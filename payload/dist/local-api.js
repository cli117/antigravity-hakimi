'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

let lastKnownOrigin = null;

function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function normalizeOrigin(originOrUrl) {
  if (!originOrUrl || typeof originOrUrl !== 'string') return null;
  try {
    const u = new URL(originOrUrl);
    if (!/^https?:$/.test(u.protocol) || !isLoopbackHost(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isSameLoopbackServer(originA, originB) {
  if (!originA || !originB) return false;
  if (originA === originB) return true;
  try {
    const ua = new URL(originA);
    const ub = new URL(originB);
    return (
      ua.protocol === ub.protocol &&
      ua.port === ub.port &&
      isLoopbackHost(ua.hostname) &&
      isLoopbackHost(ub.hostname)
    );
  } catch {
    return false;
  }
}

function resolveActiveLsAuth(expectedOrigin = null, options = {}) {
  const normalizedExpected = expectedOrigin ? normalizeOrigin(expectedOrigin) : null;
  const sources = [];
  if (options && options.authBootstrap) {
    sources.push({ mod: options.authBootstrap, urlFn: 'getActiveLsBaseUrl', tokenFn: 'getActiveLsCsrfToken' });
  } else {
    try {
      sources.push({ mod: require('./authBootstrap'), urlFn: 'getActiveLsBaseUrl', tokenFn: 'getActiveLsCsrfToken' });
    } catch {}
  }
  if (options && options.languageServer) {
    sources.push({ mod: options.languageServer, urlFn: 'getLsBaseUrl', tokenFn: 'getLsCsrfToken' });
  } else {
    try {
      sources.push({ mod: require('./languageServer'), urlFn: 'getLsBaseUrl', tokenFn: 'getLsCsrfToken' });
    } catch {}
  }

  for (const src of sources) {
    try {
      const mod = src.mod;
      if (!mod || typeof mod !== 'object') continue;
      const baseUrl = typeof mod[src.urlFn] === 'function' ? normalizeOrigin(mod[src.urlFn]()) : null;
      const csrfToken =
        typeof mod[src.tokenFn] === 'function' ? String(mod[src.tokenFn]() || '').trim() : '';
      if (csrfToken && (!normalizedExpected || !baseUrl || isSameLoopbackServer(baseUrl, normalizedExpected))) {
        return { origin: baseUrl || normalizedExpected, csrfToken };
      }
      if (!normalizedExpected && baseUrl) {
        return { origin: baseUrl, csrfToken };
      }
    } catch {}
  }
  return { origin: null, csrfToken: '' };
}

function setLastKnownOrigin(originOrUrl) {
  const norm = normalizeOrigin(originOrUrl);
  if (norm) lastKnownOrigin = norm;
  return lastKnownOrigin;
}

function request(urlStr, body, token) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }
    if (!/^https?:$/.test(parsed.protocol) || !isLoopbackHost(parsed.hostname)) {
      return reject(new Error(`Refusing non-loopback local API request: ${urlStr}`));
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      method: body ? 'POST' : 'GET',
      headers: body
        ? {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': token || '',
          }
        : {},
    };
    if (parsed.protocol === 'https:') {
      reqOpts.rejectUnauthorized = false;
    }
    const req = transport.request(urlStr, reqOpts, (response) => {
      let text = '';
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () =>
        response.statusCode === 200
          ? resolve(text)
          : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
      );
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function findDevToolsActivePortFile() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'));
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
    path.join(home, '.config', 'Antigravity', 'DevToolsActivePort')
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function findOriginFromElectronWebContents() {
  try {
    const electron = require('electron');
    const all = electron && electron.webContents && typeof electron.webContents.getAllWebContents === 'function'
      ? electron.webContents.getAllWebContents()
      : [];
    let getRemoteBackend = null;
    try {
      const wb = require('./remote/windowBackends');
      if (wb && typeof wb.remoteBackendOf === 'function') getRemoteBackend = wb.remoteBackendOf;
    } catch {}
    for (const wc of all) {
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
      if (getRemoteBackend) {
        try {
          if (getRemoteBackend(wc)) continue;
        } catch {}
      }
      const rawUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
      const norm = normalizeOrigin(rawUrl);
      if (norm) return { origin: norm, page: { type: 'page', url: rawUrl } };
    }
  } catch {}
  return null;
}

async function resolveOriginAndPage() {
  const activeAuth = resolveActiveLsAuth();
  if (activeAuth.origin) {
    lastKnownOrigin = activeAuth.origin;
    return { origin: activeAuth.origin, page: { type: 'page', url: `${activeAuth.origin}/` } };
  }
  if (lastKnownOrigin) {
    return { origin: lastKnownOrigin, page: { type: 'page', url: `${lastKnownOrigin}/` } };
  }
  const wcFound = findOriginFromElectronWebContents();
  if (wcFound) {
    lastKnownOrigin = wcFound.origin;
    return wcFound;
  }
  const portFile = findDevToolsActivePortFile();
  if (!portFile) {
    throw new Error('Antigravity window origin unavailable (no active frame or DevToolsActivePort)');
  }
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid DevToolsActivePort in ${portFile}`);
  }
  const pages = JSON.parse(await request(`http://127.0.0.1:${port}/json/list`));
  const page = Array.isArray(pages)
    ? pages.find((item) => item && item.type === 'page' && normalizeOrigin(item.url))
    : null;
  if (!page) throw new Error('Antigravity window not found');
  const origin = normalizeOrigin(page.url);
  lastKnownOrigin = origin;
  return { origin, page };
}

async function resolveCsrfToken(origin, options = {}) {
  const active = resolveActiveLsAuth(origin, options);
  if (active.csrfToken) return active.csrfToken;
  const fetchFn = typeof options.requestFn === 'function' ? options.requestFn : request;
  const html = await fetchFn(origin + '/');
  const m = typeof html === 'string' ? html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/) : null;
  if (!m) throw new Error('window.__APP_CONFIG__ not found on local host page');
  const token = String(JSON.parse(m[1])?.csrfToken || '').trim();
  if (!token) {
    throw new Error('CSRF token unavailable (redacted on GET / and no active authBootstrap token)');
  }
  return token;
}

async function connect() {
  const { origin, page } = await resolveOriginAndPage();
  const token = await resolveCsrfToken(origin);
  return {
    origin,
    page,
    call: async (method, body) =>
      JSON.parse(
        await request(
          `${origin}/exa.language_server_pb.LanguageServerService/${method}`,
          body || {},
          token
        )
      ),
  };
}

module.exports = { connect, setLastKnownOrigin, resolveCsrfToken, resolveActiveLsAuth };
