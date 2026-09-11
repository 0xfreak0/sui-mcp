#!/usr/bin/env bash
# Shared scanner for the pre-commit and commit-msg hooks.
#
# Reads newline-separated extended-regex patterns from two files and fails if
# any matches the text on stdin:
#
#   .githooks/patterns        tracked   — patterns safe to publish
#   .githooks/patterns.local  ignored   — patterns that must NOT be published
#
# The split is the whole point. A hook that blocks a maintainer's wallet
# addresses has to name them, and naming them in a tracked file publishes
# exactly what it exists to protect. So the private list lives beside the hook
# and is gitignored; `patterns.local.example` documents the format.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
text="$(cat)"
label="${1:-content}"
found=0

scan() {
  local file="$1" kind="$2"
  [ -r "$file" ] || return 0
  while IFS= read -r pattern; do
    # Skip blanks and comments.
    case "$pattern" in ""|\#*) continue ;; esac
    if printf '%s' "$text" | grep -qiE "$pattern"; then
      if [ "$kind" = private ]; then
        # Never echo the pattern itself — it is the secret.
        echo "BLOCKED: $label matches a private pattern from patterns.local" >&2
      else
        echo "BLOCKED: $label matches /$pattern/" >&2
      fi
      found=1
    fi
  done < "$file"
}

scan "$here/patterns" public
scan "$here/patterns.local" private

exit $found
