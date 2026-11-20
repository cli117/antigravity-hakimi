/**
 * Antigravity Chinese Localization Engine (Runtime v3.4.0)
 * 支持 Antigravity v2.34.0 全量界面汉化 / Unicode 标点与大小写智能归一化 / 动态属性监听 / 精准忽略边界
 *
 * 核心改进：
 * 1. 彻底阻断 requestIdleCallback 自旋死循环，改为 15 秒低频保底扫描
 * 2. 增加 DOM 否定标记，未命中节点二次扫描 O(1) 瞬时退出
 * 3. 增加悬浮 Portal/Tooltip/Popover/Listbox 门禁过滤与 120ms 节流阀，根绝 mouseover 树暴搜
 * 4. 精准类名边界匹配：区分 .terminal / .token 与 group/terminal-card，避免误伤终端卡片 UI
 * 5. Unicode 引号/省略号归一化、安全大小写回退、macOS 快捷键符号与安全动态属性观察
 */
(function (root) {
  'use strict';

  if (!root) {
    root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  }
  if (!root) return;

  function createI18nEngine(dictData) {
    var data = dictData || {};
    var exactDict = data.exact || {};
    var allPatterns = (data.patterns || []).concat(data.rules || []);
    var patterns = allPatterns.map(function (p) {
      return {
        regex: new RegExp(p.regex),
        replacement: p.replacement
      };
    });

    var hasOwn = Object.prototype.hasOwnProperty;

    function normalizeWhitespace(str) {
      return str.replace(/[\u00a0\s]+/g, ' ').trim();
    }

    function canonicalizeForLookup(str) {
      return str
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\u2026/g, '...');
    }

    var translatedValues = {};
    var exactDictCanonical = {};
    var exactDictLower = {};
    for (var k in exactDict) {
      if (hasOwn.call(exactDict, k)) {
        var v = exactDict[k];
        translatedValues[v] = true;
        var ck = canonicalizeForLookup(normalizeWhitespace(k));
        if (ck && !hasOwn.call(exactDictCanonical, ck)) {
          exactDictCanonical[ck] = v;
        }
        if (ck && ck.length >= 4 && !/^[A-Z0-9\s\-_]+$/.test(ck)) {
          var lk = ck.toLowerCase();
          if (!hasOwn.call(exactDictLower, lk)) {
            exactDictLower[lk] = v;
          }
        }
      }
    }

    function lookupExact(normalized, canonical) {
      if (hasOwn.call(exactDict, normalized)) {
        return exactDict[normalized];
      }
      if (canonical !== normalized && hasOwn.call(exactDict, canonical)) {
        return exactDict[canonical];
      }
      if (hasOwn.call(exactDictCanonical, canonical)) {
        return exactDictCanonical[canonical];
      }
      if (canonical.length >= 4 && (canonical.indexOf(' ') !== -1 || /^[A-Z]/.test(canonical))) {
        var lower = canonical.toLowerCase();
        if (hasOwn.call(exactDictLower, lower)) {
          return exactDictLower[lower];
        }
      }
      return null;
    }

    var translationCache = typeof Map !== 'undefined' ? new Map() : null;
    var MAX_CACHE_SIZE = 10000;

    function cacheAndReturn(key, value) {
      if (translationCache) {
        if (translationCache.size >= MAX_CACHE_SIZE) {
          var iter = translationCache.keys();
          for (var ci = 0; ci < 1000; ci++) {
            var oldK = iter.next().value;
            if (oldK !== undefined) {
              translationCache.delete(oldK);
            } else {
              break;
            }
          }
        }
        translationCache.set(key, value);
      }
      return value;
    }

    function runPatterns(str) {
      for (var i = 0; i < patterns.length; i++) {
        var p = patterns[i];
        if (p.regex.test(str)) {
          p.regex.lastIndex = 0;
          var result = str.replace(p.regex, p.replacement);
          for (var pi = 0; pi < patterns.length; pi++) {
            if (patterns[pi].regex.test(result)) {
              patterns[pi].regex.lastIndex = 0;
              result = result.replace(patterns[pi].regex, patterns[pi].replacement);
            }
          }
          return result;
        }
      }
      return null;
    }

    function translateSingleUnit(rawStr) {
      if (!rawStr || typeof rawStr !== 'string') return null;
      var normalized = normalizeWhitespace(rawStr);
      if (!normalized) return null;

      if (translationCache && translationCache.has(normalized)) {
        return translationCache.get(normalized);
      }

      var canonical = canonicalizeForLookup(normalized);

      var exactHit = lookupExact(normalized, canonical);
      if (exactHit !== null) {
        return cacheAndReturn(normalized, exactHit);
      }

      if (!/[a-zA-Z]/.test(canonical)) {
        return cacheAndReturn(normalized, null);
      }

      if (hasOwn.call(translatedValues, normalized)) {
        return cacheAndReturn(normalized, null);
      }

      if (/[\u4e00-\u9fa5]/.test(normalized) && !/[a-zA-Z]{2,}/.test(normalized)) {
        return cacheAndReturn(normalized, null);
      }

      var patternHit = runPatterns(canonical);
      if (patternHit !== null && patternHit !== canonical) {
        return cacheAndReturn(normalized, patternHit);
      }

      var punctuationMatch = canonical.match(/^([\w\s\-\/'",+&()]+?)(\.\.\.|[:：…\.？\?!！]+)$/);
      if (punctuationMatch) {
        var base = punctuationMatch[1].trim();
        var punc = punctuationMatch[2];
        if (base) {
          var baseHit = lookupExact(base, base);
          if (baseHit !== null) {
            var zhPunc = punc === ':' ? '：' : (punc === '...' ? '…' : punc);
            return cacheAndReturn(normalized, baseHit + zhPunc);
          }
        }
      }

      var hotkeyMatch = canonical.match(/^([\w\s\-\/'&]+?)\s*(\((?:(?:Ctrl|Cmd|Alt|Shift|Option|Meta|⌘|⇧|⌥|⌃)\+|Escape|Esc|Enter|Return|Tab|Delete|Backspace|↵|⌫)[^\)]*\)|(?:(?:Ctrl|Cmd|Alt|Shift|⌘|⇧|⌥|⌃)\+[\w;:,\\/+\-⌘⇧⌥⌃↵⌫]+|[⌘⇧⌥⌃]+[\w↵⌫]+))$/i);
      if (hotkeyMatch) {
        var cmdBase = hotkeyMatch[1].trim();
        var hotkey = hotkeyMatch[2].trim();
        var cmdHit = lookupExact(cmdBase, cmdBase);
        if (cmdHit !== null) {
          return cacheAndReturn(normalized, cmdHit + ' ' + hotkey);
        }
      }

      if (canonical.indexOf('. ') !== -1 || canonical.indexOf('! ') !== -1 || canonical.indexOf('? ') !== -1 || canonical.indexOf('。') !== -1) {
        var sentences = canonical.split(/([.!?]\s+|[。！？]\s*)/);
        var anyTranslated = false;
        var allTranslated = true;
        var translatedParts = [];
        for (var sIdx = 0; sIdx < sentences.length; sIdx++) {
          var part = sentences[sIdx];
          var trimmedPart = part.trim();
          if (!trimmedPart || /^[.!?。！？\s]+$/.test(part)) {
            translatedParts.push(part.replace(/\.\s*/g, '。 '));
            continue;
          }
          var transPart = lookupExact(trimmedPart, trimmedPart) ||
                          lookupExact(trimmedPart + '.', trimmedPart + '.');
          if (!transPart) {
            transPart = runPatterns(trimmedPart);
          }
          if (!transPart) {
            var pMatch = trimmedPart.match(/^([\w\s\-\/'",+&()]+?)(\.\.\.|[:：…\.？\?!！]+)$/);
            if (pMatch) {
              var pBase = pMatch[1].trim();
              var pBaseHit = pBase ? lookupExact(pBase, pBase) : null;
              if (pBaseHit !== null) {
                transPart = pBaseHit + (pMatch[2] === ':' ? '：' : (pMatch[2] === '...' ? '…' : pMatch[2]));
              }
            }
          }
          if (transPart) {
            anyTranslated = true;
            translatedParts.push(transPart);
          } else {
            allTranslated = false;
            translatedParts.push(part);
          }
        }
        if (anyTranslated && allTranslated) {
          return cacheAndReturn(normalized, translatedParts.join('').replace(/([。！？])[。！？.]*\s*/g, '$1 ').trim());
        }
      }

      return cacheAndReturn(normalized, null);
    }

    return {
      translate: translateSingleUnit,
      exactDict: exactDict,
      patterns: patterns,
      cache: translationCache,
      normalizeWhitespace: normalizeWhitespace
    };
  }

  // 若处于 Node.js 环境，优先准备导出
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createI18nEngine: createI18nEngine
    };
  }

  if (root && root.__AGY_I18N_INITIALIZED__) return;
  if (root) root.__AGY_I18N_INITIALIZED__ = true;

  var doc = root ? (root.document || (typeof document !== 'undefined' ? document : null)) : null;

  var I18N_DATA = (root && root.__AGY_I18N_DATA__) || { exact: {}, patterns: [] };
  var I18N_CONFIG = (root && root.__AGY_I18N_CONFIG__) || { enabled: true, language: 'zh-CN' };
  var i18nEnabled = I18N_CONFIG.enabled !== false && I18N_CONFIG.language !== 'en';
  var defaultEngine = createI18nEngine(I18N_DATA);
  var exactDict = defaultEngine.exactDict;
  var patterns = defaultEngine.patterns;
  var translationCache = defaultEngine.cache;
  var normalizeWhitespace = defaultEngine.normalizeWhitespace;
  var translateSingleUnit = defaultEngine.translate;

  var IGNORED_TAGS = {
    'SCRIPT': 1, 'STYLE': 1, 'CODE': 1, 'PRE': 1, 'NOSCRIPT': 1,
    'SVG': 1, 'PATH': 1, 'CANVAS': 1,
    'IFRAME': 1, 'VIDEO': 1, 'AUDIO': 1
  };

  var IGNORED_CLASS_SUBSTRINGS = [
    'monaco-editor',
    'view-lines',
    'view-line',
    'monaco-mouse-cursor-text',
    'xterm',
    'hljs',
    'code-block',
    'editor-instance'
  ];

  // 仅精确匹配独立类名 token，避免将 Tailwind 语义类名如 group/terminal-card 或 token-count 误判为代码/终端输出区
  var IGNORED_EXACT_CLASSES = {
    'terminal': 1,
    'token': 1
  };

  function hasIgnoredClass(className) {
    if (!className || typeof className !== 'string') return false;
    for (var i = 0; i < IGNORED_CLASS_SUBSTRINGS.length; i++) {
      if (className.indexOf(IGNORED_CLASS_SUBSTRINGS[i]) !== -1) return true;
    }
    if (className.indexOf('terminal') !== -1 || className.indexOf('token') !== -1) {
      var parts = className.split(/\s+/);
      for (var j = 0; j < parts.length; j++) {
        if (IGNORED_EXACT_CLASSES[parts[j]]) return true;
      }
    }
    return false;
  }

  var TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label', 'data-tooltip', 'alt', 'aria-description'];

  function isModelSelectorBoundary(elem) {
    if (!elem || elem.nodeType !== 1) return false;
    var testId = elem.getAttribute ? elem.getAttribute('data-testid') : null;
    if (testId) {
      if (testId === 'model-selector-trigger' ||
          testId === 'model-selector-item' ||
          testId === 'model-selector-effort-option' ||
          testId === 'model-selector-effort-group' ||
          testId === 'model-selector-list') {
        return true;
      }
    }
    if (elem.hasAttribute && elem.hasAttribute('data-effort')) {
      return true;
    }
    return false;
  }

  function shouldIgnoreElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'context-meter-root') return true;
    if (IGNORED_TAGS[el.tagName]) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#context-meter-root')) return true;

    // 模型选择器相关边界元素及其子元素保持英文原样（纯属性 O(1) 短路）
    if (isModelSelectorBoundary(el)) return true;

    var className = typeof el.className === 'string' ? el.className : '';
    if (className && hasIgnoredClass(className)) return true;

    // 向上检查最近 3 层祖先，防止子文本/图标元素在受保护区域（如 trigger/item 内部）
    var ancestor = el.parentElement;
    for (var depth = 0; ancestor && depth < 3; depth++) {
      if (IGNORED_TAGS[ancestor.tagName]) return true;
      if (isModelSelectorBoundary(ancestor)) return true;
      var ancestorClass = typeof ancestor.className === 'string' ? ancestor.className : '';
      if (ancestorClass && hasIgnoredClass(ancestorClass)) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }



  // 标记属性名，用于避免重复翻译
  var MARK_ATTR = '_agyDone';

  // 扫描轮次 ID，同一轮全量扫描中元素只处理一次
  var currentScanId = 0;

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    var parent = node.parentElement || node.parentNode;
    if (parent && (shouldIgnoreElement(parent) || parent.tagName === 'INPUT' || parent.tagName === 'TEXTAREA')) return;

    var original = node.nodeValue;
    if (!original) return;

    // 如果节点已标记原始文本且未变化，直接 O(1) 瞬时退出
    if (node._agyOriginal === original) return;

    var trimmed = original.trim();
    if (!trimmed) {
      // 对纯空白节点补充否定标记，二次扫描直接 O(1) 退出，避免重复调用 trim()
      node._agyOriginal = original;
      return;
    }

    if (!i18nEnabled) {
      node._agyOriginal = original;
      return;
    }

    if (trimmed === '.' && node.previousSibling && /[\u4e00-\u9fa5]/.test(node.previousSibling.textContent || '')) {
      node.nodeValue = original.replace('.', '。');
      node._agyOriginal = node.nodeValue;
      return;
    }

    var translated = translateSingleUnit(trimmed);
    if (translated !== null && translated !== trimmed) {
      var leadingSpace = original.match(/^\s*/)[0];
      var trailingSpace = original.match(/\s*$/)[0];
      // 盘古之白排版优化：若前一个兄弟节点以英数结尾且当前译文以汉字开头，自动补齐规范空格
      if (!leadingSpace && node.previousSibling) {
        var prevText = (node.previousSibling.textContent || '').trim();
        if (/[a-zA-Z0-9]$/.test(prevText) && /^[\u4e00-\u9fa5]/.test(translated)) {
          leadingSpace = ' ';
        }
      }
      node.nodeValue = leadingSpace + translated + trailingSpace;
      node._agyOriginal = node.nodeValue; // 记录翻译后的值，防止重复处理
    } else {
      // 关键性能优化：补充 DOM 否定标记，未命中时记录原始文本，二次扫描直接 O(1) 退出
      node._agyOriginal = original;
    }
  }

  // 深度穿透获取首个纯文本子节点（单例通用穿透辅助，避免在热路径循环中重复创建闭包分配）
  function getFirstDirectTextNode(n) {
    var cur = n;
    while (cur) {
      if (cur.nodeType === 3) return cur;
      if (cur.nodeType === 1 && cur.childNodes.length === 1) {
        cur = cur.firstChild;
      } else {
        break;
      }
    }
    return null;
  }

  function translateElement(el, scanId) {
    if (!el || el.nodeType !== 1) return;
    if (shouldIgnoreElement(el)) return;

    // 同一轮扫描中，已处理的元素跳过
    if (scanId && el._agyScanId === scanId) return;
    if (scanId) el._agyScanId = scanId;

    // 复合组件自愈：处理特定 JSX 碎片化 Alert（如 plan-command-fyi-alert）
    if (el.getAttribute && el.getAttribute('data-testid') === 'plan-command-fyi-alert') {
      var alertSpan = el.querySelector ? el.querySelector('span') : null;
      if (alertSpan && !alertSpan._agyAlertDone) {
        var alertChild = alertSpan.firstChild;
        while (alertChild) {
          if (alertChild.nodeType === 3 && alertChild.nodeValue && alertChild.nodeValue.trim() === 'Type') {
            alertChild.nodeValue = alertChild.nodeValue.replace('Type', '输入');
            alertChild._agyOriginal = alertChild.nodeValue;
          }
          alertChild = alertChild.nextSibling;
        }
        alertSpan._agyAlertDone = true;
      }
    }

    // 翻译属性（仅在启用汉化时）
    if (i18nEnabled) {
      for (var i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
        var attr = TRANSLATABLE_ATTRS[i];
        if (el.hasAttribute && el.hasAttribute(attr)) {
          var val = el.getAttribute(attr);
          if (val) {
            // 检查是否已翻译过此属性
            var markKey = MARK_ATTR + '_' + attr;
            if (el[markKey] === val) continue;

            var trans = translateSingleUnit(val);
            if (trans !== null && trans !== val) {
              el.setAttribute(attr, trans);
              el[markKey] = trans; // 标记已翻译的值
            } else {
              // 关键性能优化：补充 DOM 否定标记，未命中时记录原属性值，二次扫描直接 O(1) 退出
              el[markKey] = val;
            }
          }
        }
      }
    }

    // 遍历子节点
    // 联合文本自愈：如果元素直接子节点全为纯文本节点且数量 > 1（常见于 React 碎片化模板拆分，如 "All ", e, "s run as Flash."）
    var first = el.firstChild;
    if (i18nEnabled && first && first.nextSibling) {
      var allText = true;
      var cur = first;
      while (cur) {
        if (cur.nodeType !== 3) {
          allText = false;
          break;
        }
        cur = cur.nextSibling;
      }
      if (allText) {
        var combinedText = el.textContent;
        if (combinedText) {
          var combinedTrans = translateSingleUnit(combinedText);
          if (combinedTrans !== null && combinedTrans !== combinedText) {
            first.nodeValue = combinedTrans;
            first._agyOriginal = combinedTrans;
            var other = first.nextSibling;
            while (other) {
              other.nodeValue = '';
              other._agyOriginal = '';
              other = other.nextSibling;
            }
            return;
          }
        }
      } else {
        // 跨内联元素语序重排自愈：针对 "Also includes" / "Includes" + <span>Global Permissions</span> + "when working in this project."
        var alsoNode = null;
        var whenNode = null;
        var scanCur = first;

        while (scanCur) {
          var tn = getFirstDirectTextNode(scanCur);
          if (tn && tn.nodeValue) {
            var tVal = tn.nodeValue.trim();
            if (/^(?:Also\s+includes|Includes|也包含|包含)$/i.test(tVal)) {
              alsoNode = tn;
            } else if (alsoNode && (tVal.indexOf('when working in this project') !== -1 || tVal.indexOf('在此项目中工作时') !== -1)) {
              whenNode = tn;
              break;
            }
          }
          scanCur = scanCur.nextSibling;
        }
        if (alsoNode && whenNode) {
          var alsoText = alsoNode.nodeValue.trim();
          var prefix = (alsoText.indexOf('也') !== -1 || alsoText.indexOf('Also') !== -1) ? '在此项目中工作时，也包含' : '在此项目中工作时包含';
          alsoNode.nodeValue = prefix;
          alsoNode._agyOriginal = alsoNode.nodeValue;

          // 清理两者之间的空白节点
          var alsoContainer = alsoNode.parentNode === el ? alsoNode : alsoNode.parentNode;
          var whenContainer = whenNode.parentNode === el ? whenNode : whenNode.parentNode;
          var between = alsoContainer.nextSibling;
          while (between && between !== whenContainer) {
            if (between.nodeType === 3 && !between.nodeValue.trim()) {
              between.nodeValue = '';
              between._agyOriginal = '';
            }
            between = between.nextSibling;
          }

          var cleanedWhen = whenNode.nodeValue.replace(/when\s+working\s+in\s+this\s+project[。.]?/gi, '').replace(/在此项目中工作时[。.]?/g, '').trim();
          whenNode.nodeValue = cleanedWhen ? ('。 ' + cleanedWhen) : '。';
          whenNode._agyOriginal = whenNode.nodeValue;
        }
      }
    }

    var child = el.firstChild;
    while (child) {
      if (child.nodeType === 3) {
        translateTextNode(child);
      } else if (child.nodeType === 1) {
        translateElement(child, scanId);
      }
      child = child.nextSibling;
    }
  }

  // ============ Observer 与扫描调度 ============

  var observer = null;
  var observing = false;

  function disconnectObserver() {
    if (observer && observing) {
      observer.disconnect();
      observing = false;
    }
  }

  var FLOATING_SELECTOR = '[role="tooltip"], [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-floating-ui-portal], [data-popover-popup], [data-radix-popper-content-wrapper], .popover, .tooltip, .context-view, .monaco-hover';

  function reconnectObserver() {
    if (observer && !observing && doc && doc.documentElement) {
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRS
      });
      observing = true;
    }
  }

  /**
   * 安全地翻译一组节点
   * 在翻译期间暂停 Observer，完成后重新连接
   */
  function safeTranslateNodes(nodes) {
    disconnectObserver();
    try {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.nodeType === 1) {
          translateElement(node);
        } else if (node.nodeType === 3) {
          translateTextNode(node);
        }
      }
    } catch (e) {
      // 静默吞错，避免一个异常阻断整体
    }
    reconnectObserver();
  }

  /**
   * 安全地执行全量扫描
   */
  function safeFullScan() {
    if (!doc || !doc.documentElement) return;
    currentScanId++;
    disconnectObserver();
    try {
      translateElement(doc.documentElement, currentScanId);
    } catch (e) {}
    reconnectObserver();
  }

  // ---- 节流与去重：合并高频 mutation 到下一个 rAF ----
  var pendingNodes = [];
  var pendingNodeSet = typeof Set !== 'undefined' ? new Set() : null;
  var rafScheduled = false;

  function enqueueNode(node) {
    if (!node) return;
    if (pendingNodeSet) {
      if (pendingNodeSet.has(node)) return;
      if (pendingNodes.length < 500) {
        pendingNodes.push(node);
        pendingNodeSet.add(node);
      }
    } else {
      if (pendingNodes.length < 500) {
        pendingNodes.push(node);
      }
    }
  }

  function flushPendingNodes() {
    rafScheduled = false;
    if (pendingNodes.length === 0) return;
    var batch = pendingNodes.splice(0, 200);
    if (pendingNodeSet) {
      for (var bIdx = 0; bIdx < batch.length; bIdx++) {
        pendingNodeSet.delete(batch[bIdx]);
      }
    }
    safeTranslateNodes(batch);
    // 如果还有剩余，安排下一帧处理
    if (pendingNodes.length > 0) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (!rafScheduled) {
      rafScheduled = true;
      if (root.requestAnimationFrame) {
        root.requestAnimationFrame(flushPendingNodes);
      } else {
        setTimeout(flushPendingNodes, 16);
      }
    }
  }

  function startObserver() {
    if (!doc || !doc.documentElement) return;

    // 首次全量扫描
    safeFullScan();

    var MutationObserverClass = root.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (MutationObserverClass) {
      observer = new MutationObserverClass(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'childList') {
            var added = mutation.addedNodes;
            for (var j = 0; j < added.length; j++) {
              enqueueNode(added[j]);
            }
          } else if (mutation.type === 'characterData') {
            // 文本内容变化，重置标记使其可以被重新翻译
            if (mutation.target) {
              mutation.target._agyOriginal = undefined;
              enqueueNode(mutation.target);
            }
          } else if (mutation.type === 'attributes') {
            var attrTarget = mutation.target;
            var attrName = mutation.attributeName;
            if (attrTarget && attrTarget.nodeType === 1 && attrName && attrTarget.getAttribute) {
              var curAttrVal = attrTarget.getAttribute(attrName);
              var attrMarkKey = MARK_ATTR + '_' + attrName;
              if (curAttrVal && attrTarget[attrMarkKey] !== curAttrVal) {
                enqueueNode(attrTarget);
              }
            }
          }
        }
        if (pendingNodes.length > 0) {
          scheduleFlush();
        }
      });

      reconnectObserver();
    }

    // 低频保底扫描：彻底阻断 50~60Hz 无限自旋死循环，改为每 15 秒配合 requestIdleCallback 执行一次低频保底扫描
    var idleScanScheduled = false;
    function scheduleIdleScan() {
      if (idleScanScheduled) return;
      if (root.requestIdleCallback) {
        idleScanScheduled = true;
        root.requestIdleCallback(function () {
          idleScanScheduled = false;
          safeFullScan();
        }, { timeout: 5000 });
      } else {
        safeFullScan();
      }
    }
    setInterval(scheduleIdleScan, 15000);
  }

  function isFloatingElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (doc && (el === doc.body || el === doc.documentElement)) return false;
    if (el.id === 'workbench') return false;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (cls && cls.indexOf('monaco-workbench') !== -1) return false;

    if (el.matches) {
      try {
        if (el.matches(FLOATING_SELECTOR)) {
          return true;
        }
      } catch (e) {}
    }
    var role = el.getAttribute ? el.getAttribute('role') : '';
    if (role === 'tooltip' || role === 'menu' || role === 'dialog' || role === 'alertdialog' || role === 'listbox') return true;
    if (el.hasAttribute && (el.hasAttribute('data-floating-ui-portal') || el.hasAttribute('data-popover-popup') || el.hasAttribute('data-radix-popper-content-wrapper'))) return true;
    if (cls) {
      if (cls.indexOf('popover') !== -1 || cls.indexOf('tooltip') !== -1 || cls.indexOf('context-view') !== -1 || cls.indexOf('monaco-hover') !== -1) {
        return true;
      }
    }
    return false;
  }

  function isWorkbenchOrRoot(el) {
    if (!el || el.nodeType !== 1) return true;
    if (doc && (el === doc.body || el === doc.documentElement)) return true;
    if (el.id === 'workbench') return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (cls && cls.indexOf('monaco-workbench') !== -1) return true;
    return false;
  }

  if (doc) {
    try {
      var proto = typeof Document !== 'undefined' ? Document.prototype : null;
      var titleDesc = proto ? Object.getOwnPropertyDescriptor(proto, 'title') : null;
      if (titleDesc && titleDesc.set && titleDesc.get) {
        var origSetter = titleDesc.set;
        var origGetter = titleDesc.get;
        Object.defineProperty(doc, 'title', {
          configurable: true,
          enumerable: true,
          get: function() {
            return origGetter.call(this);
          },
          set: function(val) {
            origSetter.call(this, formatBrandDocumentTitle(String(val || '')));
          }
        });
      }
      if (doc.title) {
        var formatted = formatBrandDocumentTitle(doc.title);
        if (formatted !== doc.title) doc.title = formatted;
      }
    } catch (e) {}

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', startObserver);
    } else {
      startObserver();
    }

    // 全局悬浮气泡 (Hover Tooltips / Popovers) 快速反应拦截器
    // 专门防御光标移入时才动态挂载或改变属性的临时注释节点
    try {
      var lastHoverTime = 0;
      var hoverScanTimer = null;

      function scanFloatingContainers() {
        if (!doc || !doc.body) return;
        disconnectObserver();
        try {
          // 定向扫描顶层 Portal 容器、Tooltip、Popover 节点，门禁拦截非浮层元素，绝不遍历整棵 DOM 树
          var last = doc.body.lastElementChild;
          if (last && isFloatingElement(last)) {
            translateElement(last);
          }
          if (last && last.previousElementSibling && isFloatingElement(last.previousElementSibling)) {
            translateElement(last.previousElementSibling);
          }
          var tooltips = doc.querySelectorAll ? doc.querySelectorAll(FLOATING_SELECTOR) : null;
          if (tooltips && tooltips.length > 0) {
            for (var tIdx = 0; tIdx < tooltips.length; tIdx++) {
              translateElement(tooltips[tIdx]);
            }
          }
        } catch (e) {}
        reconnectObserver();
      }

      var onHoverAction = function (e) {
        // 120ms 节流阀：阻断高频事件风暴，杜绝掉帧卡顿
        var now = Date.now ? Date.now() : (+new Date());
        if (now - lastHoverTime < 120) return;
        lastHoverTime = now;

        var target = e.target;
        if (!target) return;
        disconnectObserver();
        try {
          if (target.nodeType === 1) {
            translateElement(target);
            // 严禁对 #workbench / body 根容器递归全树深搜，防止剧烈掉帧
            if (target.parentElement && !isWorkbenchOrRoot(target.parentElement)) {
              translateElement(target.parentElement);
            }
          }
        } catch (e) {}
        reconnectObserver();

        // 防抖延迟定向扫描浮动提示层（捕获动态延迟 50ms 挂载的气泡）
        if (hoverScanTimer) clearTimeout(hoverScanTimer);
        hoverScanTimer = setTimeout(function () {
          hoverScanTimer = null;
          scanFloatingContainers();
        }, 50);
      };

      doc.addEventListener('pointerenter', onHoverAction, { capture: true, passive: true });
      doc.addEventListener('contextmenu', onHoverAction, { capture: true, passive: true });
    } catch (e) {}
  }

  if (root) {
    root.__AGY_CREATE_ENGINE__ = createI18nEngine;
    root.__AGY_TRANSLATE_UNIT__ = translateSingleUnit;
    root.__AGY_TRANSLATE_EL__ = translateElement;
    root.__AGY_RUN_FULL_SCAN__ = safeFullScan;
    root.__AGY_CACHE__ = translationCache;
    root.__AGY_IS_FLOATING__ = isFloatingElement;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

