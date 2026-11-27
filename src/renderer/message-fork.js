  // =========================================================================
  // 聊天区每轮回复操作栏消息级 Time-Travel Fork 按钮模块（方案 A）
  // - 挂载位置：非旁路提问、非 Battle 模式的 [data-testid="cascade-system-message-toolbar"]
  //   内「复制 / 点赞 / 点踩」按钮组中紧邻「复制」按钮之后（与官方 rYc 槽位一致）
  // - 交互（方案 A）：
  //   · 单击：直接以当前工作区（targetForkWorkspace=1）从该轮末尾 stepIndex 派生分支
  //   · Shift+点击：直接以新建 Git Worktree（targetForkWorkspace=2）派生独立分支
  //   · 右键点击：弹出极简双项菜单选择「当前工作区派生 / 新建 Worktree 派生」
  // - 零提示词改写、零外发请求拦截；优先读取宿主 KYc React Fiber 精确 stepIndex，
  //   缺失时降级通过官方本地 LanguageServerService/GetTrajectoryTurns 对齐轮次边界
  // =========================================================================
  const MSG_FORK_STYLE_ID = 'ag-message-fork-style';
  const MSG_FORK_TOOLTIP_ID = 'ag-message-fork-tooltip';
  const MSG_FORK_MENU_ID = 'ag-message-fork-menu';
  const MSG_FORK_BTN_ATTR = 'data-hakimi-msg-fork';
  const MSG_FORK_FALLBACK_CLASS =
    'agy-button agy-button-icon inline-flex items-center justify-center font-medium transition-colors select-none outline-none cursor-pointer disabled:opacity-50 bg-transparent text-secondary-foreground hover:text-foreground hover:bg-secondary h-7 w-7 rounded-md';
  const MSG_FORK_TOOLTIP_CLASS =
    'compact-tooltip surface-glass bg-card text-secondary-foreground border border-border rounded-md px-2 py-1 text-sm leading-[1.4] select-none pointer-events-none';

  const MSG_FORK_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="18" r="2.4"></circle>' +
    '<circle cx="6.5" cy="6" r="2.4"></circle>' +
    '<circle cx="17.5" cy="6" r="2.4"></circle>' +
    '<path d="M17.5 8.4v1.6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V8.4"></path>' +
    '<path d="M12 12v3.6"></path>' +
    '</svg>';

  const MSG_FORK_SPINNER_SVG =
    '<svg class="ag-hakimi-msg-fork-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>' +
    '</svg>';

  const MSG_FORK_COPY_SELECTOR =
    'button[aria-label="Copy"], button[aria-label="Copied"], button[aria-label="复制"], button[aria-label="已复制"]';
  const MSG_FORK_FEEDBACK_SELECTOR =
    'button[aria-label="Good response"], button[aria-label="Bad response"], button[aria-label="优质回答"], button[aria-label="优质回复"], button[aria-label="不佳回答"], button[aria-label="较差回复"]';
  const MSG_FORK_NATIVE_FORK_SELECTOR =
    '[aria-label="Fork Conversation"], [aria-label="Fork conversation"], [aria-label="派生分支会话"], [data-testid="message-fork-button"], [data-tooltip-id^="fork-"]';
  const MSG_FORK_COMPOSER_STOP_SELECTOR =
    'button[aria-label="Stop execution"], button[aria-label="停止执行"], [data-testid="stop-button"]';

  let msgForkObserver = null;
  let msgForkScanTimer = null;
  let msgForkTooltipEl = null;
  let msgForkTooltipAnchor = null;
  let msgForkTooltipTimer = null;
  let msgForkMenuEl = null;
  let msgForkMenuAnchor = null;
  let msgForkDocListenersBound = false;
  let activeMessageForkState = null; // { cascadeId, stepIndex, targetWorkspace }

  // 降级轮次缓存（仅在 React Fiber 不可用时按需调用 GetTrajectoryTurns）
  let msgForkTurnsCache = {
    cascadeId: '',
    turns: null,
    toolbarCount: 0,
    fetchedAt: 0,
    inFlight: null
  };

  function ensureMessageForkStyles() {
    try {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(MSG_FORK_STYLE_ID)) return;
      const styleEl = document.createElement('style');
      styleEl.id = MSG_FORK_STYLE_ID;
      styleEl.textContent =
        '@keyframes agHakimiMsgForkSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
        '@layer base{' +
        'button[' + MSG_FORK_BTN_ATTR + '="true"]{' +
        'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;flex-shrink:0;transition:background-color .15s ease,color .15s ease,opacity .15s ease;' +
        '}' +
        'button[' + MSG_FORK_BTN_ATTR + '="true"]:hover:not(:disabled){' +
        'background:var(--secondary,rgba(128,128,128,0.16));color:var(--foreground,inherit);' +
        '}' +
        '}' +
        'button[' + MSG_FORK_BTN_ATTR + '="true"]:disabled{opacity:0.42;cursor:not-allowed}' +
        'button[' + MSG_FORK_BTN_ATTR + '="true"] .ag-hakimi-msg-fork-spin{animation:agHakimiMsgForkSpin .8s linear infinite}' +
        '#' + MSG_FORK_TOOLTIP_ID + '{' +
        'position:fixed;left:0;top:0;z-index:2147482600;white-space:nowrap;pointer-events:none;' +
        'opacity:0;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease;' +
        '}' +
        '#' + MSG_FORK_TOOLTIP_ID + '[data-open="true"]{opacity:1;transform:translateY(0)}' +
        '#' + MSG_FORK_MENU_ID + '{' +
        'position:fixed;left:0;top:0;z-index:2147482610;min-width:236px;max-width:296px;padding:4px;' +
        'border-radius:10px;border:1px solid var(--border,rgba(128,128,128,0.28));' +
        'background:var(--popover,var(--card,#1e1f22));color:var(--foreground,#e6e6e6);' +
        'box-shadow:0 8px 24px rgba(0,0,0,0.28);backdrop-filter:blur(12px);' +
        'font-family:inherit;user-select:none;' +
        '}' +
        '#' + MSG_FORK_MENU_ID + ' .ag-mf-item{' +
        'display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:7px 9px;' +
        'border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;' +
        'transition:background-color .12s ease;' +
        '}' +
        '#' + MSG_FORK_MENU_ID + ' .ag-mf-item:hover{' +
        'background:var(--secondary,rgba(128,128,128,0.18));' +
        '}' +
        '#' + MSG_FORK_MENU_ID + ' .ag-mf-item-title{' +
        'font-size:13px;font-weight:500;line-height:1.35;color:var(--foreground,inherit);' +
        '}' +
        '#' + MSG_FORK_MENU_ID + ' .ag-mf-item-desc{' +
        'font-size:11px;line-height:1.35;color:var(--muted-foreground,rgba(160,160,160,0.88));' +
        '}';
      document.head.appendChild(styleEl);
    } catch {}
  }

  function positionFloatingAnchorBox(anchor, box, fallbackW, fallbackH) {
    if (!anchor || !box || typeof anchor.getBoundingClientRect !== 'function') return;
    const rect = anchor.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const boxRect = typeof box.getBoundingClientRect === 'function'
      ? box.getBoundingClientRect()
      : { width: fallbackW, height: fallbackH };
    const w = boxRect.width || fallbackW;
    const h = boxRect.height || fallbackH;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const gap = 6;
    const margin = 8;
    let left = rect.left + rect.width / 2 - w / 2;
    if (left < margin) left = margin;
    if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
    let top = rect.top - h - gap;
    if (top < margin) {
      top = Math.min(vh - margin - h, rect.bottom + gap);
    }
    if (top < margin) top = margin;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  function ensureMessageForkTooltip() {
    if (typeof document === 'undefined') return null;
    if (msgForkTooltipEl && msgForkTooltipEl.isConnected !== false) {
      return msgForkTooltipEl;
    }
    const existing = document.getElementById?.(MSG_FORK_TOOLTIP_ID);
    if (existing) {
      msgForkTooltipEl = existing;
      return existing;
    }
    const root = document.body || document.documentElement;
    if (!root) return null;
    const tip = document.createElement('div');
    tip.id = MSG_FORK_TOOLTIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.className = MSG_FORK_TOOLTIP_CLASS;
    tip.hidden = true;
    tip.setAttribute('data-open', 'false');
    root.appendChild(tip);
    msgForkTooltipEl = tip;
    return tip;
  }

  function hideMessageForkTooltip() {
    if (msgForkTooltipTimer) {
      clearTimeout(msgForkTooltipTimer);
      msgForkTooltipTimer = null;
    }
    msgForkTooltipAnchor = null;
    if (msgForkTooltipEl) {
      msgForkTooltipEl.setAttribute('data-open', 'false');
      msgForkTooltipEl.hidden = true;
    }
  }

  function showMessageForkTooltipNow(anchor) {
    if (state.disposed || !anchor) return;
    if (msgForkMenuEl && !msgForkMenuEl.hidden && msgForkMenuAnchor === anchor) return;
    const text = anchor.getAttribute?.('data-msg-fork-tip') || anchor.getAttribute?.('aria-label') || '';
    if (!text) return;
    const tip = ensureMessageForkTooltip();
    if (!tip) return;
    msgForkTooltipAnchor = anchor;
    tip.textContent = text;
    tip.hidden = false;
    positionFloatingAnchorBox(anchor, tip, 180, 28);
    tip.setAttribute('data-open', 'true');
  }

  function scheduleMessageForkTooltip(anchor, delayMs = 180) {
    if (state.disposed || !anchor) return;
    if (msgForkTooltipTimer) {
      clearTimeout(msgForkTooltipTimer);
      msgForkTooltipTimer = null;
    }
    if (delayMs <= 0) {
      showMessageForkTooltipNow(anchor);
      return;
    }
    msgForkTooltipAnchor = anchor;
    msgForkTooltipTimer = setTimeout(() => {
      msgForkTooltipTimer = null;
      if (msgForkTooltipAnchor === anchor) {
        showMessageForkTooltipNow(anchor);
      }
    }, delayMs);
  }

  function closeMessageForkMenu() {
    msgForkMenuAnchor = null;
    if (msgForkMenuEl) {
      msgForkMenuEl.hidden = true;
    }
  }

  function ensureMessageForkMenu() {
    if (typeof document === 'undefined') return null;
    if (msgForkMenuEl && msgForkMenuEl.isConnected !== false) {
      return msgForkMenuEl;
    }
    const existing = document.getElementById?.(MSG_FORK_MENU_ID);
    if (existing) {
      msgForkMenuEl = existing;
      return existing;
    }
    const root = document.body || document.documentElement;
    if (!root) return null;
    const menu = document.createElement('div');
    menu.id = MSG_FORK_MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    root.appendChild(menu);
    msgForkMenuEl = menu;
    return menu;
  }

  function openMessageForkMenu(anchor) {
    if (state.disposed || !anchor || anchor.disabled) return;
    hideMessageForkTooltip();
    const menu = ensureMessageForkMenu();
    if (!menu) return;
    const isHistorical = anchor.getAttribute?.('data-is-historical') === 'true';
    const items = [
      {
        target: 1,
        title: t('msg.fork.menuCurrentTitle'),
        desc: isHistorical ? t('msg.fork.menuCurrentDescHist') : t('msg.fork.menuCurrentDescLatest')
      },
      {
        target: 2,
        title: t('msg.fork.menuWorktreeTitle'),
        desc: t('msg.fork.menuWorktreeDesc')
      }
    ];
    menu.replaceChildren();
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-mf-item';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-fork-target', String(item.target));

      const titleEl = document.createElement('span');
      titleEl.className = 'ag-mf-item-title';
      titleEl.textContent = item.title;

      const descEl = document.createElement('span');
      descEl.className = 'ag-mf-item-desc';
      descEl.textContent = item.desc;

      btn.appendChild(titleEl);
      btn.appendChild(descEl);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetAnchor = msgForkMenuAnchor || anchor;
        closeMessageForkMenu();
        void triggerMessageForkFromButton(targetAnchor, item.target);
      });
      menu.appendChild(btn);
    }
    msgForkMenuAnchor = anchor;
    menu.hidden = false;
    positionFloatingAnchorBox(anchor, menu, 252, 108);
  }

  function onMessageForkDocEvent(e) {
    if (e && e.type === 'keydown') {
      if (e.key !== 'Escape') return;
      hideMessageForkTooltip();
      closeMessageForkMenu();
      return;
    }
    if (e && e.type === 'scroll') {
      hideMessageForkTooltip();
      closeMessageForkMenu();
      return;
    }
    if (e && (e.type === 'mousedown' || e.type === 'pointerdown' || e.type === 'click')) {
      if (msgForkMenuEl && !msgForkMenuEl.hidden) {
        const target = e.target;
        const inMenu = target && typeof msgForkMenuEl.contains === 'function' && msgForkMenuEl.contains(target);
        const inAnchor = target && msgForkMenuAnchor && typeof msgForkMenuAnchor.contains === 'function' && msgForkMenuAnchor.contains(target);
        if (!inMenu && !inAnchor) {
          closeMessageForkMenu();
        }
      }
    }
  }

  function bindMessageForkDocListeners() {
    if (msgForkDocListenersBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    msgForkDocListenersBound = true;
    document.addEventListener('scroll', onMessageForkDocEvent, true);
    document.addEventListener('keydown', onMessageForkDocEvent, true);
    document.addEventListener('mousedown', onMessageForkDocEvent, true);
  }

  function unbindMessageForkDocListeners() {
    if (!msgForkDocListenersBound || typeof document === 'undefined' || typeof document.removeEventListener !== 'function') {
      return;
    }
    msgForkDocListenersBound = false;
    document.removeEventListener('scroll', onMessageForkDocEvent, true);
    document.removeEventListener('keydown', onMessageForkDocEvent, true);
    document.removeEventListener('mousedown', onMessageForkDocEvent, true);
  }

  function isClearedStepStatusValue(status) {
    return status === 5 || status === 'CORTEX_STEP_STATUS_CLEARED' || status === 'CLEARED';
  }

  function extractStepIndexFromStep(step) {
    if (!step || typeof step !== 'object') return -1;
    const raw =
      step.metadata?.sourceTrajectoryStepInfo?.stepIndex ??
      step.metadata?.source_trajectory_step_info?.step_index ??
      step.stepIndex ??
      step.step_index;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : -1;
  }

  function extractMessageForkMetaFromFiber(toolbar) {
    const empty = { found: false, stepIndex: -1, isLatest: false, cleared: false, isBattle: false };
    if (!toolbar || typeof toolbar !== 'object') return empty;
    const candidates = [toolbar, toolbar.parentElement].filter(Boolean);
    for (const node of candidates) {
      let fiberKey = null;
      try {
        fiberKey = Object.keys(node).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
      } catch {}
      if (!fiberKey) continue;
      let fiber = node[fiberKey];
      let foundSteps = null;
      let isLatest = false;
      let isBattle = false;
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        if (props.isBattleConversation === true || props.value?.isBattleConversation === true) {
          isBattle = true;
        }
        if (!foundSteps && Array.isArray(props.steps) && props.steps.length > 0) {
          foundSteps = props.steps;
          isLatest = Boolean(props.isLatest);
        }
        if (foundSteps && isBattle) break;
      }
      if (foundSteps || isBattle) {
        let stepIndex = -1;
        let cleared = false;
        if (foundSteps) {
          for (let i = foundSteps.length - 1; i >= 0; i--) {
            const idx = extractStepIndexFromStep(foundSteps[i]);
            if (idx >= 0) {
              stepIndex = idx;
              break;
            }
          }
          const lastStep = foundSteps[foundSteps.length - 1];
          const userStep = foundSteps.find(
            (s) => s?.step?.case === 'userInput' || s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' || s?.type === 2
          );
          if (isClearedStepStatusValue(lastStep?.status) || isClearedStepStatusValue(userStep?.status)) {
            cleared = true;
          }
        }
        return {
          found: Boolean(foundSteps),
          stepIndex,
          isLatest,
          cleared,
          isBattle
        };
      }
    }
    return empty;
  }

  function isActiveConversationBattle(cascadeId) {
    if (!cascadeId) return false;
    const row = typeof findSidebarRowByCascadeId === 'function' ? findSidebarRowByCascadeId(cascadeId) : null;
    if (row && row.getAttribute?.('data-battle-arms')) return true;
    return false;
  }

  function isActiveConversationRunning(cascadeId) {
    if (cascadeId && typeof findSidebarRowByCascadeId === 'function') {
      const row = findSidebarRowByCascadeId(cascadeId);
      const actions = row && typeof findRowActionsContainer === 'function' ? findRowActionsContainer(row) : null;
      if (actions && typeof isSidebarRowRunning === 'function' && isSidebarRowRunning(actions)) {
        return true;
      }
    }
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const stops = document.querySelectorAll(MSG_FORK_COMPOSER_STOP_SELECTOR);
      for (const node of stops) {
        if (node.closest?.('[data-testid="conversation-row-sidebar"]')) continue;
        if (node.hidden || node.disabled) continue;
        return true;
      }
    }
    return false;
  }

  function hasNativeMessageForkButton(group) {
    if (!group || typeof group.querySelectorAll !== 'function') return false;
    const candidates = group.querySelectorAll(MSG_FORK_NATIVE_FORK_SELECTOR);
    for (const node of candidates) {
      if (node.getAttribute?.(MSG_FORK_BTN_ATTR) !== 'true') return true;
    }
    return false;
  }

  function findMessageToolbarButtonGroup(toolbar) {
    if (!toolbar || typeof toolbar.querySelector !== 'function') {
      return { group: null, copyBtn: null, feedbackBtn: null };
    }
    const copyBtn = toolbar.querySelector(MSG_FORK_COPY_SELECTOR);
    const feedbackBtn = toolbar.querySelector(MSG_FORK_FEEDBACK_SELECTOR);
    const anchorBtn = copyBtn || feedbackBtn;
    if (anchorBtn && anchorBtn.parentElement && toolbar.contains?.(anchorBtn.parentElement)) {
      return { group: anchorBtn.parentElement, copyBtn, feedbackBtn };
    }
    const fallbackGroup = toolbar.querySelector('div.flex.shrink-0.items-center');
    if (fallbackGroup) {
      return { group: fallbackGroup, copyBtn: null, feedbackBtn: null };
    }
    return { group: null, copyBtn: null, feedbackBtn: null };
  }

  function buildMessageForkButtonClass(nativeSibling) {
    const raw = nativeSibling && typeof nativeSibling.className === 'string' ? nativeSibling.className.trim() : '';
    if (!raw) return MSG_FORK_FALLBACK_CLASS;
    const tokens = raw
      .split(/\s+/)
      .filter((tok) => tok && tok !== 'bg-secondary' && tok !== 'shadow-xs' && tok !== 'opacity-40');
    if (!tokens.includes('text-secondary-foreground')) tokens.push('text-secondary-foreground');
    if (!tokens.includes('hover:text-foreground')) tokens.push('hover:text-foreground');
    return tokens.join(' ');
  }

  function requestFallbackTrajectoryTurns(cascadeId, toolbarCount) {
    if (state.disposed || !cascadeId || !SIDEBAR_FORK_UUID_RE.test(cascadeId)) return;
    if (typeof window === 'undefined' || typeof window.contextMeterAPI?.getTrajectoryTurns !== 'function') return;
    const now = Date.now();
    if (
      msgForkTurnsCache.cascadeId === cascadeId &&
      (msgForkTurnsCache.inFlight || (msgForkTurnsCache.toolbarCount === toolbarCount && now - msgForkTurnsCache.fetchedAt < 1500))
    ) {
      return;
    }
    let rawPromise;
    try {
      rawPromise = Promise.resolve(window.contextMeterAPI.getTrajectoryTurns(cascadeId));
    } catch {
      return;
    }
    const p = rawPromise
      .then((res) => {
        if (state.disposed || route() !== cascadeId) return;
        if (res && res.ok && Array.isArray(res.turns)) {
          msgForkTurnsCache = {
            cascadeId,
            turns: res.turns,
            toolbarCount,
            fetchedAt: Date.now(),
            inFlight: null
          };
          syncMessageForkButtons();
        } else if (msgForkTurnsCache.cascadeId === cascadeId) {
          msgForkTurnsCache.inFlight = null;
          msgForkTurnsCache.fetchedAt = Date.now();
        }
      })
      .catch(() => {
        if (msgForkTurnsCache.cascadeId === cascadeId) {
          msgForkTurnsCache.inFlight = null;
          msgForkTurnsCache.fetchedAt = Date.now();
        }
      });
    msgForkTurnsCache = {
      cascadeId,
      turns: msgForkTurnsCache.cascadeId === cascadeId ? msgForkTurnsCache.turns : null,
      toolbarCount,
      fetchedAt: now,
      inFlight: p
    };
  }

  function resolveFallbackTurnForToolbar(turns, toolbarIdx, totalToolbars) {
    if (!Array.isArray(turns) || turns.length === 0 || toolbarIdx < 0 || totalToolbars <= 0) return null;
    if (totalToolbars === turns.length) {
      return turns[toolbarIdx] || null;
    }
    if (totalToolbars < turns.length) {
      // 顶部虚拟滚动折叠早期轮次时，自底向上对齐
      const offset = turns.length - totalToolbars;
      return turns[offset + toolbarIdx] || null;
    }
    // DOM 中 toolbar 数大于 turns 数时不盲猜中间轮次，仅安全映射最新一轮
    if (toolbarIdx === totalToolbars - 1) {
      return turns[turns.length - 1] || null;
    }
    return null;
  }

  function updateMessageForkButtonVisual(btn, meta) {
    if (!btn || !meta) return;
    const { cascadeId, forkAtStepIndex, isHistorical, cleared, running } = meta;
    const cascadeBusy = forkingCascadeIds.has(cascadeId);
    const isSelfBusy = Boolean(
      cascadeBusy &&
      activeMessageForkState &&
      activeMessageForkState.cascadeId === cascadeId &&
      activeMessageForkState.stepIndex === forkAtStepIndex
    );
    const disabled = cascadeBusy || Boolean(running) || Boolean(cleared);

    let label;
    if (isSelfBusy) {
      label = activeMessageForkState.targetWorkspace === 2
        ? t('msg.fork.busyWorktree')
        : t('msg.fork.busy');
    } else if (cascadeBusy) {
      label = t('msg.fork.busy');
    } else if (cleared) {
      label = t('msg.fork.clearedDisabled');
    } else if (running) {
      label = t('sidebar.fork.runningDisabled');
    } else {
      label = isHistorical ? t('msg.fork.tipHistorical') : t('msg.fork.tipLatest');
    }

    btn.disabled = disabled;
    btn.setAttribute('data-cascade-id', cascadeId);
    btn.setAttribute('data-fork-step-index', String(forkAtStepIndex));
    btn.setAttribute('data-is-historical', isHistorical ? 'true' : 'false');
    btn.setAttribute('data-cleared', cleared ? 'true' : 'false');
    btn.setAttribute('data-busy', isSelfBusy ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-msg-fork-tip', label);
    if (typeof btn.removeAttribute === 'function') btn.removeAttribute('title');

    const desiredIcon = isSelfBusy ? 'spinner' : 'fork';
    if (btn.getAttribute('data-icon-kind') !== desiredIcon) {
      btn.setAttribute('data-icon-kind', desiredIcon);
      btn.innerHTML = isSelfBusy ? MSG_FORK_SPINNER_SVG : MSG_FORK_ICON_SVG;
    }
    if (msgForkTooltipAnchor === btn && msgForkTooltipEl && !msgForkTooltipEl.hidden) {
      msgForkTooltipEl.textContent = label;
      positionFloatingAnchorBox(btn, msgForkTooltipEl, 180, 28);
    }
  }

  async function triggerMessageFork(cascadeId, opts = {}) {
    if (state.disposed) return { ok: false, error: 'disposed' };
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!SIDEBAR_FORK_UUID_RE.test(id)) {
      return { ok: false, error: t('msg.unknownErr') };
    }
    if (opts.cleared) {
      const msg = t('msg.fork.clearedDisabled');
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    }
    if (isActiveConversationRunning(id)) {
      const msg = t('sidebar.fork.runningDisabled');
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    }

    const targetForkWorkspace = [1, 2, 3].includes(Number(opts.targetForkWorkspace))
      ? Number(opts.targetForkWorkspace)
      : 1;
    const rawStep = opts.forkAtStepIndex;
    const forkAtStepIndex = Number.isInteger(Number(rawStep)) && Number(rawStep) >= -1 ? Number(rawStep) : -1;
    const isHistorical = Boolean(opts.isHistorical);

    if (isHistorical && forkAtStepIndex < 0) {
      const msg = t('msg.fork.noStepIndex');
      if (typeof showModelSwitchToast === 'function') showModelSwitchToast(msg);
      return { ok: false, error: msg };
    }

    activeMessageForkState = {
      cascadeId: id,
      stepIndex: forkAtStepIndex,
      targetWorkspace: targetForkWorkspace
    };
    if (targetForkWorkspace === 2 && typeof showModelSwitchToast === 'function') {
      showModelSwitchToast(t('msg.fork.busyWorktree'));
    }
    try {
      return await triggerSidebarFork(id, {
        forkAtStepIndex,
        targetForkWorkspace,
        sourceTitle: opts.sourceTitle,
        existingTitles: opts.existingTitles,
        navigate: opts.navigate,
        doneMessage: targetForkWorkspace === 2
          ? t('msg.fork.doneWorktree')
          : (isHistorical ? t('msg.fork.doneHistorical') : t('sidebar.fork.done')),
        doneWithWarnMessage: (warn) => t('sidebar.fork.doneWithWarn', { warn })
      });
    } finally {
      activeMessageForkState = null;
      syncMessageForkButtons();
    }
  }

  async function triggerMessageForkFromButton(btn, targetForkWorkspace = 1) {
    if (!btn || btn.disabled) return { ok: false, error: 'disabled' };
    const cascadeId = String(btn.getAttribute?.('data-cascade-id') || route() || '').trim();
    const rawStep = Number(btn.getAttribute?.('data-fork-step-index'));
    const forkAtStepIndex = Number.isInteger(rawStep) && rawStep >= -1 ? rawStep : -1;
    const isHistorical = btn.getAttribute?.('data-is-historical') === 'true';
    const cleared = btn.getAttribute?.('data-cleared') === 'true';
    return triggerMessageFork(cascadeId, {
      forkAtStepIndex,
      targetForkWorkspace,
      isHistorical,
      cleared
    });
  }

  function createMessageForkButton(nativeSibling) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(MSG_FORK_BTN_ATTR, 'true');
    btn.className = buildMessageForkButtonClass(nativeSibling);

    const stopBubble = (e) => {
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', stopBubble);
    btn.addEventListener('mousedown', stopBubble);
    btn.addEventListener('mouseenter', () => { scheduleMessageForkTooltip(btn, 180); });
    btn.addEventListener('mouseleave', () => {
      if (msgForkTooltipAnchor === btn) hideMessageForkTooltip();
    });
    btn.addEventListener('focus', () => { scheduleMessageForkTooltip(btn, 0); });
    btn.addEventListener('blur', () => {
      if (msgForkTooltipAnchor === btn) hideMessageForkTooltip();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMessageForkMenu(btn);
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideMessageForkTooltip();
      closeMessageForkMenu();
      const targetWorkspace = e && e.shiftKey ? 2 : 1;
      void triggerMessageForkFromButton(btn, targetWorkspace);
    });
    return btn;
  }

  function syncMessageForkButtons() {
    if (state.disposed || typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return 0;
    }
    ensureMessageForkStyles();
    const cascadeId = route();
    const allToolbars = Array.from(document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]'));

    if (!cascadeId || !SIDEBAR_FORK_UUID_RE.test(cascadeId) || isActiveConversationBattle(cascadeId)) {
      for (const tb of allToolbars) {
        const oldBtn = tb.querySelector?.(`button[${MSG_FORK_BTN_ATTR}="true"]`);
        if (oldBtn) oldBtn.remove();
      }
      closeMessageForkMenu();
      return 0;
    }

    const eligible = [];
    for (const tb of allToolbars) {
      const existing = tb.querySelector?.(`button[${MSG_FORK_BTN_ATTR}="true"]`) || null;
      // 旁路提问 (/btw) 面板不挂载主会话 Fork 按钮
      if (tb.querySelector?.('[data-testid="side-question-insert-to-main"]')) {
        if (existing) existing.remove();
        continue;
      }
      const { group, copyBtn, feedbackBtn } = findMessageToolbarButtonGroup(tb);
      if (!group || hasNativeMessageForkButton(group)) {
        if (existing) existing.remove();
        continue;
      }
      const fiberMeta = extractMessageForkMetaFromFiber(tb);
      if (fiberMeta.isBattle) {
        if (existing) existing.remove();
        continue;
      }
      eligible.push({ toolbar: tb, group, copyBtn, feedbackBtn, existing, fiberMeta });
    }

    if (eligible.length === 0) return 0;

    let needFallbackTurns = false;
    for (let i = 0; i < eligible.length; i++) {
      const item = eligible[i];
      const isLastInDom = i === eligible.length - 1;
      if (!item.fiberMeta.found || (item.fiberMeta.stepIndex < 0 && !item.fiberMeta.isLatest && !isLastInDom)) {
        needFallbackTurns = true;
        break;
      }
    }

    let fallbackTurns = null;
    if (needFallbackTurns) {
      if (msgForkTurnsCache.cascadeId === cascadeId && Array.isArray(msgForkTurnsCache.turns)) {
        fallbackTurns = msgForkTurnsCache.turns;
      }
      if (!fallbackTurns || msgForkTurnsCache.toolbarCount !== eligible.length) {
        requestFallbackTrajectoryTurns(cascadeId, eligible.length);
      }
    }

    const running = isActiveConversationRunning(cascadeId);
    let mountedCount = 0;

    for (let i = 0; i < eligible.length; i++) {
      const item = eligible[i];
      const isLastInDom = i === eligible.length - 1;
      const fbTurn = fallbackTurns ? resolveFallbackTurnForToolbar(fallbackTurns, i, eligible.length) : null;

      let stepIndex = item.fiberMeta.stepIndex;
      let isLatest = item.fiberMeta.found ? item.fiberMeta.isLatest : (fbTurn ? Boolean(fbTurn.isLatest) : isLastInDom);
      let cleared = item.fiberMeta.cleared;

      if (stepIndex < 0 && fbTurn) {
        if (Number.isInteger(fbTurn.endStepIndex) && fbTurn.endStepIndex >= 0) {
          stepIndex = fbTurn.endStepIndex;
        }
        if (fbTurn.cleared) cleared = true;
      }

      const isHistorical = !isLatest;
      let forkAtStepIndex = stepIndex;
      if (forkAtStepIndex < 0) {
        if (isLatest) {
          forkAtStepIndex = -1;
        } else {
          // 历史轮次无法确认精确 stepIndex 时绝不盲目回退到 -1
          if (item.existing) item.existing.remove();
          continue;
        }
      }

      let btn = item.existing;
      if (!btn) {
        btn = createMessageForkButton(item.copyBtn || item.feedbackBtn);
      }

      // 保持与官方 KYc 槽位一致：紧跟在「复制」按钮之后
      if (item.copyBtn && item.copyBtn.parentElement === item.group) {
        if (item.copyBtn.nextSibling !== btn) {
          if (typeof item.group.insertBefore === 'function') {
            item.group.insertBefore(btn, item.copyBtn.nextSibling || null);
          } else {
            item.group.appendChild(btn);
          }
        }
      } else if (btn.parentElement !== item.group) {
        if (item.feedbackBtn && item.feedbackBtn.parentElement === item.group && typeof item.group.insertBefore === 'function') {
          item.group.insertBefore(btn, item.feedbackBtn);
        } else {
          item.group.appendChild(btn);
        }
      }

      updateMessageForkButtonVisual(btn, {
        cascadeId,
        forkAtStepIndex,
        isHistorical,
        cleared,
        running
      });
      mountedCount += 1;
    }

    return mountedCount;
  }

  function onMessageForkRouteChange(nextCascadeId) {
    hideMessageForkTooltip();
    closeMessageForkMenu();
    if (msgForkTurnsCache.cascadeId !== nextCascadeId) {
      msgForkTurnsCache = {
        cascadeId: nextCascadeId || '',
        turns: null,
        toolbarCount: 0,
        fetchedAt: 0,
        inFlight: null
      };
    }
    scheduleMessageForkScan();
  }

  function isMessageForkRelevantNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.getAttribute?.(MSG_FORK_BTN_ATTR) === 'true') return false;
    if (node.id === MSG_FORK_TOOLTIP_ID || node.id === MSG_FORK_MENU_ID || node.id === MSG_FORK_STYLE_ID) return false;
    const testId = node.getAttribute?.('data-testid') || '';
    if (
      testId === 'cascade-system-message-toolbar' ||
      testId === 'side-question-insert-to-main' ||
      testId === 'stop-button'
    ) {
      return true;
    }
    const aria = node.getAttribute?.('aria-label') || '';
    if (
      aria === 'Copy' || aria === 'Copied' || aria === '复制' || aria === '已复制' ||
      aria === 'Good response' || aria === 'Bad response' ||
      aria === 'Stop execution' || aria === '停止执行'
    ) {
      return true;
    }
    if (typeof node.querySelector === 'function') {
      return Boolean(node.querySelector('[data-testid="cascade-system-message-toolbar"], [data-testid="stop-button"]'));
    }
    return false;
  }

  function scheduleMessageForkScan() {
    if (state.disposed || msgForkScanTimer) return;
    msgForkScanTimer = setTimeout(() => {
      msgForkScanTimer = null;
      syncMessageForkButtons();
    }, 80);
  }

  function initMessageFork() {
    if (state.disposed) return;
    bindMessageForkDocListeners();
    syncMessageForkButtons();
    if (msgForkObserver || typeof MutationObserver !== 'function') return;
    const root = document.body || document.documentElement;
    if (!root) return;
    msgForkObserver = new MutationObserver((mutations) => {
      if (state.disposed) return;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        const target = m.target;
        if (target && (target.id === MSG_FORK_MENU_ID || target.id === MSG_FORK_TOOLTIP_ID)) continue;
        if (target?.closest?.('[data-testid="cascade-system-message-toolbar"]')) {
          let onlySelf = true;
          for (const n of m.addedNodes || []) {
            if (n?.getAttribute?.(MSG_FORK_BTN_ATTR) !== 'true') { onlySelf = false; break; }
          }
          if (onlySelf) {
            for (const n of m.removedNodes || []) {
              if (n?.getAttribute?.(MSG_FORK_BTN_ATTR) !== 'true') { onlySelf = false; break; }
            }
          }
          if (!onlySelf) {
            scheduleMessageForkScan();
            return;
          }
          continue;
        }
        for (const n of m.addedNodes || []) {
          if (isMessageForkRelevantNode(n)) {
            scheduleMessageForkScan();
            return;
          }
        }
        for (const n of m.removedNodes || []) {
          if (isMessageForkRelevantNode(n)) {
            scheduleMessageForkScan();
            return;
          }
        }
      }
    });
    try {
      msgForkObserver.observe(root, { childList: true, subtree: true });
    } catch {}
  }

  function disposeMessageFork() {
    try { msgForkObserver?.disconnect(); } catch {}
    msgForkObserver = null;
    if (msgForkScanTimer) {
      clearTimeout(msgForkScanTimer);
      msgForkScanTimer = null;
    }
    hideMessageForkTooltip();
    closeMessageForkMenu();
    unbindMessageForkDocListeners();
    try { msgForkTooltipEl?.remove?.(); } catch {}
    msgForkTooltipEl = null;
    try { msgForkMenuEl?.remove?.(); } catch {}
    msgForkMenuEl = null;
    activeMessageForkState = null;
    msgForkTurnsCache = {
      cascadeId: '',
      turns: null,
      toolbarCount: 0,
      fetchedAt: 0,
      inFlight: null
    };
    try { document.getElementById(MSG_FORK_STYLE_ID)?.remove?.(); } catch {}
    try { document.getElementById(MSG_FORK_TOOLTIP_ID)?.remove?.(); } catch {}
    try { document.getElementById(MSG_FORK_MENU_ID)?.remove?.(); } catch {}
    try {
      if (typeof document.querySelectorAll === 'function') {
        for (const btn of document.querySelectorAll(`button[${MSG_FORK_BTN_ATTR}="true"]`)) {
          btn.remove?.();
        }
      }
    } catch {}
  }
