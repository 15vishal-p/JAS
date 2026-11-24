# Application

Complete authorized applications efficiently using the exact CV released by CV Audit. Read [application research](../../resources/application.md), [login handling](../execution.md) and the private confirmed-answer register. Reuse existing sessions, drafts and verified answers to reduce repeated work.

## Preconditions

Require a current live vacancy, resolved essential requirements, user authority covering the submission, and a `Pass` audit identifying the exact artifact version. Re-read shared ownership and current tracker state before portal writes. Reconcile prior or uncertain submissions before retrying. If any prerequisite is missing, preserve the draft and route the issue to its owner. In monitor mode, inspect records and report status without altering files or submitting applications.

## Work

1. Recheck the vacancy on the official employer application link from the verified JD before applying. Match employer, requisition and authenticated account. Confirm the posting is active and not expired (detecting 404 or closed status). Confirm that it has not already been submitted.
2. For automated local execution, reuse the verified Playwright application runner (`skills/job-application/scripts/apply.js`). Execute safe dry-run inspection by default (`node skills/job-application/scripts/apply.js --url=<url> --cv=<pdf>`), which fills fields, attaches the CV, verifies DOM rendering, captures a full-page pre-submission screenshot, and exits without submitting.
3. Require exact CV matching to the target Job ID (e.g., `<Company>_<Role>_<Job_ID>_CV.pdf`). Cross-role reuse or mismatched Job IDs are strictly rejected. Form fields and screening questions must be populated exclusively from verified candidate facts.
4. Stop or skip immediately on an expired listing, missing or mismatched CV, unanswered screening question, CAPTCHA / bot challenge, unsupported portal, or uncertain submission. Never guess answers. For approved queues with standing authorization (`--approved-queue`), the runner automatically submits ready, validated applications while cleanly logging and skipping blockers to continue queue processing.
5. Reuse a valid signed-in session first. When file-based login is authorized and supported by the host, use only the matching site's entry in the user's private `secrets/login.md` or configured existing login file. Verify the exact official HTTPS origin and account scope before entering credentials through supported tools. Never copy secrets into handoffs, terminal commands, tracker rows, reports or generated examples.
6. Submit only within current user authority. Verify a role-specific confirmation page, application ID, portal state or confirmation email. Record `Applied` only with that evidence. If the outcome is uncertain, record `Needs verification` / `UNCERTAIN` and reconcile employer state before any repeat attempt. Automatic retries are blocked until manual reconciliation.
7. Update the existing private tracker with artifact reference, audit reference, application state, timestamp/timezone, receipt evidence, blockers and next action. Preserve formulas, unrelated rows and newer edits. Save a resumable checkpoint when access or runtime ends.

## Report

Return the employer/requisition, confirmed submission evidence or exact blocker, final CV version, saved draft location when available and next action. Count started drafts and confirmed submissions separately. Notify the user of genuine blockers and audit regressions. Report account actions only when verified through the current session.
