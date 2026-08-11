#!/usr/bin/env bash
# Sweep 10 tool-calling prompting strategies through the live bench.
# Each strategy = a fresh proxy with its own env, then the bench on a fixed task
# subset. One strategy at a time (one port) so threads don't overlap. Results land
# in scripts/bench/out/var-<name>-<ts>.json; a summary is appended to the SUMMARY file.
set -u
cd "$(dirname "$0")/../.." || exit 1

PORT=4141
TASKS="${TASKS:-fix-bug,find-needle,edit-config}"
MAXTURNS="${MAXTURNS:-12}"
REPEAT="${REPEAT:-1}"
PROXY_LOG=/tmp/m365-sweep-proxy.log
SUMMARY=/tmp/m365-sweep-summary.txt
PIDFILE=/tmp/m365-sweep-proxy.pid
: > "$SUMMARY"

# strategy_name|extra_env (space-separated KEY=VAL pairs)
STRATEGIES=(
  "baseline|"
  "softened|M365_FRAMING_VARIANT=softened"
  "demo_only|M365_FRAMING_VARIANT=demo_only"
  "session_facts|M365_FRAMING_VARIANT=session_facts"
  "fewshot|M365_FRAMING_VARIANT=fewshot"
  "reply_tool|M365_INJECT_REPLY_TOOL=1"
)

kill_proxy() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE"
  sleep 2
}
trap kill_proxy EXIT

for entry in "${STRATEGIES[@]}"; do
  name="${entry%%|*}"
  envs="${entry#*|}"
  echo "==================== STRATEGY: $name  ($envs) ===================="
  kill_proxy
  # start proxy with the strategy env
  env $envs M365_DEBUG=1 node packages/proxy/bin/m365-proxy.mjs "$PORT" > "$PROXY_LOG" 2>&1 &
  echo $! > "$PIDFILE"
  # wait for health (up to 30s)
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  sleep 2
  out=$(node scripts/bench/run.mjs --base-url "http://localhost:$PORT/v1" --model m365-copilot \
        --label "var-$name" --tasks "$TASKS" --max-turns "$MAXTURNS" --repeat "$REPEAT" 2>&1)
  echo "$out" | grep -E "^\s+(fizzbuzz|fix-bug|find-needle|edit-config|count-lines)|SCORECARD|SOLVED|avg tool"
  line=$(echo "$out" | grep "SOLVED" | head -1)
  echo "$name : $line" >> "$SUMMARY"
  kill_proxy
  echo "--- cooldown 20s (let thread-rate settle) ---"
  sleep 20
done

echo ""
echo "==================== SWEEP COMPLETE ===================="
cat "$SUMMARY"
