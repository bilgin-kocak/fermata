#!/usr/bin/env bash
# Milestone S gate: runs the three probes sequentially (never in parallel — the MPC session deadlocks
# under CPU contention on small machines) and exits 0 only if all three print GREEN.
set -uo pipefail
cd "$(dirname "$0")"
declare -a lines=()
for p in proof-path mpp-method tip20; do
  echo "########## $p ##########"
  out=$("./$p/run.sh" 2>&1 | tee "/dev/stderr" | grep -E '^PROBE [123]:' | tail -1)
  lines+=("${out:-PROBE ?: RED(no result line from $p)}")
done
echo "########## gate ##########"
printf '%s\n' "${lines[@]}"
[ "$(printf '%s\n' "${lines[@]}" | grep -c ': GREEN')" -eq 3 ] && { echo "GATE: GREEN"; exit 0; } || { echo "GATE: RED"; exit 1; }
