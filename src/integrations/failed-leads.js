/**
 * failed-leads.js — Shared failed lead tracking
 * 
 * Prevents the infinite retry loop by permanently marking leads
 * that have exhausted all retry attempts. Shared between
 * hunter-bridge.js and hunter-worker.js to avoid circular imports.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const LEADS_DIR  = path.join(__dirname, '..', '..', 'leads');
const FAILED_LEADS_PATH = path.join(LEADS_DIR, 'failed_leads.json');

export function markLeadPermanentlyFailed(leadId) {
  let failed = [];
  try { failed = JSON.parse(fs.readFileSync(FAILED_LEADS_PATH, 'utf8')); } catch {}
  if (!failed.includes(leadId)) {
    failed.push(leadId);
    fs.writeFileSync(FAILED_LEADS_PATH, JSON.stringify(failed, null, 2));
  }
}

export function isLeadPermanentlyFailed(leadId) {
  try {
    const failed = JSON.parse(fs.readFileSync(FAILED_LEADS_PATH, 'utf8'));
    return failed.includes(leadId);
  } catch { return false; }
}
