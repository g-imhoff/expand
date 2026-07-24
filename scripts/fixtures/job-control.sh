#!/usr/bin/env bash
set -euo pipefail
set -m
signal_job() {
  kill "$1" -- "$2"
}
true &
"$@" &
pid=$!
job_line="$(jobs -l %%)"
job_marker="${job_line%% *}"
job_number="${job_marker#[}"
job_number="${job_number%%]*}"
pgid="$(ps -o pgid= -p "$pid")"
pgid="${pgid//[[:space:]]/}"
printf 'job=%%%s pid=%s pgid=%s\n' "$job_number" "$pid" "$pgid"
set +e
wait "%$job_number" 2>/dev/null
status=$?
set -e
printf 'status=%s\n' "$status"
wait %1 2>/dev/null || true
