@echo off
echo JET MEDIA: starting PowerShell... (the first start after a Windows update can take up to a minute)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0provision.ps1" %*
echo.
pause
