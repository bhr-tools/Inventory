#!/bin/sh
# Runs the browser tests against a throwaway instance of the current code, with
# Playwright and Chromium from nixpkgs. Screenshots go to tests/e2e/out.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p tests/e2e/out
tmp=$(mktemp -d)
trap 'kill $pid 2>/dev/null || true; rm -rf "$tmp"' EXIT

nix shell nixpkgs#go -c go build -o "$tmp/inventory" ./cmd/server
"$tmp/inventory" -port 18931 -data-dir "$tmp" >"$tmp/server.log" 2>&1 &
pid=$!

browsers=$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)
PLAYWRIGHT_BROWSERS_PATH="$browsers" PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true \
BASE_URL=http://127.0.0.1:18931 OUT=tests/e2e/out \
  nix shell --impure --expr '((builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}).python3.withPackages (p: [ p.playwright ])' \
  -c python3 tests/e2e/smoke.py
