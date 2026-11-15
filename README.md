# antigravity-hakimi (`哈基米.app`)

> 专注 **macOS Apple Silicon (ARM64)**，基于只读官方 `/Applications/Antigravity.app` 复制并构建完全独立的增强版客户端 **`/Applications/哈基米.app`**，与官方客户端共享 Google 登录状态、历史对话与设置，同时**绝对不修改官方原版 `/Applications/Antigravity.app`（及 `.orig`）任何文件**。

---

## 核心特性

1. **账号地区 / Free-tier 限制自适应解锁与版本同步检测**
   - 通过 [`meter-region-unlock.js`](payload/dist/meter-region-unlock.js) 动态解析 `language_server` Mach-O Go `.gopclntab` 符号表与 `authclient.ValidateAndOnboardAccount` 指令特征，自动定位 `"free-tier"` 限制分支并打入无条件跳转补丁——**不再依赖写死二进制 SHA-256 或固定偏移 `+0x294`**；只有当新版底层函数或逻辑本身消失时才会安全中止报错。
   - **版本同步横幅**：面板自动对比只读官方 `/Applications/Antigravity.app` 与 `/Applications/哈基米.app` 的 `CFBundleShortVersionString`，当检测到官方客户端已更新时会在面板顶部提示重建命令。
   - **不可回滚保证**：脚本先应用地区解锁再由引擎生成备份，且 UI 内“恢复官方设置”仅原位还原上下文与中文标题字节，**绝不会回滚地区解锁**。
2. **上下文窗口解锁（桌面端 + `agy` CLI 联动）**
   - 桌面端原生支持 `default` (256K)、`fixed` (`16384 ~ 2097152`) 与 `dynamic`（默认启用，跟随模型原生上限透传），通过 ARM64 Gate 3A (`CLAMP_256K_ARM64` / `DEF_ORIG_ARM64`) 与 Gate 3B (`applyFeatureProviderCheckpointOverrideConfig`) 双重修补生效。
   - 渲染层 Hook 在发送 `SendUserCascadeMessage` 请求时按当前配置动态覆写 `checkpointConfig.maxTokenLimit`；设置面板与顶栏快调浮层均提供 `256K`、`512K`、`1M` 与 `动态跟随` 预设，支持自定义整数与 Apple Silicon (`arm64`) 在 UI 内即时保存应用。
   - **`agy` CLI 联动解锁**：内置 [`meter-cli-unlock.js`](payload/dist/meter-cli-unlock.js)（与 [`unlock/agy-cli/agy-patch.py`](unlock/agy-cli/agy-patch.py)），支持在构建时加 `--patch-cli`、独立执行 `npm run unlock:cli` 或在面板「配置」页点击按钮，一键修补本机 `agy` CLI 二进制（绕过 `/model` 上下文选择器机型白名单 + 修复 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 读取）并同步 CLI 配置文件。
3. **实时上下文监控与会话快捷操作**
   - 内置右上角悬浮胶囊（Context Meter）：实时展示当前上下文 Token 占用进度、输入/输出速率（tok/s）、附件扫描预算估计（[`attachment_scan.py`](payload/dist/attachment_scan.py)），以及 8 类失败原因自动分类诊断。
   - **一级顶栏纯图标快捷入口 + 窗口快速微浮层**：顶部监控条紧邻圆环提供**纯图标**按钮（无文字占位，悬停显示说明气泡）：一键触发 `/compact` 压缩当前会话，以及点击弹出**上下文窗口快调浮层**——顶部自动标识并一键切换 `全部模型统一 / 仅当前模型` 作用域，原地直选 `256K / 512K / 1M / 动态` 即时生效；当前会话详情卡片同步提供即时预设条与 `512K → 1M` 下条生效预览。
4. **纯 Token 消耗历史与额度池看板**
   - 专注于统计桌面端与 CLI 的纯 Token 历史用量（输入 / 输出 / 缓存读取）、日/周/月/年/累计热力图，以及账号套餐与 Prompt / Flow 额度池状态（已移除全部 API 参考费率、货币换算与订阅价格表单）。
5. **会话主标题 & 章节标题自动简体中文**
   - 通过 `meter-enhance.js` 在 `language_server` 中写入 3 条等长 ASCII 双向可逆指令补丁（默认开启），自动生成 4~10 字简体中文会话标题与章节标题。
6. **桌面端简体中文界面与四态品牌标题控制**
   - 通过 `app.asar` 预加载注入全量简体中文词库（`zh-CN.json`）与 DOM 翻译引擎（`i18n-runtime.js`），支持 **四态无损切换** 左上角品牌标题：
     - `hakimi`：**`哈基米`**（默认）
     - `translated`：**`反重力`**
     - `hidden`：隐藏文字但保留菜单入口
     - `english`：**`Antigravity`**
7. **自定义应用图标（可选 `--icon`）与一键健康诊断（`npm run doctor`）**
   - 支持传入本地图片（`PNG` / `JPG` / `WebP` / `HEIC` / `ICNS` 等）作为 `哈基米.app` 的应用图标；覆盖构建时不传 `--icon` 会自动保留旧副本已有的自定义图标，也可传入 `--default-icon` 恢复官方默认图标。
   - 对非透明背景照片会自动居中裁剪为 1:1 并施加 macOS 圆角矩形留白遮罩（带透明圆角/边缘的图标则原样保留，也可配合 `--raw-icon` 禁用遮罩），同时更新 **`Contents/Resources/icon.icns`**（访达 / 启动台 / Spotlight）与 **`app.asar/icon.png`**（运行态 Dock 图标）。
   - 提供只读健康诊断工具 `npm run doctor`（[`scripts/doctor.js`](scripts/doctor.js)），一键核查官方包纯净隔离、版本同步、`ElectronAsarIntegrity` 摘要、`codesign --verify --strict`、地区/上下文/中文标题补丁状态、运行中进程及 `agy` CLI 状态。

---

## 架构隔离与精简边界

- **只读官方守卫 (`assertNotOfficialAntigravityApp`)**：构建脚本与核心引擎在所有写入路径（`language_server`、`app.asar`、`icon.icns`、`codesign`）均强制校验目标绝非 `/Applications/Antigravity.app`、`/Applications/Antigravity.app.orig` 或指向它们的符号链接。
- **Bundle 身份保留**：`/Applications/哈基米.app` 保留内部 `CFBundleIdentifier` (`com.google.antigravity`)、`CFBundleName`/`CFBundleExecutable` (`Antigravity`) 与内部 `package.json`，从而与官方版无缝共享 Google 登录态、会话记录及 `ElectronAsarIntegrity` 校验流程。
- **明确裁剪移除的模块**：
  - 系统提示词精简与防幻觉重写（0~4 档）
  - 免 TUN 代理（`meter-proxy.js`）
  - 一键开 CLI 按钮（`meter-cli-launcher.js`）、GitHub 自动更新器、CDP 热注入及就地覆盖官方应用的安装器

---

## 快速使用

### 1. 构建并安装 `/Applications/哈基米.app`

```bash
# 构建并安装 `/Applications/哈基米.app`（若旧副本已有自定义图标会自动保留；正在运行时可加 --restart 自动重启）
bash ./build-hakimi.sh --force --restart

# 同时修补本机 agy CLI 二进制并同步 CLI 上下文配置
bash ./build-hakimi.sh --force --patch-cli --restart

# 可选：指定一张本地图片作为 哈基米.app 的图标（支持 PNG/JPG/WebP/HEIC/ICNS）
bash ./build-hakimi.sh --force --icon ~/Pictures/hakimi.jpg

# 单独修补本机 agy CLI 或执行只读健康诊断
npm run unlock:cli
npm run doctor

# 启动
open "/Applications/哈基米.app"
```

### 2. 为已构建的 `哈基米.app` 快速换图标（免重跑完整 Build）

如果 `/Applications/哈基米.app` 已经打包好，只想更换图标或恢复默认图标，可直接运行 `set-hakimi-icon.sh`（耗时约 1~2 秒，不重新复制/修改 205MB `language_server`，保留全部解锁与汉化配置）：

```bash
# 直接替换图标（需先 Cmd+Q 退出 哈基米.app，或加上 --restart 自动退出并重开）
bash ./set-hakimi-icon.sh ~/Pictures/new-icon.png --restart

# 传入自定义图标且不自动加圆角遮罩
bash ./set-hakimi-icon.sh --icon ~/Pictures/logo.png --raw-icon

# 还原为默认官方图标（从官方 app 只读提取）
bash ./set-hakimi-icon.sh --restore --restart
```

### 3. 构建参数说明

```text
./build-hakimi.sh [选项]
  --force                         允许覆盖已存在的输出 .app 副本
  --stage-only                    仅在 /tmp 临时目录构建并签名，不写入 /Applications，也不改用户配置目录
  --from <path>                   指定只读源 Antigravity.app (默认优先 /Applications/Antigravity.app.orig，其次 /Applications/Antigravity.app)
  --app <path>                    指定输出 .app 路径 (默认: /Applications/哈基米.app；严禁指向官方应用)
  -i, --icon <path>               可选：指定本地图片作为应用图标 (不传时若旧副本已有自定义图标会自动保留)
  --raw-icon                      可选：配合 --icon 使用，不自动添加 macOS 圆角矩形留白遮罩
  --default-icon                  可选：覆盖旧副本时强制恢复为默认官方图标
  -r, --restart                   若目标应用当前正在运行，构建完成后自动优雅退出旧进程并重启新版
  --context-mode <mode>           上下文窗口模式: default | fixed | dynamic (默认: dynamic)
  --context-limit <tokens>        当 --context-mode fixed 时指定固定 token 上限 (16384 ~ 2097152)
  --patch-cli                     构建完成后联动修补本机 agy CLI 二进制并同步 CLI 上下文配置
  --cli-bin <path>                可选：配合 --patch-cli 指定 agy 二进制路径
  --chinese-title <on|off>        启用/关闭会话与章节自动中文标题补丁 (默认: on)
  --client-lang <zh-CN|en>        初始化/强制覆盖桌面端界面语言 (默认首次为 zh-CN)
  --brand <hakimi|translated|hidden|english>
                                  初始化/强制覆盖左上角品牌标题模式 (默认首次为 hakimi)
```

---

## 开发与测试

```bash
# 重新编译 Context Meter 渲染层 -> payload/dist/meter-renderer.js
npm run build:renderer

# 运行自动化测试（ASAR 打包校验、四态品牌 DOM、官方路径守卫、自适应解锁与诊断测试）
npm test

# 一键只读健康诊断（支持 --json / --allow-missing）
npm run doctor
```

## 目录结构

- `build-hakimi.sh`：一键复制、自定义图标处理、自适应地区解锁、上下文/标题二进制补丁、ASAR 重打包、`ElectronAsarIntegrity` 更新与 `codesign` 签名脚本
- `set-hakimi-icon.sh`：对已构建 `哈基米.app` 原位秒级替换应用图标 / 还原默认图标的轻量脚本（无需重跑完整构建）
- `scripts/doctor.js`：一键只读健康诊断 CLI（核查官方只读隔离、版本同步、ASAR 摘要、签名、各类补丁与 `agy` CLI 状态）
- `scripts/region-unlock.js` / `scripts/cli-unlock.js`：自适应地区解锁 CLI 与 `agy` CLI 联动解锁 CLI
- `scripts/build-macos-icon.js`：将本地图片转换为标准 macOS `.icns` 与 `512x512` Dock 图标 PNG（自适应圆角留白遮罩）
- `scripts/replace-asar-icon.js`：仅替换已打包 `app.asar` 内根目录 `icon.png` 并保留全部钩子与元数据
- `scripts/build-renderer.js`：将 `src/renderer/*` 编译为 `payload/dist/meter-renderer.js`
- `scripts/pack-hakimi-asar.js`：解包官方只读 `app.asar`、清理并注入 4 处 `dist/utils.js` 钩子与 `dist/preload.js`、支持替换内置 `icon.png` 并计算头摘要 SHA-256
- `payload/dist/`：主进程监听、自适应地区解锁、桌面/CLI 上下文解锁引擎、中文标题引擎、纯 Token 统计存储与汉化词库运行时
- `src/renderer/`：Context Meter 悬浮胶囊、快捷操作、速率/纯 Token 历史看板与设置弹窗源码
- `unlock/agy-cli/agy-patch.py`：独立命令行二进制上下文窗口解锁工具（Python 版）
- `test/`：自动化单元测试套件

---

## 致谢与上游项目

- **Context Meter / 看板 / 汉化与解锁框架**：本项目的前端监控面板、纯 Token 用量统计、桌面端简体中文化运行时及上下文解锁基础代码基于 [`elviscjn-cjn/antigravity-context-viewer`](https://github.com/elviscjn-cjn/antigravity-context-viewer)（基于 `v0.8.3`）改造，在此基础上新增了 macOS Apple Silicon (`arm64`) 独立 `/Applications/哈基米.app` 构建流程、自适应账号地区与 `agy` CLI 解锁、快捷操作、四态品牌标题与自定义图标支持，并移除了计价/代理/自动更新等模块。
- **上下文解锁方案原作者**：致谢 [Linux.do @23375](https://linux.do/t/topic/3117832) 提供的上下文窗口解锁技术方案。
