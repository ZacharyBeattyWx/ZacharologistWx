$ErrorActionPreference = "Stop"
$base = "https://zacharologistwx.com/weather-data/current-wx"
$items = @("current-temp.webp","current-hazards.webp","mrms-72h.webp","conus-radar.webp","manifest.json")
foreach ($item in $items) {
  $url = "$base/$item"
  try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 15
    Write-Host "$($r.StatusCode) $item  cache=$($r.Headers['Cache-Control'])  type=$($r.Headers['Content-Type'])"
  } catch {
    Write-Warning "$item failed: $($_.Exception.Message)"
  }
}
