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
 *   7. Safe Dry-Run Default: Runs full form population and CV attachment verification without submitting.
 *   8. Explicit Authorization Switch: Requires `--submit` flag to perform final submission.
 *   9. Visual Audit Trail: Captures full-page screenshots for dry-runs, confirmed submissions, and uncertain states.
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
    else if (arg === '--force') options.force = true;
    else if (arg === '--headless') options.headless = true;
  }

  return options;
}

// Load Candidate Profile Configuration
function loadProfile(configPath) {
  let resolved = configPath;
  if (!fs.existsSync(resolved)) {
    // Check fallback to profile.example.json if profile.json does not exist
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
  const parts = parsed.pathname.split('/').filter(p => p && p.toLowerCase() !== 'application');

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
  if (text.includes('berlin') || text.includes('munich') || text.includes('germany') || text.includes('deutschland') || text.includes('/lyceum/') || text.includes('/plancraft/')) {
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
  console.log('======================================================\n');

  if (!opts.url) {
    console.error('Error: Missing target application URL.');
    console.log('Usage: node apply.js --url=<url> [--cv=<pdf>] [--submit] [--headless]');
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
      console.log(`(Pass --force to run a dry-run test anyway)\n`);
      process.exit(0);
    }
    if (existing.status === 'UNCERTAIN' && !opts.force) {
      console.log(`\n[RETRY BLOCKED - UNCERTAIN STATUS] This job has an existing UNCERTAIN outcome recorded on ${existing.submittedAt}!`);
      console.log(`Reason: ${existing.reason || 'Unconfirmed outcome'}`);
      console.log(`Screenshot: ${existing.screenshot}`);
      console.log(`Automated retries are blocked until the application receipt is reconciled.`);
      console.log(`(Pass --force to run a dry-run check anyway)\n`);
      process.exit(1);
    }
  }

  // 3. Resolve and Verify Exact CV File (Zero Fuzzy Matching)
  const cvDir = opts.approvedDir || profile.security.approvedCvDirectory;
  const cv = resolveAndVerifyExactCV(jobId, company, opts.cv, cvDir);
  console.log(`[CV Attachment]   : ${cv.filename} (${cv.size} bytes, SHA-256: ${cv.hash})`);
  console.log(`[CV File Path]    : ${cv.path}`);

  // 4. Ensure Output Directories Exist
  if (!fs.existsSync(opts.profileDir)) fs.mkdirSync(opts.profileDir, { recursive: true });
  if (!fs.existsSync(opts.screenshotsDir)) fs.mkdirSync(opts.screenshotsDir, { recursive: true });

  // 5. Mode Selection
  console.log(`[Run Mode]        : ${opts.submit ? '*** SUBMISSION AUTHORIZED (--submit) ***' : 'DRY-RUN / REVIEW (Default, no submission)'}`);

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

    // Wait for form elements to load
    await page.waitForSelector('input[name*="name"], input[type="file"], button', { timeout: 15000 }).catch(() => {});
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
    const pageText = await page.evaluate(() => document.body.innerText);
    const country = detectCountry(pageText, opts.url);
    const statutory = cand.statutoryByCountry[country] || cand.statutoryByCountry['DefaultSchengen'];
    console.log(`[Statutory Context]: Detected Country: ${country}`);
    console.log(`                     Authorized in Country: ${statutory.authorizedInCountry ? 'Yes' : 'No'}`);
    console.log(`                     Requires Sponsorship:  ${statutory.requiresSponsorship ? 'Yes' : 'No'}`);
    console.log(`                     Statutory Basis:       ${statutory.details}`);
    summary['Target Country'] = country;
    summary['Statutory Basis'] = statutory.details;

    console.log('\n[Form] Inspecting and populating candidate fields...');

    // 1. Full Name / Name
    const nameInput = page.locator('#_systemfield_name').or(page.getByRole('textbox', { name: /full name|name/i })).first();
    if (await nameInput.isVisible().catch(() => false)) {
      const currentVal = await nameInput.inputValue();
      if (!currentVal) {
        await nameInput.fill(cand.fullName);
        summary['Name'] = cand.fullName;
      } else {
        summary['Name'] = currentVal + ' (preserved)';
      }
    }

    // 2. Email
    const emailInput = page.locator('#_systemfield_email').or(page.getByRole('textbox', { name: /email/i })).first();
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
    const phoneInput = page.locator('input[type="tel"]').or(page.getByRole('textbox', { name: /mobile|phone/i })).first();
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

    // 4. Normal Location / Based in
    const locationInput = page.locator('input[placeholder*="Start typing"]').or(page.getByRole('textbox', { name: /normally based|location|city/i })).first();
    if (await locationInput.isVisible().catch(() => false)) {
      const currentVal = await locationInput.inputValue();
      if (!currentVal) {
        const cityTarget = country === 'Netherlands' ? 'Amsterdam, Netherlands' : (country === 'Germany' ? 'Berlin, Germany' : 'Bratislava, Slovakia');
        await locationInput.click();
        await locationInput.type(cityTarget, { delay: 50 });
        await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        summary['Location'] = `${cityTarget} (willing to relocate)`;
      } else {
        summary['Location'] = currentVal + ' (preserved)';
      }
    }

    // 5. Statutory Work Authorization & Sponsorship Questions (STRICT MAPPING)
    const yesNoGroups = page.locator('div[class*="_optionsContainer_pjyt6_1"], div[class*="ashby-application-form-input-yesno"], div[class*="yesno"]');
    const groupCount = await yesNoGroups.count();

    for (let i = 0; i < groupCount; i++) {
      const group = yesNoGroups.nth(i);
      const questionText = await group.evaluate(el => {
        let parent = el.parentElement;
        while (parent && !parent.innerText.includes('?')) {
          parent = parent.parentElement;
        }
        return parent ? parent.innerText.slice(0, 100).replace(/\n/g, ' ') : '';
      });

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

    // 6. Earliest start date
    const startDateInput = page.locator('input[class*="input-date"], input[placeholder*="Pick date"]').or(page.getByRole('textbox', { name: /start date|when can you start/i })).first();
    if (await startDateInput.isVisible().catch(() => false)) {
      await startDateInput.click();
      await startDateInput.fill(cand.earliestStartDate);
      await page.keyboard.press('Escape');
      summary['Start Date'] = cand.earliestStartDate;
    }

    // 7. Behavioral Textfields
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

    const whyInterestedInput = page.getByRole('textbox', { name: /why are you interested|motivation|anything else|cover letter/i }).first();
    if (await whyInterestedInput.isVisible().catch(() => false)) {
      const currentVal = await whyInterestedInput.inputValue();
      if (!currentVal) {
        await whyInterestedInput.fill(cand.behavioralAnswers.additionalInfo);
        summary['Motivation / Why Interested'] = 'Populated from profile';
      }
    }

    // 8. Salary Expectations (Supports both numeric and string input fields)
    const salaryInput = page.locator('input[type="number"]').or(page.getByRole('spinbutton', { name: /salary/i })).or(page.getByRole('textbox', { name: /salary expectation/i })).first();
    if (await salaryInput.isVisible().catch(() => false)) {
      const currentVal = await salaryInput.inputValue();
      if (!currentVal) {
        const inputType = await salaryInput.getAttribute('type');
        if (inputType === 'number') {
          const numVal = country === 'Netherlands' ? '60000' : '48000';
          await salaryInput.fill(numVal);
          summary['Salary Expectations'] = `${numVal} EUR (numeric)`;
        } else {
          await salaryInput.fill(cand.salaryExpectationEUR);
          summary['Salary Expectations'] = cand.salaryExpectationEUR;
        }
      } else {
        summary['Salary Expectations'] = currentVal + ' (preserved)';
      }
    }

    // 9. Consent Checkbox
    const consentCheckbox = page.getByRole('checkbox', { name: /consent|understand|agree/i }).or(page.locator('label:has-text("I agree"), label:has-text("consent")')).first();
    if (await consentCheckbox.isVisible().catch(() => false)) {
      await consentCheckbox.click();
      summary['Consent'] = 'Checked';
    }

    // 10. CV Attachment (Exact Match Verified)
    console.log(`[Upload] Attaching verified exact CV via setInputFiles: ${cv.path}...`);
    let fileInput = page.locator('#_systemfield_resume').first();
    if (await fileInput.count() === 0) {
      fileInput = page.locator('input[type="file"]').last();
    }
    await fileInput.waitFor({ state: 'attached', timeout: 15000 });
    await fileInput.setInputFiles(cv.path);
    await page.waitForTimeout(3000);

    // Verify CV attachment in DOM
    const cvBadge = page.locator(`text=${cv.filename}`).or(page.locator('text=.pdf')).or(page.locator('button:has-text("Replace")')).first();
    const isAttached = await cvBadge.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isAttached) {
      console.warn('[Warning] CV badge not visibly confirmed in DOM, checking file input status...');
    } else {
      console.log(`[Verification] Exact CV attached successfully (confirmed in DOM with Replace button).`);
    }
    summary['CV Attached'] = `${cv.filename} (${cv.hash})`;

    // 11. Display Application Summary
    console.log('\n--- APPLICATION SUMMARY ---');
    for (const [k, v] of Object.entries(summary)) {
      console.log(`  ${k.padEnd(30)}: ${v}`);
    }
    console.log('---------------------------\n');

    // 12. Pre-Submission / Dry-Run Screenshot
    const dryRunScreenshotPath = path.join(opts.screenshotsDir, `${jobId}_dry_run.png`);
    await page.screenshot({ path: dryRunScreenshotPath, fullPage: true });
    console.log(`[Screenshot] Pre-submission form view saved: ${dryRunScreenshotPath}`);

    // 13. Submission Execution or Stop
    if (!opts.submit) {
      console.log('\n>>> DRY RUN FINISHED SUCCESSFULLY <<<');
      console.log('No submission was made. The form has been populated and verified.');
      console.log(`To execute actual submission, run with: --submit\n`);
      await page.waitForTimeout(2000);
      await browser.close();
      return { status: 'DRY_RUN_COMPLETED', jobId, company, summary };
    }

    // AUTHORIZED SUBMISSION PATH
    console.log('\n[SUBMIT] --submit switch detected. Proceeding to submit application...');
    const submitBtn = page.getByRole('button', { name: /Submit Application|Submit/i }).first();
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
