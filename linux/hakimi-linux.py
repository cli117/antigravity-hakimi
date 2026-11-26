#!/usr/bin/env python3
"""hakimi-linux — Linux 版 Antigravity (agy CLI / language_server) 地区解锁工具。

机制与 macOS 版哈基米一致：
  1. 解析 ELF64 的 Go .gopclntab 符号表，定位
     authclient.ValidateAndOnboardAccount；
  2. 在函数体内自适应匹配 ineligibleTiers 的 "free-tier" 限制分支
     （x86-64 的 cmp/jne 与 arm64 的 cmp/b.ne），把条件跳转改写成无条件跳转；
  3. allowedTiers 分支保持原样，不写死 SHA-256 或固定偏移。

只处理 Linux ELF64（x86-64 / arm64，PIE 与非 PIE）；不修改提示词、
不注入外发请求拦截、不触碰桌面端 Antigravity 安装目录。

用法:
    ./hakimi-linux.py [status]                  # 只读检查（默认）
    ./hakimi-linux.py patch [--dry-run]         # 备份并解锁全部目标
    ./hakimi-linux.py restore [--force]         # 从备份还原
    ./hakimi-linux.py install-timer             # 安装 systemd 用户定时器（更新后自动重打）
    ./hakimi-linux.py uninstall-timer
    ./hakimi-linux.py timer-status

示例:
    ./hakimi-linux.py patch
    ./hakimi-linux.py patch --binary ~/.local/bin/agy
    ./hakimi-linux.py status --json
"""

import argparse
import hashlib
import json
import os
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

TOOL_VERSION = "1.0.0"
FUNC_REGION = "authclient.ValidateAndOnboardAccount"
PCLNTAB_MAGICS = (0xFFFFFFF1, 0xFFFFFFF0)  # Go 1.20+ / Go 1.18+
FREE_TIE = b"free-tie"
HUB_DIR_NAME = ".antigravity-hub-server"
SERVICE_NAME = "hakimi-linux"


class PatchError(Exception):
    pass


# ---------------------------------------------------------------------------
# ELF64 解析与 Go 符号定位
# ---------------------------------------------------------------------------


def read_cstr(data, off, limit=2048):
    if off < 0 or off >= len(data):
        return ""
    end = data.find(b"\x00", off, min(len(data), off + limit))
    if end < 0:
        end = min(len(data), off + limit)
    return data[off:end].decode("utf-8", "replace")


def sxt(val, bits):
    mask = 1 << (bits - 1)
    return (val & (mask - 1)) - (val & mask)


def parse_elf64(data):
    if len(data) < 64:
        raise PatchError("file too small to be a valid ELF64 executable")
    if data[:4] != b"\x7fELF":
        raise PatchError("not an ELF binary")
    if data[4] != 2 or data[5] != 1:
        raise PatchError("only 64-bit little-endian ELF is supported")
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
    if text_size <= 0:
        raise PatchError(".text section is empty")
    return {
        "format": "ELF64",
        "arch": arch,
        "text_va": text_va,
        "text_off": text_off,
        "text_size": text_size,
        "rela_dyn": by_name.get(".rela.dyn"),
        "sections": sections,
    }


def file_off_to_va(container, file_off):
    for _name, sec_addr, sec_off, sec_size in container["sections"]:
        if sec_size > 0 and sec_addr > 0 and sec_off <= file_off < sec_off + sec_size:
            return sec_addr + (file_off - sec_off)
    return file_off


def resolve_elf_go_text_base(data, container, pcln_off, text_start):
    """PIE Go 二进制的 pcHeader.textStart 可能为 0，需要从 .rela.dyn 的 firstmoduledata 反推。"""
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
                    ro, _r_info, ra = struct.unpack_from("<QQq", data, q)
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
    """从 .gopclntab 定位 authclient.ValidateAndOnboardAccount 的文件区间。"""
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
            functab = base + pcln_off
            fnname = base + fn_off
            if pcln_off <= 0 or fn_off <= 0 or functab + (nfunc + 1) * 8 > len(data) or fnname >= len(data):
                continue

            go_tva, go_toff, source = resolve_elf_go_text_base(data, container, base, text_start)
            found = {}
            for k in range(nfunc):
                entry_off, func_off = struct.unpack_from("<II", data, functab + k * 8)
                frec = functab + func_off
                if frec + 8 > len(data):
                    continue
                name_off = struct.unpack_from("<i", data, frec + 4)[0]
                if name_off < 0 or fnname + name_off >= len(data):
                    continue
                name = read_cstr(data, fnname + name_off, 512)
                if name == FUNC_REGION or name.endswith("/" + FUNC_REGION) or name.endswith("." + FUNC_REGION):
                    next_entry_off = struct.unpack_from("<I", data, functab + (k + 1) * 8)[0]
                    found[FUNC_REGION] = {
                        "name": name,
                        "entry_off": entry_off,
                        "next_entry_off": next_entry_off,
                        "size": max(0, next_entry_off - entry_off),
                        "fn_start": go_toff + entry_off,
                        "fn_end": go_toff + next_entry_off,
                        "fn_va": go_tva + entry_off,
                    }
                    break

            return found, go_tva, go_toff, source, nfunc

    raise PatchError("Go .gopclntab not found")


# ---------------------------------------------------------------------------
# 自适应分支分析（与 payload/dist/meter-ssh.js 保持同一套特征）
# ---------------------------------------------------------------------------


def analyze_region_x64(b, fn_s, fn_e):
    cands = []
    seen = set()
    for p in range(fn_s, fn_e - 24):
        if b[p] in (0x48, 0x49) and b[p + 1] == 0x83 and (b[p + 2] & 0xF8) == 0xF8 and b[p + 3] == 0x09:
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

        free_idx = b.find(FREE_TIE, jo + jlen, min(fn_e, jo + jlen + 24))
        if free_idx < 0:
            continue

        tail_end, loop_top = None, None
        for q in range(free_idx + 8, min(fn_e - 6, free_idx + 0x30)):
            next_q = -1
            if b[q] == 0x80 and (b[q + 1] & 0xF8) == 0x78 and b[q + 2] == 0x08 and b[q + 3] == 0x72:
                next_q = q + 4
            elif b[q] == 0x80 and b[q + 1] == 0x7C and b[q + 3] == 0x08 and b[q + 4] == 0x72:
                next_q = q + 5
            if next_q < 0 or next_q + 2 > fn_e:
                continue
            target, end = None, None
            if b[next_q] == 0x0F and b[next_q + 1] == 0x85 and next_q + 6 <= fn_e:
                target = next_q + 6 + struct.unpack_from("<i", b, next_q + 2)[0]
                end = next_q + 6
            elif b[next_q] == 0x75:
                target = next_q + 2 + struct.unpack_from("<b", b, next_q + 1)[0]
                end = next_q + 2
            if target is not None and fn_s <= target < p:
                loop_top, tail_end = target, end
                break
        if tail_end is None:
            continue

        exits = []
        for r in range(loop_top, min(p, loop_top + 0x48) - 2):
            dest = None
            if b[r] == 0x0F and 0x80 <= b[r + 1] <= 0x8F and r + 6 <= fn_e:
                dest = r + 6 + struct.unpack_from("<i", b, r + 2)[0]
            elif 0x70 <= b[r] <= 0x7F:
                dest = r + 2 + struct.unpack_from("<b", b, r + 1)[0]
            if dest is not None and tail_end <= dest < fn_e:
                exits.append(dest)
        if not exits:
            continue

        immediate_break = None
        if tail_end + 2 <= fn_e and b[tail_end] == 0xEB:
            immediate_break = tail_end + 2 + struct.unpack_from("<b", b, tail_end + 1)[0]
        elif tail_end + 5 <= fn_e and b[tail_end] == 0xE9:
            immediate_break = tail_end + 5 + struct.unpack_from("<i", b, tail_end + 1)[0]

        is_break_only = immediate_break is not None and immediate_break in exits
        has_match_body = (
            not is_break_only
            and tgt == loop_top
            and any(d > tail_end + 0x10 for d in exits)
        )

        seen.add(jo)
        cands.append({
            "cmp_offset": p,
            "branch_offset": jo,
            "state": st,
            "target": tgt,
            "patched_bytes": pbytes,
            "has_match_body": has_match_body,
            "is_break_only": is_break_only,
        })

    ineligible = [c for c in cands if c["has_match_body"]]
    allowed = [c for c in cands if c["is_break_only"] and not c["has_match_body"]]
    if len(ineligible) != 1:
        return {
            "ok": False,
            "status": "pattern_missing" if not ineligible else "ambiguous",
            "allowed_tiers": len(allowed),
            "error": "未找到唯一的 x86-64 free-tier 限制分支" if not ineligible else f"命中 {len(ineligible)} 处 x86-64 候选分支",
        }
    if any(c["state"] != "unpatched" for c in allowed):
        return {"ok": False, "status": "corrupted_allowed_tiers", "error": "检测到 allowedTiers 循环被意外修改"}

    hit = ineligible[0]
    off = hit["branch_offset"]
    return {
        "ok": True,
        "status": hit["state"],
        "arch": "x86-64",
        "cmp_offset": hit["cmp_offset"],
        "branch_offset": off,
        "target_offset": hit["target"],
        "current_bytes": bytes(b[off:off + len(hit["patched_bytes"])]),
        "patched_bytes": hit["patched_bytes"],
        "allowed_tiers": len(allowed),
    }


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
        if (w0 & 0x7FFFFC1F) != 0x7100241F:  # cmp xN/wN, #9 ("free-tier")
            continue
        target = dec_bne(w1, p + 4)
        st = "unpatched" if target is not None else None
        if target is None:
            target = dec_b(w1, p + 4)
            if target is not None:
                st = "patched"
        if target is None or not (fn_s <= target < p):
            continue

        tail_end, inter = None, 0
        for q in range(p + 8, min(fn_e - 8, p + 0x48) + 1, 4):
            wq0, wq1 = struct.unpack_from("<II", b, q)
            if (wq0 & 0x7FFFFC1F) == 0x7101C81F and dec_bne(wq1, q + 4) == target:
                tail_end = q + 8
                break
            if dec_bne(wq0, q) == target:
                inter += 1
        if tail_end is None or inter < 1:
            continue

        exits = []
        for r in range(target, min(p, target + 0x30), 4):
            dest = dec_cb(struct.unpack_from("<I", b, r)[0], r)
            if dest is not None and dest >= tail_end:
                exits.append(dest)
        if not exits:
            continue

        has_body = any(d > tail_end for d in exits)
        is_break_only = all(d == tail_end for d in exits)
        cands.append({
            "cmp_offset": p,
            "branch_offset": p + 4,
            "state": st,
            "target": target,
            "has_match_body": has_body,
            "is_break_only": is_break_only,
        })

    ineligible = [c for c in cands if c["has_match_body"]]
    allowed = [c for c in cands if c["is_break_only"] and not c["has_match_body"]]
    if len(ineligible) != 1:
        return {
            "ok": False,
            "status": "pattern_missing" if not ineligible else "ambiguous",
            "allowed_tiers": len(allowed),
            "error": "未找到唯一的 arm64 free-tier 限制分支" if not ineligible else f"命中 {len(ineligible)} 处 arm64 候选分支",
        }
    if any(c["state"] != "unpatched" for c in allowed):
        return {"ok": False, "status": "corrupted_allowed_tiers", "error": "检测到 allowedTiers 循环被意外修改"}

    hit = ineligible[0]
    off = hit["branch_offset"]
    off26 = (hit["target"] - off) // 4
    pbytes = struct.pack("<I", (0x14000000 | (off26 & 0x03FFFFFF)) & 0xFFFFFFFF)
    return {
        "ok": True,
        "status": hit["state"],
        "arch": "arm64",
        "cmp_offset": hit["cmp_offset"],
        "branch_offset": off,
        "target_offset": hit["target"],
        "current_bytes": bytes(b[off:off + 4]),
        "patched_bytes": pbytes,
        "allowed_tiers": len(allowed),
    }


def analyze(data):
    """只读分析；返回 ok/status/arch/offset 等信息。"""
    sha = hashlib.sha256(data).hexdigest()
    try:
        container = parse_elf64(data)
    except PatchError as exc:
        return {"ok": False, "status": "unsupported", "format": None, "arch": None, "sha256": sha, "error": str(exc)}

    try:
        funcs, go_tva, go_toff, source, nfunc = build_functions(data, container)
    except PatchError as exc:
        return {
            "ok": False,
            "status": "pclntab_missing",
            "format": "ELF64",
            "arch": container["arch"],
            "sha256": sha,
            "error": str(exc),
        }

    fn = funcs.get(FUNC_REGION)
    if not fn:
        return {
            "ok": False,
            "status": "symbol_missing",
            "format": "ELF64",
            "arch": container["arch"],
            "sha256": sha,
            "error": f"{FUNC_REGION} 不在符号表中（可能已被重构或裁剪）",
        }

    fn_s = max(container["text_off"], fn["fn_start"])
    fn_e = min(len(data), fn["fn_end"])
    if fn_e <= fn_s + 24:
        return {
            "ok": False,
            "status": "function_too_small",
            "format": "ELF64",
            "arch": container["arch"],
            "sha256": sha,
            "fn_name": fn["name"],
            "error": "函数体过短，无法安全匹配",
        }

    region = analyze_region_a64(data, fn_s, fn_e) if container["arch"] == "arm64" else analyze_region_x64(data, fn_s, fn_e)
    result = {
        "format": "ELF64",
        "arch": container["arch"],
        "sha256": sha,
        "fn_name": fn["name"],
        "fn_start": fn["fn_start"],
        "fn_end": fn["fn_end"],
        "fn_va": fn["fn_va"],
        "go_text_source": source,
        "total_symbols": nfunc,
        **region,
    }
    if result.get("ok"):
        result["status"] = region["status"]
    return result


def apply_patch(data):
    """在 bytearray 上原地打补丁；返回 (changed, before, after)。"""
    before = analyze(data)
    if not before.get("ok") or before.get("status") != "unpatched":
        return False, before, before

    off = before["branch_offset"]
    pbytes = before["patched_bytes"]
    if off < 0 or off + len(pbytes) > len(data):
        raise PatchError("branch offset out of range")
    data[off:off + len(pbytes)] = pbytes

    after = analyze(data)
    if not after.get("ok") or after.get("status") != "patched" or after.get("branch_offset") != off:
        raise PatchError("in-memory verification failed after patching")
    return True, before, after


# ---------------------------------------------------------------------------
# 目标发现与状态
# ---------------------------------------------------------------------------


def home_dir():
    return os.path.expanduser("~")


def is_elf64_file(path):
    try:
        if not os.path.isfile(path) or os.path.getsize(path) < 64:
            return False
        with open(path, "rb") as fh:
            head = fh.read(6)
        return len(head) >= 6 and head[:4] == b"\x7fELF" and head[4] == 2 and head[5] == 1
    except OSError:
        return False


def is_official_mac_bundle(path):
    real = os.path.realpath(os.path.abspath(path))
    for root in ("/Applications/Antigravity.app", "/Applications/Antigravity.app.orig"):
        if real == root or real.startswith(root + "/"):
            return True
    return False


def agy_candidates():
    home = home_dir()
    out = []
    env_bin = os.environ.get("AGY_CLI_BIN")
    if env_bin:
        out.append(env_bin)
    out.extend([
        os.path.join(home, ".local", "bin", "agy"),
        # 真实二进制在代理 wrapper 场景下会被改名为 agy.real
        os.path.join(home, ".local", "bin", "agy.real"),
        os.path.join(home, ".antigravity", "antigravity", "bin", "agy"),
        os.path.join(home, ".antigravity", "bin", "agy"),
        os.path.join(home, "bin", "agy"),
    ])
    which = shutil.which("agy")
    if which:
        out.append(which)
    out.extend(["/usr/local/bin/agy", "/usr/bin/agy"])
    return out


def hub_candidates():
    root = os.path.join(home_dir(), HUB_DIR_NAME, "bin")
    if not os.path.isdir(root):
        return []
    out = []
    for entry in sorted(os.listdir(root)):
        for name in ("language_server", "language_server_linux", "language_server_linux_x64", "language_server_linux_arm64"):
            p = os.path.join(root, entry, name)
            if os.path.isfile(p):
                out.append(p)
    return out


def dedupe_paths(paths):
    seen = set()
    out = []
    for p in paths:
        if not p:
            continue
        absp = os.path.abspath(os.path.expanduser(p))
        real = os.path.realpath(absp)
        if real in seen:
            continue
        seen.add(real)
        out.append(absp)
    return out


def discover_targets(args):
    explicit = list(args.binary or [])
    globs = list(args.glob or [])

    paths = []
    if explicit:
        paths.extend(explicit)
    if globs:
        import glob as _glob
        for pattern in globs:
            paths.extend(sorted(_glob.glob(os.path.expanduser(pattern))))
    if not explicit and not globs:
        if not args.no_cli:
            paths.extend(agy_candidates())
        if not args.no_hub:
            paths.extend(hub_candidates())

    targets = []
    for path in dedupe_paths(paths):
        kind = "language_server" if "language_server" in os.path.basename(path) else ("agy" if os.path.basename(path) == "agy" else "binary")
        entry = {"kind": kind, "path": path, "real_path": os.path.realpath(path), "exists": os.path.exists(path)}
        if entry["exists"] and is_official_mac_bundle(path):
            entry["error"] = "拒绝处理官方 Antigravity.app 路径"
            targets.append(entry)
            continue
        if not entry["exists"]:
            if explicit:
                entry["error"] = "文件不存在"
                targets.append(entry)
            continue
        if not is_elf64_file(entry["real_path"]):
            if explicit:
                entry["error"] = "不是 Linux ELF64 可执行文件"
                targets.append(entry)
            continue
        targets.append(entry)
    return targets


def running_pids(real_paths):
    hits = {}
    if not os.path.isdir("/proc"):
        return hits
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            exe = os.readlink(f"/proc/{name}/exe")
        except OSError:
            continue
        if exe.endswith(" (deleted)"):
            exe = exe[: -len(" (deleted)")]
        if exe in real_paths:
            hits.setdefault(exe, []).append(int(name))
    return hits


def read_target(entry):
    path = entry["real_path"]
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        entry["error"] = f"读取失败: {exc}"
        entry["status"] = "error"
        return None
    analysis = analyze(data)
    entry.update({
        "format": analysis.get("format"),
        "arch": analysis.get("arch"),
        "status": analysis.get("status", "error"),
        "sha256": analysis.get("sha256"),
        "analysis": analysis,
    })
    if analysis.get("error"):
        entry["error"] = analysis["error"]
    return data


# ---------------------------------------------------------------------------
# 备份 / 还原
# ---------------------------------------------------------------------------


def state_dir():
    override = os.environ.get("HAKIMI_LINUX_STATE_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(home_dir(), ".local", "state")
    return os.path.join(base, "hakimi-linux")


def backup_dir():
    return os.path.join(state_dir(), "backups")


def manifest_path():
    return os.path.join(backup_dir(), "manifest.json")


def load_manifest():
    path = manifest_path()
    if not os.path.exists(path):
        return {"version": 1, "entries": {}}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
            raise ValueError("bad manifest shape")
        return data
    except (OSError, ValueError):
        return {"version": 1, "entries": {}}


def save_manifest(manifest):
    os.makedirs(backup_dir(), exist_ok=True)
    tmp = manifest_path() + f".tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, manifest_path())


def atomic_write(path, data):
    st = os.stat(path)
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.hakimi.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def make_backup(real_path, original_sha):
    os.makedirs(backup_dir(), exist_ok=True)
    name = f"{os.path.basename(real_path)}.{original_sha[:12]}.orig"
    dest = os.path.join(backup_dir(), name)
    if os.path.exists(dest):
        with open(dest, "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest() == original_sha:
                return dest
        raise PatchError(f"备份文件已存在但内容不匹配: {dest}")
    shutil.copy2(real_path, dest)
    with open(dest, "rb") as fh:
        if hashlib.sha256(fh.read()).hexdigest() != original_sha:
            raise PatchError(f"备份校验失败: {dest}")
    return dest


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------


def json_safe(value):
    """把 bytes/bytearray 转成 hex，保证 JSON 可序列化。"""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def summarize(targets):
    summary = {"total": len(targets), "patched": 0, "unpatched": 0, "failed": 0}
    for t in targets:
        status = t.get("status")
        if status == "patched":
            summary["patched"] += 1
        elif status == "unpatched":
            summary["unpatched"] += 1
        else:
            summary["failed"] += 1
    return summary


def cmd_status(args):
    targets = discover_targets(args)
    for entry in targets:
        if entry.get("exists") and "error" not in entry:
            read_target(entry)
    pids = running_pids({t["real_path"] for t in targets if t.get("exists")})
    for entry in targets:
        entry["running_pids"] = pids.get(entry["real_path"], [])

    if args.json:
        print(json.dumps(json_safe({"ok": True, "state_dir": state_dir(), "targets": targets, "summary": summarize(targets)}), ensure_ascii=False, indent=2))
    else:
        print(f"hakimi-linux v{TOOL_VERSION}  state={state_dir()}")
        if not targets:
            print("未发现 agy CLI 或 language_server；可用 --binary/--glob 指定目标。")
        for entry in targets:
            meta = f"{entry.get('format') or '?'} {entry.get('arch') or '?'}"
            status = entry.get("status") or ("missing" if not entry.get("exists") else "error")
            print(f"[{entry['kind']}] {entry['path']}")
            line = f"  {meta}  {status}"
            if entry.get("sha256"):
                line += f"  sha256={entry['sha256'][:12]}"
            if entry.get("analysis", {}).get("allowed_tiers") is not None:
                line += f"  allowedTiers={entry['analysis']['allowed_tiers']}"
            if entry.get("running_pids"):
                line += "  running=" + ",".join(str(p) for p in entry["running_pids"])
            print(line)
            if entry.get("error") and status not in ("unpatched", "patched"):
                print(f"  reason: {entry['error']}")

    summary = summarize(targets)
    return 0 if targets and summary["unpatched"] == 0 and summary["failed"] == 0 else 1


def cmd_patch(args):
    targets = discover_targets(args)
    manifest = load_manifest()
    results = []
    failed = 0
    quiet = args.quiet or args.json
    changed_paths = set()

    for entry in targets:
        if entry.get("error") and not entry.get("exists"):
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": "error", "error": entry["error"]})
            continue
        if entry.get("error"):
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": "error", "error": entry["error"]})
            continue

        data = read_target(entry)
        if data is None:
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": "error", "error": entry.get("error")})
            continue

        status = entry.get("status")
        if status == "patched":
            results.append({"path": entry["path"], "ok": True, "status": "patched", "changed": False, "sha256": entry.get("sha256")})
            if not quiet:
                print(f"[skip]    {entry['path']} 已处于解锁状态")
            continue
        if status != "unpatched":
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": status, "error": entry.get("error")})
            if not quiet:
                print(f"[failed]  {entry['path']}  {entry.get('error') or status}", file=sys.stderr)
            continue

        original_sha = entry["sha256"]
        buf = bytearray(data)
        try:
            changed, before, analysis = apply_patch(buf)
        except PatchError as exc:
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": "patch_failed", "error": str(exc)})
            if not quiet:
                print(f"[failed]  {entry['path']}  {exc}", file=sys.stderr)
            continue

        if not changed:
            results.append({"path": entry["path"], "ok": True, "status": before.get("status"), "changed": False})
            if not quiet:
                print(f"[skip]    {entry['path']} 已处于解锁状态")
            continue

        if args.dry_run:
            results.append({
                "path": entry["path"],
                "ok": True,
                "status": "would_patch",
                "changed": True,
                "branch_offset": before.get("branch_offset"),
                "current_bytes": before.get("current_bytes", b"").hex(),
                "patched_bytes": before.get("patched_bytes", b"").hex(),
            })
            if not quiet:
                print(
                    f"[dry-run] {entry['path']}  {before.get('current_bytes', b'').hex()} -> "
                    f"{before.get('patched_bytes', b'').hex()} @ 0x{before['branch_offset']:x}"
                )
            continue

        try:
            backup = make_backup(entry["real_path"], original_sha)
            atomic_write(entry["real_path"], buf)
        except (OSError, PatchError) as exc:
            failed += 1
            results.append({"path": entry["path"], "ok": False, "status": "write_failed", "error": str(exc)})
            if not quiet:
                print(f"[failed]  {entry['path']}  {exc}", file=sys.stderr)
            continue

        patched_sha = hashlib.sha256(bytes(buf)).hexdigest()
        manifest["entries"][entry["real_path"]] = {
            "backup": backup,
            "original_sha256": original_sha,
            "patched_sha256": patched_sha,
            "patched_at": datetime.now(timezone.utc).isoformat(),
            "format": analysis.get("format"),
            "arch": analysis.get("arch"),
            "fn_name": analysis.get("fn_name"),
        }
        save_manifest(manifest)

        results.append({
            "path": entry["path"],
            "ok": True,
            "status": "patched",
            "changed": True,
            "backup": backup,
            "before_sha256": original_sha,
            "after_sha256": patched_sha,
            "branch_offset": analysis.get("branch_offset"),
        })
        changed_paths.add(entry["real_path"])
        if not quiet:
            print(f"[patched] {entry['path']}  backup={backup}")

    pids = running_pids(changed_paths)
    if pids and not quiet:
        print("\n提示: 以下 language_server 仍在运行旧进程，重启 agy / 重新连接后补丁才会生效：")
        for real, plist in pids.items():
            print(f"  PID {','.join(str(p) for p in plist)}  {real}")

    if args.json:
        print(json.dumps(json_safe({"ok": failed == 0, "results": results}), ensure_ascii=False, indent=2))
    return 0 if failed == 0 else 1


def cmd_restore(args):
    manifest = load_manifest()
    entries = manifest.get("entries", {})
    selected = []
    missing = set()
    quiet = args.quiet or args.json
    if args.binary:
        wanted = {os.path.realpath(os.path.abspath(os.path.expanduser(p))) for p in args.binary}
        for real, meta in entries.items():
            if real in wanted:
                selected.append((real, meta))
        missing = wanted - {real for real, _ in selected}
        for p in missing:
            if not quiet:
                print(f"[skip]    {p} 没有备份记录", file=sys.stderr)
    else:
        selected = list(entries.items())

    if not selected:
        if not quiet:
            print("没有可还原的备份记录。")
        return 1

    failed = 0
    results = []
    for p in missing:
        failed += 1
        results.append({"path": p, "ok": False, "error": "没有备份记录"})
    for real, meta in selected:
        backup = meta.get("backup")
        if not backup or not os.path.exists(backup):
            failed += 1
            results.append({"path": real, "ok": False, "error": "备份文件不存在"})
            if not quiet:
                print(f"[failed]  {real}  备份文件不存在", file=sys.stderr)
            continue
        if not os.path.exists(real):
            failed += 1
            results.append({"path": real, "ok": False, "error": "目标文件不存在"})
            if not quiet:
                print(f"[failed]  {real}  目标文件不存在", file=sys.stderr)
            continue

        with open(real, "rb") as fh:
            current = fh.read()
        current_sha = hashlib.sha256(current).hexdigest()
        expected = meta.get("patched_sha256")
        if current_sha != expected and not args.force:
            failed += 1
            results.append({"path": real, "ok": False, "error": "目标已被更新或改动，未还原（可加 --force）"})
            if not quiet:
                print(f"[skip]    {real}  目标已被更新或改动（sha256 不匹配），未还原；如确认要还原请加 --force", file=sys.stderr)
            continue

        with open(backup, "rb") as fh:
            original = fh.read()
        if hashlib.sha256(original).hexdigest() != meta.get("original_sha256"):
            failed += 1
            results.append({"path": real, "ok": False, "error": "备份校验失败"})
            if not quiet:
                print(f"[failed]  {real}  备份校验失败", file=sys.stderr)
            continue

        try:
            atomic_write(real, original)
        except OSError as exc:
            failed += 1
            results.append({"path": real, "ok": False, "error": str(exc)})
            if not quiet:
                print(f"[failed]  {real}  {exc}", file=sys.stderr)
            continue

        verify = analyze(original)
        results.append({"path": real, "ok": True, "status": verify.get("status"), "backup": backup})
        if not quiet:
            print(f"[restored] {real}  <- {backup}")

    if args.json:
        print(json.dumps(json_safe({"ok": failed == 0, "results": results}), ensure_ascii=False, indent=2))
    return 0 if failed == 0 else 1


# ---------------------------------------------------------------------------
# systemd 用户定时器
# ---------------------------------------------------------------------------


def systemd_user_dir():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home_dir(), ".config")
    return os.path.join(base, "systemd", "user")


def service_paths():
    base = systemd_user_dir()
    return os.path.join(base, f"{SERVICE_NAME}.service"), os.path.join(base, f"{SERVICE_NAME}.timer")


def systemctl(*argv):
    try:
        return subprocess.run(["systemctl", "--user", *argv], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(["systemctl"], 127, "", str(exc))


def cmd_install_timer(args):
    script = os.path.realpath(os.path.abspath(__file__))
    service, timer = service_paths()
    os.makedirs(os.path.dirname(service), exist_ok=True)
    interval = max(1, int(args.interval_minutes))

    service_body = f"""[Unit]
Description=Hakimi Linux agy/language_server region unlock auto-repair
After=default.target

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env python3 "{script}" patch --quiet
"""
    timer_body = f"""[Unit]
Description=Periodically re-apply Hakimi Linux region unlock after agy updates

[Timer]
OnBootSec=2min
OnUnitActiveSec={interval}min
AccuracySec=1min
Unit={SERVICE_NAME}.service

[Install]
WantedBy=timers.target
"""
    with open(service, "w", encoding="utf-8") as fh:
        fh.write(service_body)
    with open(timer, "w", encoding="utf-8") as fh:
        fh.write(timer_body)

    daemon = systemctl("daemon-reload")
    enable = systemctl("enable", "--now", f"{SERVICE_NAME}.timer")
    if enable.returncode != 0:
        print(f"已写入 {service} 和 {timer}", file=sys.stderr)
        print("但 systemctl --user 启用失败（当前会话可能没有 systemd 用户总线）：", file=sys.stderr)
        print(f"  {enable.stderr.strip() or enable.stdout.strip()}", file=sys.stderr)
        print("可手动执行：", file=sys.stderr)
        print(f"  systemctl --user daemon-reload && systemctl --user enable --now {SERVICE_NAME}.timer", file=sys.stderr)
        print("或改用 cron：", file=sys.stderr)
        print(f"  */{interval} * * * * /usr/bin/env python3 {shlex.quote(script)} patch --quiet", file=sys.stderr)
        return 1

    print(f"已启用 {SERVICE_NAME}.timer（每 {interval} 分钟检查一次）")
    print(f"  service: {service}")
    print(f"  timer:   {timer}")
    print("提示: 如希望未登录时也运行，可执行 loginctl enable-linger \"$USER\"")
    return 0


def cmd_uninstall_timer(args):
    service, timer = service_paths()
    systemctl("disable", "--now", f"{SERVICE_NAME}.timer")
    removed = []
    for path in (timer, service):
        if os.path.exists(path):
            try:
                os.unlink(path)
                removed.append(path)
            except OSError as exc:
                print(f"删除失败 {path}: {exc}", file=sys.stderr)
                return 1
    systemctl("daemon-reload")
    if removed:
        print("已移除: " + ", ".join(removed))
    else:
        print("没有已安装的定时器。")
    return 0


def cmd_timer_status(args):
    service, timer = service_paths()
    print(f"service: {service} {'(exists)' if os.path.exists(service) else '(missing)'}")
    print(f"timer:   {timer} {'(exists)' if os.path.exists(timer) else '(missing)'}")
    res = systemctl("status", f"{SERVICE_NAME}.timer", "--no-pager")
    if res.stdout:
        print(res.stdout.rstrip())
    elif res.stderr:
        print(res.stderr.rstrip(), file=sys.stderr)
    return 0 if os.path.exists(timer) else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--binary", action="append", default=[], metavar="PATH", help="只处理指定文件（可重复）")
    common.add_argument("--glob", action="append", default=[], metavar="PATTERN", help="额外按 glob 匹配目标（可重复）")
    common.add_argument("--no-cli", action="store_true", help="不自动扫描 agy CLI")
    common.add_argument("--no-hub", action="store_true", help="不自动扫描 ~/.antigravity-hub-server")
    common.add_argument("--json", action="store_true", help="输出 JSON")
    common.add_argument("--quiet", action="store_true", help="只输出错误")

    parser = argparse.ArgumentParser(
        prog="hakimi-linux.py",
        description="Linux 版 Antigravity (agy CLI / language_server) 地区解锁工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  %(prog)s                       # 只读检查\n"
            "  %(prog)s patch                 # 备份并解锁\n"
            "  %(prog)s patch --dry-run       # 只看会改哪些字节\n"
            "  %(prog)s restore --force       # 从备份还原\n"
            "  %(prog)s install-timer         # 更新后自动重打\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"hakimi-linux {TOOL_VERSION}")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", parents=[common], help="只读检查补丁状态（默认）")
    p_patch = sub.add_parser("patch", parents=[common], help="备份并解锁目标")
    p_patch.add_argument("--dry-run", action="store_true", help="只分析，不写入")
    p_restore = sub.add_parser("restore", parents=[common], help="从备份还原")
    p_restore.add_argument("--force", action="store_true", help="目标 sha256 变化时仍强制还原")
    p_install = sub.add_parser("install-timer", help="安装 systemd 用户定时器（更新后自动重打）")
    p_install.add_argument("--interval-minutes", type=int, default=10, metavar="N", help="检查间隔分钟数（默认 10）")
    sub.add_parser("uninstall-timer", help="卸载 systemd 用户定时器")
    sub.add_parser("timer-status", help="查看定时器状态")

    return parser, common


def main(argv=None):
    parser, _common = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "status"
    if command == "status":
        # 没有子命令时补齐默认值
        for key, val in (("binary", []), ("glob", []), ("no_cli", False), ("no_hub", False), ("json", False), ("quiet", False)):
            if not hasattr(args, key):
                setattr(args, key, val)
        return cmd_status(args)
    if command == "patch":
        return cmd_patch(args)
    if command == "restore":
        return cmd_restore(args)
    if command == "install-timer":
        return cmd_install_timer(args)
    if command == "uninstall-timer":
        return cmd_uninstall_timer(args)
    if command == "timer-status":
        return cmd_timer_status(args)
    parser.error(f"unknown command: {command}")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except PatchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
