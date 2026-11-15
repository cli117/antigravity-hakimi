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
