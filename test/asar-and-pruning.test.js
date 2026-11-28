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
const enhance = require(path.join(ROOT, 'payload', 'dist', 'meter-enhance.js'));
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
  'CHINESE_TITLE_RULES',
  'CHINESE_TITLE_META',
  'applyChineseTitlePatchToBuffer',
  'inspectChineseTitleRules',
  'normalizeChineseTitleMode',
  'enhance-prompt-card',
  'chk-enhance-chinese-title',
  'btn-enhance-apply-prompt',
  'chk-rec-title',
  'meter-context-unlock',
  '__JETSKI_LS_CLIENT_DECORATOR__',
  'WebSocket.prototype.send',
  'XMLHttpRequest.prototype.send',
  'window.fetch =',
  'checkpointConfig.maxTokenLimit',
  'offersContextWindow',
  'AGY_CLI_AUTO_COMPACT_OVERRIDE',
  'GetCheckpointConfig',
  'applyFeatureProviderCheckpointOverrideConfig',
  'btn-topbar-window',
  'topbar-window-popover',
  'session-ctx-preset-bar',
  'applyQuickContextPreset',
  'resolveQuickContextTarget',
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
  assert.ok(jsFiles.length >= 15, `expected >= 15 JS files, got ${jsFiles.length}`);
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

test('src/renderer/template.html has balanced <div> tags and no legacy brand title buttons', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const opens = (tpl.match(/<div\b/g) || []).length;
  const closes = (tpl.match(/<\/div>/g) || []).length;
  assert.equal(opens, closes, `Unbalanced <div> tags: opens=${opens}, closes=${closes}`);
  assert.equal(tpl.includes('data-brand-title='), false, 'Legacy data-brand-title controls should be removed');
  assert.equal(tpl.includes('id="btn-brand-hakimi"'), false, 'Legacy #btn-brand-hakimi should be removed');
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

test('i18n-runtime translates desktop UI labels without touching chat prose or code blocks', () => {
  const runtimeCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js'), 'utf8');

  const rootEl = createMockElement('HTML');
  const bodyEl = createMockElement('BODY');
  const navBtn = createMockElement('BUTTON', {}, 'sidebar-btn');
  const navText = createMockTextNode('Settings');
  navBtn.appendChild(navText);

  const codeEl = createMockElement('CODE', {}, '');
  const codeText = createMockTextNode('Settings');
  codeEl.appendChild(codeText);

  bodyEl.appendChild(navBtn);
  bodyEl.appendChild(codeEl);
  rootEl.appendChild(bodyEl);

  const doc = {
    documentElement: rootEl,
    body: bodyEl,
    readyState: 'complete',
    _title: 'Antigravity',
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };
  function FakeDocument() {}
  Object.defineProperty(FakeDocument.prototype, 'title', {
    configurable: true,
    enumerable: true,
    get() {
      return this._title;
    },
    set(v) {
      this._title = String(v);
    },
  });
  Object.setPrototypeOf(doc, FakeDocument.prototype);

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    document: doc,
    Document: FakeDocument,
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
    __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN' },
    __AGY_I18N_DATA__: { exact: { Settings: '设置' }, patterns: [], rules: [] },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(runtimeCode, sandbox, { filename: 'i18n-runtime.js' });

  assert.equal(navText.nodeValue, '设置');
  assert.equal(codeText.nodeValue, 'Settings', 'Code elements must never be mutated by i18n runtime');
  assert.doesNotThrow(() => {
    doc.title = 'Session - Antigravity';
  }, 'Setting document.title must not throw after i18n-runtime initializes');
  assert.equal(doc.title, 'Session - Antigravity');
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
      hasExplicitLang: true,
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

  const buildHakimiSrc = fs.readFileSync(path.join(ROOT, 'build-hakimi.sh'), 'utf8');
  assert.equal(buildHakimiSrc.includes('--chinese-title'), false, 'build-hakimi.sh must not retain --chinese-title');
  assert.equal(buildHakimiSrc.includes('CHINESE_TITLE'), false, 'build-hakimi.sh must not retain CHINESE_TITLE');

  // Intel (x86_64) support: the build must resolve a target arch and forward it to the official
  // feed fetcher instead of assuming Apple Silicon.
  assert.equal(buildHakimiSrc.includes('--arch'), true, 'build-hakimi.sh must expose --arch');
  assert.equal(
    buildHakimiSrc.includes('--arch "$TARGET_ARCH"'),
    true,
    'build-hakimi.sh must forward --arch to hakimi-builder fetch-official'
  );
  assert.equal(
    /uname -m/.test(buildHakimiSrc),
    true,
    'build-hakimi.sh must detect the host architecture via uname -m'
  );
  assert.equal(
    buildHakimiSrc.includes('x86_64'),
    true,
    'build-hakimi.sh must map x86_64 hosts to the x64 target arch'
  );
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

test('preload and renderer contain zero outgoing request interception hooks', () => {
  const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  for (const forbidden of [
    '__JETSKI_LS_CLIENT_DECORATOR__',
    'webFrame.executeJavaScript',
    'context-unlock',
    'enhance-status',
    'enhance-apply',
    'enhance-restore',
  ]) {
    assert.equal(preloadCode.includes(forbidden), false, `Preload must not include ${forbidden}`);
  }
  assert.ok(preloadCode.includes('compactSession'), 'Preload should expose compactSession IPC bridge');

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  for (const removed of ['tab-ctx-models', 'pane-ctx-models', 'ctx-compact-card', 'enhance-preset-card', 'btn-topbar-window', 'topbar-window-popover']) {
    assert.equal(tpl.includes(removed), false, `template.html must not contain ${removed}`);
  }
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

test('meter-enhance ps lookup preserves UTF-8 non-ASCII bundle paths under stripped C locale', () => {
  const targetLs = '/Applications/哈基米.app/Contents/Resources/bin/language_server';
  const syntheticPs = `41204 Sun Nov 15 14:00:32 2026     ${targetLs} --standalone\n`;
  const parsed = enhance.parseMacPsOutput(syntheticPs, targetLs);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pid, 41204);

  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  const prevLcCtype = process.env.LC_CTYPE;
  try {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;

    const isRunning = enhance.checkLanguageServerRunning({ targets: [{ id: 'desktop', path: targetLs }] });
    const livePs = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
    });
    const actuallyRunning = livePs.split(/\r?\n/).some((l) => l.includes(targetLs));
    if (actuallyRunning) {
      assert.equal(
        isRunning,
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
    'btn-topbar-compact',
    'topbar-action-tooltip',
    'cli-unlock-card',
    'badge-cache',
    'overflow-cache-btn',
    'cache-summary',
    'h-sum-cache-rate',
  ]) {
    assert.ok(tpl.includes(marker), `Missing ${marker} in template.html`);
    assert.ok(renderedJs.includes(marker), `Missing ${marker} in meter-renderer.js`);
  }
  for (const removed of [
    'ctx-breakdown-card',
    'btn-session-compact',
    'btn-session-raise-limit',
    'btn-topbar-raise-limit',
    'btn-toggle-details',
    'id="drawer-body"',
    'id="drawer-arrow"',
    'session-total',
    'attachment-total',
  ]) {
    assert.equal(tpl.includes(removed), false, `${removed} should be removed from template.html`);
    assert.equal(renderedJs.includes(removed), false, `${removed} should be removed from meter-renderer.js`);
  }
  for (const btnId of ['btn-topbar-compact']) {
    const match = tpl.match(new RegExp(`<button\\s+id="${btnId}"[^>]*>([\\s\\S]*?)<\\/button>`));
    assert.ok(match, `Missing <button id="${btnId}"> element in template.html`);
    assert.ok(match[1].includes('<svg'), `${btnId} must render an <svg> icon`);
    const visibleText = match[1].replace(/<[^>]+>/g, '').trim();
    assert.equal(visibleText, '', `${btnId} on primary top bar must be icon-only with no visible text`);
  }
  assert.ok(renderedJs.includes('GetSlashCommands'), 'Missing GetSlashCommands in meter-renderer.js');
  assert.ok(renderedJs.includes('compactSession'), 'Missing compactSession in meter-renderer.js');
});

test('build-hakimi.sh and set-hakimi-icon.sh escalate to SIGKILL on stuck processes, clean stale SingletonLock, and use open -n', async () => {
  const lifecycleLibPath = path.join(ROOT, 'scripts', 'lib', 'target-app-lifecycle.sh');
  execFileSync('bash', ['-n', lifecycleLibPath]);
  const lifecycleSrc = fs.readFileSync(lifecycleLibPath, 'utf8');
  for (const token of ['find_running_target_pids', 'stop_running_target_app', 'kill -KILL', 'cleanupStaleSingletonLock']) {
    assert.ok(lifecycleSrc.includes(token), `target-app-lifecycle.sh missing "${token}"`);
  }

  for (const scriptName of ['build-hakimi.sh', 'set-hakimi-icon.sh']) {
    const scriptPath = path.join(ROOT, scriptName);
    execFileSync('bash', ['-n', scriptPath]);
    const content = fs.readFileSync(scriptPath, 'utf8');
    for (const token of ['scripts/lib/target-app-lifecycle.sh', 'stop_running_target_app', 'open -n "$APP"']) {
      assert.ok(content.includes(token), `${scriptName} missing "${token}"`);
    }
  }

  const buildSrc = fs.readFileSync(path.join(ROOT, 'build-hakimi.sh'), 'utf8');
  assert.ok(
    buildSrc.includes('src/renderer/*') && buildSrc.includes('scripts/build-renderer.js'),
    'build-hakimi.sh must check all src/renderer/* files and scripts/build-renderer.js for renderer rebuilds'
  );

  // Verify default userDataDir resolution works without ReferenceError: os is not defined
  const defaultDataDir = modulesConfig.getDefaultUserDataDir();
  assert.ok(path.isAbsolute(defaultDataDir) && defaultDataDir.endsWith('Antigravity'));

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

    const helperScript = path.join(tmp, 'run-stop.sh');
    fs.writeFileSync(
      helperScript,
      `#!/bin/bash\nset -euo pipefail\nSCRIPT_DIR="$1"\nsource "$SCRIPT_DIR/scripts/lib/target-app-lifecycle.sh"\nstop_running_target_app "$2"\n`,
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

test('meter-core computes cache hit rate, avoids turn-1 false alarms, preserves zero-cache turns across previousValidContext, and aggregates session/interval cache metrics', () => {
  // 1. computeCacheMetrics edge cases & level classification
  assert.equal(meterCore.computeCacheMetrics(0, 0), null);
  assert.equal(meterCore.computeCacheMetrics(null, null), null);
  assert.equal(meterCore.computeCacheMetrics(-1, -1), null);

  const turn1Cold = meterCore.computeCacheMetrics(16290, 0, { turnCount: 1 });
  assert.deepEqual(turn1Cold, {
    hitRate: 0,
    cachedTokens: 0,
    uncachedTokens: 16290,
    totalInputTokens: 16290,
    level: 'cold',
  });

  const shortCold = meterCore.computeCacheMetrics(5000, 0, { turnCount: 3 });
  assert.equal(shortCold.level, 'cold');

  const multiTurnLow = meterCore.computeCacheMetrics(129003, 0, { turnCount: 4 });
  assert.equal(multiTurnLow.hitRate, 0);
  assert.equal(multiTurnLow.level, 'low');

  const warnHit = meterCore.computeCacheMetrics(45212, 16832, { turnCount: 2 });
  assert.equal(warnHit.hitRate, 27.1);
  assert.equal(warnHit.level, 'warn');

  const goodHit = meterCore.computeCacheMetrics(29127, 62045, { turnCount: 3 });
  assert.equal(goodHit.hitRate, 68.1);
  assert.equal(goodHit.level, 'good');

  const highHit = meterCore.computeCacheMetrics(2049, 260136, { turnCount: 7 });
  assert.equal(highHit.hitRate, 99.2);
  assert.equal(highHit.level, 'high');

  // 2. summarize() turn-1 cold start vs multi-turn cache miss with previousValidContext
  const turn1Sum = meterCore.summarize(
    {
      chatModel: {
        model: 'Orchestrator (Carbon)',
        usage: { inputTokens: 16831, cacheReadTokens: 0, outputTokens: 591 },
      },
    },
    { turnCount: 1 }
  );
  assert.equal(turn1Sum.cacheHitRate, 0);
  assert.equal(turn1Sum.uncachedInput, 16831);
  assert.equal(turn1Sum.cached, 0);
  assert.equal(turn1Sum.cache.level, 'cold');

  const highSum = meterCore.summarize(
    {
      chatModel: {
        model: 'Orchestrator (Carbon)',
        usage: { inputTokens: 2049, cacheReadTokens: 260136, outputTokens: 1356 },
      },
    },
    { turnCount: 7 }
  );
  assert.equal(highSum.cacheHitRate, 99.2);
  assert.equal(highSum.cache.level, 'high');

  // When a new turn genuinely has 0 cache read tokens, it must NOT fall back to previousValidContext.cached
  const missAfterHigh = meterCore.summarize(
    {
      chatModel: {
        model: 'Orchestrator (Carbon)',
        usage: { inputTokens: 129003, cacheReadTokens: 0, outputTokens: 361 },
      },
    },
    { turnCount: 4, previousValidContext: highSum }
  );
  assert.equal(missAfterHigh.cached, 0);
  assert.equal(missAfterHigh.uncachedInput, 129003);
  assert.equal(missAfterHigh.input, 129003);
  assert.equal(missAfterHigh.cacheHitRate, 0);
  assert.equal(missAfterHigh.cache.level, 'low');

  // When a non-overflow error happens without usage, fallback preserves previousValidContext's 0 cached value without coercing
  const errFallback = meterCore.summarize(
    {
      chatModel: {
        retryInfos: [{ error: 'ECONNRESET' }],
      },
    },
    { previousValidContext: missAfterHigh }
  );
  assert.equal(errFallback.cached, 0);
  assert.equal(errFallback.uncachedInput, 129003);
  assert.equal(errFallback.cacheHitRate, 0);
  assert.equal(errFallback.cache.level, 'low');

  // 3. summarizeSessionCache filters synthetic / empty entries and computes cumulative hitRate
  assert.equal(meterCore.summarizeSessionCache([]), null);
  assert.equal(
    meterCore.summarizeSessionCache([
      { callId: 'test_001', inputTokens: 1000, cacheReadTokens: 9000 },
      { callId: 'call_empty', inputTokens: 0, cacheReadTokens: 0 },
    ]),
    null
  );
  const sessCache = meterCore.summarizeSessionCache([
    { callId: 'test_synthetic', inputTokens: 500000, cacheReadTokens: 0 },
    { callId: 'call_1', inputTokens: 10000, cacheReadTokens: 0 },
    { callId: 'call_2', inputTokens: 2000, cacheReadTokens: 10000 },
    { callId: 'call_3', inputTokens: 3000, cacheTokens: 15000 },
  ]);
  assert.deepEqual(sessCache, {
    hitRate: 62.5,
    cachedTokens: 25000,
    uncachedTokens: 15000,
    totalInputTokens: 40000,
    turns: 3,
  });

  // 4. calculateIntervalTokens computes interval cacheHitRate
  const intervalWithCache = meterCore.calculateIntervalTokens(
    {
      '2026-11-10': { total: 100000, input: 10000, output: 5000, cache: 85000 },
      '2026-11-11': { total: 50000, input: 5000, output: 2000, cache: 43000 },
    },
    ['2026-11-10', '2026-11-11'],
    { todayStr: '2026-11-11' }
  );
  assert.equal(intervalWithCache.cacheHitRate, 89.5);

  const intervalEmpty = meterCore.calculateIntervalTokens({}, ['2026-11-10'], { todayStr: '2026-11-10' });
  assert.equal(intervalEmpty.cacheHitRate, null);
});

test('v2.34.0+ dist/utils.js loadHubWindowUrl anchor and authBootstrap CSRF resolution work end-to-end', async () => {
  const { cleanUtilsSource, verifyCleanStructure } = require(path.join(ROOT, 'payload', 'dist', 'modular-installer'));
  const localApi = require(path.join(ROOT, 'payload', 'dist', 'local-api'));

  // 1. Pack & round-trip verifyCleanStructure on v2.34.0 loadHubWindowUrl dist/utils.js layout
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-v234-test-'));
  try {
    const srcTree = path.join(tmp, 'src-tree');
    fs.mkdirSync(path.join(srcTree, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcTree, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    const rawV234Utils = [
      '"use strict";',
      'async function invokeWindowLoadUrl(win, url) {',
      '    await win.loadURL(url);',
      '}',
      'async function loadHubWindowUrl(win, targetUrl, options) {',
      '    await invokeWindowLoadUrl(win, targetUrl);',
      '}',
      'function createWindow(url, storageManager, options) {',
      '    const win = {};',
      '    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);',
      '    void loadHubWindowUrl(win, url, { skipBootstrapMint });',
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
    ].join('\n');
    fs.writeFileSync(path.join(srcTree, 'dist', 'utils.js'), rawV234Utils, 'utf8');
    fs.writeFileSync(path.join(srcTree, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n', 'utf8');

    assert.equal(verifyCleanStructure(rawV234Utils), true);

    const srcAsar = path.join(tmp, 'src.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcTree, srcAsar, {});

    const destAsar = path.join(tmp, 'FakeHakimi.app', 'Contents', 'Resources', 'app.asar');
    const res = packHakimiAsar({
      srcAsar,
      destAsar,
      stateDir: path.join(tmp, 'state'),
      skipConfig: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.inspect.meterReady, true);
    assert.equal(res.inspect.chineseReady, true);

    const packedUtils = asarEngine.builtinAsar.extractFile(destAsar, 'dist/utils.js').toString('utf8');
    assert.ok(packedUtils.includes('require("./meter-main").installContextMeter(win);'));
    assert.ok(packedUtils.includes('    void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
    assert.equal(verifyCleanStructure(cleanUtilsSource(packedUtils)), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 2. local-api resolveCsrfToken prefers authBootstrap when GET / redacts csrfToken (v2.34.0+)
  const tokenFromBootstrap = await localApi.resolveCsrfToken('https://127.0.0.1:54321', {
    authBootstrap: {
      getActiveLsBaseUrl: () => 'https://127.0.0.1:54321',
      getActiveLsCsrfToken: () => 'admin-csrf-token-v234',
    },
    requestFn: async () => {
      throw new Error('Should not hit GET / when authBootstrap token is available');
    },
  });
  assert.equal(tokenFromBootstrap, 'admin-csrf-token-v234');

  // 3. local-api resolveCsrfToken falls back to GET / window.__APP_CONFIG__ on legacy <= v2.33.x
  const tokenFromHtml = await localApi.resolveCsrfToken('https://127.0.0.1:54321', {
    authBootstrap: {},
    languageServer: {},
    requestFn: async () => '<script>window.__APP_CONFIG__ = {"csrfToken":"legacy-csrf-token"};</script>',
  });
  assert.equal(tokenFromHtml, 'legacy-csrf-token');

  // 4. local-api resolveCsrfToken rejects redacted empty csrfToken when no authBootstrap token exists
  await assert.rejects(
    () =>
      localApi.resolveCsrfToken('https://127.0.0.1:54321', {
        authBootstrap: {},
        languageServer: {},
        requestFn: async () => '<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>',
      }),
    /CSRF token unavailable/
  );
});

test('i18n engine & zh-CN.json cover v2.34.0 UI, Unicode/case normalization, terminal-card boundary, and dynamic attributes', () => {
  const dictPath = path.join(ROOT, 'payload', 'dist', 'i18n', 'zh-CN.json');
  const runtimePath = path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js');
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const runtimeCode = fs.readFileSync(runtimePath, 'utf8');
  const { createI18nEngine } = require(runtimePath);

  // Every pattern regex in zh-CN.json must compile cleanly
  assert.ok(Array.isArray(dict.patterns) && dict.patterns.length >= 500);
  for (const p of dict.patterns) {
    assert.doesNotThrow(() => new RegExp(p.regex), `Invalid i18n regex: ${p.regex}`);
  }

  const engine = createI18nEngine(dict);

  // Unicode ellipsis & curly quote normalization
  assert.equal(engine.translate('Updating…'), '正在更新...');
  assert.equal(engine.translate('This site can’t be reached'), '无法访问此网站');
  assert.equal(engine.translate('“foo” isn’t a valid folder name.'), '“foo”不是有效的文件夹名称。');
  assert.equal(engine.translate('Retrying transcription (attempt 2)…'), '正在重试音频转录（第 2 次）…');

  // Case-insensitive fallback for multi-word / capitalized UI strings while keeping short acronyms untouched
  assert.equal(engine.translate('CLOSE PANEL'), '关闭面板');
  assert.equal(engine.translate('voice speed'), '语速');
  assert.equal(engine.translate('OK'), null);

  // Key v2.34.0 exact & dynamic UI strings
  assert.equal(engine.translate('Orchestrator'), '编排器');
  assert.equal(engine.translate('Side Question'), '旁路提问');
  assert.equal(engine.translate('Connectors'), '连接器');
  assert.equal(engine.translate('Customize Sidebar'), '自定义侧边栏');
  assert.equal(engine.translate('Plan, 2 of 5 steps done'), '计划：已完成 2 / 5 步');
  assert.equal(engine.translate('Open Subagent: Codebase Researcher'), '打开子智能体：Codebase Researcher');
  assert.equal(engine.translate('Show 3 more subagents'), '显示其余 3 个子智能体');
  assert.equal(engine.translate('Working directory: /tmp/demo'), '工作目录：/tmp/demo');
  assert.equal(engine.translate('12 lines added, 4 lines removed'), '新增 12 行，删除 4 行');
  assert.equal(engine.translate('Show more (8)'), '显示更多 (8)');
  assert.equal(engine.translate('Close (Escape)'), '关闭 (Escape)');

  // DOM boundary check: group/terminal-card must be translated, while exact .terminal / .token stay untouched
  const rootEl = createMockElement('HTML');
  const bodyEl = createMockElement('BODY');

  const terminalCard = createMockElement('DIV', {}, 'group/terminal-card mt-0.5 flex');
  const cardLabel = createMockElement('SPAN', { title: 'Working directory' }, 'text-xs');
  const cardText = createMockTextNode('Working directory: /tmp/demo');
  cardLabel.appendChild(cardText);
  terminalCard.appendChild(cardLabel);

  const rawTerminal = createMockElement('DIV', {}, 'terminal xterm-rows');
  const rawTermText = createMockTextNode('Working directory: /tmp/demo');
  rawTerminal.appendChild(rawTermText);

  const prismToken = createMockElement('SPAN', {}, 'token keyword');
  const prismText = createMockTextNode('Orchestrator');
  prismToken.appendChild(prismText);

  const popoverEl = createMockElement('DIV', { 'data-popover-popup': '' }, '');
  const listboxEl = createMockElement('DIV', { role: 'listbox' }, '');

  bodyEl.appendChild(terminalCard);
  bodyEl.appendChild(rawTerminal);
  bodyEl.appendChild(prismToken);
  bodyEl.appendChild(popoverEl);
  bodyEl.appendChild(listboxEl);
  rootEl.appendChild(bodyEl);

  let observerOpts = null;
  let observerCb = null;
  class CapturingMutationObserver {
    constructor(cb) {
      observerCb = cb;
    }
    observe(_target, opts) {
      observerOpts = opts;
    }
    disconnect() {}
  }

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

  const sandbox = {
    document: doc,
    Document: function FakeDocument() {},
    MutationObserver: CapturingMutationObserver,
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
    __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN' },
    __AGY_I18N_DATA__: dict,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(runtimeCode, sandbox, { filename: 'i18n-runtime.js' });

  // group/terminal-card translated; exact .terminal and .token preserved
  assert.equal(cardText.nodeValue, '工作目录：/tmp/demo');
  assert.equal(cardLabel.getAttribute('title'), '工作目录');
  assert.equal(rawTermText.nodeValue, 'Working directory: /tmp/demo');
  assert.equal(prismText.nodeValue, 'Orchestrator');

  // Floating selectors recognize data-popover-popup and role="listbox"
  assert.equal(sandbox.__AGY_IS_FLOATING__(popoverEl), true);
  assert.equal(sandbox.__AGY_IS_FLOATING__(listboxEl), true);

  // MutationObserver safely watches dynamic translatable attributes
  assert.equal(observerOpts.attributes, true);
  assert.ok(Array.isArray(observerOpts.attributeFilter) && observerOpts.attributeFilter.includes('title'));
  cardLabel.setAttribute('title', 'Customize Sidebar');
  observerCb([{ type: 'attributes', target: cardLabel, attributeName: 'title' }]);
  assert.equal(cardLabel.getAttribute('title'), '自定义侧边栏');
});

test('i18n-runtime preserves code identifiers inside file-viewer, diff, and deep code containers', () => {
  const dictPath = path.join(ROOT, 'payload', 'dist', 'i18n', 'zh-CN.json');
  const runtimePath = path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js');
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const runtimeCode = fs.readFileSync(runtimePath, 'utf8');

  const rootEl = createMockElement('HTML');
  const bodyEl = createMockElement('BODY');

  // 1. Antigravity file viewer: .code-line > [data-line-tokens] > span.relative > span(Output/Status/Client/Cache)
  const fileViewerLine = createMockElement('DIV', { 'data-line-number': '42' }, 'code-line group flex font-mono text-sm');
  const lineTokens = createMockElement('DIV', { 'data-line-tokens': '' }, '');
  const tokenWrap = createMockElement('SPAN', {}, 'relative');
  const outputSpan = createMockElement('SPAN', {}, '');
  const outputText = createMockTextNode('Output');
  outputSpan.appendChild(outputText);
  const statusSpan = createMockElement('SPAN', {}, '');
  const statusText = createMockTextNode('Status');
  statusSpan.appendChild(statusText);
  tokenWrap.appendChild(outputSpan);
  tokenWrap.appendChild(statusSpan);
  lineTokens.appendChild(tokenWrap);
  fileViewerLine.appendChild(lineTokens);

  // 2. Diff / CodeLine viewer: .code-line > .line-content > span(Client/Cache)
  const diffLine = createMockElement('DIV', { 'data-file-uri': 'file:///a.go', 'data-diff-type': '0' }, 'w-1/2 code-line group flex');
  const lineContent = createMockElement('DIV', {}, 'line-content group/line overflow-y-clip');
  const clientSpan = createMockElement('SPAN', {}, '');
  const clientText = createMockTextNode('Client');
  clientSpan.appendChild(clientText);
  const cacheSpan = createMockElement('SPAN', {}, '');
  const cacheText = createMockTextNode('Cache');
  cacheSpan.appendChild(cacheText);
  lineContent.appendChild(clientSpan);
  lineContent.appendChild(cacheSpan);
  diffLine.appendChild(lineContent);

  // 3. Deeply nested (>3 ancestors) code inside <pre>
  const preEl = createMockElement('PRE', {}, '');
  const d1 = createMockElement('DIV', {}, '');
  const d2 = createMockElement('DIV', {}, '');
  const d3 = createMockElement('DIV', {}, '');
  const d4 = createMockElement('DIV', {}, '');
  const deepSpan = createMockElement('SPAN', {}, '');
  const deepText = createMockTextNode('Status');
  deepSpan.appendChild(deepText);
  d4.appendChild(deepSpan);
  d3.appendChild(d4);
  d2.appendChild(d3);
  d1.appendChild(d2);
  preEl.appendChild(d1);

  // 4. Non-code UI element with substring-similar class ("inline-content") must still translate
  const uiInlineBox = createMockElement('DIV', {}, 'inline-content text-sm');
  const uiStatusText = createMockTextNode('Status');
  uiInlineBox.appendChild(uiStatusText);

  bodyEl.appendChild(fileViewerLine);
  bodyEl.appendChild(diffLine);
  bodyEl.appendChild(preEl);
  bodyEl.appendChild(uiInlineBox);
  rootEl.appendChild(bodyEl);

  let observerCb = null;
  class CapturingMutationObserver {
    constructor(cb) {
      observerCb = cb;
    }
    observe() {}
    disconnect() {}
  }

  const listeners = {};
  const doc = {
    documentElement: rootEl,
    body: bodyEl,
    readyState: 'complete',
    title: 'Antigravity',
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    querySelectorAll() {
      return [];
    },
  };

  const sandbox = {
    document: doc,
    Document: function FakeDocument() {},
    MutationObserver: CapturingMutationObserver,
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
    __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN' },
    __AGY_I18N_DATA__: dict,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(runtimeCode, sandbox, { filename: 'i18n-runtime.js' });

  // Full scan assertions
  assert.equal(outputText.nodeValue, 'Output');
  assert.equal(statusText.nodeValue, 'Status');
  assert.equal(clientText.nodeValue, 'Client');
  assert.equal(cacheText.nodeValue, 'Cache');
  assert.equal(deepText.nodeValue, 'Status');
  assert.equal(uiStatusText.nodeValue, '状态');

  // Direct MutationObserver & pointerenter targeting deep nodes must not bypass ignore boundaries
  observerCb([
    { type: 'childList', addedNodes: [outputSpan, clientSpan, deepSpan] },
    { type: 'characterData', target: statusText },
    { type: 'characterData', target: cacheText },
    { type: 'characterData', target: deepText },
  ]);
  if (listeners.pointerenter) {
    listeners.pointerenter({ target: outputSpan });
    listeners.pointerenter({ target: deepSpan });
  }

  assert.equal(outputText.nodeValue, 'Output');
  assert.equal(statusText.nodeValue, 'Status');
  assert.equal(clientText.nodeValue, 'Client');
  assert.equal(cacheText.nodeValue, 'Cache');
  assert.equal(deepText.nodeValue, 'Status');
});

test('i18n preload loads dictionary lazily via IPC without inlining 467KB JSON and skips work when language=en', () => {
  const { generateChinesePreloadCode } = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
  const dictPath = path.join(ROOT, 'payload', 'dist', 'i18n', 'zh-CN.json');
  const runtimePath = path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js');
  const dictRaw = fs.readFileSync(dictPath, 'utf8');
  const runtimeRaw = fs.readFileSync(runtimePath, 'utf8');

  const preloadCode = generateChinesePreloadCode(dictRaw, runtimeRaw);
  assert.ok(
    Buffer.byteLength(preloadCode, 'utf8') < 80 * 1024,
    `Expected compact preload (<80KB) without inlined zh-CN.json, got ${Buffer.byteLength(preloadCode, 'utf8')} bytes`
  );
  assert.ok(preloadCode.includes('context-meter:get-i18n-dict-sync'));

  // 1. English mode must exit early without requesting dictionary IPC
  const enIpcCalls = [];
  const enSandbox = {
    electron_1: {
      ipcRenderer: {
        sendSync(ch) {
          enIpcCalls.push(ch);
          if (ch === 'context-meter:get-chinese-config-sync') return { enabled: false, language: 'en' };
          return dictRaw;
        },
      },
    },
    console,
  };
  enSandbox.window = enSandbox;
  enSandbox.globalThis = enSandbox;
  vm.runInNewContext(preloadCode, enSandbox, { filename: 'preload-en.js' });
  assert.deepEqual(enIpcCalls, ['context-meter:get-chinese-config-sync']);
  assert.equal(enSandbox.__AGY_I18N_DATA__, undefined);

  // 2. zh-CN mode fetches dictionary lazily via IPC and initializes engine
  const zhIpcCalls = [];
  const zhSandbox = {
    electron_1: {
      ipcRenderer: {
        sendSync(ch) {
          zhIpcCalls.push(ch);
          if (ch === 'context-meter:get-chinese-config-sync') return { enabled: true, language: 'zh-CN' };
          if (ch === 'context-meter:get-i18n-dict-sync') return JSON.stringify({ exact: { Settings: '设置' }, patterns: [] });
          return null;
        },
      },
    },
    Set,
    Map,
    RegExp,
    Object,
    String,
    Array,
    Date,
    console,
  };
  zhSandbox.window = zhSandbox;
  zhSandbox.globalThis = zhSandbox;
  vm.runInNewContext(preloadCode, zhSandbox, { filename: 'preload-zh.js' });
  assert.deepEqual(zhIpcCalls, ['context-meter:get-chinese-config-sync', 'context-meter:get-i18n-dict-sync']);
  assert.equal(zhSandbox.__AGY_TRANSLATE_UNIT__('Settings'), '设置');
});

test('i18n regex bucket prefilter matches naive scan identically and idle scan skips hidden document', () => {
  const dictPath = path.join(ROOT, 'payload', 'dist', 'i18n', 'zh-CN.json');
  const runtimePath = path.join(ROOT, 'payload', 'dist', 'i18n', 'i18n-runtime.js');
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const { createI18nEngine } = require(runtimePath);
  const engine = createI18nEngine(dict);

  const compiled = dict.patterns.map((p) => ({ regex: new RegExp(p.regex), replacement: p.replacement }));
  const naiveRun = (str) => {
    for (const p of compiled) {
      if (p.regex.test(str)) {
        let res = str.replace(p.regex, p.replacement);
        for (const p2 of compiled) {
          if (p2.regex.test(res)) res = res.replace(p2.regex, p2.replacement);
        }
        return res;
      }
    }
    return null;
  };

  const samples = [
    'Thought for 1h 2m 3.5s',
    'Thought for 12s',
    'Plan, 2 of 5 steps done',
    'Open Subagent: Codebase Researcher',
    'Show 3 more subagents',
    'Working directory: /tmp/demo',
    '12 lines added, 4 lines removed',
    'Show more (8)',
    'Jan 12, 2026, 3:45 PM',
    'Jan 5 - Feb 10',
    'Retrying transcription (attempt 2)...',
    'Also includes Global Permissions when working in this project.',
    'Steps to Reproduce',
    'Unmatched plain text without digits',
    'const x = 42; // unmatched code line',
  ];
  for (const s of samples) {
    const expected = naiveRun(s);
    if (expected !== null && expected !== s && !dict.exact[s]) {
      assert.equal(engine.translate(s), expected, `Pattern mismatch for "${s}"`);
    }
  }

  // Verify idle interval skips full scan while doc.hidden === true
  const runtimeCode = fs.readFileSync(runtimePath, 'utf8');
  const rootEl = createMockElement('HTML');
  const bodyEl = createMockElement('BODY');
  const btn = createMockElement('BUTTON', {}, '');
  const txt = createMockTextNode('Initial');
  btn.appendChild(txt);
  bodyEl.appendChild(btn);
  rootEl.appendChild(bodyEl);

  let intervalCb = null;
  const doc = {
    documentElement: rootEl,
    body: bodyEl,
    readyState: 'complete',
    hidden: true,
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };
  const sb = {
    document: doc,
    Document: function () {},
    MutationObserver: class { observe() {} disconnect() {} },
    Set,
    Map,
    RegExp,
    Object,
    String,
    Array,
    Date,
    setInterval(cb) {
      intervalCb = cb;
      return 1;
    },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(cb) { cb(); return 1; },
    console,
    __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN' },
    __AGY_I18N_DATA__: { exact: { Settings: '设置' }, patterns: [] },
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.runInNewContext(runtimeCode, sb, { filename: 'i18n-hidden.js' });

  txt.nodeValue = 'Settings';
  txt._agyOriginal = undefined;
  assert.equal(typeof intervalCb, 'function');
  intervalCb();
  assert.equal(txt.nodeValue, 'Settings', 'Idle scan must skip while document.hidden is true');

  doc.hidden = false;
  intervalCb();
  assert.equal(txt.nodeValue, '设置', 'Idle scan resumes once document becomes visible');
});

test('meter-main caches static bundle and coalesces concurrent ensureMeterInjected calls per WebContents', async () => {
  const meterMain = require(path.join(ROOT, 'payload', 'dist', 'meter-main.js'));
  meterMain.clearRuntimeCaches();

  const dictJson = meterMain.getCachedI18nDictJson();
  assert.ok(typeof dictJson === 'string' && dictJson.length > 1000);
  assert.equal(meterMain.getCachedI18nDictJson(), dictJson);

  let execCalls = 0;
  let injectedScripts = 0;
  const fakeWc = {
    isDestroyed: () => false,
    getURL: () => 'https://127.0.0.1:41234/',
    async executeJavaScript(code) {
      execCalls++;
      await new Promise((r) => setTimeout(r, 25));
      if (String(code).includes('window.__AGContextMeter && document.getElementById')) {
        return false;
      }
      injectedScripts++;
      return true;
    },
  };
  const fakeWin = {
    isDestroyed: () => false,
    webContents: fakeWc,
  };

  const results = await Promise.all([
    meterMain.ensureMeterInjected(fakeWin, { force: false }),
    meterMain.ensureMeterInjected(fakeWin, { force: false }),
    meterMain.ensureMeterInjected(fakeWin, { force: false }),
  ]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(injectedScripts, 1, 'Concurrent ensureMeterInjected calls must coalesce into a single script execution');
  assert.equal(execCalls, 2, 'Expected exactly 1 alive check + 1 script injection for 3 concurrent calls');
});

test('meter-storage byte verification, collector bounded caches, SSH renderer banners, and doctor SSH hook check', () => {
  const { safeWriteJsonSync } = require(path.join(ROOT, 'payload', 'dist', 'meter-storage.js'));
  const collector = require(path.join(ROOT, 'payload', 'dist', 'meter-collector.js'));

  // 1. Bounded map enforces cap while preserving pending entries
  const m = new Map();
  collector.setBoundedMap(m, 'k0', { pending: Promise.resolve() }, 3, (v) => Boolean(v && v.pending));
  collector.setBoundedMap(m, 'k1', { done: true }, 3, (v) => Boolean(v && v.pending));
  collector.setBoundedMap(m, 'k2', { done: true }, 3, (v) => Boolean(v && v.pending));
  collector.setBoundedMap(m, 'k3', { done: true }, 3, (v) => Boolean(v && v.pending));
  assert.equal(m.size, 3);
  assert.equal(m.has('k0'), true, 'Pending entry must not be evicted');
  assert.equal(m.has('k1'), false, 'Oldest completed entry should be evicted');
  assert.equal(m.has('k3'), true);

  // 2. safeWriteJsonSync byte-level pre_verify and post_verify
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-storage-test-'));
  try {
    const outPath = path.join(tmp, 'ledger.json');
    const okRes = safeWriteJsonSync(outPath, { version: '1.0.0', calls: { c1: { totalTokens: 100 } } }, {
      validate: (d) => d && typeof d.calls === 'object',
    });
    assert.equal(okRes.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')).calls.c1, { totalTokens: 100 });

    // Corrupted temp read triggers pre_verify failure without clobbering existing file
    const badFs = {
      ...fs,
      readFileSync(p) {
        if (String(p).includes('.tmp')) return Buffer.from('{"truncated":');
        return fs.readFileSync(p);
      },
    };
    const badRes = safeWriteJsonSync(outPath, { version: '1.0.0', calls: {} }, { fs: badFs });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.phase, 'pre_verify');
    assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).calls.c1.totalTokens, 100);

    // 3. Doctor explicitly flags missing SSH hooks when official/target bundle contains dist/remote/bootstrapScript.js
    const fakeHakimi = path.join(tmp, 'FakeHakimi.app');
    const srcTree = path.join(tmp, 'src-tree');
    fs.mkdirSync(path.join(srcTree, 'dist', 'remote'), { recursive: true });
    fs.writeFileSync(path.join(srcTree, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    fs.writeFileSync(
      path.join(srcTree, 'dist', 'utils.js'),
      [
        'function setupNodeWrapper(env) { return env; }',
        'function createWindow(url, storageManager) {',
        '    const win = {};',
        '    void loadHubWindowUrl(win, url);',
        '    return win;',
        '}',
        'function showOrCreateWindow(port) {',
        '    const wins = [];',
        '    if (wins.length > 0) {',
        '        wins[0].focus();',
        '    } else {',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '    }',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(srcTree, 'dist', 'preload.js'), 'const electron_1 = {};\n', 'utf8');
    fs.writeFileSync(
      path.join(srcTree, 'dist', 'remote', 'bootstrapScript.js'),
      'const SCRIPT_BODY = "\\nagy_main; exit $?\\n";\nfunction buildBootstrapScript() {\n    const header = "#!/bin/sh\\n";\n    return header + SCRIPT_BODY;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcTree, 'dist', 'remote', 'remoteManager.js'),
      'class RemoteManager {\n    onConnected(entry, sshSession) {\n        entry.session = sshSession;\n    }\n    disposeHost(entry) {\n        entry.disposed = true;\n    }\n}\n',
      'utf8'
    );
    const srcAsar = path.join(tmp, 'src.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcTree, srcAsar, {});

    // 3a. Uninjected SSH hooks -> doctor flags hakimi_ssh_hooks as WARN
    const unpatchedHakimi = path.join(tmp, 'UnpatchedHakimi.app');
    const unpatchedAsar = path.join(unpatchedHakimi, 'Contents', 'Resources', 'app.asar');
    fs.mkdirSync(path.dirname(unpatchedAsar), { recursive: true });
    fs.copyFileSync(srcAsar, unpatchedAsar);
    const srcHash = asarEngine.computeAsarHeaderSha256(unpatchedAsar);
    fs.writeFileSync(
      path.join(unpatchedHakimi, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.34.0</string><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${srcHash}</string></dict></dict></dict></plist>`,
      'utf8'
    );
    const docWarn = runDoctor({
      appPath: unpatchedHakimi,
      officialApp: path.join(tmp, 'MissingOfficial.app'),
      skipCodesign: true,
      skipProcess: true,
      homeDir: tmp,
      stateDir: tmp,
    });
    const sshCheckWarn = docWarn.checks.find((c) => c.id === 'hakimi_ssh_hooks');
    assert.ok(sshCheckWarn, 'doctor must report hakimi_ssh_hooks when SSH files exist');
    assert.equal(sshCheckWarn.level, 'WARN');

    // 3b. Packed Hakimi ASAR -> doctor reports hakimi_ssh_hooks as OK
    const destAsar = path.join(fakeHakimi, 'Contents', 'Resources', 'app.asar');
    const packed = packHakimiAsar({ srcAsar, destAsar, skipConfig: true });
    assert.equal(packed.ok, true);
    fs.writeFileSync(
      path.join(fakeHakimi, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.34.0</string><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${packed.sha256}</string></dict></dict></dict></plist>`,
      'utf8'
    );
    const docOk = runDoctor({
      appPath: fakeHakimi,
      officialApp: path.join(tmp, 'MissingOfficial.app'),
      skipCodesign: true,
      skipProcess: true,
      homeDir: tmp,
      stateDir: tmp,
    });
    const sshCheckOk = docOk.checks.find((c) => c.id === 'hakimi_ssh_hooks');
    assert.ok(sshCheckOk, 'doctor must include hakimi_ssh_hooks check');
    assert.equal(sshCheckOk.level, 'OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4. Renderer exposes SSH remote status banner
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const renderedJs = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  for (const marker of ['enhance-ssh-remote-banner']) {
    assert.ok(tpl.includes(marker), `Missing ${marker} in template.html`);
    assert.ok(renderedJs.includes(marker), `Missing ${marker} in meter-renderer.js`);
  }
  assert.ok(renderedJs.includes('renderSshRemoteContextBanners'));
  assert.ok(renderedJs.includes('ssh.remote.contextBanner'));
});

test('markdown preload patch disables remark-gfm singleTilde by default with host/frame guard and clean round-trip', () => {
  const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
  const preloadSnippet = modularInstaller.generateMarkdownPreloadCode();
  assert.ok(modularInstaller.validateSyntax(preloadSnippet, 'markdown-preload.js'));
  assert.ok(preloadSnippet.includes(modularInstaller.TAGS.MARKDOWN_PRELOAD_START));
  assert.ok(preloadSnippet.includes(modularInstaller.TAGS.MARKDOWN_PRELOAD_END));

  const basePreload = 'const electron_1 = require("electron");\n';
  const cleaned = modularInstaller.cleanPreloadSource(basePreload + preloadSnippet);
  assert.equal(cleaned.includes(modularInstaller.TAGS.MARKDOWN_PRELOAD_START), false);
  assert.equal(cleaned.includes('__AGY_REMARK_GFM_NO_SINGLE_TILDE__'), false);
  assert.ok(modularInstaller.validateSyntax(cleaned, 'cleaned-preload.js'));

  const runPreload = (location, isTop) => {
    const executed = [];
    const topObj = {};
    const sandbox = {
      location,
      top: topObj,
      self: isTop ? topObj : {},
      electron_1: {
        webFrame: {
          executeJavaScript(code) {
            executed.push(code);
            return Promise.resolve();
          },
        },
      },
      Promise,
      RegExp,
      Object,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(preloadSnippet, sandbox, { filename: 'preload-markdown.js' });
    return executed;
  };

  assert.equal(runPreload({ protocol: 'https:', hostname: 'example.com' }, true).length, 0);
  assert.equal(runPreload({ protocol: 'https:', hostname: '127.0.0.1' }, false).length, 0);

  const localRuns = runPreload({ protocol: 'https:', hostname: '127.0.0.1' }, true);
  assert.equal(localRuns.length, 1);

  const mainWorld = { Object, Symbol, console };
  mainWorld.globalThis = mainWorld;
  mainWorld.window = mainWorld;
  vm.runInNewContext(localRuns[0], mainWorld, { filename: 'main-world-markdown.js' });
  // Idempotent second run must not break or double-wrap
  vm.runInNewContext(localRuns[0], mainWorld, { filename: 'main-world-markdown-2.js' });

  const calls = [];
  function fakeRemarkGfm(opts) {
    calls.push({ self: this, opts });
    return 'ok';
  }
  const extraSym = Symbol('extra');
  const esmLike = Object.defineProperties(
    { __esModule: true, namedExport: 42, [extraSym]: 'sym' },
    { default: { get: () => fakeRemarkGfm, enumerable: true, configurable: false } }
  );
  mainWorld['remark-gfm'] = esmLike;
  const wrapped = mainWorld['remark-gfm'];
  assert.equal(wrapped.__esModule, true);
  assert.equal(wrapped.namedExport, 42);
  assert.equal(wrapped[extraSym], 'sym');

  const processor = { id: 'proc' };
  wrapped.default.call(processor);
  wrapped.default.call(processor, null);
  wrapped.default.call(processor, { tablePipeAlign: false });
  wrapped.default.call(processor, { singleTilde: undefined, firstLineBlank: true });
  wrapped.default.call(processor, { singleTilde: true, tablePipeAlign: false });

  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(call.self, processor);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.map((c) => c.opts))),
    [
      { singleTilde: false },
      { singleTilde: false },
      { tablePipeAlign: false, singleTilde: false },
      { singleTilde: false, firstLineBlank: true },
      { singleTilde: true, tablePipeAlign: false },
    ]
  );

  // Also handles non-configurable non-writable data property without Proxy invariant error
  const frozenMod = Object.defineProperty(
    { __esModule: true },
    'default',
    { value: fakeRemarkGfm, writable: false, configurable: false, enumerable: true }
  );
  mainWorld['remark-gfm'] = frozenMod;
  calls.length = 0;
  mainWorld['remark-gfm'].default.call(processor);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, processor);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].opts)), { singleTilde: false });
});

test('markdown preload patch prevents single-tilde strikethrough in real language_server remark-gfm bundle', (t) => {
  const lsBin = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
  if (!fs.existsSync(lsBin)) {
    t.skip('official language_server not present');
    return;
  }
  const zlib = require('zlib');
  const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
  const bin = fs.readFileSync(lsBin);

  let mainJs = null;
  let pos = 0;
  while (true) {
    const idx = bin.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), pos);
    if (idx === -1 || idx + 30 > bin.length) break;
    pos = idx + 4;
    const comp = bin.readUInt16LE(idx + 8);
    const csize = bin.readUInt32LE(idx + 18);
    const fnlen = bin.readUInt16LE(idx + 26);
    const exlen = bin.readUInt16LE(idx + 28);
    if (fnlen === 7 && bin.subarray(idx + 30, idx + 37).toString('utf8') === 'main.js') {
      const start = idx + 30 + fnlen + exlen;
      const raw = bin.subarray(start, start + csize);
      mainJs = (comp === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      break;
    }
  }
  if (!mainJs || !mainJs.includes('globalThis["remark-gfm"]=')) {
    t.skip('embedded main.js does not expose globalThis["remark-gfm"]');
    return;
  }

  const extractGlobalIife = (name) => {
    const endIdx = mainJs.indexOf(`globalThis["${name}"]=`);
    const callEnd = mainJs.indexOf('}).call(globalThis);', endIdx) + '}).call(globalThis);'.length;
    const re = /\*\/\s*\(function\(\)\{/g;
    let lastStart = -1;
    let m;
    while ((m = re.exec(mainJs)) && m.index < endIdx) {
      lastStart = m.index + m[0].indexOf('(function(){');
    }
    return mainJs.slice(lastStart, callEnd);
  };

  const remarkParseIife = extractGlobalIife('remark-parse');
  const remarkGfmIife = extractGlobalIife('remark-gfm');
  const patchScript = modularInstaller.buildMarkdownMainWorldPatchScript();

  const parseDeletes = (withPatch, samples) => {
    const ctx = vm.createContext({
      globalThis: null,
      window: null,
      safevalues_raw: { dom: { setElementInnerHtml() {} }, htmlEscape: (s) => s },
      document: { createElement: () => ({ textContent: '' }) },
      Object,
      Array,
      Map,
      Set,
      RegExp,
      Error,
      TypeError,
      Number,
      String,
      Boolean,
      Math,
      Symbol,
      console,
    });
    ctx.globalThis = ctx;
    ctx.window = ctx;
    if (withPatch) vm.runInContext(patchScript, ctx);
    vm.runInContext(remarkParseIife, ctx);
    vm.runInContext(remarkGfmIife, ctx);
    ctx.__samples = samples;
    return vm.runInContext(`
      var gfm = globalThis['remark-gfm'].default;
      var parse = globalThis['remark-parse'].default;
      var store = {};
      var proc = { data: function(k) { return k ? store[k] : store; } };
      gfm.call(proc);
      parse.call(proc);
      __samples.map(function(s) {
        var tree = proc.parser(s);
        var nodes = [];
        (function walk(n) {
          if (n.type === 'delete') nodes.push(n.children.map(function(c) { return c.value; }).join(''));
          if (n.children) n.children.forEach(walk);
        })(tree);
        return nodes;
      });
    `, ctx);
  };

  const samples = [
    'Get 平均耗时从 ~150ms 恶化至 300~514ms、',
    '1~2 分钟....15:29~17:11',
    '这是 ~~真正删除线~~ 和 ~约100ms~ 未误伤',
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(parseDeletes(false, samples))), [
    ['150ms 恶化至 300'],
    ['2 分钟....15:29'],
    ['真正删除线', '约100ms'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(parseDeletes(true, samples))), [
    [],
    [],
    ['真正删除线'],
  ]);
});

test('tech drawer, 20s full-trajectory scan, and attachment_scan.py are removed while token history polling is lazy and idle-throttled', async () => {
  const collector = require(path.join(ROOT, 'payload', 'dist', 'meter-collector.js'));
  const meterMainSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-main.js'), 'utf8');
  const modularSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'), 'utf8');
  const packerSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'hakimi-asar-packer.js'), 'utf8');
  const mainRendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'main.js'), 'utf8');

  // 1. Static pruning verification
  assert.equal(fs.existsSync(path.join(ROOT, 'payload', 'dist', 'attachment_scan.py')), false);
  assert.equal(collector.collect, undefined);
  assert.equal(collector.scanFiles, undefined);
  assert.equal(collector.pythonScan, undefined);
  assert.equal(collector.TOKEN_HISTORY_CACHE_TTL_MS, 60000);
  assert.equal(meterMainSrc.includes('context-meter:scan'), false);
  assert.equal(modularSrc.includes('context-meter:scan'), false);
  assert.equal(packerSrc.includes('attachment_scan.py'), false);
  assert.equal(mainRendererSrc.includes('GetCascadeTrajectorySteps'), false);

  // 2. Collector archive cache reads cleanly and detects archive updates
  const tmpAg = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-hist-cache-'));
  try {
    const v1Path = path.join(tmpAg, 'token_usage_archive_v1.json');
    fs.writeFileSync(
      v1Path,
      JSON.stringify({
        firstUseDate: '2026-11-01',
        dailyMap: { '2026-11-01': { total: 5000, input: 3000, output: 1000, cache: 1000, steps: 2 } },
      }),
      'utf8'
    );
    const h1 = await collector.collectTokenHistoryAsync({ agDir: tmpAg, userStatus: null });
    assert.equal(h1.summary.grandTotalTokens, 5000);

    // Update archive with larger size so stat cache invalidates immediately
    fs.writeFileSync(
      v1Path,
      JSON.stringify({
        firstUseDate: '2026-11-01',
        dailyMap: {
          '2026-11-01': { total: 5000, input: 3000, output: 1000, cache: 1000, steps: 2 },
          '2026-11-02': { total: 7500, input: 4500, output: 1500, cache: 1500, steps: 3 },
        },
      }),
      'utf8'
    );
    const h2 = await collector.collectTokenHistoryAsync({ agDir: tmpAg, userStatus: null });
    assert.equal(h2.summary.grandTotalTokens, 12500);
  } finally {
    fs.rmSync(tmpAg, { recursive: true, force: true });
  }

  // 3. Renderer VM check: lazy heatmap rendering, single boot getSettings, hidden-tab pause & visibility resume
  const byId = new Map();
  const makeNode = (tag, id = '') => {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const node = {
      nodeType: 1,
      tagName: String(tag || 'DIV').toUpperCase(),
      id,
      hidden: id === 'panel' || id === 'panel-tokens' || id === 'overflow-menu' || id === 'color-picker-popover',
      disabled: false,
      textContent: '',
      value: '',
      className: '',
      style: {
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; },
        getPropertyValue(k) { return this[k] || ''; },
      },
      children,
      childNodes: children,
      parentElement: null,
      get isConnected() { return true; },
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() { return false; },
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener() {},
      appendChild(child) {
        child.parentElement = node;
        children.push(child);
        return child;
      },
      replaceChildren(...items) {
        children.length = 0;
        for (const it of items) {
          if (it && typeof it === 'object') {
            it.parentElement = node;
            children.push(it);
          }
        }
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      contains(target) { return target === node || children.includes(target); },
      getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }; },
      remove() {},
      attachShadow() {
        let html = '';
        const shadow = {
          get innerHTML() { return html; },
          set innerHTML(val) {
            html = String(val || '');
            for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
              if (!byId.has(m[1])) byId.set(m[1], makeNode('DIV', m[1]));
            }
          },
          getElementById(k) { return byId.get(k) || null; },
          querySelector() { return null; },
          querySelectorAll() { return []; },
        };
        return shadow;
      },
    };
    return node;
  };

  const docListeners = new Map();
  const body = makeNode('BODY', 'body');
  const fakeDoc = {
    hidden: false,
    body,
    documentElement: body,
    head: makeNode('HEAD', 'head'),
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (list) docListeners.set(type, list.filter((x) => x !== fn));
    },
  };

  let getSettingsCalls = 0;
  let getTokenHistoryCalls = 0;
  let lastForceArg = null;
  const historyPayload = {
    updatedAt: '2026-11-25 12:00:00',
    firstUseDate: '2026-11-20',
    summary: { grandTotalTokens: 42000, todayTokens: 42000, monthTokens: 42000, yearTokens: 42000, totalConversations: 2, activeDaysCount: 1 },
    dailyMap: { '2026-11-25': { total: 42000, input: 20000, output: 12000, cache: 10000, steps: 4 } },
    dailyMapBySource: {
      all: { '2026-11-25': { total: 42000, input: 20000, output: 12000, cache: 10000, steps: 4 } },
      desktop: { '2026-11-25': { total: 42000, input: 20000, output: 12000, cache: 10000, steps: 4 } },
      cli: {},
    },
    rawPlanStatus: { status: 'identified', email: 'lazy@example.com', modelQuotaGroups: [] },
    planStatus: { status: 'identified', email: 'lazy@example.com', tierName: 'Pro' },
    cascadeModelConfigs: [],
    speedRecords: [],
  };

  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/' },
    document: fakeDoc,
    navigator: { platform: 'MacIntel' },
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    AbortController,
    Date,
    Math,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
    JSON,
    console,
    contextMeterAPI: {
      getSettings: async () => {
        getSettingsCalls++;
        return { ok: true, uiPreferences: {} };
      },
      getTokenHistory: async (force) => {
        getTokenHistoryCalls++;
        lastForceArg = force;
        return { ok: true, data: historyPayload };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const coreSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  vm.runInNewContext(`${coreSrc}\n${rendererSrc}`, sandbox, { filename: 'meter-renderer-lazy-test.js' });
  await new Promise((r) => setImmediate(r));

  const api = sandbox.__AGContextMeter;
  assert.ok(api, 'meter runtime should initialize');
  assert.equal(getSettingsCalls, 1, 'restoreSettingsFromHost should run once at boot, not on every history sync');
  assert.equal(getTokenHistoryCalls, 1, 'boot should trigger exactly one initial token history sync (no duplicate calls)');

  // Heatmap DOM stays unbuilt while #panel-tokens is hidden, even after receiving history payload
  assert.equal(byId.get('token-amount').textContent, '42.0K');
  assert.equal(api.isHeatViewDirtyForTest(), true, 'heatmap should remain marked dirty while panel-tokens is hidden');
  assert.equal(byId.get('h-grid-cols').children.length, 0, 'hidden panel-tokens must not build 364-day heatmap DOM');

  // While document.hidden === true, tick() must NOT trigger idle history sync even if stale > 2 minutes
  fakeDoc.hidden = true;
  api.setLastHistorySyncForTest(Date.now() - 300000);
  api.tickForTest();
  await new Promise((r) => setImmediate(r));
  assert.equal(getTokenHistoryCalls, 1, 'background hidden tab must pause idle history polling');
  assert.equal(getSettingsCalls, 1, 'settings must never be re-read during polling');

  // Returning to foreground fires visibilitychange and resumes sync cleanly (still no redundant getSettings)
  fakeDoc.hidden = false;
  for (const fn of docListeners.get('visibilitychange') || []) fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(getTokenHistoryCalls, 2, 'returning to foreground after >=60s should catch up history once');
  assert.equal(getSettingsCalls, 1, 'history catch-up must not re-call getSettings');

  // Opening #panel-tokens builds the heatmap DOM once and clears dirty flag
  api.setLastHistorySyncForTest(Date.now() - 20000);
  api.showPanelForTest('tokens');
  await new Promise((r) => setImmediate(r));
  assert.equal(api.isHeatViewDirtyForTest(), false, 'opening panel-tokens should flush dirty heatmap');
  assert.equal(byId.get('h-grid-cols').children.length, 52, 'opening panel-tokens should build 52-week heatmap grid');
  assert.equal(getTokenHistoryCalls, 3);
  assert.equal(lastForceArg, true, 'opening panel-tokens when stale >= 15s should force fresh CLI/desktop scan');

  api.dispose();
});
