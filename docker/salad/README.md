# Salad Cloud — ComfyUI image for AutoMusicVidGen kids-hit

**Image:** `saeedk247365/amvg-comfyui:kids-hit-wan22`

Salad max compressed image size is ~35GB, so Wan 14B weights (~40GB) download on
**first container start** from Hugging Face. Character LoRAs + LightX2V LoRAs +
`realcartoon3d_v15` are baked when you run `prepare-bake.ps1` locally.

## Local build + Docker Hub push

1. Enable CPU virtualization (VT-x/AMD-V) in BIOS, reboot
2. `wsl --install --no-distribution` (reboot if asked)
3. Start Docker Desktop, then:

```powershell
cd E:\DeploymentProduction\AutoMusicVidGen_v2
.\docker\salad\prepare-bake.ps1
docker login
.\docker\salad\build-and-push.cmd
```

## GitHub Actions push (no local Docker)

Add repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (and optional `HF_TOKEN`).

```bash
gh workflow run salad-comfy-image.yml -R saeedk247365/AutoMusicVidGen_v2
```

## Salad container group settings

| Setting | Value |
|---------|--------|
| Image | `ghcr.io/saeedk247365/amvg-comfyui:kids-hit-wan22` |
| **Gateway port** | **8888** (same as local Comfy — `COMFY_PORT`) |
| Comfy listen | **8888** inside the container |
| Local Comfy (PC) | **8888** (`http://127.0.0.1:8888`) |
| Startup / ready probe | `GET /system_stats` on **8888** (long start — model download) |
| GPU | RTX 4090-class 24GB+ |
| RAM / disk | 30GB+ RAM, 80GB+ disk |
| Auth | Salad-Api-Key recommended |

Then set in project `.env`:

```
SALAD_COMFY_URL=https://YOUR_GATEWAY.salad.cloud
SALAD_ORG=...
SALAD_CONTAINER=...
GPU_BACKEND=salad
```

Use mvid **Salad Shutdown** when idle to avoid billing.
