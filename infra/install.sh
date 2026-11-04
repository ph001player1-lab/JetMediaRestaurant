#!/bin/bash
# Установка и обновление сервера JET MEDIA на Ubuntu. Три режима:
#   Тестовая версия (test.jetmedia.dev) — свежий код, своя база (копия рабочей); рабочую не трогает:
#     curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo TEST=1 bash
#     (с COPY=1 — заново скопировать базу с рабочей; первый запуск копирует сам)
#   Выкатить на рабочую ровно ту версию, что проверили на тестовой (пауза несколько секунд):
#     curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo RELEASE=1 bash
#   Как раньше — рабочая сразу на свежий код (первая установка; сброс пароля — с RESET_ADMIN=1):
#     curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/claude/brave-ride-0arxnd/infra/install.sh | sudo bash
set -e
BRANCH=claude/brave-ride-0arxnd
REPO=https://github.com/ph001player1-lab/JetMediaRestaurant
DIR=/opt/jetmedia          # рабочая версия
TDIR=/opt/jetmedia-test    # тестовая версия
PROD="docker compose -p infra -f $DIR/infra/docker-compose.yml"
TESTC="docker compose -p jetmedia-test -f $TDIR/infra/docker-compose.test.yml"

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v git >/dev/null || apt-get install -y git

# Код нужной версии в папке (папка — только для запуска, своих правок в ней нет)
checkout() {
  if [ -d "$1/.git" ]; then git -C "$1" fetch -q origin "$BRANCH"; else git clone -q -b "$BRANCH" "$REPO" "$1"; fi
  git -C "$1" reset -q --hard "$2"
}
# Номер версии для портала: дата изменения и его код, например 2026.11.02-7afa695
version() {
  echo "$(git -C "$1" log -1 --format=%cd --date=format:%Y.%m.%d)-$(git -C "$1" rev-parse --short HEAD)" > "$1/server/VERSION"
}
# Caddy: новые адреса подхватываем без перезапуска; перезапуск — только если иначе не увидит файл
caddy_update() {
  if $PROD exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$DIR/infra/Caddyfile"; then
    $PROD exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  else
    $PROD up -d --no-deps --force-recreate caddy
  fi
}

# ---------- Тестовая версия
if [ "$TEST" = 1 ]; then
  [ -d "$DIR/.git" ] || { echo "Сначала установите рабочую версию (команда без TEST=1)"; exit 1; }
  checkout "$TDIR" "origin/$BRANCH"
  version "$TDIR"
  cp "$DIR/infra/.env" "$TDIR/infra/.env"
  # адрес test.jetmedia.dev → тестовая копия; файл переписываем на месте, Caddy перечитывает его без остановки
  cat "$TDIR/infra/Caddyfile" > "$DIR/infra/Caddyfile"
  if [ "$COPY" = 1 ] || ! docker volume inspect jetmedia-test_data >/dev/null 2>&1; then
    docker volume inspect infra_data >/dev/null 2>&1 || { echo "Не найдена база рабочей версии (том infra_data)"; exit 1; }
    $TESTC down 2>/dev/null || true
    docker volume create jetmedia-test_data >/dev/null
    # копия базы; если рабочая как раз записывала файл — повторяем, пока копия не прочитается целиком
    for try in 1 2 3 4 5; do
      if docker run --rm -v infra_data:/from:ro -v jetmedia-test_data:/to node:22-alpine sh -c \
        'rm -rf /to/* && cp -a /from/. /to/ && rm -f /to/reset-admin && node -e "JSON.parse(require(\"fs\").readFileSync(\"/to/db.json\"))"'; then
        echo "База тестовой версии скопирована с рабочей."; break
      fi
      [ "$try" = 5 ] && { echo "Не удалось скопировать базу — запустите ещё раз"; exit 1; }
      sleep 2
    done
  fi
  $TESTC up -d --force-recreate
  caddy_update
  echo
  echo "Тестовая версия $(cat "$TDIR/server/VERSION") запущена: https://test.jetmedia.dev"
  echo "Приложение официанта (тест): https://test.jetmedia.dev/staff/   Вход — те же логины и PIN, что в рабочей."
  echo "Выкатить её на рабочую: curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/$BRANCH/infra/install.sh | sudo RELEASE=1 bash"
  exit 0
fi

# ---------- Рабочая версия: проверенная на тестовой (RELEASE=1) или свежий код (как раньше)
if [ "$RELEASE" = 1 ]; then
  [ -d "$TDIR/.git" ] || { echo "Тестовая версия не установлена — выкатывать нечего"; exit 1; }
  TARGET=$(git -C "$TDIR" rev-parse HEAD)
else
  TARGET="origin/$BRANCH"
fi
FIRST=0
[ -d "$DIR/.git" ] || FIRST=1
checkout "$DIR" "$TARGET"
version "$DIR"

cd "$DIR/infra"
grep -q ADMIN_PASSWORD .env 2>/dev/null || echo "ADMIN_PASSWORD=$(openssl rand -hex 6)" >> .env
grep -q DEVICE_KEY .env || echo "DEVICE_KEY=$(openssl rand -hex 8)" >> .env
if [ "$FIRST" = 1 ]; then
  $PROD up -d
else
  # перезапускаем только сервер: он доводит начатые запросы и сохраняет базу; Caddy — только если изменился его файл
  $PROD up -d --no-deps --force-recreate api
  caddy_update
  $PROD up -d
fi

# Тестовая — на ту же версию, что рабочая (с RELEASE=1 она и так та же; база тестовой не меняется)
if [ -d "$TDIR/.git" ] && [ "$(git -C "$TDIR" rev-parse HEAD)" != "$(git -C "$DIR" rev-parse HEAD)" ]; then
  checkout "$TDIR" "$(git -C "$DIR" rev-parse HEAD)"
  version "$TDIR"
  cp "$DIR/infra/.env" "$TDIR/infra/.env"
  $TESTC up -d --force-recreate
  echo "Тестовая обновлена до той же версии $(cat "$TDIR/server/VERSION")."
fi

# Сброс пароля суперадмина на первый: curl … install.sh | sudo RESET_ADMIN=1 bash
if [ "$RESET_ADMIN" = 1 ]; then
  sleep 3
  $PROD exec -T api touch /data/reset-admin
  $PROD restart api
  echo "Пароль суперадмина сброшен на первый (ниже)."
fi

echo
echo "Готово. Рабочая версия $(cat "$DIR/server/VERSION"). Портал: https://app.jetmedia.dev"
[ -f "$TDIR/server/VERSION" ] && echo "Тестовая версия $(cat "$TDIR/server/VERSION"): https://test.jetmedia.dev"
echo "Вход: ph001player1@gmail.com (или admin)   Первый пароль: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo "Если пароль меняли в портале и забыли — сброс: curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/JetMediaRestaurant/$BRANCH/infra/install.sh | sudo RESET_ADMIN=1 bash"
echo "Ключ регистрации устройств (для provision.cmd): $(grep DEVICE_KEY .env | cut -d= -f2)"
echo "Приложение персонала: https://app.jetmedia.dev/staff/"
