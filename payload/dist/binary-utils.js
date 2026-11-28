'use strict';
/**
 * Shared low-level binary helpers for 哈基米.app region unlock engines
 * (Mach-O / ELF64 Go .gopclntab scanning and arch-adaptive ValidateAndOnboardAccount
 * branch analysis covering Apple Silicon arm64, Intel x86-64 Mach-O and Linux ELF64).
 */

const crypto = require('crypto');

/** `"free-tie"` little-endian bytes (first 8 bytes of the `free-tier` tier name). */
const FREE_TIE_BYTES = Buffer.from('667265652d746965', 'hex');

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

/**
 * Decode an x86-64 `jne` (0x75 rel8 / 0F 85 rel32) or its already-patched unconditional
 * `jmp` (EB rel8 / E9 rel32, optionally NOP-padded) form at `off`.
 * Returns the branch length, current state, branch target and the 1:1 same-length patch bytes.
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} fnEnd
 */
function decodeX64JneOrJmp(buf, off, fnEnd) {
  if (off + 2 > fnEnd) return null;
  const b0 = buf[off];
  const b1 = buf[off + 1];
  if (b0 === 0x0f && b1 === 0x85 && off + 6 <= fnEnd) {
    const rel32 = buf.readInt32LE(off + 2);
    const patched = Buffer.alloc(6);
    patched[0] = 0x90;
    patched[1] = 0xe9;
    patched.writeInt32LE(rel32, 2);
    return { len: 6, state: 'unpatched', target: off + 6 + rel32, patched };
  }
  if (b0 === 0x90 && b1 === 0xe9 && off + 6 <= fnEnd) {
    const rel32 = buf.readInt32LE(off + 2);
    return { len: 6, state: 'patched', target: off + 6 + rel32, patched: Buffer.from(buf.subarray(off, off + 6)) };
  }
  if (b0 === 0xe9 && off + 6 <= fnEnd && buf[off + 5] === 0x90) {
    const rel32 = buf.readInt32LE(off + 1);
    return { len: 6, state: 'patched', target: off + 5 + rel32, patched: Buffer.from(buf.subarray(off, off + 6)) };
  }
  if (b0 === 0x75) {
    const rel8 = buf.readInt8(off + 1);
    const patched = Buffer.from([0xeb, buf[off + 1]]);
    return { len: 2, state: 'unpatched', target: off + 2 + rel8, patched };
  }
  if (b0 === 0xeb) {
    const rel8 = buf.readInt8(off + 1);
    return { len: 2, state: 'patched', target: off + 2 + rel8, patched: Buffer.from(buf.subarray(off, off + 2)) };
  }
  return null;
}

/**
 * Shared adaptive x86-64 instruction-pattern analyzer for authclient.ValidateAndOnboardAccount.
 * Container-agnostic: works for Linux ELF64 x86-64 and macOS Intel (x86_64) Mach-O alike.
 * Distinguishes allowedTiers (BREAK_ONLY) vs ineligibleTiers (HAS_MATCH_BODY) loops.
 * @param {Buffer} buf
 * @param {number} fnStart
 * @param {number} fnEnd
 * @param {string} fnName
 */
function analyzeX64RegionInRange(buf, fnStart, fnEnd, fnName) {
  const freeIdxAny = buf.indexOf(FREE_TIE_BYTES, fnStart);
  const hasFreeTieConst = freeIdxAny >= fnStart && freeIdxAny < fnEnd;
  const candidates = [];
  const seenJOff = new Set();

  for (let p = fnStart; p < fnEnd - 24; p++) {
    let cmpLen = 0;
    // cmp r64, imm8 == 9  ->  REX.W 83 /7 ib
    if ((buf[p] === 0x48 || buf[p] === 0x49) && buf[p + 1] === 0x83 && (buf[p + 2] & 0xf8) === 0xf8 && buf[p + 3] === 0x09) {
      cmpLen = 4;
    } else if (
      // cmp r32, imm8 == 9  ->  83 /7 ib (no REX.W prefix)
      buf[p] === 0x83 &&
      (buf[p + 1] & 0xf8) === 0xf8 &&
      buf[p + 2] === 0x09 &&
      !(p > fnStart && (buf[p - 1] === 0x48 || buf[p - 1] === 0x49))
    ) {
      cmpLen = 3;
    } else {
      continue;
    }

    const jOff = p + cmpLen;
    if (seenJOff.has(jOff)) continue;
    const br = decodeX64JneOrJmp(buf, jOff, fnEnd);
    if (!br) continue;

    // The "free-tie" immediate must follow the length check almost immediately (Go movabs).
    const afterBr = jOff + br.len;
    const freeIdx = buf.indexOf(FREE_TIE_BYTES, afterBr);
    if (freeIdx < 0 || freeIdx > afterBr + 16) continue;

    // Locate the tail byte check `cmp byte ptr [reg+8], 0x72` ('r') and confirm it branches
    // back to the very same loop top as the length check.
    let tailEnd = null;
    let loopTop = null;
    const tailScanEnd = Math.min(fnEnd - 6, freeIdx + 0x30);
    for (let q = freeIdx + 8; q < tailScanEnd; q++) {
      let nextQ = -1;
      if (buf[q] === 0x80 && (buf[q + 1] & 0xf8) === 0x78 && buf[q + 2] === 0x08 && buf[q + 3] === 0x72) {
        nextQ = q + 4;
      } else if (buf[q] === 0x80 && buf[q + 1] === 0x7c && buf[q + 3] === 0x08 && buf[q + 4] === 0x72) {
        nextQ = q + 5;
      }
      if (nextQ < 0 || nextQ + 2 > fnEnd) continue;
      let tTarget = null;
      let tEnd = null;
      if (buf[nextQ] === 0x0f && buf[nextQ + 1] === 0x85 && nextQ + 6 <= fnEnd) {
        tTarget = nextQ + 6 + buf.readInt32LE(nextQ + 2);
        tEnd = nextQ + 6;
      } else if (buf[nextQ] === 0x75) {
        tTarget = nextQ + 2 + buf.readInt8(nextQ + 1);
        tEnd = nextQ + 2;
      }
      if (tTarget !== null && tTarget >= fnStart && tTarget < p) {
        loopTop = tTarget;
        tailEnd = tEnd;
        break;
      }
    }
    if (tailEnd === null || loopTop === null) continue;

    // Collect loop-exit conditional branches in the loop head region.
    const loopExits = [];
    const loopScanEnd = Math.min(p, loopTop + 0x48);
    for (let r = loopTop; r < loopScanEnd - 2; r++) {
      let dest = null;
      if (buf[r] === 0x0f && buf[r + 1] >= 0x80 && buf[r + 1] <= 0x8f && r + 6 <= fnEnd) {
        dest = r + 6 + buf.readInt32LE(r + 2);
      } else if (buf[r] >= 0x70 && buf[r] <= 0x7f) {
        dest = r + 2 + buf.readInt8(r + 1);
      }
      if (dest !== null && dest >= tailEnd && dest < fnEnd) {
        loopExits.push({ offset: r, dest });
      }
    }
    if (loopExits.length === 0) continue;

    // An immediate unconditional `jmp` right after the tail check means "match => break only".
    let immediateBreakTarget = null;
    if (tailEnd + 2 <= fnEnd && buf[tailEnd] === 0xeb) {
      immediateBreakTarget = tailEnd + 2 + buf.readInt8(tailEnd + 1);
    } else if (tailEnd + 5 <= fnEnd && buf[tailEnd] === 0xe9) {
      immediateBreakTarget = tailEnd + 5 + buf.readInt32LE(tailEnd + 1);
    }

    const isBreakOnly =
      immediateBreakTarget !== null && loopExits.some((e) => e.dest === immediateBreakTarget);
    const hasMatchBody =
      !isBreakOnly &&
      br.target === loopTop &&
      loopExits.some((e) => e.dest > tailEnd + 0x10);

    seenJOff.add(jOff);
    candidates.push({
      p,
      jOff,
      jLen: br.len,
      state: br.state,
      target: br.target,
      patched: br.patched,
      loopTop,
      tailEnd,
      hasMatchBody,
      isBreakOnly,
    });
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
      error: '未找到 x86-64 free-tier 地区限制分支',
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
      error: `在 ValidateAndOnboardAccount 中命中 ${ineligible.length} 处 x86-64 候选分支`,
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
  return {
    ok: true,
    arch: 'x86-64',
    status: hit.state,
    fnName,
    fnStart,
    fnEnd,
    cmpOffset: hit.p,
    branchOffset: hit.jOff,
    branchLength: hit.jLen,
    relOffsetInFn: hit.p - fnStart,
    targetOffset: hit.target,
    currentBytes: Buffer.from(buf.subarray(hit.jOff, hit.jOff + hit.jLen)),
    patchedBytes: hit.patched,
    allowedTiersCount: allowed.length,
    hasFreeTieConst,
  };
}

/**
 * Normalize an architecture label to the two internal engine names.
 * @param {string} arch
 * @returns {'arm64'|'x86-64'}
 */
function normalizeRegionArch(arch) {
  const a = String(arch || '').toLowerCase().replace(/[_\s]/g, '-');
  if (a === 'arm64' || a === 'aarch64' || a === 'arm64e') return 'arm64';
  return 'x86-64';
}

/**
 * Dispatch the adaptive region analyzer by architecture.
 * @param {Buffer} buf
 * @param {number} fnStart
 * @param {number} fnEnd
 * @param {string} fnName
 * @param {string} arch
 */
function analyzeRegionInRangeByArch(buf, fnStart, fnEnd, fnName, arch) {
  return normalizeRegionArch(arch) === 'arm64'
    ? analyzeArm64RegionInRange(buf, fnStart, fnEnd, fnName)
    : analyzeX64RegionInRange(buf, fnStart, fnEnd, fnName);
}

module.exports = {
  sha256Buffer,
  signExtend,
  readCString,
  decodeArm64BneTarget,
  decodeArm64CondBranchTarget,
  decodeArm64UncondBranchTarget,
  scanGopclntabBySuffix,
  FREE_TIE_BYTES,
  decodeX64JneOrJmp,
  analyzeArm64RegionInRange,
  analyzeX64RegionInRange,
  normalizeRegionArch,
  analyzeRegionInRangeByArch,
};

