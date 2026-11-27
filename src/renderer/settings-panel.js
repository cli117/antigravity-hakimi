  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 模块 1.5: 插件面板语言 (Context Meter) 与客户端语言 (Antigravity)
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');
  const btnClientLangZhCn = el('btn-client-lang-zh-CN');
  const btnClientLangEn = el('btn-client-lang-en');

  function syncPanelLanguageButtons(lang) {
    const normalized = normalizePanelLanguage(lang);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  function syncClientLanguageButtons() {
    if (btnClientLangZhCn) {
      if (currentChineseEnabled) addClass(btnClientLangZhCn, 'active');
      else removeClass(btnClientLangZhCn, 'active');
      btnClientLangZhCn.setAttribute?.('aria-pressed', String(currentChineseEnabled));
    }
    if (btnClientLangEn) {
      if (!currentChineseEnabled) addClass(btnClientLangEn, 'active');
      else removeClass(btnClientLangEn, 'active');
      btnClientLangEn.setAttribute?.('aria-pressed', String(!currentChineseEnabled));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch {}
    try { if (typeof applyTheme === 'function') applyTheme(); } catch {}
    try { renderVersionSyncBanner(); } catch {}
    try { renderSshRemoteContextBanners(); } catch {}
    try { render(); } catch {}
    try { renderSpeedComparisonTab(); } catch {}
    try { renderCliUnlockState(currentCliUnlockStatus); } catch {}
    try { renderHakimiUpgradeState(currentHakimiUpgradeState); } catch {}
    try { renderHakimiIconState(currentHakimiIconState); } catch {}
    try { if (typeof syncMessageForkButtons === 'function') syncMessageForkButtons(); } catch {}
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      }
    } catch {}
    try {
      if (isChineseExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView) {
        void refreshCliUnlockDisplay();
        void refreshHakimiUpgradeStatus();
        void refreshHakimiIconStatus();
        if (typeof refreshAccountsStatus === 'function') void refreshAccountsStatus({ silent: true });
      }
    } catch {}
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
      }
    } catch {}
    try {
      if (typeof quotaShadow !== 'undefined' && quotaShadow) {
        applyStaticPanelTranslations(quotaShadow);
      }
      if (typeof shortcutsShadow !== 'undefined' && shortcutsShadow) {
        applyStaticPanelTranslations(shortcutsShadow);
      }
      if (typeof accountsShadow !== 'undefined' && accountsShadow) {
        applyStaticPanelTranslations(accountsShadow);
      }
      if (typeof renderModelQuota === 'function') {
        renderModelQuota(true);
      }
      if (typeof renderAccountsUI === 'function') {
        renderAccountsUI();
      }
      if (typeof renderModelShortcutsPopover === 'function' && typeof shortcutsPopoverOpen !== 'undefined' && shortcutsPopoverOpen) {
        renderModelShortcutsPopover();
      }
    } catch {}

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch {}
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  // 模块 2: 客户端界面汉化 (AntigravityChinese)
  // -------------------------------------------------------------
  const btnToggleChinese = el('btn-toggle-chinese');
  const chineseDrawerBody = el('chinese-drawer-body');
  const chineseDrawerArrow = el('chinese-drawer-arrow');
  const chineseBadge = el('chinese-badge');
  const chineseStatusDesc = el('chinese-status-desc');
  const btnToggleChineseModule = el('btn-toggle-chinese-module');

  let isChineseExpanded = false;
  let currentChineseEnabled = false;

  btnToggleChinese?.addEventListener('click', () => {
    isChineseExpanded = !isChineseExpanded;
    if (chineseDrawerBody) chineseDrawerBody.style.display = isChineseExpanded ? 'block' : 'none';
    if (chineseDrawerArrow) chineseDrawerArrow.textContent = isChineseExpanded ? t('drawer.collapse') : t('drawer.expand');
    btnToggleChinese?.setAttribute('aria-expanded', String(isChineseExpanded));
    if (isChineseExpanded) {
      void refreshModulesDisplay();
    }
  });

  const btnClientLangRestart = el('btn-client-lang-restart');
  const clientLangResultBox = el('client-lang-result');
  const clientLangResultText = el('client-lang-result-text');

  function showClientLangResult(ok, message) {
    if (!clientLangResultBox || !clientLangResultText) return;
    clientLangResultBox.style.display = 'block';
    clientLangResultBox.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    clientLangResultText.textContent = message;
  }

  btnClientLangRestart?.addEventListener('click', openClientRestartConfirmFlow);

  let lastVersionSyncState = null;

  function renderVersionSyncBanner(vs = lastVersionSyncState) {
    const banner = el('version-sync-banner');
    const textEl = el('version-sync-text');
    if (!banner || !textEl) return;
    if (vs && vs.outdated && !vs.hakimiAhead && vs.officialVersion && vs.hakimiVersion) {
      textEl.textContent = t('versionSync.mismatch', {
        officialVer: vs.officialVersion,
        hakimiVer: vs.hakimiVersion
      });
      banner.hidden = false;
    } else {
      textEl.textContent = '';
      banner.hidden = true;
    }
  }

  async function refreshModulesDisplay() {
    try {
      const res = await invokeModulesApi('status');
      if (!res || !res.ok || !res.data) {
        const errMsg = (res && res.error) ? translateBackendText(res.error) : t('msg.unknownErr');
        if (chineseBadge) {
          chineseBadge.textContent = t('mod.readFail');
          chineseBadge.className = 'key-pill pill-danger';
        }
        if (chineseStatusDesc) {
          chineseStatusDesc.textContent = t('mod.zh.failDetect', { err: errMsg });
        }
        return;
      }
      lastVersionSyncState = res.versionSync || null;
      renderVersionSyncBanner(lastVersionSyncState);
      const cfg = res.data;

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      // 判定宿主界面是否已翻译：定向检查系统导航、活动栏、菜单及操作按钮等固有系统壳层（排除用户消息内容区域）
      const isDomTranslated = (() => {
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const systemContainers = document.querySelectorAll(
            "div[role='navigation'], nav, header, [role='banner'], aside, [data-testid*='sidebar'], [data-testid*='navigation'], [class*='@container/titlebar'], .monaco-workbench, .activitybar"
          );
          const systemKeywords = ['新建对话', '新建会话', '新建', '设置', '账户', '项目', '关于', '帮助', '工作区', '管理', '自定义扩展', '资源管理器', '活动栏'];
          for (let i = 0; i < systemContainers.length; i++) {
            const container = systemContainers[i];
            if (container.closest && container.closest('.chat-session, .conversation-view, .monaco-list-row, .markdown, [data-testid*="chat"], [data-testid*="message"]')) {
              continue; // 严格排除用户聊天内容区
            }
            const labeledNodes = container.querySelectorAll ? container.querySelectorAll('button, a, [role="button"], [aria-label], [title], span') : [];
            for (let j = 0; j < Math.min(labeledNodes.length, 40); j++) {
              const node = labeledNodes[j];
              const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
              if (label && systemKeywords.some(kw => label.includes(kw))) return true;
              const text = (node.textContent || '').trim();
              if (text && systemKeywords.some(kw => text.includes(kw))) return true;
            }
            const txt = container.innerText || '';
            if (systemKeywords.some(kw => txt.includes(kw))) return true;
          }
          const nav = document.querySelector("div[role='navigation'], nav");
          if (nav && nav.innerText && systemKeywords.some(kw => nav.innerText.includes(kw))) {
            return true;
          }
        } catch {}
        return false;
      })();
      const disk = res.disk || {};

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = disk.chinese ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!disk.chinese) {
          chineseBadge.textContent = t('mod.zh.badgeNotInjected');
          chineseBadge.className = 'key-pill pill-danger';
        } else {
          chineseBadge.textContent = t('mod.zh.badgePendingRestart');
          chineseBadge.className = 'key-pill pill-warn';
        }
      }
      if (chineseStatusDesc) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseStatusDesc.textContent = t('mod.zh.descRestartEn');
          } else {
            chineseStatusDesc.textContent = disk.chinese
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!disk.chinese) {
          chineseStatusDesc.textContent = t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (chineseBadge) {
        chineseBadge.textContent = t('mod.readErr');
        chineseBadge.className = 'key-pill pill-danger';
      }
      if (chineseStatusDesc) {
        chineseStatusDesc.textContent = t('mod.zh.errDetect', { err: errMsg });
      }
    }
  }

  async function setClientLanguageTarget(wantChinese) {
    if (Boolean(wantChinese) === Boolean(currentChineseEnabled)) return;
    if (btnToggleChineseModule) {
      btnToggleChineseModule.disabled = true;
      btnToggleChineseModule.textContent = t('mod.processing');
    }
    try {
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en'
      });
      if (!res || !res.ok) {
        showClientLangResult(false, translateBackendText(res?.error) || t('mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = true;
        if (btnClientLangRestart) btnClientLangRestart.hidden = false;
        showClientLangResult(true, t('msg.appliedRestart'));
      }
      await refreshModulesDisplay();
    } catch (e) {
      showClientLangResult(false, `${t('mod.zh.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleChineseModule) {
        btnToggleChineseModule.disabled = false;
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
    }
  }

  btnClientLangZhCn?.addEventListener('click', () => {
    void setClientLanguageTarget(true);
  });
  btnClientLangEn?.addEventListener('click', () => {
    void setClientLanguageTarget(false);
  });

  btnToggleChineseModule?.addEventListener('click', () => {
    void setClientLanguageTarget(!currentChineseEnabled);
  });

  const cliUnlockBadge = el('cli-unlock-badge');
  const cliUnlockMeta = el('cli-unlock-meta');
  const btnCliUnlockApply = el('btn-cli-unlock-apply');
  const btnCliUnlockRefresh = el('btn-cli-unlock-refresh');
  const cliUnlockResultBox = el('cli-unlock-result');
  const cliUnlockResultText = el('cli-unlock-result-text');

  let currentCliUnlockStatus = null;
  let isCliUnlockBusy = false;

  async function invokeCliUnlockApi(action, opts = {}) {
    if (action === 'status' && window.contextMeterAPI?.getCliUnlockStatus) {
      return await window.contextMeterAPI.getCliUnlockStatus(opts);
    }
    if (action === 'apply' && window.contextMeterAPI?.applyCliUnlock) {
      return await window.contextMeterAPI.applyCliUnlock(opts);
    }
    return { ok: false, error: t('models.err.noApplyBridge'), unavailable: true };
  }

  function renderCliUnlockState(res = currentCliUnlockStatus) {
    if (!cliUnlockBadge || !cliUnlockMeta) return;
    if (!res || !res.ok || !res.data) {
      cliUnlockBadge.textContent = t('status.badge.unavailable');
      cliUnlockBadge.className = 'key-pill pill-muted';
      cliUnlockMeta.textContent = res?.error ? translateBackendText(res.error) : '—';
      if (btnCliUnlockApply) btnCliUnlockApply.disabled = true;
      return;
    }

    const d = res.data;
    const region = d.regionUnlock && d.regionUnlock.status && d.regionUnlock.status !== 'missing'
      ? d.regionUnlock
      : null;
    const patchedCount = region && region.status === 'patched' ? 1 : 0;
    const totalCount = region ? 1 : 0;

    if (d.status === 'patched') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.patched', { ok: patchedCount || 1, total: totalCount || 1 });
      cliUnlockBadge.className = 'key-pill pill-ok';
    } else if (d.status === 'partial') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.partial');
      cliUnlockBadge.className = 'key-pill pill-warn';
    } else if (d.status === 'not_found') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.notFound');
      cliUnlockBadge.className = 'key-pill pill-muted';
    } else if (d.status === 'unsupported') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.unsupported');
      cliUnlockBadge.className = 'key-pill pill-danger';
    } else {
      cliUnlockBadge.textContent = t('settings.cliUnlock.unpatched');
      cliUnlockBadge.className = 'key-pill pill-muted';
    }

    const metaParts = [];
    if (d.realPath || d.binaryPath) {
      metaParts.push(t('settings.cliUnlock.metaPath', { path: d.realPath || d.binaryPath }));
    } else if (d.message) {
      metaParts.push(translateBackendText(d.message));
    }
    if (Array.isArray(d.brokenSymlinks) && d.brokenSymlinks.length > 0) {
      metaParts.push(t('settings.cliUnlock.brokenLinks', {
        paths: d.brokenSymlinks.map(s => s.path).join(', ')
      }));
    }
    cliUnlockMeta.textContent = metaParts.join(' · ') || '—';

    if (btnCliUnlockApply) {
      const blocked = d.status === 'not_found' || d.status === 'unsupported' || d.status === 'partial';
      btnCliUnlockApply.disabled = isCliUnlockBusy || blocked;
      btnCliUnlockApply.textContent = isCliUnlockBusy ? t('settings.cliUnlock.busy') : t('settings.cliUnlock.applyBtn');
    }
  }

  async function refreshCliUnlockDisplay(opts = {}) {
    try {
      const res = await invokeCliUnlockApi('status', opts);
      currentCliUnlockStatus = res;
      renderCliUnlockState(res);
      return res;
    } catch (err) {
      const fallback = { ok: false, error: err?.message || t('msg.unknownErr') };
      currentCliUnlockStatus = fallback;
      renderCliUnlockState(fallback);
      return fallback;
    }
  }

  btnCliUnlockRefresh?.addEventListener('click', () => {
    void refreshCliUnlockDisplay();
  });

  btnCliUnlockApply?.addEventListener('click', async () => {
    if (isCliUnlockBusy) return;
    isCliUnlockBusy = true;
    renderCliUnlockState(currentCliUnlockStatus);
    if (cliUnlockResultBox) cliUnlockResultBox.style.display = 'none';
    try {
      const res = await invokeCliUnlockApi('apply', {});
      if (!res || !res.ok) {
        if (cliUnlockResultBox && cliUnlockResultText) {
          cliUnlockResultBox.className = 'unlock-result-box result-error';
          cliUnlockResultBox.style.display = 'block';
          cliUnlockResultText.textContent = buildFriendlyWriteError(res?.error);
        }
      } else {
        if (cliUnlockResultBox && cliUnlockResultText) {
          cliUnlockResultBox.className = 'unlock-result-box result-success';
          cliUnlockResultBox.style.display = 'block';
          cliUnlockResultText.textContent = res.message || t('msg.applied');
        }
      }
      await refreshCliUnlockDisplay();
    } catch (err) {
      if (cliUnlockResultBox && cliUnlockResultText) {
        cliUnlockResultBox.className = 'unlock-result-box result-error';
        cliUnlockResultBox.style.display = 'block';
        cliUnlockResultText.textContent = buildFriendlyWriteError(err?.message);
      }
    } finally {
      isCliUnlockBusy = false;
      renderCliUnlockState(currentCliUnlockStatus);
    }
  });

  // -------------------------------------------------------------
  // 模块 2.5: 哈基米双源自更新（官方反重力 + GitHub main）
  // -------------------------------------------------------------
  const btnTopbarUpgrade = el('btn-topbar-upgrade');
  const hakimiUpgradeCard = el('hakimi-upgrade-card');
  const hakimiUpgradeBadge = el('hakimi-upgrade-badge');
  const hakimiUpgradeMeta = el('hakimi-upgrade-meta');
  const hakimiUpgradeDiag = el('hakimi-upgrade-diag');
  const hakimiUpgradeDiagTitle = el('hakimi-upgrade-diag-title');
  const hakimiUpgradeDiagBody = el('hakimi-upgrade-diag-body');
  const btnHakimiUpgradeInstall = el('btn-hakimi-upgrade-install');
  const btnHakimiUpgradeSync = el('btn-hakimi-upgrade-sync');
  const btnHakimiUpgradeForceMain = el('btn-hakimi-upgrade-force-main');
  const btnHakimiUpgradeCopyDiag = el('btn-hakimi-upgrade-copy-diag');
  const hakimiUpgradeResultBox = el('hakimi-upgrade-result');
  const hakimiUpgradeResultText = el('hakimi-upgrade-result-text');
  const hakimiUpgradeModal = el('hakimi-upgrade-modal');
  const modalUpgradeBody = el('modal-upgrade-body');
  const modalUpgradeFeedback = el('modal-upgrade-feedback');
  const btnModalUpgradeCancel = el('btn-modal-upgrade-cancel');
  const btnModalUpgradeConfirm = el('btn-modal-upgrade-confirm');

  let currentHakimiUpgradeState = null;
  let isHakimiUpgradeSyncBusy = false;
  let isHakimiUpgradeInstallBusy = false;
  let unsubscribeHakimiUpgradeChanged = null;

  function formatHakimiUpgradeSummary(st = currentHakimiUpgradeState) {
    const staged = st?.staged;
    if (!staged) return t('upgrade.topbarTipFallback');
    const agFrom = st?.installed?.antigravityVersion || '?';
    const agTo = staged.targetAntigravityVersion || agFrom;
    const cFrom = st?.installed?.hakimiCommitShort || 'local';
    const cTo = staged.targetHakimiCommitShort || (staged.targetHakimiCommit ? staged.targetHakimiCommit.slice(0, 7) : 'latest');
    if (staged.antigravityChanged && staged.hakimiChanged) {
      return t('upgrade.readySummary.both', { agFrom, agTo, cFrom, cTo });
    }
    if (staged.antigravityChanged) {
      return t('upgrade.readySummary.agOnly', { agFrom, agTo });
    }
    return t('upgrade.readySummary.hakimiOnly', { cFrom, cTo, agTo });
  }

  function showHakimiUpgradeResult(ok, msg) {
    if (!hakimiUpgradeResultBox || !hakimiUpgradeResultText) return;
    if (!msg) {
      hakimiUpgradeResultBox.style.display = 'none';
      return;
    }
    hakimiUpgradeResultBox.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    hakimiUpgradeResultBox.style.display = 'block';
    hakimiUpgradeResultText.textContent = msg;
  }

  function renderHakimiUpgradeState(st = currentHakimiUpgradeState) {
    const isRemote = Boolean(typeof getRemoteSshMeta === 'function' && getRemoteSshMeta());
    const prevTopbarHidden = btnTopbarUpgrade ? btnTopbarUpgrade.hidden : true;

    if (isRemote) {
      if (hakimiUpgradeCard) hakimiUpgradeCard.hidden = true;
      if (btnTopbarUpgrade) btnTopbarUpgrade.hidden = true;
      if (btnTopbarUpgrade && prevTopbarHidden !== btnTopbarUpgrade.hidden) {
        updateResponsiveLayout();
      }
      return;
    }

    if (hakimiUpgradeCard) hakimiUpgradeCard.hidden = false;

    const status = st?.status || 'idle';
    const isReady = Boolean(st && st.ok && st.supported !== false && status === 'ready' && st.staged);

    // 严格「仅成功才提示」：顶栏按钮只在沙盒试构建与验签全绿（ready）时出现
    if (btnTopbarUpgrade) {
      btnTopbarUpgrade.hidden = !isReady;
      if (prevTopbarHidden !== btnTopbarUpgrade.hidden) {
        updateResponsiveLayout();
      }
    }

    if (hakimiUpgradeBadge) {
      if (!st || !st.ok) {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.error');
        hakimiUpgradeBadge.className = 'key-pill pill-danger';
      } else if (status === 'unsupported') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.unsupported');
        hakimiUpgradeBadge.className = 'key-pill pill-muted';
      } else if (status === 'ready') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.ready');
        hakimiUpgradeBadge.className = 'key-pill pill-ok';
      } else if (status === 'checking') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.checking');
        hakimiUpgradeBadge.className = 'key-pill pill-warn';
      } else if (status === 'staging') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.staging');
        hakimiUpgradeBadge.className = 'key-pill pill-warn';
      } else if (status === 'incompatible') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.incompatible');
        hakimiUpgradeBadge.className = 'key-pill pill-warn';
      } else if (status === 'local_dev') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.localDev');
        hakimiUpgradeBadge.className = 'key-pill pill-muted';
      } else if (status === 'error') {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.error');
        hakimiUpgradeBadge.className = 'key-pill pill-danger';
      } else {
        hakimiUpgradeBadge.textContent = t('upgrade.badge.idle');
        hakimiUpgradeBadge.className = 'key-pill pill-muted';
      }
    }

    if (hakimiUpgradeMeta) {
      if (!st || !st.ok) {
        hakimiUpgradeMeta.textContent = st?.error || '—';
      } else {
        const lines = [];
        const agVer = st.installed?.antigravityVersion || '?';
        const commitShort = st.installed?.hakimiCommitShort || 'local';
        lines.push(t('upgrade.meta.installed', { ag: agVer, commit: commitShort }));
        if (isReady) {
          lines.push(`✔ ${formatHakimiUpgradeSummary(st)}`);
        }
        const extras = [];
        if (st.cleanBaseCache?.version) {
          extras.push(t('upgrade.meta.cache', { ver: st.cleanBaseCache.version }));
        }
        if (st.lastCheckedAt) {
          const ts = typeof formatMonthDayTime === 'function' ? formatMonthDayTime(st.lastCheckedAt) : st.lastCheckedAt;
          if (ts) extras.push(t('upgrade.meta.checked', { time: ts }));
        }
        if (extras.length) lines.push(extras.join(' · '));
        if (status === 'local_dev') {
          lines.push(t('upgrade.meta.localDevNote'));
        }
        if (status === 'error' && st.lastError) {
          lines.push(st.lastError);
        }
        hakimiUpgradeMeta.textContent = lines.join('\n');
      }
    }

    const inc = st?.incompatible || null;
    if (hakimiUpgradeDiag && hakimiUpgradeDiagTitle && hakimiUpgradeDiagBody) {
      if (inc && inc.antigravityVersion) {
        hakimiUpgradeDiagTitle.textContent = t('upgrade.diag.title', { ver: inc.antigravityVersion });
        hakimiUpgradeDiagBody.textContent = t('upgrade.diag.body', {
          stage: inc.failedStage || 'unknown',
          err: inc.error || t('msg.unknownErr'),
          commit: inc.testedHakimiCommitShort || String(inc.testedHakimiCommit || 'local').slice(0, 7),
        });
        hakimiUpgradeDiag.hidden = false;
      } else {
        hakimiUpgradeDiag.hidden = true;
      }
    }

    const busy = isHakimiUpgradeSyncBusy || Boolean(st?.busy);
    const unsupported = st?.supported === false;
    if (btnHakimiUpgradeInstall) {
      btnHakimiUpgradeInstall.hidden = !isReady;
      btnHakimiUpgradeInstall.disabled = isHakimiUpgradeInstallBusy || !isReady;
    }
    if (btnHakimiUpgradeSync) {
      btnHakimiUpgradeSync.disabled = busy || unsupported || isHakimiUpgradeInstallBusy;
      btnHakimiUpgradeSync.textContent = busy ? t('upgrade.btn.syncBusy') : t('upgrade.btn.sync');
    }
    if (btnHakimiUpgradeForceMain) {
      btnHakimiUpgradeForceMain.hidden = status !== 'local_dev';
      btnHakimiUpgradeForceMain.disabled = busy || unsupported || isHakimiUpgradeInstallBusy;
    }
    if (btnHakimiUpgradeCopyDiag) {
      btnHakimiUpgradeCopyDiag.hidden = !inc;
    }
  }

  function closeHakimiUpgradeModal() {
    if (hakimiUpgradeModal) hakimiUpgradeModal.hidden = true;
    if (modalUpgradeFeedback) {
      modalUpgradeFeedback.hidden = true;
      modalUpgradeFeedback.textContent = '';
    }
  }

  function openHakimiUpgradeModal() {
    if (!currentHakimiUpgradeState?.staged || currentHakimiUpgradeState?.status !== 'ready') return;
    if (el('panel')?.hidden) showPanel('context');
    if (modalUpgradeBody) {
      modalUpgradeBody.textContent = t('upgrade.modal.body', {
        summary: formatHakimiUpgradeSummary(currentHakimiUpgradeState),
      });
    }
    if (modalUpgradeFeedback) {
      modalUpgradeFeedback.hidden = true;
      modalUpgradeFeedback.textContent = '';
    }
    if (btnModalUpgradeConfirm) btnModalUpgradeConfirm.disabled = isHakimiUpgradeInstallBusy;
    if (hakimiUpgradeModal) hakimiUpgradeModal.hidden = false;
  }

  async function refreshHakimiUpgradeStatus() {
    if (typeof getRemoteSshMeta === 'function' && getRemoteSshMeta()) {
      renderHakimiUpgradeState(null);
      return null;
    }
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.getHakimiUpgradeStatus !== 'function') {
      return null;
    }
    try {
      const res = await window.contextMeterAPI.getHakimiUpgradeStatus();
      currentHakimiUpgradeState = res;
      renderHakimiUpgradeState(res);
      return res;
    } catch (err) {
      const fallback = { ok: false, error: err?.message || t('msg.unknownErr') };
      currentHakimiUpgradeState = fallback;
      renderHakimiUpgradeState(fallback);
      return fallback;
    }
  }

  async function triggerHakimiUpgradeSync(opts = {}) {
    if (isHakimiUpgradeSyncBusy) return null;
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.syncHakimiUpgrade !== 'function') {
      showHakimiUpgradeResult(false, t('msg.noHostBridge'));
      return null;
    }
    isHakimiUpgradeSyncBusy = true;
    showHakimiUpgradeResult(true, '');
    renderHakimiUpgradeState(currentHakimiUpgradeState);
    try {
      const res = await window.contextMeterAPI.syncHakimiUpgrade(opts);
      currentHakimiUpgradeState = res;
      renderHakimiUpgradeState(res);
      if (!res || !res.ok) {
        showHakimiUpgradeResult(false, res?.error || t('msg.unknownErr'));
      } else if (res.status === 'ready') {
        showHakimiUpgradeResult(true, t('upgrade.sync.readyNow'));
      } else if (res.status === 'idle' || res.status === 'local_dev') {
        showHakimiUpgradeResult(true, t('upgrade.sync.upToDate'));
      } else if (res.status === 'error' && res.lastError) {
        showHakimiUpgradeResult(false, res.lastError);
      }
      return res;
    } catch (err) {
      showHakimiUpgradeResult(false, err?.message || t('msg.unknownErr'));
      return null;
    } finally {
      isHakimiUpgradeSyncBusy = false;
      renderHakimiUpgradeState(currentHakimiUpgradeState);
    }
  }

  async function confirmInstallHakimiUpgrade() {
    if (isHakimiUpgradeInstallBusy) return;
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.installHakimiUpgrade !== 'function') {
      if (modalUpgradeFeedback) {
        modalUpgradeFeedback.textContent = t('msg.noHostBridge');
        modalUpgradeFeedback.hidden = false;
      }
      return;
    }
    isHakimiUpgradeInstallBusy = true;
    if (btnModalUpgradeConfirm) btnModalUpgradeConfirm.disabled = true;
    if (modalUpgradeFeedback) {
      modalUpgradeFeedback.textContent = t('upgrade.modal.starting');
      modalUpgradeFeedback.hidden = false;
    }
    try {
      const res = await window.contextMeterAPI.installHakimiUpgrade();
      if (!res || !res.ok) {
        isHakimiUpgradeInstallBusy = false;
        if (btnModalUpgradeConfirm) btnModalUpgradeConfirm.disabled = false;
        if (modalUpgradeFeedback) {
          modalUpgradeFeedback.textContent = t('upgrade.modal.failed', { err: res?.error || t('msg.unknownErr') });
          modalUpgradeFeedback.hidden = false;
        }
      }
    } catch (err) {
      isHakimiUpgradeInstallBusy = false;
      if (btnModalUpgradeConfirm) btnModalUpgradeConfirm.disabled = false;
      if (modalUpgradeFeedback) {
        modalUpgradeFeedback.textContent = t('upgrade.modal.failed', { err: err?.message || t('msg.unknownErr') });
        modalUpgradeFeedback.hidden = false;
      }
    }
  }

  btnTopbarUpgrade?.addEventListener('click', () => {
    hideTopbarActionTooltip(true);
    openHakimiUpgradeModal();
  });
  btnTopbarUpgrade?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) showTopbarActionTooltip('upgrade', btnTopbarUpgrade);
  });
  btnTopbarUpgrade?.addEventListener('mouseleave', () => {
    hideTopbarActionTooltip(false);
  });
  btnTopbarUpgrade?.addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showTopbarActionTooltip('upgrade', btnTopbarUpgrade);
  });
  btnTopbarUpgrade?.addEventListener('blur', () => {
    hideTopbarActionTooltip(false);
  });
  btnHakimiUpgradeInstall?.addEventListener('click', openHakimiUpgradeModal);
  btnHakimiUpgradeSync?.addEventListener('click', () => {
    void triggerHakimiUpgradeSync({ forceMainSync: false });
  });
  btnHakimiUpgradeForceMain?.addEventListener('click', () => {
    void triggerHakimiUpgradeSync({ forceMainSync: true });
  });
  btnHakimiUpgradeCopyDiag?.addEventListener('click', () => {
    const inc = currentHakimiUpgradeState?.incompatible;
    if (!inc) return;
    const text = [
      `Antigravity target: v${inc.antigravityVersion || '?'}`,
      `Installed: Antigravity v${currentHakimiUpgradeState?.installed?.antigravityVersion || '?'} / Hakimi ${currentHakimiUpgradeState?.installed?.hakimiCommit || 'unknown'}`,
      `Tested Hakimi commit: ${inc.testedHakimiCommit || 'unknown'}`,
      `Failed stage: ${inc.failedStage || 'unknown'}`,
      `Error: ${inc.error || 'unknown'}`,
      `Tested at: ${inc.testedAt || ''}`,
    ].join('\n');
    try {
      navigator?.clipboard?.writeText?.(text);
      showHakimiUpgradeResult(true, t('upgrade.diag.copied'));
    } catch {
      showHakimiUpgradeResult(false, text);
    }
  });
  btnModalUpgradeCancel?.addEventListener('click', closeHakimiUpgradeModal);
  btnModalUpgradeConfirm?.addEventListener('click', () => {
    void confirmInstallHakimiUpgrade();
  });
  hakimiUpgradeModal?.addEventListener('click', (e) => {
    if (e.target === hakimiUpgradeModal && !isHakimiUpgradeInstallBusy) {
      closeHakimiUpgradeModal();
    }
  });

  if (
    typeof window !== 'undefined' &&
    typeof window.contextMeterAPI?.onHakimiUpgradeChanged === 'function' &&
    !(typeof getRemoteSshMeta === 'function' && getRemoteSshMeta())
  ) {
    try {
      unsubscribeHakimiUpgradeChanged = window.contextMeterAPI.onHakimiUpgradeChanged((snap) => {
        if (state.disposed) return;
        currentHakimiUpgradeState = snap;
        renderHakimiUpgradeState(snap);
      });
    } catch {}
  }

  // -------------------------------------------------------------
  // 模块 2.6: 哈基米应用内换图标（实时预览 + 沙盒验签 + 原子冷替换）
  // -------------------------------------------------------------
  const hakimiIconCard = el('hakimi-icon-card');
  const hakimiIconBadge = el('hakimi-icon-badge');
  const hakimiIconDropzone = el('hakimi-icon-dropzone');
  const btnHakimiIconTilePick = el('btn-hakimi-icon-tile-pick');
  const hakimiIconCurImg = el('hakimi-icon-cur-img');
  const hakimiIconCurEmpty = el('hakimi-icon-cur-empty');
  const hakimiIconArrow = el('hakimi-icon-arrow');
  const hakimiIconNextWrap = el('hakimi-icon-next-wrap');
  const hakimiIconNextImg = el('hakimi-icon-next-img');
  const hakimiIconNextEmpty = el('hakimi-icon-next-empty');
  const hakimiIconMeta = el('hakimi-icon-meta');
  const hakimiIconMaskWrap = el('hakimi-icon-mask-wrap');
  const chkHakimiIconMask = el('chk-hakimi-icon-mask');
  const btnHakimiIconPick = el('btn-hakimi-icon-pick');
  const btnHakimiIconApply = el('btn-hakimi-icon-apply');
  const btnHakimiIconClear = el('btn-hakimi-icon-clear');
  const btnHakimiIconRestore = el('btn-hakimi-icon-restore');
  const hakimiIconResultBox = el('hakimi-icon-result');
  const hakimiIconResultText = el('hakimi-icon-result-text');
  const hakimiIconModal = el('hakimi-icon-modal');
  const modalIconTitle = el('modal-icon-title');
  const modalIconPreviewBox = el('modal-icon-preview-box');
  const modalIconPreviewImg = el('modal-icon-preview-img');
  const modalIconBody = el('modal-icon-body');
  const modalIconFeedback = el('modal-icon-feedback');
  const btnModalIconCancel = el('btn-modal-icon-cancel');
  const btnModalIconConfirm = el('btn-modal-icon-confirm');

  let currentHakimiIconState = null;
  let pendingIconFilePath = null;
  let pendingIconPreview = null;
  let pendingIconRawMode = false;
  let pendingIconModalMode = null; // 'custom' | 'restore'
  let isHakimiIconPreviewBusy = false;
  let isHakimiIconApplyBusy = false;
  let iconPreviewSeq = 0;

  function showHakimiIconResult(ok, msg) {
    if (!hakimiIconResultBox || !hakimiIconResultText) return;
    if (!msg) {
      hakimiIconResultBox.style.display = 'none';
      return;
    }
    hakimiIconResultBox.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    hakimiIconResultBox.style.display = 'block';
    hakimiIconResultText.textContent = msg;
  }

  function renderHakimiIconState(st = currentHakimiIconState) {
    const isRemote = Boolean(typeof getRemoteSshMeta === 'function' && getRemoteSshMeta());
    const hasBridge = Boolean(
      typeof window !== 'undefined' && typeof window.contextMeterAPI?.getHakimiIconStatus === 'function'
    );
    if (isRemote || !hasBridge) {
      if (hakimiIconCard) hakimiIconCard.hidden = true;
      return;
    }

    if (st && st.supported === false) {
      if (hakimiIconCard) hakimiIconCard.hidden = true;
      return;
    }

    if (hakimiIconCard) hakimiIconCard.hidden = false;

    const busy = isHakimiIconPreviewBusy || isHakimiIconApplyBusy || Boolean(st?.busy);
    const hasPendingFile = Boolean(pendingIconFilePath);
    const hasValidPreview = Boolean(pendingIconPreview && pendingIconPreview.ok && pendingIconPreview.dataUrl);

    if (hakimiIconBadge) {
      if (busy) {
        hakimiIconBadge.textContent = t('icon.badge.busy');
        hakimiIconBadge.className = 'key-pill pill-warn';
      } else if (!st) {
        hakimiIconBadge.textContent = t('settings.common.reading');
        hakimiIconBadge.className = 'key-pill pill-muted';
      } else if (!st.ok) {
        hakimiIconBadge.textContent = t('icon.badge.error');
        hakimiIconBadge.className = 'key-pill pill-danger';
      } else if (st.isCustomIcon === true) {
        hakimiIconBadge.textContent = t('icon.badge.custom');
        hakimiIconBadge.className = 'key-pill pill-ok';
      } else {
        hakimiIconBadge.textContent = t('icon.badge.default');
        hakimiIconBadge.className = 'key-pill pill-muted';
      }
    }

    if (hakimiIconCurImg && hakimiIconCurEmpty) {
      if (st?.currentIconDataUrl) {
        if (hakimiIconCurImg.getAttribute('src') !== st.currentIconDataUrl) {
          hakimiIconCurImg.setAttribute('src', st.currentIconDataUrl);
        }
        hakimiIconCurImg.hidden = false;
        hakimiIconCurEmpty.hidden = true;
      } else {
        hakimiIconCurImg.hidden = true;
        hakimiIconCurEmpty.hidden = false;
      }
    }

    if (hakimiIconArrow) hakimiIconArrow.hidden = !hasPendingFile;
    if (hakimiIconNextWrap) hakimiIconNextWrap.hidden = !hasPendingFile;
    if (hakimiIconNextImg && hakimiIconNextEmpty) {
      if (hasValidPreview) {
        if (hakimiIconNextImg.getAttribute('src') !== pendingIconPreview.dataUrl) {
          hakimiIconNextImg.setAttribute('src', pendingIconPreview.dataUrl);
        }
        hakimiIconNextImg.hidden = false;
        hakimiIconNextEmpty.hidden = true;
      } else {
        hakimiIconNextImg.hidden = true;
        hakimiIconNextEmpty.hidden = false;
      }
    }

    if (hakimiIconMaskWrap && chkHakimiIconMask) {
      const showMaskToggle = hasPendingFile && pendingIconPreview?.mode !== 'icns';
      hakimiIconMaskWrap.hidden = !showMaskToggle;
      chkHakimiIconMask.checked = !pendingIconRawMode;
      chkHakimiIconMask.disabled = busy;
    }

    if (hakimiIconMeta) {
      if (isHakimiIconPreviewBusy && pendingIconFilePath) {
        const baseName = pendingIconFilePath.split(/[\\/]/).pop() || pendingIconFilePath;
        hakimiIconMeta.textContent = t('icon.meta.previewBusy', { name: baseName });
      } else if (hasValidPreview) {
        const p = pendingIconPreview;
        const name = p.fileName || (pendingIconFilePath || '').split(/[\\/]/).pop() || '';
        if (p.mode === 'icns') {
          hakimiIconMeta.textContent = t('icon.meta.previewIcns', { name });
        } else if (p.masked) {
          hakimiIconMeta.textContent = t('icon.meta.previewMasked', { name, w: p.w || '?', h: p.h || '?' });
        } else if (p.hasTransparentCorners && !pendingIconRawMode) {
          hakimiIconMeta.textContent = t('icon.meta.previewTransparent', { name, w: p.w || '?', h: p.h || '?' });
        } else {
          hakimiIconMeta.textContent = t('icon.meta.previewRaw', { name, w: p.w || '?', h: p.h || '?' });
        }
      } else if (!st || !st.ok) {
        hakimiIconMeta.textContent = st?.error || '—';
      } else if (st.isCustomIcon === true) {
        hakimiIconMeta.textContent = t('icon.meta.custom');
      } else {
        hakimiIconMeta.textContent = t('icon.meta.default');
      }
    }

    if (btnHakimiIconPick) {
      btnHakimiIconPick.disabled = busy;
      btnHakimiIconPick.textContent = hasPendingFile ? t('icon.btn.pickAnother') : t('icon.btn.pick');
      btnHakimiIconPick.className = hasPendingFile
        ? 'unlock-btn unlock-btn-secondary'
        : 'unlock-btn unlock-btn-primary';
    }
    if (btnHakimiIconTilePick) {
      btnHakimiIconTilePick.disabled = busy;
    }
    if (btnHakimiIconApply) {
      btnHakimiIconApply.hidden = !hasValidPreview;
      btnHakimiIconApply.disabled = busy || !hasValidPreview;
    }
    if (btnHakimiIconClear) {
      btnHakimiIconClear.hidden = !hasPendingFile;
      btnHakimiIconClear.disabled = busy;
    }
    if (btnHakimiIconRestore) {
      const canShowRestore = Boolean(st?.ok && st.canRestoreDefault && st.isCustomIcon !== false);
      btnHakimiIconRestore.hidden = !canShowRestore;
      btnHakimiIconRestore.disabled = busy || !canShowRestore;
    }
  }

  async function requestHakimiIconPreview(filePath, rawMode = pendingIconRawMode) {
    if (!filePath || typeof window === 'undefined' || typeof window.contextMeterAPI?.previewHakimiIcon !== 'function') {
      return null;
    }
    const seq = ++iconPreviewSeq;
    pendingIconFilePath = filePath;
    pendingIconRawMode = Boolean(rawMode);
    isHakimiIconPreviewBusy = true;
    showHakimiIconResult(true, '');
    renderHakimiIconState(currentHakimiIconState);
    try {
      const res = await window.contextMeterAPI.previewHakimiIcon({
        inputPath: filePath,
        rawIcon: pendingIconRawMode,
      });
      if (seq !== iconPreviewSeq) return null;
      if (res && res.ok && res.dataUrl) {
        pendingIconPreview = res;
        showHakimiIconResult(true, '');
      } else {
        pendingIconPreview = null;
        showHakimiIconResult(false, res?.error || t('msg.unknownErr'));
      }
      return res;
    } catch (err) {
      if (seq !== iconPreviewSeq) return null;
      pendingIconPreview = null;
      showHakimiIconResult(false, err?.message || t('msg.unknownErr'));
      return null;
    } finally {
      if (seq === iconPreviewSeq) {
        isHakimiIconPreviewBusy = false;
        renderHakimiIconState(currentHakimiIconState);
      }
    }
  }

  async function handlePickHakimiIconFile() {
    if (isHakimiIconPreviewBusy || isHakimiIconApplyBusy) return;
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.pickHakimiIconFile !== 'function') {
      showHakimiIconResult(false, t('msg.noHostBridge'));
      return;
    }
    try {
      const pick = await window.contextMeterAPI.pickHakimiIconFile();
      if (!pick || pick.canceled || !pick.filePath) return;
      if (pick.ok === false) {
        showHakimiIconResult(false, pick.error || t('msg.unknownErr'));
        return;
      }
      await requestHakimiIconPreview(pick.filePath, pendingIconRawMode);
    } catch (err) {
      showHakimiIconResult(false, err?.message || t('msg.unknownErr'));
    }
  }

  function clearPendingHakimiIcon() {
    iconPreviewSeq++;
    pendingIconFilePath = null;
    pendingIconPreview = null;
    isHakimiIconPreviewBusy = false;
    showHakimiIconResult(true, '');
    renderHakimiIconState(currentHakimiIconState);
  }

  function closeHakimiIconModal() {
    if (isHakimiIconApplyBusy) return;
    pendingIconModalMode = null;
    if (hakimiIconModal) hakimiIconModal.hidden = true;
    if (modalIconFeedback) {
      modalIconFeedback.hidden = true;
      modalIconFeedback.textContent = '';
    }
  }

  function openHakimiIconModal(mode) {
    if (isHakimiIconApplyBusy) return;
    if (mode === 'custom' && (!pendingIconFilePath || !pendingIconPreview?.ok)) return;
    if (mode === 'restore' && !currentHakimiIconState?.canRestoreDefault) return;
    pendingIconModalMode = mode;
    if (modalIconTitle) {
      modalIconTitle.textContent =
        mode === 'restore' ? t('icon.modal.restoreTitle') : t('icon.modal.applyTitle');
    }
    if (modalIconBody) {
      if (mode === 'restore') {
        modalIconBody.textContent = t('icon.modal.restoreBody');
      } else {
        const name = pendingIconPreview?.fileName || pendingIconFilePath.split(/[\\/]/).pop() || '';
        modalIconBody.textContent = t('icon.modal.applyBody', { name });
      }
    }
    if (modalIconPreviewBox && modalIconPreviewImg) {
      if (mode === 'custom' && pendingIconPreview?.dataUrl) {
        modalIconPreviewImg.setAttribute('src', pendingIconPreview.dataUrl);
        modalIconPreviewBox.hidden = false;
      } else {
        modalIconPreviewBox.hidden = true;
      }
    }
    if (btnModalIconConfirm) {
      btnModalIconConfirm.textContent =
        mode === 'restore' ? t('icon.btn.restore') : t('icon.btn.apply');
      btnModalIconConfirm.disabled = false;
    }
    if (btnModalIconCancel) btnModalIconCancel.disabled = false;
    if (modalIconFeedback) {
      modalIconFeedback.hidden = true;
      modalIconFeedback.textContent = '';
    }
    if (hakimiIconModal) hakimiIconModal.hidden = false;
  }

  async function confirmHakimiIconAction() {
    if (isHakimiIconApplyBusy || !pendingIconModalMode) return;
    const mode = pendingIconModalMode;
    const api = typeof window !== 'undefined' ? window.contextMeterAPI : null;
    const invokeFn = mode === 'restore' ? api?.restoreHakimiIcon : api?.applyHakimiIcon;
    if (typeof invokeFn !== 'function') {
      if (modalIconFeedback) {
        modalIconFeedback.textContent = t('msg.noHostBridge');
        modalIconFeedback.hidden = false;
      }
      return;
    }

    isHakimiIconApplyBusy = true;
    renderHakimiIconState(currentHakimiIconState);
    if (btnModalIconConfirm) btnModalIconConfirm.disabled = true;
    if (btnModalIconCancel) btnModalIconCancel.disabled = true;
    if (modalIconFeedback) {
      modalIconFeedback.textContent = t('icon.modal.staging');
      modalIconFeedback.hidden = false;
    }

    try {
      const payload =
        mode === 'custom'
          ? { inputPath: pendingIconFilePath, rawIcon: pendingIconRawMode }
          : {};
      const res = await invokeFn(payload);
      if (res && res.ok && res.coldSwapping) {
        if (modalIconFeedback) {
          modalIconFeedback.textContent = t('icon.modal.swapping');
          modalIconFeedback.hidden = false;
        }
        return;
      }
      isHakimiIconApplyBusy = false;
      renderHakimiIconState(currentHakimiIconState);
      if (btnModalIconConfirm) btnModalIconConfirm.disabled = false;
      if (btnModalIconCancel) btnModalIconCancel.disabled = false;
      if (modalIconFeedback) {
        modalIconFeedback.textContent = t('icon.modal.failed', { err: res?.error || t('msg.unknownErr') });
        modalIconFeedback.hidden = false;
      }
    } catch (err) {
      isHakimiIconApplyBusy = false;
      renderHakimiIconState(currentHakimiIconState);
      if (btnModalIconConfirm) btnModalIconConfirm.disabled = false;
      if (btnModalIconCancel) btnModalIconCancel.disabled = false;
      if (modalIconFeedback) {
        modalIconFeedback.textContent = t('icon.modal.failed', { err: err?.message || t('msg.unknownErr') });
        modalIconFeedback.hidden = false;
      }
    }
  }

  async function refreshHakimiIconStatus(opts = {}) {
    if (typeof getRemoteSshMeta === 'function' && getRemoteSshMeta()) {
      renderHakimiIconState(null);
      return null;
    }
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.getHakimiIconStatus !== 'function') {
      renderHakimiIconState(null);
      return null;
    }
    try {
      const res = await window.contextMeterAPI.getHakimiIconStatus({
        consumeLastResult: opts.consumeLastResult === true,
      });
      currentHakimiIconState = res;
      renderHakimiIconState(res);
      if (res?.lastResult) {
        if (res.lastResult.ok) {
          showHakimiIconResult(
            true,
            res.lastResult.iconMode === 'restore' ? t('icon.lastResult.okRestore') : t('icon.lastResult.okCustom')
          );
        } else if (res.lastResult.error) {
          showHakimiIconResult(false, t('icon.lastResult.fail', { err: res.lastResult.error }));
        }
      }
      return res;
    } catch (err) {
      const fallback = { ok: false, error: err?.message || t('msg.unknownErr') };
      currentHakimiIconState = fallback;
      renderHakimiIconState(fallback);
      return fallback;
    }
  }

  btnHakimiIconPick?.addEventListener('click', () => {
    void handlePickHakimiIconFile();
  });
  btnHakimiIconTilePick?.addEventListener('click', () => {
    void handlePickHakimiIconFile();
  });
  btnHakimiIconApply?.addEventListener('click', () => openHakimiIconModal('custom'));
  btnHakimiIconClear?.addEventListener('click', clearPendingHakimiIcon);
  btnHakimiIconRestore?.addEventListener('click', () => openHakimiIconModal('restore'));
  chkHakimiIconMask?.addEventListener('change', () => {
    const nextRaw = !chkHakimiIconMask.checked;
    pendingIconRawMode = nextRaw;
    if (pendingIconFilePath) {
      void requestHakimiIconPreview(pendingIconFilePath, nextRaw);
    }
  });
  btnModalIconCancel?.addEventListener('click', closeHakimiIconModal);
  btnModalIconConfirm?.addEventListener('click', () => {
    void confirmHakimiIconAction();
  });
  hakimiIconModal?.addEventListener('click', (e) => {
    if (e.target === hakimiIconModal && !isHakimiIconApplyBusy) {
      closeHakimiIconModal();
    }
  });

  if (hakimiIconDropzone) {
    const clearDragState = () => hakimiIconDropzone.classList?.remove('is-dragover');
    hakimiIconDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!isHakimiIconApplyBusy) hakimiIconDropzone.classList?.add('is-dragover');
    });
    hakimiIconDropzone.addEventListener('dragleave', clearDragState);
    hakimiIconDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      clearDragState();
      if (isHakimiIconApplyBusy || isHakimiIconPreviewBusy) return;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      let droppedPath = '';
      try {
        if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getFilePathForDrop === 'function') {
          droppedPath = String(window.contextMeterAPI.getFilePathForDrop(file) || '').trim();
        }
      } catch {}
      if (!droppedPath && typeof file.path === 'string') {
        droppedPath = file.path.trim();
      }
      if (!droppedPath) {
        showHakimiIconResult(false, t('icon.dropUnsupported'));
        return;
      }
      void requestHakimiIconPreview(droppedPath, pendingIconRawMode);
    });
  }

  // 静默初始化检测各模块状态
  setTimeout(() => {
    void refreshModulesDisplay();
    void refreshCliUnlockDisplay();
    void refreshHakimiUpgradeStatus();
    void refreshHakimiIconStatus({ consumeLastResult: true });
  }, 500);
  setTimeout(() => {
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);

  // 二级抽屉 1（面板 B 内）: 指标与背景颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  function toggleColorsDrawer(forceOpen) {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
    colorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker();
    }
  }
  btnColors?.addEventListener('click', () => toggleColorsDrawer());

  // 二级抽屉 2（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
  const btnTokenColors = el('btn-toggle-token-colors');
  const tokenColorDrawerBody = el('token-color-drawer-body');
  const tokenColorDrawerArrow = el('token-color-drawer-arrow');
  function toggleTokenColorsDrawer(forceOpen) {
    if (!tokenColorDrawerBody) return;
    const curHidden = tokenColorDrawerBody.style.display === 'none' || !tokenColorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    tokenColorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    tokenColorDrawerBody.classList?.toggle?.('is-expanded', nextOpen);
    if (tokenColorDrawerArrow) tokenColorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnTokenColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker(false);
    }
  }
  btnTokenColors?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('heat-legend-scale')?.addEventListener('click', () => toggleTokenColorsDrawer(true));

  // 热力图视图切换（每天 / 每周 / 累计总量）

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = customColors.tokenAccent || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
    heatViewDirty = false;
  }

  function switchHeatView(view, save = true, opts = {}) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    hidePopover();
    if (opts.forceRender || isTokensPanelVisible()) {
      renderActiveHeatView(true);
    } else {
      heatViewDirty = true;
    }

    if (save && typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ savedHeatView: view });
    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      toggle(false);
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    const isClosingNow = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (pop && !pop.hidden && !isClosingNow) {
      const isInsidePicker = path.includes(pop);
      const isSwatchBtn = path.some(n => n?.classList?.contains?.('color-swatch-btn') || n?.classList?.contains?.('heat-leg-swatch') || n?.id?.startsWith?.('swatch-') || n?.id?.startsWith?.('heat-leg-'));
      if (!isInsidePicker && !isSwatchBtn) {
        closeColorPicker();
      }
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      if (hakimiIconModal && !hakimiIconModal.hidden && !isHakimiIconApplyBusy) {
        closeHakimiIconModal();
        return;
      }
      if (hakimiUpgradeModal && !hakimiUpgradeModal.hidden && !isHakimiUpgradeInstallBusy) {
        closeHakimiUpgradeModal();
        return;
      }
      const pop = el('color-picker-popover');
      const isEscClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
      if (pop && !pop.hidden && !isEscClosing) {
        const returnFocus = activePickerAnchor;
        closeColorPicker();
        returnFocus?.focus?.();
        return;
      }
      const tokenDrawer = el('token-color-drawer-body');
      if (tokenDrawer && tokenDrawer.style.display !== 'none') {
        toggleTokenColorsDrawer(false);
        btnTokenColors?.focus?.();
        return;
      }
      const colorDrawer = el('color-drawer-body');
      if (colorDrawer && colorDrawer.style.display !== 'none') {
        toggleColorsDrawer(false);
        btnColors?.focus?.();
        return;
      }
      toggle(false);
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);