param(
  [Parameter(Mandatory = $true)]
  [string] $WorkDir,
  [ValidateRange(1, 60)]
  [int] $IntervalSeconds = 5
)

# Monitor da releitura OCR completa. O full-text-status.json e a fonte de
# progresso deste modo; nao abre o SQLite e portanto nao disputa o checkpoint.
$resolvedWorkDir = [IO.Path]::GetFullPath($WorkDir)
$statusPath = Join-Path $resolvedWorkDir "full-text-status.json"
$lastProcessed = $null
$lastSampleAt = $null

function Read-FullTextStatus {
  if (-not (Test-Path -LiteralPath $statusPath)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $statusPath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return $null
  }
}

while ($true) {
  $now = Get-Date
  $status = Read-FullTextStatus
  $total = 0
  $processed = 0
  $remaining = 0
  $percent = 0
  $statusTime = $null

  if ($status) {
    if ($null -ne $status.sourceFileCount) { $total = [int]$status.sourceFileCount }
    if ($null -ne $status.processed) { $processed = [int]$status.processed }
    if ($null -ne $status.remaining) { $remaining = [int]$status.remaining } else { $remaining = [math]::Max(0, $total - $processed) }
    if ($total -gt 0) { $percent = [math]::Round(($processed / $total) * 100, 2) }
    if ($status.updatedAt) {
      try { $statusTime = [DateTime]::Parse($status.updatedAt).ToLocalTime() } catch { }
    }
  }

  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -like "*--extract-full-text*" -and
      $_.CommandLine -like "*--work*$resolvedWorkDir*"
    })
  $statusAge = if ($statusTime) { ($now - $statusTime).TotalSeconds } else { [double]::PositiveInfinity }

  if ($status -and $status.completed) {
    $state = "CONCLUIDO"
  } elseif ($processes.Count -eq 0) {
    if ($total -gt 0 -and $processed -lt $total) {
      $state = "PARCIALMENTE ENCERRADO - dados preservados; retomada possivel"
    } else {
      $state = "ENCERRADO - processo nao localizado"
    }
  } elseif ($statusAge -le 120) {
    $state = "ATIVO - checkpoint atualizado ha $([math]::Max(0, [math]::Round($statusAge)))s"
  } else {
    $state = "ATIVO, mas sem atualizacao ha $([math]::Round($statusAge))s - OCR lento ou travado"
  }

  $rate = $null
  if ($null -ne $lastProcessed -and $processed -gt $lastProcessed -and $null -ne $lastSampleAt) {
    $elapsedMinutes = ($now - $lastSampleAt).TotalMinutes
    if ($elapsedMinutes -gt 0) { $rate = [math]::Round(($processed - $lastProcessed) / $elapsedMinutes, 2) }
  }
  $eta = if ($rate -and $rate -gt 0) {
    [timespan]::FromMinutes($remaining / $rate).ToString("d' d 'hh' h 'mm' min'")
  } else { "calculando" }

  try { Clear-Host -ErrorAction Stop } catch { }
  Write-Progress -Activity "OCR completo local do SICC" -Status "$processed / $total ($percent%)" -PercentComplete ([math]::Min(100, $percent))
  Write-Host "SICC - acompanhamento do OCR completo"
  Write-Host "Estado:       $state"
  Write-Host "Progresso:    $processed / $total ($percent%)"
  Write-Host "Restantes:    $remaining"
  Write-Host "ImageText:    $($(if ($status -and $null -ne $status.imageTextRecords) { $status.imageTextRecords } else { 0 }))"
  Write-Host "Taxa:         $($(if ($rate) { "$rate imagens/min" } else { "calculando" }))"
  Write-Host "Previsao:     $eta"
  Write-Host "Atualizacao:  $($(if ($statusTime) { $statusTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "ausente" }))"
  if ($status -and $status.counts) {
    Write-Host ("Estados:      " + (($status.counts.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "))
  }
  Write-Host "Leitura:      $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

  if (($status -and $status.completed) -or $processes.Count -eq 0) {
    break
  }
  $lastProcessed = $processed
  $lastSampleAt = $now
  Start-Sleep -Seconds $IntervalSeconds
}
