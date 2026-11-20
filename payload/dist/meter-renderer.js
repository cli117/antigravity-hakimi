(function () {
  const METER_VERSION = "1.0.0";
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;
  globalThis.__AGContextMeter?.dispose();
  const {
    summarize,
    computeCacheMetrics,
    summarizeSessionCache,
    parseGeneratorCall,
    normalizeModelId,
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

  shadow.innerHTML = `<style>
        :host{
      position:fixed;top:6px;right:138px;z-index:2147483000;
      font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      -webkit-app-region:no-drag;user-select:none;display:inline-flex;align-items:center;gap:2px;
      height:28px;flex-shrink:0;vertical-align:middle;

      /* 优先复用 Antigravity 0 级宿主主题变量，无变量时回退深色默认值 */
      --ag-toolbar-fg:var(--secondary-foreground,#b8b8c0);
      --ag-toolbar-fg-hover:var(--foreground,#ececef);
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:var(--secondary,rgba(255,255,255,0.08));
      --ag-toolbar-bg-active:var(--secondary,rgba(255,255,255,0.12));
      --ag-toolbar-border-focus:var(--primary,rgba(128,128,128,0.45));
      --ag-divider:var(--border,rgba(255,255,255,0.08));

      /* 圆环与各指标默认主题色 */
      --ag-ring-track-default:rgba(255,255,255,0.20);
      --ag-ring-used-default:#e6e6eb;
      --ag-ring-warn:#f59e0b;
      --ag-ring-danger:#ef4444;

      --ag-context-text-default:#ececef;
      --ag-speed-default:#b8b8c0;
      --ag-cache-default:#b8b8c0;
      --ag-token-total-default:#b8b8c0;
      --ag-token-accent-default:#a78bfa;

      /* 0 级主题背景与一级/二级严格统一背景色 */
      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#181818));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(255,255,255,0.12);
      --ag-float-shadow:0 12px 32px rgba(0,0,0,0.52),0 2px 8px rgba(0,0,0,0.32);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(255,255,255,0.11);
      --ag-shadow-panel:0 16px 40px rgba(0,0,0,0.58),0 2px 10px rgba(0,0,0,0.32);
      --ag-text-primary:#ececef;
      --ag-text-secondary:#c8c8d0;
      --ag-text-muted:#8a8a94;
      --ag-border-subtle:rgba(255,255,255,0.08);

      /* 一级面板与二级内部菜单/卡片/抽屉背景严格一致 */
      --ag-bg-card:var(--ag-unified-bg);
      --ag-bg-card-hover:var(--ag-unified-bg);
      --ag-border-card:rgba(255,255,255,0.09);
      --ag-bg-subcard:var(--ag-unified-bg);
      --ag-border-subcard:rgba(255,255,255,0.08);
      --ag-bg-status:var(--ag-unified-bg);
      --ag-text-status:#c8c8d0;

      --ag-btn-bg:var(--ag-unified-bg);
      --ag-btn-hover:rgba(255,255,255,0.08);
      --ag-btn-border:rgba(255,255,255,0.12);
      --ag-btn-border-hover:rgba(255,255,255,0.22);
      --ag-btn-text:#d4d4d8;

      --ag-pill-muted-bg:var(--ag-unified-bg);
      --ag-pill-muted-border:rgba(255,255,255,0.12);
      --ag-pill-muted-text:#9a9aa2;

      --ag-track-bg:rgba(255,255,255,0.12);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-unified-bg);
      --ag-heat-lvl-0:#27272a;
      --ag-heat-lvl-1:#3f1e6b;
      --ag-heat-lvl-2:#652ab7;
      --ag-heat-lvl-3:#9053f8;
      --ag-heat-lvl-4:#c084fc;
      --ag-heat-outline:#ffffff;

      --ag-pop-bg:var(--ag-unified-bg);
      --ag-pop-border:var(--ag-float-border);
      --ag-pop-shadow:var(--ag-float-shadow);
      --ag-pop-text:var(--ag-text-primary);
      --ag-pop-muted:var(--ag-text-secondary);
      --ag-pop-sub:var(--ag-text-muted);

      --ag-scrollbar-thumb:rgba(255,255,255,0.16);
      --ag-scrollbar-hover:rgba(255,255,255,0.28);

      --ag-bg-input:rgba(255,255,255,0.06);
      --ag-select-option-bg:#222226;
      --ag-select-option-fg:#ececef;

      color-scheme:dark;
      color:var(--ag-text-primary);
    }

    /* 融入宿主原生布局容器时参与正常 Flexbox 空间分配 */
    :host([data-dock="flow"]){
      position:relative !important;top:auto !important;right:auto !important;left:auto !important;bottom:auto !important;z-index:20;
      margin-right:4px;
    }

    /* 窗口非活动状态适度降低顶栏对比度 */
    :host([data-window-active="false"]) .ag-unit{
      opacity:0.72;
    }
    :host([data-window-active="false"]) .ag-unit:hover,
    :host([data-window-active="false"]) .ag-unit:focus-visible{
      opacity:1;
    }

    /* 浅色模式规范（与 0 级浅色主题协调，且一级/二级背景严格统一） */
    :host([data-theme="light"]),
    :host([data-panel-tone="light"]){
      --ag-toolbar-fg:#52525b;
      --ag-toolbar-fg-hover:#18181b;
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:rgba(0,0,0,0.06);
      --ag-toolbar-bg-active:rgba(0,0,0,0.10);
      --ag-toolbar-border-focus:rgba(0,0,0,0.35);
      --ag-divider:rgba(0,0,0,0.08);

      --ag-ring-track-default:rgba(0,0,0,0.18);
      --ag-ring-used-default:#18181b;
      --ag-ring-warn:#d97706;
      --ag-ring-danger:#dc2626;

      --ag-context-text-default:#18181b;
      --ag-speed-default:#52525b;
      --ag-cache-default:#52525b;
      --ag-token-total-default:#52525b;
      --ag-token-accent-default:#7c3aed;

      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#ffffff));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(0,0,0,0.12);
      --ag-float-shadow:0 8px 24px rgba(0,0,0,0.12),0 2px 6px rgba(0,0,0,0.06);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(0,0,0,0.12);
      --ag-shadow-panel:0 14px 36px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.06);
      --ag-text-primary:#18181b;
      --ag-text-secondary:#3f3f46;
      --ag-text-muted:#71717a;
      --ag-border-subtle:rgba(0,0,0,0.08);

      --ag-bg-card:var(--ag-unified-bg);
      --ag-bg-card-hover:var(--ag-unified-bg);
      --ag-border-card:rgba(0,0,0,0.10);
      --ag-bg-subcard:var(--ag-unified-bg);
      --ag-border-subcard:rgba(0,0,0,0.09);
      --ag-bg-status:var(--ag-unified-bg);
      --ag-text-status:#27272a;

      --ag-btn-bg:var(--ag-unified-bg);
      --ag-btn-hover:rgba(0,0,0,0.05);
      --ag-btn-border:rgba(0,0,0,0.12);
      --ag-btn-border-hover:rgba(0,0,0,0.22);
      --ag-btn-text:#18181b;

      --ag-pill-muted-bg:var(--ag-unified-bg);
      --ag-pill-muted-border:rgba(0,0,0,0.12);
      --ag-pill-muted-text:#52525b;

      --ag-track-bg:rgba(0,0,0,0.08);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-unified-bg);
      --ag-heat-lvl-0:#e4e4e7;
      --ag-heat-lvl-1:#e9d5ff;
      --ag-heat-lvl-2:#c084fc;
      --ag-heat-lvl-3:#9333ea;
      --ag-heat-lvl-4:#6b21a8;
      --ag-heat-outline:#18181b;

      --ag-scrollbar-thumb:rgba(0,0,0,0.16);
      --ag-scrollbar-hover:rgba(0,0,0,0.28);

      --ag-bg-input:rgba(0,0,0,0.04);
      --ag-select-option-bg:#ffffff;
      --ag-select-option-fg:#18181b;

      color-scheme:light;
      color:var(--ag-text-primary);
    }

    *{box-sizing:border-box}
    .sr-only{
      position:absolute!important;width:1px!important;height:1px!important;
      padding:0!important;margin:-1px!important;overflow:hidden!important;
      clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
    }
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb);border-radius:3px}
    ::-webkit-scrollbar-thumb:hover{background:var(--ag-scrollbar-hover)}
    button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}
    button:focus-visible{outline:1.5px solid var(--ag-toolbar-border-focus);outline-offset:1px}

    /* Basic Unit: 原生工具栏级别精密小单元 */
    .ag-unit{
      display:inline-flex;align-items:center;justify-content:center;
      height:28px;padding:0 7px;border-radius:8px;border:1px solid transparent;
      background:var(--ag-toolbar-bg);color:var(--ag-toolbar-fg);
      white-space:nowrap;font-variant-numeric:tabular-nums;
      font-size:12px;font-weight:500;letter-spacing:-0.01em;gap:4px;
      transition:background-color .14s ease,color .14s ease,border-color .14s ease,opacity .14s ease,transform .1s cubic-bezier(0.16,1,0.3,1);
      flex-shrink:0;
    }
    .ag-unit:hover,.ag-unit:focus-visible,.ag-unit[aria-expanded="true"]{
      background:var(--ag-toolbar-bg-hover);
      color:var(--ag-toolbar-fg-hover);
    }
    .ag-unit:active{
      background:var(--ag-toolbar-bg-active);
      transform:scale(0.96);
    }

    /* 单元 1: 上下文小圆环按钮（按内容自适应，圆环+百分比共存） */
    #badge.ag-unit-ring{
      width:auto!important;
      min-width:28px;
      height:28px;
      padding:0 6px 0 4px;
      gap:3px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
    }
    :host([data-layout="ring-only"]) #badge.ag-unit-ring{
      width:28px!important;
      min-width:28px!important;
      padding:0!important;
      gap:0!important;
    }
    .ring-svg{
      width:18px;height:18px;display:block;flex-shrink:0;overflow:visible;
    }
    .ring-track{
      stroke:var(--ag-custom-ring-track,var(--ag-ring-track-default));
    }
    .ring-fill{
      stroke:var(--ag-custom-ring-used,var(--ag-ring-used-default));
      transition:stroke-dasharray .22s ease,opacity .15s ease;
    }
    :host([data-occupancy="warn"]) .ring-fill{
      stroke:var(--ag-ring-warn);
    }
    :host([data-occupancy="danger"]) .ring-fill{
      stroke:var(--ag-ring-danger);
    }

    /* 顶部快捷操作图标按钮（仅图标，悬停显示说明） */
    .ag-unit-quick{
      width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;
      color:var(--ag-toolbar-fg);
    }
    .ag-unit-quick[hidden]{
      display:none!important;
    }
    .ag-unit-quick:disabled{
      opacity:0.48;cursor:wait;transform:none;
    }
    .topbar-quick-icon{
      width:14px;height:14px;display:block;flex-shrink:0;
    }
    :host([data-occupancy="warn"]) .ag-unit-quick{
      color:var(--ag-ring-warn);
      background:rgba(245,158,11,0.10);
      border-color:rgba(245,158,11,0.24);
    }
    :host([data-occupancy="warn"]) .ag-unit-quick:hover,
    :host([data-occupancy="warn"]) .ag-unit-quick:focus-visible{
      background:rgba(245,158,11,0.18);
    }
    :host([data-occupancy="danger"]) #btn-topbar-compact{
      color:var(--ag-ring-danger);
      background:rgba(239,68,68,0.12);
      border-color:rgba(239,68,68,0.28);
    }
    :host([data-occupancy="danger"]) #btn-topbar-compact:hover,
    :host([data-occupancy="danger"]) #btn-topbar-compact:focus-visible{
      background:rgba(239,68,68,0.20);
    }
    :host([data-occupancy="danger"]) #btn-topbar-window{
      color:#60a5fa;
      background:rgba(37,99,235,0.16);
      border-color:rgba(59,130,246,0.38);
    }
    :host([data-occupancy="danger"]) #btn-topbar-window:hover,
    :host([data-occupancy="danger"]) #btn-topbar-window:focus-visible,
    #btn-topbar-window[aria-expanded="true"]{
      background:rgba(37,99,235,0.24);
      border-color:rgba(59,130,246,0.45);
      color:#60a5fa;
    }
    :host([data-theme="light"][data-occupancy="danger"]) #btn-topbar-window,
    :host([data-panel-tone="light"][data-occupancy="danger"]) #btn-topbar-window,
    :host([data-theme="light"]) #btn-topbar-window[aria-expanded="true"],
    :host([data-panel-tone="light"]) #btn-topbar-window[aria-expanded="true"]{
      color:#2563eb;
    }

    /* 单元 2: 输出速度 */
    #badge-speed{
      color:var(--ag-custom-speed,var(--ag-speed-default));
      min-width:54px;
      justify-content:flex-start;
    }
    #badge-speed:hover,#badge-speed:focus-visible,#badge-speed[aria-expanded="true"]{
      color:var(--ag-custom-speed,var(--ag-toolbar-fg-hover));
    }
    .speed-icon{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.88;font-size:11.5px;line-height:1;
    }
    #speed-amount{
      font-variant-numeric:tabular-nums;
      display:inline-block;
      min-width:32px;
      text-align:left;
      color:inherit;
    }

    /* 单元 2.5: 上下文缓存命中率 */
    #badge-cache{
      color:var(--ag-custom-cache,var(--ag-cache-default));
      justify-content:flex-start;
    }
    #badge-cache:hover,#badge-cache:focus-visible,#badge-cache[aria-expanded="true"]{
      color:var(--ag-custom-cache,var(--ag-toolbar-fg-hover));
    }
    .cache-icon{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.9;
    }
    #cache-amount{
      font-variant-numeric:tabular-nums;
      display:inline-block;
      text-align:left;
      color:inherit;
    }
    #badge-cache[data-cache-state="high"] .cache-icon{
      color:#22c55e;
    }
    :host([data-theme="light"]) #badge-cache[data-cache-state="high"] .cache-icon,
    :host([data-panel-tone="light"]) #badge-cache[data-cache-state="high"] .cache-icon{
      color:#16a34a;
    }
    #badge-cache[data-cache-state="warn"]{
      color:var(--ag-ring-warn);
      background:rgba(245,158,11,0.10);
      border-color:rgba(245,158,11,0.28);
    }
    #badge-cache[data-cache-state="warn"]:hover,
    #badge-cache[data-cache-state="warn"]:focus-visible,
    #badge-cache[data-cache-state="warn"][aria-expanded="true"]{
      color:var(--ag-ring-warn);
      background:rgba(245,158,11,0.18);
    }
    #badge-cache[data-cache-state="low"]{
      color:var(--ag-ring-danger);
      background:rgba(239,68,68,0.12);
      border-color:rgba(239,68,68,0.34);
    }
    #badge-cache[data-cache-state="low"]:hover,
    #badge-cache[data-cache-state="low"]:focus-visible,
    #badge-cache[data-cache-state="low"][aria-expanded="true"]{
      color:var(--ag-ring-danger);
      background:rgba(239,68,68,0.20);
    }

    /* 单元 3: 累计 Token 用量 */
    #badge-tokens{
      color:var(--ag-custom-token-total,var(--ag-token-total-default));
      min-width:68px;
      justify-content:flex-start;
    }
    #badge-tokens:hover,#badge-tokens:focus-visible,#badge-tokens[aria-expanded="true"]{
      color:var(--ag-custom-token-total,var(--ag-toolbar-fg-hover));
    }
    .token-fire-dot{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      flex-shrink:0;opacity:0.95;
    }
    .badge-pct-val{
      font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;
      color:var(--ag-custom-context-text,var(--ag-context-text-default));
      padding-left:2px;
    }
    :host([data-layout="ring-only"]) .badge-pct-val{
      display:none!important;
    }
    #token-amount{
      font-variant-numeric:tabular-nums;
      display:inline-block;
      min-width:38px;
      text-align:left;
      color:inherit;
    }

    /* 下拉选择框与选项在深浅主题下的高对比度保底 */
    select {
      background-color: var(--ag-bg-input, rgba(255,255,255,0.08)) !important;
      color: var(--ag-text-primary, #ececef) !important;
      border: 1px solid var(--ag-border-subcard, rgba(255,255,255,0.15)) !important;
      border-radius: 4px;
      outline: none;
      color-scheme: dark;
    }
    :host([data-theme="light"]) select,
    :host([data-panel-tone="light"]) select {
      background-color: var(--ag-bg-input, #f4f4f5) !important;
      color: var(--ag-text-primary, #18181b) !important;
      border-color: var(--ag-border-subcard, rgba(0,0,0,0.15)) !important;
      color-scheme: light;
    }
    select option {
      background-color: var(--ag-select-option-bg, #27272a) !important;
      color: var(--ag-select-option-fg, #f4f4f5) !important;
    }
    :host([data-theme="light"]) select option,
    :host([data-panel-tone="light"]) select option {
      background-color: #ffffff !important;
      color: #18181b !important;
    }

    /* 单元 4: 窄屏溢出菜单入口 */
    #badge-overflow{
      width:28px;height:28px;padding:0;display:none;
    }
    .overflow-icon{
      width:16px;height:16px;display:block;
    }

    /* 渐进式宽度收缩四阶段: wide -> compact -> minimal -> ring-only */
    :host([data-layout="compact"]){
      gap:1px;
    }
    :host([data-layout="compact"]) .ag-unit-quick{
      width:24px;min-width:24px;height:24px;
    }
    :host([data-layout="compact"]) #badge-speed,
    :host([data-layout="compact"]) #badge-cache,
    :host([data-layout="compact"]) #badge-tokens{
      padding:0 5px;font-size:11.5px;gap:3px;
    }
    :host([data-layout="minimal"]) #badge-speed,
    :host([data-layout="minimal"]) #badge-cache,
    :host([data-layout="minimal"]) #badge-tokens{
      display:none!important;
    }
    :host([data-layout="minimal"]) #badge-overflow{
      display:inline-flex!important;
    }
    :host([data-layout="ring-only"]) #badge-speed,
    :host([data-layout="ring-only"]) #badge-cache,
    :host([data-layout="ring-only"]) #badge-tokens,
    :host([data-layout="ring-only"]) #badge-overflow,
    :host([data-layout="ring-only"]) .ag-unit-quick{
      display:none!important;
    }

    /* 上下文悬停信息气泡（严格还原参考图三层结构） */
    #context-tooltip{
      position:fixed;top:0;left:0;z-index:2147483600;
      min-width:166px;max-width:268px;padding:9px 13px;
      border-radius:10px;border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      pointer-events:none;opacity:0;visibility:hidden;
      transform:translateY(2px);
      transition:opacity .12s ease,transform .12s ease,visibility .12s ease;
      font-variant-numeric:tabular-nums;
    }
    #context-tooltip[data-visible="true"]{
      opacity:1;visibility:visible;transform:translateY(0);
    }
    .ctx-tip-title{
      font-size:12px;line-height:1.35;font-weight:500;
      color:var(--ag-text-muted);margin-bottom:2px;
    }
    .ctx-tip-pct{
      font-size:13px;line-height:1.38;font-weight:600;
      color:var(--ag-custom-context-text,var(--ag-context-text-default));
    }
    :host([data-occupancy="warn"]) .ctx-tip-pct{
      color:var(--ag-ring-warn);
    }
    :host([data-occupancy="danger"]) .ctx-tip-pct{
      color:var(--ag-ring-danger);
    }
    .ctx-tip-detail{
      font-size:12.5px;line-height:1.38;font-weight:500;
      color:var(--ag-custom-context-text,var(--ag-text-secondary));
      margin-top:1px;
    }

    /* 顶部快捷操作悬停说明与点击反馈气泡 */
    #topbar-action-tooltip{
      position:fixed;top:0;left:0;z-index:2147483601;
      min-width:148px;max-width:264px;padding:7px 11px;
      border-radius:9px;border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      pointer-events:none;opacity:0;visibility:hidden;
      transform:translateY(2px);
      transition:opacity .12s ease,transform .12s ease,visibility .12s ease;
    }
    #topbar-action-tooltip[data-visible="true"]{
      opacity:1;visibility:visible;transform:translateY(0);
    }
    #topbar-action-tooltip[data-tone="success"] .topbar-tip-title{
      color:#22c55e;
    }
    #topbar-action-tooltip[data-tone="warn"] .topbar-tip-title{
      color:var(--ag-ring-warn);
    }
    #topbar-action-tooltip[data-tone="error"] .topbar-tip-title{
      color:#ef4444;
    }
    .topbar-tip-title{
      font-size:12px;line-height:1.35;font-weight:600;
      color:var(--ag-text-primary);
    }
    .topbar-tip-desc{
      font-size:11px;line-height:1.38;font-weight:400;
      color:var(--ag-text-muted);margin-top:2px;white-space:pre-line;
    }
    .topbar-tip-desc[hidden]{
      display:none!important;
    }

    /* 顶部上下文窗口快速调节微浮层（方案A做法1） */
    .topbar-window-popover{
      position:fixed;top:36px;right:12px;z-index:2147483550;
      width:232px;padding:9px 10px;border-radius:10px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      display:flex;flex-direction:column;gap:7px;
    }
    .topbar-window-popover[hidden]{display:none!important}
    .twp-header{display:flex;align-items:center;justify-content:space-between;gap:6px}
    .twp-scope-label{font-size:11px;font-weight:600;color:var(--ag-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
    .twp-scope-toggle-btn{
      font-size:10px;font-weight:500;padding:2px 6px;border-radius:4px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      color:var(--ag-text-secondary);cursor:pointer;flex-shrink:0;white-space:nowrap;
      transition:background-color .12s ease,color .12s ease,border-color .12s ease;
    }
    .twp-scope-toggle-btn:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .twp-preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
    .twp-preset-btn{
      display:flex;align-items:center;justify-content:center;
      height:26px;padding:0 4px;border-radius:6px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      color:var(--ag-text-secondary);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;
      cursor:pointer;white-space:nowrap;transition:all .14s ease;
    }
    .twp-preset-btn:hover:not(:disabled){background:var(--ag-btn-hover);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .twp-preset-btn.is-active{border-color:#2563eb;background:rgba(37,99,235,0.16);color:var(--ag-text-primary);box-shadow:inset 0 0 0 1px rgba(37,99,235,0.35)}
    .twp-preset-btn:disabled{opacity:0.45;cursor:not-allowed;border-style:dashed}
    .twp-status-note{font-size:10.5px;line-height:1.35;color:var(--ag-text-muted)}
    .twp-status-note.is-success{color:#22c55e}
    .twp-status-note.is-error{color:#ef4444}
    .twp-status-note[hidden]{display:none!important}
    .twp-more-btn{
      width:100%;text-align:left;padding:5px 7px;border-radius:5px;
      font-size:10.5px;font-weight:500;color:var(--ag-text-secondary);
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      cursor:pointer;transition:background-color .12s ease,color .12s ease;
    }
    .twp-more-btn:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary)}

    /* 窄屏溢出菜单浮层 */
    #overflow-menu{
      position:fixed;top:36px;right:12px;z-index:2147483500;
      width:220px;padding:6px;border-radius:10px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
    }
    #overflow-menu[hidden]{display:none!important}
    .overflow-item{
      width:100%;display:flex;align-items:center;justify-content:space-between;
      padding:7px 9px;border-radius:7px;font-size:12px;color:var(--ag-text-secondary);
      text-align:left;transition:background-color .12s ease,color .12s ease;
    }
    .overflow-item:hover,.overflow-item:focus-visible{
      background:var(--ag-toolbar-bg-hover);color:var(--ag-text-primary);
    }
    .overflow-item-label{display:flex;align-items:center;gap:6px;font-weight:500}
    .overflow-item-val{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ag-text-primary)}
    .overflow-item-val.is-warn{color:var(--ag-ring-warn)}
    .overflow-item-val.is-low{color:var(--ag-ring-danger)}

    /* 会话面板：上下文缓存命中率速览卡片 */
    .cache-summary-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:8px 0 10px}
    .cache-summary-title{color:var(--ag-custom-cache,var(--ag-text-primary))}
    .cache-stat-primary{color:var(--ag-custom-cache,var(--ag-text-primary))}
    #cache-summary[data-cache-state="warn"] .cache-stat-primary{color:var(--ag-ring-warn)}
    #cache-summary[data-cache-state="low"] .cache-stat-primary{color:var(--ag-ring-danger)}

    /* 详情二级抽屉折叠交互 */
    .tech-drawer{margin-top:10px;border-top:1px solid var(--ag-border-subtle);padding-top:9px}
    .drawer-trigger{
      width:100%;display:flex;justify-content:space-between;align-items:center;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      border-radius:7px;padding:7px 11px;color:var(--ag-text-secondary);font-size:11.5px;font-weight:500;
      cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease;
    }
    .drawer-trigger:hover{background:var(--ag-bg-card-hover);color:var(--ag-text-primary);border-color:var(--ag-border-card)}
    .drawer-trigger-left{display:flex;align-items:center;gap:6px}
    .drawer-arrow{font-size:11px;color:var(--ag-text-muted);font-weight:600}
    .drawer-body{margin-top:9px}

    /* 自定义颜色设置网格与自定义颜色选取器面板 */
    .color-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:6px}
    .color-item{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:6px 8px;border-radius:6px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }
    .color-item-lbl{font-size:11px;color:var(--ag-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .color-item-ctrls{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .color-picker{display:none!important}
    .color-swatch-btn{
      width:20px;height:20px;padding:0;border:1px solid var(--ag-border-card);
      border-radius:4px;background:var(--swatch-color,#7748cf);cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,0.18);transition:transform .12s ease,border-color .12s ease;
    }
    .color-swatch-btn:hover{transform:scale(1.08);border-color:var(--ag-text-primary)}
    .color-reset-btn{
      font-size:10.5px;padding:2px 6px;border-radius:4px;
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-muted);
    }
    .color-reset-btn:hover{color:var(--ag-text-primary);background:var(--ag-btn-hover)}
    .color-reset-btn[data-mode="auto"]{opacity:0.55}

    /* 自定义颜色选取器悬浮面板（参考样式：吸管 + 预设圆点 + SV主色区 + 色相条 + HEX/RGB/HSL三行） */
    #color-picker-popover{
      position:fixed;z-index:2147483640;width:304px;max-height:calc(100vh - 48px);overflow-y:auto;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);
      border:1px solid var(--ag-border-panel);border-radius:10px;
      box-shadow:var(--ag-shadow-panel);padding:12px;
      user-select:none;
      opacity:1;transform:translateY(0);
      transition:opacity 170ms cubic-bezier(0.16, 1, 0.3, 1), transform 170ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events:auto;
    }
    #color-picker-popover[hidden]{display:none!important}
    #color-picker-popover.is-opening{
      opacity:0;transform:translateY(-3px);
    }
    #color-picker-popover.is-closing{
      opacity:0;transform:translateY(-3px);
      transition:opacity 125ms cubic-bezier(0.4, 0, 1, 1), transform 125ms cubic-bezier(0.4, 0, 1, 1);
      pointer-events:none!important;
    }
    .cp-advanced-formats{
      margin-top:6px;border-top:1px solid var(--ag-border-subtle);padding-top:6px;
    }
    .cp-fmt-summary{
      font-size:11px;color:var(--ag-text-muted);cursor:pointer;outline:none;user-select:none;
    }
    .cp-fmt-summary:hover{color:var(--ag-text-primary)}
    .source-switch-bar,.view-switch-bar{
      display:inline-flex;align-items:center;background:var(--ag-bg-subcard);
      border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px;
    }
    .switch-pill-btn{
      border:0;background:transparent;color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:2px 8px;border-radius:4px;cursor:pointer;transition:background-color .12s,color .12s;
    }
    .switch-pill-btn:hover{color:var(--ag-text-primary)}
    .switch-pill-btn.active{
      background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;
      box-shadow:0 1px 3px rgba(0,0,0,0.18);
    }
    .plan-summary-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;
      padding:7px 11px;margin-bottom:10px;font-size:11.5px;
    }
    .plan-summary-badge{
      display:inline-flex;align-items:center;gap:6px;font-weight:600;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
    }
    .plan-detail-dl{
      display:grid;
      grid-template-columns:115px minmax(0,1fr);
      gap:6px 12px;
      margin:0;
      align-items:baseline;
    }
    .plan-detail-dl dt{
      color:var(--ag-text-muted);
      font-size:11px;
      white-space:nowrap;
      text-align:left;
    }
    .plan-detail-dl dd{
      margin:0;
      text-align:left;
      max-width:none;
      min-width:0;
      color:var(--ag-text-primary);
      font-size:11.5px;
      line-height:1.45;
      overflow-wrap:break-word;
    }
    @media (max-width: 600px) {
      .plan-detail-dl{
        grid-template-columns:1fr;
        gap:3px 0;
      }
      .plan-detail-dl dt{
        font-weight:600;
        margin-top:3px;
      }
    }
        /* 所有详情与收起面板的丝滑物理展开动画 (匹配一级菜单质感) */
    @keyframes agSmoothExpand{
      0%{
        opacity:0;
        transform:translateY(-6px) scale(0.985);
      }
      100%{
        opacity:1;
        transform:translateY(0) scale(1);
      }
    }
    .collapsible-pane[style*="display: block"],
    .collapsible-pane:not([style*="display: none"]),
    #plan-detail-card:not([style*="display: none"]),
    .drawer-body:not([style*="display: none"]){
      animation: agSmoothExpand 0.2s cubic-bezier(0.16,1,0.3,1) forwards;
      transform-origin: top center;
    }

    /* Antigravity 原生定制下拉组件样式与动效 */
    .ag-dropdown-wrapper{
      position:relative;width:100%;box-sizing:border-box;
    }
    .ag-dropdown-trigger{
      width:100%;box-sizing:border-box;
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:5px 8px;font-size:11px;
      color:var(--ag-text-primary);
      background:var(--ag-bg-input);
      border:1px solid var(--ag-border-subcard);
      border-radius:5px;
      cursor:pointer;user-select:none;
      transition:background .15s cubic-bezier(0.16,1,0.3,1),border-color .15s cubic-bezier(0.16,1,0.3,1),box-shadow .15s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-trigger:hover{
      background:rgba(255,255,255,0.08);
      border-color:rgba(255,255,255,0.22);
    }
    :host([data-theme="light"]) .ag-dropdown-trigger:hover{
      background:rgba(0,0,0,0.05);
      border-color:rgba(0,0,0,0.22);
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-trigger{
      border-color:var(--ag-token-accent-default,#a78bfa);
      box-shadow:0 0 0 2px rgba(167,139,250,0.25);
      background:var(--ag-bg-subcard);
    }
    .ag-dropdown-arrow{
      width:10px;height:10px;display:flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.65;
      transition:transform 0.2s cubic-bezier(0.16,1,0.3,1),opacity 0.2s ease;
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-arrow{
      transform:rotate(180deg);opacity:1;
    }
    .plan-detail-card, .plan-detail-dl{
      overflow:visible !important;
    }
    .ag-dropdown-wrapper.is-open{
      z-index:2147483647 !important;
    }
    .ag-dropdown-menu{
      position:absolute;top:calc(100% + 4px);left:0;right:0;
      max-height:240px;overflow-y:auto;
      background:var(--ag-unified-bg,#1e1e24);
      border:1px solid var(--ag-float-border,rgba(255,255,255,0.14));
      border-radius:7px;
      box-shadow:0 16px 40px rgba(0,0,0,0.65),0 4px 12px rgba(0,0,0,0.4);
      backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
      padding:4px;z-index:2147483647 !important;
      opacity:0;transform:translateY(-6px) scale(0.97);
      transform-origin:top center;pointer-events:none;
      transition:opacity 0.16s cubic-bezier(0.16,1,0.3,1),transform 0.16s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-search-wrap{
      position:sticky;top:-4px;margin:-4px -4px 4px -4px;padding:6px;
      background:var(--ag-unified-bg,#1e1e24);
      border-bottom:1px solid var(--ag-border-subcard);
      z-index:10;
    }
    .ag-dropdown-search-input{
      width:100%;box-sizing:border-box;
      background:var(--ag-bg-input);
      border:1px solid var(--ag-border-subcard);
      border-radius:4px;padding:4px 7px;font-size:11px;
      color:var(--ag-text-primary);outline:none;
    }
    .ag-dropdown-search-input:focus{
      border-color:var(--ag-token-accent-default,#a78bfa);
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-menu{
      opacity:1;transform:translateY(0) scale(1);pointer-events:auto;
    }
    .ag-dropdown-item{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:5.5px 8px;border-radius:4px;
      font-size:11px;color:var(--ag-text-secondary);
      cursor:pointer;user-select:none;
      transition:background 0.12s ease,color 0.12s ease;
    }
    .ag-dropdown-item:hover{
      background:rgba(255,255,255,0.08);color:var(--ag-text-primary);
    }
    :host([data-theme="light"]) .ag-dropdown-item:hover{
      background:rgba(0,0,0,0.05);color:var(--ag-text-primary);
    }
    .ag-dropdown-item.is-selected{
      color:var(--ag-token-accent-default,#a78bfa);
      font-weight:600;background:rgba(167,139,250,0.12);
    }
    .ag-dropdown-item-check{
      font-size:10px;opacity:0;color:var(--ag-token-accent-default,#a78bfa);
    }
    .ag-dropdown-item.is-selected .ag-dropdown-item-check{
      opacity:1;
    }
    .ag-dropdown-item.is-keyboard-focus{
      background:rgba(255,255,255,0.12);outline:1px solid rgba(167,139,250,0.4);
    }
    :host([data-theme="light"]) .ag-dropdown-item.is-keyboard-focus{
      background:rgba(0,0,0,0.08);outline:1px solid rgba(124,58,237,0.4);
    }
    .ag-dropdown-wrapper.open-up .ag-dropdown-menu{
      top:auto;bottom:calc(100% + 4px);
      transform-origin:bottom center;
      transform:translateY(6px) scale(0.97);
    }
    .ag-dropdown-wrapper.is-open.open-up .ag-dropdown-menu{
      transform:translateY(0) scale(1);
    }
    .ag-dropdown-item-sub{
      font-size:9.5px;color:var(--ag-text-muted);margin-left:auto;padding-left:8px;
    }
    .ag-dropdown-item:hover .ag-dropdown-item-sub{
      color:var(--ag-text-secondary);
    }
    .ag-dropdown-menu::-webkit-scrollbar{width:4px}
    .ag-dropdown-menu::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb,rgba(255,255,255,0.2));border-radius:4px}

    .plan-detail-card{
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:11.5px;
    }
    .collapsible-pane{
      transition:opacity 0.18s ease;
    }
    .cp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
    .cp-title{font-size:12.5px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:6px}
    .cp-target-lbl{font-size:11px;font-weight:400;color:var(--ag-text-muted)}
    .cp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:9px}
    .cp-eyedropper-btn{
      display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:6px;
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-primary);
      font-size:11.5px;font-weight:500;cursor:pointer;flex-shrink:0;
    }
    .cp-eyedropper-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    .cp-presets{display:flex;align-items:center;gap:5px}
    .cp-preset-dot{
      width:16px;height:16px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.22);
      cursor:pointer;padding:0;transition:transform .12s ease;
    }
    :host([data-theme="light"]) .cp-preset-dot{border-color:rgba(0,0,0,0.18)}
    .cp-preset-dot:hover{transform:scale(1.16)}
    .cp-stage{display:grid;grid-template-columns:16px 1fr;gap:8px;margin-bottom:8px}
    .cp-side-preview{border-radius:6px;border:1px solid var(--ag-border-card);background:#652ab7}
    .cp-sv-area{
      position:relative;height:132px;border-radius:7px;overflow:hidden;cursor:crosshair;
      border:1px solid var(--ag-border-card);
      background-color:#ff0000;
      background-image:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);
    }
    .cp-sv-thumb{
      position:absolute;width:12px;height:12px;border-radius:50%;
      border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,0.75);
      transform:translate(-50%,-50%);pointer-events:none;left:50%;top:50%;
    }
    .cp-hue-wrap{
      position:relative;height:12px;border-radius:6px;margin-bottom:10px;cursor:ew-resize;
      border:1px solid var(--ag-border-card);
      background:linear-gradient(to right,#ff0000 0%,#ffff00 17%,#00ff00 33%,#00ffff 50%,#0000ff 67%,#ff00ff 83%,#ff0000 100%);
    }
    .cp-hue-thumb{
      position:absolute;top:50%;width:12px;height:12px;border-radius:50%;
      background:#fff;border:2px solid rgba(0,0,0,0.45);box-shadow:0 1px 3px rgba(0,0,0,0.5);
      transform:translate(-50%,-50%);pointer-events:none;left:0%;
    }
    .cp-rows{display:flex;flex-direction:column;gap:6px}
    .cp-row{
      display:grid;grid-template-columns:36px 1fr 24px;align-items:center;gap:6px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-card);
      border-radius:6px;padding:4px 7px;
    }
    .cp-fmt-lbl{font-size:11px;font-weight:600;color:var(--ag-text-muted)}
    .cp-fmt-input{
      width:100%;border:0;background:transparent;color:var(--ag-text-primary);
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;
      outline:none;padding:1px 2px;
    }
    .cp-copy-btn{
      border:0;background:transparent;color:var(--ag-text-muted);cursor:pointer;
      font-size:11.5px;padding:2px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;
    }
    .cp-copy-btn:hover{color:var(--ag-text-primary);background:var(--ag-toolbar-bg-hover)}
    .cp-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:7px;border-top:1px solid var(--ag-border-subtle)}

    /* 弹出面板：上下文 (#panel) 与 Token 用量一览 (#panel-tokens) 独立面板 */
    .ag-panel{
      box-sizing:border-box;
      position:fixed;top:38px;left:auto;right:16px;z-index:2147483500;
      max-width:calc(100vw - 24px);max-height:calc(100vh - 52px);
      overflow:auto;border:1px solid var(--ag-border-panel);border-radius:10px;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);box-shadow:var(--ag-shadow-panel);padding:14px;
      opacity:1;transform:translateY(0);visibility:visible;pointer-events:auto;
      transform-origin:top right;
      transition:opacity .16s cubic-bezier(0.16,1,0.3,1),transform .16s cubic-bezier(0.16,1,0.3,1),visibility .16s ease;
      contain:layout paint;
    }
    #panel{width:472px;max-width:calc(100vw - 24px)}
    #panel-tokens{width:730px;transition:width .22s cubic-bezier(0.16,1,0.3,1),left .22s cubic-bezier(0.16,1,0.3,1),max-width .22s cubic-bezier(0.16,1,0.3,1),opacity .16s cubic-bezier(0.16,1,0.3,1),transform .16s cubic-bezier(0.16,1,0.3,1)}
    .ag-panel[hidden]{display:block!important;opacity:0;transform:translateY(-6px);visibility:hidden;pointer-events:none}

    /* 视图内平滑交叉淡入淡出（避免直接 display 硬切导致内容跳闪） */
    @keyframes agFadeIn{
      from{opacity:0;transform:translateY(4px)}
      to{opacity:1;transform:translateY(0)}
    }
    .view-pane-fade{transition:opacity .15s ease,transform .15s ease;opacity:1;transform:translateY(0)}
    .view-pane-fade.pane-hidden{opacity:0;transform:translateY(3px);display:none!important}

    /* 顶栏控制条（sticky 固定，防止表单或详情展开时滚出视口） */
    .panel-header-bar{
      position:sticky;top:-14px;background:var(--ag-bg-panel);z-index:20;
      margin-top:-14px;padding-top:14px;
      display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:nowrap;
      border-bottom:1px solid var(--ag-border-subtle);padding-bottom:9px;margin-bottom:9px
    }
    .panel-title{display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 auto;overflow:hidden}
    .panel-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .panel-title-tokens{color:var(--ag-custom-token-accent,var(--ag-token-accent-default))}
    .panel-header-actions{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;flex-shrink:0}
    .ctx-header-actions{justify-content:flex-end}

    .panel-icon-btn{
      background:none;border:0;color:var(--ag-text-muted);font-size:12px;line-height:1;
      padding:4px 7px;border-radius:6px;cursor:pointer;transition:background-color .14s ease,color .14s ease;
      display:inline-flex;align-items:center;justify-content:center;gap:3px;
    }
    .panel-icon-btn:hover{color:var(--ag-text-primary);background:var(--ag-toolbar-bg-hover)}
    #close,#close-tokens{font-size:16px;padding:2px 7px}

    h3{margin:0;font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    h4{margin:12px 0 5px;font-size:11.5px;font-weight:600;color:var(--ag-text-secondary)}
    p{margin:5px 0;color:var(--ag-text-muted)}
    .drawer-body dl{display:grid;grid-template-columns:1fr auto;gap:5px;margin:0}
    .drawer-body dt{color:var(--ag-text-muted)}
    .drawer-body dd{margin:0;text-align:right;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:270px}

    #key-summary{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:6px 0 10px}
    .key-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
    .key-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px}
    .key-pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid transparent}
    .pill-good, .pill-ok{color:#52c41a;background:rgba(82,196,26,0.12);border-color:rgba(82,196,26,0.28)}
    :host([data-theme="light"]) .pill-good, :host([data-theme="light"]) .pill-ok{color:#389e0d;background:#f6ffed;border-color:#b7eb8f}
    .pill-info{color:#1890ff;background:rgba(24,144,255,0.12);border-color:rgba(24,144,255,0.28)}
    :host([data-theme="light"]) .pill-info{color:#096dd9;background:#e6f7ff;border-color:#91d5ff}
    .pill-warn{color:#faad14;background:rgba(250,173,20,0.12);border-color:rgba(250,173,20,0.28)}
    :host([data-theme="light"]) .pill-warn{color:#d46b08;background:#fff7e6;border-color:#ffd591}
    .pill-danger{color:#ff4d4f;background:rgba(255,77,79,0.14);border-color:rgba(255,77,79,0.32)}
    :host([data-theme="light"]) .pill-danger{color:#cf1322;background:#fff1f0;border-color:#ffa39e}
    .pill-muted{color:var(--ag-pill-muted-text);background:var(--ag-pill-muted-bg);border-color:var(--ag-pill-muted-border)}

    .key-bar-track{width:100%;height:6px;background:var(--ag-custom-ring-track,var(--ag-track-bg));border-radius:3px;overflow:hidden;margin-bottom:9px}
    .key-bar-fill{height:100%;width:0%;border-radius:3px;background:var(--ag-custom-ring-used,var(--bar-color,#69c0ff));transition:width .24s ease,background-color .2s ease}
    :host([data-occupancy="warn"]) .key-bar-fill{background:var(--ag-ring-warn)}
    :host([data-occupancy="danger"]) .key-bar-fill{background:var(--ag-ring-danger)}
    .key-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;margin-bottom:7px}
    .key-stat{background:var(--ag-bg-subcard);padding:6px 4px;border-radius:6px;border:1px solid var(--ag-border-subcard)}
    .key-stat-label{font-size:10px;color:var(--ag-text-muted);margin-bottom:2px}
    .key-stat-val{font-size:12px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #key-used{color:var(--ag-custom-context-text,var(--ag-text-primary))}
    .key-takeaway{font-size:11px;color:var(--ag-text-secondary);padding-top:6px;border-top:1px solid var(--ag-border-subcard);line-height:1.4}

    .version-sync-banner{
      background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);
      color:var(--ag-text-primary);border-radius:7px;padding:7px 10px;
      margin-bottom:8px;font-size:11px;line-height:1.4;
    }
    .version-sync-banner[hidden]{display:none!important}
    .version-sync-banner-text code{
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      font-size:10px;padding:1px 4px;border-radius:4px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }

    #status{padding:7px 10px;border:0;border-left:2.5px solid var(--tone,#666);border-radius:4px;background:var(--ag-bg-status);color:var(--ag-text-status);font-weight:500;font-size:11.5px}
    #model{overflow-wrap:anywhere;font-size:11.5px;color:var(--ag-text-muted)}
    #note,#coverage,#updated{font-size:11px;color:var(--ag-text-muted)}
    #refresh{border:1px solid var(--ag-btn-border);border-radius:6px;background:var(--ag-btn-bg);color:var(--ag-btn-text);padding:4px 10px;margin-top:8px;transition:background-color .14s ease,border-color .14s ease}
    #refresh:hover:not(:disabled){background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    #files{max-height:220px;overflow:auto}
    .file{padding:7px 0;border-top:1px solid var(--ag-border-subtle)}
    .file-name{overflow-wrap:anywhere;color:var(--ag-text-primary)}
    .file-detail{color:var(--ag-text-muted);font-size:11px}
    .file-unknown{color:#e6b865;font-size:11px}
    :host([data-theme="light"]) .file-unknown{color:#b45309}
    #v{color:var(--ag-text-muted);font-size:10px;font-weight:400;margin-left:2px;flex-shrink:0}

    /* 全局 Token 用量一览 */
    #view-tokens{display:flex;flex-direction:column;gap:10px}
    .token-stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .t-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px;transition:background-color .14s ease}
    .t-card:hover{background:var(--ag-bg-card-hover)}
    .t-card-lbl{font-size:11px;color:var(--ag-text-muted);display:flex;justify-content:space-between}
    .t-card-val{font-size:16.5px;font-weight:700;color:var(--ag-text-primary);letter-spacing:-0.3px;font-variant-numeric:tabular-nums}
    #t-total-val{color:var(--ag-custom-token-total,var(--ag-text-primary))}
    #t-today-val{color:var(--ag-custom-token-accent,var(--ag-text-primary))}
    .t-card-sub{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .heatmap-section{background:var(--ag-heat-bg);border:1px solid var(--ag-border-card);border-radius:10px;padding:12px}
    .heat-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    .heat-header-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .heat-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .first-use-badge{
      font-size:11px;font-weight:500;color:var(--ag-text-secondary);
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-card);
      border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums;
    }
    .heat-win-nav{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .heat-nav-btn{
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-secondary);
      border-radius:4px;padding:1px 6px;font-size:11px;line-height:1.25;cursor:pointer;
    }
    .heat-nav-btn:hover:not(:disabled){background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .heat-nav-btn:disabled{opacity:0.35;cursor:default}
    .heat-tabs{
      position:relative;display:inline-flex;align-items:center;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
      border-radius:9999px;padding:2px;gap:2px;user-select:none;
    }
    .heat-tab-thumb{
      position:absolute;top:2px;bottom:2px;left:0;width:0;
      border-radius:9999px;
      background:var(--ag-tab-thumb-bg, var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa)));
      opacity:0.25;pointer-events:none;
      transition:transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      will-change:transform, width;
    }
    @media (prefers-reduced-motion: reduce){
      .heat-tab-thumb{transition:none!important}
    }
    .heat-tab-btn{
      position:relative;z-index:1;border:0;background:transparent;
      color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:3px 10px;border-radius:9999px;cursor:pointer;
      transition:color .14s ease;outline:none;white-space:nowrap;
    }
    .heat-tab-btn:hover{color:var(--ag-text-primary)}
    .heat-tab-btn.active{color:var(--ag-text-primary);font-weight:600}
    .heat-tab-btn:focus-visible{box-shadow:0 0 0 1.5px var(--ag-token-accent-default,#a78bfa)}

    .heat-scroll-box{overflow-x:auto;overflow-y:hidden;padding:6px 6px 4px 6px}
    .heat-grid-cols{display:flex;gap:3px}
    .heat-week-col{display:flex;flex-direction:column;gap:3px}
    .heat-cell{width:10px;height:10px;border-radius:2px;background:var(--ag-heat-lvl-0);cursor:pointer;transition:transform .12s ease}
    .heat-cell:hover{transform:scale(1.3);z-index:5;outline:1.5px solid var(--ag-heat-outline)}
    .heat-cell.is-future{opacity:0.36}
    .heat-cell.is-today{outline:1.5px solid var(--ag-custom-token-accent,var(--ag-token-accent-default));outline-offset:0.5px}
    .lvl-0{background:var(--ag-heat-lvl-0)}
    .lvl-1{background:var(--ag-heat-lvl-1)}
    .lvl-2{background:var(--ag-heat-lvl-2)}
    .lvl-3{background:var(--ag-heat-lvl-3)}
    .lvl-4{background:var(--ag-heat-lvl-4)}

    .heat-months{position:relative;height:18px;margin-top:4px;font-size:11px;color:var(--ag-text-muted);overflow:hidden}
    .heat-month-item{position:absolute;white-space:nowrap}

    #h-weekly-box{display:none;height:105px;align-items:flex-end;gap:3px;border-bottom:1px solid var(--ag-border-subtle);padding-bottom:3px}
    .w-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer}
    .w-bar-fill{width:100%;border-radius:2px 2px 0 0;background:var(--ag-heat-lvl-0);min-height:3px;transition:height .22s ease,background-color .14s ease}
    .w-bar-col:hover .w-bar-fill{background:var(--ag-custom-token-accent,var(--ag-heat-lvl-4))!important}

    #h-monthly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-month-grid{display:grid;width:100%;height:100%;align-content:center;justify-content:center}
    .heat-month-cell{display:flex;align-items:center;justify-content:center;border-radius:3px;cursor:pointer;transition:transform .12s ease}
    .heat-month-cell:hover{transform:scale(1.18);z-index:5;outline:1.5px solid var(--ag-heat-outline,#fff)}
    .heat-month-cell-num{font-size:9.5px;font-weight:600;color:rgba(255,255,255,0.9);text-shadow:0 1px 2px rgba(0,0,0,0.65);pointer-events:none}
    :host([data-theme="light"]) .heat-month-cell-num{color:#18181b;text-shadow:none}

    #h-yearly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-yearly-svg{width:100%;height:105px;display:block;overflow:visible}
    @keyframes bubblePopIn{0%{transform:scale(0.6);opacity:0}100%{transform:scale(1);opacity:1}}
    .heat-yearly-bubble-group{transform-origin:center center;animation:bubblePopIn 0.22s cubic-bezier(0.16,1,0.3,1) both;cursor:pointer}
    /* 上下文加长面板样式 */
    .unlock-panel-content{padding:4px 0 2px;display:flex;flex-direction:column;gap:8px}
    .unlock-status-row{display:flex;justify-content:space-between;align-items:flex-start;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .unlock-label{font-size:11px;font-weight:600;color:var(--ag-text-primary);margin-bottom:2px}
    .unlock-desc{font-size:11px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice{background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.22);border-radius:6px;padding:7px 9px}
    .unlock-notice-title{font-size:10.5px;font-weight:600;color:#eab308;margin-bottom:3px}
    .unlock-notice-list{margin:0;padding-left:14px;font-size:10px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice-list li{margin-bottom:2px}
    .unlock-notice-list strong{color:var(--ag-text-primary)}
    .unlock-actions-row{display:flex;gap:8px;align-items:center;margin-top:2px}
    .unlock-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease}
    .unlock-btn:disabled{opacity:0.5;cursor:not-allowed}
    .unlock-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}
    .unlock-btn-primary:hover:not(:disabled){background:#1d4ed8}
    .unlock-btn-secondary{background:var(--ag-bg-subcard);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard)}
    .unlock-btn-secondary:hover:not(:disabled){background:var(--ag-bg-card-hover)}
    .unlock-result-box{border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.4}
    .unlock-result-box.result-success{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:#22c55e}
    .unlock-result-box.result-error{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444}
    .unlock-meta-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:10.5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 10px;margin:2px 0}
    .unlock-meta-dl dt{color:var(--ag-text-muted);font-weight:500}
    .unlock-meta-dl dd{margin:0;color:var(--ag-text-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .unlock-credit-bar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;font-size:10.5px;color:var(--ag-text-muted);border-top:1px dashed var(--ag-border-subtle);padding-top:7px;margin-top:4px}
    .unlock-credit-left{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
    .unlock-author-link{color:var(--ag-link,#38bdf8);text-decoration:underline;text-underline-offset:2px;font-weight:600;cursor:pointer;padding:1px 4px;border-radius:4px;transition:all .15s ease;display:inline-flex;align-items:center}
    .unlock-author-link:hover{color:#7dd3fc;background:rgba(56,189,248,0.12)}
    .unlock-author-link:focus-visible{outline:2px solid var(--ag-link,#38bdf8);background:rgba(56,189,248,0.18)}
    .unlock-copy-link-btn{background:transparent;border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);border-radius:4px;font-size:10px;padding:1px 6px;cursor:pointer;transition:all .15s ease}
    .unlock-copy-link-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-text-muted);background:var(--ag-bg-card-hover)}
    .unlock-copy-link-btn:focus-visible{outline:1px solid var(--ag-link,#38bdf8)}
    .unlock-link-toast{margin-top:4px;font-size:10px;padding:4px 8px;border-radius:4px;background:rgba(56,189,248,0.12);color:var(--ag-text-primary);border:1px solid rgba(56,189,248,0.3);line-height:1.4;animation:agSmoothExpand 0.15s ease}
    .unlock-adapter-note{font-size:9.5px;opacity:0.8}
    .ctx-adjust-trigger{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}
    .ctx-adjust-trigger:hover{background:var(--ag-bg-card-hover);border-color:var(--ag-link,#38bdf8)}
    .ctx-model-card,.ctx-adjust-box{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
    .ctx-model-header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap}
    .ctx-model-name{font-size:11.5px;font-weight:600;color:var(--ag-text-primary);line-height:1.3}
    .ctx-model-id{font-size:10px;color:var(--ag-text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-all;margin-top:1px}
    .ctx-model-picker-wrap{display:flex;flex-direction:column;gap:2px;min-width:140px;max-width:190px;flex:1 1 140px}
    .ctx-small-label{font-size:10px;color:var(--ag-text-muted)}
    .ctx-model-select{background:var(--ag-bg-card);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard);border-radius:4px;padding:3px 6px;font-size:10.5px;width:100%;outline:none}
    .ctx-pref-banner{border-top:1px dashed var(--ag-border-subtle);padding-top:5px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}
    .ctx-pref-val{font-size:10.5px;font-weight:600;color:var(--ag-link,#38bdf8)}
    .ctx-preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .ctx-preset-btn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:var(--ag-bg-card);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;cursor:pointer;transition:all .15s ease;color:var(--ag-text-primary)}
    .ctx-preset-btn:hover:not(:disabled){background:var(--ag-bg-card-hover);border-color:var(--ag-text-muted)}
    .ctx-preset-btn.active{border-color:#2563eb;background:rgba(37,99,235,0.14);box-shadow:inset 0 0 0 1px rgba(37,99,235,0.35)}
    .ctx-preset-btn:disabled,.ctx-preset-btn.is-disabled{opacity:0.48;cursor:not-allowed;border-style:dashed}
    .ctx-preset-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-preset-sub{font-size:9.5px;color:var(--ag-text-secondary);line-height:1.25}
    .ctx-custom-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
    .ctx-custom-input-wrap{display:flex;align-items:center;flex:1;background:var(--ag-bg-card);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:0 8px}
    .ctx-custom-input-wrap:focus-within{border-color:#2563eb}
    .ctx-custom-input{flex:1;min-width:0;background:transparent;border:none;color:var(--ag-text-primary);font-size:11px;padding:5px 0;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .ctx-input-unit{font-size:10px;color:var(--ag-text-muted);margin-left:4px}
    .ctx-validation-msg{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-validation-msg.is-error{color:#ef4444;font-weight:500}
    .ctx-validation-msg.is-warn{color:#eab308}
    .ctx-pref-actions,.unlock-actions-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px}
    .ctx-scope-note{font-size:10px;color:#eab308;margin-top:4px;line-height:1.35}

    @media (prefers-reduced-motion: reduce){.heat-yearly-bubble-group{animation:none!important}}
    .heat-yearly-bubble-group:hover circle.bubble-main{filter:brightness(1.22);stroke:var(--ag-text-primary);stroke-width:1.5px}

    #h-cum-box{display:none;height:105px;position:relative}
    canvas#h-cum-canvas{width:100%;height:105px;display:block}

    .heat-summary-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
      margin-top:8px;padding:5px 8px;background:var(--ag-bg-subcard);border-radius:6px;
      border:1px solid var(--ag-border-subcard);font-size:11px;
    }
    .heat-sum-item{display:inline-flex;align-items:center;gap:4px}
    .heat-sum-label{color:var(--ag-text-muted);font-size:10px}
    .heat-sum-val{color:var(--ag-text-primary);font-weight:600;font-variant-numeric:tabular-nums}

    .heat-preset-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin:6px 0 8px}
    .heat-preset-group{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
    .heat-preset-btn{
      display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;
      border:1px solid var(--ag-border-card);background:var(--ag-bg-subcard);color:var(--ag-text-secondary);
      font-size:11px;cursor:pointer;transition:border-color .12s ease,color .12s ease;
    }
    .heat-preset-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .heat-preset-btn[data-active="true"]{
      color:var(--ag-text-primary);border-color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      font-weight:600;
    }
    .heat-preset-dots{display:inline-flex;gap:2px}
    .heat-preset-dots i{width:7px;height:7px;border-radius:1.5px;display:inline-block}

    .heat-leg-swatch{
      width:11px;height:11px;padding:0;border-radius:2.5px;
      border:1px solid var(--ag-border-card);
      background:var(--swatch-color,var(--ag-heat-lvl-0));
      cursor:pointer;flex-shrink:0;
      transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;
    }
    .heat-leg-swatch:hover{
      transform:scale(1.32);z-index:2;
      border-color:var(--ag-text-primary);
      box-shadow:0 0 0 1px var(--ag-text-primary);
    }
    .heat-leg-swatch[data-custom="true"]{
      border-color:var(--ag-text-secondary);
    }

    .heat-lvl-custom-bar{
      margin:6px 0 8px;padding:7px 8px;border-radius:7px;
      background:var(--ag-bg-card);border:1px solid var(--ag-border-card);
    }
    .heat-lvl-custom-hdr{
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      margin-bottom:6px;flex-wrap:wrap;
    }
    .heat-lvl-grid{
      display:grid;grid-template-columns:repeat(auto-fit,minmax(122px,1fr));gap:6px;
    }
    .heat-lvl-item{
      display:flex;align-items:center;justify-content:space-between;gap:4px;
      padding:5px 7px;border-radius:6px;
      background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);
    }
    .heat-lvl-lbl{
      font-size:10.5px;color:var(--ag-text-secondary);font-weight:500;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }

    .heat-popover{position:fixed;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);border-radius:8px;padding:7px 11px;box-shadow:var(--ag-pop-shadow);z-index:2147483600;opacity:0;transform:translate(-50%,-100%) translateY(-6px);transition:opacity .12s ease}
    .pop-date{font-size:11.5px;color:var(--ag-pop-muted)}
    .pop-val{font-size:13.5px;font-weight:600;color:var(--ag-pop-text);margin:2px 0 4px}
    .pop-det{font-size:10.5px;color:var(--ag-pop-sub);margin-top:2px;display:flex;gap:12px;align-items:flex-start}
    .pop-det-col{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px}
    .pop-det-val{font-size:11px;font-weight:500;color:var(--ag-pop-sub);font-variant-numeric:tabular-nums;white-space:nowrap}
    .pop-det-trans{font-size:9.5px;color:var(--ag-pop-muted);opacity:0.88;white-space:nowrap;line-height:1.2}

    /* 上下文面板分页、模型卡片、状态条与速度对比图表 */
    .unlock-panel-content{padding:4px 0 2px;display:flex;flex-direction:column;gap:8px}
    .unlock-status-row{display:flex;justify-content:space-between;align-items:flex-start;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .unlock-label{font-size:11px;font-weight:600;color:var(--ag-text-primary);margin-bottom:2px}
    .unlock-desc{font-size:11px;color:var(--ag-text-secondary);line-height:1.4}
    .unlock-notice{background:rgba(234,179,8,0.06);border:1px solid rgba(234,179,8,0.2);border-radius:6px;padding:8px 10px}
    .unlock-notice-list{margin:0;padding-left:15px;font-size:10.5px;color:var(--ag-text-secondary);line-height:1.45}
    .unlock-notice-list li{margin-bottom:4px}
    .unlock-notice-list strong{color:var(--ag-text-primary)}
    .unlock-actions-row{display:flex;gap:8px;align-items:center;margin-top:2px;flex-wrap:wrap}
    .unlock-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 11px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}
    .unlock-btn[hidden]{display:none!important}
    .unlock-btn:disabled{opacity:0.5;cursor:not-allowed}
    .unlock-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}
    .unlock-btn-primary:hover:not(:disabled){background:#1d4ed8}
    .unlock-btn-secondary{background:var(--ag-bg-subcard);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard)}
    .unlock-btn-secondary:hover:not(:disabled){background:var(--ag-bg-card-hover)}
    .unlock-result-box{border-radius:6px;padding:7px 9px;font-size:11px;line-height:1.4;margin-top:4px}
    .unlock-result-box.result-success{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:#22c55e}
    .unlock-result-box.result-error{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444}
    .unlock-meta-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:10.5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 10px;margin:2px 0}
    .unlock-meta-dl dt{color:var(--ag-text-muted);font-weight:500}
    .unlock-meta-dl dd{margin:0;color:var(--ag-text-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .unlock-credit-bar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;font-size:10.5px;color:var(--ag-text-muted);border-top:1px dashed var(--ag-border-subtle);padding-top:7px;margin-top:4px}
    .unlock-credit-left{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
    .unlock-author-link{color:var(--ag-link,#38bdf8);text-decoration:underline;text-underline-offset:2px;font-weight:600;cursor:pointer;padding:1px 4px;border-radius:4px;transition:all .15s ease;display:inline-flex;align-items:center}
    .unlock-author-link:hover{color:#7dd3fc;background:rgba(56,189,248,0.12)}
    .unlock-author-link:focus-visible{outline:2px solid var(--ag-link,#38bdf8);background:rgba(56,189,248,0.18)}
    .unlock-copy-link-btn{background:transparent;border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);border-radius:4px;font-size:10px;padding:1px 6px;cursor:pointer;transition:all .15s ease}
    .unlock-copy-link-btn:hover{color:var(--ag-text-primary);border-color:var(--ag-text-muted);background:var(--ag-bg-card-hover)}
    .unlock-link-toast{margin-top:4px;font-size:10px;padding:4px 8px;border-radius:4px;background:rgba(56,189,248,0.12);color:var(--ag-text-primary);border:1px solid rgba(56,189,248,0.3);line-height:1.4;animation:agSmoothExpand 0.15s ease}
    .unlock-adapter-note{font-size:9.5px;opacity:0.8}

    /* 模型选择器（模型设置页内） & 分页栏 */
    .ctx-header-model-ctrl{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex-wrap:wrap}
    .ctx-models-toolbar{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:7px 9px;margin-bottom:8px}
    .ctx-selector-role-lbl{font-size:10.5px;color:var(--ag-text-muted);white-space:nowrap;flex-shrink:0}
    .ctx-header-dropdown{flex:1 1 160px;min-width:0;max-width:100%}
    .ctx-compact-trigger{padding:4px 8px!important;font-size:11px!important;max-width:100%}
    .ctx-compact-trigger .ag-dropdown-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
    .ctx-model-dropdown-menu{min-width:220px;max-width:100%;left:0;right:auto}
    .ctx-card-details-drawer{border-top:1px solid var(--ag-border-subtle);padding-top:6px;margin-top:2px}
    .ctx-card-drawer-trigger{font-size:11px;padding:2px 0}
    .ctx-card-drawer-body{padding-top:6px}
    .ctx-model-group-hdr.is-history-hdr{margin-top:4px;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;opacity:0.85}
    .ctx-product-row-history-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-muted);flex-shrink:0}
    .ctx-mini-link-btn{background:none;border:0;color:var(--ag-link,#38bdf8);font-size:10px;padding:2px 4px;cursor:pointer;white-space:nowrap;text-decoration:underline;text-underline-offset:2px}
    .ctx-mini-link-btn[hidden]{display:none!important}
    .ag-dropdown-group-title{display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:10px;font-weight:600;color:var(--ag-text-muted);letter-spacing:0.2px;cursor:default;user-select:none;border-top:1px solid var(--ag-border-subtle);margin-top:3px}
    .ag-dropdown-group-title:first-child{border-top:0;margin-top:0}
    .ag-vendor-dot{width:7px;height:7px;border-radius:999px;display:inline-block;flex-shrink:0;background:var(--ag-text-muted)}
    .ag-dropdown-badge{font-size:9.5px;padding:0 5px;border-radius:9px;background:rgba(56,189,248,0.14);color:var(--ag-link,#38bdf8);border:1px solid rgba(56,189,248,0.3);margin-left:4px;flex-shrink:0}

    .ctx-tabs-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:7px;padding:3px;margin-bottom:9px;box-sizing:border-box;width:100%}
    .ctx-tab-btn{display:flex;align-items:center;justify-content:center;min-width:0;border:1px solid transparent;background:transparent;color:var(--ag-text-muted);font-size:11.5px;font-weight:500;padding:5px 4px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .05s ease}
    .ctx-tab-btn:hover{color:var(--ag-text-primary);background:rgba(255,255,255,0.05)}
    .ctx-tab-btn:active{transform:scale(0.97);background:rgba(255,255,255,0.08)}
    .ctx-tab-btn:focus-visible{outline:2px solid var(--primary,#38bdf8);outline-offset:1px}
    .ctx-tab-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.28);border:1px solid var(--ag-border-card)}
    :host([data-theme="light"]) .ctx-tab-btn.active{box-shadow:0 1px 3px rgba(0,0,0,0.12);border-color:rgba(0,0,0,0.12)}

    .ctx-lang-top-segmented{display:inline-flex;align-items:center;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px;flex-shrink:0;vertical-align:middle;margin-right:2px}
    .ctx-lang-top-segmented .ctx-seg-btn{border:1px solid transparent;background:transparent;color:var(--ag-text-muted);font-size:10.5px;font-weight:500;padding:2px 6px;border-radius:4px;cursor:pointer;line-height:15px;transition:all .15s ease}
    .ctx-lang-top-segmented .ctx-seg-btn:hover{color:var(--ag-text-primary);background:rgba(255,255,255,0.05)}
    .ctx-lang-top-segmented .ctx-seg-btn:active{transform:scale(0.96)}
    .ctx-lang-top-segmented .ctx-seg-btn:focus-visible{outline:1.5px solid var(--primary,#38bdf8);outline-offset:1px}
    .ctx-lang-top-segmented .ctx-seg-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,0.2);border:1px solid var(--ag-border-card)}

    .ag-modal-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;animation:agFadeIn .15s ease-out}
    .ag-modal-overlay[hidden]{display:none !important}
    .ag-modal-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:10px;padding:16px 18px;max-width:340px;width:100%;box-shadow:0 16px 40px rgba(0,0,0,0.6),0 2px 10px rgba(0,0,0,0.3);display:flex;flex-direction:column;gap:12px}
    .ag-modal-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .ag-modal-body{font-size:11.5px;line-height:1.5;color:var(--ag-text-secondary)}
    .ag-modal-feedback{font-size:11px;line-height:1.4;padding:6px 8px;border-radius:5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary)}
    .ag-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
    .ctx-brand-feedback{font-size:11px;margin-top:6px;padding:5px 8px;border-radius:5px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary)}
    .ctx-tab-pane[hidden]{display:none!important}

    /* 当前会话紧凑卡片 */
    .ctx-compact-card{display:flex;flex-direction:column;align-items:stretch;gap:7px;background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 11px;margin:8px 0 4px}
    .ctx-compact-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ctx-compact-info{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1}
    .ctx-compact-title-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .ctx-compact-title{font-size:11.5px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-compact-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10.5px;color:var(--ag-text-secondary)}
    .ctx-compact-meta strong{color:var(--ag-text-primary);font-weight:600}
    .ctx-compact-link-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:4px 9px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0}
    .ctx-compact-link-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    .session-ctx-preset-bar{margin-top:1px}

    /* 模型设置页：全局状态条 */
    .ctx-status-bar{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:8px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}
    .ctx-status-bar-main{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-status-left{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .ctx-client-status-text{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-restart-btn[hidden],.ctx-restart-confirm[hidden],.ctx-manual-restart-note[hidden],.ctx-restart-feedback[hidden],.ctx-status-subnote[hidden]{display:none!important}
    .ctx-status-subnote{font-size:10.5px;color:#eab308;line-height:1.35}
    .ctx-manual-restart-note{font-size:10.5px;color:var(--ag-text-secondary);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;line-height:1.4}
    .ctx-restart-confirm{background:rgba(234,179,8,0.09);border:1px solid rgba(234,179,8,0.3);border-radius:6px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-restart-confirm-text{font-size:10.5px;color:var(--ag-text-primary);line-height:1.35;flex:1;min-width:170px}
    .ctx-restart-confirm-actions{display:flex;gap:6px;align-items:center}
    .ctx-restart-feedback{font-size:10.5px;color:var(--ag-link,#38bdf8);line-height:1.35}

    /* 模式选择器（统一设置 vs 按模型分别设置） */
    .ctx-scope-selector-wrap{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:5px;margin-bottom:8px}
    .ctx-scope-mode-toggle{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .ctx-mode-tab-btn{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;cursor:pointer;color:var(--ag-text-secondary);transition:all .15s ease}
    .ctx-mode-tab-btn:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .ctx-mode-tab-btn.is-active{background:rgba(37,99,235,0.12);border-color:rgba(37,99,235,0.48);color:var(--ag-text-primary);box-shadow:0 1px 3px rgba(0,0,0,0.06)}
    .ctx-mode-tab-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-mode-tab-desc{font-size:9.5px;color:var(--ag-text-muted);line-height:1.3}

    /* 厂商分组模型列表 */
    .ctx-model-list{display:flex;flex-direction:column;gap:6px;max-height:175px;overflow-y:auto;background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:7px;margin-bottom:8px}
    .ctx-model-group{display:flex;flex-direction:column;gap:3px}
    .ctx-model-group-hdr{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;color:var(--ag-text-muted);padding:2px 4px}
    .ctx-product-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:5px;padding:5px 7px;cursor:pointer;color:var(--ag-text-secondary);font-size:11px;transition:background .12s ease,border-color .12s ease}
    .ctx-product-row:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .ctx-product-row.is-active{background:rgba(37,99,235,0.14);border-color:rgba(37,99,235,0.42);color:var(--ag-text-primary);font-weight:600}
    .ctx-product-row.is-unavailable{opacity:0.65}
    .ctx-product-row-unavailable-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;flex-shrink:0}
    .ctx-product-row-notice-tag{font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;flex-shrink:0}
    .ctx-product-row-left{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
    .ctx-product-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-product-row-right{display:flex;align-items:center;gap:4px;flex-shrink:0;font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .ctx-product-row-val.is-conflict{color:#f59e0b;font-weight:600}

    /* 模型大卡片 */
    .ctx-detail-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px 11px;margin-bottom:8px;display:flex;flex-direction:column;gap:8px}
    .ctx-conflict-banner{background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.34);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:5px}
    .ctx-conflict-banner[hidden]{display:none!important}
    .ctx-conflict-title{font-size:10.5px;font-weight:600;color:#f59e0b}
    .ctx-conflict-rows{display:flex;flex-direction:column;gap:4px}
    .ctx-conflict-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--ag-text-primary)}
    .ctx-conflict-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer}
    .ctx-conflict-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    .ctx-card-top{display:flex;flex-direction:column;gap:3px}
    .ctx-card-vendor-row{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--ag-text-muted)}
    .ctx-card-product-name{font-size:13.5px;font-weight:600;color:var(--ag-text-primary);line-height:1.3;overflow-wrap:anywhere;word-break:break-word}
    .ctx-card-efforts-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--ag-text-secondary)}
    .ctx-card-session-effort{font-weight:600;color:var(--ag-link,#38bdf8)}
    .ctx-card-session-effort[hidden]{display:none!important}

    /* 精简主界面三项高亮网格 */
    .ctx-summary-highlight-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:8px 10px}
    .ctx-summary-item{display:flex;flex-direction:column;gap:2px;min-width:0}
    .ctx-summary-item-length{grid-column:1 / -1;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;margin-top:2px}
    .ctx-summary-label{font-size:10px;font-weight:500;color:var(--ag-text-muted)}
    .ctx-summary-value{font-size:11.5px;font-weight:600;color:var(--ag-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-summary-length-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .ctx-length-val{font-size:12.5px;color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))}

    .ctx-card-metrics{display:flex;flex-direction:column;gap:5px}
    .ctx-metric-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:start;gap:6px 8px;padding:5px 8px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-left-width:3px;border-radius:5px;font-size:11px}
    .ctx-metric-saved{border-left-color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))}
    .ctx-metric-request{border-left-color:var(--ag-custom-speed,var(--ag-speed-default,#38bdf8))}
    .ctx-metric-client{border-left-color:var(--ag-text-muted)}
    .ctx-metric-observed{border-left-color:var(--ag-custom-speed,var(--ag-speed-default,#38bdf8))}
    .ctx-metric-convo{border-left-color:var(--ag-text-muted)}
    .ctx-metric-diagnosis{border-left-color:#10b981}
    .ctx-metric-diagnosis-val{font-size:10.5px;font-weight:500;line-height:1.4}
    .ctx-metric-diagnosis-val.is-confirmed{color:#10b981}
    .ctx-metric-diagnosis-val.is-mismatch{color:#ef4444}
    .ctx-metric-diagnosis-val.is-dispatched_pending_confirm,
    .ctx-metric-diagnosis-val.is-saved_pending_dispatch{color:#f59e0b}
    .ctx-metric-label{font-size:10.5px;color:var(--ag-text-muted);font-weight:500;padding-top:1px}
    .ctx-metric-value{font-size:11px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
    .ctx-metric-value-col{display:flex;flex-direction:column;gap:3px;min-width:0}
    .ctx-metric-side{font-size:9.5px;color:var(--ag-text-muted);white-space:nowrap;padding-top:2px}
    .ctx-metric-pre-restart{font-size:10px;color:var(--ag-text-muted);opacity:0.78}
    .ctx-metric-pre-restart[hidden],.ctx-metric-service-limit[hidden],.ctx-card-hints[hidden],.ctx-reset-notice[hidden]{display:none!important}
    .ctx-metric-service-limit{font-size:10.5px;color:#f59e0b;font-weight:500}
    .ctx-speed-effort-lines{display:flex;flex-direction:column;gap:2px;font-size:10.5px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .ctx-inline-link-btn{background:none;border:0;padding:0;color:var(--ag-link,#38bdf8);font-size:10.5px;font-weight:500;cursor:pointer;text-align:left;align-self:flex-start}
    .ctx-inline-link-btn:hover{text-decoration:underline}
    .ctx-card-hints{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--ag-border-subtle);padding-top:6px;font-size:10.5px;color:var(--ag-text-secondary);line-height:1.4}
    .ctx-card-hint-item{padding:4px 7px;background:var(--ag-bg-subcard);border-radius:4px;border-left:2px solid var(--ag-ring-warn,#f59e0b)}

    /* 设置操作区 */
    .ctx-adjust-box{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}
    .ctx-small-label{font-size:10.5px;color:var(--ag-text-muted)}
    .ctx-model-select{background:var(--ag-bg-card);color:var(--ag-text-primary);border:1px solid var(--ag-border-subcard);border-radius:4px;padding:3px 6px;font-size:10.5px;width:100%;outline:none}
    .ctx-preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .ctx-preset-btn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:6px 8px;cursor:pointer;transition:all .15s ease;color:var(--ag-text-primary)}
    .ctx-preset-btn:hover:not(:disabled){background:var(--ag-bg-card-hover);border-color:var(--ag-text-muted)}
    .ctx-preset-btn.active{border-color:#2563eb;background:rgba(37,99,235,0.14);box-shadow:inset 0 0 0 1px rgba(37,99,235,0.35)}
    .ctx-preset-btn:disabled,.ctx-preset-btn.is-disabled{opacity:0.48;cursor:not-allowed;border-style:dashed}
    .ctx-preset-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-preset-sub{font-size:9.5px;color:var(--ag-text-secondary);line-height:1.25}
    .ctx-cap-ref-card{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:6px;margin-top:2px}
    .ctx-cap-ref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 10px}
    .ctx-cap-item{display:flex;flex-direction:column;gap:1px;min-width:0}
    .ctx-cap-item-wide{grid-column:1 / -1;border-top:1px dashed var(--ag-border-subtle);padding-top:4px;margin-top:1px}
    .ctx-cap-lbl{font-size:9.5px;color:var(--ag-text-muted);font-weight:500}
    .ctx-cap-val{font-size:11px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .ctx-cap-sub{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-cap-verify-strip{display:flex;flex-wrap:wrap;gap:6px 12px;border-top:1px dashed var(--ag-border-subtle);padding-top:5px;font-size:10px;color:var(--ag-text-secondary)}
    .ctx-cap-v-cell{display:inline-flex;align-items:center;gap:4px;min-width:0}
    .ctx-cap-v-cell em{font-style:normal;color:var(--ag-text-muted)}
    .ctx-cap-v-cell strong{font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums}
    .ctx-unified-proj{display:flex;flex-direction:column;gap:3px;border-top:1px dashed var(--ag-border-subtle);padding-top:5px;font-size:10px}
    .ctx-unified-proj-title{font-weight:600;color:var(--ag-text-primary);margin-bottom:1px}
    .ctx-unified-proj-row{display:flex;justify-content:space-between;gap:8px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .ctx-unified-proj-row.is-clamped strong{color:#f59e0b}
    .ctx-custom-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:1px}
    .ctx-custom-input-wrap{display:flex;align-items:center;flex:1;background:var(--ag-bg-input);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:0 8px}
    .ctx-custom-input-wrap:focus-within{border-color:#2563eb}
    .ctx-custom-input{flex:1;min-width:0;background:transparent;border:none;color:var(--ag-text-primary);font-size:11px;padding:5px 0;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .ctx-input-unit{font-size:10px;color:var(--ag-text-muted);margin-left:4px}
    .ctx-validation-msg{font-size:10px;color:var(--ag-text-secondary);line-height:1.35}
    .ctx-validation-msg.is-error{color:#ef4444;font-weight:500}
    .ctx-validation-msg.is-warn{color:#eab308}
    .ctx-pref-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px}
    .ctx-text-action-btn{background:none;border:0;color:var(--ag-text-muted);font-size:11px;padding:4px 6px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
    .ctx-text-action-btn:hover{color:var(--ag-text-primary)}
    .ctx-reset-notice{font-size:10.5px;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.24);border-radius:5px;padding:5px 8px;line-height:1.4}
    .ctx-plain-help{font-size:10px;color:var(--ag-text-muted);line-height:1.45;border-top:1px dashed var(--ag-border-subtle);padding-top:6px}
    .ctx-detail-ol{padding-left:16px}

    /* 速度对比分页与 SVG 图表 */
    .ctx-speed-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .ctx-segmented{display:inline-flex;align-items:center;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:2px;gap:2px}
    .ctx-seg-btn{border:0;background:transparent;color:var(--ag-text-muted);font-size:10.5px;font-weight:500;padding:3px 7px;border-radius:4px;cursor:pointer;white-space:nowrap}
    .ctx-seg-btn:hover{color:var(--ag-text-primary)}
    .ctx-seg-btn.active{background:var(--ag-unified-bg);color:var(--ag-text-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,0.2)}
    .ctx-chart-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:9px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}
    .ctx-chart-header{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
    .ctx-chart-title{font-size:11.5px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-speed-dropdown{min-width:170px;max-width:250px;flex:1}
    .ctx-svg-wrap{width:100%;overflow:hidden}
    .ctx-speed-svg{display:block;width:100%;height:auto;font-family:inherit}
    .ctx-chart-tooltip{position:absolute;z-index:30;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);border-radius:6px;padding:5px 8px;box-shadow:var(--ag-pop-shadow);font-size:10px;color:var(--ag-pop-text);line-height:1.4;max-width:220px}
    .ctx-chart-tooltip[hidden]{display:none!important}
    .ctx-chart-note{font-size:10px;color:var(--ag-text-muted);line-height:1.35}
    .ctx-speed-empty{font-size:11px;color:var(--ag-text-muted);text-align:center;padding:18px 8px;background:var(--ag-bg-subcard);border:1px dashed var(--ag-border-subcard);border-radius:6px}
    .ctx-speed-empty[hidden],.ctx-svg-wrap[hidden]{display:none!important}
    .ctx-active-test-note{font-size:10.5px;color:var(--ag-text-muted);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;line-height:1.4}

    /* 设置视图 */
    .ctx-settings-header{display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:4px;border-bottom:1px solid var(--ag-border-subtle)}
    .ctx-back-btn{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-primary);border-radius:5px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer}
    .ctx-back-btn:hover{background:var(--ag-btn-hover)}
    .ctx-settings-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-settings-card{background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:10px 11px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}
    .ctx-settings-card-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-settings-card-title{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-settings-card-desc{font-size:10.5px;color:var(--ag-text-muted);line-height:1.45}
    .ctx-lang-segmented{display:flex;width:100%;box-sizing:border-box}
    .ctx-lang-segmented .ctx-seg-btn{flex:1 1 0;min-width:0;text-align:center;padding:5px 8px;font-size:11px}
    .ctx-client-lang-note{font-size:10.5px;color:var(--ag-text-muted);background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:6px 8px;margin-top:8px;line-height:1.45}
    .ctx-pref-actions{flex-wrap:wrap}
    .ctx-preset-btn{min-width:0}
    .ctx-preset-sub{overflow-wrap:anywhere}
    .ctx-metric-label{flex-shrink:0}
    .ctx-metric-value,.ctx-metric-side{min-width:0;overflow-wrap:anywhere}

    /* 结果框内联重启操作区与增强设置中心 */
    .unlock-result-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}
    .unlock-result-actions[hidden],.ctx-enhance-confirm[hidden],.ctx-preset-preview-box[hidden]{display:none!important}
    .ctx-result-manual-note{font-size:10px;color:var(--ag-text-secondary);line-height:1.4;margin-top:4px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:5px;padding:5px 7px}
    .ctx-selector-hint{font-size:10px;color:var(--ag-text-muted);line-height:1.35;margin-top:4px}

    .ctx-settings-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}

    .ctx-tier-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
    .ctx-tier-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 4px;border-radius:6px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);color:var(--ag-text-secondary);cursor:pointer;text-align:center;min-width:0;transition:all .14s ease}
    .ctx-tier-btn:hover{background:var(--ag-bg-card-hover);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .ctx-tier-btn.active{background:rgba(37,99,235,0.16);border-color:#2563eb;color:var(--ag-text-primary);font-weight:600;box-shadow:inset 0 0 0 1px rgba(37,99,235,0.32)}
    .ctx-tier-num{font-size:11px;font-weight:700;line-height:1.1}
    .ctx-tier-name{font-size:10px;line-height:1.2;overflow-wrap:anywhere}

    .ctx-tier-matrix{background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:4px;font-size:10.5px;line-height:1.4}
    .ctx-tier-matrix-title{font-weight:600;color:var(--ag-text-primary);margin-bottom:1px}
    .ctx-tier-matrix-row{display:grid;grid-template-columns:46px minmax(0,1fr);gap:6px;align-items:start}
    .ctx-tier-matrix-k{font-weight:600;color:var(--ag-text-muted);white-space:nowrap}
    .ctx-tier-matrix-v{color:var(--ag-text-secondary);overflow-wrap:anywhere}
    .ctx-tier-note-warn{font-size:10px;color:var(--ag-text-muted);background:rgba(234,179,8,0.07);border:1px solid rgba(234,179,8,0.22);border-radius:5px;padding:5px 8px;line-height:1.4}

    .ctx-toggle-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:7px 9px;cursor:pointer}
    .ctx-toggle-row-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
    .ctx-toggle-row-title{font-size:11px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-toggle-row-sub{font-size:10px;color:var(--ag-text-muted);line-height:1.35}

    .ctx-preset-checklist{display:flex;flex-direction:column;gap:5px}
    .ctx-preset-check-item{display:flex;align-items:flex-start;gap:7px;background:var(--ag-bg-subcard);border:1px solid var(--ag-border-subcard);border-radius:6px;padding:6px 8px;cursor:pointer;font-size:10.5px;line-height:1.35}
    .ctx-preset-check-item input[type="checkbox"]{margin-top:2px;flex-shrink:0}
    .ctx-preset-check-meta{display:flex;flex-direction:column;gap:1px;min-width:0}
    .ctx-preset-check-meta strong{color:var(--ag-text-primary);font-size:11px}
    .ctx-preset-check-meta span{color:var(--ag-text-muted);font-size:10px}

    .ctx-enhance-confirm{background:rgba(234,179,8,0.09);border:1px solid rgba(234,179,8,0.32);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:6px;font-size:10.5px;line-height:1.4;color:var(--ag-text-primary)}
    .ctx-enhance-confirm-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
    .unlock-btn-danger{background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.35)}
    .unlock-btn-danger:hover:not(:disabled){background:rgba(239,68,68,0.2)}
    :host([data-theme="light"]) .unlock-btn-danger{color:#dc2626}

    @media (max-width:440px){
      .ctx-preset-grid{grid-template-columns:1fr}
      .ctx-tier-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .color-grid{grid-template-columns:1fr}
    }
    @media (prefers-reduced-motion: reduce){
      *,.ag-unit,.ring-fill,.key-bar-fill,.ag-panel,#context-tooltip,#topbar-action-tooltip,.heat-cell,.w-bar-fill{
        transition:none!important;animation:none!important;
      }
    }
    @media(max-width:500px){
      #panel{width:calc(100vw - 24px)}
    }
    @media(max-width:760px){
      #panel-tokens{width:calc(100vw - 24px)}
    }

  </style>

    <!-- 顶部基本单元 1: 上下文小圆环 -->
  <button id="badge" class="ag-unit ag-unit-ring" type="button" aria-label="会话与上下文统计" data-i18n-aria="badge.aria" aria-describedby="context-tooltip" aria-expanded="false">
    <svg id="ring-svg" class="ring-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle id="ring-track" class="ring-track" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1"></circle>
      <circle id="ring-fill" class="ring-fill" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1" stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="3.2 4.97"></circle>
    </svg>
    <span id="badge-pct-val" class="badge-pct-val">--%</span>
    <div id="bar-wrap" class="sr-only" aria-hidden="true"><div id="bar-fill" class="meter-bar-fill"></div></div>
    <span id="amount" class="sr-only" data-i18n="badge.reading">读取中…</span>
    <span id="hover-wrap" class="sr-only"><span id="hover-extra"></span></span>
  </button>

  <!-- 顶部快捷操作: 一键 Compact 与上下文窗口快速调节（仅图标，悬停气泡说明） -->
  <button id="btn-topbar-compact" class="ag-unit ag-unit-quick" type="button" hidden aria-label="Compact 压缩上下文" data-i18n-aria="topbar.quick.compactTitle" aria-describedby="topbar-action-tooltip">
    <svg class="topbar-quick-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 1.75v3.75M5.75 3.75L8 5.75l2.25-2M3 8h10M8 14.25v-3.75M5.75 12.25L8 10.25l2.25 2"></path>
    </svg>
  </button>
  <button id="btn-topbar-window" class="ag-unit ag-unit-quick ag-unit-quick-window" type="button" aria-label="调整上下文窗口上限" data-i18n-aria="twp.aria" aria-describedby="topbar-action-tooltip" aria-expanded="false">
    <svg class="topbar-quick-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="2"></rect>
      <path d="M5.25 8h5.5M9 6.25L10.75 8 9 9.75M7 6.25L5.25 8 7 9.75"></path>
    </svg>
  </button>

  <!-- 顶部基本单元 2: 输出速度 (tok/s) -->
  <button id="badge-speed" class="ag-unit" type="button" aria-label="模型输出速度与耗时统计" data-i18n-aria="badge.speed.aria" aria-expanded="false">
    <span class="speed-icon" aria-hidden="true">⚡</span>
    <span id="speed-amount">-- tok/s</span>
    <span id="speed-hover-extra" class="sr-only"></span>
  </button>

  <!-- 顶部基本单元 2.5: 上下文缓存命中率 (%) -->
  <button id="badge-cache" class="ag-unit" type="button" aria-label="上下文缓存命中率统计" data-i18n-aria="badge.cache.aria" aria-describedby="topbar-action-tooltip" aria-expanded="false" data-cache-state="idle">
    <span class="cache-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="3.75" rx="5.25" ry="2.1"></ellipse><path d="M2.75 3.75v4.1c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1v-4.1"></path><path d="M2.75 7.85v4.1c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1v-4.1"></path></svg></span>
    <span id="cache-amount">--%</span>
  </button>

  <!-- 顶部基本单元 3: 累计 Token 用量（细线统计图标） -->
  <button id="badge-tokens" class="ag-unit" type="button" aria-label="Token 用量一览" data-i18n-aria="badge.tokens.aria" aria-expanded="false">
    <span class="token-fire-dot" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13V9M8 13V4M13 13V7"></path></svg></span>
    <span id="token-amount">--</span>
    <span id="token-hover-extra" class="sr-only"></span>
  </button>

  <!-- 顶部基本单元 4: 窄屏溢出菜单按钮 -->
  <button id="badge-overflow" class="ag-unit" type="button" aria-label="更多统计指标" data-i18n-aria="badge.overflow.aria" aria-expanded="false">
    <svg class="overflow-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25"></circle>
      <circle cx="8" cy="8" r="1.25"></circle>
      <circle cx="12.5" cy="8" r="1.25"></circle>
    </svg>
  </button>

  <!-- 上下文圆环悬停/聚焦信息气泡（参考图三层结构） -->
  <div id="context-tooltip" role="tooltip" data-visible="false" data-placement="bottom">
    <div id="ctx-tip-title" class="ctx-tip-title" data-i18n="tip.title.default">上下文窗口：</div>
    <div id="ctx-tip-pct" class="ctx-tip-pct" data-i18n="tip.pct.notReady">数据尚未就绪</div>
    <div id="ctx-tip-detail" class="ctx-tip-detail" data-i18n="tip.detail.loading">正在读取当前会话上下文用量…</div>
  </div>

  <!-- 顶部快捷操作悬停说明与点击反馈气泡 -->
  <div id="topbar-action-tooltip" role="tooltip" data-visible="false" data-placement="bottom" data-tone="default">
    <div id="topbar-tip-title" class="topbar-tip-title"></div>
    <div id="topbar-tip-desc" class="topbar-tip-desc"></div>
  </div>

  <!-- 顶部上下文窗口快速调节微浮层（方案A做法1） -->
  <div id="topbar-window-popover" class="topbar-window-popover" hidden role="dialog" aria-label="快速调整上下文窗口上限" data-i18n-aria="twp.aria">
    <div class="twp-header">
      <span id="twp-scope-label" class="twp-scope-label">—</span>
      <button id="btn-twp-toggle-scope" class="twp-scope-toggle-btn" type="button"></button>
    </div>
    <div id="twp-preset-grid" class="twp-preset-grid" role="group" aria-label="上下文长度预设" data-i18n-aria="models.preset.aria">
      <button type="button" class="twp-preset-btn" data-qctx-mode="fixed" data-qctx-limit="512000">512K</button>
      <button type="button" class="twp-preset-btn" data-qctx-mode="fixed" data-qctx-limit="1000000">1M</button>
      <button type="button" class="twp-preset-btn" data-qctx-mode="dynamic" data-qctx-limit="" data-i18n="twp.preset.dynamic">动态</button>
    </div>
    <div id="twp-status-note" class="twp-status-note" hidden></div>
    <button id="btn-twp-open-models" class="twp-more-btn" type="button" data-i18n="twp.moreModels">⚙️ 自定义数值 / 管理全部模型 ›</button>
  </div>

  <!-- 窄屏溢出菜单 -->
  <div id="overflow-menu" hidden aria-label="更多统计快捷菜单" data-i18n-aria="overflow.aria">
    <button id="overflow-speed-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span>⚡</span><span data-i18n="overflow.speed">输出速度</span></span>
      <span id="overflow-speed-val" class="overflow-item-val">-- tok/s</span>
    </button>
    <button id="overflow-cache-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span class="cache-icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="3.75" rx="5.25" ry="2.1"></ellipse><path d="M2.75 3.75v4.1c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1v-4.1"></path><path d="M2.75 7.85v4.1c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1v-4.1"></path></svg></span><span data-i18n="overflow.cache">缓存命中率</span></span>
      <span id="overflow-cache-val" class="overflow-item-val">--%</span>
    </button>
    <button id="overflow-tokens-btn" class="overflow-item" type="button">
      <span class="overflow-item-label"><span class="token-fire-dot"></span><span data-i18n="overflow.tokens">Token 用量一览</span></span>
      <span id="overflow-tokens-val" class="overflow-item-val">--</span>
    </button>
  </div>

  <!-- 弹出式面板 1: 会话上下文与速度监控 (#panel, 450px) -->
  <section id="panel" class="ag-panel" hidden aria-label="会话与上下文详情" data-i18n-aria="panel.ctx.aria">
    <div class="panel-header-bar">
      <div class="panel-title">
        <span class="panel-title-text" style="font-size:13px;font-weight:600;color:var(--ag-text-primary)" data-i18n="panel.ctx.title">💬 当前会话上下文</span>
        <span id="v">v0.8.3</span>
      </div>
      <div class="panel-header-actions ctx-header-actions">
        <!-- 插件面板三语言快速切换分段按钮 -->
        <div id="panel-lang-top-segmented" class="ctx-segmented ctx-lang-top-segmented" role="group" aria-label="插件面板语言" data-i18n-aria="settings.panelLang.aria">
          <button id="btn-top-lang-zh-CN" class="ctx-seg-btn active" type="button" data-panel-lang="zh-CN" title="简体中文" aria-label="简体中文">简</button>
          <button id="btn-top-lang-zh-TW" class="ctx-seg-btn" type="button" data-panel-lang="zh-TW" title="繁體中文" aria-label="繁體中文">繁</button>
          <button id="btn-top-lang-en" class="ctx-seg-btn" type="button" data-panel-lang="en" title="English" aria-label="English">EN</button>
        </div>
        <button id="btn-github-repo-ctx" class="panel-icon-btn" type="button" aria-label="打开 GitHub 仓库" data-i18n-aria="header.github.aria" title="打开 GitHub 仓库" data-i18n-title="header.github.aria">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
        </button>
        <button id="btn-panel-palette" class="panel-icon-btn" type="button" aria-label="外观与调色设置" data-i18n-aria="header.palette.aria" title="外观与调色设置" data-i18n-title="header.palette.aria">🎨</button>
        <button id="theme-toggle" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" data-i18n-aria="header.theme.aria" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）" data-i18n-title="header.theme.title">🌓</button>
        <button id="close" class="panel-icon-btn" type="button" aria-label="收起详情" data-i18n-aria="header.close.aria">×</button>
      </div>
    </div>

    <div id="version-sync-banner" class="version-sync-banner" hidden role="status">
      <div class="version-sync-banner-text" id="version-sync-text"></div>
    </div>

    <div id="view-context">
      <!-- 顶部 4 分页标签栏 -->
      <div id="ctx-tabs-bar" class="ctx-tabs-bar" role="tablist" aria-label="上下文面板分页" data-i18n-aria="tabs.aria">
        <button id="tab-ctx-session" class="ctx-tab-btn active" type="button" role="tab" aria-selected="true" data-ctx-tab="session" data-i18n="tab.session">当前会话</button>
        <button id="tab-ctx-models" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="models" data-i18n="tab.models">模型设置</button>
        <button id="tab-ctx-speed" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="speed" data-i18n="tab.speed">速度对比</button>
        <button id="tab-ctx-settings" class="ctx-tab-btn" type="button" role="tab" aria-selected="false" data-ctx-tab="settings" data-i18n="tab.settings">配置</button>
      </div>

      <!-- 分页 1: 当前会话 -->
      <div id="pane-ctx-session" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-session">
        <!-- 卡片 1: 核心用量速览 -->
        <div id="key-summary">
          <div class="key-header"><span class="key-title" data-i18n="session.keySummary.title">⭐ 核心用量速览</span><span id="key-badge" class="key-pill pill-muted" data-i18n="session.badge.reading">读取中</span></div>
          <div class="key-bar-track"><div id="key-bar-fill" class="key-bar-fill"></div></div>
          <div class="key-stats"><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.used">当前已用</div><div id="key-used" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.limit">预算上限</div><div id="key-limit" class="key-stat-val">—</div></div><div class="key-stat"><div class="key-stat-label" data-i18n="session.stat.remaining">剩余可用</div><div id="key-remaining" class="key-stat-val">—</div></div></div>
          <div id="key-takeaway" class="key-takeaway" data-i18n="session.keyTakeaway.loading">正在计算核心指标…</div>
        </div>

        <!-- 卡片 2: 输出速度与延迟速览 -->
        <div id="speed-summary" style="background:var(--ag-bg-card);border:1px solid var(--ag-border-card);border-radius:8px;padding:11px 12px;margin:8px 0 10px;">
          <div class="key-header">
            <span class="key-title" style="color:var(--ag-custom-speed,var(--ag-text-primary));" data-i18n="session.speedSummary.title">⚡ 最新生成速度与耗时</span>
            <span id="speed-badge" class="key-pill pill-muted" data-i18n="session.speed.pending">待生成</span>
          </div>
          <div class="key-stats" style="grid-template-columns:repeat(4,1fr);">
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.rate">输出速度</div>
              <div id="speed-val" class="key-stat-val" style="color:var(--ag-custom-speed,var(--ag-text-primary));">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.duration">生成耗时</div>
              <div id="speed-duration" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.ttft">首字延迟</div>
              <div id="speed-ttft" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.speed.tokens">本次输出</div>
              <div id="speed-tokens" class="key-stat-val">—</div>
            </div>
          </div>
          <div id="speed-takeaway" class="key-takeaway" data-i18n="session.speed.wait">等待首次模型输出产生速度统计…</div>
        </div>

        <!-- 卡片 2.5: 上下文缓存命中率速览 -->
        <div id="cache-summary" class="cache-summary-card">
          <div class="key-header">
            <span class="key-title cache-summary-title" data-i18n="session.cacheSummary.title">♻️ 上下文缓存命中</span>
            <span id="cache-badge" class="key-pill pill-muted" data-i18n="session.cache.pending">待统计</span>
          </div>
          <div class="key-stats" style="grid-template-columns:repeat(4,1fr);">
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.cache.rate">本轮命中率</div>
              <div id="cache-val" class="key-stat-val cache-stat-primary">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.cache.read">缓存复用</div>
              <div id="cache-read" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.cache.fresh">未缓存新增</div>
              <div id="cache-fresh" class="key-stat-val">—</div>
            </div>
            <div class="key-stat">
              <div class="key-stat-label" data-i18n="session.cache.sessionRate">会话命中率</div>
              <div id="cache-session-rate" class="key-stat-val">—</div>
            </div>
          </div>
          <div id="cache-takeaway" class="key-takeaway" data-i18n="session.cache.wait">等待请求返回输入与缓存复用统计…</div>
        </div>

        <!-- 紧凑上下文设置入口卡片（支持直接点选常用档位） -->
        <div id="ctx-compact-card" class="ctx-compact-card">
          <div class="ctx-compact-top">
            <div class="ctx-compact-info">
              <div class="ctx-compact-title-row">
                <span id="ctx-compact-scope-title" class="ctx-compact-title" data-i18n="session.compact.title">上下文设置</span>
                <span id="ctx-compact-saved" class="key-pill pill-muted">—</span>
              </div>
              <div class="ctx-compact-meta">
                <span><span data-i18n="session.compact.clientLabel">客户端当前使用：</span><strong id="ctx-compact-client">状态读取中…</strong></span>
              </div>
            </div>
            <button id="btn-goto-model-settings" class="ctx-compact-link-btn" type="button" data-i18n="session.compact.gotoModels">管理全部模型 ›</button>
          </div>
          <div id="session-ctx-preset-bar" class="twp-preset-grid session-ctx-preset-bar" role="group" aria-label="上下文长度预设" data-i18n-aria="models.preset.aria">
            <button type="button" class="twp-preset-btn" data-qctx-mode="fixed" data-qctx-limit="512000">512K</button>
            <button type="button" class="twp-preset-btn" data-qctx-mode="fixed" data-qctx-limit="1000000">1M</button>
            <button type="button" class="twp-preset-btn" data-qctx-mode="dynamic" data-qctx-limit="" data-i18n="twp.preset.dynamic">动态</button>
          </div>
          <div id="ctx-compact-feedback" class="twp-status-note" hidden></div>
        </div>

        <!-- 底层技术参数与附件审计 -->
        <div class="tech-drawer">
          <button id="btn-toggle-details" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left">
              <span data-i18n="session.techDrawer.title">📋 底层技术参数与附件审计</span>
            </span>
            <span id="drawer-arrow" class="drawer-arrow" data-i18n="session.techDrawer.expand">▼ 点击展开明细</span>
          </button>
          <div id="drawer-body" class="drawer-body" style="display:none;">
            <p id="status" data-i18n="session.tech.checking">正在核对请求和附件…</p><p id="model"></p>
            <h4 data-i18n="session.tech.latestReq">最近一次模型请求</h4>
            <dl><dt data-i18n="session.tech.reqStatus">请求状态</dt><dd id="request-status">—</dd><dt data-i18n="session.tech.actual">模型返回输入＋输出</dt><dd id="actual">—</dd><dt data-i18n="session.tech.cacheDetail">本轮输入构成（缓存／新增）</dt><dd id="cache-tech-detail">—</dd><dt data-i18n="session.tech.estimate">客户端估算（可能漏附件）</dt><dd id="estimate">—</dd><dt data-i18n="session.tech.budget">客户端预算字段</dt><dd id="budget">—</dd><dt data-i18n="session.tech.serviceLimit">该次报错的服务端限制</dt><dd id="service-limit">—</dd><dt data-i18n="session.tech.percent">相对客户端预算</dt><dd id="percent">—</dd></dl>
            <h4 data-i18n="session.tech.sessionHeading">整个会话累计内容 · 本地估算</h4>
            <dl><dt data-i18n="session.tech.sessionTotal">可读取文本 token 估算</dt><dd id="session-total" data-i18n="session.tech.scanning">扫描中…</dd><dt data-i18n="session.tech.characters">实际读取文字字符数</dt><dd id="characters">—</dd><dt data-i18n="session.tech.user">用户消息</dt><dd id="user">—</dd><dt data-i18n="session.tech.assistant">模型回复</dt><dd id="assistant">—</dd><dt data-i18n="session.tech.thinking">可见思考内容</dt><dd id="thinking">—</dd><dt data-i18n="session.tech.tools">工具调用与工具输出</dt><dd id="tools">—</dd><dt data-i18n="session.tech.summaries">历史压缩摘要</dt><dd id="summaries">—</dd><dt data-i18n="session.tech.system">当前系统提示与工具定义</dt><dd id="system">—</dd><dt data-i18n="session.tech.attachments">上传／输出附件文本</dt><dd id="attachment-total">—</dd><dt data-i18n="session.tech.steps">历史步骤完整性</dt><dd id="steps">—</dd></dl>
            <p id="coverage"></p><h4 data-i18n="session.tech.filesHeading">附件逐项检查</h4><div id="files"></div><button id="refresh" type="button" data-i18n="session.tech.rescan">重新扫描整段会话与附件</button>
            <p id="note" data-i18n-html="session.tech.note">会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。</p>
            <p id="updated"></p>
          </div>
        </div>
      </div>

      <!-- 分页 2: 模型设置 -->
      <div id="pane-ctx-models" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-models" hidden>
        <!-- 1. 客户端状态条（全局一条） -->
        <div id="ctx-client-status-bar" class="ctx-status-bar">
          <div class="ctx-status-bar-main">
            <div class="ctx-status-left">
              <span id="ctx-client-status-text" class="ctx-client-status-text" data-i18n="status.client.reading">客户端当前使用：状态读取中…</span>
              <span id="unlock-badge" class="key-pill pill-muted" data-i18n="status.badge.reading">状态读取中…</span>
            </div>
            <div class="ctx-status-actions">
              <button id="btn-restart-host" class="unlock-btn unlock-btn-primary ctx-restart-btn" type="button" hidden data-i18n="models.restartBtn">重启客户端使设置生效</button>
            </div>
          </div>
          <div id="ctx-restart-mismatch-note" class="ctx-status-subnote" hidden></div>
          <div id="ctx-manual-restart-note" class="ctx-manual-restart-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。</div>
          <div id="ctx-restart-confirm" class="ctx-restart-confirm" hidden>
            <div class="ctx-restart-confirm-text" data-i18n="models.restartConfirm.text">重启会中断正在运行的任务。请先保存未保存的内容。</div>
            <div class="ctx-restart-confirm-actions">
              <button id="btn-restart-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
              <button id="btn-restart-confirm-go" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartConfirm.go">重启</button>
            </div>
          </div>
          <div id="ctx-restart-feedback" class="ctx-restart-feedback" hidden></div>
        </div>

        <!-- 2. 模式选择器（统一设置 vs 按模型分别设置） -->
        <div class="ctx-scope-selector-wrap" id="ctx-scope-selector-wrap">
          <div class="ctx-scope-mode-toggle" role="radiogroup" aria-label="上下文设置模式" data-i18n-aria="models.mode.aria">
            <button type="button" class="ctx-mode-tab-btn is-active" id="btn-ctx-mode-unified" data-mode="unified" role="radio" aria-checked="true">
              <span class="ctx-mode-tab-title" data-i18n="models.mode.unifiedTitle">所有模型统一设置</span>
              <span class="ctx-mode-tab-desc" data-i18n="models.mode.unifiedDesc">设置一次，所有模型使用相同的上下文长度。</span>
            </button>
            <button type="button" class="ctx-mode-tab-btn" id="btn-ctx-mode-per-model" data-mode="per_model" role="radio" aria-checked="false">
              <span class="ctx-mode-tab-title" data-i18n="models.mode.perModelTitle">按模型分别设置</span>
              <span class="ctx-mode-tab-desc" data-i18n="models.mode.perModelDesc">每个模型分别保存，使用哪个模型，就采用它的上下文长度。</span>
            </button>
          </div>
        </div>

        <!-- 3. 模型查看与切换条（仅在分别设置模式下呈现） -->
        <div class="ctx-models-toolbar" id="ctx-models-toolbar" hidden>
          <div class="ctx-header-model-ctrl">
            <span id="ctx-model-selector-role" class="ctx-selector-role-lbl" data-i18n="panel.ctx.viewModel">查看模型</span>
            <select id="ctx-model-select" class="ctx-model-select" aria-label="查看模型" data-i18n-aria="panel.ctx.viewModel" style="display:none"></select>
            <div id="ctx-model-dropdown-wrap" class="ag-dropdown-wrapper ctx-header-dropdown">
              <div id="ctx-model-dropdown-trigger" class="ag-dropdown-trigger ctx-compact-trigger" tabindex="0" title="按厂商查看不同模型的上下文设置" data-i18n-title="panel.ctx.viewModelTitle">
                <span id="ctx-model-dropdown-label" class="ag-dropdown-label" data-i18n="panel.ctx.loadingModels">正在读取模型…</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="ctx-model-dropdown-menu" class="ag-dropdown-menu ctx-model-dropdown-menu"></div>
            </div>
            <button id="btn-ctx-back-current" class="ctx-mini-link-btn" type="button" hidden title="回到当前会话正在使用的模型" data-i18n="panel.ctx.backCurrent" data-i18n-title="panel.ctx.backCurrentTitle">回到当前模型</button>
          </div>
          <div class="ctx-selector-hint" data-i18n="panel.ctx.viewModelHint">仅查看模型配置与实测数据；切换聊天模型请在输入框右侧选择。</div>
        </div>

        <!-- 4. 模型列表（按厂商分组，仅在分别设置模式下呈现） -->
        <div id="ctx-model-list" class="ctx-model-list" aria-label="按厂商分组的模型产品列表" data-i18n-aria="models.list.aria" hidden></div>

        <!-- 5. 核心操作区（前置到首屏，点选预设即时生效） -->
        <div class="ctx-adjust-box" id="ctx-adjust-box">
          <div class="ctx-preset-grid" id="ctx-preset-grid" role="group" aria-label="上下文长度预设" data-i18n-aria="models.preset.aria">
            <button type="button" class="ctx-preset-btn" data-ctx-mode="fixed" data-ctx-limit="512000">
              <span class="ctx-preset-title">512,000 (512K)</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.p512Sub">标准预设 · 512,000 tokens</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="fixed" data-ctx-limit="1000000">
              <span class="ctx-preset-title">1,000,000 (1M)</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.p1mSub">1M 满血窗口 · 自动预留输出</span>
            </button>
            <button type="button" class="ctx-preset-btn" data-ctx-mode="dynamic" data-ctx-limit="">
              <span class="ctx-preset-title" data-i18n="models.preset.dynamic">动态跟随</span>
              <span class="ctx-preset-sub" data-i18n="models.preset.dynamicSub">不固定数值，按底座动态计算</span>
            </button>
          </div>

          <div class="ctx-custom-row">
            <label for="ctx-custom-limit-input" class="ctx-small-label" data-i18n="models.custom.label">自定义长度</label>
            <div class="ctx-custom-input-wrap">
              <input id="ctx-custom-limit-input" class="ctx-custom-input" type="text" inputmode="numeric" placeholder="输入整数，例如 300000" data-i18n-placeholder="models.custom.placeholder" autocomplete="off">
              <span class="ctx-input-unit">tokens</span>
            </div>
          </div>
          <div id="ctx-limit-validation" class="ctx-validation-msg" data-i18n="models.validation.defaultRange">可设置范围：16,384 – 2,097,152 tokens。</div>

          <div class="ctx-pref-actions">
            <button id="btn-save-model-ctx" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.save">保存自定义</button>
            <button id="btn-apply-unlock" class="unlock-btn unlock-btn-primary" type="button" hidden data-i18n="models.btn.saveApply">保存并应用</button>
            <button id="btn-reset-model-ctx" class="ctx-text-action-btn" type="button" data-i18n="models.btn.reset">恢复默认</button>
          </div>

          <div id="ctx-reset-notice" class="ctx-reset-notice" hidden></div>

          <div class="ctx-plain-help">
            <div data-i18n="models.help.line1">点击预设即时生效；自定义整数请填写后点「保存自定义」（底座在动态跟随解锁后逐模型生效）。</div>
            <div data-i18n="models.help.line2">各模型根据保存的设置独立生效，多会话与模型切换互不干扰。</div>
          </div>

          <div id="unlock-result-box" class="unlock-result-box" style="display:none;">
            <div id="unlock-result-text" class="unlock-result-text"></div>
            <div id="unlock-result-actions" class="unlock-result-actions" hidden>
              <button id="btn-unlock-result-restart" class="unlock-btn unlock-btn-primary" type="button" hidden data-i18n="models.restartBtn">重启客户端使设置生效</button>
              <button id="btn-unlock-result-retry" class="unlock-btn unlock-btn-secondary" type="button" hidden data-i18n="models.btn.retryApply">重新检测并应用</button>
            </div>
            <div id="unlock-result-manual" class="ctx-result-manual-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。</div>
          </div>
        </div>

        <!-- 6. 选中模型摘要卡片（详细信息与能力参考默认折叠） -->
        <div id="ctx-model-card" class="ctx-detail-card">
          <div id="ctx-conflict-banner" class="ctx-conflict-banner" hidden>
            <div class="ctx-conflict-title" data-i18n="models.conflict.title">这个模型的不同档位保存过不同长度，请选一个统一值。</div>
            <div id="ctx-conflict-rows" class="ctx-conflict-rows"></div>
          </div>

          <div class="ctx-card-top">
            <div class="ctx-card-vendor-row">
              <span id="ctx-card-vendor-dot" class="ag-vendor-dot"></span>
              <span id="ctx-card-vendor-name" class="ctx-card-vendor-name">—</span>
            </div>
            <div id="ctx-card-product-name" class="ctx-card-product-name" data-i18n="models.card.waiting">等待读取模型…</div>
            <div class="ctx-card-efforts-row">
              <span id="ctx-card-efforts-list" class="ctx-card-efforts-list" data-i18n="models.card.effortsEmpty">可用档位：—</span>
              <span id="ctx-card-session-effort" class="ctx-card-session-effort" hidden>当前会话：—</span>
            </div>
          </div>

          <!-- 主界面极简核心展示区：当前模式、当前模型、当前使用长度 -->
          <div class="ctx-summary-highlight-grid" id="ctx-summary-highlight-grid">
            <div class="ctx-summary-item">
              <span class="ctx-summary-label" data-i18n="models.summary.mode">当前模式</span>
              <span class="ctx-summary-value" id="ctx-summary-mode" data-i18n="models.mode.unifiedTitle">所有模型统一设置</span>
            </div>
            <div class="ctx-summary-item">
              <span class="ctx-summary-label" data-i18n="models.summary.model">当前模型</span>
              <span class="ctx-summary-value" id="ctx-summary-model">—</span>
            </div>
            <div class="ctx-summary-item ctx-summary-item-length">
              <span class="ctx-summary-label" data-i18n="models.summary.length">目标设置与状态</span>
              <div class="ctx-summary-length-row">
                <span class="ctx-summary-value ctx-length-val" id="ctx-summary-length" data-i18n="models.summary.modelDefault">使用模型默认值</span>
                <span class="key-pill pill-muted" id="ctx-summary-status-pill" hidden>待重启生效</span>
              </div>
            </div>
          </div>

          <!-- 折叠抽屉：详细信息（模型能力参考、配置来源、请求参数、底座状态、实测预算） -->
          <div class="ctx-card-details-drawer">
            <button id="btn-toggle-card-details" class="drawer-trigger ctx-card-drawer-trigger" aria-expanded="false" type="button">
              <span class="drawer-trigger-left" data-i18n="models.card.detailsToggle">详细信息（能力参考、请求参数与预算验证）</span>
              <span id="ctx-card-drawer-arrow" class="drawer-arrow" data-i18n="session.techDrawer.expand">▼ 点击展开明细</span>
            </button>
            <div id="ctx-card-drawer-body" class="drawer-body ctx-card-drawer-body" style="display:none;">
              <!-- 模型能力与当前生效参考 -->
              <div class="ctx-cap-ref-card" id="ctx-capability-ref">
                <div class="ctx-cap-ref-grid">
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.window">模型总窗口</span>
                    <span class="ctx-cap-val" id="ctx-cap-window">—</span>
                  </div>
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.output">最大输出</span>
                    <span class="ctx-cap-val" id="ctx-cap-output">—</span>
                  </div>
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.modelMax">模型理论输入上限</span>
                    <span class="ctx-cap-val" id="ctx-cap-model-max">—</span>
                  </div>
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.clientPolicy">当前客户端限制</span>
                    <span class="ctx-cap-val" id="ctx-cap-client-policy">—</span>
                  </div>
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.defaultCap">当前策略默认预算</span>
                    <span class="ctx-cap-val" id="ctx-cap-default">—</span>
                  </div>
                  <div class="ctx-cap-item">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.range">当前可采纳输入范围</span>
                    <span class="ctx-cap-val" id="ctx-cap-range">16,384 – 2,097,152</span>
                  </div>
                  <div class="ctx-cap-item ctx-cap-item-wide">
                    <span class="ctx-cap-lbl" data-i18n="models.cap.formulaLbl">来源与计算说明</span>
                    <span class="ctx-cap-sub" id="ctx-cap-formula">等待读取模型元数据…</span>
                  </div>
                </div>
                <div class="ctx-cap-verify-strip" id="ctx-cap-verify-strip">
                  <span class="ctx-cap-v-cell"><em data-i18n="models.cap.saved">已保存</em> <strong id="ctx-ref-saved">—</strong></span>
                  <span class="ctx-cap-v-cell"><em data-i18n="models.cap.sent">最近请求携带</em> <strong id="ctx-ref-sent">尚无本次验证</strong></span>
                  <span class="ctx-cap-v-cell"><em data-i18n="models.cap.adopted">后端实际采用</em> <strong id="ctx-ref-adopted">尚无本次验证</strong></span>
                </div>
                <div class="ctx-unified-proj" id="ctx-unified-projection" hidden></div>
              </div>

              <div class="ctx-card-metrics">
                <div class="ctx-metric-row ctx-metric-saved">
                  <span class="ctx-metric-label" data-i18n="models.card.saved">已保存</span>
                  <span class="ctx-metric-value" id="ctx-card-saved" data-i18n="status.savedDefault">未单独设置（使用默认）</span>
                  <span class="ctx-metric-side" data-i18n="models.card.savedSide">为这个模型记下的长度</span>
                </div>
                <div class="ctx-metric-row ctx-metric-request">
                  <span class="ctx-metric-label" data-i18n="models.card.request">请求携带</span>
                  <span class="ctx-metric-value" id="ctx-card-request">默认透传</span>
                  <span class="ctx-metric-side" data-i18n="models.card.requestSide">本次请求发送给底座的参数</span>
                </div>
                <div class="ctx-metric-row ctx-metric-client">
                  <span class="ctx-metric-label" data-i18n="models.card.client">底座状态</span>
                  <span class="ctx-metric-value">
                    <span id="ctx-card-client" data-i18n="status.badge.reading">状态读取中…</span>
                    <span id="ctx-card-client-tag" class="key-pill pill-muted" data-i18n="status.badge.reading">状态读取中…</span>
                  </span>
                  <span class="ctx-metric-side" data-i18n="models.card.clientSide">底座运行模式</span>
                </div>
                <div class="ctx-metric-row ctx-metric-observed">
                  <span class="ctx-metric-label" data-i18n="models.card.observedBudget">实测预算</span>
                  <div class="ctx-metric-value-col">
                    <span class="ctx-metric-value" id="ctx-card-observed-budget" data-i18n="models.card.observedBudgetNone">尚未观测</span>
                    <span class="ctx-metric-pre-restart" id="ctx-card-pre-restart-budget" hidden></span>
                    <span class="ctx-metric-service-limit" id="ctx-card-service-limit" hidden></span>
                  </div>
                  <span class="ctx-metric-side" data-i18n="models.card.observedBudgetSide">对话中实际分配</span>
                </div>
                <div class="ctx-metric-row ctx-metric-convo">
                  <span class="ctx-metric-label" data-i18n="models.card.convoIdTitle">对应会话</span>
                  <span class="ctx-metric-value" id="ctx-card-convo">—</span>
                  <span class="ctx-metric-side">发生调用的会话标识</span>
                </div>
                <div class="ctx-metric-row ctx-metric-diagnosis">
                  <span class="ctx-metric-label" data-i18n="models.card.diagnosisTitle">生效诊断</span>
                  <span class="ctx-metric-value" id="ctx-card-diagnosis">—</span>
                  <span class="ctx-metric-side">目标值与观测值比对结果</span>
                </div>
                <div class="ctx-metric-row ctx-metric-observed">
                  <span class="ctx-metric-label" data-i18n="models.card.observedSpeed">实测速度</span>
                  <div class="ctx-metric-value-col">
                    <div id="ctx-card-observed-speed" class="ctx-speed-effort-lines" data-i18n="models.card.observedSpeedNone">暂无实测数据</div>
                    <button id="btn-card-goto-speed" class="ctx-inline-link-btn" type="button" data-i18n="models.card.gotoSpeed">查看速度对比 ›</button>
                  </div>
                </div>
                <div class="ctx-metric-row ctx-metric-client" id="ctx-card-tier-caps-row" hidden>
                  <span class="ctx-metric-label" data-i18n="models.card.tierCaps">档位能力</span>
                  <div class="ctx-metric-value-col">
                    <div id="ctx-card-tier-caps" class="ctx-speed-effort-lines">—</div>
                  </div>
                </div>
              </div>
              <div id="ctx-card-hints" class="ctx-card-hints" hidden></div>
            </div>
          </div>
        </div>

        <!-- 5. 唯一保留的折叠区：详细说明 -->
        <div class="tech-drawer" id="context-unlock-drawer">
          <button id="btn-toggle-unlock-details" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left">
              <span data-i18n="models.details.title">详细说明</span>
            </span>
            <span id="unlock-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expand">▼ 展开</span>
          </button>
          <div id="unlock-drawer-body" class="drawer-body" style="display:none;">
            <div class="unlock-panel-content">
              <div class="unlock-notice">
                <ol class="unlock-notice-list ctx-detail-ol">
                  <li data-i18n-html="models.details.li1"><strong>底座解锁与按模型请求注入的分工</strong>：客户端语言服务原版会对默认与回落预算实施 256,000 tokens 钳位（256K 限制点），并允许远程实验覆写。底座解锁用于一次性开启「动态跟随（Dynamic）」默认策略并屏蔽远程实验覆写；每次发送消息时，插件再按当次请求实际选中的模型在请求参数 <code>checkpointConfig.maxTokenLimit</code> 中写入你设定的预算。若设定超过 256,000 tokens，仍需底座处于「动态跟随」已解锁状态。</li>
                  <li data-i18n-html="models.details.li2"><strong>多项安全检查点说明</strong>：客户端包含默认/钳位双检查点、远程实验覆写拦截点以及上下文窗口序列上限检查点；本插件只依赖本地偏好配合每次请求参数写入实现按模型隔离，不会在切换模型时反复改写宿主程序文件。</li>
                  <li data-i18n-html="models.details.li3"><strong>恢复客户端默认 vs 按模型最大可用</strong>：「恢复客户端默认」仅清除请求级覆盖参数，把决定权交回当前语言服务的全局策略（若已开启「动态跟随」则走模型动态默认，无法逐模型单切回原版 256K 钳位）；「按模型最大可用」则按 IDE 元数据公式 <code>maxTokens - maxOutputTokens</code> 计算并显式发送该整数上限。</li>
                  <li data-i18n-html="models.details.li4"><strong>几个数字的区别</strong>：
                    <div>模型总窗口 / 最大输出：来自 IDE 模型目录与步骤元数据，不代表实际已分配配额。</div>
                    <div>已保存：你为当前模型或统一模式保存的目标值。</div>
                    <div>最近请求携带 / 后端实际采用：按当前会话与模型轮次严格隔离对照，尚无对应发送时显示「尚无本次验证」。</div>
                    <div>服务端报错上限：仅当请求被服务端拒绝且报错给出明确数字时出现。</div>
                  </li>
                  <li data-i18n-html="models.details.li5"><strong>工程范围与预设说明</strong>：256,000 / 512,000 / 1,000,000 属于插件预设；合法自定义工程范围为 16,384 – 2,097,152 任意整数 tokens，真实超长请求能否被服务端接受取决于各模型自身配额与风控策略。</li>
                </ol>
              </div>

              <div class="unlock-actions-row">
                <button id="btn-restore-unlock" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.restoreOriginal">客户端恢复原始设置</button>
                <button id="btn-refresh-unlock" class="unlock-btn unlock-btn-secondary" type="button" title="重新检测状态" data-i18n="models.btn.refreshStatus" data-i18n-title="models.btn.refreshStatus">刷新状态</button>
              </div>

              <div id="unlock-status-desc" class="unlock-desc" style="margin-top:8px;" data-i18n="models.status.detecting">正在检测当前 Antigravity 状态…</div>
              <dl class="unlock-meta-dl">
                <dt data-i18n="models.meta.mode">当前配置 / 实测</dt><dd id="unlock-meta-mode">—</dd>
                <dt data-i18n="models.meta.target">目标进程</dt><dd id="unlock-meta-target">—</dd>
                <dt data-i18n="models.meta.arch">系统架构</dt><dd id="unlock-meta-arch">—</dd>
                <dt data-i18n="models.meta.backup">原版备份状态</dt><dd id="unlock-meta-backup">—</dd>
              </dl>

              <div class="unlock-credit-bar">
                <div class="unlock-credit-left">
                  <span class="unlock-credit-lbl" data-i18n="models.credit.source">方案来源：</span>
                  <a id="link-unlock-author" href="https://linux.do/t/topic/3117832" target="_blank" rel="noopener noreferrer" class="unlock-author-link" role="link" tabindex="0" title="点击在系统默认浏览器中打开原作者帖子" data-i18n="models.credit.author">原作者帖子 (Linux.do @23375) ↗</a>
                  <button id="btn-copy-unlock-link" class="unlock-copy-link-btn" type="button" title="复制原作者帖子链接" data-i18n="models.credit.copy">📋 复制链接</button>
                </div>
                <span class="unlock-adapter-note" data-i18n="models.credit.adapter">本项目负责 Node.js 适配与集成</span>
              </div>
              <div id="unlock-link-toast" class="unlock-link-toast" style="display:none;" role="status"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 分页 3: 速度对比 -->
      <div id="pane-ctx-speed" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-speed" hidden>
        <div class="ctx-speed-toolbar">
          <div class="ctx-segmented" role="group" aria-label="时间范围" data-i18n-aria="speed.range.aria">
            <button id="speed-range-7d" class="ctx-seg-btn active" type="button" data-speed-range="7" data-i18n="speed.range.7d">近 7 天</button>
            <button id="speed-range-30d" class="ctx-seg-btn" type="button" data-speed-range="30" data-i18n="speed.range.30d">近 30 天</button>
            <button id="speed-range-all" class="ctx-seg-btn" type="button" data-speed-range="all" data-i18n="speed.range.all">全部</button>
          </div>
          <div id="speed-origin-filter-wrap" class="ctx-segmented" role="group" aria-label="样本来源" data-i18n-aria="speed.origin.aria">
            <button id="speed-origin-all" class="ctx-seg-btn active" type="button" data-speed-origin="all" data-i18n="speed.origin.all">全部来源</button>
            <button id="speed-origin-chat" class="ctx-seg-btn" type="button" data-speed-origin="chat" data-i18n="speed.origin.chat">日常对话</button>
          </div>
        </div>

        <!-- 柱状图卡片 -->
        <div class="ctx-chart-card">
          <div class="ctx-chart-header">
            <span id="speed-bar-title" class="ctx-chart-title" data-i18n="speed.barTitle.tps">输出速度对比</span>
            <div class="ctx-segmented" role="group" aria-label="对比指标" data-i18n-aria="speed.metric.aria">
              <button id="speed-metric-tps" class="ctx-seg-btn active" type="button" data-speed-metric="tps" data-i18n="speed.metric.tps">输出速度</button>
              <button id="speed-metric-ttft" class="ctx-seg-btn" type="button" data-speed-metric="ttft" data-i18n="speed.metric.ttft">首字延迟</button>
              <button id="speed-metric-duration" class="ctx-seg-btn" type="button" data-speed-metric="duration" data-i18n="speed.metric.duration">总耗时</button>
            </div>
          </div>
          <div id="speed-bar-empty" class="ctx-speed-empty" hidden data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
          <div id="speed-bar-chart-wrap" class="ctx-svg-wrap" style="position:relative;">
            <svg id="speed-bar-svg" class="ctx-speed-svg" role="img" aria-label="各模型与档位速度对比柱状图" data-i18n-aria="speed.barSvg.aria"></svg>
            <div id="speed-bar-tooltip" class="ctx-chart-tooltip" hidden></div>
          </div>
          <div id="speed-bar-note" class="ctx-chart-note" data-i18n="speed.barNote">以各模型与档位的中位数统计；不足 3 条标注“样本少”。总耗时受输出长度影响，条件相近时才可比较。</div>
        </div>

        <!-- 单模型折线图卡片 -->
        <div class="ctx-chart-card">
          <div class="ctx-chart-header ctx-line-header">
            <span class="ctx-chart-title" data-i18n="speed.lineTitle">单模型速度趋势</span>
            <div id="speed-model-dropdown-wrap" class="ag-dropdown-wrapper ctx-speed-dropdown">
              <div id="speed-model-dropdown-trigger" class="ag-dropdown-trigger ctx-compact-trigger" tabindex="0" title="选择一个模型与档位查看速度变化" data-i18n-title="speed.linePickTitle">
                <span id="speed-model-dropdown-label" class="ag-dropdown-label" data-i18n="speed.lineNoModel">暂无模型记录</span>
                <div class="ag-dropdown-arrow">
                  <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                </div>
              </div>
              <div id="speed-model-dropdown-menu" class="ag-dropdown-menu"></div>
            </div>
          </div>
          <div id="speed-line-empty" class="ctx-speed-empty" data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
          <div id="speed-line-chart-wrap" class="ctx-svg-wrap" style="position:relative;" hidden>
            <svg id="speed-line-svg" class="ctx-speed-svg" role="img" aria-label="所选模型与档位历史输出速度折线图" data-i18n-aria="speed.lineSvg.aria"></svg>
            <div id="speed-line-tooltip" class="ctx-chart-tooltip" hidden></div>
          </div>
        </div>

        <div id="speed-active-test-note" class="ctx-active-test-note" data-i18n="speed.activeTestNote">主动测试：未接通。目前没有可靠的指定模型调用入口，暂时只能使用日常对话的实测记录。</div>
      </div>

      <!-- 设置与系统配置 (第四分页: 配置 / setting) -->
      <div id="pane-ctx-settings" class="ctx-tab-pane" role="tabpanel" aria-labelledby="tab-ctx-settings" hidden>
        <!-- 1. 一键推荐配置与总览（默认不自动应用，需用户预览勾选并确认） -->
        <div class="ctx-settings-card" id="enhance-preset-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="enhance.preset.title">✨ 一键推荐配置（按需勾选预览）</div>
            <span id="enhance-global-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <div class="ctx-settings-card-desc" data-i18n="enhance.preset.desc">下方列出推荐增强组合；可按需勾选并预览确认，地区免切锁补丁始终保留不受恢复影响。</div>
          <div class="ctx-preset-checklist">
            <label class="ctx-preset-check-item">
              <input id="chk-rec-lang" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemLang">客户端简体中文界面（哈基米）</strong>
                <span data-i18n="enhance.preset.itemLangSub">仅改变桌面端壳层中文，不影响你选择的插件面板语言。</span>
              </div>
            </label>
            <label class="ctx-preset-check-item">
              <input id="chk-rec-ctx" type="checkbox" checked>
              <div class="ctx-preset-check-meta">
                <strong data-i18n="enhance.preset.itemCtx">上下文模式：跟随模型</strong>
                <span data-i18n="enhance.preset.itemCtxSub">按模型各自支持的最大长度运行，不硬锁固定 983,040 或 512,000。</span>
              </div>
            </label>
          </div>
          <div class="ctx-settings-card-actions">
            <button id="btn-enhance-preset-apply" class="unlock-btn unlock-btn-primary" type="button" data-i18n="enhance.preset.applyBtn">应用所选推荐配置</button>
            <button id="btn-enhance-restore-all" class="unlock-btn unlock-btn-danger" type="button" data-i18n="enhance.restoreAll.btn">恢复功能默认</button>
          </div>
          <div id="enhance-preset-confirm" class="ctx-enhance-confirm" hidden>
            <div id="enhance-preset-confirm-text"></div>
            <div class="ctx-enhance-confirm-actions">
              <button id="btn-enhance-confirm-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
              <button id="btn-enhance-confirm-go" class="unlock-btn unlock-btn-primary" type="button" data-i18n="enhance.confirm.go">确认应用</button>
            </div>
          </div>
          <div id="enhance-global-result" class="unlock-result-box" style="display:none;">
            <div id="enhance-global-result-text" class="unlock-result-text"></div>
            <div id="enhance-global-result-actions" class="unlock-result-actions" hidden>
              <button id="btn-enhance-restart-ls" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="enhance.btn.restartLs">重启语言服务</button>
              <button id="btn-enhance-restart-host" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartBtn">重启客户端使设置生效</button>
            </div>
            <div id="enhance-global-manual-note" class="ctx-result-manual-note" hidden data-i18n="models.manualRestart">请手动重启：关闭所有 哈基米 窗口（Cmd+Q 完全退出），再重新打开 哈基米.app。</div>
          </div>
        </div>

        <!-- 2. 客户端界面语言与品牌标题 (哈基米) -->
        <div class="ctx-settings-card" id="client-brand-lang-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="settings.clientLang.title">🖥️ 客户端界面语言与品牌（哈基米）</div>
            <span id="chinese-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <div id="chinese-status-desc" class="ctx-settings-card-desc" data-i18n="settings.clientLang.detecting">正在检测桌面端汉化运行状态…</div>
          <div class="ctx-segmented ctx-lang-segmented" id="client-lang-segmented" role="group" aria-label="客户端界面语言" data-i18n-aria="settings.clientLang.aria">
            <button id="btn-client-lang-zh-CN" class="ctx-seg-btn" type="button" data-client-lang="zh-CN">简体中文</button>
            <button id="btn-client-lang-en" class="ctx-seg-btn" type="button" data-client-lang="en">English</button>
          </div>
          <div class="ctx-small-label" style="margin-top:8px" data-i18n="enhance.brand.label">左上角品牌文字显示（仅作用于左上角品牌位，不影响 Logo、菜单或代码）：</div>
          <div class="ctx-segmented ctx-lang-segmented" id="brand-title-segmented" role="group" aria-label="品牌名称选项" data-i18n-aria="enhance.brand.aria">
            <button id="btn-brand-hakimi" class="ctx-seg-btn active" type="button" data-brand-title="hakimi" data-i18n="enhance.brand.hakimi">哈基米</button>
            <button id="btn-brand-translated" class="ctx-seg-btn" type="button" data-brand-title="translated" data-i18n="enhance.brand.translated">反重力</button>
            <button id="btn-brand-hidden" class="ctx-seg-btn" type="button" data-brand-title="hidden" data-i18n="enhance.brand.hidden">隐藏品牌字样</button>
            <button id="btn-brand-english" class="ctx-seg-btn" type="button" data-brand-title="english" data-i18n="enhance.brand.english">Antigravity (英文原样)</button>
          </div>
          <div id="brand-apply-feedback" class="ctx-brand-feedback" style="display:none;"></div>
          <div id="client-lang-license-note" class="ctx-client-lang-note" data-i18n="settings.clientLang.licenseNote">说明：此设置控制桌面端壳层，与顶部插件面板语言相互独立。切换客户端语言或品牌标题在保存后需重启客户端完全生效。</div>
          <div class="ctx-settings-card-actions">
            <button id="btn-toggle-chinese-module" class="unlock-btn unlock-btn-primary" type="button" data-i18n="settings.clientLang.toggle">切换汉化状态</button>
            <button id="btn-apply-brand-title" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="enhance.brand.applyBtn">保存品牌选择并应用</button>
          </div>
        </div>

        <!-- 3. agy CLI 上下文联动解锁 -->
        <div class="ctx-settings-card" id="cli-unlock-card">
          <div class="ctx-settings-card-hdr">
            <div class="ctx-settings-card-title" data-i18n="settings.cliUnlock.title">⌨️ agy CLI 上下文联动解锁</div>
            <span id="cli-unlock-badge" class="key-pill pill-muted" data-i18n="settings.common.reading">读取中…</span>
          </div>
          <div id="cli-unlock-desc" class="ctx-settings-card-desc" data-i18n="settings.cliUnlock.desc">检测本机 agy 命令行二进制，解除 /model 上下文选择器机型白名单并修复 AGY_CLI_AUTO_COMPACT_OVERRIDE 环境变量读取，同时同步上下文窗口配置。</div>
          <div id="cli-unlock-meta" class="ctx-client-lang-note">—</div>
          <div class="ctx-settings-card-actions">
            <button id="btn-cli-unlock-apply" class="unlock-btn unlock-btn-primary" type="button" data-i18n="settings.cliUnlock.applyBtn">一键修补并同步 agy CLI</button>
            <button id="btn-cli-unlock-refresh" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.btn.refreshStatus">刷新状态</button>
          </div>
          <div id="cli-unlock-result" class="unlock-result-box" style="display:none;">
            <div id="cli-unlock-result-text" class="unlock-result-text"></div>
          </div>
        </div>

        <!-- 保留：兼容隐藏旧中文折叠触发节点 -->
        <div id="chinese-i18n-drawer" hidden>
          <button id="btn-toggle-chinese" type="button" hidden></button>
          <div id="chinese-drawer-body" style="display:none;"><span id="chinese-drawer-arrow"></span></div>
        </div>

        <!-- 6. 面板背景与指标颜色自定义 -->
        <div class="tech-drawer">
          <button id="btn-toggle-colors" class="drawer-trigger" aria-expanded="false" type="button">
            <span class="drawer-trigger-left"><span data-i18n="settings.colors.title">🎨 指标与背景颜色自定义（默认跟随主题）</span></span>
            <span id="color-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expandSettings">▼ 展开设置</span>
          </button>
          <div id="color-drawer-body" class="drawer-body" style="display:none;">
            <div class="color-grid">
              <div class="color-item" style="grid-column:1 / -1">
                <span class="color-item-lbl" data-i18n="settings.colors.panelBg">面板与菜单统一背景色（0级跟随 / 自定义）</span>
                <div class="color-item-ctrls">
                  <input id="color-panelBg" class="color-picker" type="color" value="#181818" data-i18n-aria="settings.colors.panelBg" aria-label="面板背景色" />
                  <button id="swatch-panelBg" class="color-swatch-btn" type="button" data-color-slot="panelBg" data-color-label="面板与菜单背景色" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-panelBg" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.ringUsed">圆环已用部分</span>
                <div class="color-item-ctrls">
                  <input id="color-ringUsed" class="color-picker" type="color" value="#e6e6eb" data-i18n-aria="settings.colors.ringUsed" aria-label="上下文圆环已用部分颜色" />
                  <button id="swatch-ringUsed" class="color-swatch-btn" type="button" data-color-slot="ringUsed" data-color-label="圆环已用部分" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-ringUsed" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.ringTrack">圆环轨道</span>
                <div class="color-item-ctrls">
                  <input id="color-ringTrack" class="color-picker" type="color" value="#52525b" data-i18n-aria="settings.colors.ringTrack" aria-label="圆环轨道颜色" />
                  <button id="swatch-ringTrack" class="color-swatch-btn" type="button" data-color-slot="ringTrack" data-color-label="圆环轨道" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-ringTrack" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.contextText">上下文用量文字</span>
                <div class="color-item-ctrls">
                  <input id="color-contextText" class="color-picker" type="color" value="#ececef" data-i18n-aria="settings.colors.contextText" aria-label="上下文用量文字颜色" />
                  <button id="swatch-contextText" class="color-swatch-btn" type="button" data-color-slot="contextText" data-color-label="上下文用量文字" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-contextText" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.speedText">输出速度</span>
                <div class="color-item-ctrls">
                  <input id="color-speedText" class="color-picker" type="color" value="#38bdf8" data-i18n-aria="settings.colors.speedText" aria-label="输出速度颜色" />
                  <button id="swatch-speedText" class="color-swatch-btn" type="button" data-color-slot="speedText" data-color-label="输出速度" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-speedText" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.cacheText">缓存命中率</span>
                <div class="color-item-ctrls">
                  <input id="color-cacheText" class="color-picker" type="color" value="#34d399" data-i18n-aria="settings.colors.cacheText" aria-label="缓存命中率颜色" />
                  <button id="swatch-cacheText" class="color-swatch-btn" type="button" data-color-slot="cacheText" data-color-label="缓存命中率" data-i18n-color-label="settings.colors.cacheText" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-cacheText" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.tokenTotal">累计 token 用量</span>
                <div class="color-item-ctrls">
                  <input id="color-tokenTotal" class="color-picker" type="color" value="#c084fc" data-i18n-aria="settings.colors.tokenTotal" aria-label="累计 token 用量颜色" />
                  <button id="swatch-tokenTotal" class="color-swatch-btn" type="button" data-color-slot="tokenTotal" data-color-label="累计 token 用量" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-tokenTotal" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
              <div class="color-item">
                <span class="color-item-lbl" data-i18n="settings.colors.tokenAccent">其他 token 指标</span>
                <div class="color-item-ctrls">
                  <input id="color-tokenAccent" class="color-picker" type="color" value="#a78bfa" data-i18n-aria="settings.colors.tokenAccent" aria-label="其他 token 指标颜色" />
                  <button id="swatch-tokenAccent" class="color-swatch-btn" type="button" data-color-slot="tokenAccent" data-color-label="其他 token 指标" data-i18n-title="colors.swatchTitle" title="点击打开颜色选取器"></button>
                  <button id="reset-tokenAccent" class="color-reset-btn" type="button" data-mode="auto" data-i18n="colors.followTheme">跟随主题</button>
                </div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:7px">
              <span style="font-size:10.5px;color:var(--ag-text-muted)" data-i18n="settings.colors.note">注：高占用与超限告警色独立保留，不被常态颜色覆盖。</span>
              <button id="reset-all-colors" class="color-reset-btn" type="button" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全局统一居中重启确认模态弹窗（立即可见，支持顶部、底部与配置区所有重启入口） -->
    <div id="global-restart-modal" class="ag-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="modal-restart-title">
      <div class="ag-modal-card">
        <div id="modal-restart-title" class="ag-modal-title" data-i18n="models.restartConfirm.title">重启 Antigravity 客户端</div>
        <div id="modal-restart-text" class="ag-modal-body" data-i18n="models.restartConfirm.text">重启会中断正在运行的任务。请先保存未保存的内容。</div>
        <div id="modal-restart-feedback" class="ag-modal-feedback" hidden></div>
        <div class="ag-modal-actions">
          <button id="btn-modal-restart-cancel" class="unlock-btn unlock-btn-secondary" type="button" data-i18n="models.restartConfirm.cancel">取消</button>
          <button id="btn-modal-restart-confirm" class="unlock-btn unlock-btn-primary" type="button" data-i18n="models.restartConfirm.go">确认重启</button>
        </div>
      </div>
    </div>
  </section>

  <!-- 弹出式面板 2: Token 用量一览 (#panel-tokens, 730px) -->
  <section id="panel-tokens" class="ag-panel" hidden aria-label="Token 用量一览" data-i18n-aria="badge.tokens.aria">
    <div class="panel-header-bar">
      <div class="panel-title panel-title-tokens">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))"><path d="M3 13V9M8 13V4M13 13V7"></path></svg>
        <span id="panel-tokens-title" style="font-size:13px;font-weight:600;color:var(--ag-custom-token-accent,var(--ag-token-accent-default))" data-i18n="tokens.title">本机已记录用量</span>
      </div>
      <div class="panel-header-actions">
        <button id="btn-github-repo" class="panel-icon-btn" type="button" aria-label="打开 GitHub 仓库" data-i18n-aria="header.github.aria" title="打开 GitHub 仓库" data-i18n-title="header.github.aria">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
        </button>
        <button id="btn-panel-tokens-palette" class="panel-icon-btn" type="button" aria-label="外观与调色设置" data-i18n-aria="header.palette.aria" title="外观与调色设置" data-i18n-title="header.palette.aria">🎨</button>
        <button id="theme-toggle-tokens" class="panel-icon-btn" type="button" aria-label="切换浅色/深色主题" data-i18n-aria="header.theme.aria" title="当前：跟随IDE（点击切换：浅色 / 深色 / 自动）" data-i18n-title="header.theme.title">🌓</button>
        <button id="close-tokens" class="panel-icon-btn" type="button" aria-label="收起详情" data-i18n-aria="header.close.aria">×</button>
      </div>
    </div>

    <div id="view-tokens">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        <div class="source-switch-bar">
          <span style="font-size:10.5px;color:var(--ag-text-muted);padding:0 4px" data-i18n="tokens.sourceLabel">来源:</span>
          <button id="src-tab-all" class="switch-pill-btn active" type="button" data-i18n="tokens.src.all">全部</button>
          <button id="src-tab-desktop" class="switch-pill-btn" type="button" data-i18n="tokens.src.desktop">桌面端</button>
          <button id="src-tab-cli" class="switch-pill-btn" type="button" data-i18n="tokens.src.cli">CLI</button>
        </div>
      </div>

      <!-- 账号套餐状态摘要行 -->
      <div id="plan-summary-bar" class="plan-summary-bar">
        <div class="plan-summary-badge" style="display:flex;align-items:center;gap:6px;flex:1;overflow:hidden">
          <span>💎</span>
          <span id="plan-summary-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Pro · ...</span>
        </div>
        <button id="btn-plan-detail-toggle" class="switch-pill-btn" type="button" style="padding:2px 6px;flex-shrink:0" data-i18n="plan.detail.toggleOpen">详情 ▼</button>
      </div>

      <!-- 套餐详情卡片（仅显示套餐与额度池状态，不含货币费率） -->
      <div id="plan-detail-card" class="plan-detail-card collapsible-pane" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--ag-border-subcard)">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11.5px;font-weight:600;color:var(--ag-text-primary)" data-i18n="plan.detail.title">💎 AI 订阅与额度详情</span>
          </div>
          <button id="btn-plan-detail-collapse-top" class="switch-pill-btn" type="button" style="padding:2px 8px;font-size:10.5px" data-i18n="plan.detail.toggleClose">详情收回 ▲</button>
        </div>
        <dl class="plan-detail-dl">
          <dt data-i18n="plan.dt.plan">当前套餐：</dt>
          <dd id="p-det-name" style="font-weight:600">Google AI Pro</dd>
          <dt data-i18n="plan.dt.account">当前账号：</dt>
          <dd id="p-det-account">—</dd>
          <dt data-i18n="plan.dt.promptCredits">Prompt 额度池：</dt>
          <dd id="p-det-prompt-credits"><span id="p-det-credits">—</span></dd>
          <dt data-i18n="plan.dt.flowCredits">Flow 额度池：</dt>
          <dd id="p-det-flow-credits">—</dd>
          <dt data-i18n="plan.dt.updated">状态更新时间：</dt>
          <dd id="p-det-time" style="font-size:11px;color:var(--ag-text-muted)">—</dd>
        </dl>

        <div style="display:flex;justify-content:flex-start;align-items:center;margin-top:8px;padding-top:6px;border-top:1px dashed var(--ag-border-subcard)">
          <button id="btn-plan-detail-collapse" class="switch-pill-btn" type="button" style="padding:3px 10px;font-size:11px" data-i18n="plan.detail.toggleClose">详情收回 ▲</button>
        </div>
      </div>

      <!-- 专属 Token 统计页（卡片统计、热力图与调色抽屉） -->
      <div id="tokens-main-view">
        <div class="token-stat-cards" id="token-stat-cards">
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.total">累计处理 Token</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Total</span></div>
            <div style="font-size:9.5px;color:var(--ag-text-muted);margin:-2px 0 4px" data-i18n="tokens.card.includeCache">含缓存读取</div>
            <div class="t-card-val" id="t-total-val">--</div>
            <div class="t-card-sub" id="t-total-sub" data-i18n="common.loading">读取中...</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.today">今日使用</span><span style="color:var(--ag-custom-token-accent,#0284c7)">Today</span></div>
            <div class="t-card-val" id="t-today-val">--</div>
            <div class="t-card-sub" id="t-today-sub" data-i18n="common.loading">读取中...</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.month">本月使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Month</span></div>
            <div class="t-card-val" id="t-month-val">--</div>
            <div class="t-card-sub" id="t-month-sub" data-i18n="common.loading">读取中...</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.year">年度使用</span><span style="color:var(--ag-custom-token-accent,var(--ag-token-accent-default))">Year</span></div>
            <div class="t-card-val" id="t-year-val">--</div>
            <div class="t-card-sub" id="t-year-sub" data-i18n="common.loading">读取中...</div>
          </div>
        </div>

      <div class="heatmap-section">
        <div class="heat-header">
          <div class="heat-header-left">
            <div class="heat-title" data-i18n="tokens.heat.title">Token 活动</div>
            <span id="first-use-badge" class="first-use-badge" data-i18n="tokens.heat.firstUsePlaceholder">首次使用：--</span>
            <div class="heat-win-nav">
              <button id="h-page-prev" class="heat-nav-btn" type="button" title="查看更早的 12 个月窗口" data-i18n-title="tokens.heat.prevTitle" disabled>‹</button>
              <span id="h-win-range">--</span>
              <button id="h-page-next" class="heat-nav-btn" type="button" title="查看更新的 12 个月窗口" data-i18n-title="tokens.heat.nextTitle" disabled>›</button>
            </div>
          </div>
          <div class="heat-tabs" id="heat-tabs-bar" role="tablist" aria-label="热力图统计周期" data-i18n-aria="tokens.heat.tabsAria">
            <div class="heat-tab-thumb" id="heat-tab-thumb" aria-hidden="true"></div>
            <button class="heat-tab-btn active" id="h-tab-daily" role="tab" aria-selected="true" type="button" tabindex="0" data-i18n="tokens.heat.daily">每天</button>
            <button class="heat-tab-btn" id="h-tab-weekly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.weekly">每周</button>
            <button class="heat-tab-btn" id="h-tab-monthly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.monthly">每月</button>
            <button class="heat-tab-btn" id="h-tab-yearly" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.yearly">今年</button>
            <button class="heat-tab-btn" id="h-tab-cum" role="tab" aria-selected="false" type="button" tabindex="-1" data-i18n="tokens.heat.cum">累计总量</button>
          </div>
        </div>
        <div class="heat-scroll-box" id="h-scroll-box">
          <div id="h-daily-box">
            <div class="heat-grid-cols" id="h-grid-cols"></div>
            <div class="heat-months" id="h-months"></div>
          </div>
          <div id="h-weekly-box" style="display:none"></div>
          <div id="h-monthly-box" style="display:none"></div>
          <div id="h-yearly-box" style="display:none"></div>
          <div id="h-cum-box" style="display:none">
            <canvas id="h-cum-canvas"></canvas>
          </div>
        </div>
        <div id="h-summary-bar" class="heat-summary-bar">
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumTokens">区间合计:</span>
            <span id="h-sum-tokens" class="heat-sum-val">-- Tokens</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumDailyAvg">折合每天:</span>
            <span id="h-sum-daily-avg" class="heat-sum-val">0 Tokens</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumActiveAvg">活跃日均:</span>
            <span id="h-sum-active-avg" class="heat-sum-val" data-i18n="tokens.heat.activeAvgPlaceholder">0 Tokens (0天)</span>
          </div>
          <div class="heat-sum-item">
            <span class="heat-sum-label" data-i18n="tokens.heat.sumCacheRate">缓存命中:</span>
            <span id="h-sum-cache-rate" class="heat-sum-val">--%</span>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11px;color:var(--ag-text-muted);flex-wrap:wrap;gap:6px">
          <span data-i18n="tokens.heat.tip">点击或悬浮格子查看当日详细 Token 构成</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div id="heat-legend-scale" style="display:flex;align-items:center;gap:4px;cursor:pointer" title="点击任一色块单独修改该档位颜色，或点击文字展开设置" data-i18n-title="tokens.heat.legendTitle">
              <span data-i18n="tokens.heat.less">少</span>
              <button id="heat-leg-0" class="heat-leg-swatch" type="button" data-color-slot="heatLvl0" data-color-label="色阶第 1 档（少/无用量）" title="第 1 档（少/无用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl0Title"></button>
              <button id="heat-leg-1" class="heat-leg-swatch" type="button" data-color-slot="heatLvl1" data-color-label="色阶第 2 档（低用量）" title="第 2 档（低用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl1Title"></button>
              <button id="heat-leg-2" class="heat-leg-swatch" type="button" data-color-slot="heatLvl2" data-color-label="色阶第 3 档（中等用量）" title="第 3 档（中等用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl2Title"></button>
              <button id="heat-leg-3" class="heat-leg-swatch" type="button" data-color-slot="heatLvl3" data-color-label="色阶第 4 档（高用量）" title="第 4 档（高用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl3Title"></button>
              <button id="heat-leg-4" class="heat-leg-swatch" type="button" data-color-slot="heatLvl4" data-color-label="色阶第 5 档（多/峰值用量）" title="第 5 档（多/峰值用量）：点击单独修改此格颜色" data-i18n-title="colors.lvl4Title"></button>
              <span data-i18n="tokens.heat.more">多</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 二级交互折叠区（就近放置于面板 A 内部）：面板背景色 + 热力图 5 档色阶预设、5 档逐格独立自定义与两端插值自定义 -->
      <div class="tech-drawer" style="margin-top:2px">
        <button id="btn-toggle-token-colors" class="drawer-trigger" aria-expanded="false" type="button">
          <span class="drawer-trigger-left"><span data-i18n="tokens.colors.title">🎨 热力图色阶与面板外观自定义（默认跟随主题）</span></span>
          <span id="token-color-drawer-arrow" class="drawer-arrow" data-i18n="drawer.expandSettings">▼ 展开设置</span>
        </button>
        <div id="token-color-drawer-body" class="drawer-body" style="display:none;">
          <div class="heat-preset-bar">
            <span style="font-size:11px;color:var(--ag-text-secondary);font-weight:500" data-i18n="tokens.heat.presetLabel">5 档色阶预设：</span>
            <div class="heat-preset-group" id="heat-preset-group">
              <button class="heat-preset-btn" type="button" data-heat-preset="purple" data-active="true">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#3f1e6b"></i><i style="background:#652ab7"></i><i style="background:#9053f8"></i><i style="background:#c084fc"></i></span>
                <span data-i18n="tokens.heat.presetPurple">紫色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="yellow" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#713f12"></i><i style="background:#a16207"></i><i style="background:#eab308"></i><i style="background:#fde047"></i></span>
                <span data-i18n="tokens.heat.presetYellow">黄色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="green" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#14532d"></i><i style="background:#15803d"></i><i style="background:#22c55e"></i><i style="background:#86efac"></i></span>
                <span data-i18n="tokens.heat.presetGreen">绿色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="blue" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#1e3a8a"></i><i style="background:#1d4ed8"></i><i style="background:#3b82f6"></i><i style="background:#93c5fd"></i></span>
                <span data-i18n="tokens.heat.presetBlue">蓝色系</span>
              </button>
              <button class="heat-preset-btn" type="button" data-heat-preset="red" data-active="false">
                <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#7f1d1d"></i><i style="background:#b91c1c"></i><i style="background:#ef4444"></i><i style="background:#fca5a5"></i></span>
                <span data-i18n="tokens.heat.presetRed">红色系</span>
              </button>
            </div>
          </div>

          <div class="heat-lvl-custom-bar">
            <div class="heat-lvl-custom-hdr">
              <span style="font-size:11px;color:var(--ag-text-secondary);font-weight:500" data-i18n="tokens.heat.customTitle">5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：</span>
              <button id="reset-heat-lvls" class="color-reset-btn" type="button" data-i18n="tokens.heat.resetLvls">恢复 5 档预设</button>
            </div>
            <div class="heat-lvl-grid" id="heat-lvl-grid">
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl0">1档 · 少/无</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl0" class="color-picker" type="color" value="#27272a" aria-label="热力图第1档颜色" data-i18n-aria-label="tokens.heat.lvl0Aria" />
                  <button id="swatch-heatLvl0" class="color-swatch-btn" type="button" data-color-slot="heatLvl0" data-color-label="色阶第 1 档（少/无用量）" data-i18n-color-label="tokens.heat.lvl0Swatch"></button>
                  <button id="reset-heatLvl0" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl1">2档 · 低</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl1" class="color-picker" type="color" value="#3f1e6b" aria-label="热力图第2档颜色" data-i18n-aria-label="tokens.heat.lvl1Aria" />
                  <button id="swatch-heatLvl1" class="color-swatch-btn" type="button" data-color-slot="heatLvl1" data-color-label="色阶第 2 档（低用量）" data-i18n-color-label="tokens.heat.lvl1Swatch"></button>
                  <button id="reset-heatLvl1" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl2">3档 · 中</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl2" class="color-picker" type="color" value="#652ab7" aria-label="热力图第3档颜色" data-i18n-aria-label="tokens.heat.lvl2Aria" />
                  <button id="swatch-heatLvl2" class="color-swatch-btn" type="button" data-color-slot="heatLvl2" data-color-label="色阶第 3 档（中等用量）" data-i18n-color-label="tokens.heat.lvl2Swatch"></button>
                  <button id="reset-heatLvl2" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl3">4档 · 高</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl3" class="color-picker" type="color" value="#9053f8" aria-label="热力图第4档颜色" data-i18n-aria-label="tokens.heat.lvl3Aria" />
                  <button id="swatch-heatLvl3" class="color-swatch-btn" type="button" data-color-slot="heatLvl3" data-color-label="色阶第 4 档（高用量）" data-i18n-color-label="tokens.heat.lvl3Swatch"></button>
                  <button id="reset-heatLvl3" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
              <div class="heat-lvl-item">
                <span class="heat-lvl-lbl" data-i18n="tokens.heat.lvl4">5档 · 多/峰</span>
                <div class="color-item-ctrls">
                  <input id="color-heatLvl4" class="color-picker" type="color" value="#c084fc" aria-label="热力图第5档颜色" data-i18n-aria-label="tokens.heat.lvl4Aria" />
                  <button id="swatch-heatLvl4" class="color-swatch-btn" type="button" data-color-slot="heatLvl4" data-color-label="色阶第 5 档（多/峰值用量）" data-i18n-color-label="tokens.heat.lvl4Swatch"></button>
                  <button id="reset-heatLvl4" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
                </div>
              </div>
            </div>
          </div>

          <div class="color-grid">
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.lowEnd">色阶「少」端颜色（自动插值）</span>
              <div class="color-item-ctrls">
                <input id="color-heatLow" class="color-picker" type="color" value="#27272a" aria-label="热力图少端颜色" data-i18n-aria-label="tokens.heat.lowEndAria" />
                <button id="swatch-heatLow" class="color-swatch-btn" type="button" data-color-slot="heatLow" data-color-label="热力图「少」端颜色" data-i18n-color-label="tokens.heat.lowEndSwatch"></button>
                <button id="reset-heatLow" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.highEnd">色阶「多」端颜色（自动插值）</span>
              <div class="color-item-ctrls">
                <input id="color-heatHigh" class="color-picker" type="color" value="#c084fc" aria-label="热力图多端颜色" data-i18n-aria-label="tokens.heat.highEndAria" />
                <button id="swatch-heatHigh" class="color-swatch-btn" type="button" data-color-slot="heatHigh" data-color-label="热力图「多」端颜色" data-i18n-color-label="tokens.heat.highEndSwatch"></button>
                <button id="reset-heatHigh" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.heat.btnPreset">预设</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.panelBg">面板与菜单统一背景色</span>
              <div class="color-item-ctrls">
                <button id="swatch-panelBg-tokens" class="color-swatch-btn" type="button" data-color-slot="panelBg" data-color-label="面板与菜单背景色" data-i18n-color-label="colors.panelBgSwatch"></button>
                <button id="reset-panelBg-tokens" class="color-reset-btn" type="button" data-mode="auto" data-i18n="tokens.colors.followTheme">跟随主题</button>
              </div>
            </div>
            <div class="color-item">
              <span class="color-item-lbl" data-i18n="tokens.heat.accentColors">累计与强调指标色</span>
              <div class="color-item-ctrls">
                <button id="swatch-tokenTotal-tokens" class="color-swatch-btn" type="button" data-color-slot="tokenTotal" data-color-label="累计 token 用量" data-i18n-color-label="tokens.heat.totalSwatch"></button>
                <button id="swatch-tokenAccent-tokens" class="color-swatch-btn" type="button" data-color-slot="tokenAccent" data-color-label="Token 强调色" data-i18n-color-label="tokens.heat.accentSwatch"></button>
                <button id="reset-all-colors-tokens" class="color-reset-btn" type="button" data-i18n="settings.colors.resetAll">全部恢复跟随主题</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div><!-- end #tokens-main-view -->
    </div>
  </section>

  <!-- 自定义颜色选取器面板（替换系统原生取色器） -->
  <div id="color-picker-popover" hidden role="dialog" aria-label="颜色选取器" data-i18n-aria="cp.title">
    <div class="cp-header">
      <div class="cp-title">
        <span data-i18n="cp.title">🎨 颜色选取器</span>
        <span id="cp-target-name" class="cp-target-lbl"></span>
      </div>
      <button id="cp-close" class="panel-icon-btn" type="button" aria-label="关闭颜色选取器" data-i18n-aria="cp.closeAria">×</button>
    </div>
    <div class="cp-toolbar">
      <button id="cp-eyedropper" class="cp-eyedropper-btn" type="button" title="从屏幕吸取颜色" data-i18n-title="cp.eyedropperTitle" data-i18n="cp.eyedropper">🖊 取色</button>
      <div class="cp-presets" id="cp-presets">
        <button class="cp-preset-dot" type="button" data-cp-hex="#ef4444" style="background:#ef4444" title="#EF4444"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#f97316" style="background:#f97316" title="#F97316"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#eab308" style="background:#eab308" title="#EAB308"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#22c55e" style="background:#22c55e" title="#22C55E"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#06b6d4" style="background:#06b6d4" title="#06B6D4"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#3b82f6" style="background:#3b82f6" title="#3B82F6"></button>
        <button class="cp-preset-dot" type="button" data-cp-hex="#a855f7" style="background:#a855f7" title="#A855F7"></button>
      </div>
    </div>
    <div class="cp-stage">
      <div id="cp-side-preview" class="cp-side-preview"></div>
      <div id="cp-sv-area" class="cp-sv-area">
        <div id="cp-sv-thumb" class="cp-sv-thumb"></div>
      </div>
    </div>
    <div id="cp-hue-wrap" class="cp-hue-wrap">
      <div id="cp-hue-thumb" class="cp-hue-thumb"></div>
    </div>
    <div class="cp-rows">
      <div class="cp-row">
        <span class="cp-fmt-lbl">HEX</span>
        <input id="cp-input-hex" class="cp-fmt-input" type="text" value="#652ab7" spellcheck="false" aria-label="HEX 色值输入" data-i18n-aria="cp.hexAria" />
        <button id="cp-copy-hex" class="cp-copy-btn" type="button" title="复制 HEX" data-i18n-title="cp.copyHex">📋</button>
      </div>
      <details class="cp-advanced-formats">
        <summary class="cp-fmt-summary" data-i18n="cp.moreFormats">更多格式 (RGB / HSL)</summary>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
          <div class="cp-row">
            <span class="cp-fmt-lbl">RGB</span>
            <input id="cp-input-rgb" class="cp-fmt-input" type="text" value="rgb(101, 42, 183)" spellcheck="false" aria-label="RGB 色值输入" data-i18n-aria="cp.rgbAria" />
            <button id="cp-copy-rgb" class="cp-copy-btn" type="button" title="复制 RGB" data-i18n-title="cp.copyRgb">📋</button>
          </div>
          <div class="cp-row">
            <span class="cp-fmt-lbl">HSL</span>
            <input id="cp-input-hsl" class="cp-fmt-input" type="text" value="hsl(265, 63%, 44%)" spellcheck="false" aria-label="HSL 色值输入" data-i18n-aria="cp.hslAria" />
            <button id="cp-copy-hsl" class="cp-copy-btn" type="button" title="复制 HSL" data-i18n-title="cp.copyHsl">📋</button>
          </div>
        </div>
      </details>
    </div>
    <div class="cp-footer">
      <span id="cp-status-msg" style="font-size:10.5px;color:var(--ag-text-muted)" data-i18n="cp.hint">支持直接输入或粘贴 HEX 色值</span>
      <button id="cp-reset-slot" class="color-reset-btn" type="button" data-i18n="cp.followTheme">跟随主题</button>
    </div>
  </div>

  <!-- 热力图浮动 Tooltip -->
  <div class="heat-popover" id="heat-pop">
    <div class="pop-date" id="heat-pop-date">10月24日</div>
    <div class="pop-val" id="heat-pop-val">2.47亿 个 Token</div>
    <div class="pop-det" id="heat-pop-det"></div>
  </div>
`;

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  // =========================================================================
  // 模块 0: 插件面板三语言国际化 (简体中文 / 繁體中文 / English)
  // =========================================================================
  const VALID_PANEL_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);
  let currentPanelLanguage = 'zh-CN';

  function normalizePanelLanguage(lang) {
    if (typeof lang !== 'string') return 'zh-CN';
    const trimmed = lang.trim();
    if (VALID_PANEL_LANGUAGES.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'tw') return 'zh-TW';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    return 'zh-CN';
  }

  function getPanelLanguage() {
    return currentPanelLanguage;
  }

  const PANEL_I18N = {
    // 顶部入口单元与气泡
    'badge.aria': { 'zh-CN': '会话与上下文统计', 'zh-TW': '工作階段與上下文統計', en: 'Session and context statistics' },
    'badge.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
    'badge.speed.aria': { 'zh-CN': '模型输出速度与耗时统计', 'zh-TW': '模型輸出速度與耗時統計', en: 'Model output speed and latency' },
    'badge.cache.aria': { 'zh-CN': '上下文缓存命中率统计', 'zh-TW': '上下文快取命中率統計', en: 'Context cache hit rate' },
    'badge.tokens.aria': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量一覽', en: 'Token usage overview' },
    'badge.overflow.aria': { 'zh-CN': '更多统计指标', 'zh-TW': '更多統計指標', en: 'More metrics' },
    'tip.title.default': { 'zh-CN': '上下文窗口：', 'zh-TW': '上下文視窗：', en: 'Context window:' },
    'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
    'tip.detail.loading': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前工作階段上下文用量…', en: 'Reading current session context usage…' },
    'overflow.aria': { 'zh-CN': '更多统计快捷菜单', 'zh-TW': '更多統計快捷選單', en: 'More metrics menu' },
    'overflow.speed': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
    'overflow.cache': { 'zh-CN': '缓存命中率', 'zh-TW': '快取命中率', en: 'Cache hit rate' },
    'overflow.tokens': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量一覽', en: 'Token usage' },

    // 上下文面板头部与分页
    'panel.ctx.aria': { 'zh-CN': '会话与上下文详情', 'zh-TW': '工作階段與上下文詳情', en: 'Session & Context Details' },
    'panel.ctx.title': { 'zh-CN': '💬 当前会话上下文', 'zh-TW': '💬 目前工作階段上下文', en: '💬 Current Session Context' },
    'panel.ctx.viewModel': { 'zh-CN': '查看模型', 'zh-TW': '檢視模型', en: 'Model' },
    'panel.ctx.viewModelTitle': { 'zh-CN': '按厂商查看不同模型的上下文设置', 'zh-TW': '依廠商檢視不同模型的上下文設定', en: 'Inspect context settings by vendor and model' },
    'panel.ctx.loadingModels': { 'zh-CN': '正在读取模型…', 'zh-TW': '正在讀取模型…', en: 'Loading models…' },
    'panel.ctx.backCurrent': { 'zh-CN': '回到当前模型', 'zh-TW': '回到目前模型', en: 'Back to current' },
    'panel.ctx.backCurrentTitle': { 'zh-CN': '回到当前会话正在使用的模型', 'zh-TW': '回到目前工作階段正在使用的模型', en: 'Switch back to the active session model' },
    'header.settings.aria': { 'zh-CN': '打开设置', 'zh-TW': '開啟設定', en: 'Open settings' },
    'header.settings.title': { 'zh-CN': '设置（语言、标题与外观）', 'zh-TW': '設定（語言、標題與外觀）', en: 'Settings (Language, Titles & Appearance)' },
    'header.github.aria': { 'zh-CN': '打开 GitHub 仓库', 'zh-TW': '開啟 GitHub 儲存庫', en: 'Open GitHub repository' },
    'header.palette.aria': { 'zh-CN': '外观与调色设置', 'zh-TW': '外觀與調色設定', en: 'Appearance & color settings' },
    'header.close.aria': { 'zh-CN': '收起详情', 'zh-TW': '收起詳情', en: 'Close panel' },
    'tabs.aria': { 'zh-CN': '上下文面板分页', 'zh-TW': '上下文面板分頁', en: 'Context panel tabs' },
    'tab.session': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
    'tab.models': { 'zh-CN': '模型设置', 'zh-TW': '模型設定', en: 'Models' },
    'tab.speed': { 'zh-CN': '速度对比', 'zh-TW': '速度對比', en: 'Speed' },
    'tab.settings': { 'zh-CN': '配置', 'zh-TW': '配置', en: 'setting' },

    // 分页 1: 当前会话与版本同步提示
    'versionSync.mismatch': { 'zh-CN': '⚠️ 检测到官方 Antigravity 已更新至 v{officialVer}（当前哈基米基于 v{hakimiVer}）。如需同步新版底座，请运行：bash ./build-hakimi.sh --force --restart', 'zh-TW': '⚠️ 偵測到官方 Antigravity 已更新至 v{officialVer}（目前哈基米基於 v{hakimiVer}）。如需同步新版底座，請執行：bash ./build-hakimi.sh --force --restart', en: '⚠️ Official Antigravity updated to v{officialVer} (Hakimi is on v{hakimiVer}). Rebuild with: bash ./build-hakimi.sh --force --restart' },
    'session.quick.compactBusy': { 'zh-CN': '⏳ 正在压缩…', 'zh-TW': '⏳ 正在壓縮…', en: '⏳ Compacting…' },
    'session.quick.compactDone': { 'zh-CN': '✔ 已向当前会话发送 /compact 指令，上下文即将更新。', 'zh-TW': '✔ 已向目前工作階段發送 /compact 指令，上下文即將更新。', en: '✔ Sent /compact command to active chat; context will refresh shortly.' },
    'session.quick.compactFail': { 'zh-CN': '✖ 触发压缩失败：{err}', 'zh-TW': '✖ 觸發壓縮失敗：{err}', en: '✖ Failed to trigger compact: {err}' },
    'session.quick.compactNoSession': { 'zh-CN': '请先打开一个对话会话并确保后台已就绪。', 'zh-TW': '請先開啟一個對話工作階段並確保後台已就緒。', en: 'Open an active chat and wait until backend is ready.' },
    'topbar.quick.compactTitle': { 'zh-CN': 'Compact 压缩上下文', 'zh-TW': 'Compact 壓縮上下文', en: 'Compact Context' },
    'topbar.quick.compactDesc': { 'zh-CN': '向当前会话发送 /compact，清理历史冗余释放空间', 'zh-TW': '向目前對話發送 /compact，清理歷史冗餘釋放空間', en: 'Send /compact to summarize chat history and free space' },
    'topbar.quick.compactBusyDesc': { 'zh-CN': '正在向当前会话发送 /compact 指令…', 'zh-TW': '正在向目前對話發送 /compact 指令…', en: 'Sending /compact command to active chat…' },
    'twp.aria': { 'zh-CN': '调整上下文窗口上限', 'zh-TW': '調整上下文視窗上限', en: 'Adjust context window limit' },
    'twp.tipTitle': { 'zh-CN': '上下文窗口（{cur}）', 'zh-TW': '上下文視窗（{cur}）', en: 'Context Window ({cur})' },
    'twp.tipDescUnified': { 'zh-CN': '全局统一 · 点击切换 512K / 1M / 动态', 'zh-TW': '全域統一 · 點擊切換 512K / 1M / 動態', en: 'All models · Click to switch 512K / 1M / Dynamic' },
    'twp.tipDescModel': { 'zh-CN': '{model} · 点击切换 512K / 1M / 动态', 'zh-TW': '{model} · 點擊切換 512K / 1M / 動態', en: '{model} · Click to switch 512K / 1M / Dynamic' },
    'twp.scopeUnified': { 'zh-CN': '作用域：全部模型统一', 'zh-TW': '作用域：全部模型統一', en: 'Scope: All Models' },
    'twp.scopeModel': { 'zh-CN': '当前：{model}', 'zh-TW': '目前：{model}', en: 'Model: {model}' },
    'twp.scopeModelPending': { 'zh-CN': '当前模型：待识别', 'zh-TW': '目前模型：待識別', en: 'Current Model: Detecting…' },
    'twp.switchToPerModel': { 'zh-CN': '切分模型', 'zh-TW': '切分模型', en: 'Per-Model' },
    'twp.switchToUnified': { 'zh-CN': '切统一', 'zh-TW': '切統一', en: 'Unified' },
    'twp.preset.dynamic': { 'zh-CN': '动态', 'zh-TW': '動態', en: 'Auto' },
    'twp.moreModels': { 'zh-CN': '⚙️ 自定义数值 / 管理全部模型 ›', 'zh-TW': '⚙️ 自訂數值 / 管理全部模型 ›', en: '⚙️ Custom Limit / All Models ›' },
    'twp.unconfirmedHint': { 'zh-CN': '暂未识别当前聊天模型，请先打开对话或点击下方管理全部模型。', 'zh-TW': '暫未識別目前聊天模型，請先開啟對話或點擊下方管理全部模型。', en: 'Active model not detected yet; open a chat or manage all models below.' },
    'twp.customActiveNote': { 'zh-CN': '当前自定义上限：{val}', 'zh-TW': '目前自訂上限：{val}', en: 'Custom limit active: {val}' },
    'twp.savedDone': { 'zh-CN': '✔ 已设为 {target}（下一条消息生效）', 'zh-TW': '✔ 已設為 {target}（下一則訊息生效）', en: '✔ Set to {target} (applies on next message)' },
    'twp.savedNeedRestart': { 'zh-CN': '✔ 已设为 {target} 并解锁底座，请重启客户端生效', 'zh-TW': '✔ 已設為 {target} 並解鎖底座，請重啟用戶端生效', en: '✔ Set to {target} & unlocked backend; restart client to apply' },
    'twp.saveFail': { 'zh-CN': '✖ 调整上限失败：{err}', 'zh-TW': '✖ 調整上限失敗：{err}', en: '✖ Failed to update limit: {err}' },
    'key.limitNextTip': { 'zh-CN': '当前轮次预算 {cur}，下一条消息将按 {next} 生效', 'zh-TW': '目前輪次預算 {cur}，下一則訊息將按 {next} 生效', en: 'Current turn budget {cur}; next message will use {next}' },
    'session.keySummary.title': { 'zh-CN': '⭐ 核心用量速览', 'zh-TW': '⭐ 核心用量速覽', en: '⭐ Context Summary' },
    'session.badge.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Loading' },
    'session.stat.used': { 'zh-CN': '当前已用', 'zh-TW': '目前已用', en: 'Used' },
    'session.stat.limit': { 'zh-CN': '预算上限', 'zh-TW': '預算上限', en: 'Budget Limit' },
    'session.stat.remaining': { 'zh-CN': '剩余可用', 'zh-TW': '剩餘可用', en: 'Remaining' },
    'session.keyTakeaway.loading': { 'zh-CN': '正在计算核心指标…', 'zh-TW': '正在計算核心指標…', en: 'Calculating key metrics…' },
    'session.speedSummary.title': { 'zh-CN': '⚡ 最新生成速度与耗时', 'zh-TW': '⚡ 最新生成速度與耗時', en: '⚡ Latest Speed & Latency' },
    'session.speed.pending': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
    'session.speed.rate': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output Speed' },
    'session.speed.duration': { 'zh-CN': '生成耗时', 'zh-TW': '生成耗時', en: 'Duration' },
    'session.speed.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
    'session.speed.tokens': { 'zh-CN': '本次输出', 'zh-TW': '本次輸出', en: 'Output' },
    'session.speed.wait': { 'zh-CN': '等待首次模型输出产生速度统计…', 'zh-TW': '等待首次模型輸出產生速度統計…', en: 'Waiting for the first model response…' },
    'session.cacheSummary.title': { 'zh-CN': '♻️ 上下文缓存命中', 'zh-TW': '♻️ 上下文快取命中', en: '♻️ Context Cache Reuse' },
    'session.cache.pending': { 'zh-CN': '待统计', 'zh-TW': '待統計', en: 'Pending' },
    'session.cache.rate': { 'zh-CN': '本轮命中率', 'zh-TW': '本輪命中率', en: 'Turn Hit Rate' },
    'session.cache.read': { 'zh-CN': '缓存复用', 'zh-TW': '快取複用', en: 'Cache Read' },
    'session.cache.fresh': { 'zh-CN': '未缓存新增', 'zh-TW': '未快取新增', en: 'Uncached' },
    'session.cache.sessionRate': { 'zh-CN': '会话命中率', 'zh-TW': '工作階段命中率', en: 'Session Rate' },
    'session.cache.wait': { 'zh-CN': '等待请求返回输入与缓存复用统计…', 'zh-TW': '等待請求回傳輸入與快取複用統計…', en: 'Waiting for input and cache read token stats…' },
    'session.compact.title': { 'zh-CN': '上下文设置', 'zh-TW': '上下文設定', en: 'Context Settings' },
    'session.compact.scopeUnified': { 'zh-CN': '上下文上限 · 全局统一', 'zh-TW': '上下文上限 · 全域統一', en: 'Context Limit · All Models' },
    'session.compact.scopeModel': { 'zh-CN': '上下文上限 · {model}', 'zh-TW': '上下文上限 · {model}', en: 'Context Limit · {model}' },
    'session.compact.savedLabel': { 'zh-CN': '本模型已保存：', 'zh-TW': '本模型已儲存：', en: 'Saved for model: ' },
    'session.compact.clientLabel': { 'zh-CN': '客户端当前使用：', 'zh-TW': '用戶端目前使用：', en: 'Client active: ' },
    'session.compact.gotoModels': { 'zh-CN': '管理全部模型 ›', 'zh-TW': '管理全部模型 ›', en: 'All Models ›' },
    'session.techDrawer.title': { 'zh-CN': '📋 底层技术参数与附件审计', 'zh-TW': '📋 底層技術參數與附件稽核', en: '📋 Technical Metrics & Attachment Audit' },
    'session.techDrawer.expand': { 'zh-CN': '▼ 点击展开明细', 'zh-TW': '▼ 點擊展開明細', en: '▼ Show details' },
    'session.techDrawer.collapse': { 'zh-CN': '▲ 点击收起明细', 'zh-TW': '▲ 點擊收起明細', en: '▲ Hide details' },
    'session.tech.checking': { 'zh-CN': '正在核对请求和附件…', 'zh-TW': '正在核對請求與附件…', en: 'Checking requests and attachments…' },
    'session.tech.latestReq': { 'zh-CN': '最近一次模型请求', 'zh-TW': '最近一次模型請求', en: 'Latest Model Request' },
    'session.tech.reqStatus': { 'zh-CN': '请求状态', 'zh-TW': '請求狀態', en: 'Request status' },
    'session.tech.actual': { 'zh-CN': '模型返回输入＋输出', 'zh-TW': '模型回傳輸入＋輸出', en: 'Returned input + output' },
    'session.tech.cacheDetail': { 'zh-CN': '本轮输入构成（缓存／新增）', 'zh-TW': '本輪輸入構成（快取／新增）', en: 'Input breakdown (cached / fresh)' },
    'session.tech.estimate': { 'zh-CN': '客户端估算（可能漏附件）', 'zh-TW': '用戶端估算（可能漏附件）', en: 'Client estimate (may miss files)' },
    'session.tech.budget': { 'zh-CN': '客户端预算字段', 'zh-TW': '用戶端預算欄位', en: 'Client budget field' },
    'session.tech.serviceLimit': { 'zh-CN': '该次报错的服务端限制', 'zh-TW': '該次報錯的伺服器端限制', en: 'Server limit from error' },
    'session.tech.percent': { 'zh-CN': '相对客户端预算', 'zh-TW': '相對用戶端預算', en: 'Share of client budget' },
    'session.tech.sessionHeading': { 'zh-CN': '整个会话累计内容 · 本地估算', 'zh-TW': '整個工作階段累計內容 · 本機估算', en: 'Cumulative Session Content · Local Estimate' },
    'session.tech.sessionTotal': { 'zh-CN': '可读取文本 token 估算', 'zh-TW': '可讀取文字 token 估算', en: 'Readable text token est.' },
    'session.tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
    'session.tech.characters': { 'zh-CN': '实际读取文字字符数', 'zh-TW': '實際讀取文字字元數', en: 'Readable characters' },
    'session.tech.user': { 'zh-CN': '用户消息', 'zh-TW': '使用者訊息', en: 'User messages' },
    'session.tech.assistant': { 'zh-CN': '模型回复', 'zh-TW': '模型回覆', en: 'Assistant replies' },
    'session.tech.thinking': { 'zh-CN': '可见思考内容', 'zh-TW': '可見思考內容', en: 'Visible thinking' },
    'session.tech.tools': { 'zh-CN': '工具调用与工具输出', 'zh-TW': '工具呼叫與工具輸出', en: 'Tool calls & outputs' },
    'session.tech.summaries': { 'zh-CN': '历史压缩摘要', 'zh-TW': '歷史壓縮摘要', en: 'Compressed summaries' },
    'session.tech.system': { 'zh-CN': '当前系统提示与工具定义', 'zh-TW': '目前系統提示與工具定義', en: 'System prompt & tools' },
    'session.tech.attachments': { 'zh-CN': '上传／输出附件文本', 'zh-TW': '上傳／輸出附件文字', en: 'Attachment text' },
    'session.tech.steps': { 'zh-CN': '历史步骤完整性', 'zh-TW': '歷史步驟完整性', en: 'History completeness' },
    'session.tech.filesHeading': { 'zh-CN': '附件逐项检查', 'zh-TW': '附件逐項檢查', en: 'Attachment Inspection' },
    'session.tech.rescan': { 'zh-CN': '重新扫描整段会话与附件', 'zh-TW': '重新掃描整段工作階段與附件', en: 'Rescan session & attachments' },
    'session.tech.note': {
      'zh-CN': '会话累计包括可读取的全部归档历史；已压缩内容仍计入累计。它不等于当前实际发送给模型的上下文，不能用累计值除以 1M 判断剩余空间。附件原文与工具读出的文本可能在历史中分别出现，各按一次出现计入。尚未发送的草稿与待上传附件不在归档内，暂未计入；新上传可能使下一次请求明显增长。<br><br>本地 token 区间是文本启发式估算，不是 Gemini 分词结果，也不是严格上下界。图像、音视频、加密文件、不可访问文件和未解析部分会明确列为未知。未知内容不按零处理；只有服务端返回的用量才标为实际统计。此功能不向外部发送文件，不执行宏或公式。',
      'zh-TW': '工作階段累計包含可讀取的全部封存歷史；已壓縮內容仍計入累計。它不等於目前實際傳送給模型的上下文，不能用累計值除以 1M 判斷剩餘空間。附件原文與工具讀出的文字可能在歷史中分別出現，各按一次出現計入。尚未傳送的草稿與待上傳附件不在封存內，暫未計入；新上傳可能使下一次請求明顯增長。<br><br>本機 token 區間是文字啟發式估算，不是 Gemini 分詞結果，也不是嚴格上下界。影像、音視訊、加密檔案、無法存取檔案與未解析部分會明確列為未知。未知內容不按零處理；只有伺服器端回傳的用量才標為實際統計。此功能不向外部傳送檔案，不執行巨集或公式。',
      en: 'Cumulative session totals include all readable archived history (including compressed turns). They do not equal the active context sent to the model and must not be divided by 1M to judge remaining space. Attachment text and tool-read text may appear separately in history and are counted per occurrence. Unsent drafts and pending uploads are excluded.<br><br>Local token ranges are text heuristics, not exact Gemini tokenization or strict bounds. Images, audio/video, encrypted, inaccessible, or unparsed items are marked unknown (never zero). Only server-returned counts are labeled actual usage. No files are sent externally and no macros are executed.'
    },

    // 分页 2: 模型设置
    'models.list.aria': { 'zh-CN': '按厂商分组的模型产品列表', 'zh-TW': '依廠商分組的模型產品清單', en: 'Models grouped by vendor' },
    'models.list.empty': { 'zh-CN': '暂无已知模型，发一条消息或等待模型列表加载后显示。', 'zh-TW': '暫無已知模型，發送一則訊息或等待模型清單載入後顯示。', en: 'No models detected yet. Send a message or wait for the model list to load.' },
    'models.restartBtn': { 'zh-CN': '重启客户端使设置生效', 'zh-TW': '重新啟動用戶端使設定生效', en: 'Restart client to apply' },
    'models.manualRestart': { 'zh-CN': '请手动重启：关闭所有 Antigravity 窗口（包括托盘图标里的“退出”），再重新打开 Antigravity。', 'zh-TW': '請手動重新啟動：關閉所有 Antigravity 視窗（包含系統匣圖示中的「結束」），再重新開啟 Antigravity。', en: 'Please restart manually: close all Antigravity windows (including Quit from the tray icon) and reopen Antigravity.' },
    'models.restartConfirm.text': { 'zh-CN': '重启会中断正在运行的任务。请先保存未保存的内容。', 'zh-TW': '重新啟動會中斷正在執行的任務。請先儲存未儲存的內容。', en: 'Restarting will interrupt active tasks. Please save any unsaved work first.' },
    'models.restartConfirm.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
    'models.restartConfirm.go': { 'zh-CN': '重启', 'zh-TW': '重新啟動', en: 'Restart' },
    'models.restart.restarting': { 'zh-CN': '正在重启客户端…', 'zh-TW': '正在重新啟動用戶端…', en: 'Restarting client…' },
    'models.restart.notExited': { 'zh-CN': '客户端没有退出，可能被取消或正在等待。请手动重启。', 'zh-TW': '用戶端沒有結束，可能被取消或正在等待。請手動重新啟動。', en: 'The client did not exit (cancelled or busy). Please restart manually.' },
    'models.conflict.title': { 'zh-CN': '这个模型的不同档位保存过不同长度，请选一个统一值。', 'zh-TW': '此模型的不同檔位儲存過不同長度，請選一個統一值。', en: 'Different efforts of this model have different saved limits. Pick one unified value.' },
    'models.conflict.keep': { 'zh-CN': '保留此值', 'zh-TW': '保留此值', en: 'Use this' },
    'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
    'models.card.efforts': { 'zh-CN': '可用档位：{val}', 'zh-TW': '可用檔位：{val}', en: 'Efforts: {val}' },
    'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
    'models.card.sessionEffort': { 'zh-CN': '当前会话：{val}', 'zh-TW': '目前工作階段：{val}', en: 'Current session: {val}' },
    'models.card.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'models.card.savedSide': { 'zh-CN': '为这个模型记下的长度', 'zh-TW': '為此模型記下的長度', en: 'Saved limit for this model' },
    'models.card.request': { 'zh-CN': '请求携带', 'zh-TW': '請求攜帶', en: 'Request Attached' },
    'models.mode.aria': { 'zh-CN': '上下文设置模式', 'zh-TW': '上下文設定模式', en: 'Context setting mode' },
    'models.mode.unifiedTitle': { 'zh-CN': '所有模型统一设置', 'zh-TW': '所有模型統一設定', en: 'Unified for All Models' },
    'models.mode.unifiedDesc': { 'zh-CN': '设置一次，所有模型使用相同的上下文长度。', 'zh-TW': '設定一次，所有模型使用相同的上下文長度。', en: 'Set once; all models use the same context length.' },
    'models.mode.perModelTitle': { 'zh-CN': '按模型分别设置', 'zh-TW': '依模型個別設定', en: 'Per-Model Separate Settings' },
    'models.mode.perModelDesc': { 'zh-CN': '每个模型分别保存，使用哪个模型，就采用它的上下文长度。', 'zh-TW': '每個模型分別儲存，使用哪個模型，就採用其上下文長度。', en: 'Each model saved separately; active model uses its own length.' },
    'models.summary.mode': { 'zh-CN': '当前模式', 'zh-TW': '目前模式', en: 'Active Mode' },
    'models.summary.model': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Active Model' },
    'models.summary.length': { 'zh-CN': '目标设置与状态', 'zh-TW': '目標設定與狀態', en: 'Target & Status' },
    'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
    'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
    'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
    'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
    'panel.ctx.currentModelUnconfirmed': { 'zh-CN': '当前会话模型待确认（请在输入框选择模型或发送消息）', 'zh-TW': '目前工作階段模型待確認（請在輸入框選擇模型或發送訊息）', en: 'Active model pending confirmation (select a model or send a message first)' },
    'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
    'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
    'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
    'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
    'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
    'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
    'models.summary.unconfirmed': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
    'models.summary.pendingRestart': { 'zh-CN': '待重启生效', 'zh-TW': '待重啟生效', en: 'Pending Restart' },
    'models.summary.modelDefault': { 'zh-CN': '使用模型默认值', 'zh-TW': '使用模型預設值', en: 'Use model default' },
    'models.summary.unifiedTarget': { 'zh-CN': '所有模型（统一生效）', 'zh-TW': '所有模型（統一生效）', en: 'All models (unified)' },
    'models.card.detailsToggle': { 'zh-CN': '详细信息（能力参考、请求参数与预算验证）', 'zh-TW': '詳細資訊（能力參考、請求參數與預算驗證）', en: 'Details (Capabilities, request & budget)' },
    'models.card.requestSide': { 'zh-CN': '本次请求发送给底座的参数', 'zh-TW': '本次請求發送給底座的參數', en: 'Limit sent in request' },
    'models.card.client': { 'zh-CN': '底座引擎', 'zh-TW': '底座引擎', en: 'Base Engine' },
    'models.card.clientSide': { 'zh-CN': '底座透传与门禁状态', 'zh-TW': '底座透傳與門禁狀態', en: 'Pass-through & gate status' },
    'models.card.observedBudget': { 'zh-CN': '实测预算', 'zh-TW': '實測預算', en: 'Observed Budget' },
    'models.card.observedBudgetNone': { 'zh-CN': '尚未观测', 'zh-TW': '尚未觀測', en: 'Not observed yet' },
    'models.card.observedBudgetSide': { 'zh-CN': '对话中实际分配', 'zh-TW': '對話中實際分配', en: 'Allocated in live turns' },
    'models.card.observedSpeed': { 'zh-CN': '实测速度', 'zh-TW': '實測速度', en: 'Observed Speed' },
    'models.card.observedSpeedNone': { 'zh-CN': '暂无实测数据', 'zh-TW': '暫無實測資料', en: 'No speed data yet' },
    'models.card.gotoSpeed': { 'zh-CN': '查看速度对比 ›', 'zh-TW': '檢視速度對比 ›', en: 'Compare speed ›' },
    'models.preset.aria': { 'zh-CN': '上下文长度预设', 'zh-TW': '上下文長度預設', en: 'Context length presets' },
    'models.preset.default': { 'zh-CN': '恢复客户端默认', 'zh-TW': '恢復用戶端預設', en: 'Restore Client Default' },
    'models.preset.defaultSub': { 'zh-CN': '清除请求覆盖，由当前底座策略决定', 'zh-TW': '清除請求覆寫，由目前底座策略決定', en: 'Clear request override; follow active host policy' },
    'models.preset.p512Sub': { 'zh-CN': '标准预设 · 512,000 tokens', 'zh-TW': '標準預設 · 512,000 tokens', en: 'Standard preset · 512,000 tokens' },
    'models.preset.p1mSub': { 'zh-CN': '1M 满血窗口 · 自动预留输出', 'zh-TW': '1M 滿血視窗 · 自動預留輸出', en: '1M full window · auto output reserve' },
    'models.preset.modelMax': { 'zh-CN': '按模型最大可用', 'zh-TW': '依模型最大可用', en: 'Max Usable for Model' },
    'models.preset.modelMaxSub': { 'zh-CN': '总窗口 - 最大输出（需元数据）', 'zh-TW': '總視窗 - 最大輸出（需中繼資料）', en: 'Context window - max output (needs metadata)' },
    'models.preset.dynamic': { 'zh-CN': '动态跟随', 'zh-TW': '動態跟隨', en: 'Dynamic Follow' },
    'models.preset.dynamicSub': { 'zh-CN': '不固定数值，按底座动态计算', 'zh-TW': '不固定數值，依底座動態計算', en: 'No fixed cap; compute dynamically on host' },
    'models.cap.window': { 'zh-CN': '模型总窗口', 'zh-TW': '模型總視窗', en: 'Context Window' },
    'models.cap.output': { 'zh-CN': '最大输出', 'zh-TW': '最大輸出', en: 'Max Output' },
    'models.cap.modelMax': { 'zh-CN': '模型理论输入上限', 'zh-TW': '模型理論輸入上限', en: 'Model Theoretical Input Cap' },
    'models.cap.clientPolicy': { 'zh-CN': '当前客户端限制', 'zh-TW': '目前用戶端限制', en: 'Current Client Policy Limit' },
    'models.cap.defaultCap': { 'zh-CN': '当前策略默认预算', 'zh-TW': '目前策略預設預算', en: 'Current Strategy Default' },
    'models.cap.range': { 'zh-CN': '当前可采纳输入范围', 'zh-TW': '目前可採納輸入範圍', en: 'Adoptable Input Range' },
    'models.cap.formulaLbl': { 'zh-CN': '来源与计算说明', 'zh-TW': '來源與計算說明', en: 'Source & Formula' },
    'models.cap.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'models.cap.sent': { 'zh-CN': '最近请求携带', 'zh-TW': '最近請求攜帶', en: 'Last Request' },
    'models.cap.adopted': { 'zh-CN': '后端实际采用', 'zh-TW': '後端實際採用', en: 'Backend Adopted' },
    'models.card.tierCaps': { 'zh-CN': '档位能力', 'zh-TW': '檔位能力', en: 'Tier Capabilities' },
    'models.custom.label': { 'zh-CN': '自定义长度', 'zh-TW': '自訂長度', en: 'Custom limit' },
    'models.custom.placeholder': { 'zh-CN': '输入整数，例如 333333', 'zh-TW': '輸入整數，例如 333333', en: 'Enter integer, e.g. 333333' },
    'models.validation.defaultRange': { 'zh-CN': '可设置范围：16,384 – 2,097,152 tokens。', 'zh-TW': '可設定範圍：16,384 – 2,097,152 tokens。', en: 'Valid range: 16,384 – 2,097,152 tokens.' },
    'models.validation.empty': { 'zh-CN': '请输入 16,384 到 2,097,152 之间的整数。', 'zh-TW': '請輸入 16,384 到 2,097,152 之間的整數。', en: 'Enter an integer between 16,384 and 2,097,152.' },
    'models.validation.int': { 'zh-CN': '请输入整数（不要带小数或单位）。', 'zh-TW': '請輸入整數（不要帶小數或單位）。', en: 'Enter a whole integer without decimals or units.' },
    'models.validation.range': { 'zh-CN': '数值必须在 16,384 – 2,097,152 tokens 之间。', 'zh-TW': '數值必須在 16,384 – 2,097,152 tokens 之間。', en: 'Value must be between 16,384 and 2,097,152 tokens.' },
    'models.btn.save': { 'zh-CN': '保存自定义', 'zh-TW': '儲存自訂', en: 'Save Custom' },
    'models.btn.saveApply': { 'zh-CN': '保存并应用', 'zh-TW': '儲存並套用', en: 'Save & Apply' },
    'models.btn.reset': { 'zh-CN': '恢复默认', 'zh-TW': '恢復預設', en: 'Reset to Default' },
    'models.help.line1': { 'zh-CN': '点击预设即时生效；自定义整数请填写后点「保存自定义」（底座在动态跟随解锁后逐模型生效）。', 'zh-TW': '點擊預設即時生效；自訂整數請填寫後點「儲存自訂」（底座在動態跟隨解鎖後逐模型生效）。', en: 'Presets apply on click; enter custom integer and click Save Custom (dynamic backend routes per model).' },
    'models.help.line2': { 'zh-CN': '各模型根据保存的设置独立生效，多会话与模型切换互不干扰。', 'zh-TW': '各模型依儲存的設定獨立生效，多工作階段與模型切換互不干擾。', en: 'Each model applies its saved setting independently without crosstalk across sessions or switches.' },
    'models.details.title': { 'zh-CN': '详细说明', 'zh-TW': '詳細說明', en: 'Details & Notes' },
    'models.details.li1': { 'zh-CN': '<strong>设置存在哪里</strong>：模型设置保存在插件的本地设置文件里，按模型产品记录。「应用」会把一种设置写入客户端的语言服务，重启后由新进程读取。', 'zh-TW': '<strong>設定儲存在哪裡</strong>：模型設定儲存在外掛的本機設定檔中，依模型產品記錄。「套用」會將設定寫入用戶端語言服務，重新啟動後由新行程讀取。', en: '<strong>Where settings live</strong>: Per-model preferences are stored in local plugin settings. "Apply" writes the selected limit to the client language server for the next restart.' },
    'models.details.li2': {
      'zh-CN': '<strong>几个数字的区别</strong>：<div>已保存：你为模型记下的目标。</div><div>请求携带：本次对话请求实际发送给底座的参数。</div><div>底座引擎：底座语言服务的动态跟随状态。</div><div>实测预算：对话请求中客户端实际分配的上下文预算。</div><div>服务端报错上限：只有服务端拒绝请求时才会出现。</div>',
      'zh-TW': '<strong>幾個數字的區別</strong>：<div>已儲存：你為模型記下的目標。</div><div>請求攜帶：本次對話請求實際發送給底座的參數。</div><div>底座引擎：底座語言服務的動態跟隨狀態。</div><div>實測預算：對話請求中用戶端實際分配的上下文預算。</div><div>伺服器端報錯上限：只有伺服器端拒絕請求時才會出現。</div>',
      en: '<strong>Understanding the numbers</strong>:<div>Saved: target limit for this model.</div><div>Request Attached: parameter sent in this turn.</div><div>Base Engine: follow state of the language server.</div><div>Observed budget: actual budget allocated in live turns.</div><div>Service limit: appears only when the server rejects a request.</div>'
    },
    'models.details.li3': { 'zh-CN': '<strong>影响范围</strong>：底座引擎采用动态跟随架构，每个对话请求按当前所选模型分别携带独立上下文参数，多会话与多模型并发隔离生效。', 'zh-TW': '<strong>影響範圍</strong>：底座引擎採用動態跟隨架構，每個對話請求按目前所選模型分別攜帶獨立上下文參數，多工作階段與多模型並發隔離生效。', en: '<strong>Scope</strong>: The base engine uses a dynamic follow architecture, where each request carries independent context limits per model with full multi-session isolation.' },
    'models.details.li4': {
      'zh-CN': '<strong>验证范围</strong>：<div>已验证：客户端重启后读到了新设置，并在之后的会话中观测到对应预算。</div><div>未验证：真实超长请求能否被服务端完整接受；账号风险未知。</div>',
      'zh-TW': '<strong>驗證範圍</strong>：<div>已驗證：用戶端重啟後讀到了新設定，並在之後的對話中觀測到對應預算。</div><div>未驗證：真實超長請求能否被伺服器端完整接受；帳號風險未知。</div>',
      en: '<strong>Verification scope</strong>:<div>Verified: client read the new setting after restart and live turns showed the updated budget.</div><div>Unverified: whether the server accepts full ultra-long requests; account risk is unknown.</div>'
    },
    'models.details.li5': { 'zh-CN': '<strong>精确数值</strong>：512K = 512,000 tokens；1M = 1,000,000 tokens；可设置范围 16,384 – 2,097,152 tokens；跟随模型不固定数值。', 'zh-TW': '<strong>精確數值</strong>：512K = 512,000 tokens；1M = 1,000,000 tokens；可設定範圍 16,384 – 2,097,152 tokens；跟隨模型不固定數值。', en: '<strong>Exact values</strong>: 512K = 512,000; 1M = 1,000,000 tokens; allowed range 16,384 – 2,097,152 tokens; Follow Model has no fixed cap.' },
    'models.btn.restoreOriginal': { 'zh-CN': '客户端恢复原始设置', 'zh-TW': '用戶端恢復原始設定', en: 'Restore Client Default' },
    'models.btn.refreshStatus': { 'zh-CN': '刷新状态', 'zh-TW': '重新整理狀態', en: 'Refresh' },
    'models.status.detecting': { 'zh-CN': '正在检测当前 Antigravity 状态…', 'zh-TW': '正在偵測目前 Antigravity 狀態…', en: 'Detecting current Antigravity status…' },
    'models.meta.mode': { 'zh-CN': '当前配置 / 实测', 'zh-TW': '目前設定 / 實測', en: 'Config / Observed' },
    'models.meta.target': { 'zh-CN': '目标进程', 'zh-TW': '目標行程', en: 'Target Binary' },
    'models.meta.arch': { 'zh-CN': '系统架构', 'zh-TW': '系統架構', en: 'Architecture' },
    'models.meta.backup': { 'zh-CN': '原版备份状态', 'zh-TW': '原版備份狀態', en: 'Original Backup' },
    'models.credit.source': { 'zh-CN': '方案来源：', 'zh-TW': '方案來源：', en: 'Source:' },
    'models.credit.author': { 'zh-CN': '原作者帖子 (Linux.do @23375) ↗', 'zh-TW': '原作者文章 (Linux.do @23375) ↗', en: 'Original Post (Linux.do @23375) ↗' },
    'models.credit.copy': { 'zh-CN': '📋 复制链接', 'zh-TW': '📋 複製連結', en: '📋 Copy Link' },
    'models.credit.adapter': { 'zh-CN': '本项目负责 Node.js 适配与集成', 'zh-TW': '本專案負責 Node.js 適配與整合', en: 'Node.js adaptation & integration by this project' },

    // 状态与反馈通用
    'status.savedDefault': { 'zh-CN': '未单独设置（使用默认）', 'zh-TW': '未單獨設定（使用預設）', en: 'Not set (Default)' },
    'status.savedShortDefault': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
    'status.badge.unavailable': { 'zh-CN': '暂时无法读取客户端状态', 'zh-TW': '暫時無法讀取用戶端狀態', en: 'Client status unavailable' },
    'status.badge.reading': { 'zh-CN': '状态读取中…', 'zh-TW': '狀態讀取中…', en: 'Reading status…' },
    'status.badge.pendingRestart': { 'zh-CN': '需要重启', 'zh-TW': '需要重新啟動', en: 'Restart Required' },
    'status.badge.notPatched': { 'zh-CN': '未修改（使用默认）', 'zh-TW': '未修改（使用預設）', en: 'Unmodified (Default)' },
    'status.badge.unconfirmed': { 'zh-CN': '状态未确认', 'zh-TW': '狀態未確認', en: 'Unconfirmed' },
    'status.badge.loaded': { 'zh-CN': '已加载', 'zh-TW': '已載入', en: 'Active' },
    'status.badge.failed': { 'zh-CN': '应用失败', 'zh-TW': '套用失敗', en: 'Apply Failed' },
    'status.client.reading': { 'zh-CN': '客户端设置：状态读取中…', 'zh-TW': '用戶端設定：狀態讀取中…', en: 'Client setting: reading…' },
    'status.client.pendingRestart': { 'zh-CN': '待重启：已设置为 {val}，重启后生效', 'zh-TW': '待重啟：已設定為 {val}，重啟後生效', en: 'Pending restart: set to {val}, restart client to apply' },
    'status.client.loadedFixed': { 'zh-CN': '当前已加载的设置：{val}', 'zh-TW': '目前已載入的設定：{val}', en: 'Active loaded setting: {val}' },
    'status.client.loadedDynamic': { 'zh-CN': '当前已加载的设置：跟随模型', 'zh-TW': '目前已載入的設定：跟隨模型', en: 'Active loaded setting: Follow Model' },
    'status.client.loadedDefault': { 'zh-CN': '当前已加载的设置：官方默认', 'zh-TW': '目前已載入的設定：官方預設', en: 'Active loaded setting: Official Default' },
    'status.client.unknown': { 'zh-CN': '当前已加载设置：未知', 'zh-TW': '目前已載入設定：未知', en: 'Active loaded setting: unknown' },
    'status.client.dynamic': { 'zh-CN': '客户端设置：跟随模型（各模型实际长度可能不同）', 'zh-TW': '用戶端設定：跟隨模型（各模型實際長度可能不同）', en: 'Client setting: Follow Model (varies by model)' },
    'status.client.fixed': { 'zh-CN': '客户端设置：{val}（所有模型同一长度）', 'zh-TW': '用戶端設定：{val}（所有模型同一長度）', en: 'Client setting: {val} (shared across models)' },
    'msg.savedUnified': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為此模型儲存統一設定。', en: 'Saved unified setting for this model.' },
    'msg.saveUnifiedFail': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save unified setting: {err}' },
    'msg.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
    'msg.resetDefault': { 'zh-CN': '已恢复默认设置。', 'zh-TW': '已恢復預設設定。', en: 'Reset to default.' },
    'msg.resetStillUsing': { 'zh-CN': '客户端仍在使用 {val}。需要时请在「详细说明」里点「客户端恢复原始设置」。', 'zh-TW': '用戶端仍在使用 {val}。需要時請在「詳細說明」中點擊「用戶端恢復原始設定」。', en: 'Client is still using {val}. Use "Restore Client Default" in Details if needed.' },
    'msg.clearFail': { 'zh-CN': '清除设置失败：{err}', 'zh-TW': '清除設定失敗：{err}', en: 'Failed to clear setting: {err}' },
    'msg.appliedRestart': { 'zh-CN': '已应用。重启客户端后生效。', 'zh-TW': '已套用。重新啟動用戶端後生效。', en: 'Applied. Restart the client to take effect.' },
    'msg.alreadyClient': { 'zh-CN': '客户端已经是这个设置', 'zh-TW': '用戶端已經是此設定', en: 'Client is already using this setting.' },
    'msg.applied': { 'zh-CN': '已应用当前设置。', 'zh-TW': '已套用目前設定。', en: 'Setting applied.' },
    'msg.restoredRestart': { 'zh-CN': '客户端已恢复原始设置，重启客户端后生效。', 'zh-TW': '用戶端已恢復原始設定，重新啟動用戶端後生效。', en: 'Client restored to original default. Restart to take effect.' },
    'msg.restoreFail': { 'zh-CN': '恢复原始设置失败', 'zh-TW': '恢復原始設定失敗', en: 'Failed to restore client default' },
    'msg.writeBusy': { 'zh-CN': '客户端正在占用文件，写入失败。请关闭客户端后再试。', 'zh-TW': '用戶端正在佔用檔案，寫入失敗。請關閉用戶端後再試。', en: 'File is in use by the client. Close the client and try again.' },
    'msg.writeFail': { 'zh-CN': '写入失败：{err}', 'zh-TW': '寫入失敗：{err}', en: 'Write failed: {err}' },
    'msg.unknownErr': { 'zh-CN': '未知错误', 'zh-TW': '未知錯誤', en: 'Unknown error' },

    // 分页 3: 速度对比
    'speed.range.aria': { 'zh-CN': '时间范围', 'zh-TW': '時間範圍', en: 'Time range' },
    'speed.range.7d': { 'zh-CN': '近 7 天', 'zh-TW': '近 7 天', en: '7D' },
    'speed.range.30d': { 'zh-CN': '近 30 天', 'zh-TW': '近 30 天', en: '30D' },
    'speed.range.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
    'speed.origin.aria': { 'zh-CN': '样本来源', 'zh-TW': '樣本來源', en: 'Sample origin' },
    'speed.origin.all': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All sources' },
    'speed.origin.chat': { 'zh-CN': '日常对话', 'zh-TW': '日常對話', en: 'Chat' },
    'speed.metric.aria': { 'zh-CN': '对比指标', 'zh-TW': '對比指標', en: 'Metric' },
    'speed.metric.tps': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Speed' },
    'speed.metric.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
    'speed.metric.duration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
    'speed.barTitle.tps': { 'zh-CN': '输出速度对比', 'zh-TW': '輸出速度對比', en: 'Output Speed Comparison' },
    'speed.barTitle.ttft': { 'zh-CN': '首字延迟对比', 'zh-TW': '首字延遲對比', en: 'First-Token Latency (TTFT)' },
    'speed.barTitle.duration': { 'zh-CN': '总耗时对比', 'zh-TW': '總耗時對比', en: 'Total Duration Comparison' },
    'speed.empty': { 'zh-CN': '还没有可用的速度记录。正常对话后会自动积累。', 'zh-TW': '還沒有可用的速度記錄。正常對話後會自動累積。', en: 'No speed samples yet. Samples are recorded automatically during normal chats.' },
    'speed.barNote': { 'zh-CN': '以各模型与档位的中位数统计；不足 3 条标注“样本少”。总耗时受输出长度影响，条件相近时才可比较。', 'zh-TW': '以各模型與檔位的中位數統計；不足 3 筆標註「樣本少」。總耗時受輸出長度影響，條件相近時才可比較。', en: 'Bars show median per model & effort; <3 samples are marked "Low n". Total duration depends on output length.' },
    'speed.lineTitle': { 'zh-CN': '单模型速度趋势', 'zh-TW': '單模型速度趨勢', en: 'Model Speed Trend' },
    'speed.linePickTitle': { 'zh-CN': '选择一个模型与档位查看速度变化', 'zh-TW': '選擇一個模型與檔位檢視速度變化', en: 'Select a model & effort to view speed trend' },
    'speed.lineNoModel': { 'zh-CN': '暂无模型记录', 'zh-TW': '暫無模型記錄', en: 'No model records' },
    'speed.activeTestNote': { 'zh-CN': '主动测试：未接通。目前没有可靠的指定模型调用入口，暂时只能使用日常对话的实测记录。', 'zh-TW': '主動測試：未接通。目前沒有可靠的指定模型呼叫入口，暫時只能使用日常對話的實測記錄。', en: 'Active benchmark: unavailable. No reliable per-model probe endpoint exists yet; showing live chat measurements only.' },
    'speed.lowSample': { 'zh-CN': '样本少', 'zh-TW': '樣本少', en: 'Low n' },
    'speed.samples': { 'zh-CN': '{n} 条', 'zh-TW': '{n} 筆', en: '{n} samples' },
    'speed.median': { 'zh-CN': '中位数：{val}', 'zh-TW': '中位數：{val}', en: 'Median: {val}' },
    'speed.avg': { 'zh-CN': '均值：{val}', 'zh-TW': '均值：{val}', en: 'Avg: {val}' },
    'speed.sampleCount': { 'zh-CN': '样本数：{n} 条', 'zh-TW': '樣本數：{n} 筆', en: 'Samples: {n}' },
    'speed.latestAt': { 'zh-CN': '最近：{time}', 'zh-TW': '最近：{time}', en: 'Latest: {time}' },

    // 齿轮设置页
    'settings.back': { 'zh-CN': '‹ 返回', 'zh-TW': '‹ 返回', en: '‹ Back' },
    'settings.title': { 'zh-CN': '设置（语言、网络代理与外观）', 'zh-TW': '設定（語言、網路代理與外觀）', en: 'Settings (Language, Proxy & Appearance)' },
    'settings.panelLang.title': { 'zh-CN': '🌐 插件面板语言（Context Meter）', 'zh-TW': '🌐 外掛面板語言（Context Meter）', en: '🌐 Panel Language (Context Meter)' },
    'settings.panelLang.aria': { 'zh-CN': '插件面板语言', 'zh-TW': '外掛面板語言', en: 'Panel language' },
    'settings.panelLang.desc': { 'zh-CN': '控制 Context Meter 面板、按钮、图表与提示文字。切换立即生效并保存，重启后保留；不改写上下文长度，不触发重启。', 'zh-TW': '控制 Context Meter 面板、按鈕、圖表與提示文字。切換立即生效並儲存，重啟後保留；不改寫上下文長度，不觸發重啟。', en: 'Controls Context Meter UI, charts, and messages. Applies and saves immediately without changing context limits or restarting.' },
    'settings.panelLang.saved': { 'zh-CN': '已切换并保存', 'zh-TW': '已切換並儲存', en: 'Saved' },
    'settings.panelLang.saveLocal': { 'zh-CN': '已切换（仅本地生效）', 'zh-TW': '已切換（僅本機生效）', en: 'Applied locally' },
    'settings.clientLang.title': { 'zh-CN': '🖥️ 客户端界面语言（Antigravity 本身）', 'zh-TW': '🖥️ 用戶端介面語言（Antigravity 本身）', en: '🖥️ Client UI Language (Antigravity)' },
    'settings.clientLang.aria': { 'zh-CN': '客户端界面语言', 'zh-TW': '用戶端介面語言', en: 'Client UI language' },
    'settings.clientLang.statusLabel': { 'zh-CN': '客户端当前语言与生效方式', 'zh-TW': '用戶端目前語言與生效方式', en: 'Client language status & apply behavior' },
    'settings.clientLang.licenseNote': { 'zh-CN': '说明：此设置控制 Antigravity 客户端本身，与上方插件面板语言相互独立。切换客户端语言需重新安装/重启客户端后生效。由于上游客户端繁體中文词典（qqxpee/antigravity2-cn）未声明开源许可证，暂未内置客户端繁體中文选项。', 'zh-TW': '說明：此設定控制 Antigravity 用戶端本身，與上方外掛面板語言相互獨立。切換用戶端語言需重新安裝／重新啟動用戶端後生效。由於上游用戶端繁體中文詞典（qqxpee/antigravity2-cn）未聲明開源授權，暫未內建用戶端繁體中文選項。', en: 'Note: Controls Antigravity itself, independent from Panel Language. Changing client language requires reinstalling/restarting Antigravity. Traditional Chinese client dicts (upstream qqxpee/antigravity2-cn) have no declared license and are not bundled.' },
    'settings.clientLang.sourceLabel': { 'zh-CN': '汉化方案来源：', 'zh-TW': '中文化方案來源：', en: 'Localization source:' },
    'settings.clientLang.sourceValue': { 'zh-CN': 'AntigravityChinese (开源社区贡献)', 'zh-TW': 'AntigravityChinese（開源社群貢獻）', en: 'AntigravityChinese (Community)' },
    'settings.colors.title': { 'zh-CN': '🎨 指标与背景颜色自定义（默认跟随主题）', 'zh-TW': '🎨 指標與背景顏色自訂（預設跟隨主題）', en: '🎨 Metric & Background Colors (Follow Theme)' },
    'settings.colors.panelBg': { 'zh-CN': '面板与菜单统一背景色（0级跟随 / 自定义）', 'zh-TW': '面板與選單統一背景色（0 級跟隨 / 自訂）', en: 'Panel & menu background (Auto / Custom)' },
    'settings.colors.ringUsed': { 'zh-CN': '圆环已用部分', 'zh-TW': '圓環已用部分', en: 'Ring used' },
    'settings.colors.ringTrack': { 'zh-CN': '圆环轨道', 'zh-TW': '圓環軌道', en: 'Ring track' },
    'settings.colors.contextText': { 'zh-CN': '上下文用量文字', 'zh-TW': '上下文用量文字', en: 'Context text' },
    'settings.colors.speedText': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
    'settings.colors.cacheText': { 'zh-CN': '缓存命中率', 'zh-TW': '快取命中率', en: 'Cache hit rate' },
    'settings.colors.tokenTotal': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 token 用量', en: 'Total tokens' },
    'settings.colors.tokenAccent': { 'zh-CN': '其他 token 指标', 'zh-TW': '其他 token 指標', en: 'Token accent' },
    'settings.colors.note': { 'zh-CN': '注：高占用与超限告警色独立保留，不被常态颜色覆盖。', 'zh-TW': '註：高佔用與超限告警色獨立保留，不被常態顏色覆蓋。', en: 'Note: High-usage and overflow alert colors remain independent.' },
    'settings.colors.resetAll': { 'zh-CN': '全部恢复跟随主题', 'zh-TW': '全部恢復跟隨主題', en: 'Reset all to theme' },
    'drawer.expand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
    'drawer.collapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
    'drawer.expandSettings': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
    'drawer.collapseSettings': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

    // 下拉菜单通用
    'dropdown.searchPlaceholder': { 'zh-CN': '🔍 搜索...', 'zh-TW': '🔍 搜尋...', en: '🔍 Search...' },
    'dropdown.empty': { 'zh-CN': '未找到匹配项', 'zh-TW': '找不到符合項目', en: 'No matching items' },
    'dropdown.modelSearch': { 'zh-CN': '🔍 搜索模型或厂商…', 'zh-TW': '🔍 搜尋模型或廠商…', en: '🔍 Search model or vendor…' },
    'dropdown.modelEmpty': { 'zh-CN': '未找到匹配的模型', 'zh-TW': '找不到符合的模型', en: 'No matching models' },
    'dropdown.speedSearch': { 'zh-CN': '🔍 搜索模型或档位…', 'zh-TW': '🔍 搜尋模型或檔位…', en: '🔍 Search model or effort…' },
    'dropdown.speedEmpty': { 'zh-CN': '未找到匹配的模型记录', 'zh-TW': '找不到符合的模型記錄', en: 'No matching speed records' },

    // Token 面板 & 颜色选择器 & 更新浮层
    'tokens.title': { 'zh-CN': '本机已记录用量', 'zh-TW': '本機已記錄用量', en: 'Local Recorded Usage' },
    'tokens.sourceLabel': { 'zh-CN': '来源:', 'zh-TW': '來源:', en: 'Source:' },
    'tokens.src.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
    'tokens.src.desktop': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },
    'tokens.src.cli': { 'zh-CN': 'CLI', 'zh-TW': 'CLI', en: 'CLI' },
    'tokens.card.total': { 'zh-CN': '累计处理 Token', 'zh-TW': '累計處理 Token', en: 'Total Tokens' },
    'tokens.card.includeCache': { 'zh-CN': '含缓存读取', 'zh-TW': '含快取讀取', en: 'Incl. cache reads' },
    'tokens.card.today': { 'zh-CN': '今日使用', 'zh-TW': '今日使用', en: 'Today' },
    'tokens.card.month': { 'zh-CN': '本月使用', 'zh-TW': '本月使用', en: 'This Month' },
    'tokens.card.year': { 'zh-CN': '年度使用', 'zh-TW': '年度使用', en: 'This Year' },
    'tokens.heat.title': { 'zh-CN': 'Token 活动', 'zh-TW': 'Token 活動', en: 'Token Activity' },
    'tokens.heat.daily': { 'zh-CN': '每天', 'zh-TW': '每天', en: 'Daily' },
    'tokens.heat.weekly': { 'zh-CN': '每周', 'zh-TW': '每週', en: 'Weekly' },
    'tokens.heat.monthly': { 'zh-CN': '每月', 'zh-TW': '每月', en: 'Monthly' },
    'tokens.heat.yearly': { 'zh-CN': '今年', 'zh-TW': '今年', en: 'Year' },
    'tokens.heat.cum': { 'zh-CN': '累计总量', 'zh-TW': '累計總量', en: 'Cumulative' },
    'tokens.heat.sumTokens': { 'zh-CN': '区间合计:', 'zh-TW': '區間合計:', en: 'Range total:' },
    'tokens.heat.sumDailyAvg': { 'zh-CN': '折合每天:', 'zh-TW': '折合每天:', en: 'Daily avg:' },
    'tokens.heat.sumActiveAvg': { 'zh-CN': '活跃日均:', 'zh-TW': '活躍日均:', en: 'Active avg:' },
    'tokens.heat.sumCacheRate': { 'zh-CN': '缓存命中:', 'zh-TW': '快取命中:', en: 'Cache hit:' },
    'tokens.heat.tip': { 'zh-CN': '点击或悬浮格子查看当日详细 Token 构成', 'zh-TW': '點擊或懸停格子檢視當日詳細 Token 構成', en: 'Click or hover a cell to view daily token breakdown' },
    'tokens.heat.less': { 'zh-CN': '少', 'zh-TW': '少', en: 'Less' },
    'tokens.heat.more': { 'zh-CN': '多', 'zh-TW': '多', en: 'More' },
    'tokens.colors.title': { 'zh-CN': '🎨 热力图色阶与面板外观自定义（默认跟随主题）', 'zh-TW': '🎨 熱力圖色階與面板外觀自訂（預設跟隨主題）', en: '🎨 Heatmap Palette & Panel Appearance' },
    'cp.title': { 'zh-CN': '🎨 颜色选取器', 'zh-TW': '🎨 顏色選取器', en: '🎨 Color Picker' },
    'cp.eyedropper': { 'zh-CN': '🖊 取色', 'zh-TW': '🖊 取色', en: '🖊 Pick' },
    'cp.moreFormats': { 'zh-CN': '更多格式 (RGB / HSL)', 'zh-TW': '更多格式 (RGB / HSL)', en: 'More formats (RGB / HSL)' },
    'cp.hint': { 'zh-CN': '支持直接输入或粘贴 HEX 色值', 'zh-TW': '支援直接輸入或貼上 HEX 色值', en: 'Type or paste a HEX color value' },
    'cp.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow Theme' },
    'colors.btn.restore': { 'zh-CN': '恢复', 'zh-TW': '恢復', en: 'Reset' },
    'colors.btn.preset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
    'colors.btn.restorePreset': { 'zh-CN': '恢复预设', 'zh-TW': '恢復預設', en: 'Reset Preset' },
    'colors.btn.restoreDefault': { 'zh-CN': '恢复默认', 'zh-TW': '恢復預設', en: 'Default' },
    'theme.light': { 'zh-CN': '浅色', 'zh-TW': '淺色', en: 'Light' },
    'theme.dark': { 'zh-CN': '深色', 'zh-TW': '深色', en: 'Dark' },
    'theme.autoTitle': { 'zh-CN': '当前主题：跟随宿主 ({mode})\n点击切换为：浅色模式', 'zh-TW': '目前主題：跟隨宿主 ({mode})\n點擊切換為：淺色模式', en: 'Theme: Follow IDE ({mode})\nClick to switch to Light' },
    'theme.lightTitle': { 'zh-CN': '当前主题：浅色模式 (固定)\n点击切换为：深色模式', 'zh-TW': '目前主題：淺色模式 (固定)\n點擊切換為：深色模式', en: 'Theme: Light (Fixed)\nClick to switch to Dark' },
    'theme.darkTitle': { 'zh-CN': '当前主题：深色模式 (固定)\n点击切换为：跟随宿主', 'zh-TW': '目前主題：深色模式 (固定)\n點擊切換為：跟隨宿主', en: 'Theme: Dark (Fixed)\nClick to switch to Follow IDE' },

    // 模块状态（客户端语言 / 代理）
    'mod.readFail': { 'zh-CN': '⚠️ 读取失败', 'zh-TW': '⚠️ 讀取失敗', en: '⚠️ Read Failed' },
    'mod.readErr': { 'zh-CN': '⚠️ 读取异常', 'zh-TW': '⚠️ 讀取異常', en: '⚠️ Read Error' },
    'mod.processing': { 'zh-CN': '正在处理…', 'zh-TW': '正在處理…', en: 'Processing…' },
    'mod.zh.failDetect': { 'zh-CN': '检测汉化状态失败: {err}', 'zh-TW': '偵測中文化狀態失敗: {err}', en: 'Failed to detect client language status: {err}' },
    'mod.zh.errDetect': { 'zh-CN': '检测汉化状态异常: {err}', 'zh-TW': '偵測中文化狀態異常: {err}', en: 'Error detecting client language status: {err}' },
    'mod.zh.badgeRestartEn': { 'zh-CN': '⏳ 需重启恢复英文', 'zh-TW': '⏳ 需重啟恢復英文', en: '⏳ Restart for English' },
    'mod.zh.badgeOffReady': { 'zh-CN': '⚪ 已关闭 (官方英文)', 'zh-TW': '⚪ 已關閉 (官方英文)', en: '⚪ English (Active)' },
    'mod.zh.badgeNotInstalled': { 'zh-CN': '⚪ 官方英文 (未注入汉化)', 'zh-TW': '⚪ 官方英文 (未注入中文化)', en: '⚪ English (Default)' },
    'mod.zh.badgeActive': { 'zh-CN': '🟢 已翻译生效', 'zh-TW': '🟢 已翻譯生效', en: '🟢 zh-CN Active' },
    'mod.zh.badgeNotInjected': { 'zh-CN': '⚠️ 磁盘未注入', 'zh-TW': '⚠️ 磁碟未注入', en: '⚠️ Not Injected' },
    'mod.zh.badgePendingRestart': { 'zh-CN': '⏳ 待重启客户端生效', 'zh-TW': '⏳ 待重啟用戶端生效', en: '⏳ Restart Required' },
    'mod.zh.descRestartEn': { 'zh-CN': '已切换为官方英文；当前界面仍保留已加载的中文 DOM 缓存，需完全退出并重新打开 Antigravity 客户端后彻底生效。', 'zh-TW': '已切換為官方英文；目前介面仍保留已載入的中文 DOM 快取，需完全結束並重新開啟 Antigravity 用戶端後徹底生效。', en: 'Switched to English; current UI still retains loaded Chinese DOM cache. Fully quit and reopen Antigravity to apply.' },
    'mod.zh.descOffReady': { 'zh-CN': '客户端当前保持官方原生英文（磁盘已具备简体中文资源与配置门禁，切换为简体中文并重启即可生效）。', 'zh-TW': '用戶端目前保持官方原生英文（磁碟已具備簡體中文資源與設定門禁，切換為簡體中文並重啟即可生效）。', en: 'Client is running native English (zh-CN resources are staged on disk; switch to zh-CN and restart to apply).' },
    'mod.zh.descOffNotInstalled': { 'zh-CN': '客户端汉化处于未安装状态，保持官方原生英文界面。', 'zh-TW': '用戶端中文化處於未安裝狀態，保持官方原生英文介面。', en: 'Client localization is not installed; running native English.' },
    'mod.zh.descActive': { 'zh-CN': '客户端简体中文运行中：DOM 监听器正常工作，左侧边栏与核心菜单已翻译。', 'zh-TW': '用戶端簡體中文執行中：DOM 監聽器正常運作，左側邊欄與核心選單已翻譯。', en: 'Client zh-CN localization is active.' },
    'mod.zh.descNeedInject': { 'zh-CN': '配置已开启简体中文，但当前磁盘 ASAR 未注入汉化资源；请重新运行 bash ./build-hakimi.sh --force 重建 哈基米.app。', 'zh-TW': '設定已開啟簡體中文，但目前磁碟 ASAR 未注入中文化資源；請重新執行 bash ./build-hakimi.sh --force 重建 哈基米.app。', en: 'zh-CN is enabled in config, but ASAR lacks localization injection. Rebuild with: bash ./build-hakimi.sh --force' },
    'mod.zh.descPendingRestart': { 'zh-CN': '简体中文代码已注入且配置已开启；需完全退出并重新打开 Antigravity 客户端加载生效。', 'zh-TW': '簡體中文程式碼已注入且設定已開啟；需完全結束並重新開啟 Antigravity 用戶端載入生效。', en: 'zh-CN localization is injected and enabled; quit and reopen Antigravity to take effect.' },
    'mod.zh.btnDisable': { 'zh-CN': '切换为官方英文 (需重启)', 'zh-TW': '切換為官方英文 (需重啟)', en: 'Switch to English (Restart)' },
    'mod.zh.btnEnable': { 'zh-CN': '切换为简体中文 (需重启)', 'zh-TW': '切換為簡體中文 (需重啟)', en: 'Switch to 简体中文 (Restart)' },
    'mod.zh.toggleFail': { 'zh-CN': '切换客户端语言失败', 'zh-TW': '切換用戶端語言失敗', en: 'Failed to switch client language' },

    // 模型卡片与列表细节
    'models.list.currentTag': { 'zh-CN': '当前', 'zh-TW': '目前', en: 'Current' },
    'models.list.conflictPill': { 'zh-CN': '多档位冲突', 'zh-TW': '多檔位衝突', en: 'Conflict' },
    'models.card.savedConflict': { 'zh-CN': '多档位冲突（请统一）', 'zh-TW': '多檔位衝突（請統一）', en: 'Conflict (pick one)' },
    'models.card.savedCustom': { 'zh-CN': '自定义 {val}', 'zh-TW': '自訂 {val}', en: 'Custom {val}' },
    'models.card.savedShortCustom': { 'zh-CN': '自定义', 'zh-TW': '自訂', en: 'Custom' },
    'models.card.clientFollowing': { 'zh-CN': '跟随模型', 'zh-TW': '跟隨模型', en: 'Follow Model' },
    'models.card.clientDefault': { 'zh-CN': '默认（未修改）', 'zh-TW': '預設（未修改）', en: 'Default (Original)' },
    'models.card.preRestart': { 'zh-CN': '重启前已观测：{val}', 'zh-TW': '重啟前已觀測：{val}', en: 'Before restart: {val}' },
    'models.card.serviceLimit': { 'zh-CN': '服务端报错上限：{val}', 'zh-TW': '伺服器端報錯上限：{val}', en: 'Server error limit: {val}' },
    'models.card.hintDynamic': { 'zh-CN': '已应用跟随模型；正在使用的模型实际预算需由对话请求确认。', 'zh-TW': '已套用跟隨模型；正在使用的模型實際預算需由對話請求確認。', en: 'Follow Model is active; exact per-model budget is confirmed during live chat.' },
    'models.card.hintSavedDiff': { 'zh-CN': '已保存目标（{saved}）与客户端当前配置（{client}）不同；点击下方「保存并应用」写入客户端。', 'zh-TW': '已儲存目標（{saved}）與用戶端目前設定（{client}）不同；點擊下方「儲存並套用」寫入用戶端。', en: 'Saved target ({saved}) differs from client active ({client}); click "Save & Apply" to update.' },
    'models.card.hintRestartWait': { 'zh-CN': '新设置已写入客户端，重启后生效，目前对话仍使用旧设置。', 'zh-TW': '新設定已寫入用戶端，重啟後生效，目前對話仍使用舊設定。', en: 'New setting written to client; restart required before new chats use it.' },
    'models.card.speedLine': { 'zh-CN': '{effort}：中位 {tps} tok/s · {n} 条', 'zh-TW': '{effort}：中位 {tps} tok/s · {n} 筆', en: '{effort}: median {tps} tok/s · {n}' },
    'models.card.defaultEffort': { 'zh-CN': '标准', 'zh-TW': '標準', en: 'Standard' },
    'models.mismatch': { 'zh-CN': '客户端重启后读到的配置（{actual}）与目标不一致，请重新应用。', 'zh-TW': '用戶端重啟後讀到的設定（{actual}）與目標不一致，請重新套用。', en: 'Client loaded ({actual}) after restart, which differs from target. Please reapply.' },
    'models.meta.modeLine': { 'zh-CN': '配置 {cfg} / 实测 {obs}', 'zh-TW': '設定 {cfg} / 實測 {obs}', en: 'Config {cfg} / Observed {obs}' },
    'models.meta.unobserved': { 'zh-CN': '未观测', 'zh-TW': '未觀測', en: 'Unobserved' },
    'models.meta.backupOk': { 'zh-CN': '已备份完整', 'zh-TW': '已備份完整', en: 'Backed up' },
    'models.meta.backupNone': { 'zh-CN': '无（未修改原版）', 'zh-TW': '無（未修改原版）', en: 'None (original)' },
    'models.copyOk': { 'zh-CN': '已复制链接', 'zh-TW': '已複製連結', en: 'Link copied' },
    'models.linkOpened': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者文章', en: 'Opened original author post in default browser' },
    'models.linkCopyFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者文章連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; author post URL copied to clipboard.' },
    'models.copyFail': { 'zh-CN': '无法自动打开，请手动复制：{url}', 'zh-TW': '無法自動開啟，請手動複製：{url}', en: 'Could not open automatically. URL: {url}' },
    'models.validation.dynamicDesc': { 'zh-CN': '跟随模型：所有模型使用同一种方式，每个模型按自己支持的长度分配，实际预算可能不同。', 'zh-TW': '跟隨模型：所有模型使用同一種方式，每個模型依自身支援的長度分配，實際預算可能不同。', en: 'Follow Model: each model uses its own supported limit; active budgets may differ.' },
    'models.validation.defaultDesc': { 'zh-CN': '默认：使用客户端原本的长度。', 'zh-TW': '預設：使用用戶端原本的長度。', en: 'Default: uses the native client limit.' },
    'models.validation.outOfRange': { 'zh-CN': '超出可设置范围（{min} – {max}）', 'zh-TW': '超出可設定範圍（{min} – {max}）', en: 'Out of allowed range ({min} – {max})' },
    'models.validation.tooSmall': { 'zh-CN': '设置值 {val} 偏小，可能很快触发上下文压缩。', 'zh-TW': '設定值 {val} 偏小，可能很快觸發上下文壓縮。', en: 'Value {val} is small and may trigger early compression.' },
    'models.validation.aboveService': { 'zh-CN': '高于最近一次服务端报错上限（{val}）。', 'zh-TW': '高於最近一次伺服器端報錯上限（{val}）。', en: 'Above recent server error limit ({val}).' },
    'models.card.observedWaitRestart': { 'zh-CN': '重启后尚未观测，发一条消息后更新', 'zh-TW': '重啟後尚未觀測，發送一則訊息後更新', en: 'Not observed after restart; send a message to update' },
    'models.card.observedTitle': { 'zh-CN': '实际分配预算：{val} tokens', 'zh-TW': '實際分配預算：{val} tokens', en: 'Allocated budget: {val} tokens' },
    'models.card.preRestartTitle': { 'zh-CN': '重启前预算：{val} tokens', 'zh-TW': '重啟前預算：{val} tokens', en: 'Budget before restart: {val} tokens' },
    'models.card.serviceLimitTitle': { 'zh-CN': '服务端报错上限：{val} tokens', 'zh-TW': '伺服器端報錯上限：{val} tokens', en: 'Server error limit: {val} tokens' },
    'models.card.speedLineText': { 'zh-CN': '{prefix}{tps} tokens/秒 · 近 {count} 次中位数{low}{ts}', 'zh-TW': '{prefix}{tps} tokens/秒 · 近 {count} 次中位數{low}{ts}', en: '{prefix}{tps} tok/s · median of {count}{low}{ts}' },
    'models.card.lowSampleParen': { 'zh-CN': '（样本少）', 'zh-TW': '（樣本少）', en: ' (low n)' },
    'models.card.hintDiffClient': { 'zh-CN': '与客户端当前使用的长度不同。应用后，所有模型都会改用这个长度。', 'zh-TW': '與用戶端目前使用的長度不同。套用後，所有模型都會改用此長度。', en: 'Differs from current client setting. Applying will update all models.' },
    'models.card.hintBelowSet': { 'zh-CN': '实际分配低于设置值，可能受模型或服务端限制。', 'zh-TW': '實際分配低於設定值，可能受模型或伺服器端限制。', en: 'Allocated budget is lower than configured; may be capped by model or server.' },
    'models.conflict.useThis': { 'zh-CN': '用这个', 'zh-TW': '用這個', en: 'Use this' },
    'models.conflict.orCustom': { 'zh-CN': '或重新设定一个统一值', 'zh-TW': '或重新設定一個統一值', en: 'Or set a unified value' },
    'models.conflict.selfSet': { 'zh-CN': '自己设置', 'zh-TW': '自行設定', en: 'Set manually' },
    'models.dropdown.empty': { 'zh-CN': '暂无已知模型', 'zh-TW': '暫無已知模型', en: 'No models yet' },

    // 速度图内部与提示
    'speed.unitSec': { 'zh-CN': '{val} 秒', 'zh-TW': '{val} 秒', en: '{val} s' },
    'speed.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
    'speed.originProbe': { 'zh-CN': '主动测试', 'zh-TW': '主動測試', en: 'Probe' },
    'speed.tip.samples': { 'zh-CN': '样本数：{n}{low}', 'zh-TW': '樣本數：{n}{low}', en: 'Samples: {n}{low}' },
    'speed.tip.timeRange': { 'zh-CN': '时间范围：{range}', 'zh-TW': '時間範圍：{range}', en: 'Range: {range}' },
    'speed.tip.medOut': { 'zh-CN': '输出 tokens 中位数：{val}', 'zh-TW': '輸出 tokens 中位數：{val}', en: 'Median output tokens: {val}' },
    'speed.tip.medIn': { 'zh-CN': '输入 tokens 中位数：{val}', 'zh-TW': '輸入 tokens 中位數：{val}', en: 'Median input tokens: {val}' },
    'speed.tip.time': { 'zh-CN': '时间：{val}', 'zh-TW': '時間：{val}', en: 'Time: {val}' },
    'speed.tip.output': { 'zh-CN': '输出：{val} tokens', 'zh-TW': '輸出：{val} tokens', en: 'Output: {val} tokens' },
    'speed.tip.ttft': { 'zh-CN': '首字延迟：{val}', 'zh-TW': '首字延遲：{val}', en: 'TTFT: {val}' },
    'speed.tip.origin': { 'zh-CN': '来源：{val}', 'zh-TW': '來源：{val}', en: 'Source: {val}' },
    'speed.tip.tpsLine': { 'zh-CN': '#{idx} · {tps} tokens/秒', 'zh-TW': '#{idx} · {tps} tokens/秒', en: '#{idx} · {tps} tok/s' },

      // 悬停气泡与顶部胶囊
      'tip.title.normal': { 'zh-CN': '上下文窗口：', 'zh-TW': '上下文視窗：', en: 'Context window:' },
      'tip.title.stale': { 'zh-CN': '上下文窗口（数据过期）：', 'zh-TW': '上下文視窗（資料過期）：', en: 'Context window (stale):' },
      'tip.title.high90': { 'zh-CN': '上下文窗口（高占用告警）：', 'zh-TW': '上下文視窗（高佔用警示）：', en: 'Context window (high usage):' },
      'tip.title.high75': { 'zh-CN': '上下文窗口（占用偏高）：', 'zh-TW': '上下文視窗（佔用偏高）：', en: 'Context window (elevated):' },
      'tip.title.est': { 'zh-CN': '上下文窗口（本地估算）：', 'zh-TW': '上下文視窗（本機估算）：', en: 'Context window (local est.):' },
      'tip.pct.staleVal': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 统计延迟）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 統計延遲）', en: '{used}% used ({rem}% left · delayed)' },
      'tip.pct.staleUnknown': { 'zh-CN': '统计读取延迟（剩余未知）', 'zh-TW': '統計讀取延遲（剩餘未知）', en: 'Stats delayed (remaining unknown)' },
      'tip.pct.high90': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 接近上限）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 接近上限）', en: '{used}% used ({rem}% left · near limit)' },
      'tip.pct.high75': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 占用偏高）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 佔用偏高）', en: '{used}% used ({rem}% left · elevated)' },
      'tip.pct.normal': { 'zh-CN': '{used}% 已用（剩余 {rem}%）', 'zh-TW': '{used}% 已用（剩餘 {rem}%）', en: '{used}% used ({rem}% left)' },
      'tip.pct.noBudget': { 'zh-CN': '容量未知（未返回上限）', 'zh-TW': '容量未知（未回傳上限）', en: 'Limit unknown (not returned)' },
      'tip.pct.estOnly': { 'zh-CN': '真实占比未知（仅估算）', 'zh-TW': '真實佔比未知（僅估算）', en: 'Actual % unknown (estimate only)' },
      'tip.pct.waitStats': { 'zh-CN': '等待请求统计（仅归档估算）', 'zh-TW': '等待請求統計（僅封存估算）', en: 'Waiting for stats (archive est.)' },
      'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
      'tip.detail.usedOfBudget': { 'zh-CN': '已用 {used} token，共 {budget}{inc}', 'zh-TW': '已用 {used} token，共 {budget}{inc}', en: '{used} / {budget} tokens used{inc}' },
      'tip.detail.usedNoBudget': { 'zh-CN': '已用 {used} token，总容量未知', 'zh-TW': '已用 {used} token，總容量未知', en: '{used} tokens used, limit unknown' },
      'tip.detail.estUsed': { 'zh-CN': '已用 ≈ {used} token{budget}', 'zh-TW': '已用 ≈ {used} token{budget}', en: 'Used ≈ {used} tokens{budget}' },
      'tip.detail.estBudgetPart': { 'zh-CN': '，共 {budget}', 'zh-TW': '，共 {budget}', en: ' of {budget}' },
      'tip.detail.estNoBudgetPart': { 'zh-CN': '，总容量未知', 'zh-TW': '，總容量未知', en: ', limit unknown' },
      'tip.detail.sessionEst': { 'zh-CN': '会话估算 ≈ {low}–{high} token', 'zh-TW': '工作階段估算 ≈ {low}–{high} token', en: 'Session est. ≈ {low}–{high} tokens' },
      'tip.detail.sessionCum': { 'zh-CN': '会话累计 ≈ {low}–{high} token', 'zh-TW': '工作階段累計 ≈ {low}–{high} token', en: 'Session cumulative ≈ {low}–{high} tokens' },
      'tip.detail.waitBg': { 'zh-CN': '正在等待后台更新统计数据', 'zh-TW': '正在等待背景更新統計資料', en: 'Waiting for background stats update' },
      'tip.detail.readingSession': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前工作階段上下文用量…', en: 'Reading current session context usage…' },
      'tip.detail.incSuffix': { 'zh-CN': '（含未知附件）', 'zh-TW': '（含未知附件）', en: ' (incl. unknown files)' },
      'badge.noSession': { 'zh-CN': '未打开会话', 'zh-TW': '未開啟工作階段', en: 'No active chat' },
      'badge.clickOpen': { 'zh-CN': ' · 点击查看详情', 'zh-TW': ' · 點擊檢視詳情', en: ' · Click to view details' },
      'badge.contexts': { 'zh-CN': 'contexts', 'zh-TW': 'contexts', en: 'contexts' },
      'badge.delayed': { 'zh-CN': '统计延迟', 'zh-TW': '統計延遲', en: 'Delayed' },
      'badge.actualUnknown': { 'zh-CN': '真实量未知', 'zh-TW': '真實量未知', en: 'Actual unknown' },
      'badge.tokensTitle': { 'zh-CN': 'Token 用量一览（点击展开详情）', 'zh-TW': 'Token 用量一覽（點擊展開詳情）', en: 'Token Usage Overview (click to open)' },
      'badge.speedCalc': { 'zh-CN': '计算中…', 'zh-TW': '計算中…', en: 'Calculating…' },
      'badge.speedHoverIdle': { 'zh-CN': ' · 待生成', 'zh-TW': ' · 待生成', en: ' · Idle' },
      'badge.speedTitleIdle': { 'zh-CN': '模型输出速度与耗时 (tok/s)', 'zh-TW': '模型輸出速度與耗時 (tok/s)', en: 'Model output speed & latency (tok/s)' },
      'badge.speedTitleWait': { 'zh-CN': '正在等待模型返回或计算生成指标…', 'zh-TW': '正在等待模型回傳或計算生成指標…', en: 'Waiting for model response or metrics…' },
      'badge.speedTitleDetail': { 'zh-CN': '最新模型输出速度：{tps} tok/s{streaming}\n总耗时：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次产出：{output} tokens', 'zh-TW': '最新模型輸出速度：{tps} tok/s{streaming}\n總耗時：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次產出：{output} tokens', en: 'Latest output speed: {tps} tok/s{streaming}\nTotal: {duration}s (TTFT {ttft}s + streaming {streamSec}s)\nOutput: {output} tokens' },
      'badge.speedStreamingPart': { 'zh-CN': ' (流式 {tps} tok/s)', 'zh-TW': ' (流式 {tps} tok/s)', en: ' (streaming {tps} tok/s)' },
      'badge.cacheWide': { 'zh-CN': '缓存 {pct}%', 'zh-TW': '快取 {pct}%', en: 'Cache {pct}%' },
      'badge.cacheCalcWide': { 'zh-CN': '缓存 …', 'zh-TW': '快取 …', en: 'Cache …' },
      'badge.cacheIdleWide': { 'zh-CN': '缓存 --%', 'zh-TW': '快取 --%', en: 'Cache --%' },
      'badge.cacheTitleIdle': { 'zh-CN': '上下文缓存命中率', 'zh-TW': '上下文快取命中率', en: 'Context cache hit rate' },
      'cache.tip.idleTitle': { 'zh-CN': '上下文缓存命中率：待统计', 'zh-TW': '上下文快取命中率：待統計', en: 'Context Cache Hit Rate: Idle' },
      'cache.tip.idleDesc': { 'zh-CN': '打开对话并完成一轮请求后，将实时统计缓存复用比例。', 'zh-TW': '開啟對話並完成一輪請求後，將即時統計快取複用比例。', en: 'Cache reuse ratio will appear after a completed chat turn.' },
      'cache.tip.title': { 'zh-CN': '本轮缓存命中率：{pct}%', 'zh-TW': '本輪快取命中率：{pct}%', en: 'Turn Cache Hit Rate: {pct}%' },
      'cache.tip.titleLow': { 'zh-CN': '⚠ 缓存命中率过低：{pct}%', 'zh-TW': '⚠ 快取命中率過低：{pct}%', en: '⚠ Low Cache Hit Rate: {pct}%' },
      'cache.tip.titleWarn': { 'zh-CN': '⚡ 缓存命中率偏低：{pct}%', 'zh-TW': '⚡ 快取命中率偏低：{pct}%', en: '⚡ Reduced Cache Hit Rate: {pct}%' },
      'cache.tip.breakdown': { 'zh-CN': '本轮复用 {cached} · 未缓存新增 {uncached}（共 {total}）', 'zh-TW': '本輪複用 {cached} · 未快取新增 {uncached}（共 {total}）', en: 'Reused {cached} · Uncached {uncached} (total {total})' },
      'cache.tip.sessionLine': { 'zh-CN': '本会话累计命中 {pct}%（{turns} 轮，共复用 {cached}）', 'zh-TW': '本工作階段累計命中 {pct}%（{turns} 輪，共複用 {cached}）', en: 'Session cumulative: {pct}% ({turns} turns, {cached} reused)' },
      'cache.tip.warnHint': { 'zh-CN': '未命中部分需重新处理，可能消耗更多输入 Token（常见于频繁改动前置上下文或缓存过期）。', 'zh-TW': '未命中部分需重新處理，可能消耗更多輸入 Token（常見於頻繁改動前置上下文或快取過期）。', en: 'Uncached input is reprocessed, consuming more input tokens (often from prefix edits or cache expiry).' },
      'cache.tip.coldHint': { 'zh-CN': '首轮建缓存或短上下文（正常冷启动，后续轮次通常会复用）。', 'zh-TW': '首輪建快取或短上下文（正常冷啟動，後續輪次通常會複用）。', en: 'Initial cold cache or short context (subsequent turns typically reuse it).' },
      'badge.corpus.range': { 'zh-CN': '会话{range}{inc}', 'zh-TW': '工作階段{range}{inc}', en: 'Chat {range}{inc}' },
      'badge.corpus.incPlus': { 'zh-CN': '＋未知', 'zh-TW': '＋未知', en: '+unknown' },
      'badge.corpus.scanning': { 'zh-CN': '会话扫描中…', 'zh-TW': '工作階段掃描中…', en: 'Scanning chat…' },
      'badge.corpus.pending': { 'zh-CN': '会话待扫描', 'zh-TW': '工作階段待掃描', en: 'Chat scan pending' },
      'badge.status.stale': { 'zh-CN': '最近请求统计读取异常或延迟，不能判断剩余空间。', 'zh-TW': '最近請求統計讀取異常或延遲，無法判斷剩餘空間。', en: 'Latest request stats delayed or unavailable; remaining space cannot be determined.' },
      'badge.status.scanErr': { 'zh-CN': '全会话扫描未完成：{err}', 'zh-TW': '全工作階段掃描未完成：{err}', en: 'Session scan incomplete: {err}' },
      'badge.status.incomplete': { 'zh-CN': '存在 {count} 个附件含未知内容；会话总量仍未计全，不能据此保证不会超限。', 'zh-TW': '存在 {count} 個附件含未知內容；工作階段總量仍未計全，無法據此保證不會超限。', en: '{count} attachment(s) contain unreadable content; cumulative total is incomplete.' },
      'badge.status.estimated': { 'zh-CN': '只有客户端估算，附件等内容可能未计全；当前请求真实占用未知。', 'zh-TW': '僅有用戶端估算，附件等內容可能未計全；目前請求真實佔用未知。', en: 'Client estimate only; attachments may be omitted and actual usage is unknown.' },
      'badge.status.normal': { 'zh-CN': '请求用量与会话累计分别统计；会话 token 数始终为本地估算。', 'zh-TW': '請求用量與工作階段累計分別統計；工作階段 token 數始終為本機估算。', en: 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.' },

      // 折叠抽屉开关
      'drawer.colors.expand': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
      'drawer.colors.collapse': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },

      // 会话关键摘要 & 技术明细
      'key.overflowUsed': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Exceeded' },
      'key.overflowRem': { 'zh-CN': '0 (已溢出)', 'zh-TW': '0 (已溢位)', en: '0 (Overflow)' },
      'key.estShort': { 'zh-CN': '约 {val} (估算)', 'zh-TW': '約 {val} (估算)', en: '~{val} (est.)' },
      'key.estPrefix': { 'zh-CN': '约 {val}', 'zh-TW': '約 {val}', en: '~{val}' },
      'key.pending': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
      'key.pill.tight': { 'zh-CN': '紧张', 'zh-TW': '緊張', en: 'Critical' },
      'key.pill.elevated': { 'zh-CN': '偏高', 'zh-TW': '偏高', en: 'High' },
      'key.pill.normal': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
      'key.pill.est': { 'zh-CN': '估算', 'zh-TW': '估算', en: 'Estimate' },
      'key.pill.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Reading' },
      'key.takeaway.90': { 'zh-CN': '⚠ 上下文已消耗 {pct}%，仅剩约 {rem} tokens，接近预算上限！建议清理冗余上下文。', 'zh-TW': '⚠ 上下文已消耗 {pct}%，僅剩約 {rem} tokens，接近預算上限！建議清理多餘上下文。', en: '⚠ Context usage is at {pct}% (~{rem} tokens left), near the limit. Consider trimming context.' },
      'key.takeaway.75': { 'zh-CN': '⚡ 已使用 {pct}%，剩余可用空间约 {rem} tokens，注意大文件或长输出。', 'zh-TW': '⚡ 已使用 {pct}%，剩餘可用空間約 {rem} tokens，注意大型檔案或長輸出。', en: '⚡ {pct}% used (~{rem} tokens left). Watch large files or long outputs.' },
      'key.takeaway.ok': { 'zh-CN': '✔ 当前用量健康（{pct}%），剩余可用空间充足（约 {rem} tokens），可正常继续对话。', 'zh-TW': '✔ 目前用量健康（{pct}%），剩餘可用空間充足（約 {rem} tokens），可正常繼續對話。', en: '✔ Healthy usage ({pct}%), plenty of room (~{rem} tokens left).' },
      'key.takeaway.est': { 'zh-CN': 'ℹ 当前主要依赖本地估算或待服务端返回实际统计，暂不计算精确剩余空间。', 'zh-TW': 'ℹ 目前主要依賴本機估算或待伺服器端回傳實際統計，暫不計算精確剩餘空間。', en: 'ℹ Relying on local estimates or awaiting server stats; exact remaining space unavailable.' },
      'speed.pill.fast': { 'zh-CN': '极速', 'zh-TW': '極速', en: 'Fast' },
      'speed.pill.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'Smooth' },
      'speed.pill.good': { 'zh-CN': '良好', 'zh-TW': '良好', en: 'Good' },
      'speed.pill.slow': { 'zh-CN': '偏慢', 'zh-TW': '偏慢', en: 'Slow' },
      'speed.pill.calc': { 'zh-CN': '计算中', 'zh-TW': '計算中', en: 'Calculating' },
      'speed.pill.idle': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
      'speed.takeaway.ok': { 'zh-CN': '✔ 输出{tone}（{tps} tok/s{stream}），总耗时 {dur}s 内生成 {tok} tokens{model}。', 'zh-TW': '✔ 輸出{tone}（{tps} tok/s{stream}），總耗時 {dur}s 內產生 {tok} tokens{model}。', en: '✔ Output {tone} ({tps} tok/s{stream}), generated {tok} tokens in {dur}s{model}.' },
      'speed.tone.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'smooth' },
      'speed.tone.steady': { 'zh-CN': '平稳', 'zh-TW': '平穩', en: 'steady' },
      'speed.streamPart': { 'zh-CN': '，纯流式传输达 {tps} tok/s', 'zh-TW': '，純串流傳輸達 {tps} tok/s', en: ', streaming {tps} tok/s' },
      'speed.takeaway.idle': { 'zh-CN': 'ℹ 等待当前或下一次模型输出完成，将自动计算精确输出速度 (tok/s)、首字延迟与总耗时。', 'zh-TW': 'ℹ 等待目前或下一次模型輸出完成，將自動計算精確輸出速度 (tok/s)、首字延遲與總耗時。', en: 'ℹ Waiting for the next model response to measure output speed (tok/s), TTFT, and duration.' },
      'cache.pill.high': { 'zh-CN': '高效复用', 'zh-TW': '高效複用', en: 'High Hit' },
      'cache.pill.good': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
      'cache.pill.cold': { 'zh-CN': '冷启动', 'zh-TW': '冷啟動', en: 'Cold Start' },
      'cache.pill.warn': { 'zh-CN': '命中偏低', 'zh-TW': '命中偏低', en: 'Reduced' },
      'cache.pill.low': { 'zh-CN': '命中过低', 'zh-TW': '命中過低', en: 'Low Hit' },
      'cache.pill.idle': { 'zh-CN': '待统计', 'zh-TW': '待統計', en: 'Idle' },
      'cache.takeaway.cold': { 'zh-CN': 'ℹ 当前为首轮冷启动或短输入（总输入 {total} tokens，复用 {cached}），属于正常建缓存阶段。', 'zh-TW': 'ℹ 目前為首輪冷啟動或短輸入（總輸入 {total} tokens，複用 {cached}），屬於正常建快取階段。', en: 'ℹ Initial cold start or short input ({total} total tokens, {cached} cached); normal cache warmup.' },
      'cache.takeaway.low': { 'zh-CN': '⚠ 缓存命中率过低（仅 {pct}%）：本轮多达 {uncached} tokens 未命中缓存，需要重新处理输入，将显著增加 Token 消耗！可能原因：长时间未对话导致缓存过期、切换了模型/系统提示，或前置上下文被修改。', 'zh-TW': '⚠ 快取命中率過低（僅 {pct}%）：本輪多達 {uncached} tokens 未命中快取，需要重新處理輸入，將顯著增加 Token 消耗！可能原因：長時間未對話導致快取過期、切換了模型／系統提示，或前置上下文被修改。', en: '⚠ Very low cache hit rate ({pct}%): {uncached} tokens were uncached and reprocessed this turn, increasing token consumption. Possible causes: cache TTL expiry, model/prefix change, or history rewrite.' },
      'cache.takeaway.warn': { 'zh-CN': '⚡ 缓存命中率偏低（{pct}%）：本轮新增未缓存输入 {uncached} tokens，复用 {cached} tokens；若非刚插入大文件，请留意缓存是否部分失效。', 'zh-TW': '⚡ 快取命中率偏低（{pct}%）：本輪新增未快取輸入 {uncached} tokens，複用 {cached} tokens；若非剛插入大型檔案，請留意快取是否部分失效。', en: '⚡ Reduced cache hit rate ({pct}%): {uncached} uncached vs {cached} cached tokens. Unless adding large files, check if prefix cache partially invalidated.' },
      'cache.takeaway.high': { 'zh-CN': '✔ 缓存高效复用（{pct}%）：本轮 {total} 输入中直接命中 {cached} tokens，仅重算 {uncached} tokens。', 'zh-TW': '✔ 快取高效複用（{pct}%）：本輪 {total} 輸入中直接命中 {cached} tokens，僅重算 {uncached} tokens。', en: '✔ High cache efficiency ({pct}%): {cached} of {total} input tokens reused; only {uncached} uncached.' },
      'cache.takeaway.good': { 'zh-CN': '✔ 缓存正常复用（{pct}%）：复用 {cached} tokens，新增未缓存 {uncached} tokens。', 'zh-TW': '✔ 快取正常複用（{pct}%）：複用 {cached} tokens，新增未快取 {uncached} tokens。', en: '✔ Normal cache reuse ({pct}%): {cached} cached, {uncached} uncached tokens.' },
      'cache.takeaway.idle': { 'zh-CN': 'ℹ 等待请求返回输入明细后，将自动计算上下文缓存命中率与低命中提醒。', 'zh-TW': 'ℹ 等待請求回傳輸入明細後，將自動計算上下文快取命中率與低命中提醒。', en: 'ℹ Waiting for request usage details to calculate cache hit rate and low-hit alerts.' },
      'tech.cacheDetail.val': { 'zh-CN': '命中 {pct}% · 复用 {cached} ／ 新增 {uncached} tokens', 'zh-TW': '命中 {pct}% · 複用 {cached} ／ 新增 {uncached} tokens', en: '{pct}% hit · {cached} cached / {uncached} uncached' },
      'tech.modelPlaceholder': { 'zh-CN': '模型标识：{id}', 'zh-TW': '模型識別：{id}', en: 'Model ID: {id}' },
      'tech.modelMissing': { 'zh-CN': '未返回模型信息', 'zh-TW': '未回傳模型資訊', en: 'No model info returned' },
      'tech.req.exceeded': { 'zh-CN': '输入超限（已失败）', 'zh-TW': '輸入超限（已失敗）', en: 'Input limit exceeded (failed)' },
      'tech.req.network': { 'zh-CN': '网络故障（非超限）', 'zh-TW': '網路故障（非超限）', en: 'Network error (not overflow)' },
      'tech.req.failed': { 'zh-CN': '已失败', 'zh-TW': '已失敗', en: 'Failed' },
      'tech.req.reported': { 'zh-CN': '已返回实际统计', 'zh-TW': '已回傳實際統計', en: 'Actual stats returned' },
      'tech.req.estimated': { 'zh-CN': '只有本地估算', 'zh-TW': '僅有本機估算', en: 'Local estimate only' },
      'tech.req.waiting': { 'zh-CN': '等待统计，未确认执行状态', 'zh-TW': '等待統計，未確認執行狀態', en: 'Awaiting stats; status unconfirmed' },
      'tech.actual.exceeded': { 'zh-CN': '>{val}（实际总数未返回）', 'zh-TW': '>{val}（實際總數未回傳）', en: '>{val} (actual total not returned)' },
      'tech.actual.exceededNoLim': { 'zh-CN': '已超限；实际数值未知', 'zh-TW': '已超限；實際數值未知', en: 'Exceeded; actual count unknown' },
      'tech.actual.unknown': { 'zh-CN': '真实用量未知', 'zh-TW': '真實用量未知', en: 'Actual usage unknown' },
      'tech.est.val': { 'zh-CN': '约 {val} · {note}', 'zh-TW': '約 {val} · {note}', en: '~{val} · {note}' },
      'tech.est.under': { 'zh-CN': '已证实低估', 'zh-TW': '已證實低估', en: 'Confirmed underestimate' },
      'tech.est.ref': { 'zh-CN': '仅供参考', 'zh-TW': '僅供參考', en: 'For reference only' },
      'tech.est.none': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
      'tech.svcLim.val': { 'zh-CN': '{val}（仅该次错误证据）', 'zh-TW': '{val}（僅該次錯誤證據）', en: '{val} (from this error)' },
      'tech.svcLim.none': { 'zh-CN': '本次没有服务端限制证据', 'zh-TW': '本次沒有伺服器端限制證據', en: 'No server limit evidence' },
      'tech.pct.val': { 'zh-CN': '{pct}%（非 1M 总容量）', 'zh-TW': '{pct}%（非 1M 總容量）', en: '{pct}% (not 1M cap)' },
      'tech.pct.none': { 'zh-CN': '不提供安全余量百分比', 'zh-TW': '不提供安全餘量百分比', en: 'Headroom % unavailable' },
      'tech.plusUnknown': { 'zh-CN': ' ＋ 未知内容', 'zh-TW': ' ＋ 未知內容', en: ' + unknown' },
      'tech.plusUnknownShort': { 'zh-CN': ' ＋ 未知', 'zh-TW': ' ＋ 未知', en: ' + unknown' },
      'tech.scanIncomplete': { 'zh-CN': '扫描未完成', 'zh-TW': '掃描未完成', en: 'Scan incomplete' },
      'tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
      'tech.stepsVal': { 'zh-CN': '{steps} 条；{user} 条用户消息／{assistant} 条回复', 'zh-TW': '{steps} 筆；{user} 則使用者訊息／{assistant} 則回覆', en: '{steps} steps; {user} user / {assistant} assistant' },
      'tech.stepsNone': { 'zh-CN': '尚未完成全量读取', 'zh-TW': '尚未完成全量讀取', en: 'Full history not loaded yet' },
      'tech.coverageVal': { 'zh-CN': '{total} 个附件条目（{user} 个上传、{assistant} 个模型/工具输出）；{read} 个已读到文本，{unknown} 个含未计内容。{rescan}{err}', 'zh-TW': '{total} 個附件項目（{user} 個上傳、{assistant} 個模型/工具輸出）；{read} 個已讀到文字，{unknown} 個含未計內容。{rescan}{err}', en: '{total} attachment(s) ({user} uploaded, {assistant} model/tool); {read} readable, {unknown} with unread content.{rescan}{err}' },
      'tech.coverageRescan': { 'zh-CN': ' 正在重新扫描…', 'zh-TW': ' 正在重新掃描…', en: ' Rescanning…' },
      'tech.coverageErr': { 'zh-CN': ' 最近重扫失败，当前为旧结果：{err}', 'zh-TW': ' 最近重掃失敗，目前為舊結果：{err}', en: ' Latest rescan failed (showing prior data): {err}' },
      'tech.coverageScanning': { 'zh-CN': '正在扫描整段归档，不依赖页面已加载的聊天条数。', 'zh-TW': '正在掃描整段封存，不依賴頁面已載入的聊天筆數。', en: 'Scanning full archive regardless of rendered chat items.' },
      'tech.updatedVal': { 'zh-CN': '请求统计 {req} · 全量扫描 {scan}', 'zh-TW': '請求統計 {req} · 全量掃描 {scan}', en: 'Request stats {req} · Full scan {scan}' },
      'tech.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
      'tech.unfinished': { 'zh-CN': '未完成', 'zh-TW': '未完成', en: 'Pending' },
      'files.reading': { 'zh-CN': '正在读取全量会话附件引用…', 'zh-TW': '正在讀取全量工作階段附件引用…', en: 'Reading session attachment references…' },
      'files.empty': { 'zh-CN': '归档中没有上传附件引用。', 'zh-TW': '封存中沒有上傳附件引用。', en: 'No attachment references in archive.' },
      'files.refs': { 'zh-CN': '（引用 {n} 次）', 'zh-TW': '（引用 {n} 次）', en: ' ({n} refs)' },
      'files.px': { 'zh-CN': '{w}×{h} 像素', 'zh-TW': '{w}×{h} 像素', en: '{w}×{h} px' },
      'files.chars': { 'zh-CN': '{n} 字符', 'zh-TW': '{n} 字元', en: '{n} chars' },
      'files.tokUnknown': { 'zh-CN': '内容 token 未知', 'zh-TW': '內容 token 未知', en: 'Token count unknown' },
      'files.assistantPrefix': { 'zh-CN': '模型输出附件 · ', 'zh-TW': '模型輸出附件 · ', en: 'Model/tool attachment · ' },
      'files.sheets': { 'zh-CN': ' · {sheets} 个工作表，{cells} 个单元格', 'zh-TW': ' · {sheets} 個工作表，{cells} 個儲存格', en: ' · {sheets} sheets, {cells} cells' },
      'files.hiddenSheets': { 'zh-CN': '（含 {n} 个隐藏表）', 'zh-TW': '（含 {n} 個隱藏工作表）', en: ' ({n} hidden)' },
      'files.unknownPrefix': { 'zh-CN': '未计全：{parts}', 'zh-TW': '未計全：{parts}', en: 'Partial: {parts}' },

      // 热力图与 Token 用量弹窗
      'heat.today': { 'zh-CN': '（今日）', 'zh-TW': '（今日）', en: ' (Today)' },
      'heat.firstUse': { 'zh-CN': '（首次使用）', 'zh-TW': '（首次使用）', en: ' (First use)' },
      'heat.future': { 'zh-CN': '未来日期（待产生记录）', 'zh-TW': '未來日期（待產生記錄）', en: 'Future date (no records yet)' },
      'heat.prompt': { 'zh-CN': '提示词', 'zh-TW': '提示詞', en: 'Prompt' },
      'heat.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
      'heat.cache': { 'zh-CN': '缓存', 'zh-TW': '快取', en: 'Cache' },
      'heat.weeklyTotal': { 'zh-CN': '周累计 · 折合日均 {avg} Tokens', 'zh-TW': '週累計 · 折合日均 {avg} Tokens', en: 'Weekly Total · Avg {avg} Tokens/d' },
      'heat.cumSuffix': { 'zh-CN': ' (累计)', 'zh-TW': ' (累計)', en: ' (Cumulative)' },
      'heat.cumTotal': { 'zh-CN': '截至当日累计 · 折合日均 {avg} Tokens', 'zh-TW': '截至當日累計 · 折合日均 {avg} Tokens', en: 'Cumulative to Date · Avg {avg} Tokens/d' },
      'heat.activeDays': { 'zh-CN': '{avg} Tokens ({days}天)', 'zh-TW': '{avg} Tokens ({days}天)', en: '{avg} Tokens ({days}d)' },
      'heat.peak': { 'zh-CN': '峰值', 'zh-TW': '峰值', en: 'Peak' },

      // 模型卡片折叠详情、历史分组与按钮状态补齐
      'models.card.detailsToggle': { 'zh-CN': '实测预算、速度与内部详情', 'zh-TW': '實測預算、速度與內部詳情', en: 'Observed budget, speed & details' },
      'models.list.historyGroup': { 'zh-CN': '仅历史记录 / 本地设置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / Local Only' },
      'models.list.historyTag': { 'zh-CN': '仅历史', 'zh-TW': '僅歷史', en: 'History' },
      'models.btn.partialBlocked': { 'zh-CN': '需先还原后端', 'zh-TW': '需先還原後端', en: 'Restore backend first' },
      'models.btn.retryApply': { 'zh-CN': '重新检测并应用', 'zh-TW': '重新偵測並套用', en: 'Retry detect & apply' },
      'models.btn.unsupported': { 'zh-CN': '当前环境不可应用', 'zh-TW': '目前環境無法套用', en: 'Unsupported environment' },
      'header.theme.aria': { 'zh-CN': '切换浅色/深色主题', 'zh-TW': '切換淺色/深色主題', en: 'Toggle light/dark theme' },
      'header.theme.title': { 'zh-CN': '当前：跟随IDE（点击切换：浅色 / 深色 / 自动）', 'zh-TW': '目前：跟隨IDE（點擊切換：淺色 / 深色 / 自動）', en: 'Current: Follow IDE (click to cycle Light / Dark / Auto)' },

      // 订阅与额度详情
      'plan.detail.toggleOpen': { 'zh-CN': '详情 ▼', 'zh-TW': '詳情 ▼', en: 'Details ▼' },
      'plan.detail.toggleClose': { 'zh-CN': '详情收回 ▲', 'zh-TW': '詳情收回 ▲', en: 'Hide ▲' },
      'plan.detail.title': { 'zh-CN': '💎 AI 订阅与额度详情', 'zh-TW': '💎 AI 訂閱與額度詳情', en: '💎 AI Subscription & Credits' },
      'plan.summary.identified': { 'zh-CN': '已自动识别', 'zh-TW': '已自動識別', en: 'Auto-detected' },
      'plan.summary.unknown': { 'zh-CN': '未识别/默认', 'zh-TW': '未識別/預設', en: 'Default / Unknown' },
      'plan.summary.justNow': { 'zh-CN': '刚刚更新', 'zh-TW': '剛剛更新', en: 'Just now' },
      'plan.dt.plan': { 'zh-CN': '当前套餐：', 'zh-TW': '目前方案：', en: 'Plan:' },
      'plan.dt.account': { 'zh-CN': '当前账号：', 'zh-TW': '目前帳號：', en: 'Account:' },
      'plan.dt.promptCredits': { 'zh-CN': 'Prompt 额度池：', 'zh-TW': 'Prompt 額度池：', en: 'Prompt credits:' },
      'plan.dt.flowCredits': { 'zh-CN': 'Flow 额度池：', 'zh-TW': 'Flow 額度池：', en: 'Flow credits:' },
      'plan.dt.updated': { 'zh-CN': '状态更新时间：', 'zh-TW': '狀態更新時間：', en: 'Updated:' },
      'plan.account.unknown': { 'zh-CN': '未识别当前登录邮箱', 'zh-TW': '未識別目前登入信箱', en: 'Signed-in email not detected' },
      'plan.tag.saved': { 'zh-CN': '已保存', 'zh-TW': '已儲存', en: 'Saved' },
      'models.restartConfirm.title': { 'zh-CN': '重启 Antigravity 客户端', 'zh-TW': '重新啟動 Antigravity 用戶端', en: 'Restart Antigravity Client' },
      'plan.credits.avail': { 'zh-CN': '{avail} 可用 / {monthly} 月额度', 'zh-TW': '{avail} 可用 / {monthly} 月額度', en: '{avail} left / {monthly} monthly' },

      // Token 统计与热力图控制
      'tokens.firstUse': { 'zh-CN': '首次使用：{date}', 'zh-TW': '首次使用：{date}', en: 'First use: {date}' },
      'tokens.heat.presetLabel': { 'zh-CN': '5 档色阶预设：', 'zh-TW': '5 檔色階預設：', en: '5-step presets:' },
      'tokens.heat.presetPurple': { 'zh-CN': '紫色系', 'zh-TW': '紫色系', en: 'Purple' },
      'tokens.heat.presetYellow': { 'zh-CN': '黄色系', 'zh-TW': '黃色系', en: 'Yellow' },
      'tokens.heat.presetGreen': { 'zh-CN': '绿色系', 'zh-TW': '綠色系', en: 'Green' },
      'tokens.heat.presetBlue': { 'zh-CN': '蓝色系', 'zh-TW': '藍色系', en: 'Blue' },
      'tokens.heat.presetRed': { 'zh-CN': '红色系', 'zh-TW': '紅色系', en: 'Red' },
      'tokens.heat.customTitle': { 'zh-CN': '5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：', 'zh-TW': '5 檔逐格獨立自訂（點擊任意一格或圖例「少 ▢▢▢▢▢ 多」單獨調色，可設 5 種不同顏色）：', en: 'Customize each of the 5 steps independently:' },
      'tokens.heat.resetLvls': { 'zh-CN': '恢复 5 档预设', 'zh-TW': '恢復 5 檔預設', en: 'Reset 5 steps' },
      'tokens.heat.lvl0': { 'zh-CN': '1档 · 少/无', 'zh-TW': '1檔 · 少/無', en: 'L1 · None/Min' },
      'tokens.heat.lvl1': { 'zh-CN': '2档 · 低', 'zh-TW': '2檔 · 低', en: 'L2 · Low' },
      'tokens.heat.lvl2': { 'zh-CN': '3档 · 中', 'zh-TW': '3檔 · 中', en: 'L3 · Med' },
      'tokens.heat.lvl3': { 'zh-CN': '4档 · 高', 'zh-TW': '4檔 · 高', en: 'L4 · High' },
      'tokens.heat.lvl4': { 'zh-CN': '5档 · 多/峰', 'zh-TW': '5檔 · 多/峰', en: 'L5 · Peak' },
      'tokens.heat.btnPreset': { 'zh-CN': '预设', 'zh-TW': '預設', en: 'Preset' },
      'tokens.heat.lowEnd': { 'zh-CN': '色阶「少」端颜色（自动插值）', 'zh-TW': '色階「少」端顏色（自動插值）', en: 'Low end color (auto-interpolated)' },
      'tokens.heat.highEnd': { 'zh-CN': '色阶「多」端颜色（自动插值）', 'zh-TW': '色階「多」端顏色（自動插值）', en: 'High end color (auto-interpolated)' },
      'tokens.heat.panelBg': { 'zh-CN': '面板与菜单统一背景色', 'zh-TW': '面板與選單統一背景色', en: 'Unified panel background' },
      'tokens.heat.accentColors': { 'zh-CN': '累计与强调指标色', 'zh-TW': '累計與強調指標色', en: 'Total & accent colors' },
      'tokens.colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow theme' },

      // Token 数据与来源标签
      'tokens.firstUseNone': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
      'tokens.srcAllLabel': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All Sources' },
      'tokens.srcDesktopLabel': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },

      // 模型卡片/解锁/异常状态与动态文案补齐
      'models.status.savedPendingDispatch': { 'zh-CN': '已保存，下一次发送时尝试应用', 'zh-TW': '已儲存，下一次發送時嘗試套用', en: 'Saved; will attempt to apply on next message' },
      'models.status.dispatchedPendingConfirm': { 'zh-CN': '已发送设置，等待确认', 'zh-TW': '已發送設定，等待確認', en: 'Setting dispatched; awaiting confirmation' },
      'models.status.confirmed': { 'zh-CN': '实际预算已确认', 'zh-TW': '實際預算已確認', en: 'Observed budget confirmed' },
      'models.status.mismatch': { 'zh-CN': '未生效：目标值与观测值不一致', 'zh-TW': '未生效：目標值與觀測值不一致', en: 'Not active: target differs from observed budget' },
      'panel.ctx.currentModelUnconfirmed': { 'zh-CN': '当前会话模型待确认（请在输入框选择模型或发送消息）', 'zh-TW': '目前工作階段模型待確認（請在輸入框選擇模型或發送訊息）', en: 'Active model pending confirmation (select a model or send a message first)' },
      'models.card.targetTitle': { 'zh-CN': '目标设置', 'zh-TW': '目標設定', en: 'Target Setting' },
      'models.card.actualRequestTitle': { 'zh-CN': '实际请求值', 'zh-TW': '實際請求值', en: 'Actual Request' },
      'models.card.convoIdTitle': { 'zh-CN': '对应会话', 'zh-TW': '對應工作階段', en: 'Conversation' },
      'models.card.diagnosisTitle': { 'zh-CN': '生效诊断', 'zh-TW': '生效診斷', en: 'Diagnosis' },
      'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
      'models.card.modelHistorical': { 'zh-CN': '历史归档', 'zh-TW': '歷史歸檔', en: 'Historical' },
      'models.pref.none': { 'zh-CN': '未单独设置（使用默认）', 'zh-TW': '未單獨設定（使用預設）', en: 'Not set (Default)' },
      'models.pref.noneShort': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
      'models.pref.inconsistent': { 'zh-CN': '档位设置不一致', 'zh-TW': '檔位設定不一致', en: 'Effort mismatch' },
      'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
      'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
      'models.card.effortsList': { 'zh-CN': '可用档位：{list}', 'zh-TW': '可用檔位：{list}', en: 'Efforts: {list}' },
      'models.card.effortStandard': { 'zh-CN': '可用档位：标准', 'zh-TW': '可用檔位：標準', en: 'Efforts: Standard' },
      'models.card.sessionEffort': { 'zh-CN': '当前会话：{effort}', 'zh-TW': '目前會話：{effort}', en: 'Session: {effort}' },
      'models.toast.savedUniform': { 'zh-CN': '已为该模型保存统一设置。', 'zh-TW': '已為該模型儲存統一設定。', en: 'Saved uniform setting for this model.' },
      'models.toast.saveFailed': { 'zh-CN': '保存统一设置失败：{err}', 'zh-TW': '儲存統一設定失敗：{err}', en: 'Failed to save uniform setting: {err}' },
      'models.input.phFollow': { 'zh-CN': '当前为跟随模型（可点 512K 或输入整数）', 'zh-TW': '目前為跟隨模型（可點 512K 或輸入整數）', en: 'Follow model (click 512K or enter integer)' },
      'models.input.phDefault': { 'zh-CN': '当前为默认（可点 512K 或输入整数）', 'zh-TW': '目前為預設（可點 512K 或輸入整數）', en: 'Default (click 512K or enter integer)' },
      'models.input.validFixed': { 'zh-CN': '将设定固定长度：{short}（{full} tokens）', 'zh-TW': '將設定固定長度：{short}（{full} tokens）', en: 'Will set fixed limit: {short} ({full} tokens)' },
      'models.err.noSettingsBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Not connected to host settings bridge' },
      'models.err.noApplyBridge': { 'zh-CN': '未连接到客户端设置桥接', 'zh-TW': '未連線到用戶端設定橋接', en: 'Not connected to client settings bridge' },
      'models.err.noModels': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list.' },
      'models.err.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
      'models.status.line': { 'zh-CN': '当前状态：{badge} · 配置：{mode}', 'zh-TW': '目前狀態：{badge} · 設定：{mode}', en: 'Status: {badge} · Mode: {mode}' },
      'status.client.unavailable': { 'zh-CN': '当前环境无法读取客户端状态', 'zh-TW': '目前環境無法讀取用戶端狀態', en: 'Unable to read client status in this environment' },
      'models.status.restartMismatch': { 'zh-CN': '重启后读到的设置与目标不同（实际：{actual}）', 'zh-TW': '重啟後讀到的設定與目標不同（實際：{actual}）', en: 'Post-restart config differs from target (actual: {actual})' },
      'models.meta.targetDesktop': { 'zh-CN': '桌面端核心服务', 'zh-TW': '桌面端核心服務', en: 'Desktop Core Service' },
      'models.meta.targetDesktopArch': { 'zh-CN': '桌面端核心服务 ({arch})', 'zh-TW': '桌面端核心服務 ({arch})', en: 'Desktop Core Service ({arch})' },
      'models.meta.archUnknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'models.meta.backupStale': { 'zh-CN': '客户端已更新，历史备份已过期', 'zh-TW': '用戶端已更新，歷史備份已過期', en: 'Client updated; legacy backup expired' },
      'models.meta.backupReady': { 'zh-CN': '已自动备份原始文件', 'zh-TW': '已自動備份原始檔案', en: 'Original binary backed up' },
      'models.meta.backupNone': { 'zh-CN': '尚未产生备份（首次修改前自动备份）', 'zh-TW': '尚未產生備份（首次修改前自動備份）', en: 'No backup yet (created before first patch)' },
      'models.credit.openedBrowser': { 'zh-CN': '已在系统默认浏览器中打开原作者帖子', 'zh-TW': '已在系統預設瀏覽器中開啟原作者貼文', en: 'Opened author thread in default browser' },
      'models.credit.openFallback': { 'zh-CN': '无法直接唤起外部浏览器，原作者帖子链接已复制到剪贴板，可直接在浏览器粘贴访问。', 'zh-TW': '無法直接開啟外部瀏覽器，原作者貼文連結已複製到剪貼簿，可直接在瀏覽器貼上存取。', en: 'Could not launch browser; link copied to clipboard.' },
      'models.credit.copiedLink': { 'zh-CN': '已复制原作者帖子链接', 'zh-TW': '已複製原作者貼文連結', en: 'Author thread link copied' },

      // 异常诊断态
      'diag.ctx.badge': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Limit' },
      'diag.ctx.amount': { 'zh-CN': '服务端超限', 'zh-TW': '伺服器端超限', en: 'Server Limit' },
      'diag.ctx.keyBadge': { 'zh-CN': '已超限', 'zh-TW': '已超限', en: 'Exceeded' },
      'diag.ctx.hover': { 'zh-CN': ' · 100% 已溢出', 'zh-TW': ' · 100% 已溢出', en: ' · 100% overflow' },
      'diag.ctx.tipTitle': { 'zh-CN': '上下文窗口（超限告警）：', 'zh-TW': '上下文視窗（超限警示）：', en: 'Context Window (Exceeded):' },
      'diag.ctx.tipPct': { 'zh-CN': '100% 已用（已超出上限）', 'zh-TW': '100% 已用（已超出上限）', en: '100% used (exceeded)' },
      'diag.ctx.tipDetailLim': { 'zh-CN': '已超上限，共 {lim} token', 'zh-TW': '已超上限，共 {lim} token', en: 'Exceeded {lim} tokens' },
      'diag.ctx.tipDetailDef': { 'zh-CN': '服务端已拒绝输入（超出容量上限）', 'zh-TW': '伺服器端已拒絕輸入（超出容量上限）', en: 'Input rejected by server (over limit)' },
      'diag.ctx.status': { 'zh-CN': '服务端已拒绝：输入超限{lim}。本地估算不可靠，需精简或新建会话。', 'zh-TW': '伺服器端已拒絕：輸入超限{lim}。本機估算不可靠，需精簡或新建會話。', en: 'Server rejected: input exceeded{lim}. Trim context or start a new chat.' },
      'diag.ctx.statusLim': { 'zh-CN': '（上限 {lim} tokens）', 'zh-TW': '（上限 {lim} tokens）', en: ' (limit {lim} tokens)' },
      'diag.ctx.takeaway': { 'zh-CN': '✖ 已超出服务端最大限制{lim}，当前对话已被拒绝。需精简或新建会话。', 'zh-TW': '✖ 已超出伺服器端最大限制{lim}，目前對話已被拒絕。需精簡或新建會話。', en: '✖ Exceeded server max limit{lim}; current chat rejected. Trim or start new chat.' },
      'diag.quota.badge': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Quota' },
      'diag.quota.amount': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Out of Quota' },
      'diag.quota.hover': { 'zh-CN': ' · 模型额度用尽，可切换模型', 'zh-TW': ' · 模型額度用盡，可切換模型', en: ' · Model quota exhausted' },
      'diag.quota.tipTitle': { 'zh-CN': '模型额度（额度耗尽）：', 'zh-TW': '模型額度（額度耗盡）：', en: 'Model Quota (Exhausted):' },
      'diag.quota.tipPct': { 'zh-CN': '当前模型配额已用尽', 'zh-TW': '目前模型配額已用盡', en: 'Current model quota exhausted' },
      'diag.quota.reset': { 'zh-CN': '，预计将于 {time} 重置', 'zh-TW': '，預計將於 {time} 重置', en: ', resets around {time}' },
      'diag.quota.tipDetail': { 'zh-CN': '{pool}额度已耗尽{reset}。可手动切换至其他可用模型', 'zh-TW': '{pool}額度已耗盡{reset}。可手動切換至其他可用模型', en: '{pool} quota exhausted{reset}. Switch to another model.' },
      'diag.quota.status': { 'zh-CN': '模型额度耗尽：{pool}额度已耗尽{reset}。可手动切换至其他可用模型。', 'zh-TW': '模型額度耗盡：{pool}額度已耗盡{reset}。可手動切換至其他可用模型。', en: 'Quota exhausted: {pool} quota depleted{reset}. Switch to another model.' },
      'diag.quota.takeaway': { 'zh-CN': '✖ {pool}额度已耗尽{reset}。可手动切换至其他可用模型继续对话。', 'zh-TW': '✖ {pool}額度已耗盡{reset}。可手動切換至其他可用模型繼續對話。', en: '✖ {pool} quota exhausted{reset}. Switch to another model to continue.' },
      'diag.rate.badge': { 'zh-CN': '限流', 'zh-TW': '限流', en: '429' },
      'diag.rate.amount': { 'zh-CN': '请求限流', 'zh-TW': '請求限流', en: 'Rate Limited' },
      'diag.rate.hover': { 'zh-CN': ' · 触发频率限制，请稍候', 'zh-TW': ' · 觸發頻率限制，請稍候', en: ' · Rate limited, wait a moment' },
      'diag.rate.tipTitle': { 'zh-CN': '请求限制（请求过频）：', 'zh-TW': '請求限制（請求過頻）：', en: 'Rate Limit (Too Many Requests):' },
      'diag.rate.tipPct': { 'zh-CN': '触发服务端频率限制（429）', 'zh-TW': '觸發伺服器端頻率限制（429）', en: 'Server rate limit (429)' },
      'diag.rate.retry': { 'zh-CN': '（建议等待 {sec} 秒）', 'zh-TW': '（建議等待 {sec} 秒）', en: ' (retry in {sec}s)' },
      'diag.rate.tipDetail': { 'zh-CN': '请求过于频繁{retry}，请稍候重试', 'zh-TW': '請求過於頻繁{retry}，請稍候重試', en: 'Too many requests{retry}, try again later' },
      'diag.rate.status': { 'zh-CN': '请求频率限制：请求过于频繁，触发服务端限制（429）{retry}。稍候重试即可恢复。', 'zh-TW': '請求頻率限制：請求過於頻繁，觸發伺服器端限制（429）{retry}。稍候重試即可恢復。', en: 'Rate limited (429){retry}. Wait and retry.' },
      'diag.rate.takeaway': { 'zh-CN': '⚠ 触发服务端请求频率限制（HTTP 429）{retry}，短时间内发送请求过多，稍候重试即可恢复。', 'zh-TW': '⚠ 觸發伺服器端請求頻率限制（HTTP 429）{retry}，短時間內發送請求過多，稍候重試即可恢復。', en: '⚠ HTTP 429 rate limit{retry}. Wait briefly and retry.' },
      'diag.net.defDiag': { 'zh-CN': '连接中断或超时', 'zh-TW': '連線中斷或逾時', en: 'Connection dropped or timed out' },
      'diag.net.badge': { 'zh-CN': '网络', 'zh-TW': '網路', en: 'Network' },
      'diag.net.amount': { 'zh-CN': '网络故障', 'zh-TW': '網路故障', en: 'Network Error' },
      'diag.net.hover': { 'zh-CN': ' · 连接异常，请检查网络', 'zh-TW': ' · 連線異常，請檢查網路', en: ' · Connection error, check network' },
      'diag.net.tipTitle': { 'zh-CN': '网络连接（连接故障）：', 'zh-TW': '網路連線（連線故障）：', en: 'Network (Connection Failed):' },
      'diag.net.tipPct': { 'zh-CN': '网络连接失败或超时', 'zh-TW': '網路連線失敗或逾時', en: 'Connection failed or timed out' },
      'diag.net.tipDetail': { 'zh-CN': '连接异常（{diag}）。请检查本地网络代理与连接', 'zh-TW': '連線異常（{diag}）。請檢查本機網路代理與連線', en: 'Connection error ({diag}). Check proxy & network.' },
      'diag.net.status': { 'zh-CN': '网络连接异常：{diag}。请检查本地网络代理与网络链路设置。', 'zh-TW': '網路連線異常：{diag}。請檢查本機網路代理與網路鏈路設定。', en: 'Network error: {diag}. Check local proxy and network settings.' },
      'diag.net.takeaway': { 'zh-CN': '✖ 网络连接出现异常（{diag}）。请检查本地网络代理与链路状态。', 'zh-TW': '✖ 網路連線出現異常（{diag}）。請檢查本機網路代理與鏈路狀態。', en: '✖ Network error ({diag}). Check proxy and connection.' },
      'diag.auth.badge': { 'zh-CN': '认证', 'zh-TW': '認證', en: 'Auth' },
      'diag.auth.amount': { 'zh-CN': '认证失败', 'zh-TW': '認證失敗', en: 'Auth Failed' },
      'diag.auth.keyBadge': { 'zh-CN': '认证异常', 'zh-TW': '認證異常', en: 'Auth Error' },
      'diag.auth.hover': { 'zh-CN': ' · 权限不足或登录异常', 'zh-TW': ' · 權限不足或登入異常', en: ' · Unauthorized or session expired' },
      'diag.auth.tipTitle': { 'zh-CN': '账号权限（身份异常）：', 'zh-TW': '帳號權限（身份異常）：', en: 'Account Auth (Error):' },
      'diag.auth.tipPct': { 'zh-CN': '身份认证失败或缺少权限', 'zh-TW': '身份認證失敗或缺少權限', en: 'Authentication failed or unauthorized' },
      'diag.auth.tipDetail': { 'zh-CN': '身份认证失败或无权限访问，请检查账号登录状态', 'zh-TW': '身份認證失敗或無權限存取，請檢查帳號登入狀態', en: 'Auth failed or no access. Check sign-in status.' },
      'diag.auth.status': { 'zh-CN': '身份认证失败或无访问权限，请检查账号登录状态或订阅权限。', 'zh-TW': '身份認證失敗或無存取權限，請檢查帳號登入狀態或訂閱權限。', en: 'Authentication failed or unauthorized (401/403). Check account sign-in.' },
      'diag.auth.takeaway': { 'zh-CN': '✖ 身份认证失败或无访问权限（401/403）。请检查账号登录状态或订阅权限。', 'zh-TW': '✖ 身份認證失敗或無存取權限（401/403）。請檢查帳號登入狀態或訂閱權限。', en: '✖ Auth failed or forbidden (401/403). Check account sign-in or plan.' },
      'diag.svc.badge': { 'zh-CN': '服务异常', 'zh-TW': '服務異常', en: '503' },
      'diag.svc.amount': { 'zh-CN': '服务受限', 'zh-TW': '服務受限', en: 'Unavailable' },
      'diag.svc.hover': { 'zh-CN': ' · 服务端繁忙，请稍候', 'zh-TW': ' · 伺服器端繁忙，請稍候', en: ' · Server overloaded, wait briefly' },
      'diag.svc.tipTitle': { 'zh-CN': '服务端状态（服务受限）：', 'zh-TW': '伺服器端狀態（服務受限）：', en: 'Service Status (Unavailable):' },
      'diag.svc.tipPct': { 'zh-CN': '模型服务暂不可用或过载', 'zh-TW': '模型服務暫不可用或過載', en: 'Model service overloaded or unavailable' },
      'diag.svc.tipDetail': { 'zh-CN': '服务端暂时过载或维护中，请稍后重试', 'zh-TW': '伺服器端暫時過載或維護中，請稍後重試', en: 'Server overloaded or under maintenance. Retry later.' },
      'diag.svc.status': { 'zh-CN': '模型服务暂不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '模型服務暫不可用或處於高負載（503/Overloaded），請稍後重試。', en: 'Model service unavailable or overloaded (503). Retry later.' },
      'diag.svc.takeaway': { 'zh-CN': '⚠ 服务端暂时不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '⚠ 伺服器端暫時不可用或處於高負載（503/Overloaded），請稍後重試。', en: '⚠ Service unavailable or overloaded (503). Retry later.' },
      'diag.cancel.badge': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Cancelled' },
      'diag.cancel.amount': { 'zh-CN': '请求取消', 'zh-TW': '請求取消', en: 'Cancelled' },
      'diag.cancel.hover': { 'zh-CN': ' · 请求已取消', 'zh-TW': ' · 請求已取消', en: ' · Request cancelled' },
      'diag.cancel.tipTitle': { 'zh-CN': '请求状态（已取消）：', 'zh-TW': '請求狀態（已取消）：', en: 'Request Status (Cancelled):' },
      'diag.cancel.tipPct': { 'zh-CN': '本次请求被中止或取消', 'zh-TW': '本次請求被中止或取消', en: 'Request aborted or cancelled' },
      'diag.cancel.tipDetail': { 'zh-CN': '本次生成已被用户取消或中断，可重新发送消息', 'zh-TW': '本次生成已被使用者取消或中斷，可重新發送訊息', en: 'Generation cancelled. Resend message if needed.' },
      'diag.cancel.status': { 'zh-CN': '请求已取消：当前轮次生成被中断。', 'zh-TW': '請求已取消：目前輪次生成被中斷。', en: 'Request cancelled: current generation aborted.' },
      'diag.cancel.takeaway': { 'zh-CN': 'ℹ 本轮生成已被用户取消或中断，未完整输出。', 'zh-TW': 'ℹ 本輪生成已被使用者取消或中斷，未完整輸出。', en: 'ℹ Generation cancelled before completion.' },
      'diag.quota.defPool': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Current model' },
      'diag.unknown.badge': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Error' },
      'diag.unknown.amount': { 'zh-CN': '请求异常', 'zh-TW': '請求異常', en: 'Request Error' },
      'diag.unknown.keyBadge': { 'zh-CN': '原因待确认', 'zh-TW': '原因待確認', en: 'Unconfirmed' },
      'diag.unknown.hover': { 'zh-CN': ' · 失败原因待确认', 'zh-TW': ' · 失敗原因待確認', en: ' · Reason unconfirmed' },
      'diag.unknown.tipTitle': { 'zh-CN': '请求状态（原因待确认）：', 'zh-TW': '請求狀態（原因待確認）：', en: 'Request Status (Unconfirmed):' },
      'diag.unknown.tipPct': { 'zh-CN': '最近请求失败（原因未知）', 'zh-TW': '最近請求失敗（原因未知）', en: 'Recent request failed (unknown reason)' },
      'diag.unknown.tipDetail': { 'zh-CN': '当前无法确认具体原因（{diag}）', 'zh-TW': '目前無法確認具體原因（{diag}）', en: 'Cannot confirm exact reason ({diag})' },
      'diag.unknown.status': { 'zh-CN': '最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: 'Recent request failed; cannot confirm exact reason ({diag}).' },
      'diag.unknown.takeaway': { 'zh-CN': '✖ 最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '✖ 最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: '✖ Recent request failed; cannot confirm exact reason ({diag}).' },

      // Token 统计、热力图与成本细节补齐
      'tokens.badge.today': { 'zh-CN': ' · 今日 {val}', 'zh-TW': ' · 今日 {val}', en: ' · Today {val}' },
      'common.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
      'common.notProvided': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
      'common.loading': { 'zh-CN': '读取中...', 'zh-TW': '讀取中...', en: 'Loading...' },
      'tokens.heat.firstUsePlaceholder': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
      'tokens.heat.activeAvgPlaceholder': { 'zh-CN': '0 Tokens (0天)', 'zh-TW': '0 Tokens (0天)', en: '0 Tokens (0d)' },
      'tokens.card.todaySub': { 'zh-CN': '{n} 会话实时累加', 'zh-TW': '{n} 會話即時累加', en: '{n} chat(s) live' },
      'tokens.card.monthSub': { 'zh-CN': '日均约 {val}', 'zh-TW': '日均約 {val}', en: '~{val}/day avg' },
      'tokens.card.yearSub': { 'zh-CN': '{n} 天活动记录', 'zh-TW': '{n} 天活動記錄', en: '{n} active day(s)' },
      'tokens.range.month': { 'zh-CN': '{y}年{m}月', 'zh-TW': '{y}年{m}月', en: '{y}-{m}' },
      'tokens.range.year': { 'zh-CN': '{y}年', 'zh-TW': '{y}年', en: '{y}' },
      'tokens.range.yearToToday': { 'zh-CN': '{y}年（1月1日–今天）', 'zh-TW': '{y}年（1月1日–今天）', en: '{y} (Jan 1 – Today)' },
      'heatmap.pop.inProgress': { 'zh-CN': '（进行中）', 'zh-TW': '（進行中）', en: ' (Current)' },
      'heatmap.pop.peak': { 'zh-CN': '（年度峰值）', 'zh-TW': '（年度峰值）', en: ' (Peak)' },
      'heatmap.pop.future': { 'zh-CN': '未来月份（尚未产生用量）', 'zh-TW': '未來月份（尚未產生用量）', en: 'Future month (no usage)' },
      'heatmap.pop.monthlyDet': { 'zh-CN': '月度合计 · 折合日均 {avg} Tokens (活跃 {days} 天)', 'zh-TW': '月度合計 · 折合日均 {avg} Tokens (活躍 {days} 天)', en: 'Monthly Total · Avg {avg} Tokens/d ({days} active days)' },

      // 调色板与 agy CLI 解锁文案
      'colors.resetLevel': { 'zh-CN': '恢复该档预设', 'zh-TW': '恢復該檔預設', en: 'Reset step' },
      'colors.followTheme': { 'zh-CN': '跟随主题', 'zh-TW': '跟隨主題', en: 'Follow theme' },
      'colors.lvl0': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Step 1 (None/Min)' },
      'colors.lvl1': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Step 2 (Low)' },
      'colors.lvl2': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Step 3 (Medium)' },
      'colors.lvl3': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Step 4 (High)' },
      'colors.lvl4': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/峰值用量）', en: 'Step 5 (Peak)' },
      'colors.eyedropperPicked': { 'zh-CN': '已吸取 {hex}', 'zh-TW': '已吸取 {hex}', en: 'Picked {hex}' },
      'colors.eyedropperUnsupported': { 'zh-CN': '当前环境不支持原生吸管，可直接粘贴 HEX', 'zh-TW': '目前環境不支援原生滴管，可直接貼上 HEX', en: 'Eyedropper unsupported; paste HEX directly' },
      'colors.appliedHex': { 'zh-CN': '已应用 {hex}', 'zh-TW': '已套用 {hex}', en: 'Applied {hex}' },
      'colors.copied': { 'zh-CN': '✔ 已复制 {label}: {val}', 'zh-TW': '✔ 已複製 {label}: {val}', en: '✔ Copied {label}: {val}' },
      'settings.cliUnlock.title': { 'zh-CN': '⌨️ agy CLI 上下文联动解锁', 'zh-TW': '⌨️ agy CLI 上下文連動解鎖', en: '⌨️ agy CLI Context Unlock' },
      'settings.cliUnlock.desc': { 'zh-CN': '检测本机 agy 命令行二进制，解除 /model 上下文选择器机型白名单并修复 AGY_CLI_AUTO_COMPACT_OVERRIDE 环境变量读取，同时同步上下文窗口配置。', 'zh-TW': '偵測本機 agy 命令列二進位檔，解除 /model 上下文選擇器機型白名單並修復 AGY_CLI_AUTO_COMPACT_OVERRIDE 環境變數讀取，同時同步上下文視窗設定。', en: 'Detects local agy CLI binary, bypasses /model context selector allowlist, fixes AGY_CLI_AUTO_COMPACT_OVERRIDE env reading, and syncs CLI context config.' },
      'settings.cliUnlock.applyBtn': { 'zh-CN': '一键修补并同步 agy CLI', 'zh-TW': '一鍵修補並同步 agy CLI', en: 'Patch & Sync agy CLI' },
      'settings.cliUnlock.busy': { 'zh-CN': '正在修补并重签名 agy CLI…', 'zh-TW': '正在修補並重簽章 agy CLI…', en: 'Patching & codesigning agy CLI…' },
      'settings.cliUnlock.patched': { 'zh-CN': '🟢 已解锁 ({ok}/{total})', 'zh-TW': '🟢 已解鎖 ({ok}/{total})', en: '🟢 Unlocked ({ok}/{total})' },
      'settings.cliUnlock.unpatched': { 'zh-CN': '⚪ 未修补', 'zh-TW': '⚪ 未修補', en: '⚪ Unpatched' },
      'settings.cliUnlock.partial': { 'zh-CN': '⚠️ 部分匹配', 'zh-TW': '⚠️ 部分符合', en: '⚠️ Partial Match' },
      'settings.cliUnlock.notFound': { 'zh-CN': '⚪ 未安装 agy CLI', 'zh-TW': '⚪ 未安裝 agy CLI', en: '⚪ agy CLI Not Found' },
      'settings.cliUnlock.unsupported': { 'zh-CN': '⚠️ 架构不支持', 'zh-TW': '⚠️ 架構不支援', en: '⚠️ Unsupported Arch' },
      'settings.cliUnlock.brokenLinks': { 'zh-CN': '检测到失效软链接：{paths}', 'zh-TW': '偵測到失效軟連結：{paths}', en: 'Broken symlink(s): {paths}' },
      'settings.cliUnlock.metaPath': { 'zh-CN': '二进制路径：{path}', 'zh-TW': '二進位路徑：{path}', en: 'Binary: {path}' },
      'settings.cliUnlock.metaCfg': { 'zh-CN': '已同步 CLI 配置：{n} 项', 'zh-TW': '已同步 CLI 設定：{n} 項', en: 'Synced CLI configs: {n}' },

      // 速度图表 Aria 与 设置/更新弹窗
      'speed.barSvg.aria': { 'zh-CN': '各模型与档位速度对比柱状图', 'zh-TW': '各模型與檔位速度對比長條圖', en: 'Model & effort speed comparison bar chart' },
      'speed.lineSvg.aria': { 'zh-CN': '所选模型与档位历史输出速度折线图', 'zh-TW': '所選模型與檔位歷史輸出速度折線圖', en: 'Selected model & effort speed trend line chart' },
      'settings.common.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
      'settings.clientLang.detecting': { 'zh-CN': '正在检测桌面端汉化运行状态…', 'zh-TW': '正在偵測桌面端漢化執行狀態…', en: 'Checking desktop localization status…' },
      'settings.clientLang.toggle': { 'zh-CN': '切换汉化状态', 'zh-TW': '切換漢化狀態', en: 'Toggle Localization' },

      // 模型查看提示 & 状态扩展 & 重启交互
      'panel.ctx.viewModelHint': { 'zh-CN': '仅查看模型配置；在此切换不会改变发送模型', 'zh-TW': '僅檢視模型設定；在此切換不會改變發送模型', en: 'Inspect model config only; does not change active chat model' },
      'status.badge.partialMatch': { 'zh-CN': '特征未识别（部分匹配）', 'zh-TW': '特徵未識別（部分匹配）', en: 'Signature mismatch (partial)' },
      'client.restart.hostNotSupported': { 'zh-CN': '当前窗口为热注入或预览模式，不支持一键重启客户端，请手动完全退出后重新打开。', 'zh-TW': '目前視窗為熱注入或預覽模式，不支援一鍵重啟用戶端，請手動完全結束後重新開啟。', en: 'Current mode does not support one-click host restart. Fully quit and reopen 哈基米 manually.' },
      'client.restart.triggering': { 'zh-CN': '正在通知客户端退出并重启…', 'zh-TW': '正在通知用戶端結束並重新啟動…', en: 'Requesting restart…' },
      'client.restart.triggered': { 'zh-CN': '已触发客户端重启；若未自动拉起，请手动重新打开 哈基米.app。', 'zh-TW': '已觸發用戶端重啟；若未自動拉起，請手動重新開啟 哈基米.app。', en: 'Restart requested. Reopen 哈基米.app manually if it does not relaunch automatically.' },
      'client.restart.failed': { 'zh-CN': '无法自动重启：{err}，请手动完全退出后重新打开客户端。', 'zh-TW': '無法自動重啟：{err}，請手動完全結束後重新開啟用戶端。', en: 'Auto-restart failed: {err}. Please quit and reopen manually.' },
      'client.restart.manualNote': { 'zh-CN': '请手动完全退出 哈基米.app（Cmd+Q）并重新打开，然后刷新状态确认是否生效。', 'zh-TW': '請手動完全結束 哈基米.app（Cmd+Q）並重新開啟，然後重新整理狀態確認是否生效。', en: 'Quit 哈基米.app completely (Cmd+Q) and reopen it, then refresh status to verify.' },
      'msg.saveFail': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
      'msg.noHostBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
      'msg.noModelsDetected': { 'zh-CN': '尚未检测到可选模型，请先开启对话或等待列表读取。', 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the model list to load.' },
      'models.btn.recheck': { 'zh-CN': '重新检测', 'zh-TW': '重新偵測', en: 'Re-detect' },
      'models.card.partialFailDetail': { 'zh-CN': '未定位到完整的上下文写入点，为保护二进制完整性已中止写入。{reason}', 'zh-TW': '未定位到完整的上下文寫入點，為保護二進位完整性已中止寫入。{reason}', en: 'Could not locate all required binary gates; aborted safely. {reason}' },

      // 推荐配置与品牌标题设置
      'enhance.preset.title': { 'zh-CN': '✨ 推荐配置（按需主动应用）', 'zh-TW': '✨ 推薦設定（依需求主動套用）', en: '✨ Recommended Setup (Opt-In)' },
      'enhance.preset.desc': { 'zh-CN': '下方列出推荐增强组合；勾选并确认后写入 哈基米.app，且始终保留账号地区免切锁补丁。', 'zh-TW': '下方列出推薦增強組合；勾選並確認後寫入 哈基米.app，且始終保留帳號地區免切鎖修補。', en: 'Select desired features below and confirm before writing to 哈基米.app. Region unlock patch is always preserved.' },
      'enhance.preset.itemLang': { 'zh-CN': '客户端界面简体中文', 'zh-TW': '用戶端介面簡體中文', en: 'Client Simplified Chinese UI' },
      'enhance.preset.itemLangSub': { 'zh-CN': '切换桌面端宿主本身为简体中文（可随时切回官方英文）', 'zh-TW': '切換桌面端宿主本身為簡體中文（可隨時切回官方英文）', en: 'Switches host UI to zh-CN (reversible to English)' },
      'enhance.preset.itemCtx': { 'zh-CN': '上下文跟随模型 (推荐上限释放)', 'zh-TW': '上下文跟隨模型 (推薦上限釋放)', en: 'Follow Model Context Limit' },
      'enhance.preset.itemCtxSub': { 'zh-CN': '解除前端硬编码上限，按当前模型原生能力透传真实预算', 'zh-TW': '解除前端寫死上限，依目前模型原生能力透傳真實預算', en: 'Lifts hardcoded client cap so each model uses its native limit' },
      'enhance.preset.applyBtn': { 'zh-CN': '应用所选推荐配置…', 'zh-TW': '套用所選推薦設定…', en: 'Apply Selected Preset…' },
      'enhance.restoreAll.btn': { 'zh-CN': '恢复功能默认…', 'zh-TW': '恢復功能預設…', en: 'Restore Feature Defaults…' },
      'enhance.confirm.go': { 'zh-CN': '确认执行', 'zh-TW': '確認執行', en: 'Confirm' },
      'enhance.confirm.presetSummary': { 'zh-CN': '即将执行以下已勾选项：{items}；未勾选项目保持不变。变更后可能需要重启语言服务或 哈基米 客户端加载生效。', 'zh-TW': '即將執行以下已勾選項：{items}；未勾選項目維持不變。變更後可能需要重啟語言服務或 哈基米 用戶端載入生效。', en: 'About to apply checked items: {items}; unchecked items stay untouched. A language server or client restart may be required.' },
      'enhance.confirm.restoreSummary': { 'zh-CN': '「恢复功能默认」将还原以下 2 项：切换客户端英文界面与品牌(Antigravity)、还原宿主默认上下文行为；账号地区免切锁补丁会完整保留，已保存的模型偏好不清除。是否继续？', 'zh-TW': '「恢復功能預設」將還原以下 2 項：切換用戶端英文介面與品牌(Antigravity)、還原宿主預設上下文行為；帳號地區免切鎖修補會完整保留，已儲存的模型偏好不清除。是否繼續？', en: '"Restore Feature Defaults" resets these 2 items: English host UI & brand (Antigravity), and native context behavior. Account region unlock and saved model preferences are preserved. Continue?' },
      'enhance.confirm.noneSelected': { 'zh-CN': '请至少勾选一项要应用的配置。', 'zh-TW': '請至少勾選一項要套用的設定。', en: 'Select at least one option first.' },
      'enhance.btn.restartLs': { 'zh-CN': '重启语言服务', 'zh-TW': '重啟語言服務', en: 'Restart Language Server' },
      'enhance.brand.label': { 'zh-CN': '左上角品牌文字显示（仅作用于左上角品牌位，不影响 Logo、菜单或代码）：', 'zh-TW': '左上角品牌文字顯示（僅作用於左上角品牌位，不影響 Logo、選單或程式碼）：', en: 'Header Brand Text (applies only to top-left brand slot; does not alter logo, menus, or code):' },
      'enhance.brand.aria': { 'zh-CN': '品牌显示模式', 'zh-TW': '品牌顯示模式', en: 'Brand display mode' },
      'enhance.brand.hakimi': { 'zh-CN': '哈基米', 'zh-TW': '哈基米', en: '哈基米 (Hakimi)' },
      'enhance.brand.translated': { 'zh-CN': '反重力', 'zh-TW': '反重力', en: '反重力 (Translated)' },
      'enhance.brand.hidden': { 'zh-CN': '隐藏品牌字样', 'zh-TW': '隱藏品牌字樣', en: 'Hide' },
      'enhance.brand.english': { 'zh-CN': 'Antigravity (英文原样)', 'zh-TW': 'Antigravity (英文原樣)', en: 'Keep Antigravity' },
      'enhance.brand.applyBtn': { 'zh-CN': '保存品牌选择并应用', 'zh-TW': '儲存品牌選擇並套用', en: 'Save & Apply Brand' },
      'enhance.brand.switched': { 'zh-CN': '品牌显示已保存为「{mode}」，重启客户端后生效。', 'zh-TW': '品牌顯示已儲存為「{mode}」，重新啟動用戶端後生效。', en: 'Brand display saved as "{mode}". Restart client to take effect.' },
      'enhance.btn.applyPresetBusy': { 'zh-CN': '正在应用推荐配置…', 'zh-TW': '正在套用推薦設定…', en: 'Applying preset…' },
      'enhance.btn.restoreAllBusy': { 'zh-CN': '正在恢复默认…', 'zh-TW': '正在恢復預設…', en: 'Restoring defaults…' },
      'enhance.status.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
      'enhance.status.pendingRestartLs': { 'zh-CN': '待重启语言服务', 'zh-TW': '待重啟語言服務', en: 'LS Restart Needed' },
      'enhance.status.patchedActive': { 'zh-CN': '已写入', 'zh-TW': '已寫入', en: 'Patched' },
      'enhance.status.stock': { 'zh-CN': '官方原版', 'zh-TW': '官方原版', en: 'Stock' },
      'enhance.status.backupYes': { 'zh-CN': '已备份', 'zh-TW': '已備份', en: 'Backed up' },
      'enhance.status.backupNo': { 'zh-CN': '无（未改写）', 'zh-TW': '無（未改寫）', en: 'None (stock)' },
      'enhance.result.presetDone': { 'zh-CN': '✔ 所选推荐配置已写入（{summary}）。请重启语言服务或客户端让全部变更加载生效。', 'zh-TW': '✔ 所選推薦設定已寫入（{summary}）。請重啟語言服務或用戶端讓全部變更載入生效。', en: '✔ Selected preset applied ({summary}). Restart language server or client to load changes.' },
      'enhance.result.restoredDone': { 'zh-CN': '✔ 已恢复为功能默认状态（官方英文界面与默认上下文，已保留地区解锁）。请重启客户端完整生效。', 'zh-TW': '✔ 已恢復為功能預設狀態（官方英文介面與預設上下文，已保留地區解鎖）。請重啟用戶端完整生效。', en: '✔ Restored defaults (English host UI, native context; region unlock preserved). Restart client to take effect.' },
      'enhance.result.partialFail': { 'zh-CN': '⚠ 部分完成，未全部成功。已成功：{done}；失败：{failed}。请处理异常项后重试。', 'zh-TW': '⚠ 部分完成，未全部成功。已成功：{done}；失敗：{failed}。請處理異常項後重試。', en: '⚠ Partial completion. Succeeded: {done}; Failed: {failed}. Please retry failed items.' },
      'enhance.result.lsRestarted': { 'zh-CN': '✔ 已通知语言服务重载（终止 {killed} 个旧进程），哈基米 将自动拉起新版后端。', 'zh-TW': '✔ 已通知語言服務重載（終止 {killed} 個舊行程），哈基米 將自動拉起新版後端。', en: '✔ Language server signaled to reload ({killed} process(es) cycled); 哈基米 will respawn it.' },
      'enhance.result.lsRestartFail': { 'zh-CN': '重启语言服务失败：{err}', 'zh-TW': '重啟語言服務失敗：{err}', en: 'Failed to restart language server: {err}' },
      'enhance.result.noBridge': { 'zh-CN': '当前预览模式未连接到语言服务增强桥接。', 'zh-TW': '目前預覽模式未連線到語言服務增強橋接。', en: 'Enhance bridge unavailable in this mode.' },
      'enhance.result.fail': { 'zh-CN': '操作失败：{err}', 'zh-TW': '操作失敗：{err}', en: 'Action failed: {err}' },

      // 颜色与拾色器
      'colors.swatchTitle': { 'zh-CN': '点击打开调色板', 'zh-TW': '點擊開啟調色盤', en: 'Click to pick color' },
      'colors.lvl0Title': { 'zh-CN': '热力图第1档：少/无用量（点击独立调色）', 'zh-TW': '熱力圖第1檔：少/無用量（點擊獨立調色）', en: 'Heatmap Level 1: None/Low (click to edit)' },
      'colors.lvl1Title': { 'zh-CN': '热力图第2档：低用量（点击独立调色）', 'zh-TW': '熱力圖第2檔：低用量（點擊獨立調色）', en: 'Heatmap Level 2: Light (click to edit)' },
      'colors.lvl2Title': { 'zh-CN': '热力图第3档：中等用量（点击独立调色）', 'zh-TW': '熱力圖第3檔：中等用量（點擊獨立調色）', en: 'Heatmap Level 3: Medium (click to edit)' },
      'colors.lvl3Title': { 'zh-CN': '热力图第4档：高用量（点击独立调色）', 'zh-TW': '熱力圖第4檔：高用量（點擊獨立調色）', en: 'Heatmap Level 4: High (click to edit)' },
      'colors.lvl4Title': { 'zh-CN': '热力图第5档：多/峰值用量（点击独立调色）', 'zh-TW': '熱力圖第5檔：多/峰值用量（點擊獨立調色）', en: 'Heatmap Level 5: Peak (click to edit)' },
      'colors.panelBgSwatch': { 'zh-CN': '面板与菜单背景色', 'zh-TW': '面板與選單背景色', en: 'Panel & Menu Background' },
      'cp.closeAria': { 'zh-CN': '关闭调色器', 'zh-TW': '關閉調色盤', en: 'Close color picker' },
      'cp.eyedropperTitle': { 'zh-CN': '屏幕取色器 (吸管)', 'zh-TW': '螢幕取色器 (吸管)', en: 'Eyedropper' },
      'cp.hexAria': { 'zh-CN': 'HEX 色值', 'zh-TW': 'HEX 色值', en: 'HEX value' },
      'cp.copyHex': { 'zh-CN': '复制 HEX', 'zh-TW': '複製 HEX', en: 'Copy HEX' },
      'cp.rgbAria': { 'zh-CN': 'RGB 色值', 'zh-TW': 'RGB 色值', en: 'RGB value' },
      'cp.copyRgb': { 'zh-CN': '复制 RGB', 'zh-TW': '複製 RGB', en: 'Copy RGB' },
      'cp.hslAria': { 'zh-CN': 'HSL 色值', 'zh-TW': 'HSL 色值', en: 'HSL value' },
      'cp.copyHsl': { 'zh-CN': '复制 HSL', 'zh-TW': '複製 HSL', en: 'Copy HSL' },

      // 热力图与色彩自定义补充
      'tokens.heat.prevTitle': { 'zh-CN': '上一个周期', 'zh-TW': '上一個週期', en: 'Previous period' },
      'tokens.heat.nextTitle': { 'zh-CN': '下一个周期', 'zh-TW': '下一個週期', en: 'Next period' },
      'tokens.heat.tabsAria': { 'zh-CN': '热力图时间维度', 'zh-TW': '熱力圖時間維度', en: 'Heatmap time dimension' },
      'tokens.heat.legendTitle': { 'zh-CN': '点击任意档位色块即可单独自定义该档颜色', 'zh-TW': '點擊任意檔位色塊即可單獨自訂該檔顏色', en: 'Click any legend swatch to customize its color' },
      'tokens.heat.lvl0Aria': { 'zh-CN': '热力图第1档颜色', 'zh-TW': '熱力圖第1檔顏色', en: 'Heatmap level 1 color' },
      'tokens.heat.lvl0Swatch': { 'zh-CN': '色阶第 1 档（少/无用量）', 'zh-TW': '色階第 1 檔（少/無用量）', en: 'Heatmap Level 1 (None/Low)' },
      'tokens.heat.lvl1Aria': { 'zh-CN': '热力图第2档颜色', 'zh-TW': '熱力圖第2檔顏色', en: 'Heatmap level 2 color' },
      'tokens.heat.lvl1Swatch': { 'zh-CN': '色阶第 2 档（低用量）', 'zh-TW': '色階第 2 檔（低用量）', en: 'Heatmap Level 2 (Light)' },
      'tokens.heat.lvl2Aria': { 'zh-CN': '热力图第3档颜色', 'zh-TW': '熱力圖第3檔顏色', en: 'Heatmap level 3 color' },
      'tokens.heat.lvl2Swatch': { 'zh-CN': '色阶第 3 档（中等用量）', 'zh-TW': '色階第 3 檔（中等用量）', en: 'Heatmap Level 3 (Medium)' },
      'tokens.heat.lvl3Aria': { 'zh-CN': '热力图第4档颜色', 'zh-TW': '熱力圖第4檔顏色', en: 'Heatmap level 4 color' },
      'tokens.heat.lvl3Swatch': { 'zh-CN': '色阶第 4 档（高用量）', 'zh-TW': '色階第 4 檔（高用量）', en: 'Heatmap Level 4 (High)' },
      'tokens.heat.lvl4Aria': { 'zh-CN': '热力图第5档颜色', 'zh-TW': '熱力圖第5檔顏色', en: 'Heatmap level 5 color' },
      'tokens.heat.lvl4Swatch': { 'zh-CN': '色阶第 5 档（多/峰值用量）', 'zh-TW': '色階第 5 檔（多/峰值用量）', en: 'Heatmap Level 5 (Peak)' },
      'tokens.heat.lowEndAria': { 'zh-CN': '热力图少端颜色', 'zh-TW': '熱力圖少端顏色', en: 'Heatmap low end color' },
      'tokens.heat.lowEndSwatch': { 'zh-CN': '热力图「少」端颜色', 'zh-TW': '熱力圖「少」端顏色', en: 'Heatmap Low Color' },
      'tokens.heat.highEndAria': { 'zh-CN': '热力图多端颜色', 'zh-TW': '熱力圖多端顏色', en: 'Heatmap high end color' },
      'tokens.heat.highEndSwatch': { 'zh-CN': '热力图「多」端颜色', 'zh-TW': '熱力圖「多」端顏色', en: 'Heatmap High Color' },
      'tokens.heat.totalSwatch': { 'zh-CN': '累计 token 用量', 'zh-TW': '累計 token 用量', en: 'Total Tokens Color' },
      'tokens.heat.accentSwatch': { 'zh-CN': 'Token 強調色', 'zh-TW': 'Token 強調色', en: 'Token Accent Color' },

      // 其余散落文案
      'drawer.shortExpand': { 'zh-CN': '▼ 展开', 'zh-TW': '▼ 展開', en: '▼ Expand' },
      'drawer.shortCollapse': { 'zh-CN': '▲ 收起', 'zh-TW': '▲ 收起', en: '▲ Collapse' },
      'scan.failPrefix': { 'zh-CN': '读取会话失败：{err}', 'zh-TW': '讀取工作階段失敗：{err}', en: 'Failed to read session: {err}' },
      'scan.notLoadedPrefix': { 'zh-CN': '无法读取全量会话：{err}', 'zh-TW': '無法讀取全量工作階段：{err}', en: 'Failed to scan session: {err}' }
  };

  function t(key, vars = null) {
    const entry = PANEL_I18N[key];
    let text = entry
      ? (entry[currentPanelLanguage] ?? entry['zh-CN'] ?? key)
      : key;
    if (vars && typeof vars === 'object') {
      text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
    }
    return text;
  }

  function applyStaticPanelTranslations(rootNode = shadow) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
    for (const node of rootNode.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (key) node.textContent = t(key);
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-html]')) {
      const key = node.getAttribute('data-i18n-html');
      if (key) node.innerHTML = t(key);
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-title]')) {
      const key = node.getAttribute('data-i18n-title');
      if (key) node.setAttribute('title', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-aria]')) {
      const key = node.getAttribute('data-i18n-aria');
      if (key) node.setAttribute('aria-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-aria-label]')) {
      const key = node.getAttribute('data-i18n-aria-label');
      if (key) node.setAttribute('aria-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-color-label]')) {
      const key = node.getAttribute('data-i18n-color-label');
      if (key) node.setAttribute('data-color-label', t(key));
    }
    for (const node of rootNode.querySelectorAll('[data-i18n-placeholder]')) {
      const key = node.getAttribute('data-i18n-placeholder');
      if (key) node.setAttribute('placeholder', t(key));
    }
  }

  const BACKEND_EXACT_TRANSLATIONS = {
    '未知错误': { 'zh-TW': '未知錯誤', en: 'Unknown error' },
    '无效的设置参数': { 'zh-TW': '無效的設定參數', en: 'Invalid settings payload' },
    '宿主暂不支持重启': { 'zh-TW': '宿主暫不支援重新啟動', en: 'Host restart is not supported' },
    '未检测到语言服务二进制文件': { 'zh-TW': '未偵測到語言服務二進位檔案', en: 'Language server binary not found' },
    '未检测到可用的语言服务目标文件': { 'zh-TW': '未偵測到可用的語言服務目標檔案', en: 'No language server binary target found' },
    '原版备份不存在': { 'zh-TW': '原版備份不存在', en: 'Original backup not found' },
    '当前已是原版，无需恢复': { 'zh-TW': '目前已經是原版，無需恢復', en: 'Already using the original binary' },
    '写入失败': { 'zh-TW': '寫入失敗', en: 'Write failed' },
    '未连接到宿主设置桥接': { 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
    '尚未检测到可选模型，请先开启对话或等待列表读取。': { 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list to load.' },
    '未找到可用的上下文写入模式或目标特征不完整': { 'zh-TW': '未找到可用的上下文寫入模式或目標特徵不完整', en: 'Context patch target signature is incomplete' },
    '当前架构暂不支持上下文补丁': { 'zh-TW': '目前架構暫不支援上下文修補', en: 'Context patching is unsupported on this architecture' },
    '后台尚未就绪': { 'zh-TW': '背景服務尚未就緒', en: 'Backend is not ready yet' },
    '读取超时': { 'zh-TW': '讀取逾時', en: 'Request timed out' },
    '完整重启 Antigravity 后启用附件扫描': { 'zh-TW': '完整重新啟動 Antigravity 後啟用附件掃描', en: 'Fully restart Antigravity to enable attachment scanning' },
    '扫描未返回有效结果': { 'zh-TW': '掃描未回傳有效結果', en: 'Scan returned no valid result' }
  };

  function localizeUnknownLabel(val) {
    if (val === null || val === undefined || val === '') return t('speed.unknown');
    const s = String(val).trim();
    if (s === '未知' || s === 'Unknown' || s.includes('未在当前会话中获取')) return t('speed.unknown');
    return s;
  }

  function translateBackendText(text) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    if (currentPanelLanguage === 'zh-CN') return str;
    const hit = BACKEND_EXACT_TRANSLATIONS[str.trim()];
    if (hit && hit[currentPanelLanguage]) return hit[currentPanelLanguage];
    return str;
  }

  function formatVendorLabel(vendor) {
    if (!vendor) return currentPanelLanguage === 'en' ? 'Other' : '其他';
    if (vendor === '其他') return currentPanelLanguage === 'en' ? 'Other' : '其他';
    return vendor;
  }

(function (root) {
  'use strict';

  const DEFAULT_MIN_TOKENS = 16384;
  const DEFAULT_MAX_TOKENS = 2097152;
  const STOCK_DEFAULT_CLAMP_TOKENS = 256000;
  const DEFAULT_CONFIRM_TIMEOUT_MS = 45000;

  // 来自宿主 bundle E.Model 的已知静态枚举值（动态 PLACEHOLDER_M* 由 cascadeModelConfigs 解析）
  const STATIC_MODEL_ENUM_MAP = {
    235: 'chat_20706',
    246: 'google_gemini_2_5_pro',
    269: 'chat_23310',
    281: 'claude_4_sonnet',
    282: 'claude_4_sonnet_thinking',
    290: 'claude_4_opus',
    291: 'claude_4_opus_thinking',
    312: 'google_gemini_2_5_flash',
    313: 'google_gemini_2_5_flash_thinking',
    327: 'google_gemini_for_google_2_5_pro',
    328: 'google_gemini_nemosreef',
    329: 'google_gemini_2_5_flash_thinking_tools',
    330: 'google_gemini_2_5_flash_lite',
    331: 'google_gemini_2_5_pro_eval',
    332: 'google_gemini_2_5_flash_image_preview',
    333: 'claude_4_5_sonnet',
    334: 'claude_4_5_sonnet_thinking',
    335: 'google_gemini_computer_use_experimental',
    336: 'google_gemini_horizondawn',
    337: 'google_gemini_pureprism',
    338: 'google_gemini_gentleisland',
    339: 'google_gemini_rainsong',
    340: 'claude_4_5_haiku',
    341: 'claude_4_5_haiku_thinking',
    342: 'openai_gpt_oss_120b_medium',
    343: 'google_gemini_orionfire',
    346: 'google_jarvis_proxy',
    347: 'google_gemini_cosmicforge',
    348: 'google_gemini_riftrunner',
    349: 'google_jarvis_v4s',
    350: 'google_gemini_infinityjet',
    351: 'google_gemini_infinitybloom',
    352: 'google_gemini_riftrunner_thinking_low',
    353: 'google_gemini_riftrunner_thinking_high',
    354: 'google_gemini_example_gemax_sampler'
  };

  /**
   * 规范化 Protobuf 枚举前缀：将 "MODEL_PLACEHOLDER_M37" 与 "PLACEHOLDER_M37" 对齐
   */
  function stripModelEnumPrefix(raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw).trim();
    if (!s) return '';
    return s.replace(/^MODEL_/i, '');
  }

  /**
   * 从通用数值编号转成 E.Model 枚举名（支持 1000+ 为 PLACEHOLDER_M{n-1000}）
   */
  function modelEnumNumberToName(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (STATIC_MODEL_ENUM_MAP[n]) return STATIC_MODEL_ENUM_MAP[n].toUpperCase();
    if (n >= 1000 && n < 2000) return `PLACEHOLDER_M${n - 1000}`;
    return null;
  }

  /**
   * 判断 URL / RPC 方法是否为允许注入上下文预算的目标 RPC
   * 事实核对：StartCascadeRequest 不含 cascade_config，仅 SendUserCascadeMessage 携带
   */
  function isTargetBudgetRpc(urlOrProcedure) {
    if (!urlOrProcedure) return false;
    const s = String(urlOrProcedure);
    if (s.includes('StartCascade')) return false;
    return s.includes('SendUserCascadeMessage');
  }

  // =========================================================================
  // 1. Protobuf Binary Wire 编解码器（零依赖精准读写 SendUserCascadeMessageRequest）
  //    真实 Schema 核验结果：
  //    - SendUserCascadeMessageRequest: 1 = cascade_id (string), 5 = cascade_config (CascadeConfig)
  //    - CascadeConfig: 1 = planner_config (CascadePlannerConfig), 2 = checkpoint_config (CheckpointConfig)
  //    - CascadePlannerConfig: 1 = plan_model (enum), 15 = requested_model (ModelOrAlias: 1=model, 2=alias),
  //                            27 = custom_model_info_override (ModelInfo), 28 = model_name (string)
  //    - CheckpointConfig: 1 = token_threshold, 2 = is_sync, 5 = max_token_limit (uint32),
  //                        11 = max_output_tokens, 36 = context_window (string)
  // =========================================================================

  function readVarint(bytes, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, nextOffset: pos };
      }
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid protobuf varint overflow');
    }
    throw new Error('Truncated protobuf varint');
  }

  function writeVarint(num) {
    let v = typeof num === 'bigint' ? num : BigInt(num);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
  }

  function concatUint8Arrays(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function encodeVarintField(fieldNumber, value) {
    const tag = writeVarint((fieldNumber << 3) | 0);
    const val = writeVarint(value);
    return concatUint8Arrays([tag, val]);
  }

  function encodeLengthDelimitedField(fieldNumber, payloadBytes) {
    const tag = writeVarint((fieldNumber << 3) | 2);
    const len = writeVarint(payloadBytes.length);
    return concatUint8Arrays([tag, len, payloadBytes]);
  }

  /**
   * 严格解析单层 Protobuf 消息字段，保留每个字段的原始完整切片（tag+value）
   */
  function parseProtoFields(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const start = pos;
      const tagInfo = readVarint(bytes, pos);
      pos = tagInfo.nextOffset;
      const tagNum = Number(tagInfo.value);
      const fieldNumber = tagNum >>> 3;
      const wireType = tagNum & 0x07;
      if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`);

      let valueStart = pos;
      let valueEnd = pos;
      let varintValue = null;
      let sliceValue = null;

      if (wireType === 0) {
        const vInfo = readVarint(bytes, pos);
        varintValue = vInfo.value;
        pos = vInfo.nextOffset;
        valueEnd = pos;
      } else if (wireType === 1) {
        if (pos + 8 > bytes.length) throw new Error('Truncated 64-bit field');
        pos += 8;
        valueEnd = pos;
      } else if (wireType === 2) {
        const lenInfo = readVarint(bytes, pos);
        const len = Number(lenInfo.value);
        pos = lenInfo.nextOffset;
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > bytes.length) {
          throw new Error('Truncated length-delimited field');
        }
        valueStart = pos;
        sliceValue = bytes.subarray(pos, pos + len);
        pos += len;
        valueEnd = pos;
      } else if (wireType === 5) {
        if (pos + 4 > bytes.length) throw new Error('Truncated 32-bit field');
        pos += 4;
        valueEnd = pos;
      } else {
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
      }

      fields.push({
        fieldNumber,
        wireType,
        varintValue,
        bytesValue: sliceValue,
        rawField: bytes.subarray(start, valueEnd)
      });
    }
    return fields;
  }

  function decodeUtf8Strict(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /**
   * 从二进制 SendUserCascadeMessageRequest 提取 cascadeId、模型标识与既有 checkpointConfig
   */
  function extractProtoSendMessageMetadata(bytes) {
    const topFields = parseProtoFields(bytes);
    let cascadeId = null;
    let planModelEnum = null;
    let requestedModelEnum = null;
    let modelName = null;
    let customModelOverrideRaw = null;
    let existingMaxTokenLimit = null;
    let existingContextWindow = null;

    for (const f of topFields) {
      if (f.fieldNumber === 1 && f.wireType === 2 && f.bytesValue) {
        try { cascadeId = decodeUtf8Strict(f.bytesValue); } catch {}
      } else if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        const cfgFields = parseProtoFields(f.bytesValue);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.bytesValue) {
            const plannerFields = parseProtoFields(cf.bytesValue);
            for (const pf of plannerFields) {
              if (pf.fieldNumber === 1 && pf.wireType === 0 && pf.varintValue !== null) {
                planModelEnum = Number(pf.varintValue);
              } else if (pf.fieldNumber === 15 && pf.wireType === 2 && pf.bytesValue) {
                const moaFields = parseProtoFields(pf.bytesValue);
                for (const mf of moaFields) {
                  if (mf.fieldNumber === 1 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  } else if (mf.fieldNumber === 2 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  }
                }
              } else if (pf.fieldNumber === 27 && pf.wireType === 2 && pf.bytesValue) {
                try {
                  const overrideFields = parseProtoFields(pf.bytesValue);
                  for (const ofield of overrideFields) {
                    if (ofield.wireType === 2 && ofield.bytesValue) {
                      const s = decodeUtf8Strict(ofield.bytesValue);
                      if (s && !customModelOverrideRaw) customModelOverrideRaw = s;
                    } else if (ofield.fieldNumber === 15 && ofield.wireType === 0 && ofield.varintValue !== null) {
                      if (planModelEnum === null) planModelEnum = Number(ofield.varintValue);
                    }
                  }
                } catch {}
              } else if (pf.fieldNumber === 28 && pf.wireType === 2 && pf.bytesValue) {
                try { modelName = decodeUtf8Strict(pf.bytesValue); } catch {}
              }
            }
          } else if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            const cpFields = parseProtoFields(cf.bytesValue);
            for (const cpf of cpFields) {
              if (cpf.fieldNumber === 5 && cpf.wireType === 0 && cpf.varintValue !== null) {
                existingMaxTokenLimit = Number(cpf.varintValue);
              } else if (cpf.fieldNumber === 36 && cpf.wireType === 2 && cpf.bytesValue) {
                try { existingContextWindow = decodeUtf8Strict(cpf.bytesValue); } catch {}
              }
            }
          }
        }
      }
    }

    return {
      cascadeId,
      planModelEnum,
      requestedModelEnum,
      modelName,
      customModelOverrideRaw,
      existingMaxTokenLimit,
      existingContextWindow
    };
  }

  /**
   * 无损重写二进制 SendUserCascadeMessageRequest 中的 cascade_config(5).checkpoint_config(2).max_token_limit(5)
   * @param {Uint8Array} bytes
   * @param {{ mode: 'fixed'|'dynamic'|'default', limitTokens?: number|null }} action
   */
  function rewriteProtoSendMessageCheckpointLimit(bytes, action) {
    const topFields = parseProtoFields(bytes);
    const isFixed = action?.mode === 'fixed' && Number.isSafeInteger(action?.limitTokens) && action.limitTokens > 0;

    // 重建 CheckpointConfig bytes：保留所有非 field 5 (max_token_limit) 的字段
    const buildCheckpointBytes = (existingCpBytes) => {
      const kept = [];
      if (existingCpBytes) {
        const cpFields = parseProtoFields(existingCpBytes);
        for (const cpf of cpFields) {
          if (cpf.fieldNumber === 5) continue;
          kept.push(cpf.rawField);
        }
      }
      if (isFixed) {
        kept.push(encodeVarintField(5, action.limitTokens));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    // 重建 CascadeConfig bytes：保留所有非 field 2 (checkpoint_config) 的字段
    const buildCascadeConfigBytes = (existingCfgBytes) => {
      const kept = [];
      let mergedCp = null;
      if (existingCfgBytes) {
        const cfgFields = parseProtoFields(existingCfgBytes);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            mergedCp = mergedCp ? concatUint8Arrays([mergedCp, cf.bytesValue]) : cf.bytesValue;
            continue;
          }
          kept.push(cf.rawField);
        }
      }
      const nextCpBytes = buildCheckpointBytes(mergedCp);
      if (nextCpBytes) {
        kept.push(encodeLengthDelimitedField(2, nextCpBytes));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    const outFields = [];
    let mergedCascadeCfg = null;
    for (const f of topFields) {
      if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        mergedCascadeCfg = mergedCascadeCfg ? concatUint8Arrays([mergedCascadeCfg, f.bytesValue]) : f.bytesValue;
        continue;
      }
      outFields.push(f.rawField);
    }

    if (mergedCascadeCfg || isFixed) {
      const nextCfgBytes = buildCascadeConfigBytes(mergedCascadeCfg);
      if (nextCfgBytes) {
        outFields.push(encodeLengthDelimitedField(5, nextCfgBytes));
      }
    }

    return concatUint8Arrays(outFields);
  }

  // =========================================================================
  // 2. 多传输格式解包与回包（JSON / Lcc WebSocket JSON / 5-byte Envelope / Protobuf Binary）
  // =========================================================================

  function toUint8Array(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    return null;
  }

  function looksLikeJsonText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  /**
   * 统一解包外发请求体或 WebSocket 文本帧
   * @param {any} body
   * @param {{ channel?: string, urlOrProcedure?: string, contentType?: string }} [meta]
   */
  function unpackTransportPayload(body, meta = {}) {
    if (!body) return null;
    const channel = meta.channel || 'http';
    const contentType = String(meta.contentType || '').toLowerCase();
    const urlOrProc = String(meta.urlOrProcedure || '');

    if (typeof body === 'string') {
      if (!looksLikeJsonText(body)) return null;
      let parsed = null;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return null;
      }
      // 宿主 Lcc WebSocket JSON 封装：{ streamId, type: "start", procedure, stream, headers, payload }
      if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        return {
          format: 'ws_lcc_json',
          procedure: parsed.procedure,
          envelope: parsed,
          payload: parsed.payload
        };
      }
      return { format: 'json_string', payload: parsed };
    }

    const raw = toUint8Array(body);
    if (!raw || raw.length === 0) return null;

    // 优先判断是否为 5 字节 Connect / gRPC-Web Envelope：[flags(1B), uint32BE length(4B)] + body
    const expectsProtoContentType = contentType.includes('proto') || contentType.includes('grpc');
    if (raw.length >= 5) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const flags = view.getUint8(0);
      const declaredLen = view.getUint32(1, false);
      if (raw.length === 5 + declaredLen || (raw.length > 5 + declaredLen && (flags === 0 || flags === 1 || flags === 2))) {
        if ((flags & 1) !== 0) {
          return { format: 'compressed_unsupported', flags, uninjectableReason: 'unsupported_compressed_frame' };
        }
        const inner = raw.subarray(5, 5 + declaredLen);
        let decodedText = null;
        try {
          decodedText = new TextDecoder('utf-8', { fatal: true }).decode(inner);
        } catch {}
        if (!expectsProtoContentType && decodedText && looksLikeJsonText(decodedText)) {
          try {
            return { format: 'connect_envelope', flags, payload: JSON.parse(decodedText.trim()) };
          } catch {}
        }
        try {
          const protoMeta = extractProtoSendMessageMetadata(inner);
          return { format: 'connect_proto_envelope', flags, rawInner: inner, trailing: raw.subarray(5 + declaredLen), protoMeta };
        } catch {}
      }
    }

    // 尝试纯 UTF-8 JSON 二进制体
    if (!expectsProtoContentType) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (looksLikeJsonText(text)) {
          const parsed = JSON.parse(text.trim());
          if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload) {
            return {
              format: 'ws_lcc_json_binary',
              procedure: parsed.procedure,
              envelope: parsed,
              payload: parsed.payload
            };
          }
          return { format: 'raw_binary_json', payload: parsed };
        }
      } catch {}
    }

    // 尝试原始二进制 Protobuf（仅当 URL/类型表明是目标 Protobuf RPC，避免对任意二进制误解析）
    if (expectsProtoContentType || isTargetBudgetRpc(urlOrProc)) {
      try {
        const protoMeta = extractProtoSendMessageMetadata(raw);
        return { format: 'raw_binary_proto', rawBytes: raw, protoMeta };
      } catch {
        return { format: 'unparseable_binary', uninjectableReason: 'invalid_protobuf_wire' };
      }
    }

    return null;
  }

  function packTransportPayload(unpacked, nextData) {
    if (!unpacked) return null;
    if (unpacked.format === 'json_string') {
      return JSON.stringify(nextData);
    }
    if (unpacked.format === 'ws_lcc_json') {
      return JSON.stringify({ ...unpacked.envelope, payload: nextData });
    }
    if (unpacked.format === 'ws_lcc_json_binary') {
      return new TextEncoder().encode(JSON.stringify({ ...unpacked.envelope, payload: nextData }));
    }
    if (unpacked.format === 'raw_binary_json') {
      return new TextEncoder().encode(JSON.stringify(nextData));
    }
    if (unpacked.format === 'connect_envelope') {
      const bytes = new TextEncoder().encode(JSON.stringify(nextData));
      const out = new Uint8Array(5 + bytes.length);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, bytes.length, false);
      out.set(bytes, 5);
      return out;
    }
    if (unpacked.format === 'connect_proto_envelope' && nextData instanceof Uint8Array) {
      const tailLen = unpacked.trailing ? unpacked.trailing.length : 0;
      const out = new Uint8Array(5 + nextData.length + tailLen);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, nextData.length, false);
      out.set(nextData, 5);
      if (tailLen > 0) out.set(unpacked.trailing, 5 + nextData.length);
      return out;
    }
    if (unpacked.format === 'raw_binary_proto' && nextData instanceof Uint8Array) {
      return nextData;
    }
    return null;
  }

  // =========================================================================
  // 2.5 模型能力参考、当前客户端运行策略解析、可调范围与统一模式逐模型预测
  // =========================================================================

  /**
   * 严格解析底座解锁/运行策略状态，将“磁盘检测模式”与“当前运行态确认状态”彻底分离
   * 绝不将 null / partial / pending_restart / runtime_unconfirmed 当作已运行的 dynamic 或 256K
   */
  function resolveRuntimeUnlockPolicy(unlockStatus) {
    if (!unlockStatus || typeof unlockStatus !== 'object') {
      return {
        policyKnown: false,
        runtimeState: 'unknown',
        diskMode: 'unknown',
        diskLimitTokens: null,
        runtimeMode: 'unknown',
        runtimeLimitTokens: null,
        currentClientLimitTokens: null,
        isDynamicUnlocked: null,
        diskVsRuntimeMismatch: false,
        status: null
      };
    }

    const status = typeof unlockStatus.status === 'string' ? unlockStatus.status : null;
    const gate3a = unlockStatus.gate3a && typeof unlockStatus.gate3a === 'object' ? unlockStatus.gate3a : null;
    const runtimeEvidence = unlockStatus.runtimeEvidence && typeof unlockStatus.runtimeEvidence === 'object'
      ? unlockStatus.runtimeEvidence
      : null;

    // 1. 解析磁盘/配置态策略（读取真实 fixed 固定值，绝不一律退化为 256,000）
    let diskMode = 'unknown';
    let diskLimitTokens = null;
    const rawConfMode = unlockStatus.configuredMode;
    const rawClampState = gate3a?.clampState || null;

    if (rawConfMode === 'dynamic' || (!rawConfMode && rawClampState === 'DYN')) {
      diskMode = 'dynamic';
    } else if (rawConfMode === 'fixed' || (!rawConfMode && rawClampState === 'CONST')) {
      const rawLim = Number(unlockStatus.configuredLimitTokens ?? gate3a?.limit);
      if (Number.isSafeInteger(rawLim) && rawLim > 0) {
        diskMode = 'fixed';
        diskLimitTokens = rawLim;
      } else {
        diskMode = 'unknown';
      }
    } else if (
      rawConfMode === 'default' ||
      (!rawConfMode && rawClampState === 'ORIG') ||
      (!rawConfMode && status === 'not_patched')
    ) {
      diskMode = 'default';
      diskLimitTokens = STOCK_DEFAULT_CLAMP_TOKENS;
    } else if (rawConfMode === 'partial' || status === 'partial_match') {
      diskMode = 'partial';
    }

    // 2. 判定运行态确认级别（磁盘修改后尚未重启、进程未确认、部分匹配、未知均不可直接冒充已运行生效）
    let runtimeState = 'unknown';
    let policyKnown = false;
    let diskVsRuntimeMismatch = false;

    if (status === 'partial_match' || diskMode === 'partial') {
      runtimeState = 'partial';
    } else if (status === 'failed' || status === 'unsupported' || diskMode === 'unknown') {
      runtimeState = 'unknown';
    } else if (status === 'patched_pending_restart' || runtimeEvidence?.restartDetected === false) {
      runtimeState = 'pending_restart';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_runtime_unconfirmed') {
      runtimeState = 'runtime_unconfirmed';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_loaded' || status === 'not_patched' || !status) {
      // 无否定状态且非待重启时，若传入明确策略（patched_loaded / not_patched / 或直接传入策略对象）则认定策略已知
      runtimeState = 'confirmed';
      policyKnown = true;
    }

    const runtimeMode = policyKnown ? diskMode : 'unknown';
    const runtimeLimitTokens = policyKnown ? diskLimitTokens : null;
    const currentClientLimitTokens = policyKnown && (runtimeMode === 'default' || runtimeMode === 'fixed')
      ? runtimeLimitTokens
      : null;
    const isDynamicUnlocked = policyKnown ? (runtimeMode === 'dynamic') : null;

    return {
      policyKnown,
      runtimeState,
      diskMode,
      diskLimitTokens,
      runtimeMode,
      runtimeLimitTokens,
      currentClientLimitTokens,
      isDynamicUnlocked,
      diskVsRuntimeMismatch,
      status
    };
  }

  /**
   * 从产品及其成员（含 GetAvailableModels / Step.metadata.modelInfo）汇总真实能力元数据，
   * 并严格分离：模型理论能力上限、当前客户端限制、当前策略默认预算、当前环境可采纳范围
   * 仅采信结构化字段（maxTokens / maxOutputTokens）；不做型号名字猜测或硬编码
   */
  function deriveModelCapabilitySummary(product, unlockStatus = null, modelCapabilitiesById = null) {
    const members = Array.isArray(product?.members) ? product.members : [];
    const capById = modelCapabilitiesById && typeof modelCapabilitiesById === 'object' ? modelCapabilitiesById : null;

    const findCapForMember = (m) => {
      if (!capById || !m) return null;
      const candidates = [m.modelId, m.modelOrAlias?.model, m.label]
        .filter(Boolean)
        .map(v => stripModelEnumPrefix(v).toLowerCase());
      for (const k of candidates) {
        if (k && capById[k]) return capById[k];
      }
      return null;
    };

    const tierDetails = [];
    for (const m of members) {
      const extCap = findCapForMember(m);
      const maxTokens = Number.isSafeInteger(Number(m?.maxTokens)) && Number(m.maxTokens) > 0
        ? Number(m.maxTokens)
        : (Number.isSafeInteger(Number(extCap?.maxTokens)) && Number(extCap.maxTokens) > 0 ? Number(extCap.maxTokens) : null);
      const rawOut = m?.maxOutputTokens ?? extCap?.maxOutputTokens;
      const maxOutputTokens = rawOut !== null && rawOut !== undefined && Number.isSafeInteger(Number(rawOut)) && Number(rawOut) >= 0
        ? Number(rawOut)
        : null;
      const thinkingBudget = m?.thinkingBudget ?? extCap?.thinkingBudget ?? null;
      const thinkingLevel = m?.thinkingLevel || extCap?.thinkingLevel || null;
      const capabilitySource = m?.capabilitySource || extCap?.capabilitySource || null;
      if (maxTokens !== null || maxOutputTokens !== null || thinkingLevel || thinkingBudget !== null) {
        tierDetails.push({
          modelId: m.modelId || null,
          effort: m.effort || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget,
          thinkingLevel,
          capabilitySource
        });
      }
    }

    const withWindow = tierDetails.filter(t => t.maxTokens !== null);
    const withOutput = tierDetails.filter(t => t.maxOutputTokens !== null);
    const uniqueWindows = Array.from(new Set(withWindow.map(t => t.maxTokens)));
    const uniqueOutputs = Array.from(new Set(withOutput.map(t => t.maxOutputTokens)));

    const maxTokens = uniqueWindows.length > 0 ? Math.min(...uniqueWindows) : null;
    const maxOutputTokens = uniqueOutputs.length > 0 ? Math.max(...uniqueOutputs) : null;
    const hasTierVariance = uniqueWindows.length > 1 || uniqueOutputs.length > 1;
    const sources = Array.from(new Set(tierDetails.map(t => t.capabilitySource).filter(Boolean)));

    const runtimePolicy = resolveRuntimeUnlockPolicy(unlockStatus);
    const isDynamicUnlocked = runtimePolicy.isDynamicUnlocked;
    const currentClientLimitTokens = runtimePolicy.currentClientLimitTokens;

    // 1. 模型理论能力上限与动态基准（仅依据模型结构化元数据，不受客户端状态左右）
    let modelTheoreticalMaxTokens = null;
    let dynamicDefaultBudget = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      const reserve = Math.max(maxOutputTokens, 40000);
      dynamicDefaultBudget = maxTokens > reserve ? (maxTokens - reserve) : 0;
      modelTheoreticalMaxTokens = Math.min(DEFAULT_MAX_TOKENS, maxTokens - maxOutputTokens);
    }

    // 2. 当前策略默认预算（未携带自定义 maxTokenLimit 时的当前运行态默认结果）：
    //    依据二进制核实：
    //    - utils.GetCheckpointConfig 在 default(ORIG) 下按 min(dynamicDefault, 256000) 钳位；
    //    - 在 fixed(CONST=N) 下直接改写为 N，并经 ClampCheckpointConfigForModelInfo 钳位至 <= maxTokens - maxOutputTokens；
    //    - 在 dynamic(DYN) 下采用 dynamicDefault；
    //    - 在未知 / 部分匹配 / 待重启 / 运行未确认状态下必须保持 null（不可猜测或直接套用 983040 / 256000）
    let currentStrategyDefaultBudget = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        currentStrategyDefaultBudget = dynamicDefaultBudget;
      } else if (runtimePolicy.runtimeMode === 'default') {
        currentStrategyDefaultBudget = dynamicDefaultBudget !== null
          ? Math.min(dynamicDefaultBudget, STOCK_DEFAULT_CLAMP_TOKENS)
          : null;
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.runtimeLimitTokens !== null) {
        const fixedVal = Math.min(DEFAULT_MAX_TOKENS, runtimePolicy.runtimeLimitTokens);
        if (modelTheoreticalMaxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, modelTheoreticalMaxTokens);
        } else if (maxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, maxTokens);
        } else {
          currentStrategyDefaultBudget = fixedVal;
        }
      }
    }
    const effectiveDefaultBudget = currentStrategyDefaultBudget;

    // 3. 当前环境下可确认的安全可调上限（与参考卡、最大可用按钮、预设/校验和统一预测一致）：
    //    虽然局部合并链中请求显式 maxTokenLimit 优先级高于默认基座，但未开启 Dynamic 并经实机确认前，
    //    下游覆盖与服务端策略限制仍可能将实际预算束缚于 currentClientLimitTokens
    let maxAdjustableTokens = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        maxAdjustableTokens = modelTheoreticalMaxTokens;
      } else if ((runtimePolicy.runtimeMode === 'default' || runtimePolicy.runtimeMode === 'fixed') && currentClientLimitTokens !== null) {
        const clientCap = Math.min(DEFAULT_MAX_TOKENS, currentClientLimitTokens);
        maxAdjustableTokens = modelTheoreticalMaxTokens !== null
          ? Math.min(modelTheoreticalMaxTokens, clientCap)
          : clientCap;
      }
    }

    let formulaNote = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      formulaNote = '模型理论输入上限 = maxTokens - maxOutputTokens（动态默认按 max(maxOutputTokens, 40,000) 预留）';
    } else if (maxTokens !== null && maxOutputTokens === null) {
      formulaNote = 'IDE 仅返回总窗口但缺少 maxOutputTokens，无法推导模型理论输入上限';
    }

    let policyNote = null;
    if (runtimePolicy.runtimeState === 'pending_restart') {
      policyNote = '磁盘配置已变更但运行中的客户端尚未重启，当前运行策略与可采纳上限待确认';
    } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
      policyNote = '仅检测到磁盘配置，尚未确认运行中进程已加载该策略';
    } else if (runtimePolicy.runtimeState === 'partial') {
      policyNote = '检测到当前环境处于部分异常状态，运行策略上限未知';
    } else if (runtimePolicy.runtimeState === 'unknown') {
      policyNote = '尚未获取或无法确认当前客户端运行策略，默认预算及目标采纳范围标为未知';
    } else if (runtimePolicy.runtimeMode === 'fixed' && currentClientLimitTokens !== null) {
      policyNote = `当前客户端运行于固定限制 ${currentClientLimitTokens.toLocaleString('en-US')} tokens`;
    } else if (runtimePolicy.runtimeMode === 'default') {
      policyNote = '当前客户端运行于默认 256,000 tokens 限制';
    } else if (runtimePolicy.runtimeMode === 'dynamic') {
      policyNote = '当前客户端已开启 Dynamic 动态跟随，按模型自身上限裁剪';
    }

    const rangeMin = maxAdjustableTokens !== null
      ? Math.min(DEFAULT_MIN_TOKENS, maxAdjustableTokens)
      : DEFAULT_MIN_TOKENS;
    const rangeMax = maxAdjustableTokens;

    return {
      productKey: product?.productKey || null,
      productLabel: product?.productLabel || null,
      maxTokens,
      maxOutputTokens,
      modelTheoreticalMaxTokens,
      dynamicDefaultBudget,
      currentClientLimitTokens,
      currentStrategyDefaultBudget,
      effectiveDefaultBudget,
      maxAdjustableTokens,
      rangeMin,
      rangeMax,
      hasMetadata: maxTokens !== null && maxOutputTokens !== null,
      hasPartialMetadata: (maxTokens !== null) !== (maxOutputTokens !== null),
      hasTierVariance,
      tierDetails,
      sources,
      runtimePolicy,
      isDynamicUnlocked,
      formulaNote,
      policyNote
    };
  }

  /**
   * 评估当前输入/预设在对应模型能力与当前客户端运行策略下的合法性及可采纳值
   * 绝不静默篡改用户数值并报成功，也不混淆模型能力上限与客户端策略上限
   */
  function evaluateLimitInput(rawVal, capSummary = null, unlockStatus = null, serviceLimit = null) {
    const rawStr = typeof rawVal === 'number' ? String(rawVal) : String(rawVal ?? '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    if (num < DEFAULT_MIN_TOKENS || num > DEFAULT_MAX_TOKENS) {
      return {
        ok: false,
        reasonCode: 'out_of_engineering_range',
        limitTokens: num,
        min: DEFAULT_MIN_TOKENS,
        max: DEFAULT_MAX_TOKENS
      };
    }

    const warnings = [];
    const policy = arguments.length >= 3
      ? resolveRuntimeUnlockPolicy(unlockStatus)
      : (capSummary?.runtimePolicy || resolveRuntimeUnlockPolicy(null));
    const modelMaxAllowed = capSummary?.modelTheoreticalMaxTokens ?? null;
    const clientLimit = policy.policyKnown ? policy.currentClientLimitTokens : null;

    let exceedsModelLimit = false;
    const modelCapped = modelMaxAllowed !== null ? Math.min(num, modelMaxAllowed) : num;
    if (modelMaxAllowed !== null && num > modelMaxAllowed) {
      exceedsModelLimit = true;
      warnings.push({
        code: 'exceeds_model_limit',
        limitTokens: num,
        maxAllowed: modelMaxAllowed,
        adoptableTokens: policy.policyKnown && clientLimit !== null
          ? Math.min(modelCapped, clientLimit)
          : (policy.policyKnown ? modelCapped : null)
      });
    }

    let exceedsClientPolicy = false;
    let requiresDynamicUnlock = false;
    if (!policy.policyKnown) {
      warnings.push({
        code: 'unconfirmed_runtime_policy',
        limitTokens: num,
        runtimeState: policy.runtimeState,
        diskMode: policy.diskMode,
        diskLimitTokens: policy.diskLimitTokens
      });
    } else if (clientLimit !== null && num > clientLimit) {
      exceedsClientPolicy = true;
      if (policy.runtimeMode === 'default') {
        requiresDynamicUnlock = true;
        warnings.push({
          code: 'requires_dynamic_unlock',
          limitTokens: num,
          stockCap: clientLimit
        });
      } else if (policy.runtimeMode === 'fixed') {
        warnings.push({
          code: 'exceeds_fixed_client_limit',
          limitTokens: num,
          fixedCap: clientLimit
        });
      }
    }

    let adoptableTokens = null;
    if (policy.policyKnown) {
      if (policy.runtimeMode === 'dynamic') {
        adoptableTokens = modelCapped;
      } else if (clientLimit !== null) {
        adoptableTokens = Math.min(modelCapped, clientLimit);
      }
    }

    const sLimit = Number(serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push({
        code: 'exceeds_service_limit',
        limitTokens: num,
        serviceLimit: sLimit
      });
    }

    if (num < 65536) {
      warnings.push({
        code: 'below_recommended_floor',
        limitTokens: num
      });
    }

    return {
      ok: true,
      limitTokens: num,
      exceedsModelLimit,
      exceedsClientPolicy,
      clientPolicyLimit: clientLimit,
      runtimeState: policy.runtimeState,
      policyKnown: policy.policyKnown,
      adoptableTokens,
      requiresDynamicUnlock,
      warnings
    };
  }

  /**
   * 统一预算模式下，为每个模型预测当前运行策略下的可采纳结果
   * 严格区分“预测值”与“运行已确认”，绝不把未知/待重启/default/fixed 错判为 exact
   */
  function projectUnifiedBudgetForProducts(unifiedPref, products = [], unlockStatus = null, modelCapabilitiesById = null) {
    const mode = unifiedPref?.mode || 'default';
    const rawLimit = mode === 'fixed' && Number.isSafeInteger(Number(unifiedPref?.limitTokens))
      ? Number(unifiedPref.limitTokens)
      : null;
    const policy = resolveRuntimeUnlockPolicy(unlockStatus);
    const unresolvedOutcome = policy.runtimeState === 'pending_restart'
      ? 'pending_restart_unconfirmed'
      : (policy.runtimeState === 'partial'
        ? 'partial_policy_unconfirmed'
        : (policy.runtimeState === 'runtime_unconfirmed' ? 'runtime_unconfirmed' : 'unknown_policy'));

    return (Array.isArray(products) ? products : []).map(prod => {
      const cap = deriveModelCapabilitySummary(prod, unlockStatus, modelCapabilitiesById);
      const modelCap = cap.modelTheoreticalMaxTokens;
      const clientCap = policy.policyKnown ? policy.currentClientLimitTokens : null;

      if (mode === 'default') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'client_default',
          projectedTokens: cap.effectiveDefaultBudget
        };
      }

      if (mode === 'dynamic') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        if (policy.runtimeMode === 'default' || policy.runtimeMode === 'fixed') {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            clientLimitTokens: clientCap,
            projectedTokens: cap.effectiveDefaultBudget
          };
        }
        if (cap.dynamicDefaultBudget === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'dynamic_follow',
          projectedTokens: cap.dynamicDefaultBudget
        };
      }

      if (!rawLimit) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'invalid_target',
          projectedTokens: null
        };
      }

      if (!policy.policyKnown) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: unresolvedOutcome,
          targetTokens: rawLimit,
          exceedsModelLimit: modelCap !== null && rawLimit > modelCap,
          projectedTokens: null
        };
      }

      if (policy.runtimeMode === 'dynamic') {
        if (modelCap === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            targetTokens: rawLimit,
            projectedTokens: null
          };
        }
        if (rawLimit > modelCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_to_model_max',
            targetTokens: rawLimit,
            projectedTokens: modelCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exact',
          targetTokens: rawLimit,
          projectedTokens: rawLimit
        };
      }

      // runtimeMode === 'default' (256,000) 或 'fixed' (N)
      if (modelCap !== null && rawLimit > modelCap) {
        if (clientCap !== null && clientCap < modelCap && rawLimit > clientCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            targetTokens: rawLimit,
            clientLimitTokens: clientCap,
            modelTheoreticalMaxTokens: modelCap,
            projectedTokens: clientCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'clamped_to_model_max',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: modelCap
        };
      }

      if (clientCap !== null && rawLimit > clientCap) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exceeds_client_policy',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          modelTheoreticalMaxTokens: modelCap,
          projectedTokens: modelCap !== null ? Math.min(modelCap, clientCap) : clientCap
        };
      }

      if (modelCap === null) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'unknown_cap',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: null
        };
      }

      return {
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        capability: cap,
        outcome: 'exact',
        targetTokens: rawLimit,
        clientLimitTokens: clientCap,
        projectedTokens: rawLimit
      };
    });
  }

  // =========================================================================
  // 3. 请求模型提取（严禁回退至插件配置面板选中项或全局历史快照）
  // =========================================================================

  function matchConfigByCandidate(candidate, knownConfigs) {
    if (!Array.isArray(knownConfigs) || !knownConfigs.length || candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === 'number') {
      const byValue = knownConfigs.find(c => Number(c?.value) === candidate);
      if (byValue) return byValue;
      const enumName = modelEnumNumberToName(candidate);
      if (enumName) {
        return matchConfigByCandidate(enumName, knownConfigs);
      }
      return null;
    }
    const rawStr = String(candidate).trim();
    if (!rawStr) return null;
    const rawLower = rawStr.toLowerCase();
    const strippedLower = stripModelEnumPrefix(rawStr).toLowerCase();
    return knownConfigs.find(c => {
      const fields = [c?.modelId, c?.model, c?.modelOrAlias?.model, c?.modelOrAlias?.alias, c?.modelAlias, c?.label];
      for (const f of fields) {
        if (f === null || f === undefined) continue;
        const fl = String(f).trim().toLowerCase();
        if (!fl) continue;
        if (fl === rawLower || stripModelEnumPrefix(fl) === strippedLower) return true;
      }
      if (/^\d+$/.test(rawStr) && Number(c?.value) === Number(rawStr)) return true;
      return false;
    }) || null;
  }

  function normalizeResolvedCandidate(rawCandidate, knownConfigs, groupFn, resolveStableFn) {
    if (rawCandidate === null || rawCandidate === undefined) return null;
    const matchedCfg = matchConfigByCandidate(rawCandidate, knownConfigs);
    if (matchedCfg) {
      const mId = matchedCfg.modelId || matchedCfg.model || matchedCfg.modelOrAlias?.model || matchedCfg.label;
      const lbl = matchedCfg.label || matchedCfg.modelDisplayName || mId;
      const g = groupFn({ modelId: mId, label: lbl, modelOrAlias: matchedCfg.modelOrAlias, effort: matchedCfg.effort });
      if (g?.productKey) {
        return {
          productKey: g.productKey,
          productLabel: g.productLabel,
          modelId: (resolveStableFn ? resolveStableFn(matchedCfg, knownConfigs) : null) || String(mId || '').toLowerCase(),
          rawCandidate
        };
      }
    }

    let strVal = null;
    if (typeof rawCandidate === 'number') {
      strVal = modelEnumNumberToName(rawCandidate);
    } else if (typeof rawCandidate === 'string') {
      strVal = rawCandidate.trim();
    }
    if (!strVal) return null;

    // 去除 Protobuf enum 前缀并美化可读名称用于分组兜底
    const stripped = stripModelEnumPrefix(strVal);
    if (/^PLACEHOLDER_M\d+$/i.test(stripped)) {
      // 未能在已知目录中找到具体产品名时，按准确占位 ID 分组而不是跨模型猜测
      const g = groupFn({ modelId: stripped.toLowerCase(), label: stripped.toLowerCase() });
      return {
        productKey: g?.productKey || `product:other:${stripped.toLowerCase()}`,
        productLabel: g?.productLabel || stripped.toLowerCase(),
        modelId: stripped.toLowerCase(),
        rawCandidate
      };
    }

    const readable = stripped.includes('_') && stripped === stripped.toUpperCase()
      ? stripped.toLowerCase().replace(/_/g, '-')
      : stripped;
    const g = groupFn({ modelId: readable, label: readable });
    if (!g?.productKey) return null;
    return {
      productKey: g.productKey,
      productLabel: g.productLabel,
      modelId: (resolveStableFn ? resolveStableFn(readable, knownConfigs) : null) || readable.toLowerCase(),
      rawCandidate
    };
  }

  /**
   * 从出站请求对象 / 二进制元数据提取实际模型产品键
   * @param {object} requestOrProtoMeta
   * @param {{
   *   isProtoMeta?: boolean,
   *   knownConfigs?: Array,
   *   verifiedConversationBindings?: Record<string, { productKey: string, modelId?: string }>,
   *   groupProduct?: Function,
   *   resolveStableModelId?: Function
   * }} [options]
   */
  function resolveRequestModel(requestOrProtoMeta, options = {}) {
    if (!requestOrProtoMeta || typeof requestOrProtoMeta !== 'object') {
      return { resolved: false, reason: 'invalid_payload', cascadeId: null };
    }

    const knownConfigs = Array.isArray(options.knownConfigs) ? options.knownConfigs : [];
    const bindings = options.verifiedConversationBindings || {};
    const groupFn = typeof options.groupProduct === 'function'
      ? options.groupProduct
      : (input) => {
        const s = String(input?.label || input?.modelId || 'unknown').trim();
        const low = s.toLowerCase().replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        return { productKey: `product:other:${low || 'unknown'}`, productLabel: s, vendor: '其他', effort: null };
      };
    const resolveStableFn = typeof options.resolveStableModelId === 'function' ? options.resolveStableModelId : null;

    if (options.isProtoMeta) {
      const cascadeId = requestOrProtoMeta.cascadeId || null;
      const candidates = [
        { source: 'customModelInfoOverride', value: requestOrProtoMeta.customModelOverrideRaw },
        { source: 'modelName', value: requestOrProtoMeta.modelName },
        { source: 'requestedModel', value: requestOrProtoMeta.requestedModelEnum },
        { source: 'planModel', value: requestOrProtoMeta.planModelEnum }
      ];
      for (const c of candidates) {
        if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
        const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
        if (norm) return { resolved: true, source: `proto_${c.source}`, cascadeId, ...norm };
      }
      if (cascadeId && bindings[cascadeId]?.productKey) {
        return {
          resolved: true,
          source: 'verified_conversation_binding',
          cascadeId,
          productKey: bindings[cascadeId].productKey,
          productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
          modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
        };
      }
      return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
    }

    const payload = requestOrProtoMeta;
    const cascadeId = payload.cascadeId || payload.cascade_id || null;
    const cfg = payload.cascadeConfig || payload.cascade_config || {};
    const planner = cfg.plannerConfig || cfg.planner_config || payload.plannerConfig || payload.planner_config || {};

    const override = planner.customModelInfoOverride || planner.custom_model_info_override || {};
    const reqModelObj = planner.requestedModel || planner.requested_model || {};
    const candidates = [
      { source: 'customModelInfoOverride', value: override.model || override.modelId || override.label },
      { source: 'modelName', value: planner.modelName || planner.model_name },
      { source: 'requestedModel', value: reqModelObj.model || reqModelObj.alias || (reqModelObj.choice?.case ? reqModelObj.choice.value : null) },
      { source: 'planModel', value: planner.planModel ?? planner.plan_model }
    ];

    for (const c of candidates) {
      if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
      const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
      if (norm) return { resolved: true, source: c.source, cascadeId, ...norm };
    }

    if (cascadeId && bindings[cascadeId]?.productKey) {
      return {
        resolved: true,
        source: 'verified_conversation_binding',
        cascadeId,
        productKey: bindings[cascadeId].productKey,
        productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
        modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
      };
    }

    return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
  }

  // =========================================================================
  // 4. 预算偏好查询与请求篡改（支持对象/JSON/Protobuf、保护 $typeName 与默认清理）
  // =========================================================================

  function findPreferenceForProduct(productKey, contextPreferencesMap) {
    if (!productKey || !contextPreferencesMap || typeof contextPreferencesMap !== 'object') return null;
    if (contextPreferencesMap[productKey]) return contextPreferencesMap[productKey];
    const pSlug = String(productKey).replace(/^product:[^:]+:/, '').toLowerCase();
    for (const [k, pref] of Object.entries(contextPreferencesMap)) {
      if (!pref) continue;
      const kSlug = String(k).replace(/^product:[^:]+:/, '').toLowerCase();
      if (kSlug && kSlug === pSlug) return pref;
    }
    return null;
  }

  function resolveBudgetPolicy(options = {}) {
    const scopeMode = options.scopeMode === 'per_model' ? 'per_model' : 'unified';
    const pref = scopeMode === 'unified'
      ? (options.unifiedPreference || { mode: 'default', limitTokens: null })
      : findPreferenceForProduct(options.productKey, options.contextPreferencesMap);
    if (!pref) {
      return { mode: 'default', limitTokens: null, hasExplicitPref: false };
    }
    const mode = pref.mode === 'fixed' || pref.mode === 'dynamic' ? pref.mode : 'default';
    if (mode === 'fixed') {
      const limit = Number(pref.limitTokens);
      const minTokens = Number(options.minTokens || DEFAULT_MIN_TOKENS);
      const maxTokens = Number(options.maxTokens || DEFAULT_MAX_TOKENS);
      if (Number.isSafeInteger(limit) && limit >= minTokens && limit <= maxTokens) {
        return { mode: 'fixed', limitTokens: limit, hasExplicitPref: true };
      }
      return { mode: 'invalid_fixed', limitTokens: limit, hasExplicitPref: true };
    }
    return { mode, limitTokens: null, hasExplicitPref: true };
  }

  /**
   * 在 JS 请求对象上注入/清理 CheckpointConfig.maxTokenLimit（支持 Snake/Camel 单套与 @bufbuild/protobuf v2 $typeName）
   */
  function applyBudgetPolicyToObject(payload, policy) {
    if (!payload || typeof payload !== 'object' || !policy) {
      return { modified: false, appliedMode: 'passthrough', sentLimitTokens: null };
    }

    const usesProtoBufTypeName = Boolean(
      payload.$typeName
      || payload.cascadeConfig?.$typeName
      || payload.cascadeConfig?.plannerConfig?.$typeName
      || payload.cascadeConfig?.checkpointConfig?.$typeName
    );
    const isSnake = Boolean(payload.cascade_config && !payload.cascadeConfig);

    if (policy.mode === 'fixed' && Number.isSafeInteger(policy.limitTokens)) {
      if (isSnake) {
        payload.cascade_config = payload.cascade_config || {};
        payload.cascade_config.checkpoint_config = payload.cascade_config.checkpoint_config || {};
        payload.cascade_config.checkpoint_config.max_token_limit = policy.limitTokens;
      } else {
        if (!payload.cascadeConfig) {
          payload.cascadeConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CascadeConfig' } : {};
        }
        if (!payload.cascadeConfig.checkpointConfig) {
          payload.cascadeConfig.checkpointConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CheckpointConfig' } : {};
        } else if (usesProtoBufTypeName && !payload.cascadeConfig.checkpointConfig.$typeName) {
          payload.cascadeConfig.checkpointConfig.$typeName = 'exa.cortex_pb.CheckpointConfig';
        }
        payload.cascadeConfig.checkpointConfig.maxTokenLimit = policy.limitTokens;
      }
      return { modified: true, appliedMode: 'fixed', sentLimitTokens: policy.limitTokens };
    }

    // dynamic 或 default：必须清除任何残留固定阈值，绝不保留上一次遗留的 fixed 值
    let cleared = false;
    if (payload.cascadeConfig?.checkpointConfig && payload.cascadeConfig.checkpointConfig.maxTokenLimit !== undefined) {
      delete payload.cascadeConfig.checkpointConfig.maxTokenLimit;
      cleared = true;
    }
    if (payload.cascade_config?.checkpoint_config && payload.cascade_config.checkpoint_config.max_token_limit !== undefined) {
      delete payload.cascade_config.checkpoint_config.max_token_limit;
      cleared = true;
    }
    return {
      modified: cleared,
      appliedMode: policy.mode === 'dynamic' ? 'dynamic' : 'default',
      sentLimitTokens: null
    };
  }

  /**
   * 一体化拦截变换（支持 client_object / HTTP JSON / WebSocket Lcc / Envelope / Protobuf Binary）
   */
  function transformOutgoingSendRequest(input, context = {}) {
    const channel = context.channel || 'http';
    const urlOrProcedure = context.urlOrProcedure || '';

    // 1. 先检查 RPC 通道目标
    if (channel !== 'ws_frame' && urlOrProcedure && !isTargetBudgetRpc(urlOrProcedure)) {
      return { handled: false, passthrough: true, reason: 'non_target_rpc' };
    }

    // 2. 如果是客户端装饰器直传对象
    if (channel === 'client_object') {
      if (!input || typeof input !== 'object') {
        return { handled: false, passthrough: true, reason: 'invalid_client_request' };
      }
      const resolved = resolveRequestModel(input, context);
      const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
      if (!resolved.resolved && scopeMode !== 'unified') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: resolved.reason || 'unidentifiable_request_model',
          cascadeId: resolved.cascadeId || null,
          productKey: null
        };
      }
      const policy = resolveBudgetPolicy({
        scopeMode,
        unifiedPreference: context.unifiedPreference,
        contextPreferencesMap: context.contextPreferencesMap,
        productKey: resolved.productKey,
        minTokens: context.minTokens,
        maxTokens: context.maxTokens
      });
      if (policy.mode === 'invalid_fixed') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: 'invalid_fixed_limit',
          cascadeId: resolved.cascadeId || null,
          productKey: resolved.productKey || null
        };
      }
      const applied = applyBudgetPolicyToObject(input, policy);
      return {
        handled: true,
        passthrough: policy.mode === 'default' && !applied.modified,
        modified: applied.modified,
        uninjectable: false,
        channel,
        cascadeId: resolved.cascadeId || input.cascadeId || input.cascade_id || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: applied.appliedMode,
        sentLimitTokens: applied.sentLimitTokens,
        output: input
      };
    }

    // 3. 传输层帧/请求体（WebSocket / Fetch / XHR）
    const unpacked = unpackTransportPayload(input, { channel, urlOrProcedure, contentType: context.contentType });
    if (!unpacked) {
      return { handled: false, passthrough: true, reason: 'unrecognized_body' };
    }

    // WebSocket Lcc 帧需在解包后检验 procedure
    if (channel === 'ws_frame') {
      if (!unpacked.procedure || !isTargetBudgetRpc(unpacked.procedure)) {
        return { handled: false, passthrough: true, reason: 'non_target_ws_procedure' };
      }
    }

    if (unpacked.uninjectableReason) {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: unpacked.uninjectableReason,
        channel,
        cascadeId: null,
        productKey: null
      };
    }

    const isProto = unpacked.format === 'connect_proto_envelope' || unpacked.format === 'raw_binary_proto';
    const resolved = isProto
      ? resolveRequestModel(unpacked.protoMeta, { ...context, isProtoMeta: true })
      : resolveRequestModel(unpacked.payload, { ...context, isProtoMeta: false });

    const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
    if (!resolved.resolved && scopeMode !== 'unified') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: resolved.reason || 'unidentifiable_request_model',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: null
      };
    }

    const policy = resolveBudgetPolicy({
      scopeMode,
      unifiedPreference: context.unifiedPreference,
      contextPreferencesMap: context.contextPreferencesMap,
      productKey: resolved.productKey,
      minTokens: context.minTokens,
      maxTokens: context.maxTokens
    });
    if (policy.mode === 'invalid_fixed') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: 'invalid_fixed_limit',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || null
      };
    }

    if (isProto) {
      const srcBytes = unpacked.format === 'connect_proto_envelope' ? unpacked.rawInner : unpacked.rawBytes;
      const hadExisting = unpacked.protoMeta?.existingMaxTokenLimit !== null && unpacked.protoMeta?.existingMaxTokenLimit !== undefined;
      let nextProtoBytes = srcBytes;
      let modified = false;
      if (policy.mode === 'fixed') {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: 'fixed', limitTokens: policy.limitTokens });
        modified = true;
      } else if (hadExisting) {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: policy.mode, limitTokens: null });
        modified = true;
      }
      const packed = modified ? packTransportPayload(unpacked, nextProtoBytes) : input;
      return {
        handled: true,
        passthrough: !modified,
        modified,
        uninjectable: false,
        channel,
        format: unpacked.format,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: policy.mode === 'fixed' ? 'fixed' : (policy.mode === 'dynamic' ? 'dynamic' : 'default'),
        sentLimitTokens: policy.mode === 'fixed' ? policy.limitTokens : null,
        output: packed || input
      };
    }

    const applied = applyBudgetPolicyToObject(unpacked.payload, policy);
    const packed = applied.modified ? packTransportPayload(unpacked, unpacked.payload) : input;
    return {
      handled: true,
      passthrough: !applied.modified,
      modified: Boolean(applied.modified && packed),
      uninjectable: false,
      channel,
      format: unpacked.format,
      cascadeId: resolved.cascadeId || unpacked.payload?.cascadeId || unpacked.payload?.cascade_id || null,
      productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
      productLabel: resolved.productLabel || null,
      modelId: resolved.modelId || null,
      modelSource: resolved.source || null,
      scopeMode,
      targetMode: policy.mode,
      targetLimitTokens: policy.limitTokens,
      sentMode: applied.appliedMode,
      sentLimitTokens: applied.sentLimitTokens,
      output: packed || input
    };
  }

  // =========================================================================
  // 5. 发送追踪、因果观测与严格状态机 (杜绝时间戳造假与假确认)
  // =========================================================================

  function makeScopeKey(convoId, productKey) {
    return `${convoId || '__no_conv__'}::${productKey || '__no_product__'}`;
  }

  function createContextBudgetTracker(options = {}) {
    const confirmTimeoutMs = Number(options.confirmTimeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS);
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    let seqCounter = 0;

    // 按 (convoId, productKey) 隔离保存最近发送记录，防止并发会话/快速切换互相覆盖
    const dispatchesByScope = new Map();
    const dispatchesById = new Map();
    // 仅在无活跃会话上下文时辅助查询按产品的最近发送，不跨会话冒用确认
    const dispatchesByProduct = new Map();
    // 按 (convoId, productKey) 隔离保存真实观测快照
    const observationsByScope = new Map();
    // 已验证的会话->模型绑定（仅来自明确请求的响应或该会话真实 metadata）
    const verifiedConversationBindings = Object.create(null);

    function recordConversationBinding(convoId, binding) {
      if (!convoId || !binding?.productKey) return;
      verifiedConversationBindings[convoId] = {
        productKey: binding.productKey,
        productLabel: binding.productLabel || binding.productKey,
        modelId: binding.modelId || binding.productKey,
        updatedAt: nowFn()
      };
    }

    function getBaselineForScope(convoId, productKey) {
      const obs = observationsByScope.get(makeScopeKey(convoId, productKey));
      if (!obs) return { callId: null, stepCount: -1, obsTs: 0 };
      return {
        callId: obs.callId || null,
        stepCount: Number.isFinite(obs.stepCount) ? obs.stepCount : -1,
        obsTs: Number(obs.ts || 0)
      };
    }

    function beginDispatch(info = {}) {
      const seq = ++seqCounter;
      const timestamp = Number(info.timestamp || nowFn());
      const convoId = info.cascadeId || info.convoId || null;
      const productKey = info.productKey || null;
      const dispatchId = `disp_${seq}_${timestamp}`;

      if (convoId && productKey && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: info.productLabel,
          modelId: info.modelId
        });
      }

      const baseline = getBaselineForScope(convoId, productKey);
      // 严禁在诊断追踪中落盘任何用户对话内容或凭证信息，仅保留结构化预算追踪字段
      const sanitizedPrefSnapshot = info.prefSnapshot && typeof info.prefSnapshot === 'object'
        ? {
          mode: info.prefSnapshot.mode || 'default',
          limitTokens: info.prefSnapshot.mode === 'fixed' && Number.isSafeInteger(Number(info.prefSnapshot.limitTokens))
            ? Number(info.prefSnapshot.limitTokens)
            : null
        }
        : {
          mode: info.targetMode || 'default',
          limitTokens: info.targetLimitTokens ?? null
        };
      const record = {
        dispatchId,
        seq,
        cascadeId: convoId,
        convoId,
        productKey,
        modelId: info.modelId || null,
        scopeMode: info.scopeMode || 'per_model',
        prefSnapshot: sanitizedPrefSnapshot,
        targetMode: info.targetMode || 'default',
        targetLimitTokens: info.targetLimitTokens ?? null,
        sentMode: info.sentMode || info.targetMode || 'default',
        sentLimitTokens: info.sentLimitTokens ?? null,
        channel: info.channel || 'http',
        transport: info.channel || 'http',
        status: info.status || 'dispatched',
        errorMessage: info.errorMessage ? String(info.errorMessage).slice(0, 160) : null,
        reason: info.reason || null,
        baselineCallId: baseline.callId,
        baselineStepCount: baseline.stepCount,
        baselineObsTs: baseline.obsTs,
        timestamp
      };

      const sKey = makeScopeKey(convoId, productKey);
      dispatchesByScope.set(sKey, record);
      dispatchesById.set(dispatchId, record);
      if (dispatchesById.size > 200) {
        const oldestKey = dispatchesById.keys().next().value;
        if (oldestKey) dispatchesById.delete(oldestKey);
      }
      if (productKey && productKey !== '__unified__') {
        dispatchesByProduct.set(productKey, record);
      }
      return record;
    }

    function updateDispatchStatus(dispatchId, patch = {}) {
      const rec = dispatchesById.get(dispatchId);
      if (!rec) return null;
      Object.assign(rec, patch);
      return rec;
    }

    /**
     * 记录后端真实观测，绝不在旧快照上用 Date.now() 刷新 ts
     */
    function recordObservation(obsInput = {}) {
      const convoId = obsInput.convoId || obsInput.cascadeId || null;
      const productKey = obsInput.productKey || null;
      if (!productKey) return null;

      const sKey = makeScopeKey(convoId, productKey);
      const prev = observationsByScope.get(sKey);
      const budget = Number(obsInput.budget || 0);
      const serviceLimit = Number(obsInput.serviceLimit || 0);
      const modelHardLimit = Number(obsInput.modelHardLimit || 0);
      const callId = obsInput.callId || null;
      const stepCount = Number.isFinite(Number(obsInput.stepCount)) ? Number(obsInput.stepCount) : -1;
      const explicitTs = Number(obsInput.ts || 0);

      // 判定是否为“新步骤 / 新响应”，而非同一快照反复轮询（绝不因 poll 时间戳增加而推进旧快照 ts）
      const sameCall = callId ? prev?.callId === callId : prev?.callId === null;
      const sameStep = stepCount === prev?.stepCount;
      const downgradedMissingCall = Boolean(
        prev &&
        !callId &&
        prev.callId &&
        (stepCount < 0 || prev.stepCount < 0 || stepCount <= prev.stepCount)
      );
      const isSameSnapshot = Boolean(
        prev &&
        prev.budget === budget &&
        prev.serviceLimit === serviceLimit &&
        prev.modelHardLimit === modelHardLimit &&
        (
          (sameCall && sameStep && (!explicitTs || callId !== null || stepCount >= 0 || explicitTs <= prev.ts)) ||
          downgradedMissingCall
        )
      );

      if (isSameSnapshot) {
        return prev;
      }

      const nextTs = explicitTs > 0 ? explicitTs : nowFn();
      const next = {
        convoId,
        productKey,
        modelId: obsInput.modelId || prev?.modelId || null,
        modelLabel: obsInput.modelLabel || prev?.modelLabel || null,
        effort: obsInput.effort || prev?.effort || null,
        budget,
        serviceLimit,
        modelHardLimit,
        callId,
        stepCount,
        ts: nextTs
      };
      observationsByScope.set(sKey, next);

      if (convoId && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: next.modelLabel,
          modelId: next.modelId
        });
      }
      return next;
    }

    function getScopedObservation(convoId, productKey) {
      if (!productKey) return null;
      if (convoId) {
        return observationsByScope.get(makeScopeKey(convoId, productKey)) || null;
      }
      // 无活跃会话时不臆测，可按最新 matching scope 返回但标注 convoId
      let latest = null;
      for (const obs of observationsByScope.values()) {
        if (obs.productKey === productKey && (!latest || obs.ts > latest.ts)) {
          latest = obs;
        }
      }
      return latest;
    }

    function getScopedDispatch(convoId, productKey, scopeMode = 'per_model') {
      if (convoId) {
        const direct = dispatchesByScope.get(makeScopeKey(convoId, productKey));
        if (direct) return direct;
        if (scopeMode === 'unified') {
          const unifiedRec = dispatchesByScope.get(makeScopeKey(convoId, '__unified__'));
          if (unifiedRec) return unifiedRec;
        }
        return null;
      }
      if (productKey && dispatchesByProduct.has(productKey)) {
        return dispatchesByProduct.get(productKey);
      }
      return null;
    }

    function isPostDispatchObservation(dispatch, obs) {
      if (!dispatch || !obs) return false;
      if (dispatch.convoId && obs.convoId && dispatch.convoId !== obs.convoId) return false;
      if (obs.ts < dispatch.timestamp) return false;
      const changedCall = Boolean(obs.callId && obs.callId !== dispatch.baselineCallId);
      const advancedStep = obs.stepCount >= 0 && obs.stepCount > dispatch.baselineStepCount;
      if (changedCall || advancedStep) return true;
      // 若 callId 与发送前基线完全相同且步骤未增长，说明仍是旧快照（即便 scannedAt/ts 更新也绝非新响应）
      if (obs.callId && dispatch.baselineCallId && obs.callId === dispatch.baselineCallId) {
        return false;
      }
      // 若双方均有明确步数基线且未前进，同样禁止仅靠轮询时间戳伪确认
      if (dispatch.baselineStepCount >= 0 && obs.stepCount >= 0 && obs.stepCount <= dispatch.baselineStepCount) {
        return false;
      }
      return obs.ts > dispatch.baselineObsTs;
    }

    function evaluateStatus(params = {}) {
      const product = params.product || null;
      const scopeMode = params.scopeMode === 'per_model' ? 'per_model' : 'unified';
      const activePref = params.pref || { mode: 'default', limitTokens: null };
      const activeConvId = params.activeConvId || null;
      const now = Number(params.now || nowFn());

      if (!product) {
        return {
          status: 'unconfirmed',
          convoId: activeConvId || '—',
          targetMode: activePref?.mode || 'default',
          targetLimit: activePref?.mode === 'fixed' ? Number(activePref?.limitTokens) : null,
          dispatched: null,
          observation: null,
          diagnosisCode: 'missing_product'
        };
      }

      const targetMode = activePref?.mode || 'default';
      const targetLimit = targetMode === 'fixed' && Number.isSafeInteger(Number(activePref?.limitTokens))
        ? Number(activePref.limitTokens)
        : null;

      const rawDispatched = getScopedDispatch(activeConvId, product.productKey, scopeMode);
      const obs = getScopedObservation(activeConvId || rawDispatched?.convoId || null, product.productKey);
      const obsBudget = Number(obs?.budget || 0);
      const serviceLimit = Number(obs?.serviceLimit || 0);
      const modelHardLimit = Number(params.modelHardLimit || obs?.modelHardLimit || 0);

      // 先校验最近发送记录是否匹配“当前保存的新目标”（含从固定改默认、从失败目标改新值），不匹配则不误报旧结果
      const matchesCurrentTarget = Boolean(
        rawDispatched &&
        rawDispatched.targetMode === targetMode &&
        (targetMode !== 'fixed' || rawDispatched.targetLimitTokens === targetLimit)
      );
      const dispatched = matchesCurrentTarget ? rawDispatched : null;
      const effectiveConvoId = dispatched?.convoId || obs?.convoId || activeConvId || '—';

      if (!dispatched) {
        if (targetMode === 'default') {
          return {
            status: 'default',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit: null,
            dispatched: null,
            observation: obs,
            diagnosisCode: 'default_pending_dispatch'
          };
        }
        return {
          status: 'saved_pending_dispatch',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched: null,
          observation: obs,
          diagnosisCode: 'awaiting_next_send'
        };
      }

      if (dispatched.status === 'send_failed') {
        return {
          status: 'send_failed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_failed',
          errorMessage: dispatched.errorMessage || '请求发送失败'
        };
      }
      if (dispatched.status === 'aborted') {
        return {
          status: 'aborted',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_aborted'
        };
      }
      if (dispatched.status === 'uninjectable') {
        return {
          status: 'uninjectable',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: dispatched.reason || 'uninjectable'
        };
      }

      const hasPostObs = isPostDispatchObservation(dispatched, obs);
      if (!hasPostObs || obsBudget <= 0) {
        if (now - dispatched.timestamp > confirmTimeoutMs) {
          return {
            status: 'timeout_unconfirmed',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit,
            dispatched,
            observation: obs,
            diagnosisCode: 'confirm_timeout'
          };
        }
        return {
          status: 'dispatched_pending_confirm',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'awaiting_backend_obs'
        };
      }

      if (targetMode === 'default') {
        return {
          status: 'default',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'default_confirmed'
        };
      }

      if (targetMode === 'dynamic') {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'dynamic_observed'
        };
      }

      // 精确整数比对，不随便放宽到 ±5% 或 ±64 掩盖差值
      if (obsBudget === targetLimit) {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'exact_match'
        };
      }

      // 仅当存在明确的服务端或 ModelInfo 硬上限证据且目标超出该上限时，才判定为受模型上限限制
      const knownCap = (serviceLimit > 0 ? serviceLimit : 0) || (modelHardLimit > 0 ? modelHardLimit : 0);
      if (knownCap > 0 && targetLimit > knownCap && obsBudget <= knownCap) {
        return {
          status: 'clamped_by_model_limit',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          knownCap,
          dispatched,
          observation: obs,
          diagnosisCode: 'server_or_model_cap'
        };
      }

      return {
        status: 'mismatch',
        convoId: effectiveConvoId,
        targetMode,
        targetLimit,
        dispatched,
        observation: obs,
        diagnosisCode: 'budget_mismatch_unknown_reason'
      };
    }

    function clearConversation(convoId) {
      if (!convoId) return;
      for (const k of Array.from(dispatchesByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) dispatchesByScope.delete(k);
      }
      for (const k of Array.from(observationsByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) observationsByScope.delete(k);
      }
      delete verifiedConversationBindings[convoId];
    }

    function exportAllObservationsByProduct() {
      const out = {};
      for (const obs of observationsByScope.values()) {
        if (!obs.productKey) continue;
        const prev = out[obs.productKey];
        if (!prev || obs.ts > prev.ts) out[obs.productKey] = obs;
      }
      return out;
    }

    function exportDiagnosticTraces() {
      return Array.from(dispatchesById.values()).map(rec => {
        const obs = getScopedObservation(rec.convoId, rec.productKey);
        const postMatched = obs && isPostDispatchObservation(rec, obs);
        return {
          dispatchSeq: rec.seq,
          dispatchId: rec.dispatchId,
          convoId: rec.convoId || null,
          productKey: rec.productKey || null,
          modelId: rec.modelId || null,
          scopeMode: rec.scopeMode,
          prefSnapshot: rec.prefSnapshot || null,
          sentMode: rec.sentMode,
          sentLimitTokens: rec.sentLimitTokens,
          transport: rec.transport || rec.channel || null,
          status: rec.status,
          observedBudget: postMatched ? (obs.budget || null) : null,
          observedAt: postMatched ? (obs.ts || null) : null,
          timestamp: rec.timestamp
        };
      });
    }

    return {
      beginDispatch,
      updateDispatchStatus,
      recordObservation,
      recordConversationBinding,
      getScopedDispatch,
      getScopedObservation,
      evaluateStatus,
      clearConversation,
      exportAllObservationsByProduct,
      exportDiagnosticTraces,
      verifiedConversationBindings
    };
  }

  const api = {
    DEFAULT_MIN_TOKENS,
    DEFAULT_MAX_TOKENS,
    STOCK_DEFAULT_CLAMP_TOKENS,
    DEFAULT_CONFIRM_TIMEOUT_MS,
    STATIC_MODEL_ENUM_MAP,
    stripModelEnumPrefix,
    modelEnumNumberToName,
    isTargetBudgetRpc,
    readVarint,
    writeVarint,
    encodeVarintField,
    encodeLengthDelimitedField,
    parseProtoFields,
    extractProtoSendMessageMetadata,
    rewriteProtoSendMessageCheckpointLimit,
    unpackTransportPayload,
    packTransportPayload,
    resolveRuntimeUnlockPolicy,
    deriveModelCapabilitySummary,
    evaluateLimitInput,
    projectUnifiedBudgetForProducts,
    resolveRequestModel,
    findPreferenceForProduct,
    resolveBudgetPolicy,
    applyBudgetPolicyToObject,
    transformOutgoingSendRequest,
    createContextBudgetTracker
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.__AGContextBudgetEngine = api;
  }
})(globalThis);

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
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    reportedFinalCallIds: new Set(), reportedFinalCallOutputs: new Map()
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;

  // =========================================================================
  // 模块 1: 0 级主题跟随、面板与菜单统一背景色、热力图 5 档色阶与自定义颜色选取器
  // =========================================================================
  const COLOR_SLOTS = {
    panelBg: '--ag-custom-panel-bg',
    ringUsed: '--ag-custom-ring-used',
    ringTrack: '--ag-custom-ring-track',
    contextText: '--ag-custom-context-text',
    speedText: '--ag-custom-speed',
    cacheText: '--ag-custom-cache',
    tokenTotal: '--ag-custom-token-total',
    tokenAccent: '--ag-custom-token-accent',
    heatLow: '--ag-custom-heat-low',
    heatHigh: '--ag-custom-heat-high',
    heatLvl0: '--ag-custom-heat-lvl-0',
    heatLvl1: '--ag-custom-heat-lvl-1',
    heatLvl2: '--ag-custom-heat-lvl-2',
    heatLvl3: '--ag-custom-heat-lvl-3',
    heatLvl4: '--ag-custom-heat-lvl-4'
  };
  const COLOR_STORAGE_KEY = 'ag_custom_colors_v1';
  const HEAT_PRESET_STORAGE_KEY = 'ag_heat_preset_v1';
  const customColors = {
    panelBg: '',
    ringUsed: '',
    ringTrack: '',
    contextText: '',
    speedText: '',
    cacheText: '',
    tokenTotal: '',
    tokenAccent: '',
    heatLow: '',
    heatHigh: '',
    heatLvl0: '',
    heatLvl1: '',
    heatLvl2: '',
    heatLvl3: '',
    heatLvl4: ''
  };
  let heatPreset = 'purple';

  const HEAT_PRESETS = {
    purple: {
      dark: ['#27272a', '#3f1e6b', '#652ab7', '#9053f8', '#c084fc'],
      light: ['#e4e4e7', '#e9d5ff', '#c084fc', '#9333ea', '#6b21a8']
    },
    yellow: {
      dark: ['#27272a', '#713f12', '#a16207', '#eab308', '#fde047'],
      light: ['#e4e4e7', '#fef08a', '#facc15', '#ca8a04', '#854d0e']
    },
    green: {
      dark: ['#27272a', '#14532d', '#15803d', '#22c55e', '#86efac'],
      light: ['#e4e4e7', '#bbf7d0', '#4ade80', '#16a34a', '#14532d']
    },
    blue: {
      dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
      light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a']
    },
    red: {
      dark: ['#27272a', '#7f1d1d', '#b91c1c', '#ef4444', '#fca5a5'],
      light: ['#e4e4e7', '#fecaca', '#f87171', '#dc2626', '#7f1d1d']
    }
  };

  try {
    const rawColors = typeof localStorage !== 'undefined' && localStorage.getItem(COLOR_STORAGE_KEY);
    if (rawColors) {
      const parsed = JSON.parse(rawColors);
      for (const k of Object.keys(COLOR_SLOTS)) {
        if (typeof parsed?.[k] === 'string') customColors[k] = parsed[k];
      }
      if (typeof parsed?.heatPreset === 'string' && HEAT_PRESETS[parsed.heatPreset]) {
        heatPreset = parsed.heatPreset;
      }
    }
    const savedPreset = typeof localStorage !== 'undefined' && localStorage.getItem(HEAT_PRESET_STORAGE_KEY);
    if (savedPreset && HEAT_PRESETS[savedPreset]) heatPreset = savedPreset;
  } catch {}

  function saveCustomColors() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify({ ...customColors, heatPreset }));
        localStorage.setItem(HEAT_PRESET_STORAGE_KEY, heatPreset);
      }
    } catch {}
  }

  // 色彩空间转换与格式化工具（HEX <-> RGB <-> HSV <-> HSL）
  function clampNum(n, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  function rgbToHex(r, g, b) {
    const to2 = v => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  }

  function hexToRgb(hexStr) {
    if (!hexStr || typeof hexStr !== 'string') return null;
    const clean = hexStr.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(clean)) return null;
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return null;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hslToRgb(h, s, l) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = clampNum(Number(s), 0, 100) / 100;
    const ln = clampNum(Number(l), 0, 100) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = ln - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function normalizeHex(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    const direct = hexToRgb(s);
    if (direct) return rgbToHex(direct.r, direct.g, direct.b);
    const mRgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (mRgb) return rgbToHex(Number(mRgb[1]), Number(mRgb[2]), Number(mRgb[3]));
    const mHsl = s.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?/i);
    if (mHsl) {
      const rgb = hslToRgb(Number(mHsl[1]), Number(mHsl[2]), Number(mHsl[3]));
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }
    return null;
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) h = ((bn - rn) / d + 2) * 60;
      else h = ((rn - gn) / d + 4) * 60;
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    const v = max * 100;
    return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
  }

  function hsvToRgb(h, s, v) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = clampNum(Number(s), 0, 100) / 100;
    const vn = clampNum(Number(v), 0, 100) / 100;
    const c = vn * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = vn - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) h = ((bn - rn) / d + 2) * 60;
      else h = ((rn - gn) / d + 4) * 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function interpolateHex(hexA, hexB, t) {
    const a = hexToRgb(hexA) || { r: 39, g: 39, b: 42 };
    const b = hexToRgb(hexB) || { r: 192, g: 132, b: 252 };
    const ratio = clampNum(t, 0, 1);
    return rgbToHex(
      a.r + (b.r - a.r) * ratio,
      a.g + (b.g - a.g) * ratio,
      a.b + (b.b - a.b) * ratio
    );
  }

  let currentThemeMode = 'auto';
  try {
    currentThemeMode = (typeof localStorage !== 'undefined' && localStorage.getItem('ag_theme_mode')) || 'auto';
  } catch {}

  function parseRgbLuminance(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const rgb = hexToRgb(normalizeHex(colorStr));
    if (rgb) return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return null;
  }

  function getHostZeroLevelBg(isLight) {
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const rootEl = document.body || document.documentElement;
        if (rootEl) {
          const cs = window.getComputedStyle(rootEl);
          const raw = cs.getPropertyValue('--background')?.trim() || cs.backgroundColor?.trim();
          const norm = normalizeHex(raw);
          if (norm) return norm;
        }
      }
    } catch {}
    return isLight ? '#ffffff' : '#181818';
  }

  function getSystemTheme() {
    try {
      const body = document.body;
      const doc = document.documentElement;
      if (body?.classList?.contains('theme-light') || body?.classList?.contains('light') || doc?.classList?.contains('light') || body?.classList?.contains('vscode-light')) return 'light';
      if (body?.classList?.contains('theme-dark') || body?.classList?.contains('dark') || doc?.classList?.contains('dark') || body?.classList?.contains('vscode-dark')) return 'dark';
      if (doc?.style?.colorScheme === 'light') return 'light';
      if (doc?.style?.colorScheme === 'dark') return 'dark';
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && (body || doc)) {
        const cs = window.getComputedStyle(body || doc);
        const bgVar = cs.getPropertyValue('--background') || cs.backgroundColor;
        const lum = parseRgbLuminance(bgVar);
        if (lum != null) return lum > 0.55 ? 'light' : 'dark';
      }
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      }
    } catch {}
    return 'dark';
  }

  function resolveTheme() {
    if (currentThemeMode === 'light') return 'light';
    if (currentThemeMode === 'dark') return 'dark';
    return getSystemTheme();
  }

  function getPresetHeatmapScale() {
    const isLight = resolveTheme() === 'light';
    const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.purple;
    return (isLight ? presetObj.light : presetObj.dark).slice();
  }

  function getBaseHeatmapScale() {
    const base = getPresetHeatmapScale();
    const lowCustom = normalizeHex(customColors.heatLow);
    const highCustom = normalizeHex(customColors.heatHigh);
    if (lowCustom || highCustom) {
      const c0 = lowCustom || base[0];
      const c4 = highCustom || base[4];
      return [
        c0,
        interpolateHex(c0, c4, 0.25),
        interpolateHex(c0, c4, 0.5),
        interpolateHex(c0, c4, 0.75),
        c4
      ];
    }
    return base;
  }

  function getEffectiveHeatmapScale() {
    const scale = getBaseHeatmapScale();
    for (let i = 0; i < 5; i++) {
      const lvlCustom = normalizeHex(customColors[`heatLvl${i}`]);
      if (lvlCustom) scale[i] = lvlCustom;
    }
    return scale;
  }

  function getDefaultSlotColor(slotKey) {
    const isLight = resolveTheme() === 'light';
    const presetScale = getPresetHeatmapScale();
    const baseScale = getBaseHeatmapScale();
    switch (slotKey) {
      case 'panelBg': return getHostZeroLevelBg(isLight);
      case 'ringUsed': return isLight ? '#18181b' : '#e6e6eb';
      case 'ringTrack': return isLight ? '#b8b8c2' : '#52525b';
      case 'contextText': return isLight ? '#18181b' : '#ececef';
      case 'speedText': return isLight ? '#0284c7' : '#38bdf8';
      case 'cacheText': return isLight ? '#059669' : '#34d399';
      case 'tokenTotal': return isLight ? '#7c3aed' : '#c084fc';
      case 'tokenAccent': return isLight ? '#7c3aed' : '#a78bfa';
      case 'heatLow': return presetScale[0];
      case 'heatHigh': return presetScale[4];
      case 'heatLvl0': return baseScale[0];
      case 'heatLvl1': return baseScale[1];
      case 'heatLvl2': return baseScale[2];
      case 'heatLvl3': return baseScale[3];
      case 'heatLvl4': return baseScale[4];
      default: return '#7748cf';
    }
  }

  function getEffectiveSlotColor(slotKey) {
    return normalizeHex(customColors[slotKey]) || getDefaultSlotColor(slotKey);
  }

  function applyHeatmapPalette() {
    const scale = getEffectiveHeatmapScale();
    for (let i = 0; i < 5; i++) {
      host.style.setProperty(`--ag-heat-lvl-${i}`, scale[i]);
      const legEl = el(`heat-leg-${i}`);
      if (legEl) {
        legEl.style.background = scale[i];
        legEl.style.setProperty('--swatch-color', scale[i]);
        legEl.setAttribute('data-custom', String(Boolean(customColors[`heatLvl${i}`])));
      }
    }
    const hasCustomHeat = Boolean(
      customColors.heatLow || customColors.heatHigh ||
      customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4
    );
    try {
      const group = el('heat-preset-group');
      if (group?.querySelectorAll) {
        const btns = group.querySelectorAll('[data-heat-preset]');
        for (const btn of btns) {
          const pName = btn.getAttribute('data-heat-preset');
          btn.setAttribute('data-active', String(!hasCustomHeat && pName === heatPreset));
        }
      }
    } catch {}
  }

  function syncSwatchAndResetButtons() {
    for (const key of Object.keys(COLOR_SLOTS)) {
      const val = customColors[key];
      const eff = getEffectiveSlotColor(key);
      const inputEl = el(`color-${key}`);
      if (inputEl) inputEl.value = eff;
      const swatchEl = el(`swatch-${key}`);
      if (swatchEl) {
        swatchEl.style.setProperty('--swatch-color', eff);
        swatchEl.style.background = eff;
      }
      const resetBtn = el(`reset-${key}`);
      if (resetBtn) {
        resetBtn.setAttribute('data-mode', val ? 'custom' : 'auto');
        if (key.startsWith('heatLvl')) {
          resetBtn.textContent = val ? t('colors.btn.restore') : t('colors.btn.preset');
        } else if (key === 'heatLow' || key === 'heatHigh') {
          resetBtn.textContent = val ? t('colors.btn.restorePreset') : t('colors.btn.preset');
        } else {
          resetBtn.textContent = val ? t('colors.btn.restoreDefault') : t('cp.followTheme');
        }
      }
    }
    const resetHeatLvlsBtn = el('reset-heat-lvls');
    if (resetHeatLvlsBtn) {
      const anyHeatLvl = Boolean(
        customColors.heatLvl0 || customColors.heatLvl1 || customColors.heatLvl2 || customColors.heatLvl3 || customColors.heatLvl4 ||
        customColors.heatLow || customColors.heatHigh
      );
      resetHeatLvlsBtn.setAttribute('data-mode', anyHeatLvl ? 'custom' : 'auto');
    }
    // 面板 A 中的镜像色块按钮同步
    const mirrorMap = {
      'swatch-panelBg-tokens': 'panelBg',
      'swatch-tokenTotal-tokens': 'tokenTotal',
      'swatch-tokenAccent-tokens': 'tokenAccent'
    };
    for (const [id, slot] of Object.entries(mirrorMap)) {
      const sw = el(id);
      if (sw) {
        const eff = getEffectiveSlotColor(slot);
        sw.style.setProperty('--swatch-color', eff);
        sw.style.background = eff;
      }
    }
    const resetBgTokens = el('reset-panelBg-tokens');
    if (resetBgTokens) {
      const hasBg = Boolean(customColors.panelBg);
      resetBgTokens.setAttribute('data-mode', hasBg ? 'custom' : 'auto');
      resetBgTokens.textContent = hasBg ? t('colors.btn.restoreDefault') : t('cp.followTheme');
    }
  }

  function applyCustomColors() {
    for (const [key, cssVar] of Object.entries(COLOR_SLOTS)) {
      const val = customColors[key];
      if (val) {
        host.style.setProperty(cssVar, val);
      } else if (host.style.removeProperty) {
        host.style.removeProperty(cssVar);
      } else {
        host.style.setProperty(cssVar, '');
      }
    }
    if (customColors.panelBg) {
      const lum = parseRgbLuminance(customColors.panelBg);
      if (lum != null) {
        host.setAttribute('data-panel-tone', lum > 0.55 ? 'light' : 'dark');
      }
    } else {
      host.removeAttribute('data-panel-tone');
    }
    applyHeatmapPalette();
    syncSwatchAndResetButtons();
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
  }

  function setCustomColor(key, value) {
    if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, key)) return;
    const raw = value ? String(value).trim() : '';
    const norm = raw ? (normalizeHex(raw) || raw) : '';
    customColors[key] = norm;
    if (key === 'heatLow' && norm) customColors.heatLvl0 = '';
    if (key === 'heatHigh' && norm) customColors.heatLvl4 = '';
    saveCustomColors();
    applyCustomColors();
  }

  function setHeatPreset(presetName) {
    if (!HEAT_PRESETS[presetName]) return;
    heatPreset = presetName;
    customColors.heatLow = '';
    customColors.heatHigh = '';
    for (let i = 0; i < 5; i++) {
      customColors[`heatLvl${i}`] = '';
    }
    saveCustomColors();
    applyCustomColors();
  }

  function resetHeatmapLevels() {
    customColors.heatLow = '';
    customColors.heatHigh = '';
    for (let i = 0; i < 5; i++) {
      customColors[`heatLvl${i}`] = '';
    }
    saveCustomColors();
    applyCustomColors();
  }

  function resetCustomColors() {
    for (const key of Object.keys(COLOR_SLOTS)) customColors[key] = '';
    heatPreset = 'purple';
    saveCustomColors();
    applyCustomColors();
  }

  function applyTheme() {
    const activeTheme = resolveTheme();
    host.setAttribute('data-theme', activeTheme);
    const hostBg = getHostZeroLevelBg(activeTheme === 'light');
    host.style.setProperty('--ag-host-bg', hostBg);
    const btns = [el('theme-toggle'), el('theme-toggle-tokens')].filter(Boolean);
    btns.forEach(btn => {
      if (currentThemeMode === 'auto') {
        btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
        btn.title = t('theme.autoTitle', { mode: activeTheme === 'light' ? t('theme.light') : t('theme.dark') });
      } else if (currentThemeMode === 'light') {
        btn.textContent = '☀️';
        btn.title = t('theme.lightTitle');
      } else {
        btn.textContent = '🌙';
        btn.title = t('theme.darkTitle');
      }
    });
    applyHeatmapPalette();
    syncSwatchAndResetButtons();
    if (activeHeatView === 'weekly') renderHeatmapWeekly();
    else if (activeHeatView === 'cum') renderHeatmapCum();
    syncNativeOverlayTheme();
  }

  let lastSyncedOverlayKey = '';
  function syncNativeOverlayTheme() {
    try {
      if (typeof window === 'undefined') return;
      const isLight = resolveTheme() === 'light';
      const rootEl = document.body || document.documentElement;
      const cs = (rootEl && typeof window.getComputedStyle === 'function') ? window.getComputedStyle(rootEl) : null;
      const bg = cs?.getPropertyValue?.('--background')?.trim() || (isLight ? '#FAFAFA' : '#131313');
      const fg = cs?.getPropertyValue?.('--foreground')?.trim() || (isLight ? '#383A42' : '#FAFAFA');
      const overlayKey = `${bg}|${fg}|40`;
      if (overlayKey === lastSyncedOverlayKey) return;
      lastSyncedOverlayKey = overlayKey;
      if (typeof window.contextMeterAPI?.syncOverlay === 'function') {
        void window.contextMeterAPI.syncOverlay({ color: bg, symbolColor: fg, height: 40, heightCssPx: 40 });
      } else if (typeof window.electronNative?.setTitleBarOverlay === 'function') {
        void window.electronNative.setTitleBarOverlay({ color: bg, symbolColor: fg });
      }
    } catch {}
  }

  function cycleTheme() {
    if (currentThemeMode === 'auto') currentThemeMode = 'light';
    else if (currentThemeMode === 'light') currentThemeMode = 'dark';
    else currentThemeMode = 'auto';
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ag_theme_mode', currentThemeMode);
    } catch {}
    applyTheme();
  }

  let themeObserver = null;
  try {
    if (typeof MutationObserver !== 'undefined' && document.body) {
      themeObserver = new MutationObserver(() => {
        if (currentThemeMode === 'auto') applyTheme();
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      }
    }
  } catch {}

  applyTheme();
  applyCustomColors();

  // =========================================================================
  // 自定义「颜色选取器」面板交互逻辑（吸管 + 预设圆点 + SV主色区 + 色相条 + HEX/RGB/HSL）
  // =========================================================================
  let activePickerSlot = null;
  let activePickerAnchor = null;
  let cpHsv = { h: 265, s: 77, v: 72 };

  function syncPickerUiFromHsv(skipInputId = '', exactRgb = null) {
    const rgb = exactRgb || hsvToRgb(cpHsv.h, cpHsv.s, cpHsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

    const svArea = el('cp-sv-area');
    const svThumb = el('cp-sv-thumb');
    const hueThumb = el('cp-hue-thumb');
    const sidePreview = el('cp-side-preview');
    if (svArea) svArea.style.backgroundColor = `hsl(${cpHsv.h}, 100%, 50%)`;
    if (svThumb) {
      svThumb.style.left = `${cpHsv.s}%`;
      svThumb.style.top = `${100 - cpHsv.v}%`;
    }
    if (hueThumb) {
      hueThumb.style.left = `${(cpHsv.h / 360) * 100}%`;
    }
    if (sidePreview) {
      sidePreview.style.background = hex;
    }

    const inHex = el('cp-input-hex');
    const inRgb = el('cp-input-rgb');
    const inHsl = el('cp-input-hsl');
    if (inHex && skipInputId !== 'cp-input-hex') inHex.value = hex;
    if (inRgb && skipInputId !== 'cp-input-rgb') inRgb.value = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    if (inHsl && skipInputId !== 'cp-input-hsl') inHsl.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    return hex;
  }

  function applyPickerHex(hexStr, skipInputId = '') {
    const norm = normalizeHex(hexStr);
    if (!norm) return false;
    const rgb = hexToRgb(norm);
    if (!rgb) return false;
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const appliedHex = syncPickerUiFromHsv(skipInputId, rgb);
    if (activePickerSlot) {
      setCustomColor(activePickerSlot, appliedHex);
    }
    return true;
  }

  let pickerOpVersion = 0;

  function positionColorPickerPopover() {
    const pop = el('color-picker-popover');
    if (!pop || pop.hidden) return;
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const popW = 304;
      const popH = pop.offsetHeight > 0 ? pop.offsetHeight : 340;
      let minLeft = 12;
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right < vw - 320) {
            minLeft = Math.ceil(nr.right + 12);
          }
        }
      }
      let left = Math.round((vw - popW) / 2);
      let top = 90;
      if (activePickerAnchor?.getBoundingClientRect) {
        const ar = activePickerAnchor.getBoundingClientRect();
        if (ar.width > 0 || ar.height > 0) {
          left = Math.round(ar.right - popW);
          top = Math.round(ar.bottom + 6);
          if (top + popH > vh - 12 && ar.top > popH + 12) {
            top = Math.round(ar.top - popH - 6);
          }
        }
      }
      left = Math.max(minLeft, Math.min(vw - popW - 12, left));
      top = Math.max(42, Math.min(vh - popH - 12, top));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    } catch {}
  }

  function openColorPicker(slotKey, anchorEl = null, labelText = '') {
    if (!Object.prototype.hasOwnProperty.call(COLOR_SLOTS, slotKey)) return;
    const pop = el('color-picker-popover');
    if (!pop) return;

    const op = ++pickerOpVersion;
    activePickerSlot = slotKey;
    activePickerAnchor = anchorEl;

    const lbl = el('cp-target-name');
    if (lbl) lbl.textContent = labelText ? `· ${labelText}` : `· ${slotKey}`;
    const cpResetBtn = el('cp-reset-slot');
    if (cpResetBtn) {
      cpResetBtn.textContent = slotKey.startsWith('heat') ? t('colors.resetLevel') : t('colors.followTheme');
    }
    const startHex = getEffectiveSlotColor(slotKey);
    const rgb = hexToRgb(startHex) || { r: 101, g: 42, b: 183 };
    cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    syncPickerUiFromHsv();

    pop.setAttribute?.('data-closing', 'false');
    pop.classList?.remove?.('is-closing');
    pop.classList?.add?.('is-opening');
    pop.hidden = false;
    positionColorPickerPopover();

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (pickerOpVersion === op) {
          pop.classList?.remove?.('is-opening');
        }
      });
    } else {
      pop.classList?.remove?.('is-opening');
    }
  }

  function closeColorPicker(immediate = false) {
    const pop = el('color-picker-popover');
    const isMock = !pop?.classList || typeof pop.classList.add !== 'function' || typeof pop.animate !== 'function';
    const isClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (!pop || pop.hidden || isClosing) {
      activePickerSlot = null;
      activePickerAnchor = null;
      return;
    }
    const op = ++pickerOpVersion;
    activePickerSlot = null;
    activePickerAnchor = null;

    const isImmediate = typeof immediate === 'boolean' ? immediate : false;
    if (isImmediate || isMock || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) {
      pop.setAttribute?.('data-closing', 'false');
      pop.classList?.remove?.('is-opening', 'is-closing');
      pop.hidden = true;
      return;
    }

    pop.setAttribute?.('data-closing', 'true');
    pop.classList?.add?.('is-closing');
    setTimeout(() => {
      if (pickerOpVersion === op) {
        pop.setAttribute?.('data-closing', 'false');
        pop.classList?.remove?.('is-opening', 'is-closing');
        pop.hidden = true;
      }
    }, 130);
  }

  const getHeatLvlLabel = (idx) => t(`colors.lvl${idx}`);

  // 绑定所有颜色色块与恢复按钮事件
  for (const key of Object.keys(COLOR_SLOTS)) {
    const inputEl = el(`color-${key}`);
    const resetBtn = el(`reset-${key}`);
    const swatchBtn = el(`swatch-${key}`);
    inputEl?.addEventListener('input', e => setCustomColor(key, e.target?.value || ''));
    inputEl?.addEventListener('change', e => setCustomColor(key, e.target?.value || ''));
    resetBtn?.addEventListener('click', () => {
      setCustomColor(key, '');
      if (activePickerSlot === key) {
        const eff = getEffectiveSlotColor(key);
        const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
        cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        syncPickerUiFromHsv();
      }
    });
    swatchBtn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      openColorPicker(key, swatchBtn, swatchBtn.getAttribute('data-color-label') || key);
    });
  }

  // 热力图右下角「少 ▢▢▢▢▢ 多」5 个小色块图例直接点击弹出颜色选取器单独调色
  for (let i = 0; i < 5; i++) {
    const legBtn = el(`heat-leg-${i}`);
    const slotKey = `heatLvl${i}`;
    legBtn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      toggleTokenColorsDrawer(true);
      const swatchBtn = el(`swatch-${slotKey}`) || legBtn;
      openColorPicker(slotKey, swatchBtn, getHeatLvlLabel(i));
    });
  }
  el('reset-heat-lvls')?.addEventListener('click', () => {
    resetHeatmapLevels();
    if (activePickerSlot?.startsWith('heat')) {
      const eff = getEffectiveSlotColor(activePickerSlot);
      const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
      cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncPickerUiFromHsv();
    }
  });

  // 面板 A 镜像色块与预设按钮事件
  ['swatch-panelBg-tokens', 'swatch-tokenTotal-tokens', 'swatch-tokenAccent-tokens'].forEach(id => {
    const btn = el(id);
    btn?.addEventListener('click', e => {
      e?.stopPropagation?.();
      const slot = btn.getAttribute('data-color-slot');
      if (slot) openColorPicker(slot, btn, btn.getAttribute('data-color-label') || slot);
    });
  });
  el('reset-panelBg-tokens')?.addEventListener('click', () => setCustomColor('panelBg', ''));
  el('reset-all-colors')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });
  el('reset-all-colors-tokens')?.addEventListener('click', () => { resetCustomColors(); closeColorPicker(); });

  try {
    const presetGroup = el('heat-preset-group');
    if (presetGroup?.querySelectorAll) {
      for (const btn of presetGroup.querySelectorAll('[data-heat-preset]')) {
        btn.addEventListener('click', () => {
          const p = btn.getAttribute('data-heat-preset');
          if (p) setHeatPreset(p);
        });
      }
    }
  } catch {}

  // 颜色选取器内部控件绑定（SV 拖拽、Hue 拖拽、预设圆点、吸管、HEX/RGB/HSL 输入与复制）
  el('cp-close')?.addEventListener('click', () => closeColorPicker(false));
  el('cp-reset-slot')?.addEventListener('click', () => {
    if (activePickerSlot) {
      setCustomColor(activePickerSlot, '');
      const eff = getEffectiveSlotColor(activePickerSlot);
      const rgb = hexToRgb(eff) || { r: 101, g: 42, b: 183 };
      cpHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncPickerUiFromHsv();
    }
  });

  try {
    const presetsWrap = el('cp-presets');
    if (presetsWrap?.querySelectorAll) {
      for (const dot of presetsWrap.querySelectorAll('[data-cp-hex]')) {
        dot.addEventListener('click', () => {
          const hex = dot.getAttribute('data-cp-hex');
          if (hex) applyPickerHex(hex);
        });
      }
    }
  } catch {}

  el('cp-eyedropper')?.addEventListener('click', async () => {
    const statusEl = el('cp-status-msg');
    try {
      if (typeof window !== 'undefined' && typeof window.EyeDropper === 'function') {
        const dropper = new window.EyeDropper();
        const res = await dropper.open();
        if (res?.sRGBHex) {
          applyPickerHex(res.sRGBHex);
          if (statusEl) statusEl.textContent = t('colors.eyedropperPicked', { hex: res.sRGBHex.toUpperCase() });
        }
      } else {
        el('cp-input-hex')?.focus?.();
        if (statusEl) statusEl.textContent = t('colors.eyedropperUnsupported');
      }
    } catch {}
  });

  el('cp-input-hex')?.addEventListener('input', e => {
    const raw = e.target?.value || '';
    const norm = normalizeHex(raw);
    if (norm) {
      applyPickerHex(norm, 'cp-input-hex');
      const statusEl = el('cp-status-msg');
      if (statusEl) statusEl.textContent = t('colors.appliedHex', { hex: norm.toUpperCase() });
    }
  });
  el('cp-input-hex')?.addEventListener('change', e => {
    const raw = e.target?.value || '';
    const norm = normalizeHex(raw);
    if (norm) applyPickerHex(norm);
  });

  el('cp-input-rgb')?.addEventListener('input', e => {
    const norm = normalizeHex(e.target?.value || '');
    if (norm) applyPickerHex(norm, 'cp-input-rgb');
  });
  el('cp-input-hsl')?.addEventListener('input', e => {
    const norm = normalizeHex(e.target?.value || '');
    if (norm) applyPickerHex(norm, 'cp-input-hsl');
  });

  function copyPickerText(inputId, label) {
    const input = el(inputId);
    const val = input?.value || '';
    if (!val) return;
    try {
      navigator?.clipboard?.writeText?.(val);
    } catch {}
    const statusEl = el('cp-status-msg');
    if (statusEl) statusEl.textContent = t('colors.copied', { label, val });
  }
  el('cp-copy-hex')?.addEventListener('click', () => copyPickerText('cp-input-hex', 'HEX'));
  el('cp-copy-rgb')?.addEventListener('click', () => copyPickerText('cp-input-rgb', 'RGB'));
  el('cp-copy-hsl')?.addEventListener('click', () => copyPickerText('cp-input-hsl', 'HSL'));

  const svAreaEl = el('cp-sv-area');
  const hueWrapEl = el('cp-hue-wrap');
  let draggingSv = false;
  let draggingHue = false;

  function updateSvFromPointer(e) {
    if (!svAreaEl?.getBoundingClientRect) return;
    const r = svAreaEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = clampNum(((e.clientX - r.left) / r.width) * 100, 0, 100);
    const v = clampNum(100 - ((e.clientY - r.top) / r.height) * 100, 0, 100);
    cpHsv.s = Math.round(s);
    cpHsv.v = Math.round(v);
    const hex = syncPickerUiFromHsv();
    if (activePickerSlot) setCustomColor(activePickerSlot, hex);
  }

  function updateHueFromPointer(e) {
    if (!hueWrapEl?.getBoundingClientRect) return;
    const r = hueWrapEl.getBoundingClientRect();
    if (!r.width) return;
    const h = clampNum(((e.clientX - r.left) / r.width) * 360, 0, 360);
    cpHsv.h = Math.round(h);
    const hex = syncPickerUiFromHsv();
    if (activePickerSlot) setCustomColor(activePickerSlot, hex);
  }

  svAreaEl?.addEventListener('mousedown', e => {
    draggingSv = true;
    updateSvFromPointer(e);
  });
  hueWrapEl?.addEventListener('mousedown', e => {
    draggingHue = true;
    updateHueFromPointer(e);
  });
  const onPointerMove = e => {
    if (draggingSv) updateSvFromPointer(e);
    else if (draggingHue) updateHueFromPointer(e);
  };
  const onPointerUp = () => {
    draggingSv = false;
    draggingHue = false;
  };
  try {
    window.addEventListener?.('mousemove', onPointerMove);
    window.addEventListener?.('mouseup', onPointerUp);
  } catch {}


  // =========================================================================
  // 模块 2: 宿主布局挂载、右上角原生窗口控制区预留、渐进式宽度收缩与悬浮层定位
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;

  function findHostTitlebar() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function isTopRightToolbarCluster(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    const classList = typeof el.classList?.contains === 'function'
      ? el.classList
      : { contains: c => cls.split(/\s+/).includes(c) };
    if (!classList.contains('absolute') || !classList.contains('right-0')) return false;

    const styleTop = el.style?.top || el.getAttribute('style') || '';
    const hasTopClass = classList.contains('top-0');
    const hasTopStyle = /(?:^|;)\s*top:\s*0(?:px)?(?:\s*;|$)/i.test(styleTop);
    const rectTop = el.getBoundingClientRect ? el.getBoundingClientRect().top : 0;
    if (el.getBoundingClientRect && rectTop >= 20) return false;
    const isAtTop = hasTopClass || hasTopStyle || (rectTop <= 10 && rectTop >= 0);
    if (!isAtTop) return false;

    // 排除明显非顶栏容器（右侧全高抽屉、全屏浮层或带有明确非零高度下沉定位的浮层）
    if (classList.contains('bottom-0') || classList.contains('h-screen') || classList.contains('h-full')) {
      return false;
    }

    // 排除右侧滚动条滑槽（特征：包含 top-0.5 / bottom-0.5 / w-3 等滚动条特征）
    if (classList.contains('w-3') || classList.contains('right-0.5')) {
      return false;
    }

    // 必须符合顶栏控制按钮容器特征：
    // a) 包含右侧栏切换按钮
    // b) 或包含 z-50 并具有 flex / items-center 水平布局
    const hasAuxToggle = Boolean(el.querySelector && el.querySelector('[data-testid="toggle-aux-sidebar"]'));
    const hasToolbarLayout = classList.contains('z-50') && (classList.contains('items-center') || classList.contains('flex'));

    return hasAuxToggle || hasToolbarLayout;
  }

  function findTopRightCluster() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      // 1. 优先从右侧栏切换按钮向上寻找最近的顶栏容器
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        // 先尝试带 top-0 的经典结构（Antigravity 1.x）
        let cluster = auxToggle.closest('div.absolute.right-0.top-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
        // 兼容 Antigravity 2.x（top: 0px 写在内联 style，class 无 top-0）
        cluster = auxToggle.closest('div.absolute.right-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
      }

      // 2. 备用安全探测：当 auxToggle 尚未挂载或被动态卸载时，精确匹配顶栏容器
      // 严格检查顶部坐标与容器特征，绝不误伤滚动条、侧栏抽屉或模态弹窗
      const selectors = [
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.top-0.z-50',
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50',
        'div.absolute.right-0.z-50'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isTopRightToolbarCluster(el)) return el;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 动态计算右上角原生窗口控制区（Minimize / Maximize / Close）独占宽度（CSS px）
  function computeWindowControlsWidth(topRight) {
    if (!topRight) return 0;
    try {
      const plat = (typeof navigator !== 'undefined' && navigator.platform) || '';
      if (/^Mac|iPhone|iPad/i.test(plat)) return 0;
      if (topRight?.getBoundingClientRect) {
        const tr = topRight.getBoundingClientRect();
        // 若顶部已单独渲染菜单栏（top >= 20），则 40px 工具栏不在窗口顶边，无需重复留白
        if (tr.height > 0 && tr.top >= 20) return 0;
      }
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      // 优先 1: 标准 WCO 接口 navigator.windowControlsOverlay
      const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
      if (wco?.visible && typeof wco.getTitlebarAreaRect === 'function') {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.width > 0 && vw > 0 && rect.width < vw) {
          return Math.max(0, Math.ceil(vw - rect.right));
        }
      }
      // 优先 2: 根据 Electron titleBarOverlay 几何规格（Windows 3 颗原生控制按钮共 138 OS DIP）与实时缩放比动态换算
      let zoomFactor = 1;
      if (typeof window !== 'undefined') {
        const nativeZoom = window.electronNative?.getZoomLevel?.();
        if (typeof nativeZoom === 'number' && nativeZoom >= 0.25 && nativeZoom <= 5) {
          zoomFactor = nativeZoom;
        } else if (window.outerWidth > 0 && window.innerWidth > 0) {
          const ratio = window.outerWidth / window.innerWidth;
          if (ratio >= 0.25 && ratio <= 5) zoomFactor = ratio;
        }
      }
      const rawCssWidth = Math.ceil(138 / zoomFactor);
      let existingSpacerWidth = 0;
      if (topRight?.querySelectorAll) {
        const spacers = topRight.querySelectorAll('div[aria-hidden="true"]');
        for (const sp of spacers) {
          if (sp.id !== 'ag-wco-spacer' && sp.getBoundingClientRect) {
            existingSpacerWidth += Math.round(sp.getBoundingClientRect().width || parseFloat(sp.style?.width) || 0);
          }
        }
      }
      return Math.max(0, rawCssWidth - existingSpacerWidth);
    } catch {
      return 98;
    }
  }

  function syncWindowControlsOverlay() {
    if (state.disposed) return;
    try {
      const topRight = findTopRightCluster();
      const wcoWidth = computeWindowControlsWidth(topRight);
      const spacer = typeof document.getElementById === 'function' ? document.getElementById('ag-wco-spacer') : null;
      if (topRight && typeof document.createElement === 'function' && wcoWidth > 0) {
        let activeSpacer = spacer;
        if (!activeSpacer || activeSpacer.parentElement !== topRight) {
          activeSpacer?.remove?.();
          activeSpacer = document.createElement('div');
          activeSpacer.id = 'ag-wco-spacer';
          activeSpacer.setAttribute('aria-hidden', 'true');
          topRight.appendChild(activeSpacer);
        }
        const targetCss = `width:${wcoWidth}px;height:100%;flex-shrink:0;pointer-events:none;`;
        if (activeSpacer.style.cssText !== targetCss) {
          activeSpacer.style.cssText = targetCss;
        }
      } else {
        if (spacer) {
          spacer.remove();
        }
        if (topRight?.querySelectorAll) {
          const oldSpacers = topRight.querySelectorAll('#ag-wco-spacer');
          for (const s of oldSpacers) {
            s.remove?.();
          }
        }
      }

      if (typeof document.head !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = typeof document.getElementById === 'function' ? document.getElementById('ag-topbar-host-fix') : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ag-topbar-host-fix';
          document.head.appendChild(styleEl);
        }
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          wcoWidth > 0 ? [
            '[class*="@container/titlebar"],',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child {',
            '  -webkit-app-region: drag;',
            '}',
            '[class*="@container/titlebar"] button,',
            '[class*="@container/titlebar"] a,',
            '[class*="@container/titlebar"] input,',
            '[class*="@container/titlebar"] [role="button"],',
            '[data-testid="pane-titlebar-toolbar"] > *,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] button,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] [data-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child button,',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child a,',
            '#ag-context-meter {',
            '  -webkit-app-region: no-drag;',
            '}'
          ].join('\n') : ''
        ].join('\n');
        if (styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
      }
      syncNativeOverlayTheme();
    } catch {}
  }

  function ensureHostDocked() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      // 自愈保护：若主对话区（div.flex[style*="min-width"]）的 inline flex-grow 被意外清空，立即恢复为 1，绝不覆写其他分栏属性
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch {}

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch {}

      if (host.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {}
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
      updateFixedFallbackPosition();
    }
    updateResponsiveLayout();
  }

  function findNativeTopRightAnchor() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const openIdeBtn = buttons.find(b => {
        const text = (b.textContent || '').trim();
        return (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) && b.getBoundingClientRect?.().top < 50;
      });
      if (openIdeBtn) {
        const parentGroup = openIdeBtn.closest('div.flex.items-center, div.absolute.right-0') || openIdeBtn;
        return parentGroup;
      }
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
      }
      return document.querySelector('div.absolute.right-0.top-0');
    } catch {
      return null;
    }
  }

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch {}
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      host.style.top = '6px';
      host.style.right = `${rightOffset}px`;
    } catch {}
  }

  // 带迟滞区间（Hysteresis）的四阶段渐进收缩计算，防止临界宽度抖动
  function computeNextLayoutMode(availWidth, currentMode) {
    // 阈值设计：
    // wide <-> compact: 收缩 < 285px, 恢复 >= 300px
    // compact <-> minimal: 收缩 < 212px, 恢复 >= 226px
    // minimal <-> ring-only: 收缩 < 68px, 恢复 >= 82px
    if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
    if (currentMode === 'wide') {
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 212) return 'minimal';
      if (availWidth < 285) return 'compact';
      return 'wide';
    }
    if (currentMode === 'compact') {
      if (availWidth >= 300) return 'wide';
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 212) return 'minimal';
      return 'compact';
    }
    if (currentMode === 'minimal') {
      if (availWidth >= 300) return 'wide';
      if (availWidth >= 226) return 'compact';
      if (availWidth < 68) return 'ring-only';
      return 'minimal';
    }
    // currentMode === 'ring-only'
    if (availWidth >= 300) return 'wide';
    if (availWidth >= 226) return 'compact';
    if (availWidth >= 82) return 'minimal';
    return 'ring-only';
  }

  function measureAvailableWidth() {
    try {
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (tbRect.left < 168 ? (168 - tbRect.left) : 12);
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = Math.max(150, titleRealW);
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== host && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) nativeButtonsWidth = sum + 6;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - nativeButtonsWidth;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {}
    return 400;
  }

  function applyLayoutMode(nextMode) {
    if (!nextMode) return;
    const prev = state.layoutMode;
    state.layoutMode = nextMode;
    host.setAttribute('data-layout', nextMode);
    if (prev !== nextMode) {
      if (nextMode !== 'minimal') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
      syncCacheBadgeText();
    }
  }

  function getTopbarVisibleQuickWidth() {
    let count = 0;
    const btnCompact = el('btn-topbar-compact');
    const btnWindow = el('btn-topbar-window');
    if (btnCompact && !btnCompact.hidden) count++;
    if (btnWindow && !btnWindow.hidden) count++;
    return count * 28;
  }

  function updateResponsiveLayout() {
    if (state.disposed) return;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth();
    const nextMode = computeNextLayoutMode(avail - getTopbarVisibleQuickWidth(), state.layoutMode);
    applyLayoutMode(nextMode);
    if (state.tooltipOpen) positionContextTooltip();
    if (el('topbar-action-tooltip')?.getAttribute('data-visible') === 'true') {
      const anchor = activeTopbarTipKind === 'window'
        ? el('btn-topbar-window')
        : (activeTopbarTipKind === 'cache' ? el('badge-cache') : el('btn-topbar-compact'));
      positionTopbarActionTooltip(anchor);
    }
    if (isAnyPanelOpen() || !el('overflow-menu')?.hidden || !el('topbar-window-popover')?.hidden) positionFloatingPanels();
  }

  function scheduleLayoutSync() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        ensureHostDocked();
      });
    } else {
      ensureHostDocked();
    }
  }

  // 定位上下文悬停气泡：空间足够时优先在圆环上方，顶部空间不足时自动翻转至下方，左右防裁切
  function positionContextTooltip() {
    const tip = el('context-tooltip');
    const badge = el('badge');
    if (!tip || !badge || !badge.getBoundingClientRect) return;
    try {
      const bRect = badge.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 190, height: 66 };
      const tipW = tRect.width || 190;
      const tipH = tRect.height || 66;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = Math.max(6, Math.min(vh - tipH - 6, Math.round(top)));

      let left = Math.round(bRect.left + bRect.width / 2 - tipW / 2);
      left = Math.max(8, Math.min(vw - tipW - 8, left));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch {}
  }

  function showContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip || !el('panel')?.hidden) return;
    hideTopbarActionTooltip(true);
    state.tooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionContextTooltip();
  }

  function hideContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip) return;
    state.tooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  let activeTopbarTipKind = null;
  let isTopbarTipFeedback = false;
  let topbarTipFeedbackTimer = null;

  function positionTopbarActionTooltip(anchorEl) {
    const tip = el('topbar-action-tooltip');
    const target = (anchorEl && !anchorEl.hidden)
      ? anchorEl
      : (el('btn-topbar-window') && !el('btn-topbar-window').hidden ? el('btn-topbar-window') : el('badge'));
    if (!tip || !target || !target.getBoundingClientRect) return;
    try {
      const bRect = target.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 210, height: 52 };
      const tipW = tRect.width || 210;
      const tipH = tRect.height || 52;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = Math.max(6, Math.min(vh - tipH - 6, Math.round(top)));

      let left = Math.round(bRect.left + bRect.width / 2 - tipW / 2);
      left = Math.max(8, Math.min(vw - tipW - 8, left));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch {}
  }

  function syncTopbarActionTooltipContent(kind) {
    const tip = el('topbar-action-tooltip');
    const titleEl = el('topbar-tip-title');
    const descEl = el('topbar-tip-desc');
    if (!tip || !titleEl || !descEl) return;
    tip.setAttribute('data-tone', 'default');
    if (kind === 'compact') {
      titleEl.textContent = isQuickCompactBusy ? t('session.quick.compactBusy') : t('topbar.quick.compactTitle');
      descEl.textContent = isQuickCompactBusy ? t('topbar.quick.compactBusyDesc') : t('topbar.quick.compactDesc');
      descEl.hidden = false;
    } else if (kind === 'cache') {
      const cm = state.route ? getEffectiveCacheMetrics(state.latest) : null;
      if (!cm) {
        tip.setAttribute('data-tone', 'default');
        titleEl.textContent = t('cache.tip.idleTitle');
        descEl.textContent = t('cache.tip.idleDesc');
        descEl.hidden = false;
      } else {
        const tone = cm.level === 'low' ? 'error' : (cm.level === 'warn' ? 'warn' : 'default');
        tip.setAttribute('data-tone', tone);
        const pctFixed = cm.hitRate.toFixed(1);
        titleEl.textContent = cm.level === 'low'
          ? t('cache.tip.titleLow', { pct: pctFixed })
          : (cm.level === 'warn'
            ? t('cache.tip.titleWarn', { pct: pctFixed })
            : t('cache.tip.title', { pct: pctFixed }));
        const lines = [
          t('cache.tip.breakdown', {
            cached: fmtBubbleToken(cm.cachedTokens),
            uncached: fmtBubbleToken(cm.uncachedTokens),
            total: fmtBubbleToken(cm.totalInputTokens)
          })
        ];
        const sessCache = typeof summarizeSessionCache === 'function' ? summarizeSessionCache(state.sessionCalls) : null;
        if (sessCache && sessCache.turns >= 2) {
          lines.push(t('cache.tip.sessionLine', {
            pct: sessCache.hitRate.toFixed(1),
            turns: sessCache.turns,
            cached: fmtBubbleToken(sessCache.cachedTokens)
          }));
        }
        if (cm.level === 'low' || cm.level === 'warn') {
          lines.push(t('cache.tip.warnHint'));
        } else if (cm.level === 'cold') {
          lines.push(t('cache.tip.coldHint'));
        }
        descEl.textContent = lines.join('\n');
        descEl.hidden = false;
      }
    } else if (kind === 'window') {
      const info = typeof resolveQuickContextTarget === 'function' ? resolveQuickContextTarget() : { scopeMode: 'unified', ready: true, currentShortLabel: '—' };
      const curLbl = info.currentShortLabel || t('status.savedShortDefault');
      titleEl.textContent = t('twp.tipTitle', { cur: curLbl });
      if (info.scopeMode === 'unified') {
        descEl.textContent = t('twp.tipDescUnified');
      } else {
        const modelLbl = info.prod?.productLabel || t('models.summary.unconfirmed');
        descEl.textContent = t('twp.tipDescModel', { model: modelLbl });
      }
      descEl.hidden = false;
    }
  }

  function showTopbarActionTooltip(kind, anchorEl) {
    const tip = el('topbar-action-tooltip');
    if (!tip) return;
    hideContextTooltip();
    if (topbarTipFeedbackTimer) {
      clearTimeout(topbarTipFeedbackTimer);
      topbarTipFeedbackTimer = null;
    }
    isTopbarTipFeedback = false;
    activeTopbarTipKind = kind;
    syncTopbarActionTooltipContent(kind);
    tip.setAttribute('data-visible', 'true');
    positionTopbarActionTooltip(anchorEl);
  }

  function showTopbarTransientFeedback(ok, msg, anchorEl) {
    const tip = el('topbar-action-tooltip');
    const titleEl = el('topbar-tip-title');
    const descEl = el('topbar-tip-desc');
    if (!tip || !titleEl || !descEl || !msg) return;
    hideContextTooltip();
    if (topbarTipFeedbackTimer) {
      clearTimeout(topbarTipFeedbackTimer);
      topbarTipFeedbackTimer = null;
    }
    isTopbarTipFeedback = true;
    activeTopbarTipKind = null;
    tip.setAttribute('data-tone', ok ? 'success' : 'error');
    titleEl.textContent = msg;
    descEl.textContent = '';
    descEl.hidden = true;
    tip.setAttribute('data-visible', 'true');
    positionTopbarActionTooltip(anchorEl);
    topbarTipFeedbackTimer = setTimeout(() => {
      hideTopbarActionTooltip(true);
    }, ok ? 2800 : 3800);
  }

  function hideTopbarActionTooltip(force = false) {
    if (isTopbarTipFeedback && !force) return;
    if (topbarTipFeedbackTimer) {
      clearTimeout(topbarTipFeedbackTimer);
      topbarTipFeedbackTimer = null;
    }
    isTopbarTipFeedback = false;
    activeTopbarTipKind = null;
    el('topbar-action-tooltip')?.setAttribute('data-visible', 'false');
  }

  let elevatedStackAncestor = null;

  function syncHostStackingElevation(elevate) {
    try {
      if (elevate) {
        const z0 = host.closest?.('div.relative.z-0');
        if (z0?.style) {
          elevatedStackAncestor = z0;
          z0.style.zIndex = '40';
        }
      } else if (elevatedStackAncestor?.style) {
        elevatedStackAncestor.style.zIndex = '';
        elevatedStackAncestor = null;
      }
    } catch {}
  }

  function getLeftProjectSidebarRight(vw) {
    try {
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 260) {
            return Math.ceil(nr.right);
          }
        }
      }
    } catch {}
    return 0;
  }

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const navRight = getLeftProjectSidebarRight(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;

      const placePanel = (panelEl, targetW, anchorBtn) => {
        if (!panelEl) return;
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const top = Math.max(36, Math.min(vh - 120, Math.round((bRect.bottom || hRect.bottom) + 6)));
        const isCompact = panelEl.classList?.contains?.('cost-compact-view') || panelEl.getAttribute?.('class')?.includes?.('cost-compact-view');
        const effW = isCompact ? 400 : targetW;
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(effW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，确保任何视口宽度下右边缘绝不溢出
        let left = Math.round(bRect.right - finalW);
        left = Math.min(left, vw - finalW - 12);
        left = Math.max(minLeft, left);

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${Math.max(260, vw - left - 12)}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      placePanel(el('panel'), 472, el('badge'));
      placePanel(el('panel-tokens'), 730, el('badge-tokens'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
      placePanel(el('topbar-window-popover'), 232, el('btn-topbar-window'));
      positionColorPickerPopover();
    } catch {}
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (!host.isConnected || host.getAttribute('data-dock') !== 'flow' || !findHostTitlebar()?.contains?.(host)) {
          scheduleLayoutSync();
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {}

  const onWindowResize = () => updateResponsiveLayout();
  const onWindowFocus = () => host.setAttribute('data-window-active', 'true');
  const onWindowBlur = () => host.setAttribute('data-window-active', 'false');
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
  } catch {}

  ensureHostDocked();

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

  function closeAllDropdowns(exceptWrap = null) {
    const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : (typeof document !== 'undefined' ? document : null);
    try {
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => {
        if (w !== exceptWrap) removeClass(w, 'is-open');
      });
    } catch {}
  }

  function initDropdownController(cfg) {
    const wrap = el(cfg.wrapId);
    const trigger = el(cfg.triggerId);
    const label = el(cfg.labelId);
    const menu = el(cfg.menuId);
    const linkedSelect = cfg.selectId ? el(cfg.selectId) : null;
    if (!wrap || !trigger || !label || !menu) return null;
    if (trigger._bound) return wrap._controller || null;
    trigger._bound = true;

    let keyboardFocusIndex = -1;

    function renderMenu(kw = '') {
      menu.innerHTML = '';
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      keyboardFocusIndex = -1;

      // 1. 搜索框
      const searchWrap = document.createElement('div');
      searchWrap.className = 'ag-dropdown-search-wrap';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'ag-dropdown-search-input';
      searchInput.placeholder = (typeof cfg.searchPlaceholder === 'function' ? cfg.searchPlaceholder() : cfg.searchPlaceholder) || t('dropdown.searchPlaceholder');
      searchInput.value = kw;
      searchWrap.appendChild(searchInput);
      menu.appendChild(searchWrap);

      searchInput.addEventListener('click', (e) => e?.stopPropagation?.());
      searchInput.addEventListener('input', (e) => {
        renderList(e.target.value.trim().toLowerCase());
      });

      // 2. 列表容器
      const listContainer = document.createElement('div');
      listContainer.className = 'ag-dropdown-list-container';
      menu.appendChild(listContainer);

      let visibleItems = [];

      function updateKeyboardHighlight(newIdx) {
        const itemEls = listContainer.querySelectorAll ? listContainer.querySelectorAll('.ag-dropdown-item') : (listContainer.children || []);
        if (!itemEls.length) return;
        keyboardFocusIndex = Math.max(0, Math.min(newIdx, itemEls.length - 1));
        Array.from(itemEls).forEach((elNode, idx) => {
          if (idx === keyboardFocusIndex) {
            addClass(elNode, 'is-keyboard-focus');
            elNode.scrollIntoView?.({ block: 'nearest' });
          } else {
            removeClass(elNode, 'is-keyboard-focus');
          }
        });
      }

      function renderList(searchKey = '') {
        if (typeof listContainer.replaceChildren === 'function') listContainer.replaceChildren();
        listContainer.innerHTML = '';
        const allItems = cfg.getOptions();
        const selectedVal = cfg.getSelectedValue();

        const matchesItem = it => {
          if (!searchKey) return true;
          if (cfg.filterItem) return cfg.filterItem(it, searchKey);
          const t1 = String(it.label || '').toLowerCase();
          const t2 = String(it.value || '').toLowerCase();
          const t3 = String(it.code || '').toLowerCase();
          const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
          return t1.includes(searchKey) || t2.includes(searchKey) || t3.includes(searchKey) || aliases.some(a => a.includes(searchKey));
        };

        // 过滤可选项；组标题仅在后续存在命中项时显示且不可选
        const renderEntries = [];
        let pendingHeader = null;
        visibleItems = [];
        for (const it of allItems) {
          if (it && it.isGroupHeader) {
            pendingHeader = it;
            continue;
          }
          if (matchesItem(it)) {
            if (pendingHeader) {
              renderEntries.push(pendingHeader);
              pendingHeader = null;
            }
            renderEntries.push(it);
            visibleItems.push(it);
          }
        }

        if (!visibleItems.length) {
          const emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'padding:10px;text-align:center;color:var(--ag-text-muted);font-size:11px';
          emptyDiv.textContent = (typeof cfg.emptyText === 'function' ? cfg.emptyText() : cfg.emptyText) || t('dropdown.empty');
          listContainer.appendChild(emptyDiv);
          return;
        }

        let selectableIdx = 0;
        renderEntries.forEach((opt) => {
          if (opt && opt.isGroupHeader) {
            const groupEl = document.createElement('div');
            groupEl.className = 'ag-dropdown-group-title';
            groupEl.setAttribute?.('role', 'presentation');
            if (opt.dotColor) {
              const dot = document.createElement('span');
              dot.className = 'ag-vendor-dot';
              dot.style.backgroundColor = opt.dotColor;
              groupEl.appendChild(dot);
            }
            const lbl = document.createElement('span');
            lbl.textContent = opt.label || '';
            groupEl.appendChild(lbl);
            listContainer.appendChild(groupEl);
            return;
          }

          const idx = selectableIdx++;
          const itemEl = document.createElement('div');
          const isSelected = cfg.isItemSelected ? cfg.isItemSelected(opt, selectedVal) : (opt.value === selectedVal);
          itemEl.className = 'ag-dropdown-item' + (isSelected ? ' is-selected' : '');
          itemEl.setAttribute?.('data-index', String(idx));

          const leftSpan = document.createElement('span');
          leftSpan.textContent = opt.displayLeft || opt.label;
          itemEl.appendChild(leftSpan);

          if (opt.badgeText) {
            const b = document.createElement('span');
            b.className = 'ag-dropdown-badge';
            b.textContent = opt.badgeText;
            itemEl.appendChild(b);
          }

          const rightSpan = document.createElement('span');
          rightSpan.className = 'ag-dropdown-item-sub';
          if (opt.displayRight) {
            rightSpan.textContent = opt.displayRight;
          }

          const check = document.createElement('span');
          check.className = 'ag-dropdown-item-check';
          check.textContent = '✓';

          if (opt.displayRight) itemEl.appendChild(rightSpan);
          itemEl.appendChild(check);

          itemEl.addEventListener('click', (e) => {
            e?.stopPropagation?.();
            selectOption(opt);
          });

          listContainer.appendChild(itemEl);
        });

        // 滚入可视区
        setTimeout(() => {
          const selNode = listContainer.querySelector ? listContainer.querySelector('.ag-dropdown-item.is-selected') : null;
          selNode?.scrollIntoView?.({ block: 'nearest' });
        }, 30);
      }

      function selectOption(opt) {
        removeClass(wrap, 'is-open');
        const text = cfg.getLabelText ? cfg.getLabelText(opt) : (opt.label || opt.value);
        label.textContent = text;
        if (linkedSelect) {
          runWithUiHydration(() => {
            linkedSelect.value = opt.value;
          });
        }
        if (cfg.onSelect) cfg.onSelect(opt);
        trigger.focus?.();
      }

      renderList(kw);

      // 键盘导航
      const keyHandler = (e) => {
        if (!hasClass(wrap, 'is-open')) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex <= 0 ? 0 : keyboardFocusIndex - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault?.();
          if (keyboardFocusIndex >= 0 && visibleItems[keyboardFocusIndex]) {
            selectOption(visibleItems[keyboardFocusIndex]);
          } else if (visibleItems.length === 1) {
            selectOption(visibleItems[0]);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault?.();
          removeClass(wrap, 'is-open');
          trigger.focus?.();
        }
      };

      searchInput.addEventListener('keydown', keyHandler);
      menu.addEventListener('keydown', keyHandler);
    }

    // 立即预渲染一次菜单内容，避免初次点击或测试环境遇到空白
    renderMenu();

    function toggleOpen() {
      const isOpen = hasClass(wrap, 'is-open');
      if (!isOpen) {
        closeAllDropdowns(wrap);

        // 空间不足检测，自适应展开方向
        try {
          const rect = trigger.getBoundingClientRect?.() || { bottom: 0, top: 0 };
          const spaceBelow = (typeof window !== 'undefined' ? (window.innerHeight || 800) : 800) - rect.bottom;
          if (spaceBelow < 240 && rect.top > 240) {
            addClass(wrap, 'open-up');
          } else {
            removeClass(wrap, 'open-up');
          }
        } catch {
          removeClass(wrap, 'open-up');
        }

        renderMenu();
        addClass(wrap, 'is-open');
        setTimeout(() => {
          const input = menu.querySelector ? menu.querySelector('.ag-dropdown-search-input') : null;
          input?.focus?.();
        }, 50);
      } else {
        removeClass(wrap, 'is-open');
      }
    }

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      toggleOpen();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault?.();
        toggleOpen();
      } else if (e.key === 'Escape') {
        removeClass(wrap, 'is-open');
      }
    });

    const controller = {
      refresh: () => {
        const val = cfg.getSelectedValue();
        const opts = cfg.getOptions();
        const found = opts.find(o => !o.isGroupHeader && o.value === val);
        if (found) {
          label.textContent = cfg.getLabelText ? cfg.getLabelText(found) : (found.label || found.value);
        } else if (cfg.emptyLabel) {
          label.textContent = cfg.emptyLabel;
        }
      },
      close: () => removeClass(wrap, 'is-open'),
      open: () => toggleOpen()
    };
    wrap._controller = controller;
    return controller;
  }

  // =========================================================================
  // 套餐详情面板生命周期管理
  // =========================================================================
  let planDetailExpanded = false;

  // 统一控制订阅与额度详情面板展开与收回
  function setPlanDetailExpanded(expanded, options = {}) {
    const next = Boolean(expanded);
    planDetailExpanded = next;
    const card = el('plan-detail-card');
    const btn = el('btn-plan-detail-toggle');

    if (card) {
      card.style.display = next ? 'block' : 'none';
      card.classList?.toggle?.('is-expanded', next);
      card.setAttribute?.('data-expanded', String(next));
      if (!next) {
        try { card.scrollTop = 0; } catch {}
      }
    }
    if (btn) {
      btn.textContent = next ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      btn.setAttribute?.('aria-expanded', String(next));
    }
    if (!next) {
      closeAllDropdowns();
    }
    if (!options.skipReposition) {
      positionFloatingPanels();
    }
    return planDetailExpanded;
  }

  // 全局点击外部关闭所有下拉
  if (typeof shadow !== 'undefined' && shadow && shadow.addEventListener) {
    shadow.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }

  // 套餐详情卡片展开与收回（统一走 setPlanDetailExpanded）
  el('btn-plan-detail-toggle')?.addEventListener('click', () => {
    const card = el('plan-detail-card');
    const currentlyHidden = !card || card.style.display === 'none' || !card.style.display;
    setPlanDetailExpanded(currentlyHidden);
  });
  el('btn-plan-detail-collapse-top')?.addEventListener('click', () => {
    setPlanDetailExpanded(false);
  });
  el('btn-plan-detail-collapse')?.addEventListener('click', () => {
    setPlanDetailExpanded(false);
  });

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

  // =========================================================================
  // ELV-41 / ELV-43: 官方模型选择器识别与多通道请求拦截注入器
  // 支持：主世界 LS 客户端装饰器、WebSocket (Lcc JSON)、Fetch/XHR (JSON / Envelope / Protobuf)
  // 严格过滤 StartCascade，仅拦截 SendUserCascadeMessage；不从面板配置卡猜测模型
  // =========================================================================
  const CTX_CONFIRM_TIMEOUT_MS = budgetEngine.DEFAULT_CONFIRM_TIMEOUT_MS || 45000;
  const budgetTracker = typeof budgetEngine.createContextBudgetTracker === 'function'
    ? budgetEngine.createContextBudgetTracker({ confirmTimeoutMs: CTX_CONFIRM_TIMEOUT_MS })
    : null;
  let lastDecoratorDispatchHint = null;
  const pendingConfirmTimers = new Set();

  function scheduleConfirmTimeoutCheck(delayMs = CTX_CONFIRM_TIMEOUT_MS + 100) {
    if (typeof setTimeout !== 'function' || state.disposed) return;
    const tId = setTimeout(() => {
      pendingConfirmTimers.delete(tId);
      if (state.disposed) return;
      try {
        renderCompactSessionCard();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
        }
      } catch {}
    }, delayMs);
    pendingConfirmTimers.add(tId);
  }

  function refreshBudgetUiAfterDispatch() {
    try {
      renderCompactSessionCard();
      const prod = getSelectedProductObj();
      if (prod) renderModelDetailCard(prod);
    } catch {}
  }

  /**
   * 仅从宿主真实输入框选择器读取当前选中模型（严格排除插件自身 #ag-context-meter DOM）
   */
  function extractHostSelectedModel() {
    if (typeof document === 'undefined') return null;
    const triggers = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]'))
      : (typeof document.querySelector === 'function' ? [document.querySelector('[data-testid="model-selector-trigger"]')].filter(Boolean) : []);
    if (!triggers.length) return null;

    let trigger = null;
    for (const candidate of triggers) {
      if (!candidate) continue;
      if (host && typeof host.contains === 'function' && host.contains(candidate)) continue;
      if (typeof candidate.closest === 'function' && candidate.closest('#ag-context-meter')) continue;
      if (typeof candidate.getBoundingClientRect === 'function') {
        const rect = candidate.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      trigger = candidate;
      break;
    }
    if (!trigger) return null;

    let effort = null;
    const effortEl = trigger.querySelector?.('[data-testid="model-selector-effort-option"]')
      || trigger.querySelector?.('[data-effort]');
    if (effortEl) {
      effort = effortEl.getAttribute?.('data-effort') || effortEl.textContent?.trim() || null;
    }

    const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
    const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
    if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
    const rawText = (clone.textContent || '').trim();
    if (!rawText) return null;

    if (!effort) {
      const mEffort = rawText.match(/\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)/i);
      if (mEffort) effort = mEffort[1];
    }

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const stableId = resolveStableModelKeyClient(rawText) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(rawText, configs) : null);
    const g = groupProductSafe({
      modelId: stableId || rawText,
      label: rawText,
      effort
    });

    return {
      rawText,
      modelId: stableId || rawText,
      productKey: g.productKey,
      productLabel: g.productLabel || rawText,
      effort: effort || g.effort || null,
      source: 'dom_trigger'
    };
  }

  function buildInterceptorContext(channel, urlOrProcedure = '', contentType = '') {
    return {
      channel,
      urlOrProcedure,
      contentType,
      scopeMode: getContextScopeMode(),
      unifiedPreference: getContextUnifiedPreference(),
      contextPreferencesMap: contextPreferencesMap || (typeof window !== 'undefined' ? window.__AGContextPreferences : null) || {},
      knownConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      verifiedConversationBindings: budgetTracker?.verifiedConversationBindings || {},
      groupProduct: groupProductSafe,
      resolveStableModelId: resolveStableModelKeyClient,
      minTokens: CTX_MIN_ENGINEERING_TOKENS,
      maxTokens: CTX_MAX_ENGINEERING_TOKENS
    };
  }

  function recordBudgetTransformDispatch(txResult) {
    if (!txResult || !txResult.handled || !budgetTracker) return null;
    if (txResult.uninjectable) {
      const rec = budgetTracker.beginDispatch({
        cascadeId: txResult.cascadeId || null,
        productKey: txResult.productKey || null,
        modelId: txResult.modelId || null,
        scopeMode: txResult.scopeMode,
        targetMode: txResult.targetMode || 'default',
        targetLimitTokens: txResult.targetLimitTokens ?? null,
        sentMode: 'passthrough',
        sentLimitTokens: null,
        channel: txResult.channel || 'http',
        status: 'uninjectable',
        reason: txResult.reason || 'uninjectable'
      });
      refreshBudgetUiAfterDispatch();
      return rec;
    }

    const rec = budgetTracker.beginDispatch({
      cascadeId: txResult.cascadeId || null,
      productKey: txResult.productKey || null,
      productLabel: txResult.productLabel || null,
      modelId: txResult.modelId || null,
      scopeMode: txResult.scopeMode,
      prefSnapshot: {
        mode: txResult.targetMode || 'default',
        limitTokens: txResult.targetLimitTokens ?? null
      },
      targetMode: txResult.targetMode,
      targetLimitTokens: txResult.targetLimitTokens,
      sentMode: txResult.sentMode,
      sentLimitTokens: txResult.sentLimitTokens,
      channel: txResult.channel || 'http',
      status: 'dispatched'
    });
    if (txResult.targetMode === 'fixed' || txResult.targetMode === 'dynamic' || txResult.targetMode === 'default') {
      scheduleConfirmTimeoutCheck();
    }
    refreshBudgetUiAfterDispatch();
    return rec;
  }

  function finishDispatchOutcome(dispatchId, ok, err) {
    if (!dispatchId || !budgetTracker) return;
    if (!ok) {
      const errMsg = String(err?.message || err || '');
      const isAbort = err?.name === 'AbortError' || /abort|cancel/i.test(errMsg);
      budgetTracker.updateDispatchStatus(dispatchId, {
        status: isAbort ? 'aborted' : 'send_failed',
        errorMessage: errMsg || (isAbort ? '请求已取消' : '发送失败')
      });
      refreshBudgetUiAfterDispatch();
    }
  }

  const lastCascadeConfigByConv = new Map();

  function captureSendCascadeContext(rawInput) {
    try {
      if (!rawInput) return;
      if (typeof Uint8Array !== 'undefined' && (rawInput instanceof Uint8Array || ArrayBuffer.isView?.(rawInput) || rawInput instanceof ArrayBuffer)) {
        return;
      }
      let obj = null;
      if (typeof rawInput === 'string') {
        const trimmed = rawInput.trim();
        if (!trimmed.startsWith('{')) return;
        obj = JSON.parse(trimmed);
      } else if (typeof rawInput === 'object') {
        obj = rawInput;
      }
      if (!obj || typeof obj !== 'object') return;
      const cid = obj.cascadeId || obj.cascade_id;
      if (!cid || typeof cid !== 'string') return;
      const cfg = obj.cascadeConfig || obj.cascade_config || null;
      const meta = obj.metadata || null;
      if (!cfg && !meta) return;
      const snap = {};
      if (cfg) snap.cascadeConfig = JSON.parse(JSON.stringify(cfg));
      if (meta) snap.metadata = JSON.parse(JSON.stringify(meta));
      if (lastCascadeConfigByConv.size >= 30 && !lastCascadeConfigByConv.has(cid)) {
        const oldest = lastCascadeConfigByConv.keys().next().value;
        if (oldest !== undefined) lastCascadeConfigByConv.delete(oldest);
      }
      lastCascadeConfigByConv.set(cid, snap);
    } catch {}
  }

  function installRequestInterceptor() {
    if (typeof window === 'undefined') return;
    if (window.__agRequestInterceptorInstalled) return;

    // 0. 绑定主世界冷启动客户端装饰器回调（序列化前修改真实请求对象）
    globalThis.__AG_METER_ON_SEND_MESSAGE__ = function(req, channel = 'client_object') {
      try {
        if (!req || typeof req !== 'object' || typeof budgetEngine.transformOutgoingSendRequest !== 'function') return null;
        captureSendCascadeContext(req);
        const tx = budgetEngine.transformOutgoingSendRequest(req, buildInterceptorContext(channel, 'SendUserCascadeMessage'));
        if (!tx || !tx.handled) return null;
        const rec = recordBudgetTransformDispatch(tx);
        lastDecoratorDispatchHint = {
          ts: Date.now(),
          cascadeId: tx.cascadeId || null,
          productKey: tx.productKey || null,
          sentMode: tx.sentMode,
          sentLimitTokens: tx.sentLimitTokens ?? null,
          dispatchId: rec?.dispatchId || null
        };
        return rec ? { dispatchId: rec.dispatchId } : null;
      } catch (err) {
        console.warn('[ContextMeter] Client decorator hook error:', err);
        return null;
      }
    };
    globalThis.__AG_METER_ON_SEND_RESULT__ = function(dispatchId, ok, err) {
      finishDispatchOutcome(dispatchId, ok, err);
    };

    const isCoveredByRecentDecorator = (tx) => {
      if (!lastDecoratorDispatchHint) return false;
      const age = Date.now() - lastDecoratorDispatchHint.ts;
      if (age < 0 || age > 400) return false;
      const sameConv = (lastDecoratorDispatchHint.cascadeId || null) === (tx.cascadeId || null);
      const sameMode = lastDecoratorDispatchHint.sentMode === tx.sentMode
        && (lastDecoratorDispatchHint.sentLimitTokens ?? null) === (tx.sentLimitTokens ?? null);
      return sameConv && sameMode;
    };

    // 1. WebSocket.prototype.send interceptor (覆盖 Lcc ws://<host>/connect-websocket JSON 帧)
    if (typeof window.WebSocket === 'function' && window.WebSocket.prototype && typeof window.WebSocket.prototype.send === 'function') {
      const origWsSend = window.WebSocket.prototype.send;
      window.__agOrigWsSend = origWsSend;
      window.WebSocket.prototype.send = function(data) {
        let nextData = data;
        let rec = null;
        try {
          if (typeof budgetEngine.transformOutgoingSendRequest === 'function') {
            const tx = budgetEngine.transformOutgoingSendRequest(data, buildInterceptorContext('ws_frame', this?.url || ''));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                nextData = tx.output;
              }
              captureSendCascadeContext(nextData);
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] WebSocket interceptor error:', err);
        }
        try {
          return origWsSend.call(this, nextData);
        } catch (wsErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, wsErr);
          throw wsErr;
        }
      };
    }

    function observeHostCsrfFromHeaders(headersObj, reqUrl) {
      try {
        if (!headersObj) return;
        let tok = '';
        if (typeof headersObj.get === 'function') {
          tok = headersObj.get('x-codeium-csrf-token') || headersObj.get('X-Codeium-Csrf-Token') || '';
        } else if (typeof headersObj === 'object') {
          tok = headersObj['x-codeium-csrf-token'] || headersObj['X-Codeium-Csrf-Token'] || '';
        }
        tok = String(tok || '').trim();
        if (!tok) return;
        if (reqUrl && typeof window !== 'undefined' && window.location?.origin) {
          const parsed = new URL(reqUrl, window.location.origin);
          if (parsed.origin !== window.location.origin) return;
        }
        if (typeof state === 'object' && state) state.observedCsrfToken = tok;
      } catch {}
    }

    // 2. window.fetch interceptor (仅处理 SendUserCascadeMessage；严禁猜测 StartCascade)
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.__agOrigFetch = origFetch;
      window.fetch = async function(resource, init) {
        let rec = null;
        try {
          const urlStr = typeof resource === 'string'
            ? resource
            : (resource && resource.url ? resource.url : String(resource || ''));
          observeHostCsrfFromHeaders(init?.headers || resource?.headers, urlStr);
          if (typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr) && init?.body) {
            captureSendCascadeContext(init.body);
            const headersObj = init?.headers;
            let contentType = '';
            if (headersObj) {
              if (typeof headersObj.get === 'function') {
                contentType = headersObj.get('content-type') || headersObj.get('Content-Type') || '';
              } else if (typeof headersObj === 'object') {
                contentType = headersObj['content-type'] || headersObj['Content-Type'] || '';
              }
            }
            const tx = budgetEngine.transformOutgoingSendRequest(init.body, buildInterceptorContext('fetch', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                init = { ...init, body: tx.output };
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] Fetch request interceptor error:', err);
        }
        try {
          const response = await origFetch.call(this, resource, init);
          if (rec && response && response.ok === false) {
            finishDispatchOutcome(rec.dispatchId, false, new Error(`HTTP ${response.status || 'error'}`));
          }
          return response;
        } catch (fetchErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, fetchErr);
          throw fetchErr;
        }
      };
    }

    // 3. window.XMLHttpRequest interceptor
    if (typeof window.XMLHttpRequest === 'function') {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSetHdr = window.XMLHttpRequest.prototype.setRequestHeader;
      const origSend = window.XMLHttpRequest.prototype.send;
      window.__agOrigXhrOpen = origOpen;
      window.__agOrigXhrSetHdr = origSetHdr;
      window.__agOrigXhrSend = origSend;

      window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          this.__agRequestUrl = typeof url === 'string' ? url : String(url || '');
          this.__agRequestHeaders = {};
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      if (typeof origSetHdr === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          try {
            if (this.__agRequestHeaders && typeof name === 'string') {
              this.__agRequestHeaders[name.toLowerCase()] = String(value || '');
            }
          } catch {}
          return origSetHdr.call(this, name, value);
        };
      }

      window.XMLHttpRequest.prototype.send = function(body) {
        let rec = null;
        try {
          const urlStr = this.__agRequestUrl || '';
          if (body && typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr)) {
            captureSendCascadeContext(body);
            const contentType = this.__agRequestHeaders?.['content-type'] || '';
            const tx = budgetEngine.transformOutgoingSendRequest(body, buildInterceptorContext('xhr', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                body = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] XHR request interceptor error:', err);
        }
        if (rec && typeof this.addEventListener === 'function') {
          const dId = rec.dispatchId;
          this.addEventListener('error', () => finishDispatchOutcome(dId, false, new Error('XHR network error')), { once: true });
          this.addEventListener('abort', () => finishDispatchOutcome(dId, false, Object.assign(new Error('XHR aborted'), { name: 'AbortError' })), { once: true });
          this.addEventListener('load', () => {
            if (typeof this.status === 'number' && this.status >= 400) {
              finishDispatchOutcome(dId, false, new Error(`HTTP ${this.status}`));
            }
          }, { once: true });
        }
        try {
          return origSend.call(this, body);
        } catch (xhrErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, xhrErr);
          throw xhrErr;
        }
      };
    }

    window.__agRequestInterceptorInstalled = true;
  }

  function uninstallRequestInterceptor() {
    if (typeof window === 'undefined') return;
    delete globalThis.__AG_METER_ON_SEND_MESSAGE__;
    delete globalThis.__AG_METER_ON_SEND_RESULT__;
    for (const tId of pendingConfirmTimers) clearTimeout(tId);
    pendingConfirmTimers.clear();
    if (window.__agOrigWsSend && window.WebSocket?.prototype) {
      window.WebSocket.prototype.send = window.__agOrigWsSend;
      delete window.__agOrigWsSend;
    }
    if (window.__agOrigFetch) {
      window.fetch = window.__agOrigFetch;
      delete window.__agOrigFetch;
    }
    if (window.__agOrigXhrOpen && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.open = window.__agOrigXhrOpen;
      delete window.__agOrigXhrOpen;
    }
    if (window.__agOrigXhrSetHdr && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.setRequestHeader = window.__agOrigXhrSetHdr;
      delete window.__agOrigXhrSetHdr;
    }
    if (window.__agOrigXhrSend && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.send = window.__agOrigXhrSend;
      delete window.__agOrigXhrSend;
    }
    window.__agRequestInterceptorInstalled = false;
  }

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

  function renderClientStatusBar() {
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

  // -----------------------------------------------------------------------
  // 速度对比分页与纯 SVG 图表渲染
  // -----------------------------------------------------------------------
  function isValidSpeedSampleSafe(c) {
    if (typeof isValidSpeedSample === 'function') return isValidSpeedSample(c);
    return Boolean(c && c.status === 'final' && !c.estimated && Number(c.outputTokens) > 0 && Number(c.durationSec) > 0 && Number(c.tps) > 0);
  }

  function mergeAvailableSpeedCalls() {
    const byId = new Map();
    const hist = Array.isArray(ANTIGRAVITY_TOKEN_DATA.speedRecords) ? ANTIGRAVITY_TOKEN_DATA.speedRecords : [];
    for (const r of hist) {
      if (r && r.callId) byId.set(r.callId, r);
    }
    const cur = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    for (const r of cur) {
      if (!r || !r.callId) continue;
      const prev = byId.get(r.callId);
      if (!prev || (!isValidSpeedSampleSafe(prev) && isValidSpeedSampleSafe(r)) || Number(r.outputTokens || 0) > Number(prev.outputTokens || 0)) {
        byId.set(r.callId, r);
      }
    }
    return Array.from(byId.values());
  }

  function createSvgEl(tag, attrs = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    const node = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
      : (typeof doc.createElement === 'function' ? doc.createElement(tag) : null);
    if (!node) return null;
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && typeof node.setAttribute === 'function') node.setAttribute(k, String(v));
    }
    return node;
  }

  function renderSpeedBarChart(groups) {
    const svg = el('speed-bar-svg');
    const wrap = el('speed-bar-chart-wrap');
    const emptyEl = el('speed-bar-empty');
    const tooltip = el('speed-bar-tooltip');
    const titleEl = el('speed-bar-title');

    const metricTitleMap = { tps: t('speed.barTitle.tps'), ttft: t('speed.barTitle.ttft'), duration: t('speed.barTitle.duration') };
    if (titleEl) titleEl.textContent = metricTitleMap[speedMetric] || t('speed.barTitle.tps');

    if (!groups.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const rowH = 34;
    const padTop = 8;
    const padBottom = 10;
    const labelW = 148;
    const valW = 86;
    const barAreaW = width - labelW - valW - 12;
    const height = padTop + padBottom + groups.length * rowH;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const getVal = g => speedMetric === 'ttft' ? g.medianTtft : speedMetric === 'duration' ? g.medianDuration : g.medianTps;
    const maxVal = Math.max(...groups.map(g => getVal(g) || 0), 0.1);

    const nodes = [];
    groups.forEach((g, idx) => {
      const y = padTop + idx * rowH;
      const val = getVal(g) || 0;
      const w = Math.max(4, (val / maxVal) * barAreaW);
      const effText = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
      const displayLabel = `${g.productLabel}${effText}`;
      const unitStr = speedMetric === 'tps' ? `${val} tok/s` : t('speed.unitSec', { val });

      const rowGrp = createSvgEl('g', { style: 'cursor:pointer' });
      const bgHit = createSvgEl('rect', { x: 0, y, width, height: rowH - 4, rx: 4, fill: 'transparent' });
      const dot = createSvgEl('circle', {
        cx: 7,
        cy: y + 14,
        r: 3.5,
        fill: VENDOR_DOT_COLORS[g.vendor] || '#8a8a94'
      });
      const lbl = createSvgEl('text', {
        x: 15,
        y: y + 18,
        fill: 'var(--ag-text-primary, #ececef)',
        'font-size': '10.5'
      });
      if (lbl) lbl.textContent = displayLabel.length > 20 ? displayLabel.slice(0, 19) + '…' : displayLabel;

      const track = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: barAreaW,
        height: 14,
        rx: 3,
        fill: 'var(--ag-track-bg, rgba(255,255,255,0.08))'
      });
      const bar = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: w.toFixed(1),
        height: 14,
        rx: 3,
        fill: VENDOR_DOT_COLORS[g.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        opacity: g.lowSample ? '0.45' : '0.92'
      });
      const valTxt = createSvgEl('text', {
        x: labelW + barAreaW + 6,
        y: y + 18,
        fill: g.lowSample ? 'var(--ag-text-muted, #8a8a94)' : 'var(--ag-text-secondary, #c8c8d0)',
        'font-size': '10'
      });
      if (valTxt) valTxt.textContent = `${unitStr}${g.lowSample ? ` ${t('speed.lowSample')}` : ''}`;

      if (rowGrp) {
        if (bgHit) rowGrp.appendChild(bgHit);
        if (dot) rowGrp.appendChild(dot);
        if (lbl) rowGrp.appendChild(lbl);
        if (track) rowGrp.appendChild(track);
        if (bar) rowGrp.appendChild(bar);
        if (valTxt) rowGrp.appendChild(valTxt);
        rowGrp.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const rangeTxt = g.minTs && g.maxTs
            ? `${formatMonthDayTime(g.minTs)} ~ ${formatMonthDayTime(g.maxTs)}`
            : '—';
          tooltip.innerHTML =
            `<strong>${displayLabel}</strong><br>` +
            `${t('speed.tip.samples', { n: g.count, low: g.lowSample ? t('models.card.lowSampleParen') : '' })}<br>` +
            `${t('speed.tip.timeRange', { range: rangeTxt })}<br>` +
            `${t('speed.tip.medOut', { val: fmt(g.medianOutputTokens) })}<br>` +
            `${t('speed.tip.medIn', { val: fmt(g.medianInputTokens) })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = `${Math.max(4, y - 4)}px`;
            tooltip.style.right = '8px';
          }
        });
        rowGrp.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        rowGrp.addEventListener?.('click', () => {
          selectedSpeedExactModelId = g.modelExactId;
          renderSpeedComparisonTab();
        });
        nodes.push(rowGrp);
      }
    });
    svg.replaceChildren(...nodes);
  }

  function renderSpeedLineChart(selectedGroup) {
    const svg = el('speed-line-svg');
    const wrap = el('speed-line-chart-wrap');
    const emptyEl = el('speed-line-empty');
    const tooltip = el('speed-line-tooltip');

    const samples = (selectedGroup?.samples || []).filter(s => s && s.tps > 0);
    if (!samples.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const height = 148;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const maxTps = Math.max(...samples.map(s => Number(s.tps) || 0), 10);
    const minTps = Math.max(0, Math.min(...samples.map(s => Number(s.tps) || 0)) * 0.8);
    const spanTps = Math.max(1, maxTps - minTps);

    const nodes = [];
    // Y 轴参考线与刻度
    [0, 0.5, 1].forEach(ratio => {
      const y = padT + plotH * (1 - ratio);
      const val = Math.round(minTps + spanTps * ratio);
      const grid = createSvgEl('line', {
        x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
        stroke: 'var(--ag-border-subtle, rgba(255,255,255,0.08))', 'stroke-width': 1
      });
      const txt = createSvgEl('text', {
        x: padL - 5, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5'
      });
      if (txt) txt.textContent = String(val);
      if (grid) nodes.push(grid);
      if (txt) nodes.push(txt);
    });

    const pts = samples.map((s, idx) => {
      const x = samples.length === 1 ? padL + plotW / 2 : padL + (idx / (samples.length - 1)) * plotW;
      const y = padT + plotH * (1 - ((Number(s.tps) - minTps) / spanTps));
      return { x, y, sample: s };
    });

    if (pts.length >= 2) {
      const dAttr = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const path = createSvgEl('path', {
        d: dAttr, fill: 'none',
        stroke: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        'stroke-width': 1.8
      });
      if (path) nodes.push(path);
    }

    pts.forEach((pt, idx) => {
      const circle = createSvgEl('circle', {
        cx: pt.x.toFixed(1),
        cy: pt.y.toFixed(1),
        r: 3.5,
        fill: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        stroke: 'var(--ag-bg-panel, #181818)',
        'stroke-width': 1.2,
        style: 'cursor:pointer'
      });
      if (circle) {
        circle.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const s = pt.sample;
          const originTxt = s.origin === 'speed-test' ? t('speed.originProbe') : t('speed.origin.chat');
          const ttftTxt = s.ttftSec != null ? t('speed.unitSec', { val: s.ttftSec }) : t('speed.unknown');
          tooltip.innerHTML =
            `<strong>${t('speed.tip.tpsLine', { idx: idx + 1, tps: s.tps })}</strong><br>` +
            `${t('speed.tip.time', { val: formatMonthDayTime(s.ts || s.createdAt) || '—' })}<br>` +
            `${t('speed.tip.output', { val: fmt(s.outputTokens) })}<br>` +
            `${t('speed.tip.ttft', { val: ttftTxt })}<br>` +
            `${t('speed.tip.origin', { val: originTxt })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = '6px';
            tooltip.style.right = '8px';
          }
        });
        circle.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        nodes.push(circle);
      }
    });

    const firstLbl = createSvgEl('text', { x: padL, y: height - 6, fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (firstLbl) firstLbl.textContent = formatMonthDayTime(samples[0].ts || samples[0].createdAt) || '#1';
    const lastLbl = createSvgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (lastLbl && samples.length > 1) lastLbl.textContent = formatMonthDayTime(samples[samples.length - 1].ts || samples[samples.length - 1].createdAt) || `#${samples.length}`;
    if (firstLbl) nodes.push(firstLbl);
    if (lastLbl) nodes.push(lastLbl);

    svg.replaceChildren(...nodes);
  }

  let lastSpeedGroups = [];

  function renderSpeedComparisonTab() {
    const mergedCalls = mergeAvailableSpeedCalls();
    const daysArg = speedRangeDays === 'all' ? 'all' : Number(speedRangeDays);
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
        days: daysArg,
        origin: speedOriginFilter,
        metric: speedMetric,
        cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
      })
      : [];
    lastSpeedGroups = groups;

    renderSpeedBarChart(groups);

    if (!selectedSpeedExactModelId || !groups.some(g => g.modelExactId === selectedSpeedExactModelId)) {
      selectedSpeedExactModelId = groups[0]?.modelExactId || null;
    }
    const chosenGroup = groups.find(g => g.modelExactId === selectedSpeedExactModelId) || null;
    const speedDropLabel = el('speed-model-dropdown-label');
    if (speedDropLabel) {
      if (chosenGroup) {
        const effStr = chosenGroup.effort ? ` (${formatEffortZh(chosenGroup.effort)})` : '';
        speedDropLabel.textContent = `${chosenGroup.productLabel}${effStr}`;
      } else {
        speedDropLabel.textContent = t('speed.lineNoModel');
      }
    }

    if (!speedModelDropdownCtrl && typeof initDropdownController === 'function' && el('speed-model-dropdown-wrap')) {
      speedModelDropdownCtrl = initDropdownController({
        wrapId: 'speed-model-dropdown-wrap',
        triggerId: 'speed-model-dropdown-trigger',
        labelId: 'speed-model-dropdown-label',
        menuId: 'speed-model-dropdown-menu',
        emptyLabel: () => t('speed.lineNoModel'),
        searchPlaceholder: () => t('dropdown.speedSearch'),
        emptyText: () => t('dropdown.speedEmpty'),
        getSelectedValue: () => selectedSpeedExactModelId || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          selectedSpeedExactModelId = val;
          renderSpeedComparisonTab();
        },
        getOptions: () => lastSpeedGroups.map(g => {
          const effStr = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
          return {
            value: g.modelExactId,
            label: `${g.productLabel}${effStr}`,
            displayRight: t('speed.samples', { n: g.count })
          };
        })
      });
    } else if (speedModelDropdownCtrl && typeof speedModelDropdownCtrl.refresh === 'function') {
      speedModelDropdownCtrl.refresh();
    }

    renderSpeedLineChart(chosenGroup);
  }

  const SPEED_RANGE_MAP = { 'speed-range-7d': '7', 'speed-range-30d': '30', 'speed-range-all': 'all' };
  const SPEED_ORIGIN_MAP = { 'speed-origin-all': 'all', 'speed-origin-chat': 'chat' };
  const SPEED_METRIC_MAP = { 'speed-metric-tps': 'tps', 'speed-metric-ttft': 'ttft', 'speed-metric-duration': 'duration' };

  function bindSpeedFilterGroup(map, onPick) {
    const ids = Object.keys(map);
    ids.forEach(id => {
      el(id)?.addEventListener('click', () => {
        const val = map[id];
        onPick(val);
        ids.forEach(k => setPillActive(el(k), map[k] === val));
        renderSpeedComparisonTab();
      });
    });
  }

  bindSpeedFilterGroup(SPEED_RANGE_MAP, v => { speedRangeDays = v; });
  bindSpeedFilterGroup(SPEED_ORIGIN_MAP, v => { speedOriginFilter = v; });
  bindSpeedFilterGroup(SPEED_METRIC_MAP, v => { speedMetric = v; });

  applyContextViewVisibility();

  const UNLOCK_POST_URL = 'https://linux.do/t/topic/3117832';
  let unlockToastTimer = null;

  function showUnlockToast(msg) {
    if (!unlockLinkToast) return;
    if (unlockToastTimer) clearTimeout(unlockToastTimer);
    unlockLinkToast.textContent = msg;
    unlockLinkToast.style.display = 'block';
    unlockToastTimer = setTimeout(() => {
      unlockLinkToast.style.display = 'none';
    }, 4500);
  }

  async function openUnlockAuthorPost() {
    let opened = false;
    try {
      if (window.contextMeterAPI?.openExternal) {
        const res = await window.contextMeterAPI.openExternal(UNLOCK_POST_URL);
        if (res && res.ok) opened = true;
      }
    } catch {}

    if (!opened) {
      try {
        const w = window.open(UNLOCK_POST_URL, '_blank');
        if (w) opened = true;
      } catch {}
    }

    if (opened) {
      showUnlockToast(t('models.linkOpened'));
    } else {
      copyUnlockPostUrl(true);
    }
  }

  function copyUnlockPostUrl(fromFailedOpen = false) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(UNLOCK_POST_URL);
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = UNLOCK_POST_URL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch {}
    }
    showUnlockToast(fromFailedOpen
      ? t('models.linkCopyFallback')
      : t('models.copyOk'));
  }

  linkUnlockAuthor?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openUnlockAuthorPost();
  });

  linkUnlockAuthor?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      void openUnlockAuthorPost();
    }
  });

  btnCopyUnlockLink?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyUnlockPostUrl(false);
  });

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
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (cardDrawerArrow && cardDrawerBody) {
        const open = cardDrawerBody.style.display === 'block';
        cardDrawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (unlockDrawerArrow && unlockDrawerBody) {
        const open = unlockDrawerBody.style.display === 'block';
        unlockDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch {}
    try { if (typeof applyTheme === 'function') applyTheme(); } catch {}
    try { renderVersionSyncBanner(); } catch {}
    try { render(); } catch {}
    try { renderHeaderModelDropdown(); } catch {}
    try { renderModelSettingsTab(); } catch {}
    try { renderSpeedComparisonTab(); } catch {}
    try { if (currentUnlockStatus) { renderClientStatusBar(); renderCompactSessionCard(); } } catch {}
    try { renderCliUnlockState(currentCliUnlockStatus); } catch {}
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      }
    } catch {}
    try {
      if (typeof renderEnhanceSectionUI === 'function') renderEnhanceSectionUI();
    } catch {}
    try {
      if (isChineseExpanded || isProxyExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView) {
        void refreshCliUnlockDisplay();
        if (typeof refreshEnhanceStatus === 'function') void refreshEnhanceStatus();
      }
    } catch {}
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
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

  // -------------------------------------------------------------
  // 模块 3: 推荐配置与客户端品牌控制器
  // -------------------------------------------------------------
  const btnEnhancePresetApply = el('btn-enhance-preset-apply');
  const btnEnhanceRestoreAll = el('btn-enhance-restore-all');
  const enhanceGlobalBadge = el('enhance-global-badge');
  const enhancePresetConfirm = el('enhance-preset-confirm');
  const enhanceConfirmTitle = el('enhance-preset-confirm-text');
  const btnEnhanceConfirmCancel = el('btn-enhance-confirm-cancel');
  const btnEnhanceConfirmGo = el('btn-enhance-confirm-go');
  const enhanceGlobalResult = el('enhance-global-result');
  const enhanceResultText = el('enhance-global-result-text');
  const enhanceResultActions = el('enhance-global-result-actions');
  const enhanceManualNote = el('enhance-global-manual-note');
  const btnEnhanceRestartHost = el('btn-enhance-restart-host');
  const btnEnhanceRestartLs = el('btn-enhance-restart-ls');

  const chkPresetLang = el('chk-rec-lang');
  const chkPresetCtx = el('chk-rec-ctx');

  const brandTitleBtns = {
    hakimi: el('btn-brand-hakimi'),
    translated: el('btn-brand-translated'),
    hidden: el('btn-brand-hidden'),
    english: el('btn-brand-english')
  };

  const btnApplyBrandTitle = el('btn-apply-brand-title');
  const brandApplyFeedback = el('brand-apply-feedback');

  let currentBrandTitle = 'hakimi';
  let currentEnhanceStatus = null;
  let pendingEnhanceConfirmMode = null; // 'preset' | 'restore' | null
  let isEnhanceBusy = false;
  let hasPendingLsReload = false;

  function syncBrandTitleButtons(mode = currentBrandTitle) {
    for (const [k, btn] of Object.entries(brandTitleBtns)) {
      if (!btn) continue;
      const active = k === mode;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
  }

  function renderEnhanceSectionUI() {
    syncBrandTitleButtons(currentBrandTitle);
    const data = currentEnhanceStatus;
    const s = data?.summary || data;
    const ctxUnlock = s?.contextUnlock || null;
    const isPatched = Boolean(
      ctxUnlock && ctxUnlock.status && ctxUnlock.status !== 'not_patched' && ctxUnlock.status !== 'unsupported'
    );

    if (enhanceGlobalBadge) {
      if (!data || !data.supported) {
        enhanceGlobalBadge.textContent = t('enhance.status.unread');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      } else if (isPatched) {
        enhanceGlobalBadge.textContent = t('enhance.status.patchedActive');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else {
        enhanceGlobalBadge.textContent = t('enhance.status.stock');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      }
    }
  }

  function showEnhanceResultBox(ok, message, opts = {}) {
    if (!enhanceGlobalResult || !enhanceResultText) return;
    enhanceGlobalResult.style.display = 'block';
    enhanceGlobalResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhanceResultText.textContent = message;
    const needLs = Boolean(opts.needsLsRestart);
    const needHost = Boolean(opts.needsHostRestart);
    const canRestartHost = Boolean(hostSupportsRestart);
    if (btnEnhanceRestartLs) btnEnhanceRestartLs.hidden = !needLs;
    if (btnEnhanceRestartHost) btnEnhanceRestartHost.hidden = !(needHost && canRestartHost);
    if (enhanceManualNote) enhanceManualNote.hidden = !(needHost && !canRestartHost);
    if (enhanceResultActions) enhanceResultActions.hidden = !(needLs || (needHost && canRestartHost));
  }

  async function refreshEnhanceStatus() {
    try {
      const res = await invokeEnhanceApi('status', {});
      if (res && res.ok && res.data) {
        currentEnhanceStatus = res.data;
      } else if (res && res.unavailable) {
        currentEnhanceStatus = { supported: false };
      }
    } catch {
      currentEnhanceStatus = null;
    }
    renderEnhanceSectionUI();
  }

  btnEnhancePresetApply?.addEventListener('click', () => {
    const selectedLabels = [];
    if (chkPresetLang?.checked) selectedLabels.push(t('enhance.preset.itemLang'));
    if (chkPresetCtx?.checked) selectedLabels.push(t('enhance.preset.itemCtx'));
    if (!selectedLabels.length) {
      showEnhanceResultBox(false, t('enhance.confirm.noneSelected'));
      return;
    }
    pendingEnhanceConfirmMode = 'preset';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.presetSummary', { items: selectedLabels.join('、') });
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceRestoreAll?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = 'restore';
    if (enhanceConfirmTitle) {
      enhanceConfirmTitle.textContent = t('enhance.confirm.restoreSummary');
    }
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
  });

  btnEnhanceConfirmCancel?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
  });

  btnEnhanceConfirmGo?.addEventListener('click', async () => {
    const mode = pendingEnhanceConfirmMode;
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
    if (!mode || isEnhanceBusy) return;

    isEnhanceBusy = true;
    try {
      const doneParts = [];
      const failedParts = [];
      const needsLsRestart = false;
      let needsHostRestart = false;

      if (mode === 'preset') {
        const wantLang = Boolean(chkPresetLang?.checked);
        const wantCtx = Boolean(chkPresetCtx?.checked);

        if (wantLang) {
          try {
            const lRes = await invokeModulesApi('toggle', 'chinese', true, {
              language: 'zh-CN',
              brandTitle: currentBrandTitle
            });
            if (!lRes || !lRes.ok) {
              throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
            }
            doneParts.push(t('enhance.preset.itemLang'));
            needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
          }
        }

        if (wantCtx) {
          try {
            const cRes = await invokeUnlockApi('apply', { mode: 'dynamic', limitTokens: null });
            if (!cRes || !cRes.ok) {
              throw new Error(buildFriendlyWriteError(cRes?.error));
            }
            doneParts.push(t('enhance.preset.itemCtx'));
            if (cRes.needsRestart) needsHostRestart = true;
          } catch (stepErr) {
            failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.unknownErr')}`);
          }
        }
      } else if (mode === 'restore') {
        try {
          const lRes = await invokeModulesApi('toggle', 'chinese', false, { language: 'en', brandTitle: 'english' });
          if (!lRes || !lRes.ok) {
            throw new Error(translateBackendText(lRes?.error) || t('mod.zh.toggleFail'));
          }
          currentBrandTitle = 'english';
          doneParts.push(t('enhance.preset.itemLang'));
          needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemLang')}: ${stepErr?.message || t('mod.zh.toggleFail')}`);
        }

        try {
          const cRes = await invokeUnlockApi('restore', {});
          if (!cRes || !cRes.ok) {
            throw new Error(buildFriendlyWriteError(cRes?.error));
          }
          doneParts.push(t('enhance.preset.itemCtx'));
          if (cRes.needsRestart) needsHostRestart = true;
        } catch (stepErr) {
          failedParts.push(`${t('enhance.preset.itemCtx')}: ${stepErr?.message || t('msg.restoreFail')}`);
        }
      }

      if (needsHostRestart) needsRestartAfterApply = true;

      if (failedParts.length > 0) {
        const msg = doneParts.length > 0
          ? t('enhance.result.partialFail', { done: doneParts.join('、'), failed: failedParts.join('；') })
          : t('enhance.result.fail', { err: failedParts.join('；') });
        showEnhanceResultBox(false, msg, { needsLsRestart, needsHostRestart });
      } else if (mode === 'preset') {
        showEnhanceResultBox(
          true,
          t('enhance.result.presetDone', { summary: doneParts.join('、') }),
          { needsLsRestart, needsHostRestart }
        );
      } else if (mode === 'restore') {
        showEnhanceResultBox(true, t('enhance.result.restoredDone'), { needsLsRestart, needsHostRestart: true });
      }
      await Promise.all([refreshEnhanceStatus(), refreshModulesDisplay(), refreshUnlockStatus()]);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.fail', { err: e?.message || t('msg.unknownErr') }));
    } finally {
      isEnhanceBusy = false;
    }
  });

  btnEnhanceRestartLs?.addEventListener('click', async () => {
    try {
      const res = await invokeEnhanceApi('restart-ls', {});
      if (!res || !res.ok) {
        showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      const killedCount = Array.isArray(res.killed) ? res.killed.length : (Number(res.killed) || 0);
      hasPendingLsReload = false;
      showEnhanceResultBox(true, t('enhance.result.lsRestarted', { killed: killedCount }), { needsLsRestart: false, needsHostRestart: needsRestartAfterApply });
      await refreshEnhanceStatus(false);
    } catch (e) {
      showEnhanceResultBox(false, t('enhance.result.lsRestartFail', { err: e?.message || t('msg.unknownErr') }));
    }
  });

  btnEnhanceRestartHost?.addEventListener('click', openClientRestartConfirmFlow);

  let selectedBrandTitle = currentBrandTitle;
  let brandObserver = null;

  function getBrandDisplayText(modeKey) {
    if (modeKey === 'hakimi') return '哈基米';
    if (modeKey === 'translated') return '反重力';
    if (modeKey === 'hidden') return '';
    return 'Antigravity';
  }

  function ensureBrandObserver(modeKey, targetBtn) {
    if (brandObserver) {
      try { brandObserver.disconnect(); } catch {}
      brandObserver = null;
    }
    if (!targetBtn || modeKey === 'english') return;
    const expected = getBrandDisplayText(modeKey);
    try {
      const container = targetBtn.parentElement || targetBtn;
      brandObserver = new MutationObserver(() => {
        const btn = document.querySelector('button[data-agy-brand-item="true"]') || targetBtn;
        if (!btn) return;
        const txt = btn.textContent?.trim() || '';
        if (txt !== expected) {
          btn.textContent = expected;
        }
      });
      brandObserver.observe(container, { childList: true, subtree: true, characterData: true });
    } catch {}
  }

  function applyBrandTitleToDom(modeKey) {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { found: false, applied: false, nodeText: null };
    }
    // 1. 优先通过持久化标记锁定曾确认过的品牌节点（确保隐藏清空文字后仍可精准识别与无损恢复）
    let targetBtn = document.querySelector('button[data-agy-brand-item="true"]');

    // 2. 若尚未标记，遍历所有 title-menu-bar-item 菜单按钮，精准仅匹配原文本或已知品牌文案节点
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const menuItems = document.querySelectorAll('button[data-testid="title-menu-bar-item"]');
      for (const btn of menuItems) {
        const txt = btn.textContent?.trim();
        if (txt === 'Antigravity' || txt === '反重力' || txt === '哈基米' || btn._agyBrandManaged) {
          targetBtn = btn;
          break;
        }
      }
    }

    // 3. 备选：极左上角区域（top <= 70 && left <= 300）候选定位
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const candidateBtns = document.querySelectorAll('button.agy-button, button[class*="agy-button"]');
      for (const btn of candidateBtns) {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { top: 0, left: 0 };
        if (rect.top <= 70 && rect.left <= 300) {
          const txt = btn.textContent?.trim();
          if (txt === 'Antigravity' || txt === '反重力' || txt === '哈基米' || btn._agyBrandManaged) {
            targetBtn = btn;
            break;
          }
        }
      }
    }

    if (!targetBtn) {
      return { found: false, applied: false, nodeText: null };
    }

    // 永久保留节点引用与原始身份标记，不顺带修改 document.title 或任务栏标题
    targetBtn.setAttribute('data-agy-brand-item', 'true');
    targetBtn._agyBrandManaged = true;
    if (!targetBtn._agyOriginalText) {
      targetBtn._agyOriginalText = 'Antigravity';
    }

    const expectedText = getBrandDisplayText(modeKey);

    const nodes = targetBtn.childNodes ? Array.from(targetBtn.childNodes) : (targetBtn.children || []);
    let textNode = null;
    for (const node of nodes) {
      if (node && node.nodeType === 3) {
        textNode = node;
        break;
      }
    }

    // 保留菜单入口可用（不设置 display: none，隐藏模式仅清空文字），确保菜单功能随时可点击
    targetBtn.style.display = '';
    if (textNode) {
      textNode.nodeValue = expectedText;
    } else {
      targetBtn.textContent = expectedText;
    }
    targetBtn.setAttribute('data-agy-brand-mode', modeKey);

    ensureBrandObserver(modeKey, targetBtn);

    const currentText = targetBtn.textContent?.trim() || '';
    const isApplied = (modeKey === 'hidden' ? currentText === '' : currentText === expectedText);

    return {
      found: true,
      applied: isApplied,
      nodeText: currentText
    };
  }

  function showBrandFeedback(mode, isSuccess = true, customMsg = '', isApplied = false) {
    if (!brandApplyFeedback) return;
    if (!isSuccess) {
      brandApplyFeedback.textContent = customMsg || t('msg.saveFail');
      brandApplyFeedback.style.color = '#ef4444';
      brandApplyFeedback.hidden = false;
      return;
    }
    const modeLabel = t(`enhance.brand.${mode}`) || mode;
    let msg = customMsg;
    if (!msg) {
      msg = isApplied
        ? `${t('enhance.brand.switched', { mode: modeLabel })}（已即时生效）`
        : `${t('enhance.brand.switched', { mode: modeLabel })}（未检测到目标，${t('models.status.pendingRestart')}）`;
    }
    brandApplyFeedback.textContent = msg;
    if (!isApplied) {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'unlock-btn unlock-btn-secondary';
      rBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;cursor:pointer;';
      rBtn.textContent = t('models.btnRestartHost');
      rBtn.addEventListener('click', () => openClientRestartConfirmFlow());
      brandApplyFeedback.appendChild(rBtn);
    }
    brandApplyFeedback.style.color = isApplied ? '#10b981' : 'var(--ag-text-primary)';
    brandApplyFeedback.hidden = false;
  }

  async function applyBrandTitleSetting(modeKey) {
    try {
      const res = await invokeModulesApi('toggle', 'chinese', currentChineseEnabled, {
        language: currentChineseEnabled ? 'zh-CN' : 'en',
        brandTitle: modeKey
      });
      if (!res || !res.ok) {
        const err = translateBackendText(res?.error) || t('msg.saveFail');
        showBrandFeedback(modeKey, false, err, false);
        showEnhanceResultBox(false, err);
        return;
      }
      currentBrandTitle = modeKey;
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);

      // 实时真实 DOM 应用
      const domResult = applyBrandTitleToDom(modeKey);

      // 实时热同步（若已注入运行时环境）
      try {
        if (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__) {
          window.__AGY_I18N_CONFIG__.brandTitle = modeKey;
          if (typeof window.__AGY_RUN_FULL_SCAN__ === 'function') {
            window.__AGY_RUN_FULL_SCAN__();
          }
        }
      } catch {}

      const modeLabel = t(`enhance.brand.${modeKey}`) || modeKey;
      if (domResult.applied) {
        const appliedMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（左上角品牌已切换为：${modeLabel}）`;
        showBrandFeedback(modeKey, true, appliedMsg, true);
        showEnhanceResultBox(true, appliedMsg, { needsHostRestart: false });
      } else {
        const pendingMsg = `${t('enhance.brand.switched', { mode: modeLabel })}（当前窗口未检测到品牌节点，重启客户端后生效）`;
        showBrandFeedback(modeKey, true, pendingMsg, false);
        showEnhanceResultBox(true, pendingMsg, { needsHostRestart: true });
      }
    } catch (e) {
      const err = e?.message || t('msg.saveFail');
      showBrandFeedback(modeKey, false, err, false);
      showEnhanceResultBox(false, err);
    }
  }

  for (const [modeKey, btn] of Object.entries(brandTitleBtns)) {
    btn?.addEventListener('click', () => {
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);
      void applyBrandTitleSetting(modeKey);
    });
  }

  btnApplyBrandTitle?.addEventListener('click', () => {
    void applyBrandTitleSetting(selectedBrandTitle || currentBrandTitle);
  });

  let lastVersionSyncState = null;

  function renderVersionSyncBanner(vs = lastVersionSyncState) {
    const banner = el('version-sync-banner');
    const textEl = el('version-sync-text');
    if (!banner || !textEl) return;
    if (vs && vs.outdated && vs.officialVersion && vs.hakimiVersion) {
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
      currentBrandTitle = cfg.modules?.chinese?.brandTitle || 'hakimi';
      syncBrandTitleButtons(currentBrandTitle);
      applyBrandTitleToDom(currentBrandTitle);
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
        language: wantChinese ? 'zh-CN' : 'en',
        brandTitle: currentBrandTitle
      });
      if (!res || !res.ok) {
        showEnhanceResultBox(false, translateBackendText(res?.error) || t('mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, `${t('mod.zh.toggleFail')}: ${e.message}`);
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
    const hooks = [d.offersContextWindow, d.autoCompactEnv, d.regionUnlock].filter(
      h => h && h.status && h.status !== 'missing'
    );
    const patchedCount = hooks.filter(h => h.status === 'patched').length;
    const totalCount = hooks.length;

    if (d.status === 'patched') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.patched', { ok: patchedCount, total: totalCount || 1 });
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
    if (d.configStatus?.configContextWindow) {
      metaParts.push(`config: ${d.configStatus.configContextWindow}`);
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
      const res = await invokeCliUnlockApi('apply', { mode: 'dynamic' });
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
          const syncN = Array.isArray(res.syncedConfigs) ? res.syncedConfigs.length : 0;
          cliUnlockResultText.textContent = syncN > 0
            ? `${res.message || ''} (${t('settings.cliUnlock.metaCfg', { n: syncN })})`
            : (res.message || t('msg.applied'));
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

  // 静默初始化检测一次解锁状态与各模块状态
  setTimeout(() => {
    void refreshUnlockStatus();
    void refreshModulesDisplay();
    void refreshCliUnlockDisplay();
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

  // 二级抽屉 2（面板 B 内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 模型卡片下一层详情折叠展开（实测预算、速度与内部详情）
  const btnCardDetails = el('btn-toggle-card-details');
  const cardDrawerBody = el('ctx-card-drawer-body');
  const cardDrawerArrow = el('ctx-card-drawer-arrow');
  btnCardDetails?.addEventListener('click', () => {
    if (!cardDrawerBody) return;
    const isHidden = cardDrawerBody.style.display === 'none' || !cardDrawerBody.style.display;
    cardDrawerBody.style.display = isHidden ? 'block' : 'none';
    if (cardDrawerArrow) cardDrawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnCardDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 3（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
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
  }

  function switchHeatView(view, save = true) {
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
    renderActiveHeatView(true);
    updateHeatTabThumb();

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

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    const twpPop = el('topbar-window-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      closeTopbarWindowPopover();
      toggle(false);
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    if (twpPop && !twpPop.hidden && !path.includes(twpPop) && !path.includes(el('btn-topbar-window'))) {
      closeTopbarWindowPopover();
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
      const twpPop = el('topbar-window-popover');
      if (twpPop && !twpPop.hidden) {
        closeTopbarWindowPopover();
        el('btn-topbar-window')?.focus?.();
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
          contextPreferences: { ...contextPreferencesMap }
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

  function renderHeatmapGrid(forceRebuild = false) {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || !monthsBox) return;
    const win = computeTimelineWindow();
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}`;
    if (!forceRebuild && colsBox.children.length > 0 && colsBox.getAttribute('data-sig') === sig) return;

    colsBox.replaceChildren();
    monthsBox.replaceChildren();
    colsBox.setAttribute('data-sig', sig);

    const todayKey = formatLocalYmd(win.today);
    const list = [];
    for (let i = 0; i < win.totalDays; i++) {
      const d = addDays(win.winStart, i);
      const key = formatLocalYmd(d);
      const isFuture = d.getTime() > win.today.getTime();
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      list.push({ date: d, key, tokens: rec ? rec.total : 0, rec, isFuture, isToday: key === todayKey });
    }

    const monthMarkers = [];
    let lastM = -1;
    let lastCol = -10;

    for (let c = 0; c < 52; c++) {
      const col = document.createElement('div');
      col.className = 'heat-week-col';
      const slice = list.slice(c * 7, (c + 1) * 7);
      const mNum = slice[0].date.getMonth() + 1;
      if (mNum !== lastM) {
        if (c - lastCol >= 3 && 52 - c >= 2) {
          monthMarkers.push({ month: mNum, colIdx: c });
          lastCol = c;
        }
        lastM = mNum;
      }

      slice.forEach(item => {
        const cell = document.createElement('div');
        const lvl = getLvl(item.tokens);
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isToday ? ' is-today' : ''}`;
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));

        const showPop = () => {
          const d = item.date;
          const dateLabel = currentPanelLanguage === 'en'
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
          heatPopDate.textContent = `${dateLabel}${item.isToday ? t('heat.today') : (item.key === win.firstStr ? t('heat.firstUse') : '')}`;
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens` : (item.isFuture ? t('heat.future') : '0 Tokens');
          if (item.rec) {
            const dayCacheTotal = (Number(item.rec.input) || 0) + (Number(item.rec.cache) || 0);
            const dayCachePct = dayCacheTotal > 0 ? ` (${((Number(item.rec.cache) / dayCacheTotal) * 100).toFixed(1)}%)` : '';
            heatPopDet.innerHTML = `
              <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(item.rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(item.rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(item.rec.cache)}${dayCachePct}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
            `.trim();
            heatPopDet.style.display = 'flex';
          } else {
            heatPopDet.style.display = 'none';
          }
          const r = cell.getBoundingClientRect();
          heatPop.style.left = `${r.left + r.width / 2}px`;
          heatPop.style.top = `${r.top - 6}px`;
          heatPop.style.opacity = '1';
        };

        cell.addEventListener('mouseenter', showPop);
        cell.addEventListener('mouseleave', hidePopover);
        cell.addEventListener('click', showPop);

        col.appendChild(cell);
      });
      colsBox.appendChild(col);
    }

    const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 13}px`;
      lbl.textContent = currentPanelLanguage === 'en' ? (shortMonthsEn[mm.month - 1] || `${mm.month}`) : `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });

    updateSummaryBar('daily', list.map(x => x.key));
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.replaceChildren();

    const scale = getEffectiveHeatmapScale();
    const [cEmpty, c1, c2, c3, c4] = scale;
    const win = computeTimelineWindow();
    const totalWeeks = 52;
    const weeksData = [];
    let max = 1;

    for (let c = 0; c < totalWeeks; c++) {
      let sum = 0;
      let sDate = null, eDate = null;
      for (let r = 0; r < 7; r++) {
        const d = addDays(win.winStart, c * 7 + r);
        const k = formatLocalYmd(d);
        if (!sDate) sDate = d;
        eDate = d;
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) sum += rec.total;
      }
      if (sum > max) max = sum;
      weeksData.push({ sum, sDate, eDate, startKey: formatLocalYmd(sDate) });
    }

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      col.setAttribute('data-week-start', w.startKey);
      const fill = document.createElement('div');
      fill.className = 'w-bar-fill';
      const pct = Math.max(3, (w.sum / max) * 100);
      fill.style.height = `${pct}%`;
      const lvl = getLvlForRange(w.sum, 'week', max);
      fill.style.backgroundColor = w.sum === 0 ? cEmpty : (scale[lvl] || c4);
      col.appendChild(fill);

      const showPop = () => {
        const weekDates = [];
        for (let r = 0; r < 7; r++) weekDates.push(formatLocalYmd(addDays(w.sDate, r)));
        const tokAgg = calculateIntervalTokens(ANTIGRAVITY_TOKEN_DATA.dailyMap, weekDates, {
          todayStr: formatLocalYmd(win.today)
        });
        heatPopDate.textContent = `${w.sDate.getFullYear()}.${w.sDate.getMonth() + 1}.${w.sDate.getDate()} - ${w.eDate.getMonth() + 1}.${w.eDate.getDate()}`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens` : '0 Tokens';
        heatPopDet.innerHTML = `<span>${t('heat.weeklyTotal', { avg: fmtYi(tokAgg.dailyAverageTokens) })}</span>`;
        heatPopDet.style.display = 'block';
        const r = col.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      col.addEventListener('mouseenter', showPop);
      col.addEventListener('mouseleave', hidePopover);
      col.addEventListener('click', showPop);

      box.appendChild(col);
    });

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('weekly', allWinDates);
  }

  function renderHeatmapCum() {
    const cvs = el('h-cum-canvas');
    if (!cvs || !cvs.getContext) return;
    const ctx = cvs.getContext('2d');
    const rect = cvs.getBoundingClientRect ? cvs.getBoundingClientRect() : { width: 670 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = (rect.width || 670);
    const height = 100;
    cvs.width = width * dpr;
    cvs.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const win = computeTimelineWindow();
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const winStartKey = formatLocalYmd(win.winStart);
    // 计算窗口起点之前的历史滚存基数（支持跨年翻页时累计曲线连续）
    let running = 0;
    for (const [k, rec] of Object.entries(map)) {
      if (k < winStartKey && rec?.total > 0) running += rec.total;
    }

    const activeEnd = win.winEnd.getTime() > win.today.getTime() ? win.today : win.winEnd;
    const plotDays = Math.max(1, Math.floor((activeEnd.getTime() - win.winStart.getTime()) / 86400000) + 1);
    const points = [];

    for (let i = 0; i < plotDays; i++) {
      const d = addDays(win.winStart, i);
      const k = formatLocalYmd(d);
      const rec = map[k];
      if (rec) running += rec.total;
      points.push({ date: d, key: k, val: running });
    }

    const max = running || 1;
    const denom = Math.max(1, points.length - 1);
    const step = points.length === 1 ? width : (width / denom);

    const scale = getEffectiveHeatmapScale();
    const strokeColor = customColors.tokenAccent || scale[4];
    const strokeRgb = hexToRgb(normalizeHex(strokeColor)) || { r: 192, g: 132, b: 252 };
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.36)`);
    grad.addColorStop(1, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.02)`);

    ctx.beginPath();
    ctx.moveTo(0, height);
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? width / 2 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.lineTo(width, height);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? 0 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const idx = points.length === 1 ? 0 : Math.min(points.length - 1, Math.max(0, Math.round(mouseX / step)));
      const pt = points[idx];
      const cumDates = [];
      for (const k of Object.keys(map)) {
        if (k <= pt.key) cumDates.push(k);
      }
      const tokAgg = calculateIntervalTokens(map, cumDates, {
        todayStr: formatLocalYmd(win.today)
      });
      const cumDateLabel = currentPanelLanguage === 'en'
        ? `${pt.date.getFullYear()}-${String(pt.date.getMonth() + 1).padStart(2, '0')}-${String(pt.date.getDate()).padStart(2, '0')}`
        : `${pt.date.getFullYear()}年${pt.date.getMonth() + 1}月${pt.date.getDate()}日`;
      heatPopDate.textContent = `${cumDateLabel}${t('heat.cumSuffix')}`;
      heatPopVal.textContent = `${fmtYi(pt.val)} Tokens`;
      heatPopDet.innerHTML = `<span>${t('heat.cumTotal', { avg: fmtYi(tokAgg.dailyAverageTokens) })}</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 12)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('cum', allWinDates);
  }

  function updateSummaryBar(viewType, dateKeys = []) {
    const sumTokensEl = el('h-sum-tokens');
    const sumDailyAvgEl = el('h-sum-daily-avg');
    const sumActiveAvgEl = el('h-sum-active-avg');
    if (!sumTokensEl) return;

    const win = computeTimelineWindow();
    const todayStr = formatLocalYmd(win.today);
    const tokAgg = calculateIntervalTokens(ANTIGRAVITY_TOKEN_DATA.dailyMap, dateKeys, { todayStr });

    sumTokensEl.textContent = `${fmtYi(tokAgg.totalTokens)} Tokens`;
    if (sumDailyAvgEl) sumDailyAvgEl.textContent = `${fmtYi(tokAgg.dailyAverageTokens)} Tokens`;
    if (sumActiveAvgEl) sumActiveAvgEl.textContent = t('heat.activeDays', { avg: fmtYi(tokAgg.activeDailyAverageTokens), days: tokAgg.activeDays });
    const sumCacheRateEl = el('h-sum-cache-rate');
    if (sumCacheRateEl) {
      sumCacheRateEl.textContent = tokAgg.cacheHitRate != null ? `${tokAgg.cacheHitRate.toFixed(1)}%` : '--%';
    }
  }

  function renderHeatmapMonthly() {
    const box = el('h-monthly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const todayKey = formatLocalYmd(today);

    // 计算当前所选月 (按 heatMonthOffset 自然月偏移)
    const targetDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

    const gap = 5;
    let bestR = 1, bestC = daysInMonth, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(daysInMonth / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    bestS = Math.floor(bestS);
    const showDayNum = bestS >= 22;

    const grid = document.createElement('div');
    grid.className = 'heat-month-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${bestC}, ${bestS}px)`;
    grid.style.gridAutoRows = `${bestS}px`;
    grid.style.gap = `${gap}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
    grid.style.height = `${H}px`;

    const dateKeys = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth, day);
      const k = formatLocalYmd(d);
      dateKeys.push(k);
      const isFuture = d.getTime() > today.getTime();
      const isToday = k === todayKey;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      const tokens = rec ? rec.total : 0;
      const lvl = getLvl(tokens);

      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isToday ? ' is-today' : ''}`;
      cell.style.width = `${bestS}px`;
      cell.style.height = `${bestS}px`;
      cell.style.backgroundColor = scale[lvl];
      cell.setAttribute('data-date', k);
      cell.setAttribute('data-tokens', String(tokens));

      if (showDayNum) {
        const numSpan = document.createElement('span');
        numSpan.className = 'heat-month-cell-num';
        numSpan.textContent = String(day);
        cell.appendChild(numSpan);
      }

      const showPop = () => {
        const mDateLabel = currentPanelLanguage === 'en'
          ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          : `${targetYear}年${targetMonth + 1}月${day}日`;
        heatPopDate.textContent = `${mDateLabel}${isToday ? t('heat.today') : ''}`;
        heatPopVal.textContent = tokens > 0 ? `${fmtYi(tokens)} Tokens` : (isFuture ? t('heat.future') : '0 Tokens');
        if (rec) {
          const mCacheTotal = (Number(rec.input) || 0) + (Number(rec.cache) || 0);
          const mCachePct = mCacheTotal > 0 ? ` (${((Number(rec.cache) / mCacheTotal) * 100).toFixed(1)}%)` : '';
          heatPopDet.innerHTML = `
            <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(rec.cache)}${mCachePct}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
          `.trim();
          heatPopDet.style.display = 'flex';
        } else {
          heatPopDet.style.display = 'none';
        }
        const r = cell.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      cell.addEventListener('mouseenter', showPop);
      cell.addEventListener('mouseleave', hidePopover);
      cell.addEventListener('click', showPop);

      grid.appendChild(cell);
    }

    box.appendChild(grid);
    updateSummaryBar('monthly', dateKeys);
  }

  function renderHeatmapYearly() {
    const box = el('h-yearly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const thisYear = today.getFullYear();
    const thisMonth = today.getMonth();
    const targetYear = thisYear + heatYearOffset;

    const monthsData = [];
    const allYearDates = [];
    let maxMonthTokens = 1;

    for (let m = 0; m < 12; m++) {
      const daysCount = new Date(targetYear, m + 1, 0).getDate();
      let mTokens = 0;
      const mDates = [];
      for (let d = 1; d <= daysCount; d++) {
        const dateObj = new Date(targetYear, m, d);
        const k = formatLocalYmd(dateObj);
        mDates.push(k);
        allYearDates.push(k);
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) mTokens += rec.total;
      }
      const isCurrent = (targetYear === thisYear && m === thisMonth);
      const isFuture = (targetYear > thisYear || (targetYear === thisYear && m > thisMonth));
      if (!isFuture && mTokens > maxMonthTokens) {
        maxMonthTokens = mTokens;
      }
      const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      monthsData.push({
        monthIndex: m,
        monthName: currentPanelLanguage === 'en' ? (shortMonthsEn[m] || `${m + 1}`) : `${m + 1}月`,
        tokens: mTokens,
        dates: mDates,
        isCurrent,
        isFuture
      });
    }

    const createSvgNode = tag => {
      if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
        return document.createElementNS('http://www.w3.org/2000/svg', tag);
      }
      return document.createElement(tag);
    };

    const svg = createSvgNode('svg');
    svg.setAttribute('class', 'heat-yearly-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    const Rmin = 6;
    const Rmax = 24;
    const colW = W / 12;
    const cy = 42;

    let peakMonthIndex = -1;
    let peakTokens = 0;
    monthsData.forEach(item => {
      if (!item.isFuture && item.tokens > peakTokens) {
        peakTokens = item.tokens;
        peakMonthIndex = item.monthIndex;
      }
    });

    monthsData.forEach((item, idx) => {
      const cx = colW * idx + colW / 2;
      const g = createSvgNode('g');
      g.setAttribute('class', 'heat-yearly-bubble-group');
      g.style.animationDelay = `${idx * 20}ms`;

      let radius = Rmin;
      if (!item.isFuture && item.tokens > 0) {
        const ratio = Math.sqrt(item.tokens / maxMonthTokens);
        radius = Rmin + ratio * (Rmax - Rmin);
      }

      const lvl = item.isFuture ? 0 : getLvlForRange(item.tokens, 'month', maxMonthTokens);
      const fillCol = item.isFuture ? 'transparent' : (scale[lvl] || scale[0]);

      const circle = createSvgNode('circle');
      circle.setAttribute('class', 'bubble-main');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', fillCol);
      circle.setAttribute('stroke', item.isFuture ? 'rgba(255,255,255,0.18)' : (item.monthIndex === peakMonthIndex ? 'var(--ag-text-primary)' : 'rgba(255,255,255,0.08)'));
      circle.setAttribute('stroke-width', item.monthIndex === peakMonthIndex ? '2' : '1');

      if (item.isFuture) {
        circle.setAttribute('stroke-dasharray', '2,2');
      }

      g.appendChild(circle);

      if (item.isCurrent) {
        const activeRing = createSvgNode('circle');
        activeRing.setAttribute('cx', String(cx));
        activeRing.setAttribute('cy', String(cy));
        activeRing.setAttribute('r', String(radius + 4));
        activeRing.setAttribute('fill', 'none');
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        activeRing.setAttribute('stroke-width', '1.5');
        activeRing.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(activeRing);
      }

      if (item.monthIndex === peakMonthIndex && item.tokens > 0) {
        const peakBadge = createSvgNode('text');
        peakBadge.setAttribute('x', String(cx));
        peakBadge.setAttribute('y', String(cy - radius - 5));
        peakBadge.setAttribute('text-anchor', 'middle');
        peakBadge.setAttribute('font-size', '8.5');
        peakBadge.setAttribute('font-weight', '600');
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        peakBadge.textContent = t('heat.peak');
        g.appendChild(peakBadge);
      }

      const text = createSvgNode('text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(H - 12));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', item.isCurrent ? 'var(--ag-text-primary)' : 'var(--ag-text-muted)');
      text.setAttribute('font-weight', item.isCurrent ? '600' : '400');
      text.textContent = item.monthName;
      g.appendChild(text);

      const showPop = () => {
        const tokAgg = calculateIntervalTokens(ANTIGRAVITY_TOKEN_DATA.dailyMap, item.dates, {
          todayStr: formatLocalYmd(win.today)
        });
        const yearMonthLabel = currentPanelLanguage === 'en' ? `${item.monthName} ${targetYear}` : `${targetYear}年${item.monthName}`;
        heatPopDate.textContent = `${yearMonthLabel}${item.isCurrent ? t('heatmap.pop.inProgress') : (item.monthIndex === peakMonthIndex ? t('heatmap.pop.peak') : '')}`;
        heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens` : (item.isFuture ? t('heatmap.pop.future') : '0 Tokens');
        heatPopDet.innerHTML = `<span>${t('heatmap.pop.monthlyDet', { avg: fmtYi(tokAgg.dailyAverageTokens), days: tokAgg.activeDays })}</span>`;
        heatPopDet.style.display = 'block';

        const r = g.getBoundingClientRect ? g.getBoundingClientRect() : { left: cx, top: cy, width: radius * 2 };
        heatPop.style.left = `${r.left + (r.width || 0) / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      g.addEventListener('mouseenter', showPop);
      g.addEventListener('mouseleave', hidePopover);
      g.addEventListener('click', showPop);

      svg.appendChild(g);
    });

    box.appendChild(svg);
    updateSummaryBar('yearly', allYearDates);
  }

  // 初始化首次使用日与时间轴显示并触发后台完整历史同步
  computeTimelineWindow();
  void syncTokenHistoryFromHost();

  // 统一生成徽章、悬浮提示与速览卡片的状态数据
  function resolveDisplayStatus(d, session) {
    const ec = d?.errorClassification;
    let kind = ec?.kind || (d?.exceeded ? 'context_overflow' : d?.network ? 'network_error' : d?.error ? 'unknown' : 'none');

    // 如果没有显示分类但存在明确标志
    if (d?.exceeded) kind = 'context_overflow';

    if (kind === 'context_overflow' || d?.exceeded) {
      const sLimit = d?.serviceLimit || ec?.serviceLimit;
      const limStatus = sLimit ? t('diag.ctx.statusLim', { lim: short(sLimit) }) : '';
      const limTakeaway = sLimit ? t('diag.ctx.statusLim', { lim: fmt(sLimit) }) : '';
      return {
        kind: 'context_overflow',
        badgeText: t('diag.ctx.badge'),
        amountText: t('diag.ctx.amount'),
        keyBadgeText: t('diag.ctx.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.ctx.hover'),
        tipTitle: t('diag.ctx.tipTitle'),
        tipPct: t('diag.ctx.tipPct'),
        tipDetail: sLimit ? t('diag.ctx.tipDetailLim', { lim: fmtBubbleToken(sLimit) }) : t('diag.ctx.tipDetailDef'),
        statusText: t('diag.ctx.status', { lim: limStatus }),
        keyTakeaway: t('diag.ctx.takeaway', { lim: limTakeaway }),
        isError: true,
        isOverflow: true
      };
    }

    if (kind === 'quota_exhausted') {
      const pool = ec?.modelOrPool || d?.model || t('diag.quota.defPool');
      const resetStr = ec?.resetTimeZh ? t('diag.quota.reset', { time: ec.resetTimeZh }) : '';
      return {
        kind: 'quota_exhausted',
        badgeText: t('diag.quota.badge'),
        amountText: t('diag.quota.amount'),
        keyBadgeText: t('diag.quota.badge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.quota.hover'),
        tipTitle: t('diag.quota.tipTitle'),
        tipPct: t('diag.quota.tipPct'),
        tipDetail: t('diag.quota.tipDetail', { pool, reset: resetStr }),
        statusText: t('diag.quota.status', { pool, reset: resetStr }),
        keyTakeaway: t('diag.quota.takeaway', { pool, reset: resetStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'rate_limited') {
      const retryStr = ec?.retryAfterSec ? t('diag.rate.retry', { sec: ec.retryAfterSec }) : '';
      return {
        kind: 'rate_limited',
        badgeText: t('diag.rate.badge'),
        amountText: t('diag.rate.amount'),
        keyBadgeText: t('diag.rate.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.rate.hover'),
        tipTitle: t('diag.rate.tipTitle'),
        tipPct: t('diag.rate.tipPct'),
        tipDetail: t('diag.rate.tipDetail', { retry: retryStr }),
        statusText: t('diag.rate.status', { retry: retryStr }),
        keyTakeaway: t('diag.rate.takeaway', { retry: retryStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'network_error' || d?.network) {
      const cleanDiag = ec?.diagnostic || t('diag.net.defDiag');
      return {
        kind: 'network_error',
        badgeText: t('diag.net.badge'),
        amountText: t('diag.net.amount'),
        keyBadgeText: t('diag.net.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.net.hover'),
        tipTitle: t('diag.net.tipTitle'),
        tipPct: t('diag.net.tipPct'),
        tipDetail: t('diag.net.tipDetail', { diag: cleanDiag }),
        statusText: t('diag.net.status', { diag: cleanDiag }),
        keyTakeaway: t('diag.net.takeaway', { diag: cleanDiag }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'auth_error') {
      return {
        kind: 'auth_error',
        badgeText: t('diag.auth.badge'),
        amountText: t('diag.auth.amount'),
        keyBadgeText: t('diag.auth.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.auth.hover'),
        tipTitle: t('diag.auth.tipTitle'),
        tipPct: t('diag.auth.tipPct'),
        tipDetail: t('diag.auth.tipDetail'),
        statusText: t('diag.auth.status'),
        keyTakeaway: t('diag.auth.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'service_unavailable') {
      return {
        kind: 'service_unavailable',
        badgeText: t('diag.svc.badge'),
        amountText: t('diag.svc.amount'),
        keyBadgeText: t('diag.svc.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.svc.hover'),
        tipTitle: t('diag.svc.tipTitle'),
        tipPct: t('diag.svc.tipPct'),
        tipDetail: t('diag.svc.tipDetail'),
        statusText: t('diag.svc.status'),
        keyTakeaway: t('diag.svc.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'canceled') {
      return {
        kind: 'canceled',
        badgeText: t('diag.cancel.badge'),
        amountText: t('diag.cancel.amount'),
        keyBadgeText: t('diag.cancel.badge'),
        pillClass: 'key-pill pill-muted',
        hoverExtra: t('diag.cancel.hover'),
        tipTitle: t('diag.cancel.tipTitle'),
        tipPct: t('diag.cancel.tipPct'),
        tipDetail: t('diag.cancel.tipDetail'),
        statusText: t('diag.cancel.status'),
        keyTakeaway: t('diag.cancel.takeaway'),
        isError: false,
        isOverflow: false
      };
    }

    if (d?.error) {
      const diag = ec?.diagnostic || d.error;
      return {
        kind: 'unknown',
        badgeText: t('diag.unknown.badge'),
        amountText: t('diag.unknown.amount'),
        keyBadgeText: t('diag.unknown.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.unknown.hover'),
        tipTitle: t('diag.unknown.tipTitle'),
        tipPct: t('diag.unknown.tipPct'),
        tipDetail: t('diag.unknown.tipDetail', { diag }),
        statusText: t('diag.unknown.status', { diag }),
        keyTakeaway: t('diag.unknown.takeaway', { diag }),
        isError: true,
        isOverflow: false
      };
    }

    return {
      kind: 'none',
      badgeText: '',
      amountText: '',
      keyBadgeText: '',
      pillClass: 'key-pill pill-good',
      hoverExtra: '',
      tipTitle: '',
      tipPct: '',
      tipDetail: '',
      statusText: '',
      keyTakeaway: '',
      isError: false,
      isOverflow: false
    };
  }


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
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  renderEnhanceSectionUI();
  void restoreSettingsFromHost();
  installRequestInterceptor();
  render();
  tick();
})();

