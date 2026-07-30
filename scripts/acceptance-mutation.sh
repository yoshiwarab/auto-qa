#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
generated="build/acceptance/generated"
mutation_work="build/acceptance-mutation"
packed="$project_root/$mutation_work/packed"

if [[ ! -f "$aps_root/bb.edn" ]]; then
  echo "APS tools not found at $aps_root; run pnpm acceptance:setup." >&2
  exit 1
fi

cd "$project_root"

mkdir -p "build/acceptance/ir" "$generated"

bash "$project_root/scripts/ensure-playwright.sh"

pnpm --dir "$project_root" --filter @auto-qa/qa-lab build

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"

rm -rf "$packed"
mkdir -p "$packed"
tarball="$(
  pnpm pack --pack-destination "$packed" --silent
)"
tar -xzf "$packed/$(basename "$tarball")" -C "$packed"

export AUTO_QA_PACKED_CLI="$packed/package/dist/src/cli.js"
export PLAYWRIGHT_BROWSERS_PATH="$project_root/tmp/playwright-browsers"

for stem in passing-scenario-completes-run \
  atomic-generate-plan-rejection \
  durable-generate-plan-handoff \
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
