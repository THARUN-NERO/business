# CashClaw — Phase 1 & 2 Integration Guide

## What was added

```
cashclaw/
├── src/
│   └── integrations/
│       ├── web-ai-bridge.js   ← NEW: Zero-cost LLM via browser automation
│       └── paypal-bridge.js   ← NEW: PayPal invoicing + payment links
├── skills/
│   └── cashclaw-paypal/
│       └── SKILL.md           ← NEW: Agent instructions for PayPal skill
└── .env.example               ← NEW: All required environment variables
```

---

## Phase 1 Setup — Zero-Cost LLM Bridge

### 1. Install Playwright
```bash
npm install playwright
npx playwright install chromium
```

### 2. Find your Chrome profile path
- **Windows:** `C:\Users\<YOU>\AppData\Local\Google\Chrome\User Data`
- **Mac:**     `~/Library/Application Support/Google/Chrome`
- **Linux:**   `~/.config/google-chrome`

Make sure you are **already logged in** to Gemini or ChatGPT in that Chrome profile.

### 3. Set the env var (or it auto-detects)
```bash
# Optional — only if auto-detection is wrong
CHROME_PROFILE_PATH=/path/to/your/chrome/profile
AI_TARGET=gemini   # or chatgpt
```

### 4. Swap the LLM import in your agent
**Before:**
```js
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

**After:**
```js
import { openai } from './integrations/web-ai-bridge.js';
// Everything else stays identical — same API surface
```

### Memory usage on 8 GB RAM
| Component        | RAM usage   |
|------------------|-------------|
| Node.js process  | ~80 MB      |
| Headless Chrome  | ~250 MB     |
| Playwright layer | ~20 MB      |
| **Total bridge** | **~350 MB** |

Call `closeBridge()` after a batch of jobs to reclaim RAM:
```js
import { closeBridge } from './integrations/web-ai-bridge.js';
await closeBridge();
```

---

## Phase 2 Setup — PayPal Integration

### 1. Create a PayPal Developer App
1. Go to [developer.paypal.com](https://developer.paypal.com)
2. **My Apps & Credentials** → **Live** tab → **Create App**
3. Copy the **Client ID** and **Client Secret**

### 2. Link your Indian bank account
1. Go to [paypal.com](https://www.paypal.com) → **Wallet**
2. **Link a bank account** → enter your IFSC + account number

### 3. Add to your .env
```
PAYPAL_CLIENT_ID=your_live_client_id
PAYPAL_CLIENT_SECRET=your_live_client_secret
PAYPAL_BUSINESS_EMAIL=you@yourpaypal.com
PAYPAL_MODE=live
```

### 4. Integrate into your HYRVE job completion flow
```js
import { collectPaymentForJob } from './integrations/paypal-bridge.js';
import { sendMessage } from './integrations/hyrve-bridge.js';

// After delivering the job...
const payment = await collectPaymentForJob(job, { method: 'link' });

await sendMessage(orderId, `
✅ Delivery complete! Your ${job.title} is ready.
💳 Please complete payment here: ${payment.url}
`);
```

---

## Architecture

```
HYRVE Marketplace
        │
        ▼
  Agent mission loop
        │
        ├── Needs AI? → web-ai-bridge.js → headless Chrome → Gemini/ChatGPT (FREE)
        │
        └── Job done? → paypal-bridge.js → PayPal order/invoice
                                                  │
                                         Client pays in USD
                                                  │
                                      PayPal converts USD → INR
                                                  │
                                    Your Indian bank account 🏦
```

---

## FAQ

**Q: Will the browser bridge break if Gemini/ChatGPT updates their UI?**
A: Possibly. Update the selectors in the `TARGETS` object at the top of `web-ai-bridge.js`.

**Q: Can I switch between Gemini and ChatGPT per job?**
A: Yes — pass `{ target: 'chatgpt' }` to `askAI()`.

**Q: Do I need `@paypal/agent-toolkit`?**
A: No. `paypal-bridge.js` uses only Node's built-in `https` — zero extra dependencies.
