param([string]$Bucket = "zacharologistwx-weather-previews")
$ErrorActionPreference = "Stop"
$RepoRoot = (Get-Location).Path
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) { throw "Run from the ZacharologistWx repository root." }
& ".\render-weather-previews-local.ps1"
$files = @(
  @{ Key="current-temp.webp"; Type="image/webp"; Cache="public, max-age=120, stale-while-revalidate=600" },
  @{ Key="current-hazards.webp"; Type="image/webp"; Cache="public, max-age=120, stale-while-revalidate=600" },
  @{ Key="mrms-72h.webp"; Type="image/webp"; Cache="public, max-age=120, stale-while-revalidate=600" },
  @{ Key="conus-radar.webp"; Type="image/webp"; Cache="public, max-age=120, stale-while-revalidate=600" },
  @{ Key="manifest.json"; Type="application/json"; Cache="public, max-age=30, stale-while-revalidate=120" }
)
foreach ($item in $files) {
  npx --yes wrangler@4 r2 object put "$Bucket/$($item.Key)" --file="weather-data/current-wx/$($item.Key)" --content-type="$($item.Type)" --cache-control="$($item.Cache)" --remote
  if ($LASTEXITCODE -ne 0) { throw "R2 upload failed for $($item.Key)" }
}
Write-Host "Published cached weather previews to R2 bucket $Bucket."
