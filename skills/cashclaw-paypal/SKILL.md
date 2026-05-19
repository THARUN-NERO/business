# SKILL: paypal-invoicing
name: paypal-invoicing
version: 1.0.0
description: |
  Generate PayPal payment links and invoices for HYRVE marketplace jobs.
  USD is automatically converted to INR and deposited to your linked Indian bank account
  (minus PayPal's ~3–4% cross-border fee). No manual bank transfers needed.

## When to use this skill
Use this skill at the END of every completed HYRVE mission, after delivering the work,
to collect payment. Choose between:
  - **Payment link** — instant, no client email required. Best for quick gigs.
  - **Invoice** — professional, emailed directly to the client. Best for recurring clients.

## Required environment variables
Set these in your `.env` file before running:
```
PAYPAL_CLIENT_ID=your_live_client_id
PAYPAL_CLIENT_SECRET=your_live_client_secret
PAYPAL_BUSINESS_EMAIL=you@paypal.com
PAYPAL_MODE=live
```

## How to use in agent code

### Option A — Payment Link (recommended default)
```js
import { createPaymentLink } from '../../src/integrations/paypal-bridge.js';

const link = await createPaymentLink({
  amount:      job.budget,           // USD amount from the HYRVE job
  description: job.title,
  jobId:       job.id,
});

// Share link.url with the client in the order message thread
await sendMessage(job.orderId, `
  ✅ Your deliverable is attached above.
  
  💳 Pay here (PayPal — all major cards accepted):
  ${link.url}
  
  Funds will be reflected in your account immediately after payment.
`);
```

### Option B — Invoice (professional)
```js
import { createInvoice } from '../../src/integrations/paypal-bridge.js';

const inv = await createInvoice({
  amount:      job.budget,
  clientEmail: job.client_email,
  clientName:  job.client_name,
  description: job.title,
  jobId:       job.id,
  dueDays:     3,
});

// The invoice is auto-emailed to the client; just log it
console.log(`Invoice sent to ${inv.clientEmail}: ${inv.invoiceUrl}`);
```

### Option C — Auto (agent decides)
```js
import { collectPaymentForJob } from '../../src/integrations/paypal-bridge.js';

// If job has client_email → invoice. Otherwise → payment link.
const payment = await collectPaymentForJob(job, { method: 'link' });
console.log('Payment URL:', payment.url || payment.invoiceUrl);
```

## Money flow
```
Client pays (USD)
  → PayPal escrow
  → PayPal converts USD → INR at live rate
  → Deposits INR to your linked Indian bank (ICICI / SBI / HDFC etc.)
  → You receive within 1–3 business days
```

## Fee breakdown (per transaction)
| Fee            | Amount          |
|----------------|-----------------|
| HYRVE platform | 15% of job value|
| PayPal sender  | ~3.5% (paid by you or client) |
| FX conversion  | ~3–4% spread    |
| **Net to you** | **~81–82%** of job value |

## Testing
Set `PAYPAL_MODE=sandbox` and use sandbox credentials from developer.paypal.com.
Sandbox payments don't move real money.

## Troubleshooting
- `401 Unauthorized` → check CLIENT_ID / CLIENT_SECRET, ensure they're for LIVE not sandbox when MODE=live
- `422 Unprocessable` → PayPal rejected the email address; double-check PAYPAL_BUSINESS_EMAIL
- Invoice not arriving → check spam; PayPal sandbox emails go to sandbox accounts only
