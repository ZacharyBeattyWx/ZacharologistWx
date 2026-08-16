$ErrorActionPreference = "Stop"

$Bbox = "-14200679.12,2500000,-7400000,6505689.94"
$Url = "https://zacharologistwx.com/weather-data/ndfd?layer=ndfd.conus.maxt&season=1&width=983&height=579&bbox=$([uri]::EscapeDataString($Bbox))"

Write-Host "Checking NDFD proxy..."
Write-Host $Url

$response = Invoke-WebRequest -Uri $Url -UseBasicParsing

Write-Host "HTTP $($response.StatusCode)"
Write-Host "Content-Type: $($response.Headers['Content-Type'])"
Write-Host "Bytes: $($response.RawContentLength)"

if ($response.StatusCode -ne 200) {
  throw "NDFD proxy did not return HTTP 200."
}

if (($response.Headers['Content-Type'] -join ",") -notmatch "image") {
  throw "NDFD proxy did not return an image content type."
}

if ($response.RawContentLength -lt 1000) {
  throw "NDFD proxy image response is unexpectedly small."
}

Write-Host "NDFD weather proxy is online." -ForegroundColor Green
