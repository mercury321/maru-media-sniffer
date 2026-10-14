param(
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function New-PromoAsset([int]$Width, [int]$Height, [string]$OutputPath) {
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 255, 248, 249))

  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 214, 35, 59))
  $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 104, 85, 91))
  $dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 38, 42))
  $icon = [System.Drawing.Image]::FromFile($IconPath)
  $iconSize = [Math]::Round([Math]::Min($Height * 0.52, $Width * 0.23))
  $iconX = [Math]::Round($Width * 0.10)
  $iconY = [Math]::Round(($Height - $iconSize) / 2)
  $graphics.DrawImage($icon, $iconX, $iconY, $iconSize, $iconSize)

  $tagFont = New-Object System.Drawing.Font("Segoe UI", ($Height * 0.055), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $titleFont = New-Object System.Drawing.Font("Microsoft YaHei UI", ($Height * 0.12), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $bodyFont = New-Object System.Drawing.Font("Segoe UI", ($Height * 0.065), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $textX = $iconX + $iconSize + [Math]::Round($Width * 0.055)
  $graphics.DrawString("MARU MEDIA SNIFFER", $tagFont, $accent, $textX, [Math]::Round($Height * 0.27))
  $graphics.DrawString("Media, made clear.", $titleFont, $dark, $textX, [Math]::Round($Height * 0.38))
  $graphics.DrawString("Find the media you are watching.", $bodyFont, $muted, $textX, [Math]::Round($Height * 0.58))
  $graphics.DrawString("Local. Clear. In your control.", $bodyFont, $muted, $textX, [Math]::Round($Height * 0.69))

  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bodyFont.Dispose(); $titleFont.Dispose(); $tagFont.Dispose(); $icon.Dispose(); $dark.Dispose(); $muted.Dispose(); $accent.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

New-PromoAsset 440 280 (Join-Path $OutputDirectory "maru-promo-440x280.png")
New-PromoAsset 1400 560 (Join-Path $OutputDirectory "maru-promo-1400x560.png")
