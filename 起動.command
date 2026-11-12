#!/bin/bash
# 保育士 動線記録アプリを起動します（ダブルクリックで実行）
# このウィンドウを閉じるとアプリのサーバーも止まります。調査中は閉じないでください。
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:${PORT}/index.html"

if ! lsof -i :${PORT} >/dev/null 2>&1; then
  /usr/bin/python3 -m http.server ${PORT} >/dev/null 2>&1 &
  sleep 1
fi

# 音声入力のため Chrome を優先して開く（なければ既定のブラウザ）
open -a "Google Chrome" "${URL}" 2>/dev/null || open "${URL}"

echo "------------------------------------------------------------"
echo " 保育士 動線記録アプリ を起動しました"
echo " ${URL}"
echo " （このウィンドウは調査が終わるまで閉じないでください）"
echo "------------------------------------------------------------"
wait
