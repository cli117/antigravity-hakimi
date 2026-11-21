#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { assertNotOfficialAntigravityApp } = require('./asar-engine');
const {
  sha256Buffer,
  scanGopclntabBySuffix,
  analyzeArm64RegionInRange,
} = require('./binary-utils');

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

const TARGET_FUNC_SUFFIX = 'authclient.ValidateAndOnboardAccount';

/**
 * Parse Mach-O 64-bit ARM64 __TEXT,__text section and LC_UUID.
 * @param {Buffer} buf
 */
function parseMachOTextSection(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error('目标文件不是有效的 Mach-O 二进制 (长度不足)');
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC_64) {
    throw new Error(`非 64-bit Mach-O 文件 (magic=0x${magic.toString(16)})`);
  }
  const cputype = buf.readUInt32LE(4);
  if (cputype !== CPU_TYPE_ARM64) {
    throw new Error(`仅支持 Apple Silicon ARM64 Mach-O (cputype=0x${cputype.toString(16)})`);
  }

  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  if (32 + sizeofcmds > buf.length) {
    throw new Error('Mach-O load commands 超出文件边界');
  }

  let off = 32;
  let uuid = null;
  let textSection = null;

  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > buf.length) break;

    if (cmd === LC_UUID && cmdsize >= 24) {
      uuid = buf.subarray(off + 8, off + 24).toString('hex');
    } else if (cmd === LC_SEGMENT_64 && cmdsize >= 72) {
      const nsects = buf.readUInt32LE(off + 64);
      let sectOff = off + 72;
      for (let s = 0; s < nsects && sectOff + 80 <= off + cmdsize; s++) {
        const sectname = buf.subarray(sectOff, sectOff + 16).toString('ascii').replace(/\0.*$/, '');
        const segname = buf.subarray(sectOff + 16, sectOff + 32).toString('ascii').replace(/\0.*$/, '');
        if (segname === '__TEXT' && sectname === '__text') {
          const textVA = Number(buf.readBigUInt64LE(sectOff + 32));
          const textSize = Number(buf.readBigUInt64LE(sectOff + 40));
          const textOff = buf.readUInt32LE(sectOff + 48);
          textSection = { textVA, textSize, textOff };
        }
        sectOff += 80;
      }
    }
    off += cmdsize;
  }

  if (!textSection) {
    throw new Error('Mach-O 中未找到 __TEXT,__text 段');
  }

  return {
    ...textSection,
    uuid,
    arch: 'arm64',
    format: 'Mach-O',
  };
}

/**
 * Scan Go .gopclntab to locate a function's [fnStart, fnEnd) file offsets.
 * @param {Buffer} buf
 * @param {number} textOff
 * @param {string} targetSuffix
 */
function findGoFunction(buf, textOff, targetSuffix = TARGET_FUNC_SUFFIX) {
  const res = scanGopclntabBySuffix(buf, [targetSuffix], { minLC: 0x04, textOff });
  if (!res.foundPcln) return { foundPcln: false, name: null };
  const hit = res.funcs[targetSuffix];
  if (!hit) return { foundPcln: true, name: null };
  return {
    foundPcln: true,
    name: hit.name,
    entryOff: hit.entryOff,
    nextEntryOff: hit.nextEntryOff,
    fnStart: hit.fnStart,
    fnEnd: hit.fnEnd,
    nfunc: res.nfunc,
  };
}

/**
 * Analyze authclient.ValidateAndOnboardAccount using adaptive instruction-pattern matching.
 * Distinguishes allowedTiers (BREAK_ONLY) vs ineligibleTiers (HAS_MATCH_BODY) loops without
 * hardcoding SHA-256 or fixed offset +0x294.
 * @param {string|Buffer} filePathOrBuf
 */
function analyzeRegionUnlock(filePathOrBuf) {
  let buf;
  let targetPath = null;
  if (Buffer.isBuffer(filePathOrBuf)) {
    buf = filePathOrBuf;
  } else {
    targetPath = String(filePathOrBuf || '');
    if (!targetPath || !fs.existsSync(targetPath)) {
      return {
        ok: false,
        status: 'missing_file',
        code: 'FILE_NOT_FOUND',
        error: `找不到目标文件: ${targetPath}`,
      };
    }
    buf = fs.readFileSync(targetPath);
  }

  const sha256 = sha256Buffer(buf);

  let macho;
  try {
    macho = parseMachOTextSection(buf);
  } catch (e) {
    return { ok: false, status: 'unsupported', code: 'INVALID_MACHO', sha256, error: e.message };
  }

  const fn = findGoFunction(buf, macho.textOff, TARGET_FUNC_SUFFIX);
  if (!fn.foundPcln) {
    return {
      ok: false,
      status: 'pclntab_missing',
      code: 'PCLNTAB_NOT_FOUND',
      sha256,
      error: '找不到 Go .gopclntab 符号表，二进制格式可能已变更',
    };
  }
  if (!fn.name) {
    return {
      ok: false,
      status: 'symbol_missing',
      code: 'SYMBOL_NOT_FOUND',
      sha256,
      error: `函数表中找不到 ${TARGET_FUNC_SUFFIX}，新版可能已重命名或重构`,
    };
  }

  const fnStart = Math.max(macho.textOff, fn.fnStart);
  const fnEnd = Math.min(buf.length, fn.fnEnd);
  if (fnEnd <= fnStart + 24) {
    return {
      ok: false,
      status: 'pattern_missing',
      code: 'FUNCTION_TOO_SMALL',
      fnName: fn.name,
      sha256,
      error: `${fn.name} 函数体过短，无法安全匹配`,
    };
  }

  const analyzed = analyzeArm64RegionInRange(buf, fnStart, fnEnd, fn.name);
  if (!analyzed.ok) {
    return { ...analyzed, sha256 };
  }

  return {
    ok: true,
    status: analyzed.status,
    fnName: analyzed.fnName,
    fnStart: analyzed.fnStart,
    fnEnd: analyzed.fnEnd,
    cmpOffset: analyzed.cmpOffset,
    branchOffset: analyzed.branchOffset,
    relOffsetInFn: analyzed.relOffsetInFn,
    targetOffset: analyzed.targetOffset,
    currentWord: analyzed.currentWord,
    patchedWord: analyzed.patchedWord,
    allowedTiersCount: analyzed.allowedTiersCount,
    hasFreeTieConst: analyzed.hasFreeTieConst,
    uuid: macho.uuid,
    sha256,
  };
}

/**
 * Apply unconditional branch patch at ineligibleTiers free-tier check in language_server.
 * Refuses official Antigravity.app paths.
 * @param {string} targetPath
 */
function applyRegionUnlock(targetPath) {
  assertNotOfficialAntigravityApp(targetPath, 'apply region unlock');
  const analysis = analyzeRegionUnlock(targetPath);
  if (!analysis.ok) return analysis;

  if (analysis.status === 'patched') {
    return { ...analysis, alreadyPatched: true };
  }

  const stat = fs.statSync(targetPath);
  const data = fs.readFileSync(targetPath);
  data.writeUInt32LE(analysis.patchedWord >>> 0, analysis.branchOffset);

  const tmpPath = `${targetPath}.region_tmp_${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.chmodSync(tmpPath, stat.mode & 0o777);
  fs.renameSync(tmpPath, targetPath);

  return {
    ...analysis,
    status: 'patched',
    alreadyPatched: false,
  };
}

function formatHex32(word) {
  return `0x${(word >>> 0).toString(16).padStart(8, '0')}`;
}

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
    const res = mode === 'apply' ? applyRegionUnlock(target) : analyzeRegionUnlock(target);
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      const fnShort = String(res.fnName || TARGET_FUNC_SUFFIX).split('/').pop();
      if (mode === 'analyze') {
        console.log(
          `  [${res.status}] ${fnShort} @ 0x${res.fnStart.toString(16)} (rel +0x${res.relOffsetInFn.toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
      } else if (res.alreadyPatched) {
        console.log(`  already patched: ${fnShort} @ file 0x${res.branchOffset.toString(16)} (${formatHex32(res.currentWord)})`);
      } else {
        console.log(
          `  找到 ${fnShort} @ file offset 0x${res.fnStart.toString(16)} (len 0x${(res.fnEnd - res.fnStart).toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
        console.log(
          `  patched: file 0x${res.branchOffset.toString(16)}  ${formatHex32(res.currentWord)}(b.ne) -> ${formatHex32(res.patchedWord)}(b)  target 0x${res.targetOffset.toString(16)}`
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

module.exports = {
  parseMachOTextSection,
  findGoFunction,
  analyzeRegionUnlock,
  applyRegionUnlock,
};
