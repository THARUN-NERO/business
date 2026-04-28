import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from '../cli/utils/config.js';
import { VERSION } from '../utils/version.js';
import { listMissions, getMissionStats, getMissionTrail } from '../engine/mission-runner.js';
import { getTotal, getMonthly, getWeekly, getToday, getHistory, getByService, getDailyTotals } from '../engine/earnings-tracker.js';
import { listInstalledSkills, listAvailableSkills } from '../integrations/openclaw-bridge.js';
import { listAvailableJobs, getAgentProfile, listOrders, registerAgent, syncStatus, acceptJob, deliverJob, getWallet, acceptProposal, rejectProposal, sendMessage, getMessages, requestWithdraw, claimAgent, getJobDetail } from '../integrations/hyrve-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Create and configure the Express dashboard server.
 * @returns {express.Application}
 */
export function createDashboardServer() {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS — restrict to localhost; requests with no Origin (curl, agents) pass through
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Serve static files from public/
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // ─── API Routes ────────────────────────────────────────────────────

  /**
   * GET /api/status
   * Returns agent status, config summary, and overall stats.
   */
  app.get('/api/status', async (req, res) => {
    try {
      const config = await loadConfig();
      const missionStats = await getMissionStats();
      const total = await getTotal();
      const monthly = await getMonthly();
      const today = await getToday();

      const enabledServices = Object.entries(config.services || {})
        .filter(([_, svc]) => svc.enabled)
        .map(([key, svc]) => ({
          type: key,
          pricing: svc.pricing,
          description: svc.description,
        }));

      res.json({
        agent: config.agent,
        stripe: {
          connected: config.stripe?.connected || false,
          mode: config.stripe?.mode || 'test',
        },
        services: enabledServices,
        services_count: enabledServices.length,
        missions: missionStats,
        earnings: {
          total,
          monthly: monthly.total,
          monthly_count: monthly.count,
          today: today.total,
          today_count: today.count,
        },
        server: config.server,
        hyrve: {
          registered: config.hyrve?.registered || false,
          agent_id: config.hyrve?.agent_id || null,
        },
        openclaw: {
          workspace: config.openclaw?.workspace || null,
          auto_detected: config.openclaw?.auto_detected || false,
        },
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/missions
   * Returns list of all missions with optional status filter.
   */
  app.get('/api/missions', async (req, res) => {
    try {
      const statusFilter = req.query.status || null;
      const missions = await listMissions(statusFilter);
      const stats = await getMissionStats();

      res.json({
        missions,
        stats,
        total: missions.length,
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/earnings
   * Returns earnings summary, history, breakdown by service, and daily totals.
   */
  app.get('/api/earnings', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const days = parseInt(req.query.days) || 30;

      const [total, monthly, weekly, today, history, byService, dailyTotals] = await Promise.all([
        getTotal(),
        getMonthly(),
        getWeekly(),
        getToday(),
        getHistory(limit),
        getByService(),
        getDailyTotals(days),
      ]);

      res.json({
        summary: {
          total,
          monthly: monthly.total,
          monthly_count: monthly.count,
          weekly: weekly.total,
          weekly_count: weekly.count,
          today: today.total,
          today_count: today.count,
        },
        by_service: byService,
        daily_totals: dailyTotals,
        history,
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/skills
   * Returns available and installed CashClaw skills.
   */
  app.get('/api/skills', async (req, res) => {
    try {
      const config = await loadConfig();
      const available = await listAvailableSkills();
      const installed = await listInstalledSkills(config.openclaw?.skills_dir);

      const skills = available.map((s) => ({
        name: s.name,
        installed: installed.includes(s.name),
        has_skill_md: s.has_skill_md,
      }));

      res.json({
        skills,
        total_available: available.length,
        total_installed: installed.length,
        openclaw_detected: !!config.openclaw?.workspace,
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/config
   * Update configuration values.
   * Body: { key: "dot.notation.key", value: "new value" }
   */
  app.post('/api/config', async (req, res) => {
    try {
      const { key, value } = req.body;

      if (!key) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Key is required' },
        });
      }

      // Block sensitive keys from API modification
      const BLOCKED_KEYS = ['stripe.secret_key', 'stripe.webhook_secret'];
      if (BLOCKED_KEYS.includes(key)) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: `Key "${key}" cannot be modified via API` },
        });
      }

      // Prototype pollution guard
      const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
      const keys = key.split('.');
      if (keys.some((k) => DANGEROUS_KEYS.includes(k))) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid key name' },
        });
      }

      const config = await loadConfig();
      let obj = config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') {
          obj[keys[i]] = {};
        }
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;

      await saveConfig(config);

      res.json({ success: true, key, value });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/missions/:id/trail
   * Returns the audit trail for a specific mission.
   */
  app.get('/api/missions/:id/trail', async (req, res) => {
    try {
      const trail = await getMissionTrail(req.params.id);
      res.json(trail);
    } catch (err) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
  });

  // ─── HYRVE Marketplace Routes ──────────────────────────────────────

  /**
   * GET /api/hyrve
   * Returns HYRVE marketplace data (jobs, orders, profile).
   */
  app.get('/api/hyrve', async (req, res) => {
    try {
      const config = await loadConfig();

      if (!config.hyrve?.registered) {
        return res.json({
          registered: false,
          agent_id: null,
          jobs: [],
          orders: [],
          profile: null,
        });
      }

      // Parallel fetch - use both bridge functions and direct public API
      const [jobsResult, ordersResult, profileResult] = await Promise.allSettled([
        listAvailableJobs(),
        listOrders({ status: 'all' }),
        getAgentProfile(),
      ]);

      // Extract jobs from bridge result (jobs field) or fallback to empty
      const jobsData = jobsResult.status === 'fulfilled'
        ? (jobsResult.value.jobs || jobsResult.value.data || [])
        : [];

      // Extract orders
      const ordersData = ordersResult.status === 'fulfilled'
        ? (ordersResult.value.orders || ordersResult.value.data || [])
        : [];

      // Extract profile
      const profileData = profileResult.status === 'fulfilled'
        ? (profileResult.value.agent || profileResult.value.data || profileResult.value)
        : null;

      res.json({
        registered: true,
        agent_id: config.hyrve.agent_id,
        api_url: config.hyrve.api_url || 'https://api.hyrveai.com/v1',
        dashboard_url: config.hyrve.dashboard_url || 'https://app.hyrveai.com',
        jobs: jobsData,
        orders: ordersData,
        profile: profileData,
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/hyrve/register
   * Register this CashClaw agent on HYRVE marketplace.
   */
  app.post('/api/hyrve/register', async (req, res) => {
    try {
      const config = await loadConfig();
      const result = await registerAgent(config);

      if (result.success) {
        config.hyrve = config.hyrve || {};
        config.hyrve.registered = true;
        config.hyrve.agent_id = result.data.agent_id;
        config.hyrve.api_key = result.data.api_key;
        config.hyrve.enabled = true;
        await saveConfig(config);
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/hyrve/sync
   * Sync status heartbeat with HYRVE.
   */
  app.post('/api/hyrve/sync', async (req, res) => {
    try {
      const result = await syncStatus();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/hyrve/jobs/:id/accept
   * Accept a job from the HYRVE marketplace.
   */
  app.post('/api/hyrve/jobs/:id/accept', async (req, res) => {
    try {
      const result = await acceptJob(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/hyrve/orders/:id/deliver
   * Deliver work for a HYRVE order.
   */
  app.post('/api/hyrve/orders/:id/deliver', async (req, res) => {
    try {
      const { deliverables, notes } = req.body;
      const result = await deliverJob(req.params.id, { deliverables, notes });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * GET /api/hyrve/wallet
   * Get wallet balances and recent transactions.
   */
  app.get('/api/hyrve/wallet', async (req, res) => {
    try {
      const result = await getWallet();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  /**
   * POST /api/hyrve/proposals/:id/accept
   * Accept a proposal for an order.
   */
  app.post('/api/hyrve/proposals/:id/accept', async (req, res) => {
    try { res.json(await acceptProposal(req.params.id)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * POST /api/hyrve/proposals/:id/reject
   * Reject a proposal for an order.
   */
  app.post('/api/hyrve/proposals/:id/reject', async (req, res) => {
    try { res.json(await rejectProposal(req.params.id)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * GET /api/hyrve/orders/:id/messages
   * Get messages for an order.
   */
  app.get('/api/hyrve/orders/:id/messages', async (req, res) => {
    try { res.json(await getMessages(req.params.id, req.query.page || 1)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * POST /api/hyrve/orders/:id/messages
   * Send a message on an order thread.
   */
  app.post('/api/hyrve/orders/:id/messages', async (req, res) => {
    try { res.json(await sendMessage(req.params.id, req.body.content)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * POST /api/hyrve/wallet/withdraw
   * Request a withdrawal from the HYRVE wallet.
   */
  app.post('/api/hyrve/wallet/withdraw', async (req, res) => {
    try { res.json(await requestWithdraw(req.body.amount_usd, req.body.method)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * GET /api/hyrve/jobs/:id
   * Get detailed information about a specific job.
   */
  app.get('/api/hyrve/jobs/:id', async (req, res) => {
    try { res.json(await getJobDetail(req.params.id)); }
    catch (err) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } }); }
  });

  /**
   * GET /api/health
   * Simple health check endpoint.
   */
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: VERSION, timestamp: new Date().toISOString() });
  });

  // Fallback: serve index.html for SPA routing
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
