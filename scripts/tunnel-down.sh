#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "tunnel-down.sh is a compatibility alias; use scripts/stop.sh for the Cloudflare OAuth Bridge."
exec "$DIR/scripts/stop.sh" "$@"
