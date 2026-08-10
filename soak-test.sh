#!/usr/bin/env bash
set -u
BASE_URL="${BASE_URL:-http://127.0.0.1:18794}"
GATEWAY_KEY="${GATEWAY_KEY:?set GATEWAY_KEY}"
DURATION_SECONDS="${DURATION_SECONDS:-300}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-8}"
LOG_FILE="${LOG_FILE:-/tmp/entry-gateway-soak.csv}"
mkdir -p "$(dirname "$LOG_FILE")"
printf 'timestamp,worker,provider,model,mode,status,elapsed_ms,bytes\n' > "$LOG_FILE"

run_worker() {
  local worker="$1" provider="$2" model="$3" mode="$4" end=$(( $(date +%s) + DURATION_SECONDS ))
  while [ "$(date +%s)" -lt "$end" ]; do
    local out start elapsed status bytes
    out="/tmp/soak-${worker}-$$.out"
    start=$(date +%s%3N)
    if [ "$mode" = "stream" ]; then
      status=$(curl -sS -N -o "$out" -w '%{http_code}' --max-time 30 \
        -H "Authorization: Bearer $GATEWAY_KEY" -H 'Content-Type: application/json' \
        -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Return a concise one-sentence health check for a multi-provider AI gateway.\"}],\"temperature\":0,\"max_tokens\":48,\"stream\":true}" \
        "$BASE_URL/v1/chat/completions" 2>/dev/null || true)
    else
      status=$(curl -sS -o "$out" -w '%{http_code}' --max-time 30 \
        -H "Authorization: Bearer $GATEWAY_KEY" -H 'Content-Type: application/json' \
        -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Return a concise one-sentence health check for a multi-provider AI gateway.\"}],\"temperature\":0,\"max_tokens\":48}" \
        "$BASE_URL/v1/chat/completions" 2>/dev/null || true)
    fi
    elapsed=$(( $(date +%s%3N) - start ))
    bytes=$(wc -c < "$out" 2>/dev/null || echo 0)
    printf '%s,%s,%s,%s,%s,%s,%s,%s\n' "$(date -Is)" "$worker" "$provider" "$model" "$mode" "$status" "$elapsed" "$bytes" >> "$LOG_FILE"
    rm -f "$out"
    sleep "$INTERVAL_SECONDS"
  done
}

run_worker 1 opencode-zen mimo-v2.5-free stream &
run_worker 2 opencode-zen mimo-v2.5-free nonstream &
run_worker 3 unimodel deepseek-v4-flash stream &
run_worker 4 unimodel deepseek-v4-flash nonstream &
run_worker 5 opencode-zen mimo-v2.5-free stream &
run_worker 6 opencode-zen mimo-v2.5-free nonstream &
run_worker 7 unimodel deepseek-v4-flash stream &
run_worker 8 unimodel deepseek-v4-flash nonstream &
wait
