#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/opt/ComfyUI}"
COMFY_PORT="${COMFY_PORT:-8188}"
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
# Listen on all interfaces for Salad container gateway
exec python main.py \
  --listen 0.0.0.0 \
  --port "$COMFY_PORT" \
  --disable-auto-launch \
  "$@"
