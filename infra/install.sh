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
[ -f .env ] || echo "ADMIN_PASSWORD=$(openssl rand -hex 6)" > .env
docker compose up -d --force-recreate

echo
echo "Готово. Портал: https://app.jetmedia.dev"
echo "Логин: admin   Пароль: $(cut -d= -f2 .env)"
