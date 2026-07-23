#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
feature="$project_root/features/durable-generate-plan-handoff.feature"
ir="$project_root/build/acceptance/ir/durable-generate-plan-handoff.json"
dry_report="$project_root/build/acceptance/dry/durable-generate-plan-handoff.json"
generated="$project_root/build/acceptance/generated"

if [[ ! -f "$aps_root/bb.edn" ]]; then
  echo "APS tools not found at $aps_root; run pnpm acceptance:setup." >&2
  exit 1
fi

mkdir -p "$(dirname "$ir")" "$(dirname "$dry_report")" "$generated"

(
  cd "$aps_root"
  bb gherkin-parser "$feature" "$ir"
  bb gherkin-ir-dry-checker "$ir" "$dry_report"
)

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"
node "$project_root/dist/acceptance/generate.js" "$ir" "$generated"
node "$project_root/node_modules/vitest/vitest.mjs" run \
  --config "$project_root/vitest.acceptance.config.ts"
