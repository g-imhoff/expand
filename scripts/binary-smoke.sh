#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
test -x dist/yodea || { echo "dist/yodea missing — run 'bun run build' first" >&2; exit 1; }
test -x dist/yodea-server || { echo "dist/yodea-server missing — run 'bun run build' first" >&2; exit 1; }

export YODEA_HOME="$(mktemp -d)"
echo "YODEA_HOME=$YODEA_HOME"

health="$(./dist/yodea health --format json)"
echo "$health" | jq -e '.kind == "ServerHealth" and .data.status == "ok"' >/dev/null
echo "health: OK"

create_alpha="$(./dist/yodea project create alpha --format json)"
echo "$create_alpha" | jq -e '.kind == "Project" and .created == true and .data.name == "alpha"' >/dev/null

create_beta="$(./dist/yodea project create beta --format json)"
echo "$create_beta" | jq -e '.kind == "Project" and .created == true and .data.name == "beta"' >/dev/null

list_two="$(./dist/yodea project list --format json)"
echo "$list_two" | jq -e '.kind == "ProjectList" and .count == 2 and ([.data[].name] | sort == ["alpha", "beta"])' >/dev/null
echo "create/list durability: OK"

delete_alpha="$(./dist/yodea project delete alpha --format json)"
echo "$delete_alpha" | jq -e '.kind == "ProjectDelete"' >/dev/null

list_one="$(./dist/yodea project list --format json)"
echo "$list_one" | jq -e '.kind == "ProjectList" and .count == 1 and .data[0].name == "beta"' >/dev/null
echo "delete: OK"

deadline=$((SECONDS + 10))
while pgrep -f "$PWD/dist/yodea-server" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "yodea-server still running 10s after last disconnect" >&2
    exit 1
  fi
  sleep 0.5
done
echo "server reaped after last disconnect: OK"

echo "binary smoke: OK"
