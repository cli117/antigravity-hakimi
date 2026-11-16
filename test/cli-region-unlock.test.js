'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../payload/dist/meter-cli-unlock');

function branch(from, to, condition = 1) {
  return (0x54000000 | (((to - from) / 4 & 0x7ffff) << 5) | condition) >>> 0;
}

function fixture() {
  const buf = Buffer.alloc(0x6000);
  const textOff = 0x1000;
  const textVA = 0x100000000n;
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  buf.writeUInt32LE(2, 12);
  buf.writeUInt32LE(1, 16);
  buf.writeUInt32LE(152, 20);
  buf.writeUInt32LE(0x19, 32);
  buf.writeUInt32LE(152, 36);
  buf.write('__TEXT', 40);
  buf.writeUInt32LE(1, 96);
  buf.write('__text', 104);
  buf.write('__TEXT', 120);
  buf.writeBigUInt64LE(textVA, 136);
  buf.writeBigUInt64LE(0x1000n, 144);
  buf.writeUInt32LE(textOff, 152);

  const funcs = [
    [0, 'internal/abi.(*RegArgs).Dump'],
    [0x100, 'example/cli/model.SelectorModel.offersContextWindow'],
    [0x200, 'example/authclient.ValidateAndOnboardAccount'],
    ...Array.from({ length: 10 }, (_, i) => [0x500 + i * 0x20, `example/pkg.d${i}`]),
  ];
  const base = 0x3000;
  const names = base + 0x100;
  const table = base + 0x800;
  Buffer.from('f1ffffff00000408', 'hex').copy(buf, base);
  buf.writeBigUInt64LE(BigInt(funcs.length), base + 8);
  buf.writeBigUInt64LE(textVA, base + 24);
  buf.writeBigUInt64LE(0x100n, base + 32);
  buf.writeBigUInt64LE(0x800n, base + 64);
  let cursor = 0;
  funcs.forEach(([entry, name], index) => {
    const record = (funcs.length + 1) * 8 + 16 + index * 8;
    buf.write(name + '\0', names + cursor, 'ascii');
    buf.writeUInt32LE(entry, table + index * 8);
    buf.writeUInt32LE(record, table + index * 8 + 4);
    buf.writeUInt32LE(entry, table + record);
    buf.writeInt32LE(cursor, table + record + 4);
    cursor += Buffer.byteLength(name) + 1;
  });
  buf.writeUInt32LE(0x800, table + funcs.length * 8);
  buf.writeUInt32LE(0xf9400b90, textOff + 0x100);
  buf.writeUInt32LE(0xd65f03c0, textOff + 0x104);
  const fnStart = textOff + 0x200;
  buf.writeUInt32LE(0x528e4cc9, fnStart + 4);
  const loops = [fnStart + 0x20, fnStart + 0xc0];
  for (const [index, loop] of loops.entries()) {
    const cmp = loop + 12;
    const tail = cmp + 20;
    buf.writeUInt32LE(branch(loop, tail + (index ? 32 : 0), 10), loop);
    buf.writeUInt32LE(0xf100251f, cmp);
    buf.writeUInt32LE(branch(cmp + 4, loop), cmp + 4);
    buf.writeUInt32LE(branch(cmp + 8, loop), cmp + 8);
    buf.writeUInt32LE(0x7101c95f, cmp + 12);
    buf.writeUInt32LE(branch(cmp + 16, loop), cmp + 16);
  }
  return { buf, fnStart, allowedBranch: loops[0] + 16, regionBranch: loops[1] + 16 };
}

function inWorkspace(fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-region-test-'));
  try {
    const input = fixture();
    input.source = path.join(work, 'agy');
    input.output = path.join(work, 'copy');
    fs.writeFileSync(input.source, input.buf, { mode: 0o755 });
    fn(work, input);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('CLI apply consumes the App analyzer branchOffset/patchedWord contract', () => inWorkspace((work, input) => {
  const options = {
    binaryPath: input.source,
    homeDir: path.join(work, 'home'),
    stateDir: path.join(work, 'state'),
    skipBackup: true,
    skipCodesign: true,
    syncConfigFiles: false,
  };
  const pre = cli.analyzeAgyCli(input.source, options);
  assert.equal(pre.regionUnlock.status, 'unpatched');
  assert.equal(pre.regionUnlock.branchOffset, input.regionBranch);
  assert.equal(pre.regionUnlock.targetSite, undefined);
  const result = cli.applyAgyCliUnlock(options);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.patchedHooks.includes('ValidateAndOnboardAccount'));
  assert.equal(result.analysis.regionUnlock.status, 'patched');
  const after = fs.readFileSync(input.source);
  assert.equal(after.readUInt32LE(input.regionBranch), pre.regionUnlock.patchedWord);
  assert.equal(after.readUInt32LE(input.allowedBranch), input.buf.readUInt32LE(input.allowedBranch));
}));

test('CLI apply refuses a present but unrecognised region function before writing', () => inWorkspace((work, input) => {
  input.buf.fill(0, input.fnStart, input.fnStart + 0x300);
  fs.writeFileSync(input.source, input.buf);
  const result = cli.applyAgyCliUnlock({
    binaryPath: input.source, homeDir: path.join(work, 'home'), stateDir: path.join(work, 'state'),
    skipBackup: true, skipCodesign: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATTERN_NOT_FOUND');
  assert.deepEqual(fs.readFileSync(input.source), input.buf);
  assert.equal(fs.existsSync(path.join(work, 'home')), false);
}));
