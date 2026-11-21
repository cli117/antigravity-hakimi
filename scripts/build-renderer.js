#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer');
const OUT_FILE = path.join(ROOT, 'payload', 'dist', 'meter-renderer.js');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function escapeTemplateLiteral(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function replaceOnce(source, placeholder, replacement, label) {
  const idx = source.indexOf(placeholder);
  if (idx === -1) {
    throw new Error(`Missing placeholder ${placeholder} (${label}) in src/renderer/main.js`);
  }
  return source.slice(0, idx) + replacement + source.slice(idx + placeholder.length);
}

function buildRenderer() {
  const pkg = JSON.parse(readUtf8(path.join(ROOT, 'package.json')));
  const meterVersion = String(pkg.version || '1.0.0');

  const styles = readUtf8(path.join(SRC_DIR, 'styles.css'));
  const template = readUtf8(path.join(SRC_DIR, 'template.html'));
  const i18n = readUtf8(path.join(SRC_DIR, 'i18n.js'));
  const budgetEngine = readUtf8(path.join(SRC_DIR, 'context-budget-engine.js'));
  const colors = readUtf8(path.join(SRC_DIR, 'colors.js'));
  const topbarLayout = readUtf8(path.join(SRC_DIR, 'topbar-layout.js'));
  const dropdown = readUtf8(path.join(SRC_DIR, 'dropdown.js'));
  const requestInterceptor = readUtf8(path.join(SRC_DIR, 'request-interceptor.js'));
  const contextSettings = readUtf8(path.join(SRC_DIR, 'context-settings.js'));
  const speedPanel = readUtf8(path.join(SRC_DIR, 'speed-panel.js'));
  const settingsPanel = readUtf8(path.join(SRC_DIR, 'settings-panel.js'));
  const heatmap = readUtf8(path.join(SRC_DIR, 'heatmap.js'));
  let main = readUtf8(path.join(SRC_DIR, 'main.js'));

  const stylesAndTemplateSnippet =
    `  shadow.innerHTML = \`<style>\n    ${escapeTemplateLiteral(styles)}\n  </style>\n\n  ${escapeTemplateLiteral(template)}\`;`;

  main = replaceOnce(
    main,
    '(function () {',
    `(function () {\n  const METER_VERSION = ${JSON.stringify(meterVersion)};`,
    'METER_VERSION'
  );
  main = replaceOnce(main, '  /* @INSERT_STYLES_AND_TEMPLATE */', stylesAndTemplateSnippet, 'styles+template');
  main = replaceOnce(main, '  /* @INSERT_I18N_MODULE */', i18n, 'i18n');
  main = replaceOnce(main, '  /* @INSERT_BUDGET_ENGINE_MODULE */', budgetEngine, 'context-budget-engine');
  main = replaceOnce(main, '  /* @INSERT_COLORS_MODULE */', colors, 'colors');
  main = replaceOnce(main, '  /* @INSERT_TOPBAR_LAYOUT_MODULE */', topbarLayout, 'topbar-layout');
  main = replaceOnce(main, '  /* @INSERT_DROPDOWN_MODULE */', dropdown, 'dropdown');
  main = replaceOnce(main, '  /* @INSERT_REQUEST_INTERCEPTOR_MODULE */', requestInterceptor, 'request-interceptor');
  main = replaceOnce(main, '  /* @INSERT_CONTEXT_SETTINGS_MODULE */', contextSettings, 'context-settings');
  main = replaceOnce(main, '  /* @INSERT_SPEED_PANEL_MODULE */', speedPanel, 'speed-panel');
  main = replaceOnce(main, '  /* @INSERT_SETTINGS_PANEL_MODULE */', settingsPanel, 'settings-panel');
  main = replaceOnce(main, '  /* @INSERT_HEATMAP_MODULE */', heatmap, 'heatmap');

  new vm.Script(main, { filename: 'payload/dist/meter-renderer.js' });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, main, 'utf8');
  return { outFile: OUT_FILE, bytes: Buffer.byteLength(main, 'utf8'), version: meterVersion };
}

if (require.main === module) {
  const res = buildRenderer();
  console.log(`Built ${path.relative(ROOT, res.outFile)} (${res.bytes} bytes, v${res.version})`);
}

module.exports = { buildRenderer };
