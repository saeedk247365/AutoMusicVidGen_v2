# Prepare bake/ folder for Salad Docker build (copies from local ComfyUI models).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ComfyModels = Join-Path $Root "ComfyUI\models"
$Bake = Join-Path $PSScriptRoot "bake"
$Loras = Join-Path $Bake "loras"
$Ckpts = Join-Path $Bake "checkpoints"

New-Item -ItemType Directory -Force -Path $Loras, $Ckpts | Out-Null

$copyList = @(
  @{ Src = "loras\adamboy_character_v2.safetensors"; Dst = "loras\adamboy_character_v2.safetensors"; Required = $true },
  @{ Src = "loras\sashamom_character_v2.safetensors"; Dst = "loras\sashamom_character_v2.safetensors"; Required = $true },
  @{ Src = "loras\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"; Dst = "loras\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"; Required = $true },
  @{ Src = "loras\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"; Dst = "loras\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"; Required = $true },
  @{ Src = "checkpoints\realcartoon3d_v15.safetensors"; Dst = "checkpoints\realcartoon3d_v15.safetensors"; Required = $true }
)

foreach ($item in $copyList) {
  $src = Join-Path $ComfyModels $item.Src
  $dst = Join-Path $Bake $item.Dst
  if (-not (Test-Path $src)) {
    if ($item.Required) { throw "Missing required model: $src" }
    Write-Warning "Optional missing: $src"
    continue
  }
  Write-Host "Copy $($item.Src) → bake\$($item.Dst)"
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  Copy-Item -Force $src $dst
}

# Placeholders so COPY never fails if a dir is empty
if (-not (Get-ChildItem $Loras -File -ErrorAction SilentlyContinue)) {
  Set-Content (Join-Path $Loras ".keep") ""
}
if (-not (Get-ChildItem $Ckpts -File -ErrorAction SilentlyContinue)) {
  Set-Content (Join-Path $Ckpts ".keep") ""
}

$bytes = (Get-ChildItem $Bake -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("Bake ready: {0:N2} GB under {1}" -f ($bytes / 1GB), $Bake)
