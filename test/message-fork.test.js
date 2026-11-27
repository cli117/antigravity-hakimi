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
  class El {
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
      this.style = { setProperty() {}, getPropertyValue: () => '', removeProperty() {} };
      this.rect = { left: 100, top: 200, width: 28, height: 28, right: 128, bottom: 228 };
      this.listeners = new Map();
      this.textContent = '';
      this._innerHTML = '';
      this.classList = {
        add: (...c) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...c])].join(' '); },
        remove: (...c) => { this.className = this.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
        toggle: (c, f) => { const n = f === undefined ? !this.classList.contains(c) : Boolean(f); n ? this.classList.add(c) : this.classList.remove(c); return n; },
        contains: (c) => this.className.split(/\s+/).includes(c),
      };
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
      const i = this.parentNode ? this.parentNode.children.indexOf(this) : -1;
      return i >= 0 ? (this.parentNode.children[i + 1] || null) : null;
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
      this._innerHTML = String(v ?? '');
      this.children = [];
      for (const m of this._innerHTML.matchAll(/<([a-zA-Z0-9-]+)([^>]*)>/g)) {
        if (m[1].toLowerCase() === 'style') continue;
        const c = new El(m[1]);
        for (const a of m[2].matchAll(/([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
          c.setAttribute(a[1], a[2] ?? '');
          if (a[1] === 'hidden') c.hidden = true;
        }
        c.parentElement = c.parentNode = this;
        this.children.push(c);
      }
    }
    getBoundingClientRect() { return this.rect; }
    hasAttribute(k) { return this.attributes.has(k); }
    contains(n) { for (let c = n; c; c = c.parentElement) if (c === this) return true; return false; }
    replaceChildren(...nodes) { this.children.forEach((c) => { c.parentElement = c.parentNode = null; }); this.children = []; nodes.forEach((n) => n && this.appendChild(n)); }
    cloneNode() { const c = new El(this.tagName); c.textContent = this.textContent; return c; }
    setAttribute(k, v) { const s = String(v); this.attributes.set(k, s); if (k === 'id') this.id = s; if (k === 'class') this.className = s; }
    getAttribute(k) { return (k === 'id' && this.id) || (k === 'class' && this.className) || (this.attributes.has(k) ? this.attributes.get(k) : null); }
    removeAttribute(k) { this.attributes.delete(k); }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (!c) return c;
      if (c.parentNode) c.remove();
      const idx = ref ? this.children.indexOf(ref) : -1;
      c.parentElement = c.parentNode = this;
      if (idx >= 0) this.children.splice(idx, 0, c); else this.children.push(c);
      return c;
    }
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentElement = this.parentNode = null;
    }
    addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
    removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
    dispatchEvent(evt = { type: 'click' }) {
      evt.target = evt.target || this;
      evt.preventDefault = evt.preventDefault || (() => { evt.defaultPrevented = true; });
      evt.stopPropagation = evt.stopPropagation || (() => { evt.propagationStopped = true; });
      for (const fn of [...(this.listeners.get(evt.type) || [])]) fn(evt);
      if (!evt.propagationStopped && this.parentElement) this.parentElement.dispatchEvent(evt);
      return evt;
    }
    click(extra = {}) { return this.dispatchEvent({ type: 'click', ...extra }); }
    attachShadow() {
      const sh = new El('shadow-root');
      sh.getElementById = (id) => sh._walk((n) => n.id === id)[0] || null;
      return (this.shadowRoot = sh);
    }
    _walk(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c._walk(pred, out); } return out; }
    _matchOne(sel) {
      let rem = sel.trim();
      const tag = rem.match(/^([a-zA-Z0-9_-]+)/);
      if (tag) { if (this.tagName !== tag[1].toUpperCase()) return false; rem = rem.slice(tag[0].length); }
      for (const cm of rem.matchAll(/\.([a-zA-Z0-9_-]+)/g)) if (!this.className.split(/\s+/).includes(cm[1])) return false;
      for (const am of rem.matchAll(/\[([a-zA-Z0-9_-]+)(?:(\^?=)"([^"]*)")?\]/g)) {
        const v = this.getAttribute(am[1]);
        if (am[2] === '=' && v !== am[3]) return false;
        if (am[2] === '^=' && (typeof v !== 'string' || !v.startsWith(am[3]))) return false;
        if (!am[2] && v === null) return false;
      }
      return true;
    }
    _matchChain(part) {
      const segs = part.trim().split(/\s+/).filter(Boolean);
      if (!segs.length || !this._matchOne(segs[segs.length - 1])) return false;
      let cur = this.parentElement;
      for (let i = segs.length - 2; i >= 0; i--) {
        while (cur && !cur._matchOne(segs[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    }
    querySelectorAll(sel) { const parts = String(sel).split(','); return this._walk((n) => parts.some((p) => n._matchChain(p))); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { for (let c = this; c; c = c.parentElement) if (c._matchChain(sel)) return c; return null; }
  }

  const docListeners = new Map();
  const doc = {
    hidden: false, visibilityState: 'visible',
    documentElement: new El('html'), head: new El('head'), body: new El('body'),
    createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t),
    createDocumentFragment: () => new El('fragment'), createTextNode: (t) => { const e = new El('#text'); e.textContent = String(t ?? ''); return e; },
    getElementById: (id) => doc.documentElement._walk((n) => n.id === id)[0] || null,
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    querySelector: (s) => doc.documentElement.querySelector(s),
    addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
    removeEventListener: (t, fn) => docListeners.get(t)?.delete(fn),
    dispatchDocEvent: (evt) => { for (const fn of [...(docListeners.get(evt.type) || [])]) fn(evt); },
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function makeMessageToolbar(doc, opts = {}) {
  const outer = doc.createElement('div');
  const toolbar = doc.createElement('div');
  toolbar.setAttribute('data-testid', 'cascade-system-message-toolbar');
  const group = doc.createElement('div');
  group.className = 'flex shrink-0 items-center';

  const copyBtn = doc.createElement('button');
  copyBtn.setAttribute('aria-label', opts.copyLabel || 'Copy');
  copyBtn.className = 'native-ghost-btn text-secondary-foreground hover:text-foreground h-7 w-7';
  group.appendChild(copyBtn);

  if (opts.sideQuestion) {
    const ins = doc.createElement('button');
    ins.setAttribute('data-testid', 'side-question-insert-to-main');
    group.appendChild(ins);
  }
  if (opts.nativeFork) {
    const nf = doc.createElement('button');
    nf.setAttribute('aria-label', opts.nativeForkLabel || 'Fork Conversation');
    group.appendChild(nf);
  }
  const goodBtn = doc.createElement('button');
  goodBtn.setAttribute('aria-label', opts.goodLabel || 'Good response');
  group.appendChild(goodBtn);

  toolbar.appendChild(group);
  outer.appendChild(toolbar);

  if (opts.fiberSteps || opts.isBattleFiber) {
    const kycFiber = {
      memoizedProps: { steps: opts.fiberSteps || [], isLatest: Boolean(opts.isLatest) },
      return: opts.isBattleFiber ? { memoizedProps: { value: { isBattleConversation: true } }, return: null } : null,
    };
    toolbar.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: {}, return: kycFiber } };
  }
  return { outer, toolbar, group, copyBtn, goodBtn };
}

function makeSidebarRow(doc, cascadeId, opts = {}) {
  const row = doc.createElement('div');
  row.setAttribute('data-testid', 'conversation-row-sidebar');
  row.setAttribute('data-cascade-id', cascadeId);
  if (opts.battleArms) row.setAttribute('data-battle-arms', opts.battleArms);
  const link = doc.createElement('a');
  link.setAttribute('href', `/c/${cascadeId}`);
  row.appendChild(link);
  const actions = doc.createElement('div');
  actions.className = 'agy-row-actions';
  row.appendChild(actions);
  return { row, link, actions };
}

test('buildForkConversationRequest & buildForkedConversationTitle sanitize options and increment [Fork N] without stacking', () => {
  assert.deepEqual(meterMain.buildForkConversationRequest(ACTIVE_ID), { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: -1, targetForkWorkspace: 1 });
  assert.deepEqual(meterMain.buildForkConversationRequest(ACTIVE_ID, { forkAtStepIndex: 12, targetForkWorkspace: 2 }), { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: 12, targetForkWorkspace: 2 });
  assert.deepEqual(meterMain.buildForkConversationRequest(ACTIVE_ID, { forkAtStepIndex: -9, targetForkWorkspace: 99 }), { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: -1, targetForkWorkspace: 1 });

  assert.equal(meterMain.buildForkedConversationTitle('标题', ['标题']), '[Fork] 标题');
  assert.equal(meterMain.buildForkedConversationTitle('[Fork] 标题', ['标题', '[Fork] 标题']), '[Fork 2] 标题');
  assert.equal(meterMain.buildForkedConversationTitle('[Fork 2] 标题', ['[Fork 2] 标题']), '[Fork 3] 标题');
  assert.equal(meterMain.buildForkedConversationTitle('', []), '[Fork]');
});

test('handleForkSession validates sender/UUID, calls ForkConversation + UpdateConversationAnnotations, and falls back to GetAllCascadeTrajectories', async () => {
  await assert.rejects(() => meterMain.handleForkSession({}, ACTIVE_ID, {}, { isLocalMainFrameSender: () => null }), /仅允许本机主聊天窗口/);
  const bad = await meterMain.handleForkSession({}, 'bad-id', {}, { isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/') });
  assert.equal(bad.ok, false);

  const calls = [];
  const res = await meterMain.handleForkSession(
    {},
    ACTIVE_ID,
    { forkAtStepIndex: 11, targetForkWorkspace: 2 },
    {
      isLocalMainFrameSender: () => new URL('https://127.0.0.1:54321/'),
      callRpc: async (method, body) => {
        calls.push({ method, body });
        if (method === 'ForkConversation') return { newCascadeId: NEW_ID, newProjectId: 'p1', warnings: ['w1', ''] };
        if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { [ACTIVE_ID]: { summary: '原会话' }, other: { summary: '[Fork] 原会话' } } };
        return {};
      },
    }
  );
  assert.equal(calls.map((c) => c.method).join(','), 'ForkConversation,GetAllCascadeTrajectories,UpdateConversationAnnotations');
  assert.deepEqual(calls[0].body, { sourceCascadeId: ACTIVE_ID, forkAtStepIndex: 11, targetForkWorkspace: 2 });
  assert.deepEqual(res, { ok: true, newCascadeId: NEW_ID, newProjectId: 'p1', newTitle: '[Fork 2] 原会话', warnings: ['w1'] });
});

test('preload generator exposes forkSession IPC without unused trajectory-turns bridge', () => {
  const code = modularInstaller.generateMeterPreloadCode();
  assert.ok(code.includes('forkSession:') && code.includes('context-meter:fork-session'));
  assert.equal(code.includes('getTrajectoryTurns:'), false);
});

test('message fork mounts after Copy, uses Fiber stepIndex, supports Scheme A interactions, filters invalid toolbars, and cleans up on dispose', async () => {
  buildRenderer();
  const doc = createDomHarness();
  const rowActive = makeSidebarRow(doc, ACTIVE_ID);
  doc.body.appendChild(rowActive.row);

  const tbHist = makeMessageToolbar(doc, {
    copyLabel: '复制', goodLabel: '优质回答', isLatest: false,
    fiberSteps: [{ step: { case: 'userInput' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 0 } } }, { step: { case: 'plannerResponse' }, status: 3, metadata: { sourceTrajectoryStepInfo: { stepIndex: 11 } } }],
  });
  const tbCleared = makeMessageToolbar(doc, {
    isLatest: false,
    fiberSteps: [{ step: { case: 'userInput' }, status: 5, metadata: { sourceTrajectoryStepInfo: { stepIndex: 12 } } }, { status: 5, metadata: { sourceTrajectoryStepInfo: { stepIndex: 17 } } }],
  });
  const tbNoFiberHist = makeMessageToolbar(doc, {}); // historical without Fiber -> must NOT guess -1
  const tbLatest = makeMessageToolbar(doc, {
    isLatest: true,
    fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } }],
  });
  const tbSide = makeMessageToolbar(doc, { sideQuestion: true, isLatest: true, fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 3 } } }] });
  const tbNative = makeMessageToolbar(doc, { nativeFork: true, nativeForkLabel: '派生分支会话', isLatest: true, fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } }] });
  const tbBattle = makeMessageToolbar(doc, { isBattleFiber: true, isLatest: true, fiberSteps: [{ metadata: { sourceTrajectoryStepInfo: { stepIndex: 25 } } }] });
  for (const x of [tbHist, tbCleared, tbNoFiberHist, tbLatest, tbSide, tbNative, tbBattle]) doc.body.appendChild(x.outer);

  const forkCalls = [];
  let pendingResolve = null;
  const sandbox = {
    console, Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, RegExp, Promise, Error, URL, AbortController,
    document: doc,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: `/c/${ACTIVE_ID}`, assign() {} },
    navigator: { platform: 'MacIntel', language: 'zh-CN' },
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); } },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(24, 24, 24)', display: 'block', visibility: 'visible', opacity: '1' }),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    contextMeterAPI: {
      forkSession: (id, opts) => { forkCalls.push({ id, opts }); return new Promise((r) => { pendingResolve = r; }); },
      getSettings: async () => ({ ok: false }),
      getTokenHistory: async () => ({ ok: false }),
    },
  };
  sandbox.window = sandbox.globalThis = sandbox;
  vm.runInNewContext(
    `${fs.readFileSync(path.join(ROOT, 'payload/dist/meter-core.js'), 'utf8')}\n${fs.readFileSync(path.join(ROOT, 'payload/dist/meter-renderer.js'), 'utf8')}`,
    sandbox,
    { filename: 'meter-renderer-message-fork.test.js' }
  );
  const api = sandbox.__AGContextMeter;

  // Sidebar stays untouched; message fork sits right after Copy
  assert.equal(rowActive.actions.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  const histBtn = tbHist.group.querySelector('button[data-hakimi-msg-fork="true"]');
  const latestBtn = tbLatest.group.querySelector('button[data-hakimi-msg-fork="true"]');
  const clearedBtn = tbCleared.group.querySelector('button[data-hakimi-msg-fork="true"]');
  assert.equal(tbHist.group.children[1], histBtn);
  assert.equal(histBtn.getAttribute('data-fork-step-index'), '11');
  assert.equal(latestBtn.getAttribute('data-fork-step-index'), '25');
  assert.equal(clearedBtn.disabled, true);
  assert.equal(tbNoFiberHist.group.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  assert.equal(tbSide.group.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  assert.equal(tbNative.group.querySelector('button[data-hakimi-msg-fork="true"]'), null);
  assert.equal(tbBattle.group.querySelector('button[data-hakimi-msg-fork="true"]'), null);

  // Tooltip renders and tracks panel language
  histBtn.dispatchEvent({ type: 'focus' });
  const tip = doc.getElementById('ag-message-fork-tooltip');
  assert.ok(tip && !tip.hidden && /从此处派生分支/.test(tip.textContent));
  await api.setPanelLanguage('en', { persist: false });
  assert.match(tip.textContent, /Fork from here/);
  await api.setPanelLanguage('zh-CN', { persist: false });
  histBtn.dispatchEvent({ type: 'blur' });
  assert.equal(tip.hidden, true);

  // Scheme A: left click -> Current Workspace (target=1) & activates new sidebar row
  histBtn.click({ shiftKey: false });
  assert.deepEqual(JSON.parse(JSON.stringify(forkCalls[0])), { id: ACTIVE_ID, opts: { forkAtStepIndex: 11, targetForkWorkspace: 1 } });
  assert.equal(histBtn.disabled, true);
  assert.equal(latestBtn.disabled, true);
  const rowNew = makeSidebarRow(doc, NEW_ID);
  let newClicks = 0;
  rowNew.link.addEventListener('click', () => { newClicks += 1; });
  doc.body.appendChild(rowNew.row);
  pendingResolve({ ok: true, newCascadeId: NEW_ID, warnings: [] });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(newClicks, 1);
  assert.equal(histBtn.disabled, false);

  // Scheme A: Shift+click -> New Worktree (target=2)
  histBtn.click({ shiftKey: true });
  assert.deepEqual(JSON.parse(JSON.stringify(forkCalls[1])), { id: ACTIVE_ID, opts: { forkAtStepIndex: 11, targetForkWorkspace: 2 } });
  pendingResolve({ ok: true, newCascadeId: WORKTREE_ID, warnings: [] });
  await new Promise((r) => setTimeout(r, 15));

  // Scheme A: Right-click menu -> Escape dismiss & option 2 click
  histBtn.dispatchEvent({ type: 'contextmenu' });
  const menu = doc.getElementById('ag-message-fork-menu');
  assert.ok(menu && !menu.hidden && menu.children.length === 2);
  doc.dispatchDocEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(menu.hidden, true);
  latestBtn.dispatchEvent({ type: 'contextmenu' });
  menu.children[1].click();
  assert.equal(menu.hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(forkCalls[2])), { id: ACTIVE_ID, opts: { forkAtStepIndex: 25, targetForkWorkspace: 2 } });
  pendingResolve({ ok: true, newCascadeId: WORKTREE_ID, warnings: [] });
  await new Promise((r) => setTimeout(r, 15));

  // Running state disables buttons; dispose removes everything
  const stopBtn = doc.createElement('button');
  stopBtn.setAttribute('data-testid', 'stop-button');
  doc.body.appendChild(stopBtn);
  api.syncMessageForkButtonsForTest();
  assert.equal(histBtn.disabled, true);
  stopBtn.remove();

  api.dispose();
  assert.equal(doc.querySelectorAll('button[data-hakimi-msg-fork="true"]').length, 0);
  assert.equal(doc.getElementById('ag-message-fork-style'), null);
  assert.equal(doc.getElementById('ag-message-fork-tooltip'), null);
  assert.equal(doc.getElementById('ag-message-fork-menu'), null);
});
