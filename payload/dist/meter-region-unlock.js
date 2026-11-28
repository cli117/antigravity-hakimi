#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { assertNotOfficialAntigravityApp } = require('./asar-engine');
const {
  sha256Buffer,
  scanGopclntabBySuffix,
  normalizeRegionArch,
  analyzeRegionInRangeByArch,
} = require('./binary-utils');

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/** cputype -> internal engine arch label */
const MACHO_CPU_ARCH = {
  [CPU_TYPE_X86_64]: 'x86_64',
  [CPU_TYPE_ARM64]: 'arm64',
};

/** Go .gopclntab minLC (instruction alignment) per normalized arch: 1 for x86, 4 for arm64. */
const MIN_LC_BY_ARCH = {
  'x86-64': 0x01,
  arm64: 0x04,
};

const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

const TARGET_FUNC_SUFFIX = 'authclient.ValidateAndOnboardAccount';

/**
 * Parse Mach-O 64-bit __TEXT,__text section and LC_UUID.
 * Supports both Apple Silicon (arm64) and Intel (x86_64) thin binaries.
 * @param {Buffer} buf
 */
function parseMachOTextSection(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error('目标文件不是有效的 Mach-O 二进制 (长度不足)');
  }
  const magic = buf.readUInt32LE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf || magic === 0xbfbafeca) {
    throw new Error('目标为 Universal (fat) Mach-O，请先使用 lipo -thin 提取单一架构后再处理');
  }
  if (magic !== MH_MAGIC_64) {
    throw new Error(`非 64-bit Mach-O 文件 (magic=0x${magic.toString(16)})`);
  }
  const cputype = buf.readUInt32LE(4);
  const arch = MACHO_CPU_ARCH[cputype];
  if (!arch) {
    throw new Error(
      `仅支持 Mach-O arm64 / x86_64 (cputype=0x${cputype.toString(16)})`
    );
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
    cputype,
    arch,
    format: 'Mach-O',
  };
}

/**
 * Scan Go .gopclntab to locate a function's [fnStart, fnEnd) file offsets.
 * @param {Buffer} buf
 * @param {number} textOff
 * @param {string} targetSuffix
 * @param {string} [arch] Mach-O arch label ('arm64' | 'x86_64'); controls Go minLC.
 */
function findGoFunction(buf, textOff, targetSuffix = TARGET_FUNC_SUFFIX, arch = 'arm64') {
  const minLC = MIN_LC_BY_ARCH[normalizeRegionArch(arch)] ?? MIN_LC_BY_ARCH.arm64;
  const res = scanGopclntabBySuffix(buf, [targetSuffix], { minLC, textOff });
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

  const fn = findGoFunction(buf, macho.textOff, TARGET_FUNC_SUFFIX, macho.arch);
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

  const analyzed = analyzeRegionInRangeByArch(buf, fnStart, fnEnd, fn.name, macho.arch);
  if (!analyzed.ok) {
    return { ...analyzed, sha256 };
  }

  return {
    ok: true,
    arch: analyzed.arch,
    status: analyzed.status,
    fnName: analyzed.fnName,
    fnStart: analyzed.fnStart,
    fnEnd: analyzed.fnEnd,
    cmpOffset: analyzed.cmpOffset,
    branchOffset: analyzed.branchOffset,
    branchLength: analyzed.branchLength,
    relOffsetInFn: analyzed.relOffsetInFn,
    targetOffset: analyzed.targetOffset,
    currentBytes: analyzed.currentBytes,
    patchedBytes: analyzed.patchedBytes,
    // 4-byte ARM64 word view, kept for backward compatibility with existing callers.
    ...(analyzed.currentBytes && analyzed.currentBytes.length === 4
      ? { currentWord: analyzed.currentWord, patchedWord: analyzed.patchedWord }
      : {}),
    allowedTiersCount: analyzed.allowedTiersCount,
    hasFreeTieConst: analyzed.hasFreeTieConst,
    uuid: macho.uuid,
    sha256,
  };
}

/**
 * Apply an unconditional branch patch at the ineligibleTiers free-tier check.
 * The patch length follows the analyzed architecture (4 bytes on arm64, 2 or 6 bytes on x86_64).
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

  const patchBytes = analysis.patchedBytes;
  if (
    !Buffer.isBuffer(patchBytes) ||
    !Number.isInteger(analysis.branchOffset) ||
    analysis.branchOffset < 0 ||
    analysis.branchOffset + patchBytes.length > fs.statSync(targetPath).size
  ) {
    return {
      ...analysis,
      ok: false,
      code: 'BRANCH_SITE_INVALID',
      error: '地区解锁分支偏移与补丁字节不合法，停止处理',
    };
  }

  const stat = fs.statSync(targetPath);
  const data = fs.readFileSync(targetPath);
  patchBytes.copy(data, analysis.branchOffset);

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

/** Render a patch site as hex bytes, falling back to the legacy 32-bit word view. */
function formatPatchSite(res, which) {
  const bytes = which === 'patched' ? res.patchedBytes : res.currentBytes;
  if (Buffer.isBuffer(bytes)) {
    return bytes.toString('hex').replace(/(..)(?=.)/g, '$1 ');
  }
  const word = which === 'patched' ? res.patchedWord : res.currentWord;
  return Number.isInteger(word) ? formatHex32(word) : '?';
}

const PATCH_MNEMONIC = { 'x86-64': ['jne', 'jmp'], arm64: ['b.ne', 'b'] };


const USAGE = 'Usage: node scripts/region-unlock.js <--analyze|--apply> <language_server> [--json]';

/**
 * Shared CLI entry point for both scripts/region-unlock.js and direct module execution.
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function runCli(argv = process.argv.slice(2)) {
  let mode = null;
  let target = null;
  let jsonOut = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--analyze') {
      mode = 'analyze';
      target = argv[++i];
    } else if (argv[i] === '--apply') {
      mode = 'apply';
      target = argv[++i];
    } else if (argv[i] === '--json') {
      jsonOut = true;
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(USAGE);
      return 0;
    } else if (!target) {
      target = argv[i];
    }
  }

  if (!mode || !target) {
    console.error(USAGE);
    return 2;
  }

  try {
    const res = mode === 'apply' ? applyRegionUnlock(target) : analyzeRegionUnlock(target);
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      const fnShort = String(res.fnName || TARGET_FUNC_SUFFIX).split('/').pop();
      const [fromMnemonic, toMnemonic] = PATCH_MNEMONIC[res.arch] || PATCH_MNEMONIC.arm64;
      if (mode === 'analyze') {
        console.log(
          `  [${res.status}] (${res.arch}) ${fnShort} @ 0x${res.fnStart.toString(16)} (rel +0x${res.relOffsetInFn.toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
      } else if (res.alreadyPatched) {
        console.log(`  already patched: ${fnShort} @ file 0x${res.branchOffset.toString(16)} (${formatPatchSite(res, 'current')})`);
      } else {
        console.log(
          `  找到 ${fnShort} @ file offset 0x${res.fnStart.toString(16)} (len 0x${(res.fnEnd - res.fnStart).toString(16)}, allowedTiers=${res.allowedTiersCount})`
        );
        console.log(
          `  patched: file 0x${res.branchOffset.toString(16)}  ${formatPatchSite(res, 'current')}(${fromMnemonic}) -> ${formatPatchSite(res, 'patched')}(${toMnemonic})  target 0x${res.targetOffset.toString(16)}`
        );
      }
    } else {
      console.error(res.error || '地区解锁分析失败');
    }
    return res.ok ? 0 : 1;
  } catch (err) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(err.message);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = {
  parseMachOTextSection,
  findGoFunction,
  analyzeRegionUnlock,
  applyRegionUnlock,
  formatPatchSite,
  runCli,
};
