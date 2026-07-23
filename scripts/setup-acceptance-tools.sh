#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aps_root="${AUTO_QA_APS_ROOT:-"$project_root/tmp/acceptance-pipeline-specification"}"
repository="https://github.com/unclebob/Acceptance-Pipeline-Specification.git"

mkdir -p "$(dirname "$aps_root")"

if [[ -d "$aps_root/.git" ]]; then
  git -C "$aps_root" pull --ff-only
else
  git clone --depth 1 "$repository" "$aps_root"
fi

(
  cd "$aps_root"
  bb test
)
