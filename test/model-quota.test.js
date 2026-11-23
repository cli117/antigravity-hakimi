'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { fetchUserStatusFromHost, getPluginSettings, savePluginSettings } = require('../payload/dist/meter-collector');
const { resolveModelQuotaGroup } = require('../payload/dist/meter-core');

const ROOT = path.resolve(__dirname, '..');

test('native quota summary supports shared Gemini windows and the separate Argon limit', async () => {
  const calls = [];
  const requestFn = async (method, body) => {
    calls.push([method, body]);
    if (method === 'GetUserStatus') return { userStatus: { email: 'user@example.com' } };
    if (method === 'GetAvailableModels') return {};
    if (method === 'RetrieveUserQuotaSummary') {
      return {
        response: {
          groups: [
            { displayName: 'Gemini Models', buckets: [
              { window: 'weekly', remainingFraction: 0.62, resetTime: '2026-11-30T00:00:00Z' },
              { window: '5h', remainingFraction: 0.49, resetTime: '2026-11-24T06:00:00Z' },
              { window: 'daily', remainingFraction: 0, disabled: true }
            ] },
            { displayName: 'Claude & GPT Models', buckets: [
              { window: 'weekly', remainingFraction: 0 }
            ] },
            { displayName: 'Gemini 4 Argon', buckets: [
              { window: 'weekly', remainingFraction: 0.55 }
            ] }
          ]
        }
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const status = await fetchUserStatusFromHost({ requestFn, force: true, remoteHostId: 'model-quota-test' });
  assert.ok(calls.some(([method, body]) => method === 'RetrieveUserQuotaSummary' && body.forceRefresh === false && body.request && typeof body.request === 'object'));
  const groups = status.modelQuotaGroups;
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon High', groups).window, '5h');
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon High', groups).remainingFraction, 0.49);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon High', groups).resetTime, '2026-11-24T06:00:00Z');
  assert.equal(resolveModelQuotaGroup('Gemini 4 Argon High', groups).remainingFraction, 0.55);
  assert.equal(resolveModelQuotaGroup('Claude Opus', groups).remainingFraction, 0);
  assert.equal(resolveModelQuotaGroup('claude_opus_5_5', groups).remainingFraction, 0);
  assert.equal(resolveModelQuotaGroup('Unknown model', groups), null);

  // Transient RetrieveUserQuotaSummary failure preserves previous quota groups for the same account
  const degraded = await fetchUserStatusFromHost({
    force: true,
    remoteHostId: 'model-quota-test',
    requestFn: async (method) => {
      if (method === 'GetUserStatus') return { userStatus: { email: 'user@example.com' } };
      if (method === 'GetAvailableModels') return {};
      if (method === 'RetrieveUserQuotaSummary') throw new Error('temporary 503');
      throw new Error(`Unexpected method: ${method}`);
    }
  });
  assert.equal(degraded.modelQuotaGroups.length, 3);

  // Account switch must NOT leak previous account's quota groups on transient failure
  const otherAccount = await fetchUserStatusFromHost({
    force: true,
    remoteHostId: 'model-quota-test',
    requestFn: async (method) => {
      if (method === 'GetUserStatus') return { userStatus: { email: 'other@example.com' } };
      if (method === 'GetAvailableModels') return {};
      if (method === 'RetrieveUserQuotaSummary') throw new Error('temporary 503');
      throw new Error(`Unexpected method: ${method}`);
    }
  });
  assert.equal(otherAccount.modelQuotaGroups, undefined);
});

test('quota summary supports top-level buckets and dedicated model groups without cross-leaking', async () => {
  const status = await fetchUserStatusFromHost({
    force: true,
    remoteHostId: 'model-quota-buckets-test',
    requestFn: async (method) => {
      if (method === 'GetUserStatus') return { userStatus: {} };
      if (method === 'GetAvailableModels') return {};
      if (method === 'RetrieveUserQuotaSummary') {
        return {
          response: {
            buckets: [
              { displayName: 'Gemini 4 Models', window: 'daily', remaining: { remainingFraction: 0.72 } },
              { displayName: 'Gemini 4 Carbon', window: 'weekly', remainingFraction: 0.35 },
              { displayName: 'Claude Models', window: '5h', remainingFraction: 0.81 }
            ]
          }
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  });

  const groups = status.modelQuotaGroups;
  assert.equal(resolveModelQuotaGroup('Gemini 4 Carbon (High)', groups).remainingFraction, 0.35);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon (High)', groups).remainingFraction, 0.72);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon (High)', groups).window, 'daily');
  assert.equal(resolveModelQuotaGroup(['Claude Sonnet 5.5', 'claude_sonnet_5_5'], groups).remainingFraction, 0.81);
  // When no dedicated Argon group exists, Argon falls back to shared Gemini group instead of losing weekly quota
  assert.equal(resolveModelQuotaGroup('Gemini 4 Argon (High)', groups).remainingFraction, 0.72);
});

test('Pro-tier quota group splits (Gemini Pro/Flash, multi-model names, description fallback) match accurately', async () => {
  const status = await fetchUserStatusFromHost({
    force: true,
    remoteHostId: 'model-quota-pro-test',
    requestFn: async (method) => {
      if (method === 'GetUserStatus') return { userStatus: { userTier: { name: 'Google AI Pro' } } };
      if (method === 'GetAvailableModels') return {};
      if (method === 'RetrieveUserQuotaSummary') {
        return {
          response: {
            groups: [
              { displayName: 'Gemini Pro (Shared)', buckets: [{ window: 'weekly', remainingFraction: 0.44 }] },
              { displayName: 'Gemini 3 Flash', buckets: [{ window: 'weekly', remainingFraction: 0.91 }] },
              { displayName: 'Gemini 4 Neon & Carbon', buckets: [{ window: 'weekly', remainingFraction: 0.33 }] },
              { displayName: 'Partner Models', description: 'Includes Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B', buckets: [{ window: 'weekly', remainingFraction: 0.25 }] }
            ]
          }
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  });

  const groups = status.modelQuotaGroups;
  assert.equal(resolveModelQuotaGroup('Gemini 3.1 Pro (High)', groups).remainingFraction, 0.44);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Hydrogen (High)', groups).remainingFraction, 0.44);
  assert.equal(resolveModelQuotaGroup('Gemini 3.8 Flash (High)', groups).remainingFraction, 0.91);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Neon (High)', groups).remainingFraction, 0.33);
  assert.equal(resolveModelQuotaGroup('Gemini 4 Carbon (High)', groups).remainingFraction, 0.33);
  assert.equal(resolveModelQuotaGroup('Claude Opus 5.5 (High)', groups).remainingFraction, 0.25);
  assert.equal(resolveModelQuotaGroup('Unknown model', groups), null);
});

function createMinimalDomHarness() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.id = '';
      this.className = '';
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.hidden = false;
      this.title = '';
      this._textContent = '';
      this._value = null;
      this.shadowRoot = null;
      this.rect = { left: 0, top: 0, width: 220, height: 32, right: 220, bottom: 32 };
      this._listeners = new Map();
      this.style = {
        _props: new Map(),
        setProperty(k, v) { this._props.set(k, String(v)); },
        getPropertyValue(k) { return this._props.get(k) || ''; },
        removeProperty(k) { this._props.delete(k); },
        cssText: ''
      };
      this.classList = {
        contains: (c) => String(this.className || '').split(/\s+/).includes(c),
        add: (c) => {
          const parts = String(this.className || '').split(/\s+/).filter(Boolean);
          if (!parts.includes(c)) parts.push(c);
          this.className = parts.join(' ');
        },
        remove: (c) => {
          this.className = String(this.className || '').split(/\s+/).filter(x => x && x !== c).join(' ');
        },
        toggle: (c, force) => {
          const has = this.classList.contains(c);
          const next = force !== undefined ? Boolean(force) : !has;
          if (next) this.classList.add(c);
          else this.classList.remove(c);
        }
      };
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body || cur === doc.documentElement) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
    }
    get textContent() {
      if (this.children.length) return this.children.map(c => c.textContent).join('');
      return this._textContent;
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
    }
    get value() { return this._value; }
    set value(v) {
      this._value = Number(v);
      this.attributes.set('value', String(v));
    }
    set innerHTML(html) {
      this._innerHTML = String(html || '');
      this.children = [];
      const stripped = this._innerHTML.replace(/<style\b[\s\S]*?<\/style>/gi, '');
      const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
      let m;
      while ((m = tagRe.exec(stripped)) !== null) {
        const child = new FakeElement(m[1]);
        const attrStr = m[2] || '';
        const attrRe = /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRe.exec(attrStr)) !== null) {
          const k = am[1];
          const val = am[2] ?? '';
          if (k === 'id') child.id = val;
          else if (k === 'class') child.className = val;
          else if (k === 'hidden') child.hidden = true;
          child.attributes.set(k, val);
        }
        child.parentElement = this;
        this.children.push(child);
      }
    }
    attachShadow() {
      this.shadowRoot = new FakeElement('shadow-root');
      return this.shadowRoot;
    }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentElement) child.remove();
      const idx = this.children.indexOf(ref);
      child.parentElement = this;
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      for (const n of nodes) {
        if (n) this.appendChild(n);
      }
    }
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSimpleSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k === 'hidden') this.hidden = true;
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k === 'value') this._value = null;
      if (k === 'hidden') this.hidden = false;
    }
    getBoundingClientRect() { return this.rect; }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
    cloneNode() {
      const c = new FakeElement(this.tagName);
      c._textContent = this.textContent;
      return c;
    }
    getElementById(id) {
      for (const node of walk(this)) {
        if (node.id === id) return node;
      }
      return null;
    }
    querySelectorAll(sel) {
      const selectors = String(sel).split(',').map(s => s.trim()).filter(Boolean);
      const out = [];
      for (const node of walk(this)) {
        if (node === this) continue;
        if (selectors.some(s => matchesSimpleSelector(node, s))) out.push(node);
      }
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  function* walk(root) {
    yield root;
    for (const c of root.children) yield* walk(c);
  }

  function matchesSimpleSelector(el, sel) {
    if (!el || !sel) return false;
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel === 'div[role="navigation"]') return el.tagName === 'DIV' && el.getAttribute('role') === 'navigation';
    if (sel === 'nav') return el.tagName === 'NAV';
    if (sel === 'aside') return el.tagName === 'ASIDE';
    if (sel === '[class*="@container/titlebar"]') return String(el.className || '').includes('@container/titlebar');
    if (sel === '[data-testid="model-selector-trigger"]') return el.getAttribute('data-testid') === 'model-selector-trigger';
    if (sel === 'button') return el.tagName === 'BUTTON';
    if (sel === 'a') return el.tagName === 'A';
    if (sel === '[role="button"]') return el.getAttribute('role') === 'button';
    if (sel === '[data-i18n]') return el.hasAttribute('data-i18n');
    if (sel === '[data-i18n-title]') return el.hasAttribute('data-i18n-title');
    if (sel === '[data-i18n-aria]') return el.hasAttribute('data-i18n-aria');
    if (sel === '[data-i18n-placeholder]') return el.hasAttribute('data-i18n-placeholder');
    return false;
  }

  const doc = {
    hidden: false,
    documentElement: new FakeElement('html'),
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement('fragment'),
    createTextNode: (t) => { const el = new FakeElement('#text'); el._textContent = String(t ?? ''); return el; },
    getElementById: (id) => doc.body.getElementById(id) || doc.head.getElementById(id),
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return { doc, FakeElement };
}

function bootQuotaRendererFixture(options = {}) {
  const { doc } = createMinimalDomHarness();

  // Simulated Antigravity sidebar (collapsible wrapper + display:contents wrapper) + titlebar + model selector
  const navWrapper = doc.createElement('div');
  navWrapper.rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
  navWrapper.computedStyle = { display: 'flex', overflowX: 'hidden', visibility: 'visible', opacity: '1' };
  const contentsWrapper = doc.createElement('div');
  // display: contents has 0x0 rect even when sidebar is expanded! Must NOT falsely trigger collapse!
  contentsWrapper.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  contentsWrapper.computedStyle = { display: 'contents', visibility: 'visible', opacity: '1' };
  const nav = doc.createElement('div');
  nav.setAttribute('role', 'navigation');
  nav.rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
  const navHeader = doc.createElement('div');
  navHeader.rect = { left: 0, top: 0, width: 240, height: 40, right: 240, bottom: 40 };
  const navList = doc.createElement('div');
  navList.rect = { left: 0, top: 40, width: 240, height: 700, right: 240, bottom: 740 };
  const settingsFooter = doc.createElement('div');
  settingsFooter.rect = { left: 0, top: 750, width: 240, height: 48, right: 240, bottom: 798 };
  const settingsBtn = doc.createElement('button');
  settingsBtn.textContent = '设置';
  settingsBtn.rect = { left: 8, top: 758, width: 224, height: 32, right: 232, bottom: 790 };
  settingsFooter.appendChild(settingsBtn);
  nav.appendChild(navHeader);
  nav.appendChild(navList);
  nav.appendChild(settingsFooter);
  contentsWrapper.appendChild(nav);
  navWrapper.appendChild(contentsWrapper);
  doc.body.appendChild(navWrapper);

  const titlebar = doc.createElement('div');
  titlebar.className = '@container/titlebar flex items-center';
  doc.body.appendChild(titlebar);

  const trigger = doc.createElement('button');
  trigger.setAttribute('data-testid', 'model-selector-trigger');
  trigger.textContent = options.initialModel || 'Gemini 4 Neon (High)';
  trigger.rect = { left: 300, top: 740, width: 160, height: 28, right: 460, bottom: 768 };
  doc.body.appendChild(trigger);

  const sandbox = {
    console, Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, RegExp, Promise, Error, URL, AbortController,
    document: doc,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-2222-3333-4444-555555555555' },
    navigator: { platform: 'MacIntel', language: 'zh-CN' },
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); } },
    matchMedia: () => ({ matches: true, addEventListener: () => {} }),
    getComputedStyle: (el) => el?.computedStyle || { backgroundColor: 'rgb(24, 24, 24)', display: 'block', visibility: 'visible', opacity: '1' },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(options.bootSettings !== undefined ? { __AGContextMeterSettings: options.bootSettings } : {}),
    ...(options.contextMeterAPI ? { contextMeterAPI: options.contextMeterAPI } : {})
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const coreSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  vm.runInNewContext(`${coreSrc}\n${rendererSrc}`, sandbox, { filename: options.filename || 'meter-renderer-quota-test.js' });
  return { doc, sandbox, api: sandbox.__AGContextMeter, navWrapper, nav, settingsFooter, trigger };
}

test('renderer mounts model quota above Settings in sidebar, survives language switch, and handles collapse memory', async () => {
  const { doc, sandbox, api, navWrapper, nav, settingsFooter, trigger } = bootQuotaRendererFixture();
  assert.ok(api, 'meter runtime should initialize');

  // Feed real quota payload (both groups and per-model configs)
  const weeklyResetIso = new Date(Date.now() + (3 * 24 + 5) * 3600 * 1000).toISOString();
  const fiveHourResetIso = new Date(Date.now() + (2 * 60 + 15) * 60 * 1000).toISOString();
  api.applyTokenHistoryPayload({
    rawPlanStatus: {
      status: 'identified',
      email: 'user@example.com',
      modelQuotaGroups: [
        { displayName: 'Gemini Models', buckets: [
          { window: 'weekly', remainingFraction: 0.62, resetTime: weeklyResetIso },
          { window: '5h', remainingFraction: 0.12, resetTime: fiveHourResetIso }
        ] },
        { displayName: 'Claude & GPT Models', buckets: [
          { window: 'weekly', remainingFraction: 0.002, resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
          { window: '5h', remainingFraction: 0.45, resetTime: fiveHourResetIso }
        ] },
        { displayName: 'Gemini 4 Argon', buckets: [
          { window: 'weekly', remainingFraction: 0.55, resetTime: weeklyResetIso }
        ] }
      ]
    },
    cascadeModelConfigs: [
      { modelId: 'model-custom-x', label: 'Custom Model X', quotaInfo: { remainingFraction: 0.4, resetTime: fiveHourResetIso } }
    ],
    summary: { grandTotalTokens: 1000 },
    dailyMap: { '2026-11-24': { total: 1000, input: 600, output: 200, cache: 200, steps: 1 } }
  });

  const quotaHost = doc.getElementById('ag-model-quota-host');
  assert.ok(quotaHost, 'independent #ag-model-quota-host should exist');
  assert.equal(quotaHost.parentElement, nav, 'quota host should dock inside left sidebar nav');
  assert.equal(quotaHost.nextSibling, settingsFooter, 'quota host should sit directly above Settings footer');
  assert.equal(doc.getElementById('ag-context-meter').contains(quotaHost), false, 'quota host must not be trapped inside topbar host');

  let qs = api.getModelQuotaStateForTest();
  assert.equal(qs.hidden, false);
  assert.equal(qs.dock, 'sidebar');
  assert.equal(qs.minimized, false);
  assert.equal(qs.cardVisible, true);
  assert.equal(qs.dotVisible, false);
  assert.equal(qs.primaryTitle, '本周');
  assert.ok(qs.primaryReset.includes('3天') && qs.primaryReset.includes('重置'), `expected weekly reset countdown, got: ${qs.primaryReset}`);
  assert.equal(qs.amount, '已用 38%');
  assert.equal(qs.progressValue, 38);
  assert.equal(qs.primaryState, 'normal');
  assert.equal(qs.toggle5hVisible, true);
  assert.equal(qs.show5hRow, true);
  assert.equal(qs.title5h, '5 小时');
  assert.ok(qs.reset5h.includes('2时') && qs.reset5h.includes('重置'), `expected 5h reset countdown, got: ${qs.reset5h}`);
  assert.equal(qs.amount5h, '已用 88%');
  assert.equal(qs.progress5hValue, 88);
  assert.equal(qs.state5h, 'warn');
  assert.equal(qs.quotaState, 'warn'); // worst of visible rows
  assert.ok(qs.title.includes('本周已用 38%'));
  assert.ok(qs.title.includes('5 小时已用 88%'));
  assert.ok(qs.title.includes('重置：'));

  // Toggle 5h row hidden -> hides 5h row, lights alert dot because 5h is in warn state
  assert.equal(api.toggleModelQuota5hForTest(), false);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.toggle5hVisible, true);
  assert.equal(qs.show5hRow, false);
  assert.equal(qs.alertDot5hVisible, true);
  assert.equal(qs.quotaState, 'normal');
  assert.equal(sandbox.localStorage.getItem('ag_quota_show_5h'), '0');

  // Minimize while 5h is hidden -> dot shows SINGLE outer ring only (inner ring + track hidden!)
  assert.equal(api.setModelQuotaMinimizedForTest(true), true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.minimized, true);
  assert.equal(qs.cardVisible, false);
  assert.equal(qs.dotVisible, true);
  assert.equal(qs.quotaState, 'normal', 'host state matches visible outer ring when 5h is hidden');
  assert.equal(qs.dotOuterState, 'normal', 'outer ring (weekly 38%) should stay normal');
  assert.equal(qs.dotOuterOpacity, '1');
  assert.ok(parseFloat(qs.dotOuterDash) > 17 && parseFloat(qs.dotOuterDash) < 20, `outer arc ~38% of 48.69, got ${qs.dotOuterDash}`);
  assert.equal(qs.dotInnerVisible, false, 'when 5h is collapsed, minimized dot must show single outer ring only');
  assert.ok(qs.dotTitle.includes('本周已用 38%') && qs.dotTitle.includes('5 小时已用 88%') && qs.dotTitle.includes('重置：'));
  assert.equal(sandbox.localStorage.getItem('ag_quota_minimized'), '1');

  // Expand back from dot -> restores weekly-only, then re-enable 5h row and verify dual concentric rings!
  assert.equal(api.setModelQuotaMinimizedForTest(false), false);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.minimized, false);
  assert.equal(qs.cardVisible, true);
  assert.equal(qs.show5hRow, false);

  assert.equal(api.toggleModelQuota5hForTest(), true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.show5hRow, true);
  assert.equal(qs.alertDot5hVisible, false);
  assert.equal(qs.quotaState, 'warn');
  assert.equal(qs.dotOuterState, 'normal');
  assert.equal(qs.dotInnerVisible, true, 'when 5h is expanded, dot renders dual concentric rings');
  assert.equal(qs.dotInnerState, 'warn', 'inner ring (5h 88%) independently shows warn state');
  assert.equal(qs.dotInnerOpacity, '1');
  assert.ok(parseFloat(qs.dotInnerDash) > 23 && parseFloat(qs.dotInnerDash) < 25, `inner arc ~88% of 27.33, got ${qs.dotInnerDash}`);

  // Language switch must NOT wipe modelQuotaConfigs or modelQuotaGroups, and must re-render immediately
  await api.setPanelLanguage('en', { persist: false });
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.configsCount, 1, 'language switch must preserve modelQuotaConfigs');
  assert.equal(qs.groupsCount, 3, 'language switch must preserve modelQuotaGroups');
  assert.equal(qs.primaryTitle, 'Weekly');
  assert.ok(qs.primaryReset.includes('3d'), `expected en countdown, got: ${qs.primaryReset}`);
  assert.ok(qs.reset5h.includes('2h'), `expected en 5h countdown, got: ${qs.reset5h}`);
  assert.equal(qs.amount, '38% used');
  assert.equal(qs.title5h, '5h');
  assert.equal(qs.amount5h, '88% used');

  // Partial payload without modelQuotaGroups (e.g., archive fallback) must NOT wipe existing quota groups
  api.applyTokenHistoryPayload({
    rawPlanStatus: { status: 'identified', email: 'user@example.com' },
    summary: { grandTotalTokens: 1000 },
    dailyMap: { '2026-11-24': { total: 1000, input: 600, output: 200, cache: 200, steps: 1 } }
  });
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.groupsCount, 3);
  assert.equal(qs.amount, '38% used');

  // Claude shows weekly (danger, 99% clamped for 0 < remaining < 0.005) + 5h simultaneously, with independent ring colors
  trigger.textContent = 'Claude Opus 5.5';
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.primaryTitle, 'Weekly');
  assert.equal(qs.primaryState, 'danger');
  assert.equal(qs.quotaState, 'danger');
  assert.equal(qs.amount, '99% used');
  assert.equal(qs.progressValue, 99);
  assert.equal(qs.show5hRow, true);
  assert.equal(qs.amount5h, '55% used');
  assert.equal(qs.dotOuterState, 'danger');
  assert.equal(qs.dotInnerVisible, true);
  assert.equal(qs.dotInnerState, 'normal');

  // Argon has only weekly -> 5h toggle AND inner ring/track are hidden cleanly
  trigger.textContent = 'Gemini 4 Argon (High)';
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.primaryTitle, 'Weekly');
  assert.equal(qs.amount, '45% used');
  assert.equal(qs.toggle5hVisible, false);
  assert.equal(qs.show5hRow, false);
  assert.equal(qs.dotOuterState, 'normal');
  assert.equal(qs.dotOuterOpacity, '1');
  assert.equal(qs.dotInnerVisible, false, 'single-window model (Argon) must hide inner ring and track');

  // Unknown model with no quota data -> no colored arc drawn on outer ring, inner ring hidden
  trigger.textContent = 'Unknown Model Z';
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.dotOuterState, 'unknown');
  assert.equal(qs.dotOuterOpacity, '0');
  assert.equal(qs.dotInnerVisible, false);

  // Per-model fallback still works after language switch (and has no dangling leading "·" when window title is empty)
  trigger.textContent = 'Custom Model X';
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.amount, '60% used');
  assert.equal(qs.progressValue, 60);
  assert.equal(qs.primaryTitle, '');
  assert.ok(qs.primaryReset.includes('2h') && !qs.primaryReset.startsWith('·'), `expected clean countdown without leading dot, got: ${qs.primaryReset}`);
  assert.equal(qs.toggle5hVisible, false);
  assert.equal(qs.dotInnerVisible, false);

  // 1) While expanded in sidebar: collapsing sidebar auto-minimizes to status dot on body
  assert.equal(api.getModelQuotaStateForTest().minimized, false);
  nav.rect = { left: 0, top: 0, width: 0, height: 800, right: 0, bottom: 800 };
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.hidden, false);
  assert.equal(qs.dock, 'fixed');
  assert.equal(qs.minimized, true, 'collapsing sidebar while expanded should auto-minimize to dot');
  assert.equal(qs.dotVisible, true);
  assert.equal(qs.cardVisible, false);
  assert.equal(quotaHost.parentElement, doc.body);

  // Peeking by clicking dot while sidebar stays collapsed expands temporary floating card
  api.setModelQuotaMinimizedForTest(false);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.dock, 'fixed');
  assert.equal(qs.minimized, false);
  assert.equal(qs.cardVisible, true);

  // Re-expanding sidebar restores remembered expanded state above Settings footer
  nav.rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.dock, 'sidebar');
  assert.equal(qs.minimized, false, 're-expanding sidebar should restore remembered expanded state');
  assert.equal(quotaHost.parentElement, nav);

  // 2) While manually minimized in sidebar: collapsing then re-expanding sidebar MUST stay minimized!
  api.setModelQuotaMinimizedForTest(true);
  assert.equal(api.getModelQuotaStateForTest().minimized, true);

  // Collapsing via transform translateX(-100%) (width stays 240, right=0) moves dot to body
  nav.rect = { left: -240, top: 0, width: 240, height: 800, right: 0, bottom: 800 };
  api.renderModelQuotaForTest(true);
  assert.equal(api.getModelQuotaStateForTest().dock, 'fixed');
  assert.equal(api.getModelQuotaStateForTest().minimized, true);
  assert.equal(quotaHost.parentElement, doc.body);

  // Re-expanding sidebar remembers userMinimized=true -> MUST NOT auto-expand!
  nav.rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
  api.renderModelQuotaForTest(true);
  assert.equal(api.getModelQuotaStateForTest().dock, 'sidebar');
  assert.equal(api.getModelQuotaStateForTest().minimized, true, 're-expanding sidebar must stay minimized when user minimized before collapsing');

  // Restore expanded state and test outer clipping wrapper collapse (width=0 while inner nav stays 240)
  api.setModelQuotaMinimizedForTest(false);
  assert.equal(api.getModelQuotaStateForTest().minimized, false);

  navWrapper.rect = { left: 0, top: 0, width: 0, height: 800, right: 0, bottom: 800 };
  api.renderModelQuotaForTest(true);
  assert.equal(api.getModelQuotaStateForTest().dock, 'fixed');
  assert.equal(api.getModelQuotaStateForTest().minimized, true);
  assert.equal(quotaHost.parentElement, doc.body);

  // Re-expanding wrapper re-docks expanded card above Settings footer; removing trigger (e.g. Settings page) hides it
  navWrapper.rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
  api.renderModelQuotaForTest(true);
  qs = api.getModelQuotaStateForTest();
  assert.equal(qs.hidden, false);
  assert.equal(qs.dock, 'sidebar');
  assert.equal(qs.minimized, false);
  assert.equal(quotaHost.parentElement, nav);
  assert.equal(quotaHost.nextSibling, settingsFooter);

  trigger.remove();
  api.renderModelQuotaForTest(true);
  assert.equal(api.getModelQuotaStateForTest().hidden, true);

  // Dispose removes #ag-model-quota-host
  api.dispose();
  assert.equal(doc.getElementById('ag-model-quota-host'), null);
});

test('model quota display state (weekly-only / minimized single or dual ring) persists across random-port restarts via host uiPreferences', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-quota-persist-'));
  try {
    const quotaPayload = {
      rawPlanStatus: {
        status: 'identified',
        email: 'ultra@example.com',
        modelQuotaGroups: [
          { displayName: 'Gemini Models', buckets: [
            { window: 'weekly', remainingFraction: 0.62, resetTime: new Date(Date.now() + 72 * 3600 * 1000).toISOString() },
            { window: '5h', remainingFraction: 0.12, resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString() }
          ] }
        ]
      },
      summary: { grandTotalTokens: 100 },
      dailyMap: { '2026-11-24': { total: 100, input: 50, output: 25, cache: 25, steps: 1 } }
    };
    const bootRendererOnFreshOrigin = (bootSettings) => bootQuotaRendererFixture({
      bootSettings,
      filename: 'meter-renderer-persist-test.js',
      contextMeterAPI: {
        getSettings: async () => getPluginSettings({ agDir: tmpDir }),
        saveSettings: async (p) => savePluginSettings(p, { agDir: tmpDir })
      }
    }).api;

    // Session 1: User hides 5h row and minimizes to single-ring dot, then exits
    const api1 = bootRendererOnFreshOrigin(getPluginSettings({ agDir: tmpDir }));
    api1.applyTokenHistoryPayload(quotaPayload);
    api1.toggleModelQuota5hForTest(); // false -> weekly-only
    api1.setModelQuotaMinimizedForTest(true); // true -> minimized single ring
    await new Promise(r => setTimeout(r, 20));
    api1.dispose();

    const disk1 = getPluginSettings({ agDir: tmpDir });
    assert.equal(disk1.uiPreferences.quotaShow5h, false);
    assert.equal(disk1.uiPreferences.quotaMinimized, true);

    // Session 2 (fresh port, empty localStorage): restarts directly as minimized SINGLE-RING dot!
    const api2 = bootRendererOnFreshOrigin(disk1);
    api2.applyTokenHistoryPayload(quotaPayload);
    let qs = api2.getModelQuotaStateForTest();
    assert.equal(qs.minimized, true);
    assert.equal(qs.dotVisible, true);
    assert.equal(qs.cardVisible, false);
    assert.equal(qs.dotInnerVisible, false, 'single-ring dot must persist across restart');
    assert.equal(qs.dotOuterState, 'normal');

    // Expanding in Session 2 shows weekly-only (no 5h row), then user re-enables 5h and minimizes as DUAL-RING dot
    api2.setModelQuotaMinimizedForTest(false);
    qs = api2.getModelQuotaStateForTest();
    assert.equal(qs.cardVisible, true);
    assert.equal(qs.show5hRow, false, 'weekly-only state must persist across restart');

    api2.toggleModelQuota5hForTest(); // true -> weekly + 5h
    api2.setModelQuotaMinimizedForTest(true); // true -> minimized dual ring
    await new Promise(r => setTimeout(r, 20));
    api2.dispose();

    // Session 3 (fresh port, empty localStorage): restarts directly as minimized DUAL-RING dot!
    const disk2 = getPluginSettings({ agDir: tmpDir });
    assert.equal(disk2.uiPreferences.quotaShow5h, true);
    assert.equal(disk2.uiPreferences.quotaMinimized, true);

    const api3 = bootRendererOnFreshOrigin(disk2);
    api3.applyTokenHistoryPayload(quotaPayload);
    qs = api3.getModelQuotaStateForTest();
    assert.equal(qs.minimized, true);
    assert.equal(qs.dotVisible, true);
    assert.equal(qs.dotInnerVisible, true, 'dual-ring dot must persist across restart');
    assert.equal(qs.dotOuterState, 'normal');
    assert.equal(qs.dotInnerState, 'warn');
    api3.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
