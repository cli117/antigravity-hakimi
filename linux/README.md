# hakimi-linux

Linux 版 Antigravity 地区解锁工具，作用于两类 ELF64 二进制：

- `agy` CLI（默认探测 `~/.local/bin/agy`、`$PATH` 等）
- `~/.antigravity-hub-server/bin/<ver>-<arch>/language_server`（agy CLI / Remote SSH 实际使用的语言服务）

原理与 macOS 版一致：解析 Go `.gopclntab` 符号表定位
`authclient.ValidateAndOnboardAccount`，自适应匹配 `ineligibleTiers` 的
`"free-tier"` 限制分支，把条件跳转改成无条件跳转；`allowedTiers` 分支保持不动。
不写死 SHA-256 / 固定偏移，不修改提示词，不注入任何外发请求拦截。

支持 Linux ELF64 `x86-64` / `arm64`，兼容 PIE（通过 `.rela.dyn` 的
`firstmoduledata` 反推 Go text base）与非 PIE。

---

## 快速使用

```bash
# 只读检查（默认命令）
python3 linux/hakimi-linux.py
# 或
bash linux/hakimi-linux.sh status

# 备份并解锁所有目标
python3 linux/hakimi-linux.py patch

# 只看会改哪些字节，不写入
python3 linux/hakimi-linux.py patch --dry-run

# 从备份还原
python3 linux/hakimi-linux.py restore

# 只处理指定文件
python3 linux/hakimi-linux.py patch --binary ~/.local/bin/agy
python3 linux/hakimi-linux.py patch --glob '~/.antigravity-hub-server/bin/*/language_server'
```

`status` 退出码：全部目标已解锁返回 `0`，存在未解锁/失败/未发现目标返回 `1`，
便于脚本或 CI 判断。

---

## 目标发现

未显式传 `--binary` / `--glob` 时，自动扫描：

| 类别 | 路径 |
|------|------|
| `agy` CLI | `$AGY_CLI_BIN`、`~/.local/bin/agy`、`~/.local/bin/agy.real`（代理 wrapper 场景）、`~/.antigravity/antigravity/bin/agy`、`~/.antigravity/bin/agy`、`~/bin/agy`、`$PATH`、`/usr/local/bin/agy`、`/usr/bin/agy` |
| `language_server` | `~/.antigravity-hub-server/bin/*/language_server`（所有已下载版本） |

`--no-cli` / `--no-hub` 可分别关闭两类自动扫描。
官方桌面端安装目录不会被自动扫描；`/Applications/Antigravity.app` 路径守卫保留。

---

## 备份与还原

- 状态目录：`$HAKIMI_LINUX_STATE_DIR`，默认 `$XDG_STATE_HOME/hakimi-linux`
  （通常是 `~/.local/state/hakimi-linux`）。
- 首次 `patch` 前会把原文件复制到 `backups/<文件名>.<sha12>.orig`，
  并写入 `backups/manifest.json`（原文件 / 补丁后 SHA-256、时间、架构）。
- `restore` 会校验当前文件仍是补丁后的 SHA-256 再还原；如果文件已被
  `agy update` 替换，默认跳过（避免把新版降级回旧版），确认要还原可加 `--force`。
- 写入采用同目录临时文件 + `rename` 原子替换，并保留原文件权限与属主。

---

## 更新后自动重打

`agy update` 或 hub server 升级会替换二进制，需要重新打补丁。可安装 systemd
用户定时器：

```bash
python3 linux/hakimi-linux.py install-timer              # 默认每 10 分钟检查
python3 linux/hakimi-linux.py install-timer --interval-minutes 30
python3 linux/hakimi-linux.py timer-status
python3 linux/hakimi-linux.py uninstall-timer
```

定时器执行 `patch --quiet`，已打过补丁的文件会直接跳过。若当前会话没有
systemd 用户总线，命令会打印等价 cron 行，可自行加入 `crontab -e`：

```cron
*/10 * * * * /usr/bin/env python3 /path/to/linux/hakimi-linux.py patch --quiet
```

---

## 运行中的 language_server

Linux 上替换正在运行的可执行文件不会影响已启动进程（旧 inode 继续运行），
因此：

- 打完补丁后，`patch` 会打印仍在运行的 PID；
- 需要重启 `agy` 或重新建立 Remote SSH 连接，新的 language_server 才会加载补丁；
- 本工具**不会**自动 kill 任何进程（避免打断正在使用的会话）。

---

## 与 macOS 版的关系

核心特征与以下实现保持一致：

- `payload/dist/meter-ssh.js`：Linux ELF64 `analyzeX64RegionInRange` / `analyzeArm64RegionInRange`
- `unlock/agy-cli/agy-patch.py`：独立 Python 版单文件解锁器

本工具在两者基础上增加了多目标扫描、备份/还原、状态查询和 systemd 定时自动修复。
macOS 桌面包构建（`build-hakimi.sh`）不受影响。
