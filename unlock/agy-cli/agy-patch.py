#!/usr/bin/env python3
"""Apply adaptive region unlock to the agy CLI on macOS (arm64 / x86_64 Mach-O) and Linux (x86-64 / arm64 ELF64, PIE & non-PIE).

Patches authclient.ValidateAndOnboardAccount to bypass the ineligibleTiers "free-tier" check
while leaving allowedTiers untouched.

Usage:
    agy-patch.py [--binary PATH] [--dry-run] [--in-place]
    agy-patch.py [--binary PATH] --locate      # print symbols, change nothing

Without --in-place the result is written to PATH.patched (and ad-hoc signed on macOS).
"""

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys

PCLNTAB_MAGICS = (0xFFFFFFF1, 0xFFFFFFF0)
FREE_TIE = bytes.fromhex("667265652d746965")
FUNC_REGION = "authclient.ValidateAndOnboardAccount"


class PatchError(Exception):
    pass


def sxt(val, bits):
    mask = 1 << (bits - 1)
    return (val & (mask - 1)) - (val & mask)


def read_cstr(data, off, limit=2048):
    if off < 0 or off >= len(data):
        return ""
    end = data.find(b"\x00", off, min(len(data), off + limit))
    if end < 0:
        end = min(len(data), off + limit)
    return data[off:end].decode("utf-8", "replace")


def parse_container(data):
    if len(data) < 64:
        raise PatchError("file too small to be a valid executable")
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return _macho_container(data)
    if data[:4] == b"\x7fELF":
        return _elf_container(data)
    if data[:2] == b"MZ":
        return _pe_container(data)
    raise PatchError("unrecognised container (want Mach-O, ELF64 or PE)")


def _macho_container(data):
    ncmds = struct.unpack_from("<I", data, 16)[0]
    cputype = struct.unpack_from("<I", data, 4)[0]
    arch = "arm64" if cputype == 0x0100000C else ("x86-64" if cputype == 0x01000007 else None)
    if arch is None:
        raise PatchError(f"unsupported Mach-O cputype {cputype:#x}")
    off = 32
    for _ in range(ncmds):
        if off + 8 > len(data):
            break
        cmd, size = struct.unpack_from("<II", data, off)
        if size < 8 or off + size > len(data):
            break
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            sect = off + 72
            for _ in range(nsects):
                if sect + 80 > off + size:
                    break
                if data[sect:sect + 16].rstrip(b"\0") == b"__text":
                    addr, sz, offset = struct.unpack_from("<QQI", data, sect + 32)
                    return {
                        "format": "Mach-O",
                        "arch": arch,
                        "text_va": addr,
                        "text_off": offset,
                        "text_size": sz,
                        "rela_dyn": None,
                        "sections": [],
                    }
                sect += 80
        off += size
    raise PatchError("__text section not found")


def _elf_container(data):
    if data[4] != 2 or data[5] != 1:
        raise PatchError("only 64-bit little-endian ELF is handled")
    machine = struct.unpack_from("<H", data, 18)[0]
    arch = {0xB7: "arm64", 0x3E: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported ELF machine {machine:#x}")
    shoff = struct.unpack_from("<Q", data, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 58)
    if not shoff or shentsize < 64 or shnum == 0 or shstrndx >= shnum:
        raise PatchError("ELF missing valid section headers")
    shstr_entry = shoff + shstrndx * shentsize
    if shstr_entry + 64 > len(data):
        raise PatchError("ELF shstrtab entry out of bounds")
    strtab_off = struct.unpack_from("<Q", data, shstr_entry + 24)[0]

    sections = []
    by_name = {}
    for i in range(shnum):
        sh = shoff + i * shentsize
        if sh + 64 > len(data):
            break
        nameoff, _stype, _sflags, addr, offset, size = struct.unpack_from("<IIQQQQ", data, sh)
        name = read_cstr(data, strtab_off + nameoff, 256)
        sec = (name, addr, offset, size)
        sections.append(sec)
        if name and name not in by_name:
            by_name[name] = sec

    if ".text" not in by_name:
        raise PatchError(".text section not found")
    _, text_va, text_off, text_size = by_name[".text"]
    return {
        "format": "ELF64",
        "arch": arch,
        "text_va": text_va,
        "text_off": text_off,
        "text_size": text_size,
        "rela_dyn": by_name.get(".rela.dyn"),
        "sections": sections,
    }


def _pe_container(data):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise PatchError("bad PE signature")
    machine = struct.unpack_from("<H", data, pe + 4)[0]
    arch = {0xAA64: "arm64", 0x8664: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported PE machine {machine:#x}")
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    image_base = struct.unpack_from("<Q", data, opt + 24)[0]
    sect = opt + opt_size
    for _ in range(nsec):
        name = data[sect:sect + 8].rstrip(b"\0")
        if name == b".text":
            vsize, vaddr, _rawsize, rawptr = struct.unpack_from("<IIII", data, sect + 8)
            return {
                "format": "PE",
                "arch": arch,
                "text_va": image_base + vaddr,
                "text_off": rawptr,
                "text_size": vsize,
                "rela_dyn": None,
                "sections": [],
            }
        sect += 40
    raise PatchError(".text section not found")


def file_off_to_va(container, file_off):
    if container["format"] == "ELF64":
        for _nm, sa, so, ss in container["sections"]:
            if ss > 0 and sa > 0 and so <= file_off < so + ss:
                return sa + (file_off - so)
        return file_off
    return container["text_va"] - container["text_off"] + file_off


def _resolve_elf_go_text_base(data, container, pcln_off, text_start):
    tva = container["text_va"]
    toff = container["text_off"]
    tsz = container["text_size"]
    if tva <= text_start < tva + tsz:
        return text_start, toff + (text_start - tva), "pclntab_header"

    rela_sec = container["rela_dyn"]
    if rela_sec and rela_sec[3] >= 24:
        pcln_va = file_off_to_va(container, pcln_off)
        _, _, roff, rsz = rela_sec
        rend = min(len(data), roff + rsz)
        needle = struct.pack("<Q", pcln_va)
        pos = roff
        while pos < rend:
            hit = data.find(needle, pos, rend)
            if hit < 0:
                break
            pos = hit + 8
            if (hit - roff) % 24 != 16:
                continue
            mva = struct.unpack_from("<Q", data, hit - 16)[0]
            cands = {}

            def scan_range(start_off, end_off):
                for q in range(start_off, end_off - 23, 24):
                    ro, _, ra = struct.unpack_from("<QQq", data, q)
                    if mva <= ro < mva + 0x160 and tva <= ra < tva + tsz:
                        cands[ra] = cands.get(ra, 0) + 1

            scan_range(max(roff, hit - 16 - 24 * 64), min(rend, hit - 16 + 24 * 128))
            if not cands:
                scan_range(roff, rend)
            if cands:
                best_va = sorted(cands.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                return best_va, toff + (best_va - tva), "rela_firstmoduledata"

    return tva, toff, "text_section_start"


def build_functions(data, container):
    """Locate authclient.ValidateAndOnboardAccount from .gopclntab, resolving PIE ELF64 text base when needed."""
    minlc = 4 if container["arch"] == "arm64" else 1
    for magic in PCLNTAB_MAGICS:
        pat = struct.pack("<I", magic) + bytes([0, 0, minlc, 8])
        pos = 0
        while True:
            base = data.find(pat, pos)
            if base < 0:
                break
            pos = base + 4
            if base + 72 > len(data):
                continue
            nfunc = struct.unpack_from("<Q", data, base + 8)[0]
            text_start = struct.unpack_from("<Q", data, base + 24)[0]
            fn_off = struct.unpack_from("<Q", data, base + 32)[0]
            pcln_off = struct.unpack_from("<Q", data, base + 64)[0]
            if not (1 <= nfunc < 5_000_000):
                continue
            ft = base + pcln_off
            fnm = base + fn_off
            if pcln_off <= 0 or fn_off <= 0 or ft + (nfunc + 1) * 8 > len(data) or fnm >= len(data):
                continue

            if container["format"] == "ELF64":
                go_tva, go_toff, source = _resolve_elf_go_text_base(data, container, base, text_start)
            else:
                go_tva, go_toff, source = container["text_va"], container["text_off"], "text_section_start"

            found = {}
            for k in range(nfunc):
                eo, fo = struct.unpack_from("<II", data, ft + k * 8)
                frec = ft + fo
                if frec + 8 > len(data):
                    continue
                no = struct.unpack_from("<i", data, frec + 4)[0]
                if no < 0 or fnm + no >= len(data):
                    continue
                nm = read_cstr(data, fnm + no, 512)
                if nm == FUNC_REGION or nm.endswith("/" + FUNC_REGION) or nm.endswith("." + FUNC_REGION):
                    neo = struct.unpack_from("<I", data, ft + (k + 1) * 8)[0]
                    found[FUNC_REGION] = {
                        "name": nm,
                        "entryoff": eo,
                        "next_entryoff": neo,
                        "size": max(0, neo - eo),
                        "fn_start": go_toff + eo,
                        "fn_end": go_toff + neo,
                        "fn_va": go_tva + eo,
                    }
                    break

            return found, go_tva, go_toff, source, nfunc

    raise PatchError("Go .gopclntab not found")


def analyze_region_x64(b, fn_s, fn_e):
    cands = []
    seen = set()
    for p in range(fn_s, fn_e - 24):
        if (b[p] in (0x48, 0x49)) and b[p + 1] == 0x83 and (b[p + 2] & 0xF8) == 0xF8 and b[p + 3] == 0x09:
            clen = 4
        elif b[p] == 0x83 and (b[p + 1] & 0xF8) == 0xF8 and b[p + 2] == 0x09 and not (p > fn_s and b[p - 1] in (0x48, 0x49)):
            clen = 3
        else:
            continue
        jo = p + clen
        if jo in seen or jo + 2 > fn_e:
            continue
        b0, b1 = b[jo], b[jo + 1]
        if b0 == 0x0F and b1 == 0x85 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "unpatched", jo + 6 + r32, b"\x90\xe9" + bytes(b[jo + 2:jo + 6])
        elif b0 == 0x90 and b1 == 0xE9 and jo + 6 <= fn_e:
            r32 = struct.unpack_from("<i", b, jo + 2)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 6 + r32, bytes(b[jo:jo + 6])
        elif b0 == 0xE9 and jo + 6 <= fn_e and b[jo + 5] == 0x90:
            r32 = struct.unpack_from("<i", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 6, "patched", jo + 5 + r32, bytes(b[jo:jo + 6])
        elif b0 == 0x75:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "unpatched", jo + 2 + r8, bytes([0xEB, b[jo + 1]])
        elif b0 == 0xEB:
            r8 = struct.unpack_from("<b", b, jo + 1)[0]
            jlen, st, tgt, pbytes = 2, "patched", jo + 2 + r8, bytes(b[jo:jo + 2])
        else:
            continue
        fi = b.find(FREE_TIE, jo + jlen, min(fn_e, jo + jlen + 24))
        if fi < 0:
            continue
        tail_end, ltop = None, None
        for q in range(fi + 8, min(fn_e - 6, fi + 0x30)):
            nq = -1
            if b[q] == 0x80 and (b[q + 1] & 0xF8) == 0x78 and b[q + 2] == 0x08 and b[q + 3] == 0x72:
                nq = q + 4
            elif b[q] == 0x80 and b[q + 1] == 0x7C and b[q + 3] == 0x08 and b[q + 4] == 0x72:
                nq = q + 5
            if nq < 0 or nq + 2 > fn_e:
                continue
            tt, te = None, None
            if b[nq] == 0x0F and b[nq + 1] == 0x85 and nq + 6 <= fn_e:
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
            if b[r] == 0x0F and 0x80 <= b[r + 1] <= 0x8F and r + 6 <= fn_e:
                d = r + 6 + struct.unpack_from("<i", b, r + 2)[0]
            elif 0x70 <= b[r] <= 0x7F:
                d = r + 2 + struct.unpack_from("<b", b, r + 1)[0]
            if d is not None and tail_end <= d < fn_e:
                exits.append(d)
        if not exits:
            continue
        imm_brk = None
        if tail_end + 2 <= fn_e and b[tail_end] == 0xEB:
            imm_brk = tail_end + 2 + struct.unpack_from("<b", b, tail_end + 1)[0]
        elif tail_end + 5 <= fn_e and b[tail_end] == 0xE9:
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
        return o + sxt((w >> 5) & 0x7FFFF, 19) * 4 if (w & 0xFF00001F) == 0x54000001 else None

    def dec_cb(w, o):
        return o + sxt((w >> 5) & 0x7FFFF, 19) * 4 if (w & 0xFF000010) == 0x54000000 else None

    def dec_b(w, o):
        return o + sxt(w & 0x03FFFFFF, 26) * 4 if (w & 0xFC000000) == 0x14000000 else None

    cands = []
    for p in range(fn_s, fn_e - 20, 4):
        w0, w1 = struct.unpack_from("<II", b, p)
        if (w0 & 0x7FFFFC1F) != 0x7100241F:
            continue
        t_off = dec_bne(w1, p + 4)
        st = "unpatched" if t_off is not None else None
        if t_off is None:
            t_off = dec_b(w1, p + 4)
            if t_off is not None:
                st = "patched"
        if t_off is None or not (fn_s <= t_off < p):
            continue
        te, inter = None, 0
        for q in range(p + 8, min(fn_e - 8, p + 0x48) + 1, 4):
            wq0, wq1 = struct.unpack_from("<II", b, q)
            if (wq0 & 0x7FFFFC1F) == 0x7101C81F and dec_bne(wq1, q + 4) == t_off:
                te = q + 8
                break
            if dec_bne(wq0, q) == t_off:
                inter += 1
        if te is None or inter < 1:
            continue
        exits = []
        for r in range(t_off, min(p, t_off + 0x30), 4):
            d = dec_cb(struct.unpack_from("<I", b, r)[0], r)
            if d is not None and d >= te:
                exits.append(d)
        if not exits:
            continue
        has_body = any(d > te for d in exits)
        is_brk = all(d == te for d in exits)
        cands.append((p + 4, st, t_off, has_body, is_brk))
    inel = [c for c in cands if c[3]]
    alw = [c for c in cands if c[4] and not c[3]]
    if len(inel) != 1 or any(c[1] != "unpatched" for c in alw):
        return None
    bo, st, t_off = inel[0][0], inel[0][1], inel[0][2]
    off26 = (t_off - bo) // 4
    pbytes = struct.pack("<I", (0x14000000 | (off26 & 0x03FFFFFF)) & 0xFFFFFFFF)
    return bo, st, pbytes


def patch_region(data, funcs, arch):
    if FUNC_REGION not in funcs:
        raise PatchError(f"{FUNC_REGION}: symbol not found")
    fn = funcs[FUNC_REGION]
    fn_s = fn["fn_start"]
    fn_e = min(len(data), fn["fn_end"])
    hit = analyze_region_a64(data, fn_s, fn_e) if arch == "arm64" else analyze_region_x64(data, fn_s, fn_e)
    if hit is None:
        raise PatchError(f"{FUNC_REGION}: present but free-tier branch pattern could not be matched safely")
    bo, st, pbytes = hit
    if st == "patched":
        return False, f"{FUNC_REGION}: already patched (@ file {bo:#x})"
    data[bo:bo + len(pbytes)] = pbytes
    verify = analyze_region_a64(data, fn_s, fn_e) if arch == "arm64" else analyze_region_x64(data, fn_s, fn_e)
    if verify is None or verify[0] != bo or verify[1] != "patched":
        raise PatchError(f"{FUNC_REGION}: in-memory verification failed after patching")
    return True, f"{FUNC_REGION}: patched free-tier branch @ file {bo:#x} ({pbytes.hex(' ')})"


def assert_not_official_antigravity(path):
    real_path = os.path.realpath(os.path.abspath(path))
    forbidden_roots = (
        "/Applications/Antigravity.app",
        "/Applications/Antigravity.app.orig",
    )
    for root in forbidden_roots:
        if real_path == root or real_path.startswith(root + "/"):
            raise PatchError(f"Refusing to access official Antigravity bundle: {real_path}")


def is_supported_executable(path):
    try:
        st = os.stat(path)
        if not os.path.isfile(path) or st.st_size < 64:
            return False
        with open(path, "rb") as fh:
            hdr = fh.read(6)
        if len(hdr) < 6:
            return False
        if hdr[:4] == b"\xcf\xfa\xed\xfe":
            return True
        if hdr[:4] == b"\x7fELF" and hdr[4] == 2 and hdr[5] == 1:
            return True
        if hdr[:2] == b"MZ":
            return True
    except OSError:
        return False
    return False


def detect_default_agy_binary():
    home = os.path.expanduser("~")
    candidates = []
    if os.environ.get("AGY_CLI_BIN"):
        candidates.append(os.environ["AGY_CLI_BIN"])
    candidates.extend([
        os.path.join(home, ".local", "bin", "agy"),
        os.path.join(home, ".antigravity", "antigravity", "bin", "agy"),
        os.path.join(home, ".antigravity", "bin", "agy"),
        os.path.join(home, "bin", "agy"),
    ])
    which_agy = shutil.which("agy")
    if which_agy:
        candidates.append(which_agy)
    if sys.platform == "darwin":
        candidates.append("/opt/homebrew/bin/agy")
    candidates.extend(["/usr/local/bin/agy", "/usr/bin/agy"])

    seen = set()
    for cand in candidates:
        absp = os.path.abspath(os.path.expanduser(cand))
        if absp in seen:
            continue
        seen.add(absp)
        if not os.path.exists(absp):
            continue
        realp = os.path.realpath(absp)
        try:
            assert_not_official_antigravity(realp)
        except PatchError:
            continue
        if is_supported_executable(realp):
            return realp
    return os.path.expanduser("~/.local/bin/agy")


def resign(path, container_format):
    if sys.platform != "darwin" or container_format != "Mach-O":
        print("[i] non-Mach-O or non-macOS target: no ad-hoc signing step applied")
        return
    subprocess.run(["codesign", "--force", "--sign", "-", "--options", "runtime", path],
                   check=True, capture_output=True)
    subprocess.run(["codesign", "--verify", "--verbose=1", path],
                   check=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=None, help="path to agy CLI binary (auto-detected if omitted)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--locate", action="store_true", help="print symbols only")
    args = ap.parse_args()

    src_arg = args.binary if args.binary else detect_default_agy_binary()
    src = os.path.abspath(os.path.expanduser(src_arg))
    assert_not_official_antigravity(src)
    if not os.path.exists(src):
        sys.exit(f"no such file: {src}")
    src_real = os.path.realpath(src)
    assert_not_official_antigravity(src_real)

    with open(src_real, "rb") as fh:
        data = bytearray(fh.read())
    before = hashlib.sha256(data).hexdigest()

    container = parse_container(bytes(data))
    funcs, go_tva, go_toff, go_src, total_syms = build_functions(bytes(data), container)
    arch = container["arch"]
    print(f"[i] {src_real}\n[i] format={container['format']} arch={arch} "
          f"go_text_va={go_tva:#x} go_text_off={go_toff:#x} ({go_src}) symbols={total_syms}")

    if FUNC_REGION in funcs:
        print(f"[i] {FUNC_REGION} -> va={funcs[FUNC_REGION]['fn_va']:#x} off={funcs[FUNC_REGION]['fn_start']:#x}")
    else:
        print(f"[i] {FUNC_REGION} -> MISSING")

    if args.locate:
        return

    ok, msg = patch_region(data, funcs, arch)
    print(("[*] " if ok else "[=] ") + msg)

    after = hashlib.sha256(bytes(data)).hexdigest()
    if args.dry_run:
        if before == after:
            print("[=] dry run: nothing to change")
        else:
            print(f"[*] dry run: {before[:12]} -> {after[:12]}")
        return

    dst = src_real if args.in_place else src + ".patched"
    if before != after:
        assert_not_official_antigravity(dst)
        tmp_dst = f"{dst}.hakimi_tmp_{os.getpid()}"
        try:
            with open(tmp_dst, "wb") as fh:
                fh.write(data)
            os.chmod(tmp_dst, 0o755)
            os.replace(tmp_dst, dst)
            resign(dst, container["format"])
        finally:
            if os.path.exists(tmp_dst):
                try:
                    os.unlink(tmp_dst)
                except OSError:
                    pass
        print(f"[*] wrote {dst}\n    sha256 {before[:12]} -> {after[:12]}")
    else:
        print("[=] binary already up to date")


if __name__ == "__main__":
    try:
        main()
    except PatchError as exc:
        sys.exit(f"error: {exc}")
