/**
 * hunter-extractors.js — Platform-specific lead extractors
 * Each function receives a Playwright page and returns lead objects.
 */

function humanDelay(min = 1500, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}

// Extract email from text for auto-delivery
function extractEmail(text) {
  if (!text) return null;
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

export async function extractTwitterLeads(page) {
  const leads = [];
  try {
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20000 });
    await humanDelay(2000, 3000);
    const tweets = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results = [];
      for (const art of Array.from(articles).slice(0, 8)) {
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const userEl = art.querySelector('[data-testid="User-Name"] span');
        const handleEl = art.querySelector('[data-testid="User-Name"] a');
        const timeEl = art.querySelector('time');
        results.push({
          text: textEl?.innerText?.trim() || '',
          name: userEl?.innerText?.trim() || 'Unknown',
          handle: handleEl?.href?.split('/').pop() || '',
          time: timeEl?.dateTime || '',
          url: handleEl?.href || '',
        });
      }
      return results.filter(t => t.text && t.handle);
    });
    for (const t of tweets) {
      leads.push({
        platform: 'Twitter', handle: `@${t.handle}`, name: t.name,
        content: t.text, profileUrl: `https://x.com/${t.handle}`,
        postUrl: `https://x.com/${t.handle}/status/latest`, timestamp: t.time,
        contact: extractEmail(t.text),
      });
    }
  } catch (e) { /* Twitter extract failed */ }
  return leads;
}

export async function extractRedditLeads(page) {
  const leads = [];
  try {
    await page.waitForSelector('a[data-testid="post-title"], shreddit-post', { timeout: 20000 });
    await humanDelay();
    const posts = await page.evaluate(() => {
      const els = document.querySelectorAll('shreddit-post') || document.querySelectorAll('.Post');
      const results = [];
      for (const el of Array.from(els).slice(0, 8)) {
        const title = el.getAttribute('post-title') || el.querySelector('h3')?.innerText || '';
        const author = el.getAttribute('author') || el.querySelector('[data-click-id="user"]')?.innerText || '';
        const postUrl = el.getAttribute('permalink') || el.querySelector('a[data-click-id="body"]')?.href || '';
        const sub = el.getAttribute('subreddit-prefixed-name') || '';
        results.push({ title, author, postUrl: postUrl.startsWith('/') ? `https://www.reddit.com${postUrl}` : postUrl, sub });
      }
      return results.filter(p => p.title && p.author);
    });
    for (const p of posts) {
      leads.push({
        platform: 'Reddit', handle: `u/${p.author}`, name: p.author,
        content: p.title, profileUrl: `https://www.reddit.com/user/${p.author}`,
        postUrl: p.postUrl, subreddit: p.sub, timestamp: new Date().toISOString(),
        contact: extractEmail(p.title),
      });
    }
  } catch (e) { /* Reddit extract failed */ }
  return leads;
}

export async function extractLinkedInLeads(page) {
  const leads = [];
  try {
    await page.waitForSelector('.search-results-container, .entity-result', { timeout: 20000 });
    await humanDelay(2000, 3500);
    const posts = await page.evaluate(() => {
      const cards = document.querySelectorAll('.entity-result, .feed-shared-update-v2');
      const results = [];
      for (const c of Array.from(cards).slice(0, 6)) {
        const nameEl = c.querySelector('.entity-result__title-text, .update-components-actor__name');
        const contentEl = c.querySelector('.entity-result__summary, .update-components-text');
        const linkEl = c.querySelector('a[href*="linkedin.com"]');
        results.push({ name: nameEl?.innerText?.trim() || '', content: contentEl?.innerText?.trim() || '', url: linkEl?.href || '' });
      }
      return results.filter(r => r.name);
    });
    for (const p of posts) {
      leads.push({
        platform: 'LinkedIn', handle: p.name, name: p.name,
        content: p.content, profileUrl: p.url, postUrl: p.url, timestamp: new Date().toISOString(),
        contact: extractEmail(p.content),
      });
    }
  } catch (e) { /* LinkedIn extract failed */ }
  return leads;
}

export async function extractCraigslistLeads(page) {
  const leads = [];
  try {
    await page.waitForSelector('.cl-search-result, li.result-row', { timeout: 15000 });
    const posts = await page.evaluate(() => {
      const rows = document.querySelectorAll('.cl-search-result, li.result-row');
      const results = [];
      for (const r of Array.from(rows).slice(0, 6)) {
        const titleEl = r.querySelector('a.cl-app-anchor, a.result-title');
        results.push({ title: titleEl?.innerText?.trim() || '', url: titleEl?.href || '' });
      }
      return results.filter(r => r.title);
    });
    for (const p of posts) {
      leads.push({
        platform: 'Craigslist', handle: 'Anonymous', name: 'Craigslist Poster',
        content: p.title, profileUrl: p.url, postUrl: p.url, timestamp: new Date().toISOString(),
        contact: extractEmail(p.title),
      });
    }
  } catch (e) { /* Craigslist extract failed */ }
  return leads;
}

export async function extractGoogleLeads(page) {
  const leads = [];
  try {
    await page.waitForSelector('#search .g, .MjjYud', { timeout: 15000 });
    const results = await page.evaluate(() => {
      const items = document.querySelectorAll('#search .g');
      const out = [];
      for (const item of Array.from(items).slice(0, 8)) {
        const titleEl = item.querySelector('h3');
        const snippetEl = item.querySelector('.VwiC3b, .yDYNvb');
        const linkEl = item.querySelector('a');
        out.push({ title: titleEl?.innerText || '', snippet: snippetEl?.innerText || '', url: linkEl?.href || '' });
      }
      return out.filter(o => o.title);
    });
    for (const r of results) {
      leads.push({
        platform: 'Google', handle: new URL(r.url).hostname, name: r.title,
        content: `${r.title} — ${r.snippet}`, profileUrl: r.url, postUrl: r.url, timestamp: new Date().toISOString(),
        contact: extractEmail(r.snippet),
      });
    }
  } catch (e) { /* Google extract failed */ }
  return leads;
}

export async function extractGenericLeads(page) {
  const leads = [];
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await humanDelay(1500, 2500);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    if (text.length > 100) {
      leads.push({
        platform: 'Web', handle: page.url(), name: await page.title(),
        content: text, profileUrl: page.url(), postUrl: page.url(), timestamp: new Date().toISOString(),
        contact: extractEmail(text),
      });
    }
  } catch (e) { /* Generic extract failed */ }
  return leads;
}

export { humanDelay };
