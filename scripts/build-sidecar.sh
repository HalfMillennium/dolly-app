#!/usr/bin/env bash
# Build the dollyd Swift sidecar as a universal binary and place it where Tauri expects it
# (BUILD_PLAN §2.2, §8). macOS + Xcode/Swift toolchain required.
#
#   scripts/build-sidecar.sh [release|debug]
#
# Produces:
#   apps/desktop/src-tauri/binaries/dollyd-aarch64-apple-darwin
#   apps/desktop/src-tauri/binaries/dollyd-x86_64-apple-darwin
#   apps/desktop/src-tauri/binaries/dollyd            (universal, via lipo)
#
# Tauri's `externalBin` resolves the per-triple names when bundling with
# --target universal-apple-darwin; the plain `dollyd` universal binary is handy for local runs.
set -euo pipefail

config="${1:-release}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/native/dollyd"
out="$root/apps/desktop/src-tauri/binaries"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-sidecar.sh must run on macOS (needs the Swift toolchain + Apple frameworks)." >&2
  exit 1
fi

mkdir -p "$out"

build_arch() {
  local arch="$1" triple="$2"
  echo "==> swift build ($arch / $config)"
  swift build \
    --package-path "$pkg" \
    --configuration "$config" \
    --arch "$arch"
  local bin
  bin="$(swift build --package-path "$pkg" --configuration "$config" --arch "$arch" --show-bin-path)/dollyd"
  cp "$bin" "$out/dollyd-$triple"
}

build_arch arm64 aarch64-apple-darwin
build_arch x86_64 x86_64-apple-darwin

echo "==> lipo universal"
lipo -create \
  "$out/dollyd-aarch64-apple-darwin" \
  "$out/dollyd-x86_64-apple-darwin" \
  -output "$out/dollyd"
lipo -info "$out/dollyd"

echo "Sidecar built at $out/dollyd"
