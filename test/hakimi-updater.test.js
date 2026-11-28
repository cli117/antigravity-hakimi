'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const asarEngine = require(path.join(ROOT, 'payload', 'dist', 'asar-engine.js'));
const upgradeHelper = require(path.join(ROOT, 'payload', 'dist', 'hakimi-upgrade-helper.js'));
const builder = require(path.join(ROOT, 'payload', 'dist', 'hakimi-builder.js'));
const updaterMod = require(path.join(ROOT, 'payload', 'dist', 'hakimi-updater.js'));
const { packHakimiAsar, PAYLOAD_FILES } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar.js'));
const { inspectDiskModules } = require(path.join(ROOT, 'payload', 'dist', 'modules-config.js'));
const { runDoctor } = require(path.join(ROOT, 'scripts', 'doctor.js'));

// Host architecture drives the default official manifest name (`latest-<arch>-mac.yml`)
// and the zip directory inside it. Keep fixtures host-agnostic so the suite passes on
// both Apple Silicon (arm64) and Intel (x64) machines.
const HOST_ARCH = builder.normalizeMacArch();
const HOST_MANIFEST = `latest-${HOST_ARCH}-mac.yml`;
const HOST_ZIP_DIR = HOST_ARCH === 'x64' ? 'darwin-x64' : 'darwin-arm';

function makeFakeBundle(bundleDir, { version = '2.34.0', marker = 'old', commit = null } = {}) {
  fs.mkdirSync(path.join(bundleDir, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'Contents', 'Resources', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'Contents', 'MacOS', 'Antigravity'), `#!/bin/sh\necho ${marker}\n`, 'utf8');
  fs.chmodSync(path.join(bundleDir, 'Contents', 'MacOS', 'Antigravity'), 0o755);
  fs.writeFileSync(path.join(bundleDir, 'Contents', 'Resources', 'app.asar'), `asar-${marker}`, 'utf8');
  fs.writeFileSync(
    path.join(bundleDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    'utf8'
  );
  if (commit) {
    builder.writeBuildMeta(bundleDir, {
      antigravityVersion: version,
      hakimiVersion: '0.8.3',
      hakimiCommit: commit,
      sourceKind: 'official-local',
    });
  }
}

test('hakimi-upgrade-helper runs standalone outside repo with zero relative dependencies and guards official bundle', () => {
  const helperSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'hakimi-upgrade-helper.js'), 'utf8');
  const reqMatches = [...helperSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const modName of reqMatches) {
    assert.equal(modName.startsWith('.'), false, `hakimi-upgrade-helper.js must not have relative require: ${modName}`);
  }

  for (const forbidden of [
    '/Applications/Antigravity.app',
    '/Applications/Antigravity.app.orig',
    '/Applications/Antigravity.app/Contents/Resources/app.asar',
  ]) {
    assert.equal(upgradeHelper.isOfficialAntigravityBundle(forbidden), true);
    assert.throws(() => upgradeHelper.assertNotOfficialBundle(forbidden, '替换'), /安全拦截/);
  }
  assert.equal(upgradeHelper.isOfficialAntigravityBundle('/Applications/哈基米.app'), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-helper-standalone-'));
  try {
    const standalonePath = path.join(tmp, 'hakimi-upgrade-helper.js');
    fs.writeFileSync(standalonePath, helperSrc, 'utf8');
    const out = execFileSync(
      process.execPath,
      ['-e', `const h = require(${JSON.stringify(standalonePath)}); process.stdout.write(String(h.isOfficialAntigravityBundle('/Applications/Antigravity.app')));`],
      { encoding: 'utf8', cwd: tmp }
    );
    assert.equal(out.trim(), 'true');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('executeColdUpgradeJob enforces exit barrier, swaps atomically, promotes single-slot clean zip, cleans .prev/staging, and relaunches cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cold-swap-'));
  try {
    const appsDir = path.join(tmp, 'Apps');
    const stateDir = path.join(tmp, 'state');
    const userDataDir = path.join(tmp, 'userData');
    const nativeCacheDir = path.join(tmp, 'nativeCache');
    const cleanBaseDir = path.join(stateDir, 'updater', 'clean-base');
    const stagingRootDir = path.join(stateDir, 'updater', 'staging', 'build-2.35.1');
    const targetAppPath = path.join(appsDir, '哈基米.app');
    const stagedAppPath = path.join(stagingRootDir, '哈基米.app');
    const updaterStatePath = path.join(stateDir, 'updater', 'state.json');

    makeFakeBundle(targetAppPath, { version: '2.34.0', marker: 'old-234' });
    makeFakeBundle(stagedAppPath, { version: '2.35.1', marker: 'new-2351' });

    fs.mkdirSync(cleanBaseDir, { recursive: true });
    fs.writeFileSync(path.join(cleanBaseDir, 'Antigravity-2.34.0.zip'), 'old-zip', 'utf8');
    const stagedZipPath = path.join(stagingRootDir, 'clean-base-2.35.1.zip');
    fs.writeFileSync(stagedZipPath, 'new-zip-2351', 'utf8');

    fs.mkdirSync(path.join(nativeCacheDir, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(nativeCacheDir, 'pending', 'Antigravity.zip'), 'dup-zip', 'utf8');
    fs.writeFileSync(path.join(nativeCacheDir, 'update.zip'), 'dup-update-zip', 'utf8');

    fs.mkdirSync(userDataDir, { recursive: true });
    fs.symlinkSync('test-host-99999999', path.join(userDataDir, 'SingletonLock'));
    upgradeHelper.writeJsonFileAtomic(updaterStatePath, {
      schemaVersion: 1,
      staged: { stagedAppPath },
      incompatible: { antigravityVersion: '2.35.0' },
    });

    const signals = [];
    let aliveChecks = 0;
    const spawned = [];
    const res = upgradeHelper.executeColdUpgradeJob(
      {
        targetAppPath,
        stagedAppPath,
        stagingRootDir,
        targetAntigravityVersion: '2.35.1',
        targetHakimiCommit: 'a'.repeat(40),
        updaterStatePath,
        stateDir,
        userDataDir,
        homeDir: tmp,
        cleanBasePromotion: {
          stagedZipPath,
          cleanBaseDir,
          version: '2.35.1',
          sha512: 'fake-sha512',
          nativeCacheDir,
        },
      },
      {
        pollIntervalMs: 1,
        initialGraceMs: 2,
        mainTermMs: 5,
        sleepImpl: () => {},
        skipMacRegistration: true,
        execFileSync: () => '',
        findPidsImpl: (mode) => {
          aliveChecks++;
          if (aliveChecks <= 4) return mode === 'main' ? [43210] : [43210, 43211];
          return [];
        },
        killImpl: (pid, sig) => {
          if (sig === 0) {
            const err = new Error('ESRCH');
            err.code = 'ESRCH';
            throw err;
          }
          signals.push({ pid, sig });
        },
        spawnImpl: (bin, args, opts) => {
          spawned.push({ bin, args, env: opts.env });
          return { pid: 55555, unref() {} };
        },
        env: {
          PATH: '/usr/bin',
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '--inspect',
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.swapped, true);
    assert.equal(res.cleanBasePromoted, true);
    assert.equal(res.relaunched, true);
    assert.ok(signals.some((s) => s.pid === 43210 && s.sig === 'SIGTERM'));

    // Target bundle is now the new 2.35.1 version
    assert.equal(fs.readFileSync(path.join(targetAppPath, 'Contents', 'Resources', 'app.asar'), 'utf8'), 'asar-new-2351');
    // Stale SingletonLock cleaned
    assert.throws(() => fs.lstatSync(path.join(userDataDir, 'SingletonLock')), /ENOENT/);
    // Zero .prev backups left beside targetAppPath
    assert.deepEqual(fs.readdirSync(appsDir), ['哈基米.app']);
    // Staging root dir cleaned immediately
    assert.equal(fs.existsSync(stagingRootDir), false);
    // Strict single-slot clean-base cache: ONLY 2.35.1 zip remains, old 2.34.0 zip removed
    const cleanZips = fs.readdirSync(cleanBaseDir).filter((f) => f.endsWith('.zip'));
    assert.deepEqual(cleanZips, ['Antigravity-2.35.1.zip']);
    // Duplicate native cache zips cleaned
    assert.equal(fs.existsSync(path.join(nativeCacheDir, 'pending', 'Antigravity.zip')), false);
    assert.equal(fs.existsSync(path.join(nativeCacheDir, 'update.zip')), false);
    // Relaunched with sanitized env via open -n
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, '/usr/bin/open');
    assert.deepEqual(spawned[0].args, ['-n', targetAppPath]);
    assert.equal(spawned[0].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(spawned[0].env.NODE_OPTIONS, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('swapStagedBundleAtomically automatically rolls back .prev when incoming rename fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-swap-rollback-'));
  try {
    const targetAppPath = path.join(tmp, '哈基米.app');
    const stagedAppPath = path.join(tmp, 'staging', '哈基米.app');
    makeFakeBundle(targetAppPath, { version: '2.34.0', marker: 'original-intact' });
    makeFakeBundle(stagedAppPath, { version: '2.35.1', marker: 'new-failed' });

    let renameCall = 0;
    assert.throws(
      () =>
        upgradeHelper.swapStagedBundleAtomically(
          { targetAppPath, stagedAppPath },
          {
            skipMacRegistration: true,
            renameSync: (from, to) => {
              renameCall++;
              if (renameCall === 2) {
                const err = new Error('Simulated EACCES during incoming rename');
                err.code = 'EACCES';
                throw err;
              }
              fs.renameSync(from, to);
            },
          }
        ),
      /已自动回滚旧版/
    );

    // Original bundle must be completely restored
    assert.equal(
      fs.readFileSync(path.join(targetAppPath, 'Contents', 'Resources', 'app.asar'), 'utf8'),
      'asar-original-intact'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('official manifest YAML parsing, URL allowlist, SHA-512 verification, and GitHub main compare dev-protection work accurately', async () => {
  const sampleAppUpdate = [
    'provider: generic',
    'url: https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/',
    'updaterCacheDirName: com.google.antigravity',
  ].join('\n');
  const appUpd = builder.parseAppUpdateYml(sampleAppUpdate);
  assert.equal(appUpd.url, 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/');

  const sampleLatestYml = [
    'version: 2.35.1',
    'files:',
    '  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/2.35.1/darwin-x64/Antigravity.zip',
    '    sha512: x64sha==',
    '    size: 200000000',
    '  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/2.35.1/darwin-arm/Antigravity.zip',
    '    sha512: arm64sha==',
    '    size: 216134092',
    'releaseDate: "2026-11-25T05:00:00.000Z"',
  ].join('\n');
  const parsed = builder.parseLatestMacYml(sampleLatestYml);
  assert.equal(parsed.version, '2.35.1');
  const selected = builder.selectMacZipFromManifest(parsed, appUpd.url, 'arm64');
  assert.equal(selected.sha512, 'arm64sha==');
  assert.ok(selected.url.includes('darwin-arm/Antigravity.zip'));

  // Intel (x64) selection must resolve the darwin-x64 zip instead of falling back to arm64.
  const selectedX64 = builder.selectMacZipFromManifest(parsed, appUpd.url, 'x64');
  assert.equal(selectedX64.sha512, 'x64sha==');
  assert.ok(selectedX64.url.includes('darwin-x64/Antigravity.zip'));
  // Aliases used by different call sites must normalize to the same feed token.
  assert.equal(builder.normalizeMacArch('x86_64'), 'x64');
  assert.equal(builder.normalizeMacArch('amd64'), 'x64');
  assert.equal(builder.normalizeMacArch('aarch64'), 'arm64');
  assert.equal(builder.normalizeMacArch(undefined), HOST_ARCH);

  assert.equal(builder.compareSemver('2.35.1', '2.34.0'), 1);
  assert.equal(builder.compareSemver('2.34.0', '2.34.0'), 0);
  assert.equal(builder.compareSemver('2.9.0', '2.10.0'), -1);

  // checkAppVersionSync covers official > hakimi, official === hakimi, and hakimi > official
  const { checkAppVersionSync } = require(path.join(ROOT, 'payload', 'dist', 'modules-config.js'));
  const vsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-vs-ahead-'));
  try {
    const makePlist = (ver) =>
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${ver}</string></dict></plist>`;
    const offApp = path.join(vsTmp, 'Official.app');
    const hakApp = path.join(vsTmp, 'Hakimi.app');
    const offPlist = path.join(offApp, 'Contents', 'Info.plist');
    const hakPlist = path.join(hakApp, 'Contents', 'Info.plist');
    fs.mkdirSync(path.dirname(offPlist), { recursive: true });
    fs.mkdirSync(path.dirname(hakPlist), { recursive: true });

    // Case 1: official > hakimi (including multi-digit semver 2.10.0 > 2.9.0)
    fs.writeFileSync(offPlist, makePlist('2.10.0'));
    fs.writeFileSync(hakPlist, makePlist('2.9.0'));
    const behindSync = checkAppVersionSync({ officialPlist: offPlist, hakimiPlist: hakPlist });
    assert.equal(behindSync.outdated, true);
    assert.equal(behindSync.hakimiAhead, false);
    const docBehind = runDoctor({
      appPath: hakApp,
      officialApp: offApp,
      skipCodesign: true,
      skipProcess: true,
      homeDir: vsTmp,
      stateDir: vsTmp,
    });
    assert.equal(docBehind.checks.find((c) => c.id === 'hakimi_version_sync')?.level, 'WARN');

    // Case 2: official === hakimi
    fs.writeFileSync(offPlist, makePlist('2.34.0'));
    fs.writeFileSync(hakPlist, makePlist('2.34.0'));
    const equalSync = checkAppVersionSync({ officialPlist: offPlist, hakimiPlist: hakPlist });
    assert.equal(equalSync.outdated, false);
    assert.equal(equalSync.hakimiAhead, false);
    const docEqual = runDoctor({
      appPath: hakApp,
      officialApp: offApp,
      skipCodesign: true,
      skipProcess: true,
      homeDir: vsTmp,
      stateDir: vsTmp,
    });
    assert.equal(docEqual.checks.find((c) => c.id === 'hakimi_version_sync')?.level, 'OK');

    // Case 3: hakimi > official (e.g. Hakimi v2.35.1 via official feed while read-only official app stays v2.34.0)
    fs.writeFileSync(offPlist, makePlist('2.34.0'));
    fs.writeFileSync(hakPlist, makePlist('2.35.1'));
    const aheadSync = checkAppVersionSync({ officialPlist: offPlist, hakimiPlist: hakPlist });
    assert.equal(aheadSync.outdated, false);
    assert.equal(aheadSync.hakimiAhead, true);
    const docAhead = runDoctor({
      appPath: hakApp,
      officialApp: offApp,
      skipCodesign: true,
      skipProcess: true,
      homeDir: vsTmp,
      stateDir: vsTmp,
    });
    const aheadCheck = docAhead.checks.find((c) => c.id === 'hakimi_version_sync');
    assert.equal(aheadCheck?.level, 'OK');
    assert.equal(aheadCheck?.detail.includes('build-hakimi.sh'), false);
  } finally {
    fs.rmSync(vsTmp, { recursive: true, force: true });
  }
  assert.equal(builder.isAllowedOfficialUrl('https://evil.example.com/Antigravity.zip'), false);
  assert.equal(builder.isAllowedOfficialUrl('http://storage.googleapis.com/a.zip'), false);

  // Verify SHA-512 mismatch discards downloaded zip
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-sha512-test-'));
  try {
    const destZip = path.join(tmp, 'bad.zip');
    await assert.rejects(
      () =>
        builder.acquireOfficialVerifiedZip(
          {
            version: '2.35.1',
            url: 'https://storage.googleapis.com/antigravity-public/Antigravity.zip',
            sha512: 'definitely-wrong-sha512',
          },
          destZip,
          {
            stateDir: path.join(tmp, 'state'),
            nativeCacheDir: path.join(tmp, 'native'),
            httpRequest: async (_u, opts) => {
              fs.writeFileSync(opts.destFilePath, 'corrupted-payload');
              return { status: 200, filePath: opts.destFilePath, sha512: 'actual-different-sha' };
            },
          }
        ),
      /SHA-512 校验不匹配/
    );
    assert.equal(fs.existsSync(destZip), false, 'Corrupted zip must be removed immediately');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Official minimal manifest (`version: 2.35.1` without `files:`) returned when x-app-version is already up-to-date
  const minUpToDate = await builder.fetchOfficialLatestManifest({
    arch: 'arm64',
    currentVersion: '2.35.1',
    httpRequest: async (_url, opts = {}) => {
      assert.equal(opts.headers?.['x-app-version'], '2.35.1');
      return { status: 200, text: 'version: 2.35.1\n' };
    },
  });
  assert.equal(minUpToDate.version, '2.35.1');
  assert.equal(minUpToDate.upToDate, true);
  assert.equal(minUpToDate.url, '');
  assert.equal(minUpToDate.sha512, '');

  // Official minimal manifest reporting a NEWER version while x-app-version was sent: retries once without x-app-version
  let manifestAttempts = 0;
  const retriedNewer = await builder.fetchOfficialLatestManifest({
    arch: 'arm64',
    currentVersion: '2.34.0',
    httpRequest: async (_url, opts = {}) => {
      manifestAttempts++;
      if (opts.headers?.['x-app-version']) {
        return { status: 200, text: 'version: 2.35.1\n' };
      }
      return { status: 200, text: sampleLatestYml };
    },
  });
  assert.equal(manifestAttempts, 2);
  assert.equal(retriedNewer.version, '2.35.1');
  assert.equal(retriedNewer.upToDate, false);
  assert.equal(retriedNewer.sha512, 'arm64sha==');

  // Official manifest genuinely lacking a ZIP when no x-app-version is sent still throws
  await assert.rejects(
    () =>
      builder.fetchOfficialLatestManifest({
        httpRequest: async () => ({ status: 200, text: 'version: 2.35.1\n' }),
      }),
    /官方更新清单中未找到 macOS ZIP 安装包/
  );

  // Helper to build GitHub commits/main.atom feed XML
  const makeAtomXml = (commits) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    commits
      .map(
        (c) =>
          `  <entry>\n` +
          `    <id>tag:github.com,2008:Grit::Commit/${c.sha}</id>\n` +
          `    <link type="text/html" rel="alternate" href="https://github.com/cli117/antigravity-hakimi/commit/${c.sha}"/>\n` +
          `    <title>${c.title || 'commit'}</title>\n` +
          `    <updated>${c.date || '2026-11-25T10:00:00Z'}</updated>\n` +
          `  </entry>`
      )
      .join('\n') +
    `\n</feed>`;

  const mainSha = '1'.repeat(40);
  const prevSha1 = 'a'.repeat(40);
  const prevSha2 = 'b'.repeat(40);
  const localSha = '2'.repeat(40);
  const oldSha = '3'.repeat(40);
  const aheadLocalSha = '4'.repeat(40);
  const divergedSha = '5'.repeat(40);

  // GitHub web Atom check: identical commit (0 api.github.com calls, 1 total request)
  let identicalCalls = 0;
  const identicalRes = await builder.checkHakimiMainUpdate({
    installedCommit: mainSha,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      identicalCalls++;
      assert.ok(url.endsWith('/commits/main.atom'));
      return { status: 200, text: makeAtomXml([{ sha: mainSha, title: 'feat: latest &amp; clean' }]) };
    },
  });
  assert.equal(identicalCalls, 1);
  assert.equal(identicalRes.status, 'identical');
  assert.equal(identicalRes.updateAvailable, false);
  assert.equal(identicalRes.commitMessage, 'feat: latest & clean');

  // GitHub web Atom fast path: installedCommit present in Atom feed -> ahead without compare request
  let fastPathCalls = 0;
  const atomAheadRes = await builder.checkHakimiMainUpdate({
    installedCommit: prevSha2,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      fastPathCalls++;
      return {
        status: 200,
        text: makeAtomXml([
          { sha: mainSha, title: 'feat: newest' },
          { sha: prevSha1, title: 'feat: mid' },
          { sha: prevSha2, title: 'feat: old' },
        ]),
      };
    },
  });
  assert.equal(fastPathCalls, 1);
  assert.equal(atomAheadRes.status, 'ahead');
  assert.equal(atomAheadRes.updateAvailable, true);
  assert.equal(atomAheadRes.aheadBy, 2);

  // GitHub web compare (.patch): 404 (local unpushed commit) must NOT trigger downgrade
  const unpushedRes = await builder.checkHakimiMainUpdate({
    installedCommit: localSha,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith('/commits/main.atom')) {
        return { status: 200, text: makeAtomXml([{ sha: mainSha, title: 'main head' }]) };
      }
      if (url.endsWith(`/compare/${localSha}...${mainSha}.patch`)) {
        return { status: 404, text: 'Not Found' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(unpushedRes.status, 'local_unpushed');
  assert.equal(unpushedRes.updateAvailable, false);

  // GitHub web compare (.patch): older commit beyond Atom window -> fwd non-empty, rev empty -> ahead
  const aheadRes = await builder.checkHakimiMainUpdate({
    installedCommit: oldSha,
    httpRequest: async (url, opts = {}) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith('/commits/main.atom')) {
        return { status: 200, text: makeAtomXml([{ sha: mainSha, title: 'feat: new' }]) };
      }
      if (url.endsWith(`/compare/${oldSha}...${mainSha}.patch`)) {
        assert.equal(opts.maxBytes, 1024);
        return { status: 200, text: `From ${mainSha} Mon Sep 17 00:00:00 2001\n` };
      }
      if (url.endsWith(`/compare/${mainSha}...${oldSha}.patch`)) {
        assert.equal(opts.maxBytes, 1024);
        return { status: 200, text: '' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(aheadRes.status, 'ahead');
  assert.equal(aheadRes.updateAvailable, true);

  // GitHub web compare (.patch): local ahead of main -> fwd empty, rev non-empty -> local_ahead
  const behindRes = await builder.checkHakimiMainUpdate({
    installedCommit: aheadLocalSha,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith('/commits/main.atom')) {
        return { status: 200, text: makeAtomXml([{ sha: mainSha, title: 'older main' }]) };
      }
      if (url.endsWith(`/compare/${aheadLocalSha}...${mainSha}.patch`)) {
        return { status: 200, text: '' };
      }
      if (url.endsWith(`/compare/${mainSha}...${aheadLocalSha}.patch`)) {
        return { status: 200, text: `From ${aheadLocalSha} Mon Sep 17 00:00:00 2001\n` };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(behindRes.status, 'local_ahead');
  assert.equal(behindRes.updateAvailable, false);

  // GitHub web compare (.patch): diverged -> both fwd and rev non-empty -> diverged
  const divergedRes = await builder.checkHakimiMainUpdate({
    installedCommit: divergedSha,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith('/commits/main.atom')) {
        return { status: 200, text: makeAtomXml([{ sha: mainSha, title: 'main tip' }]) };
      }
      if (url.endsWith('.patch')) {
        return { status: 200, text: 'From deadbeef Mon Sep 17 00:00:00 2001\n' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(divergedRes.status, 'diverged');
  assert.equal(divergedRes.updateAvailable, false);

  // Git Smart HTTP info/refs fallback when commits/main.atom returns 503
  const fallbackRes = await builder.checkHakimiMainUpdate({
    installedCommit: mainSha,
    httpRequest: async (url) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith('/commits/main.atom')) {
        return { status: 503, text: 'Service Unavailable' };
      }
      if (url.endsWith('.git/info/refs?service=git-upload-pack')) {
        return {
          status: 200,
          text: `001e# service=git-upload-pack\n00000159${mainSha} HEAD\0multi_ack\n003f${mainSha} refs/heads/main\n0000`,
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(fallbackRes.status, 'identical');
  assert.equal(fallbackRes.updateAvailable, false);
  assert.equal(fallbackRes.latestSha, mainSha);
});

test('dual-source updater enforces silent-until-ready, cleans failed downloads, skips known-incompatible until main advances, and falls back to Hakimi-only', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-updater-fsm-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const nativeCacheDir = path.join(tmp, 'nativeCache');
    const targetAppPath = path.join(tmp, 'Apps', '哈基米.app');
    const officialLocalApp = path.join(tmp, 'OfficialLocal', 'Antigravity.app');
    const installedSha = 'a'.repeat(40);
    const newerSha1 = 'b'.repeat(40);
    const newerSha2 = 'c'.repeat(40);

    makeFakeBundle(targetAppPath, { version: '2.34.0', marker: 'installed', commit: installedSha });
    makeFakeBundle(officialLocalApp, { version: '2.34.0', marker: 'official-234' });

    // Create a valid fake official 2.35.1 zip using macOS ditto so extractOfficialZipAndVerify works cleanly
    const zipSrcDir = path.join(tmp, 'zip-src');
    makeFakeBundle(path.join(zipSrcDir, 'Antigravity.app'), { version: '2.35.1', marker: 'official-2351' });
    const fakeZip2351 = path.join(tmp, 'Antigravity-2.35.1.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(zipSrcDir, 'Antigravity.app'), fakeZip2351]);
    const zip2351Sha = await builder.computeFileSha512Base64(fakeZip2351);

    // Create a valid fake Hakimi tarball for newerSha2
    const fakeTarSrc = path.join(tmp, 'tar-src', `antigravity-hakimi-${newerSha2}`);
    fs.mkdirSync(path.join(fakeTarSrc, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fakeTarSrc, 'payload', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(fakeTarSrc, 'scripts', 'pack-hakimi-asar.js'), '// stub\n', 'utf8');
    fs.writeFileSync(path.join(fakeTarSrc, 'payload', 'dist', 'meter-region-unlock.js'), '// stub\n', 'utf8');
    const fakeHakimiTar = path.join(tmp, 'hakimi.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', fakeHakimiTar, '-C', path.join(tmp, 'tar-src'), `antigravity-hakimi-${newerSha2}`]);

    let remoteMainSha = installedSha;
    let stageBuildCalls = 0;
    let shouldFail2351 = true;

    const httpRequest = async (url, opts = {}) => {
      assert.equal(url.includes('api.github.com'), false, `Updater must never hit api.github.com: ${url}`);
      if (url.endsWith(HOST_MANIFEST)) {
        return {
          status: 200,
          text: [
            'version: 2.35.1',
            'files:',
            `  - url: https://storage.googleapis.com/antigravity-public/2.35.1/${HOST_ZIP_DIR}/Antigravity.zip`,
            `    sha512: ${zip2351Sha}`,
          ].join('\n'),
        };
      }
      if (url.includes('Antigravity.zip') && opts.destFilePath) {
        fs.copyFileSync(fakeZip2351, opts.destFilePath);
        return { status: 200, filePath: opts.destFilePath, sha512: zip2351Sha };
      }
      if (url.endsWith('/commits/main.atom')) {
        const entries =
          remoteMainSha === installedSha
            ? [installedSha]
            : [remoteMainSha, installedSha];
        return {
          status: 200,
          text:
            '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
            entries
              .map(
                (sha) =>
                  `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><title>commit msg</title><updated>2026-11-25T12:00:00Z</updated></entry>`
              )
              .join('') +
            '</feed>',
        };
      }
      if (url.includes('/compare/') && url.endsWith('.patch')) {
        const isForward = url.includes(`/${installedSha}...${remoteMainSha}.patch`);
        return { status: 200, text: isForward ? `From ${remoteMainSha} Mon Sep 17 00:00:00 2001\n` : '' };
      }
      if (url.includes('/tar.gz/') && opts.destFilePath) {
        fs.copyFileSync(fakeHakimiTar, opts.destFilePath);
        return { status: 200, filePath: opts.destFilePath };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const updater = updaterMod.createHakimiUpdater({
      platform: 'darwin',
      stateDir,
      homeDir: tmp,
      nativeCacheDir,
      targetAppPath,
      officialAppPath: officialLocalApp,
      skipGoogleSignatureCheck: true,
      skipOfficialRunningCheck: true,
      httpRequest,
      stageBuildImpl: async (spec) => {
        stageBuildCalls++;
        if (spec.antigravityVersion === '2.35.1' && shouldFail2351) {
          return { ok: false, failedStage: 'pack-asar', error: 'Expected unique regex anchor for createWindow' };
        }
        makeFakeBundle(path.join(spec.stageDir, '哈基米.app'), {
          version: spec.antigravityVersion,
          marker: `staged-${spec.antigravityVersion}`,
          commit: spec.hakimiCommit,
        });
        return {
          ok: true,
          stageDir: spec.stageDir,
          stagedAppPath: path.join(spec.stageDir, '哈基米.app'),
          antigravityVersion: spec.antigravityVersion,
          hakimiVersion: '0.8.4',
          hakimiCommit: spec.hakimiCommit,
          asarSha256: 'f'.repeat(64),
          usingCustomIcon: false,
        };
      },
    });

    const nativeBridge = updater.createNativeUpdaterBridge();
    assert.deepEqual(nativeBridge.getLastState(), { type: 'idle' });

    // 1. First check: 2.35.1 fails stage-build -> incompatible, NOT ready, zero tmp/staging residue!
    const snap1 = await updater.checkAndStageUpgrade({ manual: false });
    assert.equal(snap1.status, 'incompatible');
    assert.equal(snap1.ready, false);
    assert.equal(snap1.staged, null);
    assert.equal(snap1.incompatible.antigravityVersion, '2.35.1');
    assert.equal(snap1.incompatible.failedStage, 'pack-asar');
    assert.equal(stageBuildCalls, 1);
    const paths = builder.getUpdaterPaths({ stateDir, homeDir: tmp });
    assert.deepEqual(fs.existsSync(paths.tmpDir) ? fs.readdirSync(paths.tmpDir) : [], []);
    assert.deepEqual(fs.existsSync(paths.stagingDir) ? fs.readdirSync(paths.stagingDir) : [], []);
    assert.deepEqual(nativeBridge.getLastState(), { type: 'idle' });
    assert.equal(nativeBridge.getHostUpdateStatus().updateAvailable, false);

    // 2. Second silent auto-check with SAME commit: skips re-testing known-incompatible 2.35.1
    const snap2 = await updater.checkAndStageUpgrade({ manual: false });
    assert.equal(snap2.status, 'incompatible');
    assert.equal(stageBuildCalls, 1, 'Must skip retrying known-incompatible version until Hakimi main advances');

    // 3. Hakimi main advances to newerSha2 (still incompatible with 2.35.1) -> retries 2.35.1, then falls back to Hakimi-only on 2.34.0!
    remoteMainSha = newerSha2;
    const snap3 = await updater.checkAndStageUpgrade({ manual: false });
    assert.equal(stageBuildCalls, 3, 'Should retry 2.35.1 with newerSha2 then fall back to Hakimi-only 2.34.0');
    assert.equal(snap3.status, 'ready');
    assert.equal(snap3.staged.targetAntigravityVersion, '2.34.0');
    assert.equal(snap3.staged.targetHakimiCommit, newerSha2);
    assert.equal(snap3.staged.hakimiChanged, true);
    assert.equal(snap3.staged.antigravityChanged, false);
    assert.equal(snap3.incompatible.antigravityVersion, '2.35.1');
    // Ephemeral Hakimi tarball & tmp dir must be 0 bytes immediately after build
    assert.deepEqual(fs.readdirSync(paths.tmpDir), []);

    // 4. Now simulate newerSha1 fixing 2.35.1 compatibility -> stages 2.35.1 cleanly and clears incompatible!
    shouldFail2351 = false;
    remoteMainSha = newerSha1;
    const snap4 = await updater.checkAndStageUpgrade({ manual: true });
    assert.equal(snap4.status, 'ready');
    assert.equal(snap4.staged.targetAntigravityVersion, '2.35.1');
    assert.equal(snap4.staged.antigravityChanged, true);
    assert.equal(snap4.incompatible, null);
    assert.equal(nativeBridge.getHostUpdateStatus().updateAvailable, true);
    assert.deepEqual(nativeBridge.getLastState(), { type: 'idle' }, 'Native AppUpdateButton state stays idle');
    // Only 1 staging directory should remain (old superseded staging dir cleaned)
    assert.equal(fs.readdirSync(paths.stagingDir).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updater handles minimal up-to-date official manifest cleanly and refetches full manifest without x-app-version when Hakimi-only update needs clean zip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-minimal-manifest-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const nativeCacheDir = path.join(tmp, 'nativeCache');
    const targetAppPath = path.join(tmp, 'Apps', '哈基米.app');
    const installedSha = 'a'.repeat(40);
    const newerSha = 'b'.repeat(40);

    makeFakeBundle(targetAppPath, { version: '2.35.1', marker: 'installed-2351', commit: installedSha });

    // Create a valid official 2.35.1 zip
    const zipSrcDir = path.join(tmp, 'zip-src');
    makeFakeBundle(path.join(zipSrcDir, 'Antigravity.app'), { version: '2.35.1', marker: 'official-2351' });
    const fakeZip2351 = path.join(tmp, 'Antigravity-2.35.1.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(zipSrcDir, 'Antigravity.app'), fakeZip2351]);
    const zip2351Sha = await builder.computeFileSha512Base64(fakeZip2351);

    // Create a valid Hakimi tarball for newerSha
    const fakeTarSrc = path.join(tmp, 'tar-src', `antigravity-hakimi-${newerSha}`);
    fs.mkdirSync(path.join(fakeTarSrc, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fakeTarSrc, 'payload', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(fakeTarSrc, 'scripts', 'pack-hakimi-asar.js'), '// stub\n', 'utf8');
    fs.writeFileSync(path.join(fakeTarSrc, 'payload', 'dist', 'meter-region-unlock.js'), '// stub\n', 'utf8');
    const fakeHakimiTar = path.join(tmp, 'hakimi.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', fakeHakimiTar, '-C', path.join(tmp, 'tar-src'), `antigravity-hakimi-${newerSha}`]);

    let remoteMainSha = installedSha;
    let sawFullManifestRefetch = false;

    const httpRequest = async (url, opts = {}) => {
      assert.equal(url.includes('api.github.com'), false, `Must never hit api.github.com: ${url}`);
      if (url.endsWith(HOST_MANIFEST)) {
        if (opts.headers?.['x-app-version'] === '2.35.1') {
          // Real Google Cloud Run behavior when client is already on latest 2.35.1
          return { status: 200, text: 'version: 2.35.1\n' };
        }
        sawFullManifestRefetch = true;
        return {
          status: 200,
          text: [
            'version: 2.35.1',
            'files:',
            `  - url: https://storage.googleapis.com/antigravity-public/2.35.1/${HOST_ZIP_DIR}/Antigravity.zip`,
            `    sha512: ${zip2351Sha}`,
          ].join('\n'),
        };
      }
      if (url.includes('Antigravity.zip') && opts.destFilePath) {
        fs.copyFileSync(fakeZip2351, opts.destFilePath);
        return { status: 200, filePath: opts.destFilePath, sha512: zip2351Sha };
      }
      if (url.endsWith('/commits/main.atom')) {
        const entries = remoteMainSha === installedSha ? [installedSha] : [remoteMainSha, installedSha];
        return {
          status: 200,
          text:
            '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
            entries
              .map(
                (sha) =>
                  `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><title>msg</title><updated>2026-11-25T14:00:00Z</updated></entry>`
              )
              .join('') +
            '</feed>',
        };
      }
      if (url.includes('/tar.gz/') && opts.destFilePath) {
        fs.copyFileSync(fakeHakimiTar, opts.destFilePath);
        return { status: 200, filePath: opts.destFilePath };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const updater = updaterMod.createHakimiUpdater({
      platform: 'darwin',
      stateDir,
      homeDir: tmp,
      nativeCacheDir,
      targetAppPath,
      officialAppPath: path.join(tmp, 'MissingOfficial.app'),
      skipGoogleSignatureCheck: true,
      skipOfficialRunningCheck: true,
      httpRequest,
      stageBuildImpl: async (spec) => {
        makeFakeBundle(path.join(spec.stageDir, '哈基米.app'), {
          version: spec.antigravityVersion,
          marker: 'staged-hakimi-only',
          commit: spec.hakimiCommit,
        });
        return {
          ok: true,
          stageDir: spec.stageDir,
          stagedAppPath: path.join(spec.stageDir, '哈基米.app'),
          antigravityVersion: spec.antigravityVersion,
          hakimiVersion: '1.0.1',
          hakimiCommit: spec.hakimiCommit,
          asarSha256: 'e'.repeat(64),
          usingCustomIcon: false,
        };
      },
    });

    // 1. Both official (minimal manifest) and Hakimi are up-to-date -> idle, zero errors!
    const snapIdle = await updater.checkAndStageUpgrade({ manual: true });
    assert.equal(snapIdle.status, 'idle');
    assert.equal(snapIdle.lastError, null);
    assert.equal(snapIdle.latestOfficial?.version, '2.35.1');
    assert.equal(sawFullManifestRefetch, false);

    // 2. Hakimi main advances while official stays on 2.35.1 (minimal manifest) and no local/cache base exists ->
    //    must automatically refetch full official manifest without x-app-version and stage cleanly!
    remoteMainSha = newerSha;
    const snapReady = await updater.checkAndStageUpgrade({ manual: true });
    assert.equal(sawFullManifestRefetch, true, 'Must refetch full official manifest without x-app-version');
    assert.equal(snapReady.status, 'ready');
    assert.equal(snapReady.lastError, null);
    assert.equal(snapReady.staged.targetAntigravityVersion, '2.35.1');
    assert.equal(snapReady.staged.targetHakimiCommit, newerSha);
    assert.equal(snapReady.staged.hakimiChanged, true);
    assert.equal(snapReady.staged.antigravityChanged, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cleanupOrphanUpdaterArtifacts sweeps tmp, orphan .prev, stale staging, old clean-base zips, and duplicate native cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-orphan-gc-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const nativeCacheDir = path.join(tmp, 'nativeCache');
    const appsDir = path.join(tmp, 'Apps');
    const targetAppPath = path.join(appsDir, '哈基米.app');
    makeFakeBundle(targetAppPath, { version: '2.35.1', marker: 'installed', commit: 'd'.repeat(40) });

    const paths = builder.getUpdaterPaths({ stateDir, homeDir: tmp, nativeCacheDir });
    fs.mkdirSync(path.join(paths.tmpDir, 'orphan-tarball'), { recursive: true });
    fs.mkdirSync(path.join(paths.stagingDir, 'orphan-stage'), { recursive: true });
    fs.mkdirSync(path.join(appsDir, '.哈基米.app.prev.12345'), { recursive: true });
    fs.mkdirSync(paths.cleanBaseDir, { recursive: true });
    fs.writeFileSync(path.join(paths.cleanBaseDir, 'Antigravity-2.34.0.zip'), 'stale-old-zip', 'utf8');
    fs.writeFileSync(path.join(paths.cleanBaseDir, 'Antigravity-2.35.1.zip'), 'current-slot-zip', 'utf8');
    upgradeHelper.writeJsonFileAtomic(path.join(paths.cleanBaseDir, builder.CLEAN_BASE_META_FILENAME), {
      version: '2.35.1',
      fileName: 'Antigravity-2.35.1.zip',
      sha512: 'same-sha',
    });

    fs.mkdirSync(path.join(nativeCacheDir, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(nativeCacheDir, 'update.zip'), 'dup-update-zip', 'utf8');
    fs.writeFileSync(path.join(nativeCacheDir, 'pending', 'Antigravity.zip'), 'dup-pending-zip', 'utf8');
    fs.writeFileSync(
      path.join(nativeCacheDir, 'pending', 'update-info.json'),
      JSON.stringify({ fileName: 'Antigravity.zip', sha512: 'same-sha' })
    );

    const gc = builder.cleanupOrphanUpdaterArtifacts({
      stateDir,
      homeDir: tmp,
      nativeCacheDir,
      targetAppPath,
      skipOfficialRunningCheck: true,
    });

    assert.deepEqual(gc.cleanedTmp, ['orphan-tarball']);
    assert.deepEqual(gc.cleanedStaging, ['orphan-stage']);
    assert.deepEqual(gc.cleanedPrev, ['.哈基米.app.prev.12345']);
    assert.deepEqual(gc.cleanedCleanBase, ['Antigravity-2.34.0.zip']);
    assert.ok(gc.cleanedNativeCache.includes('update.zip'));
    assert.ok(gc.cleanedNativeCache.includes('pending/Antigravity.zip'));

    // Single-slot zip for installed version 2.35.1 is preserved!
    assert.deepEqual(
      fs.readdirSync(paths.cleanBaseDir).filter((f) => f.endsWith('.zip')),
      ['Antigravity-2.35.1.zip']
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('packHakimiAsar wraps dist/updater.js at module boundary, preserves updater.orig.js, and passes doctor check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-updater-asar-'));
  try {
    const srcTree = path.join(tmp, 'src-tree');
    fs.mkdirSync(path.join(srcTree, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcTree, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.35.1' }));
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
    fs.writeFileSync(path.join(srcTree, 'dist', 'preload.js'), 'const electron_1 = { contextBridge: { exposeInMainWorld(){} }, ipcRenderer: { invoke(){}, on(){}, removeListener(){} } };\n', 'utf8');
    fs.writeFileSync(path.join(srcTree, 'dist', 'updater.js'), '"use strict";\nexports.initAutoUpdater = () => {};\n', 'utf8');

    const srcAsar = path.join(tmp, 'src.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcTree, srcAsar, {});

    const fakeApp = path.join(tmp, 'FakeHakimi.app');
    const destAsar = path.join(fakeApp, 'Contents', 'Resources', 'app.asar');
    const packRes = packHakimiAsar({ srcAsar, destAsar, skipConfig: true });
    assert.equal(packRes.ok, true);
    assert.equal(packRes.inspect.updaterSupported, true);
    assert.equal(packRes.inspect.updaterReady, true);

    const wrappedUpdater = asarEngine.builtinAsar.extractFile(destAsar, 'dist/updater.js').toString('utf8');
    assert.ok(wrappedUpdater.includes("require('./hakimi-updater').createNativeUpdaterBridge()"));
    const origUpdater = asarEngine.builtinAsar.extractFile(destAsar, 'dist/updater.orig.js').toString('utf8');
    assert.ok(origUpdater.includes('exports.initAutoUpdater'));

    for (const file of ['hakimi-asar-packer.js', 'hakimi-builder.js', 'hakimi-upgrade-helper.js', 'hakimi-updater.js']) {
      assert.ok(PAYLOAD_FILES.includes(file), `PAYLOAD_FILES must include ${file}`);
    }

    fs.writeFileSync(
      path.join(fakeApp, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.35.1</string><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${packRes.sha256}</string></dict></dict></dict></plist>`,
      'utf8'
    );
    const report = runDoctor({
      appPath: fakeApp,
      officialApp: path.join(tmp, 'MissingOfficial.app'),
      skipCodesign: true,
      skipProcess: true,
      homeDir: tmp,
      stateDir: tmp,
    });
    const updCheck = report.checks.find((c) => c.id === 'hakimi_updater');
    assert.ok(updCheck, 'doctor must report hakimi_updater when dist/updater.js exists');
    assert.equal(updCheck.level, 'OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build-hakimi.sh defaults to one-shot latest/overwrite/launch/cli-unlock with opt-out flags, conflict guards, and promote-clean-base CLI', () => {
  const buildSh = fs.readFileSync(path.join(ROOT, 'build-hakimi.sh'), 'utf8');
  execFileSync('bash', ['-n', path.join(ROOT, 'build-hakimi.sh')]);
  assert.ok(buildSh.includes('SOURCE_MODE="auto"'));
  assert.ok(buildSh.includes('FORCE=1'));
  assert.ok(buildSh.includes('AUTO_RESTART=1'));
  assert.ok(buildSh.includes('PATCH_CLI=1'));
  for (const flag of ['--fetch-latest', '--local', '--no-restart', '--no-open', '--no-cli', '--no-overwrite']) {
    assert.ok(buildSh.includes(flag), `build-hakimi.sh missing ${flag}`);
  }
  assert.ok(buildSh.includes('hakimi-builder.js'));
  assert.ok(buildSh.includes('write-meta'));
  assert.ok(buildSh.includes('promote-clean-base'));

  // Verify conflicting source flags exit cleanly with code 2
  const conflict1 = spawnSync('bash', [path.join(ROOT, 'build-hakimi.sh'), '--local', '--fetch-latest'], {
    encoding: 'utf8',
  });
  assert.equal(conflict1.status, 2);
  const conflict2 = spawnSync('bash', [path.join(ROOT, 'build-hakimi.sh'), '--local', '--from', '/tmp/a.app'], {
    encoding: 'utf8',
  });
  assert.equal(conflict2.status, 2);

  // Verify promote-clean-base CLI maintains single-slot cache in isolated stateDir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-promote-cli-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const cleanBaseDir = path.join(stateDir, 'updater', 'clean-base');
    fs.mkdirSync(cleanBaseDir, { recursive: true });
    fs.writeFileSync(path.join(cleanBaseDir, 'Antigravity-2.34.0.zip'), 'old-zip');
    const incomingZip = path.join(tmp, 'official-verified.zip');
    fs.writeFileSync(incomingZip, 'new-zip-v2.35.1');

    const promoteOut = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'payload', 'dist', 'hakimi-builder.js'),
        'promote-clean-base',
        '--zip',
        incomingZip,
        '--version',
        '2.35.1',
        '--sha512',
        'mock-sha512',
        '--state-dir',
        stateDir,
      ],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(promoteOut.trim());
    assert.equal(parsed.promoted, true);
    assert.equal(fs.existsSync(path.join(cleanBaseDir, 'Antigravity-2.35.1.zip')), true);
    assert.equal(fs.existsSync(path.join(cleanBaseDir, 'Antigravity-2.34.0.zip')), false);
    assert.equal(fs.existsSync(incomingZip), false);
    const meta = builder.readCleanBaseMeta(cleanBaseDir);
    assert.equal(meta?.version, '2.35.1');
    assert.equal(meta?.sha512, 'mock-sha512');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const topbarJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'topbar-layout.js'), 'utf8');
  assert.ok(topbarJs.includes('observedRightGroup'), 'topbar-layout.js must track observedRightGroup');
  assert.ok(topbarJs.includes('resizeObserver.observe(targetContainer)'), 'topbar-layout.js must observe rightGroup in ResizeObserver');

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const rendered = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  for (const id of ['btn-topbar-upgrade', 'hakimi-upgrade-card', 'hakimi-upgrade-diag', 'hakimi-upgrade-modal']) {
    assert.ok(tpl.includes(id), `template.html missing ${id}`);
    assert.ok(rendered.includes(id), `meter-renderer.js missing ${id}`);
  }
});

test('real official Antigravity.app passes verifyOfficialGoogleBundleSignature when installed', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/Applications/Antigravity.app')) {
    t.skip('Official Antigravity.app not present');
    return;
  }
  const res = builder.verifyOfficialGoogleBundleSignature('/Applications/Antigravity.app');
  assert.equal(res.ok, true);
  assert.equal(res.teamId, builder.GOOGLE_TEAM_ID);
});

test('renderer shows topbar upgrade button strictly on ready, displays diagnostics on incompatible, hides on Remote SSH, and observes rightGroup ResizeObserver', async () => {
  const coreCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');

  const runRendererScenario = ({ isRemote }) => {
    const observedResizeTargets = [];
    class FakeElement {
      constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.id = '';
        this.className = '';
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.hidden = false;
        this._textContent = '';
        this.shadowRoot = null;
        this.rect = { left: 0, top: 0, width: 900, height: 40, right: 900, bottom: 40 };
        this._listeners = new Map();
        this.style = {
          _props: new Map(),
          setProperty(k, v) { this._props.set(k, String(v)); },
          getPropertyValue(k) { return this._props.get(k) || ''; },
          removeProperty(k) { this._props.delete(k); },
          cssText: '',
        };
        this.classList = {
          contains: (c) => String(this.className || '').split(/\s+/).includes(c),
          add: (c) => {
            const parts = String(this.className || '').split(/\s+/).filter(Boolean);
            if (!parts.includes(c)) parts.push(c);
            this.className = parts.join(' ');
          },
          remove: (c) => {
            this.className = String(this.className || '').split(/\s+/).filter((x) => x && x !== c).join(' ');
          },
          toggle: (c, force) => {
            const has = this.classList.contains(c);
            const next = force !== undefined ? Boolean(force) : !has;
            if (next) this.classList.add(c);
            else this.classList.remove(c);
          },
        };
      }
      get isConnected() { return Boolean(this.parentElement); }
      get firstChild() { return this.children[0] || null; }
      get firstElementChild() { return this.children[0] || null; }
      get lastElementChild() { return this.children[this.children.length - 1] || null; }
      get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._textContent; }
      set textContent(v) { this._textContent = String(v ?? ''); this.children = []; }
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
      attachShadow() { this.shadowRoot = new FakeElement('shadow-root'); return this.shadowRoot; }
      appendChild(c) { if (c.parentElement) c.remove(); c.parentElement = this; this.children.push(c); return c; }
      replaceChildren(...nodes) { this.children = []; for (const n of nodes) if (n) this.appendChild(n); }
      insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parentElement) c.remove();
        const idx = this.children.indexOf(ref);
        c.parentElement = this;
        if (idx === -1) this.children.push(c);
        else this.children.splice(idx, 0, c);
        return c;
      }
      remove() {
        if (!this.parentElement) return;
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
      contains(target) {
        if (target === this) return true;
        return this.children.some((c) => c.contains(target));
      }
      getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
      hasAttribute(k) { return this.attributes.has(k); }
      setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
      removeAttribute(k) { this.attributes.delete(k); }
      getBoundingClientRect() { return { ...this.rect }; }
      addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
      removeEventListener() {}
      getElementById(id) {
        for (const c of this.children) {
          if (c.id === id) return c;
          const nested = c.getElementById(id);
          if (nested) return nested;
        }
        return null;
      }
      querySelector(sel) {
        if (sel === ':scope > div.shrink-0') return this.children.find((c) => c.classList.contains('shrink-0')) || null;
        if (sel === '[class*="@container/titlebar"]') {
          if (this.className.includes('@container/titlebar')) return this;
          for (const c of this.children) { const r = c.querySelector(sel); if (r) return r; }
        }
        return null;
      }
      querySelectorAll() { return []; }
      closest() { return null; }
    }

    const body = new FakeElement('body');
    const titlebar = new FakeElement('div');
    titlebar.className = 'flex w-full @container/titlebar';
    const titleLeft = new FakeElement('div');
    titleLeft.rect = { left: 16, top: 0, width: 180, height: 40, right: 196, bottom: 40 };
    const rightGroup = new FakeElement('div');
    rightGroup.className = 'flex items-center shrink-0';
    rightGroup.setAttribute('data-testid', 'pane-titlebar-toolbar');
    const nativeBtnWrap = new FakeElement('div');
    nativeBtnWrap.className = 'flex items-center gap-1';
    nativeBtnWrap.rect = { left: 780, top: 0, width: 100, height: 40, right: 880, bottom: 40 };
    rightGroup.appendChild(nativeBtnWrap);
    titlebar.appendChild(titleLeft);
    titlebar.appendChild(rightGroup);
    body.appendChild(titlebar);

    const doc = {
      body,
      documentElement: body,
      head: new FakeElement('head'),
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_ns, tag) => new FakeElement(tag),
      createDocumentFragment: () => new FakeElement('fragment'),
      getElementById: (id) => body.getElementById(id),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };

    const sb = {
      console,
      Math,
      Date,
      JSON,
      Object,
      Array,
      Map,
      Set,
      Promise,
      RegExp,
      Number,
      String,
      Boolean,
      Error,
      URL,
      AbortController: class { abort() {} },
      ResizeObserver: class {
        observe(el) { observedResizeTargets.push(el); }
        disconnect() {}
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/' },
      navigator: { platform: 'MacIntel', clipboard: { writeText() {} } },
      innerWidth: 1280,
      innerHeight: 800,
      document: doc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      getComputedStyle: () => ({ paddingRight: '8px', backgroundColor: 'rgb(24,24,24)' }),
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      requestAnimationFrame: (cb) => { cb(); return 1; },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
      __AGContextMeterRemote: isRemote ? { kind: 'ssh', hostId: 'devbox', label: 'devbox' } : null,
      contextMeterAPI: {
        getModulesStatus: async () => ({
          ok: true,
          data: { modules: { meter: { enabled: true }, chinese: { enabled: true, language: 'zh-CN' } } },
          disk: { found: true, chinese: true, chineseReady: true, meterReady: true },
          versionSync: sb.__mockVersionSync || { officialVersion: '2.34.0', hakimiVersion: '2.35.1', outdated: false, hakimiAhead: true },
        }),
        getHakimiUpgradeStatus: async () => ({ ok: true, supported: true, status: 'idle', ready: false }),
        syncHakimiUpgrade: async () => ({ ok: true, supported: true, status: 'idle', ready: false }),
        installHakimiUpgrade: async () => ({ ok: true, coldInstalling: true }),
        onHakimiUpgradeChanged: () => () => {},
      },
    };
    sb.window = sb;
    sb.globalThis = sb;

    vm.runInNewContext(`${coreCode}\n${rendererCode}`, sb, { filename: 'meter-renderer-upgrade-test.js' });
    const hostEl = doc.getElementById('ag-context-meter');
    assert.ok(hostEl && hostEl.shadowRoot, 'Context Meter host and shadowRoot should mount');
    return { sb, shadow: hostEl.shadowRoot, titlebar, rightGroup, nativeBtnWrap, observedResizeTargets };
  };

  // Local window scenario
  const local = runRendererScenario({ isRemote: false });
  assert.ok(local.observedResizeTargets.includes(local.titlebar), 'ResizeObserver must observe titlebar');
  assert.ok(local.observedResizeTargets.includes(local.rightGroup), 'ResizeObserver must observe rightGroup (pane-titlebar-toolbar)');
  assert.ok(local.observedResizeTargets.includes(local.nativeBtnWrap), 'ResizeObserver must observe rightGroup native button wrapper');

  const topbarBtn = local.shadow.getElementById('btn-topbar-upgrade');
  const cardEl = local.shadow.getElementById('hakimi-upgrade-card');
  const diagEl = local.shadow.getElementById('hakimi-upgrade-diag');
  const installBtn = local.shadow.getElementById('btn-hakimi-upgrade-install');
  const forceMainBtn = local.shadow.getElementById('btn-hakimi-upgrade-force-main');

  // Strict "only prompt on ready": hidden for idle / checking / staging / incompatible / local_dev / error
  for (const status of ['idle', 'checking', 'staging', 'error']) {
    local.sb.__AGContextMeter.setHakimiUpgradeStateForTest({
      ok: true,
      supported: true,
      status,
      ready: false,
      installed: { antigravityVersion: '2.34.0', hakimiCommitShort: 'bb632e6' },
      staged: null,
      incompatible: null,
    });
    assert.equal(topbarBtn.hidden, true, `Topbar upgrade button must stay hidden during status=${status}`);
    assert.equal(installBtn.hidden, true);
  }

  // Incompatible: topbar stays silent, Settings card shows structured failure diagnostics
  local.sb.__AGContextMeter.setHakimiUpgradeStateForTest({
    ok: true,
    supported: true,
    status: 'incompatible',
    ready: false,
    installed: { antigravityVersion: '2.34.0', hakimiCommitShort: 'bb632e6' },
    staged: null,
    incompatible: {
      antigravityVersion: '2.35.1',
      testedHakimiCommit: 'a'.repeat(40),
      testedHakimiCommitShort: 'aaaaaaa',
      failedStage: 'pack-asar',
      error: 'createWindow anchor changed',
    },
  });
  assert.equal(topbarBtn.hidden, true, 'Topbar button must remain hidden when stage-build failed');
  assert.equal(diagEl.hidden, false, 'Settings diagnostics box must show on incompatible');
  assert.ok(local.shadow.getElementById('hakimi-upgrade-diag-body').textContent.includes('pack-asar'));

  // Local dev: topbar stays silent, Settings offers force-sync main button
  local.sb.__AGContextMeter.setHakimiUpgradeStateForTest({
    ok: true,
    supported: true,
    status: 'local_dev',
    ready: false,
    installed: { antigravityVersion: '2.34.0', hakimiCommitShort: '1234567' },
    staged: null,
    incompatible: null,
  });
  assert.equal(topbarBtn.hidden, true);
  assert.equal(forceMainBtn.hidden, false);

  // Ready: topbar button and Settings install button light up
  local.sb.__AGContextMeter.setHakimiUpgradeStateForTest({
    ok: true,
    supported: true,
    status: 'ready',
    ready: true,
    installed: { antigravityVersion: '2.34.0', hakimiCommitShort: 'bb632e6' },
    staged: {
      targetAntigravityVersion: '2.35.1',
      targetHakimiCommitShort: 'deadbee',
      antigravityChanged: true,
      hakimiChanged: true,
    },
    incompatible: null,
  });
  assert.equal(topbarBtn.hidden, false, 'Topbar button must appear once staged build is verified ready');
  assert.equal(installBtn.hidden, false);
  assert.equal(cardEl.hidden, false);

  // Version sync banner: stays hidden when hakimi > official (hakimiAhead: true), shows when official > hakimi (outdated: true)
  const syncBanner = local.shadow.getElementById('version-sync-banner');
  local.sb.__mockVersionSync = { officialVersion: '2.34.0', hakimiVersion: '2.35.1', outdated: false, hakimiAhead: true };
  await local.sb.__AGContextMeter.refreshModulesForTest();
  assert.equal(syncBanner.hidden, true, 'Version sync banner must stay hidden when Hakimi is ahead of local official app');

  local.sb.__mockVersionSync = { officialVersion: '2.35.1', hakimiVersion: '2.34.0', outdated: true, hakimiAhead: false };
  await local.sb.__AGContextMeter.refreshModulesForTest();
  assert.equal(syncBanner.hidden, false, 'Version sync banner must show when local official app is newer than Hakimi');

  local.sb.__AGContextMeter.dispose();

  // Remote SSH window scenario: MUST hide BOTH topbar button and Settings card even if ready
  const remote = runRendererScenario({ isRemote: true });
  remote.sb.__AGContextMeter.setHakimiUpgradeStateForTest({
    ok: true,
    supported: true,
    status: 'ready',
    ready: true,
    installed: { antigravityVersion: '2.34.0', hakimiCommitShort: 'bb632e6' },
    staged: { targetAntigravityVersion: '2.35.1', antigravityChanged: true, hakimiChanged: false },
  });
  assert.equal(remote.shadow.getElementById('btn-topbar-upgrade').hidden, true);
  assert.equal(remote.shadow.getElementById('hakimi-upgrade-card').hidden, true);
  remote.sb.__AGContextMeter.dispose();
});
