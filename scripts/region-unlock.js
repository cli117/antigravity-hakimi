#!/usr/bin/env node
'use strict';

const regionUnlock = require('../payload/dist/meter-region-unlock.js');

if (require.main === module) {
  process.exit(regionUnlock.runCli(process.argv.slice(2)));
}

module.exports = regionUnlock;
