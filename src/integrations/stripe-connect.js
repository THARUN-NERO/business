import Stripe from 'stripe';
import { loadConfig } from '../cli/utils/config.js';

let stripeClient = null;

/**
 * Initialize or return the Stripe client.
 * Reads the secret key from CashClaw config.
 */
async function getStripe() {
  if (stripeClient) return stripeClient;

  const config = await loadConfig();
  const secretKey = process.env.CASHCLAW_STRIPE_SECRET_KEY || config.stripe?.secret_key;

  if (!secretKey) {
    throw new Error(
      'Stripe secret key not configured. Run "cashclaw init" or "cashclaw config set stripe.secret_key <key>"'
    );
  }

  stripeClient = new Stripe(secretKey, {
    apiVersion: '2024-12-18.acacia',
  });

  return stripeClient;
}

/**
 * Create a Stripe Payment Link for a one-time payment.
 * @param {number} amount - Amount in the smallest currency unit (e.g., cents for USD)
 * @param {string} currency - Three-letter currency code (e.g., 'usd')
 * @param {string} description - Description of what the payment is for
 * @returns {object} { id, url, amount, currency }
 */
export async function createPaymentLink(amount, currency = 'usd', description = 'CashClaw Service') {
  const stripe = await getStripe();

  // Create a price for this one-time payment
  const price = await stripe.prices.create({
    unit_amount: Math.round(amount * 100), // Convert dollars to cents
    currency: currency.toLowerCase(),
    product_data: {
      name: description,
    },
  });

  // Create the payment link
  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      {
        price: price.id,
        quantity: 1,
      },
    ],
    metadata: {
      source: 'cashclaw',
      description,
    },
  });

  return {
    id: paymentLink.id,
    url: paymentLink.url,
    amount,
    currency: currency.toLowerCase(),
    description,
  };
}

/**
 * Create a Stripe Invoice and send it to a customer.
 * @param {string} customerEmail - Customer's email address
 * @param {Array} items - Array of { description, amount, currency }
 * @returns {object} Invoice details
 */
export async function createInvoice(customerEmail, items = []) {
  const stripe = await getStripe();

  // Find or create customer
  const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
  let customer;
  if (customers.data.length > 0) {
    customer = customers.data[0];
  } else {
    customer = await stripe.customers.create({
      email: customerEmail,
      metadata: { source: 'cashclaw' },
    });
  }

  // Create invoice
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 7,
    metadata: { source: 'cashclaw' },
  });

  // Add line items
  for (const item of items) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: Math.round((item.amount || 0) * 100),
      currency: (item.currency || 'usd').toLowerCase(),
      description: item.description || 'CashClaw Service',
    });
  }

  // Finalize and send
  const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  return {
    id: finalizedInvoice.id,
    number: finalizedInvoice.number,
    status: finalizedInvoice.status,
    amount_due: finalizedInvoice.amount_due / 100,
    currency: finalizedInvoice.currency,
    hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
    customer_email: customerEmail,
  };
}

/**
 * Check the status of a Stripe payment or payment intent.
 * @param {string} paymentId - Payment Intent ID (pi_...) or Payment Link ID (plink_...)
 * @returns {object} Payment status details
 */
export async function getPaymentStatus(paymentId) {
  const stripe = await getStripe();

  try {
    if (paymentId.startsWith('pi_')) {
      const intent = await stripe.paymentIntents.retrieve(paymentId);
      return {
        id: intent.id,
        status: intent.status,
        amount: intent.amount / 100,
        currency: intent.currency,
        created: new Date(intent.created * 1000).toISOString(),
      };
    } else if (paymentId.startsWith('in_')) {
      const invoice = await stripe.invoices.retrieve(paymentId);
      return {
        id: invoice.id,
        status: invoice.status,
        amount: invoice.amount_due / 100,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000).toISOString(),
        paid: invoice.paid,
      };
    } else {
      throw new Error(`Unknown payment ID format: ${paymentId}`);
    }
  } catch (err) {
    throw new Error(`Could not retrieve payment ${paymentId}: ${err.message}`);
  }
}

/**
 * List recent payments.
 * @param {number} limit - Max number of payments to return (default 10)
 * @returns {Array} List of payment details
 */
export async function listPayments(limit = 10) {
  const stripe = await getStripe();

  const paymentIntents = await stripe.paymentIntents.list({
    limit,
    metadata: { source: 'cashclaw' },
  });

  return paymentIntents.data.map((pi) => ({
    id: pi.id,
    status: pi.status,
    amount: pi.amount / 100,
    currency: pi.currency,
    description: pi.description || '',
    created: new Date(pi.created * 1000).toISOString(),
  }));
}

/**
 * Test the Stripe connection with the configured key.
 * @returns {boolean} true if the connection is valid
 */
export async function testConnection() {
  try {
    const stripe = await getStripe();
    const account = await stripe.accounts.retrieve();
    return {
      connected: true,
      account_id: account.id,
      email: account.email,
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
    };
  }
}
