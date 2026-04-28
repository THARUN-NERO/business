import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../utils/config.js';
import { getMissionStats } from '../../engine/mission-runner.js';
import { getTotal, getMonthly, getWeekly, getToday } from '../../engine/earnings-tracker.js';
import { listInstalledSkills } from '../../integrations/openclaw-bridge.js';
import { showMiniBanner } from '../utils/banner.js';

const orange = chalk.hex('#FF6B35');
const green = chalk.hex('#16C784');
const dim = chalk.dim;

export async function runStatus() {
  showMiniBanner();

  const config = await loadConfig();

  // Check if initialized
  if (!config.agent.name || config.agent.name === 'MyCashClaw') {
    const isDefault = !config.agent.owner && !config.agent.email;
    if (isDefault) {
      console.log(chalk.yellow('  Agent not initialized. Run "cashclaw init" first.\n'));
      return;
    }
  }

  // ─── Agent Info ──────────────────────────────────────────────────────
  const infoTable = new Table({
    chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '  ', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '', middle: '  ' },
    colWidths: [20, 42],
    style: { 'padding-left': 0, 'padding-right': 0 },
  });

  infoTable.push(
    [orange.bold('Agent'), chalk.bold(config.agent.name)],
    [orange('Owner'), config.agent.owner || dim('not set')],
    [orange('Email'), config.agent.email || dim('not set')],
    [orange('Currency'), config.agent.currency],
    [orange('Created'), config.agent.created_at ? new Date(config.agent.created_at).toLocaleDateString() : dim('unknown')],
  );

  console.log(infoTable.toString());
  console.log();

  // ─── Services ────────────────────────────────────────────────────────
  console.log(orange.bold('  Services'));
  console.log();

  const svcTable = new Table({
    head: [dim('Service'), dim('Status'), dim('Pricing')],
    chars: { top: '', 'top-mid': '', 'top-left': '  ', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '  ', 'bottom-right': '',
      left: '  ', 'left-mid': '  ', mid: '-', 'mid-mid': '+',
      right: '', 'right-mid': '', middle: ' | ' },
    colWidths: [22, 12, 28],
    style: { head: [], 'padding-left': 0, 'padding-right': 0 },
  });

  const serviceLabels = {
    seo_audit: 'SEO Audit',
    content_writing: 'Content Writing',
    lead_generation: 'Lead Generation',
    whatsapp_management: 'WhatsApp Mgmt',
    social_media: 'Social Media',
    email_outreach: 'Email Outreach',
    competitor_analysis: 'Competitor Analysis',
    landing_page: 'Landing Page',
    data_scraping: 'Data Scraping',
    reputation_management: 'Reputation Mgmt',
  };

  const currencySymbol = { USD: '$', EUR: '€', GBP: '£', TRY: '₺' }[config.agent.currency] || '$';

  for (const [key, svc] of Object.entries(config.services)) {
    const label = serviceLabels[key] || key;
    const status = svc.enabled ? green('active') : dim('off');
    const prices = svc.enabled
      ? Object.values(svc.pricing).map((p) => `${currencySymbol}${p}`).join(', ')
      : dim('-');
    svcTable.push([label, status, prices]);
  }

  console.log(svcTable.toString());
  console.log();

  // ─── Stripe ──────────────────────────────────────────────────────────
  const stripeStatus = config.stripe.connected
    ? green(`Connected (${config.stripe.mode})`)
    : chalk.yellow('Not configured');
  console.log(`  ${orange('Stripe')}  ${stripeStatus}`);
  console.log();

  // ─── Earnings ────────────────────────────────────────────────────────
  console.log(orange.bold('  Earnings'));
  console.log();

  try {
    const [total, monthly, weekly, today] = await Promise.all([
      getTotal(),
      getMonthly(),
      getWeekly(),
      getToday(),
    ]);

    const earnTable = new Table({
      chars: { top: '', 'top-mid': '', 'top-left': '  ', 'top-right': '',
        bottom: '', 'bottom-mid': '', 'bottom-left': '  ', 'bottom-right': '',
        left: '  ', 'left-mid': '  ', mid: '', 'mid-mid': '',
        right: '', 'right-mid': '', middle: '  ' },
      colWidths: [20, 18],
      style: { 'padding-left': 0, 'padding-right': 0 },
    });

    earnTable.push(
      [dim('Total'), green.bold(`${currencySymbol}${total.toFixed(2)}`)],
      [dim('This Month'), `${currencySymbol}${monthly.total.toFixed(2)} (${monthly.count} jobs)`],
      [dim('This Week'), `${currencySymbol}${weekly.total.toFixed(2)} (${weekly.count} jobs)`],
      [dim('Today'), `${currencySymbol}${today.total.toFixed(2)} (${today.count} jobs)`],
    );

    console.log(earnTable.toString());
  } catch {
    console.log(dim('  No earnings data yet.'));
  }
  console.log();

  // ─── Missions ────────────────────────────────────────────────────────
  console.log(orange.bold('  Missions'));
  console.log();

  try {
    const stats = await getMissionStats();

    const missionTable = new Table({
      chars: { top: '', 'top-mid': '', 'top-left': '  ', 'top-right': '',
        bottom: '', 'bottom-mid': '', 'bottom-left': '  ', 'bottom-right': '',
        left: '  ', 'left-mid': '  ', mid: '', 'mid-mid': '',
        right: '', 'right-mid': '', middle: '  ' },
      colWidths: [20, 12],
      style: { 'padding-left': 0, 'padding-right': 0 },
    });

    missionTable.push(
      [dim('Total'), String(stats.total)],
      [dim('In Progress'), chalk.yellow(String(stats.in_progress))],
      [dim('Completed'), green(String(stats.completed))],
      [dim('Total Value'), `${currencySymbol}${stats.total_value.toFixed(2)}`],
    );

    console.log(missionTable.toString());
  } catch {
    console.log(dim('  No missions yet.'));
  }
  console.log();

  // ─── Installed Skills ────────────────────────────────────────────────
  console.log(orange.bold('  Skills'));
  console.log();

  try {
    const installed = await listInstalledSkills(config.openclaw?.skills_dir);
    if (installed.length > 0) {
      for (const skill of installed) {
        console.log(`  ${green('+')} ${skill}`);
      }
    } else {
      console.log(dim('  No CashClaw skills installed.'));
    }
  } catch {
    console.log(dim('  Could not check installed skills.'));
  }

  console.log();
  console.log(dim(`  Dashboard: http://localhost:${config.server.port}`));
  console.log();
}
