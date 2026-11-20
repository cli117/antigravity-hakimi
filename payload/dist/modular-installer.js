'use strict';

const vm = require('vm');

const TAGS = {
  CHINESE_START: '// --- Antigravity Chinese Localization Injection Start ---',
  CHINESE_END: '// --- Antigravity Chinese Localization Injection End ---',
  METER_UTILS_START: '// --- Antigravity Context Meter utils Injection Start ---',
  METER_UTILS_END: '// --- Antigravity Context Meter utils Injection End ---',
  METER_PRELOAD_START: '// --- Antigravity Context Meter preload Injection Start ---',
  METER_PRELOAD_END: '// --- Antigravity Context Meter preload Injection End ---',
  SSH_BOOTSTRAP_START: '// --- Antigravity Hakimi SSH Bootstrap Injection Start ---',
  SSH_BOOTSTRAP_END: '// --- Antigravity Hakimi SSH Bootstrap Injection End ---',
  SSH_MANAGER_START: '// --- Antigravity Hakimi SSH Manager Injection Start ---',
  SSH_MANAGER_END: '// --- Antigravity Hakimi SSH Manager Injection End ---',
};

function validateSyntax(code, filename = 'script.js') {
  if (typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function generateMeterUtilsCode() {
  const storageFallbackLine =
    '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  return {
    storageFallback: `\n${storageFallbackLine}`,
    windowLoadHook: `${TAGS.METER_UTILS_START}\n${hookLine}${TAGS.METER_UTILS_END}\n`,
    focusHook: `\n        try { require("./meter-main").installContextMeter(wins[0]); require("./meter-main").ensureMeterInjected(wins[0], { force: true }); } catch {}`,
    createHook: `\n        try { require("./meter-main").installContextMeter(_mWin); require("./meter-main").ensureMeterInjected(_mWin, { force: true }); } catch {}`,
  };
}

function generateMainWorldDecoratorScript() {
  return `(function(){
  try{
    if(globalThis.__agMeterClientDecoratorBootstrapped)return;
    globalThis.__agMeterClientDecoratorBootstrapped=true;
    var prevDec=typeof globalThis.__JETSKI_LS_CLIENT_DECORATOR__==="function"?globalThis.__JETSKI_LS_CLIENT_DECORATOR__:null;
    var wrappedSet=typeof WeakSet==="function"?new WeakSet():null;
    globalThis.__JETSKI_LS_CLIENT_DECORATOR__=function(client){
      if(!client||(typeof client!=="object"&&typeof client!=="function"))return client;
      if((wrappedSet&&wrappedSet.has(client))||client.__agMeterWrappedClient)return client;
      var target=client;
      if(prevDec){try{var out=prevDec(client);if(out)target=out;}catch(e){}}
      if(!target||(typeof target!=="object"&&typeof target!=="function"))return target;
      if((wrappedSet&&wrappedSet.has(target))||target.__agMeterWrappedClient)return target;
      if(typeof target.sendUserCascadeMessage!=="function")return target;
      var origSend=target.sendUserCascadeMessage;
      var wrappedSend=function(req,opts){
        var dispatchToken=null;
        try{
          var hook=globalThis.__AG_METER_ON_SEND_MESSAGE__;
          if(typeof hook==="function"){dispatchToken=hook(req,"client_object")||null;}
        }catch(hookErr){}
        var res;
        try{
          res=origSend.call(this,req,opts);
        }catch(syncErr){
          try{if(dispatchToken&&dispatchToken.dispatchId&&typeof globalThis.__AG_METER_ON_SEND_RESULT__==="function"){globalThis.__AG_METER_ON_SEND_RESULT__(dispatchToken.dispatchId,false,syncErr);}}catch(e2){}
          throw syncErr;
        }
        if(res&&typeof res.then==="function"){
          return res.then(function(val){
            try{if(dispatchToken&&dispatchToken.dispatchId&&typeof globalThis.__AG_METER_ON_SEND_RESULT__==="function"){globalThis.__AG_METER_ON_SEND_RESULT__(dispatchToken.dispatchId,true,null,val);}}catch(e3){}
            return val;
          },function(err){
            try{if(dispatchToken&&dispatchToken.dispatchId&&typeof globalThis.__AG_METER_ON_SEND_RESULT__==="function"){globalThis.__AG_METER_ON_SEND_RESULT__(dispatchToken.dispatchId,false,err);}}catch(e4){}
            throw err;
          });
        }
        try{if(dispatchToken&&dispatchToken.dispatchId&&typeof globalThis.__AG_METER_ON_SEND_RESULT__==="function"){globalThis.__AG_METER_ON_SEND_RESULT__(dispatchToken.dispatchId,true,null,res);}}catch(e5){}
        return res;
      };
      var proxy=new Proxy(target,{
        get:function(obj,prop){
          if(prop==="__agMeterWrappedClient")return true;
          if(prop==="sendUserCascadeMessage")return wrappedSend;
          var v=Reflect.get(obj,prop,obj);
          return typeof v==="function"?v.bind(obj):v;
        }
      });
      if(wrappedSet)wrappedSet.add(proxy);
      return proxy;
    };
  }catch(e){}
})();`;
}

function generateMeterPreloadCode() {
  const mainWorldScriptLiteral = JSON.stringify(generateMainWorldDecoratorScript());
  return `\n${TAGS.METER_PRELOAD_START}
// Context Meter v2: narrow read-only conversation scan API + cold-start main-world decorator bootstrap
try {
  if (typeof electron_1 !== "undefined" && electron_1.webFrame && typeof electron_1.webFrame.executeJavaScript === "function") {
    var _agDecPromise = electron_1.webFrame.executeJavaScript(${mainWorldScriptLiteral}, false);
    if (_agDecPromise && typeof _agDecPromise.catch === "function") { _agDecPromise.catch(function(){}); }
  }
} catch (_agDecErr) {}
electron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true), getTokenHistory: (force) => electron_1.ipcRenderer.invoke("context-meter:token-history", force === true), syncOverlay: (opts) => electron_1.ipcRenderer.invoke("context-meter:sync-overlay", opts), recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls), getSettings: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-settings", opts), saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload), openExternal: (url) => electron_1.ipcRenderer.invoke("context-meter:open-external", url), getContextUnlockStatus: (opts) => electron_1.ipcRenderer.invoke("context-meter:context-unlock-status", opts), applyContextUnlock: (opts) => electron_1.ipcRenderer.invoke("context-meter:context-unlock-apply", opts), restoreContextUnlock: (opts) => electron_1.ipcRenderer.invoke("context-meter:context-unlock-restore", opts), getCliUnlockStatus: (opts) => electron_1.ipcRenderer.invoke("context-meter:cli-unlock-status", opts), applyCliUnlock: (opts) => electron_1.ipcRenderer.invoke("context-meter:cli-unlock-apply", opts), restartHost: () => electron_1.ipcRenderer.invoke("context-meter:restart-host"), getEnhanceStatus: (opts) => electron_1.ipcRenderer.invoke("context-meter:enhance-status", opts), applyEnhancePatch: (payload) => electron_1.ipcRenderer.invoke("context-meter:enhance-apply", payload), restoreAllEnhance: (opts) => electron_1.ipcRenderer.invoke("context-meter:enhance-restore", opts), restartLanguageServers: () => electron_1.ipcRenderer.invoke("context-meter:restart-language-servers"), getModulesStatus: () => electron_1.ipcRenderer.invoke("context-meter:modules-status"), toggleModule: (name, enable, opts) => electron_1.ipcRenderer.invoke("context-meter:toggle-module", name, enable, opts) });
${TAGS.METER_PRELOAD_END}\n`;
}

function generateChinesePreloadCode(dictContent, runtimeContent) {
  return `\n${TAGS.CHINESE_START}
(function() {
  try {
    var _i18nConfig = { enabled: true, language: 'zh-CN' };
    try {
      if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer && typeof electron_1.ipcRenderer.sendSync === 'function') {
        var _syncCfg = electron_1.ipcRenderer.sendSync('context-meter:get-chinese-config-sync');
        if (_syncCfg && typeof _syncCfg === 'object') {
          _i18nConfig.enabled = _syncCfg.enabled !== false && _syncCfg.language !== 'en';
          _i18nConfig.language = _syncCfg.language || (_i18nConfig.enabled ? 'zh-CN' : 'en');
        }
      }
    } catch(ipcErr) {}
    var _fs = typeof require === 'function' ? (function() { try { return require('fs'); } catch(e) { return null; } })() : null;
    var _path = typeof require === 'function' ? (function() { try { return require('path'); } catch(e) { return null; } })() : null;
    var _os = typeof require === 'function' ? (function() { try { return require('os'); } catch(e) { return null; } })() : null;
    if (_fs && _path && _os) {
      var _overrideDir = (typeof process !== 'undefined' && process.env && (process.env.AG_METER_STATE_DIR || process.env.HAKIMI_STATE_DIR || process.env.ANTIGRAVITY_METER_STATE_DIR)) || null;
      var _localApp = typeof process !== 'undefined' && process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || _path.join(_os.homedir(), 'AppData', 'Local'))
        : (typeof process !== 'undefined' && process.platform === 'darwin'
          ? _path.join(_os.homedir(), 'Library', 'Application Support')
          : _path.join(_os.homedir(), '.local', 'state'));
      var _stateDir = _overrideDir || _path.join(_localApp, 'AntigravityContextMeter');
      var _cfgP = _path.join(_stateDir, 'modules.json');
      if (_fs.existsSync(_cfgP)) {
        try {
          var _c = JSON.parse(_fs.readFileSync(_cfgP, 'utf8'));
          var _ch = _c && _c.modules && _c.modules.chinese ? _c.modules.chinese : null;
          if (_ch) {
            _i18nConfig.enabled = _ch.enabled !== false && _ch.language !== 'en';
            _i18nConfig.language = _ch.language || (_i18nConfig.enabled ? 'zh-CN' : 'en');
            if (_c && _c.modules && _c.modules.chinese && _c.modules.chinese.enabled === false) {
              return;
            }
          }
        } catch(e) {}
      }
    }

    var _dictData = ${dictContent.trim()};
    if (typeof window !== 'undefined') {
      window.__AGY_I18N_CONFIG__ = _i18nConfig;
      window.__AGY_I18N_DATA__ = _dictData;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_I18N_CONFIG__ = _i18nConfig;
      globalThis.__AGY_I18N_DATA__ = _dictData;
    }
    ${runtimeContent}
  } catch(e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AGY-i18n] Runtime Injection Error:', e);
    }
  }
})();
${TAGS.CHINESE_END}\n`;
}

function cleanUtilsSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const legacyProxyRegex = /\n?\s*\/\/ --- Antigravity Proxy NoTun Injection Start ---[\s\S]*?\/\/ --- Antigravity Proxy NoTun Injection End ---\n?/g;
  code = code.replace(legacyProxyRegex, '\n');

  const meterRegex = new RegExp(
    `\\n?\\s*${TAGS.METER_UTILS_START}[\\s\\S]*?${TAGS.METER_UTILS_END}\\n?`,
    'g'
  );
  code = code.replace(meterRegex, '\n');

  const storageFallbackLine =
    '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  code = code
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(process\.env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace('\n' + storageFallbackLine, '')
    .replace(/\s*require\("\.\/meter-main"\)\.installContextMeter\(win\);?\r?\n?/g, '')
    .replace(/\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(wins\[0\]\);[\s\S]*?\}\s*catch\s*\{\}/g, '')
    .replace(
      /const _mWin = createWindow\(`\$\{constants_1\.WINDOW_ORIGIN\}:\$\{port\}\/`\);\s*\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(_mWin\);[\s\S]*?\}\s*catch\s*\{\}/g,
      'createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);'
    )
    .replace(/\n {8}autoHideMenuBar:\s*true,/, '');

  return code;
}

function cleanPreloadSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const chineseRegex = new RegExp(
    `\\n?\\s*${TAGS.CHINESE_START}[\\s\\S]*?${TAGS.CHINESE_END}\\n?`,
    'g'
  );
  code = code.replace(chineseRegex, '\n');

  const meterRegex = new RegExp(
    `\\n?\\s*${TAGS.METER_PRELOAD_START}[\\s\\S]*?${TAGS.METER_PRELOAD_END}\\n?`,
    'g'
  );
  code = code.replace(meterRegex, '\n');

  const legacyMeterRegex =
    /\r?\n?\/\/ Context Meter v2: narrow read-only conversation scan API\r?\nelectron_1\.contextBridge\.exposeInMainWorld\("contextMeterAPI",\s*\{[\s\S]*?\}\);\r?\n?/g;
  code = code.replace(legacyMeterRegex, '\n');

  return code;
}

const WINDOW_LOAD_ANCHOR_RE =
  /^ {4}void (?:win\.loadURL\(url\)|loadHubWindowUrl\(win,\s*url(?:,\s*[^\r\n;]+)?\));(?=\r?$)/m;

function matchWindowLoadAnchors(source) {
  if (!source || typeof source !== 'string') return [];
  const globalRe = new RegExp(WINDOW_LOAD_ANCHOR_RE.source, 'gm');
  return source.match(globalRe) || [];
}

function verifyCleanStructure(cleanUtils) {
  if (!cleanUtils) return false;
  if (cleanUtils.includes('installContextMeter')) return false;
  if (cleanUtils.includes(TAGS.METER_UTILS_START)) return false;
  const setupNodeMarker = 'function setupNodeWrapper(env) {';
  const structuralOk =
    matchWindowLoadAnchors(cleanUtils).length === 1 && cleanUtils.includes(setupNodeMarker);
  return structuralOk && validateSyntax(cleanUtils, 'dist/utils.js');
}

function cleanSshBootstrapSource(source) {
  if (!source || typeof source !== 'string') return source;
  const blockRe = new RegExp(
    `${TAGS.SSH_BOOTSTRAP_START}[\\s\\S]*?${TAGS.SSH_BOOTSTRAP_END}`,
    'g'
  );
  return source.replace(blockRe, 'return header + SCRIPT_BODY;');
}

function injectSshBootstrapSource(source) {
  const cleaned = cleanSshBootstrapSource(source);
  const anchor = 'return header + SCRIPT_BODY;';
  const parts = cleaned.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`Expected unique anchor "${anchor}" in dist/remote/bootstrapScript.js (matches=${parts.length - 1})`);
  }
  const replacement = `${TAGS.SSH_BOOTSTRAP_START}\n    return require("../meter-ssh").decorateBootstrapScript(header + SCRIPT_BODY);\n    ${TAGS.SSH_BOOTSTRAP_END}`;
  return parts[0] + replacement + parts[1];
}

function cleanRemoteManagerSource(source) {
  if (!source || typeof source !== 'string') return source;
  const blockRe = new RegExp(
    `\\r?\\n?[ \\t]*${TAGS.SSH_MANAGER_START}[\\s\\S]*?${TAGS.SSH_MANAGER_END}`,
    'g'
  );
  return source.replace(blockRe, '');
}

function injectRemoteManagerSource(source) {
  let code = cleanRemoteManagerSource(source);
  const onConnectedAnchor = '    onConnected(entry, sshSession) {';
  const onConnParts = code.split(onConnectedAnchor);
  if (onConnParts.length !== 2) {
    throw new Error(`Expected unique anchor "${onConnectedAnchor}" in dist/remote/remoteManager.js (matches=${onConnParts.length - 1})`);
  }
  code =
    onConnParts[0] +
    `${onConnectedAnchor}\n        ${TAGS.SSH_MANAGER_START}\n        try { require("../meter-ssh").recordRemoteSession(entry, sshSession); } catch {}\n        ${TAGS.SSH_MANAGER_END}` +
    onConnParts[1];

  const disposeAnchor = '    disposeHost(entry) {';
  const disposeParts = code.split(disposeAnchor);
  if (disposeParts.length !== 2) {
    throw new Error(`Expected unique anchor "${disposeAnchor}" in dist/remote/remoteManager.js (matches=${disposeParts.length - 1})`);
  }
  code =
    disposeParts[0] +
    `${disposeAnchor}\n        ${TAGS.SSH_MANAGER_START}\n        try { require("../meter-ssh").forgetRemoteSession(entry?.hostId); } catch {}\n        ${TAGS.SSH_MANAGER_END}` +
    disposeParts[1];

  return code;
}

module.exports = {
  TAGS,
  WINDOW_LOAD_ANCHOR_RE,
  matchWindowLoadAnchors,
  validateSyntax,
  generateMeterUtilsCode,
  generateMainWorldDecoratorScript,
  generateMeterPreloadCode,
  generateChinesePreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  cleanSshBootstrapSource,
  injectSshBootstrapSource,
  cleanRemoteManagerSource,
  injectRemoteManagerSource,
  verifyCleanStructure,
};
