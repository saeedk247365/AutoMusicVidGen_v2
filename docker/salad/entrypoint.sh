#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/opt/ComfyUI}"
# Salad gateway often uses 8888; local default 8188. Prefer PORT / COMFY_PORT env.
COMFY_PORT="${COMFY_PORT:-${PORT:-8888}}"
cd "$COMFY_DIR"

echo "════════════════════════════════════════════════════"
echo " AMVG Salad ComfyUI"
echo " Port: $COMFY_PORT"
echo "════════════════════════════════════════════════════"

# Mark not-ready until models + Comfy are up (Salad readiness probe can hit /ready via sidecar — we use system_stats)
rm -f /tmp/ready/ok || true

echo "→ Ensuring models…"
python "$COMFY_DIR/download_models.py"

echo "→ Starting ComfyUI (native API)…"
# Salad Container Gateway reaches instances over IPv6 — IPv4-only (0.0.0.0) → 503.
# Explicit dual-stack; do NOT use bare --listen next to --port (argparse would steal it).
exec python main.py \
  --listen "0.0.0.0,::" \
  --port "$COMFY_PORT" \
  --disable-auto-launch \
  "$@"
