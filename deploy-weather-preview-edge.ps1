$ErrorActionPreference = "Stop"
$Bucket = "zacharologistwx-weather-previews"
Write-Host "Ensuring R2 bucket exists..."
$existing = npx --yes wrangler@4 r2 bucket list 2>&1 | Out-String
if ($existing -notmatch [regex]::Escape($Bucket)) {
  npx --yes wrangler@4 r2 bucket create $Bucket
  if ($LASTEXITCODE -ne 0) { throw "Could not create R2 bucket." }
} else {
  Write-Host "R2 bucket already exists: $Bucket"
}
Push-Location ".\cloudflare\weather-preview-api"
try {
  npm install
  npx wrangler deploy
  if ($LASTEXITCODE -ne 0) { throw "Weather preview Worker deploy failed." }
} finally { Pop-Location }
Write-Host "Weather preview edge Worker deployed."
