$base = "https://radar.zacharologistwx.com"
$sites = "KFCX","KRAX","KGSP","KLTX","KMRX","KJKL","KRLX","KLWX","KMHX","KAKQ","KCAE","KCLX"

$nowUtc = (Get-Date).ToUniversalTime()

$results = foreach ($site in $sites) {
  $url = "$base/radar/tilesets/test/$site/LEVEL2/REF0/frames.json"

  try {
    $manifest = Invoke-WebRequest $url -UseBasicParsing |
      Select-Object -ExpandProperty Content |
      ConvertFrom-Json

    $latest = $manifest.frames[-1]
    $updatedAt = [datetime]$manifest.updatedAt
    $ageMinutes = [math]::Round(($nowUtc - $updatedAt.ToUniversalTime()).TotalMinutes, 1)

    [pscustomobject]@{
      Site = $site
      Frames = $manifest.frames.Count
      UpdatedAtUTC = $manifest.updatedAt
      LatestScan = $latest.validTime
      AgeMinutes = $ageMinutes
      Status = if ($ageMinutes -le 5) {
        "FRESH"
      } elseif ($ageMinutes -le 10) {
        "OK-ish"
      } else {
        "STALE"
      }
    }
  } catch {
    [pscustomobject]@{
      Site = $site
      Frames = 0
      UpdatedAtUTC = ""
      LatestScan = ""
      AgeMinutes = ""
      Status = "FAILED"
    }
  }
}

$results | Format-Table -AutoSize

$stale = $results | Where-Object { $_.Status -in @("STALE", "FAILED") }

if ($stale.Count -gt 0) {
  Write-Host ""
  Write-Host "Stale or failed Level II sites detected:" -ForegroundColor Yellow
  $stale | Format-Table -AutoSize
  exit 1
}

exit 0