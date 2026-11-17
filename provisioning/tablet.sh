# JET MEDIA — настройка планшета. Этот файл provision.cmd копирует на планшет и запускает там через adb:
#   sh tablet.sh provision <серийный номер>   — настроить (агент, владелец устройства, Wi-Fi, конфиг)
#   sh tablet.sh check <серийный номер>       — только проверить, ничего не менять
# Рядом (в /data/local/tmp/jm) provision.cmd кладёт jet-agent.apk и jm.env — настройки с сервера (CFG, WIFI_SSID, WIFI_PASS).
# Итог одной строкой «модель,Android,результат» — в файл result: provision.cmd дописывает его в provision-log.csv.
MODE=$1
SERIAL=$2
D=/data/local/tmp/jm
PKG=com.jetmedia.agent
ADMIN=com.jetmedia.agent/.AdminReceiver
CFG=
KEYED=
WIFI_SSID=
WIFI_PASS=
[ -f $D/jm.env ] && . $D/jm.env

MODEL=$(getprop ro.product.model)
ANDR=$(getprop ro.build.version.release)
say() { echo "  $1"; }
result() { echo "$MODEL,$ANDR,$1" > $D/result; }
# владелец устройства: «пакет/класс» или пусто
owner() { dumpsys device_policy | grep -A4 'Device Owner' | grep -o 'ComponentInfo{[^}]*}' | head -n 1 | sed 's/^ComponentInfo{//; s/}$//'; }

echo "=== $SERIAL · $MODEL · Android $ANDR ==="
OC=$(owner)
OWN=${OC%%/*}
ACC=$(dumpsys account | grep -o 'Accounts: *[0-9]*' | head -n 1 | grep -o '[0-9]*$')
USERS=$(pm list users | grep -c 'UserInfo{')

# Чужой владелец (например, FreeKiosk): пробуем снять, FreeKiosk удаляем, чтобы не спорил с агентом за экран
if [ -n "$OWN" ] && [ "$OWN" != "$PKG" ]; then
  if [ "$MODE" = check ]; then
    say "Владелец сейчас: $OWN — provision.cmd попробует снять его сам"
  else
    say "Снимаю прежнего владельца устройства: $OWN..."
    dpm remove-active-admin "$OC" >/dev/null 2>&1
    OC=$(owner)
    OWN=${OC%%/*}
    if [ -n "$OWN" ] && [ "$OWN" != "$PKG" ]; then
      if [ "$OWN" = com.freekiosk ]; then
        say "НЕ ГОТОВ: не удалось снять FreeKiosk. В FreeKiosk: 5 раз нажмите секретную кнопку → PIN → «Remove Device Owner» (не «Exit Kiosk Mode»), затем запустите provision.cmd снова."
      else
        say "НЕ ГОТОВ: не удалось снять владельца $OWN. Снимите его в настройках того приложения или сбросьте планшет к заводским."
      fi
      result "not ready: owner $OWN"
      exit 0
    fi
    if pm list packages com.freekiosk | grep -q com.freekiosk; then
      say "Удаляю FreeKiosk..."
      pm uninstall com.freekiosk >/dev/null 2>&1
    fi
    say "Прежний владелец снят"
  fi
fi

if [ "$OWN" != "$PKG" ]; then
  if [ "${ACC:-0}" -gt 0 ]; then
    say "НЕ ГОТОВ: на планшете есть аккаунт. Сбросьте к заводским и при первой настройке не входите в Google."
    result "not ready: account"
    exit 0
  fi
  if [ "${USERS:-1}" -gt 1 ]; then
    say "НЕ ГОТОВ: на планшете несколько пользователей. Удалите лишних или сбросьте к заводским."
    result "not ready: users"
    exit 0
  fi
fi
if [ "$MODE" = check ]; then
  say "Готов к настройке"
  result "check: ready"
  exit 0
fi

if [ ! -f $D/jet-agent.apk ]; then
  say "Нет файла агента"
  result "no apk"
  exit 0
fi
say "Ставлю агент..."
OUT=$(pm install -r -g $D/jet-agent.apk 2>&1)
case "$OUT" in
  *Success*) ;;
  *) say "Ошибка установки: $OUT"; result "install failed"; exit 0 ;;
esac

if [ "$OWN" != "$PKG" ]; then
  say "Назначаю агент владельцем устройства..."
  OUT=$(dpm set-device-owner $ADMIN 2>&1)
  case "$OUT" in
    *Success*) ;;
    *)
      case "$OUT" in
        *accounts*) WHY="на планшете есть аккаунт: сброс к заводским, без входа в Google" ;;
        *users*) WHY="на планшете несколько пользователей" ;;
        *already*) WHY="владелец устройства уже назначен: нужен сброс к заводским" ;;
        *"Unknown admin"*) WHY="в APK нет компонента $ADMIN — проверьте сборку агента" ;;
        *) WHY="$OUT" ;;
      esac
      say "Ошибка: $WHY"
      result "device owner failed"
      exit 0
      ;;
  esac
fi

if [ -n "$WIFI_SSID" ]; then
  say "Подключаю Wi-Fi $WIFI_SSID..."
  if [ -n "$WIFI_PASS" ]; then
    OUT=$(cmd wifi connect-network "$WIFI_SSID" wpa2 "$WIFI_PASS" 2>&1)
  else
    OUT=$(cmd wifi connect-network "$WIFI_SSID" open 2>&1)
  fi
  case "$OUT" in
    *rror*|*nknown*) say "Wi-Fi не подключился: $OUT (подключите вручную)" ;;
  esac
else
  say "Wi-Fi не задан: планшет подключится к уже сохранённой сети, а если её нет — к самой сильной открытой."
fi
settings put global stay_on_while_plugged_in 7

# Конфиг агенту (base64 с сервера): адрес сервера, ключ, серийный номер, сети и отпечаток PIN из админки
if [ -n "$CFG" ]; then
  am start -n $PKG/.MainActivity --es config "$CFG" >/dev/null 2>&1
else
  am start -n $PKG/.MainActivity >/dev/null 2>&1
fi
say "ГОТОВО"
[ -z "$KEYED" ] && say "Ключ не указан: добавьте планшет в портале — Устройства → «Новые устройства»."
result ok
exit 0
