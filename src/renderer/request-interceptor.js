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