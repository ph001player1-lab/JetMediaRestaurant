@echo off
rem JET MEDIA - tablet setup over USB without PowerShell: only cmd, adb and curl (built into Windows 10/11).
rem Double-click to run. check.cmd = check only.
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title JET MEDIA — подготовка планшетов
rem Что делает: берёт с сервера настройки (ключ из device-key.txt, сети и PIN из админки), скачивает свежий агент,
rem для каждого планшета копирует tablet.sh, агент и настройки в /data/local/tmp/jm и запускает tablet.sh на самом планшете.
set "VER=17.11.2026-2"
set "SERVER=https://api.jetmedia.dev"
set "AGENT_URL=https://github.com/ph001player1-lab/JetMediaRestaurant/releases/download/agent-latest/jet-agent.apk"
set "ADB=platform-tools\adb.exe"
set "R=/data/local/tmp/jm"
set "MODE=provision"
if /i "%~1"=="check" set "MODE=check"
set "TMPD=%TEMP%\jetmedia-prov"
if not exist "%TMPD%" mkdir "%TMPD%"

echo JET MEDIA — подготовка планшетов. Версия скрипта: %VER%
if "%MODE%"=="check" echo Режим проверки: на планшетах ничего не меняется.
where curl >nul 2>&1 || (echo В Windows нет curl — нужна Windows 10 или 11. & goto :end)
if not exist tablet.sh (echo Рядом нет файла tablet.sh — скачайте папку provisioning заново. & goto :end)
if not exist "%ADB%" call :getadb
if not exist "%ADB%" (echo Не удалось скачать ADB — проверьте интернет и запустите снова. & goto :end)
echo Запускаю ADB...
taskkill /f /im adb.exe >nul 2>&1
"%ADB%" start-server >nul 2>&1
if "%MODE%"=="check" goto :devices

rem Ключ регистрации: спрашиваем один раз и запоминаем в device-key.txt
set "KEY="
if exist device-key.txt set /p KEY=<device-key.txt
if defined KEY call :fetchenv check
if defined KEY if "!CODE!"=="403" (echo Ключ из device-key.txt не подходит к серверу %SERVER%. & set "KEY=")
:askkey
if defined KEY goto :keyok
echo.
echo Ключ регистрации планшетов: админка → «Администраторы» → «Ключ регистрации планшетов» → «Скопировать».
set "KEY="
set /p "KEY=Вставьте ключ и нажмите Enter. Просто Enter — без ключа: "
if not defined KEY (echo Без ключа: сети Wi-Fi и PIN из админки не возьмутся, планшет нужно будет добавить в портале. & goto :keyok)
call :fetchenv check
if "!CODE!"=="403" (echo Ключ не подходит — проверьте, что скопирован целиком. & set "KEY=" & goto :askkey)
if not "!CODE!"=="200" echo Сервер %SERVER% не отвечает — ключ сохраню, проверить не удалось.
>device-key.txt echo !KEY!
echo Ключ сохранён в device-key.txt.
:keyok
if "!CODE!"=="200" for /f "usebackq tokens=1,* delims=>" %%a in (`findstr /b /c:"#>" "%TMPD%\jm.env"`) do echo %%b

if not exist apk mkdir apk
echo Скачиваю свежий агент с GitHub...
curl -fsSL -m 180 -o "apk\jet-agent.apk.tmp" "%AGENT_URL%"
if errorlevel 1 (echo Не удалось скачать агент, беру тот, что уже лежит в папке apk. & del /q "apk\jet-agent.apk.tmp" 2>nul) else (move /y "apk\jet-agent.apk.tmp" "apk\jet-agent.apk" >nul & echo Агент скачан.)
if not exist "apk\jet-agent.apk" (echo Нет файла агента apk\jet-agent.apk — нужен интернет. & goto :end)

:devices
if not exist provision-log.csv (>provision-log.csv echo Time,Serial,Model,Android,Result)
set "DONE= "
echo.
echo Подключите планшеты по USB. Отладка по USB должна быть включена.
:loop
set "NEW=0"
for /f "skip=1 tokens=1,2" %%a in ('%ADB% devices') do call :one %%a %%b
if "!NEW!"=="0" echo Новых планшетов не видно. Подключите планшет по USB и разрешите отладку на его экране.
echo.
echo Подключите следующий планшет и нажмите любую клавишу. Закончили — просто закройте окно.
pause >nul
goto :loop

rem ---- один планшет: %1 — серийный номер, %2 — состояние из «adb devices»
:one
set "S=%~1"
set "ST=%~2"
if "%ST%"=="" exit /b
if not "!DONE: %S% =!"=="!DONE!" exit /b
set "NEW=1"
if not "%ST%"=="device" (
  echo %S%: %ST% — на экране планшета разрешите отладку: галочка «Всегда разрешать» и «Разрешить».
  exit /b
)
echo.
echo %S%: копирую файлы на планшет...
"%ADB%" -s %S% shell "rm -rf %R%; mkdir -p %R%" >nul 2>&1
"%ADB%" -s %S% push tablet.sh %R%/tablet.sh >nul 2>&1
if "%MODE%"=="provision" call :pushcfg
"%ADB%" -s %S% shell "tr -d '\r' < %R%/tablet.sh > %R%/t.sh; sh %R%/t.sh %MODE% %S%"
set "RES=нет ответа от планшета"
for /f "delims=" %%r in ('%ADB% -s %S% shell cat %R%/result 2^>nul') do set "RES=%%r"
"%ADB%" -s %S% shell "rm -rf %R%" >nul 2>&1
>>provision-log.csv echo %date% %time:~0,8%,%S%,!RES!
set "DONE=!DONE!%S% "
exit /b

rem ---- настройки с сервера и агент — на планшет
:pushcfg
call :fetchenv %S%
if not "!CODE!"=="200" (
  echo   Сервер не ответил — настраиваю без данных из админки, планшет нужно будет добавить в портале.
  type nul > "%TMPD%\jm.env"
)
"%ADB%" -s %S% push "%TMPD%\jm.env" %R%/jm.env >nul 2>&1
echo   Копирую агент...
"%ADB%" -s %S% push apk\jet-agent.apk %R%/jet-agent.apk >nul 2>&1
exit /b

rem ---- настройки для планшета с сервера: %1 — серийный номер; код ответа — в CODE (200, 403 — ключ не подходит, 000 — нет связи)
:fetchenv
set "CODE=000"
del /q "%TMPD%\jm.env" 2>nul
for /f %%c in ('curl -s -m 20 -o "%TMPD%\jm.env" -w "%%{http_code}" "%SERVER%/api/device/provision-env?key=%KEY%&serial=%~1"') do set "CODE=%%c"
exit /b

rem ---- ADB: официальный Android platform-tools в эту папку
:getadb
echo ADB не найден, скачиваю Android platform-tools...
curl -fsSL -m 300 -o "%TMPD%\platform-tools.zip" https://dl.google.com/android/repository/platform-tools-latest-windows.zip || exit /b
tar -xf "%TMPD%\platform-tools.zip" -C .
exit /b

:end
echo.
pause
