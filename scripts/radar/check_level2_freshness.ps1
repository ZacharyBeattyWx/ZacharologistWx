$base = "https://radar.zacharologistwx.com"
$sites = "KFCX","KRAX","KGSP","KLTX","KMRX","KJKL","KRLX","KLWX","KMHX","KAKQ","KCAE","KCLX"

$nowUtc = (Get-Date).ToUniversalTime()

function Get-UtcDateOrNull($value) {
  if (-not $value) {
    return $null
  }

  try {
    return ([datetime]$value).ToUniversalTime()
  } catch {
    return $null
  }
}

$results = foreach ($site in $sites) {
  $url = "$base/radar/tilesets/test/$site/LEVEL2/REF0/frames.json"

  try {
    $manifest = Invoke-WebRequest $url -UseBasicParsing |
      Select-Object -ExpandProperty Content |
      ConvertFrom-Json

    $latest = $manifest.frames[-1]

    $updatedAtUtc = Get-UtcDateOrNull $manifest.updatedAt
    $latestScanUtc = Get-UtcDateOrNull $latest.validTime

    $renderAgeMinutes = if ($updatedAtUtc) {
      [math]::Round(($nowUtc - $updatedAtUtc).TotalMinutes, 1)
    } else {
      $null
    }

    $scanAgeMinutes = if ($latestScanUtc) {
      [math]::Round(($nowUtc - $latestScanUtc).TotalMinutes, 1)
    } else {
      $null
    }

    $renderStatus = if ($null -eq $renderAgeMinutes) {
      "UNKNOWN"
    } elseif ($renderAgeMinutes -le 5) {
      "FRESH"
    } elseif ($renderAgeMinutes -le 10) {
      "OK-ish"
    } else {
      "STALE"
    }

    $scanStatus = if ($null -eq $scanAgeMinutes) {
      "UNKNOWN"
    } elseif ($scanAgeMinutes -le 6) {
      "FRESH"
    } elseif ($scanAgeMinutes -le 12) {
      "OK-ish"
    } else {
      "OLD-SCAN"
    }

    [pscustomobject]@{
      Site = $site
      Frames = $manifest.frames.Count
      UpdatedAtUTC = $manifest.updatedAt
      LatestScan = $latest.validTime
      RenderAgeMin = $renderAgeMinutes
      ScanAgeMin = $scanAgeMinutes
      RenderStatus = $renderStatus
      ScanStatus = $scanStatus
    }
  } catch {
    [pscustomobject]@{
      Site = $site
      Frames = 0
      UpdatedAtUTC = ""
      LatestScan = ""
      RenderAgeMin = ""
      ScanAgeMin = ""
      RenderStatus = "FAILED"
      ScanStatus = "FAILED"
    }
  }
}

$results | Format-Table -AutoSize

$bad = $results | Where-Object {
  $_.RenderStatus -in @("STALE", "FAILED") -or
  $_.ScanStatus -in @("OLD-SCAN", "FAILED")
}

if ($bad.Count -gt 0) {
  Write-Host ""
  Write-Host "Level II freshness concerns detected:" -ForegroundColor Yellow
  $bad | Format-Table -AutoSize
  exit 1
}

exit 0