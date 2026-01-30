#!/bin/bash
set -e
SCRIPT_URL="https://raw.githubusercontent.com/gsk-panda/PaloRuleAuditorv2/main/install-apache-rhel9.sh"
TMP_SCRIPT=$(mktemp)
trap "rm -f $TMP_SCRIPT" EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SCRIPT_URL" -o "$TMP_SCRIPT"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_SCRIPT" "$SCRIPT_URL"
else
  echo "Error: curl or wget required"
  exit 1
fi
chmod +x "$TMP_SCRIPT"
sudo bash "$TMP_SCRIPT"
