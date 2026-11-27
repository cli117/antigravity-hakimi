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
  const colors = readUtf8(path.join(SRC_DIR, 'colors.js'));
  const topbarLayout = readUtf8(path.join(SRC_DIR, 'topbar-layout.js'));
  const dropdown = readUtf8(path.join(SRC_DIR, 'dropdown.js'));
  const modelSwitcher = readUtf8(path.join(SRC_DIR, 'model-switcher.js'));
  const modelQuota = readUtf8(path.join(SRC_DIR, 'model-quota.js'));
  const accountSwitcher = readUtf8(path.join(SRC_DIR, 'account-switcher.js'));
  const sidebarFork = readUtf8(path.join(SRC_DIR, 'sidebar-fork.js'));
  const messageFork = readUtf8(path.join(SRC_DIR, 'message-fork.js'));
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
  main = replaceOnce(main, '  /* @INSERT_COLORS_MODULE */', colors, 'colors');
  main = replaceOnce(main, '  /* @INSERT_TOPBAR_LAYOUT_MODULE */', topbarLayout, 'topbar-layout');
  main = replaceOnce(main, '  /* @INSERT_DROPDOWN_MODULE */', dropdown, 'dropdown');
  main = replaceOnce(main, '  /* @INSERT_MODEL_SWITCHER_MODULE */', modelSwitcher, 'model-switcher');
  main = replaceOnce(main, '  /* @INSERT_MODEL_QUOTA_MODULE */', modelQuota, 'model-quota');
  main = replaceOnce(main, '  /* @INSERT_ACCOUNT_SWITCHER_MODULE */', accountSwitcher, 'account-switcher');
  main = replaceOnce(main, '  /* @INSERT_SIDEBAR_FORK_MODULE */', sidebarFork, 'sidebar-fork');
  main = replaceOnce(main, '  /* @INSERT_MESSAGE_FORK_MODULE */', messageFork, 'message-fork');
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
