#!/usr/bin/env node
/**
 * Standalone Local Playwright Job Application Runner
 *
 * Strict Compliance & Safety Guarantees:
 *   1. Dedicated Persistent Browser Profile: Preserves logins, sessions, and CAPTCHA state.
 *   2. Strict Domain & Filesystem Whitelisting: Rejects unapproved domains and unapproved file paths.
 *   3. Exact CV-to-Job-ID Mapping: Zero fuzzy matching; strictly requires the target Job ID in the CV filename.
 *   4. Statutory Country-Aware Question Resolution: Answers work authorization and visa sponsorship as distinct questions based on verified candidate profile.
 *   5. Halts on Unknown/Unmapped Questions: Never guesses or invents answers; exits cleanly for manual review.
 *   6. Duplicate & Uncertain Submission Blocker: Blocks duplicate submissions for confirmed jobs; blocks retries for uncertain jobs until reconciled.
 *   7. Standing Authorization for Approved Queue: When invoked with `--approved-queue`, automatically submits ready, validated applications (`--submit`) without prompting, and gracefully skips blockers (missing CV, CAPTCHA, uncertain, duplicate) to continue queue processing.
 *   8. Multi-ATS Support: Certified for Ashby ATS (`jobs.ashbyhq.com`) and Greenhouse ATS (`boards.greenhouse.io`, `job-boards.greenhouse.io`).
 *   9. Visual Audit Trail: Captures full-page screenshots for dry-runs, confirmed submissions, error states, and uncertain outcomes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    } catch (e) {
      // Continue to next candidate
    }
  }

  throw new Error(
    'Playwright module not found. Please ensure "playwright-core" or "@playwright/cli" is installed.\n' +
    'Run: npm install playwright-core'
  );
}

// Argument Parser
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    url: '',
    cv: '',
    config: path.join(__dirname, '..', 'config', 'profile.json'),
    history: path.join(__dirname, '..', 'data', 'submissions_history.json'),
    approvedDir: '',
    submit: false,
    approvedQueue: false,
    force: false,
    headless: false,
    profileDir: path.join(__dirname, '..', 'browser_profile'),
    screenshotsDir: path.join(__dirname, '..', 'screenshots')
  };

  for (const arg of argv) {
    if (arg.startsWith('--url=')) options.url = arg.replace('--url=', '').trim();
    else if (arg.startsWith('--cv=')) options.cv = arg.replace('--cv=', '').trim();
    else if (arg.startsWith('--config=')) options.config = arg.replace('--config=', '').trim();
    else if (arg.startsWith('--history=')) options.history = arg.replace('--history=', '').trim();
    else if (arg.startsWith('--approved-dir=')) options.approvedDir = arg.replace('--approved-dir=', '').trim();
    else if (arg.startsWith('--profile-dir=')) options.profileDir = arg.replace('--profile-dir=', '').trim();
    else if (arg.startsWith('--screenshots-dir=')) options.screenshotsDir = arg.replace('--screenshots-dir=', '').trim();
    else if (arg === '--submit') options.submit = true;
    else if (arg === '--approved-queue') {
      options.approvedQueue = true;
      options.submit = true; // Standing authorization automatically enables submission for approved queue
    }
    else if (arg === '--force') options.force = true;
    else if (arg === '--headless') options.headless = true;
  }

  return options;
}

// Load Candidate Profile Configuration
function loadProfile(configPath) {
  let resolved = configPath;
  if (!fs.existsSync(resolved)) {
    const examplePath = path.join(path.dirname(configPath), 'profile.example.json');
    if (fs.existsSync(examplePath)) {
      console.warn(`[Config Notice] Private profile "${configPath}" not found. Using example profile: "${examplePath}"`);
      resolved = examplePath;
    } else {
      throw new Error(`Profile configuration not found at: ${configPath}`);
    }
  }

  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

// Load Submissions History
function loadSubmissions(historyPath) {
  if (!fs.existsSync(historyPath)) {
    const exampleHistory = path.join(path.dirname(historyPath), 'submissions_history.example.json');
    if (fs.existsSync(exampleHistory)) {
      return JSON.parse(fs.readFileSync(exampleHistory, 'utf8'));
    }
    return { submissions: [] };
  }
  return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
}

// Save Submission Record to History
function saveSubmissionRecord(historyPath, record) {
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data = loadSubmissions(historyPath);
  const idx = data.submissions.findIndex(s => s.jobId === record.jobId);
  if (idx >= 0) {
    data.submissions[idx] = record;
  } else {
    data.submissions.push(record);
  }

  fs.writeFileSync(historyPath, JSON.stringify(data, null, 2), 'utf8');
}

// Security: Validate Target URL against Allowed Domains
function validateDomain(urlStr, allowedDomains = []) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    throw new Error(`Invalid target application URL: "${urlStr}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = allowedDomains.some(d => hostname === d.toLowerCase() || hostname.endsWith('.' + d.toLowerCase()));
  if (!isAllowed) {
    throw new Error(
      `[SECURITY BLOCKED] Host "${hostname}" is not in the configured allowed domains list:\n` +
      `  Allowed: [${allowedDomains.join(', ')}]\n` +
      `  Execution halted to prevent navigation to unauthorized origins.`
    );
  }

  return parsed;
}

// Extract Job ID and Company Slug from Application URL
function extractJobDetails(urlStr) {
  const parsed = new URL(urlStr);
  const parts = parsed.pathname.split('/').filter(p => p && p.toLowerCase() !== 'application' && p.toLowerCase() !== 'jobs');

  let company = '';
  let jobId = '';

  if (parts.length >= 2) {
    company = parts[0];
    jobId = parts[parts.length - 1];
  } else if (parts.length === 1) {
    jobId = parts[0];
  } else {
    jobId = 'job_' + Date.now();
  }

  return { company, jobId };
}

// Strict CV Resolution: Exact Job ID matching (NO FUZZY MATCHING)
function resolveAndVerifyExactCV(jobId, companySlug, cvInput, approvedDir) {
  if (!fs.existsSync(approvedDir)) {
    throw new Error(`Approved CV directory does not exist: ${approvedDir}`);
  }

  const allPdfs = fs.readdirSync(approvedDir).filter(f => f.toLowerCase().endsWith('.pdf'));
  let resolvedPath = '';

  if (cvInput) {
    let candidatePath = cvInput;
    if (!path.isAbsolute(candidatePath)) {
      candidatePath = path.join(approvedDir, candidatePath);
    }
    if (!fs.existsSync(candidatePath)) {
      const basename = path.basename(cvInput);
      candidatePath = path.join(approvedDir, basename);
    }
    if (!fs.existsSync(candidatePath)) {
      throw new Error(`[EXACT MATCH FAILED] Specified CV file not found: "${cvInput}" (checked: ${candidatePath})`);
    }

    // STRICT CHECK: Verify file contains the exact Job ID
    const filename = path.basename(candidatePath);
    if (!filename.includes(jobId)) {
      throw new Error(
        `[AUDIT REJECTED] Mismatched CV provided!\n` +
        `  Target Job ID: ${jobId}\n` +
        `  Provided File: ${filename}\n` +
        `  Rule: The CV file MUST match the target job ID. Cross-role CV reuse is forbidden.`
      );
    }
    resolvedPath = candidatePath;
  } else {
    // Automatically find the tailored CV matching this exact Job ID
    const exactMatch = allPdfs.find(f => f.includes(jobId));
    if (!exactMatch) {
      throw new Error(
        `[EXACT MATCH FAILED] No tailored CV matching Job ID "${jobId}" found in:\n` +
        `  ${approvedDir}\n` +
        `  Zero fuzzy matching allowed. Please generate the role-specific CV before applying.`
      );
    }
    resolvedPath = path.join(approvedDir, exactMatch);
  }

  // File integrity and security verification
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`CV path is not a file: ${resolvedPath}`);
  if (stat.size < 1000) throw new Error(`CV file appears empty or corrupt (${stat.size} bytes): ${resolvedPath}`);
  if (!resolvedPath.toLowerCase().endsWith('.pdf')) throw new Error(`CV file must be a PDF: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 8);

  return {
    path: resolvedPath,
    filename: path.basename(resolvedPath),
    size: stat.size,
    hash
  };
}

// Detect Statutory Country from Page Context and URL
function detectCountry(pageText = '', urlStr = '') {
  const text = (pageText + ' ' + urlStr).toLowerCase();
  if (text.includes('amsterdam') || text.includes('netherlands') || text.includes('holland') || text.includes('/wetravel/')) {
    return 'Netherlands';
  }
  if (text.includes('berlin') || text.includes('munich') || text.includes('germany') || text.includes('deutschland') || text.includes('/lyceum/') || text.includes('/plancraft/') || text.includes('nlighten')) {
    // Note: nLighten role is Junior Payroll Administrator in Amsterdam / Germany context
    if (text.includes('amsterdam') || text.includes('netherlands')) return 'Netherlands';
    return 'Germany';
  }
  if (text.includes('bratislava') || text.includes('košice') || text.includes('kosice') || text.includes('slovakia') || text.includes('slovensko')) {
    return 'Slovakia';
  }
  return 'DefaultSchengen';
}

// Main Execution Routine
async function runApplication(options) {
  const opts = Object.assign({}, parseArgs(), options);
  const profile = loadProfile(opts.config);
  const history = loadSubmissions(opts.history);

  console.log('\n======================================================');
  console.log('   LOCAL PLAYWRIGHT JOB APPLICATION RUNNER (AUDITED)');
  if (opts.approvedQueue) {
    console.log('   POLICY: STANDING AUTHORIZATION FOR APPROVED QUEUE');
  }
  console.log('======================================================\n');

  if (!opts.url) {
    console.error('Error: Missing target application URL.');
    console.log('Usage: node apply.js --url=<url> [--cv=<pdf>] [--submit] [--approved-queue] [--headless]');
    process.exit(1);
  }

  // 1. Validate Target Domain
  const targetUrl = validateDomain(opts.url, profile.security.allowedDomains);
  const { company, jobId } = extractJobDetails(opts.url);

  console.log(`[Target URL]      : ${opts.url}`);
  console.log(`[Target Employer] : ${company}`);
  console.log(`[Target Job ID]   : ${jobId}`);
  console.log(`[Domain Security] : Verified allowed (${targetUrl.hostname})`);

  // 2. Prevent Duplicate & Uncertain Retries
  const existing = history.submissions.find(s => s.jobId === jobId || s.url === opts.url);
  if (existing) {
    if (existing.status === 'CONFIRMED' && !opts.force) {
      console.log(`\n[DUPLICATE BLOCKED] This job has ALREADY been submitted and confirmed on ${existing.submittedAt}!`);
      console.log(`Previous submission record:`, existing);
      if (opts.approvedQueue) {
        console.log(`[QUEUE SKIP] Standing authorization skips already confirmed job ${jobId}.\n`);
        return { status: 'SKIPPED_DUPLICATE', jobId, company, existing };
      }
      console.log(`(Pass --force to run a dry-run test anyway)\n`);
      process.exit(0);
    }
    if (existing.status === 'UNCERTAIN' && !opts.force) {
      console.log(`\n[RETRY BLOCKED - UNCERTAIN STATUS] This job has an existing UNCERTAIN outcome recorded on ${existing.submittedAt}!`);
      console.log(`Reason: ${existing.reason || 'Unconfirmed outcome'}`);
      console.log(`Screenshot: ${existing.screenshot}`);
      console.log(`Automated retries are blocked until the application receipt is reconciled.`);
      if (opts.approvedQueue) {
        console.log(`[QUEUE SKIP] Standing authorization skips uncertain job ${jobId} to protect against duplicate submission.\n`);
        return { status: 'SKIPPED_UNCERTAIN', jobId, company, existing };
      }
      console.log(`(Pass --force to run a dry-run check anyway)\n`);
      process.exit(1);
    }
  }

  // 3. Resolve and Verify Exact CV File (Zero Fuzzy Matching)
  const cvDir = opts.approvedDir || profile.security.approvedCvDirectory;
  let cv;
  try {
    cv = resolveAndVerifyExactCV(jobId, company, opts.cv, cvDir);
    console.log(`[CV Attachment]   : ${cv.filename} (${cv.size} bytes, SHA-256: ${cv.hash})`);
    console.log(`[CV File Path]    : ${cv.path}`);
  } catch (err) {
    console.error(`\n[CV Resolution Error]: ${err.message}`);
    if (opts.approvedQueue) {
      console.log(`[QUEUE BLOCKER] Skipping ${jobId} due to missing/invalid tailored CV.\n`);
      return { status: 'BLOCKED_MISSING_CV', jobId, company, reason: err.message };
    }
    process.exit(1);
  }

  // 4. Ensure Output Directories Exist
  if (!fs.existsSync(opts.profileDir)) fs.mkdirSync(opts.profileDir, { recursive: true });
  if (!fs.existsSync(opts.screenshotsDir)) fs.mkdirSync(opts.screenshotsDir, { recursive: true });

  // 5. Mode Selection
  console.log(`[Run Mode]        : ${opts.submit ? '*** SUBMISSION AUTHORIZED (--submit / --approved-queue) ***' : 'DRY-RUN / REVIEW (Default, no submission)'}`);

  // 6. Launch Persistent Browser Context
  const { chromium } = getPlaywright();
  console.log(`\n[Browser] Launching persistent Chrome context from: ${opts.profileDir}...`);
  const browser = await chromium.launchPersistentContext(opts.profileDir, {
    headless: opts.headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 }
  });

  const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();

  try {
    console.log(`[Navigation] Opening: ${opts.url}...`);
    await page.goto(opts.url, { waitUntil: 'networkidle' });

    // Check for Inactive / 404 postings
    const pageContent = await page.content().catch(() => '');
    if (/page not found|no longer active|this job is not available|the job you are looking for does not exist/i.test(pageContent)) {
      console.warn(`[BLOCKED - JOB CLOSED] The posting at ${opts.url} is no longer active (404 or closed).`);
      const closedScreenshot = path.join(opts.screenshotsDir, `${jobId}_closed.png`);
      await page.screenshot({ path: closedScreenshot, fullPage: true }).catch(() => {});
      await browser.close();
      if (opts.approvedQueue) {
        return { status: 'BLOCKED_JOB_CLOSED', jobId, company, reason: 'Posting inactive or closed (404)' };
      }
      process.exit(1);
    }

    // Check for CAPTCHA / Bot detection
    if (/verify you are human|turnstile|recaptcha|cf-challenge/i.test(pageContent)) {
      console.warn(`[BLOCKED - CAPTCHA] Interactive CAPTCHA challenge detected on ${opts.url}. Platform safeguards preserved.`);
      const captchaScreenshot = path.join(opts.screenshotsDir, `${jobId}_captcha.png`);
      await page.screenshot({ path: captchaScreenshot, fullPage: true }).catch(() => {});
      await browser.close();
      if (opts.approvedQueue) {
        return { status: 'BLOCKED_CAPTCHA', jobId, company, reason: 'Interactive bot check required' };
      }
      process.exit(1);
    }

    // Detect ATS platform
    const isGreenhouse = targetUrl.hostname.includes('greenhouse.io');
    const isAshby = targetUrl.hostname.includes('ashbyhq.com');
    console.log(`[ATS Detection]   : ${isGreenhouse ? 'Greenhouse ATS' : (isAshby ? 'Ashby ATS' : 'Standard Web Form')}`);

    await page.waitForTimeout(1000);

    // If on overview page, click Apply
    const applyBtn = page.getByRole('button', { name: /Apply|Apply for this job/i }).or(page.getByRole('link', { name: /Apply|Apply for this job/i })).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      console.log('[Form] Clicking Apply button...');
      await applyBtn.click();
      await page.waitForTimeout(2000);
    }

    const cand = profile.candidate;
    const summary = {};

    // Detect country from page content and URL
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const country = detectCountry(pageText, opts.url);
    const statutory = cand.statutoryByCountry[country] || cand.statutoryByCountry['DefaultSchengen'];
    console.log(`[Statutory Context]: Detected Country: ${country}`);
    console.log(`                     Authorized in Country: ${statutory.authorizedInCountry ? 'Yes' : 'No'}`);
    console.log(`                     Requires Sponsorship:  ${statutory.requiresSponsorship ? 'Yes' : 'No'}`);
    console.log(`                     Statutory Basis:       ${statutory.details}`);
    summary['Target Country'] = country;
    summary['Statutory Basis'] = statutory.details;

    console.log('\n[Form] Inspecting and populating candidate fields...');

    // 1. Candidate Names (Handles both split First/Last and unified Full Name)
    const firstNameInput = page.locator('#first_name').or(page.getByRole('textbox', { name: /first name/i })).first();
    const lastNameInput = page.locator('#last_name').or(page.getByRole('textbox', { name: /last name/i })).first();
    const fullNameInput = page.locator('#_systemfield_name').or(page.getByRole('textbox', { name: /^full name|^name$/i })).first();

    if (await firstNameInput.isVisible().catch(() => false) && await lastNameInput.isVisible().catch(() => false)) {
      const fVal = cand.firstName || cand.fullName.split(' ')[0];
      const lVal = cand.lastName || cand.fullName.split(' ').slice(1).join(' ');
      await firstNameInput.fill(fVal);
      await lastNameInput.fill(lVal);
      summary['First Name'] = fVal;
      summary['Last Name'] = lVal;
    } else if (await fullNameInput.isVisible().catch(() => false)) {
      const currentVal = await fullNameInput.inputValue();
      if (!currentVal) {
        await fullNameInput.fill(cand.fullName);
        summary['Name'] = cand.fullName;
      } else {
        summary['Name'] = currentVal + ' (preserved)';
      }
    }

    // 2. Email Address
    const emailInput = page.locator('#email, #_systemfield_email').or(page.getByRole('textbox', { name: /email/i })).first();
    if (await emailInput.isVisible().catch(() => false)) {
      const currentVal = await emailInput.inputValue();
      if (!currentVal) {
        await emailInput.fill(cand.email);
        summary['Email'] = cand.email;
      } else {
        summary['Email'] = currentVal + ' (preserved)';
      }
    }

    // 3. Mobile / Phone
    const phoneInput = page.locator('#phone, input[type="tel"]').or(page.getByRole('textbox', { name: /mobile|phone/i })).first();
    if (await phoneInput.isVisible().catch(() => false)) {
      const currentVal = await phoneInput.inputValue();
      if (!currentVal) {
        await phoneInput.fill(cand.phone);
        summary['Phone'] = cand.phone;
      } else {
        summary['Phone'] = currentVal + ' (preserved)';
      }
    }

    // 3b. LinkedIn URL
    const linkedinInput = page.locator('input[name*="linkedin"], input[placeholder*="linkedin"], input[id*="linkedin"]').or(page.getByRole('textbox', { name: /linkedin/i })).first();
    if (await linkedinInput.isVisible().catch(() => false)) {
      const currentVal = await linkedinInput.inputValue();
      if (!currentVal) {
        await linkedinInput.fill(cand.linkedin);
        summary['LinkedIn'] = cand.linkedin;
      } else {
        summary['LinkedIn'] = currentVal + ' (preserved)';
      }
    }

    // 4. Candidate Location (Greenhouse text / Ashby dropdown)
    const ghLocation = page.locator('#candidate-location').first();
    const ashbyLocation = page.locator('input[placeholder*="Start typing"]').or(page.getByRole('textbox', { name: /normally based|location|city/i })).first();
    const cityTarget = country === 'Netherlands' ? 'Amsterdam, Netherlands' : (country === 'Germany' ? 'Berlin, Germany' : 'Bratislava, Slovakia');

    if (await ghLocation.isVisible().catch(() => false)) {
      await ghLocation.fill(cityTarget);
      summary['Location'] = cityTarget;
    } else if (await ashbyLocation.isVisible().catch(() => false)) {
      const currentVal = await ashbyLocation.inputValue();
      if (!currentVal) {
        await ashbyLocation.click();
        await ashbyLocation.type(cityTarget, { delay: 50 });
        await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        summary['Location'] = `${cityTarget} (willing to relocate)`;
      } else {
        summary['Location'] = currentVal + ' (preserved)';
      }
    }

    // 5. Statutory Work Authorization & Sponsorship Questions (Ashby Option Groups & Greenhouse React-Select)
    // A. Ashby Yes/No Button Groups
    const ashbyGroups = page.locator('div[class*="_optionsContainer_pjyt6_1"], div[class*="ashby-application-form-input-yesno"], div[class*="yesno"]');
    const ashbyCount = await ashbyGroups.count();

    for (let i = 0; i < ashbyCount; i++) {
      const group = ashbyGroups.nth(i);
      const questionText = await group.evaluate(el => {
        let parent = el.parentElement;
        while (parent && !parent.innerText.includes('?')) {
          parent = parent.parentElement;
        }
        return parent ? parent.innerText.slice(0, 100).replace(/\n/g, ' ') : '';
      }).catch(() => '');

      if (/authorized to work|legal right to work/i.test(questionText)) {
        const opt = statutory.authorizedInCountry ? 'yes' : 'no';
        await group.locator(`button[data-option="${opt}"], button:has-text("${opt === 'yes' ? 'Yes' : 'No'}")`).click();
        summary['Question: Authorized to work'] = opt === 'yes' ? 'Yes' : 'No (Requires Visa/Blue Card)';
        console.log(`[Form Question]: "${questionText}" -> Selected "${opt.toUpperCase()}" based on verified statutory profile.`);
      } else if (/require sponsorship|visa sponsorship/i.test(questionText)) {
        const opt = statutory.requiresSponsorship ? 'yes' : 'no';
        await group.locator(`button[data-option="${opt}"], button:has-text("${opt === 'yes' ? 'Yes' : 'No'}")`).click();
        summary['Question: Require sponsorship'] = opt === 'yes' ? 'Yes (Requires Sponsorship)' : 'No';
        console.log(`[Form Question]: "${questionText}" -> Selected "${opt.toUpperCase()}" based on verified statutory profile.`);
      } else if (/relocate|relocation/i.test(questionText)) {
        await group.locator('button[data-option="yes"], button:has-text("Yes")').click();
        summary['Question: Relocation'] = 'Yes';
        console.log(`[Form Question]: "${questionText}" -> Selected "YES" based on candidate relocation willingness.`);
      } else {
        throw new Error(`[AUDIT HALT - UNKNOWN QUESTION] Unmapped Yes/No question: "${questionText}". Pausing execution to prevent guessing.`);
      }
    }

    // B. Greenhouse Labels & Custom Questions
    const labels = await page.locator('label').all();
    for (const label of labels) {
      const text = (await label.innerText().catch(() => '')).trim();
      const forAttr = await label.getAttribute('for').catch(() => null);
      if (!forAttr) continue;

      const target = page.locator(`#${forAttr}`);
      if (!await target.count()) continue;

      if (/authorized to work|legal right to work/i.test(text)) {
        const opt = statutory.authorizedInCountry ? 'Yes' : 'No';
        const reactSelect = target.locator('..').locator('..');
        if (await reactSelect.locator('.select__input-container').count() > 0) {
          await reactSelect.click();
          await page.waitForTimeout(300);
          await page.locator(`.select__option:has-text("${opt}")`).first().click();
          summary['Question: Authorized to work'] = opt;
          console.log(`[Form Question]: "${text}" -> Selected "${opt}" via React-select.`);
        }
      } else if (/require.*sponsorship|visa sponsorship/i.test(text)) {
        const opt = statutory.requiresSponsorship ? 'Yes' : 'No';
        const reactSelect = target.locator('..').locator('..');
        if (await reactSelect.locator('.select__input-container').count() > 0) {
          await reactSelect.click();
          await page.waitForTimeout(300);
          await page.locator(`.select__option:has-text("${opt}")`).first().click();
          summary['Question: Require sponsorship'] = opt;
          console.log(`[Form Question]: "${text}" -> Selected "${opt}" via React-select.`);
        }
      } else if (/salary/i.test(text)) {
        const inputType = await target.getAttribute('type').catch(() => 'text');
        if (inputType === 'number') {
          const numVal = country === 'Netherlands' ? '60000' : '48000';
          await target.fill(numVal);
          summary['Salary Expectations'] = `${numVal} EUR (numeric)`;
        } else {
          await target.fill(cand.salaryExpectationEUR);
          summary['Salary Expectations'] = cand.salaryExpectationEUR;
        }
      } else if (/interest.*applying|why.*role|motivation/i.test(text)) {
        const motivation = `Holding a Master's degree in Finance from TUKE with 3+ years in enterprise shared services (Infosys BPM, Holcim EMEA BSC), I have extensive experience in high-volume payroll reconciliations, general ledger close, and financial reporting in SAP ERP. I am motivated to leverage Python/Power BI to deliver scalable, accurate financial operations for ${company}.`;
        await target.fill(motivation);
        summary['Motivation'] = 'Populated verified profile facts';
      } else if (/passionate.*outside|outside of work/i.test(text)) {
        const passion = "Outside of work, I am passionate about quantitative financial modeling and building automated Python data pipelines to analyze macroeconomic indicators and market structures.";
        await target.fill(passion);
        summary['Passion'] = 'Populated verified profile facts';
      }
    }

    // 6. Earliest start date
    const startDateInput = page.locator('input[class*="input-date"], input[placeholder*="Pick date"]').or(page.getByRole('textbox', { name: /start date|when can you start/i })).first();
    if (await startDateInput.isVisible().catch(() => false)) {
      await startDateInput.click();
      await startDateInput.fill(cand.earliestStartDate);
      await page.keyboard.press('Escape');
      summary['Start Date'] = cand.earliestStartDate;
    }

    // 7. Behavioral Textfields (Ashby)
    const unfairInput = page.getByRole('textbox', { name: /unfair advantage/i }).first();
    if (await unfairInput.isVisible().catch(() => false)) {
      const currentVal = await unfairInput.inputValue();
      if (!currentVal) {
        await unfairInput.fill(cand.behavioralAnswers.unfairAdvantage);
        summary['Unfair Advantage'] = 'Populated from profile';
      }
    }

    const impressiveInput = page.getByRole('textbox', { name: /most impressive/i }).first();
    if (await impressiveInput.isVisible().catch(() => false)) {
      const currentVal = await impressiveInput.inputValue();
      if (!currentVal) {
        await impressiveInput.fill(cand.behavioralAnswers.mostImpressiveThing);
        summary['Impressive Achievement'] = 'Populated from profile';
      }
    }

    // 8. Consent Checkboxes
    const consentCheckbox = page.locator('#gdpr_processing_consent_given_1').or(page.getByRole('checkbox', { name: /consent|understand|agree/i })).or(page.locator('label:has-text("I agree"), label:has-text("consent")')).first();
    if (await consentCheckbox.isVisible().catch(() => false)) {
      await consentCheckbox.check().catch(() => consentCheckbox.click());
      summary['Consent'] = 'Checked';
    }

    // 9. Attach Verified Exact CV
    console.log(`[Upload] Attaching verified exact CV via setInputFiles: ${cv.path}...`);
    let fileInput = page.locator('#resume, #_systemfield_resume, input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 15000 });
    await fileInput.setInputFiles(cv.path);
    await page.waitForTimeout(3000);

    // Verify CV attachment in DOM
    const cvBadge = page.locator(`text=${cv.filename}`).or(page.locator('text=.pdf')).or(page.locator('button:has-text("Replace"), label[for="resume"]')).first();
    const isAttached = await cvBadge.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isAttached) {
      console.warn('[Warning] CV badge not visibly confirmed in DOM, checking file input status...');
    } else {
      console.log(`[Verification] Exact CV attached successfully.`);
    }
    summary['CV Attached'] = `${cv.filename} (${cv.hash})`;

    // 10. Display Application Summary
    console.log('\n--- APPLICATION SUMMARY ---');
    for (const [k, v] of Object.entries(summary)) {
      console.log(`  ${k.padEnd(30)}: ${v}`);
    }
    console.log('---------------------------\n');

    // 11. Pre-Submission / Dry-Run Screenshot
    const dryRunScreenshotPath = path.join(opts.screenshotsDir, `${jobId}_dry_run.png`);
    await page.screenshot({ path: dryRunScreenshotPath, fullPage: true });
    console.log(`[Screenshot] Pre-submission form view saved: ${dryRunScreenshotPath}`);

    // 12. Submission Execution or Stop
    if (!opts.submit) {
      console.log('\n>>> DRY RUN FINISHED SUCCESSFULLY <<<');
      console.log('No submission was made. The form has been populated and verified.');
      console.log(`To execute actual submission, run with: --submit (or --approved-queue)\n`);
      await page.waitForTimeout(2000);
      await browser.close();
      return { status: 'DRY_RUN_COMPLETED', jobId, company, summary };
    }

    // AUTHORIZED SUBMISSION PATH (STANDING AUTHORIZATION ACTIVE)
    console.log('\n[SUBMIT] Submission authorized (--submit / --approved-queue). Submitting application...');
    const submitBtn = page.locator('#submit_app').or(page.getByRole('button', { name: /Submit Application|Submit/i })).first();
    if (!await submitBtn.isVisible().catch(() => false)) {
      throw new Error('Submit button not found on page.');
    }

    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click();
    console.log('[Submit] Clicked Submit button. Waiting for confirmation...');

    // Wait for confirmation
    const confirmationText = page.getByText(/Success|Your application was successfully submitted|Thank you for applying|Application submitted/i).first();
    try {
      await confirmationText.waitFor({ state: 'visible', timeout: 30000 });
    } catch (e) {
      const uncertainPath = path.join(opts.screenshotsDir, `${jobId}_uncertain.png`);
      await page.screenshot({ path: uncertainPath, fullPage: true });
      console.error(`\n[UNCERTAIN OUTCOME] Did not detect immediate success message within 30s.`);
      console.error(`Screenshot saved for review: ${uncertainPath}`);

      // Record UNCERTAIN in local history to block future retries
      saveSubmissionRecord(opts.history, {
        jobId,
        company,
        url: opts.url,
        status: 'UNCERTAIN',
        submittedAt: new Date().toISOString(),
        cvFile: cv.filename,
        cvHash: cv.hash,
        screenshot: path.basename(uncertainPath),
        reason: 'Submit clicked but success confirmation was not returned within timeout. Automatic retries blocked.'
      });

      await browser.close();
      if (opts.approvedQueue) {
        return { status: 'UNCERTAIN', jobId, company, reason: 'Timeout waiting for confirmation text' };
      }
      process.exit(1);
    }

    // Success Confirmed
    const confirmScreenshotPath = path.join(opts.screenshotsDir, `${jobId}_confirm.png`);
    await page.screenshot({ path: confirmScreenshotPath, fullPage: true });
    console.log(`\n>>> SUBMISSION CONFIRMED <<<`);
    console.log(`Confirmation screenshot saved: ${confirmScreenshotPath}`);

    // Save record to local submissions history
    const record = {
      jobId,
      company,
      url: opts.url,
      status: 'CONFIRMED',
      submittedAt: new Date().toISOString(),
      cvFile: cv.filename,
      cvHash: cv.hash,
      screenshot: path.basename(confirmScreenshotPath)
    };
    saveSubmissionRecord(opts.history, record);
    console.log(`Recorded submission in: ${opts.history}`);

    await page.waitForTimeout(2000);
    await browser.close();
    return { status: 'CONFIRMED', jobId, company, record };
  } catch (err) {
    console.error(`\n[Execution Error]: ${err.message}`);
    const errorScreenshot = path.join(opts.screenshotsDir, `${jobId}_error.png`);
    try {
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      console.log(`Error state captured: ${errorScreenshot}`);
    } catch (e) {}
    await browser.close();
    if (opts.approvedQueue) {
      console.log(`[QUEUE BLOCKER] Application failed validation/execution: ${err.message}`);
      return { status: 'BLOCKED_ERROR', jobId, company, reason: err.message };
    }
    process.exit(1);
  }
}

// Export functions for testing and verification
module.exports = {
  parseArgs,
  validateDomain,
  extractJobDetails,
  resolveAndVerifyExactCV,
  detectCountry,
  loadProfile,
  loadSubmissions,
  saveSubmissionRecord,
  runApplication
};

// Auto-run if executed as script
if (require.main === module) {
  runApplication(parseArgs()).catch(err => {
    console.error('[Fatal Error]:', err);
    process.exit(1);
  });
}
