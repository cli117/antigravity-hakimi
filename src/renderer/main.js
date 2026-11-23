(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const {
    summarize,
    computeCacheMetrics,
    summarizeSessionCache,
    parseGeneratorCall,
    normalizeModelId,
    resolveModelQuota,
    resolveModelQuotaGroup,
    resolveModelQuotaGroupBuckets,
    formatResetTimeZh,
    resolveStableModelId,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    getLvlForRange,
    calculateIntervalTokens
  } = (globalThis.__AGContextMeterCore || {});
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据（纯净初始状态，启动时由宿主实时扫描本地实际账本注入）
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "",
    firstUseDate: null,
    summary: {
      grandTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      todayTokens: 0,
      monthTokens: 0,
      yearTokens: 0,
      totalSteps: 0,
      totalConversations: 0,
      firstUseDate: null,
      activeDaysCount: 0
    },
    dailyMap: {},
    speedRecords: []
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* @INSERT_STYLES_AND_TEMPLATE */

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  /* @INSERT_I18N_MODULE */
  /* @INSERT_BUDGET_ENGINE_MODULE */
  const budgetEngine = globalThis.__AGContextBudgetEngine || {};
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => {
    if (v == null) return '—';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}K`;
    return fmt(v);
  };
  // 悬停信息气泡专用紧凑计数格式（如 37k、475k、1.05M）
  const fmtBubbleToken = v => {
    if (v == null) return t('common.unknown');
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? t('common.notProvided') : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    modelQuotaConfigs: [], modelQuotaGroups: [], quotaSynced: false,
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    reportedFinalCallIds: new Set(), reportedFinalCallOutputs: new Map()
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;

  /* @INSERT_COLORS_MODULE */
  /* @INSERT_TOPBAR_LAYOUT_MODULE */

  // =========================================================================
  // 模块 3: 面板、气泡与溢出菜单交互
  // =========================================================================
  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } }, {
      currentModel: value?.model || state.latest?.model || '',
      cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      previousValidContext: value
    });
    return {
      ...(value || {}),
      error: failure.error,
      errorClassification: failure.errorClassification,
      exceeded: failure.exceeded,
      network: failure.network,
      serviceLimit: failure.serviceLimit || value?.serviceLimit || null,
      status: failure.status,
      // 解耦：保留已有有效上下文数据，不归零、不清空
      used: value?.used ?? failure?.used ?? null,
      actual: failure.exceeded ? null : (value?.actual ?? null),
      estimate: value?.estimate ?? failure?.estimate ?? null,
      budget: value?.budget ?? failure?.budget ?? null,
      percent: failure.exceeded ? 100 : (value?.percent ?? null),
      estimated: value?.actual == null
    };
  }

  function isAnyPanelOpen() {
    return !el('panel').hidden || !el('panel-tokens').hidden;
  }

  function closeTopbarWindowPopover() {
    const pop = el('topbar-window-popover');
    if (pop) pop.hidden = true;
    el('btn-topbar-window')?.setAttribute('aria-expanded', 'false');
    if (!isAnyPanelOpen() && el('overflow-menu')?.hidden !== false) {
      syncHostStackingElevation(false);
    }
  }

  function toggleTopbarWindowPopover() {
    const pop = el('topbar-window-popover');
    if (!pop) return;
    const willOpen = Boolean(pop.hidden);
    showPanel('none');
    hideContextTooltip();
    hideTopbarActionTooltip(true);
    if (willOpen) {
      pop.hidden = false;
      el('btn-topbar-window')?.setAttribute('aria-expanded', 'true');
      if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
      syncHostStackingElevation(true);
      positionFloatingPanels();
    } else {
      closeTopbarWindowPopover();
    }
  }

  function showPanel(target) {
    const pContext = el('panel');
    const pTokens = el('panel-tokens');
    const pOverflow = el('overflow-menu');
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bCache = el('badge-cache');
    const bTokens = el('badge-tokens');
    const bOverflow = el('badge-overflow');

    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');

    if (target === 'tokens') {
      closeTopbarWindowPopover();
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      closeColorPicker();
      pContext.hidden = true;
      pTokens.hidden = false;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bCache?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      void syncTokenHistoryFromHost(false);
      renderActiveHeatView(true);
    } else if (target === 'context') {
      closeTopbarWindowPopover();
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pTokens.hidden = true;
      pContext.hidden = false;
      bContext.setAttribute('aria-expanded', 'true');
      bSpeed?.setAttribute('aria-expanded', 'true');
      bCache?.setAttribute('aria-expanded', String(activeContextTab === 'session'));
      bTokens.setAttribute('aria-expanded', 'false');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      applyContextViewVisibility?.();
      if (activeContextTab === 'models' && !isContextSettingsView) {
        void refreshUnlockStatus();
      } else if (activeContextTab === 'speed' && !isContextSettingsView) {
        renderSpeedComparisonTab?.();
      }
      if (isContextSettingsView) {
        void refreshModulesDisplay();
        void refreshCliUnlockDisplay();
      }
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bCache?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      closeColorPicker();
      hidePopover();
      syncHostStackingElevation(false);
    }
  }

  function toggle(open, tab = 'context') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'tokens' ? 'tokens' : 'context');
    }
  }

  function toggleContext() {
    if (!el('panel').hidden) showPanel('none');
    else showPanel('context');
  }

  function toggleTokens() {
    if (!el('panel-tokens').hidden) showPanel('none');
    else showPanel('tokens');
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    closeTopbarWindowPopover();
    hideContextTooltip();
    hideTopbarActionTooltip(true);
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
    if (willOpen) positionFloatingPanels();
  }

  // 外观调色按钮进入设置视图并直接展开颜色自定义抽屉
  el('btn-panel-palette')?.addEventListener('click', () => {
    openContextSettings?.({ openColors: true });
  });
  el('btn-panel-tokens-palette')?.addEventListener('click', () => toggleTokenColorsDrawer());

  function hasClass(node, cls) {
    if (!node) return false;
    if (node.classList?.contains) return node.classList.contains(cls);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  function addClass(node, cls) {
    if (!node) return;
    if (node.classList?.add) { node.classList.add(cls); return; }
    const cur = String(node.className || '').trim();
    if (!cur.split(/\s+/).includes(cls)) node.className = cur ? `${cur} ${cls}` : cls;
  }
  function removeClass(node, cls) {
    if (!node) return;
    if (node.classList?.remove) { node.classList.remove(cls); return; }
    const parts = String(node.className || '').split(/\s+/).filter(c => c !== cls);
    node.className = parts.join(' ');
  }

  // 纯同步 UI 控件回填防护守卫（仅在纯同步赋值代码块内开启，严禁跨越 await）
  let isHydratingUiControls = false;
  function runWithUiHydration(fn) {
    const prev = isHydratingUiControls;
    isHydratingUiControls = true;
    try {
      return fn();
    } finally {
      isHydratingUiControls = prev;
    }
  }

  // 兼容老调用声明
  let isRestoringSettings = false;

  // 异步时序保护：用户主动修改序列号与恢复请求版本号
  let userActionSeq = 0;
  let restoreRequestSeq = 0;

  /* @INSERT_DROPDOWN_MODULE */
  /* @INSERT_MODEL_QUOTA_MODULE */

  function renderPlanDetail(ps) {
    if (!ps) return;
    const sumTxt = el('plan-summary-text');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : t('plan.summary.unknown');
      sumTxt.textContent = `${ps.tierName || 'Pro'} · ${modeTxt} · ${t('plan.summary.justNow')}`;
    }

    const detName = el('p-det-name');
    if (detName) detName.textContent = ps.tierName || 'Google AI Pro';
    const detAcc = el('p-det-account');
    if (detAcc) detAcc.textContent = ps.email || t('plan.account.unknown');

    // 守卫：若详情处于收起状态，严禁异步返回时撑开详情面板
    const cardEl = el('plan-detail-card');
    if (cardEl && !planDetailExpanded) {
      cardEl.style.display = 'none';
      cardEl.classList?.remove?.('is-expanded');
    }

    const pPrompt = el('p-det-prompt-credits');
    const pFlow = el('p-det-flow-credits');
    if (pPrompt && ps.promptCredits) {
      const promptTxt = `Prompt Credits: ${t('plan.credits.avail', { avail: ps.promptCredits.available ?? '—', monthly: ps.promptCredits.monthly ?? '—' })}`;
      pPrompt.textContent = promptTxt;
      const pLegacy = el('p-det-credits');
      if (pLegacy) pLegacy.textContent = promptTxt;
    }
    if (pFlow && ps.flowCredits) {
      pFlow.textContent = t('plan.credits.avail', { avail: ps.flowCredits?.available ?? '—', monthly: ps.flowCredits?.monthly ?? '—' });
    }
    const detTime = el('p-det-time');
    if (detTime) {
      detTime.textContent = ps.updatedAt ? new Date(ps.updatedAt).toLocaleString() : '—';
    }
  }

  function setPillActive(node, active) {
    if (!node) return;
    node.classList?.toggle?.('active', active);
    const cur = node.getAttribute('class') || 'switch-pill-btn';
    if (active) {
      if (!cur.includes('active')) node.setAttribute('class', (cur + ' active').trim());
    } else {
      node.setAttribute('class', cur.replace(/\bactive\b/g, '').trim());
    }
  }

  // 数据源切换（全部 / 桌面 / CLI）
  let activeTokenSource = 'all';
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch {}
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = bySrc[src] || bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      renderActiveHeatView(true);
    }
  }
  el('src-tab-all')?.addEventListener('click', () => switchTokenSource('all'));
  el('src-tab-desktop')?.addEventListener('click', () => switchTokenSource('desktop'));
  el('src-tab-cli')?.addEventListener('click', () => switchTokenSource('cli'));

  el('badge').addEventListener('click', toggleContext);
  el('badge-speed')?.addEventListener('click', toggleContext);
  el('badge-cache')?.addEventListener('click', () => {
    if (!el('panel').hidden && activeContextTab === 'session') {
      showPanel('none');
    } else {
      showPanel('context');
      switchContextTab('session');
    }
  });
  el('badge-tokens').addEventListener('click', toggleTokens);
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-speed-btn')?.addEventListener('click', () => showPanel('context'));
  el('overflow-cache-btn')?.addEventListener('click', () => {
    showPanel('context');
    switchContextTab('session');
  });
  el('overflow-tokens-btn')?.addEventListener('click', () => showPanel('tokens'));
  el('badge-cache')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('cache', el('badge-cache'));
  });
  el('badge-cache')?.addEventListener('mouseleave', () => {
    hideTopbarActionTooltip(false);
  });
  el('badge-cache')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('cache', el('badge-cache'));
  });
  el('badge-cache')?.addEventListener('blur', () => {
    hideTopbarActionTooltip(false);
  });
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));

  // 上下文圆环悬停与键盘聚焦气泡（面板打开时不通过悬停误切，必须通过显式左键点击切换）
  el('badge').addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showContextTooltip();
    }
  });
  el('badge').addEventListener('mouseleave', () => {
    hideContextTooltip();
  });
  el('badge').addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showContextTooltip();
  });
  el('badge').addEventListener('blur', () => {
    hideContextTooltip();
  });

  // 顶部快捷操作（仅图标）：悬停/聚焦展示说明气泡，点击直接触发动作或弹出快速调节浮层
  el('btn-topbar-compact')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('compact', el('btn-topbar-compact'));
  });
  el('btn-topbar-compact')?.addEventListener('mouseleave', () => {
    hideTopbarActionTooltip(false);
  });
  el('btn-topbar-compact')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('compact', el('btn-topbar-compact'));
  });
  el('btn-topbar-compact')?.addEventListener('blur', () => {
    hideTopbarActionTooltip(false);
  });
  el('btn-topbar-compact')?.addEventListener('click', () => {
    closeTopbarWindowPopover();
    void triggerSessionCompact('topbar');
  });

  el('btn-topbar-window')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('window', el('btn-topbar-window'));
  });
  el('btn-topbar-window')?.addEventListener('mouseleave', () => {
    hideTopbarActionTooltip(false);
  });
  el('btn-topbar-window')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen() && el('topbar-window-popover')?.hidden !== false) showTopbarActionTooltip('window', el('btn-topbar-window'));
  });
  el('btn-topbar-window')?.addEventListener('blur', () => {
    hideTopbarActionTooltip(false);
  });
  el('btn-topbar-window')?.addEventListener('click', () => {
    toggleTopbarWindowPopover();
  });

  el('btn-twp-toggle-scope')?.addEventListener('click', () => {
    setScopeMode(getContextScopeMode() === 'unified' ? 'per_model' : 'unified');
  });

  el('btn-twp-open-models')?.addEventListener('click', () => {
    closeTopbarWindowPopover();
    isContextSettingsView = false;
    if (activeSessionProductKey) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
      manualModelSelection = false;
      ctxDraftDirty = false;
    }
    showPanel('context');
    switchContextTab('models');
  });

  el('twp-preset-grid')?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.twp-preset-btn');
    if (!btn || btn.disabled) return;
    const mode = btn.getAttribute('data-qctx-mode') || 'fixed';
    const rawLim = btn.getAttribute('data-qctx-limit');
    const lim = rawLim ? Number(rawLim) : null;
    void applyQuickContextPreset(mode, lim, { source: 'popover' });
  });

  el('session-ctx-preset-bar')?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.twp-preset-btn');
    if (!btn || btn.disabled) return;
    const mode = btn.getAttribute('data-qctx-mode') || 'fixed';
    const rawLim = btn.getAttribute('data-qctx-limit');
    const lim = rawLim ? Number(rawLim) : null;
    void applyQuickContextPreset(mode, lim, { source: 'session_card' });
  });

  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('theme-toggle-tokens')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('btn-topbar-compact')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('btn-topbar-window')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-cache')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // =========================================================================
  // 模块 3: 上下文面板分页、设置视图、模型产品偏好、重启验证与速度对比
  // =========================================================================
  const btnTabSession = el('tab-ctx-session');
  const btnTabModels = el('tab-ctx-models');
  const btnTabSpeed = el('tab-ctx-speed');
  const btnTabSettings = el('tab-ctx-settings');
  const paneSession = el('pane-ctx-session');
  const paneModels = el('pane-ctx-models');
  const paneSpeed = el('pane-ctx-speed');
  const paneSettings = el('pane-ctx-settings');
  const ctxTabsBar = el('ctx-tabs-bar');
  const btnCtxSettings = el('btn-ctx-settings');
  const btnCtxSettingsBack = el('btn-ctx-settings-back');
  const btnGotoModelSettings = el('btn-goto-model-settings');
  const btnCardGotoSpeed = el('btn-card-goto-speed');
  const btnCtxBackCurrent = el('btn-ctx-back-current');
  const ctxCompactSavedEl = el('ctx-compact-saved');
  const ctxCompactClientEl = el('ctx-compact-client');

  const btnToggleUnlockDetails = el('btn-toggle-unlock-details');
  const unlockDrawerBody = el('unlock-drawer-body');
  const unlockDrawerArrow = el('unlock-drawer-arrow');
  const unlockBadge = el('unlock-badge');
  const unlockStatusDesc = el('unlock-status-desc');
  const ctxClientStatusText = el('ctx-client-status-text');
  const ctxRestartMismatchNote = el('ctx-restart-mismatch-note');
  const btnRestartHost = el('btn-restart-host');
  const ctxManualRestartNote = el('ctx-manual-restart-note');
  const ctxRestartConfirm = el('ctx-restart-confirm');
  const btnRestartCancel = el('btn-restart-cancel');
  const btnRestartConfirmGo = el('btn-restart-confirm-go');
  const ctxRestartFeedback = el('ctx-restart-feedback');
  const globalRestartModal = el('global-restart-modal');
  const modalRestartTitle = el('modal-restart-title');
  const modalRestartText = el('modal-restart-text');
  const modalRestartFeedback = el('modal-restart-feedback');
  const btnModalRestartCancel = el('btn-modal-restart-cancel');
  const btnModalRestartConfirm = el('btn-modal-restart-confirm');

  const btnApplyUnlock = el('btn-apply-unlock');
  const btnRestoreUnlock = el('btn-restore-unlock');
  const btnRefreshUnlock = el('btn-refresh-unlock');
  const unlockResultBox = el('unlock-result-box');
  const unlockResultText = el('unlock-result-text');
  const unlockResultActions = el('unlock-result-actions');
  const btnUnlockResultRestart = el('btn-unlock-result-restart');
  const btnUnlockResultRetry = el('btn-unlock-result-retry');
  const unlockResultManual = el('unlock-result-manual');
  const unlockMetaMode = el('unlock-meta-mode');
  const unlockMetaTarget = el('unlock-meta-target');
  const unlockMetaArch = el('unlock-meta-arch');
  const unlockMetaBackup = el('unlock-meta-backup');
  const linkUnlockAuthor = el('link-unlock-author');
  const btnCopyUnlockLink = el('btn-copy-unlock-link');
  const unlockLinkToast = el('unlock-link-toast');

  const ctxModelSelect = el('ctx-model-select');
  const ctxModelSelectorRoleEl = el('ctx-model-selector-role');
  const ctxModelDropdownLabelEl = el('ctx-model-dropdown-label');
  const ctxModelListEl = el('ctx-model-list');
  const ctxConflictBanner = el('ctx-conflict-banner');
  const ctxConflictRows = el('ctx-conflict-rows');
  const ctxCardVendorDot = el('ctx-card-vendor-dot');
  const ctxCardVendorName = el('ctx-card-vendor-name');
  const ctxCardProductName = el('ctx-card-product-name');
  const ctxCardEffortsList = el('ctx-card-efforts-list');
  const ctxCardSessionEffort = el('ctx-card-session-effort');
  const ctxCardSavedEl = el('ctx-card-saved');
  const ctxCardRequestEl = el('ctx-card-request');
  const ctxCardClientEl = el('ctx-card-client');
  const ctxCardClientTagEl = el('ctx-card-client-tag');
  const ctxCardObservedBudgetEl = el('ctx-card-observed-budget');
  const ctxCardPreRestartBudgetEl = el('ctx-card-pre-restart-budget');
  const ctxCardServiceLimitEl = el('ctx-card-service-limit');
  const ctxCardConvoEl = el('ctx-card-convo');
  const ctxCardDiagnosisEl = el('ctx-card-diagnosis');
  const ctxCardObservedSpeedEl = el('ctx-card-observed-speed');
  const ctxCardHintsEl = el('ctx-card-hints');
  const ctxCapWindowEl = el('ctx-cap-window');
  const ctxCapOutputEl = el('ctx-cap-output');
  const ctxCapModelMaxEl = el('ctx-cap-model-max');
  const ctxCapClientPolicyEl = el('ctx-cap-client-policy');
  const ctxCapDefaultEl = el('ctx-cap-default');
  const ctxCapRangeEl = el('ctx-cap-range');
  const ctxCapFormulaEl = el('ctx-cap-formula');
  const ctxRefSavedEl = el('ctx-ref-saved');
  const ctxRefSentEl = el('ctx-ref-sent');
  const ctxRefAdoptedEl = el('ctx-ref-adopted');
  const ctxUnifiedProjEl = el('ctx-unified-projection');
  const ctxCardTierCapsRowEl = el('ctx-card-tier-caps-row');
  const ctxCardTierCapsEl = el('ctx-card-tier-caps');
  const ctxPresetModelMaxSubEl = el('ctx-preset-modelmax-sub');

  const ctxPresetGrid = el('ctx-preset-grid');
  const ctxCustomInput = el('ctx-custom-limit-input');
  const ctxValidationEl = el('ctx-limit-validation');
  const btnSaveModelCtx = el('btn-save-model-ctx');
  const btnResetModelCtx = el('btn-reset-model-ctx');
  const ctxResetNoticeEl = el('ctx-reset-notice');

  // 双模式控件与精简展示元素
  const btnModeUnified = el('btn-ctx-mode-unified');
  const btnModePerModel = el('btn-ctx-mode-per-model');
  const ctxModelsToolbar = el('ctx-models-toolbar');
  const ctxSummaryModeEl = el('ctx-summary-mode');
  const ctxSummaryModelEl = el('ctx-summary-model');
  const ctxSummaryLengthEl = el('ctx-summary-length');
  const ctxSummaryStatusPillEl = el('ctx-summary-status-pill');

  const CTX_DEFAULT_TOKENS = 256000;
  const CTX_MIN_ENGINEERING_TOKENS = 16384;
  const CTX_MAX_ENGINEERING_TOKENS = 2097152;
  const CTX_ACTIVE_TAB_KEY = 'ag_ctx_active_tab';
  const CTX_PRE_RESTART_OBS_KEY = 'ag_ctx_pre_restart_obs_v1';

  const VENDOR_ORDER = ['Google', 'Anthropic', 'OpenAI', '其他'];
  const VENDOR_DOT_COLORS = {
    Google: 'var(--ag-custom-speed, var(--ag-speed-default, #38bdf8))',
    Anthropic: 'var(--ag-ring-warn, #f59e0b)',
    OpenAI: 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))',
    '其他': 'var(--ag-text-muted, #8a8a94)'
  };

  let activeContextTab = 'session';
  try {
    const savedTab = localStorage?.getItem(CTX_ACTIVE_TAB_KEY);
    if (savedTab === 'session' || savedTab === 'models' || savedTab === 'speed') {
      activeContextTab = savedTab;
    }
  } catch {}
  let isContextSettingsView = false;

  let currentUnlockStatus = null;
  let unlockStatusFetchError = false;
  let isUnlocking = false;
  let lastPartialReason = '';
  let unlockReqSeq = 0;
  let contextPrefSaveSeq = 0;
  let contextPreferencesMap = {};
  let contextScopeMode = 'unified'; // 'unified' | 'per_model'
  let contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  try {
    if (typeof window !== 'undefined' && window.__AGContextPreferences && typeof window.__AGContextPreferences === 'object') {
      contextPreferencesMap = { ...window.__AGContextPreferences };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawPrefs = localStorage.getItem('ag-context-preferences');
      if (rawPrefs) contextPreferencesMap = JSON.parse(rawPrefs) || {};
    }
    const initMode = (typeof window !== 'undefined' && window.__AGContextScopeMode)
      || (typeof localStorage !== 'undefined' && localStorage?.getItem?.('ag-context-scope-mode'))
      || '';
    if (initMode === 'unified' || initMode === 'per_model') {
      contextScopeMode = initMode;
    }
    if (typeof window !== 'undefined' && window.__AGContextUnifiedPreference && typeof window.__AGContextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...window.__AGContextUnifiedPreference };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawUni = localStorage.getItem('ag-context-unified-preference');
      if (rawUni) contextUnifiedPreference = JSON.parse(rawUni) || contextUnifiedPreference;
    }
  } catch {}

  function getContextScopeMode() {
    return contextScopeMode || 'unified';
  }

  function getContextUnifiedPreference() {
    return contextUnifiedPreference || { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  }

  function syncContextPreferencesCache(map) {
    try {
      if (typeof window !== 'undefined') {
        window.__AGContextPreferences = { ...(map || {}) };
        window.__AGContextScopeMode = contextScopeMode;
        window.__AGContextUnifiedPreference = { ...(contextUnifiedPreference || {}) };
        localStorage?.setItem('ag-context-preferences', JSON.stringify(map || {}));
        localStorage?.setItem('ag-context-scope-mode', contextScopeMode);
        localStorage?.setItem('ag-context-unified-preference', JSON.stringify(contextUnifiedPreference || {}));
      }
    } catch {}
  }
  let activeSessionModelKey = null;
  let activeSessionProductKey = null;
  let activeSessionEffort = null;
  let activeSessionModelConfirmed = false;
  let selectedEditModelKey = null;
  let selectedProductKey = null;
  let manualModelSelection = false;
  let ctxDraft = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  let ctxDraftDirty = false;
  let lastAutoObservedBudget = 0;
  let needsRestartAfterApply = false;
  let pendingRestartVerification = null;
  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;
  let restartMismatchNotice = '';

  const observedByModelId = new Map();
  let preRestartSnapshot = null;
  try {
    const rawPre = localStorage?.getItem(CTX_PRE_RESTART_OBS_KEY);
    if (rawPre) preRestartSnapshot = JSON.parse(rawPre);
  } catch {}

  let speedRangeDays = '7';
  let speedOriginFilter = 'all';
  let speedMetric = 'tps';
  let selectedSpeedExactModelId = null;
  let ctxHeaderDropdownCtrl = null;
  let speedModelDropdownCtrl = null;

  function formatKShort(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (typeof formatTokensK === 'function') return formatTokensK(n);
    return short(n);
  }

  function formatMonthDayTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatEffortZh(effort) {
    if (!effort) return '';
    const lang = typeof getPanelLanguage === 'function' ? getPanelLanguage() : 'zh-CN';
    if (typeof formatEffortLabel === 'function') return formatEffortLabel(effort, lang);
    return String(effort);
  }

  function groupProductSafe(input) {
    if (typeof groupModelProduct === 'function') return groupModelProduct(input || {});
    const rawId = String(input?.modelId || input?.label || 'unknown').trim();
    const low = rawId.toLowerCase();
    const vendor = low.includes('claude') ? 'Anthropic' : (low.includes('gpt') || low.includes('o1') || low.includes('o3')) ? 'OpenAI' : ((low.includes('gemini') || low.includes('hydrogen') || low.includes('argon') || low.includes('carbon')) ? 'Google' : '其他');
    return { productKey: low, productLabel: input?.label || rawId, vendor, effort: input?.effort || null };
  }

  function resolveStableModelKeyClient(rawOrLatest) {
    if (!rawOrLatest) return null;
    if (typeof resolveStableModelId === 'function') {
      const resolved = resolveStableModelId(rawOrLatest, state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);
      if (resolved) return resolved;
    }
    if (typeof rawOrLatest === 'string') {
      const s = rawOrLatest.trim().toLowerCase();
      return s || null;
    }
    const str = String(rawOrLatest.modelId || rawOrLatest.modelRaw || rawOrLatest.model || '').trim().toLowerCase();
    return str || null;
  }

  /* @INSERT_REQUEST_INTERCEPTOR_MODULE */

  /* @INSERT_CONTEXT_SETTINGS_MODULE */

  /* @INSERT_SPEED_PANEL_MODULE */

  /* @INSERT_SETTINGS_PANEL_MODULE */

  // =========================================================================
  // 模块 4: 数据渲染、完整本地 Token 历史读取与首次使用日起算时间轴
  // =========================================================================
  function renderFiles(session) {
    const parent = el('files'); parent.replaceChildren();
    if (!session) { const item = document.createElement('p'); item.textContent = t('files.reading'); parent.appendChild(item); return; }
    if (!Array.isArray(session.attachments) || !session.attachments.length) { const item = document.createElement('p'); item.textContent = t('files.empty'); parent.appendChild(item); return; }
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? t('files.refs', { n: file.references }) : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      const sizeInfo = file.width && file.height
        ? t('files.px', { w: file.width, h: file.height })
        : (typeof file.chars === 'number' && file.chars > 0 ? t('files.chars', { n: fmt(file.chars) }) : '');
      const tokenInfo = range(file) ? `${range(file)} token` : t('files.tokUnknown');
      const sheetsPart = file.sheets != null ? t('files.sheets', { sheets: file.sheets, cells: fmt(file.cells) }) : '';
      const hiddenPart = file.hiddenSheets ? t('files.hiddenSheets', { n: file.hiddenSheets }) : '';
      detail.textContent = `${file.source === 'assistant' ? t('files.assistantPrefix') : ''}${tokenInfo}${sizeInfo ? ` · ${sizeInfo}` : ''}${sheetsPart}${hiddenPart}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = t('files.unknownPrefix', { parts: file.unknownParts.join('；') }); item.appendChild(unknown); }
      parent.appendChild(item);
    }
  }

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString('en-US');
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  function parseLocalYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDotYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  function formatZhYmd(ymd) {
    const d = parseLocalYmd(ymd);
    if (!d) return ymd || '—';
    if (currentPanelLanguage === 'en') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function addDays(baseDate, deltaDays) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() + deltaDays);
    return d;
  }

  function getFirstUseDateStr() {
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (map[k]?.total > 0)).sort();
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return formatLocalYmd(new Date());
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = parseLocalYmd(firstStr) || today;
    const totalDays = 52 * 7; // 364 天（12 个月 / 52 周）
    const elapsedDays = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / 86400000)) + 1;

    let winStart;
    let winEnd;
    let canPrev = false;
    let canNext = false;

    if (elapsedDays <= totalDays) {
      // 使用未满一年：起点固定为实际首次使用日，向后铺满 12 个月（前置空白为 0）
      heatPageOffset = 0;
      winStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      winEnd = addDays(winStart, totalDays - 1);
    } else {
      // 使用满一年后：默认窗口滚动为「以今天结尾的最近 12 个月」，且起点永不早于首次使用日；支持 ‹ / › 翻页回看更早归档
      const latestStart = addDays(today, -(totalDays - 1));
      const stepDays = 26 * 7; // 每次翻页半年度（26 周）
      let candidateStart = addDays(latestStart, heatPageOffset * stepDays);
      if (candidateStart.getTime() <= firstDate.getTime()) {
        candidateStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const maxBackSteps = -Math.ceil((latestStart.getTime() - firstDate.getTime()) / (stepDays * 86400000));
        if (heatPageOffset < maxBackSteps) heatPageOffset = maxBackSteps;
      }
      winStart = candidateStart;
      winEnd = addDays(winStart, totalDays - 1);
      canPrev = winStart.getTime() > firstDate.getTime();
      canNext = heatPageOffset < 0;
    }

    const firstBadge = el('first-use-badge');
    if (firstBadge) firstBadge.textContent = t('tokens.firstUse', { date: formatZhYmd(firstStr) });
    const rangeEl = el('h-win-range');
    const prevBtn = el('h-page-prev');
    const nextBtn = el('h-page-next');

    if (activeHeatView === 'monthly') {
      const targetMonthDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
      const targetY = targetMonthDate.getFullYear();
      const targetM = targetMonthDate.getMonth();
      const firstY = firstDate.getFullYear();
      const firstM = firstDate.getMonth();
      const targetMonthKey = targetY * 12 + targetM;
      const firstMonthKey = firstY * 12 + firstM;
      canPrev = targetMonthKey > firstMonthKey;
      canNext = heatMonthOffset < 0;
      if (rangeEl) rangeEl.textContent = t('tokens.range.month', { y: targetY, m: currentPanelLanguage === 'en' ? String(targetM + 1).padStart(2, '0') : (targetM + 1) });
    } else if (activeHeatView === 'yearly') {
      const thisY = today.getFullYear();
      const targetY = thisY + heatYearOffset;
      const firstY = firstDate.getFullYear();
      canPrev = targetY > firstY;
      canNext = heatYearOffset < 0;
      if (rangeEl) {
        rangeEl.textContent = (targetY === thisY) ? t('tokens.range.yearToToday', { y: targetY }) : t('tokens.range.year', { y: targetY });
      }
    } else {
      if (rangeEl) rangeEl.textContent = `${formatDotYmd(winStart)} – ${formatDotYmd(winEnd)}`;
    }

    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;

    return { firstStr, firstDate, today, winStart, winEnd, totalDays, canPrev, canNext };
  }

  function applyTokenHistoryPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (Array.isArray(payload.speedRecords)) {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = payload.speedRecords;
      if (!isContextSettingsView && activeContextTab === 'speed') {
        renderSpeedComparisonTab();
      } else if (!isContextSettingsView && activeContextTab === 'models') {
        renderModelSettingsTab();
      }
    }
    if (payload.modelCapabilitiesById && typeof payload.modelCapabilitiesById === 'object') {
      mergeCapabilitiesMapClient(payload.modelCapabilitiesById);
    }
    if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
      const hasExisting = Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0;
      const incomingHasCaps = payload.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      const existingHasCaps = hasExisting && state.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!hasExisting || (incomingHasCaps && !existingHasCaps)) {
        state.cascadeModelConfigs = payload.cascadeModelConfigs;
        renderHeaderModelDropdown();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    }

    if (!payload.loading) {
      let quotaUpdated = false;
      if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
        state.modelQuotaConfigs = payload.cascadeModelConfigs;
        quotaUpdated = true;
      }
      if (Array.isArray(payload.rawPlanStatus?.modelQuotaGroups)) {
        state.modelQuotaGroups = payload.rawPlanStatus.modelQuotaGroups;
        quotaUpdated = true;
      }
      if (payload.rawPlanStatus || Array.isArray(payload.cascadeModelConfigs)) {
        state.quotaSynced = true;
        quotaUpdated = true;
      }
      if (quotaUpdated) renderModelQuota(true);
    }

    const hasExistingData = Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0;
    const incomingKeys = Object.keys(payload.dailyMap || {});
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(payload.dailyMap[k]?.total) || 0), 0);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || incomingTotal > 0;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(payload, { source: activeTokenSource, todayStr })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      if (normalized.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate;
      if (normalized.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = normalized.updatedAt;
    } else {
      const newMap = {};
      if (payload.dailyMap && typeof payload.dailyMap === 'object') {
        for (const [dKey, rec] of Object.entries(payload.dailyMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || !rec) continue;
          newMap[dKey] = {
            total: Number(rec.total) || 0,
            input: Number(rec.input) || 0,
            output: Number(rec.output) || 0,
            cache: Number(rec.cache) || 0,
            steps: Number(rec.steps) || 0
          };
        }
      }
      ANTIGRAVITY_TOKEN_DATA.dailyMap = newMap;
      if (payload.dailyMapBySource) ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = payload.dailyMapBySource;
      if (payload.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = payload.firstUseDate;
      if (payload.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = payload.updatedAt;
      if (payload.currentPeriod) ANTIGRAVITY_TOKEN_DATA.currentPeriod = payload.currentPeriod;

      const keys = Object.keys(newMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && newMap[k]?.total > 0).sort();
      const monthPrefix = todayStr.slice(0, 7);
      const yearPrefix = todayStr.slice(0, 4);
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, yearTokens = 0;
      let totalInput = 0, totalOutput = 0, totalCache = 0;
      let curMonthInput = 0, curMonthOutput = 0, curMonthCache = 0;
      for (const k of keys) {
        const r = newMap[k];
        const tok = Number(r.total) || 0;
        totalTokens += tok;
        totalInput += Number(r.input) || 0;
        totalOutput += Number(r.output) || 0;
        totalCache += Number(r.cache) || 0;
        if (k === todayStr) todayTokens += tok;
        if (k.startsWith(monthPrefix)) {
          monthTokens += tok;
          curMonthInput += Number(r.input) || 0;
          curMonthOutput += Number(r.output) || 0;
          curMonthCache += Number(r.cache) || 0;
        }
        if (k.startsWith(yearPrefix)) yearTokens += tok;
      }
      const rawSum = payload.summary || {};
      ANTIGRAVITY_TOKEN_DATA.summary = {
        grandTotalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        totalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        todayTokens: todayTokens > 0 ? todayTokens : (Number(rawSum.todayTokens) || 0),
        monthTokens: Math.max(monthTokens, Number(rawSum.monthTokens) || 0),
        yearTokens: Math.max(yearTokens, Number(rawSum.yearTokens) || 0),
        totalInputTokens: Math.max(totalInput, Number(rawSum.totalInputTokens) || 0),
        totalOutputTokens: Math.max(totalOutput, Number(rawSum.totalOutputTokens) || 0),
        totalCacheTokens: Math.max(totalCache, Number(rawSum.totalCacheTokens) || 0),
        currentMonthInput: Math.max(curMonthInput, Number(rawSum.currentMonthInput) || 0),
        currentMonthOutput: Math.max(curMonthOutput, Number(rawSum.currentMonthOutput) || 0),
        currentMonthCache: Math.max(curMonthCache, Number(rawSum.currentMonthCache) || 0),
        totalDays: keys.length,
        totalConversations: Number(rawSum.totalConversations) || keys.length,
        firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
      };
    }

    if (payload.planStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = payload.planStatus;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus;
      renderPlanDetail(payload.planStatus);
    }

    // 重新汇总卡片统计与顶栏
    const sum = ANTIGRAVITY_TOKEN_DATA.summary;
    const totalTokens = sum.grandTotalTokens;
    const shownToday = sum.todayTokens;
    const monthTokens = sum.monthTokens;
    const yearTokens = sum.yearTokens;
    const convCount = sum.totalConversations;
    const totalDays = sum.totalDays || Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length;
    const avgMonth = Math.round(monthTokens / Math.max(1, totalDays));

    const fmtCardM = v => {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    };
    const badgeAmt = el('token-amount');
    const badgeExtra = el('token-hover-extra');
    const overAmt = el('overflow-tokens-val');
    if (badgeAmt) badgeAmt.textContent = fmtCardM(totalTokens);
    if (badgeExtra) badgeExtra.textContent = t('tokens.badge.today', { val: fmtCardM(shownToday) });
    if (overAmt) overAmt.textContent = fmtCardM(totalTokens);

    const tTotalVal = el('t-total-val');
    const tTotalSub = el('t-total-sub');
    const tTodayVal = el('t-today-val');
    const tTodaySub = el('t-today-sub');
    const tMonthVal = el('t-month-val');
    const tMonthSub = el('t-month-sub');
    const tYearVal = el('t-year-val');
    const tYearSub = el('t-year-sub');

    if (tTotalVal) tTotalVal.textContent = fmtCardM(totalTokens);
    if (tTotalSub) tTotalSub.textContent = `${totalTokens.toLocaleString('en-US')} Tokens`;
    if (tTodayVal) tTodayVal.textContent = fmtCardM(shownToday);
    if (tTodaySub) tTodaySub.textContent = t('tokens.card.todaySub', { n: convCount });
    if (tMonthVal) tMonthVal.textContent = fmtCardM(monthTokens);
    if (tMonthSub) tMonthSub.textContent = t('tokens.card.monthSub', { val: fmtCardM(avgMonth) });
    if (tYearVal) tYearVal.textContent = fmtCardM(yearTokens);
    if (tYearSub) tYearSub.textContent = t('tokens.card.yearSub', { n: totalDays });

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }


  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return;
    let changed = false;
    const hasFinalCall = calls.some(c => c?.status === 'final');
    try {
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function') {
        const res = await window.contextMeterAPI.recordCalls(calls);
        if (res && res.ok === false) {
          console.warn('Context Meter: 记录调用入账失败', res.error);
        } else if (res?.changed) {
          changed = true;
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/record-calls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ calls })
        });
        if (!resp.ok) {
          console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${resp.status}`);
        } else {
          const res = await resp.json().catch(() => null);
          if (res && res.ok === false) {
            console.warn('Context Meter: 实时通道 record-calls 失败', res.error);
          } else if (res?.changed) {
            changed = true;
          }
        }
      }
      if (changed || hasFinalCall) {
        void syncTokenHistoryFromHost(false);
      }
    } catch (err) {
      console.warn('Context Meter: 调用入账发生异常', err);
    }
  }

  async function restoreSettingsFromHost() {
    if (state.disposed) return;
    const thisSeq = ++restoreRequestSeq;
    const startActionSeq = userActionSeq;
    try {
      let settingsRes = null;
      const currentEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';

      // 权威配置同步：宿主通信桥接可用时，以宿主最新持久化配置为准，避免启动快照覆盖最新状态
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function') {
        settingsRes = await window.contextMeterAPI.getSettings({ email: currentEmail });
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/get-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ email: currentEmail })
        });
        if (r.ok) settingsRes = await r.json().catch(() => null);
      } else if (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
        settingsRes = window.__AGContextMeterSettings;
      }

      // 若在网络等待期间有更新的恢复请求完成或用户发生了最新主动修改，丢弃旧回包！
      if (thisSeq < restoreRequestSeq || userActionSeq > startActionSeq) {
        return;
      }

      if (settingsRes?.ok) {
        if (settingsRes.uiPreferences?.restartVerification && typeof settingsRes.uiPreferences.restartVerification === 'object') {
          pendingRestartVerification = { ...settingsRes.uiPreferences.restartVerification };
          void refreshUnlockStatus();
        }
        if (settingsRes.contextScopeMode) {
          contextScopeMode = settingsRes.contextScopeMode === 'per_model' ? 'per_model' : 'unified';
        } else {
          const hasPerModelPrefs = settingsRes.contextPreferences && Object.values(settingsRes.contextPreferences).some(p => p && p.mode && p.mode !== 'default');
          contextScopeMode = hasPerModelPrefs ? 'per_model' : 'unified';
        }

        if (settingsRes.contextUnifiedPreference && typeof settingsRes.contextUnifiedPreference === 'object') {
          contextUnifiedPreference = { ...settingsRes.contextUnifiedPreference };
        } else {
          contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
        }

        if (settingsRes.contextPreferences && typeof settingsRes.contextPreferences === 'object') {
          contextPreferencesMap = { ...settingsRes.contextPreferences };
        }
        syncContextPreferencesCache(contextPreferencesMap);
        renderHeaderModelDropdown();
        if (!ctxDraftDirty) loadDraftFromSelectedModel(true);
        else renderCompactSessionCard();
        if (typeof renderQuickContextControls === 'function') renderQuickContextControls();
        const savedView = settingsRes.savedHeatView || settingsRes.uiPreferences?.savedHeatView;
        if (savedView && ['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(savedView)) {
          switchHeatView(savedView, false);
        }
        const savedLang = settingsRes.panelLanguage || settingsRes.uiPreferences?.panelLanguage;
        if (savedLang && ['zh-CN', 'zh-TW', 'en'].includes(savedLang) && savedLang !== currentPanelLanguage) {
          await applyPanelLanguage(savedLang, { persist: false });
        }
        if (hydrateModelQuotaPrefs(settingsRes.uiPreferences)) {
          renderModelQuota(true);
        }
      } else {
        try {
          const localLang = localStorage?.getItem('ag_panel_language');
          if (localLang && ['zh-CN', 'zh-TW', 'en'].includes(localLang) && localLang !== currentPanelLanguage) {
            await applyPanelLanguage(localLang, { persist: false });
          }
        } catch {}
      }

      if (settingsRes?.ok && typeof window !== 'undefined') {
        window.__AGContextMeterSettings = {
          ok: true,
          contextPreferences: { ...contextPreferencesMap },
          uiPreferences: {
            ...(settingsRes.uiPreferences || {}),
            quotaShow5h: show5hQuota,
            quotaMinimized: userMinimized
          }
        };
      }
    } catch {}
  }

  let historySyncBusy = false;
  let pendingHistoryForce = false;
  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      if (force) {
        pendingHistoryForce = true;
      }
      return;
    }
    historySyncBusy = true;
    try {
      await restoreSettingsFromHost();
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function') {
        const res = await window.contextMeterAPI.getTokenHistory(Boolean(force));
        if (res?.ok && res.data) {
          if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
          applyTokenHistoryPayload(res.data);
        }
      } else if (typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
        const live = window.__AGContextMeterLive;
        const r = await fetch(`http://127.0.0.1:${live.port}/token-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify({ force: Boolean(force) })
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.ok && j.data) {
            if (typeof window !== 'undefined') window.__AGContextMeterHistory = j.data;
            applyTokenHistoryPayload(j.data);
          }
        }
      }
    } catch {}
    finally {
      historySyncBusy = false;
      if (!state.disposed && !state.quotaSynced) {
        state.quotaSynced = true;
        renderModelQuota(true);
      }
      if (pendingHistoryForce) {
        pendingHistoryForce = false;
        void syncTokenHistoryFromHost(true);
      }
    }
  }

  function openGithubRepo(pathSuffix = '') {
    const url = 'https://github.com/cli117/antigravity-hakimi' + pathSuffix;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.openExternal === 'function') {
      window.contextMeterAPI.openExternal(url);
    } else {
      window.open?.(url, '_blank');
    }
  }

  el('btn-github-repo')?.addEventListener('click', () => openGithubRepo());
  el('btn-github-repo-ctx')?.addEventListener('click', () => openGithubRepo());

  /* @INSERT_HEATMAP_MODULE */
  function updateRingAndBubble(d, session, pct, danger, stale, incomplete) {
    const ringFill = el('ring-fill');
    const tipTitle = el('ctx-tip-title');
    const tipPct = el('ctx-tip-pct');
    const tipDetail = el('ctx-tip-detail');

    // 区分常态颜色与高占用告警状态
    let occupancy = 'normal';
    if (danger || (pct != null && pct >= 90)) {
      occupancy = 'danger';
    } else if ((pct != null && pct >= 75) || stale) {
      occupancy = 'warn';
    }
    host.setAttribute('data-occupancy', occupancy);

    // 1. 圆环进度与未知容量状态表达（未知容量绝不画成 0% 或 100%）
    if (ringFill) {
      if (d?.exceeded) {
        ringFill.setAttribute('data-ring-state', 'exceeded');
        ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '1';
      } else if (pct != null) {
        ringFill.setAttribute('data-ring-state', 'determinate');
        if (pct <= 0) {
          ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '0';
        } else {
          const arcLen = Math.max(1.8, (Math.min(100, pct) / 100) * RING_CIRCUMFERENCE);
          ringFill.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '1';
        }
      } else {
        // 容量未知 / 仅估算 / 尚未就绪：使用均匀虚线环段表示非确定比例，不画成 0% 空环或 100% 满环
        ringFill.setAttribute('data-ring-state', d?.estimated ? 'estimated' : 'unknown');
        ringFill.setAttribute('stroke-dasharray', '3.2 4.97');
        ringFill.style.opacity = '0.55';
      }
    }

    // 2. 悬停信息气泡三层文案（标题 — 使用比例 — 用量与容量）
    if (!tipTitle || !tipPct || !tipDetail) return;

    const disp = resolveDisplayStatus(d, session);
    if (disp.isError || disp.kind === 'canceled') {
      tipTitle.textContent = disp.tipTitle;
      tipPct.textContent = disp.tipPct;
      tipDetail.textContent = disp.tipDetail;
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleVal', { used: usedRound, rem: remRound });
      tipDetail.textContent = t('tip.detail.usedOfBudget', { used: fmtBubbleToken(d.actual), budget: fmtBubbleToken(d.budget), inc: '' });
    } else if (stale) {
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleUnknown');
      tipDetail.textContent = session?.total
        ? t('tip.detail.sessionEst', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) })
        : t('tip.detail.waitBg');
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = t('tip.title.high90');
        tipPct.textContent = t('tip.pct.high90', { used: usedRound, rem: remRound });
      } else if (rawPct >= 75) {
        tipTitle.textContent = t('tip.title.high75');
        tipPct.textContent = t('tip.pct.high75', { used: usedRound, rem: remRound });
      } else {
        tipTitle.textContent = t('tip.title.normal');
        tipPct.textContent = t('tip.pct.normal', { used: usedRound, rem: remRound });
      }
      tipDetail.textContent = t('tip.detail.usedOfBudget', {
        used: fmtBubbleToken(d.actual),
        budget: fmtBubbleToken(d.budget),
        inc: incomplete ? t('tip.detail.incSuffix') : ''
      });
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noBudget');
      tipDetail.textContent = t('tip.detail.usedNoBudget', { used: fmtBubbleToken(d.actual) });
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.estOnly');
      const budgetPart = d.budget ? t('tip.detail.estBudgetPart', { budget: fmtBubbleToken(d.budget) }) : t('tip.detail.estNoBudgetPart');
      tipDetail.textContent = t('tip.detail.estUsed', { used: fmtBubbleToken(d.estimate), budget: budgetPart });
    } else if (session?.total) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.waitStats');
      tipDetail.textContent = t('tip.detail.sessionCum', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) });
    } else {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.notReady');
      tipDetail.textContent = t('tip.detail.readingSession');
    }

    if (state.tooltipOpen) positionContextTooltip();
  }

  function getEffectiveCacheMetrics(d) {
    if (!d) return null;
    if (d.cache && typeof d.cache === 'object') return d.cache;
    if (typeof computeCacheMetrics === 'function' && d.input != null && d.input > 0) {
      const cached = Number(d.cached || 0);
      const uncached = d.uncachedInput != null ? Number(d.uncachedInput) : Math.max(0, Number(d.input) - cached);
      return computeCacheMetrics(uncached, cached);
    }
    return null;
  }

  function syncCacheBadgeText() {
    const cacheBadge = el('badge-cache');
    const cacheAmount = el('cache-amount');
    const overflowCacheVal = el('overflow-cache-val');
    if (!cacheAmount) return;
    const isCompact = state.layoutMode === 'compact';
    const cm = state.route ? getEffectiveCacheMetrics(state.latest) : null;
    if (cm) {
      const pctStr = (cm.hitRate > 0 && cm.hitRate < 1) ? '<1' : String(Math.round(cm.hitRate));
      cacheAmount.textContent = isCompact ? `${pctStr}%` : t('badge.cacheWide', { pct: pctStr });
      cacheBadge?.setAttribute('data-cache-state', cm.level || 'good');
      if (cacheBadge) {
        const titleTxt = `${cm.level === 'low' ? t('cache.tip.titleLow', { pct: cm.hitRate.toFixed(1) }) : (cm.level === 'warn' ? t('cache.tip.titleWarn', { pct: cm.hitRate.toFixed(1) }) : t('cache.tip.title', { pct: cm.hitRate.toFixed(1) }))} · ${t('cache.tip.breakdown', { cached: fmtBubbleToken(cm.cachedTokens), uncached: fmtBubbleToken(cm.uncachedTokens), total: fmtBubbleToken(cm.totalInputTokens) })}`;
        cacheBadge.title = titleTxt;
        cacheBadge.setAttribute('aria-label', titleTxt);
      }
      if (overflowCacheVal) {
        overflowCacheVal.textContent = `${cm.hitRate.toFixed(1)}%`;
        overflowCacheVal.className = `overflow-item-val${cm.level === 'low' ? ' is-low' : (cm.level === 'warn' ? ' is-warn' : '')}`;
      }
    } else if (state.route && state.requestBusy) {
      cacheAmount.textContent = isCompact ? '…' : t('badge.cacheCalcWide');
      cacheBadge?.setAttribute('data-cache-state', 'idle');
      if (cacheBadge) {
        cacheBadge.title = t('badge.cacheTitleIdle');
        cacheBadge.setAttribute('aria-label', t('badge.cache.aria'));
      }
      if (overflowCacheVal) {
        overflowCacheVal.textContent = '…';
        overflowCacheVal.className = 'overflow-item-val';
      }
    } else {
      cacheAmount.textContent = isCompact ? '--%' : t('badge.cacheIdleWide');
      cacheBadge?.setAttribute('data-cache-state', 'idle');
      if (cacheBadge) {
        cacheBadge.title = t('badge.cacheTitleIdle');
        cacheBadge.setAttribute('aria-label', t('badge.cache.aria'));
      }
      if (overflowCacheVal) {
        overflowCacheVal.textContent = '--%';
        overflowCacheVal.className = 'overflow-item-val';
      }
    }
    if (activeTopbarTipKind === 'cache' && !isTopbarTipFeedback && el('topbar-action-tooltip')?.getAttribute('data-visible') === 'true') {
      syncTopbarActionTooltipContent('cache');
      positionTopbarActionTooltip(cacheBadge);
    }
  }

  function renderCacheSummarySection(d) {
    const cm = state.route ? getEffectiveCacheMetrics(d) : null;
    const sessCache = state.route && typeof summarizeSessionCache === 'function' ? summarizeSessionCache(state.sessionCalls) : null;
    const summaryEl = el('cache-summary');
    if (summaryEl) {
      summaryEl.setAttribute('data-cache-state', cm ? (cm.level || 'good') : 'idle');
      const cBadge = el('cache-badge');
      const cVal = el('cache-val');
      const cRead = el('cache-read');
      const cFresh = el('cache-fresh');
      const cSess = el('cache-session-rate');
      const cTakeaway = el('cache-takeaway');
      if (cm) {
        const pctFixed = cm.hitRate.toFixed(1);
        if (cBadge) {
          if (cm.level === 'high') { cBadge.textContent = t('cache.pill.high'); cBadge.className = 'key-pill pill-good'; }
          else if (cm.level === 'good') { cBadge.textContent = t('cache.pill.good'); cBadge.className = 'key-pill pill-good'; }
          else if (cm.level === 'cold') { cBadge.textContent = t('cache.pill.cold'); cBadge.className = 'key-pill pill-info'; }
          else if (cm.level === 'warn') { cBadge.textContent = t('cache.pill.warn'); cBadge.className = 'key-pill pill-warn'; }
          else if (cm.level === 'low') { cBadge.textContent = t('cache.pill.low'); cBadge.className = 'key-pill pill-danger'; }
          else { cBadge.textContent = t('cache.pill.idle'); cBadge.className = 'key-pill pill-muted'; }
        }
        if (cVal) cVal.textContent = `${pctFixed}%`;
        if (cRead) cRead.textContent = short(cm.cachedTokens);
        if (cFresh) cFresh.textContent = short(cm.uncachedTokens);
        if (cSess) cSess.textContent = sessCache ? `${sessCache.hitRate.toFixed(1)}%` : `${pctFixed}%`;
        if (cTakeaway) {
          if (cm.level === 'cold') {
            cTakeaway.textContent = t('cache.takeaway.cold', { total: fmt(cm.totalInputTokens), cached: fmt(cm.cachedTokens) });
          } else if (cm.level === 'low') {
            cTakeaway.textContent = t('cache.takeaway.low', { pct: pctFixed, uncached: fmt(cm.uncachedTokens) });
          } else if (cm.level === 'warn') {
            cTakeaway.textContent = t('cache.takeaway.warn', { pct: pctFixed, uncached: fmt(cm.uncachedTokens), cached: fmt(cm.cachedTokens) });
          } else if (cm.level === 'high') {
            cTakeaway.textContent = t('cache.takeaway.high', { pct: pctFixed, total: fmt(cm.totalInputTokens), cached: fmt(cm.cachedTokens), uncached: fmt(cm.uncachedTokens) });
          } else {
            cTakeaway.textContent = t('cache.takeaway.good', { pct: pctFixed, cached: fmt(cm.cachedTokens), uncached: fmt(cm.uncachedTokens) });
          }
        }
      } else {
        if (cBadge) { cBadge.textContent = t('cache.pill.idle'); cBadge.className = 'key-pill pill-muted'; }
        if (cVal) cVal.textContent = '—';
        if (cRead) cRead.textContent = '—';
        if (cFresh) cFresh.textContent = '—';
        if (cSess) cSess.textContent = '—';
        if (cTakeaway) cTakeaway.textContent = t('cache.takeaway.idle');
      }
    }
    const cacheTechEl = el('cache-tech-detail');
    if (cacheTechEl) {
      cacheTechEl.textContent = cm
        ? t('tech.cacheDetail.val', { pct: cm.hitRate.toFixed(1), cached: fmt(cm.cachedTokens), uncached: fmt(cm.uncachedTokens) })
        : '—';
    }
  }

  function syncSpeedBadgeText() {
    const sp = state.latest?.speed;
    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    if (!speedAmount) return;
    const isCompact = state.layoutMode === 'compact';
    if (sp?.tps != null) {
      speedAmount.textContent = isCompact ? `${sp.tps}` : `${sp.tps} tok/s`;
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${sp.tps} tok/s`;
    } else if (state.requestBusy) {
      const calcText = t('badge.speedCalc');
      speedAmount.textContent = isCompact ? '…' : calcText;
      if (overflowSpeedVal) overflowSpeedVal.textContent = calcText;
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  let isQuickCompactBusy = false;
  let isQuickPresetSaving = false;
  let twpFeedbackTimer = null;
  let sessionCardFeedbackTimer = null;

  function resolveQuickContextTarget() {
    const scopeMode = getContextScopeMode();
    if (scopeMode === 'unified') {
      const pref = getContextUnifiedPreference();
      const rp = resolveRuntimeUnlockPolicyClient();
      const effectiveShort = (pref && pref.mode && pref.mode !== 'default')
        ? formatPrefShortPill(pref)
        : (rp?.runtimeMode === 'dynamic' ? t('twp.preset.dynamic') : formatKShort(rp?.currentClientLimitTokens || 256000));
      return {
        scopeMode: 'unified',
        ready: true,
        prod: null,
        pref,
        rawWindowMax: null,
        capSummary: null,
        currentShortLabel: effectiveShort
      };
    }

    const products = getKnownModelProducts();
    const hostSelected = extractHostSelectedModel();
    let prod = null;
    if (hostSelected && hostSelected.productKey) {
      prod = products.find(p => p.productKey === hostSelected.productKey) || {
        productKey: hostSelected.productKey,
        productLabel: hostSelected.label || hostSelected.productKey,
        vendor: hostSelected.vendor || '其他',
        members: []
      };
    } else if (activeSessionModelConfirmed && activeSessionProductKey) {
      prod = products.find(p => p.productKey === activeSessionProductKey) || null;
    }

    if (!prod) {
      return {
        scopeMode: 'per_model',
        ready: false,
        prod: null,
        pref: null,
        rawWindowMax: null,
        capSummary: null,
        currentShortLabel: t('models.summary.unconfirmed')
      };
    }

    const pState = resolveProductPreferenceState(prod);
    const capSummary = getProductCapabilitySummary(prod);
    const rawWindowMax = capSummary?.maxTokens ? Number(capSummary.maxTokens) : (capSummary?.modelTheoreticalMaxTokens ? Number(capSummary.modelTheoreticalMaxTokens) : null);
    const rp = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const pref = pState?.pref || null;
    const effectiveShort = (pref && pref.mode && pref.mode !== 'default')
      ? formatPrefShortPill(pref)
      : (rp?.runtimeMode === 'dynamic' ? t('twp.preset.dynamic') : formatKShort(rp?.currentClientLimitTokens || 256000));
    return {
      scopeMode: 'per_model',
      ready: true,
      prod,
      pState,
      pref,
      capSummary,
      rawWindowMax,
      currentShortLabel: effectiveShort
    };
  }

  function resolvePendingSessionBudgetHint(observedBudget) {
    const obs = Number(observedBudget || 0);
    if (!obs || obs <= 0) return null;
    const target = resolveQuickContextTarget();
    if (!target.ready || !target.pref) return null;
    if (target.pref.mode === 'fixed' && Number(target.pref.limitTokens) > 0) {
      const nextTok = Number(target.pref.limitTokens);
      if (target.capSummary?.maxTokens && nextTok > Number(target.capSummary.maxTokens)) return null;
      if (Math.abs(nextTok - obs) >= 1024) {
        return { nextTokens: nextTok, nextLabel: formatKShort(nextTok) };
      }
    }
    return null;
  }

  function formatKeyLimitDisplay(elLimit, budgetVal) {
    if (!elLimit) return;
    const val = Number(budgetVal || 0);
    if (!val || val <= 0) {
      elLimit.textContent = '—';
      elLimit.title = '';
      return;
    }
    const baseText = short(val);
    const pending = resolvePendingSessionBudgetHint(val);
    if (pending) {
      elLimit.textContent = `${baseText} → ${pending.nextLabel}`;
      elLimit.title = t('key.limitNextTip', { cur: baseText, next: pending.nextLabel });
    } else {
      elLimit.textContent = baseText;
      elLimit.title = '';
    }
  }

  function showQuickContextNote(source, ok, msg, autoHideMs = 0) {
    const targetId = source === 'session_card' ? 'ctx-compact-feedback' : 'twp-status-note';
    const node = el(targetId);
    if (!node) return;
    if (source === 'session_card') {
      if (sessionCardFeedbackTimer) { clearTimeout(sessionCardFeedbackTimer); sessionCardFeedbackTimer = null; }
    } else {
      if (twpFeedbackTimer) { clearTimeout(twpFeedbackTimer); twpFeedbackTimer = null; }
    }
    if (!msg) {
      node.textContent = '';
      node.hidden = true;
      node.className = 'twp-status-note';
      return;
    }
    node.textContent = msg;
    node.className = `twp-status-note ${ok === true ? 'is-success' : (ok === false ? 'is-error' : '')}`.trim();
    node.hidden = false;
    if (autoHideMs > 0) {
      const tid = setTimeout(() => {
        if (source === 'session_card') sessionCardFeedbackTimer = null;
        else twpFeedbackTimer = null;
        if (el(targetId)) el(targetId).hidden = true;
      }, autoHideMs);
      if (source === 'session_card') sessionCardFeedbackTimer = tid;
      else twpFeedbackTimer = tid;
    }
  }

  function syncQuickPresetGrid(gridEl, info) {
    if (!gridEl) return;
    const btns = gridEl.querySelectorAll ? gridEl.querySelectorAll('.twp-preset-btn') : [];
    const rp = info.capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const effectiveMode = (info.pref?.mode && info.pref.mode !== 'default')
      ? info.pref.mode
      : (rp?.runtimeMode === 'dynamic' ? 'dynamic' : 'fixed');
    const effectiveLimit = (info.pref?.mode === 'fixed' && info.pref.limitTokens)
      ? Number(info.pref.limitTokens)
      : (rp?.runtimeMode === 'fixed' && rp.currentClientLimitTokens ? Number(rp.currentClientLimitTokens) : 256000);

    for (const btn of btns) {
      const bMode = btn.getAttribute('data-qctx-mode') || 'fixed';
      const bLimRaw = btn.getAttribute('data-qctx-limit');
      const bLim = bLimRaw ? Number(bLimRaw) : null;
      const exceedsCap = Boolean(
        info.ready &&
        info.scopeMode === 'per_model' &&
        bMode === 'fixed' &&
        bLim &&
        info.rawWindowMax &&
        bLim > info.rawWindowMax
      );
      const disabled = Boolean(isQuickPresetSaving || !info.ready || exceedsCap);
      btn.disabled = disabled;
      const isMatched = Boolean(
        info.ready &&
        !exceedsCap &&
        ((bMode === 'dynamic' && effectiveMode === 'dynamic') ||
          (bMode === 'fixed' && effectiveMode === 'fixed' && bLim === effectiveLimit))
      );
      if (isMatched) addClass(btn, 'is-active');
      else removeClass(btn, 'is-active');
      btn.setAttribute('aria-pressed', String(isMatched));
      btn.title = exceedsCap ? `${fmt(bLim)} > ${fmt(info.rawWindowMax)}` : '';
    }
  }

  function renderQuickContextControls() {
    const btnTopCompact = el('btn-topbar-compact');
    const btnTopWindow = el('btn-topbar-window');
    const prevTopCompactHidden = btnTopCompact ? btnTopCompact.hidden : true;
    const hasSession = Boolean(state.route);

    if (btnTopCompact) {
      btnTopCompact.hidden = !hasSession;
      btnTopCompact.disabled = !hasSession || isQuickCompactBusy;
      btnTopCompact.setAttribute('aria-label', isQuickCompactBusy ? t('session.quick.compactBusy') : t('topbar.quick.compactTitle'));
    }

    const info = resolveQuickContextTarget();
    if (btnTopWindow) {
      btnTopWindow.hidden = false;
      btnTopWindow.disabled = isQuickPresetSaving;
      btnTopWindow.setAttribute('aria-label', t('twp.tipTitle', { cur: info.currentShortLabel || '—' }));
    }

    const scopeLbl = el('twp-scope-label');
    const scopeToggle = el('btn-twp-toggle-scope');
    if (scopeLbl) {
      if (info.scopeMode === 'unified') {
        scopeLbl.textContent = t('twp.scopeUnified');
      } else if (info.ready && info.prod) {
        scopeLbl.textContent = t('twp.scopeModel', { model: info.prod.productLabel });
      } else {
        scopeLbl.textContent = t('twp.scopeModelPending');
      }
      scopeLbl.title = scopeLbl.textContent;
    }
    if (scopeToggle) {
      scopeToggle.textContent = info.scopeMode === 'unified' ? t('twp.switchToPerModel') : t('twp.switchToUnified');
    }

    syncQuickPresetGrid(el('twp-preset-grid'), info);
    syncQuickPresetGrid(el('session-ctx-preset-bar'), info);

    if (!twpFeedbackTimer) {
      if (info.scopeMode === 'per_model' && !info.ready) {
        showQuickContextNote('popover', null, t('twp.unconfirmedHint'));
      } else if (info.pref?.mode === 'fixed' && info.pref.limitTokens && ![512000, 1000000].includes(Number(info.pref.limitTokens))) {
        showQuickContextNote('popover', null, t('twp.customActiveNote', { val: formatKShort(info.pref.limitTokens) }));
      } else {
        showQuickContextNote('popover', null, '');
      }
    }
    if (!sessionCardFeedbackTimer) {
      if (info.scopeMode === 'per_model' && !info.ready) {
        showQuickContextNote('session_card', null, t('twp.unconfirmedHint'));
      } else if (info.pref?.mode === 'fixed' && info.pref.limitTokens && ![512000, 1000000].includes(Number(info.pref.limitTokens))) {
        showQuickContextNote('session_card', null, t('twp.customActiveNote', { val: formatKShort(info.pref.limitTokens) }));
      } else {
        showQuickContextNote('session_card', null, '');
      }
    }

    if (activeTopbarTipKind && !isTopbarTipFeedback) {
      if (activeTopbarTipKind === 'compact' && btnTopCompact?.hidden) {
        hideTopbarActionTooltip(true);
      } else {
        syncTopbarActionTooltipContent(activeTopbarTipKind);
        positionTopbarActionTooltip(activeTopbarTipKind === 'window' ? btnTopWindow : btnTopCompact);
      }
    }

    if (prevTopCompactHidden !== (btnTopCompact ? btnTopCompact.hidden : true)) {
      scheduleLayoutSync();
    }
  }

  async function applyQuickContextPreset(mode, limitTokens = null, opts = {}) {
    const source = opts.source || 'popover';
    if (isQuickPresetSaving) return { ok: false, busy: true };
    const info = resolveQuickContextTarget();
    if (!info.ready) {
      const msg = t('twp.unconfirmedHint');
      showQuickContextNote(source, false, msg, 3500);
      return { ok: false, error: msg };
    }

    const nextMode = mode === 'dynamic' ? 'dynamic' : 'fixed';
    const nextTokens = nextMode === 'fixed' ? Number(limitTokens || 512000) : null;
    const targetLabel = nextMode === 'dynamic' ? t('twp.preset.dynamic') : formatKShort(nextTokens);

    isQuickPresetSaving = true;
    renderQuickContextControls();
    try {
      if (info.scopeMode === 'unified') {
        const nextPref = {
          modelId: 'unified',
          mode: nextMode,
          limitTokens: nextTokens,
          updatedAt: new Date().toISOString()
        };
        const res = await saveSettingsPayloadBridge({
          contextUnifiedPreference: nextPref,
          contextScopeMode: 'unified'
        });
        if (!res || !res.ok) {
          throw new Error(translateBackendText(res?.error) || t('msg.saveFail'));
        }
        contextUnifiedPreference = nextPref;
      } else {
        const prod = info.prod;
        const legacyKeys = resolveProductPreferenceState(prod).legacyKeys;
        const res = await saveSettingsPayloadBridge({
          contextPreference: {
            scope: 'product',
            productKey: prod.productKey,
            modelId: prod.productKey,
            label: prod.productLabel,
            mode: nextMode,
            limitTokens: nextTokens,
            clearLegacyKeys: legacyKeys
          }
        });
        if (!res || !res.ok) {
          throw new Error(translateBackendText(res?.error) || t('msg.saveFail'));
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
            mode: nextMode,
            limitTokens: nextTokens,
            updatedAt: new Date().toISOString()
          };
        }
      }
      syncContextPreferencesCache(contextPreferencesMap);
      if (!ctxDraftDirty) loadDraftFromSelectedModel(true);

      let needsRestart = false;
      const needBackendUnlock = (nextMode === 'dynamic' || (nextTokens && nextTokens > 256000))
        && (!currentUnlockStatus || currentUnlockStatus.status === 'not_patched');
      if (needBackendUnlock) {
        const uRes = await invokeUnlockApi('apply', {
          mode: 'dynamic',
          limitTokens: null,
          serviceLimit: state.latest?.serviceLimit || undefined
        });
        if (!uRes || !uRes.ok) {
          throw new Error(buildFriendlyWriteError(uRes?.error));
        }
        needsRestart = Boolean(uRes.needsRestart);
        if (needsRestart) needsRestartAfterApply = true;
        await refreshUnlockStatus();
      } else {
        renderCompactSessionCard();
        renderClientStatusBar();
      }
      renderHeaderModelDropdown();
      renderModelSettingsTab();
      render();
      const doneMsg = needsRestart
        ? t('twp.savedNeedRestart', { target: targetLabel })
        : t('twp.savedDone', { target: targetLabel });
      showQuickContextNote(source, true, doneMsg, 3200);
      return { ok: true, targetLabel, needsRestart };
    } catch (err) {
      const errMsg = t('twp.saveFail', { err: err?.message || t('msg.unknownErr') });
      showQuickContextNote(source, false, errMsg, 4200);
      return { ok: false, error: errMsg };
    } finally {
      isQuickPresetSaving = false;
      renderQuickContextControls();
    }
  }

  function getHostCsrfToken() {
    try {
      const fromConfig = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
      if (fromConfig && typeof fromConfig === 'string') return fromConfig;
    } catch {}
    try {
      if (state && typeof state.observedCsrfToken === 'string' && state.observedCsrfToken) {
        return state.observedCsrfToken;
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const fromStorage = window.localStorage.getItem('agy_session_csrf_token');
        if (fromStorage && typeof fromStorage === 'string') return fromStorage;
      }
    } catch {}
    return null;
  }

  async function triggerSessionCompact(source = 'topbar') {
    const cascadeId = state.route;
    const csrf = getHostCsrfToken();
    if (!cascadeId || !csrf) {
      const noSessMsg = t('session.quick.compactNoSession');
      if (source === 'topbar') showTopbarTransientFeedback(false, noSessMsg, el('btn-topbar-compact'));
      return { ok: false, error: noSessMsg };
    }
    if (isQuickCompactBusy) return { ok: false, busy: true };
    isQuickCompactBusy = true;
    renderQuickContextControls();
    try {
      let compactInfo = { name: 'compact' };
      try {
        const cmdRes = await fetch('/exa.language_server_pb.LanguageServerService/GetSlashCommands', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf
          },
          body: JSON.stringify({ cascadeId })
        });
        if (cmdRes.ok) {
          const cmdData = await cmdRes.json().catch(() => null);
          const list = cmdData?.commands || cmdData?.slashCommands || [];
          const found = Array.isArray(list)
            ? list.find(c => c?.name === 'compact' || c?.info?.name === 'compact')
            : null;
          if (found) {
            compactInfo = found.info || found;
          }
        }
      } catch {}

      const cachedCtx = lastCascadeConfigByConv.get(cascadeId) || {};
      const sendBody = {
        cascadeId,
        items: [{ item: { slashCommand: { info: compactInfo } } }],
        ...cachedCtx
      };
      const sendRes = await fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        },
        body: JSON.stringify(sendBody)
      });
      if (!sendRes.ok) {
        const errTxt = await sendRes.text().catch(() => '');
        throw new Error(errTxt || `HTTP ${sendRes.status}`);
      }
      const doneMsg = t('session.quick.compactDone');
      if (source === 'topbar') showTopbarTransientFeedback(true, doneMsg, el('btn-topbar-compact'));
      void requestPoll(state.generation, cascadeId);
      void scan(state.generation, cascadeId, true);
      return { ok: true };
    } catch (err) {
      const msg = t('session.quick.compactFail', { err: translateBackendText(err?.message) || err?.message || t('msg.unknownErr') });
      if (source === 'topbar') showTopbarTransientFeedback(false, msg, el('btn-topbar-compact'));
      return { ok: false, error: msg };
    } finally {
      isQuickCompactBusy = false;
      renderQuickContextControls();
    }
  }

  // 渲染上下文与全局状态（无论在主页 / 还是会话页 /c/<id>，始终保持插件栏挂载与可用）
  function render() {
    host.hidden = false;
    host.setAttribute('data-has-session', state.route ? 'true' : 'false');
    ensureHostDocked();
    if (!state.route) {
      hideContextTooltip();
      if (activeTopbarTipKind === 'compact') hideTopbarActionTooltip(true);
      const barFill = el('bar-fill');
      if (barFill) barFill.style.width = '0%';
      const badgePctVal = el('badge-pct-val');
      if (badgePctVal) badgePctVal.textContent = '--%';
      el('amount').textContent = t('badge.noSession');
      setHoverExtra(t('badge.clickOpen'));
      syncSpeedBadgeText();
      syncCacheBadgeText();
      renderCacheSummarySection(null);
      el('badge-tokens').title = t('badge.tokensTitle');
      renderQuickContextControls();
      return;
    }

    const d = state.latest, session = state.scan?.session;
    const disp = resolveDisplayStatus(d, session);
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = disp.isError || d?.exceeded;

    let pct = null;
    if (d?.exceeded) {
      pct = 100;
    } else if (d?.percent != null && !danger && !stale) {
      pct = Math.min(100, Math.max(0, d.percent));
    } else if (d?.actual != null && d?.budget && !danger && !stale) {
      pct = Math.min(100, Math.max(0, (d.actual / d.budget) * 100));
    }

    const barColor = danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff';
    const tone = danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff';
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

    updateRingAndBubble(d, session, pct, danger, stale, incomplete);

    syncContextModelSelectionFromState();

    // 若观测到的上下文预算变化且抽屉已展开或尚未读取状态，触发一次轻量同步（不再据此判定真实请求已验证）
    if (d?.budget && d.budget !== lastAutoObservedBudget && d.budget > 256000) {
      lastAutoObservedBudget = d.budget;
      if (currentUnlockStatus || (unlockDrawerBody && unlockDrawerBody.style.display === 'block')) {
        void refreshUnlockStatus();
      }
    }

    const status = disp.isError
      ? disp.statusText
      : stale ? t('badge.status.stale')
      : state.scanError ? t('badge.status.scanErr', { err: translateBackendText(state.scanError) })
      : incomplete ? t('badge.status.incomplete', { count: session.unknownFiles })
      : d?.estimated ? t('badge.status.estimated')
      : t('badge.status.normal');
    el('status').textContent = status;

    const corpus = session?.total
      ? t('badge.corpus.range', { range: range(session.total), inc: incomplete ? t('badge.corpus.incPlus') : '' })
      : state.scanBusy ? t('badge.corpus.scanning') : t('badge.corpus.pending');

    const badgePctVal = el('badge-pct-val');
    if (disp.isError || disp.kind === 'canceled') {
      el('amount').textContent = disp.amountText;
      if (badgePctVal) badgePctVal.textContent = disp.badgeText;
      setHoverExtra(disp.hoverExtra);
    } else if (stale) {
      el('amount').textContent = t('badge.delayed');
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      el('amount').textContent = `${short(d.actual)}${pctStr}`;
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      el('amount').textContent = t('badge.actualUnknown');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(` · ${corpus}`);
    }

    el('badge-tokens').title = t('badge.tokensTitle');

    // 渲染输出速度 (统一使用 tok/s) 与上下文缓存命中率
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedHoverExtra = el('speed-hover-extra');
    syncSpeedBadgeText();
    syncCacheBadgeText();
    if (speedBadge) {
      if (sp?.tps != null) {
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
        speedBadge.title = t('badge.speedTitleDetail', {
          tps: sp.tps,
          streaming: sp.streamingTps ? t('badge.speedStreamingPart', { tps: sp.streamingTps }) : '',
          duration: sp.duration || '—',
          ttft: sp.ttft || '—',
          streamSec: sp.streamingSec || '—',
          output: fmt(sp.outputTokens)
        });
      } else if (state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = t('badge.speedTitleWait');
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = t('badge.speedHoverIdle');
        speedBadge.title = t('badge.speedTitleIdle');
      }
    }

    if (el('key-summary')) {
      const keyBar = el('key-bar-fill');
      const keyBadge = el('key-badge');
      const keyUsed = el('key-used');
      const keyLimit = el('key-limit');
      const keyRemaining = el('key-remaining');
      const keyTakeaway = el('key-takeaway');

      if (keyBar) keyBar.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

      if (disp.isError || disp.kind === 'canceled') {
        if (keyBadge) {
          keyBadge.textContent = disp.keyBadgeText;
          keyBadge.className = disp.pillClass;
        }

        const usedTokenCount = d?.actual != null ? d.actual : (d?.used != null ? d.used : (d?.estimate != null ? d.estimate : (session?.total?.low ?? null)));
        const budgetTokenCount = d?.budget || (d?.serviceLimit ? d.serviceLimit : 983040);

        if (disp.isOverflow) {
          if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : t('key.overflowUsed');
          formatKeyLimitDisplay(keyLimit, d.serviceLimit || budgetTokenCount);
          if (keyRemaining) keyRemaining.textContent = t('key.overflowRem');
        } else {
          // 非超限错误：保留已有上下文用量，标明其状态，不归零、不清空
          if (keyUsed) {
            keyUsed.textContent = usedTokenCount != null ? (d?.actual != null ? `${short(usedTokenCount)}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}` : t('key.estShort', { val: short(usedTokenCount) })) : '—';
          }
          formatKeyLimitDisplay(keyLimit, budgetTokenCount);
          if (keyRemaining) {
            if (usedTokenCount != null && budgetTokenCount) {
              const rem = Math.max(0, budgetTokenCount - usedTokenCount);
              const remP = Math.max(0, 100 - (pct || ((usedTokenCount / budgetTokenCount) * 100)));
              keyRemaining.textContent = `${short(rem)} (${remP.toFixed(1)}%)`;
            } else {
              keyRemaining.textContent = t('key.pending');
            }
          }
        }
        if (keyTakeaway) keyTakeaway.textContent = disp.keyTakeaway;
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = t('key.pill.tight'); keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = t('key.pill.elevated'); keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = t('key.pill.normal'); keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        formatKeyLimitDisplay(keyLimit, limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.textContent = t('key.takeaway.90', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else if (pct >= 75) {
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else {
            keyTakeaway.textContent = t('key.takeaway.ok', { pct: pct.toFixed(1), rem: short(remainVal) });
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (session?.total ? short(session.total.low) : '—');
        formatKeyLimitDisplay(keyLimit, d?.budget);
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) keyTakeaway.textContent = t('key.takeaway.est');
      }
    }

    renderQuickContextControls();

    if (el('speed-summary')) {
      const spBadge = el('speed-badge');
      const spVal = el('speed-val');
      const spDur = el('speed-duration');
      const spTtft = el('speed-ttft');
      const spTokens = el('speed-tokens');
      const spTakeaway = el('speed-takeaway');

      if (sp?.tps != null) {
        if (spBadge) {
          if (sp.tps >= 80) { spBadge.textContent = t('speed.pill.fast'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 35) { spBadge.textContent = t('speed.pill.smooth'); spBadge.className = 'key-pill pill-good'; }
          else if (sp.tps >= 15) { spBadge.textContent = t('speed.pill.good'); spBadge.className = 'key-pill pill-warn'; }
          else { spBadge.textContent = t('speed.pill.slow'); spBadge.className = 'key-pill pill-danger'; }
        }
        if (spVal) spVal.textContent = `${sp.tps} tok/s`;
        if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
        if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
        if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
        if (spTakeaway) {
          const modelStr = d?.model ? `（${d.model}）` : '';
          const streamInfo = sp.streamingTps ? t('speed.streamPart', { tps: sp.streamingTps }) : '';
          spTakeaway.textContent = t('speed.takeaway.ok', {
            tone: sp.tps >= 35 ? t('speed.tone.smooth') : t('speed.tone.steady'),
            tps: sp.tps,
            stream: streamInfo,
            dur: sp.duration,
            tok: fmt(sp.outputTokens),
            model: modelStr
          });
        }
      } else {
        if (spBadge) { spBadge.textContent = state.requestBusy ? t('speed.pill.calc') : t('speed.pill.idle'); spBadge.className = 'key-pill pill-muted'; }
        if (spVal) spVal.textContent = '—';
        if (spDur) spDur.textContent = '—';
        if (spTtft) spTtft.textContent = '—';
        if (spTokens) spTokens.textContent = '—';
        if (spTakeaway) spTakeaway.textContent = t('speed.takeaway.idle');
      }
    }

    renderCacheSummarySection(d);

    el('model').textContent = d?.model?.startsWith('MODEL_PLACEHOLDER') ? t('tech.modelPlaceholder', { id: d.model }) : d?.model || t('tech.modelMissing');
    el('request-status').textContent = d?.exceeded ? t('tech.req.exceeded') : d?.network ? t('tech.req.network') : d?.error ? t('tech.req.failed') : d?.status === 'reported' ? t('tech.req.reported') : d?.status === 'estimated' ? t('tech.req.estimated') : t('tech.req.waiting');
    el('actual').textContent = d?.actual != null ? token(d.actual) : d?.exceeded ? t('tech.actual.exceeded', { val: fmt(d.serviceLimit || 0) }) : t('tech.actual.unknown');
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = t('tech.actual.exceededNoLim');
    el('estimate').textContent = d?.estimate ? t('tech.est.val', { val: fmt(d.estimate), note: d.exceeded ? t('tech.est.under') : t('tech.est.ref') }) : t('tech.est.none');
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? t('tech.svcLim.val', { val: fmt(d.serviceLimit) }) : t('tech.svcLim.none');
    el('percent').textContent = d?.percent != null && !danger && !stale ? t('tech.pct.val', { pct: d.percent.toFixed(1) }) : t('tech.pct.none');
    el('session-total').textContent = session?.total ? range(session.total) + (incomplete ? t('tech.plusUnknown') : '') : state.scanError ? t('tech.scanIncomplete') : t('tech.scanning');
    el('characters').textContent = session?.total ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session?.groups ? range(session.groups[name]) : '—';
    el('system').textContent = session?.groups ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session?.attachmentTotal ? range(session.attachmentTotal) + (incomplete ? t('tech.plusUnknownShort') : '') : '—';
    el('steps').textContent = session?.steps != null ? t('tech.stepsVal', { steps: fmt(session.steps), user: session.userMessages, assistant: session.assistantMessages }) : t('tech.stepsNone');
    el('coverage').textContent = Array.isArray(session?.attachments)
      ? t('tech.coverageVal', {
          total: session.attachments.length,
          user: session.attachments.filter(f => f.source === 'user').length,
          assistant: session.attachments.filter(f => f.source === 'assistant').length,
          read: session.attachments.filter(f => f.chars > 0).length,
          unknown: session.unknownFiles,
          rescan: state.scanBusy ? t('tech.coverageRescan') : '',
          err: state.scanError ? t('tech.coverageErr', { err: translateBackendText(state.scanError) }) : ''
        })
      : (state.scanError ? translateBackendText(state.scanError) : t('tech.coverageScanning'));
    el('updated').textContent = t('tech.updatedVal', {
      req: state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : t('tech.unread'),
      scan: state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : t('tech.unfinished')
    });
    el('refresh').disabled = state.scanBusy;
  }

  async function requestPoll(generation, id) {
    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = getHostCsrfToken(); if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      const parsedCalls = [];
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          state.sessionCallsMap.set(call.callId, call);
          parsedCalls.push(call);
        }
      }
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      if (parsedCalls.length) {
        if (!state.reportedFinalCallIds) state.reportedFinalCallIds = new Set();
        if (!state.reportedFinalCallOutputs) state.reportedFinalCallOutputs = new Map();
        const callsToReport = [];
        for (const call of parsedCalls) {
          if (call && call.status === 'final' && call.callId) {
            const lastOutput = state.reportedFinalCallOutputs.get(call.callId);
            const currentOutput = call.outputTokens || 0;
            if (!state.reportedFinalCallIds.has(call.callId) || (lastOutput != null && currentOutput > lastOutput)) {
              callsToReport.push(call);
            }
          }
        }
        if (callsToReport.length) {
          for (const call of callsToReport) {
            state.reportedFinalCallIds.add(call.callId);
            state.reportedFinalCallOutputs.set(call.callId, call.outputTokens || 0);
          }
          void recordModelCallsRemote(callsToReport);
        }
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const value = summarize(rows[i], {
          cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
          turnCount: offset + i + 1
        });
        if (value) {
          state.latest = withStepError(value, rows[i]);
          const callInfo = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
          recordObservationFromSummary(state.latest, id, {
            callId: callInfo?.callId || null,
            stepCount: state.count,
            ts: Date.now()
          });
          break;
        }
      }
      state.requestAt = Date.now(); state.requestError = '';
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally { clearTimeout(timeout); state.controllers.delete(controller); if (generation === state.generation && !state.disposed) { state.requestBusy = false; state.requestNext = Date.now() + (document.hidden ? 15000 : 3000); render(); } }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      if (window.contextMeterAPI?.scan) result = await window.contextMeterAPI.scan(id, force);
      else if (window.__AGContextMeterLive) {
        const live = window.__AGContextMeterLive, controller = new AbortController(); state.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 180000);
        try { const response = await fetch(`http://127.0.0.1:${live.port}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token }, body: JSON.stringify({ id, force }), signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); result = await response.json(); }
        finally { clearTimeout(timeout); state.controllers.delete(controller); }
      } else throw new Error('完整重启 Antigravity 后启用附件扫描');
      if (generation !== state.generation || state.disposed) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.modelCapabilitiesById && typeof result.data.modelCapabilitiesById === 'object') {
        mergeCapabilitiesMapClient(result.data.modelCapabilitiesById);
      }
      if (Array.isArray(result.data.cascadeModelConfigs) && result.data.cascadeModelConfigs.length) {
        state.cascadeModelConfigs = result.data.cascadeModelConfigs;
      }
      if (result.data.scannedAt >= state.requestAt && result.data.latest) {
        state.latest = result.data.latest;
        state.requestAt = result.data.scannedAt;
        const genSteps = Number(result.data.generatorCount);
        const msgSteps = Number(result.data.session?.userMessages || 0) + Number(result.data.session?.assistantMessages || 0);
        const resolvedStepCount = Number.isFinite(genSteps) && genSteps >= 0 ? genSteps : (msgSteps > 0 ? msgSteps : state.count);
        recordObservationFromSummary(state.latest, id, {
          callId: result.data.latestCallId || null,
          stepCount: resolvedStepCount,
          ts: Number(result.data.scannedAt || Date.now())
        });
      }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastHistorySync = 0;
  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = getHostCsrfToken();
    if (!csrf) return;
    if (Date.now() - lastAvailableModelsSync < 300000 && state.modelCapabilitiesById && Object.keys(state.modelCapabilitiesById).length > 0) {
      return;
    }
    availableModelsFetchInFlight = true;
    try {
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ forceRefresh: false })
      });
      if (!response.ok) return;
      const data = await response.json();
      const modelsObj = data?.response?.models || data?.models;
      if (!modelsObj || typeof modelsObj !== 'object') return;
      const entries = Array.isArray(modelsObj)
        ? modelsObj.map(item => [item?.model || item?.modelId || '', item])
        : Object.entries(modelsObj);
      const nextCaps = {};
      for (const [entryKey, d] of entries) {
        if (!d || typeof d !== 'object') continue;
        const rawId = String(d.model || d.modelId || entryKey || '').trim();
        if (!rawId) continue;
        const normKey = rawId.toLowerCase().replace(/^model_/, '');
        const maxTokens = Number.isSafeInteger(Number(d.maxTokens)) && Number(d.maxTokens) > 0 ? Number(d.maxTokens) : null;
        const maxOutputTokens = d.maxOutputTokens != null && Number.isSafeInteger(Number(d.maxOutputTokens)) && Number(d.maxOutputTokens) >= 0
          ? Number(d.maxOutputTokens)
          : null;
        const rec = {
          modelId: rawId,
          displayName: d.displayName || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget: d.thinkingBudget ?? null,
          minThinkingBudget: d.minThinkingBudget ?? null,
          thinkingLevel: d.thinkingLevel || null,
          supportsModelInfoOverride: typeof d.supportsModelInfoOverride === 'boolean' ? d.supportsModelInfoOverride : null,
          capabilitySource: 'get_available_models'
        };
        if (normKey) nextCaps[normKey] = rec;
        if (entryKey) nextCaps[String(entryKey).trim().toLowerCase().replace(/^model_/, '')] = rec;
      }
      if (Object.keys(nextCaps).length > 0) {
        mergeCapabilitiesMapClient(nextCaps);
        lastAvailableModelsSync = Date.now();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
          renderPresetSelectionUI();
        }
      }
    } catch {}
    finally {
      availableModelsFetchInFlight = false;
    }
  }

  function tick() {
    if (!state.disposed && !host.isConnected) {
      ensureHostDocked();
    }
    if (typeof document === 'undefined' || !document.hidden) {
      renderModelQuota();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.reportedFinalCallIds) state.reportedFinalCallIds.clear();
      if (state.reportedFinalCallOutputs) state.reportedFinalCallOutputs.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [],
        requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        reportedFinalCallIds: state.reportedFinalCallIds || new Set(),
        reportedFinalCallOutputs: state.reportedFinalCallOutputs || new Map()
      });
      closeTopbarWindowPopover();
      toggle(false); hideContextTooltip(); hideTopbarActionTooltip(true); renderFiles(null); render();
      void syncTokenHistoryFromHost(false);
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
  }

  const timer = setInterval(tick, 500);
  globalThis.__AGContextMeter = {
    version: typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.3',
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch {}; applyTheme(); },
    getCustomColors: () => ({ ...customColors }),
    setCustomColor,
    resetCustomColors,
    resetHeatmapLevels,
    getHeatPreset: () => heatPreset,
    setHeatPreset,
    getHeatPalette: () => getEffectiveHeatmapScale(),
    getActivePickerSlot: () => activePickerSlot,
    openColorPicker,
    closeColorPicker,
    applyTokenHistoryPayload,
    applyPickerHex,
    setTokenHistoryForTest: payload => applyTokenHistoryPayload(payload),
    getPlanDetailExpanded: () => planDetailExpanded,
    setPlanDetailExpanded,
    switchHeatView: view => switchHeatView(view),
    getActiveHeatView: () => activeHeatView,
    renderHeatmapMonthly: () => renderHeatmapMonthly(),
    renderHeatmapYearly: () => renderHeatmapYearly(),
    openGithubRepo: path => openGithubRepo(path),
    updateHeatTabThumb: () => updateHeatTabThumb(),
    restoreSettingsFromHost,
    getTimelineWindow: () => {
      const w = computeTimelineWindow();
      return {
        firstUseDate: w.firstStr,
        winStart: formatLocalYmd(w.winStart),
        winEnd: formatLocalYmd(w.winEnd),
        totalDays: w.totalDays,
        canPrev: w.canPrev,
        canNext: w.canNext
      };
    },
    repositionPanelsForTest: () => positionFloatingPanels(),
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => {
      const next = computeNextLayoutMode(width, state.layoutMode);
      applyLayoutMode(next);
      return state.layoutMode;
    },
    findTopRightClusterForTest: () => findTopRightCluster(),
    syncWindowControlsOverlayForTest: () => syncWindowControlsOverlay(),
    computeWindowControlsWidthForTest: el => computeWindowControlsWidth(el),
    getContextPreferencesState: () => ({
      activeSessionModelKey,
      activeSessionProductKey,
      selectedEditModelKey,
      selectedProductKey,
      activeContextTab,
      isContextSettingsView,
      draft: { ...ctxDraft },
      contextPreferences: { ...contextPreferencesMap },
      unlockStatus: currentUnlockStatus ? { ...currentUnlockStatus } : null,
      pendingRestartVerification: pendingRestartVerification ? { ...pendingRestartVerification } : null,
      needsRestartAfterApply
    }),
    setContextLatestForTest: (latestObj, configs = [], capabilitiesById = null) => {
      if (capabilitiesById && typeof capabilitiesById === 'object') mergeCapabilitiesMapClient(capabilitiesById);
      if (Array.isArray(configs) && configs.length) state.cascadeModelConfigs = configs;
      state.latest = latestObj;
      if (latestObj && (state.route || state.activeConversationId)) {
        recordObservationFromSummary(latestObj, state.route || state.activeConversationId, { ts: latestObj.ts || Date.now() });
      }
      manualModelSelection = false;
      render();
      return { activeSessionModelKey, activeSessionProductKey, selectedEditModelKey, selectedProductKey, draft: { ...ctxDraft } };
    },
    setModelCapabilitiesForTest: (capabilitiesById) => {
      mergeCapabilitiesMapClient(capabilitiesById);
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getBudgetTrackerTracesForTest: () => (budgetTracker && typeof budgetTracker.exportDiagnosticTraces === 'function')
      ? budgetTracker.exportDiagnosticTraces()
      : [],
    switchContextTabForTest: (tab) => switchContextTab(tab),
    openContextSettingsForTest: (opts) => openContextSettings(opts),
    setSpeedRecordsForTest: (records, calls = []) => {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = Array.isArray(records) ? records : [];
      if (Array.isArray(calls)) state.sessionCalls = calls;
      if (!isContextSettingsView && activeContextTab === 'speed') renderSpeedComparisonTab();
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    setRestartVerificationForTest: (ver, preSnapshot = null) => {
      pendingRestartVerification = ver ? { ...ver } : null;
      if (preSnapshot) preRestartSnapshot = preSnapshot;
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getKnownModelProductsForTest: () => getKnownModelProducts(),
    refreshUnlockStatusForTest: () => refreshUnlockStatus(),
    refreshCliUnlockForTest: () => refreshCliUnlockDisplay(),
    refreshModulesForTest: () => refreshModulesDisplay(),
    resolveQuickContextTargetForTest: () => resolveQuickContextTarget(),
    applyQuickContextPresetForTest: (mode, lim, opts) => applyQuickContextPreset(mode, lim, opts),
    triggerSessionCompactForTest: (src) => triggerSessionCompact(src),
    refreshEnhanceStatusForTest: () => refreshEnhanceStatus(),
    getEnhanceStateForTest: () => ({
      currentBrandTitle,
      hasPendingLsReload,
      currentEnhanceStatus: currentEnhanceStatus ? { ...currentEnhanceStatus } : null
    }),
    getUnlockUiStateForTest: () => ({
      hostSupportsRestart,
      needsRestartAfterApply,
      resultBoxDisplay: unlockResultBox?.style?.display || '',
      resultRestartHidden: btnUnlockResultRestart ? btnUnlockResultRestart.hidden : null,
      resultRetryHidden: btnUnlockResultRetry ? btnUnlockResultRetry.hidden : null,
      resultManualHidden: unlockResultManual ? unlockResultManual.hidden : null,
      headerRestartHidden: btnRestartHost ? btnRestartHost.hidden : null
    }),
    getContextScopeModeForTest: () => getContextScopeMode(),
    setContextScopeModeForTest: mode => setScopeMode(mode),
    getContextUnifiedPreferenceForTest: () => getContextUnifiedPreference(),
    getPanelLanguage: () => getPanelLanguage(),
    setPanelLanguage: (lang, opts) => applyPanelLanguage(lang, opts),
    renderModelQuotaForTest: (force = true) => renderModelQuota(force),
    toggleModelQuota5hForTest: () => toggleModelQuota5hState(),
    setModelQuotaMinimizedForTest: (val) => setModelQuotaMinimizedState(val),
    getModelQuotaStateForTest: () => getModelQuotaStateSnapshot(),
    restoreSettingsForTest: () => restoreSettingsFromHost(),
    translateForTest: (key, vars) => t(key, vars),
    applyStaticTranslationsForTest: (rootNode) => applyStaticPanelTranslations(rootNode),
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls }),
    dispose() {
      state.disposed = true;
      for (const controller of state.controllers) controller.abort();
      clearInterval(timer);
      if (topbarTipFeedbackTimer) {
        clearTimeout(topbarTipFeedbackTimer);
        topbarTipFeedbackTimer = null;
      }
      if (twpFeedbackTimer) {
        clearTimeout(twpFeedbackTimer);
        twpFeedbackTimer = null;
      }
      if (sessionCardFeedbackTimer) {
        clearTimeout(sessionCardFeedbackTimer);
        sessionCardFeedbackTimer = null;
      }
      if (layoutRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf);
      syncHostStackingElevation(false);
      try { uninstallRequestInterceptor(); } catch {}
      try { themeObserver?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { hostDomObserver?.disconnect(); } catch {}
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        window.removeEventListener?.('mousemove', onPointerMove);
        window.removeEventListener?.('mouseup', onPointerUp);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      } catch {}
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch {}
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch {}
      disposeModelQuota();
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  applyStaticPanelTranslations(quotaShadow);
  renderEnhanceSectionUI();
  void restoreSettingsFromHost();
  installRequestInterceptor();
  render();
  tick();
})();

