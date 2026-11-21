'use strict';
/**
 * Shared low-level binary helpers for 哈基米.app patch engines
 * (Mach-O / ELF64 Go .gopclntab scanning, ARM64 / x86-64 instruction codecs, and
 * adaptive ARM64 ValidateAndOnboardAccount region branch analysis).
 */

const crypto = require('crypto');

// ARM64 Gate 3A / 3B patterns
const NOP_ARM64 = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
const PATCH_256K_ARM64 = Buffer.concat(Array.from({ length: 6 }, () => NOP_ARM64));
const CLAMP_256K_ARM64 = Buffer.from('04009dd26400a0f27f00046b04009dd26400a0f26330849a', 'hex');
const DEF_ORIG_ARM64 = Buffer.from('03009dd26300a0f2030c00b9', 'hex');
const DEF_GUARD_ARM64 = Buffer.from('7f0000718c000054', 'hex');
const STR_W3_X0_0C_ARM64 = Buffer.from('030c00b9', 'hex');

// x86-64 Gate 3A patterns
const CLAMP_256K_X64 = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
const PATCH_256K_X64 = Buffer.concat([Buffer.from('89d6', 'hex'), Buffer.alloc(12, 0x90)]);
const DEF_ORIG_X64 = Buffer.from('c7400c00e80300', 'hex');
const DEF_PREFIX_X64 = Buffer.from('c7400c', 'hex');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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

function encodeMovzMovkArm64(reg, limitTokens) {
  const val = limitTokens >>> 0;
  const lo = val & 0xffff;
  const hi = (val >>> 16) & 0xffff;
  const rd = reg & 0x1f;
  const movz = (0xd2800000 | (lo << 5) | rd) >>> 0;
  const movk = (0xf2a00000 | (hi << 5) | rd) >>> 0;
  const out = Buffer.alloc(8);
  out.writeUInt32LE(movz, 0);
  out.writeUInt32LE(movk, 4);
  return out;
}

function decodeMovzMovkArm64(buf, offset, reg) {
  if (!buf || offset < 0 || offset + 8 > buf.length) return null;
  const rd = reg & 0x1f;
  const w0 = buf.readUInt32LE(offset);
  const w1 = buf.readUInt32LE(offset + 4);
  if (((w0 & 0xffe0001f) >>> 0) !== ((0xd2800000 | rd) >>> 0)) return null;
  if (((w1 & 0xffe0001f) >>> 0) !== ((0xf2a00000 | rd) >>> 0)) return null;
  const lo = (w0 >>> 5) & 0xffff;
  const hi = (w1 >>> 5) & 0xffff;
  return (((hi << 16) | lo) >>> 0);
}

function buildClampConstArm64(limitTokens) {
  const out = Buffer.alloc(24);
  encodeMovzMovkArm64(3, limitTokens).copy(out, 0);
  for (let i = 8; i < 24; i += 4) {
    NOP_ARM64.copy(out, i);
  }
  return out;
}

function buildDefConstArm64(limitTokens) {
  const out = Buffer.alloc(12);
  encodeMovzMovkArm64(3, limitTokens).copy(out, 0);
  STR_W3_X0_0C_ARM64.copy(out, 8);
  return out;
}

function buildClampConstX64(limitTokens) {
  const out = Buffer.alloc(14, 0x90);
  out[0] = 0xbe;
  out.writeUInt32LE(limitTokens >>> 0, 1);
  return out;
}

function buildDefConstX64(limitTokens) {
  const out = Buffer.alloc(7);
  DEF_PREFIX_X64.copy(out, 0);
  out.writeUInt32LE(limitTokens >>> 0, 3);
  return out;
}

function encodeAdrpArm64(rd, pcVA, targetVA) {
  const pcPage = Math.floor(pcVA / 4096);
  const targetPage = Math.floor(targetVA / 4096);
  const delta = targetPage - pcPage;
  if (delta < -(1 << 20) || delta >= (1 << 20)) {
    throw new Error('adrp target out of +/-4GB range');
  }
  const imm21 = delta & 0x1fffff;
  return (0x90000000 | ((imm21 & 3) << 29) | ((imm21 >>> 2) << 5) | (rd & 0x1f)) >>> 0;
}

function encodeAddImmArm64(rd, rn, imm12) {
  if (imm12 < 0 || imm12 > 0xfff) {
    throw new Error('add immediate out of 12-bit range');
  }
  return (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 0x1f) << 5) | (rd & 0x1f)) >>> 0;
}

function encodeMovz64Arm64(rd, imm16) {
  if (imm16 < 0 || imm16 > 0xffff) {
    throw new Error('movz immediate out of 16-bit range');
  }
  return (0xd2800000 | ((imm16 & 0xffff) << 5) | (rd & 0x1f)) >>> 0;
}

function encodeBlArm64(pcVA, targetVA) {
  const delta = targetVA - pcVA;
  if (delta % 4 !== 0 || delta < -(1 << 27) || delta >= (1 << 27)) {
    throw new Error('bl target out of +/-128MB range');
  }
  const imm26 = Math.trunc(delta / 4) & 0x03ffffff;
  return (0x94000000 | imm26) >>> 0;
}

function decodeBlArm64Target(word, pcVA) {
  if (((word & 0xfc000000) >>> 0) !== 0x94000000) return null;
  const raw26 = word & 0x03ffffff;
  const imm26 = (raw26 & 0x02000000) !== 0 ? (raw26 - 0x04000000) : raw26;
  return pcVA + imm26 * 4;
}

function decodeArm64BneTarget(word, instrOffset) {
  if (((word & 0xff00001f) >>> 0) !== 0x54000001) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeArm64CondBranchTarget(word, instrOffset) {
  if (((word & 0xff000010) >>> 0) !== 0x54000000) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeArm64UncondBranchTarget(word, instrOffset) {
  if (((word & 0xfc000000) >>> 0) !== 0x14000000) return null;
  const imm26 = signExtend(word & 0x03ffffff, 26);
  return instrOffset + imm26 * 4;
}

/**
 * Scan Go .gopclntab (Go 1.18+ 0xFFFFFFF0 / Go 1.20+ 0xFFFFFFF1) for target function suffixes.
 * @param {Buffer} buf
 * @param {string[]} targetSuffixes
 * @param {{ minLC?: number, maxNfunc?: number, resolveBase?: (pclnOff: number, textStart: number) => { goTextOff: number, goTextVA?: number, source?: string } }} [options]
 */
function scanGopclntabBySuffix(buf, targetSuffixes, options = {}) {
  const minLC = options.minLC ?? 0x04;
  const maxNfunc = options.maxNfunc ?? 500000;
  const suffixes = Array.isArray(targetSuffixes) ? targetSuffixes : [targetSuffixes];
  const magics = [
    Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, minLC, 0x08]),
    Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x00, 0x00, minLC, 0x08]),
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
      const textStart = Number(buf.readBigUInt64LE(i + 24));
      const fnOff = Number(buf.readBigUInt64LE(i + 32));
      const pclnOff = Number(buf.readBigUInt64LE(i + 64));

      if (!(nfunc >= 1 && nfunc < maxNfunc)) continue;
      const functab = i + pclnOff;
      const fnname = i + fnOff;
      if (pclnOff <= 0 || fnOff <= 0 || functab + (nfunc + 1) * 8 > buf.length || fnname >= buf.length) {
        continue;
      }

      foundPcln = true;
      const base =
        typeof options.resolveBase === 'function'
          ? options.resolveBase(i, textStart)
          : { goTextOff: options.textOff || 0, goTextVA: options.textVA || 0, source: 'explicit' };
      const found = Object.create(null);
      let foundCount = 0;

      for (let k = 0; k < nfunc; k++) {
        const entryOff = buf.readUInt32LE(functab + k * 8);
        const funcOff = buf.readUInt32LE(functab + k * 8 + 4);
        const fo = functab + funcOff;
        if (fo + 8 > buf.length) continue;
        const nameOff = buf.readInt32LE(fo + 4);
        if (nameOff < 0 || fnname + nameOff >= buf.length) continue;
        const name = readCString(buf, fnname + nameOff);

        for (const suf of suffixes) {
          if (
            !found[suf] &&
            (name === suf || name.endsWith('/' + suf) || name.endsWith('.' + suf))
          ) {
            const nextEntryOff = buf.readUInt32LE(functab + (k + 1) * 8);
            const size = nextEntryOff > entryOff ? nextEntryOff - entryOff : 0;
            found[suf] = {
              name,
              entryOff,
              nextEntryOff,
              size,
              fnStart: base.goTextOff + entryOff,
              fnEnd: base.goTextOff + nextEntryOff,
              fnVA: (base.goTextVA || 0) + entryOff,
            };
            foundCount++;
          }
        }
        if (foundCount >= suffixes.length) break;
      }

      return {
        foundPcln: true,
        pclnOff: i,
        nfunc,
        goTextVA: base.goTextVA || 0,
        goTextOff: base.goTextOff,
        goTextSource: base.source || 'explicit',
        funcs: found,
      };
    }
  }

  return { foundPcln, funcs: Object.create(null) };
}

/**
 * Shared adaptive ARM64 instruction-pattern analyzer for authclient.ValidateAndOnboardAccount.
 * Distinguishes allowedTiers (BREAK_ONLY) vs ineligibleTiers (HAS_MATCH_BODY) loops across
 * both macOS Mach-O ARM64 and Linux ELF64 ARM64 binaries.
 */
function analyzeArm64RegionInRange(buf, fnStart, fnEnd, fnName) {
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
    let T = decodeArm64BneTarget(w1, p + 4);
    let state = null;
    if (T !== null) {
      state = 'unpatched';
    } else {
      T = decodeArm64UncondBranchTarget(w1, p + 4);
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
        const qt = decodeArm64BneTarget(wq1, q + 4);
        if (qt === T) {
          tailEnd = q + 8;
          break;
        }
      }
      if (decodeArm64BneTarget(wq0, q) === T) {
        interBneCount++;
      }
    }
    if (tailEnd === null || interBneCount < 1) continue;

    // Inspect loop-exit branches inside [T, min(p, T + 0x30))
    const loopExits = [];
    const loopScanEnd = Math.min(p, T + 0x30);
    for (let r = T; r < loopScanEnd; r += 4) {
      const wr = buf.readUInt32LE(r);
      const dest = decodeArm64CondBranchTarget(wr, r);
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
      fnName,
      fnStart,
      fnEnd,
      hasFreeTieConst,
      allowedTiersCount: allowed.length,
      error: `在 ${fnName} 中未找到 free-tier 地区限制分支，新版反重力可能已移除或重构该逻辑`,
    };
  }

  if (ineligible.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      code: 'AMBIGUOUS_MATCH',
      fnName,
      fnStart,
      fnEnd,
      error: `在 ValidateAndOnboardAccount 中命中 ${ineligible.length} 处候选分支，为安全起见停止处理`,
    };
  }

  if (allowed.some((c) => c.state !== 'unpatched')) {
    return {
      ok: false,
      status: 'corrupted_allowed_tiers',
      code: 'ALLOWED_TIERS_MODIFIED',
      fnName,
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
      fnName,
      error: '地区解锁跳转分支距离超出 ARM64 b 指令范围',
    };
  }

  const patchedWord = (0x14000000 | (off26 & 0x03ffffff)) >>> 0;
  const patchedBytes = Buffer.alloc(4);
  patchedBytes.writeUInt32LE(patchedWord, 0);

  return {
    ok: true,
    arch: 'arm64',
    status: hit.state,
    fnName,
    fnStart,
    fnEnd,
    cmpOffset: hit.p,
    branchOffset,
    branchLength: 4,
    relOffsetInFn: hit.p - fnStart,
    targetOffset: hit.T,
    currentWord: hit.w1 >>> 0,
    patchedWord,
    currentBytes: Buffer.from(buf.subarray(branchOffset, branchOffset + 4)),
    patchedBytes,
    allowedTiersCount: allowed.length,
    hasFreeTieConst,
  };
}

module.exports = {
  NOP_ARM64,
  PATCH_256K_ARM64,
  CLAMP_256K_ARM64,
  DEF_ORIG_ARM64,
  DEF_GUARD_ARM64,
  STR_W3_X0_0C_ARM64,
  CLAMP_256K_X64,
  PATCH_256K_X64,
  DEF_ORIG_X64,
  DEF_PREFIX_X64,
  sha256Buffer,
  signExtend,
  readCString,
  encodeMovzMovkArm64,
  decodeMovzMovkArm64,
  buildClampConstArm64,
  buildDefConstArm64,
  buildClampConstX64,
  buildDefConstX64,
  encodeAdrpArm64,
  encodeAddImmArm64,
  encodeMovz64Arm64,
  encodeBlArm64,
  decodeBlArm64Target,
  decodeArm64BneTarget,
  decodeArm64CondBranchTarget,
  decodeArm64UncondBranchTarget,
  scanGopclntabBySuffix,
  analyzeArm64RegionInRange,
};
