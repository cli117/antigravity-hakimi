# AGENTS.md — `antigravity-hakimi` (`哈基米.app`)

面向在本仓库工作的 AI Agent 与开发者的约束与工程指南。

---

## 1. 项目概述

- **运行环境**：macOS Apple Silicon (`arm64`)，Node.js `>=22.4.0`。
- **核心机制**：从只读官方 `/Applications/Antigravity.app`（或 `/Applications/Antigravity.app.orig`）复制并构建完全独立的增强版桌面客户端 `/Applications/哈基米.app`。
- **身份复用**：保留内部 `CFBundleIdentifier` (`com.google.antigravity`) 与主可执行文件名 `Antigravity`，以与官方客户端无缝共享 Google 登录态、历史会话及用户数据目录，同时严格隔离应用二进制本身。

---

## 2. 硬性安全与工程红线（不可违背）

1. **严禁修改官方原版应用**
   - 任何时候都**不得**写入、修补、替换或重签名 `/Applications/Antigravity.app`、`/Applications/Antigravity.app.orig` 或指向它们的符号链接。
   - 所有写入/删除/签名路径必须通过 `payload/dist/asar-engine.js` 中的 `assertNotOfficialAntigravityApp()` 守卫。
2. **禁止在 Agent 会话内自动杀掉或重启运行中的 `哈基米.app`**
   - 若 Agent 正运行在 `/Applications/哈基米.app` 内，**禁止**主动执行 `build-hakimi.sh --restart`、`set-hakimi-icon.sh --restart`，或手工 `kill`/`pkill` `哈基米.app` / `language_server`（会导致当前宿主进程与对话在执行途中直接中断）；仅在用户明确要求立刻重启时例外。
   - 会话内验证请优先使用 `npm test`、`npm run doctor`，或 `bash ./build-hakimi.sh --stage-only`（仅在 `/tmp` 构建并校验签名，不动 `/Applications` 与用户配置目录）。
3. **禁止直接手改渲染层编译产物**
   - `payload/dist/meter-renderer.js` 是由 `src/renderer/*` 编译生成的单文件产物。所有 UI / 前端逻辑修改必须改在 `src/renderer/` 下，并运行 `npm run build:renderer`（`npm test` 的 `pretest` 钩子也会自动执行）。
4. **禁止重新引入已裁剪功能符号（`EXCLUDED_SYMBOLS`）**
   - `test/asar-and-pruning.test.js` 会扫描 `payload/dist/*.js` 与 `src/renderer/*` 的全文（包括注释）。**绝对不要**重新引入任何已在 `EXCLUDED_SYMBOLS` 中列出的标识符（已裁剪范围：免 TUN 代理、一键开 CLI 按钮、GitHub 自动更新器、提示词精简档位，以及 API 参考计价/汇率/订阅费用统计）。

---

## 3. 常用开发、构建与诊断命令

```bash
# 编译渲染层 src/renderer/* -> payload/dist/meter-renderer.js
npm run build:renderer

# 自动重新编译渲染层并运行全部单元测试
npm test

# 只读健康诊断（官方包隔离、版本同步、ASAR 摘要、codesign、补丁、进程与 agy CLI）
npm run doctor
# 支持参数：node scripts/doctor.js --json --allow-missing

# 安全沙盒构建验证（仅在 /tmp 目录构建并执行 codesign --verify --strict，不改 /Applications）
bash ./build-hakimi.sh --stage-only

# 构建并安装到 /Applications/哈基米.app（由用户在独立终端按需执行）
bash ./build-hakimi.sh --force --restart
bash ./build-hakimi.sh --force --patch-cli --restart

# 仅对已构建的 哈基米.app 秒级更换图标或还原默认图标
bash ./set-hakimi-icon.sh <img_path|--restore> [--raw-icon] [--restart]

# 单独修补本机 agy CLI 二进制并同步 CLI 上下文配置
npm run unlock:cli
```

---

## 4. 仓库结构与核心模块

- `build-hakimi.sh`：主构建脚本（只读源拷贝、可选图标处理、`language_server` 补丁、ASAR 重打包、`ElectronAsarIntegrity` 同步、inode 刷新、`codesign` 签名、可选进程优雅关闭/重启及 CLI 联动）。
- `set-hakimi-icon.sh`：针对已存在 `/Applications/哈基米.app` 原位替换 `Contents/Resources/icon.icns` 与 `app.asar/icon.png` 并刷新完整性与签名的轻量脚本。
- `scripts/`：
  - `build-renderer.js`：将 `src/renderer/` 各源文件拼装编译为 `payload/dist/meter-renderer.js`。
  - `pack-hakimi-asar.js` / `replace-asar-icon.js`：解包官方 `app.asar`、清理遗留注入、写入 4 处 `dist/utils.js` 钩子与 `dist/preload.js`、支持替换内置 `icon.png`，并输出 Header SHA-256。
  - `build-macos-icon.js`：本地图片转换为 macOS `.icns` 与 `512x512` Dock PNG（默认按透明边缘自适应裁剪 + 圆角遮罩）。
  - `region-unlock.js` / `cli-unlock.js` / `doctor.js`：账号地区解锁 CLI、`agy` CLI 解锁 CLI、只读健康诊断工具。
- `payload/dist/`：
  - `asar-engine.js`：纯 Node ASAR 读写引擎、`computeAsarHeaderSha256()`、`getHakimiAppPath()`、`assertNotOfficialAntigravityApp()`。
  - `modular-installer.js` / `modules-config.js`：`app.asar` 注入配置管理与 `~/.antigravity-context-meter/` 持久化工具（含 `cleanupStaleSingletonLock()`）。
  - `meter-region-unlock.js`：自适应 Mach-O `__TEXT` + Go `.gopclntab`（`0xFFFFFFF1` / `0xFFFFFFF0`）符号解析器，定位 `authclient.ValidateAndOnboardAccount` 并自适应修补 `"free-tier"` 分支（不依赖写死二进制 SHA-256 或固定偏移）。
  - `meter-context-unlock.js`：ARM64 Gate 3A（`CLAMP_256K_ARM64` / `DEF_ORIG_ARM64`）与 Gate 3B（`config.applyFeatureProviderCheckpointOverrideConfig`）双门上下文窗口补丁引擎，支持 `default` (256K) / `fixed` (`16384..2097152`) / `dynamic`；包含 `restoreUnlock()`。
  - `meter-enhance.js`：`language_server` 中文会话主标题 & 章节标题等长可逆 ASCII 补丁引擎；包含 `restoreAllEnhance()`。
  - `meter-cli-unlock.js`（与 `unlock/agy-cli/agy-patch.py`）：`agy` CLI 机型白名单绕过与 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 修复补丁及配置同步。
  - `meter-main.js` / `local-api.js` / `meter-collector.js` / `meter-core.js` / `meter-storage.js` / `attachment_scan.py`：主进程 IPC、本地 API、对话轨迹采集、纯 Token 统计分析、历史存储与附件预算估算。
  - `i18n/i18n-runtime.js` & `i18n/zh-CN.json`：桌面端界面全量简体中文运行时与四态品牌标题控制（`hakimi` / `translated` / `hidden` / `english`）。
- `src/renderer/`：Context Meter 悬浮胶囊、一级顶栏纯图标快捷操作 & `#topbar-window-popover`、会话详情、模型上下文设置、速率对比与纯 Token 热力图源码（`template.html`、`styles.css`、`i18n.js`、`colors.js`、`dropdown.js`、`heatmap.js`、`context-budget-engine.js`、`main.js`）。
- `test/`：
  - `arm64-patches.test.js`：Mach-O / `.gopclntab` / ARM64 / `agy` CLI 二进制补丁与可逆性测试。
  - `asar-and-pruning.test.js`：语法校验、裁剪符号扫描、DOM 结构与顶栏不变量、ASAR 打包/图标替换、官方路径守卫、`doctor` 与重启退出屏障测试。

---

## 5. 关键不变量与常见踩坑

1. **补丁顺序与 UI“恢复官方设置”不可回滚地区解锁**
   - `build-hakimi.sh` 必须先执行 `meter-region-unlock.js`（修补 `ValidateAndOnboardAccount`），再由 `meter-context-unlock.js` / `meter-enhance.js` 生成备份；且 `restoreUnlock()` 与 `restoreAllEnhance()` 仅按精确字节切片还原上下文/中文标题，**绝不会**回滚地区解锁。
2. **渲染层模板与交互约束（均受自动化单测强制校验）**
   - `src/renderer/template.html` 中 `<div` 与 `</div>` 数量必须**严格相等**。
   - 一级顶栏快捷按钮（`#btn-topbar-compact`、`#btn-topbar-window`）必须保持**纯图标（仅含 `<svg>`），可见文本必须为空**，说明文案仅通过 `aria-label` / `data-tip` 悬停展示。
   - 在分模型作用域（`contextScopeMode === 'per_model'`）下，若当前模型尚未确认（`resolveQuickContextTarget()` 无法通过 `extractHostSelectedModel()` 或 `activeSessionModelConfirmed && activeSessionProductKey` 锁定目标），**禁止**静默回退到 `products[0]`，必须返回 `ready: false` 并禁用分模型预设按钮或引导切换为统一作用域。
   - 本项目只统计**纯 Token 用量**，不要新增任何金额/计价估算逻辑或恢复已删除的 `#ctx-breakdown-card`。
3. **macOS Apple Silicon 签名、Inode 缓存与重启黑屏陷阱**
   - 替换/重打包 `app.asar` 后必须同步更新 `Info.plist` 中 `ElectronAsarIntegrity['Resources/app.asar'].hash`（由 `computeAsarHeaderSha256()` 计算），否则 Electron 启动会校验崩溃。
   - 签名参数不可混用：`Contents/Resources/bin/language_server` 需加 `--options runtime --entitlements`；外层 `/Applications/哈基米.app` **绝对不能**加 `--options runtime`（否则 Library Validation 会拒绝加载 Google 签名的 `Electron Framework`）。
   - 修改 `Contents/MacOS/Antigravity` 或重签名前需先 `cp -p` + `mv -f` 刷新主可执行文件 inode，避免 Apple Silicon 内核 `cs_blob` 缓存旧签名引发 `SIGKILL`。
   - 自动重启已运行 `.app` 时必须使用 `stop_running_target_app`（主进程先行优雅 `SIGTERM` -> 全进程 `SIGTERM` -> 强制 `SIGKILL` 零存活屏障 + `cleanupStaleSingletonLock()`）后再用清理过环境变量的 `open -n "$APP"` 拉起，否则 `open` 会向濒死的旧 Electron 主进程发送 `activate` 导致空白黑屏窗口。
