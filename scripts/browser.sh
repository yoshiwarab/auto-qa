#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
browser_build="$project_root/build/browser"
generated="$project_root/build/acceptance/generated"
stem="passing-scenario-completes-run"

if [[ ! -f "$aps_root/bb.edn" ]]; then
  echo "APS tools not found at $aps_root; run pnpm acceptance:setup." >&2
  exit 1
fi

bash "$project_root/scripts/ensure-playwright.sh"

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"

mkdir -p "$project_root/build/acceptance/ir" \
  "$project_root/build/acceptance/dry" "$generated" \
  "$browser_build"

feature="$project_root/features/$stem.feature"
ir="$project_root/build/acceptance/ir/$stem.json"
dry_report="$project_root/build/acceptance/dry/$stem.json"
(
  cd "$aps_root"
  bb gherkin-parser "$feature" "$ir"
  bb gherkin-ir-dry-checker "$ir" "$dry_report"
)
node "$project_root/dist/acceptance/generate.js" "$ir" "$generated"

rm -rf "$browser_build/packed"
mkdir -p "$browser_build/packed"
tarball="$(
  cd "$project_root"
  pnpm pack --pack-destination "$browser_build" --silent
)"
tar -xzf "$browser_build/$(basename "$tarball")" \
  -C "$browser_build/packed"

PLAYWRIGHT_BROWSERS_PATH="$project_root/tmp/playwright-browsers" \
AUTO_QA_PACKED_CLI="$browser_build/packed/package/dist/src/cli.js" \
  node "$project_root/node_modules/vitest/vitest.mjs" run \
    --config "$project_root/vitest.browser.config.ts"
