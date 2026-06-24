#!/bin/bash
# AI Clip 起動スクリプト
# 使い方: bash start.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "=== バックエンド起動 (port 8000) ==="
cd "$ROOT/backend"
export $(grep -v '^#' .env | xargs) 2>/dev/null || true
"$ROOT/backend/venv/bin/uvicorn" main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

echo "=== フロントエンド起動 (port 3000) ==="
cd "$ROOT"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "起動完了:"
echo "  フロント: http://localhost:3000"
echo "  バック:   http://localhost:8000"
echo ""
echo "終了するには Ctrl+C を押してください"

cleanup() {
  echo "終了中..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

wait
