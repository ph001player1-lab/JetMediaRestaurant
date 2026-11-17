@echo off
rem JET MEDIA - deploy to PRODUCTION (app.jetmedia.dev) by double-click, asks for confirmation first
chcp 65001 >nul
title JET MEDIA — выкатка на РАБОЧУЮ
echo Выкатка на РАБОЧУЮ версию: app.jetmedia.dev — её видят рестораны.
echo Сначала проверьте тест. Продолжить — любая клавиша, отменить — закройте окно.
pause >nul
echo.
ssh -t ubuntu@15.235.247.188 "curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo RELEASE=1 bash"
echo.
echo Готово. Проверьте app.jetmedia.dev
pause
