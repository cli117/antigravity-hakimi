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

const SRC_ID = '11111111-2222-3333-4444-555555555555';
const NEW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ID = '66666666-7777-8888-9999-000000000000';

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
      this.rect = { left: 0, top: 0, width: 100, height: 24, right: 100, bottom: 24 };
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
      if (typeof e.preventDefault !== 'function') e.preventDefault = () => { e.defaultPrevented = true; };
      if (typeof e.stopPropagation !== 'function') e.stopPropagation = () => { e.propagationStopped = true; };
      for (const fn of [...(this.listeners.get(e.type) || [])]) fn(e);
      if (!e.propagationStopped && this.parentElement) {
        this.parentElement.dispatchEvent(e);
      }
      return e;
    }
    click() {
      return this.dispatchEvent({ type: 'click', defaultPrevented: false, propagationStopped: false });
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
      // Split tag, classes, and attribute selectors
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
      const attrMatches = [...rem.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)];
      for (const am of attrMatches) {
        const val = this.getAttribute(am[1]);
        if (am[2] !== undefined) {
          if (val !== am[2]) return false;
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
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return { doc, FakeElement };
}

function makeSidebarRow(doc, cascadeId, opts = {}) {
  const row = doc.createElement('div');
  row.setAttribute('data-testid', 'conversation-row-sidebar');
  row.setAttribute('data-cascade-id', cascadeId);
  row.className = 'relative w-full agy-sidebar-row group';
  if (opts.battleArms) row.setAttribute('data-battle-arms', opts.battleArms);

  const link = doc.createElement('a');
  link.setAttribute('href', `/c/${cascadeId}`);
  if (opts.title) link.setAttribute('aria-label', opts.title);
  row.appendChild(link);

  const actions = doc.createElement('div');
  actions.className = 'agy-row-actions absolute top-0 bottom-0 -right-1 flex items-center gap-0.5 z-10';
  if (opts.archived) {
    const delBtn = doc.createElement('button');
    delBtn.setAttribute('data-testid', 'conversation-delete-button');
    actions.appendChild(delBtn);
    const restoreBtn = doc.createElement('button');
    restoreBtn.setAttribute('data-testid', 'conversation-restore-button');
    actions.appendChild(restoreBtn);
  } else {
    if (opts.running) {
      const stopBtn = doc.createElement('button');
      stopBtn.setAttribute('aria-label', opts.runningLabel || 'Stop execution');
      actions.appendChild(stopBtn);
    } else {
      const archiveBtn = doc.createElement('button');
      archiveBtn.setAttribute('data-testid', 'conversation-archive-button');
      archiveBtn.setAttribute('aria-label', 'Archive conversation');
      archiveBtn.className = 'agy-button agy-button-icon ghost-native-cls';
      actions.appendChild(archiveBtn);
    }
    const pinBtn = doc.createElement('button');
    pinBtn.setAttribute('data-testid', 'conversation-pin-button');
    pinBtn.setAttribute('aria-label', 'Pin conversation');
    pinBtn.className = 'agy-button agy-button-icon ghost-native-cls';
    actions.appendChild(pinBtn);
    if (opts.nativeFork) {
      const nativeBtn = doc.createElement('button');
      nativeBtn.setAttribute('aria-label', 'Fork Conversation');
      actions.appendChild(nativeBtn);
    }
  }
  row.appendChild(actions);
  return { row, link, actions };
}

test('buildForkConversationRequest sanitizes defaults and valid overrides', () => {
  assert.deepEqual(meterMain.buildForkConversationRequest(SRC_ID), {
    sourceCascadeId: SRC_ID,
    forkAtStepIndex: -1,
    targetForkWorkspace: 1,
  });
  assert.deepEqual(
    meterMain.buildForkConversationRequest(SRC_ID, { forkAtStepIndex: 12, targetForkWorkspace: 2 }),
    { sourceCascadeId: SRC_ID, forkAtStepIndex: 12, targetForkWorkspace: 2 }
  );
  assert.deepEqual(
    meterMain.buildForkConversationRequest(SRC_ID, { forkAtStepIndex: -9, targetForkWorkspace: 99 }),
    { sourceCascadeId: SRC_ID, forkAtStepIndex: -1, targetForkWorkspace: 1 }
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
    () => meterMain.handleForkSession({}, SRC_ID, {}, { isLocalMainFrameSender: () => null }),
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
    SRC_ID,
    {
      targetForkWorkspace: 1,
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
      sourceCascadeId: SRC_ID,
      forkAtStepIndex: -1,
      targetForkWorkspace: 1,
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
    SRC_ID,
    {},
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async (method, body) => {
        fallbackCalls.push({ method, body });
        if (method === 'ForkConversation') return { newCascadeId: NEW_ID };
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: { [SRC_ID]: { summary: '原生标题' } } };
        }
        if (method === 'UpdateConversationAnnotations') throw new Error('transient rename error');
        return {};
      },
    }
  );
  assert.equal(fallbackRes.ok, true);
  assert.equal(fallbackRes.newTitle, '[Fork] 原生标题');
  assert.equal(fallbackCalls.map((c) => c.method).join(','), 'ForkConversation,GetAllCascadeTrajectories,UpdateConversationAnnotations');

  const missingIdRes = await meterMain.handleForkSession(
    {},
    SRC_ID,
    {},
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async () => ({}),
    }
  );
  assert.equal(missingIdRes.ok, false);
  assert.match(missingIdRes.error, /未返回派生会话标识/);
});

test('preload generator exposes forkSession IPC bridge', () => {
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  assert.ok(preloadCode.includes('forkSession:'), 'preload should expose forkSession');
  assert.ok(preloadCode.includes('context-meter:fork-session'), 'preload should invoke context-meter:fork-session');
});

test('sidebar fork button mounts before Archive, filters archived/battle/running/native rows, forks on click, and cleans up on dispose', async () => {
  buildRenderer();
  const { doc } = createDomHarness();

  const rowNormal = makeSidebarRow(doc, SRC_ID, { title: '反重力文件识别问题' });
  const rowArchived = makeSidebarRow(doc, '22222222-2222-3333-4444-555555555555', { archived: true });
  const rowBattle = makeSidebarRow(doc, '33333333-2222-3333-4444-555555555555', { battleArms: 'arm1,arm2' });
  const rowRunning = makeSidebarRow(doc, '44444444-2222-3333-4444-555555555555', {
    running: true,
    runningLabel: '停止执行',
  });
  const rowNativeFork = makeSidebarRow(doc, '55555555-2222-3333-4444-555555555555', { nativeFork: true });
  doc.body.appendChild(rowNormal.row);
  doc.body.appendChild(rowArchived.row);
  doc.body.appendChild(rowBattle.row);
  doc.body.appendChild(rowRunning.row);
  doc.body.appendChild(rowNativeFork.row);

  let forkCalls = [];
  let rowClicks = 0;
  rowNormal.row.addEventListener('click', () => {
    rowClicks += 1;
  });

  let assignedUrls = [];
  let resolveFork = null;
  const forkSession = (id, opts) => {
    forkCalls.push({ id, opts });
    return new Promise((resolve) => {
      resolveFork = resolve;
    });
  };

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
      pathname: `/c/${OTHER_ID}`,
      assign: (u) => {
        assignedUrls.push(u);
      },
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
      forkSession,
      getSettings: async () => ({ ok: false }),
      getTokenHistory: async () => ({ ok: false }),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const coreSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  vm.runInNewContext(`${coreSrc}\n${rendererSrc}`, sandbox, { filename: 'meter-renderer-sidebar-fork.test.js' });

  const api = sandbox.__AGContextMeter;
  assert.ok(api, 'meter runtime should initialize');

  // Mounted before Archive on normal row, inheriting native ghost button class without conflicting title/unlayered CSS
  const forkBtn = rowNormal.actions.firstChild;
  assert.equal(forkBtn.getAttribute('data-hakimi-fork'), 'true');
  assert.equal(forkBtn.getAttribute('data-cascade-id'), SRC_ID);
  assert.equal(forkBtn.getAttribute('title'), null, 'should use floating native-style tooltip instead of browser title');
  assert.ok(forkBtn.className.includes('ghost-native-cls'), 'should inherit native action button styling');
  assert.ok(forkBtn.innerHTML.includes('<svg'), 'should render fork SVG icon');
  assert.equal(forkBtn.disabled, false);

  const styleEl = doc.getElementById('ag-sidebar-fork-style');
  assert.ok(styleEl && styleEl.textContent.includes('@layer base{'), 'fallback button styles must stay inside @layer base below Tailwind utilities');

  // Focus/hover shows native-style floating compact-tooltip bubble above button, and hides on blur/leave
  forkBtn.dispatchEvent({ type: 'focus' });
  const tipEl = doc.getElementById('ag-sidebar-fork-tooltip');
  assert.ok(tipEl, 'floating tooltip should mount on focus/hover');
  assert.ok(tipEl.className.includes('compact-tooltip'), 'tooltip should reuse native compact-tooltip class');
  assert.equal(tipEl.hidden, false);
  assert.equal(tipEl.getAttribute('data-open'), 'true');
  assert.equal(tipEl.textContent, 'Fork 会话');

  await api.setPanelLanguage('en', { persist: false });
  assert.equal(forkBtn.getAttribute('aria-label'), 'Fork conversation');
  assert.equal(tipEl.textContent, 'Fork conversation', 'visible tooltip should refresh on language switch');

  forkBtn.dispatchEvent({ type: 'blur' });
  assert.equal(tipEl.hidden, true);
  assert.equal(tipEl.getAttribute('data-open'), 'false');

  await api.setPanelLanguage('zh-CN', { persist: false });
  assert.equal(forkBtn.getAttribute('aria-label'), 'Fork 会话');

  // Archived, Battle, and native-fork rows must NOT get injected buttons
  assert.equal(rowArchived.actions.querySelector('button[data-hakimi-fork="true"]'), null);
  assert.equal(rowBattle.actions.querySelector('button[data-hakimi-fork="true"]'), null);
  assert.equal(rowNativeFork.actions.querySelector('button[data-hakimi-fork="true"]'), null);

  // Running row (even localized Chinese "停止执行") disables its fork button
  const runningForkBtn = rowRunning.actions.querySelector('button[data-hakimi-fork="true"]');
  assert.ok(runningForkBtn);
  assert.equal(runningForkBtn.disabled, true);
  assert.equal(runningForkBtn.getAttribute('data-running'), 'true');

  // Click forks without bubbling to parent row, shows busy spinner, blocks double click
  const clickEvt = forkBtn.click();
  assert.equal(clickEvt.propagationStopped, true, 'click must not bubble to sidebar row');
  assert.equal(rowClicks, 0, 'parent sidebar row should not receive click');
  assert.equal(forkCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(forkCalls[0])), {
    id: SRC_ID,
    opts: {
      forkAtStepIndex: -1,
      targetForkWorkspace: 1,
      sourceTitle: '反重力文件识别问题',
      existingTitles: ['反重力文件识别问题'],
    },
  });
  assert.equal(forkBtn.disabled, true);
  assert.equal(forkBtn.getAttribute('data-busy'), 'true');
  assert.equal(forkBtn.getAttribute('data-icon-kind'), 'spinner');

  // Duplicate click while in flight is ignored
  forkBtn.click();
  assert.equal(forkCalls.length, 1);

  // Simulate new forked row appearing in sidebar before resolving
  const rowNew = makeSidebarRow(doc, NEW_ID);
  let newLinkClicked = 0;
  rowNew.link.addEventListener('click', () => {
    newLinkClicked += 1;
  });
  doc.body.appendChild(rowNew.row);

  resolveFork({ ok: true, newCascadeId: NEW_ID, newProjectId: 'proj-1', warnings: [] });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(newLinkClicked, 1, 'should activate newly appeared sidebar row link cleanly');
  assert.equal(assignedUrls.length, 0, 'should not force full reload when sidebar row is present');
  assert.equal(forkBtn.disabled, false);
  assert.equal(forkBtn.getAttribute('data-icon-kind'), 'fork');

  // Dispose removes injected buttons, style, and floating tooltip cleanly
  api.dispose();
  assert.equal(doc.querySelectorAll('button[data-hakimi-fork="true"]').length, 0);
  assert.equal(doc.getElementById('ag-sidebar-fork-style'), null);
  assert.equal(doc.getElementById('ag-sidebar-fork-tooltip'), null);
});
