'use strict';
/**
 * Context Window Unlock Engine (macOS Apple Silicon ARM64 + cross-arch reader)
 * Based on antigravity-context-viewer v0.8.3, ported to Mach-O ARM64 for 哈基米.app.
 * Strictly guards against touching /Applications/Antigravity.app or .orig, and
 * preserves Region Unlock (ValidateAndOnboardAccount) and Chinese Title patches.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const {
  getStateDir,
  getAppBundleRoot,
  getHakimiAppPath,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');

const PCLNTAB_MAGIC = 0xfffffff1;

const FUNC_OFFERS = 'model.SelectorModel.offersContextWindow';
const FUNC_STORE_CW = 'store.(*Store).ContextWindow';
const FUNC_STORE_CHOICE = 'store.(*Store).ContextWindowChoice';
const FUNC_CHECKPOINT = 'utils.GetCheckpointConfig';
const FUNC_EXP_CHECKPOINT = 'config.applyFeatureProviderCheckpointOverrideConfig';
const FUNC_SELECT_EXP_KEY = 'config.selectCheckpointExperimentKey';
const FUNC_OVERRIDE = 'store.AutoCompactOverride';

// Gate 3A / 3B ARM64 instructions (verified on Antigravity 2.32.1 language_server)
const NOP_ARM64 = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
const PATCH_256K_ARM64 = Buffer.concat([
  NOP_ARM64,
  NOP_ARM64,
  NOP_ARM64,
  NOP_ARM64,
  NOP_ARM64,
  NOP_ARM64,
]);
const CLAMP_256K_ARM64 = Buffer.from(
  '04009dd26400a0f27f00046b04009dd26400a0f26330849a',
  'hex'
);
const DEF_ORIG_ARM64 = Buffer.from('03009dd26300a0f2030c00b9', 'hex');
const DEF_GUARD_ARM64 = Buffer.from('7f0000718c000054', 'hex');
const STR_W3_X0_0C_ARM64 = Buffer.from('030c00b9', 'hex');

// x86-64 reference patterns (kept for inspection parity)
const CLAMP_256K_X64 = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
const PATCH_256K_X64 = Buffer.concat([Buffer.from('89d6', 'hex'), Buffer.alloc(12, 0x90)]);
const DEF_ORIG_X64 = Buffer.from('c7400c00e80300', 'hex');
const DEF_PREFIX_X64 = Buffer.from('c7400c', 'hex');
const SERIALIZER_STOCK_X64 = Buffer.from('4889442470488b8c24a80100008908b830000000', 'hex');
const SERIALIZER_HEAD_X64 = Buffer.from('4889442470c700', 'hex');
const SERIALIZER_TAIL_X64 = Buffer.from('90909090b830000000', 'hex');

const DEFAULT_CHECKPOINT_TOKENS = 256000;
const MIN_ENGINEERING_LIMIT = 16384;
const MAX_ENGINEERING_LIMIT = 2097152;
const MIN_OUTPUT_RESERVE_HINT = 40000;
const KNOWN_LIMIT_PRESETS = [256000, 512000, 524288, 768000, 900000, 983040, 1000000, 1048576];

const AUTHOR_INFO = {
  name: 'Linux.do @23375',
  credit: '解锁方案来源：原作者帖子 (Linux.do @23375)',
  url: 'https://linux.do/t/topic/3117832',
  disclaimer:
    '本功能为非官方本地技术修补，仅作用于 哈基米.app 副本；账号风险未知，无法承诺“不会封号”。',
};

const DEFAULT_LS_ENTITLEMENTS_PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>' +
  '<key>com.apple.security.cs.allow-jit</key><true/>' +
  '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>' +
  '<key>com.apple.security.cs.disable-library-validation</key><true/>' +
  '</dict></plist>\n';

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

function buildSerializerConstX64(limitTokens) {
  const out = Buffer.alloc(20);
  SERIALIZER_HEAD_X64.copy(out, 0);
  out.writeUInt32LE(limitTokens >>> 0, 7);
  SERIALIZER_TAIL_X64.copy(out, 11);
  return out;
}

function validateContextLimit(rawInput, options = {}) {
  let num = null;
  if (typeof rawInput === 'number') {
    if (!Number.isSafeInteger(rawInput) || rawInput <= 0) {
      return {
        ok: false,
        error: '上下文长度必须为正安全整数（tokens）',
        min: MIN_ENGINEERING_LIMIT,
        max: MAX_ENGINEERING_LIMIT,
      };
    }
    num = rawInput;
  } else if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(trimmed)) {
      return {
        ok: false,
        error: '上下文长度必须为纯正整数（tokens），不可包含小数或非数字字符',
        min: MIN_ENGINEERING_LIMIT,
        max: MAX_ENGINEERING_LIMIT,
      };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return {
        ok: false,
        error: '上下文长度超出安全整数范围',
        min: MIN_ENGINEERING_LIMIT,
        max: MAX_ENGINEERING_LIMIT,
      };
    }
    num = parsed;
  } else {
    return {
      ok: false,
      error: '无效的上下文长度输入类型',
      min: MIN_ENGINEERING_LIMIT,
      max: MAX_ENGINEERING_LIMIT,
    };
  }

  if (num < MIN_ENGINEERING_LIMIT || num > MAX_ENGINEERING_LIMIT) {
    return {
      ok: false,
      error: `上下文长度超出工程可写范围 (${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens)`,
      min: MIN_ENGINEERING_LIMIT,
      max: MAX_ENGINEERING_LIMIT,
    };
  }

  const warnings = [];
  if (num < 65536) {
    warnings.push(
      `目标值 (${num.toLocaleString('en-US')}) 较小，扣除至少 ${MIN_OUTPUT_RESERVE_HINT.toLocaleString('en-US')} tokens 输出预留与系统提示词后可用历史空间非常有限。`
    );
  }
  const serviceLimit = Number(options.serviceLimit || 0);
  if (serviceLimit > 0 && num > serviceLimit) {
    warnings.push(
      `目标值 (${num.toLocaleString('en-US')}) 高于当前观测到的服务端限制 (${serviceLimit.toLocaleString('en-US')})，实际长请求仍可能被服务端拒绝。`
    );
  }

  return {
    ok: true,
    limitTokens: num,
    warnings,
    min: MIN_ENGINEERING_LIMIT,
    max: MAX_ENGINEERING_LIMIT,
    scopeNote: `当前工程可写范围为 ${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens，仅代表补丁参数可写入范围，非模型保证支持范围。`,
  };
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Resolve target language_server inside 哈基米.app (never /Applications/Antigravity.app).
 */
function detectTargetBinary(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    assertNotOfficialAntigravityApp(resolved, 'target language_server');
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`指定的目标文件不存在: ${customPath}`);
  }

  const hakimiApp = getHakimiAppPath();
  const candidates = [
    path.join(hakimiApp, 'Contents', 'Resources', 'bin', 'language_server'),
    path.join(hakimiApp, 'Contents', 'Resources', 'bin', 'language_server_macos_arm'),
    path.join('/Applications/哈基米.app', 'Contents', 'Resources', 'bin', 'language_server'),
    path.join('/Applications/哈基米.app', 'Contents', 'Resources', 'bin', 'language_server_macos_arm'),
  ];

  for (const p of candidates) {
    if (!isOfficialAntigravityPath(p) && fs.existsSync(p)) return p;
  }
  return null;
}

function findTextSection(buf) {
  if (buf.length < 64) throw new Error('文件体积过小，非有效可执行文件');

  // Mach-O 64-bit LE
  if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
    const cputype = buf.readUInt32LE(4);
    const arch = cputype === 0x0100000c ? 'arm64' : cputype === 0x01000007 ? 'x86-64' : null;
    if (!arch) throw new Error(`不支持的 Mach-O cputype: 0x${cputype.toString(16)}`);
    const ncmds = buf.readUInt32LE(16);
    let off = 32;
    let uuidHex = null;
    let textInfo = null;

    for (let c = 0; c < ncmds && off + 8 <= buf.length; c++) {
      const cmd = buf.readUInt32LE(off);
      const size = buf.readUInt32LE(off + 4);
      if (size < 8 || off + size > buf.length) break;
      if (cmd === 0x1b && size >= 24) {
        uuidHex = buf.subarray(off + 8, off + 24).toString('hex');
      } else if (cmd === 0x19) {
        const nsects = buf.readUInt32LE(off + 64);
        let sect = off + 72;
        for (let s = 0; s < nsects && sect + 80 <= off + size; s++) {
          const sectName = buf.subarray(sect, sect + 16).toString().replace(/\0+$/, '');
          if (sectName === '__text') {
            const addr = buf.readBigUInt64LE(sect + 32);
            const offset = buf.readUInt32LE(sect + 48);
            textInfo = { textVA: addr, textOff: offset, arch, format: 'Mach-O' };
          }
          sect += 80;
        }
      }
      off += size;
    }

    if (!textInfo) throw new Error('未在 Mach-O 中找到 __text 段');
    const buildId = uuidHex
      ? `${uuidHex}_${textInfo.textOff.toString(16)}`
      : `macho_${arch}_${textInfo.textOff.toString(16)}`;
    return { ...textInfo, buildId, machoUuid: uuidHex };
  }

  // ELF 64-bit LE
  if (buf.subarray(0, 4).toString('ascii') === '\x7fELF') {
    if (buf[4] !== 2 || buf[5] !== 1) throw new Error('仅支持 64 位小端 ELF');
    const machine = buf.readUInt16LE(18);
    const arch = machine === 0xb7 ? 'arm64' : machine === 0x3e ? 'x86-64' : null;
    if (!arch) throw new Error(`不支持的 ELF 架构: 0x${machine.toString(16)}`);
    const shoff = Number(buf.readBigUInt64LE(40));
    const shentsize = buf.readUInt16LE(58);
    const shnum = buf.readUInt16LE(60);
    const shstrndx = buf.readUInt16LE(62);
    const strtabOff = Number(buf.readBigUInt64LE(shoff + shstrndx * shentsize + 24));
    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      const nameoff = buf.readUInt32LE(sh);
      const end = buf.indexOf(0, strtabOff + nameoff);
      const name = buf.subarray(strtabOff + nameoff, end).toString('utf8');
      if (name === '.text') {
        const addr = buf.readBigUInt64LE(sh + 16);
        const offset = Number(buf.readBigUInt64LE(sh + 24));
        return { textVA: addr, textOff: offset, arch, format: 'ELF' };
      }
    }
    throw new Error('未在 ELF 中找到 .text 段');
  }

  // PE
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = buf.readUInt32LE(0x3c);
    if (buf.subarray(peOff, peOff + 4).toString('ascii') !== 'PE\0\0') {
      throw new Error('无效的 PE 签名');
    }
    const machine = buf.readUInt16LE(peOff + 4);
    const arch = machine === 0x8664 ? 'x86-64' : machine === 0xaa64 ? 'arm64' : null;
    if (!arch) throw new Error(`不支持的 PE 机器架构: 0x${machine.toString(16)}`);
    const nsec = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const opt = peOff + 24;
    const peTimeDateStamp = buf.readUInt32LE(peOff + 8);
    const imageBase = buf.readBigUInt64LE(opt + 24);
    const peSizeOfImage = buf.readUInt32LE(opt + 56);
    let sect = opt + optSize;
    for (let i = 0; i < nsec; i++) {
      const name = buf.subarray(sect, sect + 8).toString().replace(/\0+$/, '');
      if (name === '.text') {
        const vaddr = buf.readUInt32LE(sect + 12);
        const rawptr = buf.readUInt32LE(sect + 20);
        const buildId = `${peTimeDateStamp.toString(16)}_${peSizeOfImage.toString(16)}_${rawptr.toString(16)}`;
        return { textVA: imageBase + BigInt(vaddr), textOff: rawptr, arch, format: 'PE', peTimeDateStamp, peSizeOfImage, buildId };
      }
      sect += 40;
    }
    throw new Error('未在 PE 中找到 .text 段');
  }

  throw new Error('无法识别的可执行文件格式 (必须为 Mach-O、PE 或 ELF)');
}

function findPclntab(buf) {
  const magic = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]);
  let pos = 0;
  while (pos < buf.length - 64) {
    const idx = buf.indexOf(magic, pos);
    if (idx < 0) break;
    pos = idx + 1;
    const minLC = buf[idx + 6];
    const ptrSize = buf[idx + 7];
    if ((minLC === 1 || minLC === 2 || minLC === 4) && ptrSize === 8) {
      const nfunc = Number(buf.readBigUInt64LE(idx + 8));
      if (nfunc > 10 && nfunc < 5000000) {
        const fnOff = Number(buf.readBigUInt64LE(idx + 32));
        if (idx + fnOff + 16 <= buf.length) {
          const head = buf.subarray(idx + fnOff, idx + fnOff + 16);
          let valid = true;
          for (const b of head) {
            if (!((b >= 0x20 && b < 0x7f) || b === 0)) {
              valid = false;
              break;
            }
          }
          if (valid) return { base: idx, nfunc };
        }
      }
    }
  }
  throw new Error('未在二进制中检测到 Go .gopclntab 符号表（可能已被深度 strip 或非 Go 编译）');
}

function buildFunctions(buf, targetSymbols) {
  const { base, nfunc } = findPclntab(buf);
  const fnstart = base + Number(buf.readBigUInt64LE(base + 32));
  const pcln = base + Number(buf.readBigUInt64LE(base + 64));

  const targetSet = new Set(
    targetSymbols || [
      FUNC_OFFERS,
      FUNC_STORE_CW,
      FUNC_STORE_CHOICE,
      FUNC_CHECKPOINT,
      FUNC_EXP_CHECKPOINT,
      FUNC_SELECT_EXP_KEY,
      FUNC_OVERRIDE,
    ]
  );

  const funcs = {};
  let targetsFound = 0;

  for (let i = 0; i < nfunc; i++) {
    const off = pcln + i * 8;
    if (off + 16 > buf.length) break;
    const entryoff = buf.readUInt32LE(off);
    const funcoff = buf.readUInt32LE(off + 4);
    const nextEntry = buf.readUInt32LE(off + 8);

    const rec = pcln + funcoff;
    if (rec + 8 > buf.length) continue;
    const nameoff = buf.readInt32LE(rec + 4);
    const s = fnstart + nameoff;
    const end = buf.indexOf(0, s);
    if (end < 0 || end - s > 500) continue;

    const fullName = buf.subarray(s, end).toString('ascii');
    const shortName = fullName.split('/').pop();
    if (targetSet.has(shortName) && !funcs[shortName]) {
      funcs[shortName] = {
        entryoff,
        size: Math.max(0, nextEntry - entryoff),
        fullName,
      };
      targetsFound++;
      if (targetsFound >= targetSet.size) break;
    }
  }

  return { funcs, totalSymbols: nfunc };
}

function narrowCandidatesByAnchor(hits, anchorOffset, window = 8192) {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const near = hits.filter((h) => Math.abs(h.offset - anchorOffset) <= window);
  return near.length === 1 ? near[0] : null;
}

function disambiguateGate3ACandidates(clampHits, defHits, body, guardFn, clampLen, defLen) {
  if (clampHits.length === 0) {
    return {
      status: 'unknown',
      reason: '未在 utils.GetCheckpointConfig 中定位到 Gate 3A clamp 站点',
    };
  }

  let chosenClamp = clampHits.length === 1 ? clampHits[0] : null;
  let chosenDef = defHits.length === 1 ? defHits[0] : null;

  if (!chosenClamp && defHits.length === 1) {
    chosenClamp = narrowCandidatesByAnchor(clampHits, defHits[0].offset, 8192);
  }
  if (!chosenDef && defHits.length > 1) {
    const guarded = guardFn ? guardFn(defHits, body) : [];
    if (guarded.length === 1) {
      chosenDef = guarded[0];
    } else if (chosenClamp) {
      chosenDef = narrowCandidatesByAnchor(defHits, chosenClamp.offset, 8192);
    }
  }
  if (!chosenClamp && clampHits.length > 1 && defHits.length > 1) {
    if (chosenDef) {
      chosenClamp = narrowCandidatesByAnchor(clampHits, chosenDef.offset, 8192);
    } else {
      const pairs = [];
      for (const c of clampHits) {
        for (const d of defHits) {
          if (Math.abs(c.offset - d.offset) <= 8192) pairs.push([c, d]);
        }
      }
      if (pairs.length === 1) {
        chosenClamp = pairs[0][0];
        chosenDef = pairs[0][1];
      }
    }
  }

  if (!chosenClamp) {
    return {
      status: 'unknown',
      reason: `检测到 ${clampHits.length} 个 Gate 3A clamp 候选且无法通过锚点唯一收窄，拒绝写入。`,
      clampCandidateCount: clampHits.length,
      defaultCandidateCount: defHits.length,
    };
  }
  if (defHits.length > 1 && !chosenDef) {
    return {
      status: 'unknown',
      reason: `检测到 ${defHits.length} 个 Gate 3A default 候选且无法唯一收窄，拒绝写入。`,
      clampCandidateCount: clampHits.length,
      defaultCandidateCount: defHits.length,
    };
  }

  const hasDefaultSite = Boolean(chosenDef);
  const baseInfo = {
    offset: chosenClamp.offset,
    length: clampLen,
    mode: chosenClamp.mode,
    limit: chosenClamp.limit,
    clampState: chosenClamp.state,
    defaultOffset: chosenDef ? chosenDef.offset : null,
    defaultLength: chosenDef ? defLen : 0,
    defaultLimit: chosenDef ? chosenDef.limit : null,
    defaultState: chosenDef ? chosenDef.state : null,
    hasDefaultSite,
    clampCandidateCount: clampHits.length,
    defaultCandidateCount: defHits.length,
  };

  if (hasDefaultSite) {
    if (chosenClamp.state === 'ORIG' && chosenDef.state !== 'ORIG') {
      return {
        ...baseInfo,
        status: 'partial',
        reason: `Gate 3A 部分匹配：clamp 为官方默认 (256,000)，但 default 站点为 ${chosenDef.limit.toLocaleString('en-US')}`,
      };
    }
    if (chosenClamp.state === 'DYN' && chosenDef.state !== 'ORIG') {
      return {
        ...baseInfo,
        status: 'partial',
        reason: `Gate 3A 部分匹配：clamp 为动态透传 (DYN)，但 default 站点未处于官方默认值 (实测 ${chosenDef.limit.toLocaleString('en-US')})`,
      };
    }
    if (chosenClamp.state === 'CONST' && chosenDef.limit !== chosenClamp.limit) {
      return {
        ...baseInfo,
        status: 'partial',
        reason: `Gate 3A 部分匹配：clamp (${chosenClamp.limit.toLocaleString('en-US')}) 与 default (${chosenDef.limit.toLocaleString('en-US')}) 数值不一致`,
      };
    }
  }

  return {
    ...baseInfo,
    status: chosenClamp.state === 'ORIG' ? 'unpatched' : 'patched',
  };
}

function checkGate3A(buf, textOff, sym, arch) {
  const fnOff = textOff + sym.entryoff;
  const fnSize = sym.size || 0x600;
  const body = buf.subarray(fnOff, Math.min(buf.length, fnOff + fnSize));

  if (arch === 'arm64') {
    const clampHits = [];
    for (let i = 0; i <= body.length - 24; i += 4) {
      const slice = body.subarray(i, i + 24);
      if (slice.equals(CLAMP_256K_ARM64)) {
        clampHits.push({ state: 'ORIG', mode: 'default', limit: DEFAULT_CHECKPOINT_TOKENS, offset: fnOff + i });
      } else if (slice.equals(PATCH_256K_ARM64)) {
        clampHits.push({ state: 'DYN', mode: 'dynamic', limit: null, offset: fnOff + i });
      } else {
        const imm = decodeMovzMovkArm64(body, i, 3);
        if (
          imm !== null &&
          imm >= 4096 &&
          imm <= 16 * 1024 * 1024 &&
          body.subarray(i + 8, i + 24).equals(PATCH_256K_ARM64.subarray(0, 16))
        ) {
          clampHits.push({ state: 'CONST', mode: 'fixed', limit: imm, offset: fnOff + i });
        }
      }
    }

    const candidateDefImms = new Set([DEFAULT_CHECKPOINT_TOKENS, ...KNOWN_LIMIT_PRESETS]);
    for (const h of clampHits) {
      if (h.state === 'CONST' && h.limit) candidateDefImms.add(h.limit);
    }

    const defHits = [];
    for (let i = 0; i <= body.length - 12; i += 4) {
      const imm = decodeMovzMovkArm64(body, i, 3);
      if (imm !== null && candidateDefImms.has(imm) && body.subarray(i + 8, i + 12).equals(STR_W3_X0_0C_ARM64)) {
        defHits.push({
          state: imm === DEFAULT_CHECKPOINT_TOKENS ? 'ORIG' : 'CONST',
          limit: imm,
          offset: fnOff + i,
          relOffset: i,
        });
      }
    }

    return disambiguateGate3ACandidates(
      clampHits,
      defHits,
      body,
      (hits, b) =>
        hits.filter((d) => d.relOffset >= 8 && b.subarray(d.relOffset - 8, d.relOffset).equals(DEF_GUARD_ARM64)),
      24,
      12
    );
  }

  // x86-64 parity
  const clampHits = [];
  for (let i = 0; i <= body.length - 14; i++) {
    const slice = body.subarray(i, i + 14);
    if (slice.equals(CLAMP_256K_X64)) {
      clampHits.push({ state: 'ORIG', mode: 'default', limit: DEFAULT_CHECKPOINT_TOKENS, offset: fnOff + i });
    } else if (slice.equals(PATCH_256K_X64)) {
      clampHits.push({ state: 'DYN', mode: 'dynamic', limit: null, offset: fnOff + i });
    } else if (slice[0] === 0xbe) {
      let allNops = true;
      for (let j = 5; j < 14; j++) {
        if (slice[j] !== 0x90) {
          allNops = false;
          break;
        }
      }
      if (allNops) {
        const imm = slice.readUInt32LE(1);
        if (imm >= 4096 && imm <= 16 * 1024 * 1024) {
          clampHits.push({ state: 'CONST', mode: 'fixed', limit: imm, offset: fnOff + i });
        }
      }
    }
  }

  const candidateDefImms = new Set([DEFAULT_CHECKPOINT_TOKENS, ...KNOWN_LIMIT_PRESETS]);
  for (const h of clampHits) {
    if (h.state === 'CONST' && h.limit) candidateDefImms.add(h.limit);
  }

  const defHits = [];
  for (let i = 0; i <= body.length - 7; i++) {
    if (body[i] === 0xc7 && body[i + 1] === 0x40 && body[i + 2] === 0x0c) {
      const imm = body.readUInt32LE(i + 3);
      if (candidateDefImms.has(imm)) {
        defHits.push({
          state: imm === DEFAULT_CHECKPOINT_TOKENS ? 'ORIG' : 'CONST',
          limit: imm,
          offset: fnOff + i,
          relOffset: i,
        });
      }
    }
  }

  return disambiguateGate3ACandidates(
    clampHits,
    defHits,
    body,
    (hits, b) => {
      const exact = hits.filter(
        (d) =>
          d.relOffset >= 6 &&
          b[d.relOffset - 6] === 0x83 &&
          b[d.relOffset - 5] === 0x7a &&
          b[d.relOffset - 4] === 0x14 &&
          b[d.relOffset - 3] === 0x00 &&
          b[d.relOffset - 2] === 0x7f &&
          b[d.relOffset - 1] === 0x07
      );
      if (exact.length === 1) return exact;
      return hits.filter(
        (d) => d.relOffset >= 2 && b[d.relOffset - 2] >= 0x70 && b[d.relOffset - 2] <= 0x7f && b[d.relOffset - 1] === 0x07
      );
    },
    14,
    7
  );
}

function checkGate3B(buf, textVA, textOff, symExp, symSelect, arch) {
  const fnOff = textOff + symExp.entryoff;
  const fnSize = symExp.size || 0x200;
  const fnVA = textVA + BigInt(symExp.entryoff);
  const body = buf.subarray(fnOff, Math.min(buf.length, fnOff + fnSize));

  if (arch === 'arm64') {
    if (!symSelect) return { status: 'unknown', reason: '缺符号 config.selectCheckpointExperimentKey' };
    const hits = [];

    for (let rel = 0; rel <= body.length - 8; rel += 4) {
      const w = body.readUInt32LE(rel);
      if (((w & 0xfc000000) >>> 0) === 0x94000000) {
        let imm26 = w & 0x03ffffff;
        if (imm26 & 0x02000000) imm26 -= 0x04000000;
        const targetEntryOff = symExp.entryoff + rel + imm26 * 4;
        if (targetEntryOff === symSelect.entryoff) {
          for (let d = 4; d <= 52 && rel + d + 4 <= body.length; d += 4) {
            const w2 = body.readUInt32LE(rel + d);
            if (((w2 & 0xfffffc1f) >>> 0) === 0xd63f0000) {
              const jOff = rel + d + 4;
              const wNext = body.readUInt32LE(jOff);
              if (
                ((wNext & 0xfff8001f) >>> 0) === 0x37000000 ||
                ((wNext & 0xff00001f) >>> 0) === 0x35000000
              ) {
                const orig = body.subarray(jOff, jOff + 4);
                hits.push({
                  status: 'unpatched',
                  offset: fnOff + jOff,
                  length: 4,
                  jumpType: 'arm64_tbnz',
                  origBytes: Array.from(orig),
                  origHex: Buffer.from(orig).toString('hex'),
                });
              } else if (wNext === 0xd503201f) {
                hits.push({ status: 'patched', offset: fnOff + jOff, length: 4 });
              } else {
                hits.push({
                  status: 'unknown',
                  offset: fnOff + jOff,
                  reason: 'ARM64 Gate 3B 分支指令形状不识别',
                });
              }
              break;
            }
          }
        }
      }
    }

    if (hits.length === 0) {
      return {
        status: 'unknown',
        reason: '未在函数体内找到 BL selectCheckpointExperimentKey -> BLR -> TBNZ/NOP 特征',
      };
    }
    if (hits.length > 1) {
      return {
        status: 'unknown',
        reason: `检测到 ${hits.length} 个 ARM64 Gate 3B 候选站点，拒绝写入`,
        candidateCount: hits.length,
      };
    }
    return hits[0];
  }

  if (arch === 'x86-64') {
    if (!symSelect) return { status: 'unknown', reason: '缺符号 config.selectCheckpointExperimentKey' };
    const selVA = textVA + BigInt(symSelect.entryoff);
    const hits = [];

    for (let rel = 0; rel < body.length - 12; rel++) {
      if (body[rel] === 0xe8) {
        const disp = body.readInt32LE(rel + 1);
        if (fnVA + BigInt(rel + 5 + disp) === selVA) {
          const window = body.subarray(rel + 5, Math.min(body.length, rel + 105));
          const tIdx = window.indexOf(Buffer.from([0x84, 0xc0]));
          if (tIdx >= 0) {
            const jOff = rel + 5 + tIdx + 2;
            const b1 = body[jOff];
            const b2 = body[jOff + 1];
            if (b1 === 0x75) {
              hits.push({
                status: 'unpatched',
                offset: fnOff + jOff,
                length: 2,
                jumpType: 'rel8',
                origBytes: [b1, b2],
                origHex: Buffer.from([b1, b2]).toString('hex'),
              });
            } else if (b1 === 0x0f && b2 === 0x85) {
              const orig = body.subarray(jOff, jOff + 6);
              hits.push({
                status: 'unpatched',
                offset: fnOff + jOff,
                length: 6,
                jumpType: 'rel32',
                origBytes: Array.from(orig),
                origHex: Buffer.from(orig).toString('hex'),
              });
            } else if (b1 === 0x90 && b2 === 0x90) {
              const run =
                jOff + 6 <= body.length && body.subarray(jOff, jOff + 6).every((b) => b === 0x90) ? 6 : 2;
              hits.push({ status: 'patched', offset: fnOff + jOff, length: run });
            } else {
              hits.push({ status: 'unknown', offset: fnOff + jOff, reason: 'jcc 指令形状不识别' });
            }
          }
        }
      }
    }

    if (hits.length === 0) {
      return { status: 'unknown', reason: '未在函数体内找到 call->selectCheckpointExperimentKey->jcc 特征' };
    }
    if (hits.length > 1) {
      return {
        status: 'unknown',
        reason: `检测到 ${hits.length} 个 Gate 3B 候选站点，拒绝写入`,
        candidateCount: hits.length,
      };
    }
    return hits[0];
  }

  return { status: 'unknown' };
}

function checkSerializerGate(buf, arch) {
  if (arch !== 'x86-64' || !Buffer.isBuffer(buf)) {
    return { present: false, status: 'absent', offset: null, limit: null };
  }
  const stockHits = [];
  let idx = -1;
  while ((idx = buf.indexOf(SERIALIZER_STOCK_X64, idx + 1)) !== -1) {
    stockHits.push(idx);
    if (stockHits.length > 2) break;
  }
  if (stockHits.length === 1) {
    return { present: true, status: 'unpatched', offset: stockHits[0], limit: null };
  }
  if (stockHits.length > 1) {
    return { present: false, status: 'ambiguous', offset: null, limit: null };
  }

  const patchedHits = [];
  let p = -1;
  while ((p = buf.indexOf(SERIALIZER_HEAD_X64, p + 1)) !== -1) {
    if (p + 20 <= buf.length && buf.subarray(p + 11, p + 20).equals(SERIALIZER_TAIL_X64)) {
      const imm = buf.readUInt32LE(p + 7);
      if (imm >= 4096 && imm <= 16 * 1024 * 1024) {
        patchedHits.push({ offset: p, limit: imm });
        if (patchedHits.length > 2) break;
      }
    }
  }
  if (patchedHits.length === 1) {
    return { present: true, status: 'patched', offset: patchedHits[0].offset, limit: patchedHits[0].limit };
  }
  return { present: false, status: patchedHits.length > 1 ? 'ambiguous' : 'absent', offset: null, limit: null };
}

function formatSyncContextLabel(mode, limitTokens) {
  if (mode === 'default' || !mode) return null;
  if (mode === 'dynamic') return 'DYNAMIC';
  const n = Number(limitTokens);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  if (n % 1024 === 0 && [262144, 524288, 983040, 1048576].includes(n)) {
    return `${n / 1024}K`;
  }
  if (n >= 1000000 && n % 1000000 === 0) return `${n / 1000000}M`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

function syncExternalContextConfigs(mode, limitTokens, options = {}) {
  const shouldWrite = options.syncConfigFiles === true || Boolean(options.homeDir) || Boolean(options.stateDir);
  if (!shouldWrite) return [];
  const isIsolated = Boolean(
    options.backupDir || options.targetPath || options.skipProcessCheck || process.env.NODE_TEST_CONTEXT
  );
  if (isIsolated && !options.homeDir && !options.stateDir) {
    return [];
  }
  const home = options.homeDir || os.homedir();
  const label = formatSyncContextLabel(mode, limitTokens);
  const synced = [];

  if (options.syncCliConfigs !== false && (options.homeDir || options.syncConfigFiles === true)) {
    const jsonTargets = [
      { filePath: path.join(home, '.gemini', 'config', 'config.json'), createDir: true },
      { filePath: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), createDir: false },
    ];
    for (const item of jsonTargets) {
      try {
        const dir = path.dirname(item.filePath);
        if (!fs.existsSync(dir)) {
          if (item.createDir) fs.mkdirSync(dir, { recursive: true });
          else continue;
        }
        let obj = {};
        if (fs.existsSync(item.filePath)) {
          try {
            obj = JSON.parse(fs.readFileSync(item.filePath, 'utf8')) || {};
          } catch {
            obj = {};
          }
        }
        if (mode === 'default' || mode === 'dynamic' || !label) {
          delete obj.contextWindow;
        } else {
          obj.contextWindow = label;
        }
        const tmp = `${item.filePath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, item.filePath);
        synced.push(item.filePath);
      } catch {}
    }
  }

  try {
    const stateDir =
      options.stateDir || (options.homeDir ? path.join(options.homeDir, '.gemini', 'antigravity') : getStateDir());
    const modeFile = path.join(stateDir, 'context-mode.json');
    const modeDir = path.dirname(modeFile);
    if (!fs.existsSync(modeDir)) fs.mkdirSync(modeDir, { recursive: true });
    const modePayload = {
      mode: mode === 'dynamic' ? '983k' : mode === 'fixed' ? '512k' : '256k',
      effectiveMode: mode,
      limitTokens: mode === 'fixed' ? Number(limitTokens) : null,
      floor: mode === 'fixed' ? Number(limitTokens) : mode === 'dynamic' ? null : DEFAULT_CHECKPOINT_TOKENS,
      label: mode === 'dynamic' ? 'dynamic' : mode === 'fixed' ? label : 'default',
      updatedAt: new Date().toISOString(),
    };
    if (mode === 'fixed') {
      modePayload.limit = Number(limitTokens);
    }
    const tmpMode = `${modeFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpMode, JSON.stringify(modePayload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpMode, modeFile);
    synced.push(modeFile);
  } catch {}

  return synced;
}

function readExternalContextConfig(options = {}) {
  const home = options.homeDir || os.homedir();
  let configContextWindow = null;
  for (const cfgPath of [
    path.join(home, '.gemini', 'config', 'config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
  ]) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed.contextWindow === 'string' && parsed.contextWindow.trim()) {
        configContextWindow = parsed.contextWindow.trim();
        break;
      }
    } catch {}
  }
  let contextModeBridge = null;
  try {
    const stateDir =
      options.stateDir || (options.homeDir ? path.join(options.homeDir, '.gemini', 'antigravity') : getStateDir());
    const modeFile = path.join(stateDir, 'context-mode.json');
    if (fs.existsSync(modeFile)) {
      contextModeBridge = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
    }
  } catch {}
  return { configContextWindow, contextModeBridge };
}

function getUnlockBackupDir(overrideDir) {
  if (overrideDir && typeof overrideDir === 'string') {
    if (!fs.existsSync(overrideDir)) fs.mkdirSync(overrideDir, { recursive: true });
    return overrideDir;
  }
  if (process.env.AG_UNLOCK_DIR) {
    const dir = path.resolve(process.env.AG_UNLOCK_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(getStateDir(), 'backups', 'context-unlock');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getManifestPath(backupDir) {
  return path.join(getUnlockBackupDir(backupDir), 'manifest.json');
}

function loadManifest(backupDir) {
  const mf = getManifestPath(backupDir);
  if (fs.existsSync(mf)) {
    try {
      return JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveManifest(data, backupDir) {
  const mf = getManifestPath(backupDir);
  fs.writeFileSync(mf, JSON.stringify(data, null, 2), 'utf8');
}

function getGate3BSidecarPath(backupDir) {
  return path.join(getUnlockBackupDir(backupDir), 'gate3b.json');
}

function loadGate3BSidecar(backupDir) {
  const p = getGate3BSidecarPath(backupDir);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveGate3BSidecar(data, backupDir) {
  const p = getGate3BSidecarPath(backupDir);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function isSameTargetPath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

function doesManifestMatchContainer(manifest, container, target) {
  if (!manifest || !isSameTargetPath(manifest.targetPath, target)) return false;
  if (manifest.buildId && container?.buildId && manifest.buildId !== container.buildId) return false;
  if (
    manifest.peTimeDateStamp !== undefined &&
    container?.peTimeDateStamp !== undefined &&
    manifest.peTimeDateStamp !== container.peTimeDateStamp
  ) {
    return false;
  }
  if (
    manifest.peSizeOfImage !== undefined &&
    container?.peSizeOfImage !== undefined &&
    manifest.peSizeOfImage !== container.peSizeOfImage
  ) {
    return false;
  }
  return true;
}

function doesSidecarMatchTarget(sidecar, target, container, gate3b) {
  if (!sidecar || !sidecar.origHex) return false;
  if (sidecar.targetPath && !isSameTargetPath(sidecar.targetPath, target)) return false;
  if (sidecar.buildId && container?.buildId && sidecar.buildId !== container.buildId) return false;
  if (
    sidecar.peTimeDateStamp !== undefined &&
    container?.peTimeDateStamp !== undefined &&
    sidecar.peTimeDateStamp !== container.peTimeDateStamp
  ) {
    return false;
  }
  if (
    sidecar.peSizeOfImage !== undefined &&
    container?.peSizeOfImage !== undefined &&
    sidecar.peSizeOfImage !== container.peSizeOfImage
  ) {
    return false;
  }
  if (sidecar.offset !== undefined && gate3b?.offset !== undefined && sidecar.offset !== gate3b.offset) {
    return false;
  }
  return true;
}

function cleanupOldReplacedFiles(targetDir, targetFileName, excludePath = null) {
  const cleaned = [];
  const retained = [];
  if (!targetDir || !fs.existsSync(targetDir) || !targetFileName) {
    return { cleaned, retained };
  }
  const escapedName = targetFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedName}\\.old_\\d+$`, 'i');
  const excl = excludePath ? path.resolve(excludePath).toLowerCase() : null;

  for (const entry of fs.readdirSync(targetDir)) {
    if (!pattern.test(entry)) continue;
    const fullPath = path.join(targetDir, entry);
    if (excl && path.resolve(fullPath).toLowerCase() === excl) continue;
    try {
      if (fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
        cleaned.push(fullPath);
      }
    } catch {
      retained.push(fullPath);
    }
  }
  return { cleaned, retained };
}

function checkFileWriteLock(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM';
  }
}

let cachedProcInfo = null;
let cachedProcAt = 0;
let inFlightProcQuery = null;

function getMacPsEnv() {
  return { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', LC_TIME: 'C' };
}

function parseMacPsOutput(psOut, targetPath) {
  const resolvedTarget = targetPath ? path.resolve(targetPath) : null;
  let realTarget = resolvedTarget;
  try {
    if (resolvedTarget && fs.existsSync(resolvedTarget)) {
      realTarget = fs.realpathSync(resolvedTarget);
    }
  } catch {}

  const matches = [];
  const lineRe = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
  for (const rawLine of String(psOut || '').split(/\r?\n/)) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const pid = Number(m[1]);
    const startMs = Date.parse(m[2]);
    const cmd = m[3].trim();
    if (!pid || !cmd) continue;
    if (!resolvedTarget) continue;

    const hit =
      cmd === resolvedTarget ||
      cmd.startsWith(resolvedTarget + ' ') ||
      (realTarget && (cmd === realTarget || cmd.startsWith(realTarget + ' ')));
    if (hit) {
      matches.push({
        pid,
        startTimeMs: Number.isFinite(startMs) ? startMs : null,
        command: cmd,
      });
    }
  }
  return matches;
}

async function getRunningLanguageServerInfoAsync(targetPath, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProcInfo && now - cachedProcAt < 2500) {
    return cachedProcInfo;
  }
  if (inFlightProcQuery) return inFlightProcQuery;

  const queryPromise = (async () => {
    const result = {
      isRunning: false,
      locked: false,
      pid: null,
      path: null,
      startTimeMs: null,
      pids: [],
      isUnknown: false,
      queryFailed: false,
    };

    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(
          'ps',
          ['-ax', '-o', 'pid=,lstart=,command='],
          { encoding: 'utf8', timeout: 2500, env: getMacPsEnv() },
          (err, out) => {
            if (err) reject(err);
            else resolve(out);
          }
        );
      });
      const matches = parseMacPsOutput(stdout, targetPath);
      if (matches.length > 0) {
        result.isRunning = true;
        result.pids = matches.map((m) => m.pid);
        result.pid = matches[0].pid;
        result.path = targetPath || null;
        result.startTimeMs = matches[0].startTimeMs;
      }
    } catch {
      result.queryFailed = true;
      result.isUnknown = true;
    }

    cachedProcInfo = result;
    cachedProcAt = Date.now();
    return result;
  })();

  inFlightProcQuery = queryPromise;
  try {
    return await queryPromise;
  } finally {
    inFlightProcQuery = null;
  }
}

function getRunningLanguageServerInfo(targetPath, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProcInfo && now - cachedProcAt < 2500) {
    return cachedProcInfo;
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return {
      isRunning: false,
      locked: false,
      pid: null,
      path: null,
      startTimeMs: null,
      pids: [],
      isUnknown: false,
      queryFailed: false,
    };
  }
  try {
    const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      env: getMacPsEnv(),
    });
    const matches = parseMacPsOutput(stdout, targetPath);
    const res = {
      isRunning: matches.length > 0,
      locked: false,
      pid: matches[0]?.pid || null,
      path: matches.length > 0 ? targetPath : null,
      startTimeMs: matches[0]?.startTimeMs || null,
      pids: matches.map((m) => m.pid),
      isUnknown: false,
      queryFailed: false,
    };
    cachedProcInfo = res;
    cachedProcAt = Date.now();
    return res;
  } catch {
    return {
      isRunning: false,
      locked: false,
      pid: null,
      path: null,
      startTimeMs: null,
      pids: [],
      isUnknown: true,
      queryFailed: true,
    };
  }
}

function checkProcessActivity(targetPath) {
  return getRunningLanguageServerInfo(targetPath, false);
}

function describeGate3AMode(gate3a) {
  if (!gate3a) return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未知状态' };
  if (gate3a.status === 'partial') {
    return { configuredMode: 'partial', configuredLimitTokens: gate3a.limit ?? null, configuredSummary: '部分匹配（站点不一致）' };
  }
  if (gate3a.status === 'unknown') {
    return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未知特征' };
  }
  if (gate3a.mode === 'default' || gate3a.status === 'unpatched') {
    return { configuredMode: 'default', configuredLimitTokens: null, configuredSummary: '宿主默认（恢复原有行为）' };
  }
  if (gate3a.mode === 'fixed' && gate3a.limit) {
    return {
      configuredMode: 'fixed',
      configuredLimitTokens: gate3a.limit,
      configuredSummary: `固定上限 (${gate3a.limit.toLocaleString('en-US')} tokens)`,
    };
  }
  if (gate3a.mode === 'dynamic') {
    return {
      configuredMode: 'dynamic',
      configuredLimitTokens: null,
      configuredSummary: '动态跟随模型（透传，不锁定 983,040）',
    };
  }
  return { configuredMode: 'unknown', configuredLimitTokens: null, configuredSummary: '未识别配置' };
}

function synthesizeAnalysisStatus(options = {}) {
  const { gate3a, gate3b, proc, manifest, container, stats, target, currentSha256, observedBudget } = options;

  let overallStatus = 'unsupported';
  let statusText = '不支持';
  let details = '';

  const targetNorm = path.resolve(target).toLowerCase();
  const manifestTargetNorm =
    manifest && manifest.targetPath ? path.resolve(manifest.targetPath).toLowerCase() : null;
  const isTargetMatched = manifestTargetNorm === targetNorm;
  const isBuildMatched = container ? doesManifestMatchContainer(manifest, container, target) : isTargetMatched;
  const isRecent = Boolean(manifest && manifest.patchedSha256 === currentSha256 && isBuildMatched);
  const patchedAtMs = isRecent && manifest && manifest.patchedAt ? new Date(manifest.patchedAt).getTime() : 0;
  const fileMtimeMs = stats && stats.mtimeMs ? stats.mtimeMs : 0;
  const effectivePatchTimeMs = patchedAtMs > 0 ? patchedAtMs : fileMtimeMs;

  const isProcPathMatched = Boolean(
    proc?.path && targetNorm && path.resolve(proc.path).toLowerCase() === targetNorm
  );

  let restartDetected = null;
  if (isProcPathMatched && proc?.startTimeMs && effectivePatchTimeMs > 0) {
    restartDetected = proc.startTimeMs >= effectivePatchTimeMs - 1500;
  }

  const modeDesc = describeGate3AMode(gate3a);

  if (gate3a.status === 'unpatched' && gate3b.status === 'unpatched') {
    overallStatus = 'not_patched';
    statusText = '未解锁';
    details = '检测到宿主原始后端（未修改限制），可切换为固定数值或跟随模型模式。';
  } else if (gate3a.status === 'patched' && gate3b.status === 'patched') {
    const modeNote = `当前磁盘模式：${modeDesc.configuredSummary}`;
    const unverifiedTail =
      observedBudget > 256000
        ? `；检测到界面显示预算 ${observedBudget.toLocaleString('en-US')} tokens（仅作参考，尚未经过真实长请求验证）。`
        : '；尚未经过真实长请求验证。';

    if (proc && !proc.isRunning && !proc.locked) {
      overallStatus = 'patched_runtime_unconfirmed';
      statusText = '磁盘已解锁，运行待确认';
      details = `${modeNote}；当前后端未运行，将在 哈基米.app 启动后加载${unverifiedTail}`;
    } else if (restartDetected === true && isProcPathMatched) {
      overallStatus = 'patched_loaded';
      statusText = '已加载，待长请求实测';
      details = `${modeNote}；目标进程 (PID ${proc?.pid || '未知'}) 启动时间晚于修改时间${unverifiedTail}`;
      if (manifest && manifest.needsRestart) {
        manifest.needsRestart = false;
        try {
          saveManifest(manifest, options.backupDir);
        } catch {}
      }
    } else if (restartDetected === false && isProcPathMatched) {
      overallStatus = 'patched_pending_restart';
      statusText = '已写入补丁，待重启';
      details = `${modeNote}；当前运行中的宿主进程 (PID ${proc?.pid || '未知'}) 启动于修改之前，请重启 哈基米.app 使新配置生效。`;
    } else {
      overallStatus = 'patched_runtime_unconfirmed';
      statusText = '磁盘已解锁，运行待确认';
      details = isProcPathMatched
        ? `${modeNote}；未能确定进程重启时序，请确认已重启并观察后续真实请求表现${unverifiedTail}`
        : `${modeNote}；未能确证目标进程加载路径，将在重启后生效${unverifiedTail}`;
    }
  } else if (gate3a.status === 'partial') {
    overallStatus = 'partial_match';
    statusText = '状态异常（部分匹配）';
    details = '部分限制特征状态不一致，为避免损坏程序已拒绝写入。';
  } else if (
    (gate3a.status === 'patched' && gate3b.status === 'unpatched') ||
    (gate3a.status === 'unpatched' && gate3b.status === 'patched')
  ) {
    overallStatus = 'partial_match';
    statusText = '状态异常（部分匹配）';
    details = '后端限制处于半修改状态，拒绝直接覆写；请先通过「还原后端」恢复后再操作。';
  } else {
    overallStatus = 'failed';
    statusText = '检测或执行失败';
    const specificReasons = [gate3a?.reason, gate3b?.reason].filter(Boolean);
    details =
      specificReasons.length > 0
        ? specificReasons.join('；')
        : '未识别到可安全改写的特征（或版本已变更），已中止操作以防损坏文件。';
  }

  return {
    overallStatus,
    statusText,
    details,
    restartDetected,
    ...modeDesc,
  };
}

function buildAnalysisResult({
  target,
  container,
  stats,
  currentSha256,
  totalSymbols,
  mode,
  gate3a,
  gate3b,
  serializerGate,
  proc,
  manifest,
  sidecar,
  observedBudget,
  backupDir,
}) {
  const synthesis = synthesizeAnalysisStatus({
    gate3a,
    gate3b,
    proc,
    manifest,
    container,
    stats,
    target,
    currentSha256,
    observedBudget,
    backupDir,
  });

  const backupExists = Boolean(manifest && manifest.backupPath && fs.existsSync(manifest.backupPath));
  const backupMatches = backupExists && doesManifestMatchContainer(manifest, container, target);
  let backupStaleReason = null;
  if (backupExists && !backupMatches) {
    backupStaleReason = '检测到目标二进制路径或构建指纹已变更，历史备份与当前文件不匹配（已禁用整包还原）。';
  }

  return {
    status: synthesis.overallStatus,
    statusText: synthesis.statusText,
    details: synthesis.details,
    targetPath: target,
    format: container.format,
    arch: container.arch,
    peBuildId: container.buildId || null,
    peTimeDateStamp: container.peTimeDateStamp ?? null,
    peSizeOfImage: container.peSizeOfImage ?? null,
    mode,
    configuredMode: synthesis.configuredMode,
    configuredLimitTokens: synthesis.configuredLimitTokens,
    configuredSummary: synthesis.configuredSummary,
    scope: 'shared_backend',
    scopeNotice: '保存仅记录该模型偏好；应用会影响 哈基米.app 共享后端的所有会话，重启后生效。',
    realRequestVerified: false,
    engineeringRange: {
      min: MIN_ENGINEERING_LIMIT,
      max: MAX_ENGINEERING_LIMIT,
      presets: KNOWN_LIMIT_PRESETS,
      scopeNote: `补丁工程可写范围 ${MIN_ENGINEERING_LIMIT.toLocaleString('en-US')} ~ ${MAX_ENGINEERING_LIMIT.toLocaleString('en-US')} tokens（不代表模型保证支持上限）`,
    },
    fileSize: stats.size,
    sha256: currentSha256,
    totalSymbols,
    gate3a,
    gate3b,
    serializerGate: serializerGate || { present: false, status: 'absent', offset: null, limit: null },
    isProcessRunning: proc.isRunning,
    isProcessLocked: proc.locked,
    runtimeEvidence: {
      isProcessRunning: proc.isRunning,
      isProcessLocked: proc.locked,
      processPid: proc.pid || null,
      processStartTime: proc.startTimeMs ? new Date(proc.startTimeMs).toISOString() : null,
      patchedAt: manifest ? manifest.patchedAt : null,
      restartDetected: synthesis.restartDetected,
      observedBudget: observedBudget || null,
      budgetObservedAbove256k: observedBudget > DEFAULT_CHECKPOINT_TOKENS,
      realRequestVerified: false,
      verificationNote: '仅依据静态特征/进程/前端显示预算，尚未经真实长请求服务端验证。',
    },
    hasBackup: backupExists,
    backupValidForCurrentBinary: backupMatches,
    backupStaleReason,
    hasMatchingGate3BSidecar: doesSidecarMatchTarget(sidecar, target, container, gate3b),
    backupInfo: manifest
      ? {
          origSha256: manifest.origSha256,
          backupPath: manifest.backupPath,
          patchedAt: manifest.patchedAt,
          buildId: manifest.buildId || null,
          configuredMode: manifest.configuredMode || null,
          configuredLimitTokens: manifest.configuredLimitTokens ?? null,
        }
      : null,
    author: AUTHOR_INFO,
  };
}

function runCommonBinaryAnalysis(filePath, options = {}) {
  const target = filePath || detectTargetBinary();
  if (!target || !fs.existsSync(target)) {
    return {
      errorResult: {
        status: 'unsupported',
        targetPath: target,
        reason: target ? '目标文件不存在' : '未检测到 哈基米.app 后端文件 (language_server)',
      },
    };
  }
  if (isOfficialAntigravityPath(target)) {
    return {
      errorResult: {
        status: 'unsupported',
        targetPath: target,
        reason: `拒绝分析/修改官方 Antigravity.app：${target}`,
      },
    };
  }

  let buf;
  let stats;
  try {
    stats = fs.statSync(target);
    buf = fs.readFileSync(target);
  } catch (e) {
    return { errorResult: { status: 'failed', targetPath: target, reason: `读取目标文件失败: ${e.message}` } };
  }

  const currentSha256 = sha256Buffer(buf);

  let container;
  try {
    container = findTextSection(buf);
  } catch (e) {
    return {
      errorResult: { status: 'unsupported', targetPath: target, sha256: currentSha256, reason: e.message },
    };
  }

  const { textVA, textOff, arch, format } = container;
  if (arch !== 'arm64' && options.allowNonArm64 !== true) {
    return {
      errorResult: {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        sha256: currentSha256,
        reason: `当前版本专注 macOS Apple Silicon (arm64)，暂不支持 ${arch} 架构写入。`,
      },
    };
  }

  let funcsData;
  try {
    funcsData = buildFunctions(buf);
  } catch (e) {
    return {
      errorResult: {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        sha256: currentSha256,
        reason: e.message,
      },
    };
  }

  const { funcs, totalSymbols } = funcsData;
  const isServerOnly = !funcs[FUNC_OFFERS] && !funcs[FUNC_STORE_CW];
  const mode = isServerOnly ? 'standalone language_server' : 'agy CLI';
  const symCheckpoint = funcs[FUNC_CHECKPOINT];
  const symExp = funcs[FUNC_EXP_CHECKPOINT];
  const symSelect = funcs[FUNC_SELECT_EXP_KEY];

  if (!symCheckpoint || !symExp) {
    return {
      errorResult: {
        status: 'unsupported',
        targetPath: target,
        arch,
        format,
        mode,
        sha256: currentSha256,
        reason: '缺少核心检查点上限符号 (utils.GetCheckpointConfig 或 config.applyFeatureProviderCheckpointOverrideConfig)',
      },
    };
  }

  const gate3a = checkGate3A(buf, textOff, symCheckpoint, arch);
  const gate3b = checkGate3B(buf, textVA, textOff, symExp, symSelect, arch);
  const serializerGate = checkSerializerGate(buf, arch);

  return {
    target,
    stats,
    container,
    currentSha256,
    totalSymbols,
    mode,
    gate3a,
    gate3b,
    serializerGate,
  };
}

async function analyzeBinaryAsync(filePath, options = {}) {
  if (process.platform !== 'darwin' && !filePath) {
    return {
      status: 'unsupported',
      targetPath: null,
      reason: `当前版本专注 macOS Apple Silicon (ARM64)，不支持 ${process.platform}`,
      isPlatformSupported: false,
    };
  }
  const parsed = runCommonBinaryAnalysis(filePath, options);
  if (parsed.errorResult) return parsed.errorResult;

  const proc = options.skipProcessCheck
    ? { isRunning: false, locked: false, pid: null, path: null, startTimeMs: null, pids: [] }
    : await getRunningLanguageServerInfoAsync(parsed.target, options.forceRefresh === true);

  return buildAnalysisResult({
    target: parsed.target,
    container: parsed.container,
    stats: parsed.stats,
    currentSha256: parsed.currentSha256,
    totalSymbols: parsed.totalSymbols,
    mode: parsed.mode,
    gate3a: parsed.gate3a,
    gate3b: parsed.gate3b,
    serializerGate: parsed.serializerGate,
    proc,
    manifest: loadManifest(options.backupDir),
    sidecar: loadGate3BSidecar(options.backupDir),
    observedBudget: Number(options?.currentBudget || options?.observedBudget || 0),
    backupDir: options.backupDir,
  });
}

function analyzeBinary(filePath, options = {}) {
  const parsed = runCommonBinaryAnalysis(filePath, options);
  if (parsed.errorResult) return parsed.errorResult;

  const proc = options.skipProcessCheck
    ? { isRunning: false, locked: false, pid: null, path: null, startTimeMs: null, pids: [] }
    : checkProcessActivity(parsed.target);

  return buildAnalysisResult({
    target: parsed.target,
    container: parsed.container,
    stats: parsed.stats,
    currentSha256: parsed.currentSha256,
    totalSymbols: parsed.totalSymbols,
    mode: parsed.mode,
    gate3a: parsed.gate3a,
    gate3b: parsed.gate3b,
    serializerGate: parsed.serializerGate,
    proc,
    manifest: loadManifest(options.backupDir),
    sidecar: loadGate3BSidecar(options.backupDir),
    observedBudget: Number(options?.currentBudget || options?.observedBudget || 0),
    backupDir: options.backupDir,
  });
}

function extractCodesignEntitlements(targetPath) {
  try {
    const out = execFileSync('codesign', ['-d', '--xml', '--entitlements', '-', targetPath], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const idx = out.indexOf('<?xml');
    if (idx >= 0) return out.slice(idx);
  } catch {}
  return null;
}

function getMainExecutablePath(bundleRoot) {
  const infoPlist = path.join(bundleRoot, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) return null;
  try {
    const execName = execFileSync('defaults', ['read', infoPlist, 'CFBundleExecutable'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (!execName) return null;
    const p = path.join(bundleRoot, 'Contents', 'MacOS', execName);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * macOS Apple Silicon safe atomic replacement: always creates a NEW inode + re-signs
 * language_server (--options runtime) and refreshes/re-signs enclosing 哈基米.app bundle.
 */
function atomicWriteBinary(targetPath, buf, tempTag = 'new', options = {}) {
  assertNotOfficialAntigravityApp(targetPath, 'write binary');

  const tmpNew = `${targetPath}.${tempTag}_${process.pid}_${Date.now()}`;
  const entDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-ent-'));
  let signed = false;
  let outerSigned = false;

  try {
    let mode = 0o755;
    try {
      mode = fs.statSync(targetPath).mode & 0o777;
    } catch {}

    const bundleRoot = getAppBundleRoot(targetPath);
    if (bundleRoot) assertNotOfficialAntigravityApp(bundleRoot, 're-sign app bundle');

    const shouldCodesign =
      process.platform === 'darwin' &&
      options.skipCodesign !== true &&
      (Boolean(bundleRoot) || options.codesign === true);

    let lsEntFile = null;
    let appEntFile = null;
    if (shouldCodesign) {
      const lsEntXml = extractCodesignEntitlements(targetPath) || DEFAULT_LS_ENTITLEMENTS_PLIST;
      lsEntFile = path.join(entDir, 'ls.entitlements');
      fs.writeFileSync(lsEntFile, lsEntXml, 'utf8');

      if (bundleRoot) {
        const appEntXml = extractCodesignEntitlements(bundleRoot);
        if (appEntXml) {
          appEntFile = path.join(entDir, 'app.entitlements');
          fs.writeFileSync(appEntFile, appEntXml, 'utf8');
        }
      }
    }

    fs.writeFileSync(tmpNew, buf);
    fs.chmodSync(tmpNew, mode || 0o755);

    if (shouldCodesign) {
      const lsArgs = ['--force', '--sign', '-', '--options', 'runtime'];
      if (lsEntFile) lsArgs.push('--entitlements', lsEntFile);
      lsArgs.push(tmpNew);
      execFileSync('codesign', lsArgs, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      signed = true;
    }

    // Atomic rename replaces directory entry with brand-new inode (avoids Apple Silicon cs_blob SIGKILL)
    fs.renameSync(tmpNew, targetPath);

    if (shouldCodesign && bundleRoot) {
      const mainExec = getMainExecutablePath(bundleRoot);
      if (mainExec) {
        const execTmp = `${mainExec}.refresh_${process.pid}_${Date.now()}`;
        fs.copyFileSync(mainExec, execTmp);
        fs.chmodSync(execTmp, fs.statSync(mainExec).mode & 0o777);
        fs.renameSync(execTmp, mainExec);
      }
      const appArgs = ['--force', '--sign', '-'];
      if (appEntFile) appArgs.push('--entitlements', appEntFile);
      appArgs.push(bundleRoot);
      execFileSync('codesign', appArgs, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      outerSigned = true;
    }

    return { ok: true, usedRenameTrick: false, newInode: true, signed, outerSigned };
  } catch (e) {
    return {
      ok: false,
      error: `写入/重签名目标文件失败 (${e.code || e.message})`,
    };
  } finally {
    try {
      if (fs.existsSync(tmpNew)) fs.unlinkSync(tmpNew);
    } catch {}
    try {
      fs.rmSync(entDir, { recursive: true, force: true });
    } catch {}
  }
}

function normalizeUnlockTargetOptions(options = {}) {
  const hasLimitParam =
    options?.limitTokens !== undefined && options?.limitTokens !== null && options?.limitTokens !== '';
  const rawMode = options?.mode ? String(options.mode).trim().toLowerCase() : hasLimitParam ? 'fixed' : 'dynamic';

  if (rawMode === 'default' || rawMode === 'orig' || rawMode === 'official') {
    return { ok: true, mode: 'default', limitTokens: DEFAULT_CHECKPOINT_TOKENS, warnings: [] };
  }
  if (rawMode === 'dynamic' || rawMode === 'dyn' || rawMode === 'passthrough') {
    return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
  }
  if (rawMode === 'fixed' || rawMode === 'const' || rawMode === 'custom') {
    const validation = validateContextLimit(options?.limitTokens, { serviceLimit: options?.serviceLimit });
    if (!validation.ok) return validation;
    return {
      ok: true,
      mode: 'fixed',
      limitTokens: validation.limitTokens,
      warnings: validation.warnings,
      scopeNote: validation.scopeNote,
    };
  }
  return { ok: false, error: `未知上下文模式: ${options.mode}`, code: 'INVALID_MODE' };
}

function resolveUnlockTargetPath(options = {}) {
  const typoKey = ['binPath', 'binaryPath', 'filePath', 'path', 'target'].find(
    (k) => options[k] !== undefined && options[k] !== null && String(options[k]).trim() !== ''
  );
  if (typoKey && !options.targetPath) {
    return {
      ok: false,
      code: 'INVALID_TARGET_OPTION',
      error: `无效的目标路径字段 "${typoKey}"，请显式使用 targetPath；已拒绝回退至默认安装目录。`,
    };
  }
  if (options.targetPath && String(options.targetPath).trim() !== '') {
    const resolved = path.resolve(String(options.targetPath));
    try {
      assertNotOfficialAntigravityApp(resolved, 'modify language_server');
    } catch (e) {
      return { ok: false, code: 'OFFICIAL_APP_FORBIDDEN', error: e.message };
    }
    return { ok: true, target: resolved };
  }
  const hasIsolationContext = Boolean(
    options.backupDir ||
      options.homeDir ||
      options.stateDir ||
      options.skipProcessCheck ||
      process.env.NODE_TEST_CONTEXT
  );
  if (hasIsolationContext) {
    return {
      ok: false,
      code: 'MISSING_TARGET_PATH',
      error: '处于测试或隔离上下文但未显式指定 targetPath，已拒绝探测或写入应用目录。',
    };
  }
  try {
    const detected = detectTargetBinary();
    if (!detected) {
      return { ok: false, code: 'MISSING_TARGET_PATH', error: '未检测到 哈基米.app 内的 language_server 二进制文件。' };
    }
    return { ok: true, target: detected };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function applyUnlock(options = {}) {
  if (process.platform !== 'darwin' && !options.targetPath) {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前版本专注 macOS Apple Silicon (ARM64)，不支持 ${process.platform}`,
    };
  }

  const targetSpec = normalizeUnlockTargetOptions(options);
  if (!targetSpec.ok) {
    return { ok: false, code: targetSpec.code || 'INVALID_INPUT', error: targetSpec.error };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) return resolvedTarget;
  const target = resolvedTarget.target;

  const analysis = analyzeBinary(target, {
    backupDir: options.backupDir,
    expectedLimit: targetSpec.limitTokens,
    skipProcessCheck: options.skipProcessCheck,
  });

  const allowedStatuses = new Set([
    'not_patched',
    'patched_runtime_unconfirmed',
    'patched_pending_restart',
    'patched_loaded',
  ]);
  if (!allowedStatuses.has(analysis.status) || analysis.arch !== 'arm64') {
    return {
      ok: false,
      code: analysis.status === 'partial_match' ? 'PARTIAL_MATCH' : 'UNSUPPORTED_OR_UNKNOWN',
      error: `无法应用设置：${analysis.details || analysis.reason || '目标状态不受支持或存在部分匹配异常'}`,
      analysis,
    };
  }

  const recordedTarget = options.recordedTargetPath ? path.resolve(options.recordedTargetPath) : target;

  if (targetSpec.mode === 'default' && analysis.status === 'not_patched') {
    const syncedConfigs = syncExternalContextConfigs('default', null, options);
    return {
      ok: true,
      alreadyPatched: true,
      alreadyRestored: true,
      alreadyMatched: true,
      configuredMode: 'default',
      configuredLimitTokens: DEFAULT_CHECKPOINT_TOKENS,
      needsRestart: false,
      syncedConfigs,
      message: '当前已经处于宿主默认状态，无需重复切换。',
      analysis,
    };
  }
  if (targetSpec.mode === 'dynamic' && analysis.status !== 'not_patched' && analysis.configuredMode === 'dynamic') {
    const syncedConfigs = syncExternalContextConfigs('dynamic', null, options);
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'dynamic',
      configuredLimitTokens: null,
      needsRestart: analysis.status === 'patched_pending_restart',
      syncedConfigs,
      message: '当前已经处于「动态跟随模型（透传）」模式，无需重复写入。',
      analysis,
    };
  }
  if (
    targetSpec.mode === 'fixed' &&
    analysis.status !== 'not_patched' &&
    analysis.configuredMode === 'fixed' &&
    analysis.configuredLimitTokens === targetSpec.limitTokens
  ) {
    const syncedConfigs = syncExternalContextConfigs('fixed', targetSpec.limitTokens, options);
    return {
      ok: true,
      alreadyPatched: true,
      alreadyMatched: true,
      configuredMode: 'fixed',
      configuredLimitTokens: targetSpec.limitTokens,
      needsRestart: analysis.status === 'patched_pending_restart',
      syncedConfigs,
      message: `当前已经应用固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens，无需重复写入。`,
      analysis,
    };
  }

  const { gate3a, gate3b, arch, targetPath, sha256: beforeSha256, fileSize } = analysis;
  const backupDir = getUnlockBackupDir(options.backupDir);
  const existingManifest = loadManifest(options.backupDir);
  const existingSidecar = loadGate3BSidecar(options.backupDir);
  const buf = fs.readFileSync(targetPath);
  const container = findTextSection(buf);

  let gate3bOrigBytesForDefault = null;
  if (targetSpec.mode === 'default' && gate3b.status === 'patched') {
    if (doesSidecarMatchTarget(existingSidecar, recordedTarget, container, gate3b)) {
      gate3bOrigBytesForDefault = Buffer.from(existingSidecar.origHex, 'hex');
    } else if (
      existingManifest &&
      existingManifest.backupPath &&
      fs.existsSync(existingManifest.backupPath) &&
      doesManifestMatchContainer(existingManifest, container, recordedTarget) &&
      sha256File(existingManifest.backupPath) === existingManifest.origSha256
    ) {
      const backupBuf = fs.readFileSync(existingManifest.backupPath);
      gate3bOrigBytesForDefault = backupBuf.subarray(gate3b.offset, gate3b.offset + (gate3b.length || 4));
    } else {
      return {
        ok: false,
        code: 'MISSING_OR_STALE_GATE3B_SIDECAR',
        error: '缺少与当前版本匹配的原始字节记录或备份，无法安全切换回默认状态（已阻止盲写）。',
        analysis,
      };
    }
  }

  let manifestToSave =
    existingManifest && doesManifestMatchContainer(existingManifest, container, recordedTarget)
      ? { ...existingManifest }
      : null;

  if (analysis.status === 'not_patched') {
    let backupFile = null;
    if (options.skipBackup !== true) {
      backupFile = path.join(backupDir, `${path.basename(recordedTarget)}_${beforeSha256.slice(0, 12)}.orig`);
      try {
        fs.copyFileSync(targetPath, backupFile);
        const backupSha = sha256File(backupFile);
        if (backupSha !== beforeSha256) {
          if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
          return { ok: false, error: '备份哈希校验不匹配，操作已中止。' };
        }
      } catch (e) {
        return { ok: false, error: `创建备份失败: ${e.message}` };
      }
    }

    if (gate3b.origHex) {
      saveGate3BSidecar(
        {
          targetPath: recordedTarget,
          buildId: container.buildId || null,
          offset: gate3b.offset,
          length: gate3b.length,
          origHex: gate3b.origHex,
          origSha8: beforeSha256.slice(0, 8),
          updatedAt: new Date().toISOString(),
        },
        options.backupDir
      );
    }

    manifestToSave = {
      targetPath: recordedTarget,
      arch,
      buildId: container.buildId || null,
      origSha256: beforeSha256,
      origSize: fileSize,
      backupPath: backupFile,
      backupSha256: backupFile ? beforeSha256 : null,
      gate3bOrigHex: gate3b.origHex || null,
      gate3bLength: gate3b.length || null,
      gate3bOffset: gate3b.offset ?? null,
      author: AUTHOR_INFO,
    };
  }

  // Apply Gate 3A + Gate 3B surgical bytes for ARM64
  if (targetSpec.mode === 'default') {
    buf.set(CLAMP_256K_ARM64, gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(DEF_ORIG_ARM64, gate3a.defaultOffset);
    }
    if (gate3b.status === 'patched' && gate3bOrigBytesForDefault) {
      buf.set(gate3bOrigBytesForDefault, gate3b.offset);
    }
  } else if (targetSpec.mode === 'fixed') {
    buf.set(buildClampConstArm64(targetSpec.limitTokens), gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(buildDefConstArm64(targetSpec.limitTokens), gate3a.defaultOffset);
    }
    if (gate3b.status === 'unpatched') {
      buf.set(NOP_ARM64, gate3b.offset);
    }
  } else if (targetSpec.mode === 'dynamic') {
    buf.set(PATCH_256K_ARM64, gate3a.offset);
    if (gate3a.hasDefaultSite && gate3a.defaultOffset !== null) {
      buf.set(DEF_ORIG_ARM64, gate3a.defaultOffset);
    }
    if (gate3b.status === 'unpatched') {
      buf.set(NOP_ARM64, gate3b.offset);
    }
  }

  const afterSha256 = sha256Buffer(buf);
  const writeRes = atomicWriteBinary(targetPath, buf, 'new', options);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error };
  }

  const syncedConfigs = syncExternalContextConfigs(targetSpec.mode, targetSpec.limitTokens, options);

  if (manifestToSave) {
    manifestToSave.patchedSha256 = afterSha256;
    manifestToSave.patchedAt = new Date().toISOString();
    manifestToSave.configuredMode = targetSpec.mode;
    manifestToSave.configuredLimitTokens = targetSpec.limitTokens;
    manifestToSave.needsRestart = true;
    saveManifest(manifestToSave, options.backupDir);
  }

  const modeSummary =
    targetSpec.mode === 'default'
      ? '宿主默认模式（恢复原有行为）'
      : targetSpec.mode === 'fixed'
        ? `固定上限 ${targetSpec.limitTokens.toLocaleString('en-US')} tokens`
        : '跟随模型（动态透传）';

  return {
    ok: true,
    needsRestart: true,
    targetPath,
    configuredMode: targetSpec.mode,
    configuredLimitTokens: targetSpec.limitTokens,
    defaultSitePatched: Boolean(gate3a.hasDefaultSite),
    serializerPatched: false,
    signed: writeRes.signed,
    outerSigned: writeRes.outerSigned,
    syncedConfigs,
    warnings: targetSpec.warnings || [],
    scopeNote: analysis.scopeNotice,
    beforeSha256,
    afterSha256,
    backupPath: manifestToSave ? manifestToSave.backupPath : null,
    message: `已将 哈基米.app 共享后端切换为「${modeSummary}」，重启 哈基米.app 或语言服务后生效（尚未经过真实长请求验证）`,
  };
}

/**
 * Restore context window limit to stock 256K.
 * Prioritizes SURGICAL restoration of Gate 3A + Gate 3B so Region Unlock
 * (ValidateAndOnboardAccount) and Chinese Title patches in language_server
 * are NEVER reverted.
 */
function restoreUnlock(options = {}) {
  if (process.platform !== 'darwin' && !options.targetPath) {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `当前版本专注 macOS Apple Silicon (ARM64)，不支持 ${process.platform}`,
    };
  }

  const resolvedTarget = resolveUnlockTargetPath(options);
  if (!resolvedTarget.ok) return resolvedTarget;
  const target = resolvedTarget.target;

  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: '目标文件不存在，无法恢复' };
  }

  const manifest = loadManifest(options.backupDir);
  const sidecar = loadGate3BSidecar(options.backupDir);
  const currentBuf = fs.readFileSync(target);
  const recordedTarget = options.recordedTargetPath ? path.resolve(options.recordedTargetPath) : target;

  let container;
  try {
    container = findTextSection(currentBuf);
  } catch (e) {
    return { ok: false, error: `解析当前二进制容器失败，拒绝恢复: ${e.message}` };
  }

  const analysis = analyzeBinary(target, {
    backupDir: options.backupDir,
    skipProcessCheck: options.skipProcessCheck,
  });

  if (analysis.status === 'not_patched') {
    const syncedConfigs = syncExternalContextConfigs('default', null, options);
    return {
      ok: true,
      alreadyRestored: true,
      syncedConfigs,
      message: '当前已经处于默认 256K 上下文限制，无需恢复。',
    };
  }

  // Priority 1: Surgical Gate 3A + Gate 3B restoration (preserves Region Unlock & Chinese Title!)
  if (
    container.arch === 'arm64' &&
    (analysis.gate3a?.status === 'patched' || analysis.gate3a?.status === 'unpatched') &&
    analysis.gate3b?.status === 'patched' &&
    doesSidecarMatchTarget(sidecar, recordedTarget, container, analysis.gate3b)
  ) {
    currentBuf.set(CLAMP_256K_ARM64, analysis.gate3a.offset);
    if (analysis.gate3a.hasDefaultSite && analysis.gate3a.defaultOffset !== null) {
      currentBuf.set(DEF_ORIG_ARM64, analysis.gate3a.defaultOffset);
    }
    currentBuf.set(Buffer.from(sidecar.origHex, 'hex'), analysis.gate3b.offset);

    const writeRes = atomicWriteBinary(target, currentBuf, 'rev', options);
    if (!writeRes.ok) {
      return { ok: false, error: `原位还原写入失败: ${writeRes.error}` };
    }

    if (manifest && doesManifestMatchContainer(manifest, container, recordedTarget)) {
      manifest.needsRestart = true;
      manifest.configuredMode = 'default';
      manifest.configuredLimitTokens = DEFAULT_CHECKPOINT_TOKENS;
      manifest.patchedSha256 = sha256Buffer(currentBuf);
      manifest.patchedAt = new Date().toISOString();
      saveManifest(manifest, options.backupDir);
    }

    const syncedConfigs = syncExternalContextConfigs('default', null, options);
    return {
      ok: true,
      needsRestart: true,
      surgical: true,
      syncedConfigs,
      message: '已原位恢复默认 256K 上下文限制（已保留地区解锁与中文标题补丁）！重启后生效。',
    };
  }

  // Priority 2: Verified backup fallback
  if (manifest && manifest.backupPath && fs.existsSync(manifest.backupPath)) {
    if (!isSameTargetPath(manifest.targetPath, recordedTarget)) {
      return { ok: false, error: '安装记录目标与当前恢复目标不一致，拒绝跨路径还原。' };
    }
    if (!doesManifestMatchContainer(manifest, container, recordedTarget)) {
      return {
        ok: false,
        code: 'BACKUP_VERSION_MISMATCH',
        error: '检测到当前目标文件版本/构建已更新，与历史备份指纹不一致，已拒绝跨版本还原。',
      };
    }
    const backupSha = sha256File(manifest.backupPath);
    if (backupSha !== manifest.origSha256) {
      return { ok: false, error: '备份文件已损坏或被篡改，无法执行还原。' };
    }

    const backupBuf = fs.readFileSync(manifest.backupPath);
    const writeRes = atomicWriteBinary(target, backupBuf, 'res', options);
    if (!writeRes.ok) {
      return { ok: false, error: `恢复备份写入失败: ${writeRes.error}` };
    }

    manifest.needsRestart = true;
    manifest.configuredMode = 'default';
    manifest.configuredLimitTokens = DEFAULT_CHECKPOINT_TOKENS;
    saveManifest(manifest, options.backupDir);
    const syncedConfigs = syncExternalContextConfigs('default', null, options);

    return {
      ok: true,
      needsRestart: true,
      syncedConfigs,
      message: '已恢复默认上下文配置！请重启 哈基米.app 生效。',
    };
  }

  return {
    ok: false,
    code: 'RESTORE_REJECTED',
    error: '未找到与当前版本匹配的原始字节记录或备份，为确保安全拒绝覆盖。',
  };
}

module.exports = {
  AUTHOR_INFO,
  DEFAULT_CHECKPOINT_TOKENS,
  MIN_ENGINEERING_LIMIT,
  MAX_ENGINEERING_LIMIT,
  KNOWN_LIMIT_PRESETS,
  NOP_ARM64,
  PATCH_256K_ARM64,
  CLAMP_256K_ARM64,
  DEF_ORIG_ARM64,
  DEF_GUARD_ARM64,
  encodeMovzMovkArm64,
  decodeMovzMovkArm64,
  buildClampConstArm64,
  buildDefConstArm64,
  validateContextLimit,
  detectTargetBinary,
  findTextSection,
  findPclntab,
  buildFunctions,
  checkSerializerGate,
  syncExternalContextConfigs,
  readExternalContextConfig,
  analyzeBinary,
  analyzeBinaryAsync,
  parseMacPsOutput,
  getRunningLanguageServerInfoAsync,
  cleanupOldReplacedFiles,
  synthesizeAnalysisStatus,
  applyUnlock,
  restoreUnlock,
  atomicWriteBinary,
  getUnlockBackupDir,
  loadGate3BSidecar,
  saveGate3BSidecar,
};
