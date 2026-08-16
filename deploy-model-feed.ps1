$ErrorActionPreference = "Stop"

$RepoRoot = (Get-Location).Path
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  throw "Run this from the root of the ZacharologistWx Git repository."
}

$WorkerDir = Join-Path $RepoRoot "cloudflare\model-api"
if (-not (Test-Path (Join-Path $WorkerDir "wrangler.toml"))) {
  throw "Missing cloudflare\model-api\wrangler.toml. Install V13 first."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Node.js/npm is required to deploy the Zacharologist data Worker."
}

Write-Host ""
Write-Host "Deploying Zacharologist model-data Worker..." -ForegroundColor Cyan
Write-Host "Routes:" -ForegroundColor DarkGray
Write-Host "  https://zacharologistwx.com/model-data/*" -ForegroundColor DarkGray
Write-Host ""

Push-Location $WorkerDir
try {
  npm install
  npx wrangler deploy
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "Data Worker deployment finished." -ForegroundColor Green
Write-Host "Model files will become available after the Render Model Guidance GitHub Action writes them to R2."
