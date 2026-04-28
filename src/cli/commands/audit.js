import chalk from 'chalk';
import fs from 'fs-extra';

const orange = chalk.hex('#FF6B35');
const green = chalk.hex('#16C784');
const dim = chalk.dim;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function extractTag(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) matches.push(m[1].trim());
  return matches;
}

function extractMeta(html, nameOrProperty) {
  const re = new RegExp(
    `<meta[^>]*(?:name|property)=["']${nameOrProperty}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const alt = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${nameOrProperty}["']`,
    'i',
  );
  const m = html.match(re) || html.match(alt);
  return m ? m[1] : null;
}

function extractLinks(html, baseUrl) {
  const re = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push({ href: m[1], text: m[2].replace(/<[^>]*>/g, '').trim() });
  }

  const internal = links.filter((l) => {
    try {
      const u = new URL(l.href, baseUrl);
      return u.hostname === new URL(baseUrl).hostname;
    } catch {
      return false;
    }
  });
  const external = links.filter((l) => !internal.includes(l));
  const emptyAnchors = links.filter((l) => l.text.length === 0);

  return {
    total: links.length,
    internal: internal.length,
    external: external.length,
    emptyAnchors: emptyAnchors.length,
    links: links.slice(0, 50),
  };
}

function extractImages(html) {
  const re = /<img[^>]*>/gi;
  const images = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const src = (tag.match(/src=["']([^"']*)["']/i) || [])[1] || '';
    const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    const loading = (tag.match(/loading=["']([^"']*)["']/i) || [])[1] || '';
    images.push({ src, alt, loading });
  }
  return images;
}

function wordCount(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.split(' ').length : 0;
}

// ---------------------------------------------------------------------------
// Audit checks
// ---------------------------------------------------------------------------

function check(name, pass, value, note) {
  return {
    name,
    status: pass === null ? 'N/A' : pass ? 'PASS' : 'FAIL',
    value,
    note: note || '',
  };
}

function auditTechnical(url, html, headers, timing) {
  const results = [];

  results.push(check('HTTPS enabled', url.startsWith('https'), url));

  results.push(
    check('Server response time', timing < 500, `${timing}ms`, timing < 500 ? 'Good' : 'Slow - target < 500ms'),
  );

  const hasViewport = /meta[^>]*name=["']viewport["']/i.test(html);
  results.push(check('Mobile viewport meta', hasViewport, hasViewport));

  const canonical = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) || [])[1];
  results.push(check('Canonical tag', !!canonical, canonical || 'Missing'));

  const lang = (html.match(/<html[^>]*lang=["']([^"']*)["']/i) || [])[1];
  results.push(check('HTML lang attribute', !!lang, lang || 'Missing'));

  const hasCharset = /meta[^>]*charset/i.test(html);
  results.push(check('Charset declaration', hasCharset, hasCharset));

  const encoding = headers['content-encoding'] || '';
  const compressed = /gzip|br|deflate/i.test(encoding);
  results.push(check('Compression (gzip/br)', compressed, encoding || 'None'));

  return results;
}

function auditOnPage(html) {
  const results = [];

  const titles = extractTag(html, 'title');
  const title = titles[0] || '';
  results.push(
    check('Title tag exists', titles.length === 1 && title.length > 0, title || 'Missing', title ? `${title.length} chars` : 'No title tag found'),
  );
  results.push(
    check('Title length (50-60 chars)', title.length >= 50 && title.length <= 60, `${title.length} chars`, title.length < 50 ? 'Too short' : title.length > 60 ? 'Too long' : 'Good'),
  );

  const desc = extractMeta(html, 'description') || '';
  results.push(check('Meta description exists', desc.length > 0, desc || 'Missing'));
  results.push(check('Meta description length (150-160)', desc.length >= 150 && desc.length <= 160, `${desc.length} chars`));

  const h1s = extractTag(html, 'h1');
  results.push(check('H1 tag exists and unique', h1s.length === 1, `${h1s.length} H1 tags found`));

  const h2s = extractTag(html, 'h2');
  results.push(check('H2 tags present', h2s.length > 0, `${h2s.length} H2 tags`));

  const images = extractImages(html);
  const imagesWithAlt = images.filter((img) => img.alt.length > 0);
  const allHaveAlt = images.length === 0 || imagesWithAlt.length === images.length;
  results.push(
    check('Images have alt text', allHaveAlt, `${imagesWithAlt.length}/${images.length} have alt`, allHaveAlt ? 'Good' : 'Add alt text to all images'),
  );

  const lazyLoaded = images.filter((img) => img.loading === 'lazy');
  results.push(check('Images use lazy loading', images.length === 0 || lazyLoaded.length > 0, `${lazyLoaded.length}/${images.length} lazy`));

  const ogTitle = extractMeta(html, 'og:title');
  const ogDesc = extractMeta(html, 'og:description');
  const ogImage = extractMeta(html, 'og:image');
  results.push(
    check('Open Graph tags', !!(ogTitle && ogDesc && ogImage), { title: ogTitle || 'Missing', description: ogDesc || 'Missing', image: ogImage || 'Missing' }),
  );

  const twCard = extractMeta(html, 'twitter:card');
  results.push(check('Twitter Card meta', !!twCard, twCard || 'Missing'));

  const wc = wordCount(html);
  results.push(check('Content length (300+ words)', wc >= 300, `${wc} words`));

  const hasFavicon = /<link[^>]*rel=["'](?:shortcut )?icon["']/i.test(html);
  results.push(check('Favicon configured', hasFavicon, hasFavicon));

  return results;
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

function calcScore(checks) {
  let total = 0;
  let passed = 0;
  for (const c of checks) {
    if (c.status === 'N/A') continue;
    total++;
    if (c.status === 'PASS') passed++;
  }
  return total === 0 ? 100 : Math.round((passed / total) * 100);
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runAudit({ url, tier, output }) {
  console.log(orange.bold('\n  CashClaw SEO Auditor\n'));
  console.log(`  ${dim('URL:')}   ${url}`);
  console.log(`  ${dim('Tier:')}  ${tier || 'basic'}\n`);

  const startTime = Date.now();
  let html, headers, status;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CashClawBot/1.0 (+https://cashclaw.ai) Mozilla/5.0 compatible',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    status = response.status;
    headers = Object.fromEntries(response.headers.entries());
    html = await response.text();
  } catch (err) {
    console.error(chalk.red(`  Failed to fetch ${url}: ${err.message}\n`));
    return;
  }

  const timing = Date.now() - startTime;

  console.log(`  ${dim('Status:')}        ${status}`);
  console.log(`  ${dim('Response time:')} ${timing}ms`);
  console.log(`  ${dim('Page size:')}     ${(html.length / 1024).toFixed(1)}KB\n`);

  const technical = auditTechnical(url, html, headers, timing);
  const onPage = auditOnPage(html);
  const linkData = extractLinks(html, url);

  const allChecks = [...technical, ...onPage];
  const overallScore = calcScore(allChecks);
  const technicalScore = calcScore(technical);
  const onPageScore = calcScore(onPage);

  // Print results table
  console.log(orange('  Technical Checks\n'));
  for (const c of technical) {
    const icon = c.status === 'PASS' ? green('PASS') : c.status === 'FAIL' ? chalk.red('FAIL') : dim('N/A');
    console.log(`    [${icon}] ${c.name}${c.note ? dim(` — ${c.note}`) : ''}`);
  }

  console.log(orange('\n  On-Page Checks\n'));
  for (const c of onPage) {
    const icon = c.status === 'PASS' ? green('PASS') : c.status === 'FAIL' ? chalk.red('FAIL') : dim('N/A');
    console.log(`    [${icon}] ${c.name}${c.note ? dim(` — ${c.note}`) : ''}`);
  }

  console.log(orange('\n  Score Summary\n'));
  console.log(`    ${dim('Overall:')}    ${overallScore}/100 (${grade(overallScore)})`);
  console.log(`    ${dim('Technical:')}  ${technicalScore}/100 (${grade(technicalScore)})`);
  console.log(`    ${dim('On-Page:')}    ${onPageScore}/100 (${grade(onPageScore)})`);

  const failures = allChecks.filter((c) => c.status === 'FAIL').length;
  const passes = allChecks.filter((c) => c.status === 'PASS').length;
  console.log(`    ${dim('Issues:')}     ${failures} failures, ${passes} passed\n`);

  // Build audit report object
  const audit = {
    url,
    tier: tier || 'basic',
    audited_at: new Date().toISOString(),
    response: { status, timing_ms: timing, page_size_bytes: html.length, content_type: headers['content-type'] || '' },
    scores: {
      overall: overallScore, overall_grade: grade(overallScore),
      technical: technicalScore, technical_grade: grade(technicalScore),
      on_page: onPageScore, on_page_grade: grade(onPageScore),
    },
    technical,
    on_page: onPage,
    links: linkData,
    images: extractImages(html).length,
    word_count: wordCount(html),
    headings: { h1: extractTag(html, 'h1'), h2: extractTag(html, 'h2'), h3: extractTag(html, 'h3') },
  };

  if (output) {
    const json = JSON.stringify(audit, null, 2);
    await fs.writeFile(output, json, 'utf-8');
    console.log(green(`  Report saved to ${output}\n`));
  }
}
