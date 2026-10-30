@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0provision.ps1" -CheckOnly
pause
