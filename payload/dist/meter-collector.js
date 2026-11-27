'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeWriteJsonSync, safeReadJsonSync } = require('./meter-storage');
const {
  resolveEffectivePlanStatus,
  parseUserPlanStatus,
  normalizeModelId,
  resolveStableModelId,
  isValidSpeedSample,
  MAX_SPEED_SAMPLES_PER_MODEL
} = require('./meter-core');

const MAX_REMOTE_HOST_STATUS_CACHE = 32;
const TOKEN_HISTORY_CACHE_TTL_MS = 60000;

function setBoundedMap(map, key, value, maxSize, shouldSkipEvict = null) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size <= maxSize) return;
  for (const [oldKey, oldVal] of map.entries()) {
    if (map.size <= maxSize) break;
    if (oldKey === key) continue;
    if (typeof shouldSkipEvict === 'function' && shouldSkipEvict(oldVal)) continue;
    map.delete(oldKey);
  }
}

/**
 * 规范化模型标识符（小写且去掉 proto 常见 MODEL_ 前缀）
 * @param {string} raw
 * @returns {string}
 */
function normalizeModelKeyForCap(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase().replace(/^model_/, '');
}

/**
 * 读取正整数能力数值；非正数或非法值统一返回 null
 * @param {unknown} v
 * @returns {number|null}
 */
function toPositiveIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 读取非负整数能力数值（如 minThinkingBudget/maxOutputTokens 为 0）
 * @param {unknown} v
 * @returns {number|null}
 */
function toNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 解析 LanguageServerService.GetAvailableModels 响应为安全能力映射表
 * 仅提取数值/枚举/标签元数据，绝不保留敏感或无关负载
 * @param {object|null|undefined} raw
 * @returns {Record<string, object>}
 */
function parseAvailableModelsResponse(raw) {
  const out = Object.create(null);
  const modelsObj = raw?.response?.models || raw?.models || (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.userStatus ? raw : null);
  if (!modelsObj || typeof modelsObj !== 'object') return out;

  const entries = Array.isArray(modelsObj)
    ? modelsObj.map(item => [item?.model || item?.modelId || item?.id || '', item])
    : Object.entries(modelsObj);

  for (const [entryKey, d] of entries) {
    if (!d || typeof d !== 'object') continue;
    const rawId = String(d.model || d.modelId || entryKey || '').trim();
    if (!rawId) continue;
    const normKey = normalizeModelKeyForCap(rawId);
    const entry = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : null,
      maxTokens: toPositiveIntOrNull(d.maxTokens ?? d.max_tokens),
      maxOutputTokens: toNonNegativeIntOrNull(d.maxOutputTokens ?? d.max_output_tokens),
      thinkingBudget: toNonNegativeIntOrNull(d.thinkingBudget ?? d.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(d.minThinkingBudget ?? d.min_thinking_budget),
      thinkingLevel: typeof (d.thinkingLevel ?? d.thinking_level) === 'string' ? (d.thinkingLevel ?? d.thinking_level) : null,
      supportsModelInfoOverride: typeof (d.supportsModelInfoOverride ?? d.supports_model_info_override) === 'boolean'
        ? Boolean(d.supportsModelInfoOverride ?? d.supports_model_info_override)
        : null,
      modelProvider: typeof (d.modelProvider ?? d.model_provider) === 'string' ? (d.modelProvider ?? d.model_provider) : null,
      disabled: typeof d.disabled === 'boolean' ? d.disabled : null,
      recommended: typeof d.recommended === 'boolean' ? d.recommended : null,
      tagTitle: typeof (d.tagTitle ?? d.tag_title) === 'string' ? (d.tagTitle ?? d.tag_title).trim() : null,
      tagDescription: typeof (d.tagDescription ?? d.tag_description) === 'string' ? (d.tagDescription ?? d.tag_description).trim() : null,
      capabilitySource: 'get_available_models'
    };
    if (normKey) out[normKey] = entry;
    if (entryKey && normalizeModelKeyForCap(entryKey) && !out[normalizeModelKeyForCap(entryKey)]) {
      out[normalizeModelKeyForCap(entryKey)] = entry;
    }
  }
  return out;
}

/**
 * 将 GetAvailableModels 的能力字段安全合并到 cascadeModelConfigs
 * 不做按模型名称猜上限；缺失能力保持 null
 */
function mergeModelCapabilitiesIntoConfigs(configs, availableMap = null, stepCapsMap = null) {
  const list = Array.isArray(configs) ? configs.slice() : [];
  const availEntries = availableMap && typeof availableMap === 'object' ? Object.values(availableMap) : [];
  const stepEntries = stepCapsMap && typeof stepCapsMap === 'object' ? Object.values(stepCapsMap) : [];

  const lookupCap = (candidates, label) => {
    for (const c of candidates) {
      const k = normalizeModelKeyForCap(c);
      if (!k) continue;
      if (availableMap?.[k]) return availableMap[k];
      if (stepCapsMap?.[k]) return stepCapsMap[k];
    }
    const cleanLbl = typeof label === 'string' ? label.trim().toLowerCase() : '';
    if (cleanLbl) {
      const aMatches = availEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (aMatches.length === 1) return aMatches[0];
      const sMatches = stepEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (sMatches.length === 1) return sMatches[0];
    }
    return null;
  };

  const merged = list.map(cfg => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const cap = lookupCap([cfg.modelId, cfg.model, cfg.modelOrAlias?.model, cfg.modelOrAlias?.alias], cfg.label || cfg.modelDisplayName);
    if (!cap) return cfg;
    const next = { ...cfg };
    if (next.maxTokens == null && cap.maxTokens != null) next.maxTokens = cap.maxTokens;
    if (next.maxOutputTokens == null && cap.maxOutputTokens != null) next.maxOutputTokens = cap.maxOutputTokens;
    if (next.thinkingBudget == null && cap.thinkingBudget != null) next.thinkingBudget = cap.thinkingBudget;
    if (next.minThinkingBudget == null && cap.minThinkingBudget != null) next.minThinkingBudget = cap.minThinkingBudget;
    if (!next.thinkingLevel && cap.thinkingLevel) next.thinkingLevel = cap.thinkingLevel;
    if (next.supportsModelInfoOverride == null && cap.supportsModelInfoOverride != null) {
      next.supportsModelInfoOverride = cap.supportsModelInfoOverride;
    }
    if (!next.modelProvider && cap.modelProvider) next.modelProvider = cap.modelProvider;
    if (!next.capabilitySource && cap.capabilitySource) next.capabilitySource = cap.capabilitySource;
    if (next.disabled === undefined && cap.disabled !== null) next.disabled = cap.disabled;
    if (!next.tagTitle && cap.tagTitle) next.tagTitle = cap.tagTitle;
    if (!next.tagDescription && cap.tagDescription) next.tagDescription = cap.tagDescription;
    return next;
  });

  return merged;
}

function sanitizeCascadeModelConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const tagTitle = typeof c.tagTitle === 'string' ? c.tagTitle.trim() : '';
  const tagDesc = typeof c.tagDescription === 'string' ? c.tagDescription.trim() : '';
  const isTagUnavailable = /unavailable|disabled|不可用/i.test(tagTitle);
  const isUnavail = Boolean(
    c.unavailable === true ||
    c.isUnavailable === true ||
    c.status === 'unavailable' ||
    c.disabled === true ||
    c.enabled === false ||
    isTagUnavailable
  );
  const isHist = Boolean(
    c.isHistorical === true ||
    c.historical === true ||
    c.deprecated === true ||
    c.isDeprecated === true ||
    (typeof c.label === 'string' && /\(legacy\)|\(deprecated\)|\(old\)/i.test(c.label))
  );
  return {
    modelId: c.modelId || c.model || '',
    label: c.label || c.modelDisplayName || c.modelId || '',
    modelOrAlias: c.modelOrAlias || null,
    value: c.value !== undefined ? c.value : undefined,
    modelAlias: c.modelAlias !== undefined ? c.modelAlias : undefined,
    quotaInfo: c.quotaInfo ? {
      remainingFraction: typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: c.quotaInfo.resetTime || null
    } : null,
    tagTitle: tagTitle || null,
    tagDescription: tagDesc || null,
    contextWindowOptions: Array.isArray(c.contextWindowOptions) ? c.contextWindowOptions : undefined,
    maxTokens: toPositiveIntOrNull(c.maxTokens ?? c.max_tokens),
    maxOutputTokens: toNonNegativeIntOrNull(c.maxOutputTokens ?? c.max_output_tokens),
    thinkingBudget: toNonNegativeIntOrNull(c.thinkingBudget ?? c.thinking_budget),
    minThinkingBudget: toNonNegativeIntOrNull(c.minThinkingBudget ?? c.min_thinking_budget),
    thinkingLevel: typeof (c.thinkingLevel ?? c.thinking_level) === 'string' ? (c.thinkingLevel ?? c.thinking_level) : null,
    supportsModelInfoOverride: typeof (c.supportsModelInfoOverride ?? c.supports_model_info_override) === 'boolean'
      ? Boolean(c.supportsModelInfoOverride ?? c.supports_model_info_override)
      : null,
    modelProvider: typeof (c.modelProvider ?? c.model_provider) === 'string' ? (c.modelProvider ?? c.model_provider) : null,
    capabilitySource: typeof c.capabilitySource === 'string' ? c.capabilitySource : null,
    unavailable: isUnavail,
    unavailabilityReason: c.unavailabilityReason || c.disabledReason || c.reason || (isUnavail ? (tagDesc || tagTitle || null) : null),
    notice: c.notice || c.clientNotice || c.warning || (!isUnavail && tagTitle ? `${tagTitle}${tagDesc ? `：${tagDesc}` : ''}` : null),
    isHistorical: isHist,
    releaseDate: c.releaseDate || null,
    family: c.family || null,
    effort: c.effort || null
  };
}

let cachedTokenHistory = null;
let cachedTokenHistoryAt = 0;
const archiveFileCache = new Map();

function readArchiveJsonCached(filePath, backupPath) {
  try {
    if (!fs.existsSync(filePath)) {
      archiveFileCache.delete(filePath);
      return { exists: false, ok: false, data: null };
    }
    const st = fs.statSync(filePath);
    const cached = archiveFileCache.get(filePath);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return { exists: true, ok: true, data: cached.data };
    }
    const res = safeReadJsonSync(filePath, null, { backupPath });
    if (res.exists && res.ok && res.data && typeof res.data === 'object') {
      setBoundedMap(archiveFileCache, filePath, { size: st.size, mtimeMs: st.mtimeMs, data: res.data }, 16);
    }
    return res;
  } catch {
    return safeReadJsonSync(filePath, null, { backupPath });
  }
}

function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 检查是否为 SQLite 伴生文件或临时文件
function isCompanionOrTempFile(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('-wal') ||
         lower.endsWith('-shm') ||
         lower.endsWith('-journal') ||
         lower.endsWith('.tmp') ||
         lower.endsWith('.lock') ||
         lower.endsWith('.bak');
}

// 尝试安全读取 LanguageServer 的 GetUserStatus

// ============================================================================
// 逐请求已计价账本持久化、合成数据隔离与幂等入账
// ============================================================================
let cachedLedger = null;
let pendingLedgerFlushTimer = null;
let pendingLedgerDraft = null;
let lastLedgerFlushAt = 0;
const STREAMING_LEDGER_DEBOUNCE_MS = 1500;
const STREAMING_LEDGER_MAX_DELAY_MS = 2500;

function flushPricingLedger() {
  if (pendingLedgerFlushTimer) {
    clearTimeout(pendingLedgerFlushTimer);
    pendingLedgerFlushTimer = null;
  }
  if (!pendingLedgerDraft) {
    return { ok: true, flushed: false };
  }
  const toSave = pendingLedgerDraft;
  pendingLedgerDraft = null;
  const saveRes = savePricingLedger(toSave);
  if (saveRes.ok) {
    lastLedgerFlushAt = Date.now();
  } else {
    pendingLedgerDraft = toSave;
  }
  return { ...saveRes, flushed: Boolean(saveRes.ok) };
}

function isSyntheticCall(callId, call = {}) {
  if (!callId) return false;
  const sId = String(callId).toLowerCase();
  const cId = String(call?.cascadeId || '').toLowerCase();
  return sId.startsWith('test_') ||
         sId.startsWith('fixture_') ||
         sId.startsWith('synthetic_') ||
         sId.includes('desktop_response_001') ||
         cId.includes('verify') ||
         cId.includes('test') ||
         cId.includes('mock');
}

function getPricingLedgerPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'pricing_ledger_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'pricing_ledger_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'pricing_ledger_v1.json');
}

function quarantineSyntheticCalls(overridePathOrDir) {
  const p = getPricingLedgerPath(overridePathOrDir);
  const qPath = p.replace('pricing_ledger_v1.json', 'pricing_ledger_quarantine.json');
  if (!fs.existsSync(p)) return { quarantinedCount: 0 };

  try {
    const readRes = safeReadJsonSync(p, null);
    if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
      return { quarantinedCount: 0 };
    }
    const raw = readRes.data;
    const calls = raw.calls || {};
    const quarantined = {};
    const kept = {};

    for (const [id, call] of Object.entries(calls)) {
      if (isSyntheticCall(id, call)) {
        quarantined[id] = call;
      } else {
        kept[id] = call;
      }
    }

    const qCount = Object.keys(quarantined).length;
    if (qCount > 0) {
      let qData = { version: '1.0.0', quarantinedAt: new Date().toISOString(), calls: {} };
      if (fs.existsSync(qPath)) {
        const qRead = safeReadJsonSync(qPath, null);
        if (qRead.ok && qRead.data && typeof qRead.data === 'object') {
          qData = qRead.data;
        }
      }
      qData.calls = { ...qData.calls, ...quarantined };
      safeWriteJsonSync(qPath, qData);

      raw.calls = kept;
      raw.updatedAt = new Date().toISOString();
      const saveRes = safeWriteJsonSync(p, raw);
      if (saveRes.ok && cachedLedger && cachedLedger.calls) {
        cachedLedger.calls = kept;
      }
    }
    return { quarantinedCount: qCount };
  } catch {
    return { quarantinedCount: 0 };
  }
}

function loadPricingLedger(overridePathOrDir) {
  if (!overridePathOrDir && cachedLedger && !cachedLedger.__corrupted) return cachedLedger;
  const p = getPricingLedgerPath(overridePathOrDir);
  const def = { version: '1.0.0', updatedAt: '', calls: {} };
  const bakPath = p.replace(/\.json$/i, '') + '.bak.json';
  const readRes = safeReadJsonSync(p, null, {
    backupPath: bakPath,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });

  if (!readRes.exists) {
    if (!overridePathOrDir) cachedLedger = def;
    return def;
  }

  if (readRes.corrupted && !readRes.recoveredFromBackup) {
    // 文件存在但损坏且无备份可恢复，绝不能当作正常空数据覆盖
    return {
      version: '1.0.0',
      updatedAt: '',
      calls: {},
      __corrupted: true,
      __corruptedPath: p,
      __error: readRes.error
    };
  }

  const raw = readRes.data || def;
  const ledger = { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || '', calls: raw.calls || {} };
  let hasSynthetic = false;
  for (const [id, call] of Object.entries(ledger.calls)) {
    if (isSyntheticCall(id, call)) {
      hasSynthetic = true;
      break;
    }
  }
  if (hasSynthetic) {
    quarantineSyntheticCalls(overridePathOrDir);
    const cleanedRes = safeReadJsonSync(p, null);
    if (cleanedRes.ok && cleanedRes.data && typeof cleanedRes.data === 'object') {
      ledger.calls = cleanedRes.data.calls || {};
      ledger.updatedAt = cleanedRes.data.updatedAt || '';
    }
  }

  // 正常落盘数据建立自动滚动备份，供损坏时恢复
  if (!readRes.corrupted && fs.existsSync(p)) {
    try {
      if (!fs.existsSync(bakPath) || Math.random() < 0.1) {
        fs.copyFileSync(p, bakPath);
      }
    } catch {}
  }

  if (!overridePathOrDir) cachedLedger = ledger;
  return ledger;
}

function savePricingLedger(ledger, overridePathOrDir) {
  if (ledger && ledger.__corrupted) {
    return { ok: false, error: '原账本数据已损坏且未从备份恢复，已阻止以空数据覆盖原有历史' };
  }
  const p = getPricingLedgerPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, ledger, {
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });
  if (res.ok) {
    if (!overridePathOrDir) cachedLedger = ledger;
  }
  return res;
}

function createRecordResult(ok, changed, error, phase) {
  return {
    ok: !!ok,
    changed: !!changed,
    error: error || undefined,
    phase: phase || undefined,
    valueOf() { return this.changed; }
  };
}

function hasSpeedMetrics(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return rec.durationSec != null || rec.tps != null || rec.ttftSec != null || rec.streamingSec != null;
}

function getCallSortTimestamp(rec) {
  if (!rec) return 0;
  if (Number.isFinite(Number(rec.timestamp)) && Number(rec.timestamp) > 0) return Number(rec.timestamp);
  if (rec.created_at) {
    const t = Date.parse(rec.created_at);
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (rec.date) {
    const t = Date.parse(rec.date);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Number(rec.updatedAt) || 0;
}

/**
 * 每个准确模型 ID 最多保留最近 200 条速度样本；超出的只清除速度字段，计费与 token 数据保留不动
 */
function pruneExcessSpeedSamples(draftCalls, limit = MAX_SPEED_SAMPLES_PER_MODEL || 200) {
  if (!draftCalls || typeof draftCalls !== 'object') return false;
  const byModel = new Map();
  for (const [callId, rec] of Object.entries(draftCalls)) {
    if (!rec || !hasSpeedMetrics(rec)) continue;
    const exactId = String(rec.modelExactId || resolveStableModelId(rec) || rec.model || '').trim().toLowerCase();
    if (!exactId) continue;
    if (!byModel.has(exactId)) byModel.set(exactId, []);
    byModel.get(exactId).push({ callId, ts: getCallSortTimestamp(rec) });
  }
  let pruned = false;
  for (const entries of byModel.values()) {
    if (entries.length <= limit) continue;
    entries.sort((a, b) => b.ts - a.ts);
    for (let i = limit; i < entries.length; i++) {
      const rec = draftCalls[entries[i].callId];
      if (!rec) continue;
      const copy = { ...rec };
      delete copy.ttftSec;
      delete copy.streamingSec;
      delete copy.durationSec;
      delete copy.tps;
      delete copy.origin;
      draftCalls[entries[i].callId] = copy;
      pruned = true;
    }
  }
  return pruned;
}

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const ledger = loadPricingLedger(targetDir);

  if (ledger.__corrupted) {
    return createRecordResult(false, false, `账本已损坏，阻止空覆盖 (${ledger.__corruptedPath})`, 'corrupted_guard');
  }

  // 使用独立副本避免在写入磁盘失败前原地修改共享缓存
  const draftCalls = { ...(ledger.calls || {}) };
  let changed = false;
  let hasFinalUpdate = false;

  for (const call of newCalls) {
    if (!call || !call.callId) continue;
    // 默认阻止测试样例和合成调用污染生产账本
    if (!options.allowSynthetic && isSyntheticCall(call.callId, call)) continue;

    const existing = draftCalls[call.callId];
    if (!existing) {
      draftCalls[call.callId] = {
        ...call,
        updatedAt: Date.now()
      };
      changed = true;
      if (call.status !== 'streaming') hasFinalUpdate = true;
      continue;
    }

    // 幂等入账与数据校准：记录新调用；当存在更完整、最终用量或补齐实测速度数据时更新校准
    const stateProgressed = existing.status === 'streaming' && call.status === 'final';
    const usageProgressed = (call.outputTokens || 0) > (existing.outputTokens || 0) || (call.totalTokens || 0) > (existing.totalTokens || 0);
    const speedProgressed = !hasSpeedMetrics(existing) && hasSpeedMetrics(call) && isValidSpeedSample(call);
    const modelExactProgressed = !existing.modelExactId && Boolean(call.modelExactId);
    const isStaleRollback = (existing.status === 'final' && call.status !== 'final') ||
      (existing.status === 'final' && (call.outputTokens || 0) < (existing.outputTokens || 0));

    if (!isStaleRollback && (stateProgressed || usageProgressed || speedProgressed || modelExactProgressed)) {
      draftCalls[call.callId] = {
        ...existing,
        ...call,
        created_at: existing.created_at || call.created_at,
        date: existing.date || call.date,
        updatedAt: Date.now()
      };
      changed = true;
      if (stateProgressed || call.status !== 'streaming') hasFinalUpdate = true;
    }
  }

  if (pruneExcessSpeedSamples(draftCalls)) {
    changed = true;
  }

  if (changed) {
    const draftLedger = {
      ...ledger,
      calls: draftCalls,
      updatedAt: new Date().toISOString()
    };
    const canDebounce =
      !targetDir &&
      options.immediate !== true &&
      !hasFinalUpdate &&
      Date.now() - lastLedgerFlushAt < STREAMING_LEDGER_MAX_DELAY_MS;
    if (canDebounce) {
      cachedLedger = draftLedger;
      pendingLedgerDraft = draftLedger;
      cachedTokenHistoryAt = 0;
      if (!pendingLedgerFlushTimer) {
        pendingLedgerFlushTimer = setTimeout(() => {
          pendingLedgerFlushTimer = null;
          flushPricingLedger();
        }, STREAMING_LEDGER_DEBOUNCE_MS);
        if (typeof pendingLedgerFlushTimer.unref === 'function') {
          pendingLedgerFlushTimer.unref();
        }
      }
      return createRecordResult(true, true);
    }
    if (!targetDir && pendingLedgerFlushTimer) {
      clearTimeout(pendingLedgerFlushTimer);
      pendingLedgerFlushTimer = null;
      pendingLedgerDraft = null;
    }
    const saveRes = savePricingLedger(draftLedger, targetDir);
    if (!saveRes.ok) {
      return createRecordResult(false, false, saveRes.error || '保存账本落盘失败', saveRes.phase);
    }
    if (!targetDir) {
      lastLedgerFlushAt = Date.now();
      cachedTokenHistoryAt = 0;
    }
  }

  return createRecordResult(true, changed);
}

// ============================================================================
// 用户自定义订阅配置与插件栏偏好持久化（按账号隔离 + default 回退 + 损坏自愈）
// ============================================================================
function getCustomPlanPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'custom_plan_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'custom_plan_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'custom_plan_v1.json');
}

function sanitizeAccountPlanEntry(entry, accountKey = 'default') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = { ...entry };
  out.account = String(entry.account || accountKey || 'default').trim().toLowerCase();
  if (typeof out.customNote === 'string') {
    out.customNote = out.customNote.trim();
  }
  return out;
}

function loadCustomPlanSettings(overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const def = {
    version: '1.1.0',
    updatedAt: '',
    lastAccount: 'default',
    accounts: {},
    uiPreferences: {}
  };
  try {
    if (!fs.existsSync(p)) return def;
    const content = fs.readFileSync(p, 'utf8');
    if (!content.trim()) return def;
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (parseErr) {
      // 配置文件损坏时自动隔离备份并恢复默认结构，防止崩溃
      try {
        const bakCorrupt = p.replace(/\.json$/i, '') + '.corrupt.bak.json';
        fs.copyFileSync(p, bakCorrupt);
      } catch {}
      return { ...def, recoveredFromCorruption: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...def, recoveredFromCorruption: true };
    }

    const accounts = {};
    // 兼容旧版直接平铺在顶层的配置结构
    if (!raw.accounts && (raw.region || raw.subscriptionRegion || raw.country || raw.currency || raw.actualPricePaid !== undefined)) {
      const legacyEntry = sanitizeAccountPlanEntry(raw, raw.email || raw.account || 'default');
      if (legacyEntry) {
        accounts[legacyEntry.account] = legacyEntry;
        accounts['default'] = { ...legacyEntry, account: 'default' };
      }
    } else if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [k, v] of Object.entries(raw.accounts)) {
        const cleanKey = String(k).trim().toLowerCase();
        const sanitized = sanitizeAccountPlanEntry(v, cleanKey);
        if (sanitized) accounts[cleanKey] = sanitized;
      }
    }

    const uiPreferences = (raw.uiPreferences && typeof raw.uiPreferences === 'object' && !Array.isArray(raw.uiPreferences))
      ? { ...raw.uiPreferences }
      : {};

    return {
      version: raw.version || '1.1.0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      lastAccount: typeof raw.lastAccount === 'string' ? raw.lastAccount : 'default',
      accounts,
      uiPreferences
    };
  } catch {
    return def;
  }
}

function saveCustomPlanSettingsDetailed(settings, overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, settings, {
    validate: (data) => data && typeof data === 'object' && !Array.isArray(data)
  });
  if (!res.ok) {
    return { ok: false, error: res.error || '写入配置文件失败', phase: res.phase, path: p };
  }
  return { ok: true, path: p };
}

function saveCustomPlanSettings(settings, overridePathOrDir) {
  return saveCustomPlanSettingsDetailed(settings, overridePathOrDir).ok;
}

function setCustomPlanForAccount(accountKey, customData = {}, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  const merged = sanitizeAccountPlanEntry({
    ...(settings.accounts[key] || {}),
    ...customData,
    account: key,
    updatedAt: new Date().toISOString()
  }, key);
  if (!merged) return false;
  settings.accounts[key] = merged;
  // 同步 default 槽位与最近活跃账号，供启动早期尚未取得邮箱时读取
  settings.accounts['default'] = {
    ...(settings.accounts['default'] || {}),
    ...merged,
    account: 'default'
  };
  if (key !== 'default') settings.lastAccount = key;
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function clearCustomPlanForAccount(accountKey, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  delete settings.accounts[key];
  delete settings.accounts['default'];
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function resolveAccountCustomPlan(customSettingsAll, currentAccountKey) {
  if (!customSettingsAll || !customSettingsAll.accounts) return null;
  const accMap = customSettingsAll.accounts;
  if (currentAccountKey) {
    const k = String(currentAccountKey).trim().toLowerCase();
    if (accMap[k]) return accMap[k];
    // 账号隔离：明确指定了账号（非 default），但在配置中不存在该账号记录时，绝不回退到 default 或 lastAccount
    if (k !== 'default') return null;
  }
  // 仅在未指定账号（启动早期）或明确是 default 时，才允许检查 lastAccount 或 default
  if (!currentAccountKey || currentAccountKey === 'default') {
    if (customSettingsAll.lastAccount && accMap[customSettingsAll.lastAccount]) {
      return accMap[customSettingsAll.lastAccount];
    }
    if (accMap['default']) return accMap['default'];
  }
  return null;
}

function getPluginSettings(options = {}) {
  const targetDir = typeof options === 'string' ? options : options?.agDir;
  const settings = loadCustomPlanSettings(targetDir);
  const email = options?.email || cachedTokenHistory?.planStatus?.email || null;
  const customPlan = resolveAccountCustomPlan(settings, email);
  const uiPrefs = settings.uiPreferences || {};
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    savedHeatView: uiPrefs.savedHeatView,
    panelLanguage: uiPrefs.panelLanguage || 'zh-CN',
    accounts: settings.accounts || {},
    updatedAt: settings.updatedAt || '',
    recoveredFromCorruption: Boolean(settings.recoveredFromCorruption)
  };
}

function savePluginSettings(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '无效的设置参数' };
  }
  const targetDir = typeof options === 'string' ? options : (options?.targetDir || options?.agDir || payload?.targetDir || payload?.agDir);
  const settings = loadCustomPlanSettings(targetDir);
  const rawKey = payload.account || payload.email || cachedTokenHistory?.planStatus?.email || settings.lastAccount || 'default';
  const key = String(rawKey).trim().toLowerCase() || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[key];
    if (key === 'default' || settings.lastAccount === key) {
      delete settings.accounts['default'];
      settings.lastAccount = 'default';
    }
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    // 账号隔离约束：新账号独立初始化，禁止从默认配置继承以避免跨账号数据污染
    const prev = settings.accounts[key] || {};
    const inputPlan = payload.customPlan;
    const mergedRaw = {
      ...prev,
      ...inputPlan,
      account: key,
      updatedAt: new Date().toISOString()
    };

    // 兼容层双向同步：若更新了兼容字段（如 currency），同步更新规范字段，防止被 prev 中的旧规范字段覆盖
    if (inputPlan.currency && !inputPlan.subscriptionCurrency) {
      mergedRaw.subscriptionCurrency = inputPlan.currency;
    }
    if (inputPlan.subscriptionCurrency && !inputPlan.currency) {
      mergedRaw.currency = inputPlan.subscriptionCurrency;
    }
    if (inputPlan.country && !inputPlan.accountRegion) {
      mergedRaw.accountRegion = inputPlan.country;
    }
    if (inputPlan.accountRegion && !inputPlan.country) {
      mergedRaw.country = inputPlan.accountRegion;
    }
    if (inputPlan.subscriptionRegion && !inputPlan.subscriptionCountry) {
      mergedRaw.subscriptionCountry = inputPlan.subscriptionRegion;
    }
    if (inputPlan.subscriptionCountry && !inputPlan.subscriptionRegion) {
      mergedRaw.subscriptionRegion = inputPlan.subscriptionCountry;
      mergedRaw.region = inputPlan.subscriptionCountry;
    }

    // 传入 null 或空字符串时，从合并对象中删除对应字段
    if (inputPlan.country === null || inputPlan.country === '' || inputPlan.accountRegion === null || inputPlan.accountRegion === '') {
      delete mergedRaw.country;
      delete mergedRaw.accountRegion;
    }
    if (inputPlan.subscriptionRegion === null || inputPlan.subscriptionRegion === '' || inputPlan.subscriptionCountry === null || inputPlan.subscriptionCountry === '' || inputPlan.region === null || inputPlan.region === '') {
      delete mergedRaw.subscriptionRegion;
      delete mergedRaw.subscriptionCountry;
      delete mergedRaw.region;
    }
    if (inputPlan.currency === null || inputPlan.currency === '' || inputPlan.subscriptionCurrency === null || inputPlan.subscriptionCurrency === '') {
      delete mergedRaw.currency;
      delete mergedRaw.subscriptionCurrency;
      delete mergedRaw.currencySymbol;
    }

    const sanitized = sanitizeAccountPlanEntry(mergedRaw, key);
    if (!sanitized) {
      return { ok: false, error: '订阅设置格式无效' };
    }
    settings.accounts[key] = sanitized;
    if (key === 'default') {
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    } else {
      settings.lastAccount = key;
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    }
  }

  const topLevelUiPrefs = {};
  if (typeof payload.savedHeatView === 'string' && payload.savedHeatView) {
    topLevelUiPrefs.savedHeatView = payload.savedHeatView;
  }
  const validPanelLanguages = new Set(['zh-CN', 'zh-TW', 'en']);
  if (typeof payload.panelLanguage === 'string' && validPanelLanguages.has(payload.panelLanguage)) {
    topLevelUiPrefs.panelLanguage = payload.panelLanguage;
  }
  const incomingUiPrefs = (payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences))
    ? { ...payload.uiPreferences, ...topLevelUiPrefs }
    : (Object.keys(topLevelUiPrefs).length > 0 ? topLevelUiPrefs : null);

  if (incomingUiPrefs) {
    if (incomingUiPrefs.panelLanguage !== undefined && !validPanelLanguages.has(incomingUiPrefs.panelLanguage)) {
      delete incomingUiPrefs.panelLanguage;
    }
    const nextUi = {
      ...(settings.uiPreferences || {}),
      ...incomingUiPrefs,
      updatedAt: new Date().toISOString()
    };
    if (nextUi.restartVerification === null) {
      delete nextUi.restartVerification;
    }
    settings.uiPreferences = nextUi;
  }

  delete settings.recoveredFromCorruption;
  settings.updatedAt = new Date().toISOString();
  const writeRes = saveCustomPlanSettingsDetailed(settings, targetDir);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || '配置落盘失败' };
  }

  const activeCustom = resolveAccountCustomPlan(settings, key === 'default' ? null : key);
  const baseLive = cachedTokenHistory?.rawPlanStatus || cachedTokenHistory?.planStatus || null;
  const effectivePlanStatus = resolveEffectivePlanStatus(baseLive, activeCustom, {
    cachedLivePlan: baseLive,
    currentEmail: key === 'default' ? (baseLive?.email || null) : key
  });

  // 同步更新内存缓存与 v2 归档中的 planStatus，确保刷新或重启即刻一致
  if (!targetDir && cachedTokenHistory) {
    cachedTokenHistory.planStatus = effectivePlanStatus;
    cachedTokenHistory.customPlanSettings = activeCustom;
    cachedTokenHistory.uiPreferences = settings.uiPreferences;
  }
  let archiveSyncWarning = null;
  let archiveSynced = false;
  try {
    const home = process.env.USERPROFILE || os.homedir();
    const agDir = targetDir && !targetDir.endsWith('.json') ? targetDir : (process.env.AG_DIR || path.join(home, '.gemini', 'antigravity'));
    const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');
    if (fs.existsSync(archivePathV2)) {
      const readRes = safeReadJsonSync(archivePathV2, null);
      if (readRes.ok && readRes.data && typeof readRes.data === 'object') {
        const v2Raw = { ...readRes.data };
        v2Raw.planStatus = effectivePlanStatus;
        v2Raw.customPlanSettings = activeCustom;
        const writeArch = safeWriteJsonSync(archivePathV2, v2Raw);
        if (!writeArch.ok) {
          archiveSyncWarning = writeArch.error || '写入 v2 归档文件失败';
        } else {
          archiveSynced = true;
        }
      } else if (readRes.corrupted) {
        archiveSyncWarning = 'v2 归档文件内容已损坏，已阻止回写覆盖以保护原始数据';
      }
    }
  } catch (err) {
    archiveSyncWarning = err?.message || '同步派生归档时发生未知异常';
  }

  return {
    ok: true,
    partial: archiveSyncWarning !== null,
    warning: archiveSyncWarning ? `主配置已保存，但派生归档同步失败: ${archiveSyncWarning}` : undefined,
    archiveSynced,
    path: writeRes.path,
    savedAt: settings.updatedAt,
    customPlan: activeCustom,
    planStatus: effectivePlanStatus,
    uiPreferences: settings.uiPreferences
  };
}

let cachedHostUserStatus = null;
let cachedHostUserStatusAt = 0;
const remoteHostUserStatusCache = new Map();
const QUOTA_FORCE_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastQuotaForceRefreshAtByHost = new Map();
const pendingQuotaForceRefreshHosts = new Set();

function normalizeQuotaHostKey(hostKey) {
  return String(hostKey || 'local').trim() || 'local';
}

function isQuotaForceRefreshDue(hostKey = 'local', now = Date.now()) {
  const key = normalizeQuotaHostKey(hostKey);
  const lastAt = lastQuotaForceRefreshAtByHost.get(key) || 0;
  return lastAt === 0 || (now - lastAt) >= QUOTA_FORCE_REFRESH_MIN_INTERVAL_MS;
}

function markConversationTurnCompleted(hostKey = 'local', now = Date.now()) {
  const key = normalizeQuotaHostKey(hostKey);
  if (!isQuotaForceRefreshDue(key, now)) return false;
  pendingQuotaForceRefreshHosts.add(key);
  return true;
}

function consumePendingQuotaForceRefresh(hostKey = 'local', now = Date.now()) {
  const key = normalizeQuotaHostKey(hostKey);
  if (!pendingQuotaForceRefreshHosts.has(key)) return false;
  pendingQuotaForceRefreshHosts.delete(key);
  return isQuotaForceRefreshDue(key, now);
}

function invalidateLocalAccountCaches() {
  cachedHostUserStatus = null;
  cachedHostUserStatusAt = 0;
  cachedTokenHistoryAt = 0;
  lastQuotaForceRefreshAtByHost.delete('local');
  pendingQuotaForceRefreshHosts.add('local');
}

function pickTrimmedString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function parseQuotaSummaryBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const rawRemaining =
    bucket.remainingFraction ??
    bucket.remaining_fraction ??
    bucket.remaining?.remainingFraction ??
    bucket.remaining?.remaining_fraction;
  const remainingFraction =
    rawRemaining !== undefined && rawRemaining !== null && rawRemaining !== '' && Number.isFinite(Number(rawRemaining))
      ? Number(rawRemaining)
      : null;
  return {
    bucketId: bucket.bucketId || bucket.bucket_id || null,
    displayName: pickTrimmedString(bucket.displayName, bucket.display_name),
    description: pickTrimmedString(bucket.description),
    window: pickTrimmedString(bucket.window, bucket.refreshWindowLabel, bucket.refresh_window_label),
    remainingFraction,
    resetTime: bucket.resetTime || bucket.reset_time || null,
    disabled: bucket.disabled === true
  };
}

function parseQuotaSummaryResponse(quotaRes) {
  const summary = quotaRes?.response || quotaRes;
  if (!summary || typeof summary !== 'object') return null;
  if (Array.isArray(summary.groups)) {
    return summary.groups
      .filter(group => group && typeof group === 'object')
      .map(group => ({
        displayName: pickTrimmedString(group.displayName, group.display_name),
        description: pickTrimmedString(group.description),
        buckets: Array.isArray(group.buckets)
          ? group.buckets.map(parseQuotaSummaryBucket).filter(Boolean)
          : []
      }));
  }
  if (Array.isArray(summary.buckets)) {
    const grouped = new Map();
    for (const rawBucket of summary.buckets) {
      const bucket = parseQuotaSummaryBucket(rawBucket);
      if (!bucket) continue;
      const key = bucket.displayName || bucket.bucketId || 'default';
      if (!grouped.has(key)) {
        grouped.set(key, { displayName: bucket.displayName || key, description: bucket.description || '', buckets: [] });
      }
      grouped.get(key).buckets.push(bucket);
    }
    return Array.from(grouped.values());
  }
  return null;
}

async function fetchLiveUserStatus(request, prevStatus = null, options = {}) {
  const forceRefreshQuota = options?.forceRefreshQuota === true;
  const [res, availRes, quotaRes] = await Promise.all([
    request('GetUserStatus', {}),
    request('GetAvailableModels', { forceRefresh: false }).catch(() => null),
    request('RetrieveUserQuotaSummary', { request: {}, forceRefresh: forceRefreshQuota }).catch(() => null)
  ]);
  const parsed = parseUserPlanStatus(res);
  const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const availMap = availRes ? parseAvailableModelsResponse(availRes) : {};
  if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
  if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
  const quotaGroups = parseQuotaSummaryResponse(quotaRes);
  if (Array.isArray(quotaGroups)) {
    parsed.modelQuotaGroups = quotaGroups;
  } else if (
    Array.isArray(prevStatus?.modelQuotaGroups) &&
    (!parsed.email || !prevStatus.email || parsed.email === prevStatus.email)
  ) {
    parsed.modelQuotaGroups = prevStatus.modelQuotaGroups;
  }
  return parsed;
}

async function fetchUserStatusFromHost(options = {}) {
  const now = typeof options?.now === 'number' ? options.now : Date.now();
  if (options && options.userStatus !== undefined) {
    if (!options.userStatus) return null;
    const parsed = parseUserPlanStatus(options.userStatus);
    const configs = options.userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || options.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = options.availableModels ? parseAvailableModelsResponse(options.availableModels) : {};
    const quotaGroups = options.quotaSummary ? parseQuotaSummaryResponse(options.quotaSummary) : null;
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
      if (Array.isArray(quotaGroups)) parsed.modelQuotaGroups = quotaGroups;
    }
    return parsed;
  }
  if (typeof options.requestFn === 'function') {
    const cacheKey = normalizeQuotaHostKey(options.remoteHostId || 'ssh');
    const cached = remoteHostUserStatusCache.get(cacheKey);
    const shouldForceQuota = consumePendingQuotaForceRefresh(cacheKey, now);
    if (!options.force && !shouldForceQuota && cached && now - cached.at < 60000) {
      return cached.data;
    }
    try {
      const parsed = await fetchLiveUserStatus(options.requestFn, cached?.data || null, { forceRefreshQuota: shouldForceQuota });
      if (shouldForceQuota) {
        setBoundedMap(lastQuotaForceRefreshAtByHost, cacheKey, now, MAX_REMOTE_HOST_STATUS_CACHE);
      }
      setBoundedMap(remoteHostUserStatusCache, cacheKey, { data: parsed, at: now }, MAX_REMOTE_HOST_STATUS_CACHE);
      return parsed;
    } catch {
      return cached?.data || null;
    }
  }
  const shouldForceQuota = !options.agDir && consumePendingQuotaForceRefresh('local', now);
  if (!options.agDir && !options.force && !shouldForceQuota && cachedHostUserStatus && now - cachedHostUserStatusAt < 60000) {
    return cachedHostUserStatus;
  }
  try {
    const { connect } = require('./local-api');
    const api = await connect();
    const parsed = await fetchLiveUserStatus(api.call, !options.agDir ? cachedHostUserStatus : null, { forceRefreshQuota: shouldForceQuota });
    if (shouldForceQuota) {
      setBoundedMap(lastQuotaForceRefreshAtByHost, 'local', now, MAX_REMOTE_HOST_STATUS_CACHE);
    }
    if (parsed && !options.agDir) {
      if (parsed.email || parsed.status === 'identified') {
        cachedHostUserStatus = parsed;
        cachedHostUserStatusAt = now;
      } else {
        cachedHostUserStatus = null;
        cachedHostUserStatusAt = 0;
      }
    }
    return parsed;
  } catch {
    return cachedHostUserStatus || null;
  }
}

let activeScanPromise = null;
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

async function collectTokenHistoryAsync(options = {}) {
  if (options && options.remoteUserStatusOptions && typeof options.remoteUserStatusOptions.requestFn === 'function') {
    const { remoteUserStatusOptions, ...localOpts } = options;
    const base = await collectTokenHistoryAsync(localOpts);
    try {
      const remoteLive = await fetchUserStatusFromHost({
        ...remoteUserStatusOptions,
        force: options.force === true
      });
      if (remoteLive) {
        const home = process.env.USERPROFILE || os.homedir();
        const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
        const customSettingsAll = loadCustomPlanSettings(agDir);
        const currentAccountKey = remoteLive?.email || null;
        const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);
        const effectivePlanStatus = resolveEffectivePlanStatus(remoteLive, currentCustom, {
          cachedLivePlan: base?.rawPlanStatus || null,
          currentEmail: currentAccountKey
        });
        const compactModelConfigs = Array.isArray(remoteLive?.cascadeModelConfigs)
          ? remoteLive.cascadeModelConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
          : (base.cascadeModelConfigs || []);
        return {
          ...base,
          cascadeModelConfigs: compactModelConfigs,
          modelCapabilitiesById: remoteLive?.availableModelDetails || base.modelCapabilitiesById || null,
          planStatus: effectivePlanStatus,
          rawPlanStatus: remoteLive,
          customPlanSettings: currentCustom
        };
      }
    } catch {}
    return base;
  }
  const hasPendingLocalQuotaRefresh = !options.agDir && pendingQuotaForceRefreshHosts.has('local');
  if (!options.force && !hasPendingLocalQuotaRefresh && !options.agDir && cachedTokenHistory && Date.now() - cachedTokenHistoryAt < TOKEN_HISTORY_CACHE_TTL_MS) {
    return cachedTokenHistory;
  }
  if (!options.agDir && activeScanPromise) {
    return activeScanPromise;
  }

  const thisScanSeq = ++currentScanSequence;
  const runner = (async () => {
    const home = process.env.USERPROFILE || os.homedir();
  const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');

  const brainDir = path.join(agDir, 'brain');
  const convDir = path.join(agDir, 'conversations');
  const archivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');

  // 1. 读取旧 v1 归档（基于 size+mtime 缓存，避免重复同步解析；首次迁移自动生成 .bak 备份）
  const bakPathV1 = path.join(agDir, 'token_usage_archive_v1.bak.json');
  const readV1 = readArchiveJsonCached(archivePathV1, bakPathV1);
  let legacyV1Archive = { firstUseDate: null, dailyMap: {}, maxConversations: 0 };
  if (readV1.exists) {
    if (readV1.ok && readV1.data && typeof readV1.data === 'object') {
      legacyV1Archive = readV1.data;
      if (!fs.existsSync(bakPathV1)) {
        try { fs.copyFileSync(archivePathV1, bakPathV1); } catch {}
      }
    }
  }

  // 2. 读取已有的 v2 归档
  const bakPathV2 = path.join(agDir, 'token_usage_archive_v2.bak.json');
  const readV2 = readArchiveJsonCached(archivePathV2, bakPathV2);
  let archiveV2 = {
    version: '2.0.0',
    firstUseDate: legacyV1Archive.firstUseDate || null,
    planStatus: null,
    dailyMapBySource: {
      desktop: {},
      cli: {},
      legacyUnallocated: legacyV1Archive.dailyMap || {}
    }
  };
  if (readV2.exists) {
    if (readV2.ok && readV2.data && typeof readV2.data === 'object') {
      archiveV2 = { ...archiveV2, ...readV2.data };
      if (!fs.existsSync(bakPathV2)) {
        try { fs.copyFileSync(archivePathV2, bakPathV2); } catch {}
      }
    }
  }

  let earliestDate = archiveV2.firstUseDate || legacyV1Archive.firstUseDate || null;
  const registerDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
    }
  };

  // 3. 扫描桌面端与 CLI 会话文件（忽略 -wal/-shm/-journal 等伴生文件）
  let desktopPbCount = 0;
  let cliPbCount = 0;
  const scanSessionDir = (dir, isCli = false) => {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionOrTempFile(name)) continue;
        if (!name.endsWith('.pb') && !name.endsWith('.db')) continue;
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            count++;
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerDate(formatLocalDateKey(new Date(ts)));
          }
        } catch {}
      }
    } catch {}
    return count;
  };

  desktopPbCount = scanSessionDir(convDir, false);
  if (fs.existsSync(path.join(agCliDir, 'conversations'))) {
    cliPbCount = scanSessionDir(path.join(agCliDir, 'conversations'), true);
  }

  // 4. 双目录遍历扫描 transcript.jsonl（跳过 steps/scratch 重型目录，软链接与环路去重）
  const visitedRealDirs = new Set();
  const transcriptJobs = [];

  const walkTranscripts = (dir, sourceName, depth = 0) => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const normDir = path.resolve(dir);
      if (visitedRealDirs.has(normDir)) return;
      visitedRealDirs.add(normDir);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              if (!visitedRealDirs.has(realTarget)) {
                walkTranscripts(realTarget, sourceName, depth + 1);
              }
            } else if (entry.name === 'transcript.jsonl') {
              transcriptJobs.push({ path: realTarget, source: sourceName });
            }
          } catch {}
        } else if (entry.isDirectory()) {
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLogPath)) {
              transcriptJobs.push({ path: stdLogPath, source: sourceName });
              matchedFast = true;
            }
            if (fs.existsSync(directLogPath)) {
              transcriptJobs.push({ path: directLogPath, source: sourceName });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkTranscripts(fullPath, sourceName, depth + 1);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ path: fullPath, source: sourceName });
        }
      }
    } catch {}
  };

  walkTranscripts(brainDir, 'desktop');
  if (fs.existsSync(path.join(agCliDir, 'brain'))) {
    walkTranscripts(path.join(agCliDir, 'brain'), 'cli');
  }

  // 5. 结构化 JSON 解析 transcript.jsonl（基于 size+mtimeMs 单文件增量缓存，去重并汇总）
  const scannedBySource = {
    desktop: {},
    cli: {}
  };
  const seenEvents = new Set();
  const newlyParsedCalls = [];

  for (let jIdx = 0; jIdx < transcriptJobs.length; jIdx++) {
    const job = transcriptJobs[jIdx];
    if (jIdx > 0 && jIdx % 15 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const st = fs.statSync(job.path);
      const cachedFile = transcriptFileCache.get(job.path);
      let fileRecords = null;
      let isFreshlyParsed = false;

      if (cachedFile && cachedFile.size === st.size && cachedFile.mtimeMs === st.mtimeMs) {
        fileRecords = cachedFile.records;
      } else {
        isFreshlyParsed = true;
        fileRecords = [];
        const content = fs.readFileSync(job.path, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          let dateKey = null;
          if (event.created_at) {
            const d = new Date(event.created_at);
            if (!Number.isNaN(d.getTime())) {
              dateKey = formatLocalDateKey(d);
            }
          }

          let inp = 0, outp = 0, cap = 0, thinking = 0;
          let model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || '';

          if (event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null) {
            inp = Number(event.input_tokens || 0);
            outp = Number(event.output_tokens || 0);
            cap = Number(event.cache_read_tokens || 0);
            thinking = Number(event.thinking_output_tokens || 0);
          } else if (event.chatModel?.usage) {
            const u = event.chatModel.usage;
            inp = Number(u.inputTokens || 0);
            outp = Number(u.outputTokens || 0);
            cap = Number(u.cacheReadTokens || 0);
            thinking = Number(u.thinkingOutputTokens || 0);
          }

          const tot = inp + outp + cap;
          if (tot > 0 && dateKey) {
            const eventId = event.callId || event.responseId || event.chatModel?.usage?.responseId || `${job.path}#${event.step_index ?? i}`;
            const modelKey = normalizeModelId(model);
            const reqObj = {
              callId: eventId,
              source: job.source,
              cascadeId: event.cascadeId || path.basename(job.path, '.jsonl'),
              model,
              modelKey,
              inputTokens: inp,
              cacheTokens: cap,
              cacheReadTokens: cap,
              outputTokens: outp,
              thinkingTokens: thinking,
              totalTokens: tot,
              status: 'final',
              isEstimated: false,
              date: dateKey,
              created_at: event.created_at || null,
              timestamp: event.created_at ? new Date(event.created_at).getTime() : Date.now()
            };

            fileRecords.push({
              eventId,
              dateKey,
              inp,
              outp,
              cap,
              tot,
              reqObj
            });
          } else if (dateKey) {
            fileRecords.push({ dateKey, tot: 0 });
          }
        }
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        if (rec.dateKey) registerDate(rec.dateKey);
        if (!rec.tot || !rec.eventId) continue;
        if (seenEvents.has(rec.eventId)) continue;
        seenEvents.add(rec.eventId);

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[rec.dateKey]) {
          srcMap[rec.dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[rec.dateKey].total += rec.tot;
        srcMap[rec.dateKey].input += rec.inp;
        srcMap[rec.dateKey].output += rec.outp;
        srcMap[rec.dateKey].cache += rec.cap;
        srcMap[rec.dateKey].steps += 1;

        if (isFreshlyParsed && rec.reqObj.callId) {
          newlyParsedCalls.push(rec.reqObj);
        }
      }
    } catch {}
  }

  // 6. 与旧归档做差异合并，防止简单相加或 Math.max 抹杀 CLI 增量
  // 规则：若 (desktop + cli) < legacyV1，则把差额保留为 legacyUnallocated；否则认为已被新日志完全覆盖
  const legacyDaily = legacyV1Archive.dailyMap || {};
  const mergedDesktop = { ...(archiveV2.dailyMapBySource?.desktop || {}), ...scannedBySource.desktop };
  const mergedCli = { ...(archiveV2.dailyMapBySource?.cli || {}), ...scannedBySource.cli };
  const mergedLegacyUnallocated = {};

  const allDateKeys = new Set([
    ...Object.keys(legacyDaily),
    ...Object.keys(mergedDesktop),
    ...Object.keys(mergedCli)
  ]);

  const dailyMapAll = {};
  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    registerDate(k);
    const dRec = mergedDesktop[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const cRec = mergedCli[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const lRec = legacyDaily[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };

    const scannedSum = (dRec.total || 0) + (cRec.total || 0);
    let unallocatedDiff = Math.max(0, (lRec.total || 0) - scannedSum);

    if (unallocatedDiff > 0) {
      mergedLegacyUnallocated[k] = {
        total: unallocatedDiff,
        input: Math.max(0, (lRec.input || 0) - (dRec.input || 0) - (cRec.input || 0)),
        output: Math.max(0, (lRec.output || 0) - (dRec.output || 0) - (cRec.output || 0)),
        cache: Math.max(0, (lRec.cache || 0) - (dRec.cache || 0) - (cRec.cache || 0)),
        steps: Math.max(0, (lRec.steps || 0) - (dRec.steps || 0) - (cRec.steps || 0))
      };
    }

    const unRec = mergedLegacyUnallocated[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    dailyMapAll[k] = {
      total: (dRec.total || 0) + (cRec.total || 0) + (unRec.total || 0),
      input: (dRec.input || 0) + (cRec.input || 0) + (unRec.input || 0),
      output: (dRec.output || 0) + (cRec.output || 0) + (unRec.output || 0),
      cache: (dRec.cache || 0) + (cRec.cache || 0) + (unRec.cache || 0),
      steps: (dRec.steps || 0) + (cRec.steps || 0) + (unRec.steps || 0)
    };
  }

  // 7. 计算各项聚合统计指标
  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!earliestDate) earliestDate = todayKey;

  let grandTotalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheTokens = 0, totalSteps = 0;
  let todayTokens = 0, monthTokens = 0, yearTokens = 0;

  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (!v) continue;
    grandTotalTokens += v.total || 0;
    totalInputTokens += v.input || 0;
    totalOutputTokens += v.output || 0;
    totalCacheTokens += v.cache || 0;
    totalSteps += v.steps || 0;
    if (k === todayKey) todayTokens += v.total || 0;
    if (k.startsWith(monthPrefix)) monthTokens += v.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += v.total || 0;
  }

  // 计算本期（本月自然月）分类汇总与步骤数
  let currentMonthInput = 0, currentMonthOutput = 0, currentMonthCache = 0, currentMonthSteps = 0;
  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (k.startsWith(monthPrefix) && v) {
      currentMonthInput += v.input || 0;
      currentMonthOutput += v.output || 0;
      currentMonthCache += v.cache || 0;
      currentMonthSteps += v.steps || 0;
    }
  }

  const totalConversations = Math.max(
    legacyV1Archive.maxConversations || 0,
    transcriptJobs.length,
    desktopPbCount + cliPbCount
  );

  // 8. 自动识别套餐与用户自定义设置合并（实际读取优先于自定义优先于未知）
  const fetchedLivePlanStatus = await fetchUserStatusFromHost(options);
  const liveFetchSucceeded = Boolean(fetchedLivePlanStatus);
  const usedArchiveFallback = !liveFetchSucceeded && Boolean(archiveV2.planStatus);
  let livePlanStatus = fetchedLivePlanStatus;
  if (!livePlanStatus) {
    livePlanStatus = archiveV2.planStatus || parseUserPlanStatus(null);
  }

  const customSettingsAll = loadCustomPlanSettings(agDir);
  const currentAccountKey = liveFetchSucceeded
    ? (livePlanStatus?.email || null)
    : (livePlanStatus?.email || archiveV2.planStatus?.email || null);
  const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);

  const effectivePlanStatus = resolveEffectivePlanStatus(livePlanStatus, currentCustom, {
    cachedLivePlan: liveFetchSucceeded ? null : archiveV2.planStatus,
    currentEmail: currentAccountKey
  });
  if (usedArchiveFallback && effectivePlanStatus && typeof effectivePlanStatus === 'object') {
    effectivePlanStatus.isArchiveFallback = true;
  }

  // 结合持久化逐请求账本与本次新解析的调用（仅统计 Token 与测速样本）
  if (newlyParsedCalls.length) {
    recordModelCalls(newlyParsedCalls, { agDir });
  }
  const mergedCalls = Object.values(loadPricingLedger(agDir).calls || {});

  const speedRecords = mergedCalls
    .filter(c => isValidSpeedSample(c))
    .map(c => ({
      callId: c.callId,
      model: c.model,
      modelExactId: c.modelExactId || resolveStableModelId(c, livePlanStatus?.cascadeModelConfigs || []) || null,
      modelLabel: c.modelLabel || c.model || null,
      effort: c.effort || null,
      inputTokens: c.inputTokens,
      cacheReadTokens: c.cacheReadTokens ?? c.cacheTokens ?? 0,
      outputTokens: c.outputTokens,
      ttftSec: c.ttftSec ?? null,
      streamingSec: c.streamingSec ?? null,
      durationSec: c.durationSec,
      tps: c.tps ?? null,
      origin: c.origin === 'speed-test' ? 'speed-test' : 'chat',
      status: c.status,
      isEstimated: Boolean(c.isEstimated),
      date: c.date || null,
      created_at: c.created_at || null,
      timestamp: getCallSortTimestamp(c) || null
    }));

  const compactModelConfigs = Array.isArray(livePlanStatus?.cascadeModelConfigs)
    ? livePlanStatus.cascadeModelConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
    : [];

  const out = {
    schemaVersion: '0.8.3',
    version: '0.8.3',
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
    speedRecords,
    cascadeModelConfigs: compactModelConfigs,
    modelCapabilitiesById: livePlanStatus?.availableModelDetails || null,
    currentPeriod: {
      key: monthPrefix,
      label: `${monthPrefix} (自然月)`,
      isCurrentMonth: true
    },
    sources: {
      desktop: {
        conversationsCount: desktopPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'desktop').length
      },
      cli: {
        dirExists: fs.existsSync(agCliDir),
        conversationsCount: cliPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'cli').length
      }
    },
    planStatus: effectivePlanStatus,
    rawPlanStatus: livePlanStatus,
    customPlanSettings: currentCustom,
    uiPreferences: customSettingsAll.uiPreferences || {},
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      totalSteps,
      totalConversations,
      firstUseDate: earliestDate,
      activeDaysCount: Object.keys(dailyMapAll).length
    },
    dailyMap: dailyMapAll,
    dailyMapBySource: {
      all: dailyMapAll,
      desktop: mergedDesktop,
      cli: mergedCli,
      legacyUnallocated: mergedLegacyUnallocated
    }
  };

  // 检查是否已被后续强制并发采集超越：若已过时，放弃写盘与更新全局缓存
  if (!options.agDir && thisScanSeq !== currentScanSequence) {
    return out;
  }

  // 持久化保存到 v2 与 v1 归档（仅在数据变化或文件不存在时原子写入，减少高频磁盘 I/O）
  try {
    const archiveSig = `${agDir}|${earliestDate}|${totalConversations}|${grandTotalTokens}|${totalSteps}|${effectivePlanStatus?.tierKey || ''}|${effectivePlanStatus?.tierName || ''}|${effectivePlanStatus?.email || ''}`;
    const shouldWriteArchive = options.agDir || archiveSig !== collectTokenHistoryAsync._lastArchiveSig || !fs.existsSync(archivePathV2) || !fs.existsSync(archivePathV1);
    if (shouldWriteArchive) {
      collectTokenHistoryAsync._lastArchiveSig = archiveSig;
      const persistedPlanStatus = effectivePlanStatus && effectivePlanStatus.isArchiveFallback
        ? { ...effectivePlanStatus }
        : effectivePlanStatus;
      if (persistedPlanStatus && persistedPlanStatus.isArchiveFallback) {
        delete persistedPlanStatus.isArchiveFallback;
      }
      const v2Payload = {
        version: '2.0.0',
        firstUseDate: earliestDate,
        updatedAt: out.updatedAt,
        maxConversations: totalConversations,
        planStatus: persistedPlanStatus,
        dailyMapBySource: out.dailyMapBySource
      };
      safeWriteJsonSync(archivePathV2, v2Payload);

      // 同时写回 v1 格式以保持向下完全兼容
      const v1Payload = {
        firstUseDate: earliestDate,
        maxConversations: totalConversations,
        updatedAt: out.updatedAt,
        dailyMap: dailyMapAll
      };
      safeWriteJsonSync(archivePathV1, v1Payload);
    }
  } catch {}

  if (!options.agDir) {
    cachedTokenHistory = out;
    cachedTokenHistoryAt = Date.now();
  }
  return out;
  })();

  if (!options.agDir) {
    const tracked = runner.finally(() => {
      if (activeScanPromise === tracked) activeScanPromise = null;
    });
    activeScanPromise = tracked;
    return tracked;
  }
  return runner;
}

function collectTokenHistory(options = {}) {
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  const hasPendingLocalQuotaRefresh = !options.agDir && pendingQuotaForceRefreshHosts.has('local');
  if (!options.force && !hasPendingLocalQuotaRefresh && !options.agDir && cachedTokenHistory && Date.now() - cachedTokenHistoryAt < TOKEN_HISTORY_CACHE_TTL_MS) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return cachedTokenHistory || {
    schemaVersion: '0.8.3',
    version: '0.8.3',
    loading: true,
    updatedAt: '',
    firstUseDate: null,
    planStatus: parseUserPlanStatus(null),
    summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0, activeDaysCount: 0 },
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {} }
  };
}

module.exports = {
  sanitizeCascadeModelConfig,
  parseAvailableModelsResponse,
  mergeModelCapabilitiesIntoConfigs,
  fetchUserStatusFromHost,
  collectTokenHistory,
  collectTokenHistoryAsync,
  TOKEN_HISTORY_CACHE_TTL_MS,
  isCompanionOrTempFile,
  formatLocalDateKey,
  recordModelCalls,
  markConversationTurnCompleted,
  invalidateLocalAccountCaches,
  QUOTA_FORCE_REFRESH_MIN_INTERVAL_MS,
  flushPricingLedger,
  loadPricingLedger,
  savePricingLedger,
  setBoundedMap,
  getPricingLedgerPath,
  isSyntheticCall,
  quarantineSyntheticCalls,
  getCustomPlanPath,
  sanitizeAccountPlanEntry,
  loadCustomPlanSettings,
  saveCustomPlanSettings,
  saveCustomPlanSettingsDetailed,
  setCustomPlanForAccount,
  clearCustomPlanForAccount,
  resolveAccountCustomPlan,
  getPluginSettings,
  savePluginSettings
};
