#!/bin/bash
# Starts the dashboard and opens it. Set HOST=0.0.0.0 to let others on your network sign in.
# Set GITHUB_CLIENT_ID to an OAuth app's client id (Device Flow enabled) for one-click "Sign in with GitHub";
# without it, others sign in by pasting a personal access token.
cd "$(dirname "$0")"
PORT=${PORT:-4747}
[ -f .env ] && set -a && . ./.env && set +a
if ! curl -s -o /dev/null "http://localhost:$PORT/"; then  # any HTTP answer means it is running
  nohup node server.mjs > server.log 2>&1 &
  for i in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.3; done
fi
open "http://localhost:$PORT"
