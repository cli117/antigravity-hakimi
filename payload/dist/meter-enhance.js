'use strict';
/**
 * 哈基米.app 内核轻量化增强引擎 (meter-enhance.js)
 * 说明：
 * 1. 已移除系统提示词精简/防幻觉重写（0~4 档）；
 * 2. 专注会话与章节自动简体中文标题（3 条等长 ASCII 双向可逆规则）与上下文窗口调整委托；
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

const CHINESE_TITLE_RULES = [
  {
    id: 'conversation_title',
    name: '会话主标题生成指令 (Conversation Title)',
    oldText:
      "Respond with ONLY a short conversation title (3-5 words, title-cased, no prefix) describing the USER's intent.",
    newText:
      "Respond with ONLY a Simplified Chinese title (4-10 Chinese chars, NEVER English) describing the USER's intent.",
  },
  {
    id: 'chapter_sentence',
    name: '章节标题生成句式 (Chapter Title - 句式)',
    oldText: 'Reply with only a plain 3 to 6 word title in sentence case',
    newText: 'Reply with only a concise Simplified Chinese chapter title',
  },
  {
    id: 'chapter_example',
    name: '章节标题生成示例 (Chapter Title - 示例)',
    oldText: 'For example: Fixing the login redirect bug, or Planning the websocket rollout.',
    newText: ' ALWAYS reply in Simplified Chinese (4-10 Chinese chars, NEVER English words).',
  },
];

for (const rule of CHINESE_TITLE_RULES) {
  const oldLen = Buffer.byteLength(rule.oldText, 'ascii');
  const newLen = Buffer.byteLength(rule.newText, 'ascii');
  if (oldLen !== newLen) {
    throw new Error(`中文标题补丁内部等长校验失败 [${rule.id}]: ${oldLen} != ${newLen}`);
  }
}

const CHINESE_TITLE_META = {
  zh: { mode: 'zh', enabled: true, label: '自动中文标题 (4~10字)', shortLabel: '中文标题' },
  en: { mode: 'en', enabled: false, label: '官方英文标题', shortLabel: '英文标题' },
  unsupported: { mode: 'unsupported', enabled: false, label: '当前内核无标题特征', shortLabel: '未匹配' },
};

function normalizeChineseTitleMode(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  if (
    s === 'true' ||
    s === '1' ||
    s === 'on' ||
    s === 'zh' ||
    s === 'cn' ||
    s === 'zh-cn' ||
    s === 'enable' ||
    s === 'enabled'
  ) {
    return true;
  }
  if (
    s === 'false' ||
    s === '0' ||
    s === 'off' ||
    s === 'en' ||
    s === 'stock' ||
    s === 'restore' ||
    s === 'reset' ||
    s === 'disable' ||
    s === 'disabled'
  ) {
    return false;
  }
  return undefined;
}

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

function inspectChineseTitleRules(buf) {
  const details = [];
  let enCount = 0;
  let zhCount = 0;

  for (const rule of CHINESE_TITLE_RULES) {
    const oldBuf = Buffer.from(rule.oldText, 'ascii');
    const newBuf = Buffer.from(rule.newText, 'ascii');
    const oldOff = buf.indexOf(oldBuf);
    const newOff = buf.indexOf(newBuf);

    if (newOff !== -1) {
      zhCount++;
      details.push({ id: rule.id, name: rule.name, state: 'zh', offset: newOff });
    } else if (oldOff !== -1) {
      enCount++;
      details.push({ id: rule.id, name: rule.name, state: 'en', offset: oldOff });
    }
  }

  let mode = 'unsupported';
  if (zhCount > 0) mode = 'zh';
  else if (enCount > 0) mode = 'en';

  return {
    mode,
    enabled: mode === 'zh',
    matchedCount: zhCount + enCount,
    zhCount,
    enCount,
    details,
  };
}

function applyChineseTitlePatchToBuffer(buf, enableZh) {
  const matched = [];
  for (const rule of CHINESE_TITLE_RULES) {
    const oldBuf = Buffer.from(rule.oldText, 'ascii');
    const newBuf = Buffer.from(rule.newText, 'ascii');
    const src = enableZh ? oldBuf : newBuf;
    const dst = enableZh ? newBuf : oldBuf;

    let pos = 0;
    while (true) {
      const idx = buf.indexOf(src, pos);
      if (idx === -1) break;
      dst.copy(buf, idx);
      matched.push({ id: rule.id, offset: idx, enabled: Boolean(enableZh) });
      pos = idx + dst.length;
    }

    if (buf.indexOf(dst) !== -1 && !matched.some((m) => m.id === rule.id)) {
      matched.push({ id: rule.id, offset: buf.indexOf(dst), enabled: Boolean(enableZh) });
    }
  }
  return matched;
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
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: CHINESE_TITLE_META.unsupported.label,
      contextUnlock: null,
      error: null,
    };
  }

  let statSig = null;
  try {
    const st = fs.statSync(target.path);
    statSig = `${st.size}:${st.mtimeMs}:${st.ino || 0}`;
    const cached = binaryInspectCache.get(cacheKey);
    if (cached && cached.statSig === statSig && options.forceRefresh !== true) {
      return { ...cached.result, id: target.id, label: target.label, path: target.path };
    }
  } catch {}

  if (options.cachedOnly === true) return null;

  try {
    const buf = fs.readFileSync(target.path);
    const titleInfo = inspectChineseTitleRules(buf);

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
      fileSizeMb: Number((buf.length / (1024 * 1024)).toFixed(1)),
      chineseTitleMode: titleInfo.mode,
      chineseTitleEnabled: titleInfo.mode === 'zh',
      chineseTitleLabel: CHINESE_TITLE_META[titleInfo.mode]?.label || CHINESE_TITLE_META.en.label,
      chineseTitleMatched: titleInfo.matchedCount,
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
      chineseTitleMode: 'unsupported',
      chineseTitleEnabled: false,
      chineseTitleLabel: '解析失败',
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
      reason: '中文标题与上下文窗口内核补丁当前专注 macOS Apple Silicon (ARM64)',
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
  const chineseTitleMode = primary ? primary.chineseTitleMode || 'en' : 'en';
  const chineseTitleMeta = CHINESE_TITLE_META[chineseTitleMode] || CHINESE_TITLE_META.en;
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
      chineseTitleMode,
      chineseTitleEnabled: chineseTitleMode === 'zh',
      chineseTitleLabel: chineseTitleMeta.label,
      chineseTitleShortLabel: chineseTitleMeta.shortLabel,
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

  const chineseTitle = normalizeChineseTitleMode(payload.chineseTitle);
  if (chineseTitle === undefined) {
    return { ok: false, error: `无效的中文标题补丁参数: ${payload.chineseTitle}` };
  }

  const hasContextRequest =
    payload.contextMode !== undefined && payload.contextMode !== null && payload.contextMode !== '';
  const restartRequested = payload.restartLanguageServer === true;
  if (chineseTitle === null && !hasContextRequest && !restartRequested) {
    return { ok: false, error: '未指定要应用的中文标题或上下文设置' };
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
    if (chineseTitle !== null) {
      for (const target of targets) {
        assertNotOfficialAntigravityApp(target.path, 'patch Chinese titles');
        const origDiskBuf = fs.readFileSync(target.path);
        const nextBuf = Buffer.from(origDiskBuf);
        const tMatches = applyChineseTitlePatchToBuffer(nextBuf, chineseTitle);

        if (tMatches.length > 0) {
          logs.push(
            `[中文标题] ${target.label} -> ${chineseTitle ? '自动中文标题 (4~10字)' : '官方英文标题'} (处理 ${tMatches.length} 条指令)`
          );
        } else {
          logs.push(`[中文标题] ${target.label} 未包含会话标题生成指令（已跳过）`);
        }

        if (Buffer.compare(origDiskBuf, nextBuf) === 0) {
          logs.push(`[无变更] ${path.basename(target.path)} 标题规则已处于目标状态`);
        } else {
          const writeRes = contextUnlock.atomicWriteBinary(target.path, nextBuf, 'enh', options);
          invalidateBinaryCache(target.path);
          if (!writeRes.ok) throw new Error(writeRes.error);
          needsRestart = true;
          logs.push(`[写入成功] ${path.basename(target.path)} (新 inode${writeRes.signed ? ' + 重签名' : ''})`);
        }
      }
    }

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
 * Restore Chinese Title (back to English) + Context Window (back to 256K).
 * NEVER reverts Account Region Unlock (ValidateAndOnboardAccount)!
 */
function restoreAllEnhance(options = {}) {
  return applyEnhancePatch(
    { chineseTitle: false, contextMode: 'default', contextRestoreOptional: true },
    options
  );
}

module.exports = {
  CHINESE_TITLE_META,
  CHINESE_TITLE_RULES,
  normalizeChineseTitleMode,
  resolveTargetBinaries,
  inspectChineseTitleRules,
  applyChineseTitlePatchToBuffer,
  getEnhanceStatus,
  applyEnhancePatch,
  restoreAllEnhance,
  restartLanguageServers,
  checkLanguageServerRunning,
  invalidateBinaryCache,
};
