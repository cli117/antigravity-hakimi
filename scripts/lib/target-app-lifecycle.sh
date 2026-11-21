#!/bin/bash
# Shared target .app process lifecycle helpers for build-hakimi.sh and set-hakimi-icon.sh.
# Strictly matches processes under the specified target bundle (never touches official Antigravity.app).

find_running_target_pids() {
  local target_app="$1"
  local mode="${2:-all}"
  [[ -f "$target_app/Contents/MacOS/Antigravity" ]] || return 0
  node -e '
  const fs = require("fs");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const appExec = fs.realpathSync(path.join(process.argv[1], "Contents", "MacOS", "Antigravity"));
  const appPrefix = fs.realpathSync(process.argv[1]) + "/";
  const mode = process.argv[2] || "all";
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8", LC_TIME: "C" },
  });
  const selfPids = new Set([process.pid, process.ppid]);
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (selfPids.has(pid)) continue;
    const cmd = m[2];
    const isMain = cmd === appExec || cmd.startsWith(appExec + " ");
    const isUnderApp = cmd.startsWith(appPrefix);
    if (mode === "main" ? isMain : (isMain || isUnderApp)) {
      pids.push(pid);
    }
  }
  process.stdout.write(pids.join(" "));
  ' "$target_app" "$mode"
}

stop_running_target_app() {
  local target_app="$1"
  local grace_tenths="${HAKIMI_STOP_GRACE_TENTHS:-35}"
  local term_tenths="${HAKIMI_STOP_TERM_TENTHS:-15}"
  local kill_tenths="${HAKIMI_STOP_KILL_TENTHS:-25}"

  trap '' HUP

  local main_pids rem_pids
  main_pids="$(find_running_target_pids "$target_app" main)"
  if [[ -n "$main_pids" ]]; then
    for pid in $main_pids; do
      kill -TERM "$pid" 2>/dev/null || true
    done
    for ((i = 0; i < grace_tenths; i++)); do
      rem_pids="$(find_running_target_pids "$target_app" all)"
      [[ -z "$rem_pids" ]] && break
      sleep 0.1
    done
  fi

  rem_pids="$(find_running_target_pids "$target_app" all)"
  if [[ -n "$rem_pids" ]]; then
    for pid in $rem_pids; do
      kill -TERM "$pid" 2>/dev/null || true
    done
    for ((i = 0; i < term_tenths; i++)); do
      rem_pids="$(find_running_target_pids "$target_app" all)"
      [[ -z "$rem_pids" ]] && break
      sleep 0.1
    done
  fi

  rem_pids="$(find_running_target_pids "$target_app" all)"
  if [[ -n "$rem_pids" ]]; then
    echo "==> 旧进程仍在清理中，强制结束残留进程 (PID: $rem_pids) ..."
    for ((i = 0; i < kill_tenths; i++)); do
      rem_pids="$(find_running_target_pids "$target_app" all)"
      [[ -z "$rem_pids" ]] && break
      for pid in $rem_pids; do
        kill -KILL "$pid" 2>/dev/null || true
      done
      sleep 0.1
    done
  fi

  rem_pids="$(find_running_target_pids "$target_app" all)"
  if [[ -n "$rem_pids" ]]; then
    echo "等待进程退出超时，仍有残留进程 (PID: $rem_pids)，请先手动 Cmd+Q 退出 $target_app" >&2
    exit 1
  fi

  node -e '
  const path = require("path");
  const { cleanupStaleSingletonLock } = require(path.join(process.argv[1], "payload", "dist", "modules-config.js"));
  cleanupStaleSingletonLock(process.env.HAKIMI_USER_DATA_DIR || undefined);
  ' "$SCRIPT_DIR" 2>/dev/null || true
}
