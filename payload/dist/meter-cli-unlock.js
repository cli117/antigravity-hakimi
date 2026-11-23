'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getStateDir,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');
const {
  NOP_ARM64,
  PATCH_256K_ARM64,
  CLAMP_256K_ARM64,
  DEF_ORIG_ARM64,
  sha256Buffer,
  buildClampConstArm64,
  buildDefConstArm64,
  encodeAdrpArm64,
  encodeAddImmArm64,
  encodeMovz64Arm64,
  encodeBlArm64,
  decodeBlArm64Target,
} = require('./binary-utils');
const {
  DEFAULT_CHECKPOINT_TOKENS,
  validateContextLimit,
  findTextSection,
  buildFunctions,
  syncExternalContextConfigs,
  readExternalContextConfig,
  analyzeBinary: analyzeContextCheckpointBinary,
  atomicWriteBinary,
} = require('./meter-context-unlock');
const { analyzeRegionUnlock } = require('./meter-region-unlock');
const {
  parseElf64,
  fileOffToVA,
  findElfGoFunctions,
  analyzeElfRegionUnlock,
  analyzeElfContextUnlock,
  patchElfBuffer,
} = require('./meter-ssh');

const MH_MAGIC_64 = 0xfeedfacf;
const ENV_NAME = Buffer.from('AGY_CLI_AUTO_COMPACT_OVERRIDE', 'ascii');

const FUNC_OFFERS = 'model.SelectorModel.offersContextWindow';
const FUNC_OVERRIDE = 'store.AutoCompactOverride';
const FUNC_TRIM_SPACE = 'strings.TrimSpace';
const FUNC_OS_GETENV = 'os.Getenv';
const FUNC_CHECKPOINT = 'utils.GetCheckpointConfig';
const FUNC_EXP_CHECKPOINT = 'config.applyFeatureProviderCheckpointOverrideConfig';
const FUNC_SELECT_EXP_KEY = 'config.selectCheckpointExperimentKey';
const FUNC_REGION = 'authclient.ValidateAndOnboardAccount';

const CLI_TARGET_SYMBOLS = [
  FUNC_OFFERS,
  FUNC_OVERRIDE,
  FUNC_TRIM_SPACE,
  FUNC_OS_GETENV,
  FUNC_CHECKPOINT,
  FUNC_EXP_CHECKPOINT,
  FUNC_SELECT_EXP_KEY,
  FUNC_REGION,
];

// arm64: mov w0, #1 ; ret
const RET_TRUE_ARM64 = Buffer.from('20008052c0035fd6', 'hex');
// x86-64: mov eax, 1 ; ret
const RET_TRUE_X64 = Buffer.from('b801000000c3', 'hex');
// arm64: nop ; mov x0, xzr ; mov x1, xzr
const GETENV_STUB_ARM64 = Buffer.from('1f2003d5e0031faae1031faa', 'hex');

function isSupportedCliExecutable(filePath) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 64) return false;
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, hdr, 0, 8, 0);
    if (bytesRead < 6) return false;
    if (hdr.readUInt32LE(0) === MH_MAGIC_64) return true;
    // 64-bit little-endian ELF (\x7fELF, EI_CLASS=2, EI_DATA=1)
    if (hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46 && hdr[4] === 2 && hdr[5] === 1) {
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Detect host `agy` CLI Mach-O (macOS) or ELF64 (Linux) binary while tracking
 * broken symlinks and strictly ignoring any path resolving inside official Antigravity.app.
 */
function detectAgyCliBinary(options = {}) {
  const home = options.homeDir || os.homedir();
  const candidates = [];
  const pushCandidate = (p) => {
    if (!p || typeof p !== 'string') return;
    const resolved = path.resolve(p);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  if (options.binaryPath) {
    pushCandidate(options.binaryPath);
  } else if (Array.isArray(options.searchPaths)) {
    for (const sp of options.searchPaths) pushCandidate(sp);
  } else {
    if (process.env.AGY_CLI_BIN) pushCandidate(process.env.AGY_CLI_BIN);
    pushCandidate(path.join(home, '.local', 'bin', 'agy'));
    pushCandidate(path.join(home, '.antigravity', 'antigravity', 'bin', 'agy'));
    pushCandidate(path.join(home, '.antigravity', 'bin', 'agy'));
    pushCandidate(path.join(home, 'bin', 'agy'));
    if (!options.homeDir) {
      if (process.platform === 'darwin') {
        pushCandidate('/opt/homebrew/bin/agy');
      }
      pushCandidate('/usr/local/bin/agy');
      pushCandidate('/usr/bin/agy');
      const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of pathDirs) {
        pushCandidate(path.join(dir, 'agy'));
      }
    }
  }

  const brokenSymlinks = [];
  let binaryPath = null;
  let realPath = null;

  for (const cand of candidates) {
    let lst = null;
    try {
      lst = fs.lstatSync(cand);
    } catch {
      continue;
    }

    if (lst.isSymbolicLink() && !fs.existsSync(cand)) {
      let target = null;
      try { target = fs.readlinkSync(cand); } catch {}
      brokenSymlinks.push({ path: cand, target });
      continue;
    }

    if (!fs.existsSync(cand)) continue;
    let resolvedReal;
    try {
      resolvedReal = fs.realpathSync(cand);
    } catch {
      continue;
    }

    if (isOfficialAntigravityPath(resolvedReal)) {
      if (!options.binaryPath) continue;
      // Preserve explicit path so applyAgyCliUnlock triggers OFFICIAL_APP_FORBIDDEN
      binaryPath = cand;
      realPath = resolvedReal;
      break;
    }

    if (!isSupportedCliExecutable(resolvedReal)) continue;

    binaryPath = cand;
    realPath = resolvedReal;
    break;
  }

  return {
    found: Boolean(binaryPath),
    binaryPath,
    realPath,
    candidatePaths: candidates,
    brokenSymlinks,
  };
}

function inspectCliBinaryLayout(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    return { ok: false, reason: '目标文件过小，非有效可执行文件' };
  }

  // Linux ELF64 LE (x86-64 / arm64, including PIE binaries with .rela.dyn firstmoduledata)
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    let elf;
    try {
      elf = parseElf64(buf);
    } catch (e) {
      return { ok: false, format: 'ELF', reason: e.message };
    }
    const goInfo = findElfGoFunctions(buf, elf, CLI_TARGET_SYMBOLS);
    if (!goInfo.foundPcln) {
      return {
        ok: false,
        format: 'ELF64',
        arch: elf.arch,
        reason: '未在 ELF 二进制中检测到 Go .gopclntab 符号表（可能已被深度 strip 或非 Go 编译）',
      };
    }
    const container = {
      format: 'ELF64',
      arch: elf.arch,
      textVA: BigInt(goInfo.goTextVA),
      textOff: goInfo.goTextOff,
      goTextSource: goInfo.goTextSource,
      elf,
    };
    return {
      ok: true,
      container,
      funcs: goInfo.funcs,
      totalSymbols: goInfo.nfunc,
      fileOffToVa: (off) => fileOffToVA(elf, off),
    };
  }

  // macOS Mach-O 64-bit LE (Apple Silicon arm64)
  if (buf.readUInt32LE(0) === MH_MAGIC_64) {
    let container;
    try {
      container = findTextSection(buf);
    } catch (e) {
      return { ok: false, format: 'Mach-O', reason: e.message };
    }
    if (container.format !== 'Mach-O' || container.arch !== 'arm64') {
      return {
        ok: false,
        format: container.format,
        arch: container.arch,
        reason: `Mach-O 仅支持 Apple Silicon ARM64（当前为 ${container.format} ${container.arch}）`,
      };
    }
    let built;
    try {
      built = buildFunctions(buf, CLI_TARGET_SYMBOLS);
    } catch (e) {
      return {
        ok: false,
        format: container.format,
        arch: container.arch,
        reason: e.message,
      };
    }
    const textVA = Number(container.textVA);
    const funcs = Object.create(null);
    for (const [key, sym] of Object.entries(built.funcs)) {
      const fnStart = container.textOff + sym.entryoff;
      funcs[key] = {
        name: sym.fullName || key,
        entryOff: sym.entryoff,
        size: sym.size,
        fnStart,
        fnEnd: fnStart + sym.size,
        fnVA: textVA + sym.entryoff,
      };
    }
    return {
      ok: true,
      container,
      funcs,
      totalSymbols: built.totalSymbols,
      fileOffToVa: (off) => textVA - container.textOff + off,
    };
  }

  return {
    ok: false,
    reason: '仅支持 macOS ARM64 Mach-O 或 Linux ELF64 (x86-64 / arm64) 可执行文件',
  };
}

function getOffersRetTrueBytes(arch) {
  if (arch === 'arm64') return RET_TRUE_ARM64;
  if (arch === 'x86-64') return RET_TRUE_X64;
  return null;
}

function inspectOffersHook(buf, container, funcs) {
  const sym = funcs[FUNC_OFFERS];
  if (!sym) {
    return { status: 'missing', symbol: FUNC_OFFERS };
  }
  const blob = getOffersRetTrueBytes(container.arch);
  if (!blob) {
    return { status: 'unknown', symbol: FUNC_OFFERS, reason: `不支持架构: ${container.arch}` };
  }
  const off = sym.fnStart;
  if (off < 0 || off + blob.length > buf.length) {
    return { status: 'unknown', symbol: FUNC_OFFERS, reason: 'entry offset out of bounds' };
  }
  const actual = buf.subarray(off, off + blob.length);
  const vaHex = '0x' + sym.fnVA.toString(16);
  if (actual.equals(blob)) {
    return { status: 'patched', symbol: FUNC_OFFERS, offset: off, va: vaHex, length: blob.length };
  }
  return {
    status: 'unpatched',
    symbol: FUNC_OFFERS,
    offset: off,
    va: vaHex,
    length: blob.length,
    origHex: actual.toString('hex'),
  };
}

function inspectAutoCompactEnvHook(buf, container, funcs, fileOffToVa) {
  if (container.arch !== 'arm64') {
    return {
      status: 'unsupported_arch',
      symbol: FUNC_OVERRIDE,
      reason: `AGY_CLI_AUTO_COMPACT_OVERRIDE 补丁仅适用于 ARM64（当前 ${container.arch} 自动跳过）`,
    };
  }

  const symOverride = funcs[FUNC_OVERRIDE];
  const symTrim = funcs[FUNC_TRIM_SPACE];
  const symGetenv = funcs[FUNC_OS_GETENV];
  const nameOff = buf.indexOf(ENV_NAME);

  const missing = [];
  if (!symOverride) missing.push(FUNC_OVERRIDE);
  if (!symTrim) missing.push(FUNC_TRIM_SPACE);
  if (!symGetenv) missing.push(FUNC_OS_GETENV);
  if (nameOff < 0) missing.push(ENV_NAME.toString('ascii'));

  if (missing.length > 0) {
    return {
      status: 'missing',
      symbol: FUNC_OVERRIDE,
      missing,
    };
  }

  const fnStart = symOverride.fnStart;
  const fnVA = symOverride.fnVA;
  const bodyLen = Math.min(Math.max(512, symOverride.size || 512), buf.length - fnStart);
  if (fnStart < 0 || bodyLen < 16) {
    return { status: 'unknown', symbol: FUNC_OVERRIDE, reason: 'function body out of bounds' };
  }

  const trimVA = symTrim.fnVA;
  const getenvVA = symGetenv.fnVA;
  const targetVA = fileOffToVa(nameOff);

  const unpatchedSites = [];
  const patchedSites = [];

  for (let rel = 0; rel <= bodyLen - 16; rel += 4) {
    const fileOff = fnStart + rel;
    if (buf.subarray(fileOff, fileOff + 12).equals(GETENV_STUB_ARM64)) {
      const blWord = buf.readUInt32LE(fileOff + 12);
      const blTarget = decodeBlArm64Target(blWord, fnVA + rel + 12);
      if (blTarget === trimVA) {
        unpatchedSites.push({ rel, fileOff, blPcVA: fnVA + rel + 12 });
      }
      continue;
    }

    try {
      const expected = [
        encodeAdrpArm64(0, fnVA + rel, targetVA),
        encodeAddImmArm64(0, 0, targetVA & 0xfff),
        encodeMovz64Arm64(1, ENV_NAME.length),
        encodeBlArm64(fnVA + rel + 12, getenvVA),
      ];
      if (
        buf.readUInt32LE(fileOff) === expected[0] &&
        buf.readUInt32LE(fileOff + 4) === expected[1] &&
        buf.readUInt32LE(fileOff + 8) === expected[2] &&
        buf.readUInt32LE(fileOff + 12) === expected[3]
      ) {
        patchedSites.push({ rel, fileOff, blPcVA: fnVA + rel + 12 });
      }
    } catch {
      // Out-of-range relative offset at this candidate position; continue scanning
    }
  }

  if (patchedSites.length >= 1) {
    return {
      status: 'patched',
      symbol: FUNC_OVERRIDE,
      offset: patchedSites[0].fileOff,
      va: '0x' + patchedSites[0].blPcVA.toString(16),
      targetVA,
      getenvVA,
    };
  }
  if (unpatchedSites.length === 1) {
    return {
      status: 'unpatched',
      symbol: FUNC_OVERRIDE,
      offset: unpatchedSites[0].fileOff,
      va: '0x' + unpatchedSites[0].blPcVA.toString(16),
      targetVA,
      getenvVA,
    };
  }
  return {
    status: 'unknown',
    symbol: FUNC_OVERRIDE,
    reason: `found ${unpatchedSites.length} unpatched stub(s) and ${patchedSites.length} patched site(s)`,
  };
}

function summarizeElfCheckpointUnlock(elfCtx) {
  if (!elfCtx || !elfCtx.ok || !elfCtx.gate3a?.ok) {
    return {
      status: 'unknown',
      ok: false,
      format: 'ELF64',
      arch: elfCtx?.arch || null,
      reason: elfCtx?.error || elfCtx?.gate3a?.reason || '未识别 ELF 上下文检查点特征',
      ...(elfCtx || {}),
    };
  }
  const g3a = elfCtx.gate3a;
  const g3b = elfCtx.gate3b;
  const g3aPatched = g3a.status !== 'unpatched';
  const g3bKnown = Boolean(g3b && g3b.ok);
  const g3bPatched = g3bKnown ? g3b.status === 'patched' : null;

  let status = 'not_patched';
  if (g3aPatched && (g3bPatched === true || g3bPatched === null)) {
    status = 'patched';
  } else if (!g3aPatched && (g3bPatched === false || g3bPatched === null)) {
    status = 'not_patched';
  } else {
    status = 'partial_match';
  }

  return {
    ...elfCtx,
    status,
    configuredMode: g3a.mode,
    configuredLimitTokens: g3a.mode === 'fixed' ? g3a.limitTokens : null,
  };
}

function analyzeAgyCli(binaryPathOrOpts = null, maybeOpts = {}) {
  let binaryPath = binaryPathOrOpts;
  let options = maybeOpts;
  if (binaryPathOrOpts && typeof binaryPathOrOpts === 'object' && !Buffer.isBuffer(binaryPathOrOpts)) {
    options = binaryPathOrOpts;
    binaryPath = options.binaryPath || null;
  }

  const detected = binaryPath
    ? detectAgyCliBinary({ ...options, binaryPath })
    : detectAgyCliBinary(options);
  const configStatus = readExternalContextConfig(options);

  if (!detected.found || !detected.realPath) {
    return {
      ok: true,
      found: false,
      status: 'not_found',
      binaryPath: binaryPath || null,
      brokenSymlinks: detected.brokenSymlinks,
      candidatePaths: detected.candidatePaths,
      configStatus,
      message: detected.brokenSymlinks.length > 0
        ? `检测到 ${detected.brokenSymlinks.length} 个失效的 agy 软链接，未找到可用的 agy CLI 二进制`
        : '未检测到本机 agy CLI 二进制（跳过二进制修补，仍可同步上下文配置文件）',
    };
  }

  const realTarget = detected.realPath;
  if (isOfficialAntigravityPath(realTarget)) {
    return {
      ok: true,
      found: true,
      isOfficialProtected: true,
      status: 'unsupported',
      binaryPath: detected.binaryPath,
      realPath: realTarget,
      brokenSymlinks: detected.brokenSymlinks,
      configStatus,
      reason: `目标位于官方 Antigravity.app 受保护目录: ${realTarget}`,
    };
  }

  const buf = fs.readFileSync(realTarget);
  const layout = inspectCliBinaryLayout(buf);
  if (!layout.ok) {
    return {
      ok: true,
      found: true,
      status: 'unsupported',
      format: layout.format || null,
      arch: layout.arch || null,
      binaryPath: detected.binaryPath,
      realPath: realTarget,
      brokenSymlinks: detected.brokenSymlinks,
      configStatus,
      reason: layout.reason,
    };
  }

  const { container, funcs, totalSymbols, fileOffToVa } = layout;

  const offersContextWindow = inspectOffersHook(buf, container, funcs);
  const autoCompactEnv = inspectAutoCompactEnvHook(buf, container, funcs, fileOffToVa);

  let regionUnlock = null;
  if (funcs[FUNC_REGION]) {
    try {
      regionUnlock = container.format === 'ELF64'
        ? analyzeElfRegionUnlock(buf)
        : analyzeRegionUnlock(buf, { quiet: true });
    } catch (e) {
      regionUnlock = { ok: false, status: 'error', reason: e.message };
    }
  }

  let checkpointUnlock = null;
  if (funcs[FUNC_CHECKPOINT]) {
    try {
      checkpointUnlock = container.format === 'ELF64'
        ? summarizeElfCheckpointUnlock(analyzeElfContextUnlock(buf))
        : analyzeContextCheckpointBinary(realTarget, {
            skipProcessCheck: true,
            backupDir: options.backupDir,
          });
    } catch (e) {
      checkpointUnlock = { ok: false, status: 'error', reason: e.message };
    }
  }

  let status = 'unknown';
  if (offersContextWindow.status === 'missing') {
    status = 'unsupported';
  } else {
    const tracked = [offersContextWindow.status];
    if (autoCompactEnv.status === 'patched' || autoCompactEnv.status === 'unpatched') {
      tracked.push(autoCompactEnv.status);
    }
    if (regionUnlock && (regionUnlock.status === 'patched' || regionUnlock.status === 'unpatched')) {
      tracked.push(regionUnlock.status);
    }
    if (tracked.every((s) => s === 'patched')) {
      status = 'patched';
    } else if (tracked.some((s) => s === 'patched')) {
      status = 'partial';
    } else if (tracked.every((s) => s === 'unpatched' || s === 'unknown')) {
      status = 'unpatched';
    }
  }

  return {
    ok: true,
    found: true,
    status,
    format: container.format,
    arch: container.arch,
    goTextSource: container.goTextSource || null,
    binaryPath: detected.binaryPath,
    realPath: realTarget,
    sha256: sha256Buffer(buf),
    totalSymbols,
    offersContextWindow,
    autoCompactEnv,
    regionUnlock,
    checkpointUnlock,
    brokenSymlinks: detected.brokenSymlinks,
    configStatus,
  };
}

function getCliBackupDir(options = {}) {
  if (options.backupDir) {
    if (!fs.existsSync(options.backupDir)) fs.mkdirSync(options.backupDir, { recursive: true });
    return options.backupDir;
  }
  const baseDir = options.stateDir || getStateDir();
  const dir = path.join(baseDir, 'backups', 'cli-unlock');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCliGate3BSidecarPath(options = {}) {
  return path.join(getCliBackupDir(options), 'gate3b-sidecar.json');
}

function readCliGate3BOrigHex(targetPath, gate3bOffset, options = {}) {
  try {
    const p = getCliGate3BSidecarPath(options);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const key = `${path.resolve(targetPath)}@${gate3bOffset}`;
    const entry = data && data[key];
    return entry && typeof entry.origHex === 'string' ? entry.origHex : null;
  } catch {
    return null;
  }
}

function saveCliGate3BOrigHex(targetPath, gate3bOffset, origHex, options = {}) {
  if (!origHex) return;
  try {
    const p = getCliGate3BSidecarPath(options);
    let data = {};
    if (fs.existsSync(p)) {
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      } catch {
        data = {};
      }
    }
    const key = `${path.resolve(targetPath)}@${gate3bOffset}`;
    if (data[key]?.origHex === origHex) return;
    data[key] = { origHex, updatedAt: new Date().toISOString() };
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch {}
}

function applyMachOArm64CheckpointToBuffer(buf, checkpointUnlock, modeSpec, realTarget, options) {
  const gate3a = checkpointUnlock?.gate3a;
  const gate3b = checkpointUnlock?.gate3b;
  if (!gate3a || (gate3a.status !== 'unpatched' && gate3a.status !== 'patched')) {
    return { applied: false, changed: false };
  }
  const hasGate3b = Boolean(gate3b && (gate3b.status === 'unpatched' || gate3b.status === 'patched'));
  let origGate3bHex = hasGate3b && gate3b.status === 'unpatched' && gate3b.origHex
    ? gate3b.origHex
    : (hasGate3b ? readCliGate3BOrigHex(realTarget, gate3b.offset, options) : null);

  let changed = false;
  const writeSlice = (offset, bytes) => {
    if (!buf.subarray(offset, offset + bytes.length).equals(bytes)) {
      bytes.copy(buf, offset);
      changed = true;
    }
  };

  if (modeSpec.mode === 'default') {
    writeSlice(gate3a.offset, CLAMP_256K_ARM64);
    if (gate3a.hasDefaultSite && Number.isInteger(gate3a.defaultOffset)) {
      writeSlice(gate3a.defaultOffset, DEF_ORIG_ARM64);
    }
    if (hasGate3b && gate3b.status === 'patched' && origGate3bHex) {
      const orig = Buffer.from(origGate3bHex, 'hex');
      if (orig.length === 4) writeSlice(gate3b.offset, orig);
    }
  } else if (modeSpec.mode === 'fixed') {
    writeSlice(gate3a.offset, buildClampConstArm64(modeSpec.limitTokens));
    if (gate3a.hasDefaultSite && Number.isInteger(gate3a.defaultOffset)) {
      writeSlice(gate3a.defaultOffset, buildDefConstArm64(modeSpec.limitTokens));
    }
    if (hasGate3b && gate3b.status === 'unpatched') {
      writeSlice(gate3b.offset, NOP_ARM64);
    }
  } else {
    writeSlice(gate3a.offset, PATCH_256K_ARM64);
    if (gate3a.hasDefaultSite && Number.isInteger(gate3a.defaultOffset)) {
      writeSlice(gate3a.defaultOffset, DEF_ORIG_ARM64);
    }
    if (hasGate3b && gate3b.status === 'unpatched') {
      writeSlice(gate3b.offset, NOP_ARM64);
    }
  }

  if (hasGate3b && origGate3bHex && options.skipBackup !== true) {
    saveCliGate3BOrigHex(realTarget, gate3b.offset, origGate3bHex, options);
  }
  return { applied: true, changed };
}

function normalizeCliModeAndLimit(options = {}) {
  const hasLimit = options.limitTokens !== undefined && options.limitTokens !== null && options.limitTokens !== '';
  const rawMode = options.mode ? String(options.mode).trim().toLowerCase() : (hasLimit ? 'fixed' : 'dynamic');
  if (rawMode === 'default' || rawMode === 'orig' || rawMode === 'official') {
    return { ok: true, mode: 'default', limitTokens: DEFAULT_CHECKPOINT_TOKENS };
  }
  if (rawMode === 'dynamic' || rawMode === 'dyn' || rawMode === 'passthrough') {
    return { ok: true, mode: 'dynamic', limitTokens: null };
  }
  if (rawMode === 'fixed' || rawMode === 'const' || rawMode === 'custom') {
    const check = validateContextLimit(options.limitTokens);
    if (!check.ok) return { ok: false, error: check.error, code: 'INVALID_LIMIT' };
    return { ok: true, mode: 'fixed', limitTokens: check.limitTokens };
  }
  return { ok: false, error: `未知上下文模式: ${options.mode}`, code: 'INVALID_MODE' };
}

function applyAgyCliUnlock(options = {}) {
  const modeSpec = normalizeCliModeAndLimit(options);
  if (!modeSpec.ok) {
    return { ok: false, code: modeSpec.code, error: modeSpec.error };
  }

  if (options.binaryPath) {
    try {
      assertNotOfficialAntigravityApp(options.binaryPath, 'patch agy CLI');
    } catch (e) {
      return { ok: false, code: 'OFFICIAL_APP_FORBIDDEN', error: e.message };
    }
  }

  const syncOpts = {
    ...options,
    syncConfigFiles: options.syncConfigFiles !== false,
    syncCliConfigs: true,
  };

  const pre = analyzeAgyCli(options.binaryPath || null, options);
  if (!pre.found) {
    if (options.strict) {
      return {
        ok: false,
        code: 'CLI_NOT_FOUND',
        error: pre.message,
        brokenSymlinks: pre.brokenSymlinks,
      };
    }
    const syncedConfigs = syncExternalContextConfigs(modeSpec.mode, modeSpec.limitTokens, syncOpts);
    return {
      ok: true,
      found: false,
      skippedBinary: true,
      brokenSymlinks: pre.brokenSymlinks,
      syncedConfigs,
      configStatus: readExternalContextConfig(options),
      message: syncedConfigs.length > 0
        ? `未检测到可用 agy CLI 二进制，已同步 ${syncedConfigs.length} 处 CLI 上下文配置文件`
        : pre.message,
    };
  }

  const realTarget = pre.realPath;
  try {
    assertNotOfficialAntigravityApp(realTarget, 'patch agy CLI');
  } catch (e) {
    return { ok: false, code: 'OFFICIAL_APP_FORBIDDEN', error: e.message };
  }

  if (pre.status === 'unsupported') {
    return {
      ok: false,
      code: 'UNSUPPORTED_CLI_BINARY',
      error: pre.reason || '目标 agy CLI 二进制缺少必要符号或架构不兼容',
      analysis: pre,
    };
  }

  if (pre.regionUnlock && !pre.regionUnlock.ok) {
    return {
      ok: false,
      code: pre.regionUnlock.code || 'REGION_ANALYSIS_FAILED',
      error: pre.regionUnlock.error || pre.regionUnlock.reason || 'CLI 地区检查无法安全匹配',
      analysis: pre,
    };
  }

  const buf = Buffer.from(fs.readFileSync(realTarget));
  const beforeSha = sha256Buffer(buf);
  let backupPath = null;
  if (options.skipBackup !== true && pre.status !== 'patched') {
    const bDir = getCliBackupDir(options);
    backupPath = path.join(bDir, `${path.basename(realTarget)}_${beforeSha.slice(0, 12)}.orig`);
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(realTarget, backupPath);
    }
  }

  const patchedHooks = [];
  const skippedHooks = [];

  if (pre.offersContextWindow.status === 'unpatched') {
    const retTrue = getOffersRetTrueBytes(pre.arch);
    retTrue.copy(buf, pre.offersContextWindow.offset);
    patchedHooks.push('offersContextWindow');
  }

  if (pre.autoCompactEnv.status === 'unpatched') {
    const { offset, va, targetVA, getenvVA } = pre.autoCompactEnv;
    const siteVA = parseInt(va, 16) - 12;
    const blPcVA = siteVA + 12;
    const words = [
      encodeAdrpArm64(0, siteVA, targetVA),
      encodeAddImmArm64(0, 0, targetVA & 0xfff),
      encodeMovz64Arm64(1, ENV_NAME.length),
      encodeBlArm64(blPcVA, getenvVA),
    ];
    for (let k = 0; k < 4; k++) {
      buf.writeUInt32LE(words[k], offset + k * 4);
    }
    patchedHooks.push('autoCompactEnv');
  } else if (
    pre.autoCompactEnv.status === 'missing' ||
    pre.autoCompactEnv.status === 'unknown' ||
    pre.autoCompactEnv.status === 'unsupported_arch'
  ) {
    skippedHooks.push(`autoCompactEnv (${pre.autoCompactEnv.status})`);
  }

  if (pre.regionUnlock && pre.regionUnlock.status === 'unpatched') {
    if (pre.format === 'ELF64') {
      const { branchOffset, currentBytes, patchedBytes } = pre.regionUnlock;
      if (
        !Number.isInteger(branchOffset) ||
        branchOffset < 0 ||
        !Buffer.isBuffer(currentBytes) ||
        !Buffer.isBuffer(patchedBytes) ||
        currentBytes.length !== patchedBytes.length ||
        branchOffset + patchedBytes.length > buf.length ||
        !buf.subarray(branchOffset, branchOffset + currentBytes.length).equals(currentBytes)
      ) {
        return { ok: false, code: 'REGION_SITE_CHANGED', error: 'CLI 地区分支与分析结果不一致，停止处理' };
      }
      patchedBytes.copy(buf, branchOffset);
      const verified = analyzeElfRegionUnlock(buf);
      if (!verified.ok || verified.status !== 'patched' || verified.branchOffset !== branchOffset) {
        return { ok: false, code: 'REGION_VERIFY_FAILED', error: 'CLI 地区补丁内存校验失败，停止处理' };
      }
      patchedHooks.push('ValidateAndOnboardAccount');
    } else {
      const { branchOffset, patchedWord, currentWord } = pre.regionUnlock;
      if (!Number.isInteger(branchOffset) || branchOffset < 0 || branchOffset + 4 > buf.length ||
          !Number.isInteger(patchedWord) || buf.readUInt32LE(branchOffset) !== currentWord) {
        return { ok: false, code: 'REGION_SITE_CHANGED', error: 'CLI 地区分支与分析结果不一致，停止处理' };
      }
      buf.writeUInt32LE(patchedWord >>> 0, branchOffset);
      const verified = analyzeRegionUnlock(buf);
      if (!verified.ok || verified.status !== 'patched' || verified.branchOffset !== branchOffset) {
        return { ok: false, code: 'REGION_VERIFY_FAILED', error: 'CLI 地区补丁内存校验失败，停止处理' };
      }
      patchedHooks.push('ValidateAndOnboardAccount');
    }
  }

  if (pre.checkpointUnlock) {
    if (pre.format === 'ELF64') {
      if (pre.checkpointUnlock.ok && pre.checkpointUnlock.gate3a?.ok) {
        const g3b = pre.checkpointUnlock.gate3b;
        const savedOrigHex = g3b && g3b.ok
          ? (g3b.origHex || readCliGate3BOrigHex(realTarget, g3b.offset, options))
          : null;
        const elfCtx = patchElfBuffer(buf, {
          region: false,
          context: true,
          mode: modeSpec.mode,
          limitTokens: modeSpec.limitTokens,
          origGate3bHex: savedOrigHex,
        });
        if (elfCtx.ok) {
          if (elfCtx.origGate3bHex && g3b && g3b.ok && options.skipBackup !== true) {
            saveCliGate3BOrigHex(realTarget, g3b.offset, elfCtx.origGate3bHex, options);
          }
          if (elfCtx.modified) {
            elfCtx.buffer.copy(buf);
            patchedHooks.push('checkpointConfig');
          }
        } else {
          skippedHooks.push('checkpointConfig (patch_failed)');
        }
      } else {
        skippedHooks.push(`checkpointConfig (${pre.checkpointUnlock.status || 'unknown'})`);
      }
    } else if (pre.format === 'Mach-O') {
      const macCtx = applyMachOArm64CheckpointToBuffer(buf, pre.checkpointUnlock, modeSpec, realTarget, options);
      if (macCtx.applied) {
        if (macCtx.changed) patchedHooks.push('checkpointConfig');
      } else {
        skippedHooks.push(`checkpointConfig (${pre.checkpointUnlock.status || 'unknown'})`);
      }
    }
  }

  const afterSha = sha256Buffer(buf);
  let signed = false;
  let changed = afterSha !== beforeSha;
  if (changed) {
    const writeRes = atomicWriteBinary(realTarget, buf, 'cli', {
      skipCodesign: options.skipCodesign,
      codesign: pre.format === 'Mach-O',
    });
    if (!writeRes.ok) {
      return { ok: false, error: writeRes.error };
    }
    signed = Boolean(writeRes.signed);
  }

  const syncedConfigs = syncExternalContextConfigs(modeSpec.mode, modeSpec.limitTokens, syncOpts);
  const afterAnalysis = analyzeAgyCli(realTarget, options);

  return {
    ok: true,
    found: true,
    format: pre.format,
    arch: pre.arch,
    targetPath: realTarget,
    binaryPath: pre.binaryPath,
    changed,
    alreadyPatched: !changed && afterAnalysis.status === 'patched',
    signed,
    backupPath,
    patchedHooks,
    skippedHooks,
    syncedConfigs,
    beforeSha256: beforeSha,
    afterSha256: afterSha,
    analysis: afterAnalysis,
    message: changed
      ? `已完成 agy CLI (${pre.format} ${pre.arch}) 修补 (${patchedHooks.join(', ')}) 并同步配置`
      : `agy CLI (${pre.format} ${pre.arch}) 已处于解锁状态，已同步上下文配置文件`,
  };
}

module.exports = {
  FUNC_OFFERS,
  FUNC_OVERRIDE,
  ENV_NAME,
  RET_TRUE_ARM64,
  RET_TRUE_X64,
  GETENV_STUB_ARM64,
  encodeAdrpArm64,
  encodeAddImmArm64,
  encodeMovz64Arm64,
  encodeBlArm64,
  decodeBlArm64Target,
  detectAgyCliBinary,
  analyzeAgyCli,
  applyAgyCliUnlock,
};
