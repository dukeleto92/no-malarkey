#!/usr/bin/env bash
# Start the No Malarkey playtest harness.
#
#   ./start.sh
#
# That is the whole workflow. No build step, no upload step.
# Override the port with:  PORT=8731 ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8730}"
export PORT

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'

  Node is not installed, and the harness needs it.

  The server does two things a plain static file server cannot:
  it discovers your mod folders, and it writes result dumps into runs/
  so you can diff them. Both need a real process.

  Install Node with either:
      brew install node
      # or download from https://nodejs.org

  If you would rather not install Node, you can still play (but not dump
  results to files) with any static server, e.g.:
      python3 -m http.server 8730
  then open  http://127.0.0.1:8730/harness/index.html?mod=<folder name>
  Mod discovery and run dumps will be unavailable in that mode.

EOF
  exit 1
fi

URL="http://127.0.0.1:${PORT}/"

# Open the browser once the port is actually listening, so we never land on a
# connection-refused page.
(
  for _ in $(seq 1 50); do
    if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if command -v open >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
  fi
) &

exec node server.js
