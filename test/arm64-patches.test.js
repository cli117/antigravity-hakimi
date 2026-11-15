'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const contextUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-context-unlock.js'));
const enhance = require(path.join(ROOT, 'payload', 'dist', 'meter-enhance.js'));
const regionUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-region-unlock.js'));
const cliUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-cli-unlock.js'));

const REGION_CMP_OFF_IN_FN = 0x294;
const REGION_BRANCH_OFF_IN_FN = 0x298;
const REGION_BRANCH_WORD = 0x14fffff0; // unconditional `b` backward (simulates ValidateAndOnboardAccount unlock)

function buildSyntheticArm64MachO() {
  const buf = Buffer.alloc(0x4000, 0);

  // Mach-O 64-bit header (ARM64)
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  buf.writeUInt32LE(0x00000000, 8);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(2, 16); // ncmds
  buf.writeUInt32LE(24 + 152, 20); // sizeofcmds

  // LC_UUID (cmd = 0x1b, size = 24) at offset 32
  buf.writeUInt32LE(0x1b, 32);
  buf.writeUInt32LE(24, 36);
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(buf, 40);

  // LC_SEGMENT_64 (cmd = 0x19, size = 72 + 80 = 152) at offset 56
  buf.writeUInt32LE(0x19, 56);
  buf.writeUInt32LE(152, 60);
  buf.write('__TEXT\0', 64, 'ascii');
  buf.writeUInt32LE(1, 56 + 64); // nsects

  const sectOff = 56 + 72; // 128
  buf.write('__text\0', sectOff, 'ascii');
  buf.writeBigUInt64LE(0x100000000n, sectOff + 32); // addr (textVA)
  buf.writeBigUInt64LE(0x1000n, sectOff + 40); // size
  buf.writeUInt32LE(0x1000, sectOff + 48); // offset (textOff)

  const textOff = 0x1000;

  // fn0: internal/abi.(*RegArgs).Dump @ entryoff 0x000
  buf.writeUInt32LE(0xf9400b90, textOff + 0x000); // ldr x16, [x28, #0x10]
  buf.writeUInt32LE(0xd65f03c0, textOff + 0x004); // ret

  // fn1: ValidateAndOnboardAccount @ entryoff 0x100 (file off 0x1100)
  const regionFnEntry = 0x100;
  const regionCmpFileOff = textOff + regionFnEntry + REGION_CMP_OFF_IN_FN;
  const regionBranchFileOff = textOff + regionFnEntry + REGION_BRANCH_OFF_IN_FN;
  buf.writeUInt32LE(0xf100251f, regionCmpFileOff); // cmp x8, #9
  buf.writeUInt32LE(REGION_BRANCH_WORD, regionBranchFileOff); // unconditional `b`

  // fn2: utils.GetCheckpointConfig @ entryoff 0x400 (file off 0x1400)
  const cwFnEntry = 0x400;
  const native1MFileOff = textOff + cwFnEntry + 0x20;
  // Unguarded native 1,000,000 site (must NOT be touched by Gate 3A patching!)
  contextUnlock.encodeMovzMovkArm64(3, 1000000).copy(buf, native1MFileOff);
  buf.writeUInt32LE(0xb9000c03, native1MFileOff + 8); // str w3, [x0, #0xc]

  // Guarded 256K default site (DEF_GUARD_ARM64 + DEF_ORIG_ARM64)
  contextUnlock.DEF_GUARD_ARM64.copy(buf, textOff + cwFnEntry + 0x100);
  contextUnlock.DEF_ORIG_ARM64.copy(buf, textOff + cwFnEntry + 0x108);

  // Clamp 256K site (CLAMP_256K_ARM64)
  contextUnlock.CLAMP_256K_ARM64.copy(buf, textOff + cwFnEntry + 0x140);

  // fn3: config.selectCheckpointExperimentKey @ entryoff 0x700
  const selectFnEntry = 0x700;
  buf.writeUInt32LE(0xd65f03c0, textOff + selectFnEntry); // ret

  // fn4: config.applyFeatureProviderCheckpointOverrideConfig @ entryoff 0x740
  const expFnEntry = 0x740;
  const blRel = 0x10;
  const imm26 = (selectFnEntry - (expFnEntry + blRel)) / 4;
  const blWord = (0x94000000 | (imm26 & 0x03ffffff)) >>> 0;
  buf.writeUInt32LE(blWord, textOff + expFnEntry + blRel);
  buf.writeUInt32LE(0xd63f0100, textOff + expFnEntry + 0x18); // blr x8
  const gate3bFileOff = textOff + expFnEntry + 0x1c;
  Buffer.from('60000037', 'hex').copy(buf, gate3bFileOff); // tbnz w0, #0, +12

  // Build .gopclntab at 0x2000 (nfunc = 12 > 10)
  const pclnBase = 0x2000;
  const fnOff = 0x100;
  const pclnOff = 0x400;
  const functions = [
    { entryoff: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
    { entryoff: 0x100, name: 'exa.google/internal/authclient.ValidateAndOnboardAccount' },
    { entryoff: 0x400, name: 'exa.google/internal/utils.GetCheckpointConfig' },
    { entryoff: 0x700, name: 'exa.google/internal/config.selectCheckpointExperimentKey' },
    { entryoff: 0x740, name: 'exa.google/internal/config.applyFeatureProviderCheckpointOverrideConfig' },
    { entryoff: 0x840, name: 'exa.google/internal/pkg.dummy0' },
    { entryoff: 0x860, name: 'exa.google/internal/pkg.dummy1' },
    { entryoff: 0x880, name: 'exa.google/internal/pkg.dummy2' },
    { entryoff: 0x8a0, name: 'exa.google/internal/pkg.dummy3' },
    { entryoff: 0x8c0, name: 'exa.google/internal/pkg.dummy4' },
    { entryoff: 0x8e0, name: 'exa.google/internal/pkg.dummy5' },
    { entryoff: 0x900, name: 'exa.google/internal/pkg.dummy6' },
  ];

  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pclnBase);
  buf.writeBigUInt64LE(BigInt(functions.length), pclnBase + 8);
  buf.writeBigUInt64LE(0x100000000n, pclnBase + 24);
  buf.writeBigUInt64LE(BigInt(fnOff), pclnBase + 32);
  buf.writeBigUInt64LE(BigInt(pclnOff), pclnBase + 64);

  const fnstart = pclnBase + fnOff;
  const pcln = pclnBase + pclnOff;
  const recBaseRelToPcln = (functions.length + 1) * 8 + 16;

  let nameCursor = 0;
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const nameBytes = Buffer.from(`${fn.name}\0`, 'ascii');
    nameBytes.copy(buf, fnstart + nameCursor);

    const funcoff = recBaseRelToPcln + i * 8;
    buf.writeUInt32LE(fn.entryoff, pcln + i * 8);
    buf.writeUInt32LE(funcoff, pcln + i * 8 + 4);

    // _func record at pcln + funcoff: entryOff, nameOff
    buf.writeUInt32LE(fn.entryoff, pcln + funcoff);
    buf.writeInt32LE(nameCursor, pcln + funcoff + 4);

    nameCursor += nameBytes.length;
  }
  // Sentinel entry for last function's nextEntry
  buf.writeUInt32LE(0x920, pcln + functions.length * 8);

  return {
    buf,
    regionBranchFileOff,
    native1MFileOff,
    gate3bFileOff,
  };
}

test('ARM64 Mach-O context window patches preserve ValidateAndOnboardAccount and native 1M constant across apply/switch/restore', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-arm64-test-'));
  try {
    const appDir = path.join(tmp, 'FakeHakimi.app');
    const lsPath = path.join(appDir, 'Contents', 'Resources', 'bin', 'language_server');
    const backupDir = path.join(tmp, 'unlock-backups');
    const stateDir = path.join(tmp, 'state');

    fs.mkdirSync(path.dirname(lsPath), { recursive: true });
    const fixture = buildSyntheticArm64MachO();
    fs.writeFileSync(lsPath, fixture.buf);
    fs.chmodSync(lsPath, 0o755);

    const opts = {
      targets: [{ id: 'desktop', label: 'FakeHakimi LS', path: lsPath }],
      recordedTargetPath: lsPath,
      backupDir,
      stateDir,
      skipProcessCheck: true,
      skipCodesign: true,
    };

    // Initial state: unpatched context window
    const initialCtx = contextUnlock.analyzeBinary(lsPath, { backupDir, skipProcessCheck: true });
    assert.equal(initialCtx.status, 'not_patched');
    assert.equal(initialCtx.arch, 'arm64');
    assert.equal(initialCtx.format, 'Mach-O');
    assert.equal(initialCtx.gate3a.status, 'unpatched');
    assert.equal(initialCtx.gate3a.defaultLimit, 256000);
    assert.equal(initialCtx.gate3b.status, 'unpatched');
    assert.equal(initialCtx.gate3b.origHex, '60000037');

    // Apply fixed 512,000
    const resFixed = enhance.applyEnhancePatch(
      { contextMode: 'fixed', contextLimitTokens: 512000 },
      opts
    );
    assert.equal(resFixed.ok, true);
    assert.equal(resFixed.status.summary.contextUnlock.configuredMode, 'fixed');
    assert.equal(resFixed.status.summary.contextUnlock.configuredLimitTokens, 512000);

    const ctxFixed = contextUnlock.analyzeBinary(lsPath, { backupDir, skipProcessCheck: true });
    assert.equal(ctxFixed.status, 'patched_runtime_unconfirmed');
    assert.equal(ctxFixed.gate3a.status, 'patched');
    assert.equal(ctxFixed.configuredMode, 'fixed');
    assert.equal(ctxFixed.configuredLimitTokens, 512000);
    assert.equal(ctxFixed.gate3b.status, 'patched');

    let diskBuf = fs.readFileSync(lsPath);
    assert.equal(
      contextUnlock.decodeMovzMovkArm64(diskBuf, fixture.native1MFileOff, 3),
      1000000,
      'Native unguarded 1M constant must stay untouched'
    );
    assert.equal(
      diskBuf.readUInt32LE(fixture.regionBranchFileOff),
      REGION_BRANCH_WORD,
      'ValidateAndOnboardAccount unconditional branch must stay intact'
    );

    // Switch to dynamic mode
    const resDyn = enhance.applyEnhancePatch({ contextMode: 'dynamic' }, opts);
    assert.equal(resDyn.ok, true);
    const ctxDyn = contextUnlock.analyzeBinary(lsPath, { backupDir, skipProcessCheck: true });
    assert.equal(ctxDyn.status, 'patched_runtime_unconfirmed');
    assert.equal(ctxDyn.gate3a.status, 'patched');
    assert.equal(ctxDyn.configuredMode, 'dynamic');
    assert.equal(ctxDyn.gate3a.clampState, 'DYN');
    assert.equal(ctxDyn.gate3a.defaultLimit, 256000);
    assert.equal(ctxDyn.gate3b.status, 'patched');

    // Restore all enhancements (context -> 256K), preserving Region Unlock
    const resRestore = enhance.restoreAllEnhance(opts);
    assert.equal(resRestore.ok, true);
    assert.equal(resRestore.status.summary.contextUnlock.status, 'not_patched');

    const ctxRestored = contextUnlock.analyzeBinary(lsPath, { backupDir, skipProcessCheck: true });
    assert.equal(ctxRestored.status, 'not_patched');
    assert.equal(ctxRestored.gate3a.status, 'unpatched');
    assert.equal(ctxRestored.gate3b.status, 'unpatched');

    diskBuf = fs.readFileSync(lsPath);
    assert.equal(
      diskBuf.subarray(fixture.gate3bFileOff, fixture.gate3bFileOff + 4).toString('hex'),
      '60000037',
      'Gate 3B original instruction must be cleanly restored'
    );
    assert.equal(
      contextUnlock.decodeMovzMovkArm64(diskBuf, fixture.native1MFileOff, 3),
      1000000,
      'Native unguarded 1M constant must remain untouched after restore'
    );
    assert.equal(
      diskBuf.readUInt32LE(fixture.regionBranchFileOff),
      REGION_BRANCH_WORD,
      'CRITICAL: restoreAllEnhance must NEVER revert ValidateAndOnboardAccount Region Unlock'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('context-unlock and enhance reject official Antigravity.app targets and enforce isolation guards', () => {
  const officialLs = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';

  const unlockRes = contextUnlock.applyUnlock({
    mode: 'dynamic',
    targetPath: officialLs,
    skipProcessCheck: true,
    skipCodesign: true,
  });
  assert.equal(unlockRes.ok, false);
  assert.equal(unlockRes.code, 'OFFICIAL_APP_FORBIDDEN');

  const restoreRes = contextUnlock.restoreUnlock({
    targetPath: officialLs,
    skipProcessCheck: true,
    skipCodesign: true,
  });
  assert.equal(restoreRes.ok, false);
  assert.equal(restoreRes.code, 'OFFICIAL_APP_FORBIDDEN');

  const enhOfficial = enhance.applyEnhancePatch(
    { contextMode: 'dynamic' },
    {
      targets: [{ id: 'desktop', path: officialLs }],
      skipProcessCheck: true,
      skipCodesign: true,
    }
  );
  assert.equal(enhOfficial.ok, false);
  assert.equal(enhOfficial.code, 'OFFICIAL_APP_FORBIDDEN');

  const badTargetKey = enhance.applyEnhancePatch(
    { contextMode: 'dynamic' },
    { targetPath: '/Applications/哈基米.app/Contents/Resources/bin/language_server', skipProcessCheck: true }
  );
  assert.equal(badTargetKey.ok, false);
  assert.equal(badTargetKey.code, 'INVALID_TARGET_OPTION');

  const missingTargets = enhance.applyEnhancePatch(
    { contextMode: 'dynamic' },
    { skipProcessCheck: true, stateDir: os.tmpdir() }
  );
  assert.equal(missingTargets.ok, false);
  assert.equal(missingTargets.code, 'MISSING_TARGETS');
});

function writeSyntheticGopclntab(buf, pclnBase, textVA, functions, sentinelEndOff = 0x920) {
  const fnOff = 0x100;
  const pclnOff = 0x400;

  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pclnBase);
  buf.writeBigUInt64LE(BigInt(functions.length), pclnBase + 8);
  buf.writeBigUInt64LE(textVA, pclnBase + 24);
  buf.writeBigUInt64LE(BigInt(fnOff), pclnBase + 32);
  buf.writeBigUInt64LE(BigInt(pclnOff), pclnBase + 64);

  const fnstart = pclnBase + fnOff;
  const pcln = pclnBase + pclnOff;
  const recBaseRelToPcln = (functions.length + 1) * 8 + 16;

  let nameCursor = 0;
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const nameBytes = Buffer.from(`${fn.name}\0`, 'ascii');
    nameBytes.copy(buf, fnstart + nameCursor);

    const funcoff = recBaseRelToPcln + i * 8;
    buf.writeUInt32LE(fn.entryoff, pcln + i * 8);
    buf.writeUInt32LE(funcoff, pcln + i * 8 + 4);
    buf.writeUInt32LE(fn.entryoff, pcln + funcoff);
    buf.writeInt32LE(nameCursor, pcln + funcoff + 4);

    nameCursor += nameBytes.length;
  }
  buf.writeUInt32LE(sentinelEndOff, pcln + functions.length * 8);
}

function initSyntheticMachOHeader(buf, textVA = 0x100000000n, textSize = 0x1000n, textOff = 0x1000) {
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  buf.writeUInt32LE(2, 12);
  buf.writeUInt32LE(2, 16);
  buf.writeUInt32LE(24 + 152, 20);

  buf.writeUInt32LE(0x1b, 32);
  buf.writeUInt32LE(24, 36);
  Buffer.from('aabbccddeeff00112233445566778899', 'hex').copy(buf, 40);

  buf.writeUInt32LE(0x19, 56);
  buf.writeUInt32LE(152, 60);
  buf.write('__TEXT\0', 64, 'ascii');
  buf.writeUInt32LE(1, 56 + 64);

  const sectOff = 56 + 72;
  buf.write('__text\0', sectOff, 'ascii');
  buf.write('__TEXT\0', sectOff + 16, 'ascii');
  buf.writeBigUInt64LE(textVA, sectOff + 32);
  buf.writeBigUInt64LE(textSize, sectOff + 40);
  buf.writeUInt32LE(textOff, sectOff + 48);
}

function encodeArm64BCond(cond, fromOff, toOff) {
  const imm19 = (toOff - fromOff) / 4;
  return (0x54000000 | ((imm19 & 0x7ffff) << 5) | (cond & 0x0f)) >>> 0;
}

test('meter-region-unlock dynamically locates ineligibleTiers free-tier check while leaving allowedTiers loop and missing logic safe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-region-test-'));
  try {
    const buf = Buffer.alloc(0x4000, 0);
    const textOff = 0x1000;
    initSyntheticMachOHeader(buf, 0x100000000n, 0x1000n, textOff);

    // Function list (ValidateAndOnboardAccount spans 0x100..0x400, even at shifted offsets)
    writeSyntheticGopclntab(
      buf,
      0x2000,
      0x100000000n,
      [
        { entryoff: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
        { entryoff: 0x100, name: 'exa.google/internal/authclient.ValidateAndOnboardAccount' },
        { entryoff: 0x400, name: 'exa.google/internal/pkg.afterFn' },
      ],
      0x500
    );

    const fnStart = textOff + 0x100;
    buf.writeUInt32LE(0x528e4cc9, fnStart + 0x04); // movz w9, #0x7266 ("fr" / "free-tie" hint)

    // Loop 1 (allowedTiers - BREAK_ONLY): loop exit jumps strictly == tailEnd1
    const T1 = fnStart + 0x20;
    const p1 = T1 + 0x0c;
    const tailEnd1 = p1 + 0x14;
    buf.writeUInt32LE(encodeArm64BCond(0x0a, T1, tailEnd1), T1); // b.ge tailEnd1
    buf.writeUInt32LE(0xf100251f, p1); // cmp x8, #9
    buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 4, T1), p1 + 4); // b.ne T1
    buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 8, T1), p1 + 8); // inter b.ne T1
    buf.writeUInt32LE(0x7101c95f, p1 + 0x0c); // cmp w10, #0x72 ('r')
    buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 0x10, T1), p1 + 0x10); // stage-3 b.ne T1

    // Loop 2 (ineligibleTiers - HAS_MATCH_BODY): loop exit jumps strictly > tailEnd2
    const T2 = fnStart + 0xc0;
    const p2 = T2 + 0x0c;
    const tailEnd2 = p2 + 0x14;
    buf.writeUInt32LE(encodeArm64BCond(0x0a, T2, tailEnd2 + 0x20), T2); // b.ge past match body
    buf.writeUInt32LE(0xf100251f, p2); // cmp x8, #9
    buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 4, T2), p2 + 4); // b.ne T2
    buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 8, T2), p2 + 8); // inter b.ne T2
    buf.writeUInt32LE(0x7101c95f, p2 + 0x0c); // cmp w10, #0x72 ('r')
    buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 0x10, T2), p2 + 0x10); // stage-3 b.ne T2

    const targetBin = path.join(tmp, 'FakeHakimi.app', 'Contents', 'Resources', 'bin', 'language_server');
    fs.mkdirSync(path.dirname(targetBin), { recursive: true });
    fs.writeFileSync(targetBin, buf);

    const pre = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(pre.ok, true);
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.allowedTiersCount, 1);
    assert.equal(pre.branchOffset, p2 + 4);
    const loop1Before = buf.readUInt32LE(p1 + 4);

    const applied = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'patched');
    assert.equal(applied.alreadyPatched, false);

    const diskBuf = fs.readFileSync(targetBin);
    assert.equal(diskBuf.readUInt32LE(p1 + 4), loop1Before, 'Loop 1 (allowedTiers) must stay untouched');
    assert.equal((diskBuf.readUInt32LE(p2 + 4) & 0xfc000000) >>> 0, 0x14000000, 'Loop 2 must become unconditional b');

    const post = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(post.ok, true);
    assert.equal(post.status, 'patched');

    const idempotent = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.alreadyPatched, true);

    assert.throws(
      () => regionUnlock.applyRegionUnlock('/Applications/Antigravity.app/Contents/Resources/bin/language_server'),
      /Refusing to apply region unlock official Antigravity\.app/
    );

    // When new version removes the free-tier branch pattern, analyzer fails cleanly instead of blindly patching
    const removedBuf = Buffer.from(buf);
    removedBuf.fill(0, fnStart, fnStart + 0x200);
    removedBuf.writeUInt32LE(0xd65f03c0, fnStart); // ret
    const missingPatternRes = regionUnlock.analyzeRegionUnlock(removedBuf);
    assert.equal(missingPatternRes.ok, false);
    assert.equal(missingPatternRes.code, 'PATTERN_NOT_FOUND');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('meter-cli-unlock patches offersContextWindow + AGY_CLI_AUTO_COMPACT_OVERRIDE, reports broken symlinks, and blocks official app', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cli-test-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const backupDir = path.join(tmp, 'backups');
    fs.mkdirSync(homeDir, { recursive: true });

    const buf = Buffer.alloc(0x4000, 0);
    const textOff = 0x1000;
    const textVA = 0x100000000n;
    initSyntheticMachOHeader(buf, textVA, 0x1000n, textOff);

    const functions = [
      { entryoff: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
      { entryoff: 0x100, name: 'exa.google/cli/model.SelectorModel.offersContextWindow' },
      { entryoff: 0x200, name: 'exa.google/cli/store.AutoCompactOverride' },
      { entryoff: 0x300, name: 'strings.TrimSpace' },
      { entryoff: 0x340, name: 'os.Getenv' },
      { entryoff: 0x400, name: 'exa.google/cli/pkg.d0' },
      { entryoff: 0x420, name: 'exa.google/cli/pkg.d1' },
      { entryoff: 0x440, name: 'exa.google/cli/pkg.d2' },
      { entryoff: 0x460, name: 'exa.google/cli/pkg.d3' },
      { entryoff: 0x480, name: 'exa.google/cli/pkg.d4' },
      { entryoff: 0x4a0, name: 'exa.google/cli/pkg.d5' },
      { entryoff: 0x4c0, name: 'exa.google/cli/pkg.d6' },
    ];
    writeSyntheticGopclntab(buf, 0x2000, textVA, functions, 0x500);

    // offersContextWindow initial prologue
    buf.writeUInt32LE(0xf9400b90, textOff + 0x100);
    buf.writeUInt32LE(0xd65f03c0, textOff + 0x104);

    // AutoCompactOverride stub: nop; mov x0, xzr; mov x1, xzr; bl strings.TrimSpace
    const stubFileOff = textOff + 0x220;
    cliUnlock.GETENV_STUB_ARM64.copy(buf, stubFileOff);
    buf.writeUInt32LE(
      cliUnlock.encodeBlArm64(Number(textVA) + 0x22c, Number(textVA) + 0x300),
      stubFileOff + 12
    );
    buf.writeUInt32LE(0xd65f03c0, textOff + 0x300); // strings.TrimSpace ret
    buf.writeUInt32LE(0xd65f03c0, textOff + 0x340); // os.Getenv ret

    // Literal AGY_CLI_AUTO_COMPACT_OVERRIDE in rodata
    cliUnlock.ENV_NAME.copy(buf, 0x3000);

    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });
    fs.writeFileSync(cliBin, buf);
    fs.chmodSync(cliBin, 0o755);

    const pre = cliUnlock.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(pre.ok, true);
    assert.equal(pre.found, true);
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.offersContextWindow.status, 'unpatched');
    assert.equal(pre.autoCompactEnv.status, 'unpatched');

    const res = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      mode: 'fixed',
      limitTokens: 512000,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.deepEqual(res.patchedHooks, ['offersContextWindow', 'autoCompactEnv']);

    const post = cliUnlock.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(post.status, 'patched');
    assert.equal(post.offersContextWindow.status, 'patched');
    assert.equal(post.autoCompactEnv.status, 'patched');

    const syncedCfgPath = path.join(homeDir, '.gemini', 'config', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(syncedCfgPath, 'utf8')).contextWindow, '512K');

    const second = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      mode: 'fixed',
      limitTokens: 512000,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.alreadyPatched, true);

    // Broken symlink detection on clean home without binary
    const brokenHome = path.join(tmp, 'broken-home');
    const brokenLink = path.join(brokenHome, '.antigravity', 'antigravity', 'bin', 'agy');
    fs.mkdirSync(path.dirname(brokenLink), { recursive: true });
    fs.symlinkSync('/nonexistent/agy', brokenLink);
    const brokenRes = cliUnlock.analyzeAgyCli(null, { homeDir: brokenHome, stateDir });
    assert.equal(brokenRes.found, false);
    assert.equal(brokenRes.status, 'not_found');
    assert.equal(brokenRes.brokenSymlinks.length, 1);

    const officialCli = cliUnlock.applyAgyCliUnlock({
      binaryPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      skipCodesign: true,
    });
    assert.equal(officialCli.ok, false);
    assert.equal(officialCli.code, 'OFFICIAL_APP_FORBIDDEN');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
