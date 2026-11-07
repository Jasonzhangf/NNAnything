#!/usr/bin/env bash
set -u

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: run-live.sh RUN_DIR [LABEL]" >&2
  exit 64
fi

repo_dir="$(cd "$(dirname "$0")/../../../.." && pwd)"
run_root="$1"
label="${2:-run}"
run_dir="$run_root/live/$label"
server_port="${BA1_FIXTURE_PORT:-4199}"
chrome_port="${BA1_CHROME_PORT:-9555}"
chrome_bin="${BA1_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

mkdir -p "$run_dir/chrome-profile" "$run_dir/processes"

server_pid=""
chrome_pid=""
cleanup() {
  if [ -n "$chrome_pid" ]; then
    kill -TERM "$chrome_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

node "$repo_dir/playground/browser/search-fixture/server.mjs" --port "$server_port" \
  > "$run_dir/processes/fixture-server.stdout" \
  2> "$run_dir/processes/fixture-server.stderr" &
server_pid=$!

"$chrome_bin" --headless=new --no-sandbox --disable-gpu --disable-crash-reporter \
  --disable-dev-shm-usage --remote-debugging-port="$chrome_port" \
  --user-data-dir="$run_dir/chrome-profile" about:blank \
  > "$run_dir/processes/chrome.stdout" \
  2> "$run_dir/processes/chrome.stderr" &
chrome_pid=$!

printf '%s\n' "$server_pid" > "$run_dir/processes/fixture-server.pid"
printf '%s\n' "$chrome_pid" > "$run_dir/processes/chrome.pid"

ready=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$chrome_port/json/version" >/dev/null \
    && curl -fsS --max-time 1 "http://127.0.0.1:$server_port/" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  printf 'browser or fixture server did not become ready\n' >&2
  exit 70
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
node "$repo_dir/playground/browser/search/b-a1/accept.mjs" \
  --cdp "http://127.0.0.1:$chrome_port" \
  --origin "http://127.0.0.1:$server_port" \
  --out "$run_dir/acceptance" \
  --label "$label" \
  > "$run_dir/accept.stdout" \
  2> "$run_dir/accept.stderr"
accept_exit=$?
set -e
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '{\n  "command": "%s",\n  "startedAt": "%s",\n  "finishedAt": "%s",\n  "exitCode": %s\n}\n' \
  "node playground/browser/search/b-a1/accept.mjs --cdp http://127.0.0.1:$chrome_port --origin http://127.0.0.1:$server_port --out $run_dir/acceptance --label $label" \
  "$started_at" "$finished_at" "$accept_exit" \
  > "$run_dir/accept.receipt.json"

exit "$accept_exit"
