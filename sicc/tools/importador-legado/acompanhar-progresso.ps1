param(
  [Parameter(Mandatory = $true)]
  [string] $WorkDir,
  [ValidateRange(1, 60)]
  [int] $IntervalSeconds = 5
)

$resolvedWorkDir = [IO.Path]::GetFullPath($WorkDir)
$checkpointPath = Join-Path $resolvedWorkDir "checkpoint.sqlite"
$statusPath = Join-Path $resolvedWorkDir "status.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$lastProcessed = $null
$lastSampleAt = $null
$lastKnownProcessed = 0

while ($true) {
  $now = Get-Date
  $checkpoint = Get-Item -LiteralPath $checkpointPath -ErrorAction SilentlyContinue
  $status = $null
  try { $status = Get-Content -LiteralPath $statusPath -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json } catch { }
  $env:SICC_IMPORT_CHECKPOINT = $checkpointPath
  $query = @'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.SICC_IMPORT_CHECKPOINT,{readOnly:true});
db.exec('PRAGMA busy_timeout = 5000');
const rows=db.prepare('select state from files').all();
const states={};
for(const row of rows) states[row.state]=(states[row.state]||0)+1;
console.log(JSON.stringify({processed:rows.length,states}));
db.close();
'@
  $snapshot = $null
  try { $snapshot = (& $nodePath -e $query | ConvertFrom-Json) } catch { }
  $processed = 0
  if ($snapshot -and $null -ne $snapshot.processed) {
    $processed = [int]$snapshot.processed
    $lastKnownProcessed = $processed
  } else {
    $processed = $lastKnownProcessed
  }
  $total = 0
  if ($status -and $null -ne $status.sourceFileCount) { $total = [int]$status.sourceFileCount }
  $percent = if ($total) { [math]::Round(($processed / $total) * 100, 2) } else { 0 }
  $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("node.exe", "python.exe") -and $_.CommandLine -like "*extract-data-only*" })
  $checkpointAge = if ($checkpoint) { ($now - $checkpoint.LastWriteTime).TotalSeconds } else { [double]::PositiveInfinity }

  if ($status -and $status.completed) {
    $state = "CONCLUIDO"
  } elseif ($processes.Count -eq 0) {
    if ($total -gt 0 -and $processed -lt $total) {
      $state = "PARCIALMENTE ENCERRADO - dados preservados; retomada possivel"
    } else {
      $state = "ENCERRADO - processo nao localizado"
    }
  } elseif ($checkpointAge -le 120) {
    $state = "ATIVO - checkpoint atualizado ha $([math]::Round($checkpointAge))s"
  } else {
    $state = "ATIVO, mas sem checkpoint ha $([math]::Round($checkpointAge))s - OCR lento ou travado"
  }

  $rate = $null
  if ($null -ne $lastProcessed -and $processed -gt $lastProcessed -and $null -ne $lastSampleAt) {
    $rate = [math]::Round(($processed - $lastProcessed) / (($now - $lastSampleAt).TotalMinutes), 2)
  }
  $eta = if ($rate -and $rate -gt 0) { [timespan]::FromMinutes(($total - $processed) / $rate).ToString("d' d 'hh' h 'mm' min'") } else { "calculando" }

  try { Clear-Host -ErrorAction Stop } catch { }
  Write-Progress -Activity "Extracao local do SICC" -Status "$processed / $total ($percent%)" -PercentComplete $percent
  Write-Host "SICC - acompanhamento da extracao local"
  Write-Host "Estado:      $state"
  Write-Host "Progresso:   $processed / $total ($percent%)"
  Write-Host "Restantes:   $([math]::Max(0, $total - $processed))"
  Write-Host "Taxa:        $($(if ($rate) { "$rate imagens/min" } else { "calculando" }))"
  Write-Host "Previsao:    $eta"
  Write-Host "Checkpoint:  $($(if ($checkpoint) { $checkpoint.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "ausente" }))"
  if ($snapshot.states) { Write-Host ("Estados:     " + (($snapshot.states.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", ")) }
  Write-Host "Atualizacao: $now"

  if (($status -and $status.completed) -or $processes.Count -eq 0) { break }
  $lastProcessed = $processed
  $lastSampleAt = $now
  Start-Sleep -Seconds $IntervalSeconds
}
