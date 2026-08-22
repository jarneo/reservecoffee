#!/usr/bin/env bash
# 一键同步前端到体验版：自动升版本号 + 上传（miniprogram-ci）
# 用法： bash deploy/sync.sh
set -e

# 解析脚本目录，输出 Windows 风格路径（避免 Git Bash 的 POSIX 路径被 node 二次转换）
SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && (pwd -W 2>/dev/null || pwd))"

# managed Node 路径（固定，勿改）
NODE="${SYNC_NODE:-C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe}"
# miniprogram-ci 装在 workspace node_modules
export NODE_PATH="${SYNC_NODE_MODULES:-C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules}"

exec "$NODE" "$SCRIPT_DIR/sync.js" "$@"
