<#
  JET MEDIA — подготовка планшетов по USB.

  Запуск: двойной клик по provision.cmd
     или: powershell -ExecutionPolicy Bypass -File provision.ps1 [-Watch] [-CheckOnly] [-Reboot]

  -Watch      ждать новые планшеты и настраивать каждый сразу после подключения
  -CheckOnly  только проверить планшеты, ничего не менять
  -Reboot     перезагрузить планшет после настройки

  Что делает с каждым планшетом:
    1. проверяет модель, Android, аккаунты, пользователей, текущего владельца устройства;
    2. скачивает свежий агент с GitHub, ставит его и делает его владельцем устройства (Device Owner);
    3. подключает Wi-Fi (заданный или первую сеть «для всех планшетов» из админки), включает «не гаснуть на зарядке»;
    4. запускает агент и передаёт ему адрес сервера, код регистрации и сети «для всех планшетов» из админки;
    5. пишет результат в provision-log.csv.
#>
param(
  [string]$AgentApk   = "$PSScriptRoot\apk\jet-agent.apk",
  [string]$AgentUrl   = "https://github.com/ph001player1-lab/JetMediaRestaurant/releases/download/agent-latest/jet-agent.apk",
  [string]$StartUrl   = "",      # какую страницу показывать; пусто — экран статуса агента
  [string]$Pin        = "1234",  # PIN сервисного меню
  [string]$Admin      = "com.jetmedia.agent/.AdminReceiver",
  [string]$ServerUrl  = "https://api.jetmedia.dev",
  [string]$EnrollCode = "",
  [string]$WifiSsid   = "",
  [string]$WifiPass   = "",
  [switch]$Watch,
  [switch]$CheckOnly,
  [switch]$Reboot
)

$Pkg = $Admin.Split('/')[0]
$Log = "$PSScriptRoot\provision-log.csv"
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# ADB: рядом со скриптом, в PATH или скачиваем официальный platform-tools
function Get-Adb {
  $local = "$PSScriptRoot\platform-tools\adb.exe"
  if (Test-Path $local) { return $local }
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  Say "ADB не найден, скачиваю Android platform-tools..." Yellow
  $zip = "$env:TEMP\platform-tools.zip"
  Invoke-WebRequest "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $PSScriptRoot -Force
  return $local
}
$Adb = Get-Adb

# Свежий агент с GitHub; если сети нет — берём тот, что уже лежит в apk\
function Get-Agent {
  New-Item -ItemType Directory -Force (Split-Path $AgentApk) | Out-Null
  try {
    Invoke-WebRequest $AgentUrl -OutFile "$AgentApk.tmp" -UseBasicParsing
    Move-Item -Force "$AgentApk.tmp" $AgentApk
    Say "Агент скачан: $AgentApk" Green
  } catch { Say "Не удалось скачать агент, беру локальный файл" Yellow }
}

# Команда adb для одного планшета; stderr тоже собираем в текст
function Run($serial) { (& $Adb -s $serial @args 2>&1 | ForEach-Object { "$_" }) -join "`n" }
function Sh($serial, $command) { (Run $serial shell $command).Trim() }

function Get-Devices {
  & $Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '^\S+\s+\S+' } | ForEach-Object {
    $p = $_ -split '\s+'
    [pscustomobject]@{ Serial = $p[0]; State = $p[1] }
  }
}

function Inspect($s) {
  $ownerComp = [regex]::Match((Sh $s 'dumpsys device_policy'), '(?s)Device Owner:.*?admin=ComponentInfo\{([^}]+)\}').Groups[1].Value
  $owner = ($ownerComp -split '/')[0]
  $info = [ordered]@{
    Serial   = $s
    Model    = Sh $s 'getprop ro.product.model'
    Android  = Sh $s 'getprop ro.build.version.release'
    Accounts = [int][regex]::Match((Sh $s 'dumpsys account'), 'Accounts:\s*(\d+)').Groups[1].Value
    Users    = [regex]::Matches((Sh $s 'pm list users'), 'UserInfo\{').Count
    Owner    = $owner
    OwnerComp = $ownerComp
  }
  $info.Problem = if ($owner -eq $Pkg) { '' }
    elseif ($owner)         { "Уже есть владелец устройства: $owner." }
    elseif ($info.Accounts) { "На планшете есть аккаунт. Сбросьте к заводским и при первой настройке не входите в Google." }
    elseif ($info.Users -gt 1) { "На планшете несколько пользователей. Удалите лишних или сбросьте к заводским." }
    else { '' }
  [pscustomobject]$info
}

function Explain($out) {
  if ($out -match 'accounts')        { return "На планшете есть аккаунт: сброс к заводским, без входа в Google." }
  if ($out -match 'users')           { return "На планшете несколько пользователей." }
  if ($out -match 'already')         { return "Владелец устройства уже назначен: нужен сброс к заводским." }
  if ($out -match 'Unknown admin')   { return "В APK нет компонента $Admin — проверьте сборку агента." }
  return $out
}

function Write-Log($i, $result) {
  if (-not (Test-Path $Log)) { 'Time,Serial,Model,Android,Result' | Set-Content $Log -Encoding UTF8 }
  "$(Get-Date -Format s),$($i.Serial),$($i.Model),$($i.Android),""$result""" | Add-Content $Log -Encoding UTF8
}

# Чужой владелец устройства (например, FreeKiosk): пробуем снять его через ADB, FreeKiosk удаляем,
# чтобы он не спорил с агентом за экран. Не вышло — подсказываем, как снять вручную.
function Remove-OtherOwner($s, $i) {
  if ($CheckOnly) { Say "  Владелец сейчас: $($i.Owner) — provision.cmd попробует снять его сам" Yellow; $i.Problem = ''; return $i }
  Say "  Снимаю прежнего владельца устройства: $($i.Owner)..."
  Sh $s "dpm remove-active-admin $($i.OwnerComp)" | Out-Null
  $i = Inspect $s
  if ($i.Owner -and $i.Owner -ne $Pkg) {
    $i.Problem = "Не удалось снять владельца $($i.Owner) через ADB. " + $(if ($i.Owner -eq 'com.freekiosk') {
      "В FreeKiosk: 5 раз нажмите секретную кнопку → PIN → «Remove Device Owner» (не «Exit Kiosk Mode»), затем запустите скрипт снова." } else {
      "Снимите его в настройках того приложения или сбросьте планшет к заводским." })
    return $i
  }
  if ($i.Owner -ne $Pkg -and (Sh $s "pm list packages com.freekiosk") -match 'com.freekiosk') {
    Say "  Удаляю FreeKiosk..."
    Sh $s "pm uninstall com.freekiosk" | Out-Null
  }
  Say "  Прежний владелец снят" Green
  return $i
}

function Provision($s) {
  $i = Inspect $s
  Say "`n=== $($i.Serial) · $($i.Model) · Android $($i.Android) ===" Cyan
  if ($i.Owner -and $i.Owner -ne $Pkg) { $i = Remove-OtherOwner $s $i }
  if ($i.Problem) { Say "  НЕ ГОТОВ: $($i.Problem)" Red; Write-Log $i "not ready: $($i.Problem)"; return }
  if ($CheckOnly) { Say "  Готов к настройке" Green; return }
  if (-not (Test-Path $AgentApk)) { Say "  Нет файла агента: $AgentApk" Red; return }

  Say "  Ставлю агент..."
  $out = Run $s install -r -g $AgentApk
  if ($out -notmatch 'Success') { Say "  Ошибка установки: $out" Red; Write-Log $i "install failed"; return }

  if ($i.Owner -ne $Pkg) {
    Say "  Назначаю агент владельцем устройства..."
    $out = Sh $s "dpm set-device-owner $Admin"
    if ($out -notmatch 'Success') { Say "  Ошибка: $(Explain $out)" Red; Write-Log $i "device owner failed"; return }
  }

  if ($WifiSsid) {
    Say "  Подключаю Wi-Fi $WifiSsid..."
    $sec = if ($WifiPass) { "wpa2 '$WifiPass'" } else { 'open' }
    $out = Sh $s "cmd wifi connect-network '$WifiSsid' $sec"
    if ($out -match 'rror|nknown') { Say "  Wi-Fi не подключился: $out (подключите вручную)" Yellow }
  }
  Sh $s 'settings put global stay_on_while_plugged_in 7' | Out-Null

  # Конфиг агенту: JSON в base64, чтобы не мучиться с кавычками в командной строке
  $cfg = @{ server = $ServerUrl; enroll = $EnrollCode; url = $StartUrl; pin = $Pin; serial = $s; provisionedAt = (Get-Date -Format s) }
  if ($Fleet -and $Fleet.nets) { $cfg.wifi = @{ nets = $Fleet.nets; primary = $Fleet.primary } }   # агент сохранит эти сети сразу, до первой связи с сервером
  # PIN сервисного меню из админки (только отпечаток): заводской 1234 не действует ни минуты
  if ($Fleet -and $Fleet.pin -and $Fleet.pin.hash) { $cfg.pinSalt = $Fleet.pin.salt; $cfg.pinHash = $Fleet.pin.hash }
  $json = $cfg | ConvertTo-Json -Compress -Depth 6
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  Sh $s "am start -n $Pkg/.MainActivity --es config $b64" | Out-Null

  if ($Reboot) { Run $s reboot | Out-Null }
  Say "  ГОТОВО" Green
  if (-not $EnrollCode) { Say "  Ключ не указан: добавьте планшет в портале — Устройства → «Новые устройства»." Yellow }
  if (-not $WifiSsid) { Say "  Wi-Fi не задан: планшет подключится к уже сохранённой сети, а если её нет — к самой сильной открытой." Yellow }
  Write-Log $i "ok"
}

Say "JET MEDIA — подготовка планшетов. Версия скрипта: 07.11.2026-2" Cyan
& $Adb start-server | Out-Null
# Ключ регистрации: спрашиваем один раз и запоминаем рядом со скриптом.
# Можно пропустить — тогда планшет появится в портале в «Новых устройствах» и его нужно добавить вручную.
$KeyFile = "$PSScriptRoot\device-key.txt"
if (-not $EnrollCode -and (Test-Path $KeyFile)) { $EnrollCode = (Get-Content $KeyFile -Raw).Trim() }
if (-not $EnrollCode -and -not $CheckOnly) {
  $EnrollCode = (Read-Host "Ключ регистрации устройств (показан в конце установки сервера). Enter — пропустить").Trim()
  if ($EnrollCode) { Set-Content $KeyFile $EnrollCode }
}
# Сети «для всех планшетов» из админки («Устройства» → «Wi-Fi для всех планшетов»): агент сохранит их сам,
# а первую (основную) скрипт подключит сразу — вводить Wi-Fi руками не нужно
$Fleet = $null
if ($EnrollCode -and -not $CheckOnly) {
  try {
    $Fleet = Invoke-RestMethod -Uri "$ServerUrl/api/device/fleet-wifi?key=$([uri]::EscapeDataString($EnrollCode))" -TimeoutSec 15 -UseBasicParsing
    if ($Fleet.nets) { Say "Сети для всех планшетов из админки: $(($Fleet.nets | ForEach-Object { $_.ssid }) -join ', ')" Green }
    else { Say "В админке нет сетей «для всех планшетов» (Устройства → Wi-Fi для всех планшетов)." Yellow }
    if ($Fleet.pin) { Say "PIN сервисного меню возьмётся из админки." Green } else { Say "PIN сервисного меню в админке не задан — будет $Pin." Yellow }
  } catch { Say "Не удалось взять сети из админки: $($_.Exception.Message)" Yellow }
}
# Wi-Fi для подключения сейчас: задан в параметрах, иначе спрашиваем; Enter — основная (или первая) сеть из админки
if (-not $WifiSsid -and -not $CheckOnly) {
  $def = $null
  if ($Fleet -and $Fleet.nets) { $def = @($Fleet.nets | Where-Object { $_.ssid -eq $Fleet.primary })[0]; if (-not $def) { $def = @($Fleet.nets)[0] } }
  $hint = if ($def) { "Enter — «$($def.ssid)» из админки" } else { 'Enter — не настраивать' }
  $WifiSsid = (Read-Host "Wi-Fi для подключения сейчас: имя сети. $hint").Trim()
  if ($WifiSsid) { $WifiPass = Read-Host "Пароль Wi-Fi «$WifiSsid» (Enter — сеть без пароля)" }
  elseif ($def) { $WifiSsid = $def.ssid; $WifiPass = $def.pass }
}
if (-not $CheckOnly) { Get-Agent }
$done = @{}; $warned = @{}
Say "Подключите планшеты по USB. Отладка по USB должна быть включена." Cyan
do {
  $devices = @(Get-Devices)
  foreach ($d in $devices) {
    if ($done[$d.Serial]) { continue }
    if ($d.State -eq 'device') { Provision $d.Serial; $done[$d.Serial] = $true }
    elseif (-not $warned[$d.Serial]) {
      Say "$($d.Serial): $($d.State) — разрешите отладку на экране планшета (галочка «Всегда разрешать»)" Yellow
      $warned[$d.Serial] = $true
    }
  }
  if ($Watch) { Start-Sleep -Seconds 3 }
  elseif (-not $devices) { Say "Планшеты не найдены." Yellow }
} while ($Watch)
