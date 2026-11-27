  // =========================================================================
  // 多账号冷切换模块（macOS 系统钥匙串外部接力冷切，零明文落盘，共享历史对话）
  // - 主入口：左下角模型额度卡片标题栏人像按钮 → 独立 Shadow DOM 浮层
  // - 未登录兜底：登录页左下角快捷胶囊按钮（#acc-login-pill）+「配置」页账号卡片
  // =========================================================================
  var accountsHost = document.createElement('div');
  accountsHost.id = 'ag-accounts-host';
  var accountsShadow = accountsHost.attachShadow({ mode: 'open' });
  accountsShadow.innerHTML = `<style>
    :host{
      position:fixed;left:0;top:0;width:0;height:0;z-index:2147482510;
      -webkit-app-region:no-drag;user-select:none;
      --ag-acc-bg:var(--ag-custom-panel-bg,rgba(24,24,27,0.96));
      --ag-acc-card:rgba(255,255,255,0.045);
      --ag-acc-card-hover:rgba(255,255,255,0.08);
      --ag-acc-border:rgba(255,255,255,0.12);
      --ag-acc-border-subtle:rgba(255,255,255,0.08);
      --ag-acc-text:#ececef;
      --ag-acc-sub:#a1a1aa;
      --ag-acc-muted:#71717a;
      --ag-acc-accent:#a78bfa;
      --ag-acc-accent-bg:rgba(167,139,250,0.16);
      --ag-acc-ok:#34d399;
      --ag-acc-ok-bg:rgba(52,211,153,0.14);
      --ag-acc-warn:#f59e0b;
      --ag-acc-warn-bg:rgba(245,158,11,0.14);
      --ag-acc-danger:#f87171;
      --ag-acc-danger-bg:rgba(248,113,113,0.14);
      --ag-acc-btn-hover:rgba(255,255,255,0.09);
      --ag-acc-shadow:0 12px 32px rgba(0,0,0,0.45),0 2px 8px rgba(0,0,0,0.28);
      color-scheme:dark;
    }
    :host([data-theme="light"]),
    :host([data-panel-tone="light"]){
      --ag-acc-bg:var(--ag-custom-panel-bg,rgba(255,255,255,0.97));
      --ag-acc-card:rgba(0,0,0,0.032);
      --ag-acc-card-hover:rgba(0,0,0,0.06);
      --ag-acc-border:rgba(0,0,0,0.12);
      --ag-acc-border-subtle:rgba(0,0,0,0.07);
      --ag-acc-text:#18181b;
      --ag-acc-sub:#52525b;
      --ag-acc-muted:#71717a;
      --ag-acc-accent:#7c3aed;
      --ag-acc-accent-bg:rgba(124,58,237,0.12);
      --ag-acc-ok:#059669;
      --ag-acc-ok-bg:rgba(5,150,105,0.11);
      --ag-acc-warn:#d97706;
      --ag-acc-warn-bg:rgba(217,119,6,0.12);
      --ag-acc-danger:#dc2626;
      --ag-acc-danger-bg:rgba(220,38,38,0.11);
      --ag-acc-btn-hover:rgba(0,0,0,0.07);
      --ag-acc-shadow:0 12px 30px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.08);
      color-scheme:light;
    }
    #acc-login-pill{
      position:fixed;left:14px;bottom:14px;display:inline-flex;align-items:center;gap:6px;
      padding:6px 11px;border-radius:999px;border:1px solid var(--ag-acc-border);
      background:var(--ag-acc-bg);color:var(--ag-acc-text);
      backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
      box-shadow:var(--ag-acc-shadow);cursor:pointer;
      font:500 11.5px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      transition:border-color .14s ease,background-color .14s ease;
    }
    #acc-login-pill:hover{border-color:var(--ag-acc-accent)}
    #acc-login-pill[hidden]{display:none!important}
    #acc-login-pill svg{width:13px;height:13px;flex-shrink:0;color:var(--ag-acc-accent)}
    #accounts-popover{
      position:fixed;left:12px;bottom:12px;width:320px;max-width:calc(100vw - 24px);
      max-height:min(490px,calc(100vh - 24px));display:flex;flex-direction:column;
      border:1px solid var(--ag-acc-border);border-radius:11px;
      background:var(--ag-acc-bg);color:var(--ag-acc-text);
      backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
      box-shadow:var(--ag-acc-shadow);overflow:hidden;
      font:11.5px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    }
    #accounts-popover[hidden]{display:none!important}
    .acc-header{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:9px 11px 8px;border-bottom:1px solid var(--ag-acc-border-subtle);
    }
    .acc-title{font-size:12px;font-weight:600;color:var(--ag-acc-text)}
    .acc-header-actions{display:inline-flex;align-items:center;gap:3px}
    .acc-icon-btn{
      display:inline-flex;align-items:center;justify-content:center;
      width:20px;height:20px;padding:0;border:0;border-radius:5px;
      background:transparent;color:var(--ag-acc-sub);font-size:14px;line-height:1;cursor:pointer;
    }
    .acc-icon-btn:hover{background:var(--ag-acc-btn-hover);color:var(--ag-acc-text)}
    .acc-icon-btn svg{width:13px;height:13px;display:block}
    .acc-body{padding:9px 11px;overflow-y:auto;display:flex;flex-direction:column;gap:9px}
    .acc-current-box{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:8px 9px;border-radius:8px;background:var(--ag-acc-card);
      border:1px solid var(--ag-acc-border-subtle);
    }
    .acc-current-info{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:2px}
    .acc-current-top{display:flex;align-items:center;gap:5px;min-width:0}
    .acc-current-label{font-size:10px;color:var(--ag-acc-muted)}
    .acc-current-email{
      font-size:11.5px;font-weight:600;color:var(--ag-acc-text);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .acc-pill{
      display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;
      font-size:9.5px;font-weight:600;white-space:nowrap;flex-shrink:0;
      background:var(--ag-acc-btn-hover);color:var(--ag-acc-sub);
    }
    .acc-pill.is-ok{background:var(--ag-acc-ok-bg);color:var(--ag-acc-ok)}
    .acc-pill.is-warn{background:var(--ag-acc-warn-bg);color:var(--ag-acc-warn)}
    .acc-pill.is-accent{background:var(--ag-acc-accent-bg);color:var(--ag-acc-accent)}
    .acc-agy-warn{
      padding:7px 9px;border-radius:7px;font-size:10.5px;line-height:1.4;
      background:var(--ag-acc-warn-bg);color:var(--ag-acc-warn);
      border:1px solid rgba(245,158,11,0.28);
    }
    .acc-agy-warn[hidden]{display:none!important}
    .acc-section-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
    .acc-section-title{font-size:10.5px;font-weight:600;color:var(--ag-acc-sub)}
    .acc-list{display:flex;flex-direction:column;gap:5px}
    .acc-row{
      display:flex;align-items:center;justify-content:space-between;gap:7px;
      padding:6px 8px;border-radius:8px;background:var(--ag-acc-card);
      border:1px solid transparent;transition:background-color .14s ease,border-color .14s ease;
    }
    .acc-row.is-active{border-color:var(--ag-acc-ok-bg);background:var(--ag-acc-card)}
    .acc-row.is-clickable{cursor:pointer}
    .acc-row.is-clickable:hover{background:var(--ag-acc-card-hover);border-color:var(--ag-acc-border)}
    .acc-avatar{
      width:22px;height:22px;border-radius:999px;flex-shrink:0;
      display:inline-flex;align-items:center;justify-content:center;
      font-size:10.5px;font-weight:700;text-transform:uppercase;
      background:var(--ag-acc-accent-bg);color:var(--ag-acc-accent);
    }
    .acc-row.is-active .acc-avatar{background:var(--ag-acc-ok-bg);color:var(--ag-acc-ok)}
    .acc-meta{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}
    .acc-name{
      font-size:11.5px;font-weight:500;color:var(--ag-acc-text);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .acc-sub{
      font-size:10px;color:var(--ag-acc-muted);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .acc-rename-input{
      width:100%;box-sizing:border-box;padding:2px 6px;border-radius:4px;
      border:1px solid var(--ag-acc-accent);background:var(--ag-acc-bg);color:var(--ag-acc-text);
      font:inherit;font-size:11px;outline:none;user-select:text;
    }
    .acc-row-actions{flex-shrink:0;display:inline-flex;align-items:center;gap:4px}
    .acc-btn{
      padding:3px 8px;border:1px solid var(--ag-acc-border);border-radius:5px;
      background:transparent;color:var(--ag-acc-text);font:inherit;font-size:10.5px;
      font-weight:500;cursor:pointer;white-space:nowrap;
      transition:background-color .14s ease,border-color .14s ease,color .14s ease;
    }
    .acc-btn:hover:not(:disabled){background:var(--ag-acc-btn-hover);border-color:var(--ag-acc-accent)}
    .acc-btn:disabled{opacity:0.45;cursor:not-allowed}
    .acc-btn-primary{
      border-color:transparent;background:var(--ag-acc-accent);color:#fff;font-weight:600;
    }
    .acc-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--ag-acc-accent);border-color:transparent}
    .acc-btn-danger{border-color:transparent;background:var(--ag-acc-danger-bg);color:var(--ag-acc-danger);font-weight:600}
    .acc-btn-danger:hover:not(:disabled){background:var(--ag-acc-danger);color:#fff}
    .acc-mini-icon-btn{
      display:inline-flex;align-items:center;justify-content:center;
      width:20px;height:20px;padding:0;border:0;border-radius:5px;
      background:transparent;color:var(--ag-acc-muted);font-size:12px;cursor:pointer;
    }
    .acc-mini-icon-btn:hover:not(:disabled){background:var(--ag-acc-btn-hover);color:var(--ag-acc-text)}
    .acc-mini-icon-btn.is-danger:hover:not(:disabled){background:var(--ag-acc-danger-bg);color:var(--ag-acc-danger)}
    .acc-empty{
      font-size:10.5px;line-height:1.45;color:var(--ag-acc-muted);
      padding:6px 4px;
    }
    .acc-confirm-box{
      display:flex;flex-direction:column;gap:7px;padding:8px 9px;border-radius:8px;
      background:var(--ag-acc-card);border:1px solid var(--ag-acc-border);
    }
    .acc-confirm-box[hidden]{display:none!important}
    .acc-confirm-text{font-size:10.5px;line-height:1.45;color:var(--ag-acc-sub)}
    .acc-confirm-actions{display:flex;justify-content:flex-end;gap:5px}
    .acc-status{
      display:flex;flex-direction:column;gap:6px;padding:7px 9px;border-radius:7px;
      font-size:10.5px;line-height:1.4;background:var(--ag-acc-accent-bg);color:var(--ag-acc-text);
    }
    .acc-status[hidden]{display:none!important}
    .acc-status[data-tone="ok"]{background:var(--ag-acc-ok-bg);color:var(--ag-acc-ok)}
    .acc-status[data-tone="warn"]{background:var(--ag-acc-warn-bg);color:var(--ag-acc-warn)}
    .acc-status[data-tone="danger"]{background:var(--ag-acc-danger-bg);color:var(--ag-acc-danger)}
    .acc-footer{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:7px 11px 8px;border-top:1px solid var(--ag-acc-border-subtle);
    }
    .acc-footer-note{font-size:10px;color:var(--ag-acc-muted);min-width:0}
  </style>
  <button id="acc-login-pill" type="button" hidden>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="5.25" r="2.6"></circle>
      <path d="M2.75 13.5c.8-2.3 2.75-3.5 5.25-3.5s4.45 1.2 5.25 3.5"></path>
    </svg>
    <span id="acc-login-pill-text" data-i18n="accounts.loginPill">切换已保存账号</span>
  </button>
  <div id="accounts-popover" hidden role="dialog" aria-label="账号快捷切换">
    <div class="acc-header">
      <span id="acc-title" class="acc-title" data-i18n="accounts.title">账号快捷切换</span>
      <div class="acc-header-actions">
        <button id="acc-btn-refresh" class="acc-icon-btn" type="button" title="刷新账号状态" aria-label="刷新账号状态">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13.25 8a5.25 5.25 0 1 1-1.3-3.45"></path>
            <path d="M13.25 2.75v2.6h-2.6"></path>
          </svg>
        </button>
        <button id="acc-btn-close" class="acc-icon-btn" type="button" aria-label="关闭">×</button>
      </div>
    </div>
    <div class="acc-body">
      <div class="acc-current-box">
        <div class="acc-current-info">
          <div class="acc-current-top">
            <span class="acc-current-label" data-i18n="accounts.currentLabel">当前登录</span>
            <span id="acc-current-pill" class="acc-pill" hidden></span>
            <span id="acc-current-tier" class="acc-pill is-accent" hidden></span>
          </div>
          <div id="acc-current-email" class="acc-current-email">—</div>
        </div>
        <button id="acc-btn-save-current" class="acc-btn acc-btn-primary" type="button" data-i18n="accounts.saveCurrent">保存当前</button>
      </div>

      <div id="acc-agy-warn" class="acc-agy-warn" hidden></div>

      <div class="acc-section-head">
        <span class="acc-section-title" data-i18n="accounts.savedHeading">已保存账号（系统钥匙串）</span>
        <span id="acc-saved-count" class="acc-pill">0</span>
      </div>
      <div id="acc-list" class="acc-list"></div>

      <div id="acc-switch-confirm" class="acc-confirm-box" hidden>
        <div id="acc-switch-confirm-text" class="acc-confirm-text"></div>
        <div class="acc-confirm-actions">
          <button id="acc-btn-switch-cancel" class="acc-btn" type="button" data-i18n="accounts.cancel">取消</button>
          <button id="acc-btn-switch-go" class="acc-btn acc-btn-primary" type="button" data-i18n="accounts.switchConfirmGo">确认冷切换</button>
        </div>
      </div>

      <div id="acc-add-confirm" class="acc-confirm-box" hidden>
        <div id="acc-add-confirm-text" class="acc-confirm-text" data-i18n="accounts.addConfirmText">将先自动备份当前账号至系统钥匙串，再重启并清除本地活动凭据以进入官方登录页（不会吊销原账号 Token，历史对话保持共享）。</div>
        <div class="acc-confirm-actions">
          <button id="acc-btn-add-cancel" class="acc-btn" type="button" data-i18n="accounts.cancel">取消</button>
          <button id="acc-btn-add-go" class="acc-btn acc-btn-primary" type="button" data-i18n="accounts.addConfirmGo">备份并重启登录</button>
        </div>
      </div>

      <div id="acc-status" class="acc-status" hidden>
        <div id="acc-status-text"></div>
      </div>
    </div>
    <div class="acc-footer">
      <span class="acc-footer-note" data-i18n="accounts.footerNote">钥匙串冷切 · 共享历史对话</span>
      <button id="acc-btn-add" class="acc-btn" type="button" data-i18n="accounts.addBtn">+ 添加新账号</button>
    </div>
  </div>`;

  const accEl = id => accountsShadow.getElementById(id);
  const accDom = {
    loginPill: accEl('acc-login-pill'),
    loginPillText: accEl('acc-login-pill-text'),
    popover: accEl('accounts-popover'),
    title: accEl('acc-title'),
    refreshBtn: accEl('acc-btn-refresh'),
    closeBtn: accEl('acc-btn-close'),
    currentEmail: accEl('acc-current-email'),
    currentPill: accEl('acc-current-pill'),
    currentTier: accEl('acc-current-tier'),
    saveCurrentBtn: accEl('acc-btn-save-current'),
    agyWarn: accEl('acc-agy-warn'),
    savedCount: accEl('acc-saved-count'),
    list: accEl('acc-list'),
    switchConfirm: accEl('acc-switch-confirm'),
    switchConfirmText: accEl('acc-switch-confirm-text'),
    switchCancelBtn: accEl('acc-btn-switch-cancel'),
    switchGoBtn: accEl('acc-btn-switch-go'),
    addConfirm: accEl('acc-add-confirm'),
    addConfirmText: accEl('acc-add-confirm-text'),
    addCancelBtn: accEl('acc-btn-add-cancel'),
    addGoBtn: accEl('acc-btn-add-go'),
    statusBox: accEl('acc-status'),
    statusText: accEl('acc-status-text'),
    addBtn: accEl('acc-btn-add')
  };

  let accountsState = null;
  let accountsPopoverOpen = false;
  let accountsBusy = false;
  let accountsAddConfirmOpen = false;
  let accountsPendingSwitchId = null;
  let accountsPendingDeleteId = null;
  let accountsEditingId = null;
  let accountsEditingValue = '';
  let accountsAnchorEl = null;
  let accountsConsumedLastResultAt = '';
  let accountsShowingMismatchWarn = false;

  function isAccountSwitcherAvailable() {
    if (typeof isSshRemoteWindow === 'function' && isSshRemoteWindow()) return false;
    if (accountsState && accountsState.supported === false) return false;
    return Boolean(typeof window !== 'undefined' && window.contextMeterAPI?.getAccountsStatus);
  }

  function getLiveAccountIdentityHint() {
    const ps = ANTIGRAVITY_TOKEN_DATA?.planStatus || ANTIGRAVITY_TOKEN_DATA?.rawPlanStatus || null;
    if (!ps || ps.isArchiveFallback === true) {
      return { currentEmail: '', currentTierName: '' };
    }
    return {
      currentEmail: (typeof ps.email === 'string' && ps.email.trim()) ? ps.email.trim() : '',
      currentTierName: (typeof ps.tierName === 'string' && ps.tierName.trim()) ? ps.tierName.trim() : ''
    };
  }

  async function invokeAccountsApi(action, payload = {}) {
    const api = typeof window !== 'undefined' ? window.contextMeterAPI : null;
    if (!api) return { ok: false, supported: false, error: t('accounts.err.noBridge'), unavailable: true };
    const hint = getLiveAccountIdentityHint();
    const enriched = {
      currentEmail: hint.currentEmail,
      currentTierName: hint.currentTierName,
      ...(payload && typeof payload === 'object' ? payload : {})
    };
    if (action === 'status' && typeof api.getAccountsStatus === 'function') {
      return await api.getAccountsStatus(enriched);
    }
    if (action === 'save' && typeof api.saveCurrentAccount === 'function') {
      return await api.saveCurrentAccount(enriched);
    }
    if (action === 'switch' && typeof api.switchAccount === 'function') {
      return await api.switchAccount(enriched);
    }
    if (action === 'prepare-add' && typeof api.prepareAddAccount === 'function') {
      return await api.prepareAddAccount(enriched);
    }
    if (action === 'rename' && typeof api.renameAccount === 'function') {
      return await api.renameAccount(enriched);
    }
    if (action === 'remove' && typeof api.removeAccount === 'function') {
      return await api.removeAccount(enriched);
    }
    return { ok: false, supported: false, error: t('accounts.err.noBridge'), unavailable: true };
  }

  function syncAccountsTheme() {
    if (!accountsHost) return;
    const setAttr = (name, val) => {
      if (val === null || val === undefined) {
        if (accountsHost.hasAttribute(name)) accountsHost.removeAttribute(name);
      } else if (accountsHost.getAttribute(name) !== String(val)) {
        accountsHost.setAttribute(name, String(val));
      }
    };
    setAttr('data-theme', host.getAttribute('data-theme'));
    setAttr('data-panel-tone', host.getAttribute('data-panel-tone'));
    const customBg = host.style?.getPropertyValue?.('--ag-custom-panel-bg');
    if (customBg) accountsHost.style.setProperty('--ag-custom-panel-bg', customBg);
    else if (accountsHost.style?.removeProperty) accountsHost.style.removeProperty('--ag-custom-panel-bg');
  }
  syncAccountsTheme();

  function ensureAccountsHostMounted() {
    if (state.disposed || typeof document === 'undefined') return false;
    const parent = document.body || document.documentElement;
    if (!parent) return false;
    if (accountsHost.parentElement !== parent) parent.appendChild(accountsHost);
    return true;
  }

  function showAccountsStatus(message, tone = 'info') {
    if (!accDom.statusBox || !accDom.statusText) return;
    if (!message) {
      accDom.statusBox.hidden = true;
      accDom.statusText.textContent = '';
      return;
    }
    accDom.statusBox.hidden = false;
    accDom.statusBox.setAttribute('data-tone', tone);
    accDom.statusText.textContent = message;
  }

  function formatAccountPrimaryName(profile) {
    if (!profile) return '—';
    return profile.label || profile.email || profile.id || '—';
  }

  function formatAccountInitial(profile) {
    const raw = (profile?.label || profile?.email || profile?.id || '?').trim();
    return raw ? raw.charAt(0).toUpperCase() : '?';
  }

  function syncLoginPageFallbackPill() {
    if (!accDom.loginPill) return;
    const available = isAccountSwitcherAvailable();
    const profiles = Array.isArray(accountsState?.profiles) ? accountsState.profiles : [];
    const quotaHidden = typeof quotaHost === 'undefined' ? true : Boolean(quotaHost.hidden);
    const shouldShow = Boolean(
      available &&
      accountsState &&
      accountsState.hasActiveToken === false &&
      profiles.length > 0 &&
      quotaHidden
    );
    if (shouldShow) {
      ensureAccountsHostMounted();
      syncAccountsTheme();
    }
    accDom.loginPill.hidden = !shouldShow;
  }

  function renderAccountsSettingsCard() {
    const card = el('accounts-settings-card');
    if (!card) return;
    const available = isAccountSwitcherAvailable();
    card.hidden = !available;
    if (!available) return;

    const badge = el('accounts-settings-badge');
    const summaryEl = el('accounts-settings-summary');
    const listEl = el('accounts-settings-list');
    const saveBtn = el('btn-accounts-settings-save');
    const addBtn = el('btn-accounts-settings-add');
    const statusBox = el('accounts-settings-result');
    const statusText = el('accounts-settings-result-text');

    const st = accountsState;
    const profiles = Array.isArray(st?.profiles) ? st.profiles : [];
    const hint = getLiveAccountIdentityHint();
    const activeEmail = st?.activeEmail || hint.currentEmail || '';
    const agyBlocked = Boolean(st?.agyCliRunning);

    if (badge) {
      badge.textContent = t('accounts.savedCountBadge', { n: profiles.length });
      badge.className = `key-pill ${profiles.length > 0 ? 'pill-ok' : 'pill-muted'}`;
    }
    if (summaryEl) {
      if (!st) {
        summaryEl.textContent = t('accounts.loading');
      } else if (agyBlocked) {
        summaryEl.textContent = t('accounts.agyBlockedShort', { pids: (st.agyCliPids || []).join(', ') });
      } else if (!st.hasActiveToken) {
        summaryEl.textContent = t('accounts.notSignedInSummary');
      } else {
        const stateTag = st.currentUnsaved ? t('accounts.pill.unsaved') : t('accounts.pill.saved');
        summaryEl.textContent = `${activeEmail || t('accounts.unknownEmail')} (${stateTag})`;
      }
    }
    if (saveBtn) {
      saveBtn.disabled = accountsBusy || !st?.hasActiveToken;
      saveBtn.textContent = st?.currentUnsaved ? t('accounts.saveCurrent') : t('accounts.updateSnapshot');
    }
    if (addBtn) {
      addBtn.disabled = accountsBusy || agyBlocked;
    }
    if (listEl) {
      listEl.replaceChildren();
      if (profiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ctx-client-lang-note';
        empty.textContent = t('accounts.emptyHint');
        listEl.appendChild(empty);
      } else {
        for (const p of profiles) {
          const row = document.createElement('div');
          row.className = 'acc-settings-row';
          const left = document.createElement('div');
          left.className = 'acc-settings-row-info';
          const name = document.createElement('strong');
          name.textContent = formatAccountPrimaryName(p);
          const sub = document.createElement('span');
          const subParts = [];
          if (p.label && p.email) subParts.push(p.email);
          if (p.tierName) subParts.push(p.tierName);
          if (p.vaultPresent === false) subParts.push(t('accounts.vaultMissing'));
          sub.textContent = subParts.join(' · ') || p.id;
          left.appendChild(name);
          left.appendChild(sub);

          const right = document.createElement('div');
          right.className = 'acc-settings-row-actions';
          if (p.isActive) {
            const cur = document.createElement('span');
            cur.className = 'key-pill pill-ok';
            cur.textContent = t('accounts.pill.current');
            right.appendChild(cur);
          } else {
            const swBtn = document.createElement('button');
            swBtn.type = 'button';
            swBtn.className = 'unlock-btn unlock-btn-primary acc-settings-mini-btn';
            swBtn.textContent = accountsPendingSwitchId === p.id ? t('accounts.switchConfirmGo') : t('accounts.switchBtn');
            swBtn.disabled = accountsBusy || agyBlocked || p.vaultPresent === false;
            swBtn.addEventListener('click', () => {
              if (accountsPendingSwitchId === p.id) {
                accountsPendingSwitchId = null;
                void handleSwitchAccountAction(p.id);
              } else {
                accountsPendingSwitchId = p.id;
                accountsAddConfirmOpen = false;
                accountsPendingDeleteId = null;
                renderAccountsUI();
              }
            });
            right.appendChild(swBtn);
          }
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'unlock-btn unlock-btn-secondary acc-settings-mini-btn';
          delBtn.textContent = accountsPendingDeleteId === p.id ? t('accounts.confirmDelete') : t('accounts.deleteBtn');
          delBtn.disabled = accountsBusy;
          delBtn.addEventListener('click', () => {
            if (accountsPendingDeleteId === p.id) {
              accountsPendingDeleteId = null;
              void handleRemoveAccountAction(p.id);
            } else {
              accountsPendingDeleteId = p.id;
              accountsPendingSwitchId = null;
              renderAccountsUI();
            }
          });
          right.appendChild(delBtn);

          row.appendChild(left);
          row.appendChild(right);
          listEl.appendChild(row);
        }
      }
    }
    if (statusBox && statusText && accDom.statusBox) {
      if (accDom.statusBox.hidden) {
        statusBox.style.display = 'none';
      } else {
        const tone = accDom.statusBox.getAttribute('data-tone');
        statusBox.style.display = 'block';
        statusBox.className = `unlock-result-box ${tone === 'danger' ? 'result-error' : 'result-success'}`;
        statusText.textContent = accDom.statusText?.textContent || '';
      }
    }
  }

  function syncQuotaCardAccountsButton() {
    syncLoginPageFallbackPill();
    if (typeof qDom === 'undefined' || !qDom?.accountsBtn) return;
    const available = isAccountSwitcherAvailable();
    qDom.accountsBtn.hidden = !available;
    if (!available) return;
    const count = Array.isArray(accountsState?.profiles) ? accountsState.profiles.length : 0;
    const hint = getLiveAccountIdentityHint();
    const email = accountsState?.activeEmail || hint.currentEmail || '';
    const tip = count > 0
      ? t('accounts.btnTitleCount', { email: email || t('accounts.unknownEmail'), n: count })
      : t('accounts.btnTitle');
    qDom.accountsBtn.setAttribute('aria-label', tip);
    qDom.accountsBtn.setAttribute('title', tip);
    qDom.accountsBtn.setAttribute('aria-expanded', String(accountsPopoverOpen));
    qDom.accountsBtn.setAttribute('data-has-accounts', count > 0 ? 'true' : 'false');
  }

  function renderAccountsPopover() {
    if (!accDom.popover) return;
    const st = accountsState;
    const profiles = Array.isArray(st?.profiles) ? st.profiles : [];
    const hint = getLiveAccountIdentityHint();
    const activeEmail = st?.activeEmail || hint.currentEmail || '';
    const activeTier = st?.keychainLiveMismatch
      ? (st?.activeTierName || '')
      : (st?.activeTierName || hint.currentTierName || '');
    const agyBlocked = Boolean(st?.agyCliRunning);

    if (accDom.currentEmail) {
      if (!st) accDom.currentEmail.textContent = t('accounts.loading');
      else if (!st.hasActiveToken) accDom.currentEmail.textContent = t('accounts.notSignedIn');
      else accDom.currentEmail.textContent = activeEmail || t('accounts.unknownEmail');
    }
    if (accDom.currentPill) {
      if (!st || !st.hasActiveToken) {
        accDom.currentPill.hidden = true;
      } else {
        accDom.currentPill.hidden = false;
        accDom.currentPill.className = `acc-pill ${st.currentUnsaved ? 'is-warn' : 'is-ok'}`;
        accDom.currentPill.textContent = st.currentUnsaved ? t('accounts.pill.unsaved') : t('accounts.pill.saved');
      }
    }
    if (accDom.currentTier) {
      if (st?.hasActiveToken && activeTier) {
        accDom.currentTier.hidden = false;
        accDom.currentTier.textContent = activeTier;
      } else {
        accDom.currentTier.hidden = true;
      }
    }
    if (accDom.saveCurrentBtn) {
      accDom.saveCurrentBtn.disabled = accountsBusy || !st?.hasActiveToken;
      accDom.saveCurrentBtn.textContent = st?.currentUnsaved ? t('accounts.saveCurrent') : t('accounts.updateSnapshot');
      accDom.saveCurrentBtn.className = st?.currentUnsaved ? 'acc-btn acc-btn-primary' : 'acc-btn';
    }
    if (accDom.agyWarn) {
      accDom.agyWarn.hidden = !agyBlocked;
      if (agyBlocked) {
        accDom.agyWarn.textContent = t('accounts.agyBlockedBanner', {
          pids: (st.agyCliPids || []).join(', ')
        });
      }
    }
    if (accDom.savedCount) {
      accDom.savedCount.textContent = String(profiles.length);
    }

    const pendingTarget = accountsPendingSwitchId
      ? profiles.find((p) => p.id === accountsPendingSwitchId)
      : null;
    if (accDom.switchConfirm) {
      accDom.switchConfirm.hidden = !pendingTarget;
      if (pendingTarget && accDom.switchConfirmText) {
        accDom.switchConfirmText.textContent = t('accounts.switchConfirmText', {
          name: formatAccountPrimaryName(pendingTarget)
        });
      }
    }
    if (accDom.switchGoBtn) {
      accDom.switchGoBtn.disabled = accountsBusy || agyBlocked;
    }

    if (accDom.addConfirm) {
      accDom.addConfirm.hidden = !accountsAddConfirmOpen;
    }
    if (accDom.addBtn) {
      accDom.addBtn.disabled = accountsBusy || agyBlocked;
    }
    if (accDom.addGoBtn) {
      accDom.addGoBtn.disabled = accountsBusy || agyBlocked;
    }

    if (accDom.list) {
      accDom.list.replaceChildren();
      if (profiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'acc-empty';
        empty.textContent = t('accounts.emptyHint');
        accDom.list.appendChild(empty);
      } else {
        for (const p of profiles) {
          const isEditing = accountsEditingId === p.id;
          const canSwitch = !p.isActive && !accountsBusy && !agyBlocked && p.vaultPresent !== false && !isEditing;
          const row = document.createElement('div');
          row.className = `acc-row${p.isActive ? ' is-active' : ''}${canSwitch ? ' is-clickable' : ''}`;
          row.setAttribute('data-account-id', p.id);

          const avatar = document.createElement('span');
          avatar.className = 'acc-avatar';
          avatar.textContent = formatAccountInitial(p);

          const meta = document.createElement('div');
          meta.className = 'acc-meta';

          if (isEditing) {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'acc-rename-input';
            input.maxLength = 64;
            input.value = accountsEditingValue;
            input.placeholder = t('accounts.renamePlaceholder');
            input.addEventListener('click', (e) => e?.stopPropagation?.());
            input.addEventListener('input', (e) => {
              accountsEditingValue = e.target.value;
            });
            input.addEventListener('keydown', (e) => {
              e?.stopPropagation?.();
              if (e.key === 'Enter') {
                e.preventDefault?.();
                void handleRenameAccountAction(p.id, accountsEditingValue);
              } else if (e.key === 'Escape') {
                e.preventDefault?.();
                accountsEditingId = null;
                accountsEditingValue = '';
                renderAccountsUI();
              }
            });
            meta.appendChild(input);
            setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
          } else {
            const name = document.createElement('div');
            name.className = 'acc-name';
            name.textContent = formatAccountPrimaryName(p);
            const sub = document.createElement('div');
            sub.className = 'acc-sub';
            const subParts = [];
            if (p.label && p.email) subParts.push(p.email);
            if (p.tierName) subParts.push(p.tierName);
            if (p.vaultPresent === false) subParts.push(t('accounts.vaultMissing'));
            sub.textContent = subParts.join(' · ') || p.email || p.id;
            meta.appendChild(name);
            meta.appendChild(sub);
          }

          const actions = document.createElement('div');
          actions.className = 'acc-row-actions';

          if (isEditing) {
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'acc-btn acc-btn-primary';
            okBtn.textContent = t('accounts.renameSave');
            okBtn.disabled = accountsBusy;
            okBtn.addEventListener('click', (e) => {
              e?.stopPropagation?.();
              void handleRenameAccountAction(p.id, accountsEditingValue);
            });
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'acc-btn';
            cancelBtn.textContent = t('accounts.cancel');
            cancelBtn.addEventListener('click', (e) => {
              e?.stopPropagation?.();
              accountsEditingId = null;
              accountsEditingValue = '';
              renderAccountsUI();
            });
            actions.appendChild(okBtn);
            actions.appendChild(cancelBtn);
          } else {
            if (p.isActive) {
              const cur = document.createElement('span');
              cur.className = 'acc-pill is-ok';
              cur.textContent = t('accounts.pill.current');
              actions.appendChild(cur);
            } else {
              const swBtn = document.createElement('button');
              swBtn.type = 'button';
              swBtn.className = 'acc-btn acc-btn-primary';
              swBtn.textContent = t('accounts.switchBtn');
              swBtn.disabled = !canSwitch;
              swBtn.addEventListener('click', (e) => {
                e?.stopPropagation?.();
                accountsPendingSwitchId = p.id;
                accountsAddConfirmOpen = false;
                accountsPendingDeleteId = null;
                renderAccountsUI();
              });
              actions.appendChild(swBtn);
            }

            const renameBtn = document.createElement('button');
            renameBtn.type = 'button';
            renameBtn.className = 'acc-mini-icon-btn';
            renameBtn.textContent = '✎';
            renameBtn.title = t('accounts.renameTip');
            renameBtn.setAttribute('aria-label', t('accounts.renameTip'));
            renameBtn.disabled = accountsBusy;
            renameBtn.addEventListener('click', (e) => {
              e?.stopPropagation?.();
              accountsEditingId = p.id;
              accountsEditingValue = p.label || '';
              accountsPendingSwitchId = null;
              accountsAddConfirmOpen = false;
              accountsPendingDeleteId = null;
              renderAccountsUI();
            });
            actions.appendChild(renameBtn);

            if (accountsPendingDeleteId === p.id) {
              const confirmDel = document.createElement('button');
              confirmDel.type = 'button';
              confirmDel.className = 'acc-btn acc-btn-danger';
              confirmDel.textContent = t('accounts.confirmDelete');
              confirmDel.disabled = accountsBusy;
              confirmDel.addEventListener('click', (e) => {
                e?.stopPropagation?.();
                accountsPendingDeleteId = null;
                void handleRemoveAccountAction(p.id);
              });
              actions.appendChild(confirmDel);
            } else {
              const delBtn = document.createElement('button');
              delBtn.type = 'button';
              delBtn.className = 'acc-mini-icon-btn is-danger';
              delBtn.textContent = '×';
              delBtn.title = t('accounts.deleteTip');
              delBtn.setAttribute('aria-label', t('accounts.deleteTip'));
              delBtn.disabled = accountsBusy;
              delBtn.addEventListener('click', (e) => {
                e?.stopPropagation?.();
                accountsPendingDeleteId = p.id;
                accountsPendingSwitchId = null;
                accountsAddConfirmOpen = false;
                renderAccountsUI();
              });
              actions.appendChild(delBtn);
            }
          }

          if (canSwitch) {
            row.addEventListener('click', () => {
              accountsPendingSwitchId = p.id;
              accountsAddConfirmOpen = false;
              accountsPendingDeleteId = null;
              renderAccountsUI();
            });
          }

          row.appendChild(avatar);
          row.appendChild(meta);
          row.appendChild(actions);
          accDom.list.appendChild(row);
        }
      }
    }
  }

  function renderAccountsUI() {
    syncQuotaCardAccountsButton();
    renderAccountsPopover();
    renderAccountsSettingsCard();
    if (accountsPopoverOpen) positionAccountsPopover();
  }

  function positionAccountsPopover() {
    if (!accountsPopoverOpen || !accDom.popover) return;
    const anchor = accountsAnchorEl || (typeof qDom !== 'undefined' ? (qDom.accountsBtn || qDom.card) : null);
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const popW = Math.min(320, Math.max(248, vw - 24));
    const popH = accDom.popover.offsetHeight || 340;
    let left = 12;
    let top = Math.max(12, vh - popH - 12);
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        left = Math.min(Math.max(12, rect.left), Math.max(12, vw - popW - 12));
        if (rect.top - popH - 8 >= 12) {
          top = rect.top - popH - 8;
        } else {
          top = Math.min(Math.max(12, rect.bottom + 8), Math.max(12, vh - popH - 12));
        }
      }
    }
    accDom.popover.style.width = `${popW}px`;
    accDom.popover.style.left = `${Math.round(left)}px`;
    accDom.popover.style.top = `${Math.round(top)}px`;
    accDom.popover.style.bottom = 'auto';
  }

  function closeAccountsPopover() {
    if (!accountsPopoverOpen) return;
    accountsPopoverOpen = false;
    accountsAddConfirmOpen = false;
    accountsPendingSwitchId = null;
    accountsPendingDeleteId = null;
    accountsEditingId = null;
    accountsEditingValue = '';
    if (accDom.popover) accDom.popover.hidden = true;
    syncQuotaCardAccountsButton();
  }

  function openAccountsPopover(anchorEl = null) {
    if (!isAccountSwitcherAvailable()) return;
    if (typeof closeModelShortcutsPopover === 'function') closeModelShortcutsPopover();
    if (!ensureAccountsHostMounted()) return;
    syncAccountsTheme();
    accountsAnchorEl = anchorEl || (typeof qDom !== 'undefined' ? qDom.accountsBtn : null);
    accountsPopoverOpen = true;
    accountsAddConfirmOpen = false;
    accountsPendingSwitchId = null;
    accountsPendingDeleteId = null;
    accountsEditingId = null;
    if (accDom.popover) accDom.popover.hidden = false;
    renderAccountsUI();
    positionAccountsPopover();
    const hint = getLiveAccountIdentityHint();
    const shouldRefreshLive = Boolean(
      !hint.currentEmail ||
      !accountsState ||
      accountsState.hasActiveToken === false ||
      accountsState.keychainLiveMismatch === true ||
      (typeof lastHistorySync === 'number' && Date.now() - lastHistorySync >= 15000)
    );
    void refreshAccountsStatus({ silent: true, refreshLiveIdentity: shouldRefreshLive });
  }

  function toggleAccountsPopover(anchorEl = null) {
    if (accountsPopoverOpen) closeAccountsPopover();
    else openAccountsPopover(anchorEl);
  }

  function surfaceLastColdSwitchFeedback(lastRes) {
    if (!lastRes || typeof lastRes !== 'object' || !lastRes.completedAt) return;
    if (accountsConsumedLastResultAt === lastRes.completedAt) return;
    const completedMs = Date.parse(lastRes.completedAt);
    if (!Number.isFinite(completedMs) || Math.abs(Date.now() - completedMs) > 120000) return;
    accountsConsumedLastResultAt = lastRes.completedAt;
    if (lastRes.ok === false && lastRes.error) {
      showAccountsStatus(t('accounts.msg.coldFailed', { err: lastRes.error }), 'danger');
      if (typeof showModelSwitchToast === 'function') {
        showModelSwitchToast(t('accounts.msg.coldFailed', { err: lastRes.error }));
      }
    } else if (lastRes.ok === true && lastRes.action === 'switch' && lastRes.switchedTo) {
      const name = formatAccountPrimaryName(lastRes.switchedTo);
      const msg = lastRes.autoSavedPrevious
        ? t('accounts.msg.switchedAutoSaved', { name })
        : t('accounts.msg.switched', { name });
      showAccountsStatus(msg, 'ok');
      if (typeof showModelSwitchToast === 'function') {
        showModelSwitchToast(t('accounts.toast.switched', { name }));
      }
    }
  }

  async function refreshAccountsStatus(opts = {}) {
    if (!isAccountSwitcherAvailable()) {
      accountsState = { ok: false, supported: false, profiles: [] };
      renderAccountsUI();
      return accountsState;
    }
    try {
      if (opts.refreshLiveIdentity === true && typeof syncTokenHistoryFromHost === 'function') {
        try { await syncTokenHistoryFromHost(true); } catch {}
      }
      const res = await invokeAccountsApi('status', {
        consumeLastResult: opts.consumeLastResult === true
      });
      accountsState = res;
      if (res && res.lastColdResult) {
        surfaceLastColdSwitchFeedback(res.lastColdResult);
      }
      if (res && res.ok && res.keychainLiveMismatch && res.liveSessionEmail && res.activeEmail) {
        accountsShowingMismatchWarn = true;
        showAccountsStatus(
          t('accounts.msg.identityMismatch', { live: res.liveSessionEmail, keychain: res.activeEmail }),
          'warn'
        );
      } else if (accountsShowingMismatchWarn) {
        accountsShowingMismatchWarn = false;
        showAccountsStatus('');
      }
      if (!opts.silent && res && !res.ok && res.error) {
        accountsShowingMismatchWarn = false;
        showAccountsStatus(res.error, 'danger');
      }
      renderAccountsUI();
      return res;
    } catch (err) {
      const fallback = { ok: false, supported: true, error: err?.message || t('msg.unknownErr'), profiles: [] };
      accountsState = fallback;
      if (!opts.silent) showAccountsStatus(fallback.error, 'danger');
      renderAccountsUI();
      return fallback;
    }
  }

  async function handleSaveCurrentAccountAction() {
    if (accountsBusy) return;
    accountsBusy = true;
    accountsPendingDeleteId = null;
    accountsPendingSwitchId = null;
    renderAccountsUI();
    try {
      const hint = getLiveAccountIdentityHint();
      const res = await invokeAccountsApi('save', {
        email: hint.currentEmail,
        tierName: hint.currentTierName
      });
      if (res && res.ok) {
        if (res.status) accountsState = res.status;
        const name = formatAccountPrimaryName(res.profile);
        showAccountsStatus(t('accounts.msg.saved', { name }), 'ok');
        if (typeof showModelSwitchToast === 'function') {
          showModelSwitchToast(t('accounts.msg.saved', { name }));
        }
      } else {
        showAccountsStatus(res?.error || t('accounts.err.saveFail'), 'danger');
      }
    } catch (err) {
      showAccountsStatus(err?.message || t('accounts.err.saveFail'), 'danger');
    } finally {
      accountsBusy = false;
      renderAccountsUI();
    }
  }

  async function handleSwitchAccountAction(targetId) {
    if (accountsBusy || !targetId) return;
    accountsBusy = true;
    accountsAddConfirmOpen = false;
    accountsPendingSwitchId = null;
    accountsPendingDeleteId = null;
    renderAccountsUI();
    try {
      const hint = getLiveAccountIdentityHint();
      const res = await invokeAccountsApi('switch', {
        targetId,
        currentEmail: hint.currentEmail,
        currentTierName: hint.currentTierName
      });
      if (res && res.ok && res.coldSwitching) {
        const name = formatAccountPrimaryName(res.targetProfile);
        showAccountsStatus(t('accounts.msg.coldSwitching', { name }), 'ok');
        return;
      }
      showAccountsStatus(res?.error || t('accounts.err.switchFail'), 'danger');
      accountsBusy = false;
      renderAccountsUI();
    } catch (err) {
      showAccountsStatus(err?.message || t('accounts.err.switchFail'), 'danger');
      accountsBusy = false;
      renderAccountsUI();
    }
  }

  async function handlePrepareAddAccountAction() {
    if (accountsBusy) return;
    accountsBusy = true;
    accountsAddConfirmOpen = false;
    accountsPendingSwitchId = null;
    accountsPendingDeleteId = null;
    renderAccountsUI();
    try {
      const hint = getLiveAccountIdentityHint();
      const res = await invokeAccountsApi('prepare-add', {
        currentEmail: hint.currentEmail,
        currentTierName: hint.currentTierName
      });
      if (res && res.ok && res.coldSwitching) {
        showAccountsStatus(t('accounts.msg.coldPreparingAdd'), 'warn');
        return;
      }
      showAccountsStatus(res?.error || t('accounts.err.addFail'), 'danger');
      accountsBusy = false;
      renderAccountsUI();
    } catch (err) {
      showAccountsStatus(err?.message || t('accounts.err.addFail'), 'danger');
      accountsBusy = false;
      renderAccountsUI();
    }
  }

  async function handleRenameAccountAction(targetId, nextLabel) {
    if (accountsBusy || !targetId) return;
    accountsBusy = true;
    renderAccountsUI();
    try {
      const res = await invokeAccountsApi('rename', { targetId, label: String(nextLabel || '').trim() });
      if (res && res.ok) {
        if (res.status) accountsState = res.status;
        accountsEditingId = null;
        accountsEditingValue = '';
        showAccountsStatus(t('accounts.msg.renamed'), 'ok');
      } else {
        showAccountsStatus(res?.error || t('accounts.err.renameFail'), 'danger');
      }
    } catch (err) {
      showAccountsStatus(err?.message || t('accounts.err.renameFail'), 'danger');
    } finally {
      accountsBusy = false;
      renderAccountsUI();
    }
  }

  async function handleRemoveAccountAction(targetId) {
    if (accountsBusy || !targetId) return;
    accountsBusy = true;
    renderAccountsUI();
    try {
      const res = await invokeAccountsApi('remove', { targetId });
      if (res && res.ok) {
        if (res.status) accountsState = res.status;
        showAccountsStatus(t('accounts.msg.removed'), 'ok');
      } else {
        showAccountsStatus(res?.error || t('accounts.err.removeFail'), 'danger');
      }
    } catch (err) {
      showAccountsStatus(err?.message || t('accounts.err.removeFail'), 'danger');
    } finally {
      accountsBusy = false;
      renderAccountsUI();
    }
  }

  function onAccountsOutsideMouseDown(e) {
    if (!accountsPopoverOpen) return;
    const path = typeof e?.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(accountsHost) || (typeof qDom !== 'undefined' && qDom.accountsBtn && path.includes(qDom.accountsBtn))) {
      return;
    }
    closeAccountsPopover();
  }

  function onAccountsKeydown(e) {
    if (accountsPopoverOpen && e?.key === 'Escape') {
      if (accountsEditingId) {
        e.preventDefault?.();
        accountsEditingId = null;
        accountsEditingValue = '';
        renderAccountsUI();
        return;
      }
      e.preventDefault?.();
      closeAccountsPopover();
    }
  }

  try {
    document.addEventListener?.('mousedown', onAccountsOutsideMouseDown, true);
    window.addEventListener?.('keydown', onAccountsKeydown, true);
    window.addEventListener?.('resize', positionAccountsPopover);
  } catch {}

  accDom.loginPill?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    toggleAccountsPopover(accDom.loginPill);
  });
  accDom.closeBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    closeAccountsPopover();
  });
  accDom.refreshBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    void refreshAccountsStatus({ refreshLiveIdentity: true });
  });
  accDom.saveCurrentBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    void handleSaveCurrentAccountAction();
  });
  accDom.switchCancelBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    accountsPendingSwitchId = null;
    renderAccountsUI();
  });
  accDom.switchGoBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    if (accountsPendingSwitchId) {
      void handleSwitchAccountAction(accountsPendingSwitchId);
    }
  });
  accDom.addBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    accountsAddConfirmOpen = !accountsAddConfirmOpen;
    accountsPendingSwitchId = null;
    accountsPendingDeleteId = null;
    accountsEditingId = null;
    renderAccountsUI();
  });
  accDom.addCancelBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    accountsAddConfirmOpen = false;
    renderAccountsUI();
  });
  accDom.addGoBtn?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    void handlePrepareAddAccountAction();
  });

  // 绑定「配置」页兜底账号卡片按钮
  el('btn-accounts-settings-save')?.addEventListener('click', () => {
    void handleSaveCurrentAccountAction();
  });
  el('btn-accounts-settings-add')?.addEventListener('click', () => {
    openAccountsPopover(el('btn-accounts-settings-add'));
    accountsAddConfirmOpen = true;
    renderAccountsUI();
  });
  el('btn-accounts-settings-refresh')?.addEventListener('click', () => {
    void refreshAccountsStatus({ refreshLiveIdentity: true });
  });

  function getAccountsUiSnapshotForTest() {
    return {
      available: isAccountSwitcherAvailable(),
      popoverOpen: accountsPopoverOpen,
      loginPillVisible: Boolean(accDom.loginPill && !accDom.loginPill.hidden),
      addConfirmOpen: accountsAddConfirmOpen,
      pendingSwitchId: accountsPendingSwitchId,
      pendingDeleteId: accountsPendingDeleteId,
      editingId: accountsEditingId,
      busy: accountsBusy,
      state: accountsState,
      currentEmailText: accDom.currentEmail?.textContent || '',
      savedCountText: accDom.savedCount?.textContent || '',
      agyWarnVisible: Boolean(accDom.agyWarn && !accDom.agyWarn.hidden),
      statusHidden: Boolean(accDom.statusBox?.hidden),
      statusText: accDom.statusText?.textContent || ''
    };
  }

  function disposeAccountSwitcher() {
    closeAccountsPopover();
    try { document.removeEventListener?.('mousedown', onAccountsOutsideMouseDown, true); } catch {}
    try { window.removeEventListener?.('keydown', onAccountsKeydown, true); } catch {}
    try { window.removeEventListener?.('resize', positionAccountsPopover); } catch {}
    try { accountsHost.remove(); } catch {}
  }