#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/opt/ComfyUI}"
# Canonical Salad port — MUST match Container Gateway in the Salad portal.
# Do not use Salad's generic $PORT (it has disagreed with the gateway before).
# Override only with explicit COMFY_PORT in the container group env.
COMFY_PORT="${COMFY_PORT:-8888}"
cd "$COMFY_DIR"

echo "════════════════════════════════════════════════════"
echo " AMVG Salad ComfyUI"
echo " Port: $COMFY_PORT  (gateway must match)"
echo "════════════════════════════════════════════════════"

# Mark not-ready until models + Comfy are up (Salad readiness probe can hit /ready via sidecar — we use system_stats)
rm -f /tmp/ready/ok || true

echo "→ Ensuring models…"
python "$COMFY_DIR/download_models.py"

# RTX 50-series (Blackwell) + cudaMallocAsync commonly wedges Wan/KSampler
# with flat VRAM for 30+ minutes. Force the classic allocator.
# Optional: COMFY_EXTRA_ARGS="--disable-pinned-memory" etc.
EXTRA_ARGS=(--disable-cuda-malloc)
if [[ -n "${COMFY_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS+=(${COMFY_EXTRA_ARGS})
fi

echo "→ Starting ComfyUI (native API)…"
echo "  args: --listen 0.0.0.0,:: --port $COMFY_PORT --disable-auto-launch ${EXTRA_ARGS[*]} $*"
# Salad Container Gateway reaches instances over IPv6 — IPv4-only (0.0.0.0) → 503.
# Explicit dual-stack; do NOT use bare --listen next to --port (argparse would steal it).
exec python main.py \
  --listen "0.0.0.0,::" \
  --port "$COMFY_PORT" \
  --disable-auto-launch \
  "${EXTRA_ARGS[@]}" \
  "$@"
