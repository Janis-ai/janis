#!/usr/bin/env bash
# Smoke check: verify web + api are up and key endpoints respond.
# Usage: ./scripts/smoke.sh
set -u
cd "$(dirname "$0")"
COOKIES=$(mktemp)
FAIL=0

check() { # name url expect
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" "$2")
  if [ "$code" = "$3" ]; then
    echo "ok   $1 ($code)"
  else
    echo "FAIL $1 — got $code, want $3"
    FAIL=1
  fi
}

check "web dev server"   http://localhost:5173/                     200
check "web /channels"    http://localhost:5173/channels             200
check "web /reports"     http://localhost:5173/reports              200
check "api health"       http://localhost:8787/health               200

# login → authed endpoints
curl -s -c "$COOKIES" -X POST http://localhost:8787/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@janis.local","password":"janis-admin"}' >/dev/null

check "auth/me"            http://localhost:8787/auth/me              200
check "conversations"      http://localhost:8787/api/conversations    200
check "conversations?unread" "http://localhost:8787/api/conversations?state=unread" 200
check "search"             "http://localhost:8787/api/search?q=a"     200
check "saved-replies"      http://localhost:8787/api/saved-replies    200
check "digests"            http://localhost:8787/api/digests          200
check "slack status"       http://localhost:8787/api/slack/status     200
check "agents"             http://localhost:8787/api/agents           200

# SSE only emits on bus events (plus a 25s keepalive) — open the stream,
# trigger an event via a conversation PATCH, and check something arrived.
SSE_OUT=$(mktemp)
CONV_ID=$(curl -s -b "$COOKIES" http://localhost:8787/api/conversations | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["conversations"][0]["id"] if d["conversations"] else "")' 2>/dev/null)
if [ -n "$CONV_ID" ]; then
  curl -sN -b "$COOKIES" http://localhost:8787/api/stream >"$SSE_OUT" 2>/dev/null &
  SSE_PID=$!
  sleep 0.7
  curl -s -b "$COOKIES" -X PATCH "http://localhost:8787/api/conversations/$CONV_ID" \
    -H 'Content-Type: application/json' -d '{"is_starred":true}' >/dev/null
  sleep 0.7
  kill $SSE_PID 2>/dev/null
  if grep -q 'data:' "$SSE_OUT"; then
    echo "ok   sse stream (event received)"
  else
    echo "FAIL sse stream — no event after PATCH"
    FAIL=1
  fi
else
  echo "warn sse stream — no conversations to trigger an event"
fi
rm -f "$SSE_OUT"

rm -f "$COOKIES"
[ "$FAIL" = 0 ] && echo "--- all green ---" || echo "--- FAILURES ---"
exit $FAIL
