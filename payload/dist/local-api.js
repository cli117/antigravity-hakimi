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
    for (const wc of all) {
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
      const rawUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
      const norm = normalizeOrigin(rawUrl);
      if (norm) return { origin: norm, page: { type: 'page', url: rawUrl } };
    }
  } catch {}
  return null;
}

async function resolveOriginAndPage() {
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

async function connect() {
  const { origin, page } = await resolveOriginAndPage();
  const html = await request(origin + '/');
  const m = html.match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
  if (!m) throw new Error('window.__APP_CONFIG__ not found on local host page');
  const token = JSON.parse(m[1]).csrfToken;
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

module.exports = { connect, setLastKnownOrigin };
