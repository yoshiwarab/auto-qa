#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
generated="$project_root/build/acceptance/generated"

if [[ ! -f "$aps_root/bb.edn" ]]; then
  echo "APS tools not found at $aps_root; run pnpm acceptance:setup." >&2
  exit 1
fi

mkdir -p "$project_root/build/acceptance/ir" \
  "$project_root/build/acceptance/dry" "$generated"

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"

for stem in durable-generate-plan-handoff \
  atomic-generate-plan-rejection \
  cli-durable-generate-plan-handoff \
  cli-one-active-run-per-worktree \
  cli-abandon-active-run \
  cli-requires-git-worktree \
  workflow-engine-fenced-turn; do
  feature="$project_root/features/$stem.feature"
  ir="$project_root/build/acceptance/ir/$stem.json"
  dry_report="$project_root/build/acceptance/dry/$stem.json"
  (
    cd "$aps_root"
    bb gherkin-parser "$feature" "$ir"
    bb gherkin-ir-dry-checker "$ir" "$dry_report"
  )
  node "$project_root/dist/acceptance/generate.js" "$ir" "$generated"
done

node "$project_root/node_modules/vitest/vitest.mjs" run \
  --config "$project_root/vitest.acceptance.config.ts"
