/**
 * auto-deliver.js — Automatic Delivery Router for CashClaw
 *
 * Routes deliverables through 3 automatic channels:
 *   1. HYRVE Marketplace API (native, zero risk)
 *   2. Email via SMTP (Brevo/SendGrid free tier, 300/day)
 *   3. File queue fallback (no contact found)
 *
 * Zero cost. Fully unattended. Overnight-safe.
 */

import { createTransport } from 'nodemailer';
import { deliverJob } from './hyrve-bridge.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const LEADS_DIR  = path.join(__dirname, '..', '..', 'leads');

// ─── SMTP TRANSPORTER (lazy init) ───────────────────────────────────────
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[auto-deliver] SMTP not configured. Email delivery disabled.');
    return null;
  }

  _transporter = createTransport({
    host,
    port: 587,
    secure: false,
    auth: { user, pass },
  });

  return _transporter;
}

// ─── EXTRACT EMAIL FROM LEAD TEXT ────────────────────────────────────────
function extractContact(text) {
  if (!text) return null;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = text.match(emailRegex);
  return match ? { type: 'email', value: match[0] } : null;
}

// ─── MAIN AUTO-DELIVERY ROUTER ──────────────────────────────────────────
/**
 * Automatically deliver a preview to the client via the best available channel.
 * @param {object} lead — Lead object from pending_leads.json
 * @param {string} deliverableText — The preview/outreach text
 * @param {string|null} deliverableImageBase64 — Optional base64 image
 * @param {string} paymentLink — Payment/checkout URL
 * @returns {Promise<{status: string, method: string}>}
 */
export async function autoDeliver(lead, deliverableText, deliverableImageBase64, paymentLink) {
  const searchText = [lead.content, lead.description, lead.contact, lead.handle].filter(Boolean).join(' ');
  const contact = extractContact(searchText);

  // ─── 1️⃣ HYRVE Marketplace (API-native, 100% safe) ──────────────────
  if (lead.source === 'hyrve' && lead.hyrveJobId) {
    try {
      const result = await deliverJob(lead.hyrveJobId, {
        summary: deliverableText.substring(0, 500),
        files: paymentLink ? [paymentLink] : [],
        metadata: { source: 'auto-deliver', leadId: lead.id },
      });
      if (result.success) {
        console.log(`✅ HYRVE auto-delivered: ${lead.id}`);
        return { status: 'sent', method: 'hyrve' };
      }
      console.warn(`⚠️ HYRVE delivery API returned failure: ${result.message}`);
    } catch (err) {
      console.warn(`⚠️ HYRVE delivery failed: ${err.message}`);
    }
  }

  // ─── 2️⃣ Email Delivery (Free SMTP, zero manual steps) ──────────────
  if (contact?.type === 'email') {
    const transporter = getTransporter();
    if (transporter) {
      try {
        const fromEmail = process.env.PAYPAL_BUSINESS_EMAIL || process.env.SMTP_USER;
        const mailOptions = {
          from: `"CashClaw AI" <${fromEmail}>`,
          to: contact.value,
          subject: `Deliverable Ready: ${lead.qualification?.service_match || lead.title || 'Your Request'}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;">
              <h2 style="color:#0070ba;">Your requested work is ready</h2>
              <p>${deliverableText.substring(0, 600).replace(/\n/g, '<br>')}...</p>
              ${deliverableImageBase64 ? `<img src="${deliverableImageBase64}" style="max-width:100%;border:1px solid #ddd;border-radius:8px;margin:10px 0;">` : ''}
              <div style="margin:20px 0;">
                <a href="${paymentLink}" style="background:#0070ba;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">
                  Complete Payment & Unlock Full Files
                </a>
              </div>
              <p style="color:#666;font-size:12px;">Sent automatically by CashClaw AI Agent. Reply to this email for revisions.</p>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ Email auto-sent to ${contact.value} for ${lead.id}`);
        return { status: 'sent', method: 'email' };
      } catch (err) {
        console.warn(`⚠️ Email delivery failed: ${err.message}`);
      }
    }
  }

  // ─── 3️⃣ Fallback: Queue + File (no contact found) ─────────────────
  if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });
  const filePath = path.join(LEADS_DIR, `outreach_${lead.id}.txt`);
  fs.writeFileSync(filePath, `PAYMENT LINK: ${paymentLink}\n\nDELIVERABLE:\n${deliverableText}`);
  console.log(`⏸️ No contact for ${lead.id}. Queued to ${filePath}`);
  return { status: 'queued', method: 'file' };
}
