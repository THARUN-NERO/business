import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(isoWeek);

const EARNINGS_FILE = path.join(os.homedir(), '.cashclaw', 'earnings.jsonl');

/**
 * Ensure the earnings file parent directory exists.
 */
async function ensureEarningsFile() {
  await fs.ensureDir(path.dirname(EARNINGS_FILE));
  const exists = await fs.pathExists(EARNINGS_FILE);
  if (!exists) {
    await fs.writeFile(EARNINGS_FILE, '', 'utf-8');
  }
}

/**
 * Record a new earning entry.
 * @param {object} data - { mission_id, service_type, amount, currency, client_name, client_email, description, payment_id }
 * @returns {object} The recorded earning entry
 */
export async function recordEarning(data) {
  await ensureEarningsFile();

  const entry = {
    id: `earn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mission_id: data.mission_id || null,
    service_type: data.service_type || 'general',
    amount: data.amount || 0,
    currency: data.currency || 'USD',
    client_name: data.client_name || 'Unknown',
    client_email: data.client_email || '',
    description: data.description || '',
    payment_id: data.payment_id || null,
    recorded_at: dayjs().toISOString(),
  };

  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(EARNINGS_FILE, line, 'utf-8');

  return entry;
}

/**
 * Read all earning entries from the JSONL file.
 */
async function readAllEarnings() {
  await ensureEarningsFile();

  const content = await fs.readFile(EARNINGS_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const earnings = [];
  for (const line of lines) {
    try {
      earnings.push(JSON.parse(line));
    } catch (err) {
      // Skip malformed lines
      continue;
    }
  }

  // Sort by recorded_at descending
  earnings.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  return earnings;
}

/**
 * Get the total of all earnings in USD.
 */
export async function getTotal() {
  const earnings = await readAllEarnings();
  return earnings.reduce((sum, e) => sum + (e.amount || 0), 0);
}

/**
 * Get earnings for the current month.
 */
export async function getMonthly() {
  const earnings = await readAllEarnings();
  const startOfMonth = dayjs().startOf('month');

  const monthly = earnings.filter((e) =>
    dayjs(e.recorded_at).isAfter(startOfMonth) || dayjs(e.recorded_at).isSame(startOfMonth)
  );

  return {
    total: monthly.reduce((sum, e) => sum + (e.amount || 0), 0),
    count: monthly.length,
    entries: monthly,
  };
}

/**
 * Get earnings for the current week (ISO week, Mon-Sun).
 */
export async function getWeekly() {
  const earnings = await readAllEarnings();
  const startOfWeek = dayjs().startOf('isoWeek');

  const weekly = earnings.filter((e) =>
    dayjs(e.recorded_at).isAfter(startOfWeek) || dayjs(e.recorded_at).isSame(startOfWeek)
  );

  return {
    total: weekly.reduce((sum, e) => sum + (e.amount || 0), 0),
    count: weekly.length,
    entries: weekly,
  };
}

/**
 * Get earnings for today.
 */
export async function getToday() {
  const earnings = await readAllEarnings();
  const startOfDay = dayjs().startOf('day');

  const today = earnings.filter((e) =>
    dayjs(e.recorded_at).isAfter(startOfDay) || dayjs(e.recorded_at).isSame(startOfDay)
  );

  return {
    total: today.reduce((sum, e) => sum + (e.amount || 0), 0),
    count: today.length,
    entries: today,
  };
}

/**
 * Get earning history (most recent first).
 * @param {number} limit - Max entries to return (default 50)
 */
export async function getHistory(limit = 50) {
  const earnings = await readAllEarnings();
  return earnings.slice(0, limit);
}

/**
 * Get a breakdown of earnings by service type.
 */
export async function getByService() {
  const earnings = await readAllEarnings();
  const byService = {};

  for (const e of earnings) {
    const key = e.service_type || 'general';
    if (!byService[key]) {
      byService[key] = { total: 0, count: 0 };
    }
    byService[key].total += e.amount || 0;
    byService[key].count += 1;
  }

  return byService;
}

/**
 * Get daily totals for the last N days (for charting).
 * @param {number} days - Number of days to look back (default 30)
 */
export async function getDailyTotals(days = 30) {
  const earnings = await readAllEarnings();
  const result = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    const dayEarnings = earnings.filter(
      (e) => dayjs(e.recorded_at).format('YYYY-MM-DD') === date
    );
    result.push({
      date,
      total: dayEarnings.reduce((sum, e) => sum + (e.amount || 0), 0),
      count: dayEarnings.length,
    });
  }

  return result;
}
