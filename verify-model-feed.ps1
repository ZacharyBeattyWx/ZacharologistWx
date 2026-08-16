$ErrorActionPreference = "Continue"

$Url = "https://zacharologistwx.com/model-data/hrrr/manifest.json"
Write-Host "Checking $Url"

try {
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers @{ "Cache-Control" = "no-cache" }
  Write-Host "HTTP $($response.StatusCode)" -ForegroundColor Green
  $json = $response.Content | ConvertFrom-Json
  Write-Host "Model : $($json.model)"
  Write-Host "Run   : $($json.run)"
  Write-Host "Frames: $($json.frames.Count)"
  Write-Host "Native HRRR feed is online." -ForegroundColor Green
}
catch {
  $status = $null
  try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
  if ($status -eq 404) {
    Write-Host "HTTP 404: the model-data route is reachable, but manifest.json is not in R2 yet." -ForegroundColor Yellow
    Write-Host "Push the V8 workflow/scripts to main and let Render Model Guidance finish."
  } else {
    Write-Host "Feed check failed: $($_.Exception.Message)" -ForegroundColor Red
  }
}
