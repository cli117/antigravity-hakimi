#!/bin/bash
# 哈基米.app 独立构建脚本（专注 macOS，支持 Apple Silicon arm64 与 Intel x86_64；Linux 下自动直跑 agy CLI 解锁）
#
# 功能说明：
#   1. 默认直接从官方更新源拉取/复用单槽位缓存最新 Antigravity（校验 SHA-512 与 Google 签名）构建 /Applications/哈基米.app，
#      无需预先安装或手动更新原版 /Applications/Antigravity.app（断网时若本机存在官方包则自动回退）
#   2. 严格保护官方 /Applications/Antigravity.app 及 .orig 绝不被修改
#   3. 默认允许覆盖旧副本、联动解锁本机 agy CLI，并在完成后自动重启或首次打开 /Applications/哈基米.app
#   4. 内核级与客户端能力整合：
#      - 账号地区 / Free-tier 检测解锁 (ValidateAndOnboardAccount)
#      - 双源静默自动升级与原子冷替换（官方更新源 + 哈基米 main）
#      - 桌面端简体中文界面（纯本地 DOM 翻译，不影响请求与提示词）
#      - 实时上下文占用监控、速率监测、8 类错误诊断与纯 Token 消费历史看板
#
# 用法:
#   ./build-hakimi.sh                          # 一步到位：拉最新 + 覆盖安装 + 解锁 CLI + 自动打开/重启
#   ./build-hakimi.sh --icon ~/Pictures/a.jpg  # 构建并替换自定义应用图标
#   ./build-hakimi.sh --stage-only             # 仅在 /tmp 沙盒试构建并验签，不动 /Applications 与用户配置
#   ./build-hakimi.sh --local                  # 纯离线使用本机 /Applications/Antigravity.app 构建
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP="/Applications/哈基米.app"
SRC=""
SOURCE_MODE="auto"
SOURCE_KIND="official-local"
FETCH_SOURCE=""
STAGE_ONLY=0
FORCE=1
CLIENT_LANG=""
ICON_PATH=""
RAW_ICON=0
FORCE_DEFAULT_ICON=0
AUTO_RESTART=1
PATCH_CLI=1
CLI_STRICT=0
CLI_ONLY=0
CLI_BIN=""
# 目标架构：auto 时按本机 uname -m 推导（arm64 / x64），也可用 --arch 显式指定
TARGET_ARCH="auto"

usage() {
  cat <<'EOF'
用法: ./build-hakimi.sh [选项]

默认行为（直接运行 ./build-hakimi.sh 即可）：
  - 默认从官方更新源拉取/复用最新 Antigravity（校验 SHA-512 与 Google 签名），无需本机先装原版
    （断网且本机存在 /Applications/Antigravity.app 时自动回退本机源）
  - 默认允许覆盖已存在的 /Applications/哈基米.app（严禁覆盖官方 Antigravity.app）
  - 默认联动检测并解锁本机 agy CLI（未安装或权限不足时柔和提示，不阻断主构建；Linux 下自动直跑 CLI 解锁）
  - 默认在构建完成后自动重启运行中的 哈基米.app，或首次自动打开 哈基米.app

选项:
  --stage-only                    仅在 /tmp 临时目录试构建并验签，不写入 /Applications、不改用户配置目录、不打开应用
  --local                         强制纯离线使用本机只读官方源 (优先 /Applications/Antigravity.app.orig，其次 /Applications/Antigravity.app)
  --from <path>                   显式指定只读官方 Antigravity.app 本地源路径
  --fetch-latest                  强制从官方更新源拉取/复用最新 Antigravity（默认行为；显式指定时断网不回退本机旧版）
  --app <path>                    指定输出 .app 路径 (默认: /Applications/哈基米.app；严禁指向官方 Antigravity.app)
  -i, --icon <path>               可选：指定本地图片 (PNG/JPG/WebP/HEIC/ICNS 等) 作为应用图标 (不传时若旧副本已有自定义图标会自动保留)
  --raw-icon                      可选：配合 --icon 使用，不自动添加 macOS 圆角矩形留白遮罩
  --default-icon                  可选：覆盖旧副本时强制恢复为默认官方图标
  --no-restart, --no-open         构建完成后不自动退出/重启或自动打开目标应用
  --no-cli                        跳过本机 agy CLI 地区解锁联动
  --no-overwrite                  若输出 .app 路径已存在则报错退出而不覆盖
  --cli-only                      仅对本机 agy CLI 执行地区解锁，跳过 macOS 桌面应用构建（支持 Linux x86-64/arm64 与 macOS arm64/x86_64）
  --cli-bin <path>                指定 agy 二进制路径并严格校验解锁
  --client-lang <zh-CN|en>        桌面端界面语言 (首次写入配置默认为 zh-CN)
  --arch <auto|arm64|x64>         目标架构 (默认 auto：Apple Silicon 取 arm64，Intel 取 x64；显式指定可交叉构建)
  --force, -r, --restart, --patch-cli
                                  向下兼容参数（现均已默认开启；显式传 --patch-cli 时 CLI 解锁失败会返回非 0）
  -h, --help                      显示本帮助信息
EOF
}

require_arg() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "选项 $1 需要提供参数值" >&2
    exit 2
  fi
}

set_source_mode() {
  local next_mode="$1"
  if [[ "$SOURCE_MODE" != "auto" && "$SOURCE_MODE" != "$next_mode" ]]; then
    echo "源选项冲突：--fetch-latest、--local 与 --from 不能同时指定" >&2
    exit 2
  fi
  SOURCE_MODE="$next_mode"
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
    --no-overwrite)
      FORCE=0
      shift
      ;;
    --from)
      require_arg "$@"
      set_source_mode "from"
      SRC="$2"
      shift 2
      ;;
    --local)
      set_source_mode "local"
      shift
      ;;
    --fetch-latest)
      set_source_mode "latest"
      shift
      ;;
    --app)
      require_arg "$@"
      APP="$2"
      shift 2
      ;;
    --patch-cli)
      PATCH_CLI=1
      CLI_STRICT=1
      shift
      ;;
    --no-cli)
      PATCH_CLI=0
      CLI_STRICT=0
      shift
      ;;
    --cli-only)
      CLI_ONLY=1
      PATCH_CLI=1
      CLI_STRICT=1
      shift
      ;;
    --cli-bin)
      require_arg "$@"
      CLI_BIN="$2"
      PATCH_CLI=1
      CLI_STRICT=1
      shift 2
      ;;
    --client-lang)
      require_arg "$@"
      CLIENT_LANG="$2"
      shift 2
      ;;
    --arch)
      require_arg "$@"
      TARGET_ARCH="$2"
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
    --no-restart|--no-open)
      AUTO_RESTART=0
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

if [[ -n "$CLIENT_LANG" ]]; then
  case "$CLIENT_LANG" in
    zh-CN|en) ;;
    *) echo "无效 --client-lang: $CLIENT_LANG (可选: zh-CN | en)" >&2; exit 2 ;;
  esac
fi

# 架构别名归一化（x86_64/amd64 -> x64，aarch64 -> arm64），再校验取值
case "$TARGET_ARCH" in
  x86_64|amd64|X64|x86-64) TARGET_ARCH="x64" ;;
  aarch64|ARM64)           TARGET_ARCH="arm64" ;;
esac
case "$TARGET_ARCH" in
  auto|arm64|x64) ;;
  *) echo "无效 --arch: $TARGET_ARCH (可选: auto | arm64 | x64)" >&2; exit 2 ;;
esac

run_cli_unlock() {
  if command -v node >/dev/null 2>&1; then
    local cli_args=(--apply)
    if [[ -n "$CLI_BIN" ]]; then
      cli_args+=(--binary "$CLI_BIN" --strict)
    fi
    node "$SCRIPT_DIR/scripts/cli-unlock.js" "${cli_args[@]}"
    return $?
  elif command -v python3 >/dev/null 2>&1; then
    local py_args=(--in-place)
    [[ -n "$CLI_BIN" ]] && py_args+=(--binary "$CLI_BIN")
    python3 "$SCRIPT_DIR/unlock/agy-cli/agy-patch.py" "${py_args[@]}"
    return $?
  else
    echo "缺少 node 或 python3，无法修补 agy CLI" >&2
    return 1
  fi
}

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

# auto 架构：Apple Silicon 取 arm64，其余（x86_64 Intel）取 x64
if [[ "$TARGET_ARCH" == "auto" ]]; then
  case "$HOST_ARCH" in
    x86_64|amd64|i386) TARGET_ARCH="x64" ;;
    *)                 TARGET_ARCH="arm64" ;;
  esac
fi

if [[ $CLI_ONLY -eq 1 ]]; then
  echo "==> [CLI] 对本机 agy CLI 执行地区解锁"
  run_cli_unlock
  exit $?
fi

if [[ "$HOST_OS" != "Darwin" ]]; then
  if [[ $PATCH_CLI -eq 1 ]]; then
    echo "==> 检测到当前系统为 ${HOST_OS}（非 macOS）：跳过桌面端 哈基米.app 构建，直接修补本机 agy CLI"
    run_cli_unlock
    exit $?
  fi
  echo "当前系统为 ${HOST_OS}：桌面端 哈基米.app 构建仅支持 macOS。" >&2
  echo "如需在 Linux 开发机解锁 agy CLI，请直接运行:" >&2
  echo "  bash ./build-hakimi.sh" >&2
  echo "  或 npm run unlock:cli" >&2
  echo "  或（无 Node 环境）python3 unlock/agy-cli/agy-patch.py --in-place" >&2
  exit 1
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

if [[ $STAGE_ONLY -eq 0 && ( -e "$APP" || -L "$APP" ) && $FORCE -eq 0 ]]; then
  echo "输出路径已存在: $APP （已指定 --no-overwrite；如需覆盖请去掉 --no-overwrite，或用 --app 指定新路径）" >&2
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

# shellcheck source=scripts/lib/target-app-lifecycle.sh
source "$SCRIPT_DIR/scripts/lib/target-app-lifecycle.sh"

WAS_RUNNING=0
if [[ $STAGE_ONLY -eq 0 && -d "$APP" ]]; then
  PRE_PIDS="$(find_running_target_pids "$APP")"
  if [[ -n "$PRE_PIDS" ]]; then
    WAS_RUNNING=1
    if [[ $AUTO_RESTART -eq 0 ]]; then
      echo "检测到 $APP 正在运行 (PID: $PRE_PIDS)；已指定 --no-restart，请先 Cmd+Q 完全退出后再覆盖构建，或去掉 --no-restart 自动退出并重启。" >&2
      exit 1
    fi
  fi
fi

WORK="$(mktemp -d /tmp/hakimi-build.XXXXXX)"
if [[ $STAGE_ONLY -eq 0 ]]; then
  trap 'rm -rf "$WORK"' EXIT
fi

PROMOTE_ZIP_PATH=""
PROMOTE_ZIP_VERSION=""
PROMOTE_ZIP_SHA512=""

if [[ "$SOURCE_MODE" == "auto" || "$SOURCE_MODE" == "latest" ]]; then
  echo "==> [源获取] 目标架构: ${TARGET_ARCH}（本机 ${HOST_ARCH}）"
  if [[ "$TARGET_ARCH" == "x64" && "$HOST_ARCH" == "arm64" ]] || [[ "$TARGET_ARCH" == "arm64" && "$HOST_ARCH" == "x86_64" ]]; then
    echo "⚠️  正在交叉构建（目标 ${TARGET_ARCH} / 本机 ${HOST_ARCH}）：产物只能在与目标架构一致或更高级的机器上运行。" >&2
  fi
  echo "==> [源获取] 正在从官方更新源检查并获取最新 Antigravity（优先复用本地单槽位缓存，校验 SHA-512 与 Google 签名）..."
  FETCH_OUT="$WORK/fetched-official"
  FETCH_CMD=(node "$SCRIPT_DIR/payload/dist/hakimi-builder.js" fetch-official --out-app-dir "$FETCH_OUT" --arch "$TARGET_ARCH" --json)
  if [[ $STAGE_ONLY -eq 0 ]]; then
    FETCH_CMD+=(--keep-zip-out "$WORK/official-verified.zip")
  fi
  FETCH_ERR="$WORK/fetch-official.err"
  if FETCH_JSON="$("${FETCH_CMD[@]}" 2>"$FETCH_ERR")"; then
    FETCH_META_LINES="$(node -e '
      const data = JSON.parse(process.argv[1]);
      process.stdout.write([
        data.appPath || "",
        data.version || "",
        data.sha512 || "",
        data.source || "",
        data.needsPromotion ? (data.zipPath || "") : "",
      ].join("\n") + "\n");
    ' "$FETCH_JSON")"
    {
      IFS= read -r SRC || true
      IFS= read -r PROMOTE_ZIP_VERSION || true
      IFS= read -r PROMOTE_ZIP_SHA512 || true
      IFS= read -r FETCH_SOURCE || true
      IFS= read -r PROMOTE_ZIP_PATH || true
    } <<< "$FETCH_META_LINES"
    SOURCE_KIND="official-feed"
    echo "  官方源已就绪: v${PROMOTE_ZIP_VERSION} (${FETCH_SOURCE})"
  else
    FETCH_ERR_MSG="$(tr '\n' ' ' < "$FETCH_ERR" 2>/dev/null | sed 's/[[:space:]]*$//')"
    if [[ "$SOURCE_MODE" == "auto" && ( -d "/Applications/Antigravity.app.orig" || -d "/Applications/Antigravity.app" ) ]]; then
      echo "⚠️  无法从官方更新源获取最新版（${FETCH_ERR_MSG:-网络或校验异常}），自动回退至本机只读官方源" >&2
      SRC=""
      SOURCE_KIND="official-local"
    else
      echo "从官方更新源拉取最新 Antigravity 失败: ${FETCH_ERR_MSG:-未知错误}" >&2
      echo "提示: 请检查网络连接，或使用 --local / --from <path> 指定本机 Antigravity.app。" >&2
      exit 1
    fi
  fi
fi

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

# 校验本地源架构与目标架构一致（避免在 Intel 机上误用 arm64 底包，反之亦然）
SRC_ARCH="$(node -e '
const fs = require("fs");
const buf = Buffer.alloc(8);
const fd = fs.openSync(process.argv[1], "r");
fs.readSync(fd, buf, 0, 8, 0);
fs.closeSync(fd);
const magic = buf.readUInt32LE(0);
if (magic !== 0xfeedfacf) { process.stdout.write("unknown"); process.exit(0); }
const cpu = buf.readUInt32LE(4);
process.stdout.write(cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : "unknown");
' "$SRC/Contents/MacOS/Antigravity" 2>/dev/null || echo unknown)"
if [[ "$SRC_ARCH" != "unknown" && "$SRC_ARCH" != "$TARGET_ARCH" ]]; then
  echo "源应用架构为 ${SRC_ARCH}，与目标架构 ${TARGET_ARCH} 不一致: $SRC" >&2
  if [[ "$SOURCE_MODE" == "local" || "$SOURCE_MODE" == "from" ]]; then
    echo "提示: --local / --from 指向的官方包只能是当前机器架构；如需 Intel 版本请去掉 --local 由官方更新源拉取 --arch x64。" >&2
  fi
  exit 1
fi

SRC_VERSION="$(node -e '
const path = require("path");
const { readBundleShortVersion } = require(path.join(process.argv[1], "payload", "dist", "modules-config.js"));
process.stdout.write(readBundleShortVersion(path.join(process.argv[2], "Contents", "Info.plist")) || "unknown");
' "$SCRIPT_DIR" "$SRC")"
echo "==> 只读官方源: $SRC (版本: v$SRC_VERSION)"

NEED_BUILD_RENDERER=0
RENDERER_OUT="$SCRIPT_DIR/payload/dist/meter-renderer.js"
if [[ ! -f "$RENDERER_OUT" ]]; then
  NEED_BUILD_RENDERER=1
else
  for renderer_dep in "$SCRIPT_DIR"/src/renderer/* "$SCRIPT_DIR/scripts/build-renderer.js" "$SCRIPT_DIR/package.json"; do
    if [[ -f "$renderer_dep" && "$renderer_dep" -nt "$RENDERER_OUT" ]]; then
      NEED_BUILD_RENDERER=1
      break
    fi
  done
fi
if [[ $NEED_BUILD_RENDERER -eq 1 ]]; then
  echo "==> 编译 Context Meter 渲染层 (meter-renderer.js)"
  node "$SCRIPT_DIR/scripts/build-renderer.js"
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

echo "==> [1/3] 写入地区 / Free-tier 解锁补丁 (authclient.ValidateAndOnboardAccount)"
node "$SCRIPT_DIR/scripts/region-unlock.js" --apply "$STAGE_LS"

echo "==> [2/3] 重新打包 app.asar (Context Meter + 客户端汉化)"
PACK_ARGS=(
  --src-asar "$SRC/Contents/Resources/app.asar"
  --dest-asar "$STAGE/Contents/Resources/app.asar"
  --hash-out "$WORK/asar.sha256"
)
USING_CUSTOM_ICON=0
if [[ -n "$ICON_PATH" ]]; then
  USING_CUSTOM_ICON=1
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
    USING_CUSTOM_ICON=1
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
if [[ $USING_CUSTOM_ICON -eq 1 ]]; then
  rm -f "$STAGE/Contents/Resources/Assets.car"
fi
if [[ $STAGE_ONLY -eq 1 ]]; then
  PACK_ARGS+=(--skip-config --state-dir "$WORK/state")
fi
if [[ -n "$CLIENT_LANG" ]]; then
  PACK_ARGS+=(--client-lang "$CLIENT_LANG")
fi
ASAR_HASH="$(node "$SCRIPT_DIR/scripts/pack-hakimi-asar.js" "${PACK_ARGS[@]}")"
echo "  ElectronAsarIntegrity Resources/app.asar SHA256: $ASAR_HASH"

echo "==> [3/3] 更新 Info.plist ASAR 完整性摘要并重签名"
python3 - "$STAGE/Contents/Info.plist" "$ASAR_HASH" "$USING_CUSTOM_ICON" <<'PY'
import plistlib, sys

plist_path, new_hash, using_custom_icon = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
if len(new_hash) != 64:
    sys.exit(f"非法 ASAR 摘要长度: {new_hash}")

with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)

integrity = plist.setdefault('ElectronAsarIntegrity', {})
app_entry = integrity.setdefault('Resources/app.asar', {'algorithm': 'SHA256'})
app_entry['algorithm'] = 'SHA256'
app_entry['hash'] = new_hash

if using_custom_icon == '1':
    plist.pop('CFBundleIconName', None)

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f, sort_keys=False)
PY

# 写入构建回执（Contents/Resources/hakimi-build-meta.json），供应用内自更新识别当前版本与 commit
HAKIMI_PKG_VERSION="$(node -e 'const fs=require("fs"); try{process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version||""));}catch{}' "$SCRIPT_DIR/package.json")"
HAKIMI_GIT_SHA=""
HAKIMI_GIT_DATE=""
HAKIMI_GIT_DIRTY="0"
if command -v git >/dev/null 2>&1 && git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HAKIMI_GIT_SHA="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"
  HAKIMI_GIT_DATE="$(git -C "$SCRIPT_DIR" show -s --format=%cI HEAD 2>/dev/null || true)"
  if [[ -n "$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null || true)" ]]; then
    HAKIMI_GIT_DIRTY="1"
  fi
fi
META_ARGS=(
  write-meta
  --app "$STAGE"
  --ag-version "$SRC_VERSION"
  --source-kind "$SOURCE_KIND"
  --dirty "$HAKIMI_GIT_DIRTY"
)
[[ -n "$HAKIMI_PKG_VERSION" ]] && META_ARGS+=(--hakimi-version "$HAKIMI_PKG_VERSION")
[[ -n "$HAKIMI_GIT_SHA" ]] && META_ARGS+=(--commit "$HAKIMI_GIT_SHA")
[[ -n "$HAKIMI_GIT_DATE" ]] && META_ARGS+=(--commit-date "$HAKIMI_GIT_DATE")
node "$SCRIPT_DIR/payload/dist/hakimi-builder.js" "${META_ARGS[@]}" >/dev/null

# 刷新主二进制 inode，避免内核缓存旧页签名（Apple Silicon cs_blob 缓存 / Intel 旧 mmap）导致启动即 SIGKILL
MAIN_EXEC="$STAGE/Contents/MacOS/Antigravity"
cp -p "$MAIN_EXEC" "$MAIN_EXEC.tmp_inode"
mv -f "$MAIN_EXEC.tmp_inode" "$MAIN_EXEC"

codesign --force --sign - --options runtime --entitlements "$ENT_LS" "$STAGE_LS"
# 外层不能加 --options runtime，否则 Library Validation 会拒绝 Google 原签的 Electron Framework
codesign --force --sign - --entitlements "$ENT_APP" "$STAGE"
codesign --verify --strict "$STAGE_LS" || { echo "language_server 签名校验失败" >&2; exit 1; }
codesign --verify --strict "$STAGE"    || { echo "外层应用包签名校验失败" >&2; exit 1; }

if [[ $STAGE_ONLY -eq 1 ]]; then
  rm -rf "$WORK/fetched-official"
  echo "==> 完成 (--stage-only): $STAGE"
  exit 0
fi

if [[ -e "$APP" || -L "$APP" ]]; then
  if [[ $AUTO_RESTART -eq 1 ]]; then
    CUR_PIDS="$(find_running_target_pids "$APP" all)"
    if [[ -n "$CUR_PIDS" ]]; then
      WAS_RUNNING=1
      echo "==> 正在退出运行中的 $APP ..."
      stop_running_target_app "$APP"
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

if [[ -n "$PROMOTE_ZIP_PATH" && -f "$PROMOTE_ZIP_PATH" && -n "$PROMOTE_ZIP_VERSION" ]]; then
  node "$SCRIPT_DIR/payload/dist/hakimi-builder.js" promote-clean-base \
    --zip "$PROMOTE_ZIP_PATH" \
    --version "$PROMOTE_ZIP_VERSION" \
    --sha512 "$PROMOTE_ZIP_SHA512" >/dev/null 2>&1 || true
fi

if [[ $PATCH_CLI -eq 1 ]]; then
  echo "==> [CLI] 检测并解锁本机 agy CLI"
  if [[ $CLI_STRICT -eq 1 ]]; then
    run_cli_unlock
  else
    if ! run_cli_unlock; then
      echo "⚠️  agy CLI 自动解锁未完成（不影响 哈基米.app 正常使用；如目录需管理员权限可运行: sudo npm run unlock:cli）" >&2
    fi
  fi
fi

if [[ $AUTO_RESTART -eq 1 ]]; then
  if [[ $WAS_RUNNING -eq 1 ]]; then
    echo "==> 重新打开 $APP"
    sleep 0.5
  else
    echo "==> 正在打开 $APP"
    sleep 0.3
  fi
  env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ASAR -u NODE_OPTIONS -u ELECTRON_OZONE_PLATFORM_HINT -u DEV_URL open -n "$APP"
fi

echo "==> 构建完成！"
echo "  独立应用: $APP"
if [[ "$SOURCE_KIND" == "official-feed" ]]; then
  echo "  官方底座: 官方更新源 v$SRC_VERSION (${FETCH_SOURCE:-verified}，已校验 SHA-512 与 Google 签名)"
else
  echo "  原版官方: $SRC (只读源，未做任何修改)"
fi
if [[ $AUTO_RESTART -eq 0 ]]; then
  echo "  启动命令: open \"$APP\""
fi
