#!/usr/bin/env bash
# sync-lib.sh — 把共享库 _lib 同步到各云函数目录（MCP 部署上传的是各函数目录，不含 _lib）
# 用法：bash deploy/sync-lib.sh
#   · _lib/index.js  → 各云函数 lib.js（仅同步已有 lib.js 的函数，避免污染）
#   · _lib/sms.js    → 各云函数 sms.js（仅同步已有 sms.js 的函数）
#   · _lib/aiCore.js → 各云函数 aiCore.js（AI 对话核心，aiReserve / mpChat 共用）
#   · _lib/kb.js + _lib/kb/*.md → 各云函数 kb.js / kb/*.md（AI 知识库）
# ⚠️ 新增需要 AI 能力的云函数时：先在函数目录放一份空的 lib.js / aiCore.js / kb.js，
#    本脚本才会把共享库同步进去（避免给不需要的函数塞入无用文件）。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_IDX="cloudfunctions/_lib/index.js"
SRC_SMS="cloudfunctions/_lib/sms.js"
SRC_CORE="cloudfunctions/_lib/aiCore.js"
SRC_KB="cloudfunctions/_lib/kb.js"
SRC_KBDIR="cloudfunctions/_lib/kb"
SRC_NOTIFY="cloudfunctions/_lib/notifyLog.js"
n1=0; n2=0; n3=0; n4=0; n5=0

for d in cloudfunctions/*/; do
  fn="$(basename "$d")"
  [ "$fn" = "_lib" ] && continue
  if [ -f "${d}lib.js" ]; then cp "$SRC_IDX" "${d}lib.js"; n1=$((n1+1)); fi
  if [ -f "${d}sms.js" ]; then cp "$SRC_SMS" "${d}sms.js"; n2=$((n2+1)); fi
  if [ -f "${d}aiCore.js" ]; then cp "$SRC_CORE" "${d}aiCore.js"; n3=$((n3+1)); fi
  if [ -f "${d}kb.js" ]; then
    cp "$SRC_KB" "${d}kb.js"
    mkdir -p "${d}kb"
    cp "$SRC_KBDIR"/*.md "${d}kb/" 2>/dev/null || true
    n4=$((n4+1))
  fi
  # notifyLog.js：通知流水打点，lib.js 与 sms.js 都要用它 ⇒ 二者任一存在即同步
  if [ -f "${d}lib.js" ] || [ -f "${d}sms.js" ]; then cp "$SRC_NOTIFY" "${d}notifyLog.js"; n5=$((n5+1)); fi
done

echo "synced: lib.js=$n1  sms.js=$n2  aiCore.js=$n3  kb=$n4  notifyLog.js=$n5"
