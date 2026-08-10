#!/usr/bin/env bash
set -u
BASE_URL="${BASE_URL:-http://127.0.0.1:18796}"
GATEWAY_KEY="${GATEWAY_KEY:?set GATEWAY_KEY}"
OUT_DIR="${OUT_DIR:-/tmp/entry-gateway-vu100}"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

run_one() {
  local n="$1" provider="$2" model="$3" mode="$4" out="$OUT_DIR/$n.body" meta="$OUT_DIR/$n.meta" start elapsed status bytes
  start=$(date +%s%3N)
  if [ "$mode" = "stream" ]; then
    status=$(curl -sS -N -o "$out" -w '%{http_code}' --max-time 45 \
      -H "Authorization: Bearer $GATEWAY_KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Return a concise load-test health response.\"}],\"temperature\":0,\"max_tokens\":64,\"stream\":true}" \
      "$BASE_URL/v1/chat/completions" 2>/dev/null || true)
  else
    status=$(curl -sS -o "$out" -w '%{http_code}' --max-time 45 \
      -H "Authorization: Bearer $GATEWAY_KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Return a concise load-test health response.\"}],\"temperature\":0,\"max_tokens\":64}" \
      "$BASE_URL/v1/chat/completions" 2>/dev/null || true)
  fi
  elapsed=$(( $(date +%s%3N) - start )); bytes=$(wc -c < "$out" 2>/dev/null || echo 0)
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' "$n" "$provider" "$model" "$mode" "$status" "$elapsed" "$bytes" "$out" > "$meta"
}

n=0
# 10 Ling users: 5 stream + 5 non-stream (expected to document current upstream availability).
for mode in stream nonstream; do for _ in 1 2 3 4 5; do n=$((n+1)); run_one "$n" opencode-zen ling-3.0-flash-free "$mode" & done; done
# 40 MiMo users: 20 stream + 20 non-stream.
for mode in stream nonstream; do for _ in $(seq 1 20); do n=$((n+1)); run_one "$n" opencode-zen mimo-v2.5-free "$mode" & done; done
# 50 UniModel users: 25 stream + 25 non-stream.
for mode in stream nonstream; do for _ in $(seq 1 25); do n=$((n+1)); run_one "$n" unimodel deepseek-v4-flash "$mode" & done; done
wait
cat "$OUT_DIR"/*.meta | sort -n > "$OUT_DIR/results.csv"
python3 - "$OUT_DIR" <<'PY'
import csv, glob, json, os, sys, collections, statistics
root=sys.argv[1]; rows=list(csv.DictReader(open(root+'/results.csv'),fieldnames=['id','provider','model','mode','status','elapsed_ms','bytes','body']))
print('total=',len(rows))
print('statuses=',dict(collections.Counter(r['status'] for r in rows)))
for key,g in __import__('itertools').groupby(sorted(rows,key=lambda r:(r['provider'],r['model'],r['mode'])),key=lambda r:(r['provider'],r['model'],r['mode'])):
 a=list(g); times=[int(r['elapsed_ms']) for r in a]; print(key,'count=',len(a),'ok=',sum(r['status']=='200' for r in a),'errors=',sum(r['status']!='200' for r in a),'avg_ms=',round(statistics.mean(times)),'p95_ms=',sorted(times)[max(0,int(len(times)*.95)-1)])
usage=collections.defaultdict(lambda:[0,0,0,0.0])
for r in rows:
 try:
  d=json.load(open(r['body'])); u=d.get('usage') or {}; i=u.get('prompt_tokens',u.get('input_tokens',0)); o=u.get('completion_tokens',u.get('output_tokens',0)); usage[(r['provider'],r['model'])][0]+=i; usage[(r['provider'],r['model'])][1]+=o; usage[(r['provider'],r['model'])][2]+=1
  if r['provider']=='unimodel': usage[(r['provider'],r['model'])][3]+=(i/1e6*.14+o/1e6*.28)*5
 except Exception: pass
print('usage_totals=')
for k,v in usage.items(): print(k,'input=',v[0],'output=',v[1],'responses_with_json_usage=',v[2],'estimated_billed_cost=',round(v[3],8))
PY
