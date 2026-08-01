# Salad Cloud ComfyUI for AutoMusicVidGen kids-hit
# - Native ComfyUI API ( /prompt + /history + /view ) — works with this repo's client
# - Large Wan weights download on first start (Salad 35GB compressed image limit)
# - Bakes realcartoon + character LoRAs into the image

# RTX 50-series (sm_120 / Blackwell) needs CUDA 12.8 + PyTorch >= 2.7
# https://docs.salad.com/container-engine/tutorials/machine-learning/pytorch-rtx5090
FROM pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime

# RTX 50-series: expandable segments + entrypoint --disable-cuda-malloc
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    COMFY_DIR=/opt/ComfyUI \
    COMFY_PORT=8888 \
    MODEL_CACHE=/opt/ComfyUI/models \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      wget \
      curl \
      ffmpeg \
      libgl1 \
      libglib2.0-0 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ComfyUI (pinned-ish: main at build time; override with build-arg if needed)
ARG COMFY_REF=master
RUN git clone --depth 1 --branch ${COMFY_REF} https://github.com/comfyanonymous/ComfyUI.git ${COMFY_DIR}

WORKDIR ${COMFY_DIR}

# ComfyUI requirements.txt often pulls torch/cu124 and wipes sm_120 support.
# Install everything else, then force CUDA 12.8 wheels back on.
RUN grep -viE '^(torch|torchvision|torchaudio)([<=>![:space:]]|$)' requirements.txt \
      > /tmp/comfy-req-no-torch.txt \
    && pip install --no-cache-dir -r /tmp/comfy-req-no-torch.txt \
    && pip install --no-cache-dir \
      huggingface_hub \
      hf_transfer \
      requests \
      tqdm \
      imageio-ffmpeg \
      opencv-python-headless \
    && pip install --no-cache-dir --force-reinstall \
      torch torchvision torchaudio \
      --index-url https://download.pytorch.org/whl/cu128 \
    && python -c "import torch; v=torch.__version__; print('torch', v); assert 'cu128' in v, v"
# Note: get_arch_list() is empty on CPU-only GH Actions builders; sm_120 is in cu128 wheels.
# Optional custom nodes used by some stills / control paths (safe no-ops if unused)
RUN mkdir -p custom_nodes \
    && git clone --depth 1 https://github.com/cubiq/ComfyUI_IPAdapter_plus.git custom_nodes/ComfyUI_IPAdapter_plus || true \
    && git clone --depth 1 https://github.com/Fannovel16/comfyui_controlnet_aux.git custom_nodes/comfyui_controlnet_aux || true

# Bake small / medium assets from build context (see docker/salad/bake/ + seed-loras/)
COPY bake/loras/ ${COMFY_DIR}/models/loras/
COPY bake/checkpoints/ ${COMFY_DIR}/models/checkpoints/
COPY seed-loras/ ${COMFY_DIR}/models/loras/

COPY download_models.py entrypoint.sh models.manifest.json ${COMFY_DIR}/
RUN chmod +x ${COMFY_DIR}/entrypoint.sh \
    && sed -i 's/\r$//' ${COMFY_DIR}/entrypoint.sh \
    && mkdir -p \
      ${COMFY_DIR}/models/diffusion_models \
      ${COMFY_DIR}/models/vae \
      ${COMFY_DIR}/models/text_encoders \
      ${COMFY_DIR}/models/clip \
      ${COMFY_DIR}/input \
      ${COMFY_DIR}/output \
      ${COMFY_DIR}/temp \
      /tmp/ready

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${COMFY_PORT}/system_stats" || exit 1

ENTRYPOINT ["/opt/ComfyUI/entrypoint.sh"]
