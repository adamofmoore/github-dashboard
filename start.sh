#!/bin/bash
# Starts the dashboard and opens it in the browser.
cd "$(dirname "$0")"
PORT=${PORT:-4747}
if ! curl -sf "http://localhost:$PORT/api/me" >/dev/null 2>&1; then
  nohup node server.mjs > server.log 2>&1 &
  for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/me" >/dev/null 2>&1 && break; sleep 0.3; done
fi
open "http://localhost:$PORT"
