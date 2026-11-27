  // =========================================================================
  // 聊天区每轮回复操作栏消息级 Time-Travel Fork（方案 A）
  // 挂载在 [data-testid="cascade-system-message-toolbar"] 紧邻「复制」按钮之后；
  // 单击当前工作区派生，Shift+点击新建 Git Worktree，右键弹出双项菜单。
  // =========================================================================
  const MSG_FORK_BTN_ATTR = 'data-hakimi-msg-fork';
  const MSG_FORK_STYLE_ID = 'ag-message-fork-style';
  const MSG_FORK_TIP_ID = 'ag-message-fork-tooltip';
  const MSG_FORK_MENU_ID = 'ag-message-fork-menu';
  const MSG_FORK_UUID_RE = /^[a-f\d-]{36}$/i;
  const MSG_FORK_FALLBACK_CLS =
    'agy-button agy-button-icon inline-flex items-center justify-center rounded-md h-7 w-7 text-secondary-foreground hover:text-foreground hover:bg-secondary cursor-pointer disabled:opacity-50';
  const MSG_FORK_COPY_SEL = 'button[aria-label="Copy"],button[aria-label="Copied"],button[aria-label="复制"],button[aria-label="已复制"]';
  const MSG_FORK_FEEDBACK_SEL = 'button[aria-label="Good response"],button[aria-label="Bad response"],button[aria-label="优质回答"],button[aria-label="优质回复"],button[aria-label="不佳回答"],button[aria-label="较差回复"]';
  const MSG_FORK_NATIVE_SEL = '[aria-label="Fork Conversation"],[aria-label="Fork conversation"],[aria-label="派生分支会话"],[data-testid="message-fork-button"],[data-tooltip-id^="fork-"]';
  const MSG_FORK_STOP_SEL = 'button[aria-label="Stop execution"],button[aria-label="停止执行"],[data-testid="stop-button"]';
  const MSG_FORK_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="18" r="2.4"></circle><circle cx="6.5" cy="6" r="2.4"></circle><circle cx="17.5" cy="6" r="2.4"></circle>' +
    '<path d="M17.5 8.4v1.6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V8.4"></path><path d="M12 12v3.6"></path></svg>';
  const MSG_FORK_SPIN_SVG =
    '<svg class="ag-mf-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';

  const mf = {
    busy: null, observer: null, scanTimer: null, navTimer: null, navTarget: null,
    tipEl: null, tipAnchor: null, tipTimer: null, menuEl: null, menuAnchor: null, docBound: false
  };

  function ensureMessageForkStyles() {
    if (typeof document === 'undefined' || !document.head || document.getElementById(MSG_FORK_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = MSG_FORK_STYLE_ID;
    s.textContent =
      '@keyframes agMfSpin{to{transform:rotate(360deg)}}' +
      `@layer base{button[${MSG_FORK_BTN_ATTR}="true"]{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;flex-shrink:0}}` +
      `button[${MSG_FORK_BTN_ATTR}="true"]:disabled{opacity:.42;cursor:not-allowed}` +
      `button[${MSG_FORK_BTN_ATTR}="true"] .ag-mf-spin{animation:agMfSpin .8s linear infinite}` +
      `#${MSG_FORK_TIP_ID}{position:fixed;left:0;top:0;z-index:2147482600;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s ease}` +
      `#${MSG_FORK_TIP_ID}[data-open="true"]{opacity:1}` +
      `#${MSG_FORK_MENU_ID}{position:fixed;left:0;top:0;z-index:2147482610;min-width:236px;max-width:296px;padding:4px;border-radius:10px;border:1px solid var(--border,rgba(128,128,128,.28));background:var(--popover,var(--card,#1e1f22));color:var(--foreground,#e6e6e6);box-shadow:0 8px 24px rgba(0,0,0,.28);backdrop-filter:blur(12px);user-select:none}` +
      `#${MSG_FORK_MENU_ID} .ag-mf-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer}` +
      `#${MSG_FORK_MENU_ID} .ag-mf-item:hover{background:var(--secondary,rgba(128,128,128,.18))}` +
      `#${MSG_FORK_MENU_ID} .ag-mf-t{font-size:13px;font-weight:500;line-height:1.35}` +
      `#${MSG_FORK_MENU_ID} .ag-mf-d{font-size:11px;line-height:1.35;color:var(--muted-foreground,rgba(160,160,160,.88))}`;
    document.head.appendChild(s);
  }

  function placeOverlayBox(anchor, box, fw, fh) {
    const r = anchor?.getBoundingClientRect?.();
    if (!r || (!r.width && !r.height)) return;
    const br = box.getBoundingClientRect?.() || { width: fw, height: fh };
    const w = br.width || fw, h = br.height || fh;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const left = Math.max(8, Math.min(vw - 8 - w, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.max(8, Math.min(vh - 8 - h, r.bottom + 6));
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  function hideMessageForkTip() {
    if (mf.tipTimer) { clearTimeout(mf.tipTimer); mf.tipTimer = null; }
    mf.tipAnchor = null;
    if (mf.tipEl) { mf.tipEl.setAttribute('data-open', 'false'); mf.tipEl.hidden = true; }
  }

  function closeMessageForkMenu() {
    mf.menuAnchor = null;
    if (mf.menuEl) mf.menuEl.hidden = true;
  }

  function ensureOverlayEl(key, id, role, className) {
    if (mf[key] && mf[key].isConnected !== false) return mf[key];
    const root = document.body || document.documentElement;
    if (!root) return null;
    const elNode = document.getElementById?.(id) || document.createElement('div');
    elNode.id = id;
    elNode.setAttribute('role', role);
    if (className) elNode.className = className;
    elNode.hidden = true;
    if (!elNode.parentNode) root.appendChild(elNode);
    mf[key] = elNode;
    return elNode;
  }

  function scheduleMessageForkTip(anchor, delay = 180) {
    if (state.disposed || !anchor) return;
    if (mf.tipTimer) { clearTimeout(mf.tipTimer); mf.tipTimer = null; }
    const show = () => {
      if (state.disposed || (mf.menuEl && !mf.menuEl.hidden && mf.menuAnchor === anchor)) return;
      const text = anchor.getAttribute?.('aria-label') || '';
      if (!text) return;
      const tip = ensureOverlayEl('tipEl', MSG_FORK_TIP_ID, 'tooltip',
        'compact-tooltip surface-glass bg-card text-secondary-foreground border border-border rounded-md px-2 py-1 text-sm leading-[1.4]');
      if (!tip) return;
      mf.tipAnchor = anchor;
      tip.textContent = text;
      tip.hidden = false;
      placeOverlayBox(anchor, tip, 180, 28);
      tip.setAttribute('data-open', 'true');
    };
    if (delay <= 0) return show();
    mf.tipAnchor = anchor;
    mf.tipTimer = setTimeout(() => { mf.tipTimer = null; if (mf.tipAnchor === anchor) show(); }, delay);
  }

  function openMessageForkMenu(anchor) {
    if (state.disposed || !anchor || anchor.disabled) return;
    hideMessageForkTip();
    const menu = ensureOverlayEl('menuEl', MSG_FORK_MENU_ID, 'menu', '');
    if (!menu) return;
    const isHist = anchor.getAttribute?.('data-is-historical') === 'true';
    const items = [
      { target: 1, title: t('msg.fork.menuCurrentTitle'), desc: isHist ? t('msg.fork.menuCurrentDescHist') : t('msg.fork.menuCurrentDescLatest') },
      { target: 2, title: t('msg.fork.menuWorktreeTitle'), desc: t('msg.fork.menuWorktreeDesc') }
    ];
    menu.replaceChildren();
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ag-mf-item';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-fork-target', String(item.target));
      const tEl = document.createElement('span'); tEl.className = 'ag-mf-t'; tEl.textContent = item.title;
      const dEl = document.createElement('span'); dEl.className = 'ag-mf-d'; dEl.textContent = item.desc;
      b.appendChild(tEl); b.appendChild(dEl);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const a = mf.menuAnchor || anchor;
        closeMessageForkMenu();
        void triggerMessageForkFromBtn(a, item.target);
      });
      menu.appendChild(b);
    }
    mf.menuAnchor = anchor;
    menu.hidden = false;
    placeOverlayBox(anchor, menu, 252, 108);
  }

  function onMessageForkDocEvent(e) {
    if (e?.type === 'keydown' && e.key !== 'Escape') return;
    if (e?.type === 'keydown' || e?.type === 'scroll') { hideMessageForkTip(); closeMessageForkMenu(); return; }
    if (mf.menuEl && !mf.menuEl.hidden && !mf.menuEl.contains?.(e?.target) && !mf.menuAnchor?.contains?.(e?.target)) {
      closeMessageForkMenu();
    }
  }

  function findSidebarRow(cascadeId) {
    if (!cascadeId || typeof document?.querySelectorAll !== 'function') return null;
    for (const r of document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]')) {
      if (r.getAttribute?.('data-cascade-id') === cascadeId) return r;
    }
    return null;
  }

  function tryActivateForkedRow(cascadeId) {
    if (!cascadeId || state.disposed) return false;
    if (route() === cascadeId) return true;
    const row = findSidebarRow(cascadeId);
    const target = row?.querySelector?.('a[href]') || row?.querySelector?.('a') || row;
    if (target && typeof target.click === 'function') { target.click(); return true; }
    return false;
  }

  function navigateToForkedConversation(newCascadeId, newProjectId) {
    if (!newCascadeId || state.disposed) return;
    if (mf.navTimer) { clearInterval(mf.navTimer); mf.navTimer = null; }
    if (tryActivateForkedRow(newCascadeId)) { mf.navTarget = null; return; }
    mf.navTarget = { id: newCascadeId, proj: newProjectId || '', until: Date.now() + 1800 };
    mf.navTimer = setInterval(() => {
      if (state.disposed || !mf.navTarget || mf.navTarget.id !== newCascadeId) {
        clearInterval(mf.navTimer); mf.navTimer = null; return;
      }
      if (tryActivateForkedRow(newCascadeId)) {
        mf.navTarget = null; clearInterval(mf.navTimer); mf.navTimer = null; return;
      }
      if (Date.now() >= mf.navTarget.until) {
        const proj = mf.navTarget.proj;
        mf.navTarget = null; clearInterval(mf.navTimer); mf.navTimer = null;
        try { location.assign(`/c/${encodeURIComponent(newCascadeId)}${proj ? `?project=${encodeURIComponent(proj)}` : ''}`); } catch {}
      }
    }, 90);
  }

  function readTurnMetaFromFiber(toolbar) {
    for (const node of [toolbar, toolbar?.parentElement]) {
      if (!node || typeof node !== 'object') continue;
      let key = null;
      try { key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')); } catch {}
      if (!key) continue;
      let fiber = node[key], steps = null, isLatest = false, isBattle = false;
      for (let d = 0; fiber && d < 40; d++, fiber = fiber.return) {
        const p = fiber.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        if (p.isBattleConversation === true || p.value?.isBattleConversation === true) isBattle = true;
        if (!steps && Array.isArray(p.steps) && p.steps.length > 0) { steps = p.steps; isLatest = Boolean(p.isLatest); }
        if (steps && isBattle) break;
      }
      if (!steps && !isBattle) continue;
      let stepIndex = -1, cleared = false;
      if (steps) {
        for (let i = steps.length - 1; i >= 0; i--) {
          const raw = steps[i]?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? steps[i]?.stepIndex;
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 0) { stepIndex = n; break; }
        }
        const isClr = (st) => st === 5 || st === 'CORTEX_STEP_STATUS_CLEARED' || st === 'CLEARED';
        const uStep = steps.find((s) => s?.step?.case === 'userInput' || s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' || s?.type === 2);
        cleared = isClr(steps[steps.length - 1]?.status) || isClr(uStep?.status);
      }
      return { found: Boolean(steps), stepIndex, isLatest, cleared, isBattle };
    }
    return { found: false, stepIndex: -1, isLatest: false, cleared: false, isBattle: false };
  }

  function isConversationRunning(cascadeId) {
    const row = findSidebarRow(cascadeId);
    if (row?.querySelector?.('.agy-row-actions [aria-label="Stop execution"], .agy-row-actions [aria-label="停止执行"]')) return true;
    for (const s of document.querySelectorAll?.(MSG_FORK_STOP_SEL) || []) {
      if (!s.closest?.('[data-testid="conversation-row-sidebar"]') && !s.hidden && !s.disabled) return true;
    }
    return false;
  }

  async function triggerMessageFork(cascadeId, opts = {}) {
    if (state.disposed) return { ok: false, error: 'disposed' };
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!MSG_FORK_UUID_RE.test(id)) return { ok: false, error: t('msg.unknownErr') };
    if (mf.busy?.cascadeId === id) return { ok: false, busy: true };
    const toast = (m) => { if (typeof showModelSwitchToast === 'function') showModelSwitchToast(m); };
    if (opts.cleared) { const m = t('msg.fork.clearedDisabled'); toast(m); return { ok: false, error: m }; }
    if (isConversationRunning(id)) { const m = t('msg.fork.runningDisabled'); toast(m); return { ok: false, error: m }; }
    const targetForkWorkspace = [1, 2, 3].includes(Number(opts.targetForkWorkspace)) ? Number(opts.targetForkWorkspace) : 1;
    const rawStep = Number(opts.forkAtStepIndex);
    const forkAtStepIndex = Number.isInteger(rawStep) && rawStep >= -1 ? rawStep : -1;
    const isHistorical = Boolean(opts.isHistorical);
    if (isHistorical && forkAtStepIndex < 0) { const m = t('msg.fork.noStepIndex'); toast(m); return { ok: false, error: m }; }
    if (typeof window?.contextMeterAPI?.forkSession !== 'function') {
      const m = t('msg.fork.fail', { err: t('msg.unknownErr') }); toast(m); return { ok: false, error: m };
    }

    mf.busy = { cascadeId: id, stepIndex: forkAtStepIndex, targetWorkspace: targetForkWorkspace };
    syncMessageForkButtons();
    if (targetForkWorkspace === 2) toast(t('msg.fork.busyWorktree'));
    try {
      const data = await window.contextMeterAPI.forkSession(id, { forkAtStepIndex, targetForkWorkspace });
      if (!data?.ok || !data.newCascadeId) throw new Error(data?.error || t('msg.unknownErr'));
      const warnText = Array.isArray(data.warnings) ? data.warnings.filter(Boolean).join('; ') : '';
      toast(warnText
        ? t('msg.fork.doneWithWarn', { warn: warnText })
        : (targetForkWorkspace === 2 ? t('msg.fork.doneWorktree') : (isHistorical ? t('msg.fork.doneHistorical') : t('msg.fork.done'))));
      if (opts.navigate !== false) navigateToForkedConversation(data.newCascadeId, data.newProjectId);
      return { ok: true, newCascadeId: data.newCascadeId, newProjectId: data.newProjectId || '', warnings: data.warnings || [] };
    } catch (err) {
      const msg = t('msg.fork.fail', { err: translateBackendText(err?.message) || err?.message || t('msg.unknownErr') });
      toast(msg);
      return { ok: false, error: msg };
    } finally {
      mf.busy = null;
      syncMessageForkButtons();
    }
  }

  function triggerMessageForkFromBtn(btn, targetWorkspace) {
    if (!btn || btn.disabled) return Promise.resolve({ ok: false, error: 'disabled' });
    return triggerMessageFork(btn.getAttribute?.('data-cascade-id') || route() || '', {
      forkAtStepIndex: Number(btn.getAttribute?.('data-fork-step-index')),
      targetForkWorkspace: targetWorkspace,
      isHistorical: btn.getAttribute?.('data-is-historical') === 'true',
      cleared: btn.getAttribute?.('data-cleared') === 'true'
    });
  }

  function createMessageForkButton(sibling) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(MSG_FORK_BTN_ATTR, 'true');
    const rawCls = typeof sibling?.className === 'string' ? sibling.className.trim() : '';
    if (rawCls) {
      const toks = rawCls.split(/\s+/).filter((c) => c && c !== 'bg-secondary' && c !== 'shadow-xs' && c !== 'opacity-40');
      if (!toks.includes('text-secondary-foreground')) toks.push('text-secondary-foreground');
      if (!toks.includes('hover:text-foreground')) toks.push('hover:text-foreground');
      btn.className = toks.join(' ');
    } else {
      btn.className = MSG_FORK_FALLBACK_CLS;
    }
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('mouseenter', () => scheduleMessageForkTip(btn, 180));
    btn.addEventListener('mouseleave', () => { if (mf.tipAnchor === btn) hideMessageForkTip(); });
    btn.addEventListener('focus', () => scheduleMessageForkTip(btn, 0));
    btn.addEventListener('blur', () => { if (mf.tipAnchor === btn) hideMessageForkTip(); });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMessageForkMenu(btn); });
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      hideMessageForkTip(); closeMessageForkMenu();
      void triggerMessageForkFromBtn(btn, e?.shiftKey ? 2 : 1);
    });
    return btn;
  }

  function syncMessageForkButtons() {
    if (state.disposed || typeof document?.querySelectorAll !== 'function') return 0;
    ensureMessageForkStyles();
    if (mf.navTarget && tryActivateForkedRow(mf.navTarget.id)) {
      mf.navTarget = null;
      if (mf.navTimer) { clearInterval(mf.navTimer); mf.navTimer = null; }
    }

    const cascadeId = route();
    const toolbars = Array.from(document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]'));
    const blocked = !cascadeId || !MSG_FORK_UUID_RE.test(cascadeId) || Boolean(findSidebarRow(cascadeId)?.getAttribute?.('data-battle-arms'));
    if (blocked) {
      for (const tb of toolbars) tb.querySelector?.(`button[${MSG_FORK_BTN_ATTR}="true"]`)?.remove?.();
      closeMessageForkMenu();
      return 0;
    }

    const running = isConversationRunning(cascadeId);
    let mounted = 0;
    for (let i = 0; i < toolbars.length; i++) {
      const tb = toolbars[i];
      const existing = tb.querySelector?.(`button[${MSG_FORK_BTN_ATTR}="true"]`) || null;
      const copyBtn = tb.querySelector?.(MSG_FORK_COPY_SEL) || null;
      const fbBtn = tb.querySelector?.(MSG_FORK_FEEDBACK_SEL) || null;
      const group = (copyBtn || fbBtn)?.parentElement || tb.querySelector?.('div.flex.shrink-0.items-center') || null;
      const hasNative = group && Array.from(group.querySelectorAll?.(MSG_FORK_NATIVE_SEL) || []).some((n) => n.getAttribute?.(MSG_FORK_BTN_ATTR) !== 'true');
      const meta = readTurnMetaFromFiber(tb);
      const isLatest = meta.found ? meta.isLatest : (i === toolbars.length - 1);
      const stepIndex = meta.stepIndex >= 0 ? meta.stepIndex : (isLatest ? -1 : -2);

      if (!group || hasNative || meta.isBattle || tb.querySelector?.('[data-testid="side-question-insert-to-main"]') || stepIndex < -1) {
        existing?.remove?.();
        continue;
      }

      const btn = existing || createMessageForkButton(copyBtn || fbBtn);
      if (copyBtn && copyBtn.parentElement === group) {
        if (copyBtn.nextSibling !== btn) group.insertBefore?.(btn, copyBtn.nextSibling || null);
      } else if (btn.parentElement !== group) {
        fbBtn && fbBtn.parentElement === group ? group.insertBefore?.(btn, fbBtn) : group.appendChild(btn);
      }

      const isHistorical = !isLatest;
      const cascadeBusy = mf.busy?.cascadeId === cascadeId;
      const selfBusy = cascadeBusy && mf.busy.stepIndex === stepIndex;
      const label = selfBusy
        ? (mf.busy.targetWorkspace === 2 ? t('msg.fork.busyWorktree') : t('msg.fork.busy'))
        : cascadeBusy ? t('msg.fork.busy')
          : meta.cleared ? t('msg.fork.clearedDisabled')
            : running ? t('msg.fork.runningDisabled')
              : (isHistorical ? t('msg.fork.tipHistorical') : t('msg.fork.tipLatest'));

      btn.disabled = cascadeBusy || running || meta.cleared;
      btn.setAttribute('data-cascade-id', cascadeId);
      btn.setAttribute('data-fork-step-index', String(stepIndex));
      btn.setAttribute('data-is-historical', String(isHistorical));
      btn.setAttribute('data-cleared', String(meta.cleared));
      btn.setAttribute('data-busy', String(selfBusy));
      btn.setAttribute('aria-label', label);
      btn.removeAttribute?.('title');
      const kind = selfBusy ? 'spinner' : 'fork';
      if (btn.getAttribute('data-icon-kind') !== kind) {
        btn.setAttribute('data-icon-kind', kind);
        btn.innerHTML = selfBusy ? MSG_FORK_SPIN_SVG : MSG_FORK_SVG;
      }
      if (mf.tipAnchor === btn && mf.tipEl && !mf.tipEl.hidden) {
        mf.tipEl.textContent = label;
        placeOverlayBox(btn, mf.tipEl, 180, 28);
      }
      mounted += 1;
    }
    return mounted;
  }

  function onMessageForkRouteChange() {
    hideMessageForkTip();
    closeMessageForkMenu();
    if (!state.disposed && !mf.scanTimer) {
      mf.scanTimer = setTimeout(() => { mf.scanTimer = null; syncMessageForkButtons(); }, 80);
    }
  }

  function initMessageFork() {
    if (state.disposed) return;
    if (!mf.docBound && typeof document?.addEventListener === 'function') {
      mf.docBound = true;
      document.addEventListener('scroll', onMessageForkDocEvent, true);
      document.addEventListener('keydown', onMessageForkDocEvent, true);
      document.addEventListener('mousedown', onMessageForkDocEvent, true);
    }
    syncMessageForkButtons();
    if (mf.observer || typeof MutationObserver !== 'function') return;
    const root = document.body || document.documentElement;
    if (!root) return;
    const schedule = () => {
      if (!state.disposed && !mf.scanTimer) {
        mf.scanTimer = setTimeout(() => { mf.scanTimer = null; syncMessageForkButtons(); }, 80);
      }
    };
    const isOwn = (n) => n?.getAttribute?.(MSG_FORK_BTN_ATTR) === 'true' || n?.id === MSG_FORK_TIP_ID || n?.id === MSG_FORK_MENU_ID || n?.id === MSG_FORK_STYLE_ID;
    mf.observer = new MutationObserver((muts) => {
      if (state.disposed) return;
      for (const m of muts) {
        if (m.type !== 'childList' || isOwn(m.target)) continue;
        if (m.target?.closest?.('[data-testid="cascade-system-message-toolbar"]')) {
          if ([...(m.addedNodes || []), ...(m.removedNodes || [])].some((n) => !isOwn(n))) { schedule(); return; }
          continue;
        }
        for (const n of [...(m.addedNodes || []), ...(m.removedNodes || [])]) {
          if (n?.nodeType !== 1 || isOwn(n)) continue;
          const tid = n.getAttribute?.('data-testid') || '';
          const aria = n.getAttribute?.('aria-label') || '';
          if (tid === 'cascade-system-message-toolbar' || tid === 'stop-button' || tid === 'conversation-row-sidebar' ||
              aria === 'Stop execution' || aria === '停止执行' ||
              n.querySelector?.('[data-testid="cascade-system-message-toolbar"], [data-testid="stop-button"]')) {
            schedule(); return;
          }
        }
      }
    });
    try { mf.observer.observe(root, { childList: true, subtree: true }); } catch {}
  }

  function disposeMessageFork() {
    try { mf.observer?.disconnect(); } catch {}
    mf.observer = null;
    if (mf.scanTimer) { clearTimeout(mf.scanTimer); mf.scanTimer = null; }
    if (mf.navTimer) { clearInterval(mf.navTimer); mf.navTimer = null; }
    mf.navTarget = null;
    mf.busy = null;
    hideMessageForkTip();
    closeMessageForkMenu();
    if (mf.docBound && typeof document?.removeEventListener === 'function') {
      mf.docBound = false;
      document.removeEventListener('scroll', onMessageForkDocEvent, true);
      document.removeEventListener('keydown', onMessageForkDocEvent, true);
      document.removeEventListener('mousedown', onMessageForkDocEvent, true);
    }
    for (const id of [MSG_FORK_STYLE_ID, MSG_FORK_TIP_ID, MSG_FORK_MENU_ID]) {
      try { document.getElementById(id)?.remove?.(); } catch {}
    }
    mf.tipEl = null; mf.menuEl = null;
    for (const btn of document.querySelectorAll?.(`button[${MSG_FORK_BTN_ATTR}="true"]`) || []) btn.remove?.();
  }
