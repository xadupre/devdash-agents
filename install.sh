#!/usr/bin/env bash
# Installs the latest Arranged Agents release matching this machine into VS Code.
set -euo pipefail

REPO="xadupre/devdash-agents"
CODE="${CODE:-code}"

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  MINGW* | MSYS* | CYGWIN*) platform=win32 ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

target="${platform}-${arch}"
case "$target" in
  linux-x64 | win32-x64 | darwin-arm64) ;;
  *) echo "No native package available for $target." >&2; exit 1 ;;
esac

variant=cpu
if [ "$platform" != darwin ] && command -v nvidia-smi > /dev/null 2>&1 && nvidia-smi -L > /dev/null 2>&1; then
  variant=cuda
fi

asset="devdash-agents-${target}-${variant}.vsix"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

if ! command -v "$CODE" > /dev/null 2>&1; then
  echo "VS Code CLI '$CODE' not found; set CODE to its path (e.g. CODE=code-insiders)." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading $url"
if ! curl -fL --retry 3 -o "$tmpdir/$asset" "$url"; then
  echo "Failed to download $asset from the latest release of $REPO; check the release assets and network connection." >&2
  exit 1
fi

"$CODE" --install-extension "$tmpdir/$asset" --force
