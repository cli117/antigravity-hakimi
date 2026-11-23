#!/usr/bin/env python3
"""Unlock the agy CLI on macOS (arm64 Mach-O) and Linux (x86-64 / arm64 ELF64, PIE & non-PIE).

Patches applied when matching symbols are present:
1. model.SelectorModel.offersContextWindow (arm64 & x86-64)
   Exposes context window selector options for all models in /model.
2. store.AutoCompactOverride (arm64 only, optional)
   Restores os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE") when constant-folded.
3. authclient.ValidateAndOnboardAccount (arm64 & x86-64, adaptive)
   Bypasses the ineligibleTiers "free-tier" region check while leaving allowedTiers untouched.
4. utils.GetCheckpointConfig + config.applyFeatureProviderCheckpointOverrideConfig (Gate 3A / 3B)
   Applies dynamic / fixed / default checkpoint context window policy without reverting region unlock.

Usage:
    agy-patch.py [--binary PATH] [--mode dynamic|fixed|default] [--limit TOKENS]
                 [--no-env-fix] [--no-region] [--no-sync-config] [--dry-run] [--in-place]
    agy-patch.py [--binary PATH] --locate      # print symbols, change nothing

Without --in-place the result is written to PATH.patched (and ad-hoc signed on macOS).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys

PCLNTAB_MAGICS = (0xFFFFFFF1, 0xFFFFFFF0)
ENV_NAME = b"AGY_CLI_AUTO_COMPACT_OVERRIDE"
FREE_TIE = bytes.fromhex("667265652d746965")

FUNC_OFFERS = "model.SelectorModel.offersContextWindow"
FUNC_OVERRIDE = "store.AutoCompactOverride"
FUNC_TRIM = "strings.TrimSpace"
FUNC_GETENV = "os.Getenv"
FUNC_REGION = "authclient.ValidateAndOnboardAccount"
FUNC_CHECKPOINT = "utils.GetCheckpointConfig"
FUNC_EXP = "config.applyFeatureProviderCheckpointOverrideConfig"
FUNC_SELECT = "config.selectCheckpointExperimentKey"

TARGET_FUNCS = (
    FUNC_OFFERS,
    FUNC_OVERRIDE,
    FUNC_TRIM,
    FUNC_GETENV,
    FUNC_REGION,
    FUNC_CHECKPOINT,
    FUNC_EXP,
    FUNC_SELECT,
)

RET_TRUE_ARM64 = struct.pack("<II", 0x52800020, 0xD65F03C0)      # mov w0,#1 ; ret
RET_TRUE_X64 = bytes.fromhex("b801000000c3")                     # mov eax,1 ; ret
GETENV_STUB_ARM64 = struct.pack("<III", 0xD503201F, 0xAA1F03E0, 0xAA1F03E1)

CLAMP_X64 = bytes.fromhex("81fa00e80300be00e803000f42f2")
DYN_X64 = bytes.fromhex("89d6") + b"\x90" * 12
DEF_ORIG_X64 = bytes.fromhex("c7400c00e80300")

NOP_A64 = bytes.fromhex("1f2003d5")
DYN_A64 = NOP_A64 * 6
CLAMP_A64 = bytes.fromhex("04009dd26400a0f27f00046b04009dd26400a0f26330849a")
DEF_ORIG_A64 = bytes.fromhex("03009dd26300a0f2030c00b9")
DEF_GUARD_A64 = bytes.fromhex("7f0000718c000054")
STR_W3_A64 = bytes.fromhex("030c00b9")

MIN_LIM = 16384
MAX_LIM = 2097152


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


def enc_mov_a64(reg, val):
    lo = val & 0xFFFF
    hi = (val >> 16) & 0xFFFF
    rd = reg & 0x1F
    return struct.pack(
        "<II",
        (0xD2800000 | (lo << 5) | rd) & 0xFFFFFFFF,
        (0xF2A00000 | (hi << 5) | rd) & 0xFFFFFFFF,
    )


def dec_mov_a64(data, off, reg):
    if off < 0 or off + 8 > len(data):
        return None
    w0, w1 = struct.unpack_from("<II", data, off)
    rd = reg & 0x1F
    if (w0 & 0xFFE0001F) != (0xD2800000 | rd) or (w1 & 0xFFE0001F) != (0xF2A00000 | rd):
        return None
    return (((w1 >> 5) & 0xFFFF) << 16) | ((w0 >> 5) & 0xFFFF)


# --------------------------------------------------------------------------
# binary container parsing (Mach-O, ELF64 PIE/non-PIE, PE)
# --------------------------------------------------------------------------

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
    """Locate target Go functions from .gopclntab, resolving PIE ELF64 text base when needed."""
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
                for suf in TARGET_FUNCS:
                    if suf not in found and (nm == suf or nm.endswith("/" + suf) or nm.endswith("." + suf)):
                        neo = struct.unpack_from("<I", data, ft + (k + 1) * 8)[0]
                        found[suf] = {
                            "name": nm,
                            "entryoff": eo,
                            "next_entryoff": neo,
                            "size": max(0, neo - eo),
                            "fn_start": go_toff + eo,
                            "fn_end": go_toff + neo,
                            "fn_va": go_tva + eo,
                        }
                if len(found) >= len(TARGET_FUNCS):
                    break

            return found, go_tva, go_toff, source, nfunc

    raise PatchError("Go .gopclntab not found")


# --------------------------------------------------------------------------
# Patch 1: model.SelectorModel.offersContextWindow
# --------------------------------------------------------------------------

def patch_offers(data, funcs, arch):
    if FUNC_OFFERS not in funcs:
        raise PatchError(f"symbol not found: {FUNC_OFFERS}")
    fn = funcs[FUNC_OFFERS]
    blob = RET_TRUE_ARM64 if arch == "arm64" else RET_TRUE_X64
    off = fn["fn_start"]
    if off < 0 or off + len(blob) > len(data):
        raise PatchError(f"{FUNC_OFFERS}: entry offset out of bounds")
    if bytes(data[off:off + len(blob)]) == blob:
        return False, f"{FUNC_OFFERS}: already patched"
    data[off:off + len(blob)] = blob
    return True, f"{FUNC_OFFERS}: entry {fn['fn_va']:#x} -> return true ({blob.hex(' ')})"


# --------------------------------------------------------------------------
# Patch 2: store.AutoCompactOverride (arm64 only, optional)
# --------------------------------------------------------------------------

def encode_adrp(rd, pc, target):
    delta = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12
    if not -(1 << 20) <= delta < (1 << 20):
        raise PatchError("adrp target out of range")
    imm21 = delta & 0x1FFFFF
    return 0x90000000 | ((imm21 & 3) << 29) | ((imm21 >> 2) << 5) | rd


def encode_add_imm(rd, rn, imm12):
    if not 0 <= imm12 <= 0xFFF:
        raise PatchError("add immediate out of range")
    return 0x91000000 | (imm12 << 10) | (rn << 5) | rd


def encode_movz64(rd, imm16):
    return 0xD2800000 | (imm16 << 5) | rd


def encode_bl(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("bl target out of range")
    return 0x94000000 | ((delta >> 2) & 0x3FFFFFF)


def patch_env(data, funcs, container):
    if container["arch"] != "arm64":
        raise PatchError(f"env-var patch is arm64-only (current arch={container['arch']})")
    for needed in (FUNC_OVERRIDE, FUNC_TRIM, FUNC_GETENV):
        if needed not in funcs:
            raise PatchError(f"symbol not found: {needed}")

    fn_ov = funcs[FUNC_OVERRIDE]
    start = fn_ov["fn_start"]
    site_va = fn_ov["fn_va"]
    body_len = min(max(512, fn_ov["size"] or 512), len(data) - start)
    body = bytes(data[start:start + body_len])

    name_off = data.find(ENV_NAME)
    if name_off < 0:
        raise PatchError("env var name missing from rodata")
    target = file_off_to_va(container, name_off)
    getenv_va = funcs[FUNC_GETENV]["fn_va"]
    trim_va = funcs[FUNC_TRIM]["fn_va"]

    hits = [m.start() for m in re.finditer(re.escape(GETENV_STUB_ARM64), body)]
    if len(hits) != 1:
        for rel in range(0, body_len - 15, 4):
            try:
                expected = struct.pack(
                    "<IIII",
                    encode_adrp(0, site_va + rel, target),
                    encode_add_imm(0, 0, target & 0xFFF),
                    encode_movz64(1, len(ENV_NAME)),
                    encode_bl(site_va + rel + 12, getenv_va),
                )
            except PatchError:
                continue
            if body[rel:rel + 16] == expected:
                return False, f"{FUNC_OVERRIDE}: already patched"
        raise PatchError(f"{FUNC_OVERRIDE}: expected 1 folded Getenv stub, found {len(hits)}")

    site = start + hits[0]
    bl_site = site + 12
    old_bl = struct.unpack_from("<I", data, bl_site)[0]
    if old_bl & 0xFC000000 != 0x94000000:
        raise PatchError("expected bl after the stub")
    bl_pc = site_va + hits[0] + 12
    cur = bl_pc + sxt(old_bl & 0x3FFFFFF, 26) * 4
    if cur != trim_va:
        raise PatchError("that bl does not target strings.TrimSpace")

    words = (
        encode_adrp(0, site_va + hits[0], target),
        encode_add_imm(0, 0, target & 0xFFF),
        encode_movz64(1, len(ENV_NAME)),
        encode_bl(bl_pc, getenv_va),
    )
    data[site:site + 16] = b"".join(struct.pack("<I", w) for w in words)
    return True, f"{FUNC_OVERRIDE}: reads {ENV_NAME.decode()} (strings.TrimSpace -> os.Getenv @ {bl_pc:#x})"


# --------------------------------------------------------------------------
# Patch 3: authclient.ValidateAndOnboardAccount (Region / Free-tier unlock)
# --------------------------------------------------------------------------

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
        return False, f"{FUNC_REGION}: symbol not present (skipped)"
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


# --------------------------------------------------------------------------
# Patch 4: Gate 3A / Gate 3B checkpoint context window
# --------------------------------------------------------------------------

def patch_context(data, funcs, arch, mode, lim, orig3b_hex):
    if FUNC_CHECKPOINT not in funcs:
        return False, False, orig3b_hex, f"{FUNC_CHECKPOINT}: symbol not present (skipped)"
    fn_ck = funcs[FUNC_CHECKPOINT]
    fn_exp = funcs.get(FUNC_EXP)
    fn_sel = funcs.get(FUNC_SELECT)
    ck_s, ck_e = fn_ck["fn_start"], min(len(data), fn_ck["fn_end"])
    body = data[ck_s:ck_e]
    changed = False
    saved3b = orig3b_hex

    def put(off, val):
        nonlocal changed
        if bytes(data[off:off + len(val)]) != val:
            data[off:off + len(val)] = val
            changed = True

    if arch == "x86-64":
        ch = []
        for r in range(0, len(body) - 13):
            s = bytes(body[r:r + 14])
            if s == CLAMP_X64 or s == DYN_X64 or (s[0] == 0xBE and s[5:] == b"\x90" * 9 and MIN_LIM <= struct.unpack_from("<I", s, 1)[0] <= MAX_LIM):
                ch.append(ck_s + r)
        if len(ch) != 1:
            return False, False, saved3b, f"{FUNC_CHECKPOINT}: skipped (x64 clamp hits={len(ch)})"
        dh = []
        for r in range(2, len(body) - 6):
            if body[r] == 0xC7 and body[r + 1] == 0x40 and body[r + 2] == 0x0C and 0x70 <= body[r - 2] <= 0x7F and body[r - 1] == 0x07:
                imm = struct.unpack_from("<I", body, r + 3)[0]
                if MIN_LIM <= imm <= MAX_LIM:
                    dh.append(ck_s + r)
        if len(dh) > 1:
            return False, False, saved3b, f"{FUNC_CHECKPOINT}: skipped (x64 def hits={len(dh)})"
        g3b = None
        if fn_exp and fn_sel:
            es, ee, eva, sva = fn_exp["fn_start"], min(len(data), fn_exp["fn_end"]), fn_exp["fn_va"], fn_sel["fn_va"]
            eb = data[es:ee]
            gh = []
            for r in range(0, len(eb) - 12):
                if eb[r] != 0xE8:
                    continue
                if eva + r + 5 + struct.unpack_from("<i", eb, r + 1)[0] != sva:
                    continue
                ti = eb.find(b"\x84\xc0", r + 5, min(len(eb), r + 105))
                if ti < 0 or ti + 4 > len(eb):
                    continue
                jo = ti + 2
                if eb[jo] == 0x75:
                    gh.append(("unpatched", es + jo, 2, bytes(eb[jo:jo + 2]).hex()))
                elif eb[jo] == 0x0F and eb[jo + 1] == 0x85 and jo + 6 <= len(eb):
                    gh.append(("unpatched", es + jo, 6, bytes(eb[jo:jo + 6]).hex()))
                elif eb[jo] == 0x90 and eb[jo + 1] == 0x90:
                    ln = 6 if (jo + 6 <= len(eb) and bytes(eb[jo:jo + 6]) == b"\x90" * 6) else 2
                    gh.append(("patched", es + jo, ln, None))
            if len(gh) == 1:
                g3b = gh[0]
        if g3b and g3b[0] == "unpatched" and g3b[3]:
            saved3b = g3b[3]
        if mode == "default":
            put(ch[0], CLAMP_X64)
            if dh:
                put(dh[0], DEF_ORIG_X64)
            if g3b and g3b[0] == "patched" and saved3b:
                ob = bytes.fromhex(saved3b)
                if len(ob) == g3b[2]:
                    put(g3b[1], ob)
        elif mode == "fixed":
            put(ch[0], b"\xbe" + struct.pack("<I", lim) + b"\x90" * 9)
            if dh:
                put(dh[0], b"\xc7\x40\x0c" + struct.pack("<I", lim))
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], b"\x90" * g3b[2])
        else:
            put(ch[0], DYN_X64)
            if dh:
                put(dh[0], DEF_ORIG_X64)
            if g3b and g3b[0] == "unpatched":
                put(g3b[1], b"\x90" * g3b[2])
        return True, changed, saved3b, f"{FUNC_CHECKPOINT}: mode={mode}" + (f" ({lim})" if mode == "fixed" else "")

    # arm64
    ch = []
    for r in range(0, len(body) - 23, 4):
        s = bytes(body[r:r + 24])
        if s == CLAMP_A64 or s == DYN_A64:
            ch.append(ck_s + r)
        else:
            imm = dec_mov_a64(body, r, 3)
            if imm is not None and MIN_LIM <= imm <= MAX_LIM and s[8:] == NOP_A64 * 4:
                ch.append(ck_s + r)
    if len(ch) != 1:
        return False, False, saved3b, f"{FUNC_CHECKPOINT}: skipped (arm64 clamp hits={len(ch)})"
    dh = []
    for r in range(8, len(body) - 11, 4):
        if bytes(body[r - 8:r]) == DEF_GUARD_A64 and bytes(body[r + 8:r + 12]) == STR_W3_A64:
            imm = dec_mov_a64(body, r, 3)
            if imm is not None and MIN_LIM <= imm <= MAX_LIM:
                dh.append(ck_s + r)
    if len(dh) > 1:
        return False, False, saved3b, f"{FUNC_CHECKPOINT}: skipped (arm64 def hits={len(dh)})"
    g3b = None
    if fn_exp and fn_sel:
        es, ee, eeo, seo = fn_exp["fn_start"], min(len(data), fn_exp["fn_end"]), fn_exp["entryoff"], fn_sel["entryoff"]
        eb = data[es:ee]
        gh = []
        for r in range(0, len(eb) - 7, 4):
            w = struct.unpack_from("<I", eb, r)[0]
            if (w & 0xFC000000) != 0x94000000:
                continue
            if eeo + r + sxt(w & 0x03FFFFFF, 26) * 4 != seo:
                continue
            for d in range(4, 53, 4):
                if r + d + 8 > len(eb):
                    break
                w2 = struct.unpack_from("<I", eb, r + d)[0]
                if (w2 & 0xFFFFFC1F) != 0xD63F0000:
                    continue
                jo = r + d + 4
                wn = struct.unpack_from("<I", eb, jo)[0]
                if (wn & 0xFFF8001F) == 0x37000000 or (wn & 0xFF00001F) == 0x35000000:
                    gh.append(("unpatched", es + jo, 4, bytes(eb[jo:jo + 4]).hex()))
                elif wn == 0xD503201F:
                    gh.append(("patched", es + jo, 4, None))
                break
        if len(gh) == 1:
            g3b = gh[0]
    if g3b and g3b[0] == "unpatched" and g3b[3]:
        saved3b = g3b[3]
    if mode == "default":
        put(ch[0], CLAMP_A64)
        if dh:
            put(dh[0], DEF_ORIG_A64)
        if g3b and g3b[0] == "patched" and saved3b:
            ob = bytes.fromhex(saved3b)
            if len(ob) == 4:
                put(g3b[1], ob)
    elif mode == "fixed":
        put(ch[0], enc_mov_a64(3, lim) + NOP_A64 * 4)
        if dh:
            put(dh[0], enc_mov_a64(3, lim) + STR_W3_A64)
        if g3b and g3b[0] == "unpatched":
            put(g3b[1], NOP_A64)
    else:
        put(ch[0], DYN_A64)
        if dh:
            put(dh[0], DEF_ORIG_A64)
        if g3b and g3b[0] == "unpatched":
            put(g3b[1], NOP_A64)
    return True, changed, saved3b, f"{FUNC_CHECKPOINT}: mode={mode}" + (f" ({lim})" if mode == "fixed" else "")


# --------------------------------------------------------------------------
# Helpers: binary auto-detection, safety guard, config sync, macOS resign
# --------------------------------------------------------------------------

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


def format_context_label(mode, lim):
    if mode in ("default", "dynamic"):
        return None
    if lim % 1024 == 0 and lim in (262144, 524288, 983040, 1048576):
        return f"{lim // 1024}K"
    if lim >= 1_000_000 and lim % 1_000_000 == 0:
        return f"{lim // 1_000_000}M"
    if lim % 1000 == 0:
        return f"{lim // 1000}K"
    return str(lim)


def sync_cli_configs(mode, lim):
    home = os.path.expanduser("~")
    label = format_context_label(mode, lim) if mode == "fixed" else None
    targets = [
        (os.path.join(home, ".gemini", "config", "config.json"), True),
        (os.path.join(home, ".gemini", "antigravity-cli", "settings.json"), False),
    ]
    synced = []
    for fpath, create_dir in targets:
        d = os.path.dirname(fpath)
        if not os.path.isdir(d):
            if create_dir:
                os.makedirs(d, exist_ok=True)
            else:
                continue
        obj = {}
        if os.path.isfile(fpath):
            try:
                with open(fpath, "r", encoding="utf-8") as fh:
                    obj = json.load(fh) or {}
            except Exception:
                obj = {}
        if mode in ("default", "dynamic") or not label:
            obj.pop("contextWindow", None)
        else:
            obj["contextWindow"] = label
        tmp = f"{fpath}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, fpath)
        synced.append(fpath)
    return synced


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
    ap.add_argument("--mode", default="dynamic", choices=("default", "dynamic", "fixed"))
    ap.add_argument("--limit", type=int, default=0, help="fixed context limit tokens (16384..2097152)")
    ap.add_argument("--no-env-fix", action="store_true")
    ap.add_argument("--no-region", action="store_true")
    ap.add_argument("--no-sync-config", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--locate", action="store_true", help="print symbols only")
    args = ap.parse_args()

    if args.mode == "fixed" and not (MIN_LIM <= args.limit <= MAX_LIM):
        sys.exit(f"error: --mode fixed requires --limit between {MIN_LIM} and {MAX_LIM}")

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

    for key in TARGET_FUNCS:
        if key in funcs:
            print(f"[i] {key} -> va={funcs[key]['fn_va']:#x} off={funcs[key]['fn_start']:#x}")
        else:
            print(f"[i] {key} -> MISSING")

    if args.locate:
        return

    ok, msg = patch_offers(data, funcs, arch)
    print(("[*] " if ok else "[=] ") + msg)

    if not args.no_env_fix:
        try:
            ok, msg = patch_env(data, funcs, container)
            print(("[*] " if ok else "[=] ") + msg)
        except PatchError as exc:
            print(f"[!] skipped env-var patch: {exc}")

    if not args.no_region:
        ok, msg = patch_region(data, funcs, arch)
        print(("[*] " if ok else "[=] ") + msg)

    dst = src_real if args.in_place else src + ".patched"
    meta_path = f"{dst}.hakimi_meta.json"
    prev_meta = {}
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                prev_meta = json.load(fh) or {}
        except Exception:
            prev_meta = {}

    ctx_ok, ctx_changed, saved3b, ctx_msg = patch_context(
        data, funcs, arch, args.mode, args.limit, prev_meta.get("gate3bOrigHex")
    )
    print(("[*] " if ctx_changed else ("[=] " if ctx_ok else "[!] ")) + ctx_msg)

    after = hashlib.sha256(bytes(data)).hexdigest()
    if args.dry_run:
        if before == after:
            print("[=] dry run: nothing to change")
        else:
            print(f"[*] dry run: {before[:12]} -> {after[:12]}")
        return

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

    if saved3b and saved3b != prev_meta.get("gate3bOrigHex"):
        try:
            prev_meta["gate3bOrigHex"] = saved3b
            with open(meta_path, "w", encoding="utf-8") as fh:
                json.dump(prev_meta, fh, indent=2)
                fh.write("\n")
        except OSError:
            pass

    if args.in_place and not args.no_sync_config:
        synced = sync_cli_configs(args.mode, args.limit)
        if synced:
            print(f"[*] synced configs: {', '.join(synced)}")


if __name__ == "__main__":
    try:
        main()
    except PatchError as exc:
        sys.exit(f"error: {exc}")
