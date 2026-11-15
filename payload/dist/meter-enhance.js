'use strict';
/**
 * 哈基米.app 内核轻量化增强引擎 (meter-enhance.js)
 * 说明：
 * 1. 已彻底移除系统提示词改写与会话/章节标题提示词改写，绝不修改任何模型 Prompt 字符串；
 * 2. 专注上下文窗口调整委托及 language_server 进程检测与重启；
 * 3. 严格只操作 哈基米.app 副本的 language_server，绝不修改 /Applications/Antigravity.app。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const contextUnlock = require('./meter-context-unlock');
const {
  getHakimiAppPath,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');

function resolveTargetBinaries(options = {}) {
  if (Array.isArray(options.targets)) {
    return options.targets.map((t, idx) => {
      const targetPath = path.resolve(String(t.path || t));
      assertNotOfficialAntigravityApp(targetPath, 'target enhance binary');
      return {
        id: t.id || (idx === 0 ? 'desktop' : 'custom'),
        label: t.label || path.basename(targetPath),
        path: targetPath,
      };
    });
  }

  const hakimiApp = options.appPath ? path.resolve(options.appPath) : getHakimiAppPath();
  assertNotOfficialAntigravityApp(hakimiApp, 'target app bundle');

  const binDir = path.join(hakimiApp, 'Contents', 'Resources', 'bin');
  const primary = path.join(binDir, 'language_server');
  const alt = path.join(binDir, 'language_server_macos_arm');

  if (fs.existsSync(alt) && !fs.existsSync(primary)) {
    return [{ id: 'desktop', label: '哈基米.app 后端 (language_server_macos_arm)', path: alt }];
  }
  return [{ id: 'desktop', label: '哈基米.app 后端 (language_server)', path: primary }];
}

function findMatchingLanguageServerPids(targetPaths) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  const normTargets = new Set(
    (Array.isArray(targetPaths) ? targetPaths : [])
      .filter((p) => p && !isOfficialAntigravityPath(p))
      .map((p) => {
        try {
          return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
        } catch {
          return path.resolve(p);
        }
      })
  );
  if (normTargets.size === 0) return [];

  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 2500,
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', LC_TIME: 'C' },
    });
    const hits = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2].trim();
      for (const tp of normTargets) {
        if (cmd === tp || cmd.startsWith(tp + ' ')) {
          hits.push({ pid, target: tp });
          break;
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function checkLanguageServerRunning(options = {}) {
  try {
    const targets = resolveTargetBinaries(options).map((t) => t.path);
    return findMatchingLanguageServerPids(targets).length > 0;
  } catch {
    return false;
  }
}

function restartLanguageServers(options = {}) {
  if (process.platform !== 'darwin') {
    return { ok: false, killed: [], error: '仅支持 macOS 平台重启 哈基米.app 后台语言服务' };
  }
  const targets = resolveTargetBinaries(options).map((t) => t.path);
  const hits = findMatchingLanguageServerPids(targets);
  const killed = [];
  for (const h of hits) {
    try {
      process.kill(h.pid, 'SIGTERM');
      killed.push(`${path.basename(h.target)} (PID ${h.pid})`);
    } catch {}
  }
  return { ok: true, killed };
}

const binaryInspectCache = new Map();

function invalidateBinaryCache(targetPath) {
  if (!targetPath) {
    binaryInspectCache.clear();
    return;
  }
  binaryInspectCache.delete(path.resolve(targetPath).toLowerCase());
}

function inspectSingleBinary(target, options = {}) {
  const exists = fs.existsSync(target.path);
  const cacheKey = path.resolve(target.path).toLowerCase();

  if (!exists) {
    binaryInspectCache.delete(cacheKey);
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: false,
      contextUnlock: null,
      error: null,
    };
  }

  let statSig = null;
  let fileSizeBytes = 0;
  try {
    const st = fs.statSync(target.path);
    fileSizeBytes = st.size || 0;
    statSig = `${st.size}:${st.mtimeMs}:${st.ino || 0}`;
    const cached = binaryInspectCache.get(cacheKey);
    if (cached && cached.statSig === statSig && options.forceRefresh !== true) {
      return { ...cached.result, id: target.id, label: target.label, path: target.path };
    }
  } catch {}

  if (options.cachedOnly === true) return null;

  try {
    let unlockSummary = null;
    try {
      const ua = contextUnlock.analyzeBinary(target.path, {
        backupDir: options.backupDir,
        skipProcessCheck: true,
      });
      unlockSummary = {
        status: ua.status,
        configuredMode: ua.configuredMode,
        configuredLimitTokens: ua.configuredLimitTokens ?? null,
        configuredSummary: ua.configuredSummary || null,
      };
    } catch {}

    const result = {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      fileSizeMb: Number((fileSizeBytes / (1024 * 1024)).toFixed(1)),
      contextUnlock: unlockSummary,
      error: null,
    };
    if (statSig) binaryInspectCache.set(cacheKey, { statSig, result });
    return result;
  } catch (err) {
    return {
      id: target.id,
      label: target.label,
      path: target.path,
      exists: true,
      contextUnlock: null,
      error: err.message,
    };
  }
}

function getEnhanceStatus(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'darwin' || arch !== 'arm64')) {
    return {
      ok: true,
      supported: false,
      platform,
      arch,
      reason: '上下文窗口内核补丁当前专注 macOS Apple Silicon (ARM64)',
      binaries: [],
      summary: null,
    };
  }

  let targets;
  try {
    targets = resolveTargetBinaries(options);
  } catch (e) {
    return { ok: false, supported: false, platform, arch, error: e.message, binaries: [], summary: null };
  }

  const binaries = [];
  for (const target of targets) {
    const inspected = inspectSingleBinary(target, options);
    if (inspected === null && options.cachedOnly === true) return null;
    binaries.push(inspected);
  }

  const existing = binaries.filter((b) => b.exists && !b.error);
  const primary = existing.find((b) => b.id === 'desktop') || existing[0] || null;
  const extCfg = contextUnlock.readExternalContextConfig(options);
  const languageServerRunning = options.skipProcessCheck ? false : checkLanguageServerRunning(options);

  return {
    ok: true,
    supported: true,
    platform,
    arch,
    binaries,
    summary: {
      installedCount: existing.length,
      contextUnlock: primary?.contextUnlock || null,
      configContextWindow: extCfg.configContextWindow,
      contextModeBridge: extCfg.contextModeBridge,
      languageServerRunning,
    },
  };
}

function applyEnhancePatch(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!Array.isArray(options.targets) && (platform !== 'darwin' || arch !== 'arm64')) {
    return { ok: false, error: '当前版本专注 macOS Apple Silicon (ARM64) 内核补丁' };
  }

  const hasContextRequest =
    payload.contextMode !== undefined && payload.contextMode !== null && payload.contextMode !== '';
  const restartRequested = payload.restartLanguageServer === true;
  if (!hasContextRequest && !restartRequested) {
    return { ok: false, error: '未指定要应用的上下文设置' };
  }

  const typoTargetKey = ['targetPath', 'binPath', 'binaryPath', 'filePath', 'target'].find(
    (k) => (options && options[k]) || (payload && payload[k])
  );
  if (!Array.isArray(options.targets) && typoTargetKey) {
    return {
      ok: false,
      code: 'INVALID_TARGET_OPTION',
      error: `无效的目标参数 "${typoTargetKey}"，隔离写入必须显式使用 options.targets 数组；已拒绝探测默认安装目录`,
    };
  }

  const hasIsolationContext = Boolean(
    options.backupDir ||
      options.enhanceBackupDir ||
      options.homeDir ||
      options.stateDir ||
      options.skipProcessCheck ||
      process.env.NODE_TEST_CONTEXT
  );
  if (!Array.isArray(options.targets) && hasIsolationContext) {
    return {
      ok: false,
      code: 'MISSING_TARGETS',
      error: '处于测试或隔离调用但未显式指定 options.targets，已拒绝写入应用目录',
    };
  }
  if (Array.isArray(options.targets) && options.targets.length === 0) {
    return { ok: false, code: 'MISSING_TARGETS', error: '未提供有效的目标二进制文件 (options.targets 为空)' };
  }

  let targets;
  try {
    targets = resolveTargetBinaries(options).filter((t) => fs.existsSync(t.path));
  } catch (e) {
    return { ok: false, code: 'OFFICIAL_APP_FORBIDDEN', error: e.message };
  }

  if (targets.length === 0) {
    return { ok: false, error: '未检测到 哈基米.app 内置后端文件 (language_server)' };
  }

  const logs = [];
  let needsRestart = false;

  try {
    if (hasContextRequest) {
      const modeStr = String(payload.contextMode).trim().toLowerCase();
      let unlockOpts;
      if (modeStr === 'default' || modeStr === 'stock' || modeStr === '256k' || modeStr === 'restore') {
        unlockOpts = { mode: 'default' };
      } else if (modeStr === 'dynamic' || modeStr === 'dyn' || modeStr === '983k' || modeStr === 'auto') {
        unlockOpts = { mode: 'dynamic' };
      } else if (modeStr === '512k') {
        unlockOpts = { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 512000 };
      } else if (modeStr === '900k') {
        unlockOpts = { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 900000 };
      } else if (modeStr === '1m' || modeStr === '1000k') {
        unlockOpts = { mode: 'fixed', limitTokens: Number(payload.contextLimitTokens) || 1000000 };
      } else if (modeStr === 'fixed' || modeStr === 'const' || modeStr === 'custom') {
        unlockOpts = { mode: 'fixed', limitTokens: payload.contextLimitTokens };
      } else {
        throw new Error(`无效的上下文模式参数: ${payload.contextMode}`);
      }

      for (const ut of targets) {
        if (payload.contextRestoreOptional && unlockOpts.mode === 'default') {
          const curCtx = contextUnlock.analyzeBinary(ut.path, {
            backupDir: options.backupDir,
            skipProcessCheck: true,
          });
          if (!curCtx || curCtx.status === 'not_patched' || curCtx.status === 'unsupported') {
            logs.push(`[上下文] ${ut.label}: 当前处于默认或未解锁状态，无需恢复`);
            continue;
          }
          const res = contextUnlock.restoreUnlock({
            targetPath: ut.path,
            recordedTargetPath: options.recordedTargetPath,
            backupDir: options.backupDir,
            homeDir: options.homeDir,
            stateDir: options.stateDir,
            skipProcessCheck: options.skipProcessCheck,
            skipCodesign: options.skipCodesign,
            syncConfigFiles: options.syncConfigFiles !== false && !Array.isArray(options.targets),
          });
          invalidateBinaryCache(ut.path);
          if (!res.ok) throw new Error(`${ut.label} 上下文还原失败: ${res.error}`);
          if (!res.alreadyRestored) needsRestart = true;
          logs.push(`[上下文] ${ut.label}: ${res.message}`);
          continue;
        }

        const res = contextUnlock.applyUnlock({
          ...unlockOpts,
          targetPath: ut.path,
          recordedTargetPath: options.recordedTargetPath,
          backupDir: options.backupDir,
          homeDir: options.homeDir,
          stateDir: options.stateDir,
          skipProcessCheck: options.skipProcessCheck,
          skipCodesign: options.skipCodesign,
          syncConfigFiles: options.syncConfigFiles !== false && !Array.isArray(options.targets),
        });
        invalidateBinaryCache(ut.path);
        if (!res.ok) throw new Error(`${ut.label} 上下文切换失败: ${res.error}`);
        if (!res.alreadyMatched) needsRestart = true;
        logs.push(`[上下文] ${ut.label}: ${res.message || res.configuredMode}`);
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      logs,
    };
  }

  let restarted = false;
  let killedProcesses = [];
  if (restartRequested && !options.skipProcessCheck) {
    const r = restartLanguageServers(options);
    restarted = r.ok;
    killedProcesses = r.killed || [];
    logs.push(
      killedProcesses.length > 0
        ? `[服务重启] 已重启后台语言服务 (${killedProcesses.join(', ')})，新配置将在下次会话/请求时加载`
        : '[服务重启] 当前无运行中的 哈基米.app 后台语言服务进程'
    );
  }

  const status = getEnhanceStatus({ ...options, forceRefresh: true });
  return {
    ok: true,
    needsRestart,
    restarted,
    killedProcesses,
    logs,
    status,
  };
}

/**
 * Restore Context Window (back to 256K).
 * NEVER reverts Account Region Unlock (ValidateAndOnboardAccount)!
 */
function restoreAllEnhance(options = {}) {
  return applyEnhancePatch(
    { contextMode: 'default', contextRestoreOptional: true },
    options
  );
}

module.exports = {
  resolveTargetBinaries,
  getEnhanceStatus,
  applyEnhancePatch,
  restoreAllEnhance,
  restartLanguageServers,
  checkLanguageServerRunning,
  invalidateBinaryCache,
};
