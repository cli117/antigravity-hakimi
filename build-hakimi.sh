#!/bin/bash
# 哈基米.app 独立构建脚本（专注 macOS Apple Silicon ARM64）
#
# 功能说明：
#   1. 基于只读源 /Applications/Antigravity.app（或 --from 指定副本）复制并生成独立应用 /Applications/哈基米.app
#   2. 严格保护官方 /Applications/Antigravity.app 及 .orig 绝不被修改
#   3. 内核级与客户端能力整合：
#      - 账号地区 / Free-tier 检测解锁 (ValidateAndOnboardAccount，UI 还原操作绝不回滚该补丁)
#      - 上下文窗口解锁 (default 256K / fixed / dynamic) + 发送链路 maxTokenLimit 动态覆写
#      - 会话主标题 & 章节标题自动简体中文补丁
#      - 桌面端简体中文界面与 4 态品牌标题 (默认：哈基米 / 反重力 / 隐藏 / Antigravity)
#      - 实时上下文占用监控、速率监测、8 类错误诊断、Token 消费历史与参考费用看板
#
# 用法:
#   ./build-hakimi.sh [选项]
#   ./build-hakimi.sh --force
#   ./build-hakimi.sh --force --icon ~/Pictures/hakimi.jpg
#   ./build-hakimi.sh --stage-only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP="/Applications/哈基米.app"
SRC=""
STAGE_ONLY=0
FORCE=0
CONTEXT_MODE="dynamic"
CONTEXT_LIMIT=""
CHINESE_TITLE="on"
CLIENT_LANG=""
BRAND=""
ICON_PATH=""
RAW_ICON=0
FORCE_DEFAULT_ICON=0
AUTO_RESTART=0

usage() {
  cat <<'EOF'
用法: ./build-hakimi.sh [选项]

选项:
  --force                         允许覆盖已存在的输出 .app 副本
  --stage-only                    仅在临时目录生成打好补丁的 哈基米.app，不写入 /Applications 且不改用户配置目录
  --from <path>                   指定只读官方 Antigravity.app 源路径 (默认优先 /Applications/Antigravity.app.orig，其次 /Applications/Antigravity.app)
  --app <path>                    指定输出 .app 路径 (默认: /Applications/哈基米.app；严禁指向官方 Antigravity.app)
  -i, --icon <path>               可选：指定本地图片 (PNG/JPG/WebP/HEIC/ICNS 等) 作为应用图标 (不传时若旧副本已有自定义图标会自动保留)
  --raw-icon                      可选：配合 --icon 使用，不自动添加 macOS 圆角矩形留白遮罩
  --default-icon                  可选：覆盖旧副本时强制恢复为默认官方图标
  -r, --restart                   若目标应用当前正在运行，构建完成后自动优雅退出旧进程并重启新版
  --context-mode <mode>           上下文窗口模式: default | fixed | dynamic (默认: dynamic)
  --context-limit <tokens>        当 --context-mode fixed 时指定固定 token 上限 (16384 ~ 2097152)
  --chinese-title <on|off>        是否启用会话/章节自动简体中文标题补丁 (默认: on)
  --client-lang <zh-CN|en>        桌面端界面语言 (首次写入配置默认为 zh-CN)
  --brand <hakimi|translated|hidden|english>
                                  左上角品牌标题模式 (首次写入配置默认为 hakimi，即 哈基米)
  -h, --help                      显示本帮助信息
EOF
}

require_arg() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "选项 $1 需要提供参数值" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage-only)
      STAGE_ONLY=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --from)
      require_arg "$@"
      SRC="$2"
      shift 2
      ;;
    --app)
      require_arg "$@"
      APP="$2"
      shift 2
      ;;
    --context-mode)
      require_arg "$@"
      CONTEXT_MODE="$2"
      shift 2
      ;;
    --context-limit)
      require_arg "$@"
      CONTEXT_LIMIT="$2"
      shift 2
      ;;
    --chinese-title)
      require_arg "$@"
      CHINESE_TITLE="$2"
      shift 2
      ;;
    --client-lang)
      require_arg "$@"
      CLIENT_LANG="$2"
      shift 2
      ;;
    --brand)
      require_arg "$@"
      BRAND="$2"
      shift 2
      ;;
    -i|--icon)
      require_arg "$@"
      ICON_PATH="$2"
      shift 2
      ;;
    --raw-icon)
      RAW_ICON=1
      shift
      ;;
    --default-icon)
      FORCE_DEFAULT_ICON=1
      shift
      ;;
    -r|--restart)
      AUTO_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$CONTEXT_MODE" in
  default|fixed|dynamic) ;;
  *) echo "无效 --context-mode: $CONTEXT_MODE (可选: default | fixed | dynamic)" >&2; exit 2 ;;
esac

if [[ "$CONTEXT_MODE" == "fixed" ]]; then
  if [[ -z "$CONTEXT_LIMIT" || ! "$CONTEXT_LIMIT" =~ ^[0-9]+$ ]]; then
    echo "--context-mode fixed 必须配合正整数 --context-limit (16384 ~ 2097152)" >&2
    exit 2
  fi
fi

case "$CHINESE_TITLE" in
  on|off) ;;
  *) echo "无效 --chinese-title: $CHINESE_TITLE (可选: on | off)" >&2; exit 2 ;;
esac

if [[ -n "$CLIENT_LANG" ]]; then
  case "$CLIENT_LANG" in
    zh-CN|en) ;;
    *) echo "无效 --client-lang: $CLIENT_LANG (可选: zh-CN | en)" >&2; exit 2 ;;
  esac
fi

if [[ -n "$BRAND" ]]; then
  case "$BRAND" in
    hakimi|translated|hidden|english) ;;
    *) echo "无效 --brand: $BRAND (可选: hakimi | translated | hidden | english)" >&2; exit 2 ;;
  esac
fi

# 依赖检查
command -v node >/dev/null 2>&1 || { echo "缺少 node，请先安装 Node.js" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "缺少 python3" >&2; exit 1; }
command -v codesign >/dev/null 2>&1 || { echo "缺少 codesign (macOS Xcode CLI tools)" >&2; exit 1; }

# 官方 App 防护守卫：任何情况下禁止将输出目标设为官方 Antigravity.app / .orig（含符号链接）
node -e '
const path = require("path");
const { assertNotOfficialAntigravityApp } = require(path.join(process.argv[1], "payload", "dist", "asar-engine.js"));
assertNotOfficialAntigravityApp(process.argv[2], "写入目标应用");
' "$SCRIPT_DIR" "$APP"

if [[ -z "$SRC" ]]; then
  if [[ -d "/Applications/Antigravity.app.orig" ]]; then
    SRC="/Applications/Antigravity.app.orig"
  else
    SRC="/Applications/Antigravity.app"
  fi
fi
[[ -d "$SRC" ]] || { echo "找不到只读源应用: $SRC" >&2; exit 1; }
[[ -f "$SRC/Contents/Resources/app.asar" ]] || { echo "源应用缺少 Contents/Resources/app.asar: $SRC" >&2; exit 1; }
[[ -f "$SRC/Contents/Resources/bin/language_server" ]] || { echo "源应用缺少 Contents/Resources/bin/language_server: $SRC" >&2; exit 1; }

if [[ $STAGE_ONLY -eq 0 && ( -e "$APP" || -L "$APP" ) && $FORCE -eq 0 ]]; then
  echo "输出路径已存在: $APP （如需覆盖请传入 --force，或用 --app 指定新路径）" >&2
  exit 1
fi

if [[ -n "$ICON_PATH" && $FORCE_DEFAULT_ICON -eq 1 ]]; then
  echo "--icon 与 --default-icon 不能同时指定" >&2
  exit 2
fi

if [[ -n "$ICON_PATH" ]]; then
  [[ -f "$ICON_PATH" ]] || { echo "找不到指定的图标文件: $ICON_PATH" >&2; exit 1; }
  command -v sips >/dev/null 2>&1 || { echo "自定义图标需要 macOS sips 工具" >&2; exit 1; }
  command -v iconutil >/dev/null 2>&1 || { echo "自定义图标需要 macOS iconutil 工具" >&2; exit 1; }
fi

find_running_target_pids() {
  local target_app="$1"
  [[ -f "$target_app/Contents/MacOS/Antigravity" ]] || return 0
  node -e '
  const fs = require("fs");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const appExec = fs.realpathSync(path.join(process.argv[1], "Contents", "MacOS", "Antigravity"));
  const appPrefix = fs.realpathSync(process.argv[1]) + "/";
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8", LC_TIME: "C" },
  });
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmd = m[2];
    if (cmd === appExec || cmd.startsWith(appExec + " ") || cmd.startsWith(appPrefix)) {
      pids.push(Number(m[1]));
    }
  }
  process.stdout.write(pids.join(" "));
  ' "$target_app"
}

WAS_RUNNING=0
if [[ $STAGE_ONLY -eq 0 && -d "$APP" ]]; then
  PRE_PIDS="$(find_running_target_pids "$APP")"
  if [[ -n "$PRE_PIDS" ]]; then
    WAS_RUNNING=1
    if [[ $AUTO_RESTART -eq 0 ]]; then
      echo "检测到 $APP 正在运行 (PID: $PRE_PIDS)；请先 Cmd+Q 完全退出后再覆盖构建，或追加 --restart 自动退出并重启。" >&2
      exit 1
    fi
  fi
fi

if [[ ! -f "$SCRIPT_DIR/payload/dist/meter-renderer.js" ]] || \
   [[ "$SCRIPT_DIR/src/renderer/main.js" -nt "$SCRIPT_DIR/payload/dist/meter-renderer.js" ]] || \
   [[ "$SCRIPT_DIR/src/renderer/template.html" -nt "$SCRIPT_DIR/payload/dist/meter-renderer.js" ]] || \
   [[ "$SCRIPT_DIR/src/renderer/i18n.js" -nt "$SCRIPT_DIR/payload/dist/meter-renderer.js" ]] || \
   [[ "$SCRIPT_DIR/src/renderer/styles.css" -nt "$SCRIPT_DIR/payload/dist/meter-renderer.js" ]]; then
  echo "==> 编译 Context Meter 渲染层 (meter-renderer.js)"
  node "$SCRIPT_DIR/scripts/build-renderer.js"
fi

WORK="$(mktemp -d /tmp/hakimi-build.XXXXXX)"
if [[ $STAGE_ONLY -eq 0 ]]; then
  trap 'rm -rf "$WORK"' EXIT
fi

STAGE="$WORK/哈基米.app"
STAGE_LS="$STAGE/Contents/Resources/bin/language_server"
SRC_LS="$SRC/Contents/Resources/bin/language_server"

echo "==> 复制只读源 $SRC -> $STAGE"
cp -R -p "$SRC" "$STAGE"

# 在修改前从只读源提取官方 entitlements
ENT_APP="$WORK/app.entitlements"
ENT_LS="$WORK/ls.entitlements"
codesign -d --entitlements - --xml "$SRC"    2>/dev/null > "$ENT_APP" || true
codesign -d --entitlements - --xml "$SRC_LS" 2>/dev/null > "$ENT_LS"  || true
[[ -s "$ENT_APP" ]] || printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>' > "$ENT_APP"
[[ -s "$ENT_LS" ]] || cat <<'PLIST' > "$ENT_LS"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST

echo "==> [1/4] 写入地区 / Free-tier 解锁补丁 (authclient.ValidateAndOnboardAccount)"
python3 - "$STAGE_LS" <<'PY'
import hashlib, os, stat, struct, sys

path = sys.argv[1]
with open(path, 'rb') as f:
    data = bytearray(f.read())

EXPECTED_SHA256 = 'f5377993d29bc1036ed9ddbfb2aec55bb37b8aaaf811df4a8c3ed5763dde2db0'
actual_sha = hashlib.sha256(data).hexdigest()
if actual_sha != EXPECTED_SHA256:
    sys.exit(f"仅支持已核验的 Antigravity 2.32.1 ARM64 原始文件；当前 SHA256={actual_sha} 不匹配，停止处理")

# pclntab: magic 0xFFFFFFF1 (Go >= 1.20) / 0xFFFFFFF0
cands = []
for magic in (0xFFFFFFF1, 0xFFFFFFF0):
    pat = struct.pack('<I', magic) + b'\x00\x00'
    s = 0
    while True:
        i = data.find(pat, s)
        if i < 0:
            break
        cands.append((i, magic))
        s = i + 1

funcs = None
for i, magic in cands:
    try:
        nfunc, = struct.unpack('<Q', data[i+8:i+16])
        textStart, fnOff, cuOff, ftOff, pcOff, pclnOff = struct.unpack('<QQQQQQ', data[i+24:i+72])
    except Exception:
        continue
    if not (0 < nfunc < 500000 and 0 < pclnOff < len(data)):
        continue
    functab = i + pclnOff
    fnname = i + fnOff
    table = []
    for k in range(nfunc):
        entryoff, funcoff = struct.unpack('<II', data[functab+k*8: functab+k*8+8])
        fo = functab + funcoff
        nameoff, = struct.unpack('<i', data[fo+4:fo+8])
        ns = fnname + nameoff
        ne = data.find(b'\x00', ns)
        table.append((entryoff, data[ns:ne].decode('utf8', 'replace')))
    funcs = (i, table)
    break

if not funcs:
    sys.exit("找不到 Go pclntab，版本可能变了")

hdr, table = funcs
first_off, first_name = table[0]
if first_name != 'internal/abi.(*RegArgs).Dump':
    print(f"  注意: 首个符号为 {first_name}")

text_off = None
for cand in range(0x400, 0x4000, 4):
    w, = struct.unpack('<I', data[cand:cand+4])
    if (w & 0xFFC0001F) == (0xF9400000 | 16) and ((w >> 5) & 0x1f) == 28:
        text_off = cand
        break
if text_off is None:
    sys.exit("找不到 __text 起点")

target = 'authclient.ValidateAndOnboardAccount'
hit = [(o, n) for (o, n) in table if n.endswith(target)]
if not hit:
    sys.exit(f"函数表中找不到 {target}")

entryoff, name = hit[0]
start = text_off + entryoff
nxt = min((o for (o, _) in table if o > entryoff), default=entryoff + 0x2000)
end = text_off + nxt
print(f"  找到 {name.split('/')[-1]} @ file offset 0x{start:x} (len 0x{end-start:x})")

CMP_X8_9 = 0xf100251f
spots = []
for off in (start + 0x294,):
    w, = struct.unpack('<I', data[off:off+4])
    if w != CMP_X8_9:
        continue
    b, = struct.unpack('<I', data[off+4:off+8])
    if (b & 0xfc000000) != 0x54000000:
        continue
    imm19 = (b >> 5) & 0x7ffff
    if imm19 >= (1 << 18):
        imm19 -= (1 << 19)
    tgt = off + 4 + imm19 * 4
    if tgt < off:
        spots.append((off + 4, b, tgt))

if len(spots) != 1:
    sys.exit(f"期望命中 1 处，实际 {len(spots)} 处；版本可能变了，需人工确认")

b_off, b_word, tgt = spots[0]
off26 = (tgt - b_off) // 4
if off26 < -(1 << 25) or off26 >= (1 << 25):
    sys.exit("分支距离超出范围")
new = 0x14000000 | (off26 & 0x03ffffff)
data[b_off:b_off+4] = struct.pack('<I', new)

mode = stat.S_IMODE(os.stat(path).st_mode) or 0o755
tmp_path = f"{path}.region_tmp_{os.getpid()}"
with open(tmp_path, 'wb') as f:
    f.write(data)
os.chmod(tmp_path, mode)
os.replace(tmp_path, path)
print(f"  patched: file 0x{b_off:x}  {b_word:#010x}(b.cond) -> {new:#010x}(b)  target 0x{tgt:x}")
PY

echo "==> [2/4] 写入上下文窗口解锁 (${CONTEXT_MODE}${CONTEXT_LIMIT:+:$CONTEXT_LIMIT}) & 自动中文标题 (${CHINESE_TITLE})"
node -e '
const path = require("path");
const scriptDir = process.argv[1];
const stageLs = process.argv[2];
const appBundle = process.argv[3];
const workDir = process.argv[4];
const stageOnly = process.argv[5] === "1";
const contextMode = process.argv[6];
const contextLimit = process.argv[7];
const chineseTitle = process.argv[8];

const enhance = require(path.join(scriptDir, "payload", "dist", "meter-enhance.js"));
const contextUnlock = require(path.join(scriptDir, "payload", "dist", "meter-context-unlock.js"));

const recordedLs = stageOnly
  ? stageLs
  : path.join(appBundle, "Contents", "Resources", "bin", "language_server");

const enhanceOpts = {
  targets: [
    {
      id: "desktop",
      label: "哈基米.app 后端 (language_server)",
      path: stageLs,
    },
  ],
  recordedTargetPath: recordedLs,
  skipProcessCheck: true,
  skipCodesign: true,
};

if (stageOnly) {
  enhanceOpts.backupDir = path.join(workDir, "unlock-backups");
  enhanceOpts.stateDir = path.join(workDir, "state");
}

const payload = {
  chineseTitle: chineseTitle === "on",
  contextMode,
  ...(contextLimit ? { contextLimitTokens: Number(contextLimit) } : {}),
};

const res = enhance.applyEnhancePatch(payload, enhanceOpts);
if (!res || !res.ok) {
  console.error("applyEnhancePatch failed:", res && res.error ? res.error : res);
  process.exit(1);
}
for (const line of res.logs || []) {
  console.log(" ", line);
}

if (!stageOnly) {
  const ctxInfo = res.status && res.status.summary && res.status.summary.contextUnlock;
  const effMode = (ctxInfo && ctxInfo.configuredMode) || contextMode;
  const effLimit = (ctxInfo && ctxInfo.configuredLimitTokens) || (contextLimit ? Number(contextLimit) : null);
  contextUnlock.syncExternalContextConfigs(effMode, effLimit, {
    syncConfigFiles: true,
    syncCliConfigs: false,
  });
}
' "$SCRIPT_DIR" "$STAGE_LS" "$APP" "$WORK" "$STAGE_ONLY" "$CONTEXT_MODE" "$CONTEXT_LIMIT" "$CHINESE_TITLE"

echo "==> [3/4] 重新打包 app.asar (Context Meter + 客户端汉化)"
PACK_ARGS=(
  --src-asar "$SRC/Contents/Resources/app.asar"
  --dest-asar "$STAGE/Contents/Resources/app.asar"
  --hash-out "$WORK/asar.sha256"
)
if [[ -n "$ICON_PATH" ]]; then
  echo "==> [图标] 转换并替换应用图标: $ICON_PATH"
  ICON_ARGS=(
    --input "$ICON_PATH"
    --out-icns "$STAGE/Contents/Resources/icon.icns"
    --out-png "$WORK/custom-icon-512.png"
  )
  if [[ $RAW_ICON -eq 1 ]]; then
    ICON_ARGS+=(--no-mask)
  fi
  node "$SCRIPT_DIR/scripts/build-macos-icon.js" "${ICON_ARGS[@]}" >/dev/null
  PACK_ARGS+=(--icon-png "$WORK/custom-icon-512.png")
elif [[ $STAGE_ONLY -eq 0 && $FORCE_DEFAULT_ICON -eq 0 && -f "$APP/Contents/Resources/icon.icns" && -f "$APP/Contents/Resources/app.asar" ]]; then
  SRC_ICNS_HASH="$(shasum -a 256 "$SRC/Contents/Resources/icon.icns" | awk '{print $1}')"
  CUR_ICNS_HASH="$(shasum -a 256 "$APP/Contents/Resources/icon.icns" | awk '{print $1}')"
  if [[ "$SRC_ICNS_HASH" != "$CUR_ICNS_HASH" ]]; then
    echo "==> [图标] 自动沿用当前 哈基米.app 的自定义图标 (如需恢复官方默认请传 --default-icon)"
    cp "$APP/Contents/Resources/icon.icns" "$STAGE/Contents/Resources/icon.icns"
    node -e '
    const fs = require("fs");
    const path = require("path");
    const { builtinAsar } = require(path.join(process.argv[1], "payload", "dist", "asar-engine.js"));
    const buf = builtinAsar.extractFile(path.join(process.argv[2], "Contents", "Resources", "app.asar"), "icon.png");
    fs.writeFileSync(process.argv[3], buf);
    ' "$SCRIPT_DIR" "$APP" "$WORK/carryover-icon-512.png"
    PACK_ARGS+=(--icon-png "$WORK/carryover-icon-512.png")
  fi
fi
if [[ $STAGE_ONLY -eq 1 ]]; then
  PACK_ARGS+=(--skip-config --state-dir "$WORK/state")
fi
if [[ -n "$CLIENT_LANG" ]]; then
  PACK_ARGS+=(--client-lang "$CLIENT_LANG")
fi
if [[ -n "$BRAND" ]]; then
  PACK_ARGS+=(--brand "$BRAND")
fi
ASAR_HASH="$(node "$SCRIPT_DIR/scripts/pack-hakimi-asar.js" "${PACK_ARGS[@]}")"
echo "  ElectronAsarIntegrity Resources/app.asar SHA256: $ASAR_HASH"

echo "==> [4/4] 更新 Info.plist ASAR 完整性摘要并重签名"
python3 - "$STAGE/Contents/Info.plist" "$ASAR_HASH" <<'PY'
import plistlib, sys

plist_path, new_hash = sys.argv[1], sys.argv[2].strip()
if len(new_hash) != 64:
    sys.exit(f"非法 ASAR 摘要长度: {new_hash}")

with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)

integrity = plist.setdefault('ElectronAsarIntegrity', {})
app_entry = integrity.setdefault('Resources/app.asar', {'algorithm': 'SHA256'})
app_entry['algorithm'] = 'SHA256'
app_entry['hash'] = new_hash

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f, sort_keys=False)
PY

# 刷新主二进制 inode，避免 Apple Silicon cs_blob 缓存旧内核签名导致 SIGKILL
MAIN_EXEC="$STAGE/Contents/MacOS/Antigravity"
cp -p "$MAIN_EXEC" "$MAIN_EXEC.tmp_inode"
mv -f "$MAIN_EXEC.tmp_inode" "$MAIN_EXEC"

codesign --force --sign - --options runtime --entitlements "$ENT_LS" "$STAGE_LS"
# 外层不能加 --options runtime，否则 Library Validation 会拒绝 Google 原签的 Electron Framework
codesign --force --sign - --entitlements "$ENT_APP" "$STAGE"
codesign --verify --strict "$STAGE_LS" || { echo "language_server 签名校验失败" >&2; exit 1; }
codesign --verify --strict "$STAGE"    || { echo "外层应用包签名校验失败" >&2; exit 1; }

if [[ $STAGE_ONLY -eq 1 ]]; then
  echo "==> 完成 (--stage-only): $STAGE"
  exit 0
fi

if [[ -e "$APP" || -L "$APP" ]]; then
  if [[ $AUTO_RESTART -eq 1 ]]; then
    CUR_PIDS="$(find_running_target_pids "$APP")"
    if [[ -n "$CUR_PIDS" ]]; then
      WAS_RUNNING=1
      echo "==> 正在退出运行中的 $APP ..."
      for pid in $CUR_PIDS; do
        kill -TERM "$pid" 2>/dev/null || true
      done
      for _ in $(seq 1 30); do
        STILL_ALIVE=0
        for pid in $CUR_PIDS; do
          if kill -0 "$pid" 2>/dev/null; then
            STILL_ALIVE=1
            break
          fi
        done
        [[ $STILL_ALIVE -eq 0 ]] && break
        sleep 0.2
      done
    fi
  fi
  # 二次守卫后移除旧的 哈基米.app 副本
  node -e '
  const path = require("path");
  const { assertNotOfficialAntigravityApp } = require(path.join(process.argv[1], "payload", "dist", "asar-engine.js"));
  assertNotOfficialAntigravityApp(process.argv[2], "删除旧副本");
  ' "$SCRIPT_DIR" "$APP"
  rm -rf "$APP"
fi

echo "==> 安装独立应用: $APP"
mv "$STAGE" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
touch "$APP" 2>/dev/null || true
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP" 2>/dev/null || true
fi

if [[ $AUTO_RESTART -eq 1 && $WAS_RUNNING -eq 1 ]]; then
  echo "==> 重新打开 $APP"
  open "$APP"
fi

echo "==> 构建完成！"
echo "  独立应用: $APP"
echo "  原版官方: $SRC (未做任何修改)"
echo "  首次启动命令: open \"$APP\""
