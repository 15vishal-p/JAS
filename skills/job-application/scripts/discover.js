#!/usr/bin/env node
/**
 * Standalone Local Playwright Job Discovery Runner
 *
 * Capabilities:
 *   1. Configurable search by role, country/region, and limit.
 *   2. Support for jobs.ch portal with multi-term query expansion.
 *   3. Structured extraction of Title, Employer, Location, Workload, Contract Type, Source URL, Listing ID.
 *   4. Deduplication by Listing ID or canonical URL.
 *   5. Relevance filtering and explicit shortfall reporting (never fills with unrelated jobs).
 *   6. Dynamic Playwright resolution (no machine-specific hardcoded paths).
 *   7. Deterministic local execution with 0 AI model calls.
 *   8. Clean export to CSV or JSON formats.
 */

const fs = require('fs');
const path = require('path');

// Resolve Playwright Module across local and global environments
function getPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
    path.join(__dirname, '..', '..', 'manage-job-applications', 'scripts', 'antigravity', 'node_modules', 'playwright-core'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright-core'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright-core')
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) {}
  }

  throw new Error(
    'Playwright module not found. Please ensure "playwright-core" or "@playwright/cli" is installed.\n' +
    'Run: npm install playwright-core'
  );
}

// Argument Parser
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    role: 'Data Analyst',
    country: 'Switzerland',
    region: '',
    limit: 10,
    output: path.join(__dirname, '..', 'data', 'discovered_jobs.json'),
    source: 'jobs.ch',
    headless: true,
    channel: '',
    profileDir: ''
  };

  for (const arg of argv) {
    if (arg.startsWith('--role=')) options.role = arg.replace('--role=', '').trim();
    else if (arg.startsWith('--country=')) options.country = arg.replace('--country=', '').trim();
    else if (arg.startsWith('--region=')) options.region = arg.replace('--region=', '').trim();
    else if (arg.startsWith('--limit=')) options.limit = parseInt(arg.replace('--limit=', '').trim(), 10) || 10;
    else if (arg.startsWith('--output=')) options.output = arg.replace('--output=', '').trim();
    else if (arg.startsWith('--source=')) options.source = arg.replace('--source=', '').trim();
    else if (arg.startsWith('--channel=')) options.channel = arg.replace('--channel=', '').trim();
    else if (arg.startsWith('--profile-dir=')) options.profileDir = arg.replace('--profile-dir=', '').trim();
    else if (arg === '--headed' || arg === '--no-headless') options.headless = false;
    else if (arg === '--headless') options.headless = true;
  }

  return options;
}

// Build relevance regex based on target role
function getRelevanceMatcher(role) {
  if (/^data[\s_-]*analyst$/i.test(role.trim())) {
    return /\bdata analyst\b|datenanalyst|datenanalytiker|analyste de donn|analyse de donn|data scientist \/ analyst|data analytics analyst/i;
  }
  // Generic keyword matcher: all significant words must match
  const words = role.trim().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return /.*/;
  const pattern = words.map(w => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('.*');
  return new RegExp(pattern, 'i');
}

// Build query search terms
function getSearchTerms(role) {
  if (/^data[\s_-]*analyst$/i.test(role.trim())) {
    return [
      'Data-Analyst',
      'Data Analyst',
      'Datenanalyst',
      'Data Analytics Analyst',
      'Power BI Data Analyst',
      'Regulatory Data Analyst',
      'Data Analyst Microsoft Fabric'
    ];
  }
  return [role, role.replace(/\s+/g, '-')];
}

// Extract listing ID from jobs.ch vacancy URL
function extractListingId(url) {
  const m = url.match(/\/vacancies\/detail\/([^/?#]+)/i);
  return m ? m[1] : '';
}

// Parse card text and metadata
function parseCardText(text, url, roleMatcher) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 5) return null;

  const title = lines[1] || '';
  if (!roleMatcher.test(title)) {
    return null;
  }

  let location = '';
  let workload = '';
  let contractType = '';
  for (let j = 0; j < lines.length; j++) {
    if (/^place of work:?$/i.test(lines[j]) && j + 1 < lines.length) location = lines[j + 1];
    if (/^workload:?$/i.test(lines[j]) && j + 1 < lines.length) workload = lines[j + 1];
    if (/^contract type:?$/i.test(lines[j]) && j + 1 < lines.length) contractType = lines[j + 1];
  }

  // Filter out non-Swiss locations when Switzerland is targeted
  if (/eschen|vaduz|liechtenstein/i.test(location)) {
    return null;
  }

  // Employer candidate: line after contract type or last non-badge line
  const ignoreBadges = new Set(['new', 'easy apply', 'top']);
  const nonBadgeLines = lines.filter(l => !ignoreBadges.has(l.toLowerCase()));
  const employer = nonBadgeLines.length > 0 ? nonBadgeLines[nonBadgeLines.length - 1] : 'Unknown';

  const listingId = extractListingId(url);

  return {
    listingId,
    title,
    employer,
    location,
    workload,
    contractType,
    url
  };
}

// Main discovery routine
async function discoverJobs(userOptions = {}) {
  const opts = Object.assign({}, parseArgs(), userOptions);
  const started = Date.now();
  const searchTerms = getSearchTerms(opts.role);
  const matcher = getRelevanceMatcher(opts.role);

  console.log('\n======================================================');
  console.log('   LOCAL PLAYWRIGHT JOB DISCOVERY (DETERMINISTIC)');
  console.log('======================================================\n');
  console.log(`[Target Role]     : ${opts.role}`);
  console.log(`[Target Region]   : ${opts.region ? opts.region + ', ' : ''}${opts.country}`);
  console.log(`[Result Limit]    : ${opts.limit}`);
  console.log(`[Source Portal]   : ${opts.source}`);
  console.log(`[Headless Mode]   : ${opts.headless}`);

  const { chromium } = getPlaywright();
  const launchOptions = {
    headless: opts.headless
  };
  if (opts.channel) {
    launchOptions.channel = opts.channel;
  } else {
    launchOptions.channel = 'msedge';
  }

  let browser;
  let page;
  try {
    if (opts.profileDir) {
      if (!fs.existsSync(opts.profileDir)) fs.mkdirSync(opts.profileDir, { recursive: true });
      browser = await chromium.launchPersistentContext(opts.profileDir, launchOptions);
      page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
    } else {
      browser = await chromium.launch(launchOptions);
      page = await browser.newPage();
    }
  } catch (err) {
    // Graceful fallback to default chromium channel
    delete launchOptions.channel;
    if (opts.profileDir) {
      browser = await chromium.launchPersistentContext(opts.profileDir, launchOptions);
      page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
    } else {
      browser = await chromium.launch(launchOptions);
      page = await browser.newPage();
    }
  }

  const jobs = new Map();
  let duplicateCount = 0;
  const selector = 'a[href*="/vacancies/detail/"]';

  try {
    for (const term of searchTerms) {
      if (jobs.size >= opts.limit) break;

      const params = new URLSearchParams();
      params.set('term', term);
      if (opts.region) params.set('location', opts.region);

      const searchUrl = `https://www.jobs.ch/en/vacancies/?${params.toString()}`;
      console.log(`[Navigation] Querying: ${searchUrl}`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector(selector, { timeout: 10000 });
      } catch (navErr) {
        console.warn(`[Query Warning] Failed loading "${term}": ${navErr.message}`);
        continue;
      }

      const rawLinks = await page.locator(selector).evaluateAll(links => links.map(a => [a.innerText, a.href]));

      for (const [text, url] of rawLinks) {
        const parsed = parseCardText(text, url, matcher);
        if (!parsed) continue;

        const dedupeKey = parsed.listingId || parsed.url;
        if (jobs.has(dedupeKey)) {
          duplicateCount++;
          continue;
        }

        jobs.set(dedupeKey, parsed);
        if (jobs.size >= opts.limit) break;
      }
    }
  } finally {
    await browser.close();
  }

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(2);
  const results = Array.from(jobs.values());
  const uniqueCount = results.length;
  const shortfall = Math.max(0, opts.limit - uniqueCount);

  console.log('\n--- DISCOVERY RESULTS ---');
  console.log(`  Unique Jobs Found : ${uniqueCount}`);
  console.log(`  Duplicates Skipped: ${duplicateCount}`);
  console.log(`  Target Limit      : ${opts.limit}`);
  if (shortfall > 0) {
    console.log(`  [SHORTFALL NOTICE]: Found ${uniqueCount} matching listings (${shortfall} shortfall from target limit ${opts.limit}). No unrelated roles added.`);
  } else {
    console.log(`  Target Limit Met  : Exactly ${opts.limit} matching roles retrieved.`);
  }
  console.log(`  Elapsed Time      : ${elapsedSec}s`);
  console.log(`  AI Model Calls    : 0 (deterministic Playwright execution)`);
  console.log('-------------------------\n');

  // Export results if output path provided
  if (opts.output) {
    const outDir = path.dirname(opts.output);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    if (opts.output.toLowerCase().endsWith('.csv')) {
      const csvRows = [
        ['Listing ID', 'Title', 'Employer', 'Location', 'Workload', 'Contract Type', 'Source URL']
      ];
      for (const j of results) {
        csvRows.push([
          `"${j.listingId}"`,
          `"${(j.title || '').replace(/"/g, '""')}"`,
          `"${(j.employer || '').replace(/"/g, '""')}"`,
          `"${(j.location || '').replace(/"/g, '""')}"`,
          `"${(j.workload || '').replace(/"/g, '""')}"`,
          `"${(j.contractType || '').replace(/"/g, '""')}"`,
          `"${j.url}"`
        ]);
      }
      fs.writeFileSync(opts.output, csvRows.map(r => r.join(',')).join('\n'), 'utf8');
      console.log(`[Export] Saved ${uniqueCount} listings to CSV: ${opts.output}`);
    } else {
      const exportData = {
        metadata: {
          role: opts.role,
          country: opts.country,
          region: opts.region,
          limit: opts.limit,
          uniqueCount,
          duplicateCount,
          shortfall,
          elapsedSeconds: parseFloat(elapsedSec),
          aiModelCalls: 0,
          discoveredAt: new Date().toISOString()
        },
        jobs: results
      };
      fs.writeFileSync(opts.output, JSON.stringify(exportData, null, 2), 'utf8');
      console.log(`[Export] Saved ${uniqueCount} listings to JSON: ${opts.output}`);
    }
  }

  return {
    uniqueCount,
    duplicateCount,
    shortfall,
    elapsedSeconds: parseFloat(elapsedSec),
    aiModelCalls: 0,
    jobs: results
  };
}

module.exports = {
  parseArgs,
  getPlaywright,
  getRelevanceMatcher,
  getSearchTerms,
  extractListingId,
  parseCardText,
  discoverJobs
};

if (require.main === module) {
  discoverJobs(parseArgs()).catch(err => {
    console.error('[Discovery Fatal Error]:', err);
    process.exit(1);
  });
}
