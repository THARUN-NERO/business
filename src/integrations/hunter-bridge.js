/**
 * hunter-bridge.js — Apex Hunter Smart Lead Engine
 *
 * NOT a dumb scraper. This engine has an AI brain that:
 *   1. Asks Gemini for fresh lead-discovery strategies before each cycle
 *   2. Generates adaptive search queries (not hardcoded)
 *   3. Uses cross-platform intelligence to hunt smarter
 *   4. Reflects after each cycle to improve the next one
 *
 * Memory contract (8 GB RAM):
 *   - One browser context alive at a time
 *   - Context DESTROYED after every platform sweep
 *   - Human-mimicking delays (1–4s between actions)
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { askGemini, parseAIJSON } from './gemini-ai.js';
import { withIdentity, withShortIdentity } from './cashclaw-identity.js';
import { createPaymentLink } from './paypal-bridge.js';
import {
  extractTwitterLeads, extractRedditLeads, extractLinkedInLeads,
  extractCraigslistLeads, extractGoogleLeads, extractGenericLeads, humanDelay,
} from './hunter-extractors.js';
import hunterState from '../dashboard/hunter-state.js';
import { startDashboardServer } from '../dashboard/hunter-server.js';
import { getApprovedLeads, executeWork } from './hunter-worker.js';
import { markLeadPermanentlyFailed, isLeadPermanentlyFailed } from './failed-leads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── CONFIG ──────────────────────────────────────────────────
const HUNTER_PROFILE = process.env.HUNTER_CHROME_PROFILE || (() => {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'HunterProfile');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'HunterProfile');
  return path.join(home, '.config', 'google-chrome-hunter');
})();

const HUNT_INTERVAL_MINS   = parseInt(process.env.HUNT_INTERVAL_MINS || '20', 10);
const LEADS_DIR            = path.join(__dirname, '..', '..', 'leads');
const LOGS_DIR             = path.join(__dirname, '..', '..', 'logs');
const PENDING_JSON         = path.join(LEADS_DIR, 'pending_leads.json');
const PENDING_TXT          = path.join(LEADS_DIR, 'pending_leads.txt');
const LOG_FILE             = path.join(LOGS_DIR, 'hunter.log');
const MEMORY_FILE          = path.join(LEADS_DIR, 'hunter_memory.json');

[LEADS_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── LOGGER ──────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
  hunterState.addLog(msg, level);
}

// ─── HUNTER MEMORY — learns from past cycles ─────────────────
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch (_) { return { cycleCount: 0, totalLeads: 0, totalQualified: 0, platformStats: {}, lastReflection: '', aiDiscoveredUrls: [] }; }
}
function saveMemory(mem) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); }

// ─── BASELINE TARGETS ────────────────────────────────────────
const BASELINE_TARGETS = [
  { platform: 'Twitter', url: 'https://x.com/search?q=%22need+an+online+store%22+OR+%22need+a+website%22+OR+%22Shopify+developer%22+OR+%22need+ecommerce%22+OR+%22looking+for+web+developer%22&f=live', type: 'social', extract: extractTwitterLeads },
  { platform: 'Twitter-freelance', url: 'https://x.com/search?q=%22hiring+developer%22+OR+%22need+freelancer%22+OR+%22web+design+quote%22+OR+%22SEO+help+needed%22+OR+%22need+landing+page%22&f=live', type: 'social', extract: extractTwitterLeads },
  { platform: 'Reddit-entrepreneur', url: 'https://www.reddit.com/r/Entrepreneur/search/?q=need+website+OR+need+developer+OR+ecommerce+help&sort=new&t=day', type: 'forum', extract: extractRedditLeads },
  { platform: 'Reddit-forhire', url: 'https://www.reddit.com/r/forhire/new/', type: 'forum', extract: extractRedditLeads },
  { platform: 'Reddit-slavelabour', url: 'https://www.reddit.com/r/slavelabour/new/', type: 'forum', extract: extractRedditLeads },
  { platform: 'Reddit-smallbusiness', url: 'https://www.reddit.com/r/smallbusiness/search/?q=website+OR+online+store+OR+SEO&sort=new&t=day', type: 'forum', extract: extractRedditLeads },
  { platform: 'IndieHackers', url: 'https://www.indiehackers.com/post/looking-for-work-developers-designers-marketers-looking-for-work', type: 'community', extract: extractGenericLeads },
  { platform: 'ProductHunt', url: 'https://www.producthunt.com/discussions?q=need+developer+OR+need+designer+OR+website+help', type: 'community', extract: extractGenericLeads },
  { platform: 'Craigslist-NYC', url: 'https://newyork.craigslist.org/search/web?query=ecommerce+developer&sort=date', type: 'classifieds', extract: extractCraigslistLeads },
  { platform: 'Craigslist-LA', url: 'https://losangeles.craigslist.org/search/web?query=shopify+developer&sort=date', type: 'classifieds', extract: extractCraigslistLeads },
  { platform: 'LinkedIn', url: 'https://www.linkedin.com/search/results/content/?keywords=need%20web%20developer%20OR%20need%20ecommerce%20store%20OR%20shopify%20help&origin=GLOBAL_SEARCH_HEADER&sortBy=date_posted', type: 'professional', extract: extractLinkedInLeads },
  { platform: 'Quora', url: 'https://www.quora.com/search?q=hire+shopify+developer&time=day', type: 'qa', extract: extractGenericLeads },
  { platform: 'Google-Jobs', url: 'https://www.google.com/search?q=hire+web+developer+remote+freelance+2025&tbs=qdr:d&num=20', type: 'search', extract: extractGoogleLeads },
];

// ─── ROBUST JSON EXTRACTOR ─────────────────────────────────
// Uses the bulletproof parseAIJSON from gemini-ai.js
const extractJSON = parseAIJSON;

// ─── SMART MOVE 1: AI DISCOVERS NEW TARGETS ─────────────────
async function aiDiscoverTargets(memory) {
  log('🧠 SMART MOVE: Asking AI for fresh lead-discovery targets…');
  try {
    const prompt = withIdentity(`You are operating as CashClaw's lead-generation strategist for a freelance web development agency (eCommerce, Shopify, SEO, landing pages).

Current stats: ${memory.cycleCount} cycles run, ${memory.totalQualified} qualified leads found so far.
${memory.lastReflection ? `Last cycle reflection: ${memory.lastReflection}` : ''}

Give me 3-5 SPECIFIC URLs I should scrape RIGHT NOW to find people actively looking to hire a web developer. Think creatively:
- Specific Reddit threads or subreddits I'm not checking
- Facebook groups (public), Discord servers, Hacker News threads
- Niche forums (Warrior Forum, BlackHatWorld, DigitalPoint)
- Specific Google search queries with time filters

Answer ONLY in valid JSON array (no markdown):
[{"platform":"name","url":"full_url","reason":"why this is hot right now"}]`);

    const raw = await askGemini(prompt);
    const targets = extractJSON(raw);
    log(`🧠 AI discovered ${targets.length} new targets`);
    return targets.map(t => ({
      platform: `AI-${t.platform}`, url: t.url, type: 'ai-discovered',
      extract: extractGenericLeads, reason: t.reason,
    }));
  } catch (e) {
    log(`🧠 AI discovery failed: ${e.message}`, 'WARN');
    return [];
  }
}

// ─── SMART MOVE 2: ADAPTIVE QUERY GENERATION ────────────────
async function aiGenerateQueries(memory) {
  log('🧠 SMART MOVE: Generating adaptive search queries…');
  try {
    const topPlatforms = Object.entries(memory.platformStats || {})
      .sort((a, b) => (b[1].qualified || 0) - (a[1].qualified || 0))
      .slice(0, 3).map(([k, v]) => `${k}: ${v.qualified} qualified`).join(', ');

    const prompt = withIdentity(`You are optimizing search queries for CashClaw's freelance web dev lead hunter.
Best-performing platforms so far: ${topPlatforms || 'none yet (first cycle)'}

Generate 3 fresh Twitter/X search queries and 2 fresh Google search queries that would find people ACTIVELY looking to hire a developer RIGHT NOW. Use current trends, seasonal needs, and creative keyword combinations.

Answer ONLY in valid JSON (no markdown):
{"twitter":["query1","query2","query3"],"google":["query1","query2"]}`);

    const raw = await askGemini(prompt);
    const queries = extractJSON(raw);
    log(`🧠 AI generated ${(queries.twitter?.length || 0) + (queries.google?.length || 0)} adaptive queries`);
    return queries;
  } catch (e) {
    log(`🧠 Adaptive queries failed: ${e.message}`, 'WARN');
    return { twitter: [], google: [] };
  }
}

// ─── SMART MOVE 3: POST-CYCLE REFLECTION ─────────────────────
async function aiReflect(memory, cycleStats) {
  log('🧠 SMART MOVE: Reflecting on cycle results…');
  try {
    const prompt = withIdentity(`You are analyzing a CashClaw lead-hunting cycle for a freelance web dev agency.

Cycle results:
- Raw leads found: ${cycleStats.totalLeads}
- Qualified leads: ${cycleStats.qualifiedLeads}
- Platforms checked: ${cycleStats.platformsChecked}
- Best platform this cycle: ${cycleStats.bestPlatform || 'none'}
- Overall stats: ${memory.cycleCount} cycles, ${memory.totalQualified} total qualified

What should the hunter do DIFFERENTLY next cycle? Be specific: new keywords, new platforms, time-of-day strategy, any pattern you see.

Answer in 2-3 sentences max, plain text only.`);

    const reflection = await askGemini(prompt);
    log(`🧠 Reflection: ${reflection.slice(0, 200)}`);
    return reflection.trim();
  } catch (e) {
    log(`🧠 Reflection failed: ${e.message}`, 'WARN');
    return '';
  }
}

// ─── BROWSER FACTORY ─────────────────────────────────────────
async function launchHunterBrowser() {
  log(`Launching hunter browser with profile: ${HUNTER_PROFILE}`);
  return chromium.launchPersistentContext(HUNTER_PROFILE, {
    headless: true, channel: 'chrome',
    args: [
      '--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox',
      '--disable-extensions', '--disable-sync', '--disable-background-networking',
      '--mute-audio', '--no-first-run', '--disable-infobars', '--hide-scrollbars',
      '--disable-default-apps', '--js-flags=--max-old-space-size=200', '--memory-pressure-off',
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
}

// ─── AI QUALIFIER (Claude API — no browser needed) ───────────
const QUALIFY_JSON_SCHEMA = `{
  "is_qualified": true,
  "confidence": "high",
  "intent": "one sentence about what they need",
  "budget_estimate_usd": 250,
  "service_match": "SEO Audit | eCommerce Build | Landing Page | Content Writing | Lead Gen | Other",
  "pitch": "SHORT 4-sentence personalized pitch. Sound human, not a bot.",
  "invoice_amount": 99,
  "deposit_amount": 49
}`;

async function qualifyLead(lead) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  // Direct Claude API path (fast, reliable, no browser)
  if (apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: `You are a senior sales qualifier for CashClaw, a freelance web dev agency. Answer ONLY in valid JSON:\n${QUALIFY_JSON_SCHEMA}`,
          messages: [{
            role: 'user',
            content: `Platform: ${lead.platform}\nUser: ${lead.handle} (${lead.name})\nContent: "${lead.content}"\nURL: ${lead.postUrl}`
          }]
        })
      });
      if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (data.error?.type === 'authentication_error' || res.status === 401) throw new Error('Anthropic auth failed');
      const raw = data.content[0].text;
      const parsed = extractJSON(raw);
      return { ...parsed, raw };
    } catch (e) {
      log(`⚠️ Claude API failed (${e.message}). Falling back to web-ai-bridge...`, 'WARN');
    }
  }

  // Fallback: Gemini API (free, no browser needed)
  try {
    const geminiPrompt = `You are a senior sales qualifier for CashClaw.\nAnalyze this lead:\nPlatform: ${lead.platform}\nUser: ${lead.handle} (${lead.name})\nContent: "${lead.content}"\nURL: ${lead.postUrl}\n\nAnswer ONLY in valid JSON:\n${QUALIFY_JSON_SCHEMA}`;
    const raw = await askGemini(geminiPrompt);
    const parsed = extractJSON(raw);
    return { ...parsed, raw };
  } catch (e) {
    log(`AI qualify error for ${lead.handle}: ${e.message}`, 'WARN');
    return { is_qualified: false, confidence: 'low', error: e.message };
  }
}

// ─── LEAD STORAGE ────────────────────────────────────────────
function saveLead(lead, qualification) {
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8')); } catch (_) {}

  const isDuplicate = existing.some(e => e.handle === lead.handle && e.platform === lead.platform);
  if (isDuplicate) { log(`Skipping duplicate: ${lead.handle} on ${lead.platform}`); return null; }

  const entry = { id: `LEAD-${Date.now()}`, scrapedAt: new Date().toISOString(), status: 'approved', approvedAt: new Date().toISOString(), ...lead, qualification };
  existing.push(entry);
  fs.writeFileSync(PENDING_JSON, JSON.stringify(existing, null, 2));

  const txt = `
═══════════════════════════════════════════════════
🎯 LEAD ID:     ${entry.id}
📍 Platform:    ${lead.platform}
👤 Handle:      ${lead.handle}  |  Name: ${lead.name}
🔗 Post URL:    ${lead.postUrl}
📝 Content:     ${lead.content.slice(0, 200)}...
─────────────────────────────────────────────────
✅ Qualified:   ${qualification.is_qualified} (${qualification.confidence} confidence)
🔧 Service:     ${qualification.service_match || 'Unknown'}
💰 Est. Budget: $${qualification.budget_estimate_usd || '?'}
📄 Pitch Draft: ${qualification.pitch || 'N/A'}
💳 Invoice:     $${qualification.invoice_amount || '?'} / Deposit: $${qualification.deposit_amount || '?'}
📅 Scraped:     ${entry.scrapedAt}
═══════════════════════════════════════════════════`;

  fs.appendFileSync(PENDING_TXT, txt + '\n\n');
  log(`✅ New lead saved: ${lead.handle} on ${lead.platform} [${qualification.confidence}]`);
  return entry;
}

// ─── PROCESS APPROVED LEADS ──────────────────────────────────
async function processApprovedLeads() {
  let leads = [];
  try { leads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8')); } catch (_) { return; }
  const approved = leads.filter(l => l.status === 'approved');
  if (!approved.length) return;
  log(`Processing ${approved.length} approved leads…`);

  for (const lead of approved) {
    try {
      const depositAmt = lead.qualification?.deposit_amount || 99;
      const totalAmt = lead.qualification?.invoice_amount || 199;
      const service = lead.qualification?.service_match || 'Web Development Service';

      const payment = await createPaymentLink({
        amount: depositAmt, description: `${service} — 50% Deposit (Total: $${totalAmt})`, jobId: lead.id,
      });

      lead.status = 'pitched';
      lead.paymentLink = payment.url;
      lead.paymentOrder = payment.orderId;
      lead.pitchedAt = new Date().toISOString();

      log(`💳 PayPal link generated for ${lead.handle}: ${payment.url}`);

      const outreachFile = path.join(LEADS_DIR, `outreach_${lead.id}.txt`);
      fs.writeFileSync(outreachFile, `TO: ${lead.handle} on ${lead.platform}\nURL: ${lead.postUrl}\n${'─'.repeat(50)}\n${lead.qualification?.pitch}\n\nTo get started, here's a secure 50% deposit link:\n${payment.url}\n\n(Total: $${totalAmt} | Deposit: $${depositAmt} | Remaining: $${totalAmt - depositAmt})\n${'─'.repeat(50)}\nGenerated by Apex Hunter at ${new Date().toISOString()}`);
      log(`📁 Outreach saved: ${outreachFile}`);
    } catch (e) {
      log(`Error processing lead ${lead.id}: ${e.message}`, 'ERROR');
      lead.status = 'error'; lead.error = e.message;
    }
  }
  fs.writeFileSync(PENDING_JSON, JSON.stringify(leads, null, 2));
}

// ─── SINGLE HUNT CYCLE ──────────────────────────────────────
export async function runHuntCycle() {
  log('═══════════ 🦅 APEX HUNTER SMART CYCLE STARTING ═══════════');
  const cycleStart = Date.now();
  let totalLeads = 0, qualifiedLeads = 0;
  const platformResults = {};
  const memory = loadMemory();
  hunterState.update({ status: 'hunting', cycleStartTime: new Date().toISOString(), cycleNumber: memory.cycleCount + 1, memory });

  // SMART MOVE 1: Ask AI for new targets
  const aiTargets = await aiDiscoverTargets(memory);

  // SMART MOVE 2: Generate adaptive queries
  const adaptiveQueries = await aiGenerateQueries(memory);
  const adaptiveTargets = [];
  for (const q of (adaptiveQueries.twitter || [])) {
    adaptiveTargets.push({
      platform: `AI-Twitter-${adaptiveTargets.length}`,
      url: `https://x.com/search?q=${encodeURIComponent(q)}&f=live`, type: 'social', extract: extractTwitterLeads,
    });
  }
  for (const q of (adaptiveQueries.google || [])) {
    adaptiveTargets.push({
      platform: `AI-Google-${adaptiveTargets.length}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(q)}&tbs=qdr:d&num=15`, type: 'search', extract: extractGoogleLeads,
    });
  }

  // Merge: baseline + AI-discovered + adaptive
  const allTargets = [...BASELINE_TARGETS, ...aiTargets, ...adaptiveTargets];
  log(`📋 Total targets this cycle: ${allTargets.length} (${BASELINE_TARGETS.length} baseline + ${aiTargets.length} AI-discovered + ${adaptiveTargets.length} adaptive)`);
  hunterState.update({ totalPlatforms: allTargets.length, aiTargetsFound: aiTargets.length, adaptiveQueries: adaptiveTargets.length });

  let context;
  try { context = await launchHunterBrowser(); }
  catch (e) { log(`Browser launch failed: ${e.message}`, 'ERROR'); return; }

  for (const target of allTargets) {
    let page;
    try {
      log(`→ Hunting on ${target.platform}: ${target.url}`);
      hunterState.update({ status: 'hunting', currentPlatform: target.platform, platformIndex: allTargets.indexOf(target) + 1 });
      if (target.reason) log(`  🧠 AI reason: ${target.reason}`);
      page = await context.newPage();
      await page.route('**/*.{mp4,mp3,woff,woff2,ttf,otf}', r => r.abort());
      await page.route('**/{ads,analytics,tracker}**', r => r.abort());
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await humanDelay(2000, 4000);

      const rawLeads = await target.extract(page);
      log(`   Found ${rawLeads.length} raw leads on ${target.platform}`);
      totalLeads += rawLeads.length;
      platformResults[target.platform] = { raw: rawLeads.length, qualified: 0 };

      for (const lead of rawLeads) {
        await humanDelay(800, 1500);
        hunterState.update({ status: 'qualifying', currentLead: lead.handle });
        const qualification = await qualifyLead(lead);
        if (qualification.is_qualified && qualification.confidence !== 'low') {
          saveLead(lead, qualification);
          qualifiedLeads++;
          platformResults[target.platform].qualified++;
        } else {
          log(`   ✗ Not qualified: ${lead.handle} (${qualification.confidence})`);
        }
      }
    } catch (e) {
      log(`Error on ${target.platform}: ${e.message}`, 'WARN');
    } finally {
      if (page) await page.close().catch(() => {});
    }
    await humanDelay(8000, 15000);
  }

  try { await context.close(); log('Browser context closed — memory freed.'); } catch (_) {}
  // closeBridge no longer needed — AI calls use native API, not browser
  await processApprovedLeads();

  // Find best platform this cycle
  const bestPlatform = Object.entries(platformResults)
    .sort((a, b) => (b[1].qualified || 0) - (a[1].qualified || 0))[0];

  const cycleStats = {
    totalLeads, qualifiedLeads,
    platformsChecked: allTargets.length,
    bestPlatform: bestPlatform ? `${bestPlatform[0]} (${bestPlatform[1].qualified} qualified)` : 'none',
  };

  // SMART MOVE 3: Reflect and learn
  hunterState.update({ status: 'reflecting' });
  const reflection = await aiReflect(memory, cycleStats);

  // Update memory
  memory.cycleCount++;
  memory.totalLeads += totalLeads;
  memory.totalQualified += qualifiedLeads;
  memory.lastReflection = reflection;
  for (const [plat, stats] of Object.entries(platformResults)) {
    if (!memory.platformStats[plat]) memory.platformStats[plat] = { raw: 0, qualified: 0 };
    memory.platformStats[plat].raw += stats.raw;
    memory.platformStats[plat].qualified += stats.qualified;
  }
  saveMemory(memory);

  const elapsed = ((Date.now() - cycleStart) / 1000 / 60).toFixed(1);
  log(`═══════════ 🏁 SMART CYCLE COMPLETE in ${elapsed}min | Raw: ${totalLeads} | Qualified: ${qualifiedLeads} | Best: ${cycleStats.bestPlatform} ═══════════`);
  hunterState.update({ status: 'sleeping', stats: { rawLeads: memory.totalLeads, qualifiedLeads: memory.totalQualified, totalCycles: memory.cycleCount, bestPlatform: cycleStats.bestPlatform }, lastReflection: reflection, currentPlatform: null, currentLead: null });
}

// ─── MAIN LOOP ───────────────────────────────────────────────
export async function startHunter() {
  // Start the real-time dashboard server
  startDashboardServer();

  log(`
╔═══════════════════════════════════════════════╗
║        🦅  APEX HUNTER  v2.0.0 (SMART)       ║
║     Proactive Lead Engine for CashClaw        ║
╠═══════════════════════════════════════════════╣
║  Profile:   ${HUNTER_PROFILE.slice(-30).padStart(30)}  ║
║  Interval:  Every ${String(HUNT_INTERVAL_MINS).padStart(2)} minutes               ║
║  Platforms: ${BASELINE_TARGETS.length} baseline + AI-discovered      ║
║  RAM mode:  8GB safe (staggered + headless)   ║
║  Brain:     AI-powered adaptive hunting       ║
╚═══════════════════════════════════════════════╝`);

  log(`📂 Leads: ${PENDING_TXT}`);
  log(`📂 JSON:  ${PENDING_JSON}`);
  log(`🧠 Memory: ${MEMORY_FILE}`);

  const startDelaySecs = parseInt(process.env.HUNTER_START_DELAY_SECS || '600', 10);
  log(`⏳ Staggered start: waiting ${startDelaySecs}s before first cycle…`);
  hunterState.update({ status: 'waiting' });
  await new Promise(r => setTimeout(r, startDelaySecs * 1000));

  while (true) {
    // ── CHECK: Any approved leads waiting for work? ──
    const approved = getApprovedLeads().filter(l => !isLeadPermanentlyFailed(l.id));
    if (approved.length > 0) {
      log(`🔨 ${approved.length} APPROVED LEAD(S) FOUND — SWITCHING TO WORK MODE!`);
      hunterState.update({ status: 'working' });
      let context;
      try { context = await launchHunterBrowser(); } catch (e) { log(`Browser error: ${e.message}`, 'ERROR'); }
      for (const lead of approved) {
        if (isLeadPermanentlyFailed(lead.id)) {
          log(`⏭ Skipping permanently failed lead: ${lead.id}`);
          continue;
        }
        try {
          await executeWork(lead, context);
        } catch (e) {
          log(`Work error for ${lead.handle}: ${e.message}`, 'ERROR');
          // Track failure count — blacklist after 3 failures, not on first error
          lead.failureCount = (lead.failureCount || 0) + 1;
          try {
            const allLeads = JSON.parse(fs.readFileSync(PENDING_JSON, 'utf8'));
            const idx = allLeads.findIndex(l => l.id === lead.id);
            if (idx !== -1) { allLeads[idx].failureCount = lead.failureCount; fs.writeFileSync(PENDING_JSON, JSON.stringify(allLeads, null, 2)); }
          } catch (_) {}
          if (lead.failureCount >= 3) {
            markLeadPermanentlyFailed(lead.id);
            log(`🚫 Lead ${lead.id} blacklisted after ${lead.failureCount} failures.`, 'ERROR');
          } else {
            log(`⚠️ Lead ${lead.id} failed (attempt ${lead.failureCount}/3). Will retry next cycle.`, 'WARN');
          }
        }
      }
      if (context) await context.close().catch(() => {});
      // closeBridge no longer needed — AI calls use native API, not browser
      log('🔨 Work mode complete — resuming hunt…');
      hunterState.update({ status: 'hunting' });
      continue; // Skip sleep, go straight to next hunt
    }

    // ── No approved leads: run a hunt cycle ──
    try { await runHuntCycle(); }
    catch (e) { log(`Unhandled cycle error: ${e.message}`, 'ERROR'); }

    // ── Check again after cycle (lead might have been approved during hunt) ──
    const postCycleApproved = getApprovedLeads();
    if (postCycleApproved.length > 0) {
      log(`🔨 Lead approved during hunt — skipping sleep, entering work mode!`);
      continue;
    }

    const sleepMs = HUNT_INTERVAL_MINS * 60 * 1000;
    log(`😴 Sleeping for ${HUNT_INTERVAL_MINS} minutes until next hunt…`);
    hunterState.update({ status: 'sleeping' });

    // ── During sleep: check every 5s for newly approved leads ──
    const sleepStart = Date.now();
    let interrupted = false;
    while (Date.now() - sleepStart < sleepMs) {
      await new Promise(r => setTimeout(r, 5000));
      const urgentApproved = getApprovedLeads();
      if (urgentApproved.length > 0) {
        log(`🔨 Lead approved during sleep — waking up for work mode!`);
        interrupted = true;
        break;
      }
    }
    if (interrupted) continue;
  }
}

// Allow running directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('hunter-bridge.js') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);
if (isMain) {
  startHunter().catch(e => { log(`FATAL: ${e.message}`, 'ERROR'); process.exit(1); });
}
