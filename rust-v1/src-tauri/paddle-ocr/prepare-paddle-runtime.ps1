param(
  [string]$Python = 'py -3.12',
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'runtime')
)

$ErrorActionPreference = 'Stop'

# This is a release-engineering helper. It is intentionally not invoked by the
# application: a released build must not download Python packages or models.
$pythonParts = $Python -split ' '
$pythonCommand = $pythonParts[0]
$pythonArguments = @($pythonParts | Select-Object -Skip 1)

& $pythonCommand @pythonArguments -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
& $pythonCommand @pythonArguments -m venv (Join-Path $PSScriptRoot '.runtime-build')
$buildPython = Join-Path $PSScriptRoot '.runtime-build\Scripts\python.exe'
& $buildPython -m pip install --upgrade pip
& $buildPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')

$basePython = & $pythonCommand @pythonArguments -c 'import sys; print(sys.base_prefix)'
if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -Recurse -Force -LiteralPath $OutputRoot }
New-Item -ItemType Directory -Path $OutputRoot | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $basePython '*') -Destination $OutputRoot
Copy-Item -Recurse -Force -Path (Join-Path $PSScriptRoot '.runtime-build\Lib\site-packages\*') -Destination (Join-Path $OutputRoot 'Lib\site-packages')

$modelRoot = Join-Path $PSScriptRoot 'models'
if (Test-Path -LiteralPath $modelRoot) { Remove-Item -Recurse -Force -LiteralPath $modelRoot }
New-Item -ItemType Directory -Path $modelRoot | Out-Null

# Download once during release assembly, then copy both required model folders
# beside the worker. The app uses those explicit paths and never downloads them.
$env:PADDLE_PDX_MODEL_SOURCE = 'BOS'
& $buildPython (Join-Path $PSScriptRoot 'prepare_models.py')

$officialModels = Join-Path $env:USERPROFILE '.paddlex\official_models'
foreach ($model in @('PP-OCRv5_mobile_det', 'PP-OCRv5_mobile_rec')) {
  $source = Join-Path $officialModels $model
  if (-not (Test-Path -LiteralPath $source)) { throw "PaddleOCR did not create expected model: $source" }
  Copy-Item -Recurse -Force -LiteralPath $source -Destination (Join-Path $modelRoot $model)
}

& (Join-Path $OutputRoot 'python.exe') -c 'import paddle, paddleocr; print("Bundled PaddleOCR runtime OK")'
Write-Output "Bundled local PaddleOCR runtime ready: $OutputRoot"
