---
name: job-application
description: Autonomous local browser automation skill using Playwright for job applications. Features persistent browser profiles, exact Job ID CV matching, country-aware statutory question mapping, duplicate/uncertain submission blocking, standing authorization for approved queues, safe dry-run defaults, and visual audit evidence.
---

# Job Application Skill (Local Playwright Runner)

A dedicated, security-hardened local browser automation skill for job applications across modern Applicant Tracking Systems (ATS). Designed for running standalone browser workflows on the candidate's machine with standing authorization for approved queues, explicit authorization switches, visual audit evidence, and strict zero-guesswork compliance.

---

## 1. When to Use (Trigger Examples)

Use this skill when you need to:
- **Execute Standing Authorization on Approved Queues**: Automatically submit applications across the approved job queue using verified role-matched CVs and candidate facts without repetitive permission prompts (`node apply.js --url=<url> --approved-queue`).
- **Dry-run a job application**: Inspect and fill an application form, attach the verified tailored CV, and capture full-page evidence without submitting (`node apply.js --url=<url>`).
- **Submit an individual application with explicit authorization**: Execute a live application submission after reviewing the dry run, requiring the explicit `--submit` switch (`node apply.js --url=<url> --submit`).
- **Verify form fields & CV attachment**: Check required candidate fields, verify exact Job ID matching, and confirm DOM attachment before submission.
- **Enforce statutory truth**: Accurately answer separate questions for work authorization vs. visa sponsorship based on verified candidate profile.
- **Block duplicate or uncertain submissions**: Prevent double-applying to confirmed positions, and halt automated retries on jobs with unconfirmed/uncertain outcomes until reconciled.

---

## 2. Core Safety & Compliance Model

The skill enforces ten non-negotiable safety guardrails:

1. **Standing Authorization for Approved Job Queue**:
   - When invoked with `--approved-queue`, the runner automatically authorizes submission (`submit = true`) for ready, validated applications without prompting "Would you like to proceed?".
   - Automatically skips blockers: duplicate `CONFIRMED` jobs, unresolved `UNCERTAIN` submissions, inactive/closed postings (404), interactive CAPTCHAs, missing tailored CVs, or unmapped screening questions.
   - Continues queue processing across remaining jobs while cleanly logging blocker reasons.
2. **Dedicated Persistent Browser Context**:
   - Uses `chromium.launchPersistentContext(profileDir)` to preserve logins, session tokens, and CAPTCHA states.
   - Candidate handles logins or CAPTCHAs interactively; automation does not bypass bot protections.
3. **Strict Domain & Path Whitelisting**:
   - Navigates exclusively to domains listed in `profile.security.allowedDomains`.
   - Rejects unlisted domains, arbitrary URLs, or malicious redirects with a security exception.
   - Uploads exclusively from `profile.security.approvedCvDirectory`.
4. **Exact CV-to-Job-ID Matching (Zero Fuzzy Matching)**:
   - Target Job ID is parsed directly from the application URL.
   - Candidate CV filename must contain the exact Job ID (e.g., `Company_Role_<Job_ID>_FlowCV_2026-11-15.pdf`).
   - Fuzzy search, substring company matching, or cross-role CV reuse is strictly rejected with exit code 1.
5. **Verified Statutory Question Mapping**:
   - Treats **work authorization** and **visa sponsorship** as separate, distinct questions.
   - Maps answers strictly by country context (e.g., Germany EU Blue Card, Netherlands Kennismigrant, Slovak Act 5/2004 Coll.).
   - Halts immediately on unmapped or unknown Yes/No questions (`[AUDIT HALT - UNKNOWN QUESTION]`) to prevent guessing.
6. **Safe Dry-Run Default**:
   - By default, the script fills fields, attaches the CV, verifies DOM rendering, outputs a complete application summary, captures a full-page dry-run screenshot, and cleanly exits without submitting.
   - Live submission requires the explicit `--submit` flag or `--approved-queue` standing authorization.
7. **Required Fields & Attachment Validation**:
   - Validates that Name, Email, Phone, and CV inputs are attached and non-empty.
   - Confirms the CV in the DOM (detecting the badge or active "Replace" button) before permitting submission.
8. **Duplicate & Uncertain Submission Blocker**:
   - Checks `data/submissions_history.json` before navigating.
   - If a job is already `CONFIRMED`: halts immediately (`[DUPLICATE BLOCKED]`) or skips in queue mode.
   - If a job outcome is `UNCERTAIN`: halts immediately (`[RETRY BLOCKED - UNCERTAIN STATUS]`). Automatic retries are blocked until manual receipt reconciliation.
9. **Evidence-Backed Confirmation Receipts**:
   - Marks status `CONFIRMED` only when genuine confirmation text (`Success`, `Your application was successfully submitted`, `Thank you for applying`) is visibly confirmed in the DOM.
   - Saves timestamped full-page screenshots for every outcome (`_dry_run.png`, `_confirm.png`, `_uncertain.png`).
10. **Standalone Local Execution**:
   - Runs purely as a local Node.js script. Does not modify or bypass Antigravity's host approval system.

---

## 3. Tested ATS Platforms vs. Whitelisted Domains

| ATS Platform | Domain | Support Level | Notes |
| :--- | :--- | :--- | :--- |
| **Ashby ATS** | `jobs.ashbyhq.com` | **Tested & Fully Verified** | End-to-end verified on live postings: name, email, phone, LinkedIn, city auto-complete, Yes/No option buttons, date pickers, numeric/text salary inputs, consent checkboxes, resume file upload, and green confirmation receipt detection. |
| **Greenhouse ATS** | `boards.greenhouse.io`<br>`job-boards.greenhouse.io` | **Tested & Fully Verified** | Split first/last names, candidate location, `#resume` direct file attachment, React-select statutory dropdowns (Authorization/Sponsorship), motivation & passion fields, GDPR checkboxes, submit button, and confirmation page verification. |
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
    ├── apply.js                             # Standalone local Playwright runner
    └── verify_runner.js                     # Offline unit and safety verification suite
```

### Initial Setup Steps

1. **Install Prerequisites**:
   Ensure Node.js (>= 20.0.0) is installed. The runner resolves `playwright-core` automatically from existing project dependencies or globally installed `@playwright/cli`.
   ```powershell
   # If playwright-core is not already installed:
   npm install playwright-core
   ```

2. **Create Private Profile**:
   Copy `config/profile.example.json` to `config/profile.json` and populate with verified candidate facts:
   ```powershell
   Copy-Item skills/job-application/config/profile.example.json skills/job-application/config/profile.json
   ```

3. **Configure Approved CV Directory**:
   In `config/profile.json`, set `security.approvedCvDirectory` to your local or synced folder containing tailored CV PDFs.

4. **Initialize Submissions History**:
   Copy `data/submissions_history.example.json` to `data/submissions_history.json` to start tracking applications:
   ```powershell
   Copy-Item skills/job-application/data/submissions_history.example.json skills/job-application/data/submissions_history.json
   ```

---

## 5. Usage & Execution Commands (Windows PowerShell)

All commands are executed from the repository root in Windows PowerShell.

### A. Run Offline Safety & Integrity Checks
Run the offline verification suite to validate exact CV matching, domain whitelist enforcement, statutory mappings, duplicate protection, and standing authorization:
```powershell
node skills/job-application/scripts/verify_runner.js
```

### B. Standing Authorization Submission for Approved Queue
Automatically submits ready and verified applications in the approved queue without prompting:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://boards.greenhouse.io/nlighten/jobs/5006712101" `
  --config="skills/job-application/config/profile.json" `
  --approved-queue
```

### C. Execute a Safe Dry-Run (Default Mode)
Fills all detected form fields, attaches the exact tailored CV matching the target Job ID, displays an application summary, captures a full-page pre-submission screenshot, and exits without submitting:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json"
```

### D. Explicitly Authorized Single Submission
Submits the application after user review, waits for the confirmation page, and records `CONFIRMED` in the history log:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json" `
  --submit
```

### E. Specify an Explicit Tailored CV
When an explicit CV path is passed, the runner strictly validates that the filename contains the target Job ID:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --cv="ExampleCorp_Finance_Role_306c384f-4131-4d5f-9f6d-696645ef3061_FlowCV_2026-11-15.pdf" `
  --config="skills/job-application/config/profile.json"
```

### F. Run in Headless Mode
For automated dry-run testing where browser visual display is not required:
```powershell
node skills/job-application/scripts/apply.js `
  --url="https://jobs.ashbyhq.com/examplecorp/306c384f-4131-4d5f-9f6d-696645ef3061/application" `
  --config="skills/job-application/config/profile.json" `
  --headless
```

---

## 6. Reconciling Uncertain Submissions & Confirmed Records

### Reconciling UNCERTAIN Statuses (e.g., WeTravel Case)
When a submission encounters an unconfirmed network timeout, the runner:
1. Captures a full-page `_uncertain.png` screenshot.
2. Records status `UNCERTAIN` in `submissions_history.json`.
3. **Blocks any future automatic retries** for that Job ID.

To reconcile an uncertain record:
- Inspect the captured screenshot (`screenshots/<jobId>_uncertain.png`) or employer portal.
- Check the candidate's email for an official application confirmation receipt.
- If confirmed: update `status` to `CONFIRMED` in `submissions_history.json` and link the confirmation receipt.
- If unsubmitted: manually address the blocker (e.g., solve CAPTCHA in headed mode or correct invalid input), then run with `--force` if authorized.

### Preserving Confirmed Records (e.g., Lyceum Case)
Jobs with verified success receipts have their confirmation receipts verified locally. The runner will refuse duplicate runs on these records unless overridden with `--force`.

---

## 7. Known Limitations & Edge Cases

1. **Anti-Bot & CAPTCHA Challenges**:
   - Cloudflare Turnstile or reCAPTCHA Enterprise requires interactive candidate solving. Run in headed mode (the default) so the user can complete the challenge.
2. **Unmapped Form Questions**:
   - If an employer adds custom screening questions not defined in `profile.json`, execution pauses immediately (`[AUDIT HALT - UNKNOWN QUESTION]`) to prevent incorrect answers. Add the verified answer to `profile.json` before resuming.
3. **Numeric vs. Text Salary Inputs**:
   - The runner detects `input[type="number"]` and converts formatted salary bands into valid raw integers (e.g., `48000`) to avoid HTML5 form validation rejections.
4. **Portal Differences**:
   - Ashby ATS and Greenhouse ATS are certified for end-to-end automated submission. Other ATS engines require verified DOM selector adapters.
