@echo off
rem JET MEDIA - deploy to TEST (test.jetmedia.dev) by double-click
chcp 65001 >nul
title JET MEDIA — выкатка на ТЕСТ
echo Выкатка на ТЕСТ: test.jetmedia.dev
echo Сервер спросит пароль или ключ — как обычно.
echo.
ssh -t ubuntu@15.235.247.188 "curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo TEST=1 bash"
echo.
echo Готово. Проверьте test.jetmedia.dev
pause
