#!/usr/bin/env sh
# Fetch a Caddy binary with the IONOS DNS provider compiled in.
#
# Stock Caddy cannot solve an ACME DNS-01 challenge — the provider has to be
# built in. Caddy's official build service does that server-side, which means
# neither this machine nor the deployment host needs a Go toolchain, and
# nothing has to be cross-compiled for the target architecture.
#
# Building it locally instead would need ~1-2GB of RAM. Doing that on a small
# or busy server can starve whatever else it is running.
#
#   ./scripts/fetch-caddy.sh [arch]        arch defaults to amd64
set -eu

ARCH="${1:-amd64}"
OUT="caddy-bin/caddy"
URL="https://caddyserver.com/api/download?os=linux&arch=${ARCH}&p=github.com/caddy-dns/ionos"

mkdir -p caddy-bin
echo "Fetching Caddy (linux/${ARCH}) with caddy-dns/ionos..."
curl -fsSL --max-time 300 -o "$OUT" "$URL"
chmod +x "$OUT"

# A truncated or error-page download would otherwise only surface as a
# confusing exec-format failure inside the container.
if ! file "$OUT" | grep -q "ELF 64-bit"; then
  echo "error: downloaded file is not an ELF binary — check the URL or network" >&2
  exit 1
fi

echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
