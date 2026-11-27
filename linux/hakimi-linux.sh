#!/bin/bash
# hakimi-linux 便捷包装：等价于 python3 linux/hakimi-linux.py "$@"
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "缺少 python3，无法运行 hakimi-linux" >&2
  exit 1
fi

exec "$PY" "$DIR/hakimi-linux.py" "$@"
