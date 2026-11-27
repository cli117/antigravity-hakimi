  // =========================================================================
  // 侧边栏会话行原生悬停操作条一键 Fork 按钮模块
  // - 仅做纯本地 DOM 挂载与官方本地 LanguageServerService/ForkConversation 调用
  // - 挂载位置：未归档、非 Battle 模式的 [data-testid="conversation-row-sidebar"] 内 .agy-row-actions 最左侧
  // =========================================================================
  const SIDEBAR_FORK_STYLE_ID = 'ag-sidebar-fork-style';
  const SIDEBAR_FORK_TOOLTIP_ID = 'ag-sidebar-fork-tooltip';
  const SIDEBAR_FORK_BTN_ATTR = 'data-hakimi-fork';
  const SIDEBAR_FORK_UUID_RE = /^[a-f\d-]{36}$/i;
  const SIDEBAR_FORK_FALLBACK_CLASS =
    'agy-button agy-button-icon inline-flex items-center justify-center font-medium transition-colors select-none outline-none cursor-pointer disabled:opacity-50 bg-transparent text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:text-foreground focus-visible:bg-secondary h-6 w-6 shrink-0 flex rounded-md';
  const SIDEBAR_FORK_TOOLTIP_CLASS =
    'compact-tooltip surface-glass bg-card text-secondary-foreground border border-border rounded-md px-2 py-1 text-sm leading-[1.4] select-none pointer-events-none';

  const SIDEBAR_FORK_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="18" r="2.4"></circle>' +
    '<circle cx="6.5" cy="6" r="2.4"></circle>' +
    '<circle cx="17.5" cy="6" r="2.4"></circle>' +
    '<path d="M17.5 8.4v1.6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V8.4"></path>' +
    '<path d="M12 12v3.6"></path>' +
    '</svg>';

  const SIDEBAR_FORK_SPINNER_SVG =
    '<svg class="ag-hakimi-fork-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>' +
    '</svg>';

  const forkingCascadeIds = new Set();
  const pendingNavTimers = new Set();
  let sidebarForkObserver = null;
  let sidebarForkScanTimer = null;
  let sidebarForkNavTarget = null;
  let sidebarForkTooltipEl = null;
  let sidebarForkTooltipAnchor = null;
  let sidebarForkTooltipTimer = null;
  let sidebarForkTooltipDocListenersBound = false;

  function ensureSidebarForkStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(SIDEBAR_FORK_STYLE_ID)) return;
      const styleEl = document.createElement('style');
      styleEl.id = SIDEBAR_FORK_STYLE_ID;
      // 兜底样式放在 @layer base 内（低于 Tailwind v4 @layer utilities 与主题规则），绝不覆盖原生 .agy-button-icon 的圆形 hover 高亮
      styleEl.textContent =
        '@keyframes agHakimiForkSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
        '@layer base{' +
        'button[' + SIDEBAR_FORK_BTN_ATTR + '="true"]{' +
        'display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:9999px;background:transparent;cursor:pointer;flex-shrink:0;transition:background-color .15s ease,color .15s ease;' +
        '}' +
        'button[' + SIDEBAR_FORK_BTN_ATTR + '="true"]:hover:not(:disabled){' +
        'background:var(--secondary,rgba(128,128,128,0.16));color:var(--foreground,inherit);' +
        '}' +
        '}' +
        'button[' + SIDEBAR_FORK_BTN_ATTR + '="true"]:disabled{opacity:0.45;cursor:not-allowed}' +
        'button[' + SIDEBAR_FORK_BTN_ATTR + '="true"] .ag-hakimi-fork-spin{animation:agHakimiForkSpin .8s linear infinite}' +
        '#' + SIDEBAR_FORK_TOOLTIP_ID + '{' +
        'position:fixed;left:0;top:0;z-index:2147482600;white-space:nowrap;pointer-events:none;' +
        'opacity:0;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease;' +
        '}' +
        '#' + SIDEBAR_FORK_TOOLTIP_ID + '[data-open="true"]{opacity:1;transform:translateY(0)}';
      document.head.appendChild(styleEl);
    } catch {}
  }

  function ensureSidebarForkTooltip() {
    if (typeof document === 'undefined') return null;
    if (sidebarForkTooltipEl && sidebarForkTooltipEl.isConnected !== false) {
      return sidebarForkTooltipEl;
    }
    const existing = document.getElementById?.(SIDEBAR_FORK_TOOLTIP_ID);
    if (existing) {
      sidebarForkTooltipEl = existing;
      return existing;
    }
    const root = document.body || document.documentElement;
    if (!root) return null;
    const tip = document.createElement('div');
    tip.id = SIDEBAR_FORK_TOOLTIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.className = SIDEBAR_FORK_TOOLTIP_CLASS;
    tip.hidden = true;
    tip.setAttribute('data-open', 'false');
    root.appendChild(tip);
    sidebarForkTooltipEl = tip;
    return tip;
  }

  function positionSidebarForkTooltip(anchor, tip) {
    if (!anchor || !tip || typeof anchor.getBoundingClientRect !== 'function') return;
    const rect = anchor.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const tipRect = typeof tip.getBoundingClientRect === 'function'
      ? tip.getBoundingClientRect()
      : { width: 72, height: 28 };
    const tipW = tipRect.width || 72;
    const tipH = tipRect.height || 28;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const gap = 6;
    const margin = 8;
    let left = rect.left + rect.width / 2 - tipW / 2;
    if (left < margin) left = margin;
    if (left + tipW > vw - margin) left = Math.max(margin, vw - margin - tipW);
    let top = rect.top - tipH - gap;
    if (top < margin) top = rect.bottom + gap;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideSidebarForkTooltip() {
    if (sidebarForkTooltipTimer) {
      clearTimeout(sidebarForkTooltipTimer);
      sidebarForkTooltipTimer = null;
    }
    sidebarForkTooltipAnchor = null;
    if (sidebarForkTooltipEl) {
      sidebarForkTooltipEl.setAttribute('data-open', 'false');
      sidebarForkTooltipEl.hidden = true;
    }
  }

  function showSidebarForkTooltipNow(anchor) {
    if (state.disposed || !anchor) return;
    const text = anchor.getAttribute?.('data-fork-tip') || anchor.getAttribute?.('aria-label') || '';
    if (!text) return;
    const tip = ensureSidebarForkTooltip();
    if (!tip) return;
    sidebarForkTooltipAnchor = anchor;
    tip.textContent = text;
    tip.hidden = false;
    positionSidebarForkTooltip(anchor, tip);
    tip.setAttribute('data-open', 'true');
  }

  function scheduleSidebarForkTooltip(anchor, delayMs = 180) {
    if (state.disposed || !anchor) return;
    if (sidebarForkTooltipTimer) {
      clearTimeout(sidebarForkTooltipTimer);
      sidebarForkTooltipTimer = null;
    }
    if (delayMs <= 0) {
      showSidebarForkTooltipNow(anchor);
      return;
    }
    sidebarForkTooltipAnchor = anchor;
    sidebarForkTooltipTimer = setTimeout(() => {
      sidebarForkTooltipTimer = null;
      if (sidebarForkTooltipAnchor === anchor) {
        showSidebarForkTooltipNow(anchor);
      }
    }, delayMs);
  }

  function onSidebarForkTooltipScrollOrEscape(e) {
    if (e && e.type === 'keydown' && e.key !== 'Escape') return;
    hideSidebarForkTooltip();
  }

  function bindSidebarForkTooltipDocListeners() {
    if (sidebarForkTooltipDocListenersBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    sidebarForkTooltipDocListenersBound = true;
    document.addEventListener('scroll', onSidebarForkTooltipScrollOrEscape, true);
    document.addEventListener('keydown', onSidebarForkTooltipScrollOrEscape, true);
  }

  function unbindSidebarForkTooltipDocListeners() {
    if (!sidebarForkTooltipDocListenersBound || typeof document === 'undefined' || typeof document.removeEventListener !== 'function') {
      return;
    }
    sidebarForkTooltipDocListenersBound = false;
    document.removeEventListener('scroll', onSidebarForkTooltipScrollOrEscape, true);
    document.removeEventListener('keydown', onSidebarForkTooltipScrollOrEscape, true);
  }

  function isSidebarRowArchived(actions) {
    if (!actions || typeof actions.querySelector !== 'function') return false;
    return Boolean(
      actions.querySelector('[data-testid="conversation-delete-button"], [data-testid="conversation-restore-button"]')
    );
  }

  function isSidebarRowRunning(actions) {
    if (!actions || typeof actions.querySelector !== 'function') return false;
    return Boolean(
      actions.querySelector('[aria-label="Stop execution"], [aria-label="停止执行"]')
    );
  }

  function hasNativeForkButton(actions) {
    if (!actions || typeof actions.querySelectorAll !== 'function') return false;
    const candidates = actions.querySelectorAll(
      '[aria-label="Fork Conversation"], [aria-label="Fork conversation"], [data-testid="conversation-fork-button"]'
    );
    for (const node of candidates) {
      if (node.getAttribute?.(SIDEBAR_FORK_BTN_ATTR) !== 'true') return true;
    }
    return false;
  }

  function findRowActionsContainer(row) {
    if (!row || typeof row.querySelector !== 'function') return null;
    return row.querySelector('.agy-row-actions');
  }

  function findSidebarRowByCascadeId(cascadeId) {
    if (!cascadeId || typeof document.querySelectorAll !== 'function') return null;
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (const row of rows) {
      if (row.getAttribute?.('data-cascade-id') === cascadeId) return row;
    }
    return null;
  }

  function extractSidebarRowTitle(row) {
    if (!row) return '';
    const link = row.querySelector?.('a[href]') || row.querySelector?.('a');
    const aria = link?.getAttribute?.('aria-label');
    if (typeof aria === 'string' && aria.trim()) return aria.trim();
    const titleSpan = row.querySelector?.('span.truncate');
    if (titleSpan && typeof titleSpan.textContent === 'string' && titleSpan.textContent.trim()) {
      return titleSpan.textContent.trim();
    }
    return '';
  }

  function collectSidebarTitles() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
    const out = [];
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (const row of rows) {
      const title = extractSidebarRowTitle(row);
      if (title) out.push(title);
    }
    return out;
  }

  function formatForkedConversationTitle(sourceTitle, existingTitles = []) {
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
      if (Number.isInteger(num) && num > maxForkNum) maxForkNum = num;
    }
    const nextNum = maxForkNum + 1;
    const tag = nextNum === 1 ? '[Fork]' : `[Fork ${nextNum}]`;
    return base ? `${tag} ${base}` : tag;
  }

  function tryActivateForkedRowInDom(cascadeId) {
    if (!cascadeId || state.disposed) return false;
    if (route() === cascadeId) return true;
    const row = findSidebarRowByCascadeId(cascadeId);
    if (!row) return false;
    const link = row.querySelector?.('a[href]') || row.querySelector?.('a');
    if (link && typeof link.click === 'function') {
      link.click();
      return true;
    }
    if (typeof row.click === 'function') {
      row.click();
      return true;
    }
    return false;
  }

  function navigateToForkedConversation(newCascadeId, newProjectId) {
    if (!newCascadeId || state.disposed) return;
    if (tryActivateForkedRowInDom(newCascadeId)) {
      sidebarForkNavTarget = null;
      return;
    }
    sidebarForkNavTarget = { cascadeId: newCascadeId, projectId: newProjectId || '', expiresAt: Date.now() + 1800 };
    let attempts = 0;
    const maxAttempts = 20;
    const intervalId = setInterval(() => {
      if (state.disposed || !sidebarForkNavTarget || sidebarForkNavTarget.cascadeId !== newCascadeId) {
        clearInterval(intervalId);
        pendingNavTimers.delete(intervalId);
        return;
      }
      attempts += 1;
      if (tryActivateForkedRowInDom(newCascadeId)) {
        sidebarForkNavTarget = null;
        clearInterval(intervalId);
        pendingNavTimers.delete(intervalId);
        return;
      }
      if (attempts >= maxAttempts || Date.now() >= sidebarForkNavTarget.expiresAt) {
        const proj = sidebarForkNavTarget.projectId;
        sidebarForkNavTarget = null;
        clearInterval(intervalId);
        pendingNavTimers.delete(intervalId);
        try {
          const qs = proj ? `?project=${encodeURIComponent(proj)}` : '';
          const targetPath = `/c/${encodeURIComponent(newCascadeId)}${qs}`;
          if (typeof location !== 'undefined' && typeof location.assign === 'function') {
            location.assign(targetPath);
          }
        } catch {}
      }
    }, 90);
    pendingNavTimers.add(intervalId);
  }

  function updateSidebarForkButtonVisual(btn, cascadeId, running) {
    if (!btn) return;
    const busy = forkingCascadeIds.has(cascadeId);
    const disabled = busy || Boolean(running);
    const label = busy
      ? t('sidebar.fork.busy')
      : running
        ? t('sidebar.fork.runningDisabled')
        : t('sidebar.fork.title');
    btn.disabled = disabled;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-fork-tip', label);
    if (typeof btn.removeAttribute === 'function') btn.removeAttribute('title');
    btn.setAttribute('data-busy', busy ? 'true' : 'false');
    btn.setAttribute('data-running', running ? 'true' : 'false');
    const desiredIcon = busy ? 'spinner' : 'fork';
    if (btn.getAttribute('data-icon-kind') !== desiredIcon) {
      btn.setAttribute('data-icon-kind', desiredIcon);
      btn.innerHTML = busy ? SIDEBAR_FORK_SPINNER_SVG : SIDEBAR_FORK_ICON_SVG;
    }
    if (sidebarForkTooltipAnchor === btn && sidebarForkTooltipEl && !sidebarForkTooltipEl.hidden) {
      sidebarForkTooltipEl.textContent = label;
      positionSidebarForkTooltip(btn, sidebarForkTooltipEl);
    }
  }

  async function triggerSidebarFork(cascadeId, opts = {}) {
    if (state.disposed) return { ok: false, error: 'disposed' };
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!SIDEBAR_FORK_UUID_RE.test(id)) {
      return { ok: false, error: t('msg.unknownErr') };
    }
    if (forkingCascadeIds.has(id)) {
      return { ok: false, busy: true };
    }

    const row = findSidebarRowByCascadeId(id);
    const actions = row ? findRowActionsContainer(row) : null;
    if (actions && isSidebarRowRunning(actions)) {
      const msg = t('sidebar.fork.runningDisabled');
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    }

    const hasIpcFork = typeof window !== 'undefined' && typeof window.contextMeterAPI?.forkSession === 'function';
    const csrf = typeof getHostCsrfToken === 'function' ? getHostCsrfToken() : null;
    if (!hasIpcFork && !csrf) {
      const msg = t('sidebar.fork.fail', { err: t('msg.unknownErr') });
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    }

    const sourceTitle = typeof opts.sourceTitle === 'string' && opts.sourceTitle.trim()
      ? opts.sourceTitle.trim()
      : extractSidebarRowTitle(row);
    const existingTitles = Array.isArray(opts.existingTitles)
      ? opts.existingTitles
      : collectSidebarTitles();

    const reqOpts = {
      forkAtStepIndex: typeof opts.forkAtStepIndex === 'number' ? opts.forkAtStepIndex : -1,
      targetForkWorkspace: [1, 2, 3].includes(Number(opts.targetForkWorkspace)) ? Number(opts.targetForkWorkspace) : 1,
      sourceTitle,
      existingTitles
    };

    forkingCascadeIds.add(id);
    syncSidebarForkButtons();
    try {
      let data = null;
      if (hasIpcFork) {
        const ipcRes = await window.contextMeterAPI.forkSession(id, reqOpts);
        if (!ipcRes || !ipcRes.ok || !ipcRes.newCascadeId) {
          throw new Error(ipcRes?.error || t('msg.unknownErr'));
        }
        data = ipcRes;
      } else {
        const res = await fetch('/exa.language_server_pb.LanguageServerService/ForkConversation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf
          },
          body: JSON.stringify({
            sourceCascadeId: id,
            forkAtStepIndex: reqOpts.forkAtStepIndex,
            targetForkWorkspace: reqOpts.targetForkWorkspace
          })
        });
        if (!res.ok) {
          const errTxt = await res.text().catch(() => '');
          throw new Error(errTxt || `HTTP ${res.status}`);
        }
        const json = await res.json().catch(() => null);
        if (!json?.newCascadeId) {
          throw new Error(t('msg.unknownErr'));
        }
        const newCascadeId = String(json.newCascadeId);
        const newTitle = formatForkedConversationTitle(sourceTitle, existingTitles);
        if (newTitle) {
          try {
            await fetch('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrf
              },
              body: JSON.stringify({
                cascadeIds: [newCascadeId],
                annotations: { title: newTitle },
                mergeAnnotations: true
              })
            });
          } catch {}
        }
        data = {
          ok: true,
          newCascadeId,
          newProjectId: typeof json.newProjectId === 'string' ? json.newProjectId : '',
          newTitle,
          warnings: Array.isArray(json.warnings) ? json.warnings.filter(Boolean).map(String) : []
        };
      }

      const warnText = Array.isArray(data.warnings) && data.warnings.length > 0 ? data.warnings.join('; ') : '';
      const doneMsg = warnText
        ? t('sidebar.fork.doneWithWarn', { warn: warnText })
        : t('sidebar.fork.done');
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(doneMsg);
      if (opts.navigate !== false) {
        navigateToForkedConversation(data.newCascadeId, data.newProjectId);
      }
      return {
        ok: true,
        newCascadeId: data.newCascadeId,
        newProjectId: data.newProjectId || '',
        warnings: data.warnings || []
      };
    } catch (err) {
      const rawErr = translateBackendText(err?.message) || err?.message || t('msg.unknownErr');
      const msg = t('sidebar.fork.fail', { err: rawErr });
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    } finally {
      forkingCascadeIds.delete(id);
      syncSidebarForkButtons();
    }
  }

  function createSidebarForkButton(cascadeId, actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(SIDEBAR_FORK_BTN_ATTR, 'true');
    btn.setAttribute('data-cascade-id', cascadeId);
    const nativeSibling = actions?.querySelector?.(
      '[data-testid="conversation-archive-button"], [data-testid="conversation-pin-button"]'
    );
    btn.className = (nativeSibling && typeof nativeSibling.className === 'string' && nativeSibling.className.trim())
      ? nativeSibling.className
      : SIDEBAR_FORK_FALLBACK_CLASS;

    const stopBubble = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', stopBubble);
    btn.addEventListener('mousedown', stopBubble);
    btn.addEventListener('mouseenter', () => { scheduleSidebarForkTooltip(btn, 180); });
    btn.addEventListener('mouseleave', () => {
      if (sidebarForkTooltipAnchor === btn) hideSidebarForkTooltip();
    });
    btn.addEventListener('focus', () => { scheduleSidebarForkTooltip(btn, 0); });
    btn.addEventListener('blur', () => {
      if (sidebarForkTooltipAnchor === btn) hideSidebarForkTooltip();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideSidebarForkTooltip();
      const targetId = btn.getAttribute('data-cascade-id') || cascadeId;
      void triggerSidebarFork(targetId);
    });
    return btn;
  }

  function syncSidebarForkButtons() {
    if (state.disposed || typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return 0;
    }
    ensureSidebarForkStyles();
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    let mountedCount = 0;

    for (const row of rows) {
      const cascadeId = String(row.getAttribute?.('data-cascade-id') || '').trim();
      const actions = findRowActionsContainer(row);
      if (!actions) continue;
      const existing = actions.querySelector?.(`button[${SIDEBAR_FORK_BTN_ATTR}="true"]`) || null;

      const isValidId = SIDEBAR_FORK_UUID_RE.test(cascadeId);
      const isBattle = Boolean(row.getAttribute?.('data-battle-arms'));
      const archived = isSidebarRowArchived(actions);
      const hasNative = hasNativeForkButton(actions);

      if (!isValidId || isBattle || archived || hasNative) {
        if (existing) existing.remove();
        continue;
      }

      const running = isSidebarRowRunning(actions);
      let btn = existing;
      if (!btn) {
        btn = createSidebarForkButton(cascadeId, actions);
        if (typeof actions.insertBefore === 'function' && actions.firstChild) {
          actions.insertBefore(btn, actions.firstChild);
        } else {
          actions.appendChild(btn);
        }
      } else {
        if (btn.getAttribute('data-cascade-id') !== cascadeId) {
          btn.setAttribute('data-cascade-id', cascadeId);
        }
        if (actions.firstChild && actions.firstChild !== btn && typeof actions.insertBefore === 'function') {
          actions.insertBefore(btn, actions.firstChild);
        }
      }
      updateSidebarForkButtonVisual(btn, cascadeId, running);
      mountedCount += 1;
    }

    if (sidebarForkNavTarget && tryActivateForkedRowInDom(sidebarForkNavTarget.cascadeId)) {
      sidebarForkNavTarget = null;
    }
    return mountedCount;
  }

  function isSidebarForkRelevantNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.getAttribute?.(SIDEBAR_FORK_BTN_ATTR) === 'true') return false;
    const testId = node.getAttribute?.('data-testid') || '';
    if (
      testId === 'conversation-row-sidebar' ||
      testId === 'conversation-archive-button' ||
      testId === 'conversation-pin-button' ||
      testId === 'conversation-delete-button' ||
      testId === 'conversation-restore-button'
    ) {
      return true;
    }
    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls.includes('agy-row-actions') || cls.includes('agy-sidebar-row')) return true;
    if (typeof node.querySelector === 'function') {
      return Boolean(node.querySelector('[data-testid="conversation-row-sidebar"], .agy-row-actions'));
    }
    return false;
  }

  function scheduleSidebarForkScan() {
    if (state.disposed || sidebarForkScanTimer) return;
    sidebarForkScanTimer = setTimeout(() => {
      sidebarForkScanTimer = null;
      syncSidebarForkButtons();
    }, 60);
  }

  function initSidebarFork() {
    if (state.disposed) return;
    bindSidebarForkTooltipDocListeners();
    syncSidebarForkButtons();
    if (sidebarForkObserver || typeof MutationObserver !== 'function') return;
    const root = document.body || document.documentElement;
    if (!root) return;
    sidebarForkObserver = new MutationObserver((mutations) => {
      if (state.disposed) return;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        const target = m.target;
        const targetCls = typeof target?.className === 'string' ? target.className : '';
        if (targetCls.includes('agy-row-actions') || target?.closest?.('[data-testid="conversation-row-sidebar"]')) {
          let onlySelf = true;
          for (const n of m.addedNodes || []) {
            if (n?.getAttribute?.(SIDEBAR_FORK_BTN_ATTR) !== 'true') { onlySelf = false; break; }
          }
          if (onlySelf) {
            for (const n of m.removedNodes || []) {
              if (n?.getAttribute?.(SIDEBAR_FORK_BTN_ATTR) !== 'true') { onlySelf = false; break; }
            }
          }
          if (!onlySelf) {
            scheduleSidebarForkScan();
            return;
          }
          continue;
        }
        for (const n of m.addedNodes || []) {
          if (isSidebarForkRelevantNode(n)) {
            scheduleSidebarForkScan();
            return;
          }
        }
        for (const n of m.removedNodes || []) {
          if (isSidebarForkRelevantNode(n)) {
            scheduleSidebarForkScan();
            return;
          }
        }
      }
    });
    try {
      sidebarForkObserver.observe(root, { childList: true, subtree: true });
    } catch {}
  }

  function disposeSidebarFork() {
    try { sidebarForkObserver?.disconnect(); } catch {}
    sidebarForkObserver = null;
    if (sidebarForkScanTimer) {
      clearTimeout(sidebarForkScanTimer);
      sidebarForkScanTimer = null;
    }
    hideSidebarForkTooltip();
    unbindSidebarForkTooltipDocListeners();
    try { sidebarForkTooltipEl?.remove?.(); } catch {}
    sidebarForkTooltipEl = null;
    for (const id of pendingNavTimers) {
      clearInterval(id);
    }
    pendingNavTimers.clear();
    sidebarForkNavTarget = null;
    forkingCascadeIds.clear();
    try { document.getElementById(SIDEBAR_FORK_STYLE_ID)?.remove?.(); } catch {}
    try { document.getElementById(SIDEBAR_FORK_TOOLTIP_ID)?.remove?.(); } catch {}
    try {
      if (typeof document.querySelectorAll === 'function') {
        for (const btn of document.querySelectorAll(`button[${SIDEBAR_FORK_BTN_ATTR}="true"]`)) {
          btn.remove?.();
        }
      }
    } catch {}
  }
