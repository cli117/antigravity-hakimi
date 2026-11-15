#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DIST = path.join(ROOT, 'payload', 'dist');

const {
  assertNotOfficialAntigravityApp,
  readAsarHeader,
  computeAsarHeaderSha256,
  builtinAsar,
  withNoAsar,
} = require(path.join(PAYLOAD_DIST, 'asar-engine'));

const { verifyHeaderMetadataPreserved } = require(path.join(__dirname, 'pack-hakimi-asar'));

function parseArgs(argv) {
  const opts = {
    asarPath: null,
    iconPng: null,
    hashOut: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--asar') {
      opts.asarPath = argv[++i];
    } else if (arg === '--icon-png') {
      opts.iconPng = argv[++i];
    } else if (arg === '--hash-out') {
      opts.hashOut = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/replace-asar-icon.js --asar <path> --icon-png <path> [--hash-out <file>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.asarPath) throw new Error('Missing required --asar');
  if (!opts.iconPng) throw new Error('Missing required --icon-png');
  return opts;
}

/**
 * Swap only root `icon.png` inside an already-built app.asar while keeping every
 * other entry, injected hook, and unpacked/executable metadata intact.
 */
function replaceAsarIcon(rawOpts = {}) {
  const targetAsar = path.resolve(String(rawOpts.asarPath || ''));
  const iconPngPath = path.resolve(String(rawOpts.iconPng || ''));

  if (!targetAsar || !fs.existsSync(targetAsar)) {
    throw new Error(`Target ASAR not found: ${targetAsar}`);
  }
  assertNotOfficialAntigravityApp(targetAsar, 'replace icon in ASAR');

  if (!iconPngPath || !fs.existsSync(iconPngPath) || !fs.statSync(iconPngPath).isFile()) {
    throw new Error(`Icon PNG not found: ${iconPngPath}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-asar-icon-'));
  const tmpDestAsar = `${targetAsar}.icon_tmp_${process.pid}_${Date.now()}`;

  try {
    withNoAsar(() => {
      builtinAsar.extractAll(targetAsar, workDir);

      const destIconPng = path.join(workDir, 'icon.png');
      fs.copyFileSync(iconPngPath, destIconPng);
      fs.chmodSync(destIconPng, 0o644);

      builtinAsar.createPackageWithOptions(workDir, tmpDestAsar, {
        unpackDir: '**/chrome-devtools-mcp',
        skipUnpackedWrite: true,
      });

      verifyHeaderMetadataPreserved(targetAsar, tmpDestAsar, new Set(['icon.png']));

      const { header } = readAsarHeader(tmpDestAsar);
      const iconNode = header?.files?.['icon.png'];
      if (!iconNode || iconNode.files || iconNode.unpacked || iconNode.executable) {
        throw new Error('Packed ASAR icon.png metadata invalid after icon swap');
      }

      const sha256 = computeAsarHeaderSha256(tmpDestAsar);
      fs.renameSync(tmpDestAsar, targetAsar);

      if (rawOpts.hashOut) {
        const hashOutPath = path.resolve(String(rawOpts.hashOut));
        fs.mkdirSync(path.dirname(hashOutPath), { recursive: true });
        fs.writeFileSync(hashOutPath, `${sha256}\n`, 'utf8');
      }
    });

    const sha256 = computeAsarHeaderSha256(targetAsar);
    return { ok: true, targetAsar, sha256 };
  } finally {
    try {
      if (fs.existsSync(tmpDestAsar)) fs.unlinkSync(tmpDestAsar);
    } catch {}
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = replaceAsarIcon(opts);
  process.stdout.write(`${res.sha256}\n`);
}

module.exports = {
  replaceAsarIcon,
};
