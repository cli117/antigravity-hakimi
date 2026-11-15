'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const OFFICIAL_ANTIGRAVITY_NAMES = new Set(['antigravity.app', 'antigravity.app.orig']);
const DEFAULT_HAKIMI_APP = '/Applications/哈基米.app';

function withNoAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prev;
  }
}

function resolveWithExistingAncestor(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const pending = [];
  let cur = abs;
  while (true) {
    try {
      if (fs.existsSync(cur)) {
        const real = fs.realpathSync(cur);
        return pending.length ? path.join(real, ...pending.reverse()) : real;
      }
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    pending.push(path.basename(cur));
    cur = parent;
  }
}

function matchesOfficialBundlePath(candidatePath) {
  const normalized = path.resolve(String(candidatePath || '')).replace(/\/+$/, '').toLowerCase();
  if (
    normalized === '/applications/antigravity.app' ||
    normalized.startsWith('/applications/antigravity.app/') ||
    normalized === '/applications/antigravity.app.orig' ||
    normalized.startsWith('/applications/antigravity.app.orig/')
  ) {
    return true;
  }
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (OFFICIAL_ANTIGRAVITY_NAMES.has(part)) return true;
  }
  return false;
}

/**
 * Check whether targetPath points to (or inside) official Antigravity.app or .orig.
 */
function isOfficialAntigravityPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  return withNoAsar(() => {
    if (matchesOfficialBundlePath(targetPath)) return true;
    const real = resolveWithExistingAncestor(targetPath);
    return matchesOfficialBundlePath(real);
  });
}

/**
 * Guard every mutating operation so official /Applications/Antigravity.app is never touched.
 */
function assertNotOfficialAntigravityApp(targetPath, actionDesc) {
  if (isOfficialAntigravityPath(targetPath)) {
    throw new Error(
      `Refusing to ${actionDesc || 'modify'} official Antigravity.app path: ${targetPath}`
    );
  }
}

/**
 * Find enclosing *.app bundle directory for any path inside a macOS app bundle.
 */
function getAppBundleRoot(fromPath) {
  if (!fromPath || typeof fromPath !== 'string') return null;
  let cur = path.resolve(fromPath);
  while (true) {
    if (cur.toLowerCase().endsWith('.app')) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Return the writable target macOS app bundle path (never official Antigravity.app).
 */
function getHakimiAppPath() {
  const envPath = process.env.HAKIMI_APP_PATH || process.env.ANTIGRAVITY_TARGET_APP;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (!isOfficialAntigravityPath(resolved)) return resolved;
  }
  if (process.resourcesPath) {
    const bundle = getAppBundleRoot(process.resourcesPath);
    if (bundle && !isOfficialAntigravityPath(bundle)) return bundle;
  }
  return DEFAULT_HAKIMI_APP;
}

function getStateDir() {
  const override =
    process.env.AG_METER_STATE_DIR ||
    process.env.HAKIMI_STATE_DIR ||
    process.env.ANTIGRAVITY_METER_STATE_DIR;
  if (override) return path.resolve(override);
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const dir = path.join(base, 'AntigravityContextMeter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findAsarPath(customPath) {
  return withNoAsar(() => {
    if (customPath) {
      const resolved = path.resolve(customPath);
      assertNotOfficialAntigravityApp(resolved, 'target ASAR');
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const candidates = [
          path.join(resolved, 'Contents', 'Resources', 'app.asar'),
          path.join(resolved, 'resources', 'app.asar'),
          path.join(resolved, 'app.asar'),
        ];
        for (const candidate of candidates) {
          if (!isOfficialAntigravityPath(candidate) && fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
      if (fs.existsSync(resolved)) return resolved;
      return null;
    }

    const candidates = [];
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, 'app.asar');
      if (!isOfficialAntigravityPath(p)) candidates.push(p);
    }
    if (process.versions && process.versions.electron && process.execPath) {
      const macAsar = path.resolve(path.dirname(process.execPath), '..', 'Resources', 'app.asar');
      if (!isOfficialAntigravityPath(macAsar)) candidates.push(macAsar);
    }
    const hakimiAsar = path.join(getHakimiAppPath(), 'Contents', 'Resources', 'app.asar');
    if (!isOfficialAntigravityPath(hakimiAsar)) candidates.push(hakimiAsar);
    const defaultAsar = path.join(DEFAULT_HAKIMI_APP, 'Contents', 'Resources', 'app.asar');
    if (!isOfficialAntigravityPath(defaultAsar)) candidates.push(defaultAsar);

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
    return null;
  });
}

function readAsarHeader(asarPath) {
  return withNoAsar(() => {
    const fd = fs.openSync(asarPath, 'r');
    try {
      const pre = Buffer.alloc(16);
      const n = fs.readSync(fd, pre, 0, 16, 0);
      if (n < 16 || pre.readUInt32LE(0) !== 4) {
        throw new Error(`Invalid ASAR header magic in ${asarPath}`);
      }
      const headerSizeField = pre.readUInt32LE(4);
      const strLen = pre.readUInt32LE(12);
      const headerBuf = Buffer.alloc(strLen);
      let readTotal = 0;
      while (readTotal < strLen) {
        const chunk = fs.readSync(fd, headerBuf, readTotal, strLen - readTotal, 16 + readTotal);
        if (chunk <= 0) break;
        readTotal += chunk;
      }
      if (readTotal !== strLen) {
        throw new Error(`Truncated ASAR header in ${asarPath}`);
      }
      return {
        header: JSON.parse(headerBuf.toString('utf8')),
        headerBuf,
        dataOffset: 8 + headerSizeField,
      };
    } finally {
      fs.closeSync(fd);
    }
  });
}

/**
 * Compute ElectronAsarIntegrity SHA-256 hex over the exact raw header JSON bytes.
 */
function computeAsarHeaderSha256(asarPath) {
  const { headerBuf } = readAsarHeader(asarPath);
  return crypto.createHash('sha256').update(headerBuf).digest('hex');
}

function makeUnpackMatcher(opts = {}) {
  const rawDir = opts.unpackDir ? String(opts.unpackDir).trim() : '';
  const dirPrefixes = [];
  if (rawDir) {
    // Support patterns like "**/chrome-devtools-mcp" or "node_modules/chrome-devtools-mcp"
    const clean = rawDir.replace(/^\*\*\/+/, '').replace(/\/+$/, '');
    if (clean) dirPrefixes.push(clean);
  }
  const unpackFn = typeof opts.unpack === 'function' ? opts.unpack : null;

  return function isUnpackedFile(relPosix) {
    if (unpackFn && unpackFn(relPosix)) return true;
    for (const prefix of dirPrefixes) {
      if (
        relPosix === prefix ||
        relPosix.startsWith(prefix + '/') ||
        relPosix.includes('/' + prefix + '/')
      ) {
        return true;
      }
    }
    return false;
  };
}

function writeAtomicBuffer(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function getAsarNode(header, relPath) {
  const parts = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) {
      throw new Error(`File not found in ASAR: ${relPath}`);
    }
    node = node.files[part];
  }
  return { node, parts };
}

const builtinAsar = {
  statFile(asarPath, relPath) {
    const { header } = readAsarHeader(asarPath);
    const { node } = getAsarNode(header, relPath);
    return node;
  },

  listPackage(asarPath) {
    const { header } = readAsarHeader(asarPath);
    const out = [];
    function walk(node, prefix) {
      if (!node || !node.files) return;
      for (const name of Object.keys(node.files)) {
        const child = node.files[name];
        const rel = `${prefix}/${name}`;
        out.push(rel);
        if (child && child.files) walk(child, rel);
      }
    }
    walk(header, '');
    return out;
  },

  extractFile(asarPath, relPath) {
    return withNoAsar(() => {
      const { header, dataOffset } = readAsarHeader(asarPath);
      const { node, parts } = getAsarNode(header, relPath);
      if (!node || node.files) throw new Error(`Path is a directory in ASAR: ${relPath}`);
      if (node.unpacked) {
        const unpackedPath = path.join(`${asarPath}.unpacked`, ...parts);
        return fs.readFileSync(unpackedPath);
      }
      const size = Number(node.size || 0);
      const offset = Number(node.offset || 0);
      const buf = Buffer.alloc(size);
      if (size > 0) {
        const fd = fs.openSync(asarPath, 'r');
        try {
          let readTotal = 0;
          while (readTotal < size) {
            const n = fs.readSync(fd, buf, readTotal, size - readTotal, dataOffset + offset + readTotal);
            if (n <= 0) break;
            readTotal += n;
          }
          if (readTotal !== size) throw new Error(`Truncated ASAR entry: ${relPath}`);
        } finally {
          fs.closeSync(fd);
        }
      }
      return buf;
    });
  },

  extractAll(asarPath, destDir) {
    return withNoAsar(() => {
      const { header, dataOffset } = readAsarHeader(asarPath);
      const unpackedRoot = `${asarPath}.unpacked`;
      fs.mkdirSync(destDir, { recursive: true });
      const fd = fs.openSync(asarPath, 'r');
      try {
        function walk(node, curDest, relParts) {
          if (!node || !node.files) return;
          for (const name of Object.keys(node.files)) {
            const child = node.files[name];
            const nextDest = path.join(curDest, name);
            const nextParts = relParts.concat(name);
            if (child && child.files) {
              fs.mkdirSync(nextDest, { recursive: true });
              walk(child, nextDest, nextParts);
              continue;
            }
            if (child && child.link) {
              fs.mkdirSync(path.dirname(nextDest), { recursive: true });
              try {
                if (fs.existsSync(nextDest)) fs.unlinkSync(nextDest);
              } catch {}
              const linkTarget = path.join(destDir, child.link);
              const relLink = path.relative(path.dirname(nextDest), linkTarget);
              fs.symlinkSync(relLink, nextDest);
              continue;
            }
            fs.mkdirSync(path.dirname(nextDest), { recursive: true });
            if (child && child.unpacked) {
              const srcUnpacked = path.join(unpackedRoot, ...nextParts);
              if (fs.existsSync(srcUnpacked)) {
                fs.copyFileSync(srcUnpacked, nextDest);
                if (child.executable) fs.chmodSync(nextDest, 0o755);
              }
              continue;
            }
            const size = Number((child && child.size) || 0);
            const offset = Number((child && child.offset) || 0);
            const buf = Buffer.alloc(size);
            if (size > 0) {
              let readTotal = 0;
              while (readTotal < size) {
                const n = fs.readSync(fd, buf, readTotal, size - readTotal, dataOffset + offset + readTotal);
                if (n <= 0) break;
                readTotal += n;
              }
            }
            fs.writeFileSync(nextDest, buf);
            if (child && child.executable) fs.chmodSync(nextDest, 0o755);
          }
        }
        walk(header, destDir, []);
      } finally {
        fs.closeSync(fd);
      }
    });
  },

  createPackageWithOptions(srcDir, destAsar, opts = {}) {
    assertNotOfficialAntigravityApp(destAsar, 'write ASAR');
    return withNoAsar(() => {
      const rootDir = path.resolve(srcDir);
      const isUnpacked = makeUnpackMatcher(opts);
      const unpackedRoot = `${destAsar}.unpacked`;
      const copyUnpacked = opts.skipUnpackedWrite !== true;
      let nextOffset = 0;
      const chunks = [];
      const unpackedQueue = [];

      function buildTree(dir, relPrefix) {
        const filesMap = {};
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

          if (entry.isSymbolicLink()) {
            const rawTarget = fs.readlinkSync(fullPath);
            const absTarget = path.resolve(dir, rawTarget);
            const relFromRoot = path.relative(rootDir, absTarget);
            if (!relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)) {
              filesMap[entry.name] = { link: relFromRoot.replace(/\\/g, '/') };
              continue;
            }
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) {
              filesMap[entry.name] = { files: buildTree(fullPath, relPosix) };
              continue;
            }
            const buf = fs.readFileSync(fullPath);
            const node = { size: buf.length, offset: String(nextOffset) };
            if ((st.mode & 0o111) !== 0) node.executable = true;
            chunks.push(buf);
            nextOffset += buf.length;
            filesMap[entry.name] = node;
            continue;
          }

          if (entry.isDirectory()) {
            // Never set unpacked: true on directories; only files carry unpacked: true
            filesMap[entry.name] = { files: buildTree(fullPath, relPosix) };
            continue;
          }

          if (!entry.isFile()) continue;

          const stat = fs.statSync(fullPath);
          const executable = (stat.mode & 0o111) !== 0;

          if (isUnpacked(relPosix)) {
            const node = {
              size: stat.size,
              unpacked: true,
            };
            filesMap[entry.name] = node;
            if (copyUnpacked) unpackedQueue.push({ fullPath, relPosix, mode: stat.mode });
            continue;
          }

          const buf = fs.readFileSync(fullPath);
          const node = {
            size: buf.length,
            offset: String(nextOffset),
          };
          if (executable) node.executable = true;
          chunks.push(buf);
          nextOffset += buf.length;
          filesMap[entry.name] = node;
        }
        return filesMap;
      }

      const headerObj = { files: buildTree(rootDir, '') };
      const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
      const strLen = headerBuf.length;
      const alignedStrLen = (strLen + 3) & ~3;
      const padLen = alignedStrLen - strLen;
      const picklePayload = 4 + alignedStrLen;
      const headerSizeField = 4 + picklePayload;

      const pre = Buffer.alloc(16);
      pre.writeUInt32LE(4, 0);
      pre.writeUInt32LE(headerSizeField, 4);
      pre.writeUInt32LE(picklePayload, 8);
      pre.writeUInt32LE(strLen, 12);

      const headerPad = padLen > 0 ? Buffer.alloc(padLen, 0) : Buffer.alloc(0);
      const outBuf = Buffer.concat([pre, headerBuf, headerPad, ...chunks]);
      writeAtomicBuffer(destAsar, outBuf);

      if (copyUnpacked && unpackedQueue.length > 0) {
        assertNotOfficialAntigravityApp(unpackedRoot, 'write ASAR unpacked directory');
        for (const item of unpackedQueue) {
          const outFile = path.join(unpackedRoot, ...item.relPosix.split('/'));
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.copyFileSync(item.fullPath, outFile);
          fs.chmodSync(outFile, item.mode & 0o777);
        }
      }
      return destAsar;
    });
  },
};

function loadAsarEngine() {
  return builtinAsar;
}

module.exports = {
  OFFICIAL_ANTIGRAVITY_NAMES,
  DEFAULT_HAKIMI_APP,
  withNoAsar,
  isOfficialAntigravityPath,
  assertNotOfficialAntigravityApp,
  getAppBundleRoot,
  getHakimiAppPath,
  getStateDir,
  findAsarPath,
  readAsarHeader,
  computeAsarHeaderSha256,
  builtinAsar,
  loadAsarEngine,
};
