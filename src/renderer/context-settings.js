  function resolveRuntimeUnlockPolicyClient() {
    if (typeof budgetEngine.resolveRuntimeUnlockPolicy === 'function') {
      return budgetEngine.resolveRuntimeUnlockPolicy(currentUnlockStatus);
    }
    return null;
  }

  function formatDiskPolicyText(policy) {
    if (!policy) return '未知';
    if (policy.diskMode === 'dynamic') return 'Dynamic 动态跟随';
    if (policy.diskMode === 'fixed' && policy.diskLimitTokens) return `固定 ${fmt(policy.diskLimitTokens)} tokens`;
    if (policy.diskMode === 'default') return '默认 256,000 tokens';
    if (policy.diskMode === 'partial') return '部分异常';
    return '未知';
  }

  function getProductCapabilitySummary(product) {
    if (!product) return null;
    if (typeof budgetEngine.deriveModelCapabilitySummary === 'function') {
      return budgetEngine.deriveModelCapabilitySummary(product, currentUnlockStatus, state.modelCapabilitiesById || null);
    }
    return null;
  }

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
    }
  }

  function validateCustomLimitClient(rawInput, modeOverride = ctxDraft.mode, productOverride = null) {
    if (modeOverride === 'dynamic') {
      return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
    }
    if (modeOverride === 'default') {
      return { ok: true, mode: 'default', limitTokens: CTX_DEFAULT_TOKENS, warnings: [] };
    }
    const targetProd = productOverride || (contextScopeMode === 'per_model' ? getSelectedProductObj() : null);
    const capSummary = targetProd ? getProductCapabilitySummary(targetProd) : null;
    if (modeOverride === 'model_max') {
      if (contextScopeMode === 'unified') {
        return { ok: false, error: '统一模式下各模型容量不同，请改为具体整数或切回“按模型分别设置”后选择最大可用。' };
      }
      if (!capSummary || capSummary.modelTheoreticalMaxTokens == null) {
        return { ok: false, error: '尚未获取到当前模型的上下文窗口与最大输出元数据，暂无法自动计算最大可用预算。' };
      }
      if (!capSummary.runtimePolicy?.policyKnown || capSummary.maxAdjustableTokens == null) {
        return {
          ok: false,
          error: `当前客户端运行策略未知或待重启确认，暂无法计算当前环境最大可用上限（模型理论输入上限 ${fmt(capSummary.modelTheoreticalMaxTokens)} tokens）。`
        };
      }
      rawInput = capSummary.maxAdjustableTokens;
    }

    if (typeof budgetEngine.evaluateLimitInput === 'function') {
      const ev = budgetEngine.evaluateLimitInput(rawInput, capSummary, currentUnlockStatus, state.latest?.serviceLimit);
      if (!ev.ok) {
        if (ev.reasonCode === 'out_of_engineering_range') {
          return {
            ok: false,
            error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
          };
        }
        return { ok: false, error: t('models.custom.placeholder') };
      }
      const warnings = [];
      for (const w of ev.warnings) {
        if (w.code === 'exceeds_model_limit') {
          if (capSummary?.maxTokens && w.limitTokens <= capSummary.maxTokens) {
            const adoptTxt = fmt(w.adoptableTokens ?? w.maxAllowed);
            warnings.push(`当前模型总窗口为 ${fmt(capSummary.maxTokens)} tokens，扣除最大输出预留后实际最高输入上限为 ${fmt(w.maxAllowed)} tokens；保存 ${fmt(w.limitTokens)} 后将自动按 ${adoptTxt} tokens 满血采用。`);
          } else if (w.adoptableTokens != null) {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；若仍保存 ${fmt(w.limitTokens)}，当前环境预计最高仅可采用 ${fmt(w.adoptableTokens)} tokens。`);
          } else {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；当前客户端运行策略未确认，实际可采用上限未知。`);
          }
        } else if (w.code === 'requires_dynamic_unlock') {
          const cap = w.stockCap || 256000;
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前默认限制 ${fmt(cap)}：未开启 Dynamic 动态模式且未实机证实前，语言服务仍可能将其限制在 ${fmt(cap)} tokens（请点击“保存并应用”）。`);
        } else if (w.code === 'exceeds_fixed_client_limit') {
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前客户端固定限制 ${fmt(w.fixedCap)} tokens：未调整为更高固定值或启用 Dynamic 动态模式前，预计仍将被限制在 ${fmt(w.fixedCap)} tokens。`);
        } else if (w.code === 'unconfirmed_runtime_policy') {
          if (w.runtimeState === 'pending_restart') {
            warnings.push(`磁盘配置（${formatDiskPolicyText({ diskMode: w.diskMode, diskLimitTokens: w.diskLimitTokens })}）已变更但客户端尚未重启，运行中实际策略待确认，无法预测 ${fmt(w.limitTokens)} 是否会被采用。`);
          } else if (w.runtimeState === 'runtime_unconfirmed') {
            warnings.push(`仅读取到磁盘配置，尚未确认运行中进程已加载该策略；${fmt(w.limitTokens)} 实际能否采用需等待进程验证或实机请求确认。`);
          } else if (w.runtimeState === 'partial') {
            warnings.push(`检测到客户端处于部分异常状态，运行限制未知，无法预测 ${fmt(w.limitTokens)} 的实际采用结果。`);
          } else {
            warnings.push(`当前客户端运行策略未知，暂无法预测 ${fmt(w.limitTokens)} 在本机的实际采用上限（需先读取运行策略或实机发送验证）。`);
          }
        } else if (w.code === 'exceeds_service_limit') {
          warnings.push(t('models.validation.aboveService', { val: formatKShort(w.serviceLimit) }));
        } else if (w.code === 'below_recommended_floor') {
          warnings.push(t('models.validation.tooSmall', { val: fmt(w.limitTokens) }));
        }
      }
      return {
        ok: true,
        mode: 'fixed',
        limitTokens: ev.limitTokens,
        exceedsModelLimit: ev.exceedsModelLimit,
        exceedsClientPolicy: ev.exceedsClientPolicy,
        clientPolicyLimit: ev.clientPolicyLimit,
        runtimeState: ev.runtimeState,
        policyKnown: ev.policyKnown,
        adoptableTokens: ev.adoptableTokens,
        requiresDynamicUnlock: ev.requiresDynamicUnlock,
        warnings
      };
    }

    const rawStr = typeof rawInput === 'number' ? String(rawInput) : String(rawInput || '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    if (num < CTX_MIN_ENGINEERING_TOKENS || num > CTX_MAX_ENGINEERING_TOKENS) {
      return {
        ok: false,
        error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
      };
    }
    const warnings = [];
    if (num < 65536) {
      warnings.push(t('models.validation.tooSmall', { val: fmt(num) }));
    }
    const sLimit = Number(state.latest?.serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push(t('models.validation.aboveService', { val: formatKShort(sLimit) }));
    }
    return { ok: true, mode: 'fixed', limitTokens: num, warnings };
  }

  /** 将所有已知模型、当前会话和历史调用按产品维度分组 */
  function getKnownModelProducts() {
    const productMap = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];

    const slugToKey = new Map();
    const ensureProduct = (meta, fromAccountCatalog = false) => {
      const g = groupProductSafe(meta);
      if (!g.productKey) return null;
      const keyParts = g.productKey.split(':');
      const keySlug = keyParts.length >= 3 ? keyParts.slice(2).join(':') : '';
      let targetKey = g.productKey;
      // 若同一产品 slug 在列表里既有明确厂商又有"其他"厂商，合并到明确厂商条目下（不合并不同前缀或代际）
      if (keySlug && !productMap.has(targetKey) && slugToKey.has(keySlug)) {
        const existingKey = slugToKey.get(keySlug);
        const existingProd = productMap.get(existingKey);
        if (existingProd && (g.vendor === '其他' || existingProd.vendor === '其他')) {
          if (existingProd.vendor === '其他' && g.vendor !== '其他') {
            productMap.delete(existingKey);
            existingProd.productKey = targetKey;
            existingProd.vendor = g.vendor;
            productMap.set(targetKey, existingProd);
            slugToKey.set(keySlug, targetKey);
          } else {
            targetKey = existingKey;
          }
        }
      }
      let prod = productMap.get(targetKey);
      if (!prod) {
        prod = {
          productKey: targetKey,
          productLabel: g.productLabel,
          vendor: g.vendor || '其他',
          inAccountCatalog: Boolean(fromAccountCatalog),
          unavailable: Boolean(meta.unavailable),
          unavailabilityReason: meta.unavailabilityReason || null,
          notice: meta.notice || null,
          isHistorical: Boolean(meta.isHistorical),
          members: new Map()
        };
        productMap.set(targetKey, prod);
        if (keySlug && (!slugToKey.has(keySlug) || g.vendor !== '其他')) {
          slugToKey.set(keySlug, targetKey);
        }
      } else if (fromAccountCatalog) {
        prod.inAccountCatalog = true;
        if (meta.notice && !prod.notice) prod.notice = meta.notice;
        if (meta.isHistorical !== undefined) prod.isHistorical = prod.isHistorical && Boolean(meta.isHistorical);
      }
      if (meta.modelId) {
        const mid = String(meta.modelId).trim().toLowerCase();
        const prev = prod.members.get(mid);
        const capEntry = state.modelCapabilitiesById?.[mid.replace(/^model_/, '')]
          || state.modelCapabilitiesById?.[String(meta.modelOrAlias?.model || '').trim().toLowerCase().replace(/^model_/, '')]
          || null;
        prod.members.set(mid, {
          modelId: mid,
          label: meta.label || prev?.label || mid,
          effort: g.effort || prev?.effort || null,
          maxTokens: meta.maxTokens ?? capEntry?.maxTokens ?? prev?.maxTokens ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? capEntry?.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
          thinkingBudget: meta.thinkingBudget ?? capEntry?.thinkingBudget ?? prev?.thinkingBudget ?? null,
          minThinkingBudget: meta.minThinkingBudget ?? capEntry?.minThinkingBudget ?? prev?.minThinkingBudget ?? null,
          thinkingLevel: meta.thinkingLevel || capEntry?.thinkingLevel || prev?.thinkingLevel || null,
          supportsModelInfoOverride: meta.supportsModelInfoOverride ?? capEntry?.supportsModelInfoOverride ?? prev?.supportsModelInfoOverride ?? null,
          capabilitySource: meta.capabilitySource || capEntry?.capabilitySource || prev?.capabilitySource || null,
          unavailable: meta.unavailable !== undefined ? Boolean(meta.unavailable) : (prev?.unavailable || false),
          unavailabilityReason: meta.unavailabilityReason || prev?.unavailabilityReason || null,
          notice: meta.notice || prev?.notice || null,
          isHistorical: meta.isHistorical !== undefined ? Boolean(meta.isHistorical) : (prev?.isHistorical || false)
        });
      }
      return prod;
    };

    if (Array.isArray(configs)) {
      for (const c of configs) {
        const stableId = resolveStableModelKeyClient(c) || c?.modelId || c?.modelOrAlias?.model;
        ensureProduct({
          modelId: stableId,
          label: c?.label || c?.modelId || stableId,
          modelOrAlias: c?.modelOrAlias,
          effort: c?.effort,
          maxTokens: c?.maxTokens,
          maxOutputTokens: c?.maxOutputTokens,
          thinkingBudget: c?.thinkingBudget,
          minThinkingBudget: c?.minThinkingBudget,
          thinkingLevel: c?.thinkingLevel,
          supportsModelInfoOverride: c?.supportsModelInfoOverride,
          capabilitySource: c?.capabilitySource,
          unavailable: c?.unavailable,
          unavailabilityReason: c?.unavailabilityReason,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (state.latest?.modelId || state.latest?.modelRaw || state.latest?.model) {
      const stableId = resolveStableModelKeyClient(state.latest);
      ensureProduct({
        modelId: stableId,
        label: state.latest.model || stableId,
        modelOrAlias: state.latest.modelOrAlias,
        effort: state.latest.effort
      }, false);
    }

    const calls = [...(ANTIGRAVITY_TOKEN_DATA.speedRecords || []), ...(state.sessionCalls || [])];
    for (const c of calls) {
      if (!c) continue;
      const mid = c.modelExactId || c.modelId || c.model;
      if (!mid) continue;
      ensureProduct({
        modelId: mid,
        label: c.modelLabel || c.model || mid,
        effort: c.effort
      }, false);
    }

    for (const [k, pref] of Object.entries(contextPreferencesMap || {})) {
      if (!pref) continue;
      const g = groupProductSafe({
        modelId: pref.productKey || k,
        label: pref.label || k
      });
      if (pref.scope === 'product' || k === g.productKey) {
        ensureProduct({
          modelId: pref.productKey || k,
          label: pref.label || g.productLabel
        }, false);
      } else {
        ensureProduct({
          modelId: k,
          label: pref.label || k
        }, false);
      }
    }

    const rankEffort = { Minimal: 1, Low: 2, Medium: 3, High: 4, XHigh: 5, Extra: 6, 'Extra High': 7, Max: 8 };
    const result = Array.from(productMap.values()).map(p => {
      const members = Array.from(p.members.values()).sort((a, b) => (rankEffort[a.effort] || 99) - (rankEffort[b.effort] || 99));
      const allUnavailable = members.length > 0 && members.every(m => m.unavailable);
      const partialUnavailable = members.length > 0 && !allUnavailable && members.some(m => m.unavailable);
      const isUnavailable = members.length > 0 ? allUnavailable : Boolean(p.unavailable);
      const isHistorical = members.length > 0 ? (members.every(m => m.isHistorical) || !p.inAccountCatalog) : (p.isHistorical || (!p.inAccountCatalog));
      const notice = p.notice || members.find(m => m.notice)?.notice || null;
      const reason = isUnavailable
        ? (p.unavailabilityReason || members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null)
        : (partialUnavailable ? (members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null) : null);
      return {
        productKey: p.productKey,
        productLabel: p.productLabel,
        vendor: p.vendor,
        inAccountCatalog: p.inAccountCatalog,
        unavailable: isUnavailable,
        partialUnavailable,
        unavailabilityReason: reason,
        notice,
        isHistorical,
        members
      };
    });
    result.sort((a, b) => {
      const va = VENDOR_ORDER.indexOf(a.vendor);
      const vb = VENDOR_ORDER.indexOf(b.vendor);
      if (va !== vb) return (va === -1 ? 99 : va) - (vb === -1 ? 99 : vb);
      return a.productLabel.localeCompare(b.productLabel);
    });
    return result;
  }

  function formatSavedPrefLabel(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) {
      const num = Number(pref.limitTokens);
      if (num === 512000) return '512K';
      if (num === 1000000) return '1M';
      return t('models.card.savedCustom', { val: `${formatKShort(num)}（${fmt(num)}）` });
    }
    return t('status.savedDefault');
  }

  function formatPrefShortPill(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedShortDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) return formatKShort(pref.limitTokens);
    return t('status.savedShortDefault');
  }

  /** 解析当前产品的设置状态与旧档位迁移/冲突检测 */
  function resolveProductPreferenceState(product) {
    if (!product) {
      return { status: 'none', pref: null, displayText: t('status.savedDefault'), shortText: t('status.savedShortDefault'), legacyKeys: [], conflictEntries: [] };
    }
    const pKey = product.productKey;
    const direct = contextPreferencesMap?.[pKey];
    if (direct && (direct.scope === 'product' || (direct.productKey && direct.productKey === pKey))) {
      return {
        status: 'product',
        pref: direct,
        displayText: formatSavedPrefLabel(direct),
        shortText: formatPrefShortPill(direct),
        legacyKeys: [],
        conflictEntries: []
      };
    }

    const legacyEntries = [];
    const seenKeys = new Set();
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    for (const [k, rawPref] of Object.entries(contextPreferencesMap || {})) {
      if (!rawPref) continue;
      if (k === pKey && rawPref.scope === 'product') continue;
      const belonged = memberIds.has(k) || groupProductSafe({ modelId: k, label: rawPref.label || k }).productKey === pKey;
      if (!belonged) continue;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      const memberMeta = (product.members || []).find(m => m.modelId === k);
      const effortName = memberMeta?.effort || groupProductSafe({ modelId: k, label: rawPref.label || k }).effort;
      legacyEntries.push({
        legacyKey: k,
        effort: effortName,
        effortLabel: effortName ? formatEffortZh(effortName) : (rawPref.label || k),
        mode: rawPref.mode || 'default',
        limitTokens: rawPref.mode === 'fixed' ? Number(rawPref.limitTokens) : null,
        updatedAt: rawPref.updatedAt || null,
        label: rawPref.label || product.productLabel
      });
    }

    if (legacyEntries.length === 0) {
      if (direct) {
        return {
          status: 'product',
          pref: direct,
          displayText: formatSavedPrefLabel(direct),
          shortText: formatPrefShortPill(direct),
          legacyKeys: [],
          conflictEntries: []
        };
      }
      return { status: 'none', pref: null, displayText: t('models.pref.none'), shortText: t('models.pref.noneShort'), legacyKeys: [], conflictEntries: [] };
    }

    const sigs = new Map();
    for (const entry of legacyEntries) {
      const sig = `${entry.mode}:${entry.mode === 'fixed' ? (entry.limitTokens || 0) : ''}`;
      if (!sigs.has(sig)) sigs.set(sig, entry);
    }

    if (sigs.size === 1) {
      const unified = legacyEntries[0];
      const syntheticPref = {
        scope: 'product',
        productKey: pKey,
        modelId: pKey,
        label: product.productLabel,
        mode: unified.mode,
        limitTokens: unified.limitTokens,
        updatedAt: unified.updatedAt
      };
      return {
        status: 'legacy_uniform',
        pref: syntheticPref,
        displayText: formatSavedPrefLabel(syntheticPref),
        shortText: formatPrefShortPill(syntheticPref),
        legacyKeys: legacyEntries.map(e => e.legacyKey),
        conflictEntries: []
      };
    }

    return {
      status: 'conflict',
      pref: null,
      displayText: t('models.pref.inconsistent'),
      shortText: t('models.pref.inconsistent'),
      legacyKeys: legacyEntries.map(e => e.legacyKey),
      conflictEntries: legacyEntries
    };
  }

  function describeClientModeValue(data) {
    if (!data) return t('models.preset.default');
    if (data.configuredMode === 'dynamic') return t('models.preset.dynamic');
    if (data.configuredMode === 'fixed' && data.configuredLimitTokens) {
      return formatKShort(data.configuredLimitTokens);
    }
    return t('models.preset.default');
  }

  function doesClientMatchVerification(data, ver) {
    if (!data || !ver) return false;
    const mode = data.configuredMode || 'unknown';
    if (ver.mode === 'dynamic') return mode === 'dynamic';
    if (ver.mode === 'default') return mode === 'default' || data.status === 'not_patched';
    if (ver.mode === 'fixed') return mode === 'fixed' && Number(data.configuredLimitTokens) === Number(ver.limitTokens);
    return false;
  }

  /** 将状态 strictly 映射为规定的 5 个普通视图标签之一 */
  function mapUnlockDisplayStatus(data) {
    if (unlockStatusFetchError) {
      return { badge: t('status.badge.unavailable'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    if (!data) {
      return { badge: t('status.badge.reading'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    const raw = data.status;
    const restarted = data.runtimeEvidence?.restartDetected === true;

    if (raw === 'patched_pending_restart') {
      return { badge: t('status.badge.pendingRestart'), pillClass: 'pill-warn', effectiveLoaded: false };
    }
    if (raw === 'not_patched') {
      return { badge: t('status.badge.notPatched'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    if (raw === 'patched_loaded') {
      if (!restarted) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
      }
      if ((pendingRestartVerification && !doesClientMatchVerification(data, pendingRestartVerification)) || restartMismatchNotice) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-warn', effectiveLoaded: false };
      }
      return { badge: t('status.badge.loaded'), pillClass: 'pill-ok', effectiveLoaded: true };
    }
    if (raw === 'patched_runtime_unconfirmed') {
      return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
    }
    if (raw === 'partial_match') {
      return { badge: t('status.badge.partialMatch'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    return { badge: t('status.badge.failed'), pillClass: 'pill-danger', effectiveLoaded: false };
  }

  function buildFriendlyWriteError(rawErr) {
    const msg = String(rawErr || '');
    if (/EBUSY|EPERM|EACCES|占用|lock|locked|in use/i.test(msg)) {
      return t('msg.writeBusy');
    }
    return t('msg.writeFail', { err: translateBackendText(msg) || t('msg.unknownErr') });
  }

  function applyContextViewVisibility() {
    if (ctxTabsBar) ctxTabsBar.hidden = false;
    if (paneSettings) paneSettings.hidden = activeContextTab !== 'settings';
    if (paneSession) paneSession.hidden = activeContextTab !== 'session';
    if (paneModels) paneModels.hidden = activeContextTab !== 'models';
    if (paneSpeed) paneSpeed.hidden = activeContextTab !== 'speed';

    setPillActive(btnTabSession, activeContextTab === 'session');
    setPillActive(btnTabModels, activeContextTab === 'models');
    setPillActive(btnTabSpeed, activeContextTab === 'speed');
    setPillActive(btnTabSettings, activeContextTab === 'settings');
    btnTabSession?.setAttribute('aria-selected', String(activeContextTab === 'session'));
    btnTabModels?.setAttribute('aria-selected', String(activeContextTab === 'models'));
    btnTabSpeed?.setAttribute('aria-selected', String(activeContextTab === 'speed'));
    btnTabSettings?.setAttribute('aria-selected', String(activeContextTab === 'settings'));
    if (!el('panel')?.hidden) {
      el('badge-cache')?.setAttribute('aria-expanded', String(activeContextTab === 'session'));
    }
  }

  let prevTabBeforeSettings = 'models';

  function switchContextTab(tabName) {
    if (tabName !== 'session' && tabName !== 'models' && tabName !== 'speed' && tabName !== 'settings') return;
    if (activeContextTab !== 'settings') {
      prevTabBeforeSettings = activeContextTab;
    }
    activeContextTab = tabName;
    isContextSettingsView = tabName === 'settings';
    try { localStorage?.setItem(CTX_ACTIVE_TAB_KEY, tabName); } catch {}
    applyContextViewVisibility();
    if (tabName === 'models') {
      renderModelSettingsTab();
      if (!currentUnlockStatus && !unlockStatusFetchError) {
        void refreshUnlockStatus();
      }
    } else if (tabName === 'speed') {
      // 速度对比页只读取已有本地记录，绝不发起任何请求或 IPC
      renderSpeedComparisonTab();
    } else if (tabName === 'settings') {
      void refreshModulesDisplay();
      void refreshCliUnlockDisplay();
      if (typeof refreshEnhanceStatus === 'function') void refreshEnhanceStatus();
    }
    positionFloatingPanels();
  }

  function openContextSettings(opts = {}) {
    if (el('panel')?.hidden) showPanel('context');
    switchContextTab('settings');
    if (opts.openColors) {
      toggleColorsDrawer(true);
    }
    positionFloatingPanels();
  }

  function closeContextSettings() {
    switchContextTab(prevTabBeforeSettings || 'models');
    positionFloatingPanels();
  }

  btnTabSession?.addEventListener('click', () => switchContextTab('session'));
  btnTabModels?.addEventListener('click', () => switchContextTab('models'));
  btnTabSpeed?.addEventListener('click', () => switchContextTab('speed'));
  btnTabSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettingsBack?.addEventListener('click', () => closeContextSettings());

  btnGotoModelSettings?.addEventListener('click', () => {
    if (activeSessionProductKey) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
      manualModelSelection = false;
      ctxDraftDirty = false;
    }
    switchContextTab('models');
  });

  btnCardGotoSpeed?.addEventListener('click', () => {
    const products = getKnownModelProducts();
    const curProd = products.find(p => p.productKey === selectedProductKey) || products[0];
    if (curProd) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const targetMember = curProd.members.find(m => m.modelId === activeSessionModelKey)
        || curProd.members.find(m => mergedCalls.some(c => c.modelExactId === m.modelId && isValidSpeedSampleSafe(c)))
        || curProd.members[0];
      if (targetMember) selectedSpeedExactModelId = targetMember.modelId;
    }
    switchContextTab('speed');
  });

  btnCtxBackCurrent?.addEventListener('click', () => {
    const hostSelected = extractHostSelectedModel();
    if (hostSelected && hostSelected.productKey) {
      activeSessionModelKey = hostSelected.modelId;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
      }
    }
    if (!activeSessionModelConfirmed || !activeSessionProductKey) {
      if (typeof showToastNotification === 'function') {
        showToastNotification(t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      } else {
        showUnlockResultBox(false, t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      }
      return;
    }
    manualModelSelection = false;
    selectedProductKey = activeSessionProductKey;
    selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function toggleUnlockDrawer(forceOpen) {
    if (!unlockDrawerBody) return;
    const isHidden = unlockDrawerBody.style.display === 'none' || !unlockDrawerBody.style.display;
    const nextOpen = forceOpen === undefined ? isHidden : Boolean(forceOpen);
    unlockDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (unlockDrawerArrow) unlockDrawerArrow.textContent = nextOpen ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleUnlockDetails?.setAttribute('aria-expanded', String(nextOpen));
    if (nextOpen && !currentUnlockStatus) void refreshUnlockStatus();
  }

  btnToggleUnlockDetails?.addEventListener('click', () => toggleUnlockDrawer());

  function getSelectedProductObj() {
    const products = getKnownModelProducts();
    if (!products.length) return null;
    if (selectedProductKey) {
      const found = products.find(p => p.productKey === selectedProductKey);
      if (found) return found;
    }
    if (activeSessionProductKey) {
      const activeFound = products.find(p => p.productKey === activeSessionProductKey);
      if (activeFound) return activeFound;
    }
    return products[0];
  }

  function renderHeaderModelDropdown() {
    const products = getKnownModelProducts();
    if (!selectedProductKey && products.length) {
      selectedProductKey = activeSessionProductKey || products[0].productKey;
    }
    const currentProd = products.find(p => p.productKey === selectedProductKey) || products[0] || null;
    if (currentProd) {
      selectedProductKey = currentProd.productKey;
      selectedEditModelKey = (activeSessionProductKey === currentProd.productKey && activeSessionModelKey)
        ? activeSessionModelKey
        : (currentProd.members[0]?.modelId || currentProd.productKey);
    }

    if (ctxModelSelectorRoleEl) {
      ctxModelSelectorRoleEl.textContent = t('panel.ctx.viewModel');
    }
    if (btnCtxBackCurrent) {
      btnCtxBackCurrent.hidden = !(manualModelSelection && activeSessionModelConfirmed && activeSessionProductKey && selectedProductKey && selectedProductKey !== activeSessionProductKey);
    }

    if (ctxModelSelect && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      if (typeof ctxModelSelect.replaceChildren === 'function') {
        const opts = [];
        for (const p of products) {
          const opt = document.createElement('option');
          opt.value = p.productKey;
          const pState = resolveProductPreferenceState(p);
          opt.textContent = `${p.productLabel} (${pState.shortText})${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          opts.push(opt);
        }
        ctxModelSelect.replaceChildren(...opts);
        if (selectedProductKey) ctxModelSelect.value = selectedProductKey;
      }
    }

    if (ctxModelDropdownLabelEl) {
      ctxModelDropdownLabelEl.textContent = currentProd ? currentProd.productLabel : t('models.dropdown.empty');
    }

    if (!ctxHeaderDropdownCtrl && typeof initDropdownController === 'function' && el('ctx-model-dropdown-wrap')) {
      ctxHeaderDropdownCtrl = initDropdownController({
        wrapId: 'ctx-model-dropdown-wrap',
        triggerId: 'ctx-model-dropdown-trigger',
        labelId: 'ctx-model-dropdown-label',
        menuId: 'ctx-model-dropdown-menu',
        selectId: 'ctx-model-select',
        emptyLabel: () => t('models.dropdown.empty'),
        searchPlaceholder: () => t('dropdown.modelSearch'),
        emptyText: () => t('dropdown.modelEmpty'),
        getSelectedValue: () => selectedProductKey || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
          selectedProductKey = val;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        },
        getOptions: () => {
          const list = getKnownModelProducts();
          const items = [];
          const activeList = list.filter(p => p.inAccountCatalog);
          const historyList = list.filter(p => !p.inAccountCatalog);
          let lastVendor = '';
          for (const p of activeList) {
            if (p.vendor !== lastVendor) {
              lastVendor = p.vendor;
              items.push({
                value: `__group_${p.vendor}`,
                label: formatVendorLabel(p.vendor),
                isGroupHeader: true,
                dotColor: VENDOR_DOT_COLORS[p.vendor] || VENDOR_DOT_COLORS['其他']
              });
            }
            const pState = resolveProductPreferenceState(p);
            items.push({
              value: p.productKey,
              label: p.productLabel,
              displayRight: pState.shortText,
              badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : '',
              aliases: [p.vendor, p.productKey]
            });
          }
          if (historyList.length) {
            items.push({
              value: '__group_history',
              label: t('models.list.historyGroup'),
              isGroupHeader: true,
              dotColor: VENDOR_DOT_COLORS['其他']
            });
            for (const p of historyList) {
              const pState = resolveProductPreferenceState(p);
              items.push({
                value: p.productKey,
                label: p.productLabel,
                displayRight: pState.shortText,
                badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : t('models.list.historyTag'),
                aliases: [p.vendor, p.productKey]
              });
            }
          }
          return items;
        }
      });
    } else if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.refresh === 'function') {
      ctxHeaderDropdownCtrl.refresh();
    }
  }

  ctxModelSelect?.addEventListener('change', (e) => {
    const val = e?.target?.value || '';
    if (!val) return;
    manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
    selectedProductKey = val;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function renderCompactSessionCard() {
    const scopeMode = getContextScopeMode();
    const scopeTitleEl = el('ctx-compact-scope-title');
    if (scopeTitleEl) {
      if (scopeMode === 'unified') {
        scopeTitleEl.textContent = t('session.compact.scopeUnified');
      } else if (activeSessionModelConfirmed && activeSessionProductKey) {
        const products = getKnownModelProducts();
        const targetProd = products.find(p => p.productKey === activeSessionProductKey) || null;
        scopeTitleEl.textContent = t('session.compact.scopeModel', { model: targetProd?.productLabel || activeSessionProductKey });
      } else {
        scopeTitleEl.textContent = t('session.compact.title');
      }
    }
    if (ctxCompactSavedEl) {
      if (scopeMode === 'unified') {
        ctxCompactSavedEl.textContent = formatPrefShortPill(contextUnifiedPreference);
      } else if (!activeSessionModelConfirmed || !activeSessionProductKey) {
        ctxCompactSavedEl.textContent = t('models.summary.unconfirmed');
      } else {
        const products = getKnownModelProducts();
        const targetProd = products.find(p => p.productKey === activeSessionProductKey) || null;
        const pState = resolveProductPreferenceState(targetProd);
        ctxCompactSavedEl.textContent = pState.pref == null && pState.status === 'none' ? t('status.savedShortDefault') : pState.shortText;
      }
    }
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCompactClientEl) {
      if (unlockStatusFetchError) {
        ctxCompactClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCompactClientEl.textContent = t('status.badge.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${t('models.status.pendingRestart') || statusInfo.badge}）`;
      } else {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${statusInfo.badge}）`;
      }
    }
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
  }

  function getRemoteSshMeta() {
    const meta = typeof window !== 'undefined' ? window.__AGContextMeterRemote : null;
    if (meta && meta.kind === 'ssh') {
      return {
        hostId: String(meta.hostId || ''),
        label: String(meta.label || meta.hostId || 'SSH')
      };
    }
    return null;
  }

  function renderSshRemoteContextBanners() {
    const remote = getRemoteSshMeta();
    const bannerPairs = [
      [el('ctx-ssh-remote-banner'), el('ctx-ssh-remote-banner-text')],
      [el('enhance-ssh-remote-banner'), el('enhance-ssh-remote-banner-text')]
    ];
    for (const [box, textEl] of bannerPairs) {
      if (!box || !textEl) continue;
      if (remote) {
        textEl.textContent = t('ssh.remote.contextBanner', { host: remote.label });
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    }
    const restartLsBtn = el('btn-enhance-restart-ls');
    if (restartLsBtn) {
      if (remote) {
        restartLsBtn.title = t('ssh.remote.localRestartLsTitle');
      } else {
        restartLsBtn.removeAttribute('title');
      }
    }
  }

  function renderClientStatusBar() {
    renderSshRemoteContextBanners();
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (unlockBadge) {
      unlockBadge.textContent = statusInfo.badge;
      unlockBadge.className = `key-pill ${statusInfo.pillClass}`;
    }

    if (ctxClientStatusText) {
      if (unlockStatusFetchError) {
        ctxClientStatusText.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxClientStatusText.textContent = t('status.client.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxClientStatusText.textContent = t('status.client.pendingRestart', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'dynamic') {
        ctxClientStatusText.textContent = t('status.client.loadedDynamic');
      } else if (currentUnlockStatus.configuredMode === 'fixed' || currentUnlockStatus.limitTokens) {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'default' || currentUnlockStatus.status === 'unpatched_official') {
        ctxClientStatusText.textContent = t('status.client.loadedDefault');
      } else {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      }
    }

    if (ctxRestartMismatchNote) {
      if (restartMismatchNotice) {
        ctxRestartMismatchNote.textContent = restartMismatchNotice;
        ctxRestartMismatchNote.hidden = false;
      } else {
        ctxRestartMismatchNote.hidden = true;
      }
    }

    const showRestart = needsRestartAfterApply || currentUnlockStatus?.status === 'patched_pending_restart';
    const isErrorStatus = currentUnlockStatus?.status === 'partial_match' || currentUnlockStatus?.status === 'failed';
    if (btnRestartHost) {
      btnRestartHost.hidden = !showRestart || !hostSupportsRestart;
    }
    if (ctxManualRestartNote) {
      ctxManualRestartNote.hidden = hostSupportsRestart || !showRestart;
    }
    if (btnUnlockResultRestart) {
      btnUnlockResultRestart.hidden = !showRestart || !hostSupportsRestart;
    }
    if (btnUnlockResultRetry) {
      btnUnlockResultRetry.hidden = !isErrorStatus;
    }
    if (unlockResultManual) {
      unlockResultManual.hidden = !(showRestart && !hostSupportsRestart);
    }
    if (unlockResultActions) {
      const hasAction = (showRestart && hostSupportsRestart) || isErrorStatus;
      unlockResultActions.hidden = !hasAction;
    }
    const btnEnhanceRestart = el('btn-enhance-restart-host');
    if (btnEnhanceRestart) {
      btnEnhanceRestart.hidden = !(showRestart && hostSupportsRestart);
    }
  }

  function renderModelListGroup(products) {
    if (!ctxModelListEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (!products.length) {
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const accountProducts = hasAccountCatalog ? products.filter(p => p.inAccountCatalog) : products;
    const historyProducts = hasAccountCatalog ? products.filter(p => !p.inAccountCatalog) : [];

    const appendGroupRows = (fragNodes, vendor, list, isHistoryGroup = false) => {
      const grp = document.createElement('div');
      grp.className = 'ctx-model-group';

      const hdr = document.createElement('div');
      hdr.className = isHistoryGroup ? 'ctx-model-group-hdr is-history-hdr' : 'ctx-model-group-hdr';
      const dot = document.createElement('span');
      dot.className = 'ag-vendor-dot';
      if (dot.style) dot.style.background = VENDOR_DOT_COLORS[vendor] || VENDOR_DOT_COLORS['其他'];
      const vTxt = document.createElement('span');
      vTxt.textContent = isHistoryGroup ? t('models.list.historyGroup') : formatVendorLabel(vendor);
      hdr.appendChild(dot);
      hdr.appendChild(vTxt);
      grp.appendChild(hdr);

      for (const prod of list) {
        const pState = resolveProductPreferenceState(prod);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `ctx-product-row${prod.productKey === selectedProductKey ? ' is-active' : ''}${prod.unavailable ? ' is-unavailable' : ''}`;
        row.setAttribute('data-product-key', prod.productKey);

        const left = document.createElement('span');
        left.className = 'ctx-product-row-left';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ctx-product-row-name';
        nameSpan.textContent = prod.productLabel;
        left.appendChild(nameSpan);

        if (prod.unavailable) {
          const unavailTag = document.createElement('span');
          unavailTag.className = 'ctx-product-row-unavailable-tag';
          unavailTag.textContent = t('models.card.modelUnavailable') || '不可用';
          if (prod.unavailabilityReason) unavailTag.title = prod.unavailabilityReason;
          left.appendChild(unavailTag);
        } else if (prod.notice) {
          const noticeTag = document.createElement('span');
          noticeTag.className = 'ctx-product-row-notice-tag';
          noticeTag.textContent = 'Notice';
          noticeTag.title = typeof prod.notice === 'string' ? prod.notice : JSON.stringify(prod.notice);
          left.appendChild(noticeTag);
        }

        if (prod.productKey === activeSessionProductKey) {
          const curTag = document.createElement('span');
          curTag.className = 'ag-dropdown-badge';
          curTag.textContent = t('models.list.currentTag');
          left.appendChild(curTag);
        } else if (isHistoryGroup || prod.isHistorical) {
          const histTag = document.createElement('span');
          histTag.className = 'ctx-product-row-history-tag';
          histTag.textContent = t('models.list.historyTag');
          left.appendChild(histTag);
        }

        const right = document.createElement('span');
        right.className = 'ctx-product-row-right';
        const valSpan = document.createElement('span');
        valSpan.className = `ctx-product-row-val${pState.status === 'conflict' ? ' is-conflict' : ''}`;
        valSpan.textContent = pState.shortText;
        right.appendChild(valSpan);

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => {
          manualModelSelection = Boolean(activeSessionProductKey && prod.productKey !== activeSessionProductKey);
          selectedProductKey = prod.productKey;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        });
        grp.appendChild(row);
      }
      fragNodes.push(grp);
    };

    const groups = new Map();
    for (const p of accountProducts) {
      if (!groups.has(p.vendor)) groups.set(p.vendor, []);
      groups.get(p.vendor).push(p);
    }
    const fragNodes = [];
    for (const [vendor, list] of groups.entries()) {
      appendGroupRows(fragNodes, vendor, list, false);
    }
    if (historyProducts.length > 0) {
      appendGroupRows(fragNodes, '其他', historyProducts, true);
    }
    if (typeof ctxModelListEl.replaceChildren === 'function') {
      ctxModelListEl.replaceChildren(...fragNodes);
    }
  }

  function findLatestProductObservation(product, activeConvId = null) {
    if (!product) return { latestBudgetObs: null, latestServiceLimitObs: null };
    const scoped = budgetTracker ? budgetTracker.getScopedObservation(activeConvId, product.productKey) : null;
    if (scoped) {
      return {
        latestBudgetObs: scoped.budget > 0 ? scoped : null,
        latestServiceLimitObs: scoped.serviceLimit > 0 ? scoped : null
      };
    }
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let latestBudgetObs = null;
    let latestServiceLimitObs = null;

    for (const mid of memberIds) {
      const obs = observedByModelId.get(mid);
      if (!obs) continue;
      if (activeConvId && obs.convoId && obs.convoId !== activeConvId) continue;
      if (obs.budget > 0 && (!latestBudgetObs || obs.ts > latestBudgetObs.ts)) {
        latestBudgetObs = obs;
      }
      if (obs.serviceLimit > 0 && (!latestServiceLimitObs || obs.ts > latestServiceLimitObs.ts)) {
        latestServiceLimitObs = obs;
      }
    }
    return { latestBudgetObs, latestServiceLimitObs };
  }

  function findPreRestartBudgetForProduct(product) {
    if (!product || !preRestartSnapshot?.observations) return null;
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let best = null;
    for (const mid of memberIds) {
      const obs = preRestartSnapshot.observations[mid];
      if (obs && obs.budget > 0 && (!best || obs.ts > best.ts)) best = obs;
    }
    return best;
  }

  async function resolveProductConflict(product, chosenEntry) {
    if (!product || !chosenEntry) return;
    const legacyKeys = resolveProductPreferenceState(product).legacyKeys;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('models.toast.saveFailed', { err: translateBackendText(res?.error) || t('models.err.saveFailed') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[product.productKey] = {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    showUnlockResultBox(true, t('models.toast.savedUniform'));
  }

  function evaluateModelContextStatus(product) {
    if (!product) {
      return {
        status: 'unconfirmed',
        badge: t('panel.ctx.currentModelUnconfirmed') || '待确认',
        pillClass: 'pill-muted',
        diagnosis: '未获取到模型信息',
        targetText: '—',
        requestText: '—',
        observedText: '—',
        convoId: '—'
      };
    }

    const pState = resolveProductPreferenceState(product);
    const scopeMode = getContextScopeMode();
    const activePref = (scopeMode === 'unified') ? contextUnifiedPreference : pState.pref;
    const targetMode = activePref?.mode || 'default';
    const targetLimit = (targetMode === 'fixed') ? Number(activePref?.limitTokens) : null;
    const capSummary = getProductCapabilitySummary(product);

    let targetText = t('status.savedDefault') || '恢复客户端默认';
    if (targetMode === 'dynamic') {
      targetText = t('models.preset.dynamic') || '动态跟随';
    } else if (targetMode === 'fixed' && targetLimit) {
      targetText = targetLimit === 1000000
        ? '1M（1,000,000 tokens）'
        : targetLimit === 512000
          ? '512K（512,000 tokens）'
          : targetLimit === 256000
            ? '256K（256,000 tokens）'
            : `${formatKShort(targetLimit)}（${fmt(targetLimit)} tokens）`;
    }

    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;
    const evalCore = budgetTracker
      ? budgetTracker.evaluateStatus({
        product,
        scopeMode,
        pref: activePref,
        activeConvId,
        modelHardLimit: capSummary?.modelTheoreticalMaxTokens || null
      })
      : {
        status: 'saved_pending_dispatch',
        convoId: activeConvId || '—',
        targetMode,
        targetLimit,
        dispatched: null,
        observation: findLatestProductObservation(product, activeConvId).latestBudgetObs
      };

    const dispatched = evalCore.dispatched;
    const obs = evalCore.observation;
    const obsBudget = Number(obs?.budget || 0);

    let requestText = dispatched ? '默认透传（未附加自定义参数）' : '尚无本次验证';
    if (dispatched) {
      if (dispatched.status === 'send_failed') {
        requestText = `发送失败（${dispatched.errorMessage || '请求未完成'}）`;
      } else if (dispatched.status === 'aborted') {
        requestText = '已取消发送';
      } else if (dispatched.status === 'uninjectable') {
        requestText = '透传未注入（缺少可靠模型/不支持帧）';
      } else if (dispatched.sentMode === 'fixed' && dispatched.sentLimitTokens) {
        requestText = `${formatKShort(dispatched.sentLimitTokens)}（${fmt(dispatched.sentLimitTokens)} tokens）`;
      } else if (dispatched.sentMode === 'dynamic') {
        requestText = '动态跟随（已清除固定数值）';
      }
      if (dispatched.timestamp) {
        requestText += ` · ${formatMonthDayTime(dispatched.timestamp)}`;
      }
    }

    function statusUsesExistingObs(st, diagCode) {
      return st === 'confirmed'
        || st === 'clamped_by_model_limit'
        || st === 'mismatch'
        || (st === 'default' && diagCode === 'default_confirmed');
    }

    let observedText = '尚无本次验证';
    if (obsBudget > 0 && statusUsesExistingObs(evalCore.status, evalCore.diagnosisCode)) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      const tTxt = obs.ts ? ` · ${formatMonthDayTime(obs.ts)}` : '';
      observedText = `${formatKShort(obsBudget)}（${fmt(obsBudget)} tokens）${effTxt}${tTxt}`;
    } else if (obsBudget > 0) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      observedText = `仅见历史观测 ${fmt(obsBudget)} tokens${effTxt}（当前设置尚无本次验证）`;
    }

    const convoId = evalCore.convoId || activeConvId || '—';

    let status = evalCore.status;
    let badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
    let pillClass = 'pill-muted';
    let diagnosis = '已保存目标参数，将在下次发起请求时自动注入并发送。';

    if (status === 'default') {
      if (evalCore.diagnosisCode === 'default_confirmed') {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-good';
        diagnosis = `本次请求已按客户端默认透传（未附加自定义覆盖），收到新回复确认实际采用 ${fmt(obsBudget)} tokens。`;
      } else {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-muted';
        diagnosis = '已恢复/保持客户端默认（不附加覆盖参数），将在下一次发送时生效并验证实际采用值。';
      }
    } else if (status === 'send_failed') {
      badge = '发送失败（未确认）';
      pillClass = 'pill-bad';
      diagnosis = `本次请求发送失败（${evalCore.errorMessage || '网络或传输错误'}），因此无法确认实际预算。`;
    } else if (status === 'aborted') {
      badge = '已取消（未确认）';
      pillClass = 'pill-muted';
      diagnosis = '本次请求在完成前被取消，未收到新回复。';
    } else if (status === 'uninjectable') {
      badge = '本次未注入（已透传）';
      pillClass = 'pill-warn';
      diagnosis = `未能向本次请求自动注入参数（${evalCore.diagnosisCode || '缺少可靠模型身份或协议格式不支持'}），已保持原样透传。`;
    } else if (status === 'confirmed') {
      badge = t('models.status.confirmed') || '实际预算已确认';
      pillClass = 'pill-good';
      diagnosis = targetMode === 'dynamic'
        ? `已启用动态跟随模式，本次发送后实测返回预算 ${fmt(obsBudget)} tokens。`
        : `请求实际携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次发送后服务端返回预算 ${fmt(obsBudget)} tokens，完全吻合。`;
    } else if (status === 'clamped_by_model_limit') {
      badge = '受模型上限限制';
      pillClass = 'pill-warn';
      diagnosis = `请求携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/服务端上限（${fmt(evalCore.knownCap)} tokens）限制，实际采用 ${fmt(obsBudget)} tokens。`;
    } else if (status === 'mismatch') {
      badge = t('models.status.mismatch') || '未生效：目标值与观测值不一致';
      pillClass = 'pill-bad';
      let detail = `目标设置（${fmt(targetLimit)} tokens）与发送后实际观测预算（${fmt(obsBudget)} tokens）不一致，原因待确认。`;
      if (product.unavailable && product.unavailabilityReason) {
        detail += `（模型可用性说明：${product.unavailabilityReason}）`;
      }
      diagnosis = detail;
    } else if (status === 'timeout_unconfirmed') {
      badge = '确认超时（未观测到新回复）';
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? `已按客户端默认透传发送请求，但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`
        : `已在请求中携带设置（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`;
    } else if (status === 'dispatched_pending_confirm') {
      badge = targetMode === 'default' ? '已默认透传，等待确认' : (t('models.status.dispatchedPendingConfirm') || '已发送设置，等待确认');
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? '已按客户端默认透传发出请求（未附加覆盖参数），等待收到新回复以确认服务端实际预算。'
        : `已在本次请求中成功注入参数（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），等待收到新回复以确认实际分配预算。`;
    } else {
      status = 'saved_pending_dispatch';
      badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
      pillClass = 'pill-muted';
      diagnosis = `已保存目标设置（${targetText}），下一次在对应模型发起发送时将自动注入。`;
    }

    return {
      status,
      badge,
      pillClass,
      diagnosis,
      targetText,
      requestText,
      observedText,
      convoId
    };
  }

  function renderModelDetailCard(product) {
    if (!product) {
      if (ctxCardProductName) ctxCardProductName.textContent = t('models.card.waiting');
      if (ctxCardVendorName) ctxCardVendorName.textContent = '—';
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      if (ctxConflictBanner) ctxConflictBanner.hidden = true;
      if (ctxSummaryModelEl) ctxSummaryModelEl.textContent = '待确认';
      if (ctxSummaryLengthEl) ctxSummaryLengthEl.textContent = '—';
      if (ctxSummaryStatusPillEl) ctxSummaryStatusPillEl.hidden = true;
      return;
    }

    const evalResult = evaluateModelContextStatus(product);
    const pState = resolveProductPreferenceState(product);
    if (ctxCardVendorDot?.style) {
      ctxCardVendorDot.style.background = VENDOR_DOT_COLORS[product.vendor] || VENDOR_DOT_COLORS['其他'];
    }
    if (ctxCardVendorName) ctxCardVendorName.textContent = formatVendorLabel(product.vendor);
    if (ctxCardProductName) {
      if (product.unavailable) {
        ctxCardProductName.textContent = `${product.productLabel} [${t('models.card.modelUnavailable') || '不可用'}]`;
      } else {
        ctxCardProductName.textContent = product.productLabel;
      }
    }

    const efforts = product.members.map(m => m.effort).filter(Boolean);
    if (ctxCardEffortsList) {
      ctxCardEffortsList.textContent = efforts.length
        ? t('models.card.effortsList', { list: efforts.map(formatEffortZh).join(' · ') })
        : t('models.card.effortStandard');
    }
    if (ctxCardSessionEffort) {
      if (activeSessionProductKey === product.productKey && activeSessionEffort) {
        ctxCardSessionEffort.textContent = t('models.card.sessionEffort', { effort: formatEffortZh(activeSessionEffort) });
        ctxCardSessionEffort.hidden = false;
      } else {
        ctxCardSessionEffort.hidden = true;
      }
    }

    // 旧档位冲突横幅
    if (ctxConflictBanner && ctxConflictRows) {
      if (pState.status === 'conflict' && pState.conflictEntries.length > 0) {
        ctxConflictBanner.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxConflictRows.replaceChildren === 'function') {
          const rows = [];
          for (const ce of pState.conflictEntries) {
            const r = document.createElement('div');
            r.className = 'ctx-conflict-row';
            const lbl = document.createElement('span');
            lbl.textContent = `${ce.effortLabel} · ${formatSavedPrefLabel(ce)}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ctx-conflict-btn';
            btn.textContent = t('models.conflict.useThis');
            btn.addEventListener('click', () => { void resolveProductConflict(product, ce); });
            r.appendChild(lbl);
            r.appendChild(btn);
            rows.push(r);
          }
          const selfRow = document.createElement('div');
          selfRow.className = 'ctx-conflict-row';
          const selfHint = document.createElement('span');
          selfHint.textContent = t('models.conflict.orCustom');
          const selfBtn = document.createElement('button');
          selfBtn.type = 'button';
          selfBtn.className = 'ctx-conflict-btn';
          selfBtn.textContent = t('models.conflict.selfSet');
          selfBtn.addEventListener('click', () => {
            ctxCustomInput?.focus?.();
          });
          selfRow.appendChild(selfHint);
          selfRow.appendChild(selfBtn);
          rows.push(selfRow);
          ctxConflictRows.replaceChildren(...rows);
        }
      } else {
        ctxConflictBanner.hidden = true;
      }
    }

    // 0. 模型能力参考卡片渲染（紧邻预算设置区，不隐藏；严格区分模型上限 / 客户端限制 / 运行策略默认预算 / 可采纳范围）
    const capSummary = getProductCapabilitySummary(product);
    const runtimePolicy = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    if (ctxCapWindowEl) {
      ctxCapWindowEl.textContent = capSummary?.maxTokens ? `${fmt(capSummary.maxTokens)} tokens` : '未知（待获取元数据）';
    }
    if (ctxCapOutputEl) {
      ctxCapOutputEl.textContent = capSummary?.maxOutputTokens != null ? `${fmt(capSummary.maxOutputTokens)} tokens` : '未知';
    }
    if (ctxCapModelMaxEl) {
      ctxCapModelMaxEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
        ? `${fmt(capSummary.modelTheoreticalMaxTokens)} tokens`
        : '未知（待获取元数据）';
    }
    if (ctxCapClientPolicyEl) {
      if (!runtimePolicy || runtimePolicy.runtimeState === 'unknown') {
        ctxCapClientPolicyEl.textContent = '未知（待读取运行策略）';
      } else if (runtimePolicy.runtimeState === 'pending_restart') {
        ctxCapClientPolicyEl.textContent = `待重启（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
        ctxCapClientPolicyEl.textContent = `进程未确认（磁盘=${formatDiskPolicyText(runtimePolicy)}）`;
      } else if (runtimePolicy.runtimeState === 'partial') {
        ctxCapClientPolicyEl.textContent = '部分异常（运行限制未知）';
      } else if (runtimePolicy.runtimeMode === 'dynamic') {
        ctxCapClientPolicyEl.textContent = 'Dynamic 动态跟随（按模型上限）';
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCapClientPolicyEl.textContent = `固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} tokens`;
      } else {
        ctxCapClientPolicyEl.textContent = '默认限制 256,000 tokens';
      }
    }
    if (ctxCapDefaultEl) {
      if (capSummary?.currentStrategyDefaultBudget != null && runtimePolicy?.policyKnown) {
        let stratNote = '';
        if (runtimePolicy.runtimeMode === 'dynamic') {
          stratNote = '（Dynamic 默认）';
        } else if (runtimePolicy.runtimeMode === 'fixed') {
          stratNote = `（受固定限制 ${fmt(runtimePolicy.currentClientLimitTokens)} 约束）`;
        } else {
          stratNote = '（受默认 256,000 约束）';
        }
        ctxCapDefaultEl.textContent = `${fmt(capSummary.currentStrategyDefaultBudget)} tokens${stratNote}`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapDefaultEl.textContent = '未知（运行策略待确认）';
      } else {
        ctxCapDefaultEl.textContent = '未知';
      }
    }
    if (ctxCapRangeEl) {
      if (capSummary?.maxAdjustableTokens != null) {
        ctxCapRangeEl.textContent = `${fmt(capSummary.rangeMin || CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(capSummary.maxAdjustableTokens)} tokens`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapRangeEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
          ? `运行策略未知（模型理论上限 ${fmt(capSummary.modelTheoreticalMaxTokens)}）`
          : `运行策略未知（工程范围 ${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}）`;
      } else {
        ctxCapRangeEl.textContent = `${fmt(CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(CTX_MAX_ENGINEERING_TOKENS)}（模型上限未知）`;
      }
    }
    if (ctxCapFormulaEl) {
      const parts = [];
      if (capSummary?.sources?.length) {
        const srcText = capSummary.sources.map(s => (s === 'get_available_models' ? 'GetAvailableModels 目录' : (s === 'step_model_info' ? '会话 Step ModelInfo' : s))).join(' + ');
        parts.push(`来源：${srcText}`);
      }
      if (capSummary?.formulaNote) {
        parts.push(capSummary.formulaNote);
      } else {
        parts.push('尚未获取到当前账号/步骤的模型窗口与最大输出元数据（不按模型名称推测上限）。');
      }
      if (capSummary?.policyNote) {
        parts.push(capSummary.policyNote);
      }
      if (capSummary?.hasTierVariance) {
        parts.push('注意：该模型不同力度档位报告了不同容量/最大输出，可调上限取安全交集，详情见下方「档位能力」。');
      }
      if (runtimePolicy?.diskVsRuntimeMismatch) {
        parts.push('磁盘配置与运行中进程尚未确认一致：以下预测与默认预算均按未确认处理，请勿当作已实机生效。');
      }
      ctxCapFormulaEl.textContent = parts.join('；');
    }
    if (ctxRefSavedEl) {
      const targetSavedLabel = getContextScopeMode() === 'unified'
        ? formatSavedPrefLabel(contextUnifiedPreference)
        : pState.displayText;
      ctxRefSavedEl.textContent = targetSavedLabel;
    }
    if (ctxRefSentEl) {
      ctxRefSentEl.textContent = evalResult.requestText || '尚无本次验证';
    }
    if (ctxRefAdoptedEl) {
      ctxRefAdoptedEl.textContent = evalResult.observedText || '尚无本次验证';
    }

    if (ctxUnifiedProjEl) {
      if (getContextScopeMode() === 'unified' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const allProducts = getKnownModelProducts().filter(p => p.inAccountCatalog);
        const projections = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, allProducts, currentUnlockStatus, state.modelCapabilitiesById || null);
        if (projections.length > 0 && typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxUnifiedProjEl.replaceChildren === 'function') {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'ctx-unified-proj-title';
          titleDiv.textContent = '统一模式各模型预计采用预算（预测值，非实机已确认）：';
          const rowNodes = [titleDiv];
          for (const pr of projections.slice(0, 8)) {
            const row = document.createElement('div');
            const isWarnRow = pr.outcome === 'clamped_to_model_max' || pr.outcome === 'exceeds_client_policy' || pr.outcome === 'clamped_by_client_policy' || pr.outcome === 'pending_restart_unconfirmed' || pr.outcome === 'partial_policy_unconfirmed' || pr.outcome === 'runtime_unconfirmed';
            row.className = `ctx-unified-proj-row${isWarnRow ? ' is-clamped' : ''}`;
            const lbl = document.createElement('span');
            lbl.textContent = pr.productLabel;
            const val = document.createElement('strong');
            if (pr.outcome === 'clamped_to_model_max') {
              val.textContent = `受模型上限限制 -> 预计 ${fmt(pr.projectedTokens)}（最大可用）`;
            } else if (pr.outcome === 'exceeds_client_policy') {
              val.textContent = `超出当前客户端限制 -> 预计仅保底 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'clamped_by_client_policy') {
              val.textContent = `受当前客户端限制 -> 预计 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'pending_restart_unconfirmed') {
              val.textContent = '待验证（磁盘已改，客户端未重启）';
            } else if (pr.outcome === 'runtime_unconfirmed') {
              val.textContent = '待验证（运行中进程未确认）';
            } else if (pr.outcome === 'partial_policy_unconfirmed') {
              val.textContent = '未知（客户端处于部分异常状态）';
            } else if (pr.outcome === 'unknown_policy') {
              val.textContent = '未知（运行策略待读取）';
            } else if (pr.outcome === 'unknown_cap') {
              val.textContent = '模型上限未知';
            } else if (pr.outcome === 'client_default' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（当前策略默认）`;
            } else if (pr.outcome === 'dynamic_follow' && pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens（Dynamic 默认）`;
            } else if (pr.projectedTokens != null) {
              val.textContent = `预计 ${fmt(pr.projectedTokens)} tokens`;
            } else {
              val.textContent = '待验证';
            }
            row.appendChild(lbl);
            row.appendChild(val);
            rowNodes.push(row);
          }
          ctxUnifiedProjEl.replaceChildren(...rowNodes);
          ctxUnifiedProjEl.hidden = false;
        } else {
          ctxUnifiedProjEl.hidden = true;
        }
      } else {
        ctxUnifiedProjEl.hidden = true;
      }
    }

    if (ctxCardTierCapsRowEl && ctxCardTierCapsEl) {
      if (capSummary?.tierDetails?.length) {
        ctxCardTierCapsRowEl.hidden = false;
        const lines = capSummary.tierDetails.map(td => {
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || '标准');
          const winTxt = td.maxTokens ? `窗口 ${fmt(td.maxTokens)}` : '窗口未知';
          const outTxt = td.maxOutputTokens != null ? `最大输出 ${fmt(td.maxOutputTokens)}` : '输出未知';
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? `可调上限 ${fmt(td.maxTokens - td.maxOutputTokens)}`
            : '上限未知';
          return `${tierName}：${winTxt} / ${outTxt} / ${maxInTxt}`;
        });
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardTierCapsEl.replaceChildren === 'function') {
          ctxCardTierCapsEl.replaceChildren(...lines.map(l => {
            const d = document.createElement('div');
            d.textContent = l;
            return d;
          }));
        } else {
          ctxCardTierCapsEl.textContent = lines.join(' | ');
        }
      } else {
        ctxCardTierCapsRowEl.hidden = true;
      }
    }

    // 1. 目标值（已保存）
    if (ctxCardSavedEl) {
      ctxCardSavedEl.textContent = pState.displayText;
      ctxCardSavedEl.title = (pState.pref?.mode === 'fixed' && pState.pref.limitTokens)
        ? `${fmt(pState.pref.limitTokens)} tokens`
        : '';
    }

    // 2. 本次请求携带值
    if (ctxCardRequestEl) {
      ctxCardRequestEl.textContent = evalResult.requestText;
      ctxCardRequestEl.title = evalResult.requestText;
    }

    // 3. 对应会话
    if (ctxCardConvoEl) {
      ctxCardConvoEl.textContent = evalResult.convoId;
      ctxCardConvoEl.title = evalResult.convoId;
    }

    // 4. 生效诊断
    if (ctxCardDiagnosisEl) {
      ctxCardDiagnosisEl.textContent = evalResult.diagnosis;
      ctxCardDiagnosisEl.title = evalResult.diagnosis;
      ctxCardDiagnosisEl.className = `ctx-metric-value ctx-metric-diagnosis-val is-${evalResult.status}`;
    }

    // 5. 底座引擎（严格区分磁盘配置与当前运行进程已加载状态）
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCardClientEl) {
      if (unlockStatusFetchError) {
        ctxCardClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCardClientEl.textContent = t('status.badge.reading');
      } else if (runtimePolicy?.runtimeState === 'pending_restart') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（待重启生效）`;
      } else if (runtimePolicy?.runtimeState === 'runtime_unconfirmed') {
        ctxCardClientEl.textContent = `磁盘为 ${formatDiskPolicyText(runtimePolicy)}（运行态未确认）`;
      } else if (runtimePolicy?.runtimeState === 'partial') {
        ctxCardClientEl.textContent = '部分异常（请核对客户端状态）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'dynamic') {
        ctxCardClientEl.textContent = '动态跟随已确认运行（各模型独立）';
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCardClientEl.textContent = `固定单一上限模式 (${formatKShort(runtimePolicy.currentClientLimitTokens)}，建议升级为动态跟随)`;
      } else {
        ctxCardClientEl.textContent = describeClientModeValue(currentUnlockStatus);
      }
    }
    if (ctxCardClientTagEl) {
      if (unlockStatusFetchError || !currentUnlockStatus) {
        ctxCardClientTagEl.hidden = true;
      } else {
        ctxCardClientTagEl.hidden = false;
        ctxCardClientTagEl.textContent = statusInfo.badge;
        ctxCardClientTagEl.className = `key-pill ${statusInfo.pillClass}`;
      }
    }

    // 6. 实测预算 + 独立 serviceLimit
    const { latestBudgetObs, latestServiceLimitObs } = findLatestProductObservation(product);
    const preObs = findPreRestartBudgetForProduct(product);
    if (ctxCardObservedBudgetEl) {
      if (pendingRestartVerification && !latestBudgetObs && preObs) {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedWaitRestart');
        ctxCardObservedBudgetEl.title = '';
      } else if (latestBudgetObs?.budget > 0) {
        const effTxt = latestBudgetObs.effort ? ` · ${formatEffortZh(latestBudgetObs.effort)}` : '';
        const tTxt = latestBudgetObs.ts ? ` · ${formatMonthDayTime(latestBudgetObs.ts)}` : '';
        ctxCardObservedBudgetEl.textContent = `${formatKShort(latestBudgetObs.budget)}${effTxt}${tTxt}`;
        ctxCardObservedBudgetEl.title = t('models.card.observedTitle', { val: fmt(latestBudgetObs.budget) });
      } else {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedBudgetNone');
        ctxCardObservedBudgetEl.title = '';
      }
    }
    if (ctxCardPreRestartBudgetEl) {
      if (!latestBudgetObs && preObs?.budget > 0) {
        const effTxt = preObs.effort ? ` · ${formatEffortZh(preObs.effort)}` : '';
        const tTxt = preObs.ts ? ` · ${formatMonthDayTime(preObs.ts)}` : '';
        ctxCardPreRestartBudgetEl.textContent = `${t('models.card.preRestartTitle', { val: formatKShort(preObs.budget) }).replace(/ tokens$/, '')}${effTxt}${tTxt}`;
        ctxCardPreRestartBudgetEl.title = t('models.card.preRestartTitle', { val: fmt(preObs.budget) });
        ctxCardPreRestartBudgetEl.hidden = false;
      } else {
        ctxCardPreRestartBudgetEl.title = '';
        ctxCardPreRestartBudgetEl.hidden = true;
      }
    }
    if (ctxCardServiceLimitEl) {
      if (latestServiceLimitObs?.serviceLimit > 0) {
        const tTxt = latestServiceLimitObs.ts ? `（${formatMonthDayTime(latestServiceLimitObs.ts)}）` : '';
        ctxCardServiceLimitEl.textContent = `${t('models.card.serviceLimit', { val: formatKShort(latestServiceLimitObs.serviceLimit) })}${tTxt}`;
        ctxCardServiceLimitEl.title = t('models.card.serviceLimitTitle', { val: fmt(latestServiceLimitObs.serviceLimit) });
        ctxCardServiceLimitEl.hidden = false;
      } else {
        ctxCardServiceLimitEl.title = '';
        ctxCardServiceLimitEl.hidden = true;
      }
    }

    // 7. 实测速度（按档位逐行显示中位数、样本数、时间，不跨档位借用）
    if (ctxCardObservedSpeedEl) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const summaryRows = typeof summarizeSpeedByModel === 'function'
        ? summarizeSpeedByModel(mergedCalls, { days: 'all', cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] })
        : [];
      const summaryByExact = new Map(summaryRows.map(r => [r.modelExactId, r]));
      const members = product.members?.length ? product.members : [{ modelId: product.productKey, label: product.productLabel, effort: null }];
      const lines = [];
      for (const m of members) {
        const stat = summaryByExact.get(m.modelId);
        const prefix = m.effort ? `${formatEffortZh(m.effort)} ` : '';
        if (stat && stat.medianTps != null) {
          const tStr = stat.maxTs ? ` · ${formatMonthDayTime(stat.maxTs)}` : '';
          const lowNote = stat.lowSample ? t('models.card.lowSampleParen') : '';
          lines.push(t('models.card.speedLineText', { prefix, tps: stat.medianTps, count: stat.count, low: lowNote, ts: tStr }));
        } else {
          lines.push(`${prefix}${t('models.card.observedSpeedNone')}`);
        }
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardObservedSpeedEl.replaceChildren === 'function') {
        const lineNodes = lines.map(txt => {
          const d = document.createElement('div');
          d.textContent = txt;
          return d;
        });
        ctxCardObservedSpeedEl.replaceChildren(...lineNodes);
      } else {
        ctxCardObservedSpeedEl.textContent = lines.join(' | ');
      }
    }

    // 8. 提示规则与 Notice 说明
    if (ctxCardHintsEl) {
      const hints = [];
      if (product.notice) {
        const nText = typeof product.notice === 'string' ? product.notice : (product.notice.message || JSON.stringify(product.notice));
        hints.push(`模型提示：${nText}`);
      }
      if (product.unavailable && product.unavailabilityReason) {
        hints.push(`不可用原因：${product.unavailabilityReason}`);
      } else if (product.partialUnavailable && product.unavailabilityReason) {
        hints.push(`部分档位受限：${product.unavailabilityReason}`);
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens &&
        pState.pref &&
        !(pState.pref.mode === 'fixed' && Number(pState.pref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      ) {
        hints.push(t('models.card.hintDiffClient'));
      }
      if (pState.pref?.mode === 'dynamic') {
        hints.push(t('models.validation.dynamicDesc'));
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens > 0 &&
        latestBudgetObs?.budget > 0 &&
        latestBudgetObs.budget < currentUnlockStatus.configuredLimitTokens
      ) {
        hints.push(t('models.card.hintBelowSet'));
      }
      if (hints.length > 0) {
        ctxCardHintsEl.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardHintsEl.replaceChildren === 'function') {
          const nodes = hints.map(h => {
            const div = document.createElement('div');
            div.className = 'ctx-card-hint-item';
            div.textContent = h;
            return div;
          });
          ctxCardHintsEl.replaceChildren(...nodes);
        } else {
          ctxCardHintsEl.textContent = hints.join(' ');
        }
      } else {
        ctxCardHintsEl.hidden = true;
      }
    }

    // 9. 精简主界面展示：当前模式、当前模型、目标设置与状态
    if (ctxSummaryModeEl) {
      ctxSummaryModeEl.textContent = contextScopeMode === 'unified'
        ? (t('models.mode.unifiedTitle') || '所有模型统一设置')
        : (t('models.mode.perModelTitle') || '按模型分别设置');
    }
    if (ctxSummaryModelEl) {
      if (contextScopeMode === 'unified') {
        ctxSummaryModelEl.textContent = t('models.summary.unifiedTarget') || '所有模型（统一生效）';
      } else if (activeSessionModelConfirmed && activeSessionProductKey === product.productKey) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else if (activeSessionModelConfirmed && activeSessionProductKey) {
        const cur = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
        ctxSummaryModelEl.textContent = cur ? cur.productLabel : product.productLabel;
      } else if (product) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else {
        ctxSummaryModelEl.textContent = '待确认';
      }
    }
    if (ctxSummaryLengthEl) {
      ctxSummaryLengthEl.textContent = evalResult.targetText;
    }
    if (ctxSummaryStatusPillEl) {
      if (needsRestartAfterApply) {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = t('models.summary.pendingRestart') || '待重启生效';
        ctxSummaryStatusPillEl.className = 'key-pill pill-warn';
      } else {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = evalResult.badge;
        ctxSummaryStatusPillEl.className = `key-pill ${evalResult.pillClass}`;
      }
    }

    if (btnSaveModelCtx) btnSaveModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
    if (btnResetModelCtx) btnResetModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
  }

  function renderPresetSelectionUI() {
    const targetMode = ctxDraft.mode;
    const targetLimit = ctxDraft.limitTokens;
    const isUnified = contextScopeMode === 'unified';
    const currentProd = isUnified ? null : getSelectedProductObj();
    const capSummary = currentProd ? getProductCapabilitySummary(currentProd) : null;
    const knownEnvMax = (!isUnified && capSummary?.maxAdjustableTokens != null) ? capSummary.maxAdjustableTokens : null;
    const knownModelMax = (!isUnified && capSummary?.modelTheoreticalMaxTokens != null) ? capSummary.modelTheoreticalMaxTokens : null;
    const rawWindowMax = (!isUnified && capSummary?.maxTokens != null) ? capSummary.maxTokens : knownModelMax;
    const rp = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const policyKnown = Boolean(rp?.policyKnown);

    if (ctxPresetModelMaxSubEl) {
      if (isUnified) {
        ctxPresetModelMaxSubEl.textContent = '统一模式下各模型不同（已禁用）';
      } else if (knownEnvMax != null) {
        ctxPresetModelMaxSubEl.textContent = `当前环境最大可采纳：${fmt(knownEnvMax)} tokens`;
      } else if (!policyKnown && knownModelMax != null) {
        ctxPresetModelMaxSubEl.textContent = `运行策略未确认（模型理论上限 ${fmt(knownModelMax)}，暂不可用）`;
      } else {
        ctxPresetModelMaxSubEl.textContent = '模型元数据待获取（暂不可用）';
      }
    }

    const btns = ctxPresetGrid?.children || [];
    const applyPresetState = btn => {
      if (!btn) return;
      const bMode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode;
      const bLimRaw = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
      const bLim = bLimRaw ? Number(bLimRaw) : null;

      let disabled = false;
      let disableReason = '';
      if (bMode === 'model_max') {
        if (isUnified) {
          disabled = true;
          disableReason = '统一模式下各模型最大可用上限不同，请切换到按模型分别设置或填写具体数值。';
        } else if (knownModelMax == null) {
          disabled = true;
          disableReason = '尚未获取到该模型的上下文窗口与最大输出元数据，无法计算最大可用值。';
        } else if (!policyKnown || knownEnvMax == null) {
          disabled = true;
          disableReason = '当前客户端运行策略未知或待重启确认，暂无法确定当前环境最大可用上限。';
        }
      } else if (bMode === 'fixed' && bLim && rawWindowMax != null && bLim > rawWindowMax) {
        disabled = true;
        disableReason = `预设 ${fmt(bLim)} 超出当前模型总上下文窗口 ${fmt(rawWindowMax)} tokens。`;
      }

      if ('disabled' in btn) btn.disabled = disabled;
      if (btn.classList) {
        if (disabled) btn.classList.add('is-disabled');
        else btn.classList.remove('is-disabled');
      }
      if ('title' in btn) btn.title = disableReason;

      const matched = !disabled && (
        (bMode === 'model_max' && targetMode === 'fixed' && knownEnvMax != null && targetLimit === knownEnvMax) ||
        (bMode === targetMode && (targetMode !== 'fixed' || bLim === targetLimit))
      );
      if (btn.classList) {
        if (matched) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      btn.setAttribute?.('aria-pressed', String(Boolean(matched)));
    };
    if (typeof ctxPresetGrid?.querySelectorAll === 'function') {
      const list = ctxPresetGrid.querySelectorAll('.ctx-preset-btn');
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) applyPresetState(list[i]);
      }
    } else if (Array.isArray(btns)) {
      for (const b of btns) applyPresetState(b);
    }

    if (ctxCustomInput && 'value' in ctxCustomInput) {
      if (targetMode === 'dynamic') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phFollow');
      } else if (targetMode === 'default') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phDefault');
      } else if (targetLimit != null) {
        const cleanVal = String(targetLimit);
        if (ctxCustomInput.value !== cleanVal && !ctxDraftDirty) {
          ctxCustomInput.value = cleanVal;
        }
      }
    }
    updateValidationMessageUI();
  }

  function updateValidationMessageUI() {
    if (!ctxValidationEl) return;
    if (ctxDraft.mode === 'dynamic') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = t('models.validation.dynamicDesc');
      return;
    }
    if (ctxDraft.mode === 'default') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = '恢复客户端默认：请求将清除 maxTokenLimit 覆盖，由当前语言服务全局模式决定（若已开 Dynamic 则按动态默认）。';
      return;
    }
    const rawVal = ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== ''
      ? ctxCustomInput.value
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawVal, 'fixed');
    if (!val.ok) {
      ctxValidationEl.className = 'ctx-validation-msg is-error';
      ctxValidationEl.textContent = val.error;
      return;
    }
    if (val.warnings && val.warnings.length > 0) {
      ctxValidationEl.className = 'ctx-validation-msg is-warn';
      ctxValidationEl.textContent = val.warnings.join(' ');
      return;
    }
    ctxValidationEl.className = 'ctx-validation-msg';
    ctxValidationEl.textContent = t('models.input.validFixed', { short: formatKShort(val.limitTokens), full: fmt(val.limitTokens) });
  }

  function loadDraftFromSelectedModel(forceResetDraft = false) {
    if (!ctxDraftDirty || forceResetDraft) {
      if (contextScopeMode === 'unified') {
        const pref = contextUnifiedPreference;
        if (pref && pref.mode) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          ctxDraft = { mode: 'default', limitTokens: null };
        }
      } else {
        const prod = getSelectedProductObj();
        const pState = resolveProductPreferenceState(prod);
        const pref = pState.pref;
        if (pref) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          const rp = resolveRuntimeUnlockPolicyClient();
          if (rp?.policyKnown && rp.runtimeMode !== 'unknown' && rp.runtimeMode !== 'partial') {
            ctxDraft = {
              mode: rp.runtimeMode,
              limitTokens: rp.runtimeMode === 'fixed' ? (rp.currentClientLimitTokens ?? null) : null
            };
          } else {
            ctxDraft = { mode: 'default', limitTokens: null };
          }
        }
      }
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) {
        ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
      }
    }
    renderModelSettingsTab();
    renderPresetSelectionUI();
  }

  function renderModelSettingsTab() {
    const products = getKnownModelProducts();
    const currentProd = getSelectedProductObj();
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    renderCompactSessionCard();
    renderClientStatusBar();
    renderModelListGroup(products);
    renderModelDetailCard(currentProd);
    renderPresetSelectionUI();
  }

  function recordObservationFromSummary(summary, convoId, opts = {}) {
    if (!summary) return;
    const rawId = resolveStableModelKeyClient(summary);
    if (!rawId && !summary.model) return;
    const g = groupProductSafe({
      modelId: rawId || summary.model,
      label: summary.model || rawId,
      modelOrAlias: summary.modelOrAlias,
      effort: summary.effort
    });
    if (!g?.productKey) return;

    if (budgetTracker && (summary.budget > 0 || summary.serviceLimit > 0 || opts.callId)) {
      budgetTracker.recordObservation({
        convoId: convoId || state.activeConversationId || state.route || null,
        productKey: g.productKey,
        modelId: rawId || g.productKey,
        modelLabel: summary.model || g.productLabel,
        effort: g.effort || summary.effort || null,
        budget: Number(summary.budget || 0),
        serviceLimit: Number(summary.serviceLimit || 0),
        callId: opts.callId || null,
        stepCount: Number.isFinite(opts.stepCount) ? opts.stepCount : -1,
        ts: opts.ts || 0
      });
    }
  }

  function syncContextModelSelectionFromState() {
    const prevProd = activeSessionProductKey;
    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;

    // 1. 最高优先级：宿主输入框旁真实选中的模型（排除插件自身 DOM）
    const hostSelected = extractHostSelectedModel();
    let exactId = null;
    let detectedProduct = null;
    let detectedEffort = null;
    let isConfirmed = false;

    if (hostSelected && hostSelected.productKey) {
      exactId = hostSelected.modelId;
      detectedProduct = hostSelected.productKey;
      detectedEffort = hostSelected.effort;
      isConfirmed = true;
    } else if (state.latest && activeConvId) {
      // 2. 次优先级：检查 state.latest 是否属于当前活跃会话且非历史归档模型
      const candidateId = resolveStableModelKeyClient(state.latest);
      if (candidateId) {
        const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
        const matchedCfg = Array.isArray(configs) && configs.length > 0
          ? configs.find(c => (resolveStableModelKeyClient(c) || c.modelId) === candidateId)
          : null;
        const isAllowedInCatalog = Array.isArray(configs) && configs.length > 0
          ? Boolean(matchedCfg && !matchedCfg.isHistorical)
          : true;
        if (isAllowedInCatalog) {
          const g = groupProductSafe({
            modelId: candidateId,
            label: state.latest?.model || candidateId,
            modelOrAlias: state.latest?.modelOrAlias,
            effort: state.latest?.effort
          });
          exactId = candidateId;
          detectedProduct = g.productKey;
          detectedEffort = g.effort || state.latest?.effort || null;
          isConfirmed = true;
        }
      }
    }

    if (isConfirmed && exactId && detectedProduct) {
      activeSessionModelKey = exactId;
      activeSessionProductKey = detectedProduct;
      activeSessionEffort = detectedEffort;
      activeSessionModelConfirmed = true;
      // 严禁在此处用 Date.now() 伪造观测时间戳；仅当无观测记录且有明确后端快照时保留已有真实观测
    } else {
      activeSessionModelConfirmed = false;
      activeSessionModelKey = null;
      activeSessionProductKey = null;
      activeSessionEffort = null;
    }

    if (activeSessionModelConfirmed && activeSessionProductKey && (!manualModelSelection || !selectedProductKey)) {
      const switched = prevProd !== activeSessionProductKey || selectedProductKey !== activeSessionProductKey;
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey;
      if (switched) {
        ctxDraftDirty = false;
        loadDraftFromSelectedModel(true);
      }
    }
    renderHeaderModelDropdown();
    renderCompactSessionCard();
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  ctxPresetGrid?.addEventListener('click', async (e) => {
    const btn = e?.target?.closest?.('.ctx-preset-btn');
    if (!btn || btn.disabled) return;
    const mode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode || 'default';
    const rawLim = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
    ctxDraftDirty = true;
    if (mode === 'dynamic') {
      ctxDraft = { mode: 'dynamic', limitTokens: null };
    } else if (mode === 'default') {
      ctxDraft = { mode: 'default', limitTokens: null };
    } else {
      const lim = Number(rawLim || 512000);
      ctxDraft = { mode: 'fixed', limitTokens: lim };
    }
    if (ctxCustomInput && 'value' in ctxCustomInput) {
      ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
    }
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    renderPresetSelectionUI();

    const saved = await saveCurrentProductDraft();
    if (saved.stale) return;
    if (!saved.ok) {
      showUnlockResultBox(false, saved.error);
      return;
    }

    let needsRestart = false;
    const needBackendUnlock = (ctxDraft.mode === 'dynamic' || Number(ctxDraft.limitTokens) > 256000)
      && (!currentUnlockStatus || currentUnlockStatus.status === 'not_patched');
    if (needBackendUnlock) {
      try {
        const uRes = await invokeUnlockApi('apply', {
          mode: 'dynamic',
          limitTokens: null,
          serviceLimit: state.latest?.serviceLimit || undefined
        });
        if (!uRes || !uRes.ok) {
          showUnlockResultBox(false, buildFriendlyWriteError(uRes?.error), { showRetry: true });
          return;
        }
        needsRestart = Boolean(uRes.needsRestart);
        if (needsRestart) needsRestartAfterApply = true;
        await refreshUnlockStatus();
      } catch (err) {
        showUnlockResultBox(false, buildFriendlyWriteError(err?.message), { showRetry: true });
        return;
      }
    }

    const targetLbl = ctxDraft.mode === 'dynamic'
      ? t('twp.preset.dynamic')
      : formatKShort(ctxDraft.limitTokens || 256000);
    const doneMsg = saved.notice
      || (needsRestart ? t('twp.savedNeedRestart', { target: targetLbl }) : t('twp.savedDone', { target: targetLbl }));
    showUnlockResultBox(true, doneMsg, { needsRestart });
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    renderCompactSessionCard();
    render();
  });

  ctxCustomInput?.addEventListener('input', () => {
    const rawStr = String(ctxCustomInput.value || '').trim();
    ctxDraftDirty = true;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    if (!rawStr) {
      ctxDraft = { mode: 'fixed', limitTokens: null };
      renderPresetSelectionUI();
      return;
    }
    const val = validateCustomLimitClient(rawStr, 'fixed');
    ctxDraft = {
      mode: 'fixed',
      limitTokens: val.ok ? val.limitTokens : null
    };
    renderPresetSelectionUI();
  });
  ctxCustomInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnSaveModelCtx?.click?.();
    }
  });

  async function saveSettingsPayloadBridge(payload = {}) {
    if (window.contextMeterAPI?.saveSettings) {
      return await window.contextMeterAPI.saveSettings(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge') };
  }

  function showUnlockResultBox(isSuccess, html, opts = {}) {
    if (!unlockResultBox || !unlockResultText) return;
    unlockResultBox.style.display = 'block';
    unlockResultBox.className = `unlock-result-box ${isSuccess ? 'result-success' : 'result-error'}`;
    unlockResultText.innerHTML = html;
    const canRestartHost = Boolean(hostSupportsRestart);
    const needRestart = Boolean(opts.needsRestart);
    const showRetry = Boolean(opts.showRetry);
    if (btnUnlockResultRestart) btnUnlockResultRestart.hidden = !(needRestart && canRestartHost);
    if (btnUnlockResultRetry) btnUnlockResultRetry.hidden = !showRetry;
    if (unlockResultManual) unlockResultManual.hidden = !(needRestart && !canRestartHost);
    if (unlockResultActions) unlockResultActions.hidden = !((needRestart && canRestartHost) || showRetry);
  }

  async function saveCurrentProductDraft() {
    if (contextScopeMode === 'unified') {
      const rawLimit = ctxDraft.mode === 'fixed'
        ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
        : ctxDraft.limitTokens;
      const val = validateCustomLimitClient(rawLimit, ctxDraft.mode);
      if (!val.ok) {
        updateValidationMessageUI();
        return { ok: false, error: val.error };
      }
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference,
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraftDirty = false;
      renderModelSettingsTab();
      let notice = null;
      if (val.mode === 'fixed' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const projs = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, getKnownModelProducts().filter(p => p.inAccountCatalog), currentUnlockStatus, state.modelCapabilitiesById || null);
        const clampedModel = projs.filter(p => p.outcome === 'clamped_to_model_max');
        const clampedClient = projs.filter(p => p.outcome === 'exceeds_client_policy' || p.outcome === 'clamped_by_client_policy');
        const unconfirmed = projs.filter(p => p.outcome === 'pending_restart_unconfirmed' || p.outcome === 'runtime_unconfirmed' || p.outcome === 'partial_policy_unconfirmed' || p.outcome === 'unknown_policy');
        const msgParts = [];
        if (clampedModel.length > 0) {
          msgParts.push(`部分模型低于统一值：${clampedModel.map(c => `${c.productLabel}(上限 ${fmt(c.projectedTokens)})`).join('、')} 预计仅采用各自最大可用上限`);
        }
        if (clampedClient.length > 0) {
          msgParts.push(`当前客户端限制为 ${fmt(clampedClient[0].clientLimitTokens)} tokens，超限模型预计仅保底 ${clampedClient.map(c => `${c.productLabel}(${fmt(c.projectedTokens)})`).join('、')}`);
        }
        if (unconfirmed.length > 0) {
          msgParts.push('当前客户端运行策略尚未确认/待重启，统一值能否实机采用需后续发送请求验证');
        }
        if (msgParts.length > 0) {
          notice = `已保存统一目标 ${fmt(val.limitTokens)} tokens。注意：${msgParts.join('；')}。`;
        }
      }
      return { ok: true, prod: null, val, notice };
    }

    const prod = getSelectedProductObj();
    if (!prod) {
      return { ok: false, error: t('msg.noModelsDetected') };
    }
    const rawLimit = ctxDraft.mode === 'fixed'
      ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawLimit, ctxDraft.mode, prod);
    if (!val.ok) {
      updateValidationMessageUI();
      return { ok: false, error: val.error };
    }
    if (val.exceedsModelLimit) {
      updateValidationMessageUI();
      const capSummary = getProductCapabilitySummary(prod);
      const modelMaxCap = capSummary?.modelTheoreticalMaxTokens ?? val.adoptableTokens;
      const capText = modelMaxCap != null ? `${fmt(modelMaxCap)} tokens` : '已知模型理论上限';
      return {
        ok: false,
        error: `输入 ${fmt(val.limitTokens)} 超出 ${prod.productLabel} 模型理论输入上限 ${capText}（依据元数据：总窗口 - 最大输出）。请修改为 <= ${capText} 或重新选择合法档位，系统不会静默改写数值。`
      };
    }
    const legacyKeys = resolveProductPreferenceState(prod).legacyKeys;
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return { ok: false, stale: true };
    if (!res || !res.ok) {
      return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[prod.productKey] = {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    return { ok: true, prod, val };
  }

  btnSaveModelCtx?.addEventListener('click', async () => {
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const res = await saveCurrentProductDraft();
    if (res.stale) return;
    if (!res.ok) {
      showUnlockResultBox(false, res.error);
      return;
    }
    showUnlockResultBox(true, res.notice || t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用');
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    renderCompactSessionCard();
    render();
  });

  btnResetModelCtx?.addEventListener('click', async () => {
    if (contextScopeMode === 'unified') {
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: 'default',
        limitTokens: null,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference: { mode: 'default' },
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraft = { mode: 'default', limitTokens: null };
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
      renderModelSettingsTab();
      renderPresetSelectionUI();
      showUnlockResultBox(true, t('models.summary.modelDefault') || '已恢复默认值');
      return;
    }

    const prod = getSelectedProductObj();
    if (!prod) return;
    const pState = resolveProductPreferenceState(prod);
    const oldSavedPref = pState.pref;
    const clearAll = [prod.productKey, ...pState.legacyKeys];
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      clearContextPreferences: clearAll
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return;
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const k of clearAll) delete contextPreferencesMap[k];
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraft = { mode: 'default', limitTokens: null };
    ctxDraftDirty = false;
    if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    renderPresetSelectionUI();
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    render();

    if (ctxResetNoticeEl) {
      const clientUsingSame = oldSavedPref && currentUnlockStatus && (
        (oldSavedPref.mode === 'dynamic' && currentUnlockStatus.configuredMode === 'dynamic') ||
        (oldSavedPref.mode === 'fixed' && currentUnlockStatus.configuredMode === 'fixed' && Number(oldSavedPref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      );
      if (clientUsingSame) {
        const curVal = describeClientModeValue(currentUnlockStatus);
        ctxResetNoticeEl.textContent = t('msg.resetStillUsing', { val: curVal });
        ctxResetNoticeEl.hidden = false;
      } else {
        ctxResetNoticeEl.hidden = true;
      }
    }
    showUnlockResultBox(true, t('msg.resetDefault'));
  });

  function setScopeMode(newMode) {
    contextScopeMode = newMode === 'per_model' ? 'per_model' : 'unified';
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    syncContextPreferencesCache(contextPreferencesMap);
    void saveSettingsPayloadBridge({ contextScopeMode });
    loadDraftFromSelectedModel(true);
    const prod = getSelectedProductObj();
    if (prod) renderModelDetailCard(prod);
    renderCompactSessionCard();
    if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    render();
  }

  btnModeUnified?.addEventListener('click', () => setScopeMode('unified'));
  btnModePerModel?.addEventListener('click', () => setScopeMode('per_model'));

  async function invokeUnlockApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getContextUnlockStatus) {
      return await window.contextMeterAPI.getContextUnlockStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyContextUnlock) {
      return await window.contextMeterAPI.applyContextUnlock(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreContextUnlock) {
      return await window.contextMeterAPI.restoreContextUnlock(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/context-unlock-${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(payload)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('models.err.noApplyBridge') };
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const r = await fetch(`http://127.0.0.1:${live.port}/restart-host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: '{}'
      });
      return await r.json().catch(() => ({ ok: true, supported: false }));
    }
    return { ok: true, supported: false };
  }

  async function invokeEnhanceApi(endpoint, payload = {}) {
    if (endpoint === 'status' && window.contextMeterAPI?.getEnhanceStatus) {
      return await window.contextMeterAPI.getEnhanceStatus(payload);
    }
    if (endpoint === 'apply' && window.contextMeterAPI?.applyEnhancePatch) {
      return await window.contextMeterAPI.applyEnhancePatch(payload);
    }
    if (endpoint === 'restore' && window.contextMeterAPI?.restoreAllEnhance) {
      return await window.contextMeterAPI.restoreAllEnhance(payload);
    }
    if (endpoint === 'restart-ls' && window.contextMeterAPI?.restartLanguageServers) {
      return await window.contextMeterAPI.restartLanguageServers(payload);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const routeMap = {
        status: '/enhance-status',
        apply: '/enhance-apply',
        restore: '/enhance-restore',
        'restart-ls': '/restart-language-servers'
      };
      const path = routeMap[endpoint];
      if (path) {
        const r = await fetch(`http://127.0.0.1:${live.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(payload)
        });
        return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      }
    }
    return { ok: false, error: t('enhance.result.noBridge'), unavailable: true };
  }

  async function invokeModulesApi(action, name, enable, opts = {}) {
    if (action === 'status' && window.contextMeterAPI?.getModulesStatus) {
      return await window.contextMeterAPI.getModulesStatus();
    }
    if (action === 'toggle' && window.contextMeterAPI?.toggleModule) {
      return await window.contextMeterAPI.toggleModule(name, enable, opts);
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
      const live = window.__AGContextMeterLive;
      const route = action === 'status' ? '/modules-status' : '/toggle-module';
      const body = action === 'status' ? {} : { name, enable, opts };
      const r = await fetch(`http://127.0.0.1:${live.port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
        body: JSON.stringify(body)
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    }
    return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
  }

  async function refreshUnlockStatus() {
    const thisSeq = ++unlockReqSeq;
    try {
      const currentObservedBudget = (state.latest?.budget && state.latest.budget > 0)
        ? state.latest.budget
        : undefined;
      const res = await invokeUnlockApi('status', { currentBudget: currentObservedBudget });
      if (thisSeq !== unlockReqSeq) return;

      if (!res || !res.ok || !res.data) {
        unlockStatusFetchError = true;
        currentUnlockStatus = null;
        if (unlockStatusDesc) unlockStatusDesc.textContent = t('status.client.unavailable');
        renderCompactSessionCard();
        renderClientStatusBar();
        renderSessionQuickActions();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
        return;
      }

      unlockStatusFetchError = false;
      const data = res.data;
      currentUnlockStatus = data;
      lastPartialReason = data.partialMatchReason || data.error || '';
      if (typeof data.hostSupportsRestart === 'boolean') {
        hostSupportsRestart = data.hostSupportsRestart;
      }
      if (data.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
      } else if (data.status === 'patched_loaded' || data.status === 'not_patched') {
        needsRestartAfterApply = false;
      }

      // 重启后校验核对
      if (pendingRestartVerification) {
        if (data.runtimeEvidence?.restartDetected === true) {
          if (data.status === 'patched_loaded' && doesClientMatchVerification(data, pendingRestartVerification)) {
            restartMismatchNotice = '';
          } else {
            restartMismatchNotice = t('models.status.restartMismatch', { actual: describeClientModeValue(data) });
          }
          pendingRestartVerification = null;
          void saveSettingsPayloadBridge({ uiPreferences: { restartVerification: null } });
        }
      }

      const statusInfo = mapUnlockDisplayStatus(data);
      if (unlockStatusDesc) {
        unlockStatusDesc.textContent = t('models.status.line', { badge: statusInfo.badge, mode: describeClientModeValue(data) });
      }
      if (unlockMetaMode) {
        unlockMetaMode.textContent = `${describeClientModeValue(data)}（${statusInfo.badge}）`;
      }
      if (unlockMetaTarget) {
        unlockMetaTarget.textContent = data.arch ? t('models.meta.targetDesktopArch', { arch: data.arch }) : t('models.meta.targetDesktop');
      }
      if (unlockMetaArch) unlockMetaArch.textContent = data.arch || t('models.meta.archUnknown');
      if (unlockMetaBackup) {
        unlockMetaBackup.textContent = data.hasBackup
          ? (data.backupStaleReason ? t('models.meta.backupStale') : t('models.meta.backupReady'))
          : t('models.meta.backupNone');
      }

      if (btnApplyUnlock) {
        const writableStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
        if (writableStatuses.has(data.status) && (!data.arch || data.arch === 'arm64' || data.arch === 'x86-64')) {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.saveApply');
          btnApplyUnlock.hidden = (data.status === 'patched_loaded' && !needsRestartAfterApply);
        } else if (data.status === 'partial_match') {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.partialBlocked');
          btnApplyUnlock.hidden = false;
        } else if (data.status === 'failed') {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.retryApply');
          btnApplyUnlock.hidden = false;
        } else {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.unsupported');
          btnApplyUnlock.hidden = true;
        }
      }

      if (btnRestoreUnlock) {
        btnRestoreUnlock.disabled = !(
          (data.hasBackup && data.backupValidForCurrentBinary !== false) ||
          data.hasMatchingGate3BSidecar ||
          (data.status && data.status !== 'not_patched' && data.status !== 'unsupported')
        );
      }

      if (data.status === 'partial_match' && unlockResultBox && (!unlockResultBox.style.display || unlockResultBox.style.display === 'none')) {
        showUnlockResultBox(
          false,
          t('models.card.partialFailDetail', { reason: translateBackendText(lastPartialReason) || '' }),
          { showRetry: true }
        );
      }

      if (!ctxDraftDirty && !resolveProductPreferenceState(getSelectedProductObj()).pref) {
        loadDraftFromSelectedModel(false);
      } else {
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
      if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    } catch {
      if (thisSeq !== unlockReqSeq) return;
      unlockStatusFetchError = true;
      currentUnlockStatus = null;
      renderCompactSessionCard();
      renderClientStatusBar();
      if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
    }
  }

  btnRefreshUnlock?.addEventListener('click', () => {
    void refreshUnlockStatus();
  });

  btnApplyUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const saved = await saveCurrentProductDraft();
    if (saved.stale) return;
    if (!saved.ok) {
      showUnlockResultBox(false, saved.error);
      return;
    }

    isUnlocking = true;
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    needsRestartAfterApply = false;
    restartMismatchNotice = '';

    try {
      // ELV-41: 底座统一应用为动态透传模式 (mov esi, edx)，使各模型设置能够独立生效，绝不把单一模型的数值固化进二进制
      const res = await invokeUnlockApi('apply', {
        mode: 'dynamic',
        limitTokens: null,
        serviceLimit: state.latest?.serviceLimit || undefined
      });
      if (!res || !res.ok) {
        needsRestartAfterApply = false;
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error), { showRetry: true });
        return;
      }
      if (res.needsRestart === true) {
        needsRestartAfterApply = true;
        showUnlockResultBox(true, t('msg.appliedRestart'), { needsRestart: true });
      } else if (res.alreadyMatched) {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '底座引擎已处于动态跟随状态。当前模型设置已保存，下一次发送时尝试应用。');
      } else {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '已应用底座配置。当前模型设置已保存，下一次发送时尝试应用。');
      }
    } catch (e) {
      needsRestartAfterApply = false;
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
      if (!needsRestartAfterApply && currentUnlockStatus?.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
    }
  });

  let isRestartInProgress = false;

  async function executeClientRestart(fromModal = false) {
    if (isRestartInProgress) return;
    isRestartInProgress = true;
    if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = true;
    if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = true;

    // 记录重启前的观测快照（不保存草稿）
    try {
      const obsObj = budgetTracker ? { ...budgetTracker.exportAllObservationsByProduct() } : {};
      for (const [mid, val] of observedByModelId.entries()) obsObj[mid] = val;
      preRestartSnapshot = { requestedAt: new Date().toISOString(), observations: obsObj };
      localStorage?.setItem(CTX_PRE_RESTART_OBS_KEY, JSON.stringify(preRestartSnapshot));
    } catch {}

    const feedbackEl = fromModal ? modalRestartFeedback : (modalRestartFeedback || ctxRestartFeedback);
    if (feedbackEl) {
      feedbackEl.textContent = t('client.restart.triggering');
      feedbackEl.hidden = false;
    }

    const res = await invokeRestartHostApi();
    if (!res || res.supported === false) {
      hostSupportsRestart = false;
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.hostNotSupported');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      renderClientStatusBar();
      return;
    }
    if (res.ok === false) {
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.failed', { err: translateBackendText(res.error) || t('msg.unknownErr') });
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      return;
    }

    if (feedbackEl) {
      feedbackEl.textContent = t('models.restart.restarting');
      feedbackEl.hidden = false;
    }
    if (restartTimeoutTimer) clearTimeout(restartTimeoutTimer);
    restartTimeoutTimer = setTimeout(() => {
      if (!state.disposed && feedbackEl) {
        feedbackEl.textContent = t('models.restart.notExited');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
    }, 15000);
  }

  function openClientRestartConfirmFlow() {
    if (!hostSupportsRestart) {
      showUnlockResultBox(true, t('client.restart.hostNotSupported'), { needsRestart: true });
      return;
    }
    if (globalRestartModal) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = '';
        modalRestartFeedback.hidden = true;
      }
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      isRestartInProgress = false;
      globalRestartModal.hidden = false;
      return;
    }
    if (ctxRestartConfirm) {
      ctxRestartConfirm.hidden = false;
      if (ctxRestartFeedback) ctxRestartFeedback.hidden = true;
    }
  }

  btnRestartHost?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRestart?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRetry?.addEventListener('click', () => {
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    void refreshUnlockStatus();
  });

  btnModalRestartCancel?.addEventListener('click', () => {
    if (globalRestartModal) globalRestartModal.hidden = true;
  });
  globalRestartModal?.addEventListener('click', (e) => {
    if (e.target === globalRestartModal) {
      globalRestartModal.hidden = true;
    }
  });

  btnModalRestartConfirm?.addEventListener('click', () => executeClientRestart(true));

  btnRestartCancel?.addEventListener('click', () => {
    if (ctxRestartConfirm) ctxRestartConfirm.hidden = true;
  });

  btnRestartConfirmGo?.addEventListener('click', () => executeClientRestart(false));

  btnRestoreUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    isUnlocking = true;
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    if (unlockResultBox) unlockResultBox.style.display = 'none';

    try {
      const res = await invokeUnlockApi('restore');
      if (!res || !res.ok) {
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error || t('msg.restoreFail')), { showRetry: true });
        return;
      }
      needsRestartAfterApply = true;
      showUnlockResultBox(true, t('msg.restoredRestart'), { needsRestart: true });
    } catch (e) {
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      await refreshUnlockStatus();
    }
  });