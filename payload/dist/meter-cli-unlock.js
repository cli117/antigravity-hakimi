'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getStateDir,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');
const { sha256Buffer } = require('./binary-utils');
const {
  parseMachOTextSection,
  findGoFunction,
  analyzeRegionUnlock,
} = require('./meter-region-unlock');
const {
  parseElf64,
  findElfGoFunctions,
  analyzeElfRegionUnlock,
} = require('./meter-ssh');

const MH_MAGIC_64 = 0xfeedfacf;
const FUNC_REGION = 'authclient.ValidateAndOnboardAccount';

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
    const goInfo = findElfGoFunctions(buf, elf, [FUNC_REGION]);
    if (!goInfo.foundPcln) {
      return {
        ok: false,
        format: 'ELF64',
        arch: elf.arch,
        reason: '未在 ELF 二进制中检测到 Go .gopclntab 符号表（可能已被深度 strip 或非 Go 编译）',
      };
    }
    return {
      ok: true,
      container: {
        format: 'ELF64',
        arch: elf.arch,
        goTextSource: goInfo.goTextSource,
      },
      funcs: goInfo.funcs,
      totalSymbols: goInfo.nfunc,
    };
  }

  // macOS Mach-O 64-bit LE (Apple Silicon arm64 / Intel x86_64)
  if (buf.readUInt32LE(0) === MH_MAGIC_64) {
    let macho;
    try {
      macho = parseMachOTextSection(buf);
    } catch (e) {
      return { ok: false, format: 'Mach-O', reason: e.message };
    }
    const fn = findGoFunction(buf, macho.textOff, FUNC_REGION, macho.arch);
    if (!fn.foundPcln) {
      return {
        ok: false,
        format: 'Mach-O',
        arch: macho.arch,
        reason: '未在 Mach-O 二进制中检测到 Go .gopclntab 符号表',
      };
    }
    const funcs = Object.create(null);
    if (fn.name) funcs[FUNC_REGION] = fn;
    return {
      ok: true,
      container: {
        format: 'Mach-O',
        arch: macho.arch,
        goTextSource: null,
      },
      funcs,
      totalSymbols: fn.nfunc || 0,
    };
  }

  return {
    ok: false,
    reason: '仅支持 macOS Mach-O (arm64 / x86_64) 或 Linux ELF64 (x86-64 / arm64) 可执行文件',
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

  if (!detected.found || !detected.realPath) {
    return {
      ok: true,
      found: false,
      status: 'not_found',
      binaryPath: binaryPath || null,
      brokenSymlinks: detected.brokenSymlinks,
      candidatePaths: detected.candidatePaths,
      message: detected.brokenSymlinks.length > 0
        ? `检测到 ${detected.brokenSymlinks.length} 个失效的 agy 软链接，未找到可用的 agy CLI 二进制`
        : '未检测到本机 agy CLI 二进制',
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
      reason: layout.reason,
    };
  }

  const { container, funcs, totalSymbols } = layout;

  let regionUnlock = null;
  if (funcs[FUNC_REGION]) {
    try {
      regionUnlock = container.format === 'ELF64'
        ? analyzeElfRegionUnlock(buf)
        : analyzeRegionUnlock(buf);
    } catch (e) {
      regionUnlock = { ok: false, status: 'error', reason: e.message };
    }
  }

  let status = 'unsupported';
  let reason = null;
  if (!regionUnlock) {
    status = 'unsupported';
    reason = `目标 agy CLI 缺少 ${FUNC_REGION} 符号`;
  } else if (regionUnlock.status === 'patched') {
    status = 'patched';
  } else if (regionUnlock.status === 'unpatched') {
    status = 'unpatched';
  } else {
    status = 'unknown';
    reason = regionUnlock.error || regionUnlock.reason || null;
  }

  return {
    ok: true,
    found: true,
    status,
    ...(reason ? { reason } : {}),
    format: container.format,
    arch: container.arch,
    goTextSource: container.goTextSource || null,
    binaryPath: detected.binaryPath,
    realPath: realTarget,
    sha256: sha256Buffer(buf),
    totalSymbols,
    regionUnlock,
    brokenSymlinks: detected.brokenSymlinks,
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

function atomicWriteCliBinary(targetPath, dataBuf, options = {}) {
  assertNotOfficialAntigravityApp(targetPath, 'write agy CLI binary');
  const stat = fs.statSync(targetPath);
  const tmpPath = `${targetPath}.hakimi_cli_tmp_${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, dataBuf);
    fs.chmodSync(tmpPath, stat.mode & 0o777);
    fs.renameSync(tmpPath, targetPath);

    let signed = false;
    if (options.codesign === true && options.skipCodesign !== true && process.platform === 'darwin') {
      execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', targetPath], { stdio: 'pipe' });
      execFileSync('codesign', ['--verify', '--strict', targetPath], { stdio: 'pipe' });
      signed = true;
    }
    return { ok: true, signed };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return { ok: false, error: err.message || String(err) };
  }
}

function applyAgyCliUnlock(options = {}) {
  if (options.binaryPath) {
    try {
      assertNotOfficialAntigravityApp(options.binaryPath, 'patch agy CLI');
    } catch (e) {
      return { ok: false, code: 'OFFICIAL_APP_FORBIDDEN', error: e.message };
    }
  }

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
    return {
      ok: true,
      found: false,
      skippedBinary: true,
      brokenSymlinks: pre.brokenSymlinks,
      message: pre.message,
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

  if (!pre.regionUnlock || !pre.regionUnlock.ok) {
    return {
      ok: false,
      code: pre.regionUnlock?.code || 'REGION_ANALYSIS_FAILED',
      error: pre.regionUnlock?.error || pre.regionUnlock?.reason || 'CLI 地区检查无法安全匹配',
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

  if (pre.regionUnlock.status === 'unpatched') {
    const isElf = pre.format === 'ELF64';
    const { branchOffset, patchedBytes } = pre.regionUnlock;
    // ARM64 Mach-O patches a single 4-byte instruction word; x86-64 patches 2 or 6 bytes.
    const currentBytes =
      pre.regionUnlock.currentBytes ||
      (Number.isInteger(pre.regionUnlock.currentWord)
        ? (() => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(pre.regionUnlock.currentWord >>> 0, 0);
            return b;
          })()
        : null);
    const nextBytes =
      patchedBytes ||
      (Number.isInteger(pre.regionUnlock.patchedWord)
        ? (() => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(pre.regionUnlock.patchedWord >>> 0, 0);
            return b;
          })()
        : null);

    if (
      !Number.isInteger(branchOffset) ||
      branchOffset < 0 ||
      !Buffer.isBuffer(currentBytes) ||
      !Buffer.isBuffer(nextBytes) ||
      currentBytes.length !== nextBytes.length ||
      branchOffset + nextBytes.length > buf.length ||
      !buf.subarray(branchOffset, branchOffset + currentBytes.length).equals(currentBytes)
    ) {
      return { ok: false, code: 'REGION_SITE_CHANGED', error: 'CLI 地区分支与分析结果不一致，停止处理' };
    }
    nextBytes.copy(buf, branchOffset);
    const verified = isElf ? analyzeElfRegionUnlock(buf) : analyzeRegionUnlock(buf);
    if (!verified.ok || verified.status !== 'patched' || verified.branchOffset !== branchOffset) {
      return { ok: false, code: 'REGION_VERIFY_FAILED', error: 'CLI 地区补丁内存校验失败，停止处理' };
    }
    patchedHooks.push('ValidateAndOnboardAccount');
  }

  const afterSha = sha256Buffer(buf);
  let signed = false;
  const changed = afterSha !== beforeSha;
  if (changed) {
    const writeRes = atomicWriteCliBinary(realTarget, buf, {
      skipCodesign: options.skipCodesign,
      codesign: pre.format === 'Mach-O',
    });
    if (!writeRes.ok) {
      return { ok: false, error: writeRes.error };
    }
    signed = Boolean(writeRes.signed);
  }

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
    beforeSha256: beforeSha,
    afterSha256: afterSha,
    analysis: afterAnalysis,
    message: changed
      ? `已完成 agy CLI (${pre.format} ${pre.arch}) 地区解锁 (${patchedHooks.join(', ')})`
      : `agy CLI (${pre.format} ${pre.arch}) 已处于地区解锁状态`,
  };
}

module.exports = {
  FUNC_REGION,
  detectAgyCliBinary,
  analyzeAgyCli,
  applyAgyCliUnlock,
};
