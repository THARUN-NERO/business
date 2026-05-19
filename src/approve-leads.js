/**
 * approve-leads.js — Interactive CLI for reviewing Apex Hunter leads
 *
 * Usage:
 *   node src/approve-leads.js           ← review all pending leads
 *   node src/approve-leads.js --id LEAD-123  ← approve specific lead
 *   node src/approve-leads.js --all     ← auto-approve all high-confidence
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LEADS_DIR    = path.join(__dirname, '..', 'leads');
const PENDING_JSON = path.join(LEADS_DIR, 'pending_leads.json');

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8')); }
  catch (_) { return []; }
}

function saveLeads(leads) {
  fs.writeFileSync(PENDING_JSON, JSON.stringify(leads, null, 2));
}

function printLead(lead, idx, total) {
  console.log(`
┌─────────────────────────────────────────────────────────────────┐
│ LEAD ${idx + 1}/${total}  •  ${lead.id}
│ Platform:  ${(lead.platform || '').padEnd(20)} Status: ${lead.status}
│ Handle:    ${lead.handle}
│ Post:      ${lead.postUrl}
├─────────────────────────────────────────────────────────────────┤
│ CONTENT:   ${(lead.content || '').slice(0, 180).replace(/\n/g, ' ')}
├─────────────────────────────────────────────────────────────────┤
│ ✅ Qualified:  ${lead.qualification?.is_qualified} (${lead.qualification?.confidence})
│ 🔧 Service:    ${lead.qualification?.service_match}
│ 💰 Est Budget: $${lead.qualification?.budget_estimate_usd}
│ 📄 Pitch:
│   ${(lead.qualification?.pitch || '').split('\n').join('\n│   ')}
│
│ 💳 Invoice: $${lead.qualification?.invoice_amount} total  /  Deposit: $${lead.qualification?.deposit_amount}
└─────────────────────────────────────────────────────────────────┘`);
}

async function interactiveReview() {
  const leads   = loadLeads();
  const pending = leads.filter(l => l.status === 'pending_approval');

  if (!pending.length) {
    console.log('\n✅ No pending leads to review. Run the hunter first:\n   npm run hunt\n');
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log(`\n🦅 APEX HUNTER — Lead Review Console`);
  console.log(`   ${pending.length} leads awaiting your approval\n`);

  for (let i = 0; i < pending.length; i++) {
    const lead = pending[i];
    printLead(lead, i, pending.length);

    const answer = await ask('\n  [a]pprove  [s]kip  [d]elete  [q]uit → ');
    const cmd    = answer.trim().toLowerCase();
    const masterIdx = leads.findIndex(l => l.id === lead.id);

    if (cmd === 'a' || cmd === 'approve') {
      leads[masterIdx].status = 'approved';
      leads[masterIdx].approvedAt = new Date().toISOString();
      console.log(`  ✅ Approved! PayPal invoice will be generated on next hunter cycle.`);
    } else if (cmd === 'd' || cmd === 'delete') {
      leads[masterIdx].status = 'deleted';
      console.log(`  🗑️  Deleted.`);
    } else if (cmd === 'q' || cmd === 'quit') {
      break;
    } else {
      console.log(`  ⏭️  Skipped.`);
    }

    saveLeads(leads);
    console.log('');
  }

  rl.close();
  console.log('\n💾 All decisions saved.\n');
  const approved = leads.filter(l => l.status === 'approved').length;
  console.log(`📊 Summary: ${approved} approved, ${leads.filter(l=>l.status==='deleted').length} deleted, ${leads.filter(l=>l.status==='pending_approval').length} still pending\n`);
}

// CLI flags
const args = process.argv.slice(2);

if (args.includes('--all')) {
  const leads = loadLeads();
  let count = 0;
  for (const l of leads) {
    if (l.status === 'pending_approval' && l.qualification?.confidence === 'high') {
      l.status = 'approved';
      l.approvedAt = new Date().toISOString();
      count++;
    }
  }
  saveLeads(leads);
  console.log(`✅ Auto-approved ${count} high-confidence leads.`);
  process.exit(0);
}

const idFlag = args.indexOf('--id');
if (idFlag !== -1 && args[idFlag + 1]) {
  const id = args[idFlag + 1];
  const leads = loadLeads();
  const lead = leads.find(l => l.id === id);
  if (!lead) { console.error(`Lead ${id} not found.`); process.exit(1); }
  lead.status = 'approved';
  lead.approvedAt = new Date().toISOString();
  saveLeads(leads);
  console.log(`✅ Lead ${id} approved.`);
  process.exit(0);
}

interactiveReview().catch(e => { console.error(e.message); process.exit(1); });
