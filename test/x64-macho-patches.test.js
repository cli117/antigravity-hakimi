'use strict';

/**
 * Intel (x86_64) macOS support tests for the 哈基米.app region unlock engines.
 *
 * The synthetic fixture reproduces the exact instruction shapes the Go compiler emits for
 * `authclient.ValidateAndOnboardAccount` in the official darwin-x64 `language_server`:
 *
 *   allowedTiers loop (BREAK_ONLY — must never be touched)
 *     cmp  r10, 9                  ; len("free-tier")
 *     jne  <else>                  ; forward branch
 *     movabs r10, "free-tie"
 *     cmp  [r11], r10
 *     jne  <loopTop>
 *     cmp  byte [r11+8], 0x72      ; 'r'
 *     jne  <loopTop>
 *     jmp  <afterLoop>             ; match => break only
 *
 *   ineligibleTiers loop (HAS_MATCH_BODY — patch target)
 *     cmp  r11, 9
 *     jne  <loopTop>               ; <- patched to `nop; jmp <loopTop>`
 *     movabs r11, "free-tie"
 *     cmp  [r10], r11
 *     jne  <loopTop>
 *     cmp  byte [r10+8], 0x72
 *     jne  <loopTop>
 *     <region-rejection match body>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const regionUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-region-unlock.js'));
const cliUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-cli-unlock.js'));
const binaryUtils = require(path.join(ROOT, 'payload', 'dist', 'binary-utils.js'));

const CPU_TYPE_X86_64 = 0x01000007;
const TARGET_FUNC = 'exa.google/internal/authclient.ValidateAndOnboardAccount';
const FREE_TIE = Buffer.from('667265652d746965', 'hex'); // "free-tie"

function initSyntheticMachOHeader(buf, { textVA = 0x100000000n, textSize = 0x800n, textOff = 0x1000, cputype = CPU_TYPE_X86_64 } = {}) {
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cputype, 4); // cputype
  buf.writeUInt32LE(3, 8); // cpusubtype (x86_64 ALL / arm64 ALL)
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(2, 16); // ncmds: LC_UUID + LC_SEGMENT_64
  buf.writeUInt32LE(24 + 152, 20); // sizeofcmds

  buf.writeUInt32LE(0x1b, 32); // LC_UUID
  buf.writeUInt32LE(24, 36);
  Buffer.from('aabbccddeeff00112233445566778899', 'hex').copy(buf, 40);

  buf.writeUInt32LE(0x19, 56); // LC_SEGMENT_64
  buf.writeUInt32LE(152, 60);
  buf.write('__TEXT\0', 64, 'ascii');
  buf.writeUInt32LE(1, 56 + 64); // nsects

  const sectOff = 56 + 72;
  buf.write('__text\0', sectOff, 'ascii');
  buf.write('__TEXT\0', sectOff + 16, 'ascii');
  buf.writeBigUInt64LE(textVA, sectOff + 32);
  buf.writeBigUInt64LE(textSize, sectOff + 40);
  buf.writeUInt32LE(textOff, sectOff + 48);
}

function writeSyntheticGopclntab(buf, pclnBase, textVA, functions, sentinelEndOff, minLC = 0x01) {
  const fnOff = 0x100;
  const pclnOff = 0x400;

  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, minLC, 0x08]).copy(buf, pclnBase);
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

/* ---- x86-64 instruction emitters (24-bit safe offsets within the fixture) ---- */

const jneRel32 = (from, to) => {
  const b = Buffer.from([0x0f, 0x85, 0, 0, 0, 0]);
  b.writeInt32LE(to - (from + 6), 2);
  return b;
};
const jleRel32 = (from, to) => {
  const b = Buffer.from([0x0f, 0x8e, 0, 0, 0, 0]);
  b.writeInt32LE(to - (from + 6), 2);
  return b;
};
const jmpRel32 = (from, to) => {
  const b = Buffer.from([0xe9, 0, 0, 0, 0]);
  b.writeInt32LE(to - (from + 5), 1);
  return b;
};
const cmpLen9 = (modrm) => Buffer.from([0x49, 0x83, modrm, 0x09]); // cmp r11/r10, 9
const movabsFreeTie = (rex) => Buffer.concat([Buffer.from([rex, 0xba]), FREE_TIE]);

/**
 * Write one tier loop at [loopTop, loopTop + 0x80).
 * @param {Buffer} buf
 * @param {number} loopTop  branch target of the loop (loop head)
 * @param {number} p        offset of the `cmp <len>, 9` instruction
 * @param {number} loopExitDest  destination of the loop-exit conditional branch
 * @param {boolean} withMatchBody  true => ineligibleTiers (exit jumps past the body)
 */
function writeTierLoop(buf, loopTop, p, loopExitDest, withMatchBody) {
  jleRel32(loopTop, loopExitDest).copy(buf, loopTop);
  cmpLen9(0xfb).copy(buf, p); // cmp r11, 9
  jneRel32(p + 4, loopTop).copy(buf, p + 4); // jne loopTop (patch site)
  movabsFreeTie(0x49).copy(buf, p + 0x0a); // movabs r11, "free-tie"
  Buffer.from([0x4d, 0x39, 0x1a]).copy(buf, p + 0x14); // cmp [r10], r11
  jneRel32(p + 0x17, loopTop).copy(buf, p + 0x17); // jne loopTop
  Buffer.from([0x41, 0x80, 0x7a, 0x08, 0x72]).copy(buf, p + 0x1d); // cmp byte [r10+8], 'r'
  jneRel32(p + 0x22, loopTop).copy(buf, p + 0x22); // jne loopTop
  if (!withMatchBody) {
    jmpRel32(p + 0x28, loopExitDest).copy(buf, p + 0x28); // break-only
  }
}

/**
 * Build a synthetic x86_64 Mach-O `language_server` containing both tier loops.
 * Layout (absolute file offsets, __text starts at 0x1000):
 *   function body  : [0x1000, 0x1300)
 *   allowed loop   : loopTop 0x1008, cmp@0x101A, break target 0x1100
 *   ineligible loop: loopTop 0x1080, cmp@0x10B0, patch site 0x10B4
 */
function buildSyntheticX64RegionFixture() {
  const buf = Buffer.alloc(0x4000, 0x90); // pad with NOPs
  const textOff = 0x1000;
  initSyntheticMachOHeader(buf, { textOff });

  writeSyntheticGopclntab(
    buf,
    0x2000,
    0x100000000n,
    [{ entryoff: 0x000, name: TARGET_FUNC }],
    0x300,
    0x01
  );

  const fnStart = textOff;

  // --- allowedTiers loop (break-only): loop exit == break target ---
  const loopTop1 = fnStart + 0x008;
  const p1 = fnStart + 0x01a;
  writeTierLoop(buf, loopTop1, p1, fnStart + 0x100, false);
  // `jne <else>` must point forward (not at loopTop) for the break-only shape.
  jneRel32(p1 + 4, fnStart + 0x048).copy(buf, p1 + 4);

  // --- ineligibleTiers loop (match body => patch target) ---
  const loopTop2 = fnStart + 0x080;
  const p2 = fnStart + 0x0b0;
  writeTierLoop(buf, loopTop2, p2, fnStart + 0x200, true);

  return { buf, fnStart, p1, p2, loopTop1, loopTop2 };
}

test('x86_64 Mach-O: parseMachOTextSection recognises Intel slices and rejects foreign cputypes', () => {
  const { buf } = buildSyntheticX64RegionFixture();
  const macho = regionUnlock.parseMachOTextSection(buf);
  assert.equal(macho.arch, 'x86_64');
  assert.equal(macho.cputype, CPU_TYPE_X86_64);
  assert.equal(macho.textOff, 0x1000);
  assert.equal(macho.format, 'Mach-O');

  // arm64 header must still parse as arm64 so Apple Silicon keeps working.
  const armBuf = Buffer.alloc(0x100);
  initSyntheticMachOHeader(armBuf, { cputype: 0x0100000c });
  assert.equal(regionUnlock.parseMachOTextSection(armBuf).arch, 'arm64');

  // Unknown cputype is rejected with a clear message.
  const badBuf = Buffer.alloc(0x100);
  initSyntheticMachOHeader(badBuf, { cputype: 0x00000007 });
  assert.throws(() => regionUnlock.parseMachOTextSection(badBuf), /仅支持 Mach-O arm64 \/ x86_64/);

  // Universal (fat) binaries are refused rather than silently mis-patched.
  const fatBuf = Buffer.alloc(0x100);
  fatBuf.writeUInt32LE(0xcafebabe, 0);
  assert.throws(() => regionUnlock.parseMachOTextSection(fatBuf), /Universal \(fat\) Mach-O/);
});

test('x86_64 Mach-O: region unlock patches only the ineligibleTiers jne and stays idempotent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-x64-region-'));
  try {
    const { buf, fnStart, p1, p2 } = buildSyntheticX64RegionFixture();
    const targetBin = path.join(tmp, 'FakeHakimi.app', 'Contents', 'Resources', 'bin', 'language_server');
    fs.mkdirSync(path.dirname(targetBin), { recursive: true });
    fs.writeFileSync(targetBin, buf);

    const pre = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(pre.ok, true, pre.error);
    assert.equal(pre.arch, 'x86-64');
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.allowedTiersCount, 1);
    assert.equal(pre.hasFreeTieConst, true);
    assert.equal(pre.branchOffset, p2 + 4);
    assert.equal(pre.branchLength, 6);
    assert.equal(pre.targetOffset, fnStart + 0x080);
    assert.equal(pre.currentBytes.toString('hex'), '0f85' + buf.subarray(p2 + 6, p2 + 10).toString('hex'));

    const allowedBefore = Buffer.from(buf.subarray(p1 + 4, p1 + 10));

    const applied = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.status, 'patched');
    assert.equal(applied.alreadyPatched, false);

    const diskBuf = fs.readFileSync(targetBin);
    // ineligible loop: `0f 85` -> `90 e9` (NOP + unconditional jmp), displacement preserved.
    assert.equal(diskBuf[p2 + 4], 0x90);
    assert.equal(diskBuf[p2 + 5], 0xe9);
    assert.equal(diskBuf.readInt32LE(p2 + 6), buf.readInt32LE(p2 + 6));
    // allowedTiers loop must stay byte-identical.
    assert.deepEqual(
      Buffer.from(diskBuf.subarray(p1 + 4, p1 + 10)),
      allowedBefore,
      'allowedTiers loop must stay untouched'
    );

    const post = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(post.ok, true, post.error);
    assert.equal(post.status, 'patched');
    assert.equal(post.allowedTiersCount, 1);

    const idempotent = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.alreadyPatched, true);
    assert.deepEqual(fs.readFileSync(targetBin), diskBuf, 're-applying must not change bytes');

    assert.throws(
      () => regionUnlock.applyRegionUnlock('/Applications/Antigravity.app/Contents/Resources/bin/language_server'),
      /Refusing to apply region unlock official Antigravity\.app/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('x86_64 Mach-O: analyzer refuses ambiguous sites, missing patterns, and tampered allowedTiers', () => {
  const { buf, fnStart, p1 } = buildSyntheticX64RegionFixture();

  // 1. No free-tier check at all -> PATTERN_NOT_FOUND
  const stripped = Buffer.from(buf);
  stripped.fill(0x90, fnStart, fnStart + 0x300);
  const missing = regionUnlock.analyzeRegionUnlock(stripped);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PATTERN_NOT_FOUND');

  // 2. Two ineligible loops -> AMBIGUOUS_MATCH (refuse rather than guess)
  const dup = Buffer.from(buf);
  writeTierLoop(dup, fnStart + 0x180, fnStart + 0x1b0, fnStart + 0x2a0, true);
  const ambiguous = regionUnlock.analyzeRegionUnlock(dup);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_MATCH');

  // 3. allowedTiers loop already rewritten to an unconditional jmp -> refuse
  const tampered = Buffer.from(buf);
  tampered[p1 + 4] = 0x90;
  tampered[p1 + 5] = 0xe9;
  const corrupted = regionUnlock.analyzeRegionUnlock(tampered);
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.code, 'ALLOWED_TIERS_MODIFIED');
});

test('x86_64 Mach-O: short-form `jne rel8` site patches to `jmp rel8` in place', () => {
  // Real Go loops sometimes use rel8 branches; the 2-byte path must work too.
  const buf = Buffer.alloc(0x4000, 0x90);
  const textOff = 0x1000;
  initSyntheticMachOHeader(buf, { textOff });
  writeSyntheticGopclntab(buf, 0x2000, 0x100000000n, [{ entryoff: 0x000, name: TARGET_FUNC }], 0x300, 0x01);

  const fnStart = textOff;
  const loopTop = fnStart + 0x020;
  const p = fnStart + 0x060;

  // loop exit `jle rel8` -> past the match body (rel8 must stay within ±127 bytes)
  Buffer.from([0x7e, 0x00]).copy(buf, loopTop);
  buf[loopTop + 1] = fnStart + 0x0a0 - (loopTop + 2);

  cmpLen9(0xfb).copy(buf, p); // cmp r11, 9
  buf[p + 4] = 0x75; // jne rel8 -> loopTop  (patch site)
  buf[p + 5] = loopTop - (p + 6);
  movabsFreeTie(0x49).copy(buf, p + 0x0a);
  Buffer.from([0x4d, 0x39, 0x1a]).copy(buf, p + 0x14);
  buf[p + 0x17] = 0x75; // jne loopTop
  buf[p + 0x18] = loopTop - (p + 0x19);
  Buffer.from([0x41, 0x80, 0x7a, 0x08, 0x72]).copy(buf, p + 0x1d);
  buf[p + 0x22] = 0x75; // jne loopTop
  buf[p + 0x23] = loopTop - (p + 0x24);

  const res = regionUnlock.analyzeRegionUnlock(buf);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.branchOffset, p + 4);
  assert.equal(res.branchLength, 2);
  assert.equal(res.currentBytes[0], 0x75);
  assert.equal(res.patchedBytes[0], 0xeb);
  assert.equal(res.patchedBytes[1], res.currentBytes[1]);
});

test('x86_64 Mach-O: agy CLI unlock path patches Intel slices and reports the arch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-x64-cli-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const backupDir = path.join(tmp, 'backups');
    fs.mkdirSync(homeDir, { recursive: true });

    const { buf, p1, p2 } = buildSyntheticX64RegionFixture();
    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });
    fs.writeFileSync(cliBin, buf);
    fs.chmodSync(cliBin, 0o755);

    const pre = cliUnlock.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(pre.ok, true);
    assert.equal(pre.found, true);
    assert.equal(pre.format, 'Mach-O');
    assert.equal(pre.arch, 'x86_64');
    assert.equal(pre.status, 'unpatched');

    const res = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    assert.deepEqual(res.patchedHooks, ['ValidateAndOnboardAccount']);
    assert.match(res.message, /Mach-O x86_64/);

    const diskBuf = fs.readFileSync(cliBin);
    assert.equal(diskBuf[p2 + 5], 0xe9);
    assert.equal(diskBuf[p1 + 5], 0x85, 'allowedTiers loop must stay untouched');

    const second = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.alreadyPatched, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('binary-utils normalizes arch labels and keeps the shared x64 analyzer container-agnostic', () => {
  assert.equal(binaryUtils.normalizeRegionArch('x86_64'), 'x86-64');
  assert.equal(binaryUtils.normalizeRegionArch('amd64'), 'x86-64');
  assert.equal(binaryUtils.normalizeRegionArch('x64'), 'x86-64');
  assert.equal(binaryUtils.normalizeRegionArch('arm64'), 'arm64');
  assert.equal(binaryUtils.normalizeRegionArch('aarch64'), 'arm64');
  assert.equal(binaryUtils.normalizeRegionArch(''), 'x86-64');

  const { buf, fnStart } = buildSyntheticX64RegionFixture();
  const fnEnd = fnStart + 0x300;
  const viaX64 = binaryUtils.analyzeX64RegionInRange(buf, fnStart, fnEnd, TARGET_FUNC);
  const viaDispatch = binaryUtils.analyzeRegionInRangeByArch(buf, fnStart, fnEnd, TARGET_FUNC, 'x86_64');
  assert.equal(viaX64.ok, true);
  assert.equal(viaDispatch.ok, true);
  assert.equal(viaDispatch.branchOffset, viaX64.branchOffset);
  assert.equal(viaDispatch.arch, 'x86-64');
});
