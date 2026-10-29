#!/usr/bin/env bash
set -eu
sync_script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$sync_script_dir/install.py"
