'use strict';
/**
 * Remote SSH Integration Engine for 哈基米.app
 * - Adaptive Linux ELF64 (x86-64 & arm64) Region Unlock + Context Window Unlock (Gate 3A / 3B)
 * - Bootstrap script decorator for dist/remote/bootstrapScript.js (auto-patches remote language_server)
 * - In-memory SSH remote session registry & Electron session-routed Connect RPC transport
 *
 * Strictly read-only toward official Antigravity.app; zero System Prompt modifications.
 */

const fs = require('fs');
const path = require('path');
const {
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
  scanGopclntabBySuffix,
  analyzeArm64RegionInRange,
} = require('./binary-utils');

const TARGET_REGION_FUNC = 'authclient.ValidateAndOnboardAccount';
const TARGET_CHECKPOINT_FUNC = 'utils.GetCheckpointConfig';
const TARGET_EXP_FUNC = 'config.applyFeatureProviderCheckpointOverrideConfig';
const TARGET_SELECT_EXP_FUNC = 'config.selectCheckpointExperimentKey';

const DEFAULT_CHECKPOINT_TOKENS = 256000;
const MIN_LIMIT_TOKENS = 16384;
const MAX_LIMIT_TOKENS = 2097152;

const FREE_TIE_BYTES = Buffer.from('667265652d746965', 'hex'); // "free-tie" LE

// ============================================================================
// 1. Pure Node.js Linux ELF64 (x86-64 & arm64) Adaptive Analyzer & Patcher
// ============================================================================

function parseElf64(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error('目标文件过小，非有效 ELF64 可执行文件');
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('非 ELF 二进制文件');
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error(`仅支持 64-bit 小端 ELF (class=${buf[4]}, data=${buf[5]})`);
  }
  const eMachine = buf.readUInt16LE(18);
  const arch = eMachine === 62 ? 'x86-64' : eMachine === 183 ? 'arm64' : null;
  if (!arch) {
    throw new Error(`不支持的 ELF 架构 e_machine=${eMachine}`);
  }
  const eShoff = Number(buf.readBigUInt64LE(40));
  const eShentsize = buf.readUInt16LE(58);
  const eShnum = buf.readUInt16LE(60);
  const eShstrndx = buf.readUInt16LE(62);
  if (!eShoff || eShentsize < 64 || eShnum === 0 || eShstrndx >= eShnum) {
    throw new Error('ELF 缺少有效的 Section Header 表');
  }
  const shstrEntryOff = eShoff + eShstrndx * eShentsize;
  if (shstrEntryOff + 64 > buf.length) {
    throw new Error('ELF shstrtab 表项越界');
  }
  const shstrOff = Number(buf.readBigUInt64LE(shstrEntryOff + 24));
  const sections = [];
  const byName = Object.create(null);

  for (let i = 0; i < eShnum; i++) {
    const off = eShoff + i * eShentsize;
    if (off + 64 > buf.length) break;
    const shName = buf.readUInt32LE(off);
    const shType = buf.readUInt32LE(off + 4);
    const shAddr = Number(buf.readBigUInt64LE(off + 16));
    const shOffset = Number(buf.readBigUInt64LE(off + 24));
    const shSize = Number(buf.readBigUInt64LE(off + 32));
    const name = readCString(buf, shstrOff + shName, 256);
    const sec = { name, type: shType, addr: shAddr, offset: shOffset, size: shSize };
    sections.push(sec);
    if (name && !byName[name]) byName[name] = sec;
  }

  const textSec = byName['.text'];
  if (!textSec || textSec.size <= 0) {
    throw new Error('ELF 中未找到 .text 段');
  }

  return {
    format: 'ELF64',
    arch,
    textVA: textSec.addr,
    textOff: textSec.offset,
    textSize: textSec.size,
    relaDyn: byName['.rela.dyn'] || null,
    sections,
    byName,
  };
}

function fileOffToVA(elf, fileOff) {
  for (const sec of elf.sections) {
    if (sec.size > 0 && sec.addr > 0 && fileOff >= sec.offset && fileOff < sec.offset + sec.size) {
      return sec.addr + (fileOff - sec.offset);
    }
  }
  return fileOff;
}

function resolveElfGoTextBase(buf, elf, pclnOff, textStartFromHeader) {
  const { textVA, textOff, textSize } = elf;
  if (
    Number.isFinite(textStartFromHeader) &&
    textStartFromHeader >= textVA &&
    textStartFromHeader < textVA + textSize
  ) {
    return {
      goTextVA: textStartFromHeader,
      goTextOff: textOff + (textStartFromHeader - textVA),
      source: 'pclntab_header',
    };
  }

  // PIE Go ELF binaries leave pcHeader.textStart == 0 and store runtime.text via .rela.dyn in firstmoduledata
  if (elf.relaDyn && elf.relaDyn.size >= 24) {
    const pclnVA = fileOffToVA(elf, pclnOff);
    const needle = Buffer.alloc(8);
    needle.writeBigUInt64LE(BigInt(pclnVA), 0);
    const rOff = elf.relaDyn.offset;
    const rEnd = Math.min(buf.length, rOff + elf.relaDyn.size);

    let pos = rOff;
    while (pos < rEnd) {
      const hit = buf.indexOf(needle, pos);
      if (hit < 0 || hit >= rEnd) break;
      pos = hit + 8;
      if ((hit - rOff) % 24 !== 16) continue;
      const moddataVA = Number(buf.readBigUInt64LE(hit - 16));
      // Scan nearby .rela.dyn entries (and if needed, a quick bounded scan) for minpc/text in [moddataVA, moddataVA+0x160)
      const candidates = new Map();
      const scanRange = (start, end) => {
        for (let p = start; p + 24 <= end; p += 24) {
          const ro = Number(buf.readBigUInt64LE(p));
          if (ro >= moddataVA && ro < moddataVA + 0x160) {
            const ra = Number(buf.readBigInt64LE(p + 16));
            if (ra >= textVA && ra < textVA + textSize) {
              candidates.set(ra, (candidates.get(ra) || 0) + 1);
            }
          }
        }
      };
      // Check local window around hit first (sorted .rela.dyn hits in O(1))
      const winStart = Math.max(rOff, hit - 16 - 24 * 64);
      const winEnd = Math.min(rEnd, hit - 16 + 24 * 128);
      scanRange(winStart, winEnd);
      if (candidates.size === 0) {
        scanRange(rOff, rEnd);
      }
      if (candidates.size > 0) {
        // Prefer repeated addend (minpc + text both equal runtime.text), then smallest VA near .text start
        let bestVA = null;
        let bestCount = -1;
        for (const [va, cnt] of candidates.entries()) {
          if (cnt > bestCount || (cnt === bestCount && va < bestVA)) {
            bestVA = va;
            bestCount = cnt;
          }
        }
        return {
          goTextVA: bestVA,
          goTextOff: textOff + (bestVA - textVA),
          source: 'rela_firstmoduledata',
        };
      }
    }
  }

  return {
    goTextVA: textVA,
    goTextOff: textOff,
    source: 'text_section_start',
  };
}

function findElfGoFunctions(buf, elf, targetSuffixes) {
  const minLC = elf.arch === 'arm64' ? 0x04 : 0x01;
  return scanGopclntabBySuffix(buf, targetSuffixes, {
    minLC,
    resolveBase: (pclnOff, textStart) => resolveElfGoTextBase(buf, elf, pclnOff, textStart),
  });
}

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

function analyzeX64RegionInRange(buf, fnStart, fnEnd, fnName) {
  const hasFreeTieConst = buf.indexOf(FREE_TIE_BYTES, fnStart) >= fnStart && buf.indexOf(FREE_TIE_BYTES, fnStart) < fnEnd;
  const candidates = [];

  const seenJOff = new Set();

  for (let p = fnStart; p < fnEnd - 24; p++) {
    let cmpLen = 0;
    if ((buf[p] === 0x48 || buf[p] === 0x49) && buf[p + 1] === 0x83 && (buf[p + 2] & 0xf8) === 0xf8 && buf[p + 3] === 0x09) {
      cmpLen = 4;
    } else if (
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

    const afterBr = jOff + br.len;
    const freeIdx = buf.indexOf(FREE_TIE_BYTES, afterBr);
    if (freeIdx < 0 || freeIdx > afterBr + 16) continue;

    // Locate stage-3 tail check: cmp byte [reg+8], 0x72 ('r') followed immediately by backward jne
    // Encoding: [optional REX 0x41] 0x80 <modrm: 0x78..0x7f> 0x08 0x72  (or SIB [rsp/r12+8]: 0x7c 0x24 0x08 0x72)
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

    // Inspect loop-exit conditional branches inside [loopTop, min(p, loopTop + 0x48))
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

    // Distinguish allowedTiers (BREAK_ONLY) vs ineligibleTiers (HAS_MATCH_BODY):
    // In allowedTiers, tailEnd immediately executes `jmp <exitDest>` (0xeb or 0xe9) to one of loopExits.
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
    return { ok: false, status: 'pattern_missing', code: 'PATTERN_NOT_FOUND', fnName, hasFreeTieConst, allowedTiersCount: allowed.length, error: '未找到 x86-64 free-tier 地区限制分支' };
  }
  if (ineligible.length > 1) {
    return { ok: false, status: 'ambiguous', code: 'AMBIGUOUS_MATCH', fnName, error: `在 ValidateAndOnboardAccount 中命中 ${ineligible.length} 处 x86-64 候选分支` };
  }
  if (allowed.some((c) => c.state !== 'unpatched')) {
    return { ok: false, status: 'corrupted_allowed_tiers', code: 'ALLOWED_TIERS_MODIFIED', fnName, error: '检测到 allowedTiers 循环被意外修改' };
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
    targetOffset: hit.target,
    currentBytes: Buffer.from(buf.subarray(hit.jOff, hit.jOff + hit.jLen)),
    patchedBytes: hit.patched,
    allowedTiersCount: allowed.length,
    hasFreeTieConst,
  };
}

function analyzeElfRegionUnlock(filePathOrBuf) {
  const buf = Buffer.isBuffer(filePathOrBuf) ? filePathOrBuf : fs.readFileSync(String(filePathOrBuf));
  const sha256 = sha256Buffer(buf);
  let elf;
  try {
    elf = parseElf64(buf);
  } catch (e) {
    return { ok: false, status: 'unsupported', code: 'INVALID_ELF', sha256, error: e.message };
  }
  const goInfo = findElfGoFunctions(buf, elf, [TARGET_REGION_FUNC]);
  if (!goInfo.foundPcln) {
    return { ok: false, status: 'pclntab_missing', code: 'PCLNTAB_NOT_FOUND', sha256, error: '找不到 Go .gopclntab 符号表' };
  }
  const fn = goInfo.funcs[TARGET_REGION_FUNC];
  if (!fn) {
    return { ok: false, status: 'symbol_missing', code: 'SYMBOL_NOT_FOUND', sha256, error: `找不到 ${TARGET_REGION_FUNC}` };
  }
  const fnStart = Math.max(elf.textOff, fn.fnStart);
  const fnEnd = Math.min(buf.length, fn.fnEnd);
  if (fnEnd <= fnStart + 24) {
    return { ok: false, status: 'pattern_missing', code: 'FUNCTION_TOO_SMALL', fnName: fn.name, sha256, error: '函数体过短' };
  }
  const res =
    elf.arch === 'arm64'
      ? analyzeArm64RegionInRange(buf, fnStart, fnEnd, fn.name)
      : analyzeX64RegionInRange(buf, fnStart, fnEnd, fn.name);
  return { ...res, format: 'ELF64', goTextSource: goInfo.goTextSource, sha256 };
}

function analyzeElfGate3A(buf, fnStart, fnEnd, arch) {
  const body = buf.subarray(fnStart, fnEnd);
  if (arch === 'x86-64') {
    const clampHits = [];
    for (let rel = 0; rel <= body.length - 14; rel++) {
      if (body.subarray(rel, rel + 14).equals(CLAMP_256K_X64)) {
        clampHits.push({ status: 'unpatched', mode: 'default', limitTokens: DEFAULT_CHECKPOINT_TOKENS, offset: fnStart + rel });
      } else if (body.subarray(rel, rel + 14).equals(PATCH_256K_X64)) {
        clampHits.push({ status: 'patched_dynamic', mode: 'dynamic', limitTokens: null, offset: fnStart + rel });
      } else if (body[rel] === 0xbe && body.subarray(rel + 5, rel + 14).every((b) => b === 0x90)) {
        const imm = body.readUInt32LE(rel + 1);
        if (imm >= MIN_LIMIT_TOKENS && imm <= MAX_LIMIT_TOKENS) {
          clampHits.push({ status: 'patched_fixed', mode: 'fixed', limitTokens: imm, offset: fnStart + rel });
        }
      }
    }
    if (clampHits.length !== 1) {
      return { ok: false, status: 'unknown', reason: `x86-64 Gate 3A clamp 命中数异常 (${clampHits.length})` };
    }
    const defHits = [];
    for (let rel = 2; rel <= body.length - 7; rel++) {
      if (
        body[rel] === 0xc7 &&
        body[rel + 1] === 0x40 &&
        body[rel + 2] === 0x0c &&
        body[rel - 2] >= 0x70 &&
        body[rel - 2] <= 0x7f &&
        body[rel - 1] === 0x07
      ) {
        const imm = body.readUInt32LE(rel + 3);
        if (imm >= MIN_LIMIT_TOKENS && imm <= MAX_LIMIT_TOKENS) {
          defHits.push({ offset: fnStart + rel, limitTokens: imm });
        }
      }
    }
    if (defHits.length > 1) {
      return { ok: false, status: 'unknown', reason: `x86-64 Gate 3A default 命中数异常 (${defHits.length})` };
    }
    return {
      ok: true,
      ...clampHits[0],
      length: 14,
      hasDefaultSite: defHits.length === 1,
      defaultOffset: defHits.length === 1 ? defHits[0].offset : null,
      defaultLimitTokens: defHits.length === 1 ? defHits[0].limitTokens : null,
    };
  }

  if (arch === 'arm64') {
    const clampHits = [];
    for (let rel = 0; rel <= body.length - 24; rel += 4) {
      if (body.subarray(rel, rel + 24).equals(CLAMP_256K_ARM64)) {
        clampHits.push({ status: 'unpatched', mode: 'default', limitTokens: DEFAULT_CHECKPOINT_TOKENS, offset: fnStart + rel });
      } else if (body.subarray(rel, rel + 24).equals(PATCH_256K_ARM64)) {
        clampHits.push({ status: 'patched_dynamic', mode: 'dynamic', limitTokens: null, offset: fnStart + rel });
      } else {
        const imm = decodeMovzMovkArm64(body, rel, 3);
        if (
          imm !== null &&
          imm >= MIN_LIMIT_TOKENS &&
          imm <= MAX_LIMIT_TOKENS &&
          body.subarray(rel + 8, rel + 12).equals(NOP_ARM64) &&
          body.subarray(rel + 12, rel + 16).equals(NOP_ARM64) &&
          body.subarray(rel + 16, rel + 20).equals(NOP_ARM64) &&
          body.subarray(rel + 20, rel + 24).equals(NOP_ARM64)
        ) {
          clampHits.push({ status: 'patched_fixed', mode: 'fixed', limitTokens: imm, offset: fnStart + rel });
        }
      }
    }
    if (clampHits.length !== 1) {
      return { ok: false, status: 'unknown', reason: `ARM64 Gate 3A clamp 命中数异常 (${clampHits.length})` };
    }
    const defHits = [];
    for (let rel = 8; rel <= body.length - 12; rel += 4) {
      if (
        body.subarray(rel - 8, rel).equals(DEF_GUARD_ARM64) &&
        body.subarray(rel + 8, rel + 12).equals(STR_W3_X0_0C_ARM64)
      ) {
        const imm = decodeMovzMovkArm64(body, rel, 3);
        if (imm !== null && imm >= MIN_LIMIT_TOKENS && imm <= MAX_LIMIT_TOKENS) {
          defHits.push({ offset: fnStart + rel, limitTokens: imm });
        }
      }
    }
    if (defHits.length > 1) {
      return { ok: false, status: 'unknown', reason: `ARM64 Gate 3A default 命中数异常 (${defHits.length})` };
    }
    return {
      ok: true,
      ...clampHits[0],
      length: 24,
      hasDefaultSite: defHits.length === 1,
      defaultOffset: defHits.length === 1 ? defHits[0].offset : null,
      defaultLimitTokens: defHits.length === 1 ? defHits[0].limitTokens : null,
    };
  }

  return { ok: false, status: 'unknown', reason: `不支持架构: ${arch}` };
}

function analyzeElfGate3B(buf, fnExp, fnSelect, arch) {
  if (!fnExp || !fnSelect) {
    return { ok: false, status: 'unknown', reason: '缺少 Gate 3B 符号' };
  }
  const fnStart = fnExp.fnStart;
  const fnEnd = Math.min(buf.length, fnExp.fnEnd);
  const body = buf.subarray(fnStart, fnEnd);

  if (arch === 'x86-64') {
    const hits = [];
    for (let rel = 0; rel < body.length - 12; rel++) {
      if (body[rel] !== 0xe8) continue;
      const disp = body.readInt32LE(rel + 1);
      if (fnExp.fnVA + rel + 5 + disp !== fnSelect.fnVA) continue;
      const win = body.subarray(rel + 5, Math.min(body.length, rel + 105));
      const tIdx = win.indexOf(Buffer.from([0x84, 0xc0]));
      if (tIdx < 0) continue;
      const jOff = rel + 5 + tIdx + 2;
      if (jOff + 2 > body.length) continue;
      const b1 = body[jOff];
      const b2 = body[jOff + 1];
      if (b1 === 0x75) {
        hits.push({ status: 'unpatched', offset: fnStart + jOff, length: 2, origHex: Buffer.from([b1, b2]).toString('hex') });
      } else if (b1 === 0x0f && b2 === 0x85 && jOff + 6 <= body.length) {
        hits.push({ status: 'unpatched', offset: fnStart + jOff, length: 6, origHex: Buffer.from(body.subarray(jOff, jOff + 6)).toString('hex') });
      } else if (b1 === 0x90 && b2 === 0x90) {
        const len = jOff + 6 <= body.length && body.subarray(jOff, jOff + 6).every((b) => b === 0x90) ? 6 : 2;
        hits.push({ status: 'patched', offset: fnStart + jOff, length: len });
      }
    }
    if (hits.length !== 1) return { ok: false, status: 'unknown', reason: `x86-64 Gate 3B 命中数异常 (${hits.length})` };
    return { ok: true, ...hits[0] };
  }

  if (arch === 'arm64') {
    const hits = [];
    for (let rel = 0; rel <= body.length - 8; rel += 4) {
      const w = body.readUInt32LE(rel);
      if (((w & 0xfc000000) >>> 0) !== 0x94000000) continue;
      const imm26 = signExtend(w & 0x03ffffff, 26);
      if (fnExp.entryOff + rel + imm26 * 4 !== fnSelect.entryOff) continue;
      for (let d = 4; d <= 52 && rel + d + 4 <= body.length; d += 4) {
        const w2 = body.readUInt32LE(rel + d);
        if (((w2 & 0xfffffc1f) >>> 0) !== 0xd63f0000) continue;
        const jOff = rel + d + 4;
        const wNext = body.readUInt32LE(jOff);
        if (((wNext & 0xfff8001f) >>> 0) === 0x37000000 || ((wNext & 0xff00001f) >>> 0) === 0x35000000) {
          hits.push({ status: 'unpatched', offset: fnStart + jOff, length: 4, origHex: Buffer.from(body.subarray(jOff, jOff + 4)).toString('hex') });
        } else if (wNext === 0xd503201f) {
          hits.push({ status: 'patched', offset: fnStart + jOff, length: 4 });
        }
        break;
      }
    }
    if (hits.length !== 1) return { ok: false, status: 'unknown', reason: `ARM64 Gate 3B 命中数异常 (${hits.length})` };
    return { ok: true, ...hits[0] };
  }

  return { ok: false, status: 'unknown', reason: `不支持架构: ${arch}` };
}

function analyzeElfContextUnlock(filePathOrBuf) {
  const buf = Buffer.isBuffer(filePathOrBuf) ? filePathOrBuf : fs.readFileSync(String(filePathOrBuf));
  let elf;
  try {
    elf = parseElf64(buf);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const goInfo = findElfGoFunctions(buf, elf, [
    TARGET_CHECKPOINT_FUNC,
    TARGET_EXP_FUNC,
    TARGET_SELECT_EXP_FUNC,
  ]);
  if (!goInfo.foundPcln) {
    return { ok: false, error: '找不到 Go .gopclntab 符号表' };
  }
  const fnCk = goInfo.funcs[TARGET_CHECKPOINT_FUNC];
  const fnExp = goInfo.funcs[TARGET_EXP_FUNC];
  const fnSel = goInfo.funcs[TARGET_SELECT_EXP_FUNC];
  if (!fnCk) {
    return { ok: false, error: `找不到 ${TARGET_CHECKPOINT_FUNC}` };
  }
  const gate3a = analyzeElfGate3A(buf, fnCk.fnStart, Math.min(buf.length, fnCk.fnEnd), elf.arch);
  const gate3b = analyzeElfGate3B(buf, fnExp, fnSel, elf.arch);
  return {
    ok: gate3a.ok,
    format: 'ELF64',
    arch: elf.arch,
    goTextSource: goInfo.goTextSource,
    gate3a,
    gate3b,
  };
}

function normalizeContextSpec(opts = {}) {
  const rawMode = String(opts.mode || 'dynamic').trim().toLowerCase();
  const mode = rawMode === 'fixed' || rawMode === 'default' ? rawMode : 'dynamic';
  let limitTokens = 0;
  if (mode === 'fixed') {
    const n = Number(opts.limitTokens);
    if (!Number.isSafeInteger(n) || n < MIN_LIMIT_TOKENS || n > MAX_LIMIT_TOKENS) {
      throw new Error(`无效固定上下文上限: ${opts.limitTokens}`);
    }
    limitTokens = n;
  }
  return { mode, limitTokens };
}

function patchElfBuffer(inputBuf, options = {}) {
  const buf = Buffer.from(inputBuf);
  const applyRegion = options.region !== false;
  const applyContext = options.context !== false;
  const ctxSpec = applyContext ? normalizeContextSpec(options) : null;

  let regionResult = null;
  let contextResult = null;
  let modified = false;

  if (applyRegion) {
    const reg = analyzeElfRegionUnlock(buf);
    regionResult = reg;
    if (reg.ok && reg.status === 'unpatched') {
      reg.patchedBytes.copy(buf, reg.branchOffset);
      regionResult = { ...reg, status: 'patched', changed: true };
      modified = true;
    } else if (reg.ok) {
      regionResult = { ...reg, changed: false };
    }
  }

  let savedGate3bOrigHex = options.origGate3bHex || null;
  if (applyContext) {
    const ctx = analyzeElfContextUnlock(buf);
    contextResult = ctx;
    if (ctx.ok && ctx.gate3a.ok) {
      const { arch, gate3a, gate3b } = ctx;
      if (gate3b.ok && gate3b.status === 'unpatched' && gate3b.origHex) {
        savedGate3bOrigHex = gate3b.origHex;
      }

      const writeSlice = (offset, bytes) => {
        if (!buf.subarray(offset, offset + bytes.length).equals(bytes)) {
          bytes.copy(buf, offset);
          modified = true;
        }
      };

      if (arch === 'x86-64') {
        if (ctxSpec.mode === 'default') {
          writeSlice(gate3a.offset, CLAMP_256K_X64);
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, DEF_ORIG_X64);
          if (gate3b.ok && gate3b.status === 'patched' && savedGate3bOrigHex) {
            const orig = Buffer.from(savedGate3bOrigHex, 'hex');
            if (orig.length === gate3b.length) writeSlice(gate3b.offset, orig);
          }
        } else if (ctxSpec.mode === 'fixed') {
          writeSlice(gate3a.offset, buildClampConstX64(ctxSpec.limitTokens));
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, buildDefConstX64(ctxSpec.limitTokens));
          if (gate3b.ok && gate3b.status === 'unpatched') writeSlice(gate3b.offset, Buffer.alloc(gate3b.length, 0x90));
        } else {
          writeSlice(gate3a.offset, PATCH_256K_X64);
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, DEF_ORIG_X64);
          if (gate3b.ok && gate3b.status === 'unpatched') writeSlice(gate3b.offset, Buffer.alloc(gate3b.length, 0x90));
        }
      } else if (arch === 'arm64') {
        if (ctxSpec.mode === 'default') {
          writeSlice(gate3a.offset, CLAMP_256K_ARM64);
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, DEF_ORIG_ARM64);
          if (gate3b.ok && gate3b.status === 'patched' && savedGate3bOrigHex) {
            const orig = Buffer.from(savedGate3bOrigHex, 'hex');
            if (orig.length === 4) writeSlice(gate3b.offset, orig);
          }
        } else if (ctxSpec.mode === 'fixed') {
          writeSlice(gate3a.offset, buildClampConstArm64(ctxSpec.limitTokens));
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, buildDefConstArm64(ctxSpec.limitTokens));
          if (gate3b.ok && gate3b.status === 'unpatched') writeSlice(gate3b.offset, NOP_ARM64);
        } else {
          writeSlice(gate3a.offset, PATCH_256K_ARM64);
          if (gate3a.hasDefaultSite) writeSlice(gate3a.defaultOffset, DEF_ORIG_ARM64);
          if (gate3b.ok && gate3b.status === 'unpatched') writeSlice(gate3b.offset, NOP_ARM64);
        }
      }
      contextResult = { ...ctx, configuredMode: ctxSpec.mode, configuredLimitTokens: ctxSpec.limitTokens, origGate3bHex: savedGate3bOrigHex };
    }
  }

  return {
    ok: (!applyRegion || Boolean(regionResult?.ok)) && (!applyContext || Boolean(contextResult?.ok)),
    modified,
    buffer: buf,
    region: regionResult,
    context: contextResult,
    origGate3bHex: savedGate3bOrigHex,
  };
}

function patchElfBinaryFile(filePath, options = {}) {
  const target = path.resolve(String(filePath || ''));
  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: `找不到目标 ELF 文件: ${filePath}` };
  }
  const metaPath = `${target}.hakimi_meta.json`;
  let prevMeta = {};
  try {
    if (fs.existsSync(metaPath)) prevMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
  } catch {}

  const input = fs.readFileSync(target);
  const res = patchElfBuffer(input, { ...options, origGate3bHex: options.origGate3bHex || prevMeta.gate3bOrigHex || null });
  if (res.modified) {
    const tmpPath = `${target}.hakimi_tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, res.buffer);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, target);
  }
  if (res.origGate3bHex && res.origGate3bHex !== prevMeta.gate3bOrigHex) {
    try {
      fs.writeFileSync(metaPath, JSON.stringify({ ...prevMeta, gate3bOrigHex: res.origGate3bHex }, null, 2), 'utf8');
    } catch {}
  }
  return {
    ok: res.ok,
    modified: res.modified,
    region: res.region,
    context: res.context,
    origGate3bHex: res.origGate3bHex,
  };
}

// ============================================================================
// 2. Embedded Self-Contained Python3 Remote ELF64 Patcher & Bootstrap Decorator
// ============================================================================

function getRemotePythonPatcherSource() {
  return `import json, os, struct, sys

CLAMP_X64 = bytes.fromhex("81fa00e80300be00e803000f42f2")
DYN_X64 = bytes.fromhex("89d6") + b"\\x90" * 12
DEF_ORIG_X64 = bytes.fromhex("c7400c00e80300")
FREE_TIE = bytes.fromhex("667265652d746965")

NOP_A64 = bytes.fromhex("1f2003d5")
DYN_A64 = NOP_A64 * 6
CLAMP_A64 = bytes.fromhex("04009dd26400a0f27f00046b04009dd26400a0f26330849a")
DEF_ORIG_A64 = bytes.fromhex("03009dd26300a0f2030c00b9")
DEF_GUARD_A64 = bytes.fromhex("7f0000718c000054")
STR_W3_A64 = bytes.fromhex("030c00b9")

MIN_LIM = 16384
MAX_LIM = 2097152

def sxt(v, bits):
    m = 1 << (bits - 1)
    return (v & (m - 1)) - (v & m)

def cstr(b, off, lim=2048):
    if off < 0 or off >= len(b):
        return ""
    e = b.find(b"\\x00", off, min(len(b), off + lim))
    if e < 0:
        e = min(len(b), off + lim)
    return b[off:e].decode("utf-8", "replace")

def enc_mov_a64(reg, val):
    lo = val & 0xffff
    hi = (val >> 16) & 0xffff
    rd = reg & 0x1f
    return struct.pack("<II", (0xd2800000 | (lo << 5) | rd) & 0xffffffff, (0xf2a00000 | (hi << 5) | rd) & 0xffffffff)

def dec_mov_a64(b, off, reg):
    if off < 0 or off + 8 > len(b):
        return None
    w0, w1 = struct.unpack_from("<II", b, off)
    rd = reg & 0x1f
    if (w0 & 0xffe0001f) != (0xd2800000 | rd) or (w1 & 0xffe0001f) != (0xf2a00000 | rd):
        return None
    return (((w1 >> 5) & 0xffff) << 16) | ((w0 >> 5) & 0xffff)

def parse_elf64(b):
    if len(b) < 64 or b[:4] != b"\\x7fELF" or b[4] != 2 or b[5] != 1:
        raise RuntimeError("not ELF64 LE")
    em = struct.unpack_from("<H", b, 18)[0]
    arch = "x86-64" if em == 62 else ("arm64" if em == 183 else None)
    if not arch:
        raise RuntimeError(f"unsupported arch {em}")
    shoff = struct.unpack_from("<Q", b, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", b, 58)
    shstr_off = struct.unpack_from("<Q", b, shoff + shstrndx * shentsize + 24)[0]
    secs = []
    by_name = {}
    for idx in range(shnum):
        o = shoff + idx * shentsize
        if o + 64 > len(b):
            break
        sn, st, sf, sa, so, ss = struct.unpack_from("<IIQQQQ", b, o)
        nm = cstr(b, shstr_off + sn, 256)
        sec = (nm, sa, so, ss)
        secs.append(sec)
        if nm and nm not in by_name:
            by_name[nm] = sec
    if ".text" not in by_name:
        raise RuntimeError("missing .text")
    return arch, by_name[".text"], by_name.get(".rela.dyn"), secs

def find_go_funcs(b, arch, text_sec, rela_sec, secs, targets):
    _, tva, toff, tsz = text_sec
    minlc = 4 if arch == "arm64" else 1
    for mg in (bytes([0xf1, 0xff, 0xff, 0xff, 0, 0, minlc, 8]), bytes([0xf0, 0xff, 0xff, 0xff, 0, 0, minlc, 8])):
        pos = 0
        while True:
            i = b.find(mg, pos)
            if i < 0:
                break
            pos = i + 4
            if i + 72 > len(b):
                continue
            nfunc = struct.unpack_from("<Q", b, i + 8)[0]
            tstart = struct.unpack_from("<Q", b, i + 24)[0]
            fn_off = struct.unpack_from("<Q", b, i + 32)[0]
            pcln_off = struct.unpack_from("<Q", b, i + 64)[0]
            if not (1 <= nfunc < 500000):
                continue
            ft = i + pcln_off
            fnm = i + fn_off
            if pcln_off <= 0 or fn_off <= 0 or ft + (nfunc + 1) * 8 > len(b) or fnm >= len(b):
                continue
            go_tva = tva
            if tva <= tstart < tva + tsz:
                go_tva = tstart
            elif rela_sec and rela_sec[3] >= 24:
                pcln_va = i
                for _, sa, so, ss in secs:
                    if ss > 0 and sa > 0 and so <= i < so + ss:
                        pcln_va = sa + (i - so)
                        break
                _, _, roff, rsz = rela_sec
                rend = min(len(b), roff + rsz)
                ndl = struct.pack("<Q", pcln_va)
                p = roff
                found_va = None
                while p < rend:
                    hit = b.find(ndl, p, rend)
                    if hit < 0:
                        break
                    p = hit + 8
                    if (hit - roff) % 24 != 16:
                        continue
                    mva = struct.unpack_from("<Q", b, hit - 16)[0]
                    cands = {}
                    def scan_r(s, e):
                        for q in range(s, e - 23, 24):
                            ro, _, ra = struct.unpack_from("<QQq", b, q)
                            if mva <= ro < mva + 0x160 and tva <= ra < tva + tsz:
                                cands[ra] = cands.get(ra, 0) + 1
                    scan_r(max(roff, hit - 16 - 24 * 64), min(rend, hit - 16 + 24 * 128))
                    if not cands:
                        scan_r(roff, rend)
                    if cands:
                        found_va = sorted(cands.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                        break
                if found_va is not None:
                    go_tva = found_va
            go_toff = toff + (go_tva - tva)
            found = {}
            for k in range(nfunc):
                eo, fo = struct.unpack_from("<II", b, ft + k * 8)
                frec = ft + fo
                if frec + 8 > len(b):
                    continue
                no = struct.unpack_from("<i", b, frec + 4)[0]
                if no < 0 or fnm + no >= len(b):
                    continue
                nm = cstr(b, fnm + no)
                for suf in targets:
                    if suf not in found and (nm == suf or nm.endswith("/" + suf) or nm.endswith("." + suf)):
                        neo = struct.unpack_from("<I", b, ft + (k + 1) * 8)[0]
                        found[suf] = (nm, eo, neo, go_toff + eo, go_toff + neo, go_tva + eo)
            return found
    return None

def analyze_region_x64(b, fn_s, fn_e):
    cands = []
    seen = set()
    for p in range(fn_s, fn_e - 24):
        if (b[p] in (0x48, 0x49)) and b[p+1] == 0x83 and (b[p+2] & 0xf8) == 0xf8 and b[p+3] == 0x09:
            clen = 4
        elif b[p] == 0x83 and (b[p+1] & 0xf8) == 0xf8 and b[p+2] == 0x09 and not (p > fn_s and b[p-1] in (0x48, 0x49)):
            clen = 3
        else:
            continue
        jo = p + clen
        if jo in seen or jo + 2 > fn_e:
            continue
        b0, b1 = b[jo], b[jo+1]
        if b0 == 0x0f and b1 == 0x85 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "unpatched", jo + 6 + r32, b"\\x90\\xe9" + b[jo+2:jo+6]
        elif b0 == 0x90 and b1 == 0xe9 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 6 + r32, bytes(b[jo:jo+6])
        elif b0 == 0xe9 and jo + 6 <= fn_e and b[jo+5] == 0x90:
            r32 = struct.unpack_from("<i", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 5 + r32, bytes(b[jo:jo+6])
        elif b0 == 0x75:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "unpatched", jo + 2 + r8, bytes([0xeb, b[jo+1]])
        elif b0 == 0xeb:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "patched", jo + 2 + r8, bytes(b[jo:jo+2])
        else:
            continue
        fi = b.find(FREE_TIE, jo + jlen, min(fn_e, jo + jlen + 24))
        if fi < 0:
            continue
        tail_end, ltop = None, None
        for q in range(fi + 8, min(fn_e - 6, fi + 0x30)):
            nq = -1
            if b[q] == 0x80 and (b[q+1] & 0xf8) == 0x78 and b[q+2] == 0x08 and b[q+3] == 0x72:
                nq = q + 4
            elif b[q] == 0x80 and b[q+1] == 0x7c and b[q+3] == 0x08 and b[q+4] == 0x72:
                nq = q + 5
            if nq < 0 or nq + 2 > fn_e:
                continue
            tt, te = None, None
            if b[nq] == 0x0f and b[nq+1] == 0x85 and nq + 6 <= fn_e:
                tt = nq + 6 + struct.unpack_from("<i", b, nq + 2)[0]
                te = nq + 6
            elif b[nq] == 0x75:
                tt = nq + 2 + struct.unpack_from("<b", b, nq + 1)[0]
                te = nq + 2
            if tt is not None and fn_s <= tt < p:
                ltop, tail_end = tt, te
                break
        if tail_end is None:
            continue
        exits = []
        for r in range(ltop, min(p, ltop + 0x48) - 2):
            d = None
            if b[r] == 0x0f and 0x80 <= b[r+1] <= 0x8f and r + 6 <= fn_e:
                d = r + 6 + struct.unpack_from("<i", b, r + 2)[0]
            elif 0x70 <= b[r] <= 0x7f:
                d = r + 2 + struct.unpack_from("<b", b, r + 1)[0]
            if d is not None and tail_end <= d < fn_e:
                exits.append(d)
        if not exits:
            continue
        imm_brk = None
        if tail_end + 2 <= fn_e and b[tail_end] == 0xeb:
            imm_brk = tail_end + 2 + struct.unpack_from("<b", b, tail_end + 1)[0]
        elif tail_end + 5 <= fn_e and b[tail_end] == 0xe9:
            imm_brk = tail_end + 5 + struct.unpack_from("<i", b, tail_end + 1)[0]
        is_brk = imm_brk is not None and imm_brk in exits
        has_body = (not is_brk) and tgt == ltop and any(d > tail_end + 0x10 for d in exits)
        seen.add(jo)
        cands.append((jo, st, pbytes, has_body, is_brk))
    inel = [c for c in cands if c[3]]
    alw = [c for c in cands if c[4] and not c[3]]
    if len(inel) != 1 or any(c[1] != "unpatched" for c in alw):
        return None
    return inel[0][0], inel[0][1], inel[0][2]

def analyze_region_a64(b, fn_s, fn_e):
    def dec_bne(w, o):
        return o + sxt((w >> 5) & 0x7ffff, 19) * 4 if (w & 0xff00001f) == 0x54000001 else None
    def dec_cb(w, o):
        return o + sxt((w >> 5) & 0x7ffff, 19) * 4 if (w & 0xff000010) == 0x54000000 else None
    def dec_b(w, o):
        return o + sxt(w & 0x03ffffff, 26) * 4 if (w & 0xfc000000) == 0x14000000 else None
    cands = []
    for p in range(fn_s, fn_e - 20, 4):
        w0, w1 = struct.unpack_from("<II", b, p)
        if (w0 & 0x7ffffc1f) != 0x7100241f:
            continue
        T = dec_bne(w1, p + 4)
        st = "unpatched" if T is not None else None
        if T is None:
            T = dec_b(w1, p + 4)
            if T is not None:
                st = "patched"
        if T is None or not (fn_s <= T < p):
            continue
        te, inter = None, 0
        for q in range(p + 8, min(fn_e - 8, p + 0x48) + 1, 4):
            wq0, wq1 = struct.unpack_from("<II", b, q)
            if (wq0 & 0x7ffffc1f) == 0x7101c81f and dec_bne(wq1, q + 4) == T:
                te = q + 8
                break
            if dec_bne(wq0, q) == T:
                inter += 1
        if te is None or inter < 1:
            continue
        exits = []
        for r in range(T, min(p, T + 0x30), 4):
            d = dec_cb(struct.unpack_from("<I", b, r)[0], r)
            if d is not None and d >= te:
                exits.append(d)
        if not exits:
            continue
        has_body = any(d > te for d in exits)
        is_brk = all(d == te for d in exits)
        cands.append((p + 4, st, T, has_body, is_brk))
    inel = [c for c in cands if c[3]]
    alw = [c for c in cands if c[4] and not c[3]]
    if len(inel) != 1 or any(c[1] != "unpatched" for c in alw):
        return None
    bo, st, T = inel[0][0], inel[0][1], inel[0][2]
    off26 = (T - bo) // 4
    pbytes = struct.pack("<I", (0x14000000 | (off26 & 0x03ffffff)) & 0xffffffff)
    return bo, st, pbytes

def patch_context(b, arch, fn_ck, fn_exp, fn_sel, mode, lim, orig3b_hex):
    changed = False
    saved3b = orig3b_hex
    ck_s, ck_e = fn_ck[3], min(len(b), fn_ck[4])
    body = b[ck_s:ck_e]
    def put(off, data):
        nonlocal changed
        if bytes(b[off:off+len(data)]) != data:
            b[off:off+len(data)] = data
            changed = True
    if arch == "x86-64":
        ch = []
        for r in range(0, len(body) - 13):
            s = bytes(body[r:r+14])
            if s == CLAMP_X64 or s == DYN_X64 or (s[0] == 0xbe and s[5:] == b"\\x90" * 9 and MIN_LIM <= struct.unpack_from("<I", s, 1)[0] <= MAX_LIM):
                ch.append(ck_s + r)
        if len(ch) != 1:
            return False, changed, saved3b, f"g3a_clamp={len(ch)}"
        dh = []
        for r in range(2, len(body) - 6):
            if body[r] == 0xc7 and body[r+1] == 0x40 and body[r+2] == 0x0c and 0x70 <= body[r-2] <= 0x7f and body[r-1] == 0x07:
                imm = struct.unpack_from("<I", body, r + 3)[0]
                if MIN_LIM <= imm <= MAX_LIM:
                    dh.append(ck_s + r)
        if len(dh) > 1:
            return False, changed, saved3b, f"g3a_def={len(dh)}"
        g3b = None
        if fn_exp and fn_sel:
            es, ee, eva, sva = fn_exp[3], min(len(b), fn_exp[4]), fn_exp[5], fn_sel[5]
            eb = b[es:ee]
            gh = []
            for r in range(0, len(eb) - 12):
                if eb[r] != 0xe8:
                    continue
                if eva + r + 5 + struct.unpack_from("<i", eb, r + 1)[0] != sva:
                    continue
                ti = eb.find(b"\\x84\\xc0", r + 5, min(len(eb), r + 105))
                if ti < 0 or ti + 4 > len(eb):
                    continue
                jo = ti + 2
                if eb[jo] == 0x75:
                    gh.append(("unpatched", es + jo, 2, bytes(eb[jo:jo+2]).hex()))
                elif eb[jo] == 0x0f and eb[jo+1] == 0x85 and jo + 6 <= len(eb):
                    gh.append(("unpatched", es + jo, 6, bytes(eb[jo:jo+6]).hex()))
                elif eb[jo] == 0x90 and eb[jo+1] == 0x90:
                    ln = 6 if (jo + 6 <= len(eb) and bytes(eb[jo:jo+6]) == b"\\x90" * 6) else 2
                    gh.append(("patched", es + jo, ln, None))
            if len(gh) == 1:
                g3b = gh[0]
        if g3b and g3b[0] == "unpatched" and g3b[3]:
            saved3b = g3b[3]
        if mode == "default":
            put(ch[0], CLAMP_X64)
            if dh:
                put(dh[0], DEF_ORIG_X64)
            if g3b and g3b[0] == "patched" and saved3b:
                ob = bytes.fromhex(saved3b)
                if len(ob) == g3b[2]:
                    put(g3b[1], ob)
        elif mode == "fixed":
            put(ch[0], b"\\xbe" + struct.pack("<I", lim) + b"\\x90" * 9)
            if dh:
                put(dh[0], b"\\xc7\\x40\\x0c" + struct.pack("<I", lim))
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], b"\\x90" * g3b[2])
        else:
            put(ch[0], DYN_X64)
            if dh:
                put(dh[0], DEF_ORIG_X64)
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], b"\\x90" * g3b[2])
        return True, changed, saved3b, "ok"
    else:
        ch = []
        for r in range(0, len(body) - 23, 4):
            s = bytes(body[r:r+24])
            if s == CLAMP_A64 or s == DYN_A64:
                ch.append(ck_s + r)
            else:
                imm = dec_mov_a64(body, r, 3)
                if imm is not None and MIN_LIM <= imm <= MAX_LIM and s[8:] == NOP_A64 * 4:
                    ch.append(ck_s + r)
        if len(ch) != 1:
            return False, changed, saved3b, f"a64_clamp={len(ch)}"
        dh = []
        for r in range(8, len(body) - 11, 4):
            if bytes(body[r-8:r]) == DEF_GUARD_A64 and bytes(body[r+8:r+12]) == STR_W3_A64:
                imm = dec_mov_a64(body, r, 3)
                if imm is not None and MIN_LIM <= imm <= MAX_LIM:
                    dh.append(ck_s + r)
        if len(dh) > 1:
            return False, changed, saved3b, f"a64_def={len(dh)}"
        g3b = None
        if fn_exp and fn_sel:
            es, ee, eeo, seo = fn_exp[3], min(len(b), fn_exp[4]), fn_exp[1], fn_sel[1]
            eb = b[es:ee]
            gh = []
            for r in range(0, len(eb) - 7, 4):
                w = struct.unpack_from("<I", eb, r)[0]
                if (w & 0xfc000000) != 0x94000000:
                    continue
                if eeo + r + sxt(w & 0x03ffffff, 26) * 4 != seo:
                    continue
                for d in range(4, min(56, len(eb) - r - 4), 4):
                    w2 = struct.unpack_from("<I", eb, r + d)[0]
                    if (w2 & 0xfffffc1f) != 0xd63f0000:
                        continue
                    jo = r + d + 4
                    wn = struct.unpack_from("<I", eb, jo)[0]
                    if (wn & 0xfff8001f) == 0x37000000 or (wn & 0xff00001f) == 0x35000000:
                        gh.append(("unpatched", es + jo, 4, bytes(eb[jo:jo+4]).hex()))
                    elif wn == 0xd503201f:
                        gh.append(("patched", es + jo, 4, None))
                    break
            if len(gh) == 1:
                g3b = gh[0]
        if g3b and g3b[0] == "unpatched" and g3b[3]:
            saved3b = g3b[3]
        if mode == "default":
            put(ch[0], CLAMP_A64)
            if dh:
                put(dh[0], DEF_ORIG_A64)
            if g3b and g3b[0] == "patched" and saved3b:
                ob = bytes.fromhex(saved3b)
                if len(ob) == 4:
                    put(g3b[1], ob)
        elif mode == "fixed":
            put(ch[0], enc_mov_a64(3, lim) + NOP_A64 * 4)
            if dh:
                put(dh[0], enc_mov_a64(3, lim) + STR_W3_A64)
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], NOP_A64)
        else:
            put(ch[0], DYN_A64)
            if dh:
                put(dh[0], DEF_ORIG_A64)
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], NOP_A64)
        return True, changed, saved3b, "ok"

def main():
    args = sys.argv[1:]
    analyze_only = "--analyze" in args
    pos = [a for a in args if a != "--analyze"]
    bin_path = pos[0]
    mode = pos[1] if len(pos) > 1 else "dynamic"
    lim = int(pos[2]) if len(pos) > 2 else 0
    if mode == "fixed" and not (MIN_LIM <= lim <= MAX_LIM):
        raise RuntimeError(f"invalid limit {lim}")
    meta_path = bin_path + ".hakimi_meta.json"
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as mf:
                meta = json.load(mf) or {}
        except Exception:
            meta = {}
    with open(bin_path, "rb") as f:
        data = bytearray(f.read())
    arch, tsec, rsec, secs = parse_elf64(data)
    targets = [
        "authclient.ValidateAndOnboardAccount",
        "utils.GetCheckpointConfig",
        "config.applyFeatureProviderCheckpointOverrideConfig",
        "config.selectCheckpointExperimentKey",
    ]
    funcs = find_go_funcs(data, arch, tsec, rsec, secs, targets)
    if not funcs:
        raise RuntimeError("gopclntab not found")
    fn_reg = funcs.get(targets[0])
    fn_ck = funcs.get(targets[1])
    fn_exp = funcs.get(targets[2])
    fn_sel = funcs.get(targets[3])
    if not fn_reg:
        raise RuntimeError("ValidateAndOnboardAccount not found")
    reg_hit = analyze_region_a64(data, fn_reg[3], min(len(data), fn_reg[4])) if arch == "arm64" else analyze_region_x64(data, fn_reg[3], min(len(data), fn_reg[4]))
    if not reg_hit:
        raise RuntimeError("region free-tier branch not found")
    reg_off, reg_st, reg_bytes = reg_hit
    changed = False
    if not analyze_only and reg_st == "unpatched":
        data[reg_off:reg_off+len(reg_bytes)] = reg_bytes
        changed = True
    ctx_ok, ctx_changed, saved3b, ctx_msg = (False, False, meta.get("gate3bOrigHex"), "missing_symbol")
    if fn_ck:
        if analyze_only:
            tmp_copy = bytearray(data)
            ctx_ok, ctx_changed, saved3b, ctx_msg = patch_context(tmp_copy, arch, fn_ck, fn_exp, fn_sel, mode, lim, meta.get("gate3bOrigHex"))
        else:
            ctx_ok, ctx_changed, saved3b, ctx_msg = patch_context(data, arch, fn_ck, fn_exp, fn_sel, mode, lim, meta.get("gate3bOrigHex"))
            changed = changed or ctx_changed
    if not analyze_only:
        if changed:
            tmp_path = f"{bin_path}.hakimi_tmp.{os.getpid()}"
            with open(tmp_path, "wb") as tf:
                tf.write(data)
            os.chmod(tmp_path, 0o755)
            os.replace(tmp_path, bin_path)
        if saved3b and saved3b != meta.get("gate3bOrigHex"):
            meta["gate3bOrigHex"] = saved3b
            with open(meta_path, "w", encoding="utf-8") as mf:
                json.dump(meta, mf)
    print(json.dumps({
        "ok": True,
        "arch": arch,
        "analyzeOnly": analyze_only,
        "region": {"status": "patched" if (not analyze_only) else reg_st, "offset": hex(reg_off)},
        "context": {"ok": ctx_ok, "mode": mode, "limit": lim, "detail": ctx_msg},
        "changed": changed,
    }))

if __name__ == "__main__":
    main()
`;
}

function readDesiredSshContextConfig(options = {}) {
  let mode = 'dynamic';
  let limitTokens = 0;
  try {
    const contextUnlock = require('./meter-context-unlock');
    const backupDir = typeof contextUnlock.getUnlockBackupDir === 'function'
      ? contextUnlock.getUnlockBackupDir(options.backupDir)
      : null;
    if (backupDir) {
      const manifestPath = path.join(backupDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const cm = String(m?.configuredMode || '').trim().toLowerCase();
        if (cm === 'default') {
          mode = 'default';
          limitTokens = 0;
        } else if (cm === 'fixed') {
          const n = Number(m?.configuredLimitTokens);
          if (Number.isSafeInteger(n) && n >= MIN_LIMIT_TOKENS && n <= MAX_LIMIT_TOKENS) {
            mode = 'fixed';
            limitTokens = n;
          }
        } else if (cm === 'dynamic') {
          mode = 'dynamic';
          limitTokens = 0;
        }
      }
    }
  } catch {}
  return { mode, limitTokens };
}

function buildRemoteBootstrapHookShell(options = {}) {
  const ctx = options.mode
    ? normalizeContextSpec(options)
    : readDesiredSshContextConfig(options);
  const spec = `v1|region=1|ctx=${ctx.mode}:${ctx.limitTokens}`;
  const pyB64 = Buffer.from(getRemotePythonPatcherSource(), 'utf8').toString('base64');

  // POSIX sh compatible (dash/bash/ash), strict `set -u` safe, ZERO writes to stdout!
  return `
# --- Hakimi Remote SSH Auto-Unlock (Region + Context Window) ---
hakimi_want_spec='${spec}'
hakimi_ctx_mode='${ctx.mode}'
hakimi_ctx_limit='${ctx.limitTokens}'
hakimi_py_b64='${pyB64}'

hakimi_can_patch() {
  command -v python3 >/dev/null 2>&1
}

hakimi_stamp_matches() {
  hakimi_stf="$1.hakimi_stamp"
  [ -f "$hakimi_stf" ] || return 1
  hakimi_cur=$(cat "$hakimi_stf" 2>/dev/null) || return 1
  [ "$hakimi_cur" = "$hakimi_want_spec" ]
}

hakimi_skip_matches() {
  hakimi_skf="$1.hakimi_skip"
  [ -f "$hakimi_skf" ] || return 1
  hakimi_sk=$(cat "$hakimi_skf" 2>/dev/null) || return 1
  hakimi_sz=$(wc -c <"$1" 2>/dev/null | tr -d ' ') || hakimi_sz=0
  [ "$hakimi_sk" = "$hakimi_want_spec|$hakimi_sz" ]
}

hakimi_patch_bin() {
  hakimi_target=$1
  [ -z "\${agy_serverpath:-}" ] || return 0
  [ -f "$hakimi_target" ] || return 0
  if hakimi_stamp_matches "$hakimi_target"; then
    return 0
  fi
  if hakimi_skip_matches "$hakimi_target"; then
    return 0
  fi
  hakimi_log="\${agy_datadir:-/tmp}/hakimi-patch.log"
  mkdir -p "\${agy_datadir:-/tmp}" 2>/dev/null || true
  if ! hakimi_can_patch; then
    printf '[hakimi] python3 not found; skipping remote patch for %s\\n' "$hakimi_target" >>"$hakimi_log" 2>&1
    return 0
  fi
  hakimi_py_file="\${agy_bindir:-/tmp}/.hakimi_patch.$$.py"
  if printf '%s' "$hakimi_py_b64" | base64 -d >"$hakimi_py_file" 2>>"$hakimi_log" ||
     python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.argv[2]))' "$hakimi_py_file" "$hakimi_py_b64" 2>>"$hakimi_log"; then
    if python3 "$hakimi_py_file" "$hakimi_target" "$hakimi_ctx_mode" "$hakimi_ctx_limit" >>"$hakimi_log" 2>&1; then
      printf '%s\\n' "$hakimi_want_spec" >"$hakimi_target.hakimi_stamp" 2>/dev/null || true
      rm -f "$hakimi_target.hakimi_skip" 2>/dev/null || true
    else
      hakimi_sz=$(wc -c <"$hakimi_target" 2>/dev/null | tr -d ' ') || hakimi_sz=0
      printf '%s|%s\\n' "$hakimi_want_spec" "$hakimi_sz" >"$hakimi_target.hakimi_skip" 2>/dev/null || true
      printf '[hakimi] patch failed (non-fatal) for %s\\n' "$hakimi_target" >>"$hakimi_log" 2>&1
    fi
  fi
  rm -f "$hakimi_py_file" 2>/dev/null || true
  return 0
}

hakimi_maybe_replace_unpatched() {
  [ -z "\${agy_serverpath:-}" ] || return 0
  [ -z "\${agy_rep_pid:-}" ] || return 0
  [ "\${agy_attach_only:-0}" != 1 ] || return 0
  hakimi_can_patch || return 0
  agy_read_disc || return 0
  agy_is_ls_pid "$agy_dpid" || return 0
  hakimi_exe=$(readlink "/proc/$agy_dpid/exe" 2>/dev/null) || hakimi_exe=
  if [ "$hakimi_exe" = "$agy_bin" ] && hakimi_stamp_matches "$agy_bin"; then
    return 0
  fi
  if [ "$hakimi_exe" = "$agy_bin" ] && hakimi_skip_matches "$agy_bin"; then
    return 0
  fi
  # Running server is unpatched or uses an outdated Hakimi spec: trigger Antigravity's native locked replace flow
  agy_rep_pid=$agy_dpid
  agy_rep_ver=$agy_dver
}

agy_check_paths() {
  set -- "$agy_root" "$agy_root/bin" "$agy_datadir" "$agy_daemon" "$agy_disc"
  [ -n "$agy_serverpath" ] || set -- "$@" "$agy_bindir" "$agy_bin"
  for agy_f do
    [ -e "$agy_f" ] || continue
    [ -O "$agy_f" ] ||
      agy_fail INSTALL_FAILED "$agy_f is not owned by you"
  done
  hakimi_maybe_replace_unpatched || true
}

agy_prepare() {
  if [ -n "$agy_serverpath" ]; then
    agy_check_server_path
  else
    mkdir -p "$agy_bindir" 2>/dev/null ||
      agy_fail INSTALL_FAILED "cannot create $agy_bindir"
    agy_install
    hakimi_patch_bin "$agy_bin" || true
  fi
}
`;
}

function decorateBootstrapScript(script, options = {}) {
  if (typeof script !== 'string' || !script) return script;
  if (script.includes('hakimi_patch_bin()')) return script;
  const hookShell = buildRemoteBootstrapHookShell(options);
  const anchor = '\nagy_main; exit $?';
  const idx = script.lastIndexOf(anchor);
  if (idx >= 0) {
    return `${script.slice(0, idx)}\n${hookShell}${script.slice(idx)}`;
  }
  return `${script}\n${hookShell}`;
}

// ============================================================================
// 3. Runtime SSH Session Registry & Electron Session-Routed Connect RPC
// ============================================================================

const remoteSessions = new Map();

function normalizeHttpsLoopbackOrigin(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

function recordRemoteSession(entry, sshSession) {
  try {
    const hostId = entry?.hostId;
    if (!hostId || !sshSession) return null;
    const origin = normalizeHttpsLoopbackOrigin(sshSession.url);
    const csrfToken = String(sshSession?.discovery?.csrfToken || '').trim();
    const info = {
      hostId: String(hostId),
      label: String(entry?.label || hostId),
      origin,
      csrfToken,
      pid: Number(sshSession?.discovery?.pid || 0) || null,
      lsVersion: String(sshSession?.discovery?.lsVersion || ''),
      socksPort: Number(sshSession?.socksPort || 0) || null,
      updatedAt: Date.now(),
    };
    remoteSessions.set(String(hostId), info);
    return info;
  } catch {
    return null;
  }
}

function forgetRemoteSession(hostId) {
  if (!hostId) return false;
  return remoteSessions.delete(String(hostId));
}

function getRemoteSession(hostId) {
  if (!hostId) return null;
  return remoteSessions.get(String(hostId)) || null;
}

function getRemoteBackendForSender(sender) {
  if (!sender) return null;
  try {
    const wb = require('./remote/windowBackends');
    if (wb && typeof wb.remoteBackendOf === 'function') {
      const info = wb.remoteBackendOf(sender);
      if (info && info.kind === 'ssh' && info.hostId) return info;
    }
  } catch {}
  return null;
}

function getRemoteBackendForWindow(win) {
  if (!win) return null;
  try {
    const wb = require('./remote/windowBackends');
    if (wb && typeof wb.remoteBackendOfWindow === 'function') {
      const info = wb.remoteBackendOfWindow(win);
      if (info && info.kind === 'ssh' && info.hostId) return info;
    }
  } catch {}
  return null;
}

function createRemoteSessionRequester(sender, sessionInfo, expectedOrigin = null) {
  const ses = sender?.session;
  const origin = normalizeHttpsLoopbackOrigin(expectedOrigin || sessionInfo?.origin);
  const csrfToken = String(sessionInfo?.csrfToken || '').trim();

  if (!ses || typeof ses.fetch !== 'function') {
    throw new Error('SSH 窗口 Electron session 不可用，无法通过代理访问远端语言服务');
  }
  if (!origin) {
    throw new Error('SSH 远端语言服务地址无效');
  }
  if (!csrfToken) {
    throw new Error('SSH 远端 CSRF Token 尚未就绪，请等待连接完成或重连');
  }

  return {
    origin,
    hostId: sessionInfo?.hostId || null,
    label: sessionInfo?.label || null,
    csrfToken,
    call: async (method, body = {}) => {
      const url = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await ses.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
          redirect: 'manual',
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`SSH Remote API HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  TARGET_REGION_FUNC,
  TARGET_CHECKPOINT_FUNC,
  TARGET_EXP_FUNC,
  TARGET_SELECT_EXP_FUNC,
  CLAMP_256K_X64,
  PATCH_256K_X64,
  DEF_ORIG_X64,
  CLAMP_256K_ARM64,
  PATCH_256K_ARM64,
  DEF_ORIG_ARM64,
  DEF_GUARD_ARM64,
  NOP_ARM64,
  parseElf64,
  findElfGoFunctions,
  analyzeElfRegionUnlock,
  analyzeElfContextUnlock,
  patchElfBuffer,
  patchElfBinaryFile,
  getRemotePythonPatcherSource,
  readDesiredSshContextConfig,
  buildRemoteBootstrapHookShell,
  decorateBootstrapScript,
  recordRemoteSession,
  forgetRemoteSession,
  getRemoteSession,
  getRemoteBackendForSender,
  getRemoteBackendForWindow,
  createRemoteSessionRequester,
};
