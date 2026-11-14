# Renders the SideSites toolbar icons (mirrors icons/icon.svg) to PNG at each required size.
Add-Type -AssemblyName System.Drawing

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$outDir = Join-Path $PSScriptRoot '..\icons'
foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 128.0
  $g.ScaleTransform($s, $s)

  $purpleTop = [System.Drawing.ColorTranslator]::FromHtml('#9B30FF')
  $purpleBot = [System.Drawing.ColorTranslator]::FromHtml('#4A00B4')
  $accent = [System.Drawing.ColorTranslator]::FromHtml('#7B1FA2')
  $lilac1 = [System.Drawing.ColorTranslator]::FromHtml('#B388FF')
  $lilac2 = [System.Drawing.ColorTranslator]::FromHtml('#D1B3FF')
  $gold = [System.Drawing.ColorTranslator]::FromHtml('#FFB300')
  $shadowColor = [System.Drawing.Color]::FromArgb(115, 22, 0, 58)
  $softShadow = [System.Drawing.Color]::FromArgb(75, 22, 0, 58)

  # Tile with diagonal gradient and subtle top-left sheen
  $tile = RoundedRect 4 4 120 120 28
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 4, 4), (New-Object System.Drawing.PointF 124, 124), $purpleTop, $purpleBot
  $g.FillPath($grad, $tile)

  $sheenBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 4, 4), (New-Object System.Drawing.PointF 124, 124), ([System.Drawing.Color]::FromArgb(28, 255, 255, 255)), ([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.FillPath($sheenBrush, $tile)

  # Back card shadow + frosted main browser window
  $g.FillPath((New-Object System.Drawing.SolidBrush $softShadow), (RoundedRect 20 35 76 68 12))
  $backRect = RoundedRect 18 30 76 68 12
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(58, 240, 215, 255))), $backRect)
  $backStroke = if ($size -le 16) { 5 } else { 3 }
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(145, 255, 255, 255)), $backStroke), $backRect)

  if ($size -gt 16) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 255, 255, 255))), 27, 38, 6, 6)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(130, 255, 255, 255))), 37, 38, 6, 6)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(130, 255, 255, 255))), 47, 38, 6, 6)
  }

  # Front card layered drop shadow + elevated side panel
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45, 18, 8, 59))), (RoundedRect 60 28 46 86 13))
  $g.FillPath((New-Object System.Drawing.SolidBrush $shadowColor), (RoundedRect 62 27 44 84 12))

  $frontRect = RoundedRect 66 22 44 84 12
  $frontGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 66, 22), (New-Object System.Drawing.PointF 66, 106), ([System.Drawing.Color]::White), ([System.Drawing.ColorTranslator]::FromHtml('#EDE8FF'))
  $g.FillPath($frontGrad, $frontRect)

  # Accent bar + lines inside front card (simplified at 16px)
  $g.FillPath((New-Object System.Drawing.SolidBrush $accent), (RoundedRect 74 34 28 8 4))
  if ($size -gt 16) {
    $g.FillPath((New-Object System.Drawing.SolidBrush $lilac1), (RoundedRect 74 50 22 6 3))
    $g.FillPath((New-Object System.Drawing.SolidBrush $lilac2), (RoundedRect 74 62 28 6 3))
    $g.FillPath((New-Object System.Drawing.SolidBrush $lilac2), (RoundedRect 74 74 18 6 3))

    # Gold 4-point star accent
    $starPts = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF 98, 86),
      (New-Object System.Drawing.PointF 99.8, 90.2),
      (New-Object System.Drawing.PointF 104, 92),
      (New-Object System.Drawing.PointF 99.8, 93.8),
      (New-Object System.Drawing.PointF 98, 98),
      (New-Object System.Drawing.PointF 96.2, 93.8),
      (New-Object System.Drawing.PointF 92, 92),
      (New-Object System.Drawing.PointF 96.2, 90.2)
    )
    $g.FillPolygon((New-Object System.Drawing.SolidBrush $gold), $starPts)
  }

  $g.Dispose()
  $path = Join-Path $outDir "icon$size.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "Wrote $path"
}
