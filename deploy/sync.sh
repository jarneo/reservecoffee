#!/usr/bin/env bash
# 一键同步前端到体验版：自动升版本号 + 上传（miniprogram-ci）
# 用法： bash deploy/sync.sh
set -e

# 解析脚本目录，输出 Windows 风格路径（避免 Git Bash 的 POSIX 路径被 node 二次转换）
SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && (pwd -W 2>/dev/null || pwd))"

# managed Node 路径
# ⚠️ 原默认值写死 Windows 路径（C:/Users/Administrator/...），在 Mac 上直接
#   "No such file or directory"。改为**自动探测本机 managed node**，仍可用 SYNC_NODE 覆盖。
if [ -z "${SYNC_NODE:-}" ]; then
  for c in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2-3/bin/node" \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"; do
    if [ -x "$c" ]; then SYNC_NODE="$c"; break; fi
  done
fi
NODE="${SYNC_NODE:-node}"
# miniprogram-ci 装在工程 node_modules；可用 SYNC_NODE_MODULES 覆盖
export NODE_PATH="${SYNC_NODE_MODULES:-$SCRIPT_DIR/../node_modules}"

exec "$NODE" "$SCRIPT_DIR/sync.js" "$@"
