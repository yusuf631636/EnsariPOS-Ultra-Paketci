# Ultra Paketci - NSSM ile TEK Windows servisi kurar. Mevcut "GelismisKuryeSistemi" VE
# "AlfaPOSKuryeTakip" servislerinden TAMAMEN AYRI ad/port (4099) - ucu de ayni makinede
# yan yana calisabilir, biri digerine dokunmaz.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Bu script Yonetici olarak calistirilmalidir (Windows servisi kurmak icin gerekli). Kurulum programi (setup.exe) bunu otomatik yukseltilmis olarak calistirir.' }

$nssm = Join-Path $PSScriptRoot 'nssm.exe'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node.exe bulunamadi. install-requirements.ps1 calistirin.' }
$nodeExe = $nodeCmd.Source

$config = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$port = if ($config.port) { $config.port } else { 4099 }

$runtimeDir = Join-Path $env:ProgramData 'EnsariPOS\UltraPaketci'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$name = 'UltraPaketci'

# Guvenlik (16.09.2026): SQL sifresi artik config.json'a YAZILMAZ, servisin KENDI ortam
# degiskeni (AppEnvironmentExtra) olarak saklanir. Kaynagi oncelik sirasiyla:
#   1) Setup.exe'nin bu calistirmadan HEMEN ONCE biraktigi tek seferlik ".sql-pw.tmp"
#      dosyasi (kullanici kurulum sihirbazinda sifreyi az once girdiyse) - okunur okunmaz silinir.
#   2) Servis zaten kuruluysa, kaldirip yeniden kurmadan ONCE mevcut ortam degiskeni
#      (daha once 1. yoldan ayarlanmis olabilir) - "Servisi Yeniden Kur" kisayolu servisi
#      sifirdan kurdugu icin bu adim olmazsa sifre HER seferinde kaybolurdu.
#   3) config.json'da HALA eski usul duz metin "password" varsa (eski bir kurulumdan
#      guncellenmis olabilir) - geriye donuk uyumluluk, once bu calisir sonra config.json
#      zaten sifresiz yeniden yazilmaz (setup.exe'nin kendi isi), sadece burada okunur.
$sqlPasswordEnv = $null
$secretFile = Join-Path $PSScriptRoot '.sql-pw.tmp'
if (Test-Path $secretFile) {
  $sqlPasswordEnv = (Get-Content $secretFile -Raw).Trim()
  Remove-Item $secretFile -Force
}
if (-not $sqlPasswordEnv -and (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
  $existing = & $nssm get $name AppEnvironmentExtra 2>&1
  if ($LASTEXITCODE -eq 0 -and $existing -match 'SAMBAPOS_SQL_PASSWORD=') { $sqlPasswordEnv = $existing }
}
if (-not $sqlPasswordEnv -and $config.password) { $sqlPasswordEnv = "SAMBAPOS_SQL_PASSWORD=$($config.password)" }
if ($sqlPasswordEnv -and $sqlPasswordEnv -notmatch '^SAMBAPOS_SQL_PASSWORD=') { $sqlPasswordEnv = "SAMBAPOS_SQL_PASSWORD=$sqlPasswordEnv" }

if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
  Write-Host "$name zaten kurulu, durdurup guncelleniyor..." -ForegroundColor Yellow
  & $nssm stop $name 2>&1 | Out-Null
  & $nssm remove $name confirm 2>&1 | Out-Null
}
& $nssm install $name $nodeExe 2>&1 | Out-Null
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name\Parameters" -Name AppParameters -Value "`"$PSScriptRoot\server.js`""
& $nssm set $name AppDirectory $PSScriptRoot 2>&1 | Out-Null
& $nssm set $name AppStdout (Join-Path $logDir 'server.log') 2>&1 | Out-Null
& $nssm set $name AppStderr (Join-Path $logDir 'server.err.log') 2>&1 | Out-Null
& $nssm set $name Start SERVICE_AUTO_START 2>&1 | Out-Null
& $nssm set $name AppExit Default Restart 2>&1 | Out-Null
& $nssm set $name AppThrottle 15000 2>&1 | Out-Null
if ($sqlPasswordEnv) { & $nssm set $name AppEnvironmentExtra $sqlPasswordEnv 2>&1 | Out-Null }
& $nssm start $name 2>&1 | Out-Null
Start-Sleep -Seconds 3
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Running') {
  & $nssm stop $name 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  & $nssm start $name 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
}

Write-Host ''
if ($service -and $service.Status -eq 'Running') {
  Write-Host "$name calisiyor (port $port)." -ForegroundColor Green
} else {
  Write-Warning "$name baslatilamadi (durum: $(if ($service) { $service.Status } else { 'kurulmadi' })). $logDir altindaki .err.log dosyasina bakin."
}
Write-Host "Kurye ekrani: http://127.0.0.1:$port/courier" -ForegroundColor DarkGray
Write-Host "Restoran ekrani: http://127.0.0.1:$port/restoran" -ForegroundColor DarkGray
Write-Host "Ayni WiFi'deki telefondan erismek icin bu bilgisayarin yerel IP adresini kullanin (orn. http://192.168.1.X:$port/courier)." -ForegroundColor DarkGray
Start-Sleep -Seconds 3
