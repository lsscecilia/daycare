#!/bin/bash
# Builds Daycare into one file at ~/.local/bin/daycare, then runs `daycare setup`.
set -euo pipefail
cd "$(dirname "$0")"
command -v bun >/dev/null || { echo "Daycare needs bun to build: https://bun.sh (curl -fsSL https://bun.sh/install | bash)"; exit 1; }
[ "$(uname -s)" = Darwin ] || { echo "Daycare runs on macOS for now."; exit 1; }
dest="${DAYCARE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$dest"
bun build --compile src/cli.ts --outfile "$dest/daycare" >/dev/null
echo "Installed $dest/daycare"
case ":$PATH:" in *":$dest:"*) ;; *) echo "Add $dest to your PATH, e.g.: echo 'export PATH=\"$dest:\$PATH\"' >> ~/.zshrc";; esac
"$dest/daycare" setup "$@"
