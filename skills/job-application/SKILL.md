---
name: job-application
description: Autonomous local browser automation skill using Playwright for job discovery and applications. Features deterministic local discovery on jobs.ch, persistent browser profiles, exact Job ID CV matching, country-aware statutory question mapping, duplicate/uncertain submission blocking, standing authorization for approved queues, safe dry-run defaults, and visual audit evidence with zero AI model calls for repeated browser steps.
---

# Job Application Skill (Local Playwright Discovery & Runner)

A dedicated, security-hardened local browser automation skill for job discovery and applications across Swiss and European job portals and Applicant Tracking Systems (ATS). Designed for running standalone browser workflows on the candidate's machine with standing authorization for approved queues, explicit authorization switches, visual audit evidence, deterministic local execution (zero AI model calls), and strict zero-guesswork compliance.

---

## 1. When to Use (Trigger Examples)

Use this skill when you need to:
- **Discover jobs locally**: Search jobs.ch or local portals with role, region/country, and result limit without AI model calls (`node skills/job-application/scripts/discover.js --role="Data Analyst" --country="Switzerland" --limit=10`).
- **End-to-End Local Workflow**: Handle requests like *"Find 10 Swiss Data Analyst roles locally, screen them, and prepare eligible applications"*.
- **Dry-run a job application**: Inspect and fill an application form, attach the verified tailored CV, and capture full-page evidence without submitting (`node skills/job-application/scripts/apply.js --url=<url>`).
- **Execute Standing Authorization on Approved Queues**: Automatically submit applications across an approved, screened job queue using verified role-matched CVs and candidate facts without repetitive permission prompts (`node skills/job-application/scripts/apply.js --url=<url> --approved-queue`).
- **Submit an individual application with explicit authorization**: Execute a live application submission after reviewing the dry run, requiring the explicit `--submit` switch (`node skills/job-application/scripts/apply.js --url=<url> --submit`).
- **Verify form fields & CV attachment**: Check required candidate fields, verify exact Job ID matching, and confirm DOM attachment before submission.
- **Enforce statutory truth**: Accurately answer separate questions for work authorization vs. visa sponsorship based on verified candidate profile.
- **Block duplicate or uncertain submissions**: Prevent double-applying to confirmed positions, and halt automated retries on jobs with unconfirmed/uncertain outcomes until reconciled.

---

## 2. Core Safety & Compliance Model

The skill enforces eleven non-negotiable safety guardrails:

1. **Deterministic Local Discovery (Zero Model Calls)**:
   - Uses `scripts/discover.js` to search local portals (starting with jobs.ch) directly via Playwright.
   - Captures title, employer, location, workload, contract type, source URL, and listing ID.
   - Deduplicates strictly by listing ID or canonical URL.
   - Reports how many listings matched and surfaces any shortfall rather than padding the result set with unrelated jobs.
   - Discovery alone never authorizes an application; results feed into JAS screening.
2. **Standing Authorization for Approved Job Queue**:
   - When invoked with `--approved-queue`, the runner automatically authorizes submission (`submit = true`) for ready, validated applications without prompting "Would you like to proceed?".
   - Automatically skips blockers: duplicate `CONFIRMED` jobs, unresolved `UNCERTAIN` submissions, inactive/closed postings (404), interactive CAPTCHAs, missing tailored CVs, or unmapped screening questions.
   - Continues queue processing across remaining jobs while cleanly logging blocker reasons.
3. **Dedicated Persistent Browser Context**:
   - Uses `chromium.launchPersistentContext(profileDir)` to preserve logins, session tokens, and CAPTCHA states.
   - Candidate handles logins or CAPTCHAs interactively; automation does not bypass bot protections.
4. **Strict Domain & Path Whitelisting**:
   - Navigates exclusively to domains listed in `profile.security.allowedDomains`.
   - Rejects unlisted domains, arbitrary URLs, or malicious redirects with a security exception.
   - Uploads exclusively from `profile.security.approvedCvDirectory`.
5. **Exact CV-to-Job-ID Matching (Zero Fuzzy Matching)**:
   - Target Job ID is parsed directly from the application URL.
   - Candidate CV filename must contain the exact Job ID (e.g., `Company_Role_<Job_ID>_FlowCV_2026-11-15.pdf`).
   - Fuzzy search, substring company matching, or cross-role CV reuse is strictly rejected with exit code 1.
6. **Verified Statutory Question Mapping**:
   - Treats **work authorization** and **visa sponsorship** as separate, distinct questions.
   - Maps answers strictly by country context (Switzerland, Germany EU Blue Card, Netherlands Kennismigrant, Slovak Act 5/2004 Coll.).
   - Halts immediately on unmapped or unknown Yes/No questions (`[AUDIT HALT - UNKNOWN QUESTION]`) to prevent guessing.
7. **Safe Dry-Run Default**:
   - By default, the script fills fields, attaches the CV, verifies DOM rendering, outputs a complete application summary, captures a full-page dry-run screenshot, and cleanly exits without submitting.
   - Submission requires the explicit `--submit` or `--approved-queue` flag.
8. **Required Fields & Attachment Validation**:
   - Validates that Name, Email, Phone, and CV inputs are attached and non-empty.
   - Confirms the CV in the DOM (detecting the badge or active "Replace" button) before permitting submission.
9. **Duplicate & Uncertain Submission Blocker**:
   - Checks `data/submissions_history.json` before navigating.
   - If a job is already `CONFIRMED`: halts immediately (`[DUPLICATE BLOCKED]`) or skips in queue mode.
   - If a job outcome is `UNCERTAIN`: halts immediately (`[RETRY BLOCKED - UNCERTAIN STATUS]`). Automatic retries are blocked until manual receipt reconciliation.
10. **Evidence-Backed Confirmation Receipts**:
    - Marks status `CONFIRMED` only when genuine confirmation text (`Success`, `Your application was successfully submitted`, `Thank you for applying`) is visibly confirmed in the DOM.
    - Saves timestamped full-page screenshots for every outcome (`_dry_run.png`, `_confirm.png`, `_uncertain.png`, `_error.png`).
11. **Private Operational Learning**:
    - Reuses `skills/manage-job-applications/references/learning.md` to consult verified portal steps, export settings, error states, and recovery procedures before execution.
    - Saves demonstrated operational improvements, measured timings, and operation counts in the private workflow workspace.
    - Never commits candidate credentials, personal profiles, CVs, or logs to the repository.

---

## 3. Tested ATS Platforms vs. Whitelisted Domains

| ATS Platform | Domain | Support Level | Notes |
| :--- | :--- | :--- | :--- |
| **Ashby ATS** | `jobs.ashbyhq.com` | **Tested & Fully Verified** | End-to-end verified on live postings: name, email, phone, LinkedIn, city auto-complete, Yes/No option buttons, date pickers, numeric/text salary inputs, consent checkboxes, resume file upload, and green confirmation receipt detection. |
| **Greenhouse** | `boards.greenhouse.io`<br>`job-boards.greenhouse.io` | **Tested & Fully Verified** | Verified across modern Greenhouse boards: split first/last name, email, phone, candidate location, React-select statutory dropdowns (Authorization/Sponsorship), motivation & passion fields, GDPR checkboxes, submit button, and confirmation page verification. |
| **jobs.ch** | `www.jobs.ch` | **Discovery Verified** | Verified for deterministic local job discovery with listing ID extraction, workload, employer, and multi-term query expansion. |
| **SmartRecruiters** | `jobs.smartrecruiters.com` | Whitelisted | Whitelisted in security policy. Headless triggers bot checks; requires interactive profile session. |
| **Workable** | `apply.workable.com` | Whitelisted | Whitelisted in security policy. Form structure requires validation before authorized submission. |

---

## 4. Setup & Configuration

### Directory Layout

```
skills/job-application/
├── SKILL.md                                 # Skill documentation and runbook
├── .gitignore                               # Ignores private profiles, histories, screenshots, CVs
├── config/
│   ├── profile.example.json                 # Sanitized configuration template (committed)
│   └── profile.json                         # Private candidate configuration (ignored)
├── data/
│   ├── submissions_history.example.json     # Sanitized outcome schema (committed)
│   └── submissions_history.json             # Live submissions history (ignored)
└── scripts/
    ├── discover.js                          # Standalone local Playwright discovery runner
    ├── apply.js                             # Standalone local Playwright application runner
    └── verify_runner.js                     # Offline unit and safety verification suite
```

### Initial Setup Steps

1. **Install Prerequisites**:
   Ensure Node.js (>= 20.0.0) is installed. The runner resolves `playwright-core` automatically from existing project dependencies or globally installed `@playwright/cli`.

2. **Create Private Profile**:
   Copy `config/profile.example.json` to `config/profile.json` and populate with verified candidate facts.

3. **Configure Approved CV Directory**:
   In `config/profile.json`, set `security.approvedCvDirectory` to your local or synced folder containing tailored CV PDFs.

4. **Initialize Submissions History**:
   Copy `data/submissions_history.example.json` to `data/submissions_history.json` to start tracking applications.

---

## 5. Usage & Execution Commands (Windows PowerShell)

All commands are executed from the repository root in Windows PowerShell.

### A. Run Offline Safety & Integrity Checks
Run the offline verification suite to validate exact CV matching, domain whitelist enforcement, statutory mappings, duplicate protection, standing authorization, and discovery parsing:
```powershell
node skills/job-application/scripts/verify_runner.js
```

### B. Discover Jobs Locally (jobs.ch — Zero AI Model Calls)
Discover matching vacancies locally, deduplicating by listing ID and exporting structured metadata:
```powershell
node skills/job-application/scripts/discover.js `
  --role="Data Analyst" `
  --country="Switzerland" `
  --limit=10 `
  --output="skills/job-application/data/discovered_jobs.json"
```

### C. Execute a Safe Dry-Run (Default Mode)
Fills all detected form fields, attaches the exact tailored CV matching the target Job ID, displays an application summary, captures a full-page pre-submission screenshot, and exits without submitting:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/lyceum/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json"
```

### D. Standing Authorization Submission for Approved Queue
Automatically submits ready and verified applications in the approved queue without prompting:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://boards.greenhouse.io/nlighten/jobs/5006712101" `
  --config="skills/job-application/config/profile.json" `
  --approved-queue
```

### E. Explicitly Authorized Single Submission
Submits the application after user review, waits for the confirmation page, and records `CONFIRMED` in the history log:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json" `
  --submit
```

### F. Specify an Explicit Tailored CV
When an explicit CV path is passed, the runner strictly validates that the filename contains the target Job ID:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --cv="ExampleCorp_Finance_Role_306c384f-4131-4d5f-9f6d-696645ef3061_FlowCV_2026-11-15.pdf" `
  --config="skills/job-application/config/profile.json"
```

### G. Run in Headless Mode
For automated dry-run testing where browser visual display is not required:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json" `
  --headless
```

---

## 6. Reconciling Uncertain Submissions & Confirmed Records

### Reconciling UNCERTAIN Statuses
When a submission encounters an unconfirmed network timeout or unverified receipt:
1. Captures a full-page `_uncertain.png` screenshot.
2. Records status `UNCERTAIN` in `submissions_history.json`.
3. **Blocks any future automatic retries** for that Job ID.

To reconcile an uncertain record:
- Inspect the captured screenshot (`screenshots/<jobId>_uncertain.png`) or employer portal.
- Check candidate email for an official application confirmation receipt.
- If confirmed: update `status` to `CONFIRMED` in `submissions_history.json` and link the confirmation receipt.
- If unsubmitted: manually address the blocker (e.g., solve CAPTCHA in headed mode or correct invalid input), then run with `--force` if authorized.

### Preserving Confirmed Records
Jobs with verified success receipts have their confirmation receipts verified locally. The runner refuses duplicate runs on these records unless overridden with `--force`.

---

## 7. Known Limitations & Edge Cases

1. **Anti-Bot & CAPTCHA Challenges**:
   - Cloudflare Turnstile or reCAPTCHA Enterprise requires interactive candidate solving. Run in headed mode (the default) so the user can complete the challenge.
2. **Unmapped Form Questions**:
   - If an employer adds custom screening questions not defined in `profile.json`, execution pauses immediately (`[AUDIT HALT - UNKNOWN QUESTION]`) to prevent incorrect answers. Add the verified answer to `profile.json` before resuming.
3. **Numeric vs. Text Salary Inputs**:
   - The runner detects `input[type="number"]` and converts formatted salary bands into valid raw integers (e.g., `110000`, `60000`, or `48000`) to avoid HTML5 form validation rejections.
4. **Portal Differences**:
   - Ashby ATS and Greenhouse ATS are certified for end-to-end automated submission. Other ATS engines require verified DOM selector adapters.
