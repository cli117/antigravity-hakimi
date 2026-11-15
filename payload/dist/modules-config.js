'use strict';

const fs = require('fs');
const path = require('path');
const { getStateDir, findAsarPath, builtinAsar, assertNotOfficialAntigravityApp } = require('./asar-engine');

const SCHEMA_VERSION = '0.8.3';
const PROJECT_VERSION = '0.8.3';

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  modules: {
    meter: {
      enabled: true,
    },
    chinese: {
      enabled: true,
      language: 'zh-CN', // 'zh-CN' | 'en'
      brandTitle: 'hakimi', // 'english' | 'hidden' | 'translated' | 'hakimi'
      desktopOnly: true,
      lastUpdated: null,
    },
  },
};

function normalizeBrandTitle(val) {
  const raw = String(val || '').trim();
  const s = raw.toLowerCase();
  if (s === 'hidden' || s === 'hide' || s === 'off' || s === 'none') return 'hidden';
  if (
    s === 'translated' ||
    s === 'zh' ||
    s === 'cn' ||
    s === 'fanzhongli' ||
    s === 'anti-gravity' ||
    raw === '反重力'
  ) {
    return 'translated';
  }
  if (s === 'hakimi' || raw === '哈基米') return 'hakimi';
  return 'english';
}

function normalizeClientLanguage(val, enabledHint) {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'zh-cn' || s === 'zh' || s === 'zh-hans' || s === 'cn') return 'zh-CN';
  if (s === 'en' || s === 'english' || s === 'en-us') return 'en';
  if (enabledHint === false) return 'en';
  return 'zh-CN';
}

function getModulesConfigPath() {
  return path.join(getStateDir(), 'modules.json');
}

function loadModulesConfig() {
  const cfgPath = getModulesConfigPath();
  const current = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && parsed.modules) {
        current.modules.meter = Object.assign(
          {},
          DEFAULT_CONFIG.modules.meter,
          parsed.modules.meter || {}
        );
        const rawChinese = parsed.modules.chinese || {};
        current.modules.chinese = Object.assign({}, DEFAULT_CONFIG.modules.chinese, rawChinese);
        current.modules.chinese.language = normalizeClientLanguage(
          rawChinese.language,
          rawChinese.enabled
        );
        current.modules.chinese.brandTitle =
          rawChinese.brandTitle !== undefined
            ? normalizeBrandTitle(rawChinese.brandTitle)
            : DEFAULT_CONFIG.modules.chinese.brandTitle;
        current.modules.chinese.enabled = current.modules.chinese.language === 'zh-CN';
        return current;
      }
    } catch {}
  }

  saveModulesConfig(current);
  return current;
}

function saveModulesConfig(cfg) {
  const cfgPath = getModulesConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const sanitized = {
    schemaVersion: SCHEMA_VERSION,
    modules: {
      meter: {
        enabled: cfg?.modules?.meter?.enabled !== false,
      },
      chinese: {
        enabled: cfg?.modules?.chinese?.enabled !== false && cfg?.modules?.chinese?.language !== 'en',
        language: normalizeClientLanguage(
          cfg?.modules?.chinese?.language,
          cfg?.modules?.chinese?.enabled
        ),
        brandTitle:
          cfg?.modules?.chinese?.brandTitle !== undefined
            ? normalizeBrandTitle(cfg.modules.chinese.brandTitle)
            : DEFAULT_CONFIG.modules.chinese.brandTitle,
        desktopOnly: true,
        lastUpdated: cfg?.modules?.chinese?.lastUpdated || null,
      },
    },
  };
  const tmpPath = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(sanitized, null, 2), 'utf8');
  fs.renameSync(tmpPath, cfgPath);
  return sanitized;
}

async function acquireFileLock(lockName = 'modules-install.lock', timeoutMs = 15000) {
  const lockDir = path.join(getStateDir(), '.locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, lockName);
  const start = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {}
      };
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 60000) {
            try {
              fs.unlinkSync(lockFile);
              continue;
            } catch {}
          }
        } catch {}
        if (Date.now() - start > timeoutMs) {
          throw new Error(`无法获取模块安装互斥锁 (${lockFile})，可能存在另一安装进程正在执行`);
        }
        await new Promise((r) => setTimeout(r, 200));
      } else {
        throw e;
      }
    }
  }
}

function inspectDiskModules(customPath = null) {
  const { TAGS } = require('./modular-installer');
  let asarPath = null;
  try {
    if (customPath) assertNotOfficialAntigravityApp(customPath, 'inspect ASAR');
    asarPath = findAsarPath(customPath);
  } catch (e) {
    return {
      found: false,
      asarPath: null,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: e.message,
    };
  }

  if (!asarPath || !fs.existsSync(asarPath)) {
    return {
      found: false,
      asarPath: null,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: '未找到 哈基米.app app.asar',
    };
  }

  let utilsStr = '';
  let preloadStr = '';
  let entries = [];
  try {
    utilsStr = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    preloadStr = builtinAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    entries = builtinAsar.listPackage(asarPath);
  } catch (e) {
    return {
      found: false,
      asarPath,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: '读取或解构 ASAR 归档异常: ' + e.message,
    };
  }

  const meterInjected = utilsStr.includes(TAGS.METER_UTILS_START) || utilsStr.includes('installContextMeter');
  const meterPreload = preloadStr.includes(TAGS.METER_PRELOAD_START) || preloadStr.includes('contextMeterAPI');
  const meterFilesOk = entries.includes('/dist/meter-main.js') && entries.includes('/dist/meter-core.js');
  const meterReady = meterInjected && meterPreload && meterFilesOk;

  const chineseHasTags = preloadStr.includes(TAGS.CHINESE_START) && preloadStr.includes(TAGS.CHINESE_END);
  let chineseStatus = 'not_injected';
  let chineseReady = false;
  let chineseReason = null;

  if (!chineseHasTags) {
    chineseStatus = 'not_injected';
    chineseReady = false;
    chineseReason = '磁盘尚未注入汉化脚本代码';
  } else {
    const hasDictData = preloadStr.includes('__AGY_I18N_DATA__') && preloadStr.includes('_dictData');
    const hasRuntimeEngine =
      preloadStr.includes('createI18nEngine') ||
      preloadStr.includes('translateSingleUnit') ||
      preloadStr.includes('MutationObserver');
    const hasGateLogic =
      preloadStr.includes('chinese.enabled === false') && preloadStr.includes('modules.json');

    const dictMatch = preloadStr.match(/_dictData\s*=\s*(\{[\s\S]*?\});/);
    let dictNonEmpty = false;
    if (dictMatch && dictMatch[1]) {
      dictNonEmpty = dictMatch[1].length > 500 && dictMatch[1].includes('"');
    } else if (entries.includes('/dist/i18n/zh-CN.json')) {
      dictNonEmpty = true;
    }

    if (!hasDictData || !dictNonEmpty) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化词库字典数据缺失或为空，无法实际生效';
    } else if (!hasRuntimeEngine) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化运行时引擎核心执行逻辑缺失';
    } else if (!hasGateLogic) {
      chineseStatus = 'missing_gate';
      chineseReady = false;
      chineseReason = '磁盘汉化代码缺少运行时配置门禁或有效配置路径，无法安全动态切换';
    } else {
      chineseStatus = 'ready';
      chineseReady = true;
      chineseReason = null;
    }
  }

  return {
    found: true,
    asarPath,
    meter: meterInjected,
    meterReady,
    chinese: chineseHasTags,
    chineseReady,
    chineseGate: chineseStatus === 'ready',
    chineseStatus,
    chineseReason,
  };
}

module.exports = {
  SCHEMA_VERSION,
  PROJECT_VERSION,
  DEFAULT_CONFIG,
  normalizeBrandTitle,
  normalizeClientLanguage,
  getModulesConfigPath,
  loadModulesConfig,
  saveModulesConfig,
  acquireFileLock,
  inspectDiskModules,
};
