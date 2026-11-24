  // =========================================================================
  // 左下角当前模型额度模块：独立 Shadow DOM 宿主、侧栏流式停靠/收起记忆、双同心环与持久化
  // =========================================================================
  const QUOTA_DOT_OUTER_CIRC = 2 * Math.PI * 7.75;
  const QUOTA_DOT_INNER_CIRC = 2 * Math.PI * 4.35;
  const QUOTA_WINDOW_I18N_MAP = {
    '5h': 'quota.window.5h',
    '5_hour': 'quota.window.5h',
    '5 hours': 'quota.window.5h',
    daily: 'quota.window.daily',
    day: 'quota.window.daily',
    '24h': 'quota.window.daily',
    weekly: 'quota.window.weekly',
    week: 'quota.window.weekly',
    '7d': 'quota.window.weekly'
  };

  var quotaHost = document.createElement('div');
  quotaHost.id = 'ag-model-quota-host';
  quotaHost.setAttribute('data-dock', 'sidebar');
  quotaHost.hidden = true;
  var quotaShadow = quotaHost.attachShadow({ mode: 'open' });
  quotaShadow.innerHTML = `<style>
    :host{
      display:block;flex-shrink:0;width:100%;box-sizing:border-box;
      -webkit-app-region:no-drag;user-select:none;
      --ag-quota-bg:var(--ag-custom-panel-bg,rgba(255,255,255,0.035));
      --ag-quota-fixed-bg:var(--ag-custom-panel-bg,rgba(24,24,27,0.88));
      --ag-quota-border:rgba(255,255,255,0.09);
      --ag-quota-border-hover:rgba(255,255,255,0.16);
      --ag-quota-text:#ececef;
      --ag-quota-sub:#a1a1aa;
      --ag-quota-muted:#71717a;
      --ag-quota-track:rgba(255,255,255,0.10);
      --ag-quota-dot-track:rgba(255,255,255,0.16);
      --ag-quota-fill:linear-gradient(90deg,#8b5cf6,#a78bfa);
      --ag-quota-5h-fill:linear-gradient(90deg,#6366f1,#818cf8);
      --ag-quota-warn:#f59e0b;
      --ag-quota-warn-bar:linear-gradient(90deg,#d97706,#f59e0b);
      --ag-quota-danger:#ef4444;
      --ag-quota-danger-bar:linear-gradient(90deg,#dc2626,#ef4444);
      --ag-quota-accent-solid:#a78bfa;
      --ag-quota-5h-solid:#818cf8;
      --ag-quota-btn-hover:rgba(255,255,255,0.09);
      --ag-quota-shadow:0 8px 24px rgba(0,0,0,0.36),0 1px 4px rgba(0,0,0,0.22);
      color-scheme:dark;
    }
    :host([hidden]){display:none!important}
    :host([data-dock="sidebar"]){padding:4px 8px 6px}
    :host([data-dock="sidebar"][data-minimized="true"]){padding:2px 10px 6px}
    :host([data-dock="fixed"]){
      position:fixed;left:12px;bottom:12px;z-index:2147482000;
      width:222px;max-width:calc(100vw - 24px);
    }
    :host([data-dock="fixed"][data-minimized="true"]){width:auto}
    :host([data-theme="light"]),
    :host([data-panel-tone="light"]){
      --ag-quota-bg:var(--ag-custom-panel-bg,rgba(0,0,0,0.028));
      --ag-quota-fixed-bg:var(--ag-custom-panel-bg,rgba(255,255,255,0.92));
      --ag-quota-border:rgba(0,0,0,0.09);
      --ag-quota-border-hover:rgba(0,0,0,0.16);
      --ag-quota-text:#18181b;
      --ag-quota-sub:#52525b;
      --ag-quota-muted:#71717a;
      --ag-quota-track:rgba(0,0,0,0.08);
      --ag-quota-dot-track:rgba(0,0,0,0.13);
      --ag-quota-fill:linear-gradient(90deg,#7c3aed,#8b5cf6);
      --ag-quota-5h-fill:linear-gradient(90deg,#4f46e5,#6366f1);
      --ag-quota-warn:#d97706;
      --ag-quota-warn-bar:linear-gradient(90deg,#b45309,#f59e0b);
      --ag-quota-danger:#dc2626;
      --ag-quota-danger-bar:linear-gradient(90deg,#b91c1c,#ef4444);
      --ag-quota-accent-solid:#7c3aed;
      --ag-quota-5h-solid:#6366f1;
      --ag-quota-btn-hover:rgba(0,0,0,0.07);
      --ag-quota-shadow:0 6px 20px rgba(0,0,0,0.12),0 1px 3px rgba(0,0,0,0.06);
      color-scheme:light;
    }
    .sr-only{
      position:absolute!important;width:1px!important;height:1px!important;
      padding:0!important;margin:-1px!important;overflow:hidden!important;
      clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
    }
    #model-quota{
      box-sizing:border-box;width:100%;padding:7px 9px 8px;
      border:1px solid var(--ag-quota-border);border-radius:10px;
      background:var(--ag-quota-bg);color:var(--ag-quota-text);
      font:11px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      transition:border-color .16s ease,background-color .16s ease;
    }
    #model-quota[hidden]{display:none!important}
    #model-quota:hover{border-color:var(--ag-quota-border-hover)}
    :host([data-dock="fixed"]) #model-quota{
      background:var(--ag-quota-fixed-bg);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      box-shadow:var(--ag-quota-shadow);
    }
    .model-quota-header{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:18px}
    #model-quota-label{
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:11.5px;font-weight:600;letter-spacing:-0.015em;color:var(--ag-quota-text);
    }
    .model-quota-actions{flex-shrink:0;display:inline-flex;align-items:center;gap:2px}
    .model-quota-actions .quota-icon-btn:not(#model-quota-display-mode){opacity:0.55}
    #model-quota:hover .quota-icon-btn,.model-quota-actions .quota-icon-btn:not(#model-quota-display-mode):focus-visible{opacity:1}
    .quota-icon-btn{
      position:relative;display:inline-flex;align-items:center;justify-content:center;
      width:18px;height:18px;padding:0;border:0;border-radius:5px;
      background:transparent;color:var(--ag-quota-sub);cursor:pointer;
      transition:background-color .14s ease,color .14s ease;
    }
    #model-quota-display-mode{width:auto;min-width:28px;padding:0 4px;font:inherit;font-size:10px;white-space:nowrap}
    .quota-icon-btn[hidden]{display:none!important}
    .quota-icon-btn:hover{background:var(--ag-quota-btn-hover);color:var(--ag-quota-text)}
    .quota-icon-btn svg{width:13px;height:13px;display:block;transition:transform .16s ease}
    #model-quota-toggle-5h[aria-pressed="false"] svg{transform:rotate(180deg)}
    .quota-5h-alert-dot{
      position:absolute;top:2px;right:2px;width:4px;height:4px;border-radius:999px;
      background:var(--ag-quota-warn);pointer-events:none;
    }
    .quota-5h-alert-dot[hidden]{display:none!important}
    .quota-5h-alert-dot[data-level="danger"]{background:var(--ag-quota-danger)}
    .quota-row{margin-top:6px}
    .quota-row[hidden]{display:none!important}
    .quota-row-5h{margin-top:7px}
    .quota-row-meta{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:10.5px;line-height:1.2}
    .quota-row-left{min-width:0;display:flex;align-items:baseline;gap:4px;overflow:hidden;white-space:nowrap}
    .quota-row-title{flex-shrink:0;color:var(--ag-quota-sub);font-weight:500}
    .quota-row-reset{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ag-quota-muted);font-size:10px}
    .quota-row-reset[hidden]{display:none!important}
    .quota-row-pct{flex-shrink:0;font-variant-numeric:tabular-nums;color:var(--ag-quota-sub);font-weight:500}
    .quota-row[data-state="warn"] .quota-row-pct{color:var(--ag-quota-warn);font-weight:600}
    .quota-row[data-state="danger"] .quota-row-pct{color:var(--ag-quota-danger);font-weight:600}
    .quota-track{position:relative;width:100%;height:4px;margin-top:4px;overflow:hidden;border-radius:999px;background:var(--ag-quota-track)}
    .quota-row-5h .quota-track{height:3px}
    .quota-fill{height:100%;width:0%;border-radius:999px;background:var(--ag-quota-fill);transition:width .28s cubic-bezier(0.22,1,0.36,1),background .16s ease}
    .quota-row-5h .quota-fill{background:var(--ag-quota-5h-fill)}
    .quota-row[data-state="warn"] .quota-fill{background:var(--ag-quota-warn-bar)}
    .quota-row[data-state="danger"] .quota-fill{background:var(--ag-quota-danger-bar)}
    #model-quota-dot{
      display:inline-flex;align-items:center;justify-content:center;
      width:26px;height:26px;padding:0;border:1px solid var(--ag-quota-border);
      border-radius:999px;background:var(--ag-quota-bg);cursor:pointer;
      transition:transform .15s ease,border-color .15s ease,background-color .15s ease;
    }
    #model-quota-dot[hidden]{display:none!important}
    :host([data-dock="fixed"]) #model-quota-dot{
      background:var(--ag-quota-fixed-bg);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      box-shadow:var(--ag-quota-shadow);
    }
    #model-quota-dot:hover{transform:scale(1.08);border-color:var(--ag-quota-border-hover)}
    #model-quota-dot svg{width:20px;height:20px;display:block}
    .quota-dot-track{stroke:var(--ag-quota-dot-track);fill:none}
    .quota-dot-track-outer{stroke-width:2.1}
    .quota-dot-track-inner{stroke-width:2}
    .quota-dot-track[hidden],.quota-dot-ring[hidden]{display:none!important}
    .quota-dot-ring{fill:none;stroke-linecap:round;transition:stroke-dasharray .24s ease,stroke .16s ease,stroke-opacity .16s ease}
    .quota-dot-ring-outer{stroke:var(--ag-quota-accent-solid);stroke-width:2.1}
    .quota-dot-ring-inner{stroke:var(--ag-quota-5h-solid);stroke-width:2}
    .quota-dot-ring[data-state="warn"]{stroke:var(--ag-quota-warn)}
    .quota-dot-ring[data-state="danger"]{stroke:var(--ag-quota-danger)}
    .quota-dot-ring[data-state="unknown"]{stroke:var(--ag-quota-muted)}
  </style>
  <button id="model-quota-dot" type="button" hidden aria-label="展开模型额度">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle id="model-quota-dot-outer-track" class="quota-dot-track quota-dot-track-outer" cx="10" cy="10" r="7.75"></circle>
      <circle id="model-quota-dot-outer-ring" class="quota-dot-ring quota-dot-ring-outer" cx="10" cy="10" r="7.75" transform="rotate(-90 10 10)" stroke-dasharray="0 48.69" stroke-opacity="0" data-state="unknown"></circle>
      <circle id="model-quota-dot-inner-track" class="quota-dot-track quota-dot-track-inner" cx="10" cy="10" r="4.35" hidden></circle>
      <circle id="model-quota-dot-inner-ring" class="quota-dot-ring quota-dot-ring-inner" cx="10" cy="10" r="4.35" transform="rotate(-90 10 10)" stroke-dasharray="0 27.33" stroke-opacity="0" data-state="unknown" hidden></circle>
    </svg>
  </button>
  <div id="model-quota">
    <div class="model-quota-header">
      <span id="model-quota-label"></span>
      <span class="model-quota-actions">
        <button id="model-quota-display-mode" class="quota-icon-btn" type="button"></button>
        <button id="model-quota-toggle-5h" class="quota-icon-btn" type="button" hidden aria-pressed="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"></path></svg>
          <span id="model-quota-5h-alert-dot" class="quota-5h-alert-dot" hidden></span>
        </button>
        <button id="model-quota-minimize" class="quota-icon-btn" type="button">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 8h7"></path></svg>
        </button>
      </span>
    </div>
    <span id="model-quota-description" class="sr-only" data-i18n="quota.label">模型额度用量</span>
    <div id="model-quota-row-primary" class="quota-row" data-state="normal">
      <div class="quota-row-meta">
        <span class="quota-row-left">
          <span id="model-quota-primary-title" class="quota-row-title"></span>
          <span id="model-quota-primary-reset" class="quota-row-reset" hidden></span>
        </span>
        <span id="model-quota-amount" class="quota-row-pct"></span>
      </div>
      <div id="model-quota-progress" class="quota-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="model-quota-label model-quota-description" aria-describedby="model-quota-amount"><div id="model-quota-progress-fill" class="quota-fill"></div></div>
    </div>
    <div id="model-quota-row-5h" class="quota-row quota-row-5h" data-state="normal" hidden>
      <div class="quota-row-meta">
        <span class="quota-row-left">
          <span id="model-quota-5h-title" class="quota-row-title"></span>
          <span id="model-quota-5h-reset" class="quota-row-reset" hidden></span>
        </span>
        <span id="model-quota-5h-amount" class="quota-row-pct"></span>
      </div>
      <div id="model-quota-5h-progress" class="quota-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="model-quota-label model-quota-5h-title" aria-describedby="model-quota-5h-amount"><div id="model-quota-5h-progress-fill" class="quota-fill"></div></div>
    </div>
  </div>`;

  const qEl = id => quotaShadow.getElementById(id);
  const qDom = {
    card: qEl('model-quota'),
    dotBtn: qEl('model-quota-dot'),
    dotOuterRing: qEl('model-quota-dot-outer-ring'),
    dotInnerTrack: qEl('model-quota-dot-inner-track'),
    dotInnerRing: qEl('model-quota-dot-inner-ring'),
    label: qEl('model-quota-label'),
    displayModeBtn: qEl('model-quota-display-mode'),
    toggle5hBtn: qEl('model-quota-toggle-5h'),
    alertDot5h: qEl('model-quota-5h-alert-dot'),
    minimizeBtn: qEl('model-quota-minimize'),
    primary: {
      row: qEl('model-quota-row-primary'),
      title: qEl('model-quota-primary-title'),
      reset: qEl('model-quota-primary-reset'),
      amount: qEl('model-quota-amount'),
      progress: qEl('model-quota-progress'),
      fill: qEl('model-quota-progress-fill')
    },
    fiveHour: {
      row: qEl('model-quota-row-5h'),
      title: qEl('model-quota-5h-title'),
      reset: qEl('model-quota-5h-reset'),
      amount: qEl('model-quota-5h-amount'),
      progress: qEl('model-quota-5h-progress'),
      fill: qEl('model-quota-5h-progress-fill')
    }
  };

  function qSetText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }
  function qSetAttr(node, name, val) {
    if (!node) return;
    if (val === null || val === undefined) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== String(val)) {
      node.setAttribute(name, String(val));
    }
  }
  function qSetHidden(node, hidden, syncAttr = false) {
    if (!node) return;
    node.hidden = Boolean(hidden);
    if (syncAttr) {
      if (hidden) node.setAttribute('hidden', '');
      else node.removeAttribute('hidden');
    }
  }

  function syncModelQuotaTheme() {
    if (!quotaHost) return;
    qSetAttr(quotaHost, 'data-theme', host.getAttribute('data-theme'));
    qSetAttr(quotaHost, 'data-panel-tone', host.getAttribute('data-panel-tone'));
    const hostBg = host.style?.getPropertyValue?.('--ag-host-bg');
    if (hostBg) quotaHost.style.setProperty('--ag-host-bg', hostBg);
    const customBg = host.style?.getPropertyValue?.('--ag-custom-panel-bg');
    if (customBg) quotaHost.style.setProperty('--ag-custom-panel-bg', customBg);
    else if (quotaHost.style?.removeProperty) quotaHost.style.removeProperty('--ag-custom-panel-bg');
  }
  syncModelQuotaTheme();

  // ---- 状态与持久化 ----
  let lastQuotaRenderSig = '';
  let lastQuotaTriggerEl = null;
  let lastQuotaTriggerRawText = '';
  let lastQuotaConfigsRef = null;
  let lastQuotaGroupsRef = null;
  let quotaNavResizeObserver = null;
  let observedQuotaNav = null;
  let show5hQuota = true;
  let quotaDisplayMode = 'used';
  // userMinimized 记住「侧边栏展开时」的用户偏好；侧边栏收起时自动缩为左下角小圆环，重新打开侧边栏后恢复至记忆态
  let userMinimized = false;
  let collapsedTempExpanded = false;
  let lastQuotaSidebarOpen = null;

  function hydrateModelQuotaPrefs(uiPrefs) {
    if (!uiPrefs || typeof uiPrefs !== 'object') return false;
    let changed = false;
    if (typeof uiPrefs.quotaShow5h === 'boolean' && uiPrefs.quotaShow5h !== show5hQuota) {
      show5hQuota = uiPrefs.quotaShow5h;
      changed = true;
    }
    if (['used', 'remaining'].includes(uiPrefs.quotaDisplayMode) && uiPrefs.quotaDisplayMode !== quotaDisplayMode) {
      quotaDisplayMode = uiPrefs.quotaDisplayMode;
      changed = true;
    }
    if (typeof uiPrefs.quotaMinimized === 'boolean' && uiPrefs.quotaMinimized !== userMinimized) {
      userMinimized = uiPrefs.quotaMinimized;
      changed = true;
    }
    return changed;
  }

  function persistModelQuotaPrefs(patch = {}) {
    userActionSeq++;
    try {
      if (typeof patch.quotaShow5h === 'boolean') localStorage?.setItem('ag_quota_show_5h', patch.quotaShow5h ? '1' : '0');
      if (patch.quotaDisplayMode) localStorage?.setItem('ag_quota_display_mode', patch.quotaDisplayMode);
      if (typeof patch.quotaMinimized === 'boolean') localStorage?.setItem('ag_quota_minimized', patch.quotaMinimized ? '1' : '0');
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.__AGContextMeterSettings && typeof window.__AGContextMeterSettings === 'object') {
        window.__AGContextMeterSettings.uiPreferences = {
          ...(window.__AGContextMeterSettings.uiPreferences || {}),
          ...patch
        };
      }
    } catch {}
    if (typeof saveSettingsPayloadBridge === 'function') {
      void saveSettingsPayloadBridge({ uiPreferences: patch });
    }
  }

  function setModelQuotaMinimizedState(nextMinimized) {
    const target = Boolean(nextMinimized);
    if (findVisibleSidebarNav()) {
      userMinimized = target;
      persistModelQuotaPrefs({ quotaMinimized: target });
    } else {
      collapsedTempExpanded = !target;
    }
    renderModelQuota(true);
    return target;
  }

  function toggleModelQuota5hState() {
    show5hQuota = !show5hQuota;
    persistModelQuotaPrefs({ quotaShow5h: show5hQuota });
    renderModelQuota(true);
    return show5hQuota;
  }

  // 启动时优先从宿主持久化配置快照恢复（Antigravity 每次重启随机分配 localhost 端口，不能只靠 localStorage）
  (() => {
    const bootUi = (typeof window !== 'undefined' && window.__AGContextMeterSettings?.uiPreferences) || null;
    hydrateModelQuotaPrefs(bootUi);
    try {
      if (typeof bootUi?.quotaShow5h !== 'boolean') {
        const saved5h = localStorage?.getItem('ag_quota_show_5h');
        if (saved5h === '0' || saved5h === 'false') show5hQuota = false;
        else if (saved5h === '1' || saved5h === 'true') show5hQuota = true;
      }
      if (bootUi?.quotaDisplayMode !== 'used' && bootUi?.quotaDisplayMode !== 'remaining') {
        if (localStorage?.getItem('ag_quota_display_mode') === 'remaining') quotaDisplayMode = 'remaining';
      }
      if (typeof bootUi?.quotaMinimized !== 'boolean') {
        const savedMin = localStorage?.getItem('ag_quota_minimized');
        if (savedMin === '1' || savedMin === 'true') userMinimized = true;
        else if (savedMin === '0' || savedMin === 'false') userMinimized = false;
      }
    } catch {}
  })();

  qDom.displayModeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    quotaDisplayMode = quotaDisplayMode === 'used' ? 'remaining' : 'used';
    persistModelQuotaPrefs({ quotaDisplayMode });
    renderModelQuota(true);
  });
  qDom.toggle5hBtn?.addEventListener('click', (e) => { e?.stopPropagation?.(); toggleModelQuota5hState(); });
  qDom.minimizeBtn?.addEventListener('click', (e) => { e?.stopPropagation?.(); setModelQuotaMinimizedState(true); });
  qDom.dotBtn?.addEventListener('click', (e) => { e?.stopPropagation?.(); setModelQuotaMinimizedState(false); });

  // ---- 侧栏可见性与流式停靠 ----
  const isHiddenCss = (cs) => Boolean(
    cs && (cs.display === 'none' || cs.visibility === 'hidden' || (cs.opacity !== '' && cs.opacity != null && Number(cs.opacity) === 0))
  );
  const isClippingCss = (cs) => Boolean(
    cs && (cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'hidden' || cs.overflowX === 'clip')
  );

  function readComputedStyleSafe(el) {
    if (typeof getComputedStyle !== 'function') return null;
    try { return getComputedStyle(el); } catch { return null; }
  }

  function isSidebarElementVisible(nav) {
    if (!nav || !nav.isConnected) return false;
    if (nav.getAttribute?.('aria-hidden') === 'true' || nav.hasAttribute?.('inert')) return false;
    if (isHiddenCss(readComputedStyleSafe(nav))) return false;
    if (typeof nav.getBoundingClientRect === 'function') {
      const r = nav.getBoundingClientRect();
      if (!r || r.width < 60 || r.height < 80 || r.right < 60 || r.bottom < 80) return false;
      let p = nav.parentElement;
      for (let depth = 0; p && p !== document.body && p !== document.documentElement && depth < 6; depth++, p = p.parentElement) {
        if (p.getAttribute?.('aria-hidden') === 'true' || p.hasAttribute?.('inert')) return false;
        const pcs = readComputedStyleSafe(p);
        if (isHiddenCss(pcs)) return false;
        // display: contents 无自身布局盒，getBoundingClientRect() 恒为 0x0，绝不能误判为侧栏已收起
        if (pcs && pcs.display === 'contents') continue;
        if (typeof p.getBoundingClientRect === 'function') {
          const pr = p.getBoundingClientRect();
          if (pr && (!pcs || isClippingCss(pcs) || (pr.height >= 80 && pr.width < 60)) && (pr.width < 60 || pr.right < 60)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  function findVisibleSidebarNav() {
    if (typeof document === 'undefined') return null;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const isLeftSidebarGeometry = (el) => {
      if (typeof el.getBoundingClientRect !== 'function') return true;
      const r = el.getBoundingClientRect();
      return Boolean(r && r.left <= 24 && r.width >= 100 && r.width <= Math.max(520, vw * 0.5) && r.height >= 160);
    };
    const nodes = typeof document.querySelectorAll === 'function'
      ? document.querySelectorAll('div[role="navigation"], nav, aside')
      : [document.querySelector?.('div[role="navigation"], nav')].filter(Boolean);
    for (const nav of nodes) {
      if (isSidebarElementVisible(nav) && isLeftSidebarGeometry(nav)) return nav;
    }
    return null;
  }

  function observeSidebarNavForQuota(nav) {
    if (observedQuotaNav === nav) return;
    observedQuotaNav = nav;
    try {
      if (quotaNavResizeObserver) quotaNavResizeObserver.disconnect();
      else if (typeof ResizeObserver !== 'undefined') {
        quotaNavResizeObserver = new ResizeObserver(() => { if (!state.disposed) renderModelQuota(true); });
      }
      if (quotaNavResizeObserver && nav) {
        quotaNavResizeObserver.observe(nav);
        if (nav.parentElement && nav.parentElement !== document.body) quotaNavResizeObserver.observe(nav.parentElement);
      }
    } catch {}
  }

  function findSidebarQuotaInsertion() {
    if (typeof document === 'undefined') return { mode: 'hidden' };
    const fallbackParent = document.body || document.documentElement;
    const nav = findVisibleSidebarNav();
    if (!nav) {
      return fallbackParent ? { mode: 'fixed', parent: fallbackParent, before: null } : { mode: 'hidden' };
    }
    observeSidebarNavForQuota(nav);
    const navRect = typeof nav.getBoundingClientRect === 'function' ? nav.getBoundingClientRect() : null;
    let settingsAnchor = null;
    if (typeof nav.querySelectorAll === 'function') {
      let bestTop = -1;
      for (const item of nav.querySelectorAll('button, a, [role="button"]')) {
        if (!item || quotaHost.contains?.(item)) continue;
        const label = String(item.getAttribute?.('aria-label') || item.getAttribute?.('title') || item.textContent || '').trim();
        const testId = String(item.getAttribute?.('data-testid') || '');
        const href = String(item.getAttribute?.('href') || '');
        if (!(/^(?:settings|设置|設定)(?:\s|$)/i.test(label) || /settings/i.test(testId) || /\/settings\b/i.test(href))) continue;
        const r = typeof item.getBoundingClientRect === 'function' ? item.getBoundingClientRect() : null;
        if (r && r.width === 0 && r.height === 0) continue;
        const topVal = r ? r.top : 1;
        if ((!navRect || !r || r.top >= navRect.top + navRect.height * 0.45) && topVal >= bestTop) {
          bestTop = topVal;
          settingsAnchor = item;
        }
      }
    }
    if (settingsAnchor) {
      let footerChild = settingsAnchor;
      while (footerChild.parentElement && footerChild.parentElement !== nav) {
        const parent = footerChild.parentElement;
        const parentRect = typeof parent.getBoundingClientRect === 'function' ? parent.getBoundingClientRect() : null;
        if (navRect && parentRect && parentRect.height > Math.min(200, navRect.height * 0.45)) break;
        footerChild = parent;
      }
      if (footerChild && footerChild.parentElement && footerChild !== quotaHost) {
        return { mode: 'sidebar', parent: footerChild.parentElement, before: footerChild, nav };
      }
    }
    const children = Array.from(nav.children || []).filter(c => c !== quotaHost);
    const lastChild = children[children.length - 1] || null;
    if (children.length >= 2 && lastChild) {
      const lastRect = typeof lastChild.getBoundingClientRect === 'function' ? lastChild.getBoundingClientRect() : null;
      if (!lastRect || (lastRect.height > 0 && lastRect.height <= 160)) {
        return { mode: 'sidebar', parent: nav, before: lastChild, nav };
      }
    }
    return { mode: 'sidebar', parent: nav, before: null, nav };
  }

  function ensureModelQuotaDocked() {
    if (state.disposed) return false;
    const plan = findSidebarQuotaInsertion();
    if (plan.mode === 'hidden' || !plan.parent) {
      quotaHost.hidden = true;
      return false;
    }
    if (plan.before && plan.before.parentElement === plan.parent) {
      if (quotaHost.parentElement !== plan.parent || quotaHost.nextSibling !== plan.before) {
        plan.parent.insertBefore(quotaHost, plan.before);
      }
    } else if (quotaHost.parentElement !== plan.parent) {
      plan.parent.appendChild(quotaHost);
    }
    qSetAttr(quotaHost, 'data-dock', plan.mode);
    return true;
  }

  // ---- 窗口分类、格式化与渲染纯辅助函数 ----
  function resolveQuotaWindowLabel(bucket) {
    const rawWindow = String(bucket?.window || '').trim().toLowerCase();
    if (QUOTA_WINDOW_I18N_MAP[rawWindow]) return t(QUOTA_WINDOW_I18N_MAP[rawWindow]);
    return String(bucket?.displayName || bucket?.window || '').trim();
  }

  function classifyQuotaBucketKind(bucket) {
    const w = String(bucket?.window || '').trim().toLowerCase();
    const d = String(bucket?.displayName || '').trim().toLowerCase();
    if (w === '5h' || w === '5_hour' || w === '5 hours' || /\b5\s*h(?:our)?s?\b/.test(w) || /\b5\s*h(?:our)?s?\b/.test(d)) return '5h';
    if (w === 'weekly' || w === 'week' || w === '7d' || /\bweek(?:ly)?\b/.test(w) || /\bweek(?:ly)?\b/.test(d)) return 'weekly';
    if (w === 'daily' || w === 'day' || w === '24h' || /\bdaily\b/.test(w)) return 'daily';
    return 'other';
  }

  function formatQuotaResetCountdown(isoStr) {
    if (!isoStr) return '';
    try {
      const targetMs = new Date(isoStr).getTime();
      if (!Number.isFinite(targetMs)) return '';
      const diffMs = targetMs - Date.now();
      if (diffMs <= 60000) return t('quota.resetIn.soon');
      const totalMins = Math.ceil(diffMs / 60000);
      const days = Math.floor(totalMins / (60 * 24));
      const hours = Math.floor((totalMins % (60 * 24)) / 60);
      const mins = totalMins % 60;
      if (days > 0) return hours > 0 ? t('quota.resetIn.dh', { d: days, h: hours }) : t('quota.resetIn.d', { d: days });
      if (hours > 0) return mins > 0 ? t('quota.resetIn.hm', { h: hours, m: mins }) : t('quota.resetIn.h', { h: hours });
      return t('quota.resetIn.m', { m: Math.max(1, mins) });
    } catch {
      return '';
    }
  }

  function formatQuotaResetTime(isoStr) {
    if (!isoStr) return '';
    if (currentPanelLanguage === 'en') {
      try {
        const d = new Date(isoStr);
        if (!Number.isNaN(d.getTime())) {
          return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
      } catch {}
    }
    return typeof formatResetTimeZh === 'function' ? formatResetTimeZh(isoStr) : String(isoStr);
  }

  function isValidQuotaFraction(frac) {
    return Number.isFinite(frac) && frac >= 0 && frac <= 1;
  }
  function calcQuotaUsedPct(frac) {
    return frac <= 0 ? 100 : Math.min(99, Math.max(0, Math.round((1 - frac) * 100)));
  }
  function calcQuotaRowState(frac, used) {
    if (!Number.isFinite(frac)) return 'unknown';
    if (frac <= 0.05 || used >= 95) return 'danger';
    if (used >= 80) return 'warn';
    return 'normal';
  }
  function pickTightestQuotaBucket(list) {
    return list.reduce((best, b) => (!best || b.remainingFraction < best.remainingFraction ? b : best), null);
  }

  function formatQuotaTooltipEntry(bucket, percent) {
    const p = resolveQuotaWindowLabel(bucket);
    const pDisp = (p && currentPanelLanguage !== 'en' && /[a-z0-9]$/i.test(p)) ? `${p} ` : p;
    const remaining = quotaDisplayMode === 'remaining';
    const base = pDisp
      ? t(remaining ? 'quota.windowRemaining' : 'quota.windowUsed', { window: pDisp, percent })
      : t(remaining ? 'quota.remaining' : 'quota.used', { percent });
    if (!bucket?.resetTime) return base;
    return `${base} (${t('quota.resetAt', { time: formatQuotaResetTime(bucket.resetTime) })})`;
  }

  function renderQuotaRow(refs, opts) {
    qSetHidden(refs.row, !opts.visible);
    if (!opts.visible) return;
    qSetAttr(refs.row, 'data-state', opts.state);
    qSetText(refs.title, opts.title);
    qSetHidden(refs.reset, !opts.resetText);
    qSetText(refs.reset, opts.resetText);
    qSetText(refs.amount, opts.amountText);
    qSetAttr(refs.progress, 'aria-valuenow', opts.hasValue ? String(opts.percent) : null);
    if (refs.fill) {
      const widthStr = opts.hasValue ? `${opts.percent}%` : '0%';
      if (refs.fill.style.width !== widthStr) refs.fill.style.width = widthStr;
    }
  }

  function syncQuotaDotRing(ringEl, circ, hasData, percent, ringState) {
    if (!ringEl) return;
    const showArc = Boolean(hasData && Number.isFinite(percent) && percent > 0);
    const filled = showArc ? Math.max(0, Math.min(circ, (percent / 100) * circ)) : 0;
    qSetAttr(ringEl, 'stroke-dasharray', `${filled.toFixed(2)} ${circ.toFixed(2)}`);
    qSetAttr(ringEl, 'stroke-opacity', showArc ? '1' : '0');
    qSetAttr(ringEl, 'data-state', hasData ? ringState : 'unknown');
  }

  function peekHostSelectedTrigger() {
    if (typeof document === 'undefined') return null;
    if (typeof document.querySelectorAll === 'function') {
      const triggers = document.querySelectorAll('[data-testid="model-selector-trigger"]');
      const multiple = triggers.length > 1;
      for (const candidate of triggers) {
        if (!candidate) continue;
        if (host?.contains?.(candidate) || candidate.closest?.('#ag-context-meter')) continue;
        if (multiple && typeof candidate.getBoundingClientRect === 'function') {
          const rect = candidate.getBoundingClientRect();
          if (rect && rect.width === 0 && rect.height === 0) continue;
        }
        return candidate;
      }
      return null;
    }
    return document.querySelector?.('[data-testid="model-selector-trigger"]') || null;
  }

  function renderModelQuota(force = false) {
    if (!qDom.card || state.disposed) return;

    const configs = (Array.isArray(state.modelQuotaConfigs) && state.modelQuotaConfigs.length)
      ? state.modelQuotaConfigs
      : (state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);

    const peekTrigger = peekHostSelectedTrigger();
    const peekText = peekTrigger ? String(peekTrigger.textContent || '') : '';
    const sidebarOpen = Boolean(findVisibleSidebarNav());
    if (lastQuotaSidebarOpen !== null && lastQuotaSidebarOpen !== sidebarOpen) {
      collapsedTempExpanded = false;
    }
    lastQuotaSidebarOpen = sidebarOpen;
    const effectiveMinimized = sidebarOpen ? userMinimized : !collapsedTempExpanded;
    const sig = [
      peekText,
      state.quotaSynced ? '1' : '0',
      show5hQuota ? '5h1' : '5h0',
      quotaDisplayMode,
      effectiveMinimized ? 'min1' : 'min0',
      currentPanelLanguage,
      sidebarOpen ? 'nav1' : 'nav0',
      quotaHost.isConnected ? 'conn1' : 'conn0',
      state.modelQuotaGroups.length,
      configs.length,
      Math.floor(Date.now() / 60000)
    ].join('|');

    if (
      !force &&
      peekTrigger === lastQuotaTriggerEl &&
      peekText === lastQuotaTriggerRawText &&
      configs === lastQuotaConfigsRef &&
      state.modelQuotaGroups === lastQuotaGroupsRef &&
      sig === lastQuotaRenderSig
    ) {
      return;
    }
    lastQuotaTriggerEl = peekTrigger;
    lastQuotaTriggerRawText = peekText;
    lastQuotaConfigsRef = configs;
    lastQuotaGroupsRef = state.modelQuotaGroups;
    lastQuotaRenderSig = sig;

    const selected = extractHostSelectedModel();
    if (!selected) {
      quotaHost.hidden = true;
      return;
    }

    const modelCandidates = [selected.rawText, selected.productLabel, selected.modelId];
    const groupBuckets = typeof resolveModelQuotaGroupBuckets === 'function'
      ? resolveModelQuotaGroupBuckets(modelCandidates, state.modelQuotaGroups)
      : [];
    const pickValid = (q) => (q && isValidQuotaFraction(q.remainingFraction) ? q : null);
    const modelQuota = typeof resolveModelQuota === 'function'
      ? (pickValid(resolveModelQuota(selected.modelId, configs)) || pickValid(resolveModelQuota(selected.rawText, configs)))
      : null;

    const weeklyBucket = pickTightestQuotaBucket(groupBuckets.filter(b => classifyQuotaBucketKind(b) === 'weekly'));
    const fiveHourBucket = pickTightestQuotaBucket(groupBuckets.filter(b => classifyQuotaBucketKind(b) === '5h'));
    const otherBucket = pickTightestQuotaBucket(groupBuckets.filter(b => {
      const k = classifyQuotaBucketKind(b);
      return k !== 'weekly' && k !== '5h';
    }));

    // 主行优先周额度 → 其他非 5h 窗口 → 唯一 5h → 逐模型回退
    const primaryBucket = weeklyBucket || otherBucket || fiveHourBucket || modelQuota;
    const secondary5hBucket = (weeklyBucket || otherBucket) ? fiveHourBucket : null;
    const hasPrimary = Boolean(primaryBucket && isValidQuotaFraction(primaryBucket.remainingFraction));
    const has5hToggle = Boolean(secondary5hBucket);
    const show5h = Boolean(secondary5hBucket && show5hQuota);

    if (!hasPrimary && !state.quotaSynced) {
      quotaHost.hidden = true;
      return;
    }
    if (!ensureModelQuotaDocked()) return;

    const model = selected.productLabel || selected.rawText || t('quota.label');
    const primaryUsed = hasPrimary ? calcQuotaUsedPct(primaryBucket.remainingFraction) : null;
    const primaryState = hasPrimary ? calcQuotaRowState(primaryBucket.remainingFraction, primaryUsed) : 'unknown';
    const primaryTitle = hasPrimary ? resolveQuotaWindowLabel(primaryBucket) : '';
    const primaryCountdown = (hasPrimary && primaryBucket.resetTime) ? formatQuotaResetCountdown(primaryBucket.resetTime) : '';
    const used5h = secondary5hBucket ? calcQuotaUsedPct(secondary5hBucket.remainingFraction) : null;
    const state5h = secondary5hBucket ? calcQuotaRowState(secondary5hBucket.remainingFraction, used5h) : 'unknown';

    const showRemaining = quotaDisplayMode === 'remaining';
    const primaryPercent = hasPrimary && showRemaining ? 100 - primaryUsed : primaryUsed;
    const percent5h = secondary5hBucket && showRemaining ? 100 - used5h : used5h;
    const amountKey = showRemaining ? 'quota.remaining' : 'quota.used';
    const displayModeTip = t(showRemaining ? 'quota.mode.showUsed' : 'quota.mode.showRemaining');

    quotaHost.hidden = false;
    qSetText(qDom.displayModeBtn, t(showRemaining ? 'quota.mode.remaining' : 'quota.mode.used'));
    qSetAttr(qDom.displayModeBtn, 'aria-label', displayModeTip);
    qSetAttr(qDom.displayModeBtn, 'title', displayModeTip);
    qSetAttr(quotaHost, 'data-minimized', effectiveMinimized ? 'true' : 'false');
    qSetHidden(qDom.dotBtn, !effectiveMinimized);
    qSetHidden(qDom.card, effectiveMinimized);
    qSetText(qDom.label, model);

    // 顶部操作按钮（展开/收起 5h 与最小化）
    qSetHidden(qDom.toggle5hBtn, !has5hToggle);
    if (has5hToggle && qDom.toggle5hBtn) {
      const tip5h = show5hQuota ? t('quota.toggle5h.hide') : t('quota.toggle5h.show');
      qSetAttr(qDom.toggle5hBtn, 'aria-pressed', String(show5hQuota));
      qSetAttr(qDom.toggle5hBtn, 'aria-label', tip5h);
      qDom.toggle5hBtn.title = tip5h;
    }
    const showAlert5h = Boolean(has5hToggle && !show5hQuota && (state5h === 'warn' || state5h === 'danger'));
    qSetHidden(qDom.alertDot5h, !showAlert5h);
    if (showAlert5h) qSetAttr(qDom.alertDot5h, 'data-level', state5h);
    if (qDom.minimizeBtn) {
      const minTip = t('quota.minimize');
      qSetAttr(qDom.minimizeBtn, 'aria-label', minTip);
      qDom.minimizeBtn.title = minTip;
    }

    // 渲染主行与 5h 次行
    renderQuotaRow(qDom.primary, {
      visible: true,
      hasValue: hasPrimary,
      percent: primaryPercent,
      state: primaryState,
      title: primaryTitle,
      resetText: primaryCountdown ? (primaryTitle ? `· ${primaryCountdown}` : primaryCountdown) : '',
      amountText: hasPrimary ? t(amountKey, { percent: primaryPercent }) : t('quota.unavailable')
    });
    const countdown5h = (show5h && secondary5hBucket.resetTime) ? formatQuotaResetCountdown(secondary5hBucket.resetTime) : '';
    renderQuotaRow(qDom.fiveHour, {
      visible: show5h,
      hasValue: true,
      percent: percent5h,
      state: state5h,
      title: show5h ? (resolveQuotaWindowLabel(secondary5hBucket) || t('quota.window.5h')) : '',
      resetText: countdown5h ? `· ${countdown5h}` : '',
      amountText: show5h ? t(amountKey, { percent: percent5h }) : ''
    });

    // 宿主预警状态与收起态同心环（仅当存在 5h 且未收起 5h 时展示内环，否则单环）
    const worstState = (show5h && state5h === 'danger') || primaryState === 'danger'
      ? 'danger'
      : ((show5h && state5h === 'warn') || primaryState === 'warn') ? 'warn' : primaryState;
    qSetAttr(quotaHost, 'data-quota-state', worstState);

    syncQuotaDotRing(qDom.dotOuterRing, QUOTA_DOT_OUTER_CIRC, hasPrimary, primaryPercent, primaryState);
    qSetHidden(qDom.dotInnerTrack, !show5h, true);
    qSetHidden(qDom.dotInnerRing, !show5h, true);
    syncQuotaDotRing(qDom.dotInnerRing, QUOTA_DOT_INNER_CIRC, show5h, show5h ? percent5h : null, show5h ? state5h : 'unknown');

    // 悬停完整信息
    const tooltipParts = [
      selected.rawText || model,
      hasPrimary ? formatQuotaTooltipEntry(primaryBucket, primaryPercent) : t('quota.unavailable')
    ];
    if (secondary5hBucket) tooltipParts.push(formatQuotaTooltipEntry(secondary5hBucket, percent5h));
    const tooltip = tooltipParts.filter(Boolean).join(' · ');
    if (qDom.card.title !== tooltip) qDom.card.title = tooltip;
    if (qDom.dotBtn) {
      const dotTip = `${tooltip} · ${t('quota.expand')}`;
      if (qDom.dotBtn.title !== dotTip) qDom.dotBtn.title = dotTip;
      qSetAttr(qDom.dotBtn, 'aria-label', t('quota.expand'));
    }
  }

  function getModelQuotaStateSnapshot() {
    return {
      hidden: quotaHost.hidden,
      dock: quotaHost.getAttribute('data-dock'),
      minimized: quotaHost.getAttribute('data-minimized') === 'true',
      dotVisible: !qDom.dotBtn?.hidden,
      dotOuterState: qDom.dotOuterRing?.getAttribute('data-state') || '',
      dotOuterDash: qDom.dotOuterRing?.getAttribute('stroke-dasharray') || '',
      dotOuterOpacity: qDom.dotOuterRing?.getAttribute('stroke-opacity') || '',
      dotInnerVisible: !qDom.dotInnerTrack?.hidden && !qDom.dotInnerRing?.hidden,
      dotInnerState: qDom.dotInnerRing?.getAttribute('data-state') || '',
      dotInnerDash: qDom.dotInnerRing?.getAttribute('stroke-dasharray') || '',
      dotInnerOpacity: qDom.dotInnerRing?.getAttribute('stroke-opacity') || '',
      dotTitle: qDom.dotBtn?.title || '',
      cardVisible: !qDom.card?.hidden,
      quotaState: quotaHost.getAttribute('data-quota-state'),
      label: qDom.label?.textContent || '',
      primaryTitle: qDom.primary.title?.textContent || '',
      primaryReset: qDom.primary.reset?.hidden ? '' : (qDom.primary.reset?.textContent || ''),
      amount: qDom.primary.amount?.textContent || '',
      progressValue: qDom.primary.progress?.hasAttribute('aria-valuenow') ? Number(qDom.primary.progress.getAttribute('aria-valuenow')) : null,
      primaryState: qDom.primary.row?.getAttribute('data-state') || '',
      toggle5hVisible: !qDom.toggle5hBtn?.hidden,
      alertDot5hVisible: !qDom.alertDot5h?.hidden,
      show5hRow: !qDom.fiveHour.row?.hidden,
      title5h: qDom.fiveHour.title?.textContent || '',
      reset5h: qDom.fiveHour.reset?.hidden ? '' : (qDom.fiveHour.reset?.textContent || ''),
      amount5h: qDom.fiveHour.amount?.textContent || '',
      progress5hValue: qDom.fiveHour.progress?.hasAttribute('aria-valuenow') ? Number(qDom.fiveHour.progress.getAttribute('aria-valuenow')) : null,
      state5h: qDom.fiveHour.row?.getAttribute('data-state') || '',
      title: qDom.card?.title || '',
      configsCount: state.modelQuotaConfigs.length,
      groupsCount: state.modelQuotaGroups.length,
      quotaSynced: state.quotaSynced
    };
  }

  function disposeModelQuota() {
    try { quotaNavResizeObserver?.disconnect(); } catch {}
    quotaNavResizeObserver = null;
    observedQuotaNav = null;
    try { quotaHost.remove(); } catch {}
  }
