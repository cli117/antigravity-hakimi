'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const switcher = require(path.join(ROOT, 'payload', 'dist', 'meter-account-switcher.js'));
const coldHelper = require(path.join(ROOT, 'payload', 'dist', 'meter-account-cold-helper.js'));
const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
const { PAYLOAD_FILES } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar.js'));

function makeMockKeychain(initial = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, v);
  }
  const key = (s, a) => `${s}::${a}`;
  const calls = { has: [], get: [], set: [], delete: [] };
  return {
    store,
    calls,
    has(service, account) {
      calls.has.push([service, account]);
      return store.has(key(service, account));
    },
    get(service, account) {
      calls.get.push([service, account]);
      return store.has(key(service, account)) ? store.get(key(service, account)) : null;
    },
    set(service, account, value) {
      calls.set.push([service, account]);
      store.set(key(service, account), value);
      return true;
    },
    delete(service, account) {
      calls.delete.push([service, account]);
      return store.delete(key(service, account));
    },
  };
}

function encodeGoKeyringSecret(obj) {
  return 'go-keyring-base64:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cold-acc-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('shellEscapeForSecurity quotes safely and blocks control characters', () => {
  assert.equal(switcher.shellEscapeForSecurity('gemini'), 'gemini');
  assert.equal(switcher.shellEscapeForSecurity('user@example.com'), 'user@example.com');
  assert.equal(switcher.shellEscapeForSecurity(''), "''");
  assert.equal(switcher.shellEscapeForSecurity("a'b c"), "'a'\"'\"'b c'");
  assert.throws(() => switcher.shellEscapeForSecurity('bad\nline'), /illegal control characters/i);
  assert.throws(() => switcher.shellEscapeForSecurity('bad\rline'), /illegal control characters/i);
  assert.throws(() => switcher.shellEscapeForSecurity('bad\0nul'), /illegal control characters/i);
});

test('createMacOsKeychainAdapter uses metadata-only has() without -w and stdin security -i for set()', () => {
  const recorded = [];
  const adapter = switcher.createMacOsKeychainAdapter((bin, args, opts) => {
    recorded.push({ bin, args, input: opts?.input || '' });
    if (args[0] === 'find-generic-password' && !args.includes('-w')) {
      return 'keychain metadata without secret';
    }
    if (args[0] === 'find-generic-password' && args.includes('-w')) {
      return 'go-keyring-base64:e30=\n';
    }
    return '';
  });

  assert.equal(adapter.has('antigravity-hakimi-accounts', 'a@test.com'), true);
  assert.equal(recorded[0].bin, '/usr/bin/security');
  assert.deepEqual(recorded[0].args, ['find-generic-password', '-s', 'antigravity-hakimi-accounts', '-a', 'a@test.com']);
  assert.equal(recorded[0].args.includes('-w'), false);

  const secret = 'go-keyring-base64:TOP_SECRET_REFRESH_TOKEN';
  adapter.set('antigravity-hakimi-accounts', 'a@test.com', secret);
  assert.equal(recorded[1].bin, '/usr/bin/security');
  assert.deepEqual(recorded[1].args, ['-i']);
  assert.equal(recorded[1].args.join(' ').includes('TOP_SECRET'), false);
  assert.ok(recorded[1].input.includes('add-generic-password -U'));
  assert.ok(recorded[1].input.includes(secret));
});

test('getAccountsStatus uses metadata-only has() with zero -w reads when currentEmail matches saved profile', () => {
  withTempDir((tmp) => {
    const secretA = encodeGoKeyringSecret({ id_token_email: 'alice@work.com', refresh_token: 'rt-alice-1' });
    const secretB = encodeGoKeyringSecret({ id_token_email: 'bob@home.com', refresh_token: 'rt-bob-1' });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretA,
      'antigravity-hakimi-accounts::alice@work.com': secretA,
      'antigravity-hakimi-accounts::bob@home.com': secretB,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          { id: 'alice@work.com', email: 'alice@work.com', label: 'Work', tierName: 'Pro', tokenFingerprint: switcher.computeTokenFingerprint(secretA) },
          { id: 'bob@home.com', email: 'bob@home.com', label: 'Personal', tierName: 'Ultra', tokenFingerprint: switcher.computeTokenFingerprint(secretB) },
        ],
      },
      { stateDir: tmp }
    );

    const status = switcher.getAccountsStatus({
      platform: 'darwin',
      stateDir: tmp,
      keychain: kc,
      currentEmail: 'alice@work.com',
      currentTierName: 'Pro',
      detectAgyCliImpl: () => [],
    });

    assert.equal(status.ok, true);
    assert.equal(status.hasActiveToken, true);
    assert.equal(status.activeProfileId, 'alice@work.com');
    assert.equal(status.currentUnsaved, false);
    assert.equal(status.agyCliRunning, false);
    assert.equal(status.profiles.length, 2);
    assert.equal(status.profiles[0].vaultPresent, true);
    assert.equal(status.profiles[1].vaultPresent, true);
    // Crucial privacy guarantee: ZERO `-w` plaintext Keychain reads during normal status refresh!
    assert.equal(kc.calls.get.length, 0);
    assert.ok(kc.calls.has.length >= 3);
  });
});

test('extractEmailHintFromSecret reads id_token_email and extractTierHintFromSecret distinguishes Ultra 5x vs 20x', () => {
  const blobPlain = encodeGoKeyringSecret({
    id_token_email: 'Alice.Work@Example.COM',
    tier_display_name: 'Google AI Ultra',
    token: { refresh_token: 'secret-never-returned' },
  });
  assert.equal(switcher.extractEmailHintFromSecret(blobPlain), 'alice.work@example.com');
  assert.equal(switcher.extractTierHintFromSecret(blobPlain), 'Google AI Ultra');

  const blob5x = encodeGoKeyringSecret({
    id_token_email: 'five@example.com',
    user_tier: 'g1-ultra-lite-tier',
    tier_display_name: 'Google AI Ultra',
  });
  assert.equal(switcher.extractTierHintFromSecret(blob5x), 'Google AI Ultra 5x');

  const blob20x = encodeGoKeyringSecret({
    id_token_email: 'twenty@example.com',
    user_tier: 'g1-ultra-tier',
    tier_display_name: 'Google AI Ultra',
  });
  assert.equal(switcher.extractTierHintFromSecret(blob20x), 'Google AI Ultra 20x');

  const blobEnterprise = encodeGoKeyringSecret({
    id_token_email: 'corp@example.com',
    user_tier: 'gcp-ge-ultra-tier',
    tier_display_name: 'Google AI Ultra',
  });
  assert.equal(switcher.extractTierHintFromSecret(blobEnterprise), 'Google AI Ultra');
});

test('parseUserPlanStatus distinguishes Google AI Ultra 5x vs 20x and keeps enterprise Ultra generic', () => {
  const { parseUserPlanStatus } = require(path.join(ROOT, 'payload', 'dist', 'meter-core.js'));

  const res5x = parseUserPlanStatus({
    userStatus: {
      email: 'five@example.com',
      userTier: {
        id: 'g1-ultra-lite-tier',
        name: 'Google AI Ultra',
        description: 'Google AI Ultra',
        upgradeSubscriptionUri: 'https://antigravity.google/g1-upgrade',
        upgradeSubscriptionText: 'You can upgrade to a higher Google AI Ultra plan to receive the highest rate limits.',
      },
    },
  });
  assert.equal(res5x.tierKey, 'ultra');
  assert.equal(res5x.tierName, 'Google AI Ultra 5x');

  const res20x = parseUserPlanStatus({
    userStatus: {
      email: 'twenty@example.com',
      userTier: {
        id: 'g1-ultra-tier',
        name: 'Google AI Ultra',
        description: 'Google AI Ultra',
        upgradeSubscriptionText: 'You are subscribed to the best Google AI plan.',
      },
    },
  });
  assert.equal(res20x.tierKey, 'ultra');
  assert.equal(res20x.tierName, 'Google AI Ultra 20x');

  const resEnterprise = parseUserPlanStatus({
    userStatus: {
      email: 'corp@example.com',
      userTier: {
        id: 'gcp-ge-ultra-tier',
        name: 'Google AI Ultra',
      },
    },
  });
  assert.equal(resEnterprise.tierKey, 'ultra');
  assert.equal(resEnterprise.tierName, 'Google AI Ultra');

  const resFallbackUpgrade = parseUserPlanStatus({
    userStatus: {
      email: 'fallback@example.com',
      userTier: {
        id: 'g1-ultra-custom',
        name: 'Google AI Ultra',
        upgradeSubscriptionUri: 'https://antigravity.google/g1-upgrade',
        upgradeSubscriptionText: 'You can upgrade to a higher Google AI Ultra plan.',
      },
    },
  });
  assert.equal(resFallbackUpgrade.tierName, 'Google AI Ultra 5x');

  const resExplicitParen = parseUserPlanStatus({
    userStatus: {
      email: 'paren@example.com',
      userTier: {
        id: 'unknown-ultra',
        name: 'Google AI Ultra (5x)',
      },
    },
  });
  assert.equal(resExplicitParen.tierName, 'Google AI Ultra 5x');
});

test('getAccountsStatus auto-updates stored generic Ultra tierName to live 5x/20x without reading -w', () => {
  withTempDir((tmp) => {
    const secret5x = encodeGoKeyringSecret({ id_token_email: 'five@example.com', user_tier: 'g1-ultra-lite-tier' });
    const kc = makeMockKeychain({
      'gemini::antigravity': secret5x,
      'antigravity-hakimi-accounts::five@example.com': secret5x,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          { id: 'five@example.com', email: 'five@example.com', tierName: 'Google AI Ultra', tokenFingerprint: switcher.computeTokenFingerprint(secret5x) },
        ],
      },
      { stateDir: tmp }
    );

    const status = switcher.getAccountsStatus({
      platform: 'darwin',
      stateDir: tmp,
      keychain: kc,
      currentEmail: 'five@example.com',
      currentTierName: 'Google AI Ultra 5x',
      detectAgyCliImpl: () => [],
    });
    assert.equal(status.ok, true);
    assert.equal(status.activeTierName, 'Google AI Ultra 5x');
    assert.equal(status.profiles[0].tierName, 'Google AI Ultra 5x');
    assert.equal(kc.calls.get.length, 0);

    const reloaded = switcher.loadProfilesRegistry({ stateDir: tmp });
    assert.equal(reloaded.profiles[0].tierName, 'Google AI Ultra 5x');
  });
});

test('detectRunningAgyCliProcesses matches agy CLI and agy language_server without false positives', () => {
  const fakePs = [
    '  101 /Applications/哈基米.app/Contents/MacOS/Antigravity',
    '  102 /Applications/哈基米.app/Contents/Resources/bin/language_server --standalone --app_data_dir antigravity',
    '  201 /Users/dev/.local/bin/agy chat --prompt hello',
    '  202 /Users/dev/.local/share/antigravity/language_server --app_data_dir antigravity-cli --port 0',
    '  303 /bin/zsh -c echo agy-notes.txt',
    '  404 agy',
  ].join('\n');

  const hits = coldHelper.detectRunningAgyCliProcesses({
    execFileSync: () => fakePs,
    excludePids: [],
  });
  const pids = hits.map((h) => h.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [201, 202, 404]);
});

test('cleanupAccountLocalResidue removes only account-bound residue while preserving installation_id and shared chats', () => {
  withTempDir((tmp) => {
    const homeDir = path.join(tmp, 'home');
    const geminiDir = path.join(homeDir, '.gemini');
    const agDir = path.join(geminiDir, 'antigravity');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');

    fs.mkdirSync(path.join(geminiDir, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(agDir, 'brain'), { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    // Residue files that MUST be removed
    const fallbackTok = path.join(geminiDir, 'jetski-standalone-oauth-token');
    const markerFile = path.join(geminiDir, 'cache', 'antigravity-keyring-unavailable');
    const scopeFile = path.join(userDataDir, 'credential-user-scope');
    fs.writeFileSync(fallbackTok, '{"token":"old"}');
    fs.writeFileSync(markerFile, '1');
    fs.writeFileSync(scopeFile, '0123456789abcdef\n');

    // Files that MUST stay untouched
    const installIdPath = path.join(agDir, 'installation_id');
    const statePbtxtPath = path.join(agDir, 'antigravity_state.pbtxt');
    const convDbPath = path.join(agDir, 'conversation_summaries.db');
    const convPbPath = path.join(agDir, 'conversations', 'shared-1.pb');
    fs.writeFileSync(installIdPath, '11111111-2222-3333-4444-555555555555');
    fs.writeFileSync(statePbtxtPath, 'installation_uuid: "aaaa-bbbb"\n');
    fs.writeFileSync(convDbPath, 'sqlite-placeholder');
    fs.writeFileSync(convPbPath, 'shared-chat-data');

    // app_storage.json: strip ONLY account-bound keys, keep layout/pins/history
    const appStoragePath = path.join(userDataDir, 'app_storage.json');
    fs.writeFileSync(
      appStoragePath,
      JSON.stringify({
        'agy.onboarding.lastLoginUsername': 'alice@work.com',
        'agy.onboarding.lastLoginIsGcpTos': 'false',
        'enable-wcv-three-layer-stack': 'true',
        'enable-remote-control-hub-browser-stream': 'false',
        'enable-agy-hub-cua-macos': 'true',
        pinned_conversations_order: ['c1', 'c2'],
        'jetski.browser.history.persist:hub-browser-deadbeef': ['https://example.com'],
      })
    );

    const res = coldHelper.cleanupAccountLocalResidue({ homeDir, userDataDir, geminiDir });
    assert.equal(res.removedFallbackToken, true);
    assert.equal(res.removedKeyringMarker, true);
    assert.equal(res.removedCredentialScope, true);
    assert.deepEqual(res.clearedAppStorageKeys.sort(), [...coldHelper.ACCOUNT_SCOPED_APP_STORAGE_KEYS].sort());

    assert.equal(fs.existsSync(fallbackTok), false);
    assert.equal(fs.existsSync(markerFile), false);
    assert.equal(fs.existsSync(scopeFile), false);

    // Preserved files remain byte-identical
    assert.equal(fs.readFileSync(installIdPath, 'utf8'), '11111111-2222-3333-4444-555555555555');
    assert.equal(fs.readFileSync(statePbtxtPath, 'utf8'), 'installation_uuid: "aaaa-bbbb"\n');
    assert.equal(fs.readFileSync(convDbPath, 'utf8'), 'sqlite-placeholder');
    assert.equal(fs.readFileSync(convPbPath, 'utf8'), 'shared-chat-data');

    const storageAfter = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    assert.deepEqual(storageAfter, {
      pinned_conversations_order: ['c1', 'c2'],
      'jetski.browser.history.persist:hub-browser-deadbeef': ['https://example.com'],
    });
  });
});

test('startColdSwitchAccount blocks when agy CLI is running and never touches Keychain or spawns helper', () => {
  withTempDir((tmp) => {
    const secretA = encodeGoKeyringSecret({ id_token_email: 'a@test.com', refresh_token: 'rt-a' });
    const secretB = encodeGoKeyringSecret({ id_token_email: 'b@test.com', refresh_token: 'rt-b' });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretA,
      'antigravity-hakimi-accounts::b@test.com': secretB,
    });
    switcher.saveProfilesRegistry(
      { profiles: [{ id: 'b@test.com', email: 'b@test.com', tokenFingerprint: switcher.computeTokenFingerprint(secretB) }] },
      { stateDir: tmp }
    );

    let spawned = false;
    const res = switcher.startColdSwitchAccount(
      { targetId: 'b@test.com', currentEmail: 'a@test.com' },
      {
        platform: 'darwin',
        stateDir: tmp,
        keychain: kc,
        appBundlePath: '/Applications/哈基米.app',
        detectAgyCliImpl: () => [{ pid: 9999, command: '/Users/dev/.local/bin/agy' }],
        spawnImpl: () => {
          spawned = true;
          return { pid: 1234, unref() {} };
        },
      }
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'AGY_CLI_RUNNING');
    assert.deepEqual(res.agyCliPids, [9999]);
    assert.equal(spawned, false);
    assert.equal(kc.calls.set.length, 0);
  });
});

test('startColdSwitchAccount stages helper & zero-secret job JSON and spawns detached child', () => {
  withTempDir((tmp) => {
    const secretA = encodeGoKeyringSecret({ id_token_email: 'a@test.com', refresh_token: 'SUPER_SECRET_A' });
    const secretB = encodeGoKeyringSecret({ id_token_email: 'b@test.com', refresh_token: 'SUPER_SECRET_B' });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretA,
      'antigravity-hakimi-accounts::b@test.com': secretB,
    });
    switcher.saveProfilesRegistry(
      { profiles: [{ id: 'b@test.com', email: 'b@test.com', label: 'Backup', tokenFingerprint: switcher.computeTokenFingerprint(secretB) }] },
      { stateDir: tmp }
    );

    let capturedSpawn = null;
    let unrefCalled = false;
    const res = switcher.startColdSwitchAccount(
      { targetId: 'b@test.com', currentEmail: 'a@test.com' },
      {
        platform: 'darwin',
        stateDir: tmp,
        keychain: kc,
        appBundlePath: '/Applications/哈基米.app',
        nodeBin: '/opt/homebrew/bin/node',
        detectAgyCliImpl: () => [],
        spawnImpl: (bin, args, opts) => {
          capturedSpawn = { bin, args, opts };
          return {
            pid: 43210,
            unref() { unrefCalled = true; },
          };
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.coldSwitching, true);
    assert.equal(res.helperPid, 43210);
    assert.equal(unrefCalled, true);
    assert.equal(capturedSpawn.bin, '/opt/homebrew/bin/node');
    assert.equal(capturedSpawn.opts.detached, true);
    assert.equal(capturedSpawn.args[1], '--job');

    const stagedHelper = capturedSpawn.args[0];
    const jobFile = capturedSpawn.args[2];
    assert.ok(fs.existsSync(stagedHelper));
    assert.ok(fs.existsSync(jobFile));

    const jobRaw = fs.readFileSync(jobFile, 'utf8');
    assert.equal(jobRaw.includes('SUPER_SECRET'), false, 'job JSON must never contain OAuth secrets');
    const jobObj = JSON.parse(jobRaw);
    assert.equal(jobObj.action, 'switch');
    assert.equal(jobObj.targetId, 'b@test.com');
  });
});

test('executeColdAccountJob enforces exit barrier, swaps Keychain with auto-backup, cleans residue, and relaunches cleanly', () => {
  withTempDir((tmp) => {
    const homeDir = path.join(tmp, 'home');
    const geminiDir = path.join(homeDir, '.gemini');
    const agDir = path.join(geminiDir, 'antigravity');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    const stateDir = path.join(tmp, 'state');

    fs.mkdirSync(path.join(geminiDir, 'cache'), { recursive: true });
    fs.mkdirSync(agDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(agDir, 'installation_id'), 'keep-this-uuid');
    fs.writeFileSync(path.join(userDataDir, 'credential-user-scope'), 'oldscope12345678\n');
    fs.writeFileSync(path.join(geminiDir, 'jetski-standalone-oauth-token'), 'stale-file-token');
    fs.writeFileSync(
      path.join(userDataDir, 'app_storage.json'),
      JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'unsaved@work.com', keepMe: 1 })
    );

    // Create a stale SingletonLock pointing to dead PID 999991
    fs.symlinkSync('macbook-999991', path.join(userDataDir, 'SingletonLock'));

    const secretUnsaved = encodeGoKeyringSecret({ id_token_email: 'unsaved@work.com', refresh_token: 'RT_UNSAVED_SECRET' });
    const secretTarget = encodeGoKeyringSecret({ id_token_email: 'target@home.com', refresh_token: 'RT_TARGET_SECRET' });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretUnsaved,
      'antigravity-hakimi-accounts::target@home.com': secretTarget,
    });
    switcher.saveProfilesRegistry(
      { profiles: [{ id: 'target@home.com', email: 'target@home.com', label: 'Home', tokenFingerprint: switcher.computeTokenFingerprint(secretTarget) }] },
      { stateDir }
    );

    // Simulate 1 living main PID exiting after first poll
    let pollCount = 0;
    const events = [];
    const relaunches = [];

    const res = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'target@home.com',
        currentEmail: 'unsaved@work.com',
        currentTierName: 'Pro',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      {
        keychain: kc,
        pollIntervalMs: 10,
        initialGraceMs: 30,
        sleepImpl: () => {},
        findPidsImpl: (mode) => {
          pollCount += 1;
          if (pollCount <= 2) return mode === 'main' ? [5555] : [5555, 5556];
          return [];
        },
        killImpl: (pid, sig) => {
          if (sig === 0 && pid === 999991) {
            const e = new Error('ESRCH');
            e.code = 'ESRCH';
            throw e;
          }
          events.push({ pid, sig });
        },
        detectAgyCliImpl: () => [],
        env: {
          PATH: '/usr/bin:/bin',
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ASAR: '1',
          NODE_OPTIONS: '--inspect',
          DEV_URL: 'http://localhost:3000',
        },
        spawnImpl: (bin, args, opts) => {
          relaunches.push({ bin, args, opts });
          return { pid: 7777, unref() {} };
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.autoSavedPrevious, true);
    assert.equal(res.switchedTo.id, 'target@home.com');
    assert.equal(res.relaunched, true);

    // Active slot now holds target secret; outgoing unsaved account backed up in Vault!
    assert.equal(kc.get('gemini', 'antigravity'), secretTarget);
    assert.equal(kc.get('antigravity-hakimi-accounts', 'unsaved@work.com'), secretUnsaved);

    // Residue cleaned, SingletonLock cleaned, installation_id preserved, onboarding synced to target
    assert.equal(fs.existsSync(path.join(userDataDir, 'credential-user-scope')), false);
    assert.equal(fs.existsSync(path.join(geminiDir, 'jetski-standalone-oauth-token')), false);
    assert.equal(fs.existsSync(path.join(userDataDir, 'SingletonLock')), false);
    assert.equal(fs.readFileSync(path.join(agDir, 'installation_id'), 'utf8'), 'keep-this-uuid');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'app_storage.json'), 'utf8')), {
      keepMe: 1,
      'agy.onboarding.lastLoginUsername': 'target@home.com',
      'agy.onboarding.lastLoginIsGcpTos': 'false',
    });

    // Relaunch invoked /usr/bin/open -n with stripped Electron env vars
    assert.equal(relaunches.length, 1);
    assert.equal(relaunches[0].bin, '/usr/bin/open');
    assert.deepEqual(relaunches[0].args, ['-n', '/Applications/哈基米.app']);
    for (const k of coldHelper.RELAUNCH_STRIP_ENV_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(relaunches[0].opts.env, k), false, `env should strip ${k}`);
    }

    // Zero plaintext tokens anywhere on disk under stateDir
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const content = fs.readFileSync(full, 'utf8');
          assert.equal(content.includes('RT_UNSAVED_SECRET'), false);
          assert.equal(content.includes('RT_TARGET_SECRET'), false);
          assert.equal(content.includes('go-keyring-base64:'), false);
        }
      }
    };
    walk(stateDir);
  });
});

test('executeColdAccountJob prepare-add backs up outgoing slot without touching Vault and clears active slot', () => {
  withTempDir((tmp) => {
    const stateDir = path.join(tmp, 'state');
    const homeDir = path.join(tmp, 'home');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    const geminiDir = path.join(homeDir, '.gemini');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(geminiDir, { recursive: true });

    const secretA = encodeGoKeyringSecret({ id_token_email: 'a@work.com', refresh_token: 'RT_KEEP_ALIVE' });
    const kc = makeMockKeychain({ 'gemini::antigravity': secretA });
    const relaunches = [];

    const res = coldHelper.executeColdAccountJob(
      {
        action: 'prepare-add',
        currentEmail: 'a@work.com',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      {
        keychain: kc,
        skipStop: true,
        sleepImpl: () => {},
        detectAgyCliImpl: () => [],
        spawnImpl: (bin, args) => {
          relaunches.push({ bin, args });
          return { pid: 8888, unref() {} };
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.clearedActive, true);
    assert.equal(res.backedUpProfile.id, 'a@work.com');
    assert.equal(kc.get('gemini', 'antigravity'), null);
    assert.equal(kc.get('antigravity-hakimi-accounts', 'a@work.com'), secretA);
    assert.equal(relaunches.length, 1);
  });
});

test('official Antigravity.app bundle is strictly rejected by cold-switch guard', () => {
  withTempDir((tmp) => {
    const res = coldHelper.executeColdAccountJob(
      {
        action: 'prepare-add',
        appBundlePath: '/Applications/Antigravity.app',
        stateDir: tmp,
      },
      { skipStop: true, relaunch: false }
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /禁止|官方/);
  });
});

test('saveCurrentAccount, renameAccount, removeAccount and non-macOS degradation behave cleanly', () => {
  withTempDir((tmp) => {
    const secretA = encodeGoKeyringSecret({ id_token_email: 'a@work.com', refresh_token: 'rt-a-1' });
    const kc = makeMockKeychain({ 'gemini::antigravity': secretA });

    const linuxRes = switcher.getAccountsStatus({ platform: 'linux', stateDir: tmp, keychain: kc });
    assert.equal(linuxRes.ok, false);
    assert.equal(linuxRes.supported, false);

    const saved = switcher.saveCurrentAccount(
      { email: 'a@work.com', label: '主力 Pro', tierName: 'Pro' },
      { platform: 'darwin', stateDir: tmp, keychain: kc, detectAgyCliImpl: () => [] }
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.profile.label, '主力 Pro');

    const renamed = switcher.renameAccount(
      { targetId: 'a@work.com', label: '工作号 Pro' },
      { platform: 'darwin', stateDir: tmp, keychain: kc, detectAgyCliImpl: () => [] }
    );
    assert.equal(renamed.ok, true);
    assert.equal(renamed.profile.label, '工作号 Pro');

    const removed = switcher.removeAccount(
      { targetId: 'a@work.com' },
      { platform: 'darwin', stateDir: tmp, keychain: kc, detectAgyCliImpl: () => [] }
    );
    assert.equal(removed.ok, true);
    assert.equal(kc.get('antigravity-hakimi-accounts', 'a@work.com'), null);
    // Active login slot untouched when removing Vault snapshot
    assert.equal(kc.get('gemini', 'antigravity'), secretA);
  });
});

test('preload bridge and ASAR PAYLOAD_FILES include cold account switcher modules', () => {
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  for (const fn of [
    'getAccountsStatus',
    'saveCurrentAccount',
    'switchAccount',
    'prepareAddAccount',
    'renameAccount',
    'removeAccount',
  ]) {
    assert.ok(preloadCode.includes(`${fn}:`), `preload missing ${fn}`);
  }
  assert.ok(PAYLOAD_FILES.includes('meter-account-cold-helper.js'));
  assert.ok(PAYLOAD_FILES.includes('meter-account-switcher.js'));
});

test('executeColdAccountJob suppresses relaunch when main process fails to exit, but relaunches on post-exit Keychain failure', () => {
  withTempDir((tmp) => {
    const stateDir = path.join(tmp, 'state');
    const relaunchesA = [];
    const resA = coldHelper.executeColdAccountJob(
      {
        action: 'prepare-add',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
      },
      {
        pollIntervalMs: 5,
        initialGraceMs: 10,
        mainTermMs: 10,
        allTermMs: 10,
        killWaitMs: 10,
        sleepImpl: () => {},
        findPidsImpl: () => [91001],
        killImpl: () => {},
        spawnImpl: (bin, args) => {
          relaunchesA.push({ bin, args });
          return { pid: 1, unref() {} };
        },
      }
    );
    assert.equal(resA.ok, false);
    assert.match(resA.error, /退出超时/);
    assert.equal(relaunchesA.length, 0, 'must not spawn duplicate app while main PID still alive');

    const stateDirB = path.join(tmp, 'state-b');
    const relaunchesB = [];
    const lockedKc = {
      has() { throw new Error('macOS 钥匙串当前已锁定'); },
      get() { throw new Error('macOS 钥匙串当前已锁定'); },
      set() { throw new Error('macOS 钥匙串当前已锁定'); },
      delete() { throw new Error('macOS 钥匙串当前已锁定'); },
    };
    const resB = coldHelper.executeColdAccountJob(
      {
        action: 'prepare-add',
        appBundlePath: '/Applications/哈基米.app',
        stateDir: stateDirB,
      },
      {
        keychain: lockedKc,
        skipStop: true,
        sleepImpl: () => {},
        detectAgyCliImpl: () => [],
        spawnImpl: (bin, args) => {
          relaunchesB.push({ bin, args });
          return { pid: 2, unref() {} };
        },
      }
    );
    assert.equal(resB.ok, false);
    assert.match(resB.error, /钥匙串当前已锁定/);
    assert.equal(resB.relaunched, true);
    assert.equal(relaunchesB.length, 1, 'must relaunch app after post-exit Keychain error so user sees error');
  });
});

test('staged meter-account-cold-helper.js runs standalone outside repo with zero relative dependencies', () => {
  const { spawnSync } = require('child_process');
  withTempDir((tmp) => {
    const copiedHelper = path.join(tmp, 'cold-switch-helper.js');
    fs.copyFileSync(path.join(ROOT, 'payload', 'dist', 'meter-account-cold-helper.js'), copiedHelper);
    const stateDir = path.join(tmp, 'state');
    const jobFile = path.join(tmp, 'job.json');
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        action: 'noop-test-action',
        stateDir,
        appBundlePath: '',
      })
    );
    const run = spawnSync(process.execPath, [copiedHelper, '--job', jobFile], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(run.status, 1);
    assert.equal(fs.existsSync(jobFile), false, 'helper must delete transient job file after reading');
    const resultPath = path.join(stateDir, 'runtime', 'cold-switch-last-result.json');
    assert.ok(fs.existsSync(resultPath));
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /未知的冷切换动作/);
  });
});

test('cold switch captures exact onboarding casing/isGcpTos and restores target onboarding to avoid modal re-prompt', () => {
  withTempDir((tmp) => {
    const homeDir = path.join(tmp, 'home');
    const geminiDir = path.join(homeDir, '.gemini');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(geminiDir, { recursive: true });

    const appStoragePath = path.join(userDataDir, 'app_storage.json');
    fs.writeFileSync(
      appStoragePath,
      JSON.stringify({
        'agy.onboarding.lastLoginUsername': 'Alice.Work@Corp.COM',
        'agy.onboarding.lastLoginIsGcpTos': 'true',
        'jetski.onboarding.lastLoginUsername': 'stale@legacy.com',
        'enable-wcv-three-layer-stack': 'true',
        keepLayout: 'ok',
      })
    );

    const secretA = encodeGoKeyringSecret({
      id_token_email: 'Alice.Work@Corp.COM',
      auth_method: 'gcp',
      refresh_token: 'rt-a-gcp',
    });
    const secretB = encodeGoKeyringSecret({
      id_token_email: 'Bob.Home@Gmail.com',
      auth_method: 'consumer',
      refresh_token: 'rt-b-consumer',
    });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretA,
      'antigravity-hakimi-accounts::alice.work@corp.com': secretA,
      'antigravity-hakimi-accounts::bob.home@gmail.com': secretB,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          { id: 'alice.work@corp.com', email: 'alice.work@corp.com', tokenFingerprint: switcher.computeTokenFingerprint(secretA) },
          { id: 'bob.home@gmail.com', email: 'bob.home@gmail.com', tokenFingerprint: switcher.computeTokenFingerprint(secretB) },
        ],
      },
      { stateDir }
    );

    // Switch A -> B: captures A's exact casing + isGcpTos='true', sets B's exact casing + isGcpTos='false'
    const res1 = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'bob.home@gmail.com',
        currentEmail: 'Alice.Work@Corp.COM',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      { keychain: kc, skipStop: true, relaunch: false, detectAgyCliImpl: () => [] }
    );
    assert.equal(res1.ok, true);
    const storageAfterB = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    assert.deepEqual(storageAfterB, {
      keepLayout: 'ok',
      'agy.onboarding.lastLoginUsername': 'Bob.Home@Gmail.com',
      'agy.onboarding.lastLoginIsGcpTos': 'false',
    });

    // Switch B -> A: restores A's captured exact casing + isGcpTos='true'
    const res2 = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'alice.work@corp.com',
        currentEmail: 'Bob.Home@Gmail.com',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      { keychain: kc, skipStop: true, relaunch: false, detectAgyCliImpl: () => [] }
    );
    assert.equal(res2.ok, true);
    const storageAfterA = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    assert.deepEqual(storageAfterA, {
      keepLayout: 'ok',
      'agy.onboarding.lastLoginUsername': 'Alice.Work@Corp.COM',
      'agy.onboarding.lastLoginIsGcpTos': 'true',
    });
  });
});

test('findMatchingProfile refuses fingerprint or id fallback when currentEmail conflicts with profile email', () => {
  const profiles = [
    {
      id: 'solaris1998llc@gmail.com',
      email: 'solaris1998llc@gmail.com',
      label: '主力Ultra',
      tokenFingerprint: 'deadbeef1234',
    },
    {
      id: 'legacy-no-email',
      email: '',
      label: 'Legacy',
      tokenFingerprint: 'cafebabe5678',
    },
    {
      id: 'cherishlv1998@gmail.com',
      email: 'other@gmail.com',
      label: 'MismatchedId',
      tokenFingerprint: '112233445566',
    },
  ];

  assert.equal(
    coldHelper.findMatchingProfile(profiles, {
      activeFingerprint: 'deadbeef1234',
      currentEmail: 'cherishlv1998@gmail.com',
    }),
    null,
    'must not match solaris by fingerprint when currentEmail is cherish'
  );

  assert.equal(
    coldHelper.findMatchingProfile(profiles, {
      activeFingerprint: 'deadbeef1234',
      currentEmail: '',
    })?.id,
    'solaris1998llc@gmail.com',
    'fingerprint fallback still works when currentEmail is unknown'
  );

  assert.equal(
    coldHelper.findMatchingProfile(profiles, {
      activeFingerprint: 'cafebabe5678',
      currentEmail: 'new-email@gmail.com',
    })?.id,
    'legacy-no-email',
    'fingerprint fallback still matches email-less legacy entries'
  );
});

test('getAccountsStatus never pairs mismatched live hint with saved profile or corrupts its tierName', () => {
  withTempDir((tmp) => {
    const secretUltra = encodeGoKeyringSecret({
      id_token_email: 'solaris1998llc@gmail.com',
      user_tier: 'g1-ultra-tier',
      tier_display_name: 'Google AI Ultra',
      refresh_token: 'rt-ultra',
    });
    const secretPro = encodeGoKeyringSecret({
      id_token_email: 'cherishlv1998@gmail.com',
      tier_display_name: 'Google AI Pro',
      refresh_token: 'rt-pro',
    });

    // Case 1: Keychain holds solaris (Ultra 20x) while renderer passes stale cherish (Pro)
    const kc1 = makeMockKeychain({
      'gemini::antigravity': secretUltra,
      'antigravity-hakimi-accounts::solaris1998llc@gmail.com': secretUltra,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          {
            id: 'solaris1998llc@gmail.com',
            email: 'solaris1998llc@gmail.com',
            label: '主力Ultra',
            tierName: 'Google AI Ultra 20x',
            tokenFingerprint: switcher.computeTokenFingerprint(secretUltra),
          },
        ],
      },
      { stateDir: tmp }
    );

    const st1 = switcher.getAccountsStatus({
      platform: 'darwin',
      stateDir: tmp,
      keychain: kc1,
      currentEmail: 'cherishlv1998@gmail.com',
      currentTierName: 'Google AI Pro',
      detectAgyCliImpl: () => [],
    });
    assert.equal(st1.ok, true);
    assert.equal(st1.activeEmail, 'solaris1998llc@gmail.com');
    assert.equal(st1.activeTierName, 'Google AI Ultra 20x');
    assert.equal(st1.activeProfileId, 'solaris1998llc@gmail.com');
    assert.equal(st1.keychainLiveMismatch, true);
    assert.equal(st1.liveSessionEmail, 'cherishlv1998@gmail.com');
    assert.equal(st1.profiles[0].isActive, true);
    assert.equal(st1.profiles[0].tierName, 'Google AI Ultra 20x');
    const reloaded = switcher.loadProfilesRegistry({ stateDir: tmp });
    assert.equal(reloaded.profiles[0].tierName, 'Google AI Ultra 20x', 'must not overwrite Ultra tier with stale Pro hint');

    // Case 2: Already-corrupted fingerprint collision (saved solaris has cherish fp; active is cherish)
    switcher.saveProfilesRegistry(
      {
        profiles: [
          {
            id: 'solaris1998llc@gmail.com',
            email: 'solaris1998llc@gmail.com',
            label: '主力Ultra',
            tierName: 'Google AI Ultra 20x',
            tokenFingerprint: switcher.computeTokenFingerprint(secretPro),
          },
        ],
      },
      { stateDir: tmp }
    );
    const kc2 = makeMockKeychain({
      'gemini::antigravity': secretPro,
      'antigravity-hakimi-accounts::solaris1998llc@gmail.com': secretPro,
    });
    const st2 = switcher.getAccountsStatus({
      platform: 'darwin',
      stateDir: tmp,
      keychain: kc2,
      currentEmail: 'cherishlv1998@gmail.com',
      currentTierName: 'Google AI Pro',
      detectAgyCliImpl: () => [],
    });
    assert.equal(st2.ok, true);
    assert.equal(st2.activeEmail, 'cherishlv1998@gmail.com');
    assert.equal(st2.activeProfileId, null);
    assert.equal(st2.currentUnsaved, true);
    assert.equal(st2.profiles[0].isActive, false);
    assert.equal(st2.profiles[0].tierName, 'Google AI Ultra 20x');
  });
});

test('saveCurrentAccount and executeColdAccountJob trust token id_token_email over stale hint to prevent Vault overwrite', () => {
  withTempDir((tmp) => {
    const stateDir = path.join(tmp, 'state');
    const homeDir = path.join(tmp, 'home');
    const geminiDir = path.join(homeDir, '.gemini');
    const agDir = path.join(geminiDir, 'antigravity');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    fs.mkdirSync(agDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    const secretUltra = encodeGoKeyringSecret({
      id_token_email: 'solaris1998llc@gmail.com',
      user_tier: 'g1-ultra-tier',
      tier_display_name: 'Google AI Ultra',
      refresh_token: 'rt-ultra-keep-intact',
    });
    const secretPro = encodeGoKeyringSecret({
      id_token_email: 'cherishlv1998@gmail.com',
      tier_display_name: 'Google AI Pro',
      refresh_token: 'rt-pro-new-login',
    });
    const kc = makeMockKeychain({
      'gemini::antigravity': secretPro,
      'antigravity-hakimi-accounts::solaris1998llc@gmail.com': secretUltra,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          {
            id: 'solaris1998llc@gmail.com',
            email: 'solaris1998llc@gmail.com',
            label: '主力Ultra',
            tierName: 'Google AI Ultra 20x',
            tokenFingerprint: switcher.computeTokenFingerprint(secretUltra),
          },
        ],
      },
      { stateDir }
    );

    // User just signed into cherish (Pro) while renderer hint is still stale solaris (Ultra 20x) and clicks save/update
    const saveRes = switcher.saveCurrentAccount(
      { email: 'solaris1998llc@gmail.com', tierName: 'Google AI Ultra 20x' },
      { platform: 'darwin', stateDir, homeDir, userDataDir, keychain: kc, detectAgyCliImpl: () => [] }
    );
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.profile.id, 'cherishlv1998@gmail.com');
    assert.equal(saveRes.profile.email, 'cherishlv1998@gmail.com');
    assert.equal(saveRes.profile.tierName, 'Google AI Pro');
    // Crucial: solaris Vault entry & metadata remain completely untouched!
    assert.equal(kc.get('antigravity-hakimi-accounts', 'solaris1998llc@gmail.com'), secretUltra);
    assert.equal(kc.get('antigravity-hakimi-accounts', 'cherishlv1998@gmail.com'), secretPro);
    assert.equal(saveRes.status.profiles.length, 2);
    const solarisAfter = saveRes.status.profiles.find((p) => p.id === 'solaris1998llc@gmail.com');
    const cherishAfter = saveRes.status.profiles.find((p) => p.id === 'cherishlv1998@gmail.com');
    assert.equal(solarisAfter.label, '主力Ultra');
    assert.equal(solarisAfter.tierName, 'Google AI Ultra 20x');
    assert.equal(solarisAfter.isActive, false);
    assert.equal(cherishAfter.isActive, true);

    // Also verify cold prepare-add with stale job.currentEmail does not clobber solaris
    const archivePath = path.join(agDir, 'token_usage_archive_v2.json');
    fs.writeFileSync(
      archivePath,
      JSON.stringify({
        version: '2.0.0',
        firstUseDate: '2026-11-01',
        planStatus: { status: 'identified', tierKey: 'pro', tierName: 'Google AI Pro', email: 'cherishlv1998@gmail.com' },
        dailyMapBySource: { desktop: { '2026-11-01': { total: 1234 } }, cli: {}, legacyUnallocated: {} },
      })
    );
    const prepRes = coldHelper.executeColdAccountJob(
      {
        action: 'prepare-add',
        currentEmail: 'solaris1998llc@gmail.com',
        currentTierName: 'Google AI Ultra 20x',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      { keychain: kc, skipStop: true, relaunch: false, detectAgyCliImpl: () => [] }
    );
    assert.equal(prepRes.ok, true);
    assert.equal(prepRes.backedUpProfile.id, 'cherishlv1998@gmail.com');
    assert.equal(kc.get('antigravity-hakimi-accounts', 'solaris1998llc@gmail.com'), secretUltra);
    assert.equal(prepRes.residueCleaned.clearedArchivePlanStatus, true);
    const archiveAfter = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.equal(archiveAfter.planStatus, null, 'prepare-add must clear stale archive planStatus');
    assert.deepEqual(archiveAfter.dailyMapBySource.desktop['2026-11-01'], { total: 1234 }, 'token history must be preserved');
  });
});

test('meter-collector flags archive fallback and does not resurrect stale archive email when signed out', async () => {
  const collector = require(path.join(ROOT, 'payload', 'dist', 'meter-collector.js'));
  const tmpAg = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-acc-collector-'));
  const emptyCliDir = path.join(tmpAg, 'empty-cli');
  try {
    const archivePath = path.join(tmpAg, 'token_usage_archive_v2.json');
    fs.writeFileSync(
      archivePath,
      JSON.stringify({
        version: '2.0.0',
        firstUseDate: '2026-11-01',
        planStatus: {
          status: 'identified',
          tierKey: 'ultra',
          tierName: 'Google AI Ultra 20x',
          email: 'solaris1998llc@gmail.com',
        },
        dailyMapBySource: { desktop: {}, cli: {}, legacyUnallocated: {} },
      })
    );

    // 1. Offline/booting (userStatus: null): falls back to archiveV2 for display, flagged with isArchiveFallback=true
    const offline = await collector.collectTokenHistoryAsync({ agDir: tmpAg, agCliDir: emptyCliDir, userStatus: null });
    assert.equal(offline.planStatus.email, 'solaris1998llc@gmail.com');
    assert.equal(offline.planStatus.isArchiveFallback, true);

    // 2. Signed-out live RPC (empty userStatus object): must NOT resurrect stale solaris email from archiveV2
    const signedOut = await collector.collectTokenHistoryAsync({ agDir: tmpAg, agCliDir: emptyCliDir, userStatus: { userStatus: {} } });
    assert.equal(signedOut.planStatus.email, null);
    assert.equal(signedOut.planStatus.status, 'unidentified');
    assert.equal(signedOut.planStatus.isArchiveFallback, undefined);

    // 3. New account signed in (same or different tier): updates archiveV2 email cleanly
    const proA = await collector.collectTokenHistoryAsync({
      agDir: tmpAg,
      agCliDir: emptyCliDir,
      userStatus: { userStatus: { email: 'pro-a@gmail.com', userTier: { id: 'pro', name: 'Google AI Pro' } } },
    });
    assert.equal(proA.planStatus.email, 'pro-a@gmail.com');
    assert.equal(proA.planStatus.isArchiveFallback, undefined);

    const proB = await collector.collectTokenHistoryAsync({
      agDir: tmpAg,
      agCliDir: emptyCliDir,
      userStatus: { userStatus: { email: 'pro-b@gmail.com', userTier: { id: 'pro', name: 'Google AI Pro' } } },
    });
    assert.equal(proB.planStatus.email, 'pro-b@gmail.com');
    const savedArch = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.equal(savedArch.planStatus.email, 'pro-b@gmail.com');
  } finally {
    fs.rmSync(tmpAg, { recursive: true, force: true });
  }
});

test('renderer account switcher ignores archive fallback email, refreshes live identity on open, and surfaces mismatch warning', async () => {
  const vm = require('vm');
  const byId = new Map();
  const makeNode = (tag, id = '') => {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const node = {
      nodeType: 1,
      tagName: String(tag || 'DIV').toUpperCase(),
      id,
      hidden: id === 'panel' || id === 'panel-tokens' || id === 'overflow-menu' || id === 'color-picker-popover' || id === 'accounts-popover' || id === 'acc-status',
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
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener() {},
      dispatch(type, ev = {}) {
        for (const fn of listeners.get(type) || []) fn(ev);
      },
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
        return {
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
      },
    };
    return node;
  };

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
    addEventListener() {},
    removeEventListener() {},
  };

  let historyForceCalls = 0;
  let livePlanStatus = {
    status: 'identified',
    email: 'stale-archive@gmail.com',
    tierName: 'Google AI Ultra 20x',
    isArchiveFallback: true,
  };
  const statusRequests = [];
  let nextAccountsReply = {
    ok: true,
    supported: true,
    hasActiveToken: true,
    activeEmail: 'solaris1998llc@gmail.com',
    activeTierName: 'Google AI Ultra 20x',
    activeProfileId: 'solaris1998llc@gmail.com',
    currentUnsaved: false,
    keychainLiveMismatch: false,
    liveSessionEmail: null,
    profiles: [
      { id: 'solaris1998llc@gmail.com', email: 'solaris1998llc@gmail.com', label: '主力Ultra', tierName: 'Google AI Ultra 20x', isActive: true, vaultPresent: true },
    ],
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
      getSettings: async () => ({ ok: true, uiPreferences: {} }),
      getTokenHistory: async (force) => {
        if (force) historyForceCalls++;
        return {
          ok: true,
          data: {
            updatedAt: '2026-11-27 15:00:00',
            firstUseDate: '2026-11-20',
            summary: { grandTotalTokens: 1000, todayTokens: 1000, monthTokens: 1000, yearTokens: 1000, totalConversations: 1, activeDaysCount: 1 },
            dailyMap: { '2026-11-27': { total: 1000, input: 600, output: 200, cache: 200, steps: 1 } },
            dailyMapBySource: { all: { '2026-11-27': { total: 1000, input: 600, output: 200, cache: 200, steps: 1 } }, desktop: {}, cli: {} },
            planStatus: livePlanStatus,
            rawPlanStatus: livePlanStatus,
            cascadeModelConfigs: [],
            speedRecords: [],
          },
        };
      },
      getAccountsStatus: async (opts) => {
        statusRequests.push(opts);
        return nextAccountsReply;
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const coreSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');
  vm.runInNewContext(`${coreSrc}\n${rendererSrc}`, sandbox, { filename: 'meter-renderer-accounts-test.js' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const api = sandbox.__AGContextMeter;
  // Archive fallback email must NOT be forwarded as currentEmail
  assert.equal(statusRequests[0].currentEmail, '');

  // Opening popover when current hint is empty/fallback forces a live token-history sync
  livePlanStatus = {
    status: 'identified',
    email: 'cherishlv1998@gmail.com',
    tierName: 'Google AI Pro',
  };
  nextAccountsReply = {
    ok: true,
    supported: true,
    hasActiveToken: true,
    activeEmail: 'solaris1998llc@gmail.com',
    activeTierName: '',
    activeProfileId: 'solaris1998llc@gmail.com',
    currentUnsaved: false,
    keychainLiveMismatch: true,
    liveSessionEmail: 'cherishlv1998@gmail.com',
    profiles: [
      { id: 'solaris1998llc@gmail.com', email: 'solaris1998llc@gmail.com', label: '主力Ultra', tierName: 'Google AI Ultra 20x', isActive: true, vaultPresent: true },
    ],
  };

  api.openAccountsPopoverForTest();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.ok(historyForceCalls >= 1, 'opening popover with fallback/empty hint should force live history sync');
  const snap = api.getAccountsUiSnapshotForTest();
  assert.equal(snap.currentEmailText, 'solaris1998llc@gmail.com');
  assert.equal(snap.statusHidden, false, 'keychain/session mismatch warning should be surfaced');
  assert.match(snap.statusText, /cherishlv1998@gmail\.com/);
  assert.match(snap.statusText, /solaris1998llc@gmail\.com/);
  // Must not leak cherish's Pro tier onto solaris's badge when mismatched
  assert.equal(byId.get('acc-current-tier').hidden, true);

  api.dispose();
});

test('executeColdAccountJob switch aborts with VAULT_IDENTITY_MISMATCH when target Vault snapshot belongs to another account', () => {
  withTempDir((tmp) => {
    const homeDir = path.join(tmp, 'home');
    const geminiDir = path.join(homeDir, '.gemini');
    const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(geminiDir, { recursive: true });

    const appStoragePath = path.join(userDataDir, 'app_storage.json');
    fs.writeFileSync(
      appStoragePath,
      JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'charlie@gmail.com' })
    );

    const secretCharlie = encodeGoKeyringSecret({
      id_token_email: 'charlie@gmail.com',
      refresh_token: 'rt-charlie-active',
    });
    const secretBobPoisoned = encodeGoKeyringSecret({
      id_token_email: 'bob@gmail.com',
      refresh_token: 'rt-bob-poisoned',
    });
    const secretAliceValid = encodeGoKeyringSecret({
      id_token_email: 'Alice@Gmail.COM',
      refresh_token: 'rt-alice-valid',
    });

    const kc = makeMockKeychain({
      'gemini::antigravity': secretCharlie,
      // Poisoned Vault entry: stored under alice@gmail.com, but embedded token belongs to bob@gmail.com
      'antigravity-hakimi-accounts::alice@gmail.com': secretBobPoisoned,
      // Poisoned Vault entry with empty profile.email relying on targetId email fallback
      'antigravity-hakimi-accounts::dave@gmail.com': secretBobPoisoned,
      // Legitimate Vault entry with different email casing
      'antigravity-hakimi-accounts::alice-ok@gmail.com': secretAliceValid,
    });
    switcher.saveProfilesRegistry(
      {
        profiles: [
          {
            id: 'alice@gmail.com',
            email: 'alice@gmail.com',
            tierName: 'Google AI Ultra 20x',
            tokenFingerprint: coldHelper.computeTokenFingerprint(secretBobPoisoned),
          },
          {
            id: 'dave@gmail.com',
            email: '',
            tierName: 'Pro',
            tokenFingerprint: coldHelper.computeTokenFingerprint(secretBobPoisoned),
          },
          {
            id: 'alice-ok@gmail.com',
            email: 'alice@gmail.com',
            tierName: 'Google AI Ultra 20x',
            tokenFingerprint: coldHelper.computeTokenFingerprint(secretAliceValid),
          },
        ],
      },
      { stateDir }
    );

    const relaunches = [];
    const res = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'alice@gmail.com',
        currentEmail: 'charlie@gmail.com',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      {
        keychain: kc,
        skipStop: true,
        sleepImpl: () => {},
        detectAgyCliImpl: () => [],
        spawnImpl: (bin, args) => {
          relaunches.push({ bin, args });
          return { pid: 9001, unref() {} };
        },
      }
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'VAULT_IDENTITY_MISMATCH');
    assert.equal(res.targetId, 'alice@gmail.com');
    assert.equal(res.expectedEmail, 'alice@gmail.com');
    assert.equal(res.actualEmail, 'bob@gmail.com');
    assert.match(res.error, /alice@gmail\.com/);
    assert.match(res.error, /bob@gmail\.com/);
    // Active slot, Keychain writes, and app_storage must stay completely untouched
    assert.equal(kc.calls.set.length, 0);
    assert.equal(kc.get('gemini', 'antigravity'), secretCharlie);
    assert.deepEqual(JSON.parse(fs.readFileSync(appStoragePath, 'utf8')), {
      'agy.onboarding.lastLoginUsername': 'charlie@gmail.com',
    });
    assert.equal(res.relaunched, true);
    assert.equal(relaunches.length, 1);

    const lastRes = JSON.parse(fs.readFileSync(coldHelper.getColdResultPath({ stateDir }), 'utf8'));
    assert.equal(lastRes.ok, false);
    assert.equal(lastRes.code, 'VAULT_IDENTITY_MISMATCH');
    assert.equal(lastRes.expectedEmail, 'alice@gmail.com');
    assert.equal(lastRes.actualEmail, 'bob@gmail.com');

    // Also blocks when profile.email is empty and expected email falls back to targetId
    const resIdFallback = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'dave@gmail.com',
        currentEmail: 'charlie@gmail.com',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      { keychain: kc, skipStop: true, relaunch: false, detectAgyCliImpl: () => [] }
    );
    assert.equal(resIdFallback.ok, false);
    assert.equal(resIdFallback.code, 'VAULT_IDENTITY_MISMATCH');
    assert.equal(resIdFallback.expectedEmail, 'dave@gmail.com');
    assert.equal(resIdFallback.actualEmail, 'bob@gmail.com');
    assert.equal(kc.calls.set.length, 0);

    // Case-insensitive match proceeds normally
    const resOk = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'alice-ok@gmail.com',
        currentEmail: 'charlie@gmail.com',
        appBundlePath: '/Applications/哈基米.app',
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      { keychain: kc, skipStop: true, relaunch: false, detectAgyCliImpl: () => [] }
    );
    assert.equal(resOk.ok, true);
    assert.equal(kc.get('gemini', 'antigravity'), secretAliceValid);
  });
});
