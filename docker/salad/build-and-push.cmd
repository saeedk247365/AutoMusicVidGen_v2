@echo off
REM Build + push Salad ComfyUI image to Docker Hub
set IMAGE=saeedk247365/amvg-comfyui:kids-hit-wan22
set IMAGE_LATEST=saeedk247365/amvg-comfyui:latest

powershell -ExecutionPolicy Bypass -File "%~dp0prepare-bake.ps1"
if errorlevel 1 exit /b 1

docker build -t %IMAGE% -t %IMAGE_LATEST% "%~dp0"
if errorlevel 1 exit /b 1

echo.
echo Image built: %IMAGE%
echo Pushing to Docker Hub (docker login required)…
docker push %IMAGE%
docker push %IMAGE_LATEST%
echo Done.
