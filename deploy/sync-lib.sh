#!/usr/bin/env bash
# sync-lib.sh — 把共享库 _lib 同步到各云函数目录（MCP 部署上传的是各函数目录，不含 _lib）
# 用法：bash deploy/sync-lib.sh
#   · _lib/index.js → 各云函数 lib.js（仅同步已有 lib.js 的函数，避免污染）
#   · _lib/sms.js   → 各云函数 sms.js（仅同步已有 sms.js 的函数）
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_IDX="cloudfunctions/_lib/index.js"
SRC_SMS="cloudfunctions/_lib/sms.js"
n1=0; n2=0

for d in cloudfunctions/*/; do
  fn="$(basename "$d")"
  [ "$fn" = "_lib" ] && continue
  if [ -f "${d}lib.js" ]; then cp "$SRC_IDX" "${d}lib.js"; n1=$((n1+1)); fi
  if [ -f "${d}sms.js" ]; then cp "$SRC_SMS" "${d}sms.js"; n2=$((n2+1)); fi
done

echo "synced: lib.js=$n1  sms.js=$n2"
