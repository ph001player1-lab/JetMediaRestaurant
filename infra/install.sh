#!/bin/bash
# Установка и обновление сервера JET MEDIA на чистом Ubuntu.
# Запуск: curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo bash
set -e
BRANCH=claude/brave-ride-0arxnd
DIR=/opt/jetmedia

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v git >/dev/null || apt-get install -y git

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone -b "$BRANCH" https://github.com/ph001player1-lab/JetMediaRestaurant "$DIR"
fi

cd "$DIR/infra"
grep -q ADMIN_PASSWORD .env 2>/dev/null || echo "ADMIN_PASSWORD=$(openssl rand -hex 6)" >> .env
grep -q DEVICE_KEY .env || echo "DEVICE_KEY=$(openssl rand -hex 8)" >> .env
docker compose up -d --force-recreate

echo
echo "Готово. Портал: https://app.jetmedia.dev"
echo "Логин: admin   Пароль: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo "Ключ регистрации устройств (для provision.cmd): $(grep DEVICE_KEY .env | cut -d= -f2)"
echo "Приложение персонала: https://app.jetmedia.dev/staff/"
