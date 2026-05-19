# 🦅 Apex Hunter — Complete Setup Guide

## Step 1 — Create the HunterProfile Chrome Folder

1. **Close Chrome completely** (check Task Manager → end all Chrome processes)
2. Press `Win+R` → type `%LOCALAPPDATA%\Google\Chrome\User Data` → Enter
3. Create a new folder called `HunterProfile`
4. Open Chrome with this profile to log in:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data" --profile-directory=HunterProfile
   ```
5. In this Chrome window, log into:
   - **gemini.google.com** (your Google account)
   - **chatgpt.com** (if you use it as backup)
   - **x.com / twitter.com** (required for search results)
6. Close Chrome completely

Your profile path will be:
```
C:\Users\chelu\AppData\Local\Google\Chrome\User Data\HunterProfile
```

---

## Step 2 — Install Playwright Chromium

```bash
cd C:\Users\chelu\Downloads\cashclaw-clone\cashclaw-clone
npx playwright install chromium
```

---

## Step 3 — Start Both Agents

**Terminal 1 — Apex Nero (existing):**
```bash
cd cashclaw-main
npx cashclaw hyrve poll
```

**Terminal 2 — Apex Hunter (new):**
```bash
cd cashclaw-clone\cashclaw-clone
npm run hunt
```

Hunter waits 10 minutes before first sweep (staggered start).

---

## Step 4 — Daily Workflow

### Morning: Review leads
```bash
npm run approve
```
- Press `a` to approve → PayPal invoice generated next cycle
- Press `s` to skip
- Press `d` to delete junk
- Press `q` to quit

### Auto-approve high-confidence leads:
```bash
npm run approve -- --all
```

### Outreach files appear in:
```
leads/outreach_LEAD-*.txt
```
Copy-paste the pitch + PayPal link to the client. Nothing sends automatically.

---

## Smart Hunting Features

Unlike a dumb scraper, Apex Hunter has an AI brain:

| Feature | What It Does |
|---|---|
| AI Discovery | Asks Gemini for fresh URLs to scrape each cycle |
| Adaptive Queries | Generates trending search terms instead of hardcoded ones |
| Cross-Platform Intel | Uses findings from one platform to search smarter on others |
| Post-Cycle Reflection | Analyzes results and adjusts strategy for next cycle |
| Hunter Memory | Tracks platform performance across cycles in `hunter_memory.json` |

---

## RAM Safety

| Scenario | RAM Usage | Safe? |
|---|---|---|
| Both agents idle | ~200 MB | ✅ |
| Nero executing a job | +200 MB | ✅ |
| Hunter scraping | +250 MB | ✅ |
| **Both active** | ~700 MB | ✅ |

---

## File Structure

```
cashclaw-clone/
├── src/
│   ├── integrations/
│   │   ├── hunter-bridge.js      ← Smart hunt engine
│   │   ├── hunter-extractors.js  ← Platform extractors
│   │   ├── web-ai-bridge.js      ← Free AI (shared)
│   │   └── paypal-bridge.js      ← Invoicing (shared)
│   └── approve-leads.js          ← Approval CLI
├── leads/
│   ├── pending_leads.json        ← All leads
│   ├── pending_leads.txt         ← Human-readable summary
│   ├── hunter_memory.json        ← AI learning memory
│   └── outreach_LEAD-*.txt       ← Ready-to-send pitches
├── logs/
│   └── hunter.log
└── .env
```

## Troubleshooting

- **"Browser launch failed"** → Ensure HunterProfile folder exists, Chrome is closed
- **"0 leads on Twitter"** → Log into X in HunterProfile first
- **High CPU** → Increase `HUNT_INTERVAL_MINS` to 30 in .env
