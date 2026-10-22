#!/usr/bin/env sh
# bili-learn 本地仪表盘：./dashboard/start.sh
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-8787}"
echo "bili-learn dashboard → http://127.0.0.1:$PORT/"
exec node dashboard/server.js
