/**
 * web_ai_bridge.js — CashClaw Zero-Cost LLM Bridge
 *
 * Replaces paid OpenAI/Anthropic API calls by routing prompts through
 * a headless Playwright browser that reuses your existing Chrome login session.
 *
 * Memory budget: designed for 8 GB RAM laptops.
 *   - One browser instance, one page at a time.
 *   - Page is created fresh per request, destroyed immediately after.
 *   - persistentContext reuses your Chrome profile (already logged in).
 *
 * Supported targets: "gemini" | "chatgpt"
 *
 * Usage:
 *   import { askAI } from './web-ai-bridge.js';
 *   const reply = await askAI('Write me an SEO report for example.com', { target: 'gemini' });
 */

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import { CASHCLAW_IDENTITY } from './cashclaw-identity.js';

// ──────────────────────────────────────────────
// CONFIG — edit these paths if needed
// Uses its OWN profile (AIBridgeProfile) to avoid Chrome lock conflicts
// when running alongside Apex Hunter or other browser-based agents.
// ──────────────────────────────────────────────
const CHROME_PROFILE_PATH = process.env.AI_CHROME_PROFILE || (() => {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'AIBridgeProfile');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'AIBridgeProfile');
  return path.join(home, '.config', 'google-chrome-aibridge'); // Linux
})();

const TARGETS = {
  gemini: {
    url:           'https://gemini.google.com/app',
    inputSelector: 'div.ql-editor[contenteditable="true"]',
    submitSelector:'button[aria-label="Send message"]',
    // Gemini streams token-by-token; wait for the "stop generating" button to disappear
    doneSelector:  'button[aria-label="Stop generating"]',
    outputSelector:'div.response-content p, div.response-content li',
  },
  chatgpt: {
    url:           'https://chatgpt.com/',
    inputSelector: 'textarea#prompt-textarea',
    submitSelector:'button[data-testid="send-button"]',
    doneSelector:  'button[data-testid="stop-button"]',
    outputSelector:'div[data-message-author-role="assistant"] p',
  },
};

// ──────────────────────────────────────────────
// MEMORY-SAFE BROWSER FACTORY
// One persistent context, zero orphaned processes.
// ──────────────────────────────────────────────
let _context = null;

async function getContext() {
  if (_context) return _context;

  console.log('[web_ai_bridge] Launching persistent browser context…');
  _context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless:          true,             // never renders a window — saves ~200 MB RAM
    channel:           'chrome',         // use system Chrome, not Playwright's bundled Chromium
    args: [
      '--disable-dev-shm-usage',         // critical on low-RAM machines
      '--disable-gpu',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-infobars',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256', // cap V8 heap inside the renderer
    ],
    viewport:          { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });

  // Auto-cleanup on process exit
  process.on('exit',    () => _context && _context.close().catch(() => {}));
  process.on('SIGINT',  () => _context && _context.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => _context && _context.close().then(() => process.exit(0)));

  return _context;
}

/**
 * Force-close the browser. Call this after a batch of jobs to reclaim RAM.
 */
export async function closeBridge() {
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
    console.log('[web_ai_bridge] Browser context released.');
  }
}

// ──────────────────────────────────────────────
// CORE: askAI()
// ──────────────────────────────────────────────

/**
 * @param {string} prompt       — The agent's full prompt string
 * @param {object} [opts]
 * @param {'gemini'|'chatgpt'} [opts.target='gemini']
 * @param {number}  [opts.timeoutMs=90000]  — max wait for AI to finish (ms)
 * @param {boolean} [opts.newConversation=true] — start fresh (no history bleed)
 * @returns {Promise<string>}   — the AI's text response
 */
export async function askAI(prompt, opts = {}) {
  const target        = opts.target        || process.env.AI_TARGET || 'gemini';
  const timeoutMs     = opts.timeoutMs     || 90_000;
  const newConversation = opts.newConversation !== false;

  const cfg = TARGETS[target];
  if (!cfg) throw new Error(`[web_ai_bridge] Unknown target: "${target}". Use "gemini" or "chatgpt".`);

  const context = await getContext();

  // Open a fresh page (not a new browser — just a new tab in the existing context)
  const page = await context.newPage();

  try {
    // ── 1. Navigate ──────────────────────────────
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── 2. Wait for input box ────────────────────
    await page.waitForSelector(cfg.inputSelector, { timeout: 20_000 });

    // ── 3. Type the prompt ───────────────────────
    await page.click(cfg.inputSelector);
    // Use clipboard paste instead of keystroke-by-keystroke to save CPU
    await page.evaluate(([sel, text]) => {
      const el = document.querySelector(sel);
      if (!el) return;
      // Works for both textarea and contenteditable div
      if (el.tagName === 'TEXTAREA') { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else { el.textContent = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, [cfg.inputSelector, prompt]);

    // Small settle delay to let React/Vue re-render before submit
    await page.waitForTimeout(400);

    // ── 4. Submit ────────────────────────────────
    await page.click(cfg.submitSelector);

    // ── 5. Wait for generation to START (done button appears) ──
    try {
      await page.waitForSelector(cfg.doneSelector, { timeout: 15_000 });
    } catch (_) {
      // Some UIs skip showing the stop button for very short answers — that's fine
    }

    // ── 6. Wait for generation to FINISH (done button disappears) ──
    await page.waitForFunction(
      (sel) => !document.querySelector(sel),
      cfg.doneSelector,
      { timeout: timeoutMs }
    );

    // ── 7. Scrape the last assistant response ────
    const responseText = await page.evaluate((sel) => {
      const nodes = document.querySelectorAll(sel);
      if (!nodes.length) return '';
      // Take only the LAST response block (most recent generation)
      // Find the last group by walking backwards
      const lastParent = nodes[nodes.length - 1].closest('[data-message-author-role="assistant"]')
                      || nodes[nodes.length - 1].parentElement;
      // Collect all paragraph/li text from that block
      const parts = [];
      lastParent.querySelectorAll('p, li').forEach(el => parts.push(el.innerText.trim()));
      return parts.length ? parts.join('\n') : lastParent.innerText.trim();
    }, cfg.outputSelector);

    if (!responseText) throw new Error('[web_ai_bridge] Could not scrape response — the UI may have changed.');

    return responseText.trim();

  } finally {
    // ── MEMORY CLEANUP: always close the page, never leave tabs dangling ──
    await page.close().catch(() => {});
  }
}

// ──────────────────────────────────────────────
// DROP-IN REPLACEMENT EXPORTS
// Mirrors the OpenAI SDK surface so existing cashclaw code
// only needs to change the `import` line.
// ──────────────────────────────────────────────

/**
 * Thin compatibility wrapper that mimics openai.chat.completions.create()
 * so existing CashClaw call-sites work with zero edits.
 *
 * Before:  import OpenAI from 'openai';
 *          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 * After:   import { openai } from './web-ai-bridge.js';  ← only this line changes
 *          const r = await openai.chat.completions.create({ messages: [...] });
 *          const text = r.choices[0].message.content;      ← same API
 */
export const openai = {
  chat: {
    completions: {
      async create({ messages = [], model, ...rest }) {
        // Flatten message array into a single prompt string
        const prompt = messages
          .map(m => `[${m.role.toUpperCase()}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n\n');

        const text = await askAI(`${CASHCLAW_IDENTITY}\n\n${prompt}`, { target: process.env.AI_TARGET || 'gemini' });

        // Return an object shaped like the OpenAI response
        return {
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage:   { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // no cost!
          model:   'web-bridge',
        };
      },
    },
  },
};

/**
 * Anthropic-compatible wrapper (mirrors anthropic.messages.create).
 *
 * Before:  import Anthropic from '@anthropic-ai/sdk';
 *          const anthropic = new Anthropic();
 *
 * After:   import { anthropic } from './web-ai-bridge.js';
 *          const msg = await anthropic.messages.create({ messages: [...] });
 *          const text = msg.content[0].text;
 */
export const anthropic = {
  messages: {
    async create({ messages = [], system, ...rest }) {
      const parts = [];
      if (system) parts.push(`[SYSTEM]\n${system}`);
      messages.forEach(m => parts.push(`[${m.role.toUpperCase()}]\n${m.content}`));

      const text = await askAI(`${CASHCLAW_IDENTITY}\n\n${parts.join('\n\n')}`, { target: process.env.AI_TARGET || 'gemini' });

      return {
        content: [{ type: 'text', text }],
        role: 'assistant',
        stop_reason: 'end_turn',
        model: 'web-bridge',
      };
    },
  },
};
