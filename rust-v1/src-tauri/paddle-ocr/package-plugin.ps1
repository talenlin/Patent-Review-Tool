param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\..\..\release\plugins\paddle-ocr-mobile-1.0.0.zip')
)

$ErrorActionPreference = 'Stop'

# The host never bundles this directory. This script creates the separately
# downloadable, self-contained offline OCR plug-in after the runtime and models
# have been prepared with prepare-paddle-runtime.ps1.
foreach ($required in @(
  'plugin.json',
  'paddle_ocr_worker.py',
  'runtime\python.exe',
  'models\PP-OCRv5_mobile_det',
  'models\PP-OCRv5_mobile_rec'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $required))) {
    throw "Cannot package PaddleOCR plug-in; missing $required"
  }
}

$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null

$staging = Join-Path $env:TEMP ("patent-reader-paddle-plugin-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'plugin.json') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'paddle_ocr_worker.py') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime') -Destination (Join-Path $staging 'runtime') -Recurse
  New-Item -ItemType Directory -Path (Join-Path $staging 'models') | Out-Null
  foreach ($model in @('PP-OCRv5_mobile_det', 'PP-OCRv5_mobile_rec')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "models\$model") -Destination (Join-Path $staging "models\$model") -Recurse
  }
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($sevenZip) {
    Push-Location $staging
    try {
      & $sevenZip.Source a -tzip -mx=5 $output '*'
      if ($LASTEXITCODE -ne 0) { throw "7z failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  } else {
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $output -CompressionLevel Optimal
  }
  $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
  Write-Output "PaddleOCR plugin packaged: $output"
  Write-Output "SHA256: $hash"
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
