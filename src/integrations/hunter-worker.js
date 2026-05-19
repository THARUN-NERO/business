/**
 * hunter-worker.js — Work Execution Engine
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { askGemini } from './gemini-ai.js';
import { withShortIdentity } from './cashclaw-identity.js';
import { createPaymentLink } from './paypal-bridge.js';
import { markLeadPermanentlyFailed } from './failed-leads.js';
import { autoDeliver } from './auto-deliver.js';
import hunterState from '../dashboard/hunter-state.js';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const LEADS_DIR  = path.join(__dirname, '..', '..', 'leads');
const PENDING_JSON = path.join(LEADS_DIR, 'pending_leads.json');
const JOBS_DIR   = path.join(LEADS_DIR, 'jobs');
const DELIVERABLES_DIR = path.join(LEADS_DIR, 'deliverables');

if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
if (!fs.existsSync(DELIVERABLES_DIR)) fs.mkdirSync(DELIVERABLES_DIR, { recursive: true });

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
  hunterState.addLog(msg, level);
}

export function getApprovedLeads() {
  try {
    const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
    return leads.filter(l => l.status === 'approved');
  } catch (_) { return []; }
}

function updateLeadStatus(leadId, updates) {
  try {
    const leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    Object.assign(lead, updates);
    fs.writeFileSync(PENDING_JSON, JSON.stringify(leads, null, 2));
    hunterState.update({ leads });
  } catch (e) { log(`Error updating lead ${leadId}: ${e.message}`, 'ERROR'); }
}

function getJobFile(leadId) { return path.join(JOBS_DIR, `${leadId}.json`); }

export function loadJob(leadId) {
  try { return JSON.parse(fs.readFileSync(getJobFile(leadId), 'utf8')); }
  catch (_) { return null; }
}

export function saveJob(job) {
  fs.writeFileSync(getJobFile(job.leadId), JSON.stringify(job, null, 2));
  hunterState.update({ activeJob: job });
}

// ─── DELIVERABLE GENERATION (Claude API or Free Fallback) ──────
async function generateVariantContent(lead, variantNum) {
  const prompt = `You are CashClaw, a professional freelance web dev agency.

Generate a complete, production-ready deliverable for this client job:

Job: ${lead.content || lead.title || 'Web Development'}
Service: ${lead.qualification?.service_match || 'Web Development'}
Client: ${lead.handle} on ${lead.platform}
Budget: $${lead.qualification?.budget_estimate_usd || 200}

Deliver variant ${variantNum} of 3. Each variant should be a distinct approach.
Produce the FULL output — real code, real copy, real strategy. No placeholders.
Format it cleanly so it can be sent directly to the client.`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (apiKey && apiKey !== 'your_anthropic_api_key_here') {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
      return data.content[0].text;
    } catch (e) {
      log(`⚠️ Claude API failed (${e.message}). Falling back to free web-ai-bridge...`, 'WARN');
    }
  }

  // Zero-cost Fallback: use Gemini API directly (no browser needed)
  log(`🤖 Using Gemini API for variant ${variantNum}...`);
  return await askGemini(prompt);
}

export async function generateVariants(job, prompt, n = 3) {
  log(`🎨 Generating ${n} variants for ${job.leadId}…`);
  const jobDir = path.join(DELIVERABLES_DIR, job.leadId);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

  const variants = [];
  const lead = (() => {
    try { return JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8')).find(l => l.id === job.leadId) || {}; }
    catch { return {}; }
  })();

  for (let i = 1; i <= n; i++) {
    const variantFile = path.join(jobDir, `variant_${i}.md`);
    const previewFile = path.join(jobDir, `variant_${i}_preview.md`);

    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`Attempt ${attempt} generating variant ${i}…`);
        const content = await generateVariantContent(lead, i);
        
        // Save full deliverable
        fs.writeFileSync(variantFile, content, 'utf8');
        
        // Save preview (truncated + watermarked)
        const previewContent = content.substring(0, Math.min(content.length, 800))
          + '\n\n---\n⚠️ PREVIEW ONLY — Full deliverable unlocked after payment.\n© CashClaw / Apex AI';
        fs.writeFileSync(previewFile, previewContent, 'utf8');
        
        variants.push({ final: variantFile, preview: previewFile, name: `variant_${i}` });
        success = true;
        log(`✅ Variant ${i} generated (${content.length} chars)`);
        break;
      } catch (e) {
        log(`Generation failed on attempt ${attempt}: ${e.message}`, 'WARN');
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    if (!success) log(`Failed to generate variant ${i} after 3 attempts.`, 'ERROR');
  }

  return variants;
}

// ─── MAIN WORK EXECUTION ───────────────────────────────────
export async function executeWork(lead, context) {
  log(`🔨 ═══ ENTERING WORK MODE: ${lead.handle} on ${lead.platform} ═══`);
  
  const job = {
    leadId: lead.id,
    handle: lead.handle,
    platform: lead.platform,
    postUrl: lead.postUrl,
    service: lead.qualification?.service_match || 'Web Development',
    budget: lead.qualification?.budget_estimate_usd || 0,
    status: 'generating', // idle -> generating
    startedAt: new Date().toISOString(),
    conversation: [],
    paymentLink: null,
    variants: []
  };
  saveJob(job);

  // 1. Generate Deliverables
  try {
    const prompt = `Professional design for: ${lead.content}. High quality, highly detailed, 4k.`;
    const variants = await generateVariants(job, prompt, 3);
    if (variants.length === 0) {
      job.status = 'failed';
      saveJob(job);
      markLeadPermanentlyFailed(lead.id);
      log(`❌ All generation attempts failed for ${lead.id}. Permanently failed — will not retry.`, 'ERROR');
      return job;
    }
    job.variants = variants.map(v => v.name);
    saveJob(job);
  } catch (e) {
    job.status = 'failed';
    saveJob(job);
    markLeadPermanentlyFailed(lead.id);
    log(`❌ Generation error for ${lead.id}: ${e.message}. Permanently failed.`, 'ERROR');
    return job;
  }

  // 2. Set up Checkout Link
  try {
    const totalAmt = lead.qualification?.invoice_amount || 99;
    job.budget = totalAmt; // ensure budget matches the calculated invoice
    const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3003';
    job.paymentLink = `${baseUrl}/pay/${job.leadId}`;
    log(`💳 Checkout page ready: ${job.paymentLink}`);
  } catch (e) {
    log(`💳 Checkout link error: ${e.message}`, 'WARN');
    job.paymentLink = '[Checkout generation failed]';
  }

  // 3. Draft Outreach Message
  try {
    const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3003';
    const links = job.variants.map(v => `${baseUrl}/api/deliverables/${job.leadId}/${v}_preview.png`).join('\n');
    const outreachPrompt = withShortIdentity(`You are delivering completed work to a client on behalf of CashClaw.
Client's original post: "${lead.content}"

You've produced watermarked preview images. Write a VERY short, confident, professional message that:
1. References what they asked for specifically
2. Includes these preview links:
${links}
3. Tells them to review and pay via ${job.paymentLink} to unlock the final unwatermarked high-res versions
4. Sounds like a real senior freelancer — not a bot

Answer with ONLY the message text. No greetings like "Hi there". Jump straight into the value.`);

    const outreach = await askGemini(outreachPrompt);
    job.conversation.push({ role: 'agent', type: 'preview', message: outreach.trim(), timestamp: new Date().toISOString(), delivered: false });
  } catch (e) {
    job.conversation.push({ role: 'agent', type: 'preview', message: `Here are your previews. Pay via ${job.paymentLink} to receive final versions.`, timestamp: new Date().toISOString(), delivered: false });
  }
  
  // 4. Review Gate
  const reviewMode = process.env.REVIEW_MODE || 'auto';
  if (reviewMode === 'manual') {
    job.status = 'preview_pending';
    log('⚠️ Manual review required. Waiting for dashboard approval.');
    saveJob(job);
    updateLeadStatus(lead.id, { status: 'preview_pending', jobFile: getJobFile(lead.id) });
    return job;
  }

  // 5. Send Preview
  await sendJobPreview(context, lead, job);
  return job;
}

export async function sendJobPreview(context, lead, job) {
  log('📤 Sending preview to client…');
  let sent = false;
  if (context && lead.postUrl) {
    sent = await sendOutreach(context, lead, job.conversation[0].message);
  }

  job.conversation[0].delivered = sent;
  job.status = 'payment_pending';
  saveJob(job);
  updateLeadStatus(lead.id, { status: 'payment_pending', pitchedAt: new Date().toISOString(), jobFile: getJobFile(lead.id) });
  
  if (sent) {
    log(`✅ Preview sent to ${lead.handle}!`);
  } else {
    // Auto-deliver fallback: try email / HYRVE / file queue
    log('📤 Browser outreach failed. Attempting auto-delivery...');
    try {
      const deliverableText = job.conversation[0]?.message || 'Your preview is ready.';
      const paymentLink = job.paymentLink || `${process.env.PUBLIC_URL || 'http://localhost:3003'}/pay/${lead.id}`;
      const result = await autoDeliver(lead, deliverableText, null, paymentLink);
      lead.deliveryStatus = result.status;
      lead.deliveryMethod = result.method;
      lead.paymentLink = paymentLink;
      // Save delivery status back to pending_leads.json
      try {
        const allLeads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
        const idx = allLeads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          allLeads[idx].deliveryStatus = result.status;
          allLeads[idx].deliveryMethod = result.method;
          allLeads[idx].paymentLink = paymentLink;
          fs.writeFileSync(PENDING_JSON, JSON.stringify(allLeads, null, 2));
        }
      } catch (_) {}
      log(`📤 Auto-delivery result: ${result.status} via ${result.method}`);
    } catch (err) {
      log(`⚠️ Auto-delivery also failed: ${err.message}. Manual send required.`, 'WARN');
    }
  }
}

export async function deliverWork(leadId) {
  log(`📦 Delivering final work for ${leadId}…`);
  const job = loadJob(leadId);
  if (!job) return;

  const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3003';
  const links = job.variants.map(v => `${baseUrl}/api/deliverables/${job.leadId}/${v}_final.png`).join('\n');
  const msg = `Payment received! Thank you. Here are your final unwatermarked files:\n${links}\nLet me know if you need anything else!`;
  
  // 🚀 Real client messaging integration
  const sent = await sendToClient(job, msg);
  
  job.conversation.push({ role: 'agent', type: 'delivery', message: msg, timestamp: new Date().toISOString(), delivered: sent });
  job.status = 'delivered';
  saveJob(job);
  updateLeadStatus(leadId, { status: 'delivered' });
  
  if (sent) log(`✅ Final delivery sent to ${job.handle}!`);
  else log(`⚠️ Final delivery recorded, but auto-send failed. Send manually.`);
}

async function sendToClient(job, message) {
  try {
    if (job.platform.toLowerCase().includes('reddit')) {
      log(`🤖 Booting Playwright to send final delivery to ${job.handle} on Reddit...`);
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      
      // We pass a dummy lead object that has platform and postUrl
      const sent = await sendOutreach(context, { platform: job.platform, postUrl: job.postUrl }, message);
      
      await browser.close();
      return sent;
    }
    // E.g. email fallback if you integrate Resend:
    // if (job.platform.includes('email')) { ... }
    
    return false;
  } catch (e) {
    log(`❌ Failed to send to client: ${e.message}`, 'ERROR');
    return false;
  }
}

async function sendOutreach(context, lead, message) {
  // Try sending via playwright
  try {
    const page = await context.newPage();
    if (lead.platform.toLowerCase().includes('reddit')) {
      log(`🤖 Attempting auto-reply on Reddit: ${lead.postUrl}`);
      await page.goto(lead.postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      
      // Try to find the comment box using multiple robust strategies
      const commentBox = page.locator('div[contenteditable="true"], shreddit-composer').first();
      
      if (await commentBox.isVisible()) {
        await commentBox.click();
        await page.waitForTimeout(500);
        await page.keyboard.type(message, { delay: 10 }); // Type fast but human-like
        await page.waitForTimeout(1000);
        
        // Find the submit button
        const submitBtn = page.locator('button:has-text("Comment"), button[type="submit"]').last();
        if (await submitBtn.isVisible()) {
          await submitBtn.click();
          await page.waitForTimeout(3000);
          log('✅ Auto-comment successfully posted on Reddit!');
          await page.close();
          return true;
        }
      } else {
        log('⚠️ Comment box not found. Are you logged into Reddit?', 'WARN');
      }
    }
    await page.close();
    return false;
  } catch(e) { 
    log(`❌ Auto-reply failed: ${e.message}`, 'WARN');
    return false; 
  }
}

export async function checkForReplies(context, job) { /* existing reply logic */ }

export default { getApprovedLeads, executeWork, sendJobPreview, deliverWork, loadJob };
