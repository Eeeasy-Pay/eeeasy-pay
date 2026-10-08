#!/usr/bin/env bash
# Fail the build if a likely secret/credential pattern is committed.
# This is a heuristic tripwire, not a substitute for review (GUARDRAILS.md #5, #8).
set -euo pipefail
cd "$(dirname "$0")/.."

pattern='(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]+|pk_live_[A-Za-z0-9]+|ghp_[A-Za-z0-9]{30,}|gh[ous]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9._~+/-]{30,}|password[[:space:]]*[:=][[:space:]]*(?!(postgres:postgres|"?"?|\*\*\*|\(none\)|\$\{)))'

if grep -rInP --exclude-dir=node_modules --exclude-dir=.git \
     --exclude=pnpm-lock.yaml --exclude=secret-scan.sh \
     "$pattern" .; then
  echo "FAIL: potential secret or credential pattern found (see matches above)"
  exit 1
fi

echo "secret scan: clean (no private keys, live API tokens, or hardcoded passwords found)"
