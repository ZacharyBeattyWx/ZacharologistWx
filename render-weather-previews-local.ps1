$ErrorActionPreference = "Stop"
$RepoRoot = (Get-Location).Path
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) { throw "Run from the ZacharologistWx repository root." }
python -m pip install -r ".\scripts\weather\requirements.txt"
python ".\scripts\weather\render_current_wx_previews.py" --output ".\weather-data\current-wx"
Write-Host ""
Write-Host "Rendered local cached previews. Hard-refresh http://localhost:8000/maps.html"
