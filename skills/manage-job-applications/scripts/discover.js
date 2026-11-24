#!/usr/bin/env node
/**
 * Forwarding entrypoint for local Playwright discovery from manage-job-applications.
 * Reuses the canonical discovery runner in skills/job-application/scripts/discover.js.
 */
const path = require('path');
const discoverModule = require(path.join(__dirname, '..', '..', 'job-application', 'scripts', 'discover.js'));

module.exports = discoverModule;

if (require.main === module) {
  discoverModule.discoverJobs(discoverModule.parseArgs()).catch(err => {
    console.error('[Discovery Fatal Error]:', err);
    process.exit(1);
  });
}
