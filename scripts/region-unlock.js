#!/usr/bin/env node
'use strict';

const regionUnlock = require('../payload/dist/meter-region-unlock.js');

if (require.main === module) {
  const args = process.argv.slice(2);
  let mode = null;
  let target = null;
  let jsonOut = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--analyze') {
      mode = 'analyze';
      target = args[++i];
    } else if (args[i] === '--apply') {
      mode = 'apply';
      target = args[++i];
    } else if (args[i] === '--json') {
      jsonOut = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Usage: node scripts/region-unlock.js <--analyze|--apply> <language_server> [--json]');
      process.exit(0);
    } else if (!target) {
      target = args[i];
    }
  }

  if (!mode || !target) {
    console.error('Usage: node scripts/region-unlock.js <--analyze|--apply> <language_server> [--json]');
    process.exit(2);
  }

  try {
    const res = mode === 'apply' ? regionUnlock.applyRegionUnlock(target) : regionUnlock.analyzeRegionUnlock(target);
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      const fnShort = String(res.fnName || 'authclient.ValidateAndOnboardAccount').split('/').pop();
      const fmt32 = (w) => `0x${(w >>> 0).toString(16).padStart(8, '0')}`;
      if (mode === 'analyze') {
        console.log(
          `  [${res.status}] ${fnShort} @ 0x${res.fnStart.toString(16)} (rel +0x${res.relOffsetInFn.toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
      } else if (res.alreadyPatched) {
        console.log(`  already patched: ${fnShort} @ file 0x${res.branchOffset.toString(16)} (${fmt32(res.currentWord)})`);
      } else {
        console.log(
          `  找到 ${fnShort} @ file offset 0x${res.fnStart.toString(16)} (len 0x${(res.fnEnd - res.fnStart).toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
        console.log(
          `  patched: file 0x${res.branchOffset.toString(16)}  ${fmt32(res.currentWord)}(b.ne) -> ${fmt32(res.patchedWord)}(b)  target 0x${res.targetOffset.toString(16)}`
        );
      }
    } else {
      console.error(res.error || '地区解锁分析失败');
    }
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

module.exports = regionUnlock;
