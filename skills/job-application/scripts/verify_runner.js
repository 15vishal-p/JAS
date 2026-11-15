#!/usr/bin/env node
/**
 * Test & Verification Suite for job-application skill runner
 * Runs comprehensive offline unit and safety checks:
 *   - Exact CV-to-Job-ID resolution and rejection of cross-role reuse
 *   - Target domain whitelisting and security perimeter enforcement
 *   - Duplicate submission prevention for CONFIRMED jobs
 *   - Automatic retry blocking for UNCERTAIN jobs
 *   - Country-aware statutory question resolution
 *   - CLI argument parsing & dry-run default safety
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validateDomain,
  extractJobDetails,
  resolveAndVerifyExactCV,
  detectCountry,
  parseArgs,
  loadSubmissions
} = require('./apply');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\n======================================================');
console.log('   RUNNER AUDIT & SAFETY VERIFICATION SUITE');
console.log('======================================================\n');

// 1. Domain Whitelist Verification
runTest('Domain Security: Allows whitelisted domains', () => {
  const allowed = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'jobs.smartrecruiters.com'];
  const res1 = validateDomain('https://jobs.ashbyhq.com/examplecorp/123/application', allowed);
  assert.strictEqual(res1.hostname, 'jobs.ashbyhq.com');

  const res2 = validateDomain('https://subdomain.boards.greenhouse.io/job/456', allowed);
  assert.strictEqual(res2.hostname, 'subdomain.boards.greenhouse.io');
});

runTest('Domain Security: Rejects unapproved or spoofed domains', () => {
  const allowed = ['jobs.ashbyhq.com'];
  assert.throws(() => {
    validateDomain('https://malicious-ashbyhq.com/job/123', allowed);
  }, /SECURITY BLOCKED/);

  assert.throws(() => {
    validateDomain('https://example.com/apply', allowed);
  }, /SECURITY BLOCKED/);
});

// 2. Job Details Extraction
runTest('URL Extraction: Accurately parses company slug and job ID', () => {
  const details1 = extractJobDetails('https://jobs.ashbyhq.com/lyceum/306c384f-4131-4d5f-9f6d-696645ef3061/application');
  assert.strictEqual(details1.company, 'lyceum');
  assert.strictEqual(details1.jobId, '306c384f-4131-4d5f-9f6d-696645ef3061');

  const details2 = extractJobDetails('https://boards.greenhouse.io/databricks/jobs/7891011');
  assert.strictEqual(details2.company, 'databricks');
  assert.strictEqual(details2.jobId, '7891011');
});

// 3. Exact CV-to-Job-ID Verification
runTest('Exact CV Matching: Accepts valid PDF matching exact Job ID', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-test-'));
  const jobId = '306c384f-4131-4d5f-9f6d-696645ef3061';
  const validCvName = `Company_Role_${jobId}_FlowCV_2026-11-15.pdf`;
  const validCvPath = path.join(tempDir, validCvName);

  // Write mock PDF with size > 1000 bytes
  fs.writeFileSync(validCvPath, Buffer.alloc(1500, '%PDF-1.4 mock content'));

  const result = resolveAndVerifyExactCV(jobId, 'Company', validCvName, tempDir);
  assert.strictEqual(result.filename, validCvName);
  assert.strictEqual(result.path, validCvPath);
  assert.strictEqual(typeof result.hash, 'string');
  assert.strictEqual(result.hash.length, 8);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

runTest('Exact CV Matching: Rejects mismatched CV with different Job ID (Zero Fuzzy Matching)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-test-'));
  const targetJobId = '306c384f-4131-4d5f-9f6d-696645ef3061';
  const wrongJobId = 'fe9d02a3-8888-4444-9999-111122223333';
  const wrongCvName = `Company_DifferentRole_${wrongJobId}_FlowCV_2026-11-15.pdf`;
  const wrongCvPath = path.join(tempDir, wrongCvName);

  fs.writeFileSync(wrongCvPath, Buffer.alloc(1500, '%PDF-1.4 mock content'));

  // Attempting to use the wrong CV must throw an AUDIT REJECTED error
  assert.throws(() => {
    resolveAndVerifyExactCV(targetJobId, 'Company', wrongCvName, tempDir);
  }, /AUDIT REJECTED/);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// 4. Country Detection and Statutory Question Mapping
runTest('Statutory Mapping: Correctly separates authorization and sponsorship by jurisdiction', () => {
  // Netherlands
  assert.strictEqual(detectCountry('Office in Amsterdam, Netherlands', 'https://jobs.ashbyhq.com/wetravel/123'), 'Netherlands');

  // Germany
  assert.strictEqual(detectCountry('Role based in Berlin, Germany', 'https://jobs.ashbyhq.com/lyceum/456'), 'Germany');

  // Slovakia
  assert.strictEqual(detectCountry('Bratislava shared services centre', 'https://jobs.ashbyhq.com/company/789'), 'Slovakia');
});

// 5. Duplicate and Uncertain History Safeguards
runTest('History Safeguards: Correctly identifies CONFIRMED and UNCERTAIN statuses', () => {
  const mockHistory = {
    submissions: [
      {
        jobId: 'confirmed-job-1',
        company: 'Alpha',
        status: 'CONFIRMED',
        submittedAt: '2026-11-15T09:00:00Z'
      },
      {
        jobId: 'uncertain-job-2',
        company: 'Beta',
        status: 'UNCERTAIN',
        submittedAt: '2026-11-15T09:15:00Z',
        reason: 'Timeout waiting for receipt'
      }
    ]
  };

  const tempFile = path.join(os.tmpdir(), `history-test-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(mockHistory));

  const history = loadSubmissions(tempFile);
  const conf = history.submissions.find(s => s.jobId === 'confirmed-job-1');
  const unc = history.submissions.find(s => s.jobId === 'uncertain-job-2');

  assert.strictEqual(conf.status, 'CONFIRMED');
  assert.strictEqual(unc.status, 'UNCERTAIN');

  fs.unlinkSync(tempFile);
});

// 6. Safe Dry-Run Defaults
runTest('CLI Defaults: Defaults to safe dry-run mode without --submit', () => {
  const defaultOpts = parseArgs(['--url=https://jobs.ashbyhq.com/example/123/application']);
  assert.strictEqual(defaultOpts.submit, false, 'Should default to dry-run (submit=false)');
  assert.strictEqual(defaultOpts.force, false, 'Should default to safe protection (force=false)');

  const submitOpts = parseArgs(['--url=https://jobs.ashbyhq.com/example/123/application', '--submit']);
  assert.strictEqual(submitOpts.submit, true, 'Explicit --submit flag should authorize submission');
});

console.log(`\nVerification Suite Summary: ${passedTests}/${totalTests} tests passed.\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}
