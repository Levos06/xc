#!/usr/bin/env bash
#
# Configure git so that `git diff` on .xc files shows ONLY the code layer,
# killing diff noise from explanation/prose edits (AC: "No Diff Noise").
#
# Mechanism: a textconv diff driver. Git pipes each version of a .xc file
# through `xc-cli extract` before diffing, so prose changes produce an empty
# code diff while code changes show cleanly.
#
# Usage:  ./setup-xc-diff.sh [/path/to/repo]
#
set -euo pipefail

REPO="${1:-$(pwd)}"
cd "$REPO"

if ! command -v xc-cli >/dev/null 2>&1; then
  echo "warning: 'xc-cli' not on PATH. Either:" >&2
  echo "  pip install -e /path/to/xc-ecosystem/core" >&2
  echo "  or set the driver command below to the venv python explicitly." >&2
fi

# Register the diff driver in this repo's git config.
git config diff.xccode.textconv "xc-cli extract"
git config diff.xccode.cachetextconv true

# Tell git which files use it.
ATTR=".gitattributes"
LINE="*.xc diff=xccode"
if ! { [ -f "$ATTR" ] && grep -qF "$LINE" "$ATTR"; }; then
  echo "$LINE" >> "$ATTR"
  echo "appended to $ATTR: $LINE"
fi

echo "Done. 'git diff' on *.xc now shows only the extracted code layer."
echo "To see prose changes instead, run: git diff --no-textconv  (or use the"
echo "VS Code command 'XC: Diff Explanation Layer')."
