# Run AMVG on Salad Cloud — finish checklist

Image is already built and pushed:

**`ghcr.io/saeedk247365/amvg-comfyui:kids-hit-wan22`**

(Build: https://github.com/saeedk247365/AutoMusicVidGen_v2/actions/runs/30672228265)

## 1) Make the image pullable by Salad (30 seconds)

Open: https://github.com/users/saeedk247365/packages/container/package/amvg-comfyui

- Package settings → **Change visibility → Public**

**Or** keep it private and create a GitHub PAT with `read:packages`, then put in `.env`:

```
GHCR_USER=saeedk247365
GHCR_TOKEN=ghp_...
```

## 2) Set your Salad org slug

In [portal.salad.com](https://portal.salad.com) copy the org from the URL:

`https://portal.salad.com/organizations/<THIS_PART>/…`

Put in `.env`:

```
SALAD_ORG=<THIS_PART>
SALAD_CONTAINER=amvg-comfyui
SALAD_IMAGE=ghcr.io/saeedk247365/amvg-comfyui:kids-hit-wan22
```

## 3) Deploy + start

```powershell
npm run salad:deploy
```

This creates the container group (GPU, **port 8888**, auth), starts it, and writes `SALAD_COMFY_URL` into `.env`.

**Port rule:** Comfy is **8888** everywhere — local PC, Salad listen, Container Gateway, and deploy probes (`COMFY_PORT` in `lib/gpu-backend.js`).

First boot downloads Wan weights (~40GB) — wait until Status = running/ready (can take a while; Salad doesn’t bill the same during image prepare).

**RTX 50-series (5080/5090):** the image must start Comfy with `--disable-cuda-malloc`. Without that, Wan can sit “running” for 30+ minutes with flat VRAM. Rebuild/push after pulling latest `docker/salad/entrypoint.sh`, then redeploy.

## 4) Generate

```powershell
npm run mvid -- --salad
```

Or toggle **GPU → Salad Cloud** in the mvid toolbar.

Use **Salad Shutdown** when idle to stop billing.
