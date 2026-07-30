#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
generated="build/acceptance/generated"
mutation_work="build/acceptance-mutation"

if [[ ! -f "$aps_root/bb.edn" ]]; then
  echo "APS tools not found at $aps_root; run pnpm acceptance:setup." >&2
  exit 1
fi

cd "$project_root"

mkdir -p "build/acceptance/ir" "$generated"

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"

for stem in durable-generate-plan-handoff \
  cli-durable-generate-plan-handoff \
  cli-one-active-run-per-worktree \
  cli-abandon-active-run \
  cli-requires-git-worktree \
  workflow-engine-fenced-turn; do
  feature="features/$stem.feature"
  ir="build/acceptance/ir/$stem.json"
  bb --config "$aps_root/bb.edn" gherkin-parser "$feature" "$ir"
  node "$project_root/dist/acceptance/generate.js" "$ir" "$generated"

  bb --config "$aps_root/bb.edn" gherkin-mutator \
    --feature "$feature" \
    --work-dir "$mutation_work/$stem" \
    --generated-dir "$generated" \
    --workers 2 \
    --timeout 30s \
    --status-interval 5s \
    --level soft \
    --runner-worker \
      "node $project_root/dist/acceptance/mutationWorker.js $stem"
done
