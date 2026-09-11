#!/usr/bin/env bash
# Manual installer for the Thunderbird Mail Pipe native messaging host.
# Use this for quick testing outside of NixOS. On NixOS, prefer the module
# in ../nix/ instead, which manages this declaratively.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/tb_mail_pipe_host.py"
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
MANIFEST_PATH="$MANIFEST_DIR/tb_mail_pipe.json"
ALLOWLIST_DIR="$HOME/.config/tb-mail-pipe"
ALLOWLIST_PATH="$ALLOWLIST_DIR/allowed-scripts.json"

chmod +x "$HOST_SCRIPT"
mkdir -p "$MANIFEST_DIR"
sed "s#@HOST_SCRIPT_PATH@#$HOST_SCRIPT#" "$SCRIPT_DIR/tb_mail_pipe.json.template" > "$MANIFEST_PATH"
echo "Wrote native messaging manifest: $MANIFEST_PATH"

mkdir -p "$ALLOWLIST_DIR"
if [ ! -f "$ALLOWLIST_PATH" ]; then
  echo "[]" > "$ALLOWLIST_PATH"
  echo "Created empty allow-list: $ALLOWLIST_PATH"
  echo "Add the absolute path of each script you want the addon to be able to run, e.g.:"
  echo '  ["/home/you/bin/add-text-alternative.py"]'
else
  echo "Allow-list already exists: $ALLOWLIST_PATH (left untouched)"
fi

echo "Done. Restart Thunderbird for it to notice the new native messaging host."
