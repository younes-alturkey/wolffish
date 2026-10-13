#!/bin/bash
# Rewrites .env before every build/dev run: the CLI section comes from the
# arguments, the CEB_ lines are kept (seeded from .example.env on first run).
set -e
cd "$(dirname "$0")/.."

DEV=false
for arg in "$@"; do
  case "$arg" in
    CLI_CEB_DEV=true | CLI_CEB_DEV=false) DEV="${arg#*=}" ;;
    *)
      echo "Unknown argument <$arg>; expected CLI_CEB_DEV=true|false"
      exit 1
      ;;
  esac
done

[ -f .env ] || cp .example.env .env
EDITABLE=$(grep -E '^CEB_' .env || true)

{
  echo "# Set by scripts/env.sh on every build/dev run"
  echo "CLI_CEB_DEV=$DEV"
  echo ""
  echo "# Editable"
  echo "$EDITABLE"
} > .env
