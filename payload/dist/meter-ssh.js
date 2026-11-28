'use strict';
/**
 * Remote SSH Integration Engine for 哈基米.app
 * - Adaptive Linux ELF64 (x86-64 & arm64) Region Unlock (ValidateAndOnboardAccount)
 * - Bootstrap script decorator for dist/remote/bootstrapScript.js (auto-patches remote language_server)
 * - In-memory SSH remote session registry & Electron session-routed Connect RPC transport
 *
 * Strictly read-only toward official Antigravity.app; zero System Prompt modifications.
 */

const fs = require('fs');
const path = require('path');
const {
  sha256Buffer,
  readCString,
  scanGopclntabBySuffix,
  analyzeArm64RegionInRange,
  analyzeX64RegionInRange,
} = require('./binary-utils');

const TARGET_REGION_FUNC = 'authclient.ValidateAndOnboardAccount';

// ============================================================================
// 1. Pure Node.js Linux ELF64 (x86-64 & arm64) Adaptive Region Analyzer & Patcher
// ============================================================================

function parseElf64(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error('目标文件过小，非有效 ELF64 可执行文件');
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('非 ELF 二进制文件');
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error(`仅支持 64-bit 小端 ELF (class=${buf[4]}, data=${buf[5]})`);
  }
  const eMachine = buf.readUInt16LE(18);
  const arch = eMachine === 62 ? 'x86-64' : eMachine === 183 ? 'arm64' : null;
  if (!arch) {
    throw new Error(`不支持的 ELF 架构 e_machine=${eMachine}`);
  }
  const eShoff = Number(buf.readBigUInt64LE(40));
  const eShentsize = buf.readUInt16LE(58);
  const eShnum = buf.readUInt16LE(60);
  const eShstrndx = buf.readUInt16LE(62);
  if (!eShoff || eShentsize < 64 || eShnum === 0 || eShstrndx >= eShnum) {
    throw new Error('ELF 缺少有效的 Section Header 表');
  }
  const shstrEntryOff = eShoff + eShstrndx * eShentsize;
  if (shstrEntryOff + 64 > buf.length) {
    throw new Error('ELF shstrtab 表项越界');
  }
  const shstrOff = Number(buf.readBigUInt64LE(shstrEntryOff + 24));
  const sections = [];
  const byName = Object.create(null);

  for (let i = 0; i < eShnum; i++) {
    const off = eShoff + i * eShentsize;
    if (off + 64 > buf.length) break;
    const shName = buf.readUInt32LE(off);
    const shType = buf.readUInt32LE(off + 4);
    const shAddr = Number(buf.readBigUInt64LE(off + 16));
    const shOffset = Number(buf.readBigUInt64LE(off + 24));
    const shSize = Number(buf.readBigUInt64LE(off + 32));
    const name = readCString(buf, shstrOff + shName, 256);
    const sec = { name, type: shType, addr: shAddr, offset: shOffset, size: shSize };
    sections.push(sec);
    if (name && !byName[name]) byName[name] = sec;
  }

  const textSec = byName['.text'];
  if (!textSec || textSec.size <= 0) {
    throw new Error('ELF 中未找到 .text 段');
  }

  return {
    format: 'ELF64',
    arch,
    textVA: textSec.addr,
    textOff: textSec.offset,
    textSize: textSec.size,
    relaDyn: byName['.rela.dyn'] || null,
    sections,
    byName,
  };
}

function fileOffToVA(elf, fileOff) {
  for (const sec of elf.sections) {
    if (sec.size > 0 && sec.addr > 0 && fileOff >= sec.offset && fileOff < sec.offset + sec.size) {
      return sec.addr + (fileOff - sec.offset);
    }
  }
  return fileOff;
}

function resolveElfGoTextBase(buf, elf, pclnOff, textStartFromHeader) {
  const { textVA, textOff, textSize } = elf;
  if (
    Number.isFinite(textStartFromHeader) &&
    textStartFromHeader >= textVA &&
    textStartFromHeader < textVA + textSize
  ) {
    return {
      goTextVA: textStartFromHeader,
      goTextOff: textOff + (textStartFromHeader - textVA),
      source: 'pclntab_header',
    };
  }

  // PIE Go ELF binaries leave pcHeader.textStart == 0 and store runtime.text via .rela.dyn in firstmoduledata
  if (elf.relaDyn && elf.relaDyn.size >= 24) {
    const pclnVA = fileOffToVA(elf, pclnOff);
    const needle = Buffer.alloc(8);
    needle.writeBigUInt64LE(BigInt(pclnVA), 0);
    const rOff = elf.relaDyn.offset;
    const rEnd = Math.min(buf.length, rOff + elf.relaDyn.size);

    let pos = rOff;
    while (pos < rEnd) {
      const hit = buf.indexOf(needle, pos);
      if (hit < 0 || hit >= rEnd) break;
      pos = hit + 8;
      if ((hit - rOff) % 24 !== 16) continue;
      const moddataVA = Number(buf.readBigUInt64LE(hit - 16));
      const candidates = new Map();
      const scanRange = (start, end) => {
        for (let p = start; p + 24 <= end; p += 24) {
          const ro = Number(buf.readBigUInt64LE(p));
          if (ro >= moddataVA && ro < moddataVA + 0x160) {
            const ra = Number(buf.readBigInt64LE(p + 16));
            if (ra >= textVA && ra < textVA + textSize) {
              candidates.set(ra, (candidates.get(ra) || 0) + 1);
            }
          }
        }
      };
      const winStart = Math.max(rOff, hit - 16 - 24 * 64);
      const winEnd = Math.min(rEnd, hit - 16 + 24 * 128);
      scanRange(winStart, winEnd);
      if (candidates.size === 0) {
        scanRange(rOff, rEnd);
      }
      if (candidates.size > 0) {
        let bestVA = null;
        let bestCount = -1;
        for (const [va, cnt] of candidates.entries()) {
          if (cnt > bestCount || (cnt === bestCount && va < bestVA)) {
            bestVA = va;
            bestCount = cnt;
          }
        }
        return {
          goTextVA: bestVA,
          goTextOff: textOff + (bestVA - textVA),
          source: 'rela_firstmoduledata',
        };
      }
    }
  }

  return {
    goTextVA: textVA,
    goTextOff: textOff,
    source: 'text_section_start',
  };
}

function findElfGoFunctions(buf, elf, targetSuffixes, options = {}) {
  const minLC = elf.arch === 'arm64' ? 0x04 : 0x01;
  return scanGopclntabBySuffix(buf, targetSuffixes, {
    minLC,
    maxNfunc: options.maxNfunc ?? 5000000,
    resolveBase: (pclnOff, textStart) => resolveElfGoTextBase(buf, elf, pclnOff, textStart),
  });
}

// x86-64 adaptive analyzer + branch decoder live in ./binary-utils (shared with macOS Mach-O x86_64).

function analyzeElfRegionUnlock(filePathOrBuf) {
  const buf = Buffer.isBuffer(filePathOrBuf) ? filePathOrBuf : fs.readFileSync(String(filePathOrBuf));
  const sha256 = sha256Buffer(buf);
  let elf;
  try {
    elf = parseElf64(buf);
  } catch (e) {
    return { ok: false, status: 'unsupported', code: 'INVALID_ELF', sha256, error: e.message };
  }
  const goInfo = findElfGoFunctions(buf, elf, [TARGET_REGION_FUNC]);
  if (!goInfo.foundPcln) {
    return { ok: false, status: 'pclntab_missing', code: 'PCLNTAB_NOT_FOUND', sha256, error: '找不到 Go .gopclntab 符号表' };
  }
  const fn = goInfo.funcs[TARGET_REGION_FUNC];
  if (!fn) {
    return { ok: false, status: 'symbol_missing', code: 'SYMBOL_NOT_FOUND', sha256, error: `找不到 ${TARGET_REGION_FUNC}` };
  }
  const fnStart = Math.max(elf.textOff, fn.fnStart);
  const fnEnd = Math.min(buf.length, fn.fnEnd);
  if (fnEnd <= fnStart + 24) {
    return { ok: false, status: 'pattern_missing', code: 'FUNCTION_TOO_SMALL', fnName: fn.name, sha256, error: '函数体过短' };
  }
  const res =
    elf.arch === 'arm64'
      ? analyzeArm64RegionInRange(buf, fnStart, fnEnd, fn.name)
      : analyzeX64RegionInRange(buf, fnStart, fnEnd, fn.name);
  return { ...res, format: 'ELF64', goTextSource: goInfo.goTextSource, sha256 };
}

function patchElfBuffer(inputBuf) {
  const buf = Buffer.from(inputBuf);
  const reg = analyzeElfRegionUnlock(buf);
  let regionResult = reg;
  let modified = false;

  if (reg.ok && reg.status === 'unpatched') {
    reg.patchedBytes.copy(buf, reg.branchOffset);
    regionResult = { ...reg, status: 'patched', changed: true };
    modified = true;
  } else if (reg.ok) {
    regionResult = { ...reg, changed: false };
  }

  return {
    ok: Boolean(regionResult?.ok),
    modified,
    buffer: buf,
    region: regionResult,
  };
}

function patchElfBinaryFile(filePath) {
  const target = path.resolve(String(filePath || ''));
  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: `找不到目标 ELF 文件: ${filePath}` };
  }
  const input = fs.readFileSync(target);
  const res = patchElfBuffer(input);
  if (res.modified) {
    const tmpPath = `${target}.hakimi_tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, res.buffer);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, target);
  }
  return {
    ok: res.ok,
    modified: res.modified,
    region: res.region,
  };
}

// ============================================================================
// 2. Embedded Self-Contained Python3 Remote ELF64 Region Patcher & Bootstrap Decorator
// ============================================================================

function getRemotePythonPatcherSource() {
  return `import json, os, struct, sys

FREE_TIE = bytes.fromhex("667265652d746965")

def sxt(v, bits):
    m = 1 << (bits - 1)
    return (v & (m - 1)) - (v & m)

def cstr(b, off, lim=2048):
    if off < 0 or off >= len(b):
        return ""
    e = b.find(b"\\x00", off, min(len(b), off + lim))
    if e < 0:
        e = min(len(b), off + lim)
    return b[off:e].decode("utf-8", "replace")

def parse_elf64(b):
    if len(b) < 64 or b[:4] != b"\\x7fELF" or b[4] != 2 or b[5] != 1:
        raise RuntimeError("not ELF64 LE")
    em = struct.unpack_from("<H", b, 18)[0]
    arch = "x86-64" if em == 62 else ("arm64" if em == 183 else None)
    if not arch:
        raise RuntimeError(f"unsupported arch {em}")
    shoff = struct.unpack_from("<Q", b, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", b, 58)
    shstr_off = struct.unpack_from("<Q", b, shoff + shstrndx * shentsize + 24)[0]
    secs = []
    by_name = {}
    for idx in range(shnum):
        o = shoff + idx * shentsize
        if o + 64 > len(b):
            break
        sn, st, sf, sa, so, ss = struct.unpack_from("<IIQQQQ", b, o)
        nm = cstr(b, shstr_off + sn, 256)
        sec = (nm, sa, so, ss)
        secs.append(sec)
        if nm and nm not in by_name:
            by_name[nm] = sec
    if ".text" not in by_name:
        raise RuntimeError("missing .text")
    return arch, by_name[".text"], by_name.get(".rela.dyn"), secs

def find_go_funcs(b, arch, text_sec, rela_sec, secs, targets):
    _, tva, toff, tsz = text_sec
    minlc = 4 if arch == "arm64" else 1
    for mg in (bytes([0xf1, 0xff, 0xff, 0xff, 0, 0, minlc, 8]), bytes([0xf0, 0xff, 0xff, 0xff, 0, 0, minlc, 8])):
        pos = 0
        while True:
            i = b.find(mg, pos)
            if i < 0:
                break
            pos = i + 4
            if i + 72 > len(b):
                continue
            nfunc = struct.unpack_from("<Q", b, i + 8)[0]
            tstart = struct.unpack_from("<Q", b, i + 24)[0]
            fn_off = struct.unpack_from("<Q", b, i + 32)[0]
            pcln_off = struct.unpack_from("<Q", b, i + 64)[0]
            if not (1 <= nfunc < 500000):
                continue
            ft = i + pcln_off
            fnm = i + fn_off
            if pcln_off <= 0 or fn_off <= 0 or ft + (nfunc + 1) * 8 > len(b) or fnm >= len(b):
                continue
            go_tva = tva
            if tva <= tstart < tva + tsz:
                go_tva = tstart
            elif rela_sec and rela_sec[3] >= 24:
                pcln_va = i
                for _, sa, so, ss in secs:
                    if ss > 0 and sa > 0 and so <= i < so + ss:
                        pcln_va = sa + (i - so)
                        break
                _, _, roff, rsz = rela_sec
                rend = min(len(b), roff + rsz)
                ndl = struct.pack("<Q", pcln_va)
                p = roff
                found_va = None
                while p < rend:
                    hit = b.find(ndl, p, rend)
                    if hit < 0:
                        break
                    p = hit + 8
                    if (hit - roff) % 24 != 16:
                        continue
                    mva = struct.unpack_from("<Q", b, hit - 16)[0]
                    cands = {}
                    def scan_r(s, e):
                        for q in range(s, e - 23, 24):
                            ro, _, ra = struct.unpack_from("<QQq", b, q)
                            if mva <= ro < mva + 0x160 and tva <= ra < tva + tsz:
                                cands[ra] = cands.get(ra, 0) + 1
                    scan_r(max(roff, hit - 16 - 24 * 64), min(rend, hit - 16 + 24 * 128))
                    if not cands:
                        scan_r(roff, rend)
                    if cands:
                        found_va = sorted(cands.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                        break
                if found_va is not None:
                    go_tva = found_va
            go_toff = toff + (go_tva - tva)
            found = {}
            for k in range(nfunc):
                eo, fo = struct.unpack_from("<II", b, ft + k * 8)
                frec = ft + fo
                if frec + 8 > len(b):
                    continue
                no = struct.unpack_from("<i", b, frec + 4)[0]
                if no < 0 or fnm + no >= len(b):
                    continue
                nm = cstr(b, fnm + no)
                for suf in targets:
                    if suf not in found and (nm == suf or nm.endswith("/" + suf) or nm.endswith("." + suf)):
                        neo = struct.unpack_from("<I", b, ft + (k + 1) * 8)[0]
                        found[suf] = (nm, eo, neo, go_toff + eo, go_toff + neo, go_tva + eo)
            return found
    return None

def analyze_region_x64(b, fn_s, fn_e):
    cands = []
    seen = set()
    for p in range(fn_s, fn_e - 24):
        if (b[p] in (0x48, 0x49)) and b[p+1] == 0x83 and (b[p+2] & 0xf8) == 0xf8 and b[p+3] == 0x09:
            clen = 4
        elif b[p] == 0x83 and (b[p+1] & 0xf8) == 0xf8 and b[p+2] == 0x09 and not (p > fn_s and b[p-1] in (0x48, 0x49)):
            clen = 3
        else:
            continue
        jo = p + clen
        if jo in seen or jo + 2 > fn_e:
            continue
        b0, b1 = b[jo], b[jo+1]
        if b0 == 0x0f and b1 == 0x85 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "unpatched", jo + 6 + r32, b"\\x90\\xe9" + b[jo+2:jo+6]
        elif b0 == 0x90 and b1 == 0xe9 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 6 + r32, bytes(b[jo:jo+6])
        elif b0 == 0xe9 and jo + 6 <= fn_e and b[jo+5] == 0x90:
            r32 = struct.unpack_from("<i", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 5 + r32, bytes(b[jo:jo+6])
        elif b0 == 0x75:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "unpatched", jo + 2 + r8, bytes([0xeb, b[jo+1]])
        elif b0 == 0xeb:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "patched", jo + 2 + r8, bytes(b[jo:jo+2])
        else:
            continue
        fi = b.find(FREE_TIE, jo + jlen, min(fn_e, jo + jlen + 24))
        if fi < 0:
            continue
        tail_end, ltop = None, None
        for q in range(fi + 8, min(fn_e - 6, fi + 0x30)):
            nq = -1
            if b[q] == 0x80 and (b[q+1] & 0xf8) == 0x78 and b[q+2] == 0x08 and b[q+3] == 0x72:
                nq = q + 4
            elif b[q] == 0x80 and b[q+1] == 0x7c and b[q+3] == 0x08 and b[q+4] == 0x72:
                nq = q + 5
            if nq < 0 or nq + 2 > fn_e:
                continue
            tt, te = None, None
            if b[nq] == 0x0f and b[nq+1] == 0x85 and nq + 6 <= fn_e:
                tt = nq + 6 + struct.unpack_from("<i", b, nq + 2)[0]
                te = nq + 6
            elif b[nq] == 0x75:
                tt = nq + 2 + struct.unpack_from("<b", b, nq + 1)[0]
                te = nq + 2
            if tt is not None and fn_s <= tt < p:
                ltop, tail_end = tt, te
                break
        if tail_end is None:
            continue
        exits = []
        for r in range(ltop, min(p, ltop + 0x48) - 2):
            d = None
            if b[r] == 0x0f and 0x80 <= b[r+1] <= 0x8f and r + 6 <= fn_e:
                d = r + 6 + struct.unpack_from("<i", b, r + 2)[0]
            elif 0x70 <= b[r] <= 0x7f:
                d = r + 2 + struct.unpack_from("<b", b, r + 1)[0]
            if d is not None and tail_end <= d < fn_e:
                exits.append(d)
        if not exits:
            continue
        imm_brk = None
        if tail_end + 2 <= fn_e and b[tail_end] == 0xeb:
            imm_brk = tail_end + 2 + struct.unpack_from("<b", b, tail_end + 1)[0]
        elif tail_end + 5 <= fn_e and b[tail_end] == 0xe9:
            imm_brk = tail_end + 5 + struct.unpack_from("<i", b, tail_end + 1)[0]
        is_brk = imm_brk is not None and imm_brk in exits
        has_body = (not is_brk) and tgt == ltop and any(d > tail_end + 0x10 for d in exits)
        seen.add(jo)
        cands.append((jo, st, pbytes, has_body, is_brk))
    inel = [c for c in cands if c[3]]
    alw = [c for c in cands if c[4] and not c[3]]
    if len(inel) != 1 or any(c[1] != "unpatched" for c in alw):
        return None
    return inel[0][0], inel[0][1], inel[0][2]

def analyze_region_a64(b, fn_s, fn_e):
    def dec_bne(w, o):
        return o + sxt((w >> 5) & 0x7ffff, 19) * 4 if (w & 0xff00001f) == 0x54000001 else None
    def dec_cb(w, o):
        return o + sxt((w >> 5) & 0x7ffff, 19) * 4 if (w & 0xff000010) == 0x54000000 else None
    def dec_b(w, o):
        return o + sxt(w & 0x03ffffff, 26) * 4 if (w & 0xfc000000) == 0x14000000 else None
    cands = []
    for p in range(fn_s, fn_e - 20, 4):
        w0, w1 = struct.unpack_from("<II", b, p)
        if (w0 & 0x7ffffc1f) != 0x7100241f:
            continue
        T = dec_bne(w1, p + 4)
        st = "unpatched" if T is not None else None
        if T is None:
            T = dec_b(w1, p + 4)
            if T is not None:
                st = "patched"
        if T is None or not (fn_s <= T < p):
            continue
        te, inter = None, 0
        for q in range(p + 8, min(fn_e - 8, p + 0x48) + 1, 4):
            wq0, wq1 = struct.unpack_from("<II", b, q)
            if (wq0 & 0x7ffffc1f) == 0x7101c81f and dec_bne(wq1, q + 4) == T:
                te = q + 8
                break
            if dec_bne(wq0, q) == T:
                inter += 1
        if te is None or inter < 1:
            continue
        exits = []
        for r in range(T, min(p, T + 0x30), 4):
            d = dec_cb(struct.unpack_from("<I", b, r)[0], r)
            if d is not None and d >= te:
                exits.append(d)
        if not exits:
            continue
        has_body = any(d > te for d in exits)
        is_brk = all(d == te for d in exits)
        cands.append((p + 4, st, T, has_body, is_brk))
    inel = [c for c in cands if c[3]]
    alw = [c for c in cands if c[4] and not c[3]]
    if len(inel) != 1 or any(c[1] != "unpatched" for c in alw):
        return None
    bo, st, T = inel[0][0], inel[0][1], inel[0][2]
    off26 = (T - bo) // 4
    pbytes = struct.pack("<I", (0x14000000 | (off26 & 0x03ffffff)) & 0xffffffff)
    return bo, st, pbytes

def main():
    args = sys.argv[1:]
    analyze_only = "--analyze" in args
    pos = [a for a in args if a != "--analyze"]
    bin_path = pos[0]
    with open(bin_path, "rb") as f:
        data = bytearray(f.read())
    arch, tsec, rsec, secs = parse_elf64(data)
    targets = ["authclient.ValidateAndOnboardAccount"]
    funcs = find_go_funcs(data, arch, tsec, rsec, secs, targets)
    if not funcs:
        raise RuntimeError("gopclntab not found")
    fn_reg = funcs.get(targets[0])
    if not fn_reg:
        raise RuntimeError("ValidateAndOnboardAccount not found")
    reg_hit = analyze_region_a64(data, fn_reg[3], min(len(data), fn_reg[4])) if arch == "arm64" else analyze_region_x64(data, fn_reg[3], min(len(data), fn_reg[4]))
    if not reg_hit:
        raise RuntimeError("region free-tier branch not found")
    reg_off, reg_st, reg_bytes = reg_hit
    changed = False
    if not analyze_only and reg_st == "unpatched":
        data[reg_off:reg_off+len(reg_bytes)] = reg_bytes
        changed = True
    if not analyze_only and changed:
        tmp_path = f"{bin_path}.hakimi_tmp.{os.getpid()}"
        with open(tmp_path, "wb") as tf:
            tf.write(data)
        os.chmod(tmp_path, 0o755)
        os.replace(tmp_path, bin_path)
    print(json.dumps({
        "ok": True,
        "arch": arch,
        "analyzeOnly": analyze_only,
        "region": {"status": "patched" if (not analyze_only) else reg_st, "offset": hex(reg_off)},
        "changed": changed,
    }))

if __name__ == "__main__":
    main()
`;
}

function buildRemoteBootstrapHookShell() {
  const spec = 'v2|region=1';
  const pyB64 = Buffer.from(getRemotePythonPatcherSource(), 'utf8').toString('base64');

  // POSIX sh compatible (dash/bash/ash), strict `set -u` safe, ZERO writes to stdout!
  return `
# --- Hakimi Remote SSH Auto-Unlock (Region) ---
hakimi_want_spec='${spec}'
hakimi_py_b64='${pyB64}'

hakimi_can_patch() {
  command -v python3 >/dev/null 2>&1
}

hakimi_stamp_matches() {
  hakimi_stf="$1.hakimi_stamp"
  [ -f "$hakimi_stf" ] || return 1
  hakimi_cur=$(cat "$hakimi_stf" 2>/dev/null) || return 1
  [ "$hakimi_cur" = "$hakimi_want_spec" ]
}

hakimi_skip_matches() {
  hakimi_skf="$1.hakimi_skip"
  [ -f "$hakimi_skf" ] || return 1
  hakimi_sk=$(cat "$hakimi_skf" 2>/dev/null) || return 1
  hakimi_sz=$(wc -c <"$1" 2>/dev/null | tr -d ' ') || hakimi_sz=0
  [ "$hakimi_sk" = "$hakimi_want_spec|$hakimi_sz" ]
}

hakimi_patch_bin() {
  hakimi_target=$1
  [ -z "\${agy_serverpath:-}" ] || return 0
  [ -f "$hakimi_target" ] || return 0
  if hakimi_stamp_matches "$hakimi_target"; then
    return 0
  fi
  if hakimi_skip_matches "$hakimi_target"; then
    return 0
  fi
  hakimi_log="\${agy_datadir:-/tmp}/hakimi-patch.log"
  mkdir -p "\${agy_datadir:-/tmp}" 2>/dev/null || true
  if ! hakimi_can_patch; then
    printf '[hakimi] python3 not found; skipping remote patch for %s\\n' "$hakimi_target" >>"$hakimi_log" 2>&1
    return 0
  fi
  hakimi_py_file="\${agy_bindir:-/tmp}/.hakimi_patch.$$.py"
  if printf '%s' "$hakimi_py_b64" | base64 -d >"$hakimi_py_file" 2>>"$hakimi_log" ||
     python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.argv[2]))' "$hakimi_py_file" "$hakimi_py_b64" 2>>"$hakimi_log"; then
    if python3 "$hakimi_py_file" "$hakimi_target" >>"$hakimi_log" 2>&1; then
      printf '%s\\n' "$hakimi_want_spec" >"$hakimi_target.hakimi_stamp" 2>/dev/null || true
      rm -f "$hakimi_target.hakimi_skip" 2>/dev/null || true
    else
      hakimi_sz=$(wc -c <"$hakimi_target" 2>/dev/null | tr -d ' ') || hakimi_sz=0
      printf '%s|%s\\n' "$hakimi_want_spec" "$hakimi_sz" >"$hakimi_target.hakimi_skip" 2>/dev/null || true
      printf '[hakimi] patch failed (non-fatal) for %s\\n' "$hakimi_target" >>"$hakimi_log" 2>&1
    fi
  fi
  rm -f "$hakimi_py_file" 2>/dev/null || true
  return 0
}

hakimi_maybe_replace_unpatched() {
  [ -z "\${agy_serverpath:-}" ] || return 0
  [ -z "\${agy_rep_pid:-}" ] || return 0
  [ "\${agy_attach_only:-0}" != 1 ] || return 0
  hakimi_can_patch || return 0
  agy_read_disc || return 0
  agy_is_ls_pid "$agy_dpid" || return 0
  hakimi_exe=$(readlink "/proc/$agy_dpid/exe" 2>/dev/null) || hakimi_exe=
  if [ "$hakimi_exe" = "$agy_bin" ] && hakimi_stamp_matches "$agy_bin"; then
    return 0
  fi
  if [ "$hakimi_exe" = "$agy_bin" ] && hakimi_skip_matches "$agy_bin"; then
    return 0
  fi
  # Running server is unpatched or uses an outdated Hakimi spec: trigger Antigravity's native locked replace flow
  agy_rep_pid=$agy_dpid
  agy_rep_ver=$agy_dver
}

agy_check_paths() {
  set -- "$agy_root" "$agy_root/bin" "$agy_datadir" "$agy_daemon" "$agy_disc"
  [ -n "$agy_serverpath" ] || set -- "$@" "$agy_bindir" "$agy_bin"
  for agy_f do
    [ -e "$agy_f" ] || continue
    [ -O "$agy_f" ] ||
      agy_fail INSTALL_FAILED "$agy_f is not owned by you"
  done
  hakimi_maybe_replace_unpatched || true
}

agy_prepare() {
  if [ -n "$agy_serverpath" ]; then
    agy_check_server_path
  else
    mkdir -p "$agy_bindir" 2>/dev/null ||
      agy_fail INSTALL_FAILED "cannot create $agy_bindir"
    agy_install
    hakimi_patch_bin "$agy_bin" || true
  fi
}
`;
}

function decorateBootstrapScript(script) {
  if (typeof script !== 'string' || !script) return script;
  if (script.includes('hakimi_patch_bin()')) return script;
  const hookShell = buildRemoteBootstrapHookShell();
  const anchor = '\nagy_main; exit $?';
  const idx = script.lastIndexOf(anchor);
  if (idx >= 0) {
    return `${script.slice(0, idx)}\n${hookShell}${script.slice(idx)}`;
  }
  return `${script}\n${hookShell}`;
}

// ============================================================================
// 3. Runtime SSH Session Registry & Electron Session-Routed Connect RPC
// ============================================================================

const remoteSessions = new Map();

function normalizeHttpsLoopbackOrigin(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

function recordRemoteSession(entry, sshSession) {
  try {
    const hostId = entry?.hostId;
    if (!hostId || !sshSession) return null;
    const origin = normalizeHttpsLoopbackOrigin(sshSession.url);
    const csrfToken = String(sshSession?.discovery?.csrfToken || '').trim();
    const info = {
      hostId: String(hostId),
      label: String(entry?.label || hostId),
      origin,
      csrfToken,
      pid: Number(sshSession?.discovery?.pid || 0) || null,
      lsVersion: String(sshSession?.discovery?.lsVersion || ''),
      socksPort: Number(sshSession?.socksPort || 0) || null,
      updatedAt: Date.now(),
    };
    remoteSessions.set(String(hostId), info);
    return info;
  } catch {
    return null;
  }
}

function forgetRemoteSession(hostId) {
  if (!hostId) return false;
  return remoteSessions.delete(String(hostId));
}

function getRemoteSession(hostId) {
  if (!hostId) return null;
  return remoteSessions.get(String(hostId)) || null;
}

function getRemoteBackendForSender(sender) {
  if (!sender) return null;
  try {
    const wb = require('./remote/windowBackends');
    if (wb && typeof wb.remoteBackendOf === 'function') {
      const info = wb.remoteBackendOf(sender);
      if (info && info.kind === 'ssh' && info.hostId) return info;
    }
  } catch {}
  return null;
}

function getRemoteBackendForWindow(win) {
  if (!win) return null;
  try {
    const wb = require('./remote/windowBackends');
    if (wb && typeof wb.remoteBackendOfWindow === 'function') {
      const info = wb.remoteBackendOfWindow(win);
      if (info && info.kind === 'ssh' && info.hostId) return info;
    }
  } catch {}
  return null;
}

function createRemoteSessionRequester(sender, sessionInfo, expectedOrigin = null) {
  const ses = sender?.session;
  const origin = normalizeHttpsLoopbackOrigin(expectedOrigin || sessionInfo?.origin);
  const csrfToken = String(sessionInfo?.csrfToken || '').trim();

  if (!ses || typeof ses.fetch !== 'function') {
    throw new Error('SSH 窗口 Electron session 不可用，无法通过代理访问远端语言服务');
  }
  if (!origin) {
    throw new Error('SSH 远端语言服务地址无效');
  }
  if (!csrfToken) {
    throw new Error('SSH 远端 CSRF Token 尚未就绪，请等待连接完成或重连');
  }

  return {
    origin,
    hostId: sessionInfo?.hostId || null,
    label: sessionInfo?.label || null,
    csrfToken,
    call: async (method, body = {}) => {
      const url = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await ses.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
          redirect: 'manual',
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`SSH Remote API HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  TARGET_REGION_FUNC,
  parseElf64,
  fileOffToVA,
  findElfGoFunctions,
  analyzeElfRegionUnlock,
  patchElfBuffer,
  patchElfBinaryFile,
  getRemotePythonPatcherSource,
  buildRemoteBootstrapHookShell,
  decorateBootstrapScript,
  recordRemoteSession,
  forgetRemoteSession,
  getRemoteSession,
  getRemoteBackendForSender,
  getRemoteBackendForWindow,
  createRemoteSessionRequester,
};
