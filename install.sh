#!/usr/bin/env bash
# Installs or updates Zoi Code on Linux, macOS and WSL:
#
#   curl -fsSL https://raw.githubusercontent.com/albusdemens/zoicode/main/install.sh | bash
#
# It needs no sudo and no Node.js of your own: it downloads the official Node.js 22 for this machine
# from nodejs.org (checking its SHA-256), keeps it with the app in ~/.zoicode/runtime, and puts a
# `zoicode` command in ~/.local/bin. Remove both to uninstall.
#
# For testing: ZOICODE_TARBALL installs another build of the app (a URL or a local .tgz).
set -euo pipefail

# Everything is in functions and runs at the last line, so a download cut short can't run half a script.
TARBALL=${ZOICODE_TARBALL:-https://github.com/albusdemens/zoicode/archive/refs/heads/main.tar.gz}
NODE_MAJOR=22
RUNTIME=$HOME/.zoicode/runtime
BIN_DIR=$HOME/.local/bin

if [ -t 2 ]; then GOLD='\033[33m' RED='\033[31m' OFF='\033[0m'; else GOLD='' RED='' OFF=''; fi
say() { printf "$GOLD▸$OFF %s\n" "$*" >&2; }
fail() { printf "${RED}Zoi Code install failed:$OFF %s\n" "$*" >&2; exit 1; }

platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "this installer is for Linux, macOS and WSL. On Windows, run it in your WSL terminal." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "there is no Node.js build for this processor ($(uname -m))." ;;
  esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "nodejs.org has no Node.js for musl systems such as Alpine. Install Node.js 22.12+ yourself, then: npm install -g $TARBALL"
  fi
  echo "$os-$arch"
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Puts the newest Node.js 22 in $RUNTIME (unless it is there already) and prints its directory.
install_node() {
  local plat=$1 base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x" sums name dir tmp
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || fail "could not reach nodejs.org."
  name=$(printf '%s\n' "$sums" | grep -o "node-v$NODE_MAJOR\.[0-9.]*-$plat\.tar\.gz" | head -1)
  [ -n "$name" ] || fail "nodejs.org lists no Node.js $NODE_MAJOR for $plat."
  dir=$RUNTIME/${name%.tar.gz}
  if [ ! -x "$dir/bin/node" ]; then
    say "Downloading ${name%.tar.gz} from nodejs.org…"
    tmp=$(mktemp -d)
    curl -fsSL "$base/$name" -o "$tmp/$name" || fail "the Node.js download failed."
    [ "$(sha256 "$tmp/$name")" = "$(printf '%s\n' "$sums" | grep " $name\$" | cut -d' ' -f1)" ] ||
      fail "the Node.js download does not match nodejs.org's checksum."
    mkdir -p "$RUNTIME"
    tar -xzf "$tmp/$name" -C "$tmp"
    rm -rf "$dir" && mv "$tmp/${name%.tar.gz}" "$dir"
    rm -rf "$tmp"
  fi
  echo "$dir"
}

# Adds ~/.local/bin to PATH in the shell's startup file, once, if it isn't on PATH already.
add_to_path() {
  case ":$PATH:" in *":$BIN_DIR:"*) return 1 ;; esac
  local rc
  case "${SHELL:-}" in
    *zsh) rc=${ZDOTDIR:-$HOME}/.zshrc ;;
    *bash) rc=$HOME/.bashrc ;;
    *) rc=$HOME/.profile ;;
  esac
  if ! grep -qs 'Added by the Zoi Code installer' "$rc"; then
    printf '\n# Added by the Zoi Code installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
  fi
  echo "$rc"
}

main() {
  command -v curl >/dev/null || fail "curl is needed."
  local plat node_dir app version rc other
  plat=$(platform)
  node_dir=$(install_node "$plat")

  say "Installing Zoi Code…"
  app=$RUNTIME/app
  # The private Node first on PATH, so npm and the app's install steps use it, not an older one.
  # npm's own summary and notices go nowhere; its errors still show.
  PATH="$node_dir/bin:$PATH" npm install -g --prefix "$app" --no-fund --no-audit --no-update-notifier --loglevel=error \
    "$TARBALL" </dev/null >/dev/null || fail "npm could not install the app."

  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/zoicode" <<EOF
#!/bin/sh
# Starts Zoi Code with its own Node.js (written by install.sh).
exec "$node_dir/bin/node" "$app/lib/node_modules/zoicode/dist/cli.js" "\$@"
EOF
  chmod +x "$BIN_DIR/zoicode"
  # Older Node.js builds in the runtime folder are no longer used.
  for old in "$RUNTIME"/node-v*; do [ "$old" = "$node_dir" ] || rm -rf "$old"; done

  version=$("$BIN_DIR/zoicode" --version) || fail "the installed app does not start."
  say "Zoi Code $version is installed."
  if rc=$(add_to_path); then
    say "Open a new terminal (it adds ~/.local/bin to your PATH, in $rc), then run: zoicode"
  else
    other=$(command -v zoicode || true)
    if [ -n "$other" ] && [ "$other" != "$BIN_DIR/zoicode" ]; then
      say "Another zoicode comes first on your PATH: $other. Remove it (npm uninstall -g zoicode) or run $BIN_DIR/zoicode."
    else
      say "Run zoicode in your project folder."
    fi
  fi
}

main "$@"
