$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$secureToken = $null
$tokenValue = $null

try {
  Set-Location $projectRoot
  $secureToken = Read-Host "Paste Earthdata Login token (input hidden)" -AsSecureString
  if ($secureToken.Length -eq 0) {
    throw "An Earthdata token is required for this launcher. Use npm start to run catalog-only mode."
  }

  $tokenValue = [System.Net.NetworkCredential]::new("", $secureToken).Password
  if ([string]::IsNullOrWhiteSpace($tokenValue)) {
    throw "The entered Earthdata token is empty."
  }

  $env:EARTHDATA_TOKEN = $tokenValue
  & npm start
  if ($LASTEXITCODE -ne 0) {
    throw "npm start exited with code $LASTEXITCODE."
  }
}
finally {
  Remove-Item Env:EARTHDATA_TOKEN -ErrorAction SilentlyContinue
  if ($secureToken) {
    $secureToken.Dispose()
  }
  $tokenValue = $null
}
