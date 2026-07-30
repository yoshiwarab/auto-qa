#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
browser_root="$project_root/tmp/playwright-browsers"

if [[ -z "$(find "$browser_root" -type f -name chrome-headless-shell -print -quit 2>/dev/null)" ]]; then
  PLAYWRIGHT_BROWSERS_PATH="$browser_root" \
    node "$project_root/node_modules/playwright/cli.js" install chromium
fi
