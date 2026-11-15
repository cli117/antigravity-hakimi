'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  getStateDir,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');
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

const MH_MAGIC_64 = 0xfeedfacf;
const ENV_NAME = Buffer.from('AGY_CLI_AUTO_COMPACT_OVERRIDE', 'ascii');

const FUNC_OFFERS = 'model.SelectorModel.offersContextWindow';
const FUNC_OVERRIDE = 'store.AutoCompactOverride';
const FUNC_TRIM_SPACE = 'strings.TrimSpace';
const FUNC_OS_GETENV = 'os.Getenv';
const FUNC_CHECKPOINT = 'utils.GetCheckpointConfig';
const FUNC_REGION = 'authclient.ValidateAndOnboardAccount';

// arm64: mov w0, #1 ; ret
const RET_TRUE_ARM64 = Buffer.from('20008052c0035fd6', 'hex');
// arm64: nop ; mov x0, xzr ; mov x1, xzr
const GETENV_STUB_ARM64 = Buffer.from('1f2003d5e0031faae1031faa', 'hex');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

function isMachOFile(filePath) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 64) return false;
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, hdr, 0, 4, 0);
    if (bytesRead < 4) return false;
    return hdr.readUInt32LE(0) === MH_MAGIC_64;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Detect host `agy` CLI Mach-O binary while tracking broken symlinks and
 * strictly ignoring any path resolving inside official Antigravity.app.
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
    if (!options.homeDir) {
      pushCandidate('/opt/homebrew/bin/agy');
      pushCandidate('/usr/local/bin/agy');
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

    if (!isMachOFile(resolvedReal)) continue;

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

function inspectOffersHook(buf, container, funcs) {
  const sym = funcs[FUNC_OFFERS];
  if (!sym) {
    return { status: 'missing', symbol: FUNC_OFFERS };
  }
  const off = container.textOff + sym.entryoff;
  if (off < 0 || off + RET_TRUE_ARM64.length > buf.length) {
    return { status: 'unknown', symbol: FUNC_OFFERS, reason: 'entry offset out of bounds' };
  }
  const actual = buf.subarray(off, off + RET_TRUE_ARM64.length);
  const vaHex = '0x' + (Number(container.textVA) + sym.entryoff).toString(16);
  if (actual.equals(RET_TRUE_ARM64)) {
    return { status: 'patched', symbol: FUNC_OFFERS, offset: off, va: vaHex };
  }
  return {
    status: 'unpatched',
    symbol: FUNC_OFFERS,
    offset: off,
    va: vaHex,
    origHex: actual.toString('hex'),
  };
}

function inspectAutoCompactEnvHook(buf, container, funcs) {
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

  const textVA = Number(container.textVA);
  const fnStart = container.textOff + symOverride.entryoff;
  const fnVA = textVA + symOverride.entryoff;
  const bodyLen = Math.min(Math.max(512, symOverride.size || 512), buf.length - fnStart);
  if (fnStart < 0 || bodyLen < 16) {
    return { status: 'unknown', symbol: FUNC_OVERRIDE, reason: 'function body out of bounds' };
  }

  const trimVA = textVA + symTrim.entryoff;
  const getenvVA = textVA + symGetenv.entryoff;
  const targetVA = textVA - container.textOff + nameOff;

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

    const expected = [
      encodeAdrpArm64(0, fnVA + rel, targetVA),
      encodeAddImmArm64(0, 0, targetVA % 4096),
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
  let container;
  try {
    container = findTextSection(buf);
  } catch (e) {
    return {
      ok: true,
      found: true,
      status: 'unsupported',
      binaryPath: detected.binaryPath,
      realPath: realTarget,
      brokenSymlinks: detected.brokenSymlinks,
      configStatus,
      reason: e.message,
    };
  }

  if (container.format !== 'Mach-O' || container.arch !== 'arm64') {
    return {
      ok: true,
      found: true,
      status: 'unsupported',
      format: container.format,
      arch: container.arch,
      binaryPath: detected.binaryPath,
      realPath: realTarget,
      brokenSymlinks: detected.brokenSymlinks,
      configStatus,
      reason: `仅支持 Apple Silicon ARM64 Mach-O（当前为 ${container.format} ${container.arch}）`,
    };
  }

  let funcs;
  let totalSymbols = 0;
  try {
    const built = buildFunctions(buf, [
      FUNC_OFFERS,
      FUNC_OVERRIDE,
      FUNC_TRIM_SPACE,
      FUNC_OS_GETENV,
      FUNC_CHECKPOINT,
      FUNC_REGION,
    ]);
    funcs = built.funcs;
    totalSymbols = built.totalSymbols;
  } catch (e) {
    return {
      ok: true,
      found: true,
      status: 'unsupported',
      format: container.format,
      arch: container.arch,
      binaryPath: detected.binaryPath,
      realPath: realTarget,
      brokenSymlinks: detected.brokenSymlinks,
      configStatus,
      reason: e.message,
    };
  }

  const offersContextWindow = inspectOffersHook(buf, container, funcs);
  const autoCompactEnv = inspectAutoCompactEnvHook(buf, container, funcs);

  let regionUnlock = null;
  if (funcs[FUNC_REGION]) {
    try {
      regionUnlock = analyzeRegionUnlock(buf, { quiet: true });
    } catch (e) {
      regionUnlock = { status: 'error', reason: e.message };
    }
  }

  let checkpointUnlock = null;
  if (funcs[FUNC_CHECKPOINT]) {
    try {
      checkpointUnlock = analyzeContextCheckpointBinary(realTarget, {
        skipProcessCheck: true,
        backupDir: options.backupDir,
      });
    } catch (e) {
      checkpointUnlock = { status: 'error', reason: e.message };
    }
  }

  let status = 'unknown';
  if (offersContextWindow.status === 'missing') {
    status = 'unsupported';
  } else {
    const tracked = [offersContextWindow.status];
    if (autoCompactEnv.status !== 'missing') tracked.push(autoCompactEnv.status);
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
    RET_TRUE_ARM64.copy(buf, pre.offersContextWindow.offset);
    patchedHooks.push('offersContextWindow');
  }

  if (pre.autoCompactEnv.status === 'unpatched') {
    const { offset, va, targetVA, getenvVA } = pre.autoCompactEnv;
    const siteVA = parseInt(va, 16) - 12;
    const blPcVA = siteVA + 12;
    const words = [
      encodeAdrpArm64(0, siteVA, targetVA),
      encodeAddImmArm64(0, 0, targetVA % 4096),
      encodeMovz64Arm64(1, ENV_NAME.length),
      encodeBlArm64(blPcVA, getenvVA),
    ];
    for (let k = 0; k < 4; k++) {
      buf.writeUInt32LE(words[k], offset + k * 4);
    }
    patchedHooks.push('autoCompactEnv');
  } else if (pre.autoCompactEnv.status === 'missing' || pre.autoCompactEnv.status === 'unknown') {
    skippedHooks.push(`autoCompactEnv (${pre.autoCompactEnv.status})`);
  }

  if (pre.regionUnlock && pre.regionUnlock.status === 'unpatched') {
    const site = pre.regionUnlock.targetSite;
    if (site && Number.isInteger(site.branchFileOff) && Number.isInteger(site.patchWord)) {
      buf.writeUInt32LE(site.patchWord >>> 0, site.branchFileOff);
      patchedHooks.push('ValidateAndOnboardAccount');
    }
  }

  const afterSha = sha256Buffer(buf);
  let signed = false;
  let changed = afterSha !== beforeSha;
  if (changed) {
    const writeRes = atomicWriteBinary(realTarget, buf, 'cli', {
      skipCodesign: options.skipCodesign,
      codesign: true,
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
      ? `已完成 agy CLI 修补 (${patchedHooks.join(', ')}) 并同步配置`
      : 'agy CLI 已处于解锁状态，已同步上下文配置文件',
  };
}

module.exports = {
  FUNC_OFFERS,
  FUNC_OVERRIDE,
  ENV_NAME,
  RET_TRUE_ARM64,
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
