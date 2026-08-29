#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "tunnel-up.sh is a compatibility alias; use scripts/start.sh for the Cloudflare OAuth Bridge."
exec "$DIR/scripts/start.sh" "$@"
