/**
 * hunter-server.js — Real-time dashboard server for Apex Hunter
 * Express + SSE (Server-Sent Events) — zero extra dependencies.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import hunterState from './hunter-state.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT    = parseInt(process.env.DASHBOARD_PORT || '3003', 10);
const LEADS_DIR = path.join(__dirname, '..', '..', 'leads');
const PENDING_JSON = path.join(LEADS_DIR, 'pending_leads.json');
const DELIVERABLES_DIR = path.join(LEADS_DIR, 'deliverables');

export function startDashboardServer() {
  const app = express();

  // REST: Real PayPal Webhook (MUST be before express.json() to get raw body for signature)
  app.post('/api/webhooks/paypal', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook HIT");
    try {
      const { verifyWebhookSignature } = await import('../integrations/paypal-bridge.js');
      
      const rawBody = req.body; // Buffer from express.raw
      const headers = req.headers;
      
      // Verify signature first
      const isValid = await verifyWebhookSignature(headers, rawBody.toString('utf8'));
      if (!isValid) {
        console.warn('⚠️ Webhook signature verification failed');
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(rawBody.toString('utf8'));
      console.log(`[Webhook] Received verified event: ${event.event_type}`);

      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const invoiceId = event.resource?.custom_id || event.resource?.invoice_id; // Depends on how payment link is built
        // If we can map the invoice ID to a leadId:
        const jobsDir = path.join(LEADS_DIR, 'jobs');
        const files = fs.readdirSync(jobsDir).filter(f => f.endsWith('.json'));
        const jobs = files.map(f => JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')));
        const job = jobs.find(j => j.paymentOrder === invoiceId || j.leadId === invoiceId); // Naive match
        
        if (job) {
          const { deliverWork } = await import('../integrations/hunter-worker.js');
          await deliverWork(job.leadId);
        }
      }
      res.sendStatus(200);
    } catch (e) { 
      console.error(`[Webhook Error] ${e.message}`);
      res.status(500).json({ error: e.message }); 
    }
  });

  app.use(express.json());

  // Serve static dashboard
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Serve Checkout Page
  app.get('/pay/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pay.html'));
  });

  // REST: Config for frontend
  app.get('/api/config', (req, res) => {
    res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
  });

  // REST: PayPal v6 SDK Create Order
  app.post('/api/checkout/orders/create', async (req, res) => {
    try {
      const { jobId } = req.body;
      const { loadJob } = await import('../integrations/hunter-worker.js');
      const job = loadJob(jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });

      const { createPaymentLink } = await import('../integrations/paypal-bridge.js');
      const payment = await createPaymentLink({
        amount: job.budget,
        description: `${job.service} — Final Delivery (Total: $${job.budget})`,
        jobId: job.leadId
      });
      res.json({ id: payment.orderId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // REST: PayPal v6 SDK Capture Order
  app.post('/api/checkout/orders/capture', async (req, res) => {
    try {
      const { orderId, jobId } = req.body;
      const { capturePayment } = await import('../integrations/paypal-bridge.js');
      const captureResult = await capturePayment(orderId);
      
      if (captureResult.status === 'COMPLETED') {
        const { deliverWork } = await import('../integrations/hunter-worker.js');
        await deliverWork(jobId);
        res.json({ status: 'COMPLETED' });
      } else {
        res.json({ status: captureResult.status });
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // SSE endpoint — pushes real-time state updates
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send current state immediately
    res.write(`data: ${JSON.stringify({ type: 'state', data: hunterState.getState() })}\n\n`);

    const onUpdate = (state) => {
      res.write(`data: ${JSON.stringify({ type: 'state', data: state })}\n\n`);
    };
    const onLog = (entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', data: entry })}\n\n`);
    };

    hunterState.on('update', onUpdate);
    hunterState.on('log', onLog);

    req.on('close', () => {
      hunterState.off('update', onUpdate);
      hunterState.off('log', onLog);
    });
  });

  // REST: Get all leads
  app.get('/api/leads', (_req, res) => {
    try {
      const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
      res.json(leads);
    } catch (_) { res.json([]); }
  });

  // REST: Approve a lead
  app.post('/api/leads/:id/approve', (req, res) => {
    try {
      const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
      const lead = leads.find(l => l.id === req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      lead.status = 'approved';
      lead.approvedAt = new Date().toISOString();
      fs.writeFileSync(PENDING_JSON, JSON.stringify(leads, null, 2));
      hunterState.update({ leads });
      res.json({ ok: true, lead });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // REST: Delete a lead
  app.post('/api/leads/:id/delete', (req, res) => {
    try {
      const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
      const lead = leads.find(l => l.id === req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      lead.status = 'deleted';
      fs.writeFileSync(PENDING_JSON, JSON.stringify(leads, null, 2));
      hunterState.update({ leads });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // REST: Approve Preview (Manual mode)
  app.post('/api/jobs/:id/approve-preview', async (req, res) => {
    try {
      const { sendJobPreview, loadJob } = await import('../integrations/hunter-worker.js');
      const job = loadJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      
      const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
      const lead = leads.find(l => l.id === req.params.id);
      
      await sendJobPreview(null, lead, job); // context=null means it will mark as manual send needed unless we pass context. Since we don't have the context here easily, it will mark it for manual sending, which is safe.
      res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // REST: Confirm Payment (Simulate)
  app.post('/api/jobs/:id/confirm-payment', async (req, res) => {
    try {
      const { deliverWork } = await import('../integrations/hunter-worker.js');
      await deliverWork(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // GET: Serve Deliverables Images
  app.use('/api/deliverables', express.static(DELIVERABLES_DIR));

  // REST: Get state snapshot
  app.get('/api/state', (_req, res) => {
    res.json(hunterState.getState());
  });

  // REST: Get all jobs (work history)
  app.get('/api/jobs', (_req, res) => {
    try {
      const jobsDir = path.join(LEADS_DIR, 'jobs');
      if (!fs.existsSync(jobsDir)) return res.json([]);
      const files = fs.readdirSync(jobsDir).filter(f => f.endsWith('.json'));
      const jobs = files.map(f => JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')));
      res.json(jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
    } catch (_) { res.json([]); }
  });

  // REST: Get specific job (with conversation)
  app.get('/api/jobs/:id', (req, res) => {
    try {
      const jobFile = path.join(LEADS_DIR, 'jobs', `${req.params.id}.json`);
      if (!fs.existsSync(jobFile)) return res.status(404).json({ error: 'Job not found' });
      res.json(JSON.parse(fs.readFileSync(jobFile, 'utf8')));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // REST: Live PayPal Balance (replaces any hardcoded values)
  app.get('/api/paypal-balance', async (req, res) => {
    try {
      const { getBalance } = await import('../integrations/paypal-bridge.js');
      const data = await getBalance();
      const usdBalance = data.balances?.find(b => b.currency === 'USD');
      res.json({
        available: usdBalance?.available_balance?.value || '0.00',
        currency: 'USD',
        raw: data,
      });
    } catch (e) {
      console.error(`[PayPal Balance] ${e.message}`);
      res.status(500).json({ error: e.message, available: '0.00' });
    }
  });

  app.listen(PORT, async () => {
    console.log(`\n🌐 Apex Hunter Dashboard: http://localhost:${PORT}`);
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    console.log(`🌍 Public Domain Active: ${publicUrl}`);
    console.log(`💳 Webhook URL: ${publicUrl}/api/webhooks/paypal\n`);
  });
}
