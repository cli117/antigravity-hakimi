'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const asarEngine = require(path.join(ROOT, 'payload', 'dist', 'asar-engine.js'));
const { packHakimiAsar } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar.js'));
const { buildMacosIcon } = require(path.join(ROOT, 'scripts', 'build-macos-icon.js'));
const { replaceAsarIcon } = require(path.join(ROOT, 'scripts', 'replace-asar-icon.js'));
const meterCore = require(path.join(ROOT, 'payload', 'dist', 'meter-core.js'));
const contextUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-context-unlock.js'));
const modulesConfig = require(path.join(ROOT, 'payload', 'dist', 'modules-config.js'));
const { runDoctor } = require(path.join(ROOT, 'scripts', 'doctor.js'));

const EXCLUDED_SYMBOLS = [
  'meter-proxy',
  'meter-cli-launcher',
  'ensureProxyEnvironment',
  'testProxy',
  'badge-cli',
  'cli-launch-toast',
  'overflow-cli-btn',
  'launch-cli',
  'check-update',
  'apply-update',
  'update-popover',
  'btn-check-update',
  'check-auto-update',
  'proxy-notun-drawer',
  'enhance-tier-',
  'chk-rec-prompt',
  'parsePeEmbedTemplates',
  'PROMPT_TIER_META',
  'badge.clickOpenCli',
  'GEMINI_PRICING_TABLE',
  'calculateRequestApiCost',
  'calculateReferenceModelCost',
  'SUBSCRIPTION_REGIONS_PRESET',
  'tok-view-cost',
  'cost-estimate-card',
  'round-cost-bar',
  'plan-summary-price-badge',
];

function collectJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('all JS files in payload/dist, scripts, and src/renderer pass vm.Script syntax check', () => {
  const jsFiles = [
    ...collectJsFiles(path.join(ROOT, 'payload', 'dist')),
    ...collectJsFiles(path.join(ROOT, 'scripts')),
    ...collectJsFiles(path.join(ROOT, 'src', 'renderer')),
  ];
  assert.ok(jsFiles.length >= 18, `expected >= 18 JS files, got ${jsFiles.length}`);
  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const cleanSrc = src.startsWith('#!') ? '//' + src.slice(2) : src;
    assert.doesNotThrow(() => new vm.Script(cleanSrc, { filename: file }), `Syntax error in ${file}`);
  }
});

test('excluded features (Tiers 0-4, No-TUN proxy, CLI launcher, updater) are pruned from payload and renderer', () => {
  const payloadJs = fs
    .readdirSync(path.join(ROOT, 'payload', 'dist'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(ROOT, 'payload', 'dist', f));
  const rendererFiles = fs
    .readdirSync(path.join(ROOT, 'src', 'renderer'))
    .map((f) => path.join(ROOT, 'src', 'renderer', f));

  for (const file of [...payloadJs, ...rendererFiles]) {
    let text = fs.readFileSync(file, 'utf8');
    // modular-installer.js intentionally strips legacy proxy hooks inside cleanUtilsSource()
    if (path.basename(file) === 'modular-installer.js') {
      text = text
        .split('\n')
        .filter((line) => !line.includes('\\.ensureProxyEnvironment\\('))
        .join('\n');
    }
    for (const sym of EXCLUDED_SYMBOLS) {
      assert.equal(
        text.includes(sym),
        false,
        `Excluded symbol "${sym}" must not appear in ${path.relative(ROOT, file)}`
      );
    }
  }
});

test('src/renderer/template.html has balanced <div> tags and 4 brand title modes including hakimi', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const opens = (tpl.match(/<div\b/g) || []).length;
  const closes = (tpl.match(/<\/div>/g) || []).length;
  assert.equal(opens, closes, `Unbalanced <div> tags: opens=${opens}, closes=${closes}`);

  for (const mode of ['hakimi', 'translated', 'hidden', 'english']) {
    assert.ok(
      tpl.includes(`data-brand-title="${mode}"`),
      `Missing brand title button for mode: ${mode}`
    );
  }
  assert.ok(tpl.includes('id="btn-brand-hakimi"'), 'Missing #btn-brand-hakimi');
});

test('assertNotOfficialAntigravityApp blocks official Antigravity.app, .orig, and symlinks while allowing 哈基米.app', () => {
  for (const forbidden of [
    '/Applications/Antigravity.app',
    '/Applications/Antigravity.app.orig',
    '/Applications/Antigravity.app/Contents/Resources/app.asar',
    '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    '/Applications/Antigravity.app.orig/Contents/Resources/app.asar',
  ]) {
    assert.equal(asarEngine.isOfficialAntigravityPath(forbidden), true, `Expected official path: ${forbidden}`);
    assert.throws(
      () => asarEngine.assertNotOfficialAntigravityApp(forbidden, 'modify'),
      /Refusing to modify official Antigravity\.app/
    );
  }

  // Symlink pointing to official /Applications/Antigravity.app
  if (fs.existsSync('/Applications/Antigravity.app')) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-symlink-guard-'));
    try {
      const linkApp = path.join(tmpDir, 'HarmlessName.app');
      fs.symlinkSync('/Applications/Antigravity.app', linkApp);
      assert.equal(asarEngine.isOfficialAntigravityPath(linkApp), true);
      assert.throws(() => asarEngine.assertNotOfficialAntigravityApp(linkApp, 'overwrite'));
      assert.throws(() =>
        asarEngine.assertNotOfficialAntigravityApp(path.join(linkApp, 'Contents', 'Resources', 'app.asar'), 'write')
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  for (const allowed of [
    '/Applications/哈基米.app',
    '/Applications/哈基米.app/Contents/Resources/app.asar',
    '/Applications/哈基米.app/Contents/Resources/bin/language_server',
    '/tmp/hakimi-stage/哈基米.app',
  ]) {
    assert.equal(asarEngine.isOfficialAntigravityPath(allowed), false, `Expected allowed path: ${allowed}`);
    assert.doesNotThrow(() => asarEngine.assertNotOfficialAntigravityApp(allowed, 'modify'));
  }
});

function createMockElement(tagName, attrs = {}, className = '') {
  const el = {
    nodeType: 1,
    tagName: String(tagName || 'DIV').toUpperCase(),
    attributes: { ...attrs },
    className,
    style: {},
    childNodes: [],
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    get firstChild() {
      return this.childNodes[0] || null;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k);
    },
    appendChild(child) {
      const prev = this.childNodes[this.childNodes.length - 1] || null;
      if (prev) prev.nextSibling = child;
      child.parentNode = this;
      child.parentElement = this;
      child.nextSibling = null;
      this.childNodes.push(child);
      return child;
    },
    matches(selector) {
      const parts = String(selector || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (/^[a-z0-9]+$/i.test(p) && this.tagName === p.toUpperCase()) return true;
        if (p.startsWith('#') && this.id === p.slice(1)) return true;
        if (p.startsWith('.') && this.className.split(/\s+/).includes(p.slice(1))) return true;
        const eqAttr = p.match(/^\[([a-z0-9_-]+)="([^"]*)"\]$/i);
        if (eqAttr && this.getAttribute(eqAttr[1]) === eqAttr[2]) return true;
        const subClass = p.match(/^\[class\*="([^"]*)"\]$/i);
        if (subClass && this.className.toLowerCase().includes(subClass[1].toLowerCase())) return true;
      }
      return false;
    },
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

function createMockTextNode(value) {
  return {
    nodeType: 3,
    nodeValue: value,
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    previousSibling: null,
  };
}

test('i18n-runtime supports lossless 4-way brand title switching (hakimi <-> hidden <-> translated <-> english) without touching chat prose', () => {
  const runtimeCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js'), 'utf8');

  const rootEl = createMockElement('HTML');
  const bodyEl = createMockElement('BODY');
  const titleBar = createMockElement('DIV', {}, 'titlebar-container');
  const brandBtn = createMockElement('DIV', { 'data-testid': 'title-menu-bar-item' }, 'titlebar-left');
  const brandText = createMockTextNode('Antigravity');
  brandBtn.appendChild(brandText);
  titleBar.appendChild(brandBtn);

  const chatMsg = createMockElement('P', {}, 'chat-message');
  const chatText = createMockTextNode('Antigravity');
  chatMsg.appendChild(chatText);

  bodyEl.appendChild(titleBar);
  bodyEl.appendChild(chatMsg);
  rootEl.appendChild(bodyEl);

  const doc = {
    documentElement: rootEl,
    body: bodyEl,
    readyState: 'complete',
    title: 'Antigravity',
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    document: doc,
    Document: function FakeDocument() {},
    MutationObserver: FakeMutationObserver,
    Set,
    Map,
    RegExp,
    Object,
    String,
    Array,
    Date,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    requestAnimationFrame(cb) {
      cb();
      return 1;
    },
    console,
    __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN', brandTitle: 'hakimi' },
    __AGY_I18N_DATA__: { exact: {}, patterns: [], rules: [] },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(runtimeCode, sandbox, { filename: 'i18n-runtime.js' });

  // Initial scan should apply default 'hakimi' mode
  assert.equal(brandText.nodeValue, '哈基米');
  assert.equal(brandBtn.getAttribute('data-agy-brand-item'), 'true');
  assert.equal(chatText.nodeValue, 'Antigravity', 'Chat prose must never be mutated by brand replacement');

  // Switch to 'hidden'
  sandbox.__AGY_I18N_CONFIG__.brandTitle = 'hidden';
  sandbox.__AGY_RUN_FULL_SCAN__();
  assert.equal(brandText.nodeValue, '');
  assert.equal(brandBtn.getAttribute('data-agy-brand-item'), 'true');
  assert.equal(brandBtn.style.display, '');

  // Recover from 'hidden' -> 'translated'
  sandbox.__AGY_I18N_CONFIG__.brandTitle = 'translated';
  sandbox.__AGY_RUN_FULL_SCAN__();
  assert.equal(brandText.nodeValue, '反重力');

  // 'translated' -> 'english'
  sandbox.__AGY_I18N_CONFIG__.brandTitle = 'english';
  sandbox.__AGY_RUN_FULL_SCAN__();
  assert.equal(brandText.nodeValue, 'Antigravity');

  // 'english' -> 'hakimi'
  sandbox.__AGY_I18N_CONFIG__.brandTitle = 'hakimi';
  sandbox.__AGY_RUN_FULL_SCAN__();
  assert.equal(brandText.nodeValue, '哈基米');
  assert.equal(chatText.nodeValue, 'Antigravity');
});

test('computeAsarHeaderSha256 matches official Info.plist ElectronAsarIntegrity hash when official app is installed', () => {
  const officialAsar = '/Applications/Antigravity.app/Contents/Resources/app.asar';
  const officialPlist = '/Applications/Antigravity.app/Contents/Info.plist';
  if (!fs.existsSync(officialAsar) || !fs.existsSync(officialPlist)) return;

  const expected = execFileSync(
    'python3',
    [
      '-c',
      'import plistlib, sys; d=plistlib.load(open(sys.argv[1],"rb")); print(d["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"])',
      officialPlist,
    ],
    { encoding: 'utf8' }
  ).trim();
  const actual = asarEngine.computeAsarHeaderSha256(officialAsar);
  assert.equal(actual, expected);
});

test('asar-engine and packHakimiAsar preserve file-only unpacked/executable metadata on synthetic ASAR round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-asar-test-'));
  try {
    const srcTree = path.join(tmp, 'src-tree');
    fs.mkdirSync(path.join(srcTree, 'dist', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(srcTree, 'node_modules', 'chrome-devtools-mcp', 'build'), { recursive: true });

    fs.writeFileSync(path.join(srcTree, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.1' }));
    fs.writeFileSync(
      path.join(srcTree, 'dist', 'utils.js'),
      [
        '"use strict";',
        'function createWindow(url, storageManager, options) {',
        '    const win = {};',
        '    void win.loadURL(url);',
        '    return win;',
        '}',
        'const showOrCreateWindow = (port) => {',
        '    const wins = [];',
        '    if (wins.length > 0) {',
        '        wins[0].focus();',
        '    } else {',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '    }',
        '};',
        'function setupNodeWrapper(env) {',
        '    return env;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(srcTree, 'dist', 'preload.js'), '"use strict";\n// base preload\n', 'utf8');

    const execScript = path.join(srcTree, 'dist', 'bin', 'helper.sh');
    fs.writeFileSync(execScript, '#!/bin/sh\necho ok\n', 'utf8');
    fs.chmodSync(execScript, 0o755);

    const mcpFile = path.join(srcTree, 'node_modules', 'chrome-devtools-mcp', 'build', 'index.js');
    fs.writeFileSync(mcpFile, 'console.log("mcp");\n', 'utf8');

    const srcAsar = path.join(tmp, 'src.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcTree, srcAsar, {
      unpackDir: '**/chrome-devtools-mcp',
    });

    // Verify file-only unpacked & executable in srcAsar header + round-trip extractAll
    const srcHeader = asarEngine.readAsarHeader(srcAsar).header;
    assert.equal(srcHeader.files.node_modules.unpacked, undefined);
    assert.equal(srcHeader.files.node_modules.files['chrome-devtools-mcp'].unpacked, undefined);
    assert.equal(
      srcHeader.files.node_modules.files['chrome-devtools-mcp'].files.build.files['index.js'].unpacked,
      true
    );
    assert.equal(srcHeader.files.dist.files.bin.files['helper.sh'].executable, true);

    const extractCheck = path.join(tmp, 'extract-check');
    asarEngine.builtinAsar.extractAll(srcAsar, extractCheck);
    assert.equal(
      fs.readFileSync(path.join(extractCheck, 'node_modules', 'chrome-devtools-mcp', 'build', 'index.js'), 'utf8'),
      'console.log("mcp");\n'
    );
    assert.ok((fs.statSync(path.join(extractCheck, 'dist', 'bin', 'helper.sh')).mode & 0o111) !== 0);

    // Run full packHakimiAsar pipeline
    const destAsar = path.join(tmp, 'FakeHakimi.app', 'Contents', 'Resources', 'app.asar');
    const stateDir = path.join(tmp, 'state');
    const res = packHakimiAsar({
      srcAsar,
      destAsar,
      stateDir,
      clientLang: 'zh-CN',
      brand: 'hakimi',
      hasExplicitLang: true,
      hasExplicitBrand: true,
    });

    assert.equal(res.ok, true);
    assert.match(res.sha256, /^[0-9a-f]{64}$/);
    assert.equal(res.sha256, asarEngine.computeAsarHeaderSha256(destAsar));
    assert.equal(res.inspect.meterReady, true);
    assert.equal(res.inspect.chineseReady, true);
    assert.equal(res.inspect.chineseStatus, 'ready');

    const savedCfg = JSON.parse(fs.readFileSync(res.configPath, 'utf8'));
    assert.equal(savedCfg.modules.chinese.enabled, true);
    assert.equal(savedCfg.modules.chinese.language, 'zh-CN');
    assert.equal(savedCfg.modules.chinese.brandTitle, 'hakimi');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renamed script and package references have zero stale antigravity-unlock.sh mentions', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'build-hakimi.sh')), true, 'build-hakimi.sh must exist');
  assert.equal(fs.existsSync(path.join(ROOT, 'antigravity-unlock.sh')), false, 'antigravity-unlock.sh must be removed');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'antigravity-hakimi');
  assert.equal(pkg.scripts['build:hakimi'], 'bash ./build-hakimi.sh');

  const filesToCheck = [
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'build-hakimi.sh'),
    ...collectJsFiles(path.join(ROOT, 'payload', 'dist')),
    ...collectJsFiles(path.join(ROOT, 'scripts')),
    ...fs.readdirSync(path.join(ROOT, 'src', 'renderer')).map((f) => path.join(ROOT, 'src', 'renderer', f)),
  ];

  for (const file of filesToCheck) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      content.includes('antigravity-unlock.sh'),
      false,
      `Stale antigravity-unlock.sh reference in ${path.relative(ROOT, file)}`
    );
  }
});

function writeSyntheticTestImage({ outPath, width, height, format, cornerAlphaZero }) {
  const jxa = `
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  const outPath = argv[0];
  const w = Number(argv[1]);
  const h = Number(argv[2]);
  const fmt = argv[3];
  const transparentCorner = argv[4] === "1";
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, w, h, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0
  );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(ctx);
  if (!transparentCorner) {
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.18, 0.55, 0.92, 1.0).setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(0, 0, w, h));
  } else {
    const circle = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(w * 0.15, h * 0.15, w * 0.7, h * 0.7));
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.95, 0.45, 0.2, 1.0).setFill;
    circle.fill;
  }
  ctx.flushGraphics;
  const type = fmt === "jpeg" ? $.NSBitmapImageFileTypeJPEG : $.NSBitmapImageFileTypePNG;
  const data = rep.representationUsingTypeProperties(type, $({}));
  data.writeToFileAtomically(outPath, true);
  return "ok";
}
`;
  const tmpJxa = `${outPath}.jxa`;
  fs.writeFileSync(tmpJxa, jxa, 'utf8');
  try {
    execFileSync('osascript', [
      '-l',
      'JavaScript',
      tmpJxa,
      outPath,
      String(width),
      String(height),
      format,
      cornerAlphaZero ? '1' : '0',
    ]);
  } finally {
    try {
      fs.unlinkSync(tmpJxa);
    } catch {}
  }
}

test('buildMacosIcon converts JPEG/PNG/ICNS and packHakimiAsar optionally swaps app.asar icon.png', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-test-'));
  try {
    // 1. Non-square opaque JPEG (300x200) -> auto squircle masked .icns + 512x512 PNG
    const srcJpg = path.join(tmp, 'opaque-photo.jpg');
    writeSyntheticTestImage({ outPath: srcJpg, width: 300, height: 200, format: 'jpeg', cornerAlphaZero: false });
    const outIcns1 = path.join(tmp, 'out1.icns');
    const outPng1 = path.join(tmp, 'out1.png');
    const res1 = buildMacosIcon({ inputPath: srcJpg, outIcnsPath: outIcns1, outPngPath: outPng1 });
    assert.equal(res1.ok, true);
    assert.equal(res1.mode, 'image');
    assert.equal(res1.masked, true);
    assert.ok(fs.statSync(outIcns1).size > 1000);
    const sipsOut1 = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', outPng1], { encoding: 'utf8' });
    assert.match(sipsOut1, /pixelWidth:\s*512/);
    assert.match(sipsOut1, /pixelHeight:\s*512/);

    // 2. Transparent-corner PNG (256x256) -> preserves transparent corners (masked === false)
    const srcTransPng = path.join(tmp, 'trans-logo.png');
    writeSyntheticTestImage({ outPath: srcTransPng, width: 256, height: 256, format: 'png', cornerAlphaZero: true });
    const outIcns2 = path.join(tmp, 'out2.icns');
    const outPng2 = path.join(tmp, 'out2.png');
    const res2 = buildMacosIcon({ inputPath: srcTransPng, outIcnsPath: outIcns2, outPngPath: outPng2 });
    assert.equal(res2.ok, true);
    assert.equal(res2.masked, false);

    // 3. Direct .icns input -> copies .icns & extracts 512x512 PNG
    const outIcns3 = path.join(tmp, 'out3.icns');
    const outPng3 = path.join(tmp, 'out3.png');
    const res3 = buildMacosIcon({ inputPath: outIcns1, outIcnsPath: outIcns3, outPngPath: outPng3 });
    assert.equal(res3.ok, true);
    assert.equal(res3.mode, 'icns');
    assert.equal(Buffer.compare(fs.readFileSync(outIcns1), fs.readFileSync(outIcns3)), 0);

    // 4. Synthetic ASAR with default vs custom icon.png
    const srcTree = path.join(tmp, 'src-tree');
    fs.mkdirSync(path.join(srcTree, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcTree, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.1' }));
    const defaultIconBuf = Buffer.from('default-icon-placeholder');
    fs.writeFileSync(path.join(srcTree, 'icon.png'), defaultIconBuf);
    fs.writeFileSync(
      path.join(srcTree, 'dist', 'utils.js'),
      [
        '"use strict";',
        'function createWindow(url, storageManager, options) {',
        '    const win = {};',
        '    void win.loadURL(url);',
        '    return win;',
        '}',
        'const showOrCreateWindow = (port) => {',
        '    const wins = [];',
        '    if (wins.length > 0) {',
        '        wins[0].focus();',
        '    } else {',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '    }',
        '};',
        'function setupNodeWrapper(env) {',
        '    return env;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(srcTree, 'dist', 'preload.js'), '"use strict";\n', 'utf8');

    const srcAsar = path.join(tmp, 'src.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcTree, srcAsar, {});

    const destDefault = path.join(tmp, 'DefaultApp.app', 'Contents', 'Resources', 'app.asar');
    packHakimiAsar({ srcAsar, destAsar: destDefault, skipConfig: true, stateDir: path.join(tmp, 'state1') });
    assert.equal(
      Buffer.compare(asarEngine.builtinAsar.extractFile(destDefault, 'icon.png'), defaultIconBuf),
      0,
      'Default packHakimiAsar without iconPng must preserve original icon.png'
    );

    const destCustom = path.join(tmp, 'CustomApp.app', 'Contents', 'Resources', 'app.asar');
    packHakimiAsar({
      srcAsar,
      destAsar: destCustom,
      iconPng: outPng1,
      skipConfig: true,
      stateDir: path.join(tmp, 'state2'),
    });
    assert.equal(
      Buffer.compare(asarEngine.builtinAsar.extractFile(destCustom, 'icon.png'), fs.readFileSync(outPng1)),
      0,
      'Custom iconPng must replace root icon.png inside packed app.asar'
    );

    // 5. In-place replaceAsarIcon on already-packed destDefault (keeps meter injection untouched)
    const beforeUtils = asarEngine.builtinAsar.extractFile(destDefault, 'dist/utils.js');
    const beforePreload = asarEngine.builtinAsar.extractFile(destDefault, 'dist/preload.js');
    const swapRes = replaceAsarIcon({ asarPath: destDefault, iconPng: outPng2 });
    assert.equal(swapRes.ok, true);
    assert.match(swapRes.sha256, /^[0-9a-f]{64}$/);
    assert.equal(swapRes.sha256, asarEngine.computeAsarHeaderSha256(destDefault));
    assert.equal(
      Buffer.compare(asarEngine.builtinAsar.extractFile(destDefault, 'icon.png'), fs.readFileSync(outPng2)),
      0,
      'replaceAsarIcon must swap icon.png in place'
    );
    assert.equal(
      Buffer.compare(asarEngine.builtinAsar.extractFile(destDefault, 'dist/utils.js'), beforeUtils),
      0,
      'replaceAsarIcon must keep injected dist/utils.js intact'
    );
    assert.equal(
      Buffer.compare(asarEngine.builtinAsar.extractFile(destDefault, 'dist/preload.js'), beforePreload),
      0,
      'replaceAsarIcon must keep injected dist/preload.js intact'
    );
    assert.throws(
      () => replaceAsarIcon({ asarPath: '/Applications/Antigravity.app/Contents/Resources/app.asar', iconPng: outPng2 }),
      /Refusing to replace icon in ASAR official Antigravity\.app/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('context presets start at 256K up to 1M and arm64 clients enable Apply button', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  assert.equal(tpl.includes('data-ctx-limit="128000"'), false, '128K preset should be removed');
  for (const preset of ['256000', '512000', '1000000']) {
    assert.ok(tpl.includes(`data-ctx-limit="${preset}"`), `Missing preset button for ${preset}`);
  }

  const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'main.js'), 'utf8');
  assert.ok(
    mainJs.includes("data.arch === 'arm64'"),
    'src/renderer/main.js must enable btnApplyUnlock on Apple Silicon (arm64)'
  );
  assert.ok(
    mainJs.includes('rawWindowMax'),
    'src/renderer/main.js must compare presets against rawWindowMax so 1M stays enabled on 1M models'
  );
});

test('meter-core recognizes Gemini 4 Hydrogen, Argon, and Orchestrator (Carbon) under Google vendor', () => {
  for (const label of [
    'Gemini 4 Hydrogen (XHigh)',
    'Gemini 4 Argon (High)',
    'Orchestrator (Carbon)',
  ]) {
    const grouped = meterCore.groupModelProduct({ label });
    assert.equal(grouped.vendor, 'Google', `Expected Google vendor for ${label}`);
  }
});

test('meter-context-unlock ps lookup preserves UTF-8 non-ASCII bundle paths under stripped C locale', async () => {
  const targetLs = '/Applications/哈基米.app/Contents/Resources/bin/language_server';
  const syntheticPs = `41204 Sun Nov 15 14:00:32 2026     ${targetLs} --standalone\n`;
  const parsed = contextUnlock.parseMacPsOutput(syntheticPs, targetLs);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pid, 41204);

  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  const prevLcCtype = process.env.LC_CTYPE;
  try {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;

    const proc = await contextUnlock.getRunningLanguageServerInfoAsync(targetLs, true);
    assert.equal(proc.queryFailed, false);

    // Independently check whether 哈基米.app language_server is running using explicit UTF-8 ps env
    const livePs = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
    });
    const actuallyRunning = livePs.split(/\r?\n/).some((l) => l.includes(targetLs));
    if (actuallyRunning) {
      assert.equal(
        proc.isRunning,
        true,
        'Live 哈基米.app language_server must still be detected when parent env lacks UTF-8 LANG/LC_CTYPE'
      );
    }
  } finally {
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevLcCtype;
  }
});

test('panel GitHub links and external URL allowlist point to cli117/antigravity-hakimi', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'main.js'), 'utf8');
  const renderedJs = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');

  assert.ok(
    mainJs.includes('https://github.com/cli117/antigravity-hakimi'),
    'src/renderer/main.js should point openGithubRepo to cli117/antigravity-hakimi'
  );
  assert.ok(
    renderedJs.includes('https://github.com/cli117/antigravity-hakimi'),
    'payload/dist/meter-renderer.js should point openGithubRepo to cli117/antigravity-hakimi'
  );
  assert.equal(
    mainJs.includes('elviscjn-cjn/antigravity-context-viewer'),
    false,
    'src/renderer/main.js should not retain upstream repo URL in openGithubRepo'
  );

  assert.equal(meterCore.isValidExternalUrl('https://github.com/cli117/antigravity-hakimi'), true);
  assert.equal(meterCore.isValidExternalUrl('https://github.com/cli117/antigravity-hakimi/issues'), true);
  assert.equal(meterCore.isValidExternalUrl('https://linux.do/t/topic/3117832'), true);
  assert.equal(meterCore.isValidExternalUrl('https://github.com/elviscjn-cjn/antigravity-context-viewer'), false);
  assert.equal(meterCore.isValidExternalUrl('https://github.com/cli117/other-repo'), false);
});

test('meter-core analyzeSteps computes session groups and calculateIntervalTokens aggregates pure tokens', () => {
  const mkText = (len) => 'a '.repeat(len);
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'short hi' }] } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: mkText(800), thinking: mkText(400) } },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { filePath: '/Users/dev/secret/project/src/secret_file.ts', content: mkText(2000) } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { command: 'npm test', combinedOutput: { full: mkText(1200) } } },
    { type: 'CORTEX_STEP_TYPE_GREP_SEARCH', grepSearch: { query: 'foo', results: mkText(600) } },
    { type: 'CORTEX_STEP_TYPE_LIST_DIR', listDir: { directoryPath: '/Users/dev/secret/dir', entries: mkText(500) } },
    { type: 'CORTEX_STEP_TYPE_CONVERSATION_SUMMARY', conversationSummary: { summary: mkText(700) } },
  ];

  const analysis = meterCore.analyzeSteps(steps);
  assert.equal(analysis.topConsumers, undefined);
  assert.equal(analysis.userMessages, 1);
  assert.equal(analysis.assistantMessages, 1);
  assert.equal(analysis.steps, steps.length);
  assert.ok(analysis.groups && analysis.groups.tools && analysis.groups.tools.chars > 0);
  assert.ok(analysis.total && analysis.total.high >= analysis.total.low);

  const agg = meterCore.calculateIntervalTokens(
    {
      '2026-11-10': { total: 1000, input: 600, output: 300, cache: 100 },
      '2026-11-12': { total: 2000, input: 1200, output: 500, cache: 300 },
      '2026-11-15': { total: 99999, input: 99999, output: 0, cache: 0 }, // future relative to todayStr
    },
    ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-15'],
    { todayStr: '2026-11-12' }
  );
  assert.equal(agg.activeDays, 3);
  assert.equal(agg.pastDays, 3);
  assert.equal(agg.totalTokens, 102999);
  assert.equal(agg.dailyAverageTokens, Math.round(102999 / 3));
  assert.equal(agg.activeDailyAverageTokens, Math.round(102999 / 3));
});

test('checkAppVersionSync detects version mismatch and renderer exposes quick actions and CLI unlock hooks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-sync-doctor-'));
  try {
    const offPlist = path.join(tmp, 'Official.plist');
    const hakPlist = path.join(tmp, 'Hakimi.plist');
    const makePlist = (ver) =>
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${ver}</string></dict></plist>`;

    fs.writeFileSync(offPlist, makePlist('2.33.0'), 'utf8');
    fs.writeFileSync(hakPlist, makePlist('2.32.1'), 'utf8');
    const mismatch = modulesConfig.checkAppVersionSync({ officialPlist: offPlist, hakimiPlist: hakPlist });
    assert.equal(mismatch.officialVersion, '2.33.0');
    assert.equal(mismatch.hakimiVersion, '2.32.1');
    assert.equal(mismatch.outdated, true);

    fs.writeFileSync(hakPlist, makePlist('2.33.0'), 'utf8');
    const synced = modulesConfig.checkAppVersionSync({ officialPlist: offPlist, hakimiPlist: hakPlist });
    assert.equal(synced.outdated, false);

    const docReport = runDoctor({
      appPath: path.join(tmp, 'MissingHakimi.app'),
      allowMissing: true,
      skipCodesign: true,
      skipProcess: true,
      homeDir: tmp,
      stateDir: tmp,
    });
    assert.equal(docReport.ok, true);
    assert.equal(docReport.counts.fail, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const renderedJs = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  for (const marker of [
    'version-sync-banner',
    'btn-session-compact',
    'btn-session-raise-limit',
    'btn-topbar-compact',
    'btn-topbar-raise-limit',
    'topbar-action-tooltip',
    'cli-unlock-card',
  ]) {
    assert.ok(tpl.includes(marker), `Missing ${marker} in template.html`);
    assert.ok(renderedJs.includes(marker), `Missing ${marker} in meter-renderer.js`);
  }
  assert.equal(tpl.includes('ctx-breakdown-card'), false, 'ctx-breakdown-card should be removed from template.html');
  assert.equal(renderedJs.includes('ctx-breakdown-card'), false, 'ctx-breakdown-card should be removed from meter-renderer.js');
  for (const btnId of ['btn-topbar-compact', 'btn-topbar-raise-limit']) {
    const match = tpl.match(new RegExp(`<button\\s+id="${btnId}"[^>]*>([\\s\\S]*?)<\\/button>`));
    assert.ok(match, `Missing <button id="${btnId}"> element in template.html`);
    assert.ok(match[1].includes('<svg'), `${btnId} must render an <svg> icon`);
    const visibleText = match[1].replace(/<[^>]+>/g, '').trim();
    assert.equal(visibleText, '', `${btnId} on primary top bar must be icon-only with no visible text`);
  }
  assert.ok(renderedJs.includes('GetSlashCommands'), 'Missing GetSlashCommands in meter-renderer.js');
  assert.ok(renderedJs.includes('resolveSessionRaiseAction'), 'Missing resolveSessionRaiseAction in meter-renderer.js');
  assert.ok(renderedJs.includes('triggerSessionRaiseLimit'), 'Missing triggerSessionRaiseLimit in meter-renderer.js');
});

test('build-hakimi.sh and set-hakimi-icon.sh escalate to SIGKILL on stuck processes, clean stale SingletonLock, and use open -n', async () => {
  for (const scriptName of ['build-hakimi.sh', 'set-hakimi-icon.sh']) {
    const scriptPath = path.join(ROOT, scriptName);
    execFileSync('bash', ['-n', scriptPath]);
    const content = fs.readFileSync(scriptPath, 'utf8');
    for (const token of ['stop_running_target_app', 'kill -KILL', 'cleanupStaleSingletonLock', 'open -n "$APP"']) {
      assert.ok(content.includes(token), `${scriptName} missing "${token}"`);
    }
  }

  const meterMainSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-main.js'), 'utf8');
  assert.ok(meterMainSrc.includes('quitFallbackTimer'), 'meter-main.js must arm quitFallbackTimer on before-quit');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-restart-fix-'));
  let stuckPid = 0;
  try {
    // 1. Verify cleanupStaleSingletonLock preserves live lock and cleans dead lock
    const userDataLive = path.join(tmp, 'user-data-live');
    fs.mkdirSync(userDataLive, { recursive: true });
    fs.symlinkSync(`test-host-${process.pid}`, path.join(userDataLive, 'SingletonLock'));
    const liveRes = modulesConfig.cleanupStaleSingletonLock(userDataLive);
    assert.equal(liveRes.cleaned, false);
    assert.equal(liveRes.reason, 'owner_alive');
    assert.ok(fs.lstatSync(path.join(userDataLive, 'SingletonLock')).isSymbolicLink());

    const deadProc = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isSafeInteger(deadProc.pid) && deadProc.pid > 0);
    const userDataDead = path.join(tmp, 'user-data-dead');
    fs.mkdirSync(userDataDead, { recursive: true });
    fs.symlinkSync(`test-host-${deadProc.pid}`, path.join(userDataDead, 'SingletonLock'));
    fs.symlinkSync('12345', path.join(userDataDead, 'SingletonCookie'));
    fs.symlinkSync('/tmp/nonexistent-socket', path.join(userDataDead, 'SingletonSocket'));
    const deadRes = modulesConfig.cleanupStaleSingletonLock(userDataDead);
    assert.equal(deadRes.cleaned, true);
    assert.equal(deadRes.pid, deadProc.pid);
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      assert.throws(() => fs.lstatSync(path.join(userDataDead, f)), /ENOENT/);
    }

    // 2. End-to-end test of stop_running_target_app against a SIGTERM-ignoring mock binary
    //    adopted by PID 1 (launchd) so killing it does not leave an unreaped zombie under execFileSync.
    const mockApp = path.join(tmp, 'MockHakimi.app');
    const mockExec = path.join(mockApp, 'Contents', 'MacOS', 'Antigravity');
    fs.mkdirSync(path.dirname(mockExec), { recursive: true });
    fs.writeFileSync(mockExec, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(mockExec, 0o755);
    const realMockExec = fs.realpathSync(mockExec);

    const launcherOut = execFileSync(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('child_process');
         const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
           argv0: process.argv[1],
           detached: true,
           stdio: 'ignore',
         });
         child.unref();
         process.stdout.write(String(child.pid));`,
        realMockExec,
      ],
      { encoding: 'utf8' }
    );
    stuckPid = Number(launcherOut.trim());
    assert.ok(Number.isSafeInteger(stuckPid) && stuckPid > 0);
    assert.doesNotThrow(() => process.kill(stuckPid, 0));

    const buildSrc = fs.readFileSync(path.join(ROOT, 'build-hakimi.sh'), 'utf8');
    const helperMatch = buildSrc.match(
      /# --- BEGIN TARGET PROCESS LIFECYCLE HELPERS ---([\s\S]*?)# --- END TARGET PROCESS LIFECYCLE HELPERS ---/
    );
    assert.ok(helperMatch, 'Missing lifecycle helper block in build-hakimi.sh');

    const helperScript = path.join(tmp, 'run-stop.sh');
    fs.writeFileSync(
      helperScript,
      `#!/bin/bash\nset -euo pipefail\nSCRIPT_DIR="$1"\n${helperMatch[1]}\nstop_running_target_app "$2"\n`,
      'utf8'
    );
    fs.chmodSync(helperScript, 0o755);

    const stopUserData = path.join(tmp, 'user-data-stop');
    fs.mkdirSync(stopUserData, { recursive: true });
    fs.symlinkSync(`test-host-${stuckPid}`, path.join(stopUserData, 'SingletonLock'));

    execFileSync('bash', [helperScript, ROOT, mockApp], {
      env: {
        ...process.env,
        HAKIMI_STOP_GRACE_TENTHS: '3',
        HAKIMI_STOP_TERM_TENTHS: '2',
        HAKIMI_STOP_KILL_TENTHS: '25',
        HAKIMI_USER_DATA_DIR: stopUserData,
      },
    });

    // After SIGKILL escalation + PID 1 reap, stuckPid must no longer exist
    assert.throws(() => process.kill(stuckPid, 0), /ESRCH/);
    stuckPid = 0;
    assert.throws(() => fs.lstatSync(path.join(stopUserData, 'SingletonLock')), /ENOENT/);
  } finally {
    if (stuckPid) {
      try { process.kill(stuckPid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
