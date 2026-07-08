#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
test -x dist/expand || { echo "dist/expand missing — run 'bun run build' first" >&2; exit 1; }
test -x dist/expand-server || { echo "dist/expand-server missing — run 'bun run build' first" >&2; exit 1; }

export EXPAND_HOME="$(mktemp -d)"
echo "EXPAND_HOME=$EXPAND_HOME"

health="$(./dist/expand health --format json)"
echo "$health" | jq -e '.kind == "ServerHealth" and .data.status == "ok"' >/dev/null
echo "health: OK"

create_alpha="$(./dist/expand project create alpha --format json)"
echo "$create_alpha" | jq -e '.kind == "Project" and .created == true and .data.name == "alpha"' >/dev/null

create_beta="$(./dist/expand project create beta --format json)"
echo "$create_beta" | jq -e '.kind == "Project" and .created == true and .data.name == "beta"' >/dev/null

list_two="$(./dist/expand project list --format json)"
echo "$list_two" | jq -e '.kind == "ProjectList" and .count == 2 and ([.data[].name] | sort == ["alpha", "beta"])' >/dev/null
echo "create/list durability: OK"

delete_alpha="$(./dist/expand project delete alpha --format json)"
echo "$delete_alpha" | jq -e '.kind == "ProjectDelete"' >/dev/null

list_one="$(./dist/expand project list --format json)"
echo "$list_one" | jq -e '.kind == "ProjectList" and .count == 1 and .data[0].name == "beta"' >/dev/null
echo "delete: OK"

deadline=$((SECONDS + 10))
while pgrep -f "$PWD/dist/expand-server" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "expand-server still running 10s after last disconnect" >&2
    exit 1
  fi
  sleep 0.5
done
echo "server reaped after last disconnect: OK"

echo "binary smoke: OK"
