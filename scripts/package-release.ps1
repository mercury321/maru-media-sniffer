param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$destinationFolder = Split-Path -Parent $DestinationPath

if (-not (Test-Path -LiteralPath $destinationFolder)) {
  New-Item -ItemType Directory -Path $destinationFolder -Force | Out-Null
}

if (Test-Path -LiteralPath $DestinationPath) {
  Remove-Item -LiteralPath $DestinationPath -Force
}

Compress-Archive -Path (Join-Path $source '*') -DestinationPath $DestinationPath -Force
