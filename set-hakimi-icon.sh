#!/bin/bash
# 快速替换已构建 /Applications/哈基米.app 的应用图标（无需重跑完整 build）
#
# 说明：
#   - 仅更新 哈基米.app 的 Contents/Resources/icon.icns（访达/启动台）
#     和 Contents/Resources/app.asar 内根目录 icon.png（运行态 Dock 图标），
#     并更新 Info.plist ASAR 完整性摘要 + 重签外层 bundle。
#   - 绝不触碰 /Applications/Antigravity.app，也不重新复制/修改 205MB language_server，
#     原有的地区解锁、上下文窗口解锁、汉化配置与登录数据全部保持不变。
#
# 用法:
#   ./set-hakimi-icon.sh ~/Pictures/my-icon.png
#   ./set-hakimi-icon.sh --icon ~/Pictures/my-icon.jpg --restart
#   ./set-hakimi-icon.sh --restore
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP="/Applications/哈基米.app"
SRC=""
ICON_PATH=""
RAW_ICON=0
RESTORE=0
AUTO_RESTART=0

usage() {
  cat <<'EOF'
用法: ./set-hakimi-icon.sh [选项] [<图片路径>]

选项:
  -i, --icon <path>     指定本地图片 (PNG/JPG/WebP/HEIC/ICNS 等) 作为应用图标
  --raw-icon            配合 --icon 使用，不自动添加 macOS 圆角矩形留白遮罩
  --restore             还原为官方 /Applications/Antigravity.app 默认图标（只读读取，不改官方应用）
  --from <path>         配合 --restore 指定只读官方 Antigravity.app 源路径
  --app <path>          指定要替换图标的已构建 .app 路径 (默认: /Applications/哈基米.app；严禁指向官方应用)
  -r, --restart         若目标应用当前正在运行，自动优雅退出后再替换并重新打开
  -h, --help            显示本帮助信息
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
    -i|--icon)
      require_arg "$@"
      ICON_PATH="$2"
      shift 2
      ;;
    --raw-icon)
      RAW_ICON=1
      shift
      ;;
    --restore)
      RESTORE=1
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
    -r|--restart)
      AUTO_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$ICON_PATH" ]]; then
        ICON_PATH="$1"
        shift
      else
        echo "多余的位置参数: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

if [[ $RESTORE -eq 0 && -z "$ICON_PATH" ]]; then
  echo "请传入本地图片路径（或使用 --restore 恢复默认图标）" >&2
  usage >&2
  exit 2
fi

if [[ $RESTORE -eq 1 && -n "$ICON_PATH" ]]; then
  echo "--restore 与 --icon 不能同时指定" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo "缺少 node，请先安装 Node.js" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "缺少 python3" >&2; exit 1; }
command -v codesign >/dev/null 2>&1 || { echo "缺少 codesign (macOS Xcode CLI tools)" >&2; exit 1; }

# 严守只读边界：任何情况下禁止修改官方 Antigravity.app / .orig（含符号链接）
node -e '
const path = require("path");
const { assertNotOfficialAntigravityApp } = require(path.join(process.argv[1], "payload", "dist", "asar-engine.js"));
assertNotOfficialAntigravityApp(process.argv[2], "替换应用图标");
' "$SCRIPT_DIR" "$APP"

[[ -d "$APP" ]] || { echo "找不到已构建的应用: $APP （请先运行 bash ./build-hakimi.sh）" >&2; exit 1; }
[[ -f "$APP/Contents/Info.plist" ]] || { echo "目标缺少 Contents/Info.plist: $APP" >&2; exit 1; }
[[ -f "$APP/Contents/Resources/app.asar" ]] || { echo "目标缺少 Contents/Resources/app.asar: $APP" >&2; exit 1; }
[[ -f "$APP/Contents/MacOS/Antigravity" ]] || { echo "目标缺少 Contents/MacOS/Antigravity: $APP" >&2; exit 1; }

if [[ $RESTORE -eq 1 ]]; then
  if [[ -z "$SRC" ]]; then
    if [[ -d "/Applications/Antigravity.app.orig" ]]; then
      SRC="/Applications/Antigravity.app.orig"
    else
      SRC="/Applications/Antigravity.app"
    fi
  fi
  [[ -f "$SRC/Contents/Resources/icon.icns" ]] || { echo "官方源缺少 icon.icns: $SRC" >&2; exit 1; }
  [[ -f "$SRC/Contents/Resources/app.asar" ]] || { echo "官方源缺少 app.asar: $SRC" >&2; exit 1; }
else
  [[ -f "$ICON_PATH" ]] || { echo "找不到指定的图标文件: $ICON_PATH" >&2; exit 1; }
  command -v sips >/dev/null 2>&1 || { echo "自定义图标需要 macOS sips 工具" >&2; exit 1; }
  command -v iconutil >/dev/null 2>&1 || { echo "自定义图标需要 macOS iconutil 工具" >&2; exit 1; }
fi

# 检查目标应用是否正在运行（按精确可执行路径匹配，绝不误伤官方 Antigravity.app）
# shellcheck source=scripts/lib/target-app-lifecycle.sh
source "$SCRIPT_DIR/scripts/lib/target-app-lifecycle.sh"

RUNNING_PIDS="$(find_running_target_pids "$APP" all)"

WAS_RUNNING=0
if [[ -n "$RUNNING_PIDS" ]]; then
  WAS_RUNNING=1
  if [[ $AUTO_RESTART -eq 0 ]]; then
    echo "检测到 $APP 正在运行 (PID: $RUNNING_PIDS)；请先 Cmd+Q 完全退出后再替换图标，或追加 --restart 自动退出并重启。" >&2
    exit 1
  fi
  echo "==> 正在退出运行中的 $APP ..."
  stop_running_target_app "$APP"
fi

WORK="$(mktemp -d /tmp/hakimi-reicon.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

NEW_ICNS="$WORK/new.icns"
NEW_PNG="$WORK/new-512.png"

if [[ $RESTORE -eq 1 ]]; then
  echo "==> [1/4] 从只读源提取默认官方图标: $SRC"
  cp "$SRC/Contents/Resources/icon.icns" "$NEW_ICNS"
  node -e '
  const fs = require("fs");
  const path = require("path");
  const { builtinAsar } = require(path.join(process.argv[1], "payload", "dist", "asar-engine.js"));
  const buf = builtinAsar.extractFile(path.join(process.argv[2], "Contents", "Resources", "app.asar"), "icon.png");
  fs.writeFileSync(process.argv[3], buf);
  ' "$SCRIPT_DIR" "$SRC" "$NEW_PNG"
else
  echo "==> [1/4] 转换应用图标: $ICON_PATH"
  ICON_ARGS=(
    --input "$ICON_PATH"
    --out-icns "$NEW_ICNS"
    --out-png "$NEW_PNG"
  )
  if [[ $RAW_ICON -eq 1 ]]; then
    ICON_ARGS+=(--no-mask)
  fi
  node "$SCRIPT_DIR/scripts/build-macos-icon.js" "${ICON_ARGS[@]}" >/dev/null
fi

# 提取当前 app entitlements，避免丢失权限声明
ENT_APP="$WORK/app.entitlements"
codesign -d --entitlements - --xml "$APP" 2>/dev/null > "$ENT_APP" || true
[[ -s "$ENT_APP" ]] || printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>' > "$ENT_APP"

echo "==> [2/4] 仅替换 app.asar 内 icon.png 与 Contents/Resources/icon.icns"
cp "$NEW_ICNS" "$APP/Contents/Resources/icon.icns.tmp.$$"
mv -f "$APP/Contents/Resources/icon.icns.tmp.$$" "$APP/Contents/Resources/icon.icns"
if [[ $RESTORE -eq 1 ]]; then
  if [[ -f "$SRC/Contents/Resources/Assets.car" ]]; then
    cp "$SRC/Contents/Resources/Assets.car" "$APP/Contents/Resources/Assets.car.tmp.$$"
    mv -f "$APP/Contents/Resources/Assets.car.tmp.$$" "$APP/Contents/Resources/Assets.car"
  else
    rm -f "$APP/Contents/Resources/Assets.car"
  fi
else
  rm -f "$APP/Contents/Resources/Assets.car"
fi

ASAR_HASH="$(node "$SCRIPT_DIR/scripts/replace-asar-icon.js" \
  --asar "$APP/Contents/Resources/app.asar" \
  --icon-png "$NEW_PNG")"
echo "  新 ElectronAsarIntegrity Resources/app.asar SHA256: $ASAR_HASH"

echo "==> [3/4] 更新 Info.plist 摘要并重签外层应用（保留 language_server 原样）"
python3 - "$APP/Contents/Info.plist" "$ASAR_HASH" "$RESTORE" "${SRC:-}" <<'PY'
import os, plistlib, sys

plist_path, new_hash, restore_flag, src_app = sys.argv[1], sys.argv[2].strip(), sys.argv[3], sys.argv[4]
if len(new_hash) != 64:
    sys.exit(f"非法 ASAR 摘要长度: {new_hash}")

with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)

integrity = plist.setdefault('ElectronAsarIntegrity', {})
app_entry = integrity.setdefault('Resources/app.asar', {'algorithm': 'SHA256'})
app_entry['algorithm'] = 'SHA256'
app_entry['hash'] = new_hash

if restore_flag == '1':
    src_plist_path = os.path.join(src_app, 'Contents', 'Info.plist') if src_app else ''
    src_icon_name = None
    if src_plist_path and os.path.isfile(src_plist_path):
        with open(src_plist_path, 'rb') as sf:
            src_plist = plistlib.load(sf)
        src_icon_name = src_plist.get('CFBundleIconName')
    if src_icon_name:
        plist['CFBundleIconName'] = src_icon_name
    else:
        plist.pop('CFBundleIconName', None)
else:
    plist.pop('CFBundleIconName', None)

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f, sort_keys=False)
PY

# 刷新主二进制 inode，避免 Apple Silicon cs_blob 缓存旧签名导致 SIGKILL
MAIN_EXEC="$APP/Contents/MacOS/Antigravity"
cp -p "$MAIN_EXEC" "$MAIN_EXEC.tmp_inode"
mv -f "$MAIN_EXEC.tmp_inode" "$MAIN_EXEC"

codesign --force --sign - --entitlements "$ENT_APP" "$APP"
if [[ -f "$APP/Contents/Resources/bin/language_server" ]]; then
  codesign --verify --strict "$APP/Contents/Resources/bin/language_server" || { echo "language_server 签名校验失败" >&2; exit 1; }
fi
codesign --verify --strict "$APP" || { echo "外层应用包签名校验失败" >&2; exit 1; }

echo "==> [4/4] 刷新 macOS 图标缓存"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
touch "$APP" 2>/dev/null || true
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP" 2>/dev/null || true
fi

if [[ $AUTO_RESTART -eq 1 && $WAS_RUNNING -eq 1 ]]; then
  echo "==> 重新打开 $APP"
  sleep 0.5
  env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ASAR -u NODE_OPTIONS -u ELECTRON_OZONE_PLATFORM_HINT -u DEV_URL open -n "$APP"
fi

echo "==> 图标替换完成！($APP)"
