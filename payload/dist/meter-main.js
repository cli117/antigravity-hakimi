'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch {}
const {
  collectTokenHistory,
  collectTokenHistoryAsync,
  recordModelCalls,
  markConversationTurnCompleted,
  invalidateLocalAccountCaches,
  flushPricingLedger,
  getPluginSettings,
  savePluginSettings
} = require('./meter-collector');
const { isValidExternalUrl } = require('./meter-core');
const {
  getRemoteBackendForSender,
  getRemoteBackendForWindow,
  getRemoteSession,
  createRemoteSessionRequester,
} = require('./meter-ssh');

let cachedMeterBundle = null;
let cachedI18nDictJson = null;

function getCachedMeterBundle() {
  const corePath = path.join(__dirname, 'meter-core.js');
  const rendererPath = path.join(__dirname, 'meter-renderer.js');
  try {
    const coreStat = fs.statSync(corePath);
    const rendererStat = fs.statSync(rendererPath);
    const sig = `${coreStat.size}:${coreStat.mtimeMs}|${rendererStat.size}:${rendererStat.mtimeMs}`;
    if (cachedMeterBundle && cachedMeterBundle.sig === sig) {
      return cachedMeterBundle;
    }
    const coreCode = fs.readFileSync(corePath, 'utf8');
    const rendererCode = fs.readFileSync(rendererPath, 'utf8');
    cachedMeterBundle = { sig, combined: `${coreCode}\n${rendererCode}\ntrue;` };
    return cachedMeterBundle;
  } catch {
    const coreCode = fs.readFileSync(corePath, 'utf8');
    const rendererCode = fs.readFileSync(rendererPath, 'utf8');
    return { sig: null, combined: `${coreCode}\n${rendererCode}\ntrue;` };
  }
}

function getCachedI18nDictJson() {
  if (cachedI18nDictJson !== null) return cachedI18nDictJson;
  try {
    const dictPath = path.join(__dirname, 'i18n', 'zh-CN.json');
    if (!fs.existsSync(dictPath)) return null;
    const raw = fs.readFileSync(dictPath, 'utf8');
    if (raw && raw.length > 2) {
      cachedI18nDictJson = raw;
      return cachedI18nDictJson;
    }
  } catch {}
  return null;
}

function clearRuntimeCaches() {
  cachedMeterBundle = null;
  cachedI18nDictJson = null;
}

function getMeterSource(options = {}) {
  try {
    const bundle = getCachedMeterBundle();
    let bootstrap = '';
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        bootstrap += `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
    } catch {}
    try {
      const { loadModulesConfig } = require('./modules-config');
      const mCfg = loadModulesConfig();
      if (mCfg?.modules?.chinese) {
        bootstrap += `window.__AGY_CHINESE_CONFIG__ = ${JSON.stringify(mCfg.modules.chinese)};\n`;
      }
    } catch {}
    try {
      const remoteMeta = options && options.remote
        ? { kind: 'ssh', hostId: String(options.remote.hostId || ''), label: String(options.remote.label || '') }
        : null;
      bootstrap += `window.__AGContextMeterRemote = ${JSON.stringify(remoteMeta)};\n`;
    } catch {}
    return `${bootstrap}${bundle.combined}`;
  } catch (e) {
    return '';
  }
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    const remote = getRemoteBackendForSender(event?.sender);
    if (!remote) {
      try { require('./local-api').setLastKnownOrigin(url.origin); } catch {}
    }
    return url;
  } catch {
    return null;
  }
}

function resolveTargetWindow(sender) {
  try {
    const { BrowserWindow } = require('electron');
    const direct = BrowserWindow.fromWebContents(sender);
    if (direct && !direct.isDestroyed()) return direct;
  } catch {}
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch {}
  return null;
}

let registered = false;
let isAppQuitting = false;
let coldAccountSwitchInFlight = false;
const boundWindows = new WeakSet();
const hiddenOnClose = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();
const inFlightInjections = new WeakMap();
const wcProbeTimers = new WeakMap();

function setAppQuitting(val = true) {
  isAppQuitting = Boolean(val);
}

function getAppQuitting() {
  return isAppQuitting;
}

async function handleModulesStatus(event, customAsar = null) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  try {
    const { loadModulesConfig, inspectDiskModules, checkAppVersionSync } = require('./modules-config');
    return {
      ok: true,
      data: loadModulesConfig(),
      disk: inspectDiskModules(customAsar),
      versionSync: checkAppVersionSync(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleToggleModule(event, moduleName, enable, extraOpts = {}) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  try {
    const { loadModulesConfig, saveModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    if (!cfg.modules[moduleName]) throw new Error(`未知的模块标识: ${moduleName}`);

    const targetEnable = Boolean(enable);
    const disk = inspectDiskModules(extraOpts?.asarPath || null);

    // 判断磁盘是否已经具备该模块所需脚本、字典及配置读取能力
    const hasDiskCapability = (() => {
      if (moduleName === 'chinese') {
        return Boolean(disk.chineseReady);
      } else if (moduleName === 'meter') {
        return Boolean(disk.meterReady);
      }
      return false;
    })();

    // 结果类型 1: 已有完整运行时可通过配置切换 (config_toggled)
    if (hasDiskCapability) {
      if (moduleName === 'chinese') {
        const { normalizeClientLanguage } = require('./modules-config');
        const nextLang = normalizeClientLanguage(extraOpts?.language, targetEnable);
        cfg.modules.chinese.language = nextLang;
        cfg.modules.chinese.enabled = nextLang === 'zh-CN';
        cfg.modules.chinese.lastUpdated = new Date().toISOString();
      } else {
        cfg.modules[moduleName].enabled = targetEnable;
      }
      saveModulesConfig(cfg);
      const isEnabledNow = cfg.modules[moduleName].enabled;
      const msg = isEnabledNow
        ? '已更新并保存设置，重启客户端后生效'
        : '已关闭配置，重启客户端后生效';
      return {
        ok: true,
        status: 'config_toggled',
        data: cfg,
        disk,
        restartRequired: true,
        message: msg
      };
    }

    // 若用户是关闭一个原本就未注入的模块，直接同步配置
    if (!targetEnable) {
      cfg.modules[moduleName].enabled = false;
      if (moduleName === 'chinese') {
        cfg.modules.chinese.language = 'en';
      }
      saveModulesConfig(cfg);
      return {
        ok: true,
        status: 'config_toggled',
        data: cfg,
        disk,
        restartRequired: false,
        message: '模块未注入，配置保持关闭'
      };
    }

    // 结果类型 3: 磁盘上原本没有该组件/资源，无法在客户端运行中直接热注入
    return {
      ok: false,
      status: 'install_failed',
      data: cfg,
      disk,
      error: '主程序钩子缺失，请重新运行 bash ./build-hakimi.sh 重建 哈基米.app',
      restartRequired: false
    };
  } catch (e) {
    console.error(`[AntigravityContextMeter] 切换模块 ${moduleName} 异常:`, e);
    return { ok: false, status: 'error', error: e.message };
  }
}

async function handleRestartHost(event, options = {}) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  const targetApp = options?.appOverride || app;
  if (!targetApp || typeof targetApp.relaunch !== 'function' || typeof targetApp.quit !== 'function') {
    return { ok: true, supported: false };
  }
  const args = Array.isArray(options?.args)
    ? options.args
    : (Array.isArray(process.argv) ? process.argv.slice(1) : []);
  const delayMs = Number.isFinite(Number(options?.delayMs)) ? Number(options.delayMs) : 80;
  const triggerRestart = () => {
    try {
      setAppQuitting(true);
      targetApp.relaunch({ args });
      targetApp.quit();
    } catch {}
  };
  if (delayMs <= 0) {
    triggerRestart();
  } else {
    setTimeout(triggerRestart, delayMs);
  }
  return { ok: true, supported: true };
}

function registerIpcOnce() {
  if (registered || !ipcMain) return;
  registered = true;

  ipcMain.handle('context-meter:record-calls', async (event, calls) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const hasFinalCall = Array.isArray(calls) && calls.some(c => c?.status === 'final');
      const res = recordModelCalls(calls);
      const changed = Boolean(res && typeof res === 'object' ? (res.ok !== false && res.changed) : res);
      if (changed && hasFinalCall) {
        const remote = getRemoteBackendForSender(event?.sender);
        markConversationTurnCompleted(remote ? remote.hostId : 'local');
      }
      if (res && typeof res === 'object') {
        if (res.ok === false) {
          return { ok: false, error: res.error || '入账失败', changed: false };
        }
        return { ok: true, changed: !!res.changed };
      }
      return { ok: true, changed: !!res };
    } catch (e) {
      return { ok: false, error: e.message, changed: false };
    }
  });

  ipcMain.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const remote = getRemoteBackendForSender(event?.sender);
      if (remote) {
        const sessionInfo = getRemoteSession(remote.hostId);
        if (sessionInfo && sessionInfo.csrfToken) {
          try {
            const requester = createRemoteSessionRequester(event.sender, sessionInfo, url.origin);
            return {
              ok: true,
              data: await collectTokenHistoryAsync({
                force: force === true,
                remoteUserStatusOptions: {
                  remoteHostId: remote.hostId,
                  requestFn: requester.call,
                },
              }),
            };
          } catch {}
        }
      }
      return { ok: true, data: await collectTokenHistoryAsync({ force: force === true }) };
    }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:get-settings', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return getPluginSettings(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:save-settings', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return savePluginSettings(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
    try {
      const targetWin = resolveTargetWindow(event.sender);
      if (!targetWin || targetWin.isDestroyed?.()) return { ok: false };
      if (process.platform === 'win32') {
        try {
          if (typeof targetWin.setMenuBarVisibility === 'function') targetWin.setMenuBarVisibility(false);
          targetWin.autoHideMenuBar = true;
        } catch {}
      }
      if (typeof targetWin.setTitleBarOverlay !== 'function') return { ok: true };
      const patch = {};
      if (options && typeof options.color === 'string') patch.color = options.color;
      if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
      const rawHeight = options?.height ?? options?.heightCssPx;
      if (options && Number.isFinite(Number(rawHeight)) && Number(rawHeight) >= 24 && Number(rawHeight) <= 64) {
        patch.height = Math.round(Number(rawHeight));
      }
      targetWin.setTitleBarOverlay(patch);
      return { ok: true, patch };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:open-external', async (event, targetUrl) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (!isValidExternalUrl(targetUrl)) {
      return { ok: false, error: '仅允许打开官方白名单链接（GitHub 仓库或作者署名主页）' };
    }
    try {
      const { shell } = require('electron');
      await shell.openExternal(targetUrl);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:compact-session', async (event, cascadeId) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (typeof cascadeId !== 'string' || !/^[a-f\d-]{36}$/i.test(cascadeId)) {
      return { ok: false, error: '无效会话标识' };
    }
    try {
      let callRpc;
      const remote = getRemoteBackendForSender(event?.sender);
      if (remote) {
        const sessionInfo = getRemoteSession(remote.hostId);
        const requester = createRemoteSessionRequester(event.sender, sessionInfo, url.origin);
        callRpc = requester.call;
      } else {
        const { connect } = require('./local-api');
        const api = await connect();
        callRpc = api.call;
      }
      let compactInfo = { name: 'compact' };
      try {
        const cmdData = await callRpc('GetSlashCommands', { cascadeId });
        const list = cmdData?.commands || cmdData?.slashCommands || [];
        const found = Array.isArray(list)
          ? list.find((c) => c?.name === 'compact' || c?.info?.name === 'compact')
          : null;
        if (found) compactInfo = found.info || found;
      } catch {}
      await callRpc('SendUserCascadeMessage', {
        cascadeId,
        items: [{ item: { slashCommand: { info: compactInfo } } }],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:fork-session', handleForkSession);

  ipcMain.handle('context-meter:cli-unlock-status', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { analyzeAgyCli } = require('./meter-cli-unlock');
      const opts = (options && typeof options === 'object') ? { ...options } : {};
      return { ok: true, data: analyzeAgyCli(opts.binaryPath || null, opts) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:cli-unlock-apply', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { applyAgyCliUnlock } = require('./meter-cli-unlock');
      const opts = (options && typeof options === 'object') ? { ...options } : {};
      return applyAgyCliUnlock(opts);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:restart-host', handleRestartHost);

  ipcMain.on('context-meter:get-chinese-config-sync', (event) => {
    try {
      const { loadModulesConfig } = require('./modules-config');
      const cfg = loadModulesConfig();
      event.returnValue = cfg?.modules?.chinese || null;
    } catch (e) {
      event.returnValue = null;
    }
  });

  ipcMain.on('context-meter:get-i18n-dict-sync', (event) => {
    try {
      event.returnValue = getCachedI18nDictJson();
    } catch (e) {
      event.returnValue = null;
    }
  });

  ipcMain.handle('context-meter:restart-language-servers', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const { restartLanguageServers } = require('./meter-enhance');
      return restartLanguageServers();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:modules-status', handleModulesStatus);
  ipcMain.handle('context-meter:toggle-module', handleToggleModule);

  const rejectIfRemoteAccountSender = (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (getRemoteBackendForSender(event?.sender)) {
      return { ok: false, supported: false, error: 'SSH 远端窗口不支持本机钥匙串账号切换' };
    }
    return null;
  };

  const triggerColdQuitAfterHandoff = (delayMs = 120) => {
    const doQuit = () => {
      try {
        setAppQuitting(true);
        if (app && typeof app.quit === 'function') {
          app.quit();
        }
      } catch {}
    };
    if (delayMs <= 0) doQuit();
    else setTimeout(doQuit, delayMs);
  };

  ipcMain.handle('context-meter:accounts-status', async (event, options) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    try {
      const { getAccountsStatus } = require('./meter-account-switcher');
      return getAccountsStatus(options && typeof options === 'object' ? options : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-save-current', async (event, payload) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    try {
      const { saveCurrentAccount } = require('./meter-account-switcher');
      return saveCurrentAccount(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-switch', async (event, payload) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    if (coldAccountSwitchInFlight) {
      return { ok: false, supported: true, error: '正在执行账号冷切换，请稍候…' };
    }
    try {
      const { startColdSwitchAccount } = require('./meter-account-switcher');
      const res = startColdSwitchAccount(payload && typeof payload === 'object' ? payload : {});
      if (res && res.ok && res.coldSwitching) {
        coldAccountSwitchInFlight = true;
        try { invalidateLocalAccountCaches(); } catch {}
        try { flushPricingLedger(); } catch {}
        triggerColdQuitAfterHandoff(120);
      }
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-prepare-add', async (event, payload) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    if (coldAccountSwitchInFlight) {
      return { ok: false, supported: true, error: '正在执行账号冷切换，请稍候…' };
    }
    try {
      const { startColdPrepareAddAccount } = require('./meter-account-switcher');
      const res = startColdPrepareAddAccount(payload && typeof payload === 'object' ? payload : {});
      if (res && res.ok && res.coldSwitching) {
        coldAccountSwitchInFlight = true;
        try { invalidateLocalAccountCaches(); } catch {}
        try { flushPricingLedger(); } catch {}
        triggerColdQuitAfterHandoff(120);
      }
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-rename', async (event, payload) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    try {
      const { renameAccount } = require('./meter-account-switcher');
      return renameAccount(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:accounts-remove', async (event, payload) => {
    const denied = rejectIfRemoteAccountSender(event);
    if (denied) return denied;
    try {
      const { removeAccount } = require('./meter-account-switcher');
      return removeAccount(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  const rejectIfRemoteUpgradeSender = (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (getRemoteBackendForSender(event?.sender)) {
      return { ok: false, supported: false, error: 'SSH 远端窗口不支持本机自动更新' };
    }
    return null;
  };

  ipcMain.handle('context-meter:hakimi-upgrade-status', async (event) => {
    const denied = rejectIfRemoteUpgradeSender(event);
    if (denied) return denied;
    try {
      const { getDefaultUpdater } = require('./hakimi-updater');
      return getDefaultUpdater().getStatus();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-upgrade-sync', async (event, options) => {
    const denied = rejectIfRemoteUpgradeSender(event);
    if (denied) return denied;
    try {
      const { getDefaultUpdater } = require('./hakimi-updater');
      const opts = options && typeof options === 'object' ? options : {};
      return await getDefaultUpdater().checkAndStageUpgrade({
        manual: true,
        forceMainSync: Boolean(opts.forceMainSync),
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-upgrade-install', async (event) => {
    const denied = rejectIfRemoteUpgradeSender(event);
    if (denied) return denied;
    try {
      const { getDefaultUpdater } = require('./hakimi-updater');
      return getDefaultUpdater().installStagedUpgrade();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  const rejectIfRemoteIconSender = (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    if (getRemoteBackendForSender(event?.sender)) {
      return { ok: false, supported: false, error: 'SSH 远端窗口不支持本机应用图标替换' };
    }
    return null;
  };

  ipcMain.handle('context-meter:hakimi-icon-status', async (event, options) => {
    const denied = rejectIfRemoteIconSender(event);
    if (denied) return denied;
    try {
      const { getIconStatus } = require('./hakimi-icon-manager');
      return getIconStatus(options && typeof options === 'object' ? options : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-icon-pick', async (event) => {
    const denied = rejectIfRemoteIconSender(event);
    if (denied) return denied;
    try {
      const { pickIconFileDialog } = require('./hakimi-icon-manager');
      return await pickIconFileDialog(resolveTargetWindow(event.sender));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-icon-preview', async (event, payload) => {
    const denied = rejectIfRemoteIconSender(event);
    if (denied) return denied;
    try {
      const { previewCustomIcon } = require('./hakimi-icon-manager');
      return await previewCustomIcon(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-icon-apply', async (event, payload) => {
    const denied = rejectIfRemoteIconSender(event);
    if (denied) return denied;
    try {
      const { applyCustomIcon } = require('./hakimi-icon-manager');
      return await applyCustomIcon(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:hakimi-icon-restore', async (event, payload) => {
    const denied = rejectIfRemoteIconSender(event);
    if (denied) return denied;
    try {
      const { restoreDefaultIcon } = require('./hakimi-icon-manager');
      return await restoreDefaultIcon(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  // 1. 若为标准 BrowserWindow 或已定义 webContents getter
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;

  // 2. 宿主官方 utils.getHubWebContents(win)（最权威主会话 WebContents 来源）
  try {
    const utils = require('./utils');
    if (typeof utils.getHubWebContents === 'function') {
      const wc = utils.getHubWebContents(win);
      if (wc && !wc.isDestroyed?.()) return wc;
    }
  } catch {}

  // 3. 针对 Antigravity 2.x BaseWindow + contentView 架构遍历子 View
  // 严格安全限制：仅选择主会话界面，坚决排除 curtainView（data: 协议）及无关弹窗
  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      // 优先：明确匹配本地主聊天服务地址 (https://127.0.0.1:<port>/ 或 http/localhost)
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\//i.test(url)) return child.webContents;
        }
      }
      // 次优：若正在加载中尚未完成导航，排除明确的 data: 遮罩页 (curtainView)
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (!url.startsWith('data:')) return child.webContents;
        }
      }
    }
  } catch {}
  return null;
}


function syncWindowOverlayHeight(win) {
  try {
    if (!win || process.platform === 'darwin' || win.isDestroyed?.() || typeof win.setTitleBarOverlay !== 'function') return;
    const wc = getWindowWebContents(win);
    const zf = typeof wc?.getZoomFactor === 'function' ? wc.getZoomFactor() : 1;
    const targetH = Math.max(28, Math.min(60, Math.round(40 * (Number.isFinite(zf) && zf > 0 ? zf : 1))));
    win.setTitleBarOverlay({ height: targetH });
  } catch {}
}

async function ensureMeterInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowWebContents(win);
    if (!wc || wc.isDestroyed?.()) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }
    const url = wc.getURL?.() || '';
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\//i.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }

    const remote = getRemoteBackendForWindow(win) || getRemoteBackendForSender(wc);
    if (!remote) {
      try { require('./local-api').setLastKnownOrigin(new URL(url).origin); } catch {}
    }
    syncWindowOverlayHeight(win);

    const existing = inFlightInjections.get(wc);
    if (existing) {
      if (!options.force || existing.force) {
        return existing.promise;
      }
      await existing.promise.catch(() => false);
      if (!win || win.isDestroyed?.() || !wc || wc.isDestroyed?.()) return false;
    }

    const runInjection = (async () => {
      if (!options.force) {
        try {
          const alive = await wc.executeJavaScript(
            'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
          );
          if (alive === true) return true;
        } catch {}
      }

      const runtimeSource = getMeterSource({ remote });
      if (!runtimeSource) return false;

      await wc.executeJavaScript(runtimeSource);
      return true;
    })();

    const entry = { force: Boolean(options.force), promise: runInjection };
    inFlightInjections.set(wc, entry);
    try {
      return await runInjection;
    } finally {
      if (inFlightInjections.get(wc) === entry) {
        inFlightInjections.delete(wc);
      }
    }
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      injectionTimers.set(win, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    if (process.platform === 'win32') {
      try {
        if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
      } catch {}
    }
    const onWinVisibleOrActive = () => {
      if (process.platform === 'win32') {
        try {
          if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
        } catch {}
      }
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onWinVisibleOrActive);
    win.on?.('restore', onWinVisibleOrActive);
    win.on?.('focus', onWinVisibleOrActive);

    const isMac = process.platform === 'darwin';
    let cancelFullScreenClose = null;
    if (isMac) {
      win.on?.('show', () => hiddenOnClose.delete(win));
      win.once?.('closed', () => {
        hiddenOnClose.delete(win);
        cancelFullScreenClose?.();
      });
    }

    const hideOnClose = () => {
      if (typeof win.hide !== 'function') return;
      win.hide();
      if (isMac && !win.isDestroyed?.() && !win.isVisible()) hiddenOnClose.add(win);
    };

    // 后台常驻时隐藏最后一个符合条件的主窗口，保留会话。
    try {
      win.on?.('close', (event) => {
        if (isAppQuitting || typeof event?.preventDefault !== 'function') return;
        if (cancelFullScreenClose) {
          event.preventDefault();
          return;
        }
        if (!shouldInterceptWindowClose(win)) return;
        if (isMac && (!win.isVisible?.() || typeof win.hide !== 'function')) return;
        event.preventDefault();
        if (!isMac || !win.isFullScreen?.()) {
          hideOnClose();
          return;
        }

        // 先等 macOS 退出原生全屏空间，避免隐藏窗口后停留在黑屏空间。
        let timeout;
        const onLeaveFullScreen = () => {
          if (!cancelFullScreenClose) return;
          cancelFullScreenClose();
          if (!win.isDestroyed?.() && !win.isFullScreen() && win.isVisible() && shouldInterceptWindowClose(win)) {
            hideOnClose();
          }
        };
        cancelFullScreenClose = () => {
          cancelFullScreenClose = null;
          clearTimeout(timeout);
          win.removeListener('leave-full-screen', onLeaveFullScreen);
        };
        try {
          win.once('leave-full-screen', onLeaveFullScreen);
          // 超时只取消等待，不隐藏窗口；用户可以重试。
          timeout = setTimeout(cancelFullScreenClose, 5000);
          timeout.unref?.();
          win.setFullScreen(false);
        } catch {
          cancelFullScreenClose?.();
        }
      });
    } catch {}
  }

  const bindToWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => {
      void ensureMeterInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('zoom-changed', () => syncWindowOverlayHeight(win));
  };

  const initialWc = getWindowWebContents(win);
  if (initialWc) {
    bindToWc(initialWc);
  } else {
    // 若为 BaseWindow 且尚未挂载 WebContentsView，开启轻量安全探测轮询，并在 WeakMap 中记录定时器
    const prevProbe = wcProbeTimers.get(win);
    if (prevProbe) clearInterval(prevProbe);

    let retries = 0;
    const probeInterval = setInterval(() => {
      retries++;
      const candidateWc = getWindowWebContents(win);
      if (candidateWc) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
        bindToWc(candidateWc);
        void ensureMeterInjected(win, { force: false });
      } else if (retries >= 10 || !win || win.isDestroyed?.()) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
      }
    }, 150);
    wcProbeTimers.set(win, probeInterval);

    win.once?.('closed', () => {
      const activeTimer = wcProbeTimers.get(win);
      if (activeTimer) {
        clearInterval(activeTimer);
        wcProbeTimers.delete(win);
      }
    });
  }
};

try {
  if (app && typeof app.on === 'function') {
    let quitFallbackTimer = null;
    app.on('before-quit', () => {
      isAppQuitting = true;
      try { flushPricingLedger(); } catch {}
      setImmediate(() => {
        try {
          if (quitFallbackTimer) return;
          let confirmPending = false;
          try {
            const utils = require('./utils');
            if (utils && utils.showQuitConfirmation) confirmPending = true;
          } catch {}
          if (confirmPending) return;
          const { BrowserWindow } = require('electron');
          if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
            const wins = BrowserWindow.getAllWindows();
            if (Array.isArray(wins) && wins.length === 0) {
              quitFallbackTimer = setTimeout(() => {
                try { process.exit(0); } catch {}
              }, 6500);
              if (typeof quitFallbackTimer.unref === 'function') quitFallbackTimer.unref();
            }
          }
        } catch {}
      });
    });
    app.on('will-quit', () => {
      isAppQuitting = true;
      try { flushPricingLedger(); } catch {}
      if (quitFallbackTimer) {
        clearTimeout(quitFallbackTimer);
        quitFallbackTimer = null;
      }
    });
    const handleCreated = (_event, win) => {
      try {
        exports.installContextMeter(win);
        void ensureMeterInjected(win, { force: false });
      } catch {}
    };
    app.on('browser-window-created', handleCreated);
    app.on('base-window-created', handleCreated);
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        if (process.platform === 'darwin' && !isAppQuitting) {
          try { reopenHiddenLocalHubWindow(utils); } catch {}
        }
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          exports.installContextMeter(w);
          void ensureMeterInjected(w, { force: true });
        }
      } catch {}
    });
    app.on('second-instance', () => {
      try {
        const utils = require('./utils');
        setTimeout(() => {
          try {
            const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
            for (const w of wins) {
              exports.installContextMeter(w);
              void ensureMeterInjected(w, { force: true });
            }
          } catch {}
        }, 120);
      } catch {}
    });
  }
} catch {}

function reopenHiddenLocalHubWindow(utils) {
  const localWindows = (utils.getLocalHubWindows?.() || []).filter(
    win => !win.isDestroyed?.() && !getRemoteBackendForWindow(win)
  );
  if (localWindows.some(win => win.isVisible?.())) return;

  // 只恢复本钩子隐藏的原窗口；没有窗口时仍由宿主负责新建。
  const win = localWindows.find(win => hiddenOnClose.has(win));
  if (!win) return;
  win.show();
  if (!win.isDestroyed?.()) win.focus();
}

function isHostRunInBackgroundEnabled() {
  try {
    if (process.platform === 'darwin') return true;
    let storagePath = null;
    if (app && typeof app.getPath === 'function') {
      try {
        storagePath = path.join(app.getPath('userData'), 'app_storage.json');
      } catch {}
    }
    if (!storagePath) {
      const home = typeof os.homedir === 'function' ? os.homedir() : '';
      const appData = process.env.APPDATA || (process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config'));
      storagePath = path.join(appData, 'Antigravity', 'app_storage.json');
    }
    if (!fs.existsSync(storagePath)) return false;
    const content = fs.readFileSync(storagePath, 'utf8');
    const data = JSON.parse(content);
    return data?.runInBackground === 'true' || data?.runInBackground === true;
  } catch {
    return false;
  }
}

function shouldInterceptWindowClose(win, options = {}) {
  try {
    if (isAppQuitting) return false;
    if (getRemoteBackendForWindow(win)) return false;

    // 1. 尊重宿主后台常驻设置：若明确未开启或读取设置失败，不得拦截
    const isBgEnabled = typeof options.isBackgroundEnabled === 'function'
      ? options.isBackgroundEnabled()
      : isHostRunInBackgroundEnabled();
    if (!isBgEnabled) return false;

    // 2. 获取宿主主会话窗口列表
    let wins = null;
    if (typeof options.getHubWindows === 'function') {
      wins = options.getHubWindows();
    } else {
      try {
        const utils = require('./utils');
        if (process.platform === 'darwin' && !utils.getLocalHubWindows?.()?.includes(win)) return false;
        if (typeof utils.getHubWindows === 'function') wins = utils.getHubWindows();
      } catch {}
    }

    // 获取窗口列表失败或当前窗口非已确认的主会话窗口（避免影响辅助/弹窗窗口），安全放行
    if (!Array.isArray(wins) || !wins.includes(win)) return false;

    // 3. 多窗口关闭路径：若仍有其他可见主窗口在运行，说明当前是关闭辅助多开窗口，放行正常关闭；
    // 仅当当前是最后一个可见主会话窗口时拦截销毁，转为隐藏至托盘
    const remainingVisible = wins.filter(
      w => w !== win && !w.isDestroyed?.() && (typeof w.isVisible === 'function' ? w.isVisible() : true)
    );
    return remainingVisible.length === 0;
  } catch {
    // 发生任何异常时绝不默认隐藏，确保安全放行
    return false;
  }
}

function buildForkConversationRequest(cascadeId, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawTarget = Number(opts.targetForkWorkspace);
  const targetForkWorkspace = [1, 2, 3].includes(rawTarget) ? rawTarget : 1;
  const rawStep = opts.forkAtStepIndex;
  const forkAtStepIndex =
    typeof rawStep === 'number' && Number.isInteger(rawStep) && rawStep >= -1 ? rawStep : -1;
  return {
    sourceCascadeId: cascadeId,
    forkAtStepIndex,
    targetForkWorkspace,
  };
}

function buildForkedConversationTitle(sourceTitle, existingTitles = []) {
  const raw = typeof sourceTitle === 'string' ? sourceTitle.trim() : '';
  const prefixRe = /^\[Fork(?:\s+(\d+))?\](?:\s+|$)/i;
  const base = raw.replace(prefixRe, '').trim();
  const candidates = [];
  if (raw) candidates.push(raw);
  if (Array.isArray(existingTitles)) {
    for (const item of existingTitles) {
      if (typeof item === 'string' && item.trim()) candidates.push(item.trim());
    }
  }
  let maxForkNum = 0;
  for (const title of candidates) {
    const m = title.match(prefixRe);
    if (!m) continue;
    const itemBase = title.slice(m[0].length).trim();
    if (itemBase !== base) continue;
    const num = m[1] ? Number(m[1]) : 1;
    if (Number.isInteger(num) && num > maxForkNum) {
      maxForkNum = num;
    }
  }
  const nextNum = maxForkNum + 1;
  const tag = nextNum === 1 ? '[Fork]' : `[Fork ${nextNum}]`;
  return base ? `${tag} ${base}` : tag;
}

async function handleForkSession(event, cascadeId, options = {}, deps = {}) {
  const checkSender = typeof deps.isLocalMainFrameSender === 'function'
    ? deps.isLocalMainFrameSender
    : isLocalMainFrameSender;
  const url = checkSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  if (typeof cascadeId !== 'string' || !/^[a-f\d-]{36}$/i.test(cascadeId)) {
    return { ok: false, error: '无效会话标识' };
  }
  try {
    let callRpc;
    if (typeof deps.callRpc === 'function') {
      callRpc = deps.callRpc;
    } else {
      const remote = getRemoteBackendForSender(event?.sender);
      if (remote) {
        const sessionInfo = getRemoteSession(remote.hostId);
        const requester = createRemoteSessionRequester(event.sender, sessionInfo, url.origin);
        callRpc = requester.call;
      } else {
        const { connect } = require('./local-api');
        const api = await connect();
        callRpc = api.call;
      }
    }
    const opts = options && typeof options === 'object' ? options : {};
    const reqBody = buildForkConversationRequest(cascadeId, opts);
    const res = await callRpc('ForkConversation', reqBody);
    const newCascadeId = typeof res?.newCascadeId === 'string' ? res.newCascadeId.trim() : '';
    if (!newCascadeId) {
      return { ok: false, error: '未返回派生会话标识' };
    }
    let sourceTitle = typeof opts.sourceTitle === 'string' ? opts.sourceTitle.trim() : '';
    const existingTitles = Array.isArray(opts.existingTitles)
      ? opts.existingTitles.map((t) => String(t || '').trim()).filter(Boolean)
      : [];
    if (!sourceTitle) {
      try {
        const allTraj = await callRpc('GetAllCascadeTrajectories', {});
        const summaries = allTraj?.trajectorySummaries || {};
        const srcSummary = summaries[cascadeId];
        sourceTitle = String(srcSummary?.annotations?.title || srcSummary?.summary || '').trim();
        for (const item of Object.values(summaries)) {
          const t = String(item?.annotations?.title || item?.summary || '').trim();
          if (t) existingTitles.push(t);
        }
      } catch {}
    }
    const newTitle = buildForkedConversationTitle(sourceTitle, existingTitles);
    if (newTitle) {
      try {
        await callRpc('UpdateConversationAnnotations', {
          cascadeIds: [newCascadeId],
          annotations: { title: newTitle },
          mergeAnnotations: true,
        });
      } catch {}
    }
    const newProjectId = typeof res?.newProjectId === 'string' ? res.newProjectId.trim() : '';
    const warnings = Array.isArray(res?.warnings)
      ? res.warnings.map((w) => String(w || '').trim()).filter(Boolean)
      : [];
    return { ok: true, newCascadeId, newProjectId, newTitle, warnings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

exports.handleModulesStatus = handleModulesStatus;
exports.handleToggleModule = handleToggleModule;
exports.handleRestartHost = handleRestartHost;
exports.buildForkConversationRequest = buildForkConversationRequest;
exports.buildForkedConversationTitle = buildForkedConversationTitle;
exports.handleForkSession = handleForkSession;
exports.setAppQuitting = setAppQuitting;
exports.getAppQuitting = getAppQuitting;
exports.shouldInterceptWindowClose = shouldInterceptWindowClose;
exports.isHostRunInBackgroundEnabled = isHostRunInBackgroundEnabled;
exports.getWindowWebContents = getWindowWebContents;
exports.getMeterSource = getMeterSource;
exports.getCachedI18nDictJson = getCachedI18nDictJson;
exports.clearRuntimeCaches = clearRuntimeCaches;
