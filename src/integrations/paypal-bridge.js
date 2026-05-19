/**
 * paypal-bridge.js — CashClaw PayPal Payment Module
 *
 * Generates PayPal invoices & payment links for HYRVE jobs.
 * USD → INR conversion happens automatically when the client pays
 * (PayPal converts at interbank rate, deposits INR to your linked Indian bank).
 *
 * Setup:
 *   1. Go to https://developer.paypal.com → My Apps & Credentials → Create App
 *   2. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your .env
 *   3. Set PAYPAL_MODE=live (or sandbox for testing)
 *   4. Link your Indian bank account at paypal.com → Wallet → Link a bank
 *
 * Usage:
 *   import { createPaymentLink, createInvoice } from './paypal-bridge.js';
 */

import https from 'https';

const MODE      = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const BASE_URL  = MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYEE_EMAIL   = process.env.PAYPAL_BUSINESS_EMAIL;

// ── HTTP helper (no axios dependency) ────────
function ppRequest(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL.replace('https://', ''),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`PayPal ${res.statusCode}: ${JSON.stringify(parsed)}`));
          else resolve(parsed);
        } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── AUTH: OAuth2 access token (cached) ───────
let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!CLIENT_ID || !CLIENT_SECRET)
    throw new Error('[paypal-bridge] Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env');
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const result = await ppRequest('POST', '/v1/oauth2/token', 'grant_type=client_credentials', {
    'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded',
  });
  _token = result.access_token;
  _tokenExp = Date.now() + (result.expires_in - 60) * 1000;
  return _token;
}

async function auth() {
  return { Authorization: `Bearer ${await getAccessToken()}` };
}

// ── 1. CREATE PAYMENT LINK (Orders API v2) ───
export async function createPaymentLink(opts = {}) {
  const {
    amount, description = 'CashClaw Service', jobId = '',
    returnUrl = 'https://cashclawai.com/payment/success',
    cancelUrl = 'https://cashclawai.com/payment/cancel',
  } = opts;
  if (!amount || isNaN(amount)) throw new Error('[paypal-bridge] createPaymentLink: `amount` is required');
  const headers = await auth();
  const order = await ppRequest('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: jobId || `CASHCLAW-${Date.now()}`,
      description: `${description}${jobId ? ` (Job: ${jobId})` : ''}`,
      amount: { currency_code: 'USD', value: parseFloat(amount).toFixed(2) },
      ...(PAYEE_EMAIL ? { payee: { email_address: PAYEE_EMAIL } } : {}),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'CashClaw Agent', locale: 'en-US', landing_page: 'LOGIN',
          shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
          return_url: returnUrl, cancel_url: cancelUrl,
        },
      },
    },
  }, headers);
  const approveLink = order.links?.find(l => l.rel === 'payer-action')?.href
                   || order.links?.find(l => l.rel === 'approve')?.href;
  console.log(`[paypal-bridge] Payment link created: $${amount} — ${approveLink}`);
  return { orderId: order.id, url: approveLink, amount: parseFloat(amount), currency: 'USD', mode: MODE };
}

// ── 2. CREATE INVOICE (Invoicing API v2) ─────
export async function createInvoice(opts = {}) {
  const {
    amount, clientEmail, clientName = '', description = 'CashClaw Freelance Service',
    jobId = '', currency = 'USD', dueDays = 3,
  } = opts;
  if (!amount) throw new Error('[paypal-bridge] createInvoice: `amount` is required');
  if (!clientEmail) throw new Error('[paypal-bridge] createInvoice: `clientEmail` is required');
  const headers = await auth();
  const invoiceId = `INV-CASHCLAW-${jobId || Date.now()}`;
  const dueDate = new Date(Date.now() + dueDays * 86_400_000).toISOString().split('T')[0];
  const draft = await ppRequest('POST', '/v2/invoicing/invoices', {
    detail: {
      invoice_number: invoiceId, reference: jobId, currency_code: currency,
      note: `Delivered via CashClaw autonomous agent. Job ID: ${jobId}`,
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
    },
    invoicer: {
      ...(PAYEE_EMAIL ? { email_address: PAYEE_EMAIL } : {}),
      name: { full_name: 'CashClaw Agent' },
    },
    primary_recipients: [{
      billing_info: {
        email_address: clientEmail,
        ...(clientName ? { name: { full_name: clientName } } : {}),
      },
    }],
    items: [{
      name: description,
      description: jobId ? `HYRVE Job: ${jobId}` : 'Freelance digital service',
      quantity: '1',
      unit_amount: { currency_code: currency, value: parseFloat(amount).toFixed(2) },
      unit_of_measure: 'SERVICE',
    }],
  }, headers);
  const id = draft.href?.split('/').pop() || draft.id;
  await ppRequest('POST', `/v2/invoicing/invoices/${id}/send`, {
    send_to_invoicer: false, send_to_recipient: true,
  }, headers);
  const details = await ppRequest('GET', `/v2/invoicing/invoices/${id}`, null, headers);
  const invoiceUrl = details.detail?.metadata?.recipient_view_url || `https://www.paypal.com/invoice/p/#${id}`;
  console.log(`[paypal-bridge] Invoice created & sent: $${amount} → ${clientEmail} — ${invoiceUrl}`);
  return { invoiceId, paypalId: id, invoiceUrl, amount: parseFloat(amount), currency, clientEmail, dueDate, mode: MODE };
}

// ── 3. CAPTURE PAYMENT ──────────────────────
export async function capturePayment(orderId) {
  const headers = await auth();
  const result = await ppRequest('POST', `/v2/checkout/orders/${orderId}/capture`, {}, headers);
  console.log(`[paypal-bridge] Captured: ${orderId} — status: ${result.status}`);
  return result;
}

// ── 4. CHECK BALANCE ────────────────────────
export async function getBalance() {
  const headers = await auth();
  return ppRequest('GET', '/v1/reporting/balances', null, headers);
}

// ── 5. AGENT SKILL WRAPPER ──────────────────
export async function collectPaymentForJob(job, options = {}) {
  const method = options.method || 'link';
  const amount = job.budget || job.price || job.amount;
  const jobId = job.id || job.gig_id || job.orderId;
  if (!amount) throw new Error('[paypal-bridge] collectPaymentForJob: job has no `budget` field');
  if (method === 'invoice' && job.client_email) {
    return createInvoice({
      amount, clientEmail: job.client_email, clientName: job.client_name,
      description: job.title || job.description || 'CashClaw Delivery', jobId,
    });
  }
  return createPaymentLink({
    amount, description: job.title || job.description || 'CashClaw Delivery', jobId,
  });
}

// ── 6. VERIFY WEBHOOK SIGNATURE ──────────────
export async function verifyWebhookSignature(headers, rawBody) {
  try {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) {
      console.warn('[paypal-bridge] PAYPAL_WEBHOOK_ID is not set in .env. Skipping verification for testing.');
      return true; // Bypass if not configured, for ease of use in dev
    }

    const authHeaders = await auth();
    const result = await ppRequest('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody)
    }, authHeaders);

    return result.verification_status === 'SUCCESS';
  } catch (e) {
    console.error(`[paypal-bridge] Webhook verification error: ${e.message}`);
    return false;
  }
}

