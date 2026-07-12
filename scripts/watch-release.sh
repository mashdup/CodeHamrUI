#!/usr/bin/env bash
# Background monitor for the release workflow triggered by a v* tag.
# Uses the PUBLIC GitHub Actions REST API (no auth needed for a public repo),
# so no `gh` login is required. Polls until the run for the given tag reaches a
# terminal state, logging each transition. Launch detached:
#   nohup bash scripts/watch-release.sh v0.3.3 > /tmp/watch-v0.3.3.log 2>&1 &
# then tail the log across turns.
set -u

REPO="${REPO:-mashdup/CodeAnvil}"
TAG="${1:?usage: watch-release.sh <tag> [interval_s]}"
INTERVAL="${2:-30}"
API="https://api.github.com/repos/$REPO/actions/runs?per_page=20"

PY="$(command -v py || command -v python3 || command -v python)"

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }

if [ -z "$PY" ]; then log "FATAL: no python for JSON parsing"; exit 1; fi

log "watching $REPO for tag=$TAG via public API (every ${INTERVAL}s)"

last=""
for _ in $(seq 1 240); do   # ~2h cap at 30s
  # Emit "status conclusion url" for the newest run whose head is the tag.
  line="$(curl -s "$API" | "$PY" -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
h=[r for r in d.get('workflow_runs',[]) if r.get('head_branch')=='$TAG']
if not h: print('')
else:
    r=h[0]; print(r['status'], r.get('conclusion') or '-', r['html_url'])
")"

  if [ -z "$line" ]; then
    log "no run found yet for $TAG"
  else
    read -r status conclusion url <<<"$line"
    key="$status/$conclusion"
    [ "$key" != "$last" ] && { log "status=$status conclusion=$conclusion  $url"; last="$key"; }
    if [ "$status" = "completed" ]; then
      log "DONE: $conclusion  $url"
      [ "$conclusion" = "success" ] && exit 0 || exit 2
    fi
  fi
  sleep "$INTERVAL"
done

log "TIMEOUT: run did not finish within the poll window"
exit 3
