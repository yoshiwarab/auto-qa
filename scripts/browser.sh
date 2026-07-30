#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$project_root/scripts/ensure-playwright.sh"

node "$project_root/node_modules/typescript/bin/tsc" \
  --project "$project_root/tsconfig.build.json"

PLAYWRIGHT_BROWSERS_PATH="$project_root/tmp/playwright-browsers" \
  node "$project_root/node_modules/vitest/vitest.mjs" run \
    --config "$project_root/vitest.browser.config.ts"
