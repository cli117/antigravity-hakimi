'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const { buildRenderer } = require(path.join(ROOT, 'scripts', 'build-renderer.js'));
const meterMain = require(path.join(ROOT, 'payload', 'dist', 'meter-main.js'));
const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));

const ACTIVE_ID = '11111111-2222-3333-4444-555555555555';
const NEW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKTREE_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function createDomHarness() {
  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.nodeType = 1;
      this.id = '';
      this.className = '';
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.hidden = false;
      this.disabled = false;
      this.style = {
        _props: new Map(),
        setProperty(k, v) { this._props.set(k, String(v)); },
        getPropertyValue(k) { return this._props.get(k) || ''; },
        removeProperty(k) { this._props.delete(k); },
      };
      this.rect = { left: 100, top: 200, width: 28, height: 28, right: 128, bottom: 228 };
      this.listeners = new Map();
      this._textContent = '';
      this._innerHTML = '';
      this.classList = {
        add: (...cls) => {
          const set = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          for (const c of cls) if (c) set.add(c);
          this.className = [...set].join(' ');
        },
        remove: (...cls) => {
          const set = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          this.className = [...set].join(' ');
        },
        toggle: (c, force) => {
          const has = this.classList.contains(c);
          const next = force === undefined ? !has : Boolean(force);
          if (next) this.classList.add(c);
          else this.classList.remove(c);
          return next;
        },
        contains: (c) => String(this.className || '').split(/\s+/).includes(c),
      };
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.children.length
        ? this.parentNode.children[idx + 1]
        : null;
    }
    get textContent() {
      return this._textContent;
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
    }
    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(v) {
      this._innerHTML = String(v ?? '');
      this.children = [];
      const tagRe = /<([a-zA-Z0-9-]+)([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(this._innerHTML)) !== null) {
        const tag = m[1];
        if (tag.toLowerCase() === 'style') continue;
        const child = new FakeElement(tag);
        const attrRe = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRe.exec(m[2])) !== null) {
          const k = am[1];
          const val = am[2] !== undefined ? am[2] : '';
          child.setAttribute(k, val);
          if (k === 'hidden') child.hidden = true;
        }
        child.parentElement = this;
        child.parentNode = this;
        this.children.push(child);
      }
    }
    getBoundingClientRect() {
      return this.rect;
    }
    hasAttribute(k) {
      return this.attributes.has(k);
    }
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    replaceChildren(...nodes) {
      for (const c of this.children) { c.parentElement = null; c.parentNode = null; }
      this.children = [];
      for (const n of nodes) if (n) this.appendChild(n);
    }
    cloneNode() {
      const c = new FakeElement(this.tagName);
      c._textContent = this._textContent;
      return c;
    }
    setAttribute(k, v) {
      const val = String(v);
      this.attributes.set(k, val);
      if (k === 'id') this.id = val;
      if (k === 'class') this.className = val;
    }
    getAttribute(k) {
      if (k === 'id' && this.id) return this.id;
      if (k === 'class' && this.className) return this.className;
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && child.parentNode !== this) child.remove();
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!child) return child;
      if (child.parentNode && child.parentNode !== this) child.remove();
      const curIdx = this.children.indexOf(child);
      if (curIdx >= 0) this.children.splice(curIdx, 1);
      const refIdx = ref ? this.children.indexOf(ref) : -1;
      child.parentElement = this;
      child.parentNode = this;
      if (refIdx >= 0) this.children.splice(refIdx, 0, child);
      else this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
      this.parentElement = null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(evt) {
      const e = evt || { type: 'click' };
      if (!e.target) e.target = this;
      if (typeof e.preventDefault !== 'function') e.preventDefault = () => { e.defaultPrevented = true; };
      if (typeof e.stopPropagation !== 'function') e.stopPropagation = () => { e.propagationStopped = true; };
      for (const fn of [...(this.listeners.get(e.type) || [])]) fn(e);
      if (!e.propagationStopped && this.parentElement) {
        this.parentElement.dispatchEvent(e);
      }
      return e;
    }
    click(extra = {}) {
      return this.dispatchEvent({ type: 'click', defaultPrevented: false, propagationStopped: false, ...extra });
    }
    attachShadow() {
      const sh = new FakeElement('shadow-root');
      sh.getElementById = (id) => sh._walk((n) => n.id === id)[0] || null;
      sh.querySelector = (sel) => sh.querySelectorAll(sel)[0] || null;
      sh.querySelectorAll = (sel) => sh._matchSelector(sel);
      this.shadowRoot = sh;
      return sh;
    }
    _walk(pred, out = []) {
      for (const c of this.children) {
        if (pred(c)) out.push(c);
        c._walk(pred, out);
      }
      return out;
    }
    _matchesSingle(part) {
      const p = part.trim();
      if (!p) return false;
      let rem = p;
      const tagM = rem.match(/^([a-zA-Z0-9_-]+)/);
      if (tagM) {
        if (this.tagName !== tagM[1].toUpperCase()) return false;
        rem = rem.slice(tagM[0].length);
      }
      const clsMatches = [...rem.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
      for (const cm of clsMatches) {
        const classes = String(this.className || '').split(/\s+/);
        if (!classes.includes(cm[1])) return false;
      }
      const attrMatches = [...rem.matchAll(/\[([a-zA-Z0-9_-]+)(?:(\^?=)"([^"]*)")?\]/g)];
      for (const am of attrMatches) {
        const val = this.getAttribute(am[1]);
        if (am[2] === '=') {
          if (val !== am[3]) return false;
        } else if (am[2] === '^=') {
          if (typeof val !== 'string' || !val.startsWith(am[3])) return false;
        } else if (val === null) {
          return false;
        }
      }
      return true;
    }
    _matchSelector(sel) {
      const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
      return this._walk((n) => parts.some((p) => n._matchesSingle(p)));
    }
    querySelectorAll(sel) {
      return this._matchSelector(sel);
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur._matchesSingle(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  }

  const docListeners = new Map();
  const doc = {
    hidden: false,
    documentElement: new FakeElement('html'),
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    visibilityState: 'visible',
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement('fragment'),
    createTextNode: (t) => { const el = new FakeElement('#text'); el._textContent = String(t ?? ''); return el; },
    getElementById: (id) => doc.documentElement._walk((n) => n.id === id)[0] || null,
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
    querySelector: (sel) => doc.documentElement.querySelector(sel),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      docListeners.get(type)?.delete(fn);
    },
    dispatchDocEvent: (evt) => {
      for (const fn of [...(docListeners.get(evt.type) || [])]) fn(evt);
    },
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return { doc, FakeElement };
}

function makeMessageToolbar(doc, opts = {}) {
  const outer = doc.createElement('div');
  const toolbar = doc.createElement('div');
  toolbar.setAttribute('data-testid', 'cascade-system-message-toolbar');
  toolbar.className = 'flex flex-col px-2';

  const barRow = doc.createElement('div');
  barRow.className = '-mx-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 pt-3';

  const btnGroup = doc.createElement('div');
  btnGroup.className = 'flex shrink-0 items-center';

  const copyBtn = doc.createElement('button');
  copyBtn.setAttribute('aria-label', opts.copyLabel || 'Copy');
  copyBtn.className = opts.copyClass || 'native-ghost-btn text-secondary-foreground hover:text-foreground h-7 w-7';
  btnGroup.appendChild(copyBtn);

  if (opts.sideQuestion) {
    const insertBtn = doc.createElement('button');
    insertBtn.setAttribute('data-testid', 'side-question-insert-to-main');
    insertBtn.setAttribute('aria-label', 'Insert into main conversation');
    btnGroup.appendChild(insertBtn);
  }

  if (opts.nativeFork) {
    const nativeBtn = doc.createElement('button');
    nativeBtn.setAttribute('aria-label', opts.nativeForkLabel || 'Fork Conversation');
    if (opts.nativeForkTooltipId) nativeBtn.setAttribute('data-tooltip-id', opts.nativeForkTooltipId);
    btnGroup.appendChild(nativeBtn);
  }

  const goodBtn = doc.createElement('button');
  goodBtn.setAttribute('aria-label', opts.goodLabel || 'Good response');
  goodBtn.className = 'native-ghost-btn bg-secondary text-foreground h-7 w-7';
  btnGroup.appendChild(goodBtn);

  const badBtn = doc.createElement('button');
  badBtn.setAttribute('aria-label', opts.badLabel || 'Bad response');
  badBtn.className = 'native-ghost-btn opacity-40 text-muted-foreground h-7 w-7';
  btnGroup.appendChild(badBtn);

  barRow.appendChild(btnGroup);
  toolbar.appendChild(barRow);
  outer.appendChild(toolbar);

  if (opts.fiberSteps || opts.isBattleFiber) {
    const kycFiber = {
      memoizedProps: {
        steps: opts.fiberSteps || [],
        isLatest: Boolean(opts.isLatest),
        showThumbsUpDown: true,
      },
      return: opts.isBattleFiber
        ? { memoizedProps: { value: { isBattleConversation: true } }, return: null }
        : null,
    };
    const outerFiber = { memoizedProps: {}, return: kycFiber };
    toolbar.__reactFiber$test = { memoizedProps: {}, return: outerFiber };
  }

  return { outer, toolbar, btnGroup, copyBtn, goodBtn, badBtn };
}

function makeSidebarRow(doc, cascadeId, opts = {}) {
  const row = doc.createElement('div');
  row.setAttribute('data-testid', 'conversation-row-sidebar');
  row.setAttribute('data-cascade-id', cascadeId);
  if (opts.battleArms) row.setAttribute('data-battle-arms', opts.battleArms);
  const link = doc.createElement('a');
  link.setAttribute('href', `/c/${cascadeId}`);
  if (opts.title) link.setAttribute('aria-label', opts.title);
  row.appendChild(link);
  const actions = doc.createElement('div');
  actions.className = 'agy-row-actions';
  if (opts.running) {
    const stopBtn = doc.createElement('button');
    stopBtn.setAttribute('aria-label', 'Stop execution');
    actions.appendChild(stopBtn);
  }
  row.appendChild(actions);
  return { row, link, actions };
}

function createRendererSandbox(doc, opts = {}) {
  const assignedUrls = [];
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Promise,
    Error,
    URL,
    AbortController,
    document: doc,
    location: {
      protocol: 'https:',
      hostname: '127.0.0.1',
      pathname: opts.pathname || `/c/${ACTIVE_ID}`,
      assign: (u) => assignedUrls.push(u),
    },
    navigator: { platform: 'MacIntel', language: 'zh-CN' },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.get(k) ?? null; },
      setItem(k, v) { this._m.set(k, String(v)); },
    },
    matchMedia: () => ({ matches: true, addEventListener: () => {} }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(24, 24, 24)', display: 'block', visibility: 'visible', opacity: '1' }),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    contextMeterAPI: {
      forkSession: opts.forkSession || (async () => ({ ok: true, newCascadeId: NEW_ID, warnings: [] })),
      getTrajectoryTurns: opts.getTrajectoryTurns || (async () => ({ ok: true, turns: [] })),
      getSettings: async () => ({ ok: false }),
      getTokenHistory: async () => ({ ok: false }),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const coreSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  vm.runInNewContext(`${coreSrc}\n${rendererSrc}`, sandbox, { filename: 'meter-renderer-message-fork.test.js' });
  return { sandbox, api: sandbox.__AGContextMeter, assignedUrls };
}

test('buildForkConversationRequest sanitizes defaults and valid overrides', () => {
  assert.deepEqual(meterMain.buildForkConversationRequest(ACTIVE_ID), {
    sourceCascadeId: ACTIVE_ID,
    forkAtStepIndex: -1,
    targetForkWorkspace: 1,
  });
  assert.deepEqual(
    meterMain.buildForkConversationRequest(ACTIVE_ID, { forkAtStepIndex: 12, targetForkWorkspace: 2 }),
    { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: 12, targetForkWorkspace: 2 }
  );
  assert.deepEqual(
    meterMain.buildForkConversationRequest(ACTIVE_ID, { forkAtStepIndex: -9, targetForkWorkspace: 99 }),
    { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: -1, targetForkWorkspace: 1 }
  );
});

test('buildForkedConversationTitle adds [Fork] prefix and increments cleanly without stacking', () => {
  assert.equal(
    meterMain.buildForkedConversationTitle('反重力文件识别问题', ['反重力文件识别问题']),
    '[Fork] 反重力文件识别问题'
  );
  assert.equal(
    meterMain.buildForkedConversationTitle('反重力文件识别问题', ['反重力文件识别问题', '[Fork] 反重力文件识别问题']),
    '[Fork 2] 反重力文件识别问题'
  );
  assert.equal(
    meterMain.buildForkedConversationTitle('[Fork] 反重力文件识别问题', ['反重力文件识别问题', '[Fork] 反重力文件识别问题']),
    '[Fork 2] 反重力文件识别问题'
  );
  assert.equal(
    meterMain.buildForkedConversationTitle('[Fork 2] 反重力文件识别问题', ['[Fork 2] 反重力文件识别问题']),
    '[Fork 3] 反重力文件识别问题'
  );
  assert.equal(meterMain.buildForkedConversationTitle('', []), '[Fork]');
  assert.equal(meterMain.buildForkedConversationTitle('[Fork]', ['[Fork]']), '[Fork 2]');
});

test('handleForkSession validates sender/UUID, calls ForkConversation + UpdateConversationAnnotations, and formats response', async () => {
  await assert.rejects(
    () => meterMain.handleForkSession({}, ACTIVE_ID, {}, { isLocalMainFrameSender: () => null }),
    /仅允许本机主聊天窗口/
  );

  const invalidRes = await meterMain.handleForkSession(
    {},
    'not-a-uuid',
    {},
    { isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/') }
  );
  assert.equal(invalidRes.ok, false);
  assert.match(invalidRes.error, /无效会话标识/);

  const rpcCalls = [];
  const okRes = await meterMain.handleForkSession(
    {},
    ACTIVE_ID,
    {
      forkAtStepIndex: 11,
      targetForkWorkspace: 2,
      sourceTitle: '反重力文件识别问题',
      existingTitles: ['反重力文件识别问题', '[Fork] 反重力文件识别问题'],
    },
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async (method, body) => {
        rpcCalls.push({ method, body });
        if (method === 'ForkConversation') {
          return { newCascadeId: NEW_ID, newProjectId: 'proj-1', warnings: ['note 1', ''] };
        }
        return {};
      },
    }
  );
  assert.equal(rpcCalls.length, 2);
  assert.deepEqual(rpcCalls[0], {
    method: 'ForkConversation',
    body: {
      sourceCascadeId: ACTIVE_ID,
      forkAtStepIndex: 11,
      targetForkWorkspace: 2,
    },
  });
  assert.deepEqual(rpcCalls[1], {
    method: 'UpdateConversationAnnotations',
    body: {
      cascadeIds: [NEW_ID],
      annotations: { title: '[Fork 2] 反重力文件识别问题' },
      mergeAnnotations: true,
    },
  });
  assert.deepEqual(okRes, {
    ok: true,
    newCascadeId: NEW_ID,
    newProjectId: 'proj-1',
    newTitle: '[Fork 2] 反重力文件识别问题',
    warnings: ['note 1'],
  });

  // Fallback to GetAllCascadeTrajectories when sourceTitle is omitted, and rename failure is fail-open
  const fallbackCalls = [];
  const fallbackRes = await meterMain.handleForkSession(
    {},
    ACTIVE_ID,
    {},
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async (method, body) => {
        fallbackCalls.push({ method, body });
        if (method === 'ForkConversation') return { newCascadeId: NEW_ID };
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: { [ACTIVE_ID]: { summary: '原生标题' } } };
        }
        if (method === 'UpdateConversationAnnotations') throw new Error('transient rename error');
        return {};
      },
    }
  );
  assert.equal(fallbackRes.ok, true);
  assert.equal(fallbackRes.newTitle, '[Fork] 原生标题');
  assert.equal(
    fallbackCalls.map((c) => c.method).join(','),
    'ForkConversation,GetAllCascadeTrajectories,UpdateConversationAnnotations'
  );

  const missingIdRes = await meterMain.handleForkSession(
    {},
    ACTIVE_ID,
    {},
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async () => ({}),
    }
  );
  assert.equal(missingIdRes.ok, false);
  assert.match(missingIdRes.error, /未返回派生会话标识/);
});

test('buildTurnForkPoints computes accurate turn endStepIndex, cleared status, and sorting', () => {
  const turns = meterMain.buildTurnForkPoints(
    {
      turns: [
        { startStepIndex: 12, firstStep: { status: 3 }, responsePreview: 'Second reply' },
        { startStepIndex: 0, firstStep: { status: 5 }, responsePreview: 'Cleared first reply' },
        { start_step_index: 24, first_step: { status: 'CORTEX_STEP_STATUS_DONE' }, response_preview: 'Latest reply' },
        { startStepIndex: -1 },
      ],
    },
    31
  );
  assert.deepEqual(turns, [
    { startStepIndex: 0, endStepIndex: 11, isLatest: false, cleared: true, responsePreview: 'Cleared first reply' },
    { startStepIndex: 12, endStepIndex: 23, isLatest: false, cleared: false, responsePreview: 'Second reply' },
    { startStepIndex: 24, endStepIndex: 30, isLatest: true, cleared: false, responsePreview: 'Latest reply' },
  ]);

  const withoutTotal = meterMain.buildTurnForkPoints({
    turns: [{ startStepIndex: 0, firstStep: { status: 'CORTEX_STEP_STATUS_CLEARED' } }],
  });
  assert.deepEqual(withoutTotal, [
    { startStepIndex: 0, endStepIndex: -1, isLatest: true, cleared: true, responsePreview: '' },
  ]);
});

test('handleGetTrajectoryTurns validates sender/cascadeId and returns computed turn boundaries', async () => {
  await assert.rejects(
    () => meterMain.handleGetTrajectoryTurns({}, ACTIVE_ID, { isLocalMainFrameSender: () => null }),
    /仅允许本机主聊天窗口/
  );

  const badId = await meterMain.handleGetTrajectoryTurns({}, 'not-a-uuid', {
    isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
  });
  assert.equal(badId.ok, false);
  assert.deepEqual(badId.turns, []);

  const rpcLog = [];
  const okRes = await meterMain.handleGetTrajectoryTurns(
    {},
    ACTIVE_ID,
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async (method, body) => {
        rpcLog.push({ method, body });
        if (method === 'GetTrajectoryTurns') {
          return {
            turns: [
              { startStepIndex: 0, firstStep: { status: 3 } },
              { startStepIndex: 8, firstStep: { status: 3 } },
            ],
          };
        }
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: { [ACTIVE_ID]: { stepCount: 15 } } };
        }
        throw new Error(`unexpected ${method}`);
      },
    }
  );
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.turns, [
    { startStepIndex: 0, endStepIndex: 7, isLatest: false, cleared: false, responsePreview: '' },
    { startStepIndex: 8, endStepIndex: 14, isLatest: true, cleared: false, responsePreview: '' },
  ]);
  assert.equal(rpcLog.map((x) => x.method).join(','), 'GetTrajectoryTurns,GetAllCascadeTrajectories');
});

test('preload generator exposes forkSession and getTrajectoryTurns IPC bridges', () => {
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  assert.ok(preloadCode.includes('forkSession:'), 'preload should expose forkSession');
  assert.ok(preloadCode.includes('context-meter:fork-session'), 'preload should invoke context-meter:fork-session');
  assert.ok(preloadCode.includes('getTrajectoryTurns:'), 'preload should expose getTrajectoryTurns');
  assert.ok(
    preloadCode.includes('context-meter:trajectory-turns'),
    'preload should invoke context-meter:trajectory-turns'
  );
});

test('message fork button mounts after Copy, reads React Fiber stepIndex, supports Scheme A click/Shift+click/contextmenu, and filters non-forkable toolbars', async () => {
  buildRenderer();
  const { doc } = createDomHarness();

  const rowActive = makeSidebarRow(doc, ACTIVE_ID, { title: '哈基米架构讨论' });
  doc.body.appendChild(rowActive.row);

  // Turn 1 (historical, stepIndex=11, idle)
  const tbHist = makeMessageToolbar(doc, {
    copyLabel: '复制',
    goodLabel: '优质回答',
    badLabel: '不佳回答',
    isLatest: false,
    fiberSteps: [
      { step: { case: 'userInput' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 0 } } },
      { step: { case: 'plannerResponse' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 11 } } },
    ],
  });
  // Turn 2 (historical, cleared -> should render disabled)
  const tbCleared = makeMessageToolbar(doc, {
    isLatest: false,
    fiberSteps: [
      { step: { case: 'userInput' }, status: 5, metadata: { sourceTrajectoryStepInfo: { stepIndex: 12 } } },
      { step: { case: 'plannerResponse' }, status: 5, metadata: { sourceTrajectoryStepInfo: { stepIndex: 17 } } },
    ],
  });
  // Turn 3 (latest, stepIndex=25)
  const tbLatest = makeMessageToolbar(doc, {
    isLatest: true,
    fiberSteps: [
      { step: { case: 'userInput' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 18 } } },
      { step: { case: 'plannerResponse' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } },
    ],
  });
  // Side question toolbar -> skipped
  const tbSide = makeMessageToolbar(doc, {
    sideQuestion: true,
    isLatest: true,
    fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 3 } } }],
  });
  // Native fork toolbar -> skipped
  const tbNative = makeMessageToolbar(doc, {
    nativeFork: true,
    nativeForkLabel: '派生分支会话',
    isLatest: true,
    fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } }],
  });
  // Battle mode fiber toolbar -> skipped
  const tbBattle = makeMessageToolbar(doc, {
    isBattleFiber: true,
    isLatest: true,
    fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } }],
  });

  for (const x of [tbHist, tbCleared, tbLatest, tbSide, tbNative, tbBattle]) {
    doc.body.appendChild(x.outer);
  }

  const forkCalls = [];
  let pendingResolve = null;
  const forkSession = (id, opts) => {
    forkCalls.push({ id, opts });
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  };

  const { api } = createRendererSandbox(doc, { forkSession });
  assert.ok(api);

  // Sidebar rows must NOT receive injected fork buttons (single clean fork entry on message toolbars)
  assert.equal(rowActive.actions.querySelector('button[data-hakimi-fork="true"]'), null);
  assert.equal(rowActive.actions.querySelector('button[data-hakimi-msg-fork="true"]'), null);

  // Verify slot position: right after Copy button, before Good response
  const histBtn = tbHist.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.ok(histBtn, 'historical toolbar should mount fork button');
  assert.equal(tbHist.btnGroup.children[0], tbHist.copyBtn);
  assert.equal(tbHist.btnGroup.children[1], histBtn, 'fork button should sit right after Copy');
  assert.equal(tbHist.btnGroup.children[2], tbHist.goodBtn);
  assert.equal(histBtn.getAttribute('data-fork-step-index'), '11');
  assert.equal(histBtn.getAttribute('data-is-historical'), 'true');
  assert.equal(histBtn.disabled, false);
  assert.ok(histBtn.className.includes('native-ghost-btn'));

  const latestBtn = tbLatest.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.ok(latestBtn, 'latest toolbar should mount fork button');
  assert.equal(latestBtn.getAttribute('data-fork-step-index'), '25');
  assert.equal(latestBtn.getAttribute('data-is-historical'), 'false');
  assert.equal(latestBtn.disabled, false);

  // Cleared turn is disabled with clear tooltip
  const clearedBtn = tbCleared.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.ok(clearedBtn);
  assert.equal(clearedBtn.disabled, true);
  assert.equal(clearedBtn.getAttribute('data-cleared'), 'true');
  assert.match(clearedBtn.getAttribute('aria-label'), /已为节省空间被清理/);

  // Side question, native fork, and battle fiber toolbars must NOT get injected buttons
  assert.equal(tbSide.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  assert.equal(tbNative.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  assert.equal(tbBattle.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]'), null);

  // Tooltip renders on focus and updates live on language switch
  histBtn.dispatchEvent({ type: 'focus' });
  const tipEl = doc.getElementById('ag-message-fork-tooltip');
  assert.ok(tipEl && !tipEl.hidden);
  assert.match(tipEl.textContent, /从此处派生分支/);
  await api.setPanelLanguage('en', { persist: false });
  assert.match(tipEl.textContent, /Fork from here/);
  await api.setPanelLanguage('zh-CN', { persist: false });
  histBtn.dispatchEvent({ type: 'blur' });
  assert.equal(tipEl.hidden, true);

  // Scheme A #1: Normal left click -> immediate Current Workspace (target=1) fork at step 11
  histBtn.click({ shiftKey: false });
  assert.equal(forkCalls.length, 1);
  assert.equal(forkCalls[0].id, ACTIVE_ID);
  assert.equal(forkCalls[0].opts.forkAtStepIndex, 11);
  assert.equal(forkCalls[0].opts.targetForkWorkspace, 1);
  assert.equal(histBtn.disabled, true);
  assert.equal(histBtn.getAttribute('data-icon-kind'), 'spinner');
  assert.equal(latestBtn.disabled, true, 'other fork buttons on same cascade lock while busy');

  // Resolve first fork
  const rowNew = makeSidebarRow(doc, NEW_ID);
  doc.body.appendChild(rowNew.row);
  pendingResolve({ ok: true, newCascadeId: NEW_ID, warnings: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(histBtn.disabled, false);
  assert.equal(histBtn.getAttribute('data-icon-kind'), 'fork');

  // Scheme A #2: Shift + left click -> immediate New Worktree (target=2) fork at step 11
  histBtn.click({ shiftKey: true });
  assert.equal(forkCalls.length, 2);
  assert.equal(forkCalls[1].opts.forkAtStepIndex, 11);
  assert.equal(forkCalls[1].opts.targetForkWorkspace, 2);
  const rowWt = makeSidebarRow(doc, WORKTREE_ID);
  doc.body.appendChild(rowWt.row);
  pendingResolve({ ok: true, newCascadeId: WORKTREE_ID, newProjectId: 'wt-proj', warnings: [] });
  await new Promise((r) => setTimeout(r, 20));

  // Scheme A #3: Right-click opens dual-option menu, Escape closes it, clicking option 2 triggers worktree fork
  const ctxEvt = histBtn.dispatchEvent({ type: 'contextmenu' });
  assert.equal(ctxEvt.defaultPrevented, true);
  const menuEl = doc.getElementById('ag-message-fork-menu');
  assert.ok(menuEl && !menuEl.hidden);
  assert.equal(menuEl.children.length, 2);
  assert.equal(menuEl.children[0].getAttribute('data-fork-target'), '1');
  assert.equal(menuEl.children[1].getAttribute('data-fork-target'), '2');

  // Escape closes menu
  doc.dispatchDocEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(menuEl.hidden, true);

  // Re-open menu on latest turn and click Worktree item
  latestBtn.dispatchEvent({ type: 'contextmenu' });
  assert.equal(menuEl.hidden, false);
  menuEl.children[1].click();
  assert.equal(menuEl.hidden, true);
  assert.equal(forkCalls.length, 3);
  assert.equal(forkCalls[2].opts.forkAtStepIndex, 25);
  assert.equal(forkCalls[2].opts.targetForkWorkspace, 2);
  pendingResolve({ ok: true, newCascadeId: WORKTREE_ID, warnings: [] });
  await new Promise((r) => setTimeout(r, 20));

  // Active conversation running (composer stop button) disables message fork buttons
  const stopBtn = doc.createElement('button');
  stopBtn.setAttribute('data-testid', 'stop-button');
  doc.body.appendChild(stopBtn);
  api.syncMessageForkButtonsForTest();
  assert.equal(histBtn.disabled, true);
  assert.equal(latestBtn.disabled, true);
  assert.match(histBtn.getAttribute('aria-label'), /会话运行中/);
  stopBtn.remove();
  api.syncMessageForkButtonsForTest();
  assert.equal(histBtn.disabled, false);

  // Dispose removes all buttons, style, tooltip, and menu
  api.dispose();
  assert.equal(doc.querySelectorAll('button[data-hakimi-msg-fork="true"]').length, 0);
  assert.equal(doc.getElementById('ag-message-fork-style'), null);
  assert.equal(doc.getElementById('ag-message-fork-tooltip'), null);
  assert.equal(doc.getElementById('ag-message-fork-menu'), null);
});

test('message fork falls back to getTrajectoryTurns IPC when React Fiber is unavailable and never guesses historical stepIndex', async () => {
  buildRenderer();
  const { doc } = createDomHarness();

  // Two toolbars WITHOUT React Fiber attached
  const tb1 = makeMessageToolbar(doc, {});
  const tb2 = makeMessageToolbar(doc, {});
  doc.body.appendChild(tb1.outer);
  doc.body.appendChild(tb2.outer);

  let turnsFetches = 0;
  let resolveTurns = null;
  const getTrajectoryTurns = (id) => {
    turnsFetches += 1;
    assert.equal(id, ACTIVE_ID);
    return new Promise((resolve) => {
      resolveTurns = resolve;
    });
  };

  const { api } = createRendererSandbox(doc, { getTrajectoryTurns });

  // Before turns resolve: historical tb1 must NOT mount (never blindly fallback to -1), latest tb2 safely uses -1
  assert.equal(tb1.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  const latestBefore = tb2.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.ok(latestBefore);
  assert.equal(latestBefore.getAttribute('data-fork-step-index'), '-1');
  assert.equal(turnsFetches, 1);

  // Once getTrajectoryTurns resolves with 3 turns (simulating top turn virtualized away), bottom-aligned turns[1] & turns[2] map cleanly
  resolveTurns({
    ok: true,
    turns: [
      { startStepIndex: 0, endStepIndex: 5, isLatest: false, cleared: false },
      { startStepIndex: 6, endStepIndex: 13, isLatest: false, cleared: false },
      { startStepIndex: 14, endStepIndex: 20, isLatest: true, cleared: false },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));

  const btn1 = tb1.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  const btn2 = tb2.btnGroup.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.ok(btn1, 'historical toolbar mounts once exact endStepIndex is resolved');
  assert.equal(btn1.getAttribute('data-fork-step-index'), '13');
  assert.equal(btn1.getAttribute('data-is-historical'), 'true');
  assert.equal(btn2.getAttribute('data-fork-step-index'), '20');
  assert.equal(btn2.getAttribute('data-is-historical'), 'false');

  api.dispose();
});
