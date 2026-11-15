#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { assertNotOfficialAntigravityApp } = require('./asar-engine');

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

const TARGET_FUNC_SUFFIX = 'authclient.ValidateAndOnboardAccount';

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

function readCString(buf, start, maxLen = 2048) {
  if (start < 0 || start >= buf.length) return '';
  let end = buf.indexOf(0, start);
  if (end < 0 || end - start > maxLen) {
    end = Math.min(buf.length, start + maxLen);
  }
  return buf.subarray(start, end).toString('utf8');
}

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
  const magics = [
    Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]),
    Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]),
  ];

  let foundPcln = false;

  for (const pat of magics) {
    let pos = 0;
    while (pos >= 0 && pos < buf.length) {
      const i = buf.indexOf(pat, pos);
      if (i < 0) break;
      pos = i + 4;
      if (i + 72 > buf.length) continue;

      const nfunc = Number(buf.readBigUInt64LE(i + 8));
      const fnOff = Number(buf.readBigUInt64LE(i + 32));
      const pclnOff = Number(buf.readBigUInt64LE(i + 64));

      if (!(nfunc >= 1 && nfunc < 500000)) continue;
      const functab = i + pclnOff;
      const fnname = i + fnOff;
      if (pclnOff <= 0 || fnOff <= 0 || functab + (nfunc + 1) * 8 > buf.length || fnname >= buf.length) {
        continue;
      }

      foundPcln = true;
      for (let k = 0; k < nfunc; k++) {
        const entryOff = buf.readUInt32LE(functab + k * 8);
        const funcOff = buf.readUInt32LE(functab + k * 8 + 4);
        const fo = functab + funcOff;
        if (fo + 8 > buf.length) continue;
        const nameOff = buf.readInt32LE(fo + 4);
        if (nameOff < 0 || fnname + nameOff >= buf.length) continue;

        const name = readCString(buf, fnname + nameOff);
        if (
          name === targetSuffix ||
          name.endsWith('/' + targetSuffix) ||
          name.endsWith('.' + targetSuffix)
        ) {
          const nextEntryOff = buf.readUInt32LE(functab + (k + 1) * 8);
          return {
            foundPcln: true,
            name,
            entryOff,
            nextEntryOff,
            fnStart: textOff + entryOff,
            fnEnd: textOff + nextEntryOff,
            nfunc,
          };
        }
      }
      // Valid .gopclntab parsed, but symbol absent in this binary.
      return { foundPcln: true, name: null };
    }
  }

  return { foundPcln, name: null };
}

function decodeBneTarget(word, instrOffset) {
  if (((word & 0xff00001f) >>> 0) !== 0x54000001) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeCondBranchTarget(word, instrOffset) {
  if (((word & 0xff000010) >>> 0) !== 0x54000000) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeUncondBranchTarget(word, instrOffset) {
  if (((word & 0xfc000000) >>> 0) !== 0x14000000) return null;
  const imm26 = signExtend(word & 0x03ffffff, 26);
  return instrOffset + imm26 * 4;
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

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

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

  // Optional sanity evidence: "free-tie" (movz reg, #0x7266) inside function body
  let hasFreeTieConst = false;
  for (let p = fnStart; p <= fnEnd - 4; p += 4) {
    const w = buf.readUInt32LE(p);
    if (((w & 0x7fffffe0) >>> 0) === 0x528e4cc0) {
      hasFreeTieConst = true;
      break;
    }
  }

  const candidates = [];
  for (let p = fnStart; p <= fnEnd - 20; p += 4) {
    const w0 = buf.readUInt32LE(p);
    // cmp xN/wN, #9 (length of "free-tier")
    if (((w0 & 0x7ffffc1f) >>> 0) !== 0x7100241f) continue;

    const w1 = buf.readUInt32LE(p + 4);
    let T = decodeBneTarget(w1, p + 4);
    let state = null;
    if (T !== null) {
      state = 'unpatched';
    } else {
      T = decodeUncondBranchTarget(w1, p + 4);
      if (T !== null) state = 'patched';
    }
    if (T === null || T < fnStart || T >= p) continue;

    // Locate stage-3 tail check: cmp wM/xM, #0x72 ('r') ; b.ne T within [p+8, p+0x48)
    let tailEnd = null;
    let interBneCount = 0;
    const searchLimit = Math.min(fnEnd - 8, p + 0x48);
    for (let q = p + 8; q <= searchLimit; q += 4) {
      const wq0 = buf.readUInt32LE(q);
      const wq1 = buf.readUInt32LE(q + 4);
      if (((wq0 & 0x7ffffc1f) >>> 0) === 0x7101c81f) {
        const qt = decodeBneTarget(wq1, q + 4);
        if (qt === T) {
          tailEnd = q + 8;
          break;
        }
      }
      if (decodeBneTarget(wq0, q) === T) {
        interBneCount++;
      }
    }
    if (tailEnd === null || interBneCount < 1) continue;

    // Inspect loop-exit branches inside [T, min(p, T + 0x30))
    const loopExits = [];
    const loopScanEnd = Math.min(p, T + 0x30);
    for (let r = T; r < loopScanEnd; r += 4) {
      const wr = buf.readUInt32LE(r);
      const dest = decodeCondBranchTarget(wr, r);
      if (dest !== null && dest >= tailEnd) {
        loopExits.push({ offset: r, dest });
      }
    }
    if (loopExits.length === 0) continue;

    const hasMatchBody = loopExits.some((e) => e.dest > tailEnd);
    const isBreakOnly = loopExits.every((e) => e.dest === tailEnd);
    candidates.push({ p, w0, w1, T, tailEnd, state, loopExits, hasMatchBody, isBreakOnly });
  }

  const ineligible = candidates.filter((c) => c.hasMatchBody);
  const allowed = candidates.filter((c) => c.isBreakOnly && !c.hasMatchBody);

  if (ineligible.length === 0) {
    return {
      ok: false,
      status: 'pattern_missing',
      code: 'PATTERN_NOT_FOUND',
      fnName: fn.name,
      fnStart,
      fnEnd,
      hasFreeTieConst,
      allowedTiersCount: allowed.length,
      sha256,
      error: `在 ${fn.name} 中未找到 free-tier 地区限制分支，新版反重力可能已移除或重构该逻辑`,
    };
  }

  if (ineligible.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      code: 'AMBIGUOUS_MATCH',
      fnName: fn.name,
      fnStart,
      fnEnd,
      sha256,
      error: `在 ValidateAndOnboardAccount 中命中 ${ineligible.length} 处候选分支，为安全起见停止处理`,
    };
  }

  if (allowed.some((c) => c.state !== 'unpatched')) {
    return {
      ok: false,
      status: 'corrupted_allowed_tiers',
      code: 'ALLOWED_TIERS_MODIFIED',
      fnName: fn.name,
      sha256,
      error: '检测到 allowedTiers 循环被意外修改',
    };
  }

  const hit = ineligible[0];
  const branchOffset = hit.p + 4;
  const off26 = (hit.T - branchOffset) / 4;
  if (!Number.isInteger(off26) || off26 < -(1 << 25) || off26 >= (1 << 25)) {
    return {
      ok: false,
      status: 'out_of_range',
      code: 'BRANCH_OUT_OF_RANGE',
      fnName: fn.name,
      sha256,
      error: '地区解锁跳转分支距离超出 ARM64 b 指令范围',
    };
  }

  const patchedWord = (0x14000000 | (off26 & 0x03ffffff)) >>> 0;

  return {
    ok: true,
    status: hit.state,
    fnName: fn.name,
    fnStart,
    fnEnd,
    cmpOffset: hit.p,
    branchOffset,
    relOffsetInFn: hit.p - fnStart,
    targetOffset: hit.T,
    currentWord: hit.w1 >>> 0,
    patchedWord,
    allowedTiersCount: allowed.length,
    hasFreeTieConst,
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
