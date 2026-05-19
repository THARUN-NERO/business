/**
 * gemini-ai.js — Multi-Provider Free AI for CashClaw
 *
 * Cascading fallback across FREE cloud APIs (zero local RAM):
 *   1. Google Gemini 2.0 Flash (free: 15 RPM, 1M tokens/day)
 *   2. Groq (free: 30 RPM, 14,400 req/day — runs Llama 3.1 8B)
 *   3. Hugging Face Inference API (free: image generation)
 *   4. Bulletproof JSON parser for AI responses
 *
 * Designed for 8GB RAM laptops — ALL AI runs in the cloud.
 * Zero cost. Zero local RAM. No Playwright dependency for AI.
 */

// ─── 🌐 MULTI-PROVIDER AI (Gemini → Groq → fail gracefully) ────────────
/**
 * Call the best available free AI API with automatic fallback.
 * @param {string} prompt — The user prompt
 * @param {string} [systemPrompt=''] — Optional system instruction
 * @returns {Promise<string>} — The model's text response
 */
export async function askGemini(prompt, systemPrompt = '') {
  // Provider 1: Google Gemini 2.0 Flash
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const result = await _callGemini(prompt, systemPrompt, geminiKey);
      return result;
    } catch (err) {
      console.warn(`⚠️ Gemini failed: ${err.message.slice(0, 120)}. Trying Groq...`);
    }
  }

  // Provider 2: Groq (free tier — Llama 3.1 8B Instant)
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const result = await _callGroq(prompt, systemPrompt, groqKey);
      return result;
    } catch (err) {
      console.warn(`⚠️ Groq failed: ${err.message.slice(0, 120)}`);
    }
  }

  // Both providers failed
  throw new Error('[gemini-ai] All AI providers failed. Check GEMINI_API_KEY and/or GROQ_API_KEY in .env');
}

// ─── PROVIDER: GEMINI ───────────────────────────────────────────────────
async function _callGemini(prompt, systemPrompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(`Gemini ${data.error.code}: ${data.error.message?.slice(0, 100)}`);
  }

  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error('Gemini returned empty response');
  }

  return data.candidates[0].content.parts[0].text.trim();
}

// ─── PROVIDER: GROQ (Free: 30 RPM, 14,400/day, Llama 3.1 8B) ──────────
async function _callGroq(prompt, systemPrompt, apiKey) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(`Groq: ${data.error.message?.slice(0, 100)}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');

  return text.trim();
}

// ─── 🖼️ HUGGING FACE IMAGE GENERATION ──────────────────────────────────
/**
 * Generate an image using free Hugging Face Inference API.
 * Cascades through multiple models with warm-up retry logic.
 * @param {string} prompt — Image description
 * @param {number} [retries=3] — Max retry rounds across all models
 * @returns {Promise<string|null>} — base64 data URI or null on failure
 */
export async function generateImageWithHF(prompt, retries = 3) {
  const token = process.env.HF_API_TOKEN;
  if (!token) {
    console.warn('[gemini-ai] HF_API_TOKEN not set. Skipping image generation.');
    return null;
  }

  const models = [
    'black-forest-labs/FLUX.1-schnell',
    'stabilityai/stable-diffusion-xl-base-1.0',
    'stabilityai/stable-diffusion-2-1',
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    for (const model of models) {
      try {
        const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }),
        });

        if (res.status === 503) {
          console.log(`⏳ ${model} warming up, retrying in 8s...`);
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }

        if (!res.ok) throw new Error(`HF ${model} failed: ${res.status}`);

        const buffer = await res.arrayBuffer();
        return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`;
      } catch (err) {
        console.warn(`Image attempt ${attempt + 1} failed (${model}): ${err.message}`);
      }
    }
    // Exponential backoff between retry rounds
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }

  // Graceful fallback: never block the pipeline
  console.warn('⚠️ Image gen failed after all retries. Returning text-only deliverable.');
  return null;
}

// ─── 🔧 BULLETPROOF JSON PARSER ────────────────────────────────────────
/**
 * Parse AI-generated JSON that may contain markdown fences,
 * trailing commas, smart quotes, or explanatory text.
 * @param {string} rawText — Raw AI response
 * @returns {object|array} — Parsed JSON, or empty object/array on failure
 */
export function parseAIJSON(rawText) {
  try {
    // Strip markdown code fences
    let cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Fix smart quotes
    cleaned = cleaned.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    // Fix trailing commas before } or ]
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch (_) {
    // Attempt brace-matching extraction (handles explanatory text before/after JSON)
    try {
      const objStart = rawText.indexOf('{');
      const arrStart = rawText.indexOf('[');
      let start, openChar, closeChar;

      if (objStart === -1 && arrStart === -1) throw new Error('No JSON found');
      if (arrStart === -1 || (objStart !== -1 && objStart < arrStart)) {
        start = objStart; openChar = '{'; closeChar = '}';
      } else {
        start = arrStart; openChar = '['; closeChar = ']';
      }

      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < rawText.length; i++) {
        const c = rawText[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === openChar) depth++;
        if (c === closeChar) { depth--; if (depth === 0) return JSON.parse(rawText.slice(start, i + 1)); }
      }
    } catch (__) { /* fall through to fallback */ }

    console.warn('⚠️ AI JSON parse failed. Returning fallback.');
    return rawText.includes('[') ? [] : {};
  }
}
