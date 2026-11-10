// JET MEDIA — минимальный сервер без зависимостей (только встроенные модули Node.js).
//   /api/device/*  — планшеты: телеметрия раз в 15 с, в ответ команды
//   /guest/        — интерфейс стола (меню, вызов официанта, заказ)
//   /staff/        — приложение персонала (PWA): вызовы и заказы ресторана
//   /              — портал администратора (вход на /login)
// Данные — в DATA_DIR/db.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createVapidKeys, sendPush } from './push.mjs';
import { fetchMenu, POS_VENDORS } from './menu-sources.mjs';
import { tgApi, tgSend, tgFindChats } from './telegram.mjs';
import { THEMES, themeOf } from './themes.mjs';
import { ELEVEN_MODELS, elevenVoices, elevenUsage, cachedTts, synthesize } from './eleven.mjs';
import { eventLog, thDay, restaurantReport, networkReport, unmergeMarks, setWhySince } from './stats.mjs';
import { countRequest, selfStats, hostStats } from './sysinfo.mjs';
import { DISTRICTS, DISTRICT_IDS, OUTLINE, cleanGeo, resolveMapLink } from './geo.mjs';
import { writeZip } from './zip.mjs';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://app.jetmedia.dev';
const ONLINE_MS = 45_000;
const OFFLINE_ALERT_MS = 5 * 60_000; // столько минут без связи — пишем администратору в Telegram (короткие обрывы — в сводке за день)
const KEEP_MS = 7 * 24 * 3600_000;
// Напоминания, пока никто не нажал «Иду» / «Подтвердить»: первые 5 — каждые 45 секунд, дальше — каждые 2 минуты,
// пока вызов не приняли или не сняли как забытый; заказ — не дольше 30 минут
const REMIND_MS = 45_000, REMIND_SLOW_MS = 120_000, FAST_REMINDERS = 5, ORDER_REMIND_MAX_MS = 30 * 60_000;
const COMMANDS = ['url', 'reload', 'reboot', 'update', 'say', 'scan'];
const STATIC = {
  '/': 'portal.html',
  '/guest/': 'guest.html',
  '/staff/': 'staff.html',
  '/kitchen/': 'kitchen.html',
  '/staff/manifest.json': 'manifest.json',
  '/staff/sw.js': 'sw.js',
  // Иконка приложения персонала (звонок вызова): Android, iPhone, вкладка браузера
  '/staff/icon.svg': 'icons/staff.svg',
  '/staff/icon-192.png': 'icons/staff-192.png',
  '/staff/icon-512.png': 'icons/staff-512.png',
  '/staff/apple-touch-icon.png': 'icons/staff-apple-180.png',
  '/login': 'login.html',
  '/favicon.ico': 'favicon.svg',
  '/favicon.svg': 'favicon.svg',
  '/vendor/qrcode.js': 'vendor/qrcode.js',
  '/vendor/stats.js': 'vendor/stats.js',
  '/vendor/arrows.js': 'vendor/arrows.js',
  '/vendor/floor.js': 'vendor/floor.js',
  '/vendor/menucats.js': 'vendor/menucats.js',
  // слайды инструкции установки приложения (ЛК → Персонал)
  '/staff/install/samsung-1.jpg': 'assets/install/samsung-1.jpg',
  '/staff/install/samsung-2.jpg': 'assets/install/samsung-2.jpg',
  '/staff/install/samsung-3.jpg': 'assets/install/samsung-3.jpg',
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' };
const FILES = Object.fromEntries(Object.values(STATIC).map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url))]));
// Версия интерфейса: открытые страницы стола и персонала сами перезагружаются, когда она меняется
const BUILD = crypto.createHash('sha1').update(Buffer.concat(Object.values(FILES))).digest('hex').slice(0, 10);

// ---------- Рабочая и тестовая версии. Тестовая — отдельная копия на test.jetmedia.dev со своей базой (копией рабочей):
// не пишет в Telegram и не шлёт уведомления официантам рабочего приложения. Планшет переключают в портале рабочей версии
const INSTANCE = process.env.INSTANCE === 'test' ? 'test' : 'prod';
// Номер версии: дата и код изменения (файл VERSION пишет установщик), иначе — отпечаток файлов
const VERSION = (() => {
  try { return fs.readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim() || BUILD; } catch { return BUILD; }
})();
const TEST_URL = process.env.TEST_URL || 'https://test.jetmedia.dev';
const TEST_API = process.env.TEST_API || 'http://api-test:3000';
let testVersion = { at: 0, v: null };
async function getTestVersion() {
  if (Date.now() - testVersion.at < 60_000) return testVersion.v;
  try {
    const j = await (await fetch(`${TEST_API}/api/version`, { signal: AbortSignal.timeout(3000) })).json();
    testVersion = { at: Date.now(), v: j.version || null };
  } catch { testVersion = { at: Date.now(), v: null }; }
  return testVersion.v;
}
// Тестовая копия узнаёт планшет у рабочей: если его нет в копии базы (добавили или переставили после копирования) —
// берёт привязку к ресторану и столу по внутренней сети; заодно раз в 10 минут сверяет её
const PROD_API = process.env.PROD_API || 'http://api:3000';
const pulled = new Map();
async function pullDevice(id) {
  if (INSTANCE !== 'test' || !process.env.DEVICE_KEY || !id) return;
  const d0 = db.devices[id], known = d0 && db.restaurants[d0.restaurantId] && (d0.table || d0.role === 'entrance');
  if (Date.now() - (pulled.get(id) || 0) < (known ? 600_000 : 30_000)) return;
  pulled.set(id, Date.now());
  try {
    const j = await (await fetch(`${PROD_API}/api/internal/device?d=${encodeURIComponent(id)}&key=${encodeURIComponent(process.env.DEVICE_KEY)}`,
      { signal: AbortSignal.timeout(4000) })).json();
    if (!j.device) return;
    if (j.restaurant && !db.restaurants[j.restaurant.id]) db.restaurants[j.restaurant.id] = j.restaurant;
    const tr = db.restaurants[j.device.restaurantId];
    if (tr && j.device.table && !(tr.tables || []).includes(j.device.table)) tr.tables = [...(tr.tables || []), j.device.table];
    db.devices[id] = { ...(d0 || {}), ...j.device, queue: d0?.queue || [] };
    save();
  } catch { /* рабочая недоступна — работаем с тем, что есть */ }
}
// Тестовая копия: планшеты шлют сигнал «на связи» только рабочей — статус, заряд, привязку берём оттуда (раз в 10 с)
let devicesPulled = 0;
async function pullAllDevices() {
  if (INSTANCE !== 'test' || !process.env.DEVICE_KEY || Date.now() - devicesPulled < 10_000) return;
  devicesPulled = Date.now();
  const key = encodeURIComponent(process.env.DEVICE_KEY);
  const merge = (d) => { if (d?.id) db.devices[d.id] = { ...(db.devices[d.id] || {}), ...d, queue: db.devices[d.id]?.queue || [] }; };
  try {
    const j = await (await fetch(`${PROD_API}/api/internal/devices?key=${key}`, { signal: AbortSignal.timeout(4000) })).json().catch(() => ({}));
    if (Array.isArray(j.devices)) { j.devices.forEach(merge); return; }
    // рабочая версия старше тестовой и списка ещё не умеет — спрашиваем каждый планшет отдельно (это она умеет)
    await Promise.all(Object.keys(db.devices).map(async (id) => {
      try {
        const x = await (await fetch(`${PROD_API}/api/internal/device?d=${encodeURIComponent(id)}&key=${key}`, { signal: AbortSignal.timeout(4000) })).json();
        merge(x.device);
      } catch { /* этот планшет — в следующий раз */ }
    }));
  } catch { /* рабочая недоступна */ }
}
// Пользовательские настройки (что задают админы и менеджеры) — с рабочей на тестовую, по кнопке в тестовом портале.
// Рестораны целиком (меню, акции, персонал, столы, дизайн, схема зала…), реклама, ИИ-персонажи, админы, цены, Wi-Fi, PIN.
// Заказы, вызовы, статистика, входы и уведомления тестовой остаются свои
const SETTINGS_KEYS = ['restaurants', 'ads', 'characters', 'admins', 'pricing', 'fleetWifi', 'allowOpenWifi', 'servicePin', 'fxCustom', 'eleven'];
const SETTINGS_BACKUP = path.join(DATA_DIR, 'before-settings-copy.json');
function internalSettings(b, q, req) {
  if (INSTANCE !== 'prod' || !process.env.DEVICE_KEY || q.key !== process.env.DEVICE_KEY || req.headers['x-forwarded-for']) throw fail(403, 'forbidden');
  return { settings: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, db[k]])) };
}
async function copySettingsFromProd(who) {
  if (INSTANCE !== 'test') throw fail(400, 'Перенос настроек — только на тестовой версии');
  if (!process.env.DEVICE_KEY) throw fail(400, 'Нет ключа устройств — тестовая не связана с рабочей');
  let j;
  try {
    j = await (await fetch(`${PROD_API}/api/internal/settings?key=${encodeURIComponent(process.env.DEVICE_KEY)}`, { signal: AbortSignal.timeout(15000) })).json();
  } catch { throw fail(502, 'Рабочая версия не отвечает'); }
  const src = j?.settings;
  if (!src?.restaurants) throw fail(502, 'Рабочая версия ещё не умеет отдавать настройки — сначала выкатите на неё эту версию (RELEASE)');
  // как было на тестовой — чтобы можно было вернуть
  fs.writeFileSync(SETTINGS_BACKUP, JSON.stringify({ at: Date.now(), who, data: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, db[k]])) }));
  for (const k of SETTINGS_KEYS) if (k !== 'restaurants' && src[k] !== undefined) db[k] = structuredClone(src[k]);
  // рестораны: с рабочей — целиком; свои отметки тестовой (тестовые визиты, удалённые заказы, ссылка экрана кухни) — остаются;
  // рестораны, которые есть только на тестовой, не трогаем
  for (const [id, pr] of Object.entries(src.restaurants)) {
    const old = db.restaurants[id], r = structuredClone(pr);
    if (old) {
      for (const k of ['testIds', 'testBefore', 'removedIds']) if (old[k] !== undefined) r[k] = old[k]; else delete r[k];
      if (old.flow?.kitchenKey && r.flow) r.flow.kitchenKey = old.flow.kitchenKey;
    }
    db.restaurants[id] = r;
    hoursCache.delete(id);
  }
  save();
  // картинки и голос, загруженные на рабочей после копирования базы, — докачиваем
  const need = [...new Set(JSON.stringify(src).match(/\/uploads\/[a-f0-9]+\.(jpg|png|webp|svg|mp3|ogg|wav)/g) || [])]
    .map((u) => u.slice(9)).filter((f) => !fs.existsSync(path.join(UPLOADS, f)));
  let got = 0;
  fs.mkdirSync(UPLOADS, { recursive: true });
  for (let i = 0; i < need.length; i += 6) {
    await Promise.all(need.slice(i, i + 6).map(async (f) => {
      try {
        const res = await fetch(`${PROD_API}/uploads/${f}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return;
        fs.writeFileSync(path.join(UPLOADS, f), Buffer.from(await res.arrayBuffer()));
        got++;
      } catch { /* эта картинка — без неё */ }
    }));
  }
  const n = Object.keys(src.restaurants).length;
  audit(who, `Настройки перенесены с рабочей: ресторанов ${n}, картинок докачано ${got}`);
  return { restaurants: n, files: got, missing: need.length - got };
}
function restoreSettings(who) {
  if (INSTANCE !== 'test') throw fail(400, 'Только на тестовой версии');
  let bk;
  try { bk = JSON.parse(fs.readFileSync(SETTINGS_BACKUP, 'utf8')); } catch { throw fail(404, 'Нечего возвращать — переноса ещё не было'); }
  for (const k of SETTINGS_KEYS) if (bk.data[k] !== undefined) db[k] = bk.data[k]; else delete db[k];
  for (const id of Object.keys(db.restaurants)) hoursCache.delete(id);
  save();
  fs.rmSync(SETTINGS_BACKUP, { force: true });
  audit(who, 'Настройки тестовой возвращены как были до переноса с рабочей');
  return {};
}
const settingsBackupAt = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_BACKUP, 'utf8')).at || 0; } catch { return 0; } };
function internalDevices(b, q, req) {
  if (INSTANCE !== 'prod' || !process.env.DEVICE_KEY || q.key !== process.env.DEVICE_KEY || req.headers['x-forwarded-for']) throw fail(403, 'forbidden');
  return { devices: Object.values(db.devices).map(({ queue, ...d }) => d) };
}

// Для тестовой копии: привязка планшета (только из внутренней сети, не через интернет)
function internalDevice(b, q, req) {
  if (INSTANCE !== 'prod' || !process.env.DEVICE_KEY || q.key !== process.env.DEVICE_KEY || req.headers['x-forwarded-for']) throw fail(403, 'forbidden');
  const d = db.devices[q.d];
  if (!d) throw fail(404, 'no device');
  const { queue, ...device } = d;
  return { device, restaurant: db.restaurants[d.restaurantId] || null };
}
// Раздел «Сервер» в портале: показатели своей версии; вторую (рабочая ↔ тестовая) спрашиваем по внутренней сети
function instanceStats() {
  const devs = Object.values(db.devices);
  return {
    instance: INSTANCE, version: VERSION, ...selfStats(DATA_DIR),
    devices: { total: devs.length, online: devs.filter((d) => Date.now() - (d.lastSeen || 0) < ONLINE_MS).length },
  };
}
function internalServer(b, q, req) {
  if (!process.env.DEVICE_KEY || q.key !== process.env.DEVICE_KEY || req.headers['x-forwarded-for']) throw fail(403, 'forbidden');
  return { self: instanceStats() };
}
async function serverPanel() {
  let peer = null;
  if (process.env.DEVICE_KEY) {
    try {
      const j = await (await fetch(`${INSTANCE === 'prod' ? TEST_API : PROD_API}/api/internal/server?key=${encodeURIComponent(process.env.DEVICE_KEY)}`,
        { signal: AbortSignal.timeout(3000) })).json();
      peer = j.self || null;
    } catch { /* вторая версия не отвечает или ещё не умеет */ }
  }
  const me = instanceStats();
  return {
    at: Date.now(), here: INSTANCE, host: hostStats(DATA_DIR), telegram: db.tgBots.some((x) => x.token && x.chats?.length), pinAt: db.servicePin?.at || 0,
    prod: INSTANCE === 'prod' ? me : peer, test: INSTANCE === 'test' ? me : peer,
  };
}

// Перед переводом на тест — тестовая должна отвечать, иначе планшет показал бы ошибку
async function testAlive() {
  testVersion.at = 0;
  if (!(await getTestVersion())) throw fail(502, 'Тестовая версия не отвечает — планшеты не переключены');
}

// Страница планшета: рабочая или тестовая версия — по выбору в портале
const guestUrl = (d) => `${d.channel === 'test' ? TEST_URL : PUBLIC_URL}/guest/?d=${encodeURIComponent(d.id)}`;
const UPLOADS = path.join(DATA_DIR, 'uploads');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Что можно хранить в uploads: фото, картинки персонажей (в т. ч. SVG) и звук
const FILE_TYPES = { ...IMAGE_TYPES, 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
const MIME = Object.fromEntries(Object.entries(FILE_TYPES).map(([m, e]) => [e, m]));
const MAX_BODY = 25 * 1024 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;
// Показ акций и рекламы на планшете: задержка простоя, длительность слайда, шрифты и цвета подписи
const DISPLAY = {
  idleSec: 60, slideSec: 7, titleSize: 38, textSize: 22, textColor: '#ffffff', bgColor: '#000000',
  adEvery: 2, // реклама после каждых N слайдов ресторана (1 — каждый второй слайд)
  // смена слайдов: направление (ltr — слева направо, rtl — справа налево, ttb — сверху вниз, btt — снизу вверх) и длительность, мс
  slideFx: 'ltr', slideMs: 600,
  theme: 'classic', // цветовая тема планшета (themes.mjs), выбирается во вкладке «Дизайн»
  arrows: 'circle', arrowSize: 100, // вид стрелок карусели (vendor/arrows.js) и их размер, %
  // вид меню на планшетах и телефонах гостей: classic — как раньше (разделы строкой сверху), tiles — плитки разделов
  // слева + карточки, catalog — сетка разделов + блюда списком
  menuView: 'classic',
};
const DISPLAY_RANGE = { idleSec: [10, 600], slideSec: [3, 60], titleSize: [16, 80], textSize: [12, 48], adEvery: [1, 10], slideMs: [200, 3000], arrowSize: [50, 200] };
const ARROWS = ['circle', 'square', 'light', 'outline', 'chevron', 'accent', 'glass', 'tab', 'triangle', 'line', 'none'];
// Типы рекламы: рекламодателю — один тип; ресторан может не показывать у себя целые типы (каннабис — по умолчанию нет)
const AD_CATS = {
  bikes: 'Аренда байков и авто', tours: 'Экскурсии и туры по островам', boats: 'Яхты, катера, рыбалка', diving: 'Дайвинг и снорклинг',
  spa: 'Спа и массаж', beauty: 'Красота и салоны', medical: 'Медицина и стоматология', fitness: 'Фитнес, муай-тай, йога',
  hotels: 'Отели и виллы', realty: 'Недвижимость', food: 'Рестораны, кафе и бары', night: 'Ночная жизнь и шоу',
  events: 'Мероприятия и вечеринки', shopping: 'Шопинг и рынки', transfer: 'Трансфер и такси', finance: 'Обмен валют и финансы',
  courses: 'Курсы', kids: 'Детские развлечения и аквапарки', cannabis: 'Каннабис (18+)', other: 'Другое',
};
const blockedCats = (r) => r.blockedCats ?? ['cannabis'];
// Где показывать рекламу: ничего не выбрано — во всех ресторанах; иначе — выбранные рестораны и все рестораны выбранных районов
// (новый ресторан в выбранном районе попадает в показ сам)
const adReaches = (a, r) => (!a.restaurants?.length && !a.districts?.length)
  || (a.restaurants || []).includes(r.id) || (!!r.district && (a.districts || []).includes(r.district));
// ИИ-персонаж: как часто появляется в карусели, сколько держится, приветствия и подбор блюд по пожеланиям
// lines — фразы ресторана для каждого персонажа: { [id персонажа]: { greetings, recommend, dayDish } };
// пустой список — говорит фразы из пакета персонажа
const AVATAR = { enabled: false, characterId: '', speak: true, everyMin: 3, durationSec: 20, startWith: true, lines: {}, filters: [] };
// Сколько вариантов фраз каждого вида может завести ресторан
const MAX_LINES = 200;
// Отметки блюд для подбора по особым пожеланиям
// Где на слайде блок с QR-кодом и телефоном (4 ряда × 3 столбца) и какого он размера
const QR_POS = ['top', 'upper', 'lower', 'bottom'].flatMap((row) => ['left', 'center', 'right'].map((col) => `${row}-${col}`));
const QR_SIZE = ['s', 'm', 'l'];
const qrPlace = (x) => {
  const pos = String(x.qrPos || '').replace('middle', 'upper'); // старые «по центру слева/справа»
  return { qrPos: QR_POS.includes(pos) ? pos : 'top-right', qrSize: QR_SIZE.includes(x.qrSize) ? x.qrSize : 'm' };
};
// Кадр картинки слайда: заполнить экран или показать целиком, сдвиг по вертикали (% высоты) и масштаб (%)
const framing = (x) => ({
  fit: x.fit === 'contain' ? 'contain' : 'cover',
  imgY: Math.min(50, Math.max(-50, Math.round(Number(x.imgY)) || 0)),
  imgScale: Math.min(200, Math.max(50, Math.round(Number(x.imgScale)) || 100)),
});
const DISH_TAGS = ['vegan', 'vegetarian', 'gluten_free', 'lactose_free', 'nut_free', 'seafood_free', 'spicy', 'mild', 'kids', 'halal'];
// Блюдо на планшетах: не скрыто менеджером (⦸) и есть в наличии в источнике меню
const onMenu = (i) => !i.hidden && !i.off;
// Отметки ресторана: встроенные и свои (ЛК → «Особые пожелания»; появляются и сами из источника меню)
const tagKeys = (r) => [...DISH_TAGS, ...(r.customTags || []).map((x) => x.key)];
// Строка заказа: блюдо, вариант и выбранное в группах — разные выборы одного блюда — разные строки
const lineKey = (i) => `${i.id}|${i.opt || ''}|${(i.mods || []).join(',')}`;

let db = { devices: {}, restaurants: {}, calls: [], orders: [], sessions: {}, vapid: null, ads: [], stats: {}, characters: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  // первая версия сервера хранила только devices.json
  try { db.devices = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'devices.json'), 'utf8')); } catch {}
}
db.sessions ??= {};
db.ads ??= [];
db.characters ??= [];
db.tableKeys ??= {}; // ключи визитов столов для заказа с телефонов гостей
db.pending ??= {};
db.stats ??= {};
db.telegram ??= { token: '', bot: '', chats: [] };
db.eleven ??= { key: '', model: 'eleven_v3' };
db.vapid ??= createVapidKeys();

let saveTimer;
function writeDb() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const cutoff = Date.now() - KEEP_MS;
  db.calls = db.calls.filter((x) => !x.closed || x.closed > cutoff);
  db.orders = db.orders.filter((x) => !x.closed || x.closed > cutoff);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // сначала во временный файл, потом подмена — при сбое посреди записи база не испортится
  fs.writeFileSync(`${DB_FILE}.tmp`, JSON.stringify(db));
  fs.renameSync(`${DB_FILE}.tmp`, DB_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDb, 1000);
}

const uid = () => crypto.randomBytes(6).toString('hex');
const day = thDay; // дни считаем по тайскому времени
// Журнал событий для статистики и счётчики по дням
const events = eventLog(path.join(DATA_DIR, 'events'));
// capture — события текущего действия официанта: при «Отменить» статистика их не учитывает
let capture = null;
const logEvent = (rid, k, data = {}) => {
  const e = { t: Date.now(), r: rid, k, ...data };
  if (capture) capture.push({ k, id: e.id, t: e.t });
  return events.add(e);
};
const bump = (key, n = 1) => { db.stats[key] = (db.stats[key] || 0) + n; };
const fail = (status, message) => Object.assign(new Error(message), { status });
// ---------- Администраторы портала: вход по почте и паролю, роли, журнал изменений
//   super  — всё, включая список админов;  admin — всё, кроме админов (или только свои рестораны, если список задан);
//   доступ админа к каждому разделу — нет / чтение / редактирование (ADMIN_SECTIONS)
const SUPER_EMAIL = (process.env.SUPERADMIN_EMAIL || 'ph001player1@gmail.com').toLowerCase();
const ROLES = ['super', 'admin'];
const hashPass = (pass, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pass), salt, 32).toString('hex') });
const passOk = (a, pass) => !!a?.hash && crypto.timingSafeEqual(Buffer.from(a.hash, 'hex'), crypto.scryptSync(String(pass ?? ''), a.salt, 32));
const ADMIN_SESSION_MS = 30 * 864e5;
db.admins ??= [];
db.adminSessions ??= {};
// Первый запуск: суперадмин с паролем из ADMIN_PASSWORD (дальше пароль меняется в портале)
if (!db.admins.length) db.admins.push({ id: uid(), email: SUPER_EMAIL, name: 'Суперадмин', role: 'super', restaurants: [], ...hashPass(PASS), at: Date.now() });
for (const [k, s] of Object.entries(db.adminSessions)) if (Date.now() - s.at > ADMIN_SESSION_MS) delete db.adminSessions[k];

const cookieToken = (req) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('jm_admin='))?.slice(9) || '';
function currentAdmin(req) {
  const s = db.adminSessions[cookieToken(req)];
  return s && Date.now() - s.at < ADMIN_SESSION_MS ? db.admins.find((a) => a.id === s.adminId && !a.disabled) || null : null;
}
const publicAdmin = ({ hash, salt, ...a }) => a;
const scopeOf = (a) => (a.role !== 'super' && a.restaurants?.length ? new Set(a.restaurants) : null);
// Разделы админки. Суперадмин назначает каждому админу доступ к каждому разделу: нет / чтение / редактирование.
// «Администраторы» — только суперадмин. Админу отдельных ресторанов доступны только устройства, рестораны,
// статистика и клиенты (и только своих ресторанов)
const ADMIN_SECTIONS = [
  ['devices', 'Устройства', /^\/api\/(devices|pending)(\/|$)/],
  ['rest', 'Рестораны и меню', /^\/api\/(restaurants|geo\/resolve)(\/|$)/],
  ['ads', 'Реклама', /^\/api\/(ads|ad-cats|leads|uploads|export)(\/|$)/],
  ['chars', 'ИИ-персонажи', /^\/api\/(characters|voices|eleven)(\/|$)/],
  ['stats', 'Статистика', /^\/api\/stats$/],
  ['audit', 'Журнал', /^\/api\/audit$/],
  ['crm', 'Клиенты', /^\/api\/crm(\/|$)/],
  ['expenses', 'Расходы', /^\/api\/expenses(\/|$)/],
  ['telegram', 'Telegram', /^\/api\/telegram(\/|$)/],
  ['server', 'Сервер', /^\/api\/server$/],
  ['join', 'Заявки на подключение', /^\/api\/join-requests(\/|$)/],
];
const SECTION_NAME = Object.fromEntries(ADMIN_SECTIONS.map(([k, n]) => [k, n]));
const VIEW_ONLY = new Set(['stats', 'audit', 'server']); // там нечего менять — доступ «есть / нет»
const SCOPED_OK = new Set(['devices', 'rest', 'stats', 'crm']);
const PERM_NAME = { none: 'нет', read: 'чтение', edit: 'редактирование' };
function permOf(a, sec) {
  if (!a) return 'none';
  if (a.role === 'super') return 'edit';
  if (scopeOf(a) && !SCOPED_OK.has(sec)) return 'none';
  return ['read', 'edit'].includes(a.perms?.[sec]) ? a.perms[sec] : 'none';
}
const sectionOf = (p) => ADMIN_SECTIONS.find(([, , re]) => re.test(p))?.[0] || null;
const anyAccess = (a) => ADMIN_SECTIONS.some(([k]) => permOf(a, k) !== 'none');
const canEdit = (a, ...secs) => secs.some((k) => permOf(a, k) === 'edit');
function cleanPerms(b) {
  return Object.fromEntries(ADMIN_SECTIONS.map(([k]) => [k, ['read', 'edit'].includes(b?.[k]) ? (VIEW_ONLY.has(k) ? 'read' : b[k]) : 'none']));
}
function allowed(a, method, p) {
  if (p.startsWith('/api/me')) return true;
  if (a.role === 'super') return true;
  if (p.startsWith('/api/admins')) return false;
  // общие справочники — кратко, всем, у кого есть хоть какой-то доступ: список ресторанов и схема острова
  if (method === 'GET' && (p === '/api/restaurants' || p === '/api/geo')) return anyAccess(a);
  if (p === '/api/export/link') return permOf(a, 'ads') !== 'none'; // ссылка на ZIP фото — это просмотр
  const sec = sectionOf(p);
  const pm = sec ? permOf(a, sec) : 'none';
  return pm === 'edit' || (pm === 'read' && method === 'GET');
}
function denyText(a, method, p) {
  const sec = sectionOf(p);
  if (sec && permOf(a, sec) === 'read' && method !== 'GET') return `Только просмотр раздела «${SECTION_NAME[sec]}» — изменения недоступны`;
  return sec ? `Нет доступа к разделу «${SECTION_NAME[sec]}»` : 'Нет доступа';
}
// Однократно: прежние роли → доступы по разделам (админ — всё на редактирование, CRM — если была галочка; «только статистика» — статистика)
db.migrations ??= {};
if (!db.migrations.perms) {
  for (const a of db.admins || []) {
    if (a.role === 'super' || a.perms) continue;
    const all = Object.fromEntries(ADMIN_SECTIONS.map(([k]) => [k, a.role === 'admin' ? (VIEW_ONLY.has(k) ? 'read' : 'edit') : 'none']));
    if (a.role === 'admin' && !a.crm) all.crm = 'none';
    if (a.role === 'viewer') all.stats = 'read';
    Object.assign(a, { role: 'admin', perms: all });
    delete a.crm;
  }
  db.migrations.perms = Date.now();
}
// Однократно: Telegram был частью «Устройств» — такой же доступ; «Расходы» — пока ни у кого из админов
if (!db.migrations.perms2) {
  for (const a of db.admins || []) if (a.perms) { a.perms.telegram ??= a.perms.devices || 'none'; a.perms.expenses ??= 'none'; }
  db.migrations.perms2 = Date.now();
}

// Журнал изменений: кто, когда, что (админы портала и менеджеры ресторанов)
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
function audit(who, action, r) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ t: Date.now(), who, action, r: r || undefined })}\n`);
}
function readAudit(q, scope) {
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean); } catch {}
  const text = String(q.q || '').toLowerCase();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < Math.min(Number(q.limit) || 300, 2000); i--) {
    try {
      const e = JSON.parse(lines[i]);
      if ((q.r && e.r !== q.r) || (scope && !scope.has(e.r))) continue;
      if (text && !`${e.who} ${e.action} ${db.restaurants[e.r]?.name || ''}`.toLowerCase().includes(text)) continue;
      out.push({ ...e, rest: db.restaurants[e.r]?.name || '' });
    } catch {}
  }
  return out;
}
// Сброс пароля суперадмина на первый (ADMIN_PASSWORD из .env): файл DATA_DIR/reset-admin создаёт install.sh с RESET_ADMIN=1
const RESET_FILE = path.join(DATA_DIR, 'reset-admin');
if (fs.existsSync(RESET_FILE)) {
  let a = db.admins.find((x) => x.email === SUPER_EMAIL);
  if (!a) db.admins.push((a = { id: uid(), email: SUPER_EMAIL, name: 'Суперадмин', at: Date.now() }));
  Object.assign(a, { role: 'super', disabled: false, restaurants: [] }, hashPass(PASS));
  fs.unlinkSync(RESET_FILE);
  save();
  audit('сервер', `Пароль суперадмина ${SUPER_EMAIL} сброшен на первый`);
}

// Описание действия админа для журнала (секреты — ключи, пароли, токены — не пишем)
function auditText(method, p, b) {
  let m;
  const dev = (x) => decodeURIComponent(x);
  if (p === '/api/restaurants') return [`Ресторан сохранён: ${b.name || ''}`, b.id];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)\/sync$/))) return [b.once ? 'Меню загружено из источника один раз, дальше — вручную' : 'Синхронизация меню', m[1]];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)\/test-visit$/))) return [`Статистика: ${b.test ? 'помечено тестовым' : 'снова учитывается'} — ${visitLabel(b.label) || 'визит'}`, m[1]];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)$/))) return [`Ресторан удалён: ${m[1]}`, m[1]];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/command$/))) return [`Команда «${b.type}» устройству ${dev(m[1])}`, db.devices[dev(m[1])]?.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/wifi$/))) return [`Wi-Fi устройства ${dev(m[1])}: ${(b.list || []).map((n) => n.ssid + (n.primary ? ' (основная)' : '')).join(', ') || 'своих сетей нет'}`, db.devices[dev(m[1])]?.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/assign$/))) return [`Устройство ${dev(m[1])} → ${db.restaurants[b.restaurantId]?.name || 'не привязано'}${b.table ? ` · ${b.table}` : ''}`, b.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/_][^/]*)$/))) return [`Устройство удалено: ${dev(m[1])}`]; // _wifi, _channel — настройки, не устройства
  if (p === '/api/uploads/replace') return ['Картинка пережата и заменена'];
  if (p === '/api/export/link') return ['Создана ссылка на 48 ч: все фото акций и рекламы (ZIP)'];
  if (p === '/api/crm/clients') return [`CRM: клиент сохранён — ${b.name || db.restaurants[b.rid]?.name || ''}`, b.rid || undefined];
  if (p === '/api/crm/pricing') return ['CRM: прайс изменён'];
  if ((m = p.match(/^\/api\/crm\/clients\/([^/]+)(\/paid|\/unpay)?$/))) {
    const c = db.clients.find((x) => x.id === m[1]);
    return [`CRM: ${c?.name || m[1]} — ${m[2] === '/paid' ? `оплата${b.amount !== undefined ? ` ${b.amount} ฿` : ''}` : m[2] === '/unpay' ? 'оплата отменена' : 'клиент удалён'}`, c?.rid || undefined];
  }
  if ((m = p.match(/^\/api\/join-requests\/([^/]+)$/))) {
    const jr = db.joinReqs.find((x) => x.id === m[1]);
    return [`Заявка на подключение ${jr ? `${jr.name || ''} ${jr.phone}` : m[1]}: ${b.done === undefined ? 'удалена' : b.done ? 'обработана' : 'снова новая'}`];
  }
  if (p === '/api/devices/_wifi' && b.fleet !== undefined) return [`Wi-Fi для всех планшетов: ${(b.fleet || []).map((n) => n.ssid + (n.primary ? ' (основная)' : '')).join(', ') || 'сетей нет'}`];
  if (p === '/api/devices/_wifi') return [`Планшеты: чужие открытые Wi-Fi при потере связи — ${b.allowOpen ? 'разрешены' : 'запрещены'}`];
  if (p === '/api/devices/_channel') return [`${b.channel === 'test' ? 'На тестовую версию' : 'На рабочую версию'}: ${b.restaurantId ? db.restaurants[b.restaurantId]?.name || '' : 'вся сеть'}`, b.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/channel$/))) return [`Устройство ${dev(m[1])} → ${b.channel === 'test' ? 'тестовая' : 'рабочая'} версия`, db.devices[dev(m[1])]?.restaurantId];
  if ((m = p.match(/^\/api\/pending\/([^/]+)\/approve$/))) return [`Новое устройство добавлено: ${dev(m[1])}`];
  if ((m = p.match(/^\/api\/pending\/([^/]+)$/))) return [`Новое устройство скрыто: ${dev(m[1])}`];
  if (p === '/api/ads') return [`Реклама сохранена: ${b.advertiser || ''}${b.title ? ` — ${b.title}` : ''}`];
  if ((m = p.match(/^\/api\/ads\/([^/]+)\/tg/))) return [`Реклама ${db.ads.find((a) => a.id === m[1])?.advertiser || m[1]}: бот для заявок — ${p.split('/').pop()}`];
  if ((m = p.match(/^\/api\/ads\/([^/]+)$/))) return [`Реклама удалена: ${db.ads.find((a) => a.id === m[1])?.advertiser || m[1]}`];
  if (p === '/api/characters') return [`Персонаж загружен: ${b.id || ''}`];
  if ((m = p.match(/^\/api\/characters\/([^/]+)\/voice$/))) return [`Голос персонажа ${m[1]} изменён`];
  if ((m = p.match(/^\/api\/characters\/([^/]+)\/access$/))) {
    return [`Персонаж ${m[1]} доступен: ${(b.restaurants || []).map((id) => db.restaurants[id]?.name || id).join(', ') || 'никому'}`];
  }
  if ((m = p.match(/^\/api\/characters\/([^/]+)$/))) return [`Персонаж удалён: ${m[1]}`];
  if (p === '/api/eleven') return [b.key ? 'ElevenLabs: ключ изменён' : 'ElevenLabs: настройки изменены'];
  if (p === '/api/eleven/preview') return null;
  if (p === '/api/geo/resolve') return null;
  if (p.startsWith('/api/telegram')) {
    const bt = db.tgBots.find((x) => p.includes(`/${x.id}`)) || db.tgBots.find((x) => x.id === b.id);
    const what = method === 'DELETE' ? 'удалён' : p.endsWith('/find') ? 'поиск чатов' : p.endsWith('/test') ? 'тест' : p.endsWith('/remove') ? 'получатель удалён'
      : `сохранён (приходит: ${(b.kinds || []).map((k) => TG_KIND_NAME[k]).filter(Boolean).join(', ') || 'ничего'})`;
    return [`Telegram: бот «${b.name || bt?.name || bt?.bot || ''}» — ${what}`];
  }
  if (p.startsWith('/api/expenses')) {
    const e = db.expenses.find((x) => p.includes(`/${x.id}`));
    if (p === '/api/expenses/fx') return [`Расходы: свой курс — ${Object.entries(b || {}).map(([c, v]) => `${c} ${v || 'авто'}`).join(', ')}`];
    return [`Расходы: ${e?.name || b.name || ''} — ${method === 'DELETE' ? 'удалён' : p.endsWith('/paid') ? 'оплачено' : p.endsWith('/unpay') ? 'оплата отменена' : 'сохранён'}`];
  }
  return [`${method} ${p}`];
}

// Администраторы: список, добавление и изменение (почта, имя, роль, рестораны, пароль, отключение), удаление
// PIN сервисного меню планшетов (7 быстрых касаний в углу). Хранится и уходит планшетам только как sha256(соль + PIN):
// агент сверяет введённый PIN у себя, без сети тоже. Пока PIN не меняли — действует заданный при подготовке (1234)
function pinStatus() {
  const sp = db.servicePin, ver = sp?.hash.slice(0, 8);
  const devs = Object.values(db.devices).filter((d) => d.restaurantId || d.telemetry?.version);
  return {
    changedAt: sp?.at || 0, by: sp?.by || '', instance: INSTANCE,
    devices: devs.length,
    got: ver ? devs.filter((d) => d.telemetry?.pin === ver).length : 0,
    // агент старше 0.1.12 не умеет получать PIN с сервера
    oldAgent: devs.filter((d) => !('pin' in (d.telemetry || {}))).map((d) => deviceName(d)),
  };
}
function servicePinApi(method, b, me) {
  if (method === 'GET') return pinStatus();
  if (INSTANCE === 'test') throw fail(400, 'PIN планшетов меняется в рабочей админке (app.jetmedia.dev) — планшеты связаны с рабочей');
  const pin = String(b.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw fail(400, 'PIN — от 4 до 8 цифр');
  if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin)) throw fail(400, 'Слишком простой PIN (одинаковые цифры или подряд)');
  const salt = crypto.randomBytes(8).toString('hex');
  db.servicePin = { salt, hash: crypto.createHash('sha256').update(salt + pin).digest('hex'), at: Date.now(), by: me.email };
  save();
  audit(me.email, 'PIN сервисного меню планшетов изменён');
  return pinStatus();
}

// ---------- Ключ диагностики (только чтение): суперадмин создаёт в «Администраторах» и вводит в защищённую форму
// Claude (не в чат). По ключу видно только устройства, связь, сбои и нагрузку сервера — без гостей, заказов,
// персонала и паролей. Хранится только отпечаток ключа; срок — 30 дней, отозвать можно в любой момент
db.diagKeys ??= [];
const DIAG_DAYS = 30;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const publicDiagKey = ({ hash, ...k }) => k;
function diagKeysApi(method, p, b, me) {
  if (method === 'POST' && p === '/api/admins/diag-keys') {
    const token = `jmd_${crypto.randomBytes(24).toString('base64url')}`;
    const k = { id: uid(), name: String(b.name || 'Claude').slice(0, 60), hash: sha256(token), at: Date.now(), by: me.email,
      expiresAt: Date.now() + DIAG_DAYS * 864e5, usedAt: 0 };
    db.diagKeys.push(k);
    save();
    audit(me.email, `Ключ диагностики «${k.name}» создан`);
    return { ...publicDiagKey(k), token }; // сам ключ показываем один раз
  }
  const m = p.match(/^\/api\/admins\/diag-keys\/(\w+)$/);
  if (method === 'DELETE' && m) {
    const k = db.diagKeys.find((x) => x.id === m[1]);
    db.diagKeys = db.diagKeys.filter((x) => x.id !== m[1]);
    save();
    if (k) audit(me.email, `Ключ диагностики «${k.name}» отозван`);
  }
  db.diagKeys = db.diagKeys.filter((x) => x.expiresAt > Date.now());
  return db.diagKeys.map(publicDiagKey);
}
function diagAuth(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(jmd_[\w-]{20,})$/);
  const k = m && db.diagKeys.find((x) => x.hash === sha256(m[1]) && x.expiresAt > Date.now());
  if (!k) throw fail(401, 'diagnostic key required');
  if (Date.now() - (k.usedAt || 0) > 60_000) { k.usedAt = Date.now(); save(); }
  return k;
}
// Устройства: где стоят, на связи ли, телеметрия, обрывы, журнал сети, сбои приложения
function diagDevices(b, q, req) {
  diagAuth(req);
  const now = Date.now();
  return {
    at: now, instance: INSTANCE, allowOpenWifi: !!db.allowOpenWifi, offlineAlertMin: OFFLINE_ALERT_MS / 60_000,
    devices: Object.values(db.devices).map((d) => {
      const { voices, pin, ...telemetry } = d.telemetry || {};
      return {
        id: d.id, name: deviceName(d), restaurant: db.restaurants[d.restaurantId]?.name || '', table: d.table || '', role: d.role || '',
        online: now - (d.lastSeen || 0) < ONLINE_MS, lastSeen: d.lastSeen || 0, firstSeen: d.firstSeen || 0, pageSeen: d.pageSeen || 0,
        pinFromAdmin: db.servicePin ? pin === db.servicePin.hash.slice(0, 8) : null, // PIN сервисного меню — из админки (сам PIN не показываем)
        offlineAlert: d.offlineAlert || 0, quiet: d.quiet || 0, offAt: d.offAt || 0, offReason: d.offReason || '', onAt: d.onAt || 0, bootAt: d.bootAt || 0,
        ip: d.ip || '', telemetry, outages: d.outages || [], netlog: d.netlog || [], events: d.events || [], scan: d.scan || null, upd: d.upd || null,
      };
    }),
    restaurants: Object.values(db.restaurants).map((r) => ({ id: r.id, name: r.name, hours: r.hours || null, used: hoursOf(r), detected: detected(r.id) })),
  };
}
// Что стало с вызовом или заказом из уведомления: кто нажал «Иду» / подтвердил и когда
function pushRefState(x) {
  if (!x.ref) return {};
  const c = db.calls.find((y) => y.id === x.ref) || db.orders.find((y) => y.id === x.ref);
  if (!c) return {};
  if (c.cancelled) return { refCancel: 1 }; // гость отменил вызов сам
  if (x.kind === 'ready') return c.servedAt ? { refAckAt: c.servedAt, refAckBy: c.servedBy || '' } : {}; // «готово» → «Подано»
  const ackAt = c.ackAt || c.doneAt || c.confirmedAt || 0;
  return ackAt ? { refAckAt: ackAt, refAckBy: c.ackBy || c.by || '' } : {};
}
// Уведомления официантам: телефоны (журнал доставки) и ход вызовов из журнала событий — вызов, напоминания,
// «Иду», «Готово», отмена гостем — за days дней (до 7)
function diagPush(b, q, req) {
  diagAuth(req);
  const days = Math.min(7, Math.max(1, Number(q.days) || 1)), to = Date.now();
  const kinds = new Set(['call', 'remind', 'call_ack', 'call_done', 'call_cancel', 'shift']);
  return {
    at: to,
    phones: Object.values(db.sessions).filter((s) => s.restaurantId).map((s) => {
      const r = db.restaurants[s.restaurantId], m = (r?.staff || []).find((x) => x.id === s.staffId);
      return {
        restaurant: r?.name || '', name: m?.name || '', role: m?.role || '', onShift: !!s.onShift, lang: s.lang || '', ua: s.ua || '',
        subs: s.subs.map((x) => new URL(x.endpoint).host), testAt: s.pushTestAt || 0,
        log: (s.pushLog || (s.pushLast ? [s.pushLast] : [])).map(({ ack, ...x }) => ({ ...x, ...pushRefState(x) })),
      };
    }),
    calls: events.read(to - days * 864e5, to, null).filter((e) => kinds.has(e.k))
      .map((e) => ({ ...e, restaurant: db.restaurants[e.r]?.name || '', device: db.devices[e.dev] ? deviceName(db.devices[e.dev]) : e.dev })),
  };
}
// События устройств из журнала: пропадания (больше порога), обрывы глазами планшета, сбои — за days дней (до 31)
function diagEvents(b, q, req) {
  diagAuth(req);
  const days = Math.min(31, Math.max(1, Number(q.days) || 7)), to = Date.now();
  const kinds = new Set(['dev_offline', 'dev_outage', 'dev_crash', 'dev_off', 'dev_on']);
  return events.read(to - days * 864e5, to, null).filter((e) => kinds.has(e.k))
    .map((e) => ({ ...e, restaurant: db.restaurants[e.r]?.name || '', device: db.devices[e.dev] ? deviceName(db.devices[e.dev]) : e.dev }));
}
// Нагрузка сервера: процессор, память, диск, отклик, запросы в минуту
function diagServer(b, q, req) {
  diagAuth(req);
  return { instance: INSTANCE, version: VERSION, self: selfStats(DATA_DIR), host: hostStats(DATA_DIR) };
}

function adminsApi(method, p, b, me) {
  if (p === '/api/admins/service-pin') return servicePinApi(method, b, me);
  if (p.startsWith('/api/admins/diag-keys')) return diagKeysApi(method, p, b, me);
  // Ключ регистрации планшетов — для загрузчика (provision): только суперадмину
  if (p === '/api/admins/device-key') return { key: DEVICE_KEY, instance: INSTANCE };
  if (method === 'GET') return db.admins.map(publicAdmin);
  const supers = (except) => db.admins.filter((a) => a.role === 'super' && !a.disabled && a.id !== except).length;
  const m = p.match(/^\/api\/admins\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    const a = db.admins.find((x) => x.id === m[1]);
    if (!a) throw fail(404, 'not found');
    if (a.role === 'super' && !supers(a.id)) throw fail(400, 'Нельзя удалить последнего суперадмина');
    db.admins = db.admins.filter((x) => x.id !== a.id);
    for (const [k, s] of Object.entries(db.adminSessions)) if (s.adminId === a.id) delete db.adminSessions[k];
    save();
    audit(me.email, `Админ удалён: ${a.email}`);
    return {};
  }
  if (method !== 'POST' || p !== '/api/admins') return undefined;
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Неверная почта');
  if (db.admins.some((a) => a.email === email && a.id !== b.id)) throw fail(400, 'Такая почта уже есть');
  const role = ROLES.includes(b.role) ? b.role : 'admin';
  const perms = cleanPerms(b.perms);
  const pass = String(b.password || '');
  if (pass && pass.length < 8) throw fail(400, 'Пароль — не короче 8 символов');
  let a = db.admins.find((x) => x.id === b.id);
  if (!a) {
    if (!pass) throw fail(400, 'Задайте пароль');
    a = { id: uid(), at: Date.now() };
    db.admins.push(a);
  }
  if (a.role === 'super' && (role !== 'super' || b.disabled) && !supers(a.id)) throw fail(400, 'Нужен хотя бы один суперадмин');
  const was = a.email ? `${a.email} (${a.role}${a.disabled ? ', отключён' : ''})` : '';
  Object.assign(a, {
    email, name: String(b.name || '').slice(0, 60), role, disabled: !!b.disabled, perms: role === 'super' ? undefined : perms,
    restaurants: role === 'super' ? [] : (Array.isArray(b.restaurants) ? b.restaurants : []).filter((id) => db.restaurants[id]),
  }, pass ? hashPass(pass) : {});
  if (a.disabled || pass) for (const [k, s] of Object.entries(db.adminSessions)) if (s.adminId === a.id && a.id !== me.id) delete db.adminSessions[k];
  save();
  delete a.crm;
  const access = role === 'super' ? '' : ` (${ADMIN_SECTIONS.filter(([k]) => perms[k] !== 'none').map(([k, n]) => `${n} — ${PERM_NAME[perms[k]]}`).join(', ') || 'без доступа к разделам'})`;
  audit(me.email, `${was ? 'Админ изменён' : 'Админ добавлен'}: ${email} — ${{ super: 'суперадмин', admin: 'админ' }[role]}${access}`
    + `${a.restaurants.length ? `, рестораны: ${a.restaurants.map((id) => db.restaurants[id].name).join(', ')}` : ''}${a.disabled ? ', отключён' : ''}${pass ? ', пароль задан' : ''}`);
  return publicAdmin(a);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(fail(413, 'request is too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}

// Файл в uploads: имя — хэш содержимого, повторная загрузка того же файла ничего не дублирует
function storeFile(data, ext) {
  const name = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 20)}.${ext}`;
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, name), data);
  return `/uploads/${name}`;
}

// data:-ссылку из пакета персонажа сохраняем файлом; обычную ссылку оставляем как есть
function storeDataUri(uri) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(uri || '');
  if (!m) return String(uri || '');
  if (!FILE_TYPES[m[1]]) throw fail(400, `unsupported file type ${m[1]}`);
  return storeFile(Buffer.from(m[2], 'base64'), FILE_TYPES[m[1]]);
}

function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

// ---------- Планшет

function devicePoll(b, q, req) {
  if (!b.id) throw fail(400, 'id required');
  // Новые устройства — только с ключом регистрации; уже известные пускаем как есть.
  // Без ключа или с неверным устройство ждёт в портале: администратор может добавить его вручную.
  if (DEVICE_KEY && b.key !== DEVICE_KEY && !db.devices[b.id]) {
    db.pending[b.id] = {
      id: b.id, telemetry: b.telemetry || {}, lastSeen: Date.now(), keyGiven: !!b.key,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    };
    save();
    throw fail(403, 'bad device key');
  }
  const d = (db.devices[b.id] ??= { id: b.id, firstSeen: Date.now(), queue: [] });
  if (d.restaurantId) { bump(`up|${d.restaurantId}|${day()}`); bump(`dup|${d.id}|${day()}`); }
  // обрыв глазами планшета (агент 0.1.14+): приходит с первым удачным опросом после двух и более неудачных
  const outage = b.outage && typeof b.outage === 'object' ? outageRecord(d, b.outage) : null;
  if (d.offlineAlert) {
    // тихо пропал (выключили кнопкой, вне часов работы) — тихо и вернулся; пропал вместе со всем рестораном — одним сообщением
    if (d.group && !d.quiet) (recovered[d.restaurantId] ??= { at: Date.now(), list: [] }).list.push(Date.now() - d.lastSeen);
    else if (!d.quiet) tgAlert(`🟢 ${deviceName(d)}: снова на связи (не было ${fmtDur(Date.now() - d.lastSeen)})${outage ? `\n${outage.why}` : ''}`);
    d.offlineAlert = 0;
    d.quiet = 0;
    d.group = 0;
  }
  // экран погашен (агент 0.1.16+): планшет спит — считаем выключенным, даже если изредка выходит на связь
  const screenOff = b.telemetry?.screen === false;
  if (screenOff && !d.offAt) { d.offAt = Date.now(); d.offReason = 'screen'; }
  // включили после выключения кнопкой (агент 0.1.15+) или после сна
  if (d.offAt && !screenOff) {
    d.onAt = Date.now();
    if (d.restaurantId) logEvent(d.restaurantId, 'dev_on', { dev: d.id, offMs: Date.now() - d.offAt });
    d.offAt = 0;
  }
  const up = Number(b.telemetry?.uptime);
  if (up > 0) d.bootAt = Date.now() - up;
  // итог обновления агента (0.1.16+): установлено / уже последняя / ошибка с причиной
  if (b.update && typeof b.update === 'object' && d.upd) {
    d.upd = { ...d.upd, status: cut(b.update.status, 20), msg: cut(b.update.msg, 200), resAt: Date.now() };
    if (d.upd.status === 'latest') d.upd.done = Date.now();
  }
  // «Сети рядом» по кнопке в портале
  if (b.scan && typeof b.scan === 'object' && Array.isArray(b.scan.list)) {
    d.scan = { at: Date.now(), list: b.scan.list.slice(0, 40).map((n) => ({
      ssid: cut(n.ssid, 64), level: Number(n.level) || null, freq: Number(n.freq) || null, open: !!n.open, saved: !!n.saved, current: !!n.current })) };
  }
  // Сбои, после которых агент перезапустился сам: падение, зависание, нехватка памяти
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 5)) {
    const text = String(e).slice(0, 300);
    // история сбоев — последние 30 и не старше 60 дней (портал: «без сбоев N дней», по нажатию — список)
    d.events = [{ at: Date.now(), text }, ...(d.events || [])].filter((x) => Date.now() - x.at < 60 * 864e5).slice(0, 30);
    tgAlert(`⚠️ ${deviceName(d)}: ${text}`);
    if (d.restaurantId) logEvent(d.restaurantId, 'dev_crash', { dev: d.id });
  }
  // журнал смен Wi-Fi от агента (0.1.13+): «сеть X → Y, причина» — показываем в портале, в Telegram не шлём
  for (const n of (Array.isArray(b.netlog) ? b.netlog : []).slice(-20)) {
    const at = Number(n.at) || Date.now();
    if ((d.netlog || []).some((x) => x.at === at)) continue;
    d.netlog = [{ at, from: String(n.from || '').slice(0, 64), to: String(n.to || '').slice(0, 64), why: String(n.why || '').slice(0, 160) },
      ...(d.netlog || [])].sort((x, y) => y.at - x.at).slice(0, 30);
  }
  // Wi-Fi глазами планшета (агент 0.1.17+): ушёл на чужую открытую сеть, вернулся, сеть ресторана «не пускает»
  const nt = b.telemetry || {}, pt = d.telemetry || {};
  if (nt.authFail?.ssid && nt.authFail.at !== pt.authFail?.at) wifiNews(d, 'auth', nt);
  if (nt.backup?.ssid && !pt.backup?.ssid) wifiNews(d, 'backup', nt);
  if (nt.backup === null && pt.backup?.ssid) wifiNews(d, 'back', pt);
  d.telemetry = b.telemetry || {};
  d.lastSeen = Date.now();
  d.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  // Страница планшета сама восстанавливается: привязан к столу или входу, а показывает не ту страницу (например,
  // после переустановки агента загрузчиком) — шлём нужную. Страницу, заданную вручную кнопкой «Страница», не трогаем
  const want = d.urlWant !== undefined ? d.urlWant : d.restaurantId && (d.table || d.role === 'entrance') ? guestUrl(d) : null;
  if (want !== null && typeof d.telemetry.url === 'string' && d.telemetry.url !== want && !d.queue.some((c) => c.type === 'url')
    && Date.now() - (d.urlFixAt || 0) > 60_000) {
    d.urlFixAt = Date.now();
    d.queue.push({ type: 'url', url: want });
  }
  const commands = d.queue.splice(0);
  save();
  // PIN сервисного меню (если меняли в админке): агент хранит у себя и сверяет введённый.
  // allowOpenWifi — можно ли при потере связи подключаться к чужим открытым сетям (по умолчанию нет)
  const out = { commands, allowOpenWifi: !!db.allowOpenWifi };
  // сеть ресторана из админки — только планшетам этого ресторана и только когда изменилась
  const wf = wifiFor(d);
  if ((wf.nets.length || d.telemetry.wifiV) && d.telemetry.wifiV !== wf.v) {
    const first = wf.nets.find((n) => n.ssid === wf.primary) || wf.nets[0] || {};
    // ssid / pass / pass2 — для агента 0.1.17 (он знает одну сеть)
    out.wifi = { v: wf.v, nets: wf.nets, primary: wf.primary, ssid: first.ssid || '', pass: first.pass || '', pass2: first.pass2 || '' };
  }
  if (db.servicePin) out.pin = { salt: db.servicePin.salt, hash: db.servicePin.hash };
  return out;
}

// ---------- Обрывы связи: запись от агента, понятное объяснение причины
const fmtSec = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} с` : fmtDur(ms));
const cut = (v, n = 160) => String(v ?? '').slice(0, n);
function wifiText(w) {
  if (!w || typeof w !== 'object' || !Object.keys(w).length) return '';
  if (w.on === false) return 'Wi-Fi был выключен';
  if (!w.connected) return 'Wi-Fi не подключён ни к одной сети';
  const rssi = Number(w.rssi);
  const q = rssi >= -60 ? 'хороший' : rssi >= -70 ? 'средний' : rssi >= -80 ? 'слабый' : 'очень слабый';
  const parts = [`«${cut(w.ssid, 64)}»`];
  if (w.ip === false) parts.push('роутер не выдал адрес');
  if (Number.isFinite(rssi) && rssi < 0) parts.push(`сигнал ${rssi} dBm (${q})`);
  if (Number(w.freq) > 0) parts.push(Number(w.freq) < 3000 ? '2.4 ГГц' : '5 ГГц');
  if (w.bssid && !/^0{2}(:0{2}){5}$|null/.test(w.bssid)) parts.push(`точка …${cut(w.bssid, 17).slice(-5)}`);
  if (w.internet === false) parts.push('Android: интернета нет');
  return 'Wi-Fi: ' + parts.join(', ');
}
// Где рвётся (агент 0.1.19+ в начале обрыва проверяет роутер и интернет): точка Wi-Fi, интернет ресторана или путь до сервера
const WHERE = { ap: 'точка Wi-Fi', isp: 'интернет ресторана', path: 'путь до сервера', portal: 'страница входа сети' };
function probeOf(pr) {
  if (!pr || typeof pr !== 'object') return null;
  const gw = pr.gw === true ? true : pr.gw === false ? false : null, net = pr.net === true ? true : pr.net === 'portal' ? 'portal' : pr.net === false ? false : null;
  const where = gw === false ? 'ap' : net === 'portal' ? 'portal' : net === false ? 'isp' : net === true ? 'path' : null;
  return { gw, net, where };
}
const PROBE_TEXT = {
  ap: 'Где: роутер не отвечает — точка Wi-Fi не пропускает данные к планшету',
  isp: 'Где: роутер отвечает, интернета нет — пропал интернет ресторана',
  path: 'Где: роутер и интернет в порядке — не отвечал только путь до нашего сервера',
  portal: 'Где: сеть требует входа (страница входа)',
};
function outageRecord(d, o) {
  const now = Date.now();
  const dur = Math.min(7 * 864e5, Math.max(0, Number(o.dur) || 0));
  const key = Number(o.start) || now - dur;
  const w = o.wifi && typeof o.wifi === 'object' ? o.wifi : {};
  const wifi = {
    on: w.on !== false, connected: !!w.connected, ssid: cut(w.ssid, 64), bssid: cut(w.bssid, 17),
    rssi: Number(w.rssi) || null, freq: Number(w.freq) || null, link: Number(w.link) || null, ip: w.connected ? w.ip !== false : null, internet: w.internet !== false,
  };
  const steps = cut(o.steps, 400);
  const fix = steps ? steps.split('; ').pop().replace(/ на .*$/, '') : '';
  const probe = probeOf(o.probe);
  const why = [`Причина: ${cut(o.err) || 'неизвестна'}`, probe?.where ? PROBE_TEXT[probe.where] : '', wifiText(wifi),
    steps ? `Что делал планшет: ${steps}. Помогло: ${fix}` : 'Связь вернулась сама'].filter(Boolean).join('\n');
  const rec = { key, start: now - dur, end: now, dur, fails: Math.min(9999, Number(o.fails) || 0), err: cut(o.err), lastErr: cut(o.lastErr), wifi, steps, why,
    ...(probe ? { probe } : {}) };
  const list = (d.outages || []).filter((x) => x.key !== key);
  d.outages = [rec, ...list].slice(0, 100);
  if (d.restaurantId) logEvent(d.restaurantId, 'dev_outage', { dev: d.id, dur });
  return rec;
}

// Связь за сутки — только в часы работы ресторана (ночью закрытый зал не в счёт): обрывы, сколько без связи, доля времени на связи
function workStats(d, now = Date.now()) {
  const r = db.restaurants[d.restaurantId], from = now - 864e5;
  const list = (d.outages || []).filter((x) => x.end >= from);
  const inWork = list.filter((x) => !r || isWorking(r, x.start, 0));
  const h = r ? hoursOf(r) : null, len = h ? ((((h.to - h.from + 1440) % 1440) || 1440) * 60_000) : 864e5;
  const ms = inWork.reduce((a, x) => a + x.dur, 0);
  return { n: inWork.length, ms, off: list.length - inWork.length, avail: Math.max(0, Math.round(1000 - (ms / len) * 1000) / 10), hours: !!h };
}

// Раз в день, в 9 утра по Пхукету: сводка обрывов за вчера по каждому устройству (короткие в Telegram не пишем)
setInterval(() => {
  const bkk = new Date(Date.now() + 7 * 3600_000);
  if (bkk.getUTCHours() !== 9) return;
  const today = bkk.toISOString().slice(0, 10);
  if (db.netSummaryDay === today) return;
  db.netSummaryDay = today;
  save();
  const to = Date.parse(`${today}T00:00:00+07:00`), from = to - 864e5;
  const rows = [];
  let quiet = 0;
  for (const d of Object.values(db.devices)) {
    const r = db.restaurants[d.restaurantId];
    const list = (d.outages || []).filter((x) => x.end >= from && x.end < to && (!r || isWorking(r, x.start, 0)));
    if (!list.length) { quiet++; continue; }
    const total = list.reduce((a, x) => a + x.dur, 0), max = Math.max(...list.map((x) => x.dur));
    const rs = list.map((x) => x.wifi?.rssi).filter((v) => v < 0);
    const rssi = rs.length ? Math.round(rs.reduce((a, v) => a + v, 0) / rs.length) : null;
    const wh = {};
    for (const x of list) if (x.probe?.where) wh[x.probe.where] = (wh[x.probe.where] || 0) + 1;
    const whText = Object.keys(wh).length ? ` (${Object.entries(wh).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${WHERE[k]}: ${n}`).join(', ')})` : '';
    rows.push({ total, text: `• ${deviceName(d)} — обрывов: ${list.length}${whText}, всего ${fmtSec(total)}, самый долгий ${fmtSec(max)}${rssi ? `, сигнал около ${rssi} dBm` : ''}` });
  }
  if (!rows.length) return;
  rows.sort((a, b) => b.total - a.total);
  const date = new Date(from + 7 * 3600_000).toISOString().slice(5, 10).split('-').reverse().join('.');
  tgAlert(`📶 Связь за ${date}:\n${rows.slice(0, 40).map((r) => r.text).join('\n')}${rows.length > 40 ? `\n…и ещё ${rows.length - 40}` : ''}`
    + (quiet ? `\nОстальные устройства (${quiet}) — без обрывов.` : ''));
}, 60_000).unref();

// Планшет выключают кнопкой (агент 0.1.15+ успевает сообщить): не обрыв — без тревоги. Сел аккумулятор в часы работы — пишем
function deviceBye(b) {
  const d = db.devices[b.id];
  if (!d) throw fail(404, 'unknown device');
  if (DEVICE_KEY && b.key !== DEVICE_KEY) throw fail(403, 'bad device key');
  const battery = b.reason === 'battery';
  d.offAt = Date.now();
  d.offReason = battery ? 'battery' : b.reason === 'screen' ? 'screen' : 'shutdown';
  if (d.restaurantId) logEvent(d.restaurantId, 'dev_off', { dev: d.id, why: d.offReason });
  const r = db.restaurants[d.restaurantId];
  if (battery && (!r || isWorking(r))) tgAlert(`🪫 ${deviceName(d)}: выключился — сел аккумулятор (${Number(b.battery) || 0}%). Поставьте на зарядку`);
  save();
  return {};
}

// ---------- Часы работы ресторана. Каждую минуту считаем, сколько планшетов ресторана включено (по 5-минутным
// отрезкам, 21 день). Часы — когда включена хотя бы половина обычного числа планшетов: медиана за последние 7 рабочих
// суток (нужно не меньше 3). Праздники и несезон подхватываются сами. Можно задать вручную или «нет часов» (демо)
const SLOT_MIN = 5, SLOTS = 1440 / SLOT_MIN;
db.presence ??= {};
const bkkMin = (ts) => { const x = new Date(ts + 7 * 3600_000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const hhmm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const devOn = (d, now) => now - (d.lastSeen || 0) < ONLINE_MS && !(d.offAt && d.offAt >= d.lastSeen) && d.telemetry?.screen !== false;
setInterval(() => {
  const now = Date.now(), key = thDay(now), slot = Math.floor(bkkMin(now) / SLOT_MIN), old = thDay(now - 21 * 864e5);
  const on = {};
  for (const d of Object.values(db.devices)) if (d.restaurantId && devOn(d, now)) on[d.restaurantId] = (on[d.restaurantId] || 0) + 1;
  for (const rid of Object.keys(db.restaurants)) {
    const p = (db.presence[rid] ??= {});
    const arr = (p[key] ??= new Array(SLOTS).fill(-1)); // -1 — нет данных (сервер не работал)
    arr[slot] = Math.max(arr[slot], on[rid] || 0);
    for (const k of Object.keys(p)) if (k < old) delete p[k];
  }
  hoursCache.clear();
  save();
}, 60_000).unref();

const hoursCache = new Map();
const median = (a) => { const x = [...a].sort((p, q) => p - q); return x[Math.floor((x.length - 1) / 2)]; };
function detectHours(rid, now = Date.now()) {
  const p = db.presence[rid] || {}, keys = Object.keys(p).sort();
  if (!keys.length) return { days: [], n: 0 };
  // все отрезки подряд, от первого дня с данными до сегодня
  const series = [], dayKeys = [];
  for (let t = Date.parse(`${keys[0]}T12:00:00+07:00`); thDay(t) <= thDay(now); t += 864e5) {
    dayKeys.push(thDay(t));
    series.push(...(p[thDay(t)] || new Array(SLOTS).fill(-1)));
  }
  // граница «рабочих суток» — середина самого тихого 2-часового окна (в среднем по дням)
  const sum = new Array(SLOTS).fill(0), cnt = new Array(SLOTS).fill(0);
  series.forEach((v, i) => { if (v >= 0) { sum[i % SLOTS] += v; cnt[i % SLOTS]++; } });
  const W = 24;
  let quiet = 0, quietV = Infinity;
  for (let i = 0; i < SLOTS; i++) {
    let s2 = 0, c2 = 0;
    for (let j = 0; j < W; j++) { const k = (i + j) % SLOTS; if (cnt[k]) { s2 += sum[k] / cnt[k]; c2++; } }
    if (c2 && s2 / c2 < quietV) { quietV = s2 / c2; quiet = i; }
  }
  const bound = (quiet + W / 2) % SLOTS;
  const nowIdx = (dayKeys.length - 1) * SLOTS + Math.floor(bkkMin(now) / SLOT_MIN);
  const segs = [];
  for (let st = bound; st + SLOTS - 1 <= nowIdx && st + SLOTS <= series.length; st += SLOTS) {
    const seg = series.slice(st, st + SLOTS);
    if (seg.filter((v) => v >= 0).length < SLOTS * 0.6) continue; // мало данных за эти сутки
    segs.push({ day: dayKeys[Math.floor(st / SLOTS)], seg, max: Math.max(...seg) });
  }
  const recent = segs.slice(-7);
  const typical = recent.length ? median(recent.map((x) => x.max)) : 0;
  const thr = Math.max(1, Math.ceil(typical * 0.5));
  const bm = bound * SLOT_MIN, days = [];
  for (const x of recent) {
    if (x.max < thr) { days.push({ day: x.day, closed: true, max: x.max }); continue; } // выходной, праздник
    const o = x.seg.findIndex((v) => v >= thr), c = SLOTS - 1 - [...x.seg].reverse().findIndex((v) => v >= thr);
    days.push({ day: x.day, openOff: o * SLOT_MIN, closeOff: (c + 1) * SLOT_MIN, max: x.max });
  }
  const work = days.filter((x) => !x.closed);
  const res = { days: days.map((x) => (x.closed ? { day: x.day, closed: true }
    : { day: x.day, open: hhmm(bm + x.openOff), close: hhmm(bm + x.closeOff), max: x.max })), n: work.length, typical };
  if (work.length >= 3) {
    res.from = (bm + median(work.map((x) => x.openOff))) % 1440;
    res.to = (bm + median(work.map((x) => x.closeOff))) % 1440;
    res.open = hhmm(res.from);
    res.close = hhmm(res.to);
  }
  return res;
}
const detected = (rid) => {
  if (!hoursCache.has(rid)) hoursCache.set(rid, detectHours(rid));
  return hoursCache.get(rid);
};
// Какие часы действуют: по планшетам (когда данных хватает), иначе заданные вручную; у демо — нет часов
function hoursOf(r) {
  const h = r?.hours || {};
  if (!r || h.mode === 'none') return null;
  if (h.mode !== 'manual') {
    const d = detected(r.id);
    if (d.open) return { from: d.from, to: d.to, src: 'auto' };
  }
  return Number.isFinite(h.from) && Number.isFinite(h.to) ? { from: h.from, to: h.to, src: 'manual' } : null;
}
// Время ts — в часы работы (с запасом margin минут до и после)? Часов нет — считаем, что работает всегда
// Начало рабочего дня ресторана для статистики (визит не переходит через него): открытие по часам работы
const dayFrom = (r) => hoursOf(r)?.from ?? null;
function isWorking(r, ts = Date.now(), margin = 30) {
  const h = hoursOf(r);
  if (!h) return true;
  const len = ((h.to - h.from + 1440) % 1440) || 1440;
  const rel = (((bkkMin(ts) - (h.from - margin)) % 1440) + 1440) % 1440;
  return rel <= len + 2 * margin;
}
const parseHm = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || +m[1] > 24 || +m[2] > 59 || (+m[1] === 24 && +m[2] > 0)) return null;
  return (+m[1] * 60 + +m[2]) % 1440;
};
function cleanHours(b) {
  const mode = ['auto', 'manual', 'none'].includes(b?.mode) ? b.mode : 'auto';
  const from = parseHm(b?.from), to = parseHm(b?.to);
  return { mode, ...(from !== null && to !== null ? { from, to } : {}) };
}
// Загрузчик (provision) при подготовке планшета берёт сети «для всех планшетов» и отпечаток PIN сервисного меню
// (сам PIN нигде не хранится) — по ключу регистрации устройств. Тогда заводской PIN не действует ни минуты
function fleetWifiForProvision(b, q) {
  if (!DEVICE_KEY || q.key !== DEVICE_KEY) throw fail(403, 'bad device key');
  return { nets: db.fleetWifi.map(({ ssid, pass, pass2 }) => ({ ssid, pass, pass2, level: 'fleet' })), primary: db.fleetWifi.find((n) => n.primary)?.ssid || '',
    ...(db.servicePin ? { pin: { salt: db.servicePin.salt, hash: db.servicePin.hash } } : {}) };
}
// Сколько планшетов ресторана уже получили свои сети из админки
function wifiStatus(r) {
  const devs = Object.values(db.devices).filter((d) => d.restaurantId === r.id);
  const withNets = devs.filter((d) => wifiFor(d).v);
  return { total: withNets.length, got: withNets.filter((d) => d.telemetry?.wifiV === wifiFor(d).v).length,
    old: devs.filter((d) => !('wifiV' in (d.telemetry || {}))).length };
}
const hoursText = (h) => (h ? `${hhmm(h.from)}–${h.to === 0 ? '24:00' : hhmm(h.to)}` : '');

// Обновление агента: команда дошла, но версия не сменилась (не скачалось, мало памяти, установка отклонена) — сервер
// повторяет каждые 10 минут, пока планшет на связи, до 5 попыток; не вышло — сообщение в Telegram с последней причиной
const UPD_EVERY = 10 * 60_000, UPD_TRIES = 5;
setInterval(() => {
  const now = Date.now();
  for (const d of Object.values(db.devices)) {
    const u = d.upd;
    if (!u) continue;
    if (u.done) { if (now - u.done > 864e5) delete d.upd; continue; }
    if ((d.telemetry?.version || '') !== u.from) { u.done = now; u.status = 'ok'; u.msg = `установлена ${d.telemetry?.version || ''}`; continue; }
    if (now - (d.lastSeen || 0) > ONLINE_MS || now - u.lastTry < UPD_EVERY) continue;
    if (u.status === 'installing' && now - (u.resAt || 0) < 5 * 60_000) continue; // ещё ставится
    if (u.status === 'waiting' && now - (u.resAt || 0) < 35 * 60_000) continue; // ждёт, пока гость закончит с планшетом
    if (u.tries >= UPD_TRIES) {
      u.done = now;
      u.status = 'failed';
      tgAlert(`⚠️ ${deviceName(d)}: агент не обновился за ${UPD_TRIES} попыток (осталась ${u.from || '?'}). Последняя причина: ${u.msg || 'планшет не ответил'}`);
      continue;
    }
    d.queue.push({ type: 'update' });
    u.tries++;
    u.lastTry = now;
    u.status = 'sent';
  }
}, 60_000).unref();

// ---------- Wi-Fi из админки: списки сетей для всего парка (вкладка «Устройства»), ресторана (его карточка) и отдельного
// планшета (кнопка «Wi-Fi» у устройства). Планшет получает все три списка; одна и та же сеть — с паролем самого
// точного уровня. «Основная» — с уровня устройства, иначе ресторана, иначе парка; нет основной — планшет выбирает
// сам по сигналу и стабильности. «Новый пароль» — если ресторан собирается сменить. Пароли — только своим планшетам
function cleanNets(list) {
  const pw = (v) => {
    const x = String(v || '');
    if (x && (x.length < 8 || x.length > 63)) throw fail(400, 'Пароль Wi-Fi — от 8 до 63 символов (пусто — сеть без пароля)');
    return x;
  };
  const out = [], seen = new Set();
  let primary = false;
  for (const n of (Array.isArray(list) ? list : []).slice(0, 10)) {
    const ssid = String(n?.ssid || '').trim().slice(0, 32);
    if (!ssid || seen.has(ssid)) continue;
    seen.add(ssid);
    const isPrimary = !!n.primary && !primary;
    primary ||= isPrimary;
    out.push({ ssid, pass: pw(n.pass), pass2: pw(n.pass2), primary: isPrimary });
  }
  return out;
}
db.fleetWifi ??= [];
// прежняя одна сеть ресторана → список
for (const r of Object.values(db.restaurants)) {
  if (r.wifi && !r.wifiList) r.wifiList = r.wifi.ssid ? [{ ssid: r.wifi.ssid, pass: r.wifi.pass || '', pass2: r.wifi.pass2 || '', primary: false }] : [];
  delete r.wifi;
}
function wifiFor(d) {
  const r = db.restaurants[d.restaurantId];
  const nets = [], seen = new Set();
  let primary = '';
  for (const [level, list] of [['device', d.wifiList || []], ['restaurant', r?.wifiList || []], ['fleet', db.fleetWifi]]) {
    if (!primary) primary = list.find((n) => n.primary)?.ssid || '';
    for (const n of list) if (!seen.has(n.ssid)) { seen.add(n.ssid); nets.push({ ssid: n.ssid, pass: n.pass, pass2: n.pass2, level }); }
  }
  return { nets, primary, v: nets.length ? sha256(JSON.stringify([nets, primary])).slice(0, 10) : '' };
}
const netsPublic = (list, full) => (list || []).map((n) => (full ? n : { ssid: n.ssid, pass: n.pass ? '••••••••' : '', pass2: n.pass2 ? '••••••••' : '', primary: n.primary }));
const netsSig = (list) => JSON.stringify(list || []);
// Сообщения о Wi-Fi копим минуту и шлём одним сообщением на ресторан (одинаковые — не чаще раза в 30 минут)
const wifiQueue = [], wifiSent = {};
function wifiNews(d, kind, t) {
  wifiQueue.push({ at: Date.now(), kind, rid: d.restaurantId || '', dev: d.id,
    ssid: kind === 'auth' ? t.authFail.ssid : t.backup?.ssid || '', via: t.backup?.ssid || '' });
}
setInterval(() => {
  const now = Date.now(), ready = wifiQueue.filter((x) => now - x.at > 60_000);
  if (!ready.length) return;
  for (const x of ready) wifiQueue.splice(wifiQueue.indexOf(x), 1);
  const groups = {};
  for (const x of ready) (groups[`${x.rid}|${x.kind}`] ??= []).push(x);
  for (const [key, list] of Object.entries(groups)) {
    const [rid, kind] = key.split('|'), r = db.restaurants[rid];
    if (kind !== 'back' && now - (wifiSent[key] || 0) < 30 * 60_000) continue;
    // «не пускает» уже говорит, что планшеты на открытой сети — отдельное «через открытую сеть» не шлём
    if (kind === 'backup' && (groups[`${rid}|auth`] || now - (wifiSent[`${rid}|auth`] || 0) < 30 * 60_000)) continue;
    wifiSent[key] = now;
    const devs = [...new Set(list.map((x) => x.dev))].map((id) => db.devices[id]).filter(Boolean);
    const names = devs.map((d) => (r && d.table ? tableLabel(d.table) : deviceName(d))).join(', ');
    const place = r ? r.name : 'Без ресторана', ssid = list[0].ssid;
    const via = devs.map((d) => d.telemetry?.backup?.ssid).find(Boolean);
    if (kind === 'auth') {
      tgAlert(`🔑 ${place}: ${names} — сеть «${ssid}» видна, но не пускает. Похоже, сменили пароль Wi-Fi.\n`
        + `Впишите новый в админке: Рестораны → ${place} → Wi-Fi ресторана — планшеты получат его сами`
        + (via ? ` (сейчас на связи через открытую сеть «${via}»).` : ' (как только выйдут на связь через открытую сеть рядом).'));
    } else if (kind === 'backup') {
      tgAlert(`📶 ${place}: ${names} — на связи через чужую открытую сеть «${ssid}»: сеть ресторана не даёт связи`);
    } else {
      tgAlert(`✅ ${place}: ${names} — ${devs.length > 1 ? 'вернулись' : 'вернулся'} на сеть ресторана`);
    }
  }
}, 30_000).unref();

// Ресторан, где пропали почти все планшеты разом, — одно сообщение о восстановлении (через 1,5 минуты, когда вернутся все)
const recovered = {};
setInterval(() => {
  for (const [rid, x] of Object.entries(recovered)) {
    if (Date.now() - x.at < 90_000) continue;
    delete recovered[rid];
    tgAlert(`🟢 ${db.restaurants[rid]?.name || 'Ресторан'}: снова на связи планшетов — ${x.list.length} (не было ${fmtDur(median(x.list))})`);
  }
}, 30_000).unref();

// Сторож агента не смог поднять приложение — сообщает отдельно (не чаще раза в 10 минут)
function deviceAlert(b) {
  const d = db.devices[b.id];
  if (!d) throw fail(404, 'unknown device');
  if (Date.now() - (d.alertAt || 0) < 10 * 60_000) return {};
  d.alertAt = Date.now();
  const text = String(b.text || 'ошибка').slice(0, 300);
  d.events = [{ at: Date.now(), text }, ...(d.events || [])].slice(0, 10);
  save();
  tgAlert(`🔴 ${deviceName(d)}: ${text}`);
  return {};
}

// ---------- Оповещения в Telegram

// ---------- Telegram: несколько ботов (вкладка «Telegram»), у каждого — что на него приходит
const TG_KINDS = [
  ['devices', 'Сбои и связь планшетов'],
  ['leads', 'Заявки по рекламе'],
  ['join', 'Заявки «подключить ресторан»'],
  ['crm', 'Напоминания по клиентам'],
  ['expenses', 'Напоминания по расходам'],
];
const TG_KIND_NAME = Object.fromEntries(TG_KINDS);
// прежний единственный бот становится «Основным», на него по-прежнему приходит всё
db.tgBots ??= db.telegram?.token
  ? [{ id: 'main', name: 'Основной', token: db.telegram.token, bot: db.telegram.bot || '', chats: db.telegram.chats || [], kinds: TG_KINDS.map(([k]) => k) }] : [];
const tgBotsFor = (kind) => db.tgBots.filter((x) => x.token && x.chats?.length && (x.kinds || []).includes(kind));
const tgHas = (kind) => INSTANCE !== 'test' && tgBotsFor(kind).length > 0;
async function tgTo(kind, text) {
  for (const bt of tgBotsFor(kind)) await tgSend(bt, text);
}
const tgAlert = (text) => tgTo('devices', text);
const clock = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function deviceName(d) {
  const r = db.restaurants[d.restaurantId];
  const place = d.role === 'entrance' ? 'вход' : d.table ? tableLabel(d.table) : 'без стола';
  return `${r ? r.name : 'Без ресторана'} · ${place} (${d.id})`;
}

// Раз в сутки: счётчики по устройствам старше 120 дней удаляем, чтобы база не росла
setInterval(() => {
  const old = day(Date.now() - 120 * 864e5);
  for (const k of Object.keys(db.stats)) if (/^(dup|dimp|dscan)\|/.test(k) && k.slice(-10) < old) delete db.stats[k];
  // ключи визитов столов, которыми не пользовались дольше 4 часов
  for (const [k, x] of Object.entries(db.tableKeys)) if (Date.now() - x.last > KEY_IDLE_MS) delete db.tableKeys[k];
  save();
}, 864e5);

// Раз в сутки — порядок в загрузках: картинки, на которые больше ничего не ссылается (удалённые акции, реклама,
// заменённые фото), старше 7 дней; озвучка, которая не звучала 60 дней. Журнал статистики не трогаем
function cleanUploads() {
  let files = [];
  try { files = fs.readdirSync(UPLOADS); } catch { return; }
  const used = new Set(JSON.stringify(db).match(/\/uploads\/[a-f0-9]+\.\w+/g) || []);
  const now = Date.now();
  let n = 0, bytes = 0;
  for (const f of files) {
    const file = path.join(UPLOADS, f);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const age = now - st.mtimeMs;
    const image = /^[a-f0-9]+\.(jpg|png|webp|svg)$/.test(f) && !used.has(`/uploads/${f}`) && age > 7 * 864e5;
    const voice = /^[a-f0-9]+\.(mp3|ogg|wav)$/.test(f) && !used.has(`/uploads/${f}`) && age > 60 * 864e5;
    if (image || voice) {
      try { fs.unlinkSync(file); n++; bytes += st.size; } catch { /* занят — в следующий раз */ }
    }
  }
  if (n) console.log(`Загрузки: удалено ${n} файлов, освобождено ${Math.round(bytes / 1048576)} МБ`);
}
setTimeout(cleanUploads, 10 * 60_000).unref();
setInterval(cleanUploads, 864e5).unref();

// Забытые столы: не закрыли до конца рабочего дня — к открытию следующего закрываем сами (планшет гостя не показывает
// вчерашние вызовы и заказы, официанту не закрывать их утром). Стол без действий меньше 3 часов не трогаем (ранние гости).
// Часов работы нет (демо) — закрываем после 12 часов без действий. Проверка раз в 5 минут
const lastActAt = (x) => Math.max(x.at || 0, ...Object.entries(x).filter(([k, v]) => /At$/.test(k) && typeof v === 'number').map(([, v]) => v));
function autoCloseTables(now = Date.now()) {
  let changed = false;
  for (const r of Object.values(db.restaurants)) {
    const last = {};
    for (const x of [...db.calls, ...db.orders]) if (x.restaurantId === r.id && !x.closed && x.table) last[x.table] = Math.max(last[x.table] || 0, lastActAt(x));
    const h = hoursOf(r);
    // последнее открытие ресторана (по Пхукету), не позже сейчас
    const opened = h ? now - ((((bkkMin(now) - h.from) % 1440) + 1440) % 1440) * 60_000 : 0;
    const done = [];
    for (const [tb, at] of Object.entries(last)) {
      const stale = h ? isWorking(r, now, 0) && at < opened && now - at > 3 * 3600_000 : now - at > 12 * 3600_000;
      if (!stale) continue;
      for (const x of [...db.calls, ...db.orders]) if (x.restaurantId === r.id && x.table === tb && !x.closed) { x.closed = now; x.autoClosed = now; }
      dropTableKey(r, tb);
      (r.visits ??= {})[tb] = now;
      logEvent(r.id, 'close', { table: tb, auto: 1 });
      done.push(tb);
    }
    if (done.length) {
      changed = true;
      audit('система', `Столы закрыты автоматически — остались открытыми с прошлого рабочего дня: ${done.join(', ')}`, r.id);
    }
  }
  if (changed) save();
}
setTimeout(() => autoCloseTables(), 60_000).unref();
setInterval(() => autoCloseTables(), 5 * 60_000).unref();

// Садится аккумулятор: 15% и меньше, не заряжается, экран включён — пишем в Telegram одним сообщением на ресторан,
// только в часы работы и не чаще раза в 4 часа на планшет; поставили на зарядку или заряд вырос до 25% — отметка снимается
setInterval(() => {
  const now = Date.now(), byR = {};
  for (const d of Object.values(db.devices)) {
    const t = d.telemetry || {}, r = db.restaurants[d.restaurantId], bat = Number(t.battery);
    if (!r || now - (d.lastSeen || 0) > ONLINE_MS || !Number.isFinite(bat) || bat < 0) continue;
    if (bat > 15 || t.charging || t.screen === false) { if (d.lowBat && (t.charging || bat >= 25)) d.lowBat = 0; continue; }
    d.lowBat ||= now;
    if (now - d.lowBat < 2 * 60_000 || now - (d.lowBatAlert || 0) < 4 * 3600_000 || !isWorking(r, now, 0)) continue;
    d.lowBatAlert = now;
    (byR[r.id] ??= []).push(d);
  }
  for (const [rid, list] of Object.entries(byR)) {
    tgAlert(`🪫 ${db.restaurants[rid].name}: садится аккумулятор, планшет не заряжается — проверьте зарядку:\n`
      + list.map((d) => `• ${deviceName(d)} — ${d.telemetry.battery}%`).join('\n'));
  }
  if (Object.keys(byR).length) save();
}, 60_000).unref();

// Раз в минуту: устройства, пропавшие больше чем на 3 минуты, — одним сообщением
setInterval(() => {
  const now = Date.now();
  const lost = Object.values(db.devices).filter((d) => d.lastSeen && !d.offlineAlert && now - d.lastSeen > OFFLINE_ALERT_MS);
  if (!lost.length) return;
  const loud = [];
  for (const d of lost) {
    d.offlineAlert = now;
    // выключили кнопкой (агент сообщил) или пропал вне часов работы ресторана — без Telegram
    const r = db.restaurants[d.restaurantId];
    d.quiet = (d.offAt && d.offAt >= d.lastSeen - 1000) || d.telemetry?.screen === false || (r && !isWorking(r, d.lastSeen)) ? 1 : 0;
    if (d.restaurantId) logEvent(d.restaurantId, 'dev_offline', { dev: d.id, ...(d.quiet ? { quiet: d.offAt ? 'off' : 'hours' } : {}) });
    if (!d.quiet) loud.push(d);
  }
  save();
  if (!loud.length) return;
  const line = (d) => {
    const t = d.telemetry || {};
    const low = t.battery <= 5 && !t.charging ? ', вероятно, сел аккумулятор' : '';
    return `• ${deviceName(d)} — с ${clock(d.lastSeen)} (${fmtDur(now - d.lastSeen)}), заряд ${t.battery ?? '?'}%${low}`;
  };
  // пропали все или почти все планшеты ресторана (3 и больше) — одно сообщение про ресторан
  const groups = [], single = [];
  for (const rid of new Set(loud.map((d) => d.restaurantId || ''))) {
    const list = loud.filter((d) => (d.restaurantId || '') === rid);
    const active = rid ? Object.values(db.devices).filter((x) => x.restaurantId === rid && now - (x.lastSeen || 0) < 12 * 3600_000) : [];
    const down = active.filter((x) => now - x.lastSeen > OFFLINE_ALERT_MS && !x.quiet);
    if (rid && list.length >= 3 && down.length >= Math.ceil(active.length * 0.8)) {
      for (const d of list) d.group = now;
      groups.push(`🔴 ${db.restaurants[rid].name}: без связи ${down.length} из ${active.length} планшетов с ${clock(Math.min(...list.map((d) => d.lastSeen)))}`
        + ' — похоже, пропал интернет или электричество, или планшеты выключили не кнопкой');
    } else single.push(...list);
  }
  if (groups.length) tgAlert(groups.join('\n'));
  if (single.length) tgAlert('🔴 Нет связи с устройствами:\n' + single.map(line).join('\n'));
}, 60_000);

const tgPublic = () => ({ kinds: TG_KINDS.map(([k, n]) => ({ k, n })),
  bots: db.tgBots.map((x) => ({ id: x.id, name: x.name, bot: x.bot, connected: !!x.token, chats: x.chats || [], kinds: x.kinds || [] })) });

async function telegramAdmin(method, p, b) {
  if (method === 'GET') return tgPublic();
  const kinds = (v) => [...new Set((Array.isArray(v) ? v : []).filter((k) => TG_KIND_NAME[k]))];
  if (method === 'POST' && p === '/api/telegram/bots') {
    let bt = db.tgBots.find((x) => x.id === b.id);
    const token = String(b.token || '').trim();
    if (!bt && !token) throw fail(400, 'Вставьте токен бота от @BotFather');
    const me = token ? await tgApi(token, 'getMe') : null;
    if (!bt) { bt = { id: uid(), chats: [], kinds: [] }; db.tgBots.push(bt); }
    if (me) { if (token !== bt.token) bt.chats = []; Object.assign(bt, { token, bot: me.username }); }
    bt.name = String(b.name || bt.name || bt.bot || 'Бот').slice(0, 60);
    if (b.kinds !== undefined) bt.kinds = kinds(b.kinds);
  }
  const m = p.match(/^\/api\/telegram\/bots\/([^/]+)(?:\/(find|test|remove))?$/);
  const bt = m && db.tgBots.find((x) => x.id === m[1]);
  if (m && !bt) throw fail(404, 'Бот не найден');
  if (method === 'DELETE' && m && !m[2]) db.tgBots = db.tgBots.filter((x) => x !== bt);
  if (m?.[2] === 'find') await tgFindChats(bt);
  if (m?.[2] === 'test') await tgSend(bt, `✅ JET MEDIA: тестовое сообщение. Сюда приходит: ${(bt.kinds || []).map((k) => TG_KIND_NAME[k]).join(', ') || 'пока ничего — отметьте в админке'}.`, true);
  if (m?.[2] === 'remove') bt.chats = bt.chats.filter((c) => c.id !== b.chat);
  save();
  return tgPublic();
}

// ---------- Гость за столом (устройство определяется по ?d=<id>)

// Устройство стоит либо на столе (table), либо у входа (role = 'entrance')
function tableOf(deviceId) {
  const d = db.devices[deviceId];
  const r = d && db.restaurants[d.restaurantId];
  return r && d.table && d.role !== 'entrance' ? { r, table: d.table } : null;
}

const openAt = (list, r, table) => list.filter((x) => x.restaurantId === r.id && x.table === table && !x.closed);

// ---------- Заказ с телефонов гостей. QR-код на планшете ведёт на /t/<ключ> — ключ визита стола. Ключ живёт,
// пока стол не закрыли, и не дольше 4 часов после последнего действия за столом; после закрытия стола планшет
// показывает новый QR-код, старые телефоны отключаются. Планшет — «Гость 1», телефоны — «Гость 2», «Гость 3»… или по имени
const KEY_IDLE_MS = 4 * 3600e3;
// Настройки ресторана (ЛК → «Кухня»): заказ с телефонов, кнопка «Заказ отправлен на кухню», экран кухни
const FLOW = { phones: true, kitchenBtn: true, kitchenScreen: false, kitchenKey: '' };
const flowOf = (r) => ({ ...FLOW, ...r.flow });

function tableKey(r, table, create = false) {
  const now = Date.now();
  let hit = Object.entries(db.tableKeys).find(([, x]) => x.r === r.id && x.table === table);
  if (hit && now - hit[1].last > KEY_IDLE_MS) { delete db.tableKeys[hit[0]]; hit = null; }
  if (!hit && create) {
    const key = crypto.randomBytes(9).toString('base64url');
    db.tableKeys[key] = { r: r.id, table, at: now, last: now, guests: {} };
    hit = [key, db.tableKeys[key]];
    save();
  }
  return hit ? { key: hit[0], s: hit[1] } : null;
}
// Любое действие за столом (заказ, вызов, новый телефон, официант) продлевает ключ ещё на 4 часа
function touchTable(r, table) {
  const k = tableKey(r, table);
  if (k) k.s.last = Date.now();
}
function dropTableKey(r, table) {
  for (const [key, x] of Object.entries(db.tableKeys)) if (x.r === r.id && x.table === table) delete db.tableKeys[key];
}
// Номер нового гостя: следующий после всех, кто уже есть за столом (в подключениях и в открытых заказах)
function nextGuest(r, table, s) {
  const used = [1, ...Object.values(s?.guests || {}).map((g) => g.n)];
  for (const o of openAt(db.orders, r, table)) for (const i of o.items) used.push(i.g || o.guest || 1);
  return Math.max(...used) + 1;
}
// Имена гостей стола для подписей заказов: { номер: имя }
function guestNames(r, table) {
  const out = {};
  for (const o of openAt(db.orders, r, table)) if (o.guestName) out[o.guest] = o.guestName;
  for (const g of Object.values(tableKey(r, table)?.s.guests || {})) if (g.name) out[g.n] = g.name;
  return out;
}
// Кто делает запрос: планшет стола (d) или телефон гостя (k — ключ стола, g — личный ключ гостя)
function guestOf(x) {
  if (x.k || x.g) {
    const s = db.tableKeys[x.k], r = s && db.restaurants[s.r], g = s?.guests[x.g];
    if (!r || !g || Date.now() - s.last > KEY_IDLE_MS || !flowOf(r).phones) throw fail(410, 'visit ended');
    if (g.off) throw fail(410, 'phone disconnected');
    return { r, table: s.table, n: g.n, name: g.name, dev: '', phone: true };
  }
  const t = tableOf(x.d);
  return t && { ...t, n: 1, name: '', dev: x.d };
}

// Телефон гостя подключается по QR-коду: имя — по желанию (без имени — «Гость 2», «Гость 3»…)
function guestJoin(b) {
  const s = db.tableKeys[b.k], r = s && db.restaurants[s.r];
  if (!r || Date.now() - s.last > KEY_IDLE_MS || !flowOf(r).phones) throw fail(410, 'visit ended');
  if (Object.keys(s.guests).length >= 30) throw fail(429, 'too many phones');
  const g = crypto.randomBytes(12).toString('base64url'), n = nextGuest(r, s.table, s);
  s.guests[g] = { n, name: String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 24), at: Date.now() };
  s.last = Date.now();
  logEvent(r.id, 'phone_join', { table: s.table, n });
  save();
  return { g, n, name: s.guests[g].name };
}

// Карусель простоя: акции и блюда ресторана, через каждые две — внешняя реклама (кроме тарифа Premium)
function slidesFor(r, dev) {
  const own = [
    ...(r.promos || []).filter((p) => p.active && p.image).map((p) => ({
      type: 'promo', id: p.id, image: p.image, images: p.images || {}, phone: p.phone || '', off: p.langOff || [], // текст акции — на самой картинке
      // кнопка на слайде: «Заказать · цена» или «Заказать по акции» (строка меню создаётся сама)
      order: promoMode(p) !== 'none' && (r.menu || []).some((i) => i.id === `promo-${p.id}` && onMenu(i)) ? `promo-${p.id}` : '',
      price: promoMode(p) === 'price' ? p.price : 0,
      qr: p.link ? `${PUBLIC_URL}/go/p/${p.id}?r=${r.id}` : '', ...qrPlace(p), ...framing(p),
    })),
    // блюдо — только с галочкой «В показе акций» (блюдо дня без неё остаётся в меню и в советах персонажа)
    ...(r.menu || []).filter((i) => i.promo && i.photo && onMenu(i)).map((i) => ({ type: 'item', id: i.id, image: i.photo, title: i.name, price: i.price })),
  ];
  const ads = r.tariff === 'premium' ? [] : db.ads
    .filter((a) => a.active && a.image && adReaches(a, r) && !(r.blockedAds || []).includes(a.id)
      && !blockedCats(r).includes(a.cat || 'other'))
    .map((a) => ({
      // strict — без картинки на языке гостя реклама не показывается (у акций — запасная картинка)
      type: 'ad', id: a.id, image: a.image, images: a.images || {}, off: a.langOff || [], strict: true,
      phone: a.phone || '', // рекламодатель и название — только для поиска в портале
      qr: a.link ? `${PUBLIC_URL}/go/a/${a.id}?r=${r.id}${dev ? `&d=${encodeURIComponent(dev)}` : ''}` : '', ...qrPlace(a), ...framing(a),
      cta: a.cta?.enabled ? publicCta(a.cta) : null,
    }));
  // ИИ-персонаж — первым слайдом карусели
  // ИИ-персонаж в список не входит: планшет вставляет его в карусель по своему расписанию
  if (!own.length || !ads.length) return own.length ? own : ads;
  // Реклама — после каждых N слайдов ресторана (настройка ресторана в админке). Карусель крутит этот круг по кругу,
  // поэтому в круг входит каждая реклама хотя бы раз: если своих слайдов мало, они повторяются
  // (2 слайда ресторана, 3 рекламы, N = 2 → А1 А2 Р1 А1 А2 Р2 А1 А2 Р3)
  const n = { ...DISPLAY, ...r.display }.adEvery, out = [];
  let a = 0;
  for (let j = 0; j < 1000; j++) {
    out.push(own[j % own.length]);
    if ((j + 1) % n === 0) out.push(ads[a++ % ads.length]);
    if (j + 1 >= own.length && a >= ads.length && (j + 1) % n === 0) break;
  }
  return out;
}

// Показы рекламы за последние 7 дней: по ресторану или по всей сети (rid = '*')
function views(adId, rid = '*') {
  let n = 0;
  for (let k = 0; k < 7; k++) n += db.stats[`${adId}|${rid}|${day(Date.now() - k * 864e5)}`] || 0;
  return n;
}

function scans(id, rid = '*') {
  let n = 0;
  for (let k = 0; k < 7; k++) n += db.stats[`scan|${id}|${rid}|${day(Date.now() - k * 864e5)}`] || 0;
  return n;
}

// Скан QR из рекламы или акции: считаем и перенаправляем на ссылку рекламодателя
function qrRedirect(kind, id, rid, dev) {
  const r = db.restaurants[rid];
  const target = kind === 'a' ? db.ads.find((a) => a.id === id) : (r?.promos || []).find((p) => p.id === id);
  if (!target?.link || !/^https?:\/\//.test(target.link)) return null;
  for (const key of [`scan|${id}|${rid}|${day()}`, `scan|${id}|*|${day()}`]) db.stats[key] = (db.stats[key] || 0) + 1;
  if (kind === 'a' && db.devices[dev]?.restaurantId === rid) bump(`dscan|${dev}|${day()}`); // скан рекламы с этого планшета
  save();
  return target.link;
}

// ИИ-персонаж ресторана: включён и выбран из библиотеки персонажей
// Персонаж доступен ресторану, только если администратор разрешил его в портале
const charAllowed = (c, r) => !!c && (c.restaurants || []).includes(r.id);

// Персонаж для планшета: фразы ресторана, а где своих нет — из пакета персонажа
function avatarFor(r) {
  const a = { ...AVATAR, ...r.avatar };
  const c = a.enabled && db.characters.find((x) => x.id === a.characterId);
  if (!charAllowed(c, r)) return null;
  const L = a.lines?.[c.id] || {}, own = (k, def) => (L[k]?.length ? L[k] : def || []);
  const { restaurants, ...pack } = c;
  return {
    ...pack, tts: !!(db.eleven.key && c.voice?.eleven), ...pick(a, ['speak', 'everyMin', 'durationSec', 'startWith', 'filters']),
    greetings: own('greetings', c.greetings),
    phrases: { recommend: own('recommend', c.phrases?.recommend), dayDish: own('dayDish', c.phrases?.dayDish) },
  };
}

// Показ слайда: реклама (как раньше), акция ресторана или появление ИИ-персонажа
function guestImpression(b) {
  const d = db.devices[b.d];
  const rid = d?.restaurantId, r = db.restaurants[rid];
  if (!r) throw fail(400, 'bad impression');
  if (b.kind === 'avatar') bump(`avshow|${rid}|${day()}`);
  else if ((r.promos || []).some((p) => p.id === b.id)) bump(`imp|${b.id}|${rid}|${day()}`);
  else if (db.ads.some((a) => a.id === b.id)) for (const key of [`${b.id}|${rid}|${day()}`, `${b.id}|*|${day()}`, `dimp|${b.d}|${day()}`]) bump(key);
  else throw fail(400, 'bad impression');
  save();
  return {};
}

// Действия гостя с ИИ-персонажем: разговор, рекомендация, «Показать блюдо», «Добавить» (не больше 200 в час на планшет)
const guestEventBudget = new Map();
function guestEvent(b) {
  const t = tableOf(b.d);
  if (!t || !['av_talk', 'av_rec', 'av_dish', 'av_add'].includes(b.k)) throw fail(400, 'bad event');
  const hour = Math.floor(Date.now() / 3600e3), bud = guestEventBudget.get(b.d);
  const n = bud?.hour === hour ? bud.n : 0;
  if (n >= 200) return {};
  guestEventBudget.set(b.d, { hour, n: n + 1 });
  logEvent(t.r.id, b.k, { table: t.table, dev: b.d, dish: String(b.dish || '').slice(0, 40) || undefined, lang: b.lang });
  return {};
}

// Первый вызов или заказ за свободным столом — «стол открыт» (до «Закрыть стол»)
const tableIsFree = (r, table) => !openAt(db.calls, r, table).length && !openAt(db.orders, r, table).length;

async function guestState(b, q) {
  if (q.k) return phoneState(q);
  await pullDevice(q.d);
  const d = db.devices[q.d];
  if (d && !q.preview) d.pageSeen = Date.now(); // страница планшета открыта (предпросмотр в ЛК — не считается)
  const r = d && db.restaurants[d.restaurantId];
  if (!r || (!d.table && d.role !== 'entrance')) return { unassigned: true };
  const base = {
    restaurant: { name: r.name, langs: r.langs, address: r.address || '', district: DISTRICTS.find((x) => x.id === r.district) || null },
    build: BUILD, instance: INSTANCE, version: VERSION,
    timers: pick(timersOf(r), ['cartMin', 'langMin']), visit: r.visits?.[d.table] || 0,
    menu: guestMenuOf(r), tags: r.customTags || [],
    slides: slidesFor(r, d.id),
    display: { ...DISPLAY, ...r.display, palette: themeOf(r.display?.theme) }, menuCats: r.menuCats || {},
    avatar: avatarFor(r),
  };
  // Планшет у входа: только витрина — карусель и просмотр меню, без заказов и вызовов
  if (d.role === 'entrance') return { ...base, mode: 'entrance' };
  const k = flowOf(r).phones && tableKey(r, d.table, true);
  return {
    ...base, mode: 'table', table: d.table, me: { n: 1 }, guests: guestNames(r, d.table), kitchen: flowOf(r).kitchenScreen,
    calls: openAt(db.calls, r, d.table).filter((c) => c.status !== 'done'),
    orders: openAt(db.orders, r, d.table),
    // QR-код «Заказ с телефона» и сколько телефонов уже подключено
    join: k ? { url: `${PUBLIC_URL}/t/${k.key}`, phones: Object.values(k.s.guests).filter((g) => !g.off).length } : null,
  };
}

// Телефон гостя: меню, заказы и вызовы стола, без карусели и персонажа. Без личного ключа — экран «Как вас зовут?»
function phoneState(q) {
  const s = db.tableKeys[q.k], r = s && db.restaurants[s.r];
  if (!r || Date.now() - s.last > KEY_IDLE_MS || !flowOf(r).phones) return { ended: 'expired' };
  const base = {
    restaurant: { name: r.name, langs: r.langs }, build: BUILD, instance: INSTANCE, table: s.table, mode: 'phone',
    display: { ...DISPLAY, ...r.display, palette: themeOf(r.display?.theme) }, menuCats: r.menuCats || {},
  };
  if (!q.g) return { ...base, join: true };
  let w;
  try { w = guestOf(q); } catch (e) { return { ended: e.message === 'phone disconnected' ? 'off' : 'expired' }; }
  return {
    ...base, menu: (r.menu || []).filter(onMenu), tags: r.customTags || [], slides: [], avatar: null,
    me: { n: w.n, name: w.name }, guests: guestNames(r, s.table), kitchen: flowOf(r).kitchenScreen,
    calls: openAt(db.calls, r, s.table).filter((c) => c.status !== 'done'),
    orders: openAt(db.orders, r, s.table),
  };
}

// Номер запроса с планшета (rid): после обрыва планшет отправляет заказ или вызов повторно — второй раз не создаём
const ridOf = (b) => (typeof b.rid === 'string' ? b.rid.slice(0, 40) : '');
function byRid(list, rid, restaurantId) {
  if (!rid) return null;
  for (let i = list.length - 1, n = 0; i >= 0 && n < 3000; i--, n++) {
    const x = list[i];
    if (x.rid === rid && x.restaurantId === restaurantId) return x;
    if (Date.now() - x.at > 2 * 3600_000) break;
  }
  return null;
}

function guestCall(b) {
  const t = guestOf(b);
  if (!t) throw fail(400, 'device is not assigned');
  if (!['waiter', 'bill'].includes(b.type)) throw fail(400, 'bad call type');
  const rid = ridOf(b), dup = byRid(db.calls, rid, t.r.id);
  if (dup) return dup;
  // Счёт: «мой» (scope — номер гостя) или всего стола (0). Повторное нажатие не создаёт второй вызов
  const scope = b.type === 'bill' && b.scope === 'me' ? t.n : 0;
  let c = openAt(db.calls, t.r, t.table).find((x) => x.type === b.type && x.status !== 'done' && (x.scope || 0) === scope);
  // «Спросить официанта» у блюда с заказом через официанта: в вызове — какое блюдо
  const m = b.type === 'waiter' && b.item ? (t.r.menu || []).find((x) => x.id === b.item && onMenu(x)) : null;
  const about = m ? { id: m.id, name: m.name } : null;
  if (c && about) { c.about = about; c.notifiedAt = 0; }
  if (!c) {
    if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
    c = { id: uid(), restaurantId: t.r.id, table: t.table, type: b.type, status: 'new', at: Date.now(), guest: t.n, guestName: t.name, scope, ...(rid ? { rid } : {}), ...(about ? { about } : {}) };
    db.calls.push(c);
    logEvent(t.r.id, 'call', { id: c.id, table: t.table, dev: t.dev || undefined, type: b.type, lang: b.lang, guest: t.n, phone: t.phone ? 1 : undefined, ...(about ? { item: about.id } : {}) });
  }
  touchTable(t.r, t.table);
  // Гость нажал ещё раз — напоминаем, но не чаще раза в 20 секунд
  if (Date.now() - (c.notifiedAt || 0) > 20_000) {
    c.notifiedAt = Date.now();
    // счёт: для кого (гость или весь стол) и на какую сумму — по неоплаченным строкам
    if (b.type === 'bill') {
      const due = openAt(db.orders, t.r, t.table).filter((o) => o.status !== 'rejected').reduce((a, o) => a + o.items
        .filter((i) => !i.paidAt && !o.paidAt && (!scope || (i.g || o.guest || 1) === scope)).reduce((x, i) => x + i.price * i.qty, 0), 0);
      notify(t.r.id, t.table, 'bill', ` · ฿${due.toLocaleString('en')}`, false, scope ? t : 'table', c.id);
    } else notify(t.r.id, t.table, b.type, c.about ? ` · 🙋 ${c.about.name.en || c.about.name.ru || Object.values(c.about.name)[0] || ''}` : '', false, t.n > 1 ? t : null, c.id);
  }
  save();
  return c;
}

// Почему гость отменил вызов (спрашиваем на планшете, если вызову больше 15 с): официант подошёл, но не нажал «Иду»;
// не дождались; уже не нужно; нажали случайно — для статистики ресторана
const CANCEL_WHY = new Set(['came', 'waited', 'notneeded', 'mistake']);
function guestCancelWhy(b) {
  const t = guestOf(b);
  if (!t) throw fail(400, 'device is not assigned');
  const c = db.calls.find((x) => x.id === b.id && x.restaurantId === t.r.id && x.table === t.table && x.cancelled && Date.now() - x.cancelled < 10 * 60_000);
  if (!c || !CANCEL_WHY.has(b.why) || c.cancelWhy) return {};
  c.cancelWhy = b.why;
  logEvent(t.r.id, 'call_why', { id: c.id, table: t.table, type: c.type, why: b.why });
  save();
  return {};
}
// Гость отменил вызов (нажал по ошибке): вызов пропадает у официантов. Случайный вызов за свободным
// столом — стол снова свободен
function guestCancel(b) {
  const t = guestOf(b);
  if (!t) throw fail(400, 'device is not assigned');
  const open = openAt(db.calls, t.r, t.table);
  const c = open.find((x) => (b.id ? x.id === b.id : x.type === b.type) && x.status !== 'done');
  if (!c) return {};
  Object.assign(c, { status: 'done', doneAt: Date.now(), cancelled: Date.now() });
  logEvent(t.r.id, 'call_cancel', { id: c.id, table: t.table, dev: t.dev || undefined, type: c.type, ms: Date.now() - c.at });
  touchTable(t.r, t.table);
  if (open.length === 1 && !openAt(db.orders, t.r, t.table).length) {
    c.closed = Date.now();
    logEvent(t.r.id, 'close', { table: t.table, guest: true });
  }
  save();
  return {};
}

function guestOrder(b) {
  const t = guestOf(b);
  if (!t) throw fail(400, 'device is not assigned');
  const rid = ridOf(b), dup = byRid(db.orders, rid, t.r.id);
  if (dup) return dup;
  // каждая строка — гостя, который заказал (официант потом может перенести её на другого гостя)
  const items = buildItems(t.r, b.items, true).map((i) => ({ ...i, g: t.n }));
  if (!items.length) throw fail(400, 'empty order');
  if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
  const o = {
    id: uid(), restaurantId: t.r.id, table: t.table, items,
    total: items.reduce((s, i) => s + i.price * i.qty, 0), status: 'pending', at: Date.now(), notifiedAt: Date.now(),
    guest: t.n, guestName: t.name, src: t.phone ? 'phone' : 'tablet', ...(rid ? { rid } : {}),
    hist: [{ t: Date.now(), k: 'new', by: t.name || '', src: t.phone ? 'phone' : 'tablet', g: t.n }],
  };
  db.orders.push(o);
  logEvent(t.r.id, 'order', { id: o.id, table: t.table, dev: t.dev || undefined, total: o.total, items: items.map((i) => [i.id, i.qty, i.price]), lang: b.lang, guest: t.n, phone: t.phone ? 1 : undefined });
  touchTable(t.r, t.table);
  notify(t.r.id, t.table, 'order', ` · ฿${o.total}`, false, t.n > 1 ? t : null, o.id);
  save();
  return o;
}

// Строки заказа по меню: цены и названия берём из меню, а не из запроса
// «Заказ через официанта»: включено в ЛК или цена ฿0 (вино в ассортименте, рыба по весу) — гость видит «Цена у официанта»
// и «Спросить официанта» вместо «Добавить». Бесплатные акции и блюда с платными вариантами — как обычно
const askOf = (i) => !!i.askWaiter || (!i.fromPromo && !(Number(i.price) > 0) && !(i.options || []).some((o) => Number(o.price) > 0)
  && !(i.groups || []).some((g) => g.opts.some((o) => Number(o.price) > 0)));
const guestMenuOf = (r) => (r.menu || []).filter(onMenu).map((i) => (askOf(i) ? { ...i, ask: true } : i));
function buildItems(r, list, guest = false) {
  const menu = new Map((r.menu || []).filter(onMenu).map((i) => [i.id, i]));
  return (list || [])
    .filter((x) => menu.has(x.id) && x.qty > 0 && !(guest && askOf(menu.get(x.id))))
    .slice(0, 50)
    .map((x) => {
      const m = menu.get(x.id);
      const opt = x.opt ? (m.options || []).find((o) => o.key === x.opt) : null;
      // К названию добавляем вариант: «Пиво · 500 мл»
      const name = opt
        ? Object.fromEntries(Object.entries(m.name).map(([l, v]) => [l, `${v} · ${opt.label[l] || Object.values(opt.label)[0] || ''}`]))
        : m.name;
      const g = Math.round(Number(x.g));
      // Выбор в группах (начинка, острота, добавки): цена — из меню, а не с планшета; без выбора — как по умолчанию в источнике
      const want = Array.isArray(x.mods) ? new Set(x.mods.map(String)) : null, picked = [];
      for (const gr of m.groups || []) {
        let sel = gr.opts.filter((o) => (want ? want.has(o.id) : o.def));
        if (gr.type === 'one') sel = sel.slice(0, 1);
        if (gr.req && !sel.length && gr.opts.length) sel = [gr.opts.find((o) => o.def) || gr.opts[0]];
        picked.push(...sel);
      }
      const ml = picked.length ? Object.fromEntries([...new Set(picked.flatMap((o) => Object.keys(o.name)))].map((l) => [l,
        picked.map((o) => o.name[l] || Object.values(o.name)[0] || '').join(' · ')])) : undefined;
      const price = (Number(opt ? opt.price : m.price) || 0) + picked.reduce((a, o) => a + (Number(o.price) || 0), 0);
      return {
        id: m.id, opt: opt?.key || '', name, price, qty: Math.min(99, x.qty | 0), ...(g >= 1 && g <= 99 ? { g } : {}),
        ...(picked.length ? { mods: picked.map((o) => o.id), ml } : {}),
      };
    });
}

// ---------- Персонал: вход по коду ресторана + личному PIN, уведомления через Web Push

const PUSH_TEXT = {
  en: { kitchen: 'Send the order to the kitchen', check: '✅ You are on shift — notifications work', lost: 'not delivered to {n}', table: 'Table', waiter: 'Waiter call', bill: 'Bill requested', order: 'New order', again: 'Reminder', guest: 'Guest', ready: 'Order is ready', wholeTable: 'whole table', test: 'Test: notifications work' },
  th: { kitchen: 'ส่งออร์เดอร์เข้าครัว', check: '✅ คุณเข้ากะแล้ว — การแจ้งเตือนใช้งานได้', lost: 'ส่งไม่ถึง {n}', table: 'โต๊ะ', waiter: 'เรียกพนักงาน', bill: 'ขอเช็คบิล', order: 'ออร์เดอร์ใหม่', again: 'เตือนอีกครั้ง', guest: 'แขก', ready: 'อาหารพร้อมเสิร์ฟ', wholeTable: 'ทั้งโต๊ะ', test: 'ทดสอบ: การแจ้งเตือนใช้งานได้' },
  ru: { kitchen: 'Отправьте заказ на кухню', check: '✅ Вы на смене — уведомления работают', lost: 'не дошло до {n}', table: 'Стол', waiter: 'Вызов официанта', bill: 'Просят счёт', order: 'Новый заказ', again: 'Напоминание', guest: 'Гость', ready: 'Заказ готов', wholeTable: 'весь стол', test: 'Проверка: уведомления приходят' },
  my: { kitchen: 'အော်ဒါကို မီးဖိုချောင်သို့ ပို့ပါ', check: '✅ သင် တာဝန်ချိန်ရောက်ပြီ — အသိပေးချက်များ အလုပ်လုပ်သည်', lost: '{n} ထံ မရောက်ပါ', table: 'စားပွဲ', waiter: 'စားပွဲထိုး ခေါ်နေသည်', bill: 'ဘေလ် တောင်းနေသည်', order: 'အော်ဒါ အသစ်', again: 'သတိပေးချက်', guest: 'ဧည့်သည်', ready: 'အော်ဒါ အဆင်သင့် ဖြစ်ပြီ', wholeTable: 'စားပွဲတစ်ခုလုံး', test: 'စမ်းသပ်: အသိပေးချက်များ အလုပ်လုပ်သည်' },
};

function session(token) {
  const s = db.sessions[token];
  const r = s && db.restaurants[s.restaurantId];
  const member = r && (r.staff || []).find((m) => m.id === s.staffId);
  if (!member) throw fail(401, 'not signed in');
  return { s, r, member };
}

function staffLogin(b) {
  const r = Object.values(db.restaurants).find((x) => x.staffCode === String(b.code || '').trim());
  const member = r && (r.staff || []).find((m) => m.pin === String(b.pin || '').trim());
  if (!member) throw fail(403, 'wrong code or pin');
  const token = crypto.randomBytes(18).toString('base64url');
  db.sessions[token] = { restaurantId: r.id, staffId: member.id, at: Date.now(), onShift: true, shiftAt: Date.now(), subs: [], lang: b.lang || 'en' };
  logEvent(r.id, 'shift', { by: member.id, bn: member.name, on: true });
  setShift(r.id, member.id, true, db.sessions[token]);
  shiftCheck(db.sessions[token], 8000); // приложение успеет оформить подписку
  save();
  return { token };
}

// Планшеты столов для схемы зала официанта: не на связи (выключен, сел, нет сети больше 3 минут) — «включить»;
// заряд 10% и меньше (планшеты сообщают заряд шагами по 10%) и не заряжается — «на зарядку». Несколько планшетов — по худшему
function tabletsOf(r, now = Date.now()) {
  const out = {};
  for (const d of Object.values(db.devices)) {
    if (d.restaurantId !== r.id || !d.table || d.role === 'entrance' || !d.lastSeen) continue;
    const t = d.telemetry || {}, bat = Number(t.battery);
    const off = now - d.lastSeen > 3 * 60_000 || (d.offAt && d.offAt >= d.lastSeen - 1000) || t.screen === false;
    const x = { off: !!off, since: off ? Math.min(d.lastSeen, d.offAt || d.lastSeen) : 0, bat: Number.isFinite(bat) ? bat : null, chg: !!t.charging };
    const bad = (y) => (y.off ? 2 : y.bat !== null && y.bat <= 10 && !y.chg ? 1 : 0);
    if (!out[d.table] || bad(x) > bad(out[d.table])) out[d.table] = x;
  }
  return out;
}
function staffState(b, q) {
  const { s, r, member } = session(q.token);
  s.seenAt = Date.now(); // приложение открыто — для автоконца смены без часов работы
  return {
    restaurant: { name: r.name, pos: r.menuSource?.type === 'pos', tables: r.tables || [] },
    build: BUILD, instance: INSTANCE, version: VERSION,
    me: {
      name: member.name, role: member.role, onShift: s.onShift, push: s.subs.length > 0, pushLast: pushLastOf(s),
      pushLog: (s.pushLog || []).map(({ ack, ...x }) => ({ ...x, ...pushRefState(x) })).reverse(), pushTestAt: s.pushTestAt || 0,
      deaf: s.onShift ? deafOf(s) : null,
      lastAct: s.lastAct && Date.now() - s.lastAct.at < UNDO_MS ? { id: s.lastAct.id, act: s.lastAct.act, table: s.lastAct.table, ids: s.lastAct.ids || [] } : null,
    },
    team: teamOf(r),
    floor: floorOf(r),
    tablets: tabletsOf(r),
    // «Столы» официанта: его столы из ЛК менеджера, а если не назначены — все столы ресторана
    myTables: (r.tables || []).filter((tb) => member.role === 'manager' || !member.tables?.length || servesTable(member.tables, tb)),
    vapidKey: db.vapid.publicKey,
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    forgotten: forgottenFor(r, member),
    flow: pick(flowOf(r), ['phones', 'kitchenBtn', 'kitchenScreen']), customTags: r.customTags || [],
    kitchenDown: flowOf(r).kitchenScreen ? kitchenDown[r.id] || 0 : 0, // экран кухни не на связи с этого времени
    // телефоны гостей по столам (официант может отключить чужой) и имена гостей для подписей
    phones: Object.fromEntries((r.tables || []).map((tb) => [tb, Object.values(tableKey(r, tb)?.s.guests || {})
      .filter((g) => !g.off).map((g) => ({ n: g.n, name: g.name }))]).filter(([, l]) => l.length)),
    guests: Object.fromEntries((r.tables || []).map((tb) => [tb, guestNames(r, tb)])),
    // у блюд — отметки из меню (не острое, без глютена…): официант видит их хештегами в заказе
    orders: db.orders.filter((o) => o.restaurantId === r.id && !o.closed).map((o) => ({
      ...o, items: o.items.map((i) => ({ ...i, tags: (r.menu || []).find((m) => m.id === i.id)?.tags || [] })),
    })),
  };
}

// Заказ на стол от официанта или менеджера: сразу принят (реакции ждать не от кого)
// Обязательная группа выбора (острота, начинка…), в которой официант ничего не выбрал: «Блюдо — Группа».
// Строки без списка выбора (старые заказы) не проверяем
function missingChoice(r, list) {
  const menu = new Map((r.menu || []).map((i) => [i.id, i]));
  const nm = (o) => o?.ru || o?.en || Object.values(o || {})[0] || '';
  for (const x of list || []) {
    const m = menu.get(x?.id);
    if (!m || !Array.isArray(x.mods)) continue;
    const want = new Set(x.mods.map(String));
    const g = (m.groups || []).find((gr) => gr.req && gr.opts.length && !gr.opts.some((o) => want.has(o.id)));
    if (g) return `${nm(m.name)} — ${nm(g.name)}`;
  }
  return '';
}
const itemsSig = (items) => items.map((i) => `${i.id}|${i.opt || ''}|${(i.mods || []).join(',')}|${i.qty}`).sort().join(';');

function staffOrder(b) {
  const { s: ses } = session(b.token);
  const n = db.orders.length;
  capture = [];
  let o;
  try { o = staffOrderDo(b); } finally { var evs = capture; capture = null; }
  // новый заказ официанта — его можно отменить сразу («↩ Отменить «Новый заказ»»)
  if (db.orders.length > n && o?.id) {
    ses.lastAct = { id: uid(), act: 'order:new', table: o.table, at: Date.now(), before: [], created: [o.id], after: [{ type: 'order', id: o.id, json: JSON.stringify(o) }], events: evs, ids: [o.id] };
    save();
  }
  return o;
}
function staffOrderDo(b) {
  const { s: ses, r, member } = session(b.token);
  if (!ses.onShift) throw fail(403, OFF_SHIFT);
  ses.actAt = Date.now();
  const table = String(b.table || '');
  if (!(r.tables || []).includes(table)) throw fail(400, 'unknown table');
  // повтор того же запроса (плохой Wi-Fi, многократное нажатие) — тот же заказ, второй не создаём
  const rid = ridOf(b), dup = byRid(db.orders, rid, r.id);
  if (dup) return dup;
  const miss = missingChoice(r, b.items);
  if (miss) throw fail(400, `Не выбран обязательный вариант: ${miss}`);
  const guest = Math.min(99, Math.max(1, Math.round(Number(b.guest)) || 1));
  const items = buildItems(r, b.items).map((i) => ({ ...i, g: guest }));
  if (!items.length) throw fail(400, 'empty order');
  // страховка: такой же заказ того же официанта на тот же стол за последние 15 секунд — это повтор
  const sig = itemsSig(items);
  const same = db.orders.slice(-200).find((o) => o.restaurantId === r.id && o.src === 'staff' && o.table === table && o.by === member.name
    && Date.now() - o.at < 15_000 && o.status !== 'rejected' && itemsSig(o.items) === sig);
  if (same) return same;
  if (tableIsFree(r, table)) logEvent(r.id, 'open', { table });
  const now = Date.now();
  const o = {
    id: uid(), restaurantId: r.id, table, items, total: items.reduce((s, i) => s + i.price * i.qty, 0),
    status: 'confirmed', at: now, confirmedAt: now, ackAt: now, ackBy: member.name, by: member.name, src: 'staff',
    guest, guestName: guestNames(r, table)[guest] || '', ...(rid ? { rid } : {}),
    hist: [{ t: now, k: 'new', by: member.name, src: 'staff' }],
  };
  o.kitchenItems = kitchenSnap(o);
  db.orders.push(o);
  touchTable(r, table);
  logEvent(r.id, 'order', { id: o.id, table, total: o.total, items: items.map((i) => [i.id, i.qty, i.price]), by: member.id, bn: member.name, src: 'staff' });
  save();
  return o;
}

// Что ушло на кухню: блюда заказа одной строкой на блюдо (гости кухне не важны) — { "id|вариант": { name, qty } }.
// Снимок делается при подтверждении и при «Готово»; правка официанта потом видна на кухне как разница с ним
function kitchenSnap(o) {
  const out = {};
  for (const i of o.items) {
    const k = lineKey(i);
    out[k] = { name: i.name, ml: i.ml, qty: (out[k]?.qty || 0) + i.qty };
  }
  return out;
}

// ---------- История заказа: кто что сделал и когда. Видна официантам в карточке заказа, кухне — правки и «переделать»,
// менеджеру — в журнале визитов статистики (там же после закрытия стола)
// [[название, сколько, выбранное гостем], …] из снимка блюд заказа (kitchenSnap); названия — на всех языках меню,
// экран показывает на своём
const snapLines = (r, snap) => Object.values(snap).filter((v) => v.qty > 0).map((v) => (v.ml ? [v.name, v.qty, v.ml] : [v.name, v.qty]));
// Что изменилось между двумя снимками: добавлено и убрано
function snapDiff(r, a, b) {
  const add = {}, del = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k]?.qty || 0) - (a[k]?.qty || 0), v = { ...(b[k] || a[k]), qty: Math.abs(d) };
    if (d > 0) add[k] = v;
    else if (d < 0) del[k] = v;
  }
  return { add: snapLines(r, add), del: snapLines(r, del) };
}
function hist(x, k, by, extra = {}) {
  (x.hist ||= []).push({ t: Date.now(), k, by: by || '', ...extra });
  if (x.hist.length > 60) x.hist.splice(0, x.hist.length - 60);
}
const noteOf = (b) => String(b.note || '').trim().slice(0, 200);

// ---------- Экран кухни: подтверждённые заказы по ссылке из ЛК менеджера (без входа); повар отмечает «Готово»,
// официанты стола получают уведомление «Заказ готов»
function kitchenRest(k) {
  const r = Object.values(db.restaurants).find((x) => flowOf(x).kitchenScreen && x.flow?.kitchenKey && x.flow.kitchenKey === String(k || ''));
  if (!r) throw fail(403, 'bad kitchen link');
  return r;
}
// Экран кухни на связи? Он спрашивает заказы каждые 5 секунд. Молчит больше 2 минут (а «Экран кухни» включён) —
// официантам плашка, в Telegram (в часы работы) — «экран кухни не на связи»; вернулся — «снова на связи»
const kitchenSeen = {}, kitchenDown = {}, kitchenAlerted = {};
setInterval(() => {
  const now = Date.now();
  for (const r of Object.values(db.restaurants)) {
    const seen = kitchenSeen[r.id];
    if (!seen || !flowOf(r).kitchenScreen || now - seen < 120_000) continue;
    kitchenDown[r.id] ||= seen;
    if (!kitchenAlerted[r.id] && isWorking(r)) {
      kitchenAlerted[r.id] = true;
      tgAlert(`🔴 ${r.name}: экран кухни не на связи с ${clock(seen)} — официанты передают заказы на кухню сами и отмечают «🍽 Подано»`);
    }
  }
}, 30_000).unref();
function kitchenState(b, q) {
  const r = kitchenRest(q.k), now = Date.now(), tags = new Map((r.menu || []).map((m) => [m.id, m.tags || []]));
  if (kitchenDown[r.id]) {
    if (kitchenAlerted[r.id]) tgAlert(`🟢 ${r.name}: экран кухни снова на связи (не было ${fmtDur(now - kitchenDown[r.id])})`);
    delete kitchenDown[r.id];
    delete kitchenAlerted[r.id];
  }
  kitchenSeen[r.id] = now;
  // удалён как дубль или отменён — повар должен увидеть, пока не нажмёт «Понятно»
  const voidAt = (o) => o.removedAt || o.cancelledAt;
  const gone = (o) => voidAt(o) && o.kitchenItems && !o.readyAt && now - voidAt(o) < 30 * 60e3;
  const list = db.orders.filter((o) => o.restaurantId === r.id && ((o.status === 'confirmed' && !o.test
    && now - (o.confirmedAt || o.at) < 12 * 3600e3 && (!o.readyAt || now - o.readyAt < 15 * 60e3)) || gone(o)));
  return {
    restaurant: { name: r.name, langs: r.langs }, build: BUILD,
    orders: list.map((o) => {
      // блюда, разделённые между гостями, — одной строкой; was — сколько было, когда заказ ушёл на кухню
      // отменён/удалён — зачёркнуто всё, что кухня видела, включая добавленное после отправки
      const cur = voidAt(o) ? {} : kitchenSnap(o), was = voidAt(o) ? { ...kitchenSnap(o), ...o.kitchenItems } : o.kitchenItems || kitchenSnap(o);
      // «Переделать»: на карточке — только то, что вернули, плюс правки официанта после этого
      const redo = o.redo && o.redo.at === o.cookFrom && !voidAt(o) ? o.redo : null;
      const line = (k, src) => ({ name: src.name, ml: src.ml, tags: tags.get(k.split('|')[0]) || [] });
      const keys = [...new Set([...Object.keys(was), ...Object.keys(cur)])];
      let items = keys.map((k) => ({ ...line(k, cur[k] || was[k]), qty: cur[k]?.qty || 0, was: was[k]?.qty || 0 }));
      const changed = items.some((i) => i.qty !== i.was);
      if (redo) items = [...Object.entries(redo.items).map(([k, v]) => ({ ...line(k, v), qty: v.qty, was: v.qty, redo: true })), ...items.filter((i) => i.qty !== i.was)];
      return {
        id: o.id, table: o.table, at: o.cookFrom || o.confirmedAt || o.at, readyAt: o.readyAt || 0, editedAt: o.editedAt || 0, readyBy: o.readyBy || '',
        editedBy: o.editedBy || '', changed, items, removed: !!o.removedAt,
        cancelled: o.cancelledAt ? { by: o.cancelledBy || '', note: o.cancelNote || '' } : null,
        redo: redo ? { by: redo.by, note: redo.note || '' } : null,
      };
    }),
  };
}
function kitchenReady(b) {
  const r = kitchenRest(b.k);
  const o = db.orders.find((x) => x.id === b.id && x.restaurantId === r.id && (x.status === 'confirmed' || x.removedAt || x.cancelledAt));
  if (!o) throw fail(400, 'bad order');
  if (o.removedAt || o.cancelledAt) { o.readyAt = Date.now(); save(); return {}; } // повар увидел «удалён/отменён» — убираем карточку
  if (b.undo) {
    if (o.readyAt) hist(o, 'undo', '');
    delete o.readyAt; delete o.readyBy;
  } else if (!o.readyAt) {
    o.readyAt = Date.now();
    hist(o, 'ready', '');
    o.kitchenItems = kitchenSnap(o); // кухня приготовила это — следующие правки покажутся как новые
    logEvent(r.id, 'order_ready', { id: o.id, table: o.table, ms: o.readyAt - (o.confirmedAt || o.at) });
    notify(r.id, o.table, 'ready', '', false, null, o.id);
  }
  save();
  return {};
}

// Меню для правки заказа официантом
function staffMenu(b, q) {
  const { r } = session(q.token);
  return (r.menu || []).filter(onMenu).map(({ id, sku, name, price, options, groups }) => ({ id, sku, name, price, options, groups }));
}

// Смена — у человека, а не у входа: «На смене» / «Не на смене» переключает все его входы (старый вход на другом
// телефоне или после повторного входа иначе держал бы его «на смене» с «не приходят сообщения»)
const sessionsOf = (rid, staffId) => Object.values(db.sessions).filter((x) => x.restaurantId === rid && x.staffId === staffId);
function setShift(rid, staffId, on, except) {
  for (const x of sessionsOf(rid, staffId)) {
    if (x === except) continue;
    if (!x.onShift && on) x.shiftAt = Date.now();
    if (!on) { delete x.deaf; delete x.check; }
    x.onShift = on;
  }
}
function staffShift(b) {
  const { s, r, member } = session(b.token);
  if (s.onShift !== !!b.on) logEvent(r.id, 'shift', { by: member.id, bn: member.name, on: !!b.on });
  if (!s.onShift && b.on) { s.shiftAt = Date.now(); shiftCheck(s, 4000); } // приложение сразу обновит подписку — проверяем после
  if (!b.on) { delete s.deaf; delete s.check; }
  s.onShift = !!b.on;
  setShift(r.id, member.id, !!b.on, s);
  save();
  return {};
}

// Квитанции от телефона: служба уведомлений приняла — ещё не значит, что телефон получил. Обработчик уведомлений
// на телефоне сам сообщает: «получил» (когда пришло на самом деле) и «показал» / «ошибка показа»
const pushAcks = new Map(); // id → { s: сессия, at: когда отправили }
function pushAckId(s) {
  const id = crypto.randomBytes(9).toString('base64url');
  pushAcks.set(id, { s, at: Date.now() });
  if (pushAcks.size > 2000) pushAcks.delete(pushAcks.keys().next().value);
  return id;
}
// Журнал уведомлений телефона: последние 30 — когда отправили, что ответил Google, когда телефон получил и показал.
// Виден официанту внизу экрана «Вызовы» и в диагностике (/api/diag/push)
const PUSH_LOG = 30;
function pushRecord(s, sub, res, meta) {
  const x = { ...res, ...meta };
  s.pushLog = [...(s.pushLog || []), x].slice(-PUSH_LOG);
  delete s.pushLast; // раньше хранили только последнее — теперь это последняя строка журнала
  if (!res.ok) { s.subs = s.subs.filter((y) => y !== sub); x.dropped = true; }
  save();
  return x;
}
const pushLastOf = (s) => s.pushLog?.at(-1) || s.pushLast || null;
function staffPushAck(b) {
  const a = pushAcks.get(String(b.id || ''));
  if (!a) return {};
  const pl = (a.s.pushLog || []).find((x) => x.ack === b.id);
  if (pl && b.stage === 'got') {
    if (a.s.check?.ack === b.id) delete a.s.check; // проверка при начале смены дошла
    if (a.s.deaf) deafClear(a.s);
  }
  if (pl) {
    if (b.stage === 'got') pl.gotAt = Date.now();
    if (b.stage === 'shown') pl.shownAt = Date.now();
    if (b.stage === 'fail') pl.showErr = String(b.err || 'error').slice(0, 120);
    save();
  }
  return {};
}

// «Проверить уведомление»: через 10 секунд (успеть заблокировать экран) или через 6 минут — телефон успевает
// уснуть глубоко (так и теряются вызовы на телефонах с жёстким энергосбережением)
function staffPushTest(b) {
  const { s } = session(b.token);
  if (!s.subs.length) throw fail(400, 'no subscription');
  const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en, delay = Number(b.delay) === 360 ? 360_000 : 10_000;
  s.pushTestAt = Date.now() + delay;
  save();
  setTimeout(() => {
    if (s.pushTestAt && s.pushTestAt <= Date.now() + 1000) delete s.pushTestAt;
    for (const sub of s.subs) {
      const ack = pushAckId(s);
      sendPush(sub, { title: 'JET MEDIA', body: `✅ ${L.test || 'Test notification'}`, group: 'test', tag: `test-${Date.now()}`, ack }, db.vapid)
        .then((res) => pushRecord(s, sub, res, { kind: 'test', ack, delay: delay / 1000 }));
    }
  }, delay);
  return {};
}

function staffSubscribe(b, q, req) {
  const { s } = session(b.token);
  if (!b.sub?.endpoint || !b.sub.keys?.p256dh) throw fail(400, 'bad subscription');
  s.ua = String(req?.headers?.['user-agent'] || '').slice(0, 200); // модель телефона и браузер — для диагностики уведомлений
  // Вход — это один браузер на одном телефоне: у него одна подписка. Новая (например, свежая перед проверкой)
  // заменяет прежнюю — иначе уведомления уходили бы и на старую (ответ 410 «подписки нет») и дублировались в журнале
  s.subs = [b.sub];
  // уведомления не доходили (подписка умерла, не было подписки) — новая подписка: сразу проверяем, дошло ли
  if (s.onShift && s.deaf && !s.check?.wait) shiftCheck(s, 1000);
  if (PUSH_TEXT[b.lang]) s.lang = b.lang;
  save();
  return {};
}

function staffLogout(b) {
  const s = db.sessions[b.token];
  if (s?.onShift) logEvent(s.restaurantId, 'shift', { by: s.staffId, on: false });
  delete db.sessions[b.token];
  save();
  return {};
}

const NEXT = { call: { ack: 'ack', done: 'done' }, order: { confirm: 'confirmed', reject: 'rejected' } };

const OFF_SHIFT = 'Вы не на смене — нажмите «На смене», чтобы работать с вызовами и заказами';
// ---------- «↩ Отменить» последнее действие официанта (2 минуты). Перед действием запоминаем, какими были вызовы
// и заказы стола; отмена возвращает их как было — если после действия стол никто не менял. Закрытие стола,
// отключение телефона гостя и «Тестовый заказ» не отменяются (стол закрывается с подтверждением, тест — переключатель)
const UNDO_MS = 2 * 60e3;
const NO_UNDO = new Set(['table:close', 'table:paid', 'guest:off', 'order:test', 'order:untest']);
function undoTargets(b, r) {
  if (b.kind === 'table' || b.kind === 'guestpaid') return [...openAt(db.calls, r, b.id).map((x) => ['call', x]), ...openAt(db.orders, r, b.id).map((x) => ['order', x])];
  if (b.kind === 'call') return db.calls.filter((y) => y.id === b.id && y.restaurantId === r.id).map((x) => ['call', x]);
  if (b.kind === 'order') return db.orders.filter((y) => y.id === b.id && y.restaurantId === r.id).map((x) => ['order', x]);
  return [];
}
function staffAction(b) {
  const { s: ses, r } = session(b.token);
  const act = `${b.kind}:${b.action || ''}`, targets = NO_UNDO.has(act) ? [] : undoTargets(b, r);
  const snap = () => targets.map(([type, x]) => ({ type, id: x.id, json: JSON.stringify(x) }));
  const before = snap();
  capture = [];
  let res;
  try { res = staffActionDo(b); } finally { var evs = capture; capture = null; }
  const after = snap();
  if (NO_UNDO.has(act)) delete ses.lastAct;
  else if (after.some((a, i) => a.json !== before[i].json)) {
    ses.lastAct = { id: uid(), act, table: b.kind === 'table' || b.kind === 'guestpaid' ? b.id : targets[0][1].table, at: Date.now(), before, after, events: evs,
      ids: after.filter((a, i) => a.json !== before[i].json).map((a) => a.id) }; // в карточках этих вызовов и заказов — «↩ Отменить»
    save();
  }
  return res;
}
function staffUndo(b) {
  const { s: ses, r, member } = session(b.token);
  if (!ses.onShift) throw fail(403, OFF_SHIFT);
  const u = ses.lastAct;
  if (!u || u.id !== b.id || Date.now() - u.at > UNDO_MS) throw fail(400, 'Отменить уже нельзя — прошло больше 2 минут или после этого было другое действие');
  const find = (a) => (a.type === 'call' ? db.calls : db.orders).find((x) => x.id === a.id && x.restaurantId === r.id);
  if (u.after.some((a) => JSON.stringify(find(a)) !== a.json)) throw fail(409, 'Отменить нельзя: после этого стол уже изменился');
  const changed = u.before.filter((a) => u.after.find((x) => x.id === a.id)?.json !== a.json);
  for (const a of changed) { const x = find(a); for (const k of Object.keys(x)) delete x[k]; Object.assign(x, JSON.parse(a.json)); }
  // новый заказ официанта, созданный по ошибке: заказа как бы не было — со стола он уходит сразу (стол свободен, если на нём
  // больше ничего); кухня, если уже видела его, — увидит «отменён»; из статистики он уходит вместе с событиями
  for (const id of u.created || []) Object.assign(find({ type: 'order', id }), { status: 'rejected', rejectedAt: Date.now(), cancelledAt: Date.now(), cancelledBy: member.name, cancelNote: '↩', closed: Date.now() });
  if (u.act === 'order:remove') r.removedIds = (r.removedIds || []).filter((id) => !u.before.some((a) => a.id === id));
  for (const a of [...changed, ...(u.created || []).map((id) => ({ type: 'order', id }))]) if (a.type === 'order') hist(find(a), 'revert', member.name, { of: u.act });
  logEvent(r.id, 'undo', { by: member.id, bn: member.name, table: u.table, of: u.act, acts: u.events });
  delete ses.lastAct;
  save();
  return {};
}
function staffActionDo(b) {
  const { s: ses, r, member } = session(b.token);
  if (!ses.onShift) throw fail(403, OFF_SHIFT); // не на смене — только смотреть
  ses.actAt = Date.now();
  const who = { by: member.id, bn: member.name };
  const ackOrder = (x) => {
    if (x.ackAt) return;
    Object.assign(x, { ackAt: Date.now(), ackBy: member.name });
    logEvent(r.id, 'order_ack', { ...who, id: x.id, table: x.table, ms: x.ackAt - x.at, total: x.total });
  };
  // К оплате по строкам заказа (часть строк могли оплатить отдельные гости)
  const due = (x) => x.items.filter((i) => !i.paidAt).reduce((a, i) => a + i.price * i.qty, 0);
  const payAll = (x) => {
    const sum = due(x);
    x.items.forEach((i) => { i.paidAt ||= Date.now(); });
    Object.assign(x, { paidAt: Date.now(), paidBy: member.name });
    if (sum) logEvent(r.id, 'paid', { ...who, id: x.id, table: x.table, total: sum });
  };
  if (b.kind !== 'table' && b.kind !== 'guest' && b.kind !== 'guestpaid') {
    const x = [...db.calls, ...db.orders].find((y) => y.id === b.id && y.restaurantId === r.id);
    if (x) touchTable(r, x.table);
  }
  if (b.kind === 'table' && b.action === 'ack') {
    // «Иду» к столу — сразу по всем новым заказам и вызовам этого стола
    for (const x of openAt(db.orders, r, b.id)) if (x.status === 'pending') ackOrder(x);
    for (const c of openAt(db.calls, r, b.id).filter((y) => y.status === 'new')) {
      logEvent(r.id, 'call_ack', { ...who, id: c.id, table: c.table, type: c.type, ms: Date.now() - c.at });
      Object.assign(c, { status: 'ack', by: member.name, ackAt: Date.now() });
    }
    touchTable(r, b.id);
  } else if (b.kind === 'table') {
    // «Закрыть стол» или «Счёт оплачен» (когда касса не подключена): закрываем сессию стола, телефоны гостей отключаются
    for (const x of [...db.calls, ...db.orders]) {
      if (x.restaurantId !== r.id || x.table !== b.id || x.closed) continue;
      if (b.action === 'paid' && x.items && !x.paidAt && x.status !== 'rejected') payAll(x);
      x.closed = Date.now();
    }
    dropTableKey(r, b.id);
    // гости ушли: планшет стола возвращается к языку ресторана по умолчанию
    r.visits ??= {};
    r.visits[b.id] = Date.now();
    logEvent(r.id, 'close', { ...who, table: b.id });
  } else if (b.kind === 'guest' && b.action === 'off') {
    // Отключить телефон гостя (например, QR-код сфотографировал посторонний)
    for (const g of Object.values(tableKey(r, b.id)?.s.guests || {})) if (g.n === Number(b.n)) g.off = Date.now();
  } else if (b.kind === 'guestpaid') {
    // Гость оплатил свою часть: все его строки в заказах стола
    const n = Number(b.n) || 1;
    let sum = 0;
    for (const o of openAt(db.orders, r, b.id).filter((y) => y.status !== 'rejected')) {
      for (const i of o.items) if ((i.g || o.guest || 1) === n && !i.paidAt) { i.paidAt = Date.now(); sum += i.price * i.qty; }
      if (!o.paidAt && o.items.every((i) => i.paidAt)) Object.assign(o, { paidAt: Date.now(), paidBy: member.name });
    }
    if (sum) logEvent(r.id, 'paid', { ...who, table: b.id, total: sum, guest: n });
    touchTable(r, b.id);
  } else if (b.kind === 'order' && b.action === 'move') {
    // Разделение счёта: перенести блюдо (qty штук) на другого гостя; кухни это не касается
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && !y.closed && y.status !== 'rejected');
    const i = Number(b.line), it = x?.items[i], to = Math.round(Number(b.to));
    if (!it || it.paidAt || !(to >= 1 && to <= 99)) throw fail(400, 'bad action');
    const qty = Math.min(it.qty, Math.max(1, Math.round(Number(b.qty)) || 1));
    const same = x.items.find((y) => y !== it && lineKey(y) === lineKey(it) && (y.g || x.guest || 1) === to && !y.paidAt);
    if (same) same.qty += qty;
    else if (qty < it.qty) x.items.push({ ...it, qty, g: to });
    if (same || qty < it.qty) { it.qty -= qty; if (!it.qty) x.items.splice(i, 1); } else it.g = to;
  } else if (b.kind === 'order' && b.action === 'kitchen') {
    // «Заказ отправлен на кухню»: снимает напоминание; в статистике — время от заказа до кухни
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && y.status === 'confirmed');
    if (!x) throw fail(400, 'bad action');
    if (!x.kitchenAt) {
      Object.assign(x, { kitchenAt: Date.now(), kitchenBy: member.name });
      hist(x, 'kitchen', member.name);
      logEvent(r.id, 'order_kitchen', { ...who, id: x.id, table: x.table, ms: x.kitchenAt - x.at });
    }
  } else if (b.kind === 'order' && (b.action === 'test' || b.action === 'untest')) {
    // «Тестовый заказ» — только менеджер: весь визит стола с этим заказом не идёт в статистику
    if (member.role !== 'manager') throw fail(403, 'managers only');
    const o = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id);
    if (!o) throw fail(400, 'bad action');
    // весь визит стола, какой он сейчас (вызовы и заказы); новые заказы после этого — настоящие
    const ids = o.closed ? [o.id] : [...openAt(db.calls, r, o.table), ...openAt(db.orders, r, o.table)].map((x) => x.id);
    markTest(r, ids, b.action === 'test', member.name);
    audit(`${member.name} (менеджер)`, `Заказ ${b.action === 'test' ? 'помечен тестовым' : 'снова учитывается'} — ${o.table}`, r.id);
  } else if (b.kind === 'order' && b.action === 'served') {
    // «🍽 Подано»: официант принёс заказ. Кухня «Готово» не отмечала (экран не работает, кухня на бумаге) — отмечаем и её
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && y.status === 'confirmed' && !y.servedAt);
    if (!x) throw fail(400, 'bad action');
    const now = Date.now(), kitchenReady = !!x.readyAt;
    if (!x.readyAt) Object.assign(x, { readyAt: now, readyBy: member.name, kitchenItems: kitchenSnap(x) });
    Object.assign(x, { servedAt: now, servedBy: member.name });
    hist(x, 'served', member.name, kitchenReady ? {} : { noKitchen: 1 });
    logEvent(r.id, 'order_served', { ...who, id: x.id, table: x.table, ms: now - (x.cookFrom || x.confirmedAt || x.at), ...(kitchenReady ? {} : { noKitchen: 1 }) });
  } else if (b.kind === 'order' && b.action === 'remove') {
    // «Удалить (дубль)» — только менеджер: заказ пропадает из счёта и статистики, кухня видит «убрано»
    if (member.role !== 'manager') throw fail(403, 'managers only');
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && y.status !== 'rejected' && !y.paidAt);
    if (!x) throw fail(400, 'bad action');
    Object.assign(x, { status: 'rejected', rejectedAt: Date.now(), removedAt: Date.now(), removedBy: member.name, by: member.name });
    hist(x, 'remove', member.name);
    r.removedIds = [...(r.removedIds || []), x.id].slice(-5000);
    logEvent(r.id, 'order_remove', { ...who, id: x.id, table: x.table, total: x.total });
    audit(`${member.name} (менеджер)`, `Заказ удалён как дубль: ${tableLabel(x.table)}, ฿${x.total}`, r.id);
  } else if (b.kind === 'order' && b.action === 'redo') {
    // «🔁 Переделать»: блюдо вернули (остыло, не то, не понравилось) — кухня готовит выбранное заново; в счёт не добавляется
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && y.status === 'confirmed' && !y.closed && y.readyAt);
    if (!x) throw fail(400, 'bad action');
    const cur = kitchenSnap(x), pick = {};
    for (const [k, q] of Object.entries(b.items || {})) {
      const n = Math.min(cur[k]?.qty || 0, Math.max(0, Math.round(Number(q)) || 0));
      if (n) pick[k] = { ...cur[k], qty: n };
    }
    if (!Object.keys(pick).length) throw fail(400, 'Отметьте, что переделать');
    const now = Date.now(), note = noteOf(b);
    for (const k of ['readyAt', 'readyBy', 'servedAt', 'servedBy']) delete x[k];
    Object.assign(x, { cookFrom: now, kitchenItems: cur, redo: { at: now, by: member.name, items: pick, note } });
    hist(x, 'redo', member.name, { items: snapLines(r, pick), note });
    logEvent(r.id, 'order_redo', { ...who, id: x.id, table: x.table, items: snapLines(r, pick), note });
  } else if (b.kind === 'order' && b.action === 'cancel') {
    // «✕ Отменить заказ»: гость передумал, ошиблись столом… До «Подано» — любой сотрудник, после — только менеджер.
    // Заказ уходит из счёта и выручки, кухня видит «отменён», в истории — кто и почему
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && y.status === 'confirmed' && !y.closed);
    if (!x) throw fail(400, 'bad action');
    if (x.paidAt || x.items.some((i) => i.paidAt)) throw fail(400, 'Заказ уже оплачен — отменить нельзя');
    if (x.servedAt && member.role !== 'manager') throw fail(403, 'Заказ уже подан — отменить может только менеджер');
    const now = Date.now(), note = noteOf(b);
    Object.assign(x, { status: 'rejected', rejectedAt: now, cancelledAt: now, cancelledBy: member.name, cancelNote: note, by: member.name });
    hist(x, 'cancel', member.name, { note });
    logEvent(r.id, 'order_cancel', { ...who, id: x.id, table: x.table, total: x.total, note });
  } else if (b.kind === 'order' && b.action === 'paid') {
    // Оплачен один счёт стола; стол остаётся открытым, пока его не закроют
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && !y.closed && y.status !== 'rejected');
    if (!x) throw fail(400, 'bad action');
    if (!x.paidAt) payAll(x);
  } else if (b.kind === 'order' && (b.action === 'ack' || b.action === 'edit')) {
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && !y.closed && y.status !== 'rejected');
    if (!x) throw fail(400, 'bad action');
    // «Иду» по заказу — останавливаем напоминания; правка заказа тоже значит, что официант им занялся
    ackOrder(x);
    if (b.action === 'edit') {
      const had = new Set(x.items.map((i) => `${i.id}|${i.opt || ''}|${[...(i.mods || [])].sort().join(',')}`));
      const miss = missingChoice(r, (b.items || []).filter((i) => !had.has(`${i?.id}|${i?.opt || ''}|${[...(i?.mods || [])].map(String).sort().join(',')}`)));
      if (miss) throw fail(400, `Не выбран обязательный вариант: ${miss}`);
      const items = buildItems(r, b.items);
      if (!items.length) throw fail(400, 'empty order');
      const before = kitchenSnap(x);
      Object.assign(x, { items, total: items.reduce((s, i) => s + i.price * i.qty, 0), editedAt: Date.now(), editedBy: member.name });
      const diff = snapDiff(r, before, kitchenSnap(x));
      if (diff.add.length || diff.del.length) hist(x, 'edit', member.name, diff);
      // к уже готовому заказу добавили блюда — кухне снова есть что готовить
      const was = x.kitchenItems || {}, cur = kitchenSnap(x);
      if (x.readyAt && Object.keys(cur).some((k) => cur[k].qty > (was[k]?.qty || 0))) {
        for (const k of ['readyAt', 'readyBy', 'servedAt', 'servedBy']) delete x[k]; // снова готовить и снова подать
        x.cookFrom = Date.now();
      }
      logEvent(r.id, 'order_edit', { ...who, id: x.id, table: x.table, total: x.total, items: items.map((i) => [i.id, i.qty, i.price]), ...diff });
    }
  } else {
    const x = (b.kind === 'call' ? db.calls : db.orders).find((y) => y.id === b.id && y.restaurantId === r.id);
    const status = NEXT[b.kind]?.[b.action];
    if (!x || !status) throw fail(400, 'bad action');
    if (b.kind === 'call' && status === 'ack' && x.status === 'new') logEvent(r.id, 'call_ack', { ...who, id: x.id, table: x.table, type: x.type, ms: Date.now() - x.at });
    if (b.kind === 'call' && status === 'done') {
      if (x.status === 'new') logEvent(r.id, 'call_ack', { ...who, id: x.id, table: x.table, type: x.type, ms: Date.now() - x.at });
      logEvent(r.id, 'call_done', { ...who, id: x.id, table: x.table });
    }
    if (b.kind === 'order') {
      ackOrder(x);
      if (status === 'rejected') logEvent(r.id, 'order_reject', { ...who, id: x.id, table: x.table });
      if (x.status !== status) hist(x, status === 'confirmed' ? 'confirm' : 'reject', member.name);
    }
    Object.assign(x, { status, by: member.name, [`${status}At`]: Date.now() });
    if (status === 'confirmed') x.kitchenItems = kitchenSnap(x);
  }
  save();
  return {};
}

// ---------- Смена и «не приходят сообщения»
// Проверка при начале смены (вход, «На смене», новая подписка): уведомление «✅ Вы на смене — уведомления работают».
// Телефон не подтвердил его за 30 секунд — «не приходят сообщения» (официанту — красная плашка, менеджерам — строка,
// JET MEDIA — Telegram)
function shiftCheck(s, delay) {
  s.check = { wait: Date.now() + delay };
  setTimeout(() => {
    if (!s.onShift || !Object.values(db.sessions).includes(s)) return; // вышли из приложения или сняли смену
    if (!s.subs.length) { delete s.check; deafSet(s, 'nosub'); return; }
    const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en;
    for (const sub of s.subs) {
      const ack = pushAckId(s);
      s.check = { at: Date.now(), ack };
      sendPush(sub, { title: 'JET MEDIA', body: L.check, group: 'check', tag: `check-${Date.now()}`, ack }, db.vapid)
        .then((res) => { pushRecord(s, sub, res, { kind: 'check', ack }); if (!res.ok) { delete s.check; deafSet(s, 'gone'); } });
    }
  }, delay);
}
const DEAF_WHY = {
  gone: 'подписка на уведомления больше не действует — браузер её отменил (очищены данные, запрещены уведомления или удалено приложение с экрана).\nЧто сделать: открыть приложение официанта — подписка восстановится сама.',
  nosub: 'на телефоне не включены уведомления.\nЧто сделать: открыть приложение официанта и нажать «Включить уведомления».',
  check: 'телефон не подтвердил проверочное уведомление при начале смены — спит (энергосбережение), нет интернета или Chrome прячет уведомления как спам.\nЧто сделать: в приложении официанта — подсказка вверху, внизу — «Проверить уведомление».',
  noack: '3 уведомления подряд телефон не подтвердил за 2 минуты — спит (энергосбережение) или выключен.\nЧто сделать: в приложении официанта внизу — «Проверить через 6 мин», настройки батареи по подсказке.',
};
const memberOf = (s) => (db.restaurants[s.restaurantId]?.staff || []).find((m) => m.id === s.staffId);
const deafOf = (s) => (s.deaf ? s.deaf.why : s.onShift && !s.subs.length ? 'nosub' : null);
function deafSet(s, why) {
  if (!s.onShift || s.deaf?.why === why) return;
  s.deaf = { why, at: Date.now() };
  const r = db.restaurants[s.restaurantId], m = memberOf(s);
  // в Telegram — в часы работы и не чаще раза за смену на человека
  if (r && m && isWorking(r) && s.deafTg !== s.shiftAt) {
    s.deafTg = s.shiftAt;
    s.deaf.tg = 1;
    tgAlert(`🔕 ${r.name}: ${m.role === 'manager' ? 'менеджеру' : 'официанту'} ${m.name} не приходят сообщения.\nПричина: ${DEAF_WHY[why] || why}`);
  }
  save();
}
function deafClear(s) {
  const r = db.restaurants[s.restaurantId], m = memberOf(s);
  if (s.deaf?.tg && r && m) tgAlert(`🔔 ${r.name}: ${m.name} снова получает сообщения`);
  delete s.deaf;
  save();
}
// Кто на смене: по сотруднику (у него может быть несколько телефонов) — роль, столы, с какого времени, доходят ли уведомления
function teamOf(r) {
  const by = new Map();
  for (const s of Object.values(db.sessions)) {
    if (s.restaurantId !== r.id || !s.onShift) continue;
    // старый вход без подписки, который сутки не открывали, — не телефон на смене, а забытый вход
    if (!s.subs.length && Date.now() - (s.seenAt || 0) > 864e5) continue;
    const m = (r.staff || []).find((x) => x.id === s.staffId);
    if (!m) continue;
    const x = by.get(m.id) || { name: m.name, role: m.role, tables: m.tables || [], since: Infinity, ok: false, deaf: null };
    x.since = Math.min(x.since, s.shiftAt || s.at || Date.now());
    const d = deafOf(s);
    if (d) x.deaf ||= d; else x.ok = true;
    by.set(m.id, x);
  }
  return [...by.values()].map((x) => ({ ...x, deaf: x.ok ? null : x.deaf })).sort((a, b) => a.since - b.since);
}
const teamLine = (t) => (t.length ? t.map((x) => `${x.name} (${x.role === 'manager' ? 'менеджер' : x.tables.length ? `столы ${x.tables.join(', ')}` : 'все столы'})`
  + (x.deaf ? ' 🔕 не приходят сообщения' : ' 🔔')).join(', ') : 'пока никого');
// Последний момент «закрытие + 1 час» по часам работы (0 — часов нет)
function lastCut(r, now) {
  const h = hoursOf(r);
  if (!h) return 0;
  const back = (((bkkMin(now) - ((h.to + 60) % 1440)) % 1440) + 1440) % 1440;
  return now - back * 60e3;
}
// Раз в минуту: конец смены сам, «3 уведомления подряд не подтверждены», проверка без ответа, «ресторан проснулся»
const SHIFT_IDLE_MS = 14 * 3600e3, WAKE_DELAY_MS = Number(process.env.WAKE_DELAY_MS) || 20 * 60e3, wakeState = {};
setInterval(() => {
  const now = Date.now(), guests = {};
  // последний вызов или заказ гостей по ресторану: гости ещё есть — смену не закрываем, даже если часы работы прошли
  for (const x of [...db.calls.slice(-500), ...db.orders.slice(-500)]) guests[x.restaurantId] = Math.max(guests[x.restaurantId] || 0, x.at || 0);
  for (const s of Object.values(db.sessions)) {
    const r = db.restaurants[s.restaurantId];
    if (!r || !s.onShift) continue;
    // смена закрывается через час после закрытия (час без действий в приложении и без гостей); без часов работы — после 14 ч
    const cut = lastCut(r, now), idle = now - Math.max(s.actAt || 0, s.shiftAt || 0, cut ? guests[r.id] || 0 : s.seenAt || 0);
    if (cut ? (s.shiftAt || 0) < cut && idle > 3600e3 : idle > SHIFT_IDLE_MS) {
      s.onShift = false;
      delete s.deaf; delete s.check;
      logEvent(r.id, 'shift', { by: s.staffId, bn: memberOf(s)?.name, on: false, auto: 1 });
      save();
      continue;
    }
    if (s.check?.ack && now - s.check.at > 30_000) { delete s.check; deafSet(s, 'check'); }
    // три последних уведомления этой смены не подтверждены телефоном за 2 минуты
    const last3 = (s.pushLog || []).filter((x) => x.at >= (s.shiftAt || 0) && x.status >= 200 && x.status < 300 && now - x.at > 120e3).slice(-3);
    if (last3.length === 3 && last3.every((x) => !x.gotAt || x.gotAt - x.at > 120e3) && !s.deaf) deafSet(s, 'noack');
  }
  // «☀️ Ресторан проснулся»: первый планшет на связи после ночи (все выключены 4+ часа) — через 20 минут в Telegram,
  // кто на смене. Через 30 минут после открытия нет ни одного официанта — предупреждение. Только при часах работы
  for (const r of Object.values(db.restaurants)) {
    const h = hoursOf(r);
    if (!h) continue;
    const devs = Object.values(db.devices).filter((d) => d.restaurantId === r.id);
    const on = devs.filter((d) => now - (d.lastSeen || 0) < ONLINE_MS && !d.offAt);
    const w = (wakeState[r.id] ||= {});
    if (!on.length && devs.length) w.dark = Math.max(...devs.map((d) => d.lastSeen || 0));
    else if (on.length && w.dark) { if (now - w.dark >= 4 * 3600e3) w.wakeAt = now; delete w.dark; }
    if (w.wakeAt && now - w.wakeAt >= WAKE_DELAY_MS) {
      delete w.wakeAt;
      const team = teamOf(r);
      tgAlert(`☀️ ${r.name} проснулся: планшетов на связи ${on.length} из ${devs.length}.\n${team.length ? `На смене ${team.length}: ${teamLine(team)}.` : 'На смене пока никого.'}`);
    }
    // открытие + 30 минут: нет официантов на смене
    const sinceOpen = (((bkkMin(now) - h.from) % 1440) + 1440) % 1440, day = thDay(now);
    if (sinceOpen >= 30 && sinceOpen < 40 && w.noWaiters !== day && on.length) { // планшеты включены — ресторан работает
      const team = teamOf(r);
      if (!team.some((x) => x.role === 'waiter')) {
        w.noWaiters = day;
        tgAlert(`⚠ ${r.name}: открыт 30 минут, а на смене нет ни одного официанта — вызовы идут ${team.length ? 'только менеджерам' : 'никому'}.`);
      }
    }
  }
}, 60_000).unref();
// Старые сессии «на смене» до этой версии: начало смены — сейчас (иначе автоконец закрыл бы их сразу)
for (const s of Object.values(db.sessions)) if (s.onShift && !s.shiftAt) s.shiftAt = Date.now();

// Пуш всем сотрудникам ресторана, которые на смене и включили уведомления
// Официантам этого стола (без назначенных столов — всех столов); менеджерам — напоминания
// и вызовы, которые некому отправить
function notify(restaurantId, table, kind, extra = '', reminder = false, guest = null, ref = '') {
  const r = db.restaurants[restaurantId];
  if (!r) return;
  const member = (s) => (r.staff || []).find((m) => m.id === s.staffId);
  const active = Object.values(db.sessions).filter((s) => s.restaurantId === restaurantId && s.onShift && s.subs.length && member(s));
  const waiters = active.filter((s) => member(s).role === 'waiter' && (!member(s).tables?.length || servesTable(member(s).tables, table)));
  const managers = active.filter((s) => member(s).role === 'manager');
  const sent = new Set([...waiters, ...(reminder || !waiters.length ? managers : [])]);
  for (const s of sent) {
    const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en;
    const who = guest === 'table' ? ` · ${L.wholeTable}` : guest ? ` · ${guest.name || `${L.guest} ${guest.n}`}` : '';
    // каждое напоминание — новое уведомление (у обновлённого старого Android часто не включает звук);
    // предыдущее того же стола и вида приложение убирает само (group)
    const data = { title: tableLabel(table, L.table), body: (reminder ? `${L.again}: ` : '') + L[kind] + who + extra,
      group: `${kind}-${table}`, tag: `${kind}-${table}-${Date.now()}` };
    for (const sub of s.subs) {
      const ack = pushAckId(s);
      sendPush(sub, { ...data, ack }, db.vapid).then((res) => {
        pushRecord(s, sub, res, { kind, table, ack, ...(reminder ? { reminder } : {}), ...(ref ? { ref } : {}) });
        if (res.ok) return;
        // подписки больше нет: этот вызов — сразу менеджерам на смене (кто его ещё не получил); телефон — «не приходят сообщения»
        deafSet(s, 'gone');
        for (const mgr of managers.filter((x) => !sent.has(x) && x !== s)) {
          const ML = PUSH_TEXT[mgr.lang] || PUSH_TEXT.en;
          for (const msub of mgr.subs) {
            const mack = pushAckId(mgr);
            sendPush(msub, { ...data, body: `${data.body} · ⚠ ${ML.lost.replace('{n}', member(s)?.name || '')}`, ack: mack }, db.vapid)
              .then((r2) => pushRecord(mgr, msub, r2, { kind, table, ack: mack, resent: member(s)?.name || '', ...(ref ? { ref } : {}) }));
          }
        }
      });
    }
  }
}

// Никто не нажал «Иду» или «Подтвердить» — напоминаем каждые 45 секунд, до 5 раз
setInterval(() => {
  const now = Date.now();
  const waiting = [
    ...db.calls.filter((c) => c.status === 'new').map((c) => [c, c.type]),
    ...db.orders.filter((o) => o.status === 'pending' && !o.ackAt).map((o) => [o, 'order']),
  ];
  for (const [x, kind] of waiting) {
    const n = x.reminders || 0;
    if (x.closed || now - (x.notifiedAt || x.at) < (n < FAST_REMINDERS ? REMIND_MS : REMIND_SLOW_MS)) continue;
    if (kind === 'order' && now - x.at > ORDER_REMIND_MAX_MS) continue;
    x.reminders = (x.reminders || 0) + 1;
    x.notifiedAt = now;
    notify(x.restaurantId, x.table, kind, '', true, null, x.id);
    logEvent(x.restaurantId, 'remind', { table: x.table, kind });
  }
  // Заказ подтверждён, а «Заказ отправлен на кухню» не нажали (экрана кухни нет): через 5 минут — напоминание
  // официантам стола и менеджерам, потом каждые 5 минут, до 3 раз. Только свежие заказы (последний час)
  for (const o of db.orders) {
    if (o.status !== 'confirmed' || o.kitchenAt || o.paidAt || o.closed || o.test || now - (o.confirmedAt || o.at) > 3600e3) continue;
    const r = db.restaurants[o.restaurantId], f = r && flowOf(r);
    if (!f || !f.kitchenBtn || f.kitchenScreen || (o.kitchenReminds || 0) >= 3 || now - (o.kitchenRemindAt || o.confirmedAt || o.at) < 5 * 60e3) continue;
    o.kitchenReminds = (o.kitchenReminds || 0) + 1;
    o.kitchenRemindAt = now;
    notify(o.restaurantId, o.table, 'kitchen', '', true, null, o.id);
    logEvent(o.restaurantId, 'remind', { table: o.table, kind: 'kitchen' });
  }
}, 15_000);

// ---------- Забытые вызовы и заказы. Вызов без реакции официанта больше часа — забыт: снимается, если за столом нет заказа
// (есть заказ — остаётся, гость ещё за столом). Заказ без единого действия 8 часов — забыт и снимается.
// Принятый вызов, который так и не завершили, снимается через 8 часов. Список забытых за сегодня и вчера —
// внизу у официантов и менеджера, с подсказкой, что делать, чтобы не забывалось
// Сроки сбросов — настройка ресторана (ЛК → «Устройства»): корзина и язык планшета, забытые вызовы и заказы
const TIMERS = { cartMin: 15, langMin: 120, callMin: 15, orderHours: 8 };
const TIMER_RANGE = { cartMin: [1, 120], langMin: [10, 720], callMin: [10, 600], orderHours: [1, 48] };
const timersOf = (r) => ({ ...TIMERS, ...(r?.timers || {}) });
const cleanTimers = (b) => Object.fromEntries(Object.entries(TIMERS).map(([k, def]) => [k, Math.min(TIMER_RANGE[k][1], Math.max(TIMER_RANGE[k][0], Math.round(Number(b?.[k])) || def))]));
const callForgetMs = (r) => timersOf(r).callMin * 60_000, orderForgetMs = (r) => timersOf(r).orderHours * 3600_000;
// «2 д 3 ч 15 мин» — длительность для сообщений в Telegram
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60_000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d} д`, h && `${h} ч`, (mm || (!d && !h)) && `${mm} мин`].filter(Boolean).join(' ');
}
db.forgotten ??= [];
const lastAct = (x) => Math.max(...Object.entries(x).filter(([k, v]) => (k === 'at' || /At$/.test(k)) && typeof v === 'number').map(([, v]) => v));
function sweepForgotten() {
  const now = Date.now();
  let changed = false;
  // сначала заказы (8 часов без действий), потом вызовы — снятый забытый заказ больше не держит вызов
  for (const o of db.orders) {
    if (o.closed || now - lastAct(o) < orderForgetMs(db.restaurants[o.restaurantId])) continue;
    const last = lastAct(o);
    Object.assign(o, { closed: now, autoClosed: 'forgotten' });
    db.forgotten.unshift({ id: o.id, kind: 'order', r: o.restaurantId, table: o.table, at: o.at, last, when: now, removed: true, afterH: timersOf(db.restaurants[o.restaurantId]).orderHours,
      status: o.status, total: o.total, by: o.ackBy || o.by || '' });
    logEvent(o.restaurantId, 'forgotten', { kind: 'order', table: o.table });
    changed = true;
  }
  for (const c of db.calls) {
    if (c.closed || c.status === 'done') continue;
    const r = db.restaurants[c.restaurantId];
    if (!r) continue;
    if (c.status === 'new' && now - c.at >= callForgetMs(r)) {
      const keep = openAt(db.orders, r, c.table).length > 0;
      let f = c.forgot && db.forgotten.find((x) => x.id === c.id);
      if (!c.forgot) {
        c.forgot = now;
        f = { id: c.id, kind: 'call', type: c.type, r: c.restaurantId, table: c.table, at: c.at, when: now, removed: false, after: timersOf(r).callMin };
        db.forgotten.unshift(f);
        logEvent(c.restaurantId, 'forgotten', { kind: 'call', table: c.table, id: c.id, type: c.type });
        changed = true;
      }
      // за столом нет заказа — снимаем (и тот, что держали из-за заказа, когда заказ закрыли)
      if (!keep) {
        Object.assign(c, { status: 'done', doneAt: now, closed: now, autoClosed: 'forgotten' });
        if (f) f.removed = true;
        changed = true;
      }
    } else if (c.status !== 'new' && now - lastAct(c) >= orderForgetMs(r)) {
      Object.assign(c, { status: 'done', doneAt: now, closed: now, autoClosed: 'forgotten' });
      db.forgotten.unshift({ id: c.id, kind: 'call', type: c.type, r: c.restaurantId, table: c.table, at: c.at, when: now, removed: true, acked: c.by || '', afterH: timersOf(r).orderHours });
      changed = true;
    }
  }
  const before = db.forgotten.length;
  db.forgotten = db.forgotten.filter((f) => now - f.when < 3 * 864e5).slice(0, 1000);
  if (changed || before !== db.forgotten.length) save();
}
setTimeout(sweepForgotten, 20_000).unref();
setInterval(sweepForgotten, 60_000).unref();
// Забытые за сегодня и вчера (по Бангкоку); официант с назначенными столами видит свои столы
function forgottenFor(r, member) {
  const today = thDay(), yesterday = thDay(Date.now() - 864e5);
  const mine = (tb) => member.role === 'manager' || !member.tables?.length || servesTable(member.tables, tb);
  const tm = timersOf(r); // у записей до этой версии срока нет — берём нынешний срок ресторана
  const list = db.forgotten.filter((f) => f.r === r.id && mine(f.table)).map((f) => ({ after: tm.callMin, afterH: tm.orderHours, ...f }));
  return { today: list.filter((f) => thDay(f.when) === today), yesterday: list.filter((f) => thDay(f.when) === yesterday) };
}

// ---------- Менеджер ресторана: персонал и столы, меню, акции, блокировка внешней рекламы

function managerSession(token) {
  const x = session(token);
  if (x.member.role !== 'manager') throw fail(403, 'managers only');
  return x;
}

function managerGet(b, q) {
  const { r } = managerSession(q.token);
  return {
    restaurant: {
      id: r.id, name: r.name, staffCode: r.staffCode || '', langs: r.langs || [], tables: r.tables || [], tariff: r.tariff || 'standard', staff: r.staff || [],
      floor: floorOf(r), menuCats: r.menuCats || {},
      menu: r.menu || [], promos: r.promos || [], blockedAds: r.blockedAds || [], staffArchive: r.staffArchive || [],
      menuSource: publicSource(r.menuSource), menuIssues: menuIssues(r), timers: timersOf(r),
      display: { ...DISPLAY, ...r.display },
      avatar: { ...AVATAR, ...r.avatar },
      customTags: r.customTags || [], tagRules: r.tagRules || DEFAULT_RULES,
      flow: { ...pick(flowOf(r), ['phones', 'kitchenBtn', 'kitchenScreen']),
        kitchenUrl: r.flow?.kitchenKey ? `${PUBLIC_URL}/kitchen/?k=${r.flow.kitchenKey}` : '' },
      pos: r.menuSource?.type === 'pos' ? r.menuSource.vendor || 'pos' : '',
    },
    characters: db.characters.filter((c) => charAllowed(c, r))
      .map((c) => ({ id: c.id, name: c.name, image: c.images.idle, greetings: c.greetings, phrases: c.phrases })),
    themes: THEMES,
    devices: Object.values(db.devices).filter((d) => d.restaurantId === r.id).map((d) => ({
      id: d.id, entrance: d.role === 'entrance', table: d.table, online: Date.now() - d.lastSeen < ONLINE_MS,
      lastSeen: d.lastSeen, ...pick(d.telemetry, ['battery', 'charging', 'wifi', 'rssi', 'version']),
    })),
  };
}

const SECTIONS = { testVisit: 'пометка тестового визита', staffArchive: 'уволенные', staff: 'персонал', menu: 'меню', promos: 'акции', blockedAds: 'блокировка рекламы', menuSource: 'источник меню', customTags: 'особые пожелания', tagRules: 'правила отметок', display: 'показ и дизайн', avatar: 'ИИ-персонаж', tables: 'столы', flow: 'заказы и кухня', timers: 'сроки сбросов' };
function managerSave(b) {
  const { r, member } = managerSession(b.token);
  // Страница ЛК открыта с данными другого ресторана (вышли и вошли другим кодом без перезагрузки) — не сохраняем,
  // иначе персонал, меню и акции одного ресторана записываются в другой
  if (b.rid !== undefined && b.rid !== r.id) throw fail(409, 'Страница открыта для другого ресторана — обновите страницу и повторите');
  if (Array.isArray(b.staff)) {
    const mine = new Set((r.staff || []).concat(r.staffArchive || []).map((m) => m.id));
    const foreign = b.staff.find((m) => m.id && !mine.has(m.id) && Object.values(db.restaurants).some((o) => o.id !== r.id && (o.staff || []).some((x) => x.id === m.id)));
    if (foreign) throw fail(409, 'В списке персонала сотрудники другого ресторана — обновите страницу и повторите');
  }
  const changed = Object.keys(SECTIONS).filter((k) => b[k] !== undefined && k !== 'testVisit').map((k) => SECTIONS[k]);
  if (b.testVisit) audit(`${member.name} (менеджер)`, `Статистика: ${b.testVisit.test ? 'помечено тестовым' : 'снова учитывается'} — ${visitLabel(b.testVisit.label) || 'визит'}`, r.id);
  if (changed.length) audit(`${member.name} (менеджер)`, `ЛК: сохранено — ${changed.join(', ')}`, r.id);
  if (Array.isArray(b.staff)) setStaff(r, b.staff, b.fired || {});
  if (Array.isArray(b.staffArchive)) setArchive(r, b.staffArchive);
  if (b.testVisit) markTest(r, b.testVisit.ids, b.testVisit.test, member.name);
  // Меню из ЛК: при синхронизации — только ★ блюдо дня, 📣 в показе акций, ⦸ скрыть (хештеги и настройки синхронизации — в админке)
  if (Array.isArray(b.menu)) setMenu(r, b.menu, undefined, false);
  if (Array.isArray(b.promos)) r.promos = cleanPromos(b.promos);
  if (Array.isArray(b.promos) || Array.isArray(b.menu)) syncPromoItems(r);
  // «реклама после каждых N слайдов» задаёт админка — из ЛК не меняется
  if (b.timers) r.timers = cleanTimers(b.timers);
  if (b.floor) r.floor = cleanFloor(b.floor, r);
  // разделы меню в новом виде: своя иконка и группа (Кухня / Бар / Сладкое / сверху) — вместо подобранных сами
  if (b.menuCats && typeof b.menuCats === 'object') {
    r.menuCats = Object.fromEntries(Object.entries(b.menuCats).slice(0, 200).map(([k, v]) => [String(k).slice(0, 80), {
      icon: String(v?.icon || '').trim().slice(0, 8), group: ['food', 'bar', 'sweet', 'top'].includes(v?.group) ? v.group : '' }])
      .filter(([, v]) => v.icon || v.group));
  }
  if (b.display) r.display = { ...cleanDisplay(b.display), adEvery: { ...DISPLAY, ...r.display }.adEvery };
  if (b.avatar) r.avatar = cleanAvatar(b.avatar, r);
  if (b.flow) {
    // ссылка экрана кухни создаётся при включении; «Новая ссылка» — старая перестаёт работать
    const key = !b.flow.newKitchenKey && r.flow?.kitchenKey || crypto.randomBytes(12).toString('base64url');
    r.flow = { phones: b.flow.phones !== false, kitchenBtn: b.flow.kitchenBtn !== false, kitchenScreen: !!b.flow.kitchenScreen, kitchenKey: key };
  }
  if (Array.isArray(b.tables)) saveTables(r, b.tables);
  save();
  return {};
}

// Название стола целиком задаёт менеджер («Стол B1», «VIP-зал»); короткий номер («5», «B1») → «Стол 5»
const fullTable = (n) => (/^[A-Za-zА-Яа-я]?\d+[A-Za-zА-Яа-я]?$/.test(n) ? `Стол ${n}` : n);
// Подпись стола для уведомлений: слово «Стол» — на языке сотрудника, номер — как написал менеджер
const tableLabel = (n, word = 'Стол') => {
  const m = String(n).match(/^(?:стол|table|โต๊ะ|桌)\s+(.+)$/i);
  return /^\d+$/.test(String(n)) ? `${word} ${n}` : m ? `${word} ${m[1]}` : String(n);
};
// Официант с отметкой «1-5, B1» обслуживает «Стол 1»…«Стол 5» и «Стол B1»: сравниваем и целиком, и по последнему слову
// Кто из официантов закреплён за столом (в ЛК у сотрудника указаны столы); у кого столы не указаны — не называем
const waitersOf = (r, table) => (r.staff || []).filter((m) => m.role !== 'manager' && m.tables?.length && servesTable(m.tables, table)).map((m) => m.name);
const servesTable = (list, table) => list.includes(table) || list.includes(String(table).split(/\s+/).pop());

// Столы из ЛК менеджера: [{ from: 'старое имя' или '' для нового, to: 'новое имя' }].
// Переименование переносится на планшеты, официантов и открытые вызовы и заказы;
// планшет удалённого стола остаётся в ресторане без стола (его можно привязать в портале).
function saveTables(r, list) {
  const old = r.tables || [];
  const rows = list.map((x) => ({ from: String(x.from ?? '').trim(), to: String(x.to ?? '').trim().slice(0, 20) })).filter((x) => x.to);
  if (new Set(rows.map((x) => x.to)).size !== rows.length) throw fail(400, 'duplicate table');
  const map = new Map(rows.filter((x) => old.includes(x.from)).map((x) => [x.from, x.to]));
  const move = (t) => (map.has(t) ? map.get(t) : old.includes(t) ? '' : t);
  for (const d of Object.values(db.devices)) {
    if (d.restaurantId === r.id && d.role !== 'entrance' && d.table) d.table = move(d.table);
  }
  for (const m of r.staff || []) if (Array.isArray(m.tables)) m.tables = m.tables.map(move).filter(Boolean);
  for (const x of [...db.calls, ...db.orders]) {
    if (x.restaurantId === r.id && !x.closed) x.table = move(x.table) || x.table;
  }
  // схема зала: переименованный стол остаётся на своём месте, удалённый — уходит со схемы
  for (const z of r.floor?.zones || []) z.tables = z.tables.map((x) => ({ ...x, t: move(x.t) })).filter((x) => x.t);
  for (const k of Object.values(db.tableKeys)) if (k.r === r.id) k.table = move(k.table) || k.table;
  r.tables = rows.map((x) => x.to);
}

// ---------- Схема зала (ЛК → «Схема зала»): зоны, столы в клетках, надписи (бар, вход…) и быстрые кнопки на схеме.
// Клетки, а не пиксели — схема растягивается на любой телефон. Нет схемы — официант видит столы плитками
const QUICK_DEF = { ack: true, done: true, confirm: true, kitchen: true, served: true, paid: false, close: false };
const floorOf = (r) => ({ zones: r.floor?.zones || [], quick: { ...QUICK_DEF, ...r.floor?.quick } });
function cleanFloor(f, r) {
  const int = (v, a, b) => Math.min(b, Math.max(a, Math.round(Number(v)) || 0));
  const used = new Set();
  const zones = (Array.isArray(f.zones) ? f.zones : []).slice(0, 8).map((z, i) => {
    const cols = int(z.cols || 6, 4, 16);
    const box = (x) => { const w = int(x.w || 1, 1, cols), h = int(x.h || 1, 1, 8); return { x: int(x.x, 0, cols - w), y: int(x.y, 0, 60), w, h }; };
    const tables = (Array.isArray(z.tables) ? z.tables : []).filter((x) => (r.tables || []).includes(x.t) && !used.has(x.t) && used.add(x.t))
      .slice(0, 80).map((x) => ({ t: x.t, ...box(x), sh: x.sh === 'rd' ? 'rd' : 'sq' }));
    // надписи (бар, вход, своя) и столы без планшета — только рисунок на схеме, номер — любой текст
    // key — готовая надпись (бар, вход…): переводится на язык официанта сама; tr — перевод своей надписи
    const KEYS = ['bar', 'entrance', 'cashier', 'kitchen', 'window', 'wall'];
    const tr = (v) => Object.fromEntries(['ru', 'en', 'th', 'my'].map((l) => [l, String(v?.[l] || '').trim().slice(0, 14)]).filter(([, x]) => x));
    const decor = (Array.isArray(z.decor) ? z.decor : []).slice(0, 80).map((x) => ({ ...box(x), text: String(x.text || '').trim().slice(0, 14),
      ...(x.kind === 'table' ? { kind: 'table', sh: x.sh === 'rd' ? 'rd' : 'sq' } : KEYS.includes(x.key) ? { key: x.key } : Object.keys(tr(x.tr)).length ? { tr: tr(x.tr) } : {}) })).filter((x) => x.text);
    return { id: String(z.id || `z${i}`).slice(0, 20), name: String(z.name || '').trim().slice(0, 20) || `Зона ${i + 1}`, cols, tables, decor };
  });
  const quick = Object.fromEntries(Object.keys(QUICK_DEF).map((k) => [k, f.quick?.[k] === undefined ? QUICK_DEF[k] : !!f.quick[k]]));
  return { zones, quick };
}

// Статистика ресторана для ЛК менеджера (без внешней рекламы)
function managerStats(b, q) {
  const { r } = managerSession(q.token);
  const { from, to } = period(q);
  return restaurantReport({ log: events, db, r, from, to, staffNames: staffNamesOf(r), tests: q.tests === '1', dayFrom, waitersOf });
}

async function managerSync(b) {
  const { r, member } = managerSession(b.token);
  audit(`${member.name} (менеджер)`, 'ЛК: синхронизация меню', r.id);
  await syncMenu(r, true);
  return publicSource(r.menuSource);
}

// Админка: «Загрузить один раз и править вручную» — меню из источника, синхронизация выключается
async function importOnce(r) {
  const src = r.menuSource;
  if (!src || src.type === 'manual') throw fail(400, 'Источник меню не задан');
  await syncMenu(r, true);
  if (src.lastError) throw fail(400, src.lastError);
  r.menuSource = { ...src, type: 'manual', importedFrom: src.type };
  save();
}

// ---------- Синхронизация меню с сайтом, POS или JSON-фидом

// Токен POS наружу не отдаём
// Ошибки меню: что гости увидят не так — нет фото, цена 0, нет названия на английском, блюдо без раздела; сбой синхронизации.
// Для меню из источника исправляют там (после синхронизации ошибка уходит сама), для ручного — в меню
function menuIssues(r) {
  const src = r.menuSource, list = (r.menu || []).filter((i) => onMenu(i) && !i.fromPromo);
  const pick = (f) => list.filter(f).map((i) => ({ id: i.id, sku: i.sku || '', name: i.name || {}, cat: i.cat || {} }));
  const priced = (i) => Number(i.price) > 0 || (i.options || []).some((o) => Number(o.price) > 0);
  const filled = (o) => Object.values(o || {}).some((v) => String(v || '').trim());
  return {
    synced: !!src && src.type !== 'manual', error: src?.lastError || '', at: src?.lastSync || 0,
    issues: [
      { k: 'photo', items: pick((i) => !i.photo) },
      { k: 'price', items: pick((i) => !priced(i)) },
      // нет перевода названия или раздела на один из языков ресторана (новое блюдо в источнике, словаря ещё нет)
      ...(r.langs?.length ? r.langs : ['en']).map((l) => ({ k: `tr_${l}`,
        items: pick((i) => !String(i.name?.[l] || '').trim() || (filled(i.cat) && !String(i.cat?.[l] || '').trim())) })),
      { k: 'cat', items: pick((i) => !filled(i.cat)) },
    ].filter((x) => x.items.length),
  };
}
const publicSource = (s) => {
  if (!s) return { type: 'manual' };
  const { token, ...rest } = s;
  return { ...rest, hasToken: !!token };
};

function cleanSource(b, prev = {}) {
  const type = ['manual', 'website', 'pos', 'json'].includes(b.type) ? b.type : 'manual';
  const next = {
    ...prev, type,
    url: String(b.url ?? prev.url ?? '').trim(),
    vendor: POS_VENDORS[b.vendor] ? b.vendor : 'loyverse',
    token: b.token ? String(b.token).trim() : prev.token || '',
    lang: ['en', 'th', 'ru', 'zh'].includes(b.lang) ? b.lang : prev.lang || 'en',
    // проверять изменения каждые N минут (1–60); ownTags — свои хештеги в ЛК, синхронизация их не меняет
    everyMin: Math.min(60, Math.max(1, Math.round(Number(b.everyMin ?? prev.everyMin)) || 5)),
    ownTags: b.ownTags !== undefined ? !!b.ownTags : !!prev.ownTags,
  };
  // другой источник (тип, адрес, язык, касса или токен) — следующая синхронизация загрузит меню целиком
  if (['type', 'url', 'lang', 'vendor', 'token'].some((k) => (next[k] || '') !== (prev[k] || ''))) {
    delete next.lastHash;
    if (type !== 'manual') next.fresh = true;
  }
  return next;
}

const pick = (o = {}, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const nonEmpty = (o = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

// Поля из источника (названия на его языках, категория, цена, варианты, наличие) обновляем;
// переводы на другие языки, «блюдо дня», акции и своё фото сохраняем.
// Блюда, пропавшие из источника, скрываем, а добавленные вручную не трогаем.
// Какой источник дал блюдо (тип, адрес, касса): блюда, оставшиеся от прежнего источника, при синхронизации убираются
const srcKey = (s = {}) => `${s.type}|${s.url || ''}|${s.type === 'pos' ? s.vendor || '' : ''}`;

// Переводы меню на языки, которых нет в источнике (у сайта Veranda — только RU и EN): словарь «английский текст →
// тайский / китайский» в assets/translations/menu.json. Подставляем только пустое — перевод источника и правки не трогаем
const MENU_TR = (() => { try { return JSON.parse(fs.readFileSync(new URL('./assets/translations/menu.json', import.meta.url), 'utf8')); } catch { return {}; } })();
function fillTr(obj) {
  const t = obj && MENU_TR[String(obj.en || '').trim()];
  if (!t) return 0;
  let n = 0;
  for (const l of ['th', 'zh']) if (t[l] && !String(obj[l] || '').trim()) { obj[l] = t[l]; n++; }
  return n;
}
function translateMenu(r) {
  let n = 0;
  for (const i of r.menu || []) {
    for (const k of ['name', 'cat']) if (i[k] && typeof i[k] === 'object') n += fillTr(i[k]);
    for (const o of i.options || []) if (o.label) n += fillTr(o.label);
    for (const g of i.groups || []) { n += fillTr(g.name); for (const o of g.opts || []) n += fillTr(o.name); }
  }
  return n;
}

function mergeMenu(r, items) {
  const old = new Map((r.menu || []).filter((i) => i.extId).map((i) => [i.extId, i]));
  const seen = new Set();
  const own = !!r.menuSource?.ownTags, key = srcKey(r.menuSource);
  const synced = items.filter((s) => s.extId && Object.values(s.name || {}).some(Boolean)).map((s) => {
    seen.add(s.extId);
    const o = old.get(s.extId) || { id: uid(), cat: {}, name: {}, desc: {} };
    return {
      ...o, extId: s.extId, sku: s.sku || o.sku || '',
      cat: { ...o.cat, ...nonEmpty(s.cat) }, name: { ...o.name, ...nonEmpty(s.name) }, desc: { ...o.desc, ...nonEmpty(s.desc) },
      price: Number(s.price) || 0, options: s.options || [], groups: s.groups || [],
      photo: o.photoManual ? o.photo : s.photo || o.photo || '',
      // «нет в наличии» — из источника; «скрыть с планшетов» (hidden) — решение менеджера, синхронизация его не трогает
      off: s.available === false, srcKey: key, offAt: undefined,
      tags: own ? o.tags || [] : autoTags(r, s),
    };
  });
  // при синхронизации на планшетах — только меню источника: блюда, добавленные вручную, скрыты (строки акций остаются)
  const manual = (r.menu || []).filter((i) => !i.extId).map((i) => (i.fromPromo ? i : { ...i, hidden: true }));
  // пропавшие из этого же источника — «нет в наличии» (вернутся сами); оставшиеся от прежнего источника — убираем
  // пропавшие больше 30 дней назад — удаляем совсем
  const gone = [...old.values()].filter((i) => !seen.has(i.extId) && i.srcKey === key)
    .map((i) => ({ ...i, off: true, offAt: i.offAt || Date.now() })).filter((i) => Date.now() - i.offAt < 30 * 864e5);
  r.menu = [...synced, ...manual, ...gone];
}

// Отметки блюда при синхронизации: из источника (известные — к нашим, новые — свои отметки ресторана)
// и по правилам «вариант → отметка» (например, есть вариант «Не острое блюдо» — отметка «Не острое»)
const TAG_WORDS = {
  vegan: /vegan|веган/i, vegetarian: /vegetarian|вегетариан/i, gluten_free: /gluten|глютен/i, lactose_free: /lactose|лактоз/i,
  nut_free: /nut|орех/i, seafood_free: /seafood.?free|без морепродукт/i, spicy: /^(spicy|острое|острый)$/i, mild: /not spicy|mild|не остр/i,
  kids: /kid|child|дет/i, halal: /halal|халял/i,
};
const DEFAULT_RULES = [{ text: 'не остр', tag: 'mild' }, { text: 'not spicy', tag: 'mild' }, { text: 'остр', tag: 'spicy' }, { text: 'spicy', tag: 'spicy' }];
function autoTags(r, s) {
  const out = new Set();
  for (const name of s.srcTags || []) {
    const known = Object.keys(TAG_WORDS).find((k) => TAG_WORDS[k].test(name));
    if (known) { out.add(known); continue; }
    r.customTags ||= [];
    let c = r.customTags.find((x) => Object.values(x.name).some((v) => v.toLowerCase() === name.toLowerCase()));
    if (!c) r.customTags.push((c = { key: `c_${uid()}`, name: { ru: name, en: name, th: name, zh: name }, icon: '🏷' }));
    out.add(c.key);
  }
  const words = (s.groups || []).flatMap((g) => g.opts.flatMap((o) => Object.values(o.name))).map((v) => v.toLowerCase());
  for (const rule of r.tagRules || DEFAULT_RULES) {
    if (rule.text && words.some((w) => w.includes(rule.text.toLowerCase())) && tagKeys(r).includes(rule.tag)) out.add(rule.tag);
  }
  return [...out];
}

// Включён ли в ресторане хоть один планшет: агент на связи или страница планшета (рабочей или тестовой) спрашивает меню
const restaurantOn = (r) => Object.values(db.devices).some((d) => d.restaurantId === r.id
  && Date.now() - Math.max(d.lastSeen || 0, d.pageSeen || 0) < 3 * 60_000);

// Одна синхронизация ресторана за раз; кнопка во время фоновой — дождётся её и загрузит меню ещё раз целиком
const syncing = new Map();
function syncMenu(r, force = false) {
  const run = syncing.get(r.id);
  if (run) return force ? run.then(() => syncMenu(r, true)) : run;
  const p = syncOnce(r, force).finally(() => syncing.delete(r.id));
  syncing.set(r.id, p);
  return p;
}
async function syncOnce(r, force) {
  const src = r.menuSource;
  if (!src || src.type === 'manual') return;
  try {
    // кнопка «Синхронизировать» и первая синхронизация после смены источника — всегда целиком
    if (force || src.fresh || !(r.menu || []).some((i) => i.extId)) delete src.lastHash;
    const items = await fetchMenu(src);
    if (items?.unchanged) {
      src.lastError = '';
      return;
    }
    if (src.fresh) {
      // меню теперь из источника: блюда, добавленные вручную, с планшетов убираем (не удаляем — их видно в ЛК со значком ⦸);
      // строки акций остаются
      for (const i of r.menu || []) if (!i.extId && !i.fromPromo) i.hidden = true;
      delete src.fresh;
    }
    const hash = items.hash || crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex');
    if (hash !== src.lastHash || force) {
      mergeMenu(r, items);
      translateMenu(r);
      syncPromoItems(r);
      src.lastChange = Date.now();
    }
    Object.assign(src, { lastCount: items.length, lastError: '', lastHash: hash });
  } catch (e) {
    src.lastError = e.message;
  } finally {
    src.lastSync = Date.now();
    save();
  }
}

// Постоянная синхронизация: каждый ресторан — раз в N минут (ЛК → «Меню»); проверка лёгкая, меню
// перезаписывается, только если в источнике что-то изменилось
setInterval(() => {
  for (const r of Object.values(db.restaurants)) {
    const s = r.menuSource;
    // после смены источника — не дожидаясь интервала; только если в ресторане включён хотя бы один планшет
    // (выключены все — меню не сверяем; включится планшет — сверим сразу, если пора)
    if (s && s.type !== 'manual' && restaurantOn(r)
      && ((s.fresh && !s.lastError) || Date.now() - (s.lastSync || 0) > (s.everyMin || 5) * 60_000)) syncMenu(r);
  }
}, 30_000);

// Вебхук «меню изменилось» для POS или сайта: POST /api/menu/webhook?r=<id>&key=<syncKey>
function menuWebhook(b, q) {
  const r = db.restaurants[q.r];
  if (!r || !r.syncKey || q.key !== r.syncKey) throw fail(403, 'bad key');
  syncMenu(r);
  return { ok: true };
}

// ---------- Загрузка картинок (админ или менеджер): тело запроса — сам файл

async function upload(req) {
  const ext = IMAGE_TYPES[req.headers['content-type']];
  if (!ext) throw fail(400, 'only jpeg, png or webp');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_UPLOAD) throw fail(413, 'file is too large');
    chunks.push(c);
  }
  return { url: storeFile(Buffer.concat(chunks), ext) };
}

// ---------- CRM: клиенты по ресторанам, договоры, тарифы, платежи. Напоминания о платежах — в бот оповещений портала.
// Цена — как в прайсе jetmedia.dev: софт за ресторан + аренда каждого устройства, по сезонам (высокий — ноябрь–март),
// Premium дороже в premium раз; подключение — разово. Даты — строки ГГГГ-ММ-ДД по времени Бангкока
db.clients ??= [];
db.pricing ??= { low: { software: 1600, device: 240 }, high: { software: 3900, device: 590 }, premium: 2, setupFee: 5000 };
const CRM_STATUS = ['lead', 'test', 'active', 'paused', 'gone'];
const PERIODS = { month: 1, quarter: 3, year: 12 };
const crmAccess = (me) => permOf(me, 'crm') !== 'none';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const todayBkk = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const daysTo = (s) => (isDate(s) ? dayNum(s) - dayNum(todayBkk()) : null);
function addMonths(s, n) {
  const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n, d = +s.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
const highSeason = (s) => { const m = +s.slice(5, 7); return m >= 11 || m <= 3; };
// устройства клиента: вручную или все планшеты его ресторана
const autoDevices = (c) => (c.rid ? Object.values(db.devices).filter((d) => d.restaurantId === c.rid && (d.table || d.role === 'entrance')).length : 0);
const clientDevices = (c) => (c.devicesManual >= 0 && c.devicesManual !== null && c.devicesManual !== '' ? Number(c.devicesManual) : autoDevices(c));
function monthPrice(c, s) {
  if (c.customMonthly > 0) return c.customMonthly + (c.extra || 0);
  const pr = db.pricing, season = highSeason(s) ? pr.high : pr.low, k = c.tariff === 'premium' ? pr.premium : 1;
  return Math.round((season.software + season.device * clientDevices(c)) * k) + (c.extra || 0);
}
function periodAmount(c, due) {
  let sum = 0;
  for (let i = 0; i < PERIODS[c.period || 'month']; i++) sum += monthPrice(c, addMonths(due, i));
  return sum;
}
const visibleClients = (me) => {
  const scope = scopeOf(me);
  return db.clients.filter((c) => !scope || scope.has(c.rid));
};
function publicClient(c) {
  const due = c.nextDue;
  return {
    ...c, rest: db.restaurants[c.rid]?.name || '', devices: clientDevices(c), devicesAuto: autoDevices(c),
    monthNow: monthPrice(c, todayBkk()), amount: isDate(due) ? periodAmount(c, due) : 0, days: daysTo(due),
    contractDays: daysTo(c.contract?.until),
  };
}
function cleanClient(b, prev = {}) {
  const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
  const num = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, Math.round(Number(v)) || 0));
  const ct = b.contact || {}, k = b.contract || {}, su = b.setup || {};
  return {
    ...prev, id: prev.id || uid(), at: prev.at || Date.now(),
    rid: db.restaurants[b.rid] ? b.rid : '', name: str(b.name) || db.restaurants[b.rid]?.name || 'Клиент',
    status: CRM_STATUS.includes(b.status) ? b.status : 'lead', legal: str(b.legal, 200),
    contact: { name: str(ct.name), phone: str(ct.phone, 40), tg: str(ct.tg, 60), email: str(ct.email) },
    contract: { no: str(k.no, 60), date: isDate(k.date) ? k.date : '', until: isDate(k.until) ? k.until : '', file: /^[a-f0-9]{20}\.(pdf|jpg|png|webp)$/.test(k.file || '') ? k.file : '', fileName: str(k.fileName) },
    tariff: b.tariff === 'premium' ? 'premium' : 'standard', period: PERIODS[b.period] ? b.period : 'month',
    devicesManual: num(b.devicesManual), extra: num(b.extra) || 0, customMonthly: num(b.customMonthly) || 0,
    setup: { amount: num(su.amount) ?? db.pricing.setupFee, paid: !!su.paid, date: isDate(su.date) ? su.date : '' },
    nextDue: isDate(b.nextDue) ? b.nextDue : '', notes: str(b.notes, 3000), payments: prev.payments || [],
  };
}
function crmApi(method, p, b, me) {
  if (!crmAccess(me)) throw fail(403, 'Нет доступа к CRM');
  const scope = scopeOf(me);
  const own = (c) => c && (!scope || scope.has(c.rid));
  if (method === 'GET' && p === '/api/crm') {
    return { clients: visibleClients(me).map(publicClient), pricing: db.pricing, canPricing: me.role === 'super', today: todayBkk() };
  }
  if (method === 'POST' && p === '/api/crm/pricing') {
    if (me.role !== 'super') throw fail(403, 'Прайс меняет суперадмин');
    const n = (v, d) => Math.max(0, Math.round(Number(v)) || d);
    db.pricing = {
      low: { software: n(b.low?.software, 1600), device: n(b.low?.device, 240) }, high: { software: n(b.high?.software, 3900), device: n(b.high?.device, 590) },
      premium: Math.max(1, Number(b.premium) || 2), setupFee: n(b.setupFee, 5000),
    };
    save();
    return db.pricing;
  }
  if (method === 'POST' && p === '/api/crm/clients') {
    const prev = b.id ? db.clients.find((c) => c.id === b.id) : null;
    if (b.id && !own(prev)) throw fail(404, 'Клиент не найден');
    if (scope && !scope.has(b.rid)) throw fail(403, 'Нет доступа к этому ресторану');
    const c = cleanClient(b, prev || {});
    if (prev) Object.assign(prev, c); else db.clients.push(c);
    save();
    return publicClient(prev || c);
  }
  const m = p.match(/^\/api\/crm\/clients\/([^/]+)(\/paid|\/unpay)?$/);
  const c = m && db.clients.find((x) => x.id === m[1]);
  if (!own(c)) throw fail(404, 'Клиент не найден');
  if (method === 'DELETE' && !m[2]) { db.clients = db.clients.filter((x) => x !== c); save(); return {}; }
  // «Оплачено»: платёж в историю, следующая дата — через период
  if (method === 'POST' && m[2] === '/paid') {
    const due = isDate(c.nextDue) ? c.nextDue : todayBkk();
    const amount = b.amount !== undefined ? Math.max(0, Math.round(Number(b.amount)) || 0) : periodAmount(c, due);
    c.payments = [{ at: Date.now(), date: isDate(b.date) ? b.date : todayBkk(), due, amount, period: c.period, note: String(b.note || '').slice(0, 200), by: me.email }, ...(c.payments || [])].slice(0, 200);
    c.nextDue = addMonths(due, PERIODS[c.period || 'month']);
    save();
    return publicClient(c);
  }
  if (method === 'POST' && m[2] === '/unpay') {
    const last = (c.payments || [])[0];
    if (!last) throw fail(400, 'Платежей нет');
    c.payments = c.payments.slice(1);
    c.nextDue = last.due;
    save();
    return publicClient(c);
  }
  throw fail(404, 'not found');
}
// Файл договора (PDF или фото): хранится отдельно от общих загрузок и отдаётся только тем, у кого есть доступ к CRM
const CRM_DIR = path.join(DATA_DIR, 'crm');
const CRM_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
async function crmUpload(req, me) {
  if (!me || !canEdit(me, 'crm')) throw fail(403, 'Нет права менять раздел «Клиенты»');
  const ext = CRM_TYPES[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) throw fail(400, 'Только PDF, JPG, PNG или WEBP');
  const chunks = [];
  let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 20 * 1024 * 1024) throw fail(413, 'Файл больше 20 МБ'); chunks.push(ch); }
  const data = Buffer.concat(chunks), name = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 20)}.${ext}`;
  fs.mkdirSync(CRM_DIR, { recursive: true });
  fs.writeFileSync(path.join(CRM_DIR, name), data);
  return { file: name };
}

// Напоминания — только вам, в бот оповещений портала: за 7, 3, 1 день до платежа, в день платежа и каждый день просрочки;
// договор заканчивается — за 30 и 7 дней; по понедельникам — сводка на неделю. Не раньше 9:00 по Бангкоку, раз в день
const baht = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')} ฿`;
const ruDate = (s) => (isDate(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—');
const PERIOD_RU = { month: 'месяц', quarter: 'квартал', year: 'год' };
function crmRemind() {
  if (!tgHas('crm')) return;
  const now = new Date(Date.now() + 7 * 3600e3), today = todayBkk();
  if (now.getUTCHours() < 9) return;
  const lines = [];
  for (const c of db.clients) {
    if (c.status !== 'active' || c.remindDay === today) continue;
    const pc = publicClient(c), d = pc.days, what = `${c.name}: ${baht(pc.amount)} за ${PERIOD_RU[c.period || 'month']} (${c.tariff === 'premium' ? 'Premium' : 'Standard'}, устройств: ${pc.devices})`;
    if (d !== null && d < 0) lines.push(`🔴 Просрочен платёж ${-d} дн. — ${ruDate(c.nextDue)}\n${what}`);
    else if (d === 0) lines.push(`🟠 Сегодня платёж — ${what}`);
    else if ([1, 3, 7].includes(d)) lines.push(`💳 Через ${d} дн. платёж (${ruDate(c.nextDue)}) — ${what}`);
    const cd = pc.contractDays;
    if ([30, 7].includes(cd)) lines.push(`📄 ${c.name}: договор${c.contract.no ? ` № ${c.contract.no}` : ''} заканчивается через ${cd} дн. (${ruDate(c.contract.until)})`);
    c.remindDay = today;
  }
  if (now.getUTCDay() === 1 && db.crmWeekly !== today) {
    db.crmWeekly = today;
    const week = db.clients.filter((c) => c.status === 'active' && daysTo(c.nextDue) !== null && daysTo(c.nextDue) <= 7)
      .map((c) => { const pc = publicClient(c); return `• ${c.name} — ${ruDate(c.nextDue)}${pc.days < 0 ? ' (просрочен)' : ''}, ${baht(pc.amount)}`; });
    const month = db.clients.filter((c) => c.status === 'active').reduce((n, c) => n + monthPrice(c, today), 0);
    lines.push(`📊 Сводка на неделю: ${week.length ? `\n${week.join('\n')}` : 'платежей на этой неделе нет'}\nАктивные клиенты в месяц сейчас: ${baht(month)}`);
  }
  if (!lines.length) return;
  save();
  tgTo('crm', `JET MEDIA · CRM\n\n${lines.join('\n\n')}`);
}
setTimeout(crmRemind, 60_000).unref();
setInterval(crmRemind, 30 * 60_000).unref();

// ---------- Расходы: наши платежи (VPS, подписки, домены…) — напоминания в Telegram как у клиентов:
// за 7, 3 и 1 день, в день оплаты, каждый день просрочки; у годовых — ещё за 30 дней; по понедельникам — сводка.
// Курс к бату — текущий (обновляется сам) или свой; при «Оплачено» запоминается курс на момент оплаты
db.expenses ??= [];
db.fx ??= { USD: 0, EUR: 0, at: 0 };
db.fxCustom ??= {};
const EXP_CATS = { server: 'Сервер', ai: 'Подписки и ИИ', domain: 'Домены', comm: 'Связь', other: 'Прочее' };
const EXP_PERIODS = { month: [1, 'месяц'], quarter: [3, 'квартал'], half: [6, 'полгода'], year: [12, 'год'], once: [0, 'разово'] };
const CURS = { THB: '฿', USD: '$', EUR: '€' };
async function fxUpdate(force = false) {
  if (!force && Date.now() - (db.fx.at || 0) < 12 * 3600e3) return;
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) })).json();
    if (j?.rates?.THB && j.rates.EUR) {
      db.fx = { USD: Math.round(j.rates.THB * 100) / 100, EUR: Math.round((j.rates.THB / j.rates.EUR) * 100) / 100, at: Date.now() };
      save();
    }
  } catch { /* нет связи — курс прежний */ }
}
setTimeout(fxUpdate, 20_000).unref();
setInterval(fxUpdate, 3600e3).unref();
// курс платежа: свой у платежа → свой общий → текущий
const rateOf = (e) => (e.cur === 'THB' ? 1 : Number(e.rate) > 0 ? Number(e.rate) : Number(db.fxCustom[e.cur]) > 0 ? Number(db.fxCustom[e.cur]) : db.fx[e.cur] || 0);
const expMoney = (e) => `${(Number(e.amount) || 0).toLocaleString('ru-RU')} ${CURS[e.cur] || e.cur}${e.cur !== 'THB' && rateOf(e) ? ` ≈ ${baht(e.amount * rateOf(e))}` : ''}`;
function publicExp(e) {
  const rate = rateOf(e), n = EXP_PERIODS[e.period]?.[0] || 0;
  return { ...e, rate: e.rate || 0, rateUsed: rate, thb: Math.round((e.amount || 0) * rate), monthThb: n ? Math.round(((e.amount || 0) * rate) / n) : 0, days: daysTo(e.nextDue) };
}
function cleanExp(b, prev = {}) {
  const amount = Math.max(0, Math.round(Number(b.amount) * 100) / 100 || 0);
  return {
    ...prev, id: prev.id || uid(), name: String(b.name || '').trim().slice(0, 80) || 'Без названия',
    cat: EXP_CATS[b.cat] ? b.cat : 'other', amount, cur: CURS[b.cur] ? b.cur : 'THB', period: EXP_PERIODS[b.period] ? b.period : 'month',
    nextDue: isDate(b.nextDue) ? b.nextDue : '', auto: !!b.auto, card4: String(b.card4 || '').replace(/\D/g, '').slice(-4),
    link: /^https?:\/\//.test(String(b.link || '').trim()) ? String(b.link).trim().slice(0, 300) : '',
    note: String(b.note || '').slice(0, 500), rate: Number(b.rate) > 0 ? Math.round(Number(b.rate) * 100) / 100 : 0,
    active: b.active !== false, history: prev.history || [],
  };
}
async function expensesApi(method, p, b, me) {
  if (method === 'GET' && p === '/api/expenses') {
    if (!db.fx.at) await fxUpdate(true); // курс ещё не получали — сначала узнаём
    const list = db.expenses.map(publicExp);
    return { list, cats: EXP_CATS, periods: Object.fromEntries(Object.entries(EXP_PERIODS).map(([k, [, n]]) => [k, n])), curs: CURS,
      fx: db.fx, fxCustom: db.fxCustom, today: todayBkk(), monthThb: list.filter((e) => e.active).reduce((a, e) => a + e.monthThb, 0) };
  }
  if (method === 'POST' && p === '/api/expenses/fx') {
    for (const c of ['USD', 'EUR']) db.fxCustom[c] = Number(b[c]) > 0 ? Math.round(Number(b[c]) * 100) / 100 : 0;
    save();
    return expensesApi('GET', '/api/expenses', {}, me);
  }
  if (method === 'POST' && p === '/api/expenses') {
    const prev = db.expenses.find((x) => x.id === b.id);
    const e = cleanExp(b, prev);
    if (prev) Object.assign(prev, e); else db.expenses.push(e);
    if (!prev || prev.nextDue !== b.nextDue) e.remindDay = '';
    save();
    return publicExp(prev || e);
  }
  const m = p.match(/^\/api\/expenses\/([^/]+)(\/paid|\/unpay)?$/);
  const e = m && db.expenses.find((x) => x.id === m[1]);
  if (!e) throw fail(404, 'Платёж не найден');
  if (method === 'DELETE' && !m[2]) { db.expenses = db.expenses.filter((x) => x !== e); save(); return {}; }
  if (method === 'POST' && m[2] === '/paid') {
    // «Оплачено»: запоминаем сумму и курс на момент оплаты, дата — на следующий период (разовый — в архив)
    if (!rateOf(e)) await fxUpdate(true); // курс на момент оплаты должен быть известен
    const rate = rateOf(e);
    e.history.push({ at: Date.now(), due: e.nextDue, amount: e.amount, cur: e.cur, rate, thb: Math.round(e.amount * rate), by: me.email });
    const n = EXP_PERIODS[e.period][0];
    if (n && isDate(e.nextDue)) e.nextDue = addMonths(e.nextDue, n); else e.active = false;
    e.remindDay = '';
  }
  if (method === 'POST' && m[2] === '/unpay') {
    const last = e.history.pop();
    if (last) { e.nextDue = last.due; e.active = true; e.remindDay = ''; }
  }
  save();
  return publicExp(e);
}
function expRemind() {
  if (!tgHas('expenses')) return;
  const now = new Date(Date.now() + 7 * 3600e3), today = todayBkk();
  if (now.getUTCHours() < 9) return;
  const lines = [];
  for (const e of db.expenses) {
    if (!e.active || !isDate(e.nextDue) || e.remindDay === today) continue;
    const d = daysTo(e.nextDue), card = e.card4 ? ` с карты •••• ${e.card4}` : '', link = e.link ? `\n${e.link}` : '';
    if (d < 0) lines.push(e.auto ? `🔴 ${e.name}: дата списания прошла ${-d} дн. назад (${ruDate(e.nextDue)}), ${expMoney(e)}. Если списалось — отметьте «Оплачено» в админке${link}`
      : `🔴 Просрочена оплата ${-d} дн. — ${e.name}: ${expMoney(e)} (${ruDate(e.nextDue)})${link}`);
    else if (d === 0) lines.push(e.auto ? `🟠 Сегодня автосписание — ${e.name}: ${expMoney(e)}${card}${link}` : `🟠 Сегодня оплатить — ${e.name}: ${expMoney(e)}${link}`);
    else if ([1, 3, 7].includes(d) || (d === 30 && e.period === 'year')) {
      lines.push(e.auto ? `💳 Через ${d} дн. (${ruDate(e.nextDue)}) спишется ${expMoney(e)}${card} — ${e.name}. Проверьте баланс${link}`
        : `💳 Через ${d} дн. (${ruDate(e.nextDue)}) оплатить ${e.name}: ${expMoney(e)}${link}`);
    } else continue;
    e.remindDay = today;
  }
  if (now.getUTCDay() === 1 && db.expWeekly !== today) {
    db.expWeekly = today;
    const week = db.expenses.filter((e) => e.active && daysTo(e.nextDue) !== null && daysTo(e.nextDue) <= 7)
      .map((e) => `• ${e.name} — ${ruDate(e.nextDue)}${daysTo(e.nextDue) < 0 ? ' (просрочен)' : ''}${e.auto ? ', автосписание' : ''}, ${expMoney(e)}`);
    const month = db.expenses.filter((e) => e.active).reduce((a, e) => a + publicExp(e).monthThb, 0);
    lines.push(`📊 Расходы на неделю: ${week.length ? `\n${week.join('\n')}` : 'платежей на этой неделе нет'}\nВ месяц всего ≈ ${baht(month)}`);
  }
  if (!lines.length) return;
  save();
  tgTo('expenses', `JET MEDIA · Расходы\n\n${lines.join('\n\n')}`);
}
setTimeout(expRemind, 90_000).unref();
setInterval(expRemind, 30 * 60_000).unref();
// Однократно: заготовки — суммы и даты вписываются в админке
if (!db.migrations.expSeed) {
  if (!db.expenses.length) {
    for (const [name, cat, period] of [['VPS (сервер)', 'server', 'month'], ['Claude — подписка', 'ai', 'month'], ['ElevenLabs — подписка', 'ai', 'month'], ['Домен jetmedia.dev', 'domain', 'year']]) {
      db.expenses.push(cleanExp({ name, cat, period, cur: 'USD' }));
    }
  }
  db.migrations.expSeed = Date.now();
}

// ---------- Администратор

// Меню из ЛК или портала. При синхронизации с источником блюда меняются там: здесь — только ★ блюдо дня,
// 📣 в показе акций, ⦸ скрыть с планшетов (и хештеги, если включены свои); остальное в присланном меню не трогаем —
// иначе страница, открытая до синхронизации, вернула бы старое меню
function setMenu(r, list, synced = !!r.menuSource && r.menuSource.type !== 'manual', tagsAllowed = true) {
  if (synced) {
    const own = tagsAllowed && !!r.menuSource.ownTags, by = new Map(list.map((i) => [i?.id, i]));
    for (const it of r.menu || []) {
      const n = by.get(it.id);
      // блюда, добавленные вручную до синхронизации, остаются скрытыми — на планшетах меню из источника
      if (!n || (!it.extId && !it.fromPromo)) continue;
      Object.assign(it, { dayDish: !!n.dayDish, promo: !!n.promo, hidden: !!n.hidden, askWaiter: !!n.askWaiter });
      if (own) it.tags = (Array.isArray(n.tags) ? n.tags : []).filter((x) => tagKeys(r).includes(x));
    }
  } else r.menu = cleanMenu(list, r);
}

const cleanRules = (list, r) => list.filter((x) => x && String(x.text || '').trim() && tagKeys(r).includes(x.tag))
  .slice(0, 50).map((x) => ({ text: String(x.text).trim().slice(0, 60), tag: x.tag }));

// Свои отметки ресторана: { key, name: {ru,en,th,zh}, icon }
function cleanCustomTags(list) {
  return list.filter((x) => x && Object.values(texts(x.name)).length).slice(0, 40).map((x) => ({
    key: /^c_[\w]+$/.test(x.key) ? x.key : `c_${uid()}`, name: texts(x.name), icon: String(x.icon || '🏷').slice(0, 4),
  }));
}

function cleanMenu(menu, r = {}) {
  return menu
    .filter((i) => i && i.name && typeof i.name === 'object' && Object.values(i.name).some(Boolean))
    .map((i) => ({
      id: i.id || uid(), cat: i.cat || {}, name: i.name, desc: i.desc || {},
      price: Number(i.price) || 0, photo: String(i.photo || ''), promo: !!i.promo, dayDish: !!i.dayDish,
      extId: i.extId || undefined, sku: String(i.sku || ''), options: Array.isArray(i.options) ? i.options : [],
      groups: Array.isArray(i.groups) ? i.groups : [],
      hidden: !!i.hidden, off: !!i.off, photoManual: !!i.photoManual, askWaiter: !!i.askWaiter, fromPromo: i.fromPromo ? String(i.fromPromo) : undefined,
      tags: (Array.isArray(i.tags) ? i.tags : []).filter((x) => tagKeys(r).includes(x)),
    }));
}

// Числа — в своих пределах, цвета — только #rrggbb, тема — из списка; иначе значение по умолчанию
function cleanDisplay(d) {
  return Object.fromEntries(Object.entries(DISPLAY).map(([k, def]) => {
    if (k === 'theme') return [k, themeOf(d.theme).id];
    if (k === 'slideFx') return [k, ['ltr', 'rtl', 'ttb', 'btt'].includes(d.slideFx) ? d.slideFx : def];
    if (k === 'arrows') return [k, ARROWS.includes(d.arrows) ? d.arrows : def];
    if (k === 'menuView') return [k, ['classic', 'tiles', 'catalog'].includes(d.menuView) ? d.menuView : def];
    if (typeof def !== 'number') return [k, /^#[0-9a-f]{6}$/i.test(d[k]) ? d[k] : def];
    const [min, max] = DISPLAY_RANGE[k];
    return [k, Math.min(max, Math.max(min, Math.round(Number(d[k])) || def))];
  }));
}

// Текст на языках гостя: { en, th, ru, zh }, не длиннее 300 символов
function texts(o) {
  const out = {};
  for (const l of ['en', 'th', 'ru', 'zh']) if (o && typeof o[l] === 'string' && o[l].trim()) out[l] = o[l].trim().slice(0, 300);
  return out;
}

const lineList = (v, clean) => (Array.isArray(v) ? v : []).map(clean).filter((g) => Object.keys(g).length).slice(0, MAX_LINES);

function cleanAvatar(a, r) {
  const num = (v, min, max, def) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  const id = String(a.characterId || '');
  const lines = {};
  for (const [cid, L] of Object.entries(a.lines && typeof a.lines === 'object' ? a.lines : {})) {
    if (!charAllowed(db.characters.find((c) => c.id === cid), r)) continue;
    const x = { greetings: lineList(L?.greetings, texts), recommend: lineList(L?.recommend, texts), dayDish: lineList(L?.dayDish, texts) };
    if (x.greetings.length || x.recommend.length || x.dayDish.length) lines[cid] = x;
  }
  return {
    enabled: !!a.enabled, characterId: charAllowed(db.characters.find((c) => c.id === id), r) ? id : '', speak: a.speak !== false,
    everyMin: num(a.everyMin, 1, 60, AVATAR.everyMin), durationSec: num(a.durationSec, 10, 180, AVATAR.durationSec),
    startWith: a.startWith !== false, lines,
    filters: (Array.isArray(a.filters) ? a.filters : []).filter((f) => tagKeys(r).includes(f)),
  };
}

// Название акции — только для поиска в ЛК; у старых акций берём его из прежнего заголовка
// Акция с ценой — строка меню «promo-<id>» в категории «Акции»: её заказывают с планшета и учитывают в статистике.
// Название берём из акции при создании строки (переводы можно поправить в меню); цену, фото и видимость — всегда из акции.
const PROMO_CAT = { ru: 'Акции', en: 'Promotions', th: 'โปรโมชั่น', zh: '优惠活动' };
// Кнопка на слайде акции: 'price' — «Заказать · цена»; 'free' — «Заказать по акции» (в заказе ฿0, например «2 + 1»); 'none' — без кнопки
const promoMode = (p) => (p.orderMode === 'none' ? 'none' : p.orderMode === 'price' && p.price > 0 ? 'price' : 'free');
// Строка меню новой акции: «Акция N: название» на языке гостя (N — номер акции в списке); менеджер может переименовать
const PROMO_WORD = { ru: 'Акция', en: 'Promo', th: 'โปรโมชั่น', zh: '优惠' };
const promoLineName = (n, names) => Object.fromEntries(Object.entries(PROMO_WORD).map(([l, w]) => [l, `${w} ${n}: ${names[l] || names.ru || 'Promo'}`]));

function syncPromoItems(r) {
  const promos = new Map((r.promos || []).map((p, i) => [`promo-${p.id}`, { p, n: i + 1 }]).filter(([, x]) => promoMode(x.p) !== 'none'));
  const menu = (r.menu || []).filter((i) => !i.fromPromo || promos.has(i.id));
  for (const [id, { p, n }] of promos) {
    let it = menu.find((i) => i.id === id);
    if (!it) {
      it = { id, fromPromo: p.id, cat: { ...PROMO_CAT }, name: promoLineName(n, { ru: p.name }), desc: {}, options: [], tags: [] };
      menu.push(it);
    }
    if (Object.values(it.name || {}).some((v) => v === BROKEN) && p.name) it.name = promoLineName(n, { ru: p.name });
    Object.assign(it, { price: promoMode(p) === 'price' ? p.price : 0, photo: p.image, hidden: !p.active, cat: { ...PROMO_CAT, ...it.cat } });
  }
  r.menu = menu;
}

// Название акции — строка; если пришёл объект { ru: … } (старая ошибка ЛК) — берём его текст
const BROKEN = '[object Object]';
function promoName(p, old) {
  const n = p.name && typeof p.name === 'object' ? Object.values(p.name).find(Boolean) : p.name;
  return n && n !== BROKEN ? String(n) : old(p);
}

// Картинки акции по языкам { ru, en, th, zh }: на планшете — на языке гостя, иначе английская или любая другая.
// image — запасная (первая загруженная), для превью и старых данных
function cleanPromos(list) {
  const old = (p) => (p.title && typeof p.title === 'object' ? p.title.ru || p.title.en || Object.values(p.title)[0] : '') || '';
  const imagesOf = (p) => Object.fromEntries(['ru', 'en', 'th', 'zh'].map((l) => [l, String(p.images?.[l] || '')]).filter(([, v]) => v));
  return list.filter((p) => p && (p.image || Object.keys(imagesOf(p)).length)).map((p) => ({
    id: p.id || uid(), images: imagesOf(p), name: promoName(p, old).trim().slice(0, 80), active: !!p.active,
    // языки, на которых акцию не показывать (галочка «показывать» снята у картинки языка)
    langOff: [...new Set((Array.isArray(p.langOff) ? p.langOff : []).filter((l) => ['ru', 'en', 'th', 'zh'].includes(l)))],
    image: String(p.image || Object.values(imagesOf(p))[0]),
    price: Math.max(0, Math.round(Number(p.price)) || 0),
    orderMode: ['price', 'free', 'none'].includes(p.orderMode) ? p.orderMode : p.price > 0 ? 'price' : 'free',
    link: String(p.link || '').trim(), phone: String(p.phone || '').trim(), ...qrPlace(p), ...framing(p),
  }));
}

// Пакет ИИ-персонажа (JSON): имя, картинки «молчит» и «говорит», голос, приветствие и сценарий кнопок.
// Формат описан в docs/character-pack.md.
// Голос синтеза по языкам: имя голоса Android (выбирается в портале из голосов, установленных на планшетах)
const voiceNames = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {})
  .filter(([l, v]) => ['en', 'th', 'ru', 'zh'].includes(l) && typeof v === 'string' && v).map(([l, v]) => [l, v.slice(0, 80)]));

// ---------- ElevenLabs

async function elevenAdmin(method, p, b) {
  const el = db.eleven;
  if (method === 'POST' && p === '/api/eleven') {
    const key = String(b.key ?? '').trim();
    if (key) { await elevenVoices(key); el.key = key; } // ключ проверяем запросом списка голосов
    else if (b.key === '') el.key = '';
    if (ELEVEN_MODELS.includes(b.model)) el.model = b.model;
    save();
  }
  if (method === 'POST' && p === '/api/eleven/preview') {
    if (!el.key) throw fail(400, 'Сначала сохраните ключ ElevenLabs');
    return { url: await synthesize(UPLOADS, el.key, String(b.voice || ''), el.model, String(b.text || '').slice(0, 400)) };
  }
  if (!el.key) return { connected: false, model: el.model, voices: [] };
  const [voices, usage] = await Promise.all([elevenVoices(el.key).catch((e) => ({ error: e.message })), elevenUsage(el.key)]);
  return { connected: true, model: el.model, voices: voices.error ? [] : voices, error: voices.error, usage };
}

// Планшет просит фразу голосом персонажа: готовый файл — сразу, новый — синтез (не больше 60 новых фраз в час на планшет)
const ttsBudget = new Map();
async function guestTts(q) {
  const d = db.devices[q.d], r = d && db.restaurants[d.restaurantId];
  const c = r && avatarFor(r);
  let text = String(q.t || '').trim().slice(0, 400);
  // теги [..] понимает только eleven_v3 — для других моделей убираем, иначе их прочитают вслух
  if (db.eleven.model !== 'eleven_v3') text = text.replace(/\s*\[[^\]]*\]/g, '').trim();
  if (!c?.tts || !text) throw fail(404, 'no cloud voice');
  if (!cachedTts(UPLOADS, c.voice.eleven, db.eleven.model, text).cached) {
    const hour = Math.floor(Date.now() / 3600e3), bud = ttsBudget.get(d.id);
    const n = bud?.hour === hour ? bud.n : 0;
    if (n >= 60) throw fail(429, 'tts limit');
    ttsBudget.set(d.id, { hour, n: n + 1 });
    logEvent(r.id, 'tts', { chars: text.length });
  }
  return synthesize(UPLOADS, db.eleven.key, c.voice.eleven, db.eleven.model, text);
}

const LANG4 = ['en', 'th', 'ru', 'zh'];

function cleanCharacter(p) {
  if (!p || !p.images?.idle) throw fail(400, 'pack needs images.idle');
  const lines = (o) => (o && typeof o === 'object' ? o : {});
  return {
    id: String(p.id || uid()).replace(/[^\w-]/g, '').slice(0, 40) || uid(),
    name: lines(p.name),
    images: { idle: storeDataUri(p.images.idle), talk: storeDataUri(p.images.talk || p.images.idle) },
    voice: { pitch: Number(p.voice?.pitch) || 1, rate: Number(p.voice?.rate) || 1, names: voiceNames(p.voice?.names), eleven: String(p.voice?.eleven || '').slice(0, 64) },
    // Приветствие и варианты рекомендаций по умолчанию — ресторан может заменить их своими в ЛК.
    // Всё озвучивает ElevenLabs (готовый MP3 хранится на сервере, новая фраза озвучивается заново)
    greetings: lineList(p.greetings?.length ? p.greetings : [p.greeting], texts),
    // { recommend: [{ru,en,th,zh}], dayDish: [...] }; {dish} — где назвать блюдо (без него — в конце фразы).
    // В тексте можно ставить теги ElevenLabs: [giggles], [whispering]… — гость их не видит
    phrases: Object.fromEntries(['recommend', 'dayDish'].map((k) => [k, lineList(p.phrases?.[k], texts)])),
    dialog: p.dialog && typeof p.dialog === 'object' ? p.dialog : { start: 'hello', nodes: {} },
  };
}

// Кнопка заявки на рекламе: тексты на 4 языках (кнопка, «Отправить», сообщение после отправки), место по сетке 4 × 3, форма
const CTA_DEFAULT = {
  text: { ru: 'Оставить заявку', en: 'Request a call', th: 'ขอให้ติดต่อกลับ', zh: '预约咨询' },
  submit: { ru: 'Отправить', en: 'Send', th: 'ส่ง', zh: '提交' },
  done: { ru: 'Данные переданы, с вами свяжутся', en: 'Thank you! We will contact you soon', th: 'ส่งข้อมูลแล้ว เราจะติดต่อกลับ', zh: '已提交，我们会尽快联系您' },
};
function cleanCta(c = {}) {
  const txt = (o, def) => ({ ...def, ...texts(o) });
  return {
    enabled: !!c.enabled, pos: qrPlace({ qrPos: c.pos }).qrPos, shape: c.shape === 'pill' ? 'pill' : 'rect',
    doneSec: Math.min(60, Math.max(1, Math.round(Number(c.doneSec)) || 10)), // сколько секунд держать сообщение после отправки
    text: txt(c.text, CTA_DEFAULT.text), submit: txt(c.submit, CTA_DEFAULT.submit), done: txt(c.done, CTA_DEFAULT.done),
  };
}
const publicCta = (c) => ({ pos: c.pos, shape: c.shape, text: c.text, submit: c.submit, done: c.done, doneSec: c.doneSec || 10 });

// Картинки рекламы по языкам: реклама показывается гостю только на тех языках, где есть картинка и не снята галочка
const AD_LANGS = ['ru', 'en', 'th', 'zh'];
const adImages = (a) => Object.fromEntries(AD_LANGS.map((l) => [l, String(a.images?.[l] || '')]).filter(([, v]) => v));
function cleanAd(a) {
  const images = adImages(a);
  return {
    id: a.id || uid(), advertiser: String(a.advertiser || ''), title: String(a.title || ''), images,
    image: Object.values(images)[0] || '', langOff: [...new Set((Array.isArray(a.langOff) ? a.langOff : []).filter((l) => AD_LANGS.includes(l)))],
    restaurants: (a.restaurants || []).map(String), districts: (a.districts || []).map(String).filter((x) => DISTRICT_IDS.has(x)),
    active: !!a.active, cat: AD_CATS[a.cat] ? a.cat : 'other',
    link: String(a.link || '').trim(), phone: String(a.phone || '').trim(), ...qrPlace(a), ...framing(a),
    cta: cleanCta(a.cta), leadToMe: a.leadToMe !== false, // заявки — в бот оповещений портала (по умолчанию да)
  };
}

// ---------- Заявки по рекламе: имя и телефон гостя → бот оповещений и/или бот рекламодателя, список в портале
db.leads ??= [];
const leadBudget = new Map();
async function guestLead(b) {
  const d = db.devices[b.d], r = d && db.restaurants[d.restaurantId];
  const a = db.ads.find((x) => x.id === b.ad);
  if (!r || !a?.cta?.enabled) throw fail(400, 'bad lead');
  const name = String(b.name || '').trim().slice(0, 60), phone = String(b.phone || '').trim().slice(0, 25);
  if (!/^[+\d][\d\s()-]{4,}$/.test(phone)) throw fail(400, 'bad phone');
  const hour = Math.floor(Date.now() / 3600e3), bud = leadBudget.get(d.id);
  const n = bud?.hour === hour ? bud.n : 0;
  if (n >= 10) throw fail(429, 'too many');
  leadBudget.set(d.id, { hour, n: n + 1 });
  const place = d.role === 'entrance' ? 'вход' : d.table ? tableLabel(d.table) : '';
  const lead = { id: uid(), at: Date.now(), ad: a.id, rid: r.id, dev: d.id, place, name, phone, lang: b.lang, sent: [] };
  db.leads = [lead, ...db.leads].slice(0, 5000);
  logEvent(r.id, 'lead', { dev: d.id, ad: a.id, table: d.table || undefined });
  const text = `📩 Заявка по рекламе «${a.advertiser}${a.title ? ` — ${a.title}` : ''}»\nИмя: ${name || '—'}\nТелефон: ${phone}\n`
    + `Ресторан: ${r.name}${place ? ` · ${place}` : ''}\nВремя: ${clock(lead.at)}`;
  if (a.leadToMe !== false && tgBotsFor('leads').length) { await tgTo('leads', text); lead.sent.push('me'); }
  if (a.leadTg?.token && a.leadTg.chats?.length) { await tgSend(a.leadTg, text); lead.sent.push('advertiser'); }
  save();
  return {};
}
const publicLeadTg = (t) => ({ connected: !!t?.token, bot: t?.bot || '', chats: t?.chats || [] });

// Заявка «Подключить свой ресторан» с планшета: имя и телефон → бот оповещений портала и список в портале
db.joinReqs ??= [];
async function guestJoinRequest(b) {
  const d = db.devices[b.d], r = d && db.restaurants[d.restaurantId];
  if (!d) throw fail(400, 'bad device');
  const name = String(b.name || '').trim().slice(0, 60), phone = String(b.phone || '').trim().slice(0, 25);
  if (!/^[+\d][\d\s()-]{4,}$/.test(phone)) throw fail(400, 'bad phone');
  const hour = Math.floor(Date.now() / 3600e3), bud = leadBudget.get(`j:${d.id}`);
  const n = bud?.hour === hour ? bud.n : 0;
  if (n >= 5) throw fail(429, 'too many');
  leadBudget.set(`j:${d.id}`, { hour, n: n + 1 });
  const place = d.role === 'entrance' ? 'вход' : d.table ? tableLabel(d.table) : '';
  const jr = { id: uid(), at: Date.now(), rid: r?.id || '', dev: d.id, place, name, phone, lang: String(b.lang || '').slice(0, 5), done: false };
  db.joinReqs = [jr, ...db.joinReqs].slice(0, 2000);
  save();
  await tgTo('join', `🤝 Заявка на подключение ресторана\nИмя: ${name || '—'}\nТелефон: ${phone}\n`
    + `Откуда: ${r ? r.name : 'планшет'}${place ? ` · ${place}` : ''} (${d.id})\nВремя: ${clock(jr.at)}`);
  return {};
}

// Бот рекламодателя для заявок: токен, поиск чатов (написали боту /start), тест, удалить получателя
async function adTelegram(a, p, b) {
  a.leadTg ??= { token: '', bot: '', chats: [] };
  const t = a.leadTg;
  if (p.endsWith('/tg')) {
    const token = String(b.token || '').trim();
    const me = token ? await tgApi(token, 'getMe') : null;
    Object.assign(t, { token, bot: me ? me.username : '', chats: token === t.token ? t.chats : [] });
  }
  if (p.endsWith('/tg/find')) await tgFindChats(t);
  if (p.endsWith('/tg/test')) await tgSend(t, `✅ JET MEDIA: сюда будут приходить заявки по рекламе «${a.advertiser}${a.title ? ` — ${a.title}` : ''}».`, true);
  if (p.endsWith('/tg/remove')) t.chats = t.chats.filter((c) => c.id !== b.id);
  save();
  return publicLeadTg(t);
}

// PIN — 4–8 цифр, уникальный в ресторане; пустой или повторный заменяем случайным
function cleanStaff(list) {
  const used = new Set();
  return list.filter((m) => m && String(m.name || '').trim()).map((m) => {
    let pin = String(m.pin || '').trim();
    while (!/^\d{4,8}$/.test(pin) || used.has(pin)) pin = String(crypto.randomInt(1000, 10000));
    used.add(pin);
    return {
      id: m.id || uid(), name: String(m.name).trim().slice(0, 40), role: m.role === 'manager' ? 'manager' : 'waiter', pin,
      tables: (m.tables || []).map(String), test: !!m.test, // тестовый: его действия не идут в статистику
    };
  });
}

const staffNamesOf = (r) => Object.fromEntries([...(r.staffArchive || []).map((m) => [m.id, `${m.name} (уволен)`]), ...(r.staff || []).map((m) => [m.id, m.name])]);

// Персонал: удалённые сотрудники уходят в «Уволенные» (войти не могут). fired[id] = 'drop' — их действия убрать
// из статистики (как тестовые), 'keep' — оставить. Решение потом меняется в списке уволенных
function setStaff(r, list, fired = {}) {
  const next = cleanStaff(list), keep = new Set(next.map((m) => m.id));
  r.staffArchive ??= [];
  for (const m of r.staff || []) {
    if (keep.has(m.id) || r.staffArchive.some((a) => a.id === m.id)) continue;
    r.staffArchive.push({ id: m.id, name: m.name, role: m.role, test: fired[m.id] === 'drop' || !!m.test, firedAt: Date.now() });
  }
  r.staff = next;
  for (const [token, s] of Object.entries(db.sessions)) if (s.restaurantId === r.id && !keep.has(s.staffId)) delete db.sessions[token];
}
function setArchive(r, list) {
  for (const x of list || []) { const a = (r.staffArchive || []).find((y) => y.id === x.id); if (a) a.test = !!x.test; }
}
// Пометка визита стола «тест»: его заказы и вызовы (ids) — в r.testIds
// «Тест» в статистике: помечаем вызовы и заказы визита, какие есть сейчас (новые, пришедшие позже, — настоящие);
// who — кто пометил: видно в журнале визитов
function markTest(r, ids, test, who = '') {
  const set = new Set(r.testIds || []);
  // весь период разом — до 10 000 заказов за раз
  const list = new Set((Array.isArray(ids) ? ids : []).map(String).slice(0, 10000));
  r.testBy ??= {};
  for (const id of list) {
    if (test) { set.add(id); r.testBy[id] = [String(who).slice(0, 60), Date.now()]; } else { set.delete(id); delete r.testBy[id]; }
  }
  r.testIds = [...set].slice(-20000);
  if (Object.keys(r.testBy).length > r.testIds.length) { const keep = new Set(r.testIds); for (const id of Object.keys(r.testBy)) if (!keep.has(id)) delete r.testBy[id]; }
  for (const o of db.orders) if (o.restaurantId === r.id && list.has(o.id)) o.test = !!test;
}
// подпись визита для журнала админки: «Стол 24, визит 08.11 12:07»
const visitLabel = (l) => cut(l, 80);
const period = (q) => {
  const now = Date.now(), to = Math.min(Number(q.to) || now, now + 864e5);
  return { to, from: Math.max(Number(q.from) || to - 7 * 864e5, to - 400 * 864e5) };
};

function admin(method, p, b, me, q) {
  const scope = scopeOf(me);
  if (method === 'GET' && p === '/api/me') {
    return { ...publicAdmin(me), access: Object.fromEntries(ADMIN_SECTIONS.map(([k]) => [k, permOf(me, k)])),
      sections: ADMIN_SECTIONS.map(([k, n, re]) => ({ k, n, re: re.source, viewOnly: VIEW_ONLY.has(k) })) };
  }
  if (method === 'POST' && p === '/api/me/password') {
    if (!passOk(me, b.old)) throw fail(400, 'Текущий пароль неверный');
    if (String(b.password || '').length < 8) throw fail(400, 'Новый пароль — не короче 8 символов');
    Object.assign(me, hashPass(b.password));
    save();
    return {};
  }
  if (p.startsWith('/api/admins')) return adminsApi(method, p, b, me);
  if (p.startsWith('/api/crm')) return crmApi(method, p, b, me);
  if (p.startsWith('/api/expenses')) return expensesApi(method, p, b, me);
  if (method === 'GET' && p === '/api/audit') return readAudit(q, scope);
  // Статистика: сеть (все доступные рестораны) и, если выбран ресторан, его подробный отчёт
  if (method === 'GET' && p === '/api/stats') {
    const { from, to } = period(q);
    const rids = new Set(Object.keys(db.restaurants).filter((id) => !scope || scope.has(id)));
    const r = q.r && rids.has(q.r) ? db.restaurants[q.r] : null;
    return {
      restaurants: [...rids].map((id) => ({ id, name: db.restaurants[id].name })),
      network: networkReport({ log: events, db, rids: r ? new Set([r.id]) : rids, from, to, tests: q.tests === '1', dayFrom, waitersOf }),
      restaurant: r ? restaurantReport({ log: events, db, r, from, to, staffNames: staffNamesOf(r), tests: q.tests === '1', dayFrom, waitersOf }) : null,
    };
  }
  if (p.startsWith('/api/telegram')) return telegramAdmin(method, p, b);
  if (method === 'GET' && p === '/api/pending') {
    // Ожидающие подтверждения за последние сутки
    return Object.values(db.pending).filter((d) => Date.now() - d.lastSeen < 864e5);
  }
  let pm = p.match(/^\/api\/pending\/([^/]+)(\/approve)?$/);
  if (pm && db.pending[decodeURIComponent(pm[1])]) {
    const pd = db.pending[decodeURIComponent(pm[1])];
    if (method === 'POST' && pm[2]) {
      db.devices[pd.id] = { id: pd.id, firstSeen: Date.now(), queue: [], telemetry: pd.telemetry, lastSeen: pd.lastSeen, ip: pd.ip };
    }
    if ((method === 'POST' && pm[2]) || (method === 'DELETE' && !pm[2])) {
      delete db.pending[pd.id];
      save();
      return {};
    }
  }
  if (p === '/api/devices/_wifi') {
    if (scope) throw fail(403, 'Нет доступа');
    if (method === 'POST') {
      if (INSTANCE === 'test') throw fail(400, 'Меняется в рабочей админке (app.jetmedia.dev) — планшеты связаны с рабочей');
      if (b.allowOpen !== undefined) db.allowOpenWifi = !!b.allowOpen;
      if (b.fleet !== undefined) db.fleetWifi = cleanNets(b.fleet);
      save();
    }
    return { allowOpen: !!db.allowOpenWifi, instance: INSTANCE, fleet: netsPublic(db.fleetWifi, permOf(me, 'devices') === 'edit') };
  }
  if (method === 'GET' && p === '/api/devices') {
    const list = () => {
      const now = Date.now();
      return Object.values(db.devices).filter((d) => !scope || scope.has(d.restaurantId)).map(({ queue, wifiList, ...d }) => {
        const r = db.restaurants[d.restaurantId];
        return { ...d, online: now - d.lastSeen < ONLINE_MS, pending: (queue || []).length, work: workStats(d, now),
          outages: (d.outages || []).slice(0, 30).map((x) => (r && !isWorking(r, x.start, 0) ? { ...x, off: true } : x)) };
      });
    };
    return INSTANCE === 'test' ? pullAllDevices().then(list) : list();
  }
  if (method === 'GET' && p === '/api/restaurants') {
    const list = Object.values(db.restaurants).filter((r) => !scope || scope.has(r.id));
    // без доступа к «Ресторанам» — только то, что нужно другим разделам (без меню, персонала, PIN, паролей Wi-Fi)
    if (permOf(me, 'rest') === 'none') {
      return list.map((r) => ({ ...pick(r, ['id', 'name', 'district', 'address', 'geo', 'langs', 'tariff', 'tables', 'blockedAds', 'blockedCats']),
        hoursInfo: { used: hoursOf(r), usedText: hoursText(hoursOf(r)) } }));
    }
    return list.map((r) => ({ ...r, menuSource: publicSource(r.menuSource), tagRules: r.tagRules || DEFAULT_RULES, customTags: r.customTags || [], menuIssues: menuIssues(r),
      hoursInfo: { detected: detected(r.id), used: hoursOf(r), usedText: hoursText(hoursOf(r)) },
      wifiStatus: wifiStatus(r) }));
  }
  if (method === 'POST' && p === '/api/restaurants') {
    if (scope && !scope.has(b.id)) throw fail(403, 'Нет доступа к этому ресторану');
    const id = b.id || uid();
    const prev = db.restaurants[id] || { staffCode: String(crypto.randomInt(100000, 1000000)) };
    db.restaurants[id] = {
      ...prev, id,
      name: String(b.name || 'Ресторан'),
      tables: prev.tables || [],
      langs: b.langs || prev.langs || ['en', 'th', 'ru', 'zh'],
      menu: prev.menu || [],
      staff: prev.staff || [],
      promos: Array.isArray(b.promos) ? cleanPromos(b.promos) : prev.promos || [],
      tariff: b.tariff === 'premium' ? 'premium' : 'standard',
      // где ресторан: район Пхукета, адрес, точка на карте (из ссылки Google Maps)
      district: b.district !== undefined ? (DISTRICT_IDS.has(b.district) ? b.district : '') : prev.district || '',
      address: b.address !== undefined ? String(b.address || '').trim().slice(0, 200) : prev.address || '',
      geo: b.geo !== undefined ? cleanGeo(b.geo) : prev.geo || null,
      // реклама: после каждых N слайдов ресторана и какая реклама в этом ресторане не показывается
      blockedAds: Array.isArray(b.blockedAds) ? b.blockedAds.map(String) : prev.blockedAds || [],
      blockedCats: Array.isArray(b.blockedCats) ? b.blockedCats.filter((c) => AD_CATS[c]) : prev.blockedCats,
      display: b.adEvery !== undefined ? { ...prev.display, adEvery: Math.min(10, Math.max(1, Math.round(Number(b.adEvery)) || 2)) } : prev.display,
      menuSource: b.menuSource ? cleanSource(b.menuSource, prev.menuSource) : prev.menuSource,
      customTags: Array.isArray(b.customTags) ? cleanCustomTags(b.customTags) : prev.customTags,
      syncKey: prev.syncKey || crypto.randomBytes(12).toString('hex'),
      // часы работы: по планшетам / вручную / нет (демо) — для тревог о связи и сводки
      hours: b.hours !== undefined ? cleanHours(b.hours) : prev.hours,
      // Wi-Fi меняется только в рабочей админке: планшеты связаны с рабочей
      wifiList: b.wifiList !== undefined && INSTANCE !== 'test' ? cleanNets(b.wifiList) : prev.wifiList || [],
    };
    delete db.restaurants[id].wifi;
    if (netsSig(db.restaurants[id].wifiList) !== netsSig(prev.wifiList)) audit(me.email, `Wi-Fi ресторана «${db.restaurants[id].name}» изменён: ${db.restaurants[id].wifiList.map((n) => n.ssid + (n.primary ? ' (основная)' : '')).join(', ') || 'сетей нет'}`, id);
    hoursCache.delete(id);
    // меню — по источнику до этого сохранения: если ресторан уже синхронизировался, присланное меню не заменяет синхронизированное
    if (Array.isArray(b.tagRules)) db.restaurants[id].tagRules = cleanRules(b.tagRules, db.restaurants[id]);
    if (Array.isArray(b.menu)) setMenu(db.restaurants[id], b.menu, !!prev.menuSource && prev.menuSource.type !== 'manual');
    if (Array.isArray(b.staff)) setStaff(db.restaurants[id], b.staff, b.fired || {});
    if (Array.isArray(b.staffArchive)) setArchive(db.restaurants[id], b.staffArchive);
    // Из портала приходят номера («1-10, B1») — превращаем в полные названия, сохраняя привязки
    const old = prev.tables || [];
    saveTables(db.restaurants[id], (b.tables || []).map(String).map((raw) => ({
      from: old.includes(raw) ? raw : old.includes(fullTable(raw)) ? fullTable(raw) : '', to: fullTable(raw),
    })));
    save();
    return db.restaurants[id];
  }
  // Районы и схема острова для карты; ссылка Google Maps → координаты и ближайший район
  if (method === 'GET' && p === '/api/geo') return { districts: DISTRICTS, outline: OUTLINE };
  if (method === 'POST' && p === '/api/geo/resolve') return resolveMapLink(b.url);
  if (method === 'GET' && p === '/api/server') {
    if (scope) throw fail(403, 'Нет доступа');
    return serverPanel();
  }
  if (method === 'POST' && p === '/api/export/link') {
    if (scope) throw fail(403, 'Нет доступа');
    for (const [k, l] of Object.entries(db.exportLinks)) if (l.until < Date.now()) delete db.exportLinks[k];
    const token = crypto.randomBytes(24).toString('base64url'), until = Date.now() + 48 * 3600e3;
    db.exportLinks[token] = { until, by: me.email };
    save();
    return { url: `${PUBLIC_URL}/export/${token}/photos.zip`, until };
  }
  if (method === 'GET' && p === '/api/ad-cats') return Object.entries(AD_CATS).map(([id, name]) => ({ id, name }));
  // Заявки на подключение ресторана с планшетов (окно «О системе» по нажатию на номер стола)
  if (p.startsWith('/api/join-requests')) {
    if (scope) throw fail(403, 'Нет доступа');
    if (method === 'GET') return db.joinReqs.map((x) => ({ ...x, rest: db.restaurants[x.rid]?.name || '' }));
    const jr = db.joinReqs.find((x) => x.id === decodeURIComponent(p.split('/')[3] || ''));
    if (!jr) throw fail(404, 'Заявка не найдена');
    if (method === 'DELETE') db.joinReqs = db.joinReqs.filter((x) => x !== jr);
    else if (method === 'POST') { jr.done = !!b.done; jr.note = String(b.note ?? jr.note ?? '').slice(0, 300); }
    save();
    return {};
  }
  if (method === 'GET' && p === '/api/ads') {
    return db.ads.map(({ leadTg, ...a }) => ({ ...a, cta: cleanCta(a.cta), leadTg: publicLeadTg(leadTg), views: views(a.id), scans: scans(a.id),
      leads: db.leads.filter((l) => l.ad === a.id).length }));
  }
  // Заявки по рекламе (последние 300; по одной рекламе — ?ad=)
  if (method === 'GET' && p === '/api/leads') {
    return db.leads.filter((l) => !q.ad || l.ad === q.ad).slice(0, 300).map((l) => ({ ...l, rest: db.restaurants[l.rid]?.name || '' }));
  }
  let am = p.match(/^\/api\/ads\/([^/]+)\/tg(\/find|\/test|\/remove)?$/);
  const tgAd = am && db.ads.find((a) => a.id === am[1]);
  if (method === 'POST' && tgAd) return adTelegram(tgAd, p, b);
  if (method === 'GET' && p === '/api/characters') return db.characters;
  // ElevenLabs: ключ (наружу не отдаём), модель, голоса аккаунта, остаток символов
  if (p.startsWith('/api/eleven')) return elevenAdmin(method, p, b);
  // Голоса, которые есть на планшетах (по языкам), и планшеты, на которых можно прослушать
  if (method === 'GET' && p === '/api/voices') {
    const voices = { en: [], ru: [], th: [], zh: [] }, devices = [];
    for (const d of Object.values(db.devices)) {
      const list = d.telemetry?.voices || [];
      if (!list.length) continue;
      devices.push({ id: d.id, online: Date.now() - d.lastSeen < ONLINE_MS, place: deviceName(d) });
      for (const v of list) { const l = v.slice(0, 2) === 'cm' ? 'zh' : v.slice(0, 2); if (voices[l] && !voices[l].includes(v)) voices[l].push(v); }
    }
    for (const l in voices) voices[l].sort();
    return { voices, devices };
  }
  // Каким ресторанам доступен персонаж (остальные не видят его в ЛК, планшеты его не показывают)
  const am2 = p.match(/^\/api\/characters\/([^/]+)\/access$/);
  const ac = am2 && db.characters.find((x) => x.id === decodeURIComponent(am2[1]));
  if (method === 'POST' && ac) {
    ac.restaurants = [...new Set((Array.isArray(b.restaurants) ? b.restaurants : []).map(String))].filter((id) => db.restaurants[id]);
    save();
    return ac;
  }
  let vm = p.match(/^\/api\/characters\/([^/]+)\/voice$/);
  const vc = vm && db.characters.find((x) => x.id === decodeURIComponent(vm[1]));
  if (method === 'POST' && vc) {
    vc.voice = { ...vc.voice, names: voiceNames(b.names), eleven: String(b.eleven || '').slice(0, 64) };
    save();
    return vc;
  }
  if (method === 'POST' && p === '/api/characters') {
    const c = cleanCharacter(b);
    // Повторная загрузка пакета не сбрасывает голоса, выбранные в портале
    const prev = db.characters.find((x) => x.id === c.id);
    if (prev && !Object.keys(c.voice.names).length) c.voice.names = prev.voice?.names || {};
    if (prev && !c.voice.eleven) c.voice.eleven = prev.voice?.eleven || '';
    c.restaurants = prev?.restaurants || []; // доступ ресторанам выдаётся отдельно
    db.characters = db.characters.filter((x) => x.id !== c.id).concat(c);
    save();
    return c;
  }
  if (method === 'POST' && p === '/api/ads') {
    const ad = cleanAd(b);
    ad.leadTg = db.ads.find((a) => a.id === ad.id)?.leadTg; // бот рекламодателя меняется отдельно и наружу не отдаётся
    const i = db.ads.findIndex((a) => a.id === ad.id);
    if (i >= 0) db.ads[i] = ad; else db.ads.push(ad);
    save();
    return ad;
  }
  let m = p.match(/^\/api\/ads\/([^/]+)$/);
  if (m && method === 'DELETE') { db.ads = db.ads.filter((a) => a.id !== m[1]); save(); return {}; }
  m = p.match(/^\/api\/characters\/([^/]+)$/);
  if (m && method === 'DELETE') { db.characters = db.characters.filter((c) => c.id !== m[1]); save(); return {}; }
  m = p.match(/^\/api\/restaurants\/([^/]+)$/);
  if (m && method === 'DELETE') {
    if (scope) throw fail(403, 'Нет доступа');
    delete db.restaurants[m[1]]; save(); return {};
  }
  m = p.match(/^\/api\/restaurants\/([^/]+)\/test-visit$/);
  if (m && method === 'POST' && db.restaurants[m[1]]) {
    if (scope && !scope.has(m[1])) throw fail(403, 'Нет доступа к этому ресторану');
    markTest(db.restaurants[m[1]], b.ids, b.test, me.name || me.email);
    save();
    return {};
  }
  m = p.match(/^\/api\/restaurants\/([^/]+)\/sync$/);
  if (m && method === 'POST' && db.restaurants[m[1]]) {
    if (scope && !scope.has(m[1])) throw fail(403, 'Нет доступа к этому ресторану');
    const rr = db.restaurants[m[1]];
    return (b.once ? importOnce(rr) : syncMenu(rr, true)).then(() => publicSource(rr.menuSource));
  }

  // Тяжёлые картинки (больше 300 КБ) в загрузках, на которые ссылаются реклама, акции и меню, — портал пережимает их
  if (method === 'GET' && p === '/api/uploads/heavy') {
    if (scope) throw fail(403, 'Нет доступа');
    const uses = new Map();
    const add = (url, kind) => { if (typeof url === 'string' && /^\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/.test(url) && !uses.has(url)) uses.set(url, kind); };
    for (const a of db.ads) { add(a.image, 'slide'); Object.values(a.images || {}).forEach((u) => add(u, 'slide')); }
    for (const r of Object.values(db.restaurants)) {
      for (const pr of r.promos || []) { add(pr.image, 'slide'); Object.values(pr.images || {}).forEach((u) => add(u, 'slide')); }
      for (const i of r.menu || []) add(i.photo, i.fromPromo ? 'slide' : 'photo');
    }
    return [...uses].map(([url, kind]) => {
      try { return { url, kind, size: fs.statSync(path.join(UPLOADS, url.slice(9))).size }; } catch { return null; }
    }).filter((x) => x && x.size > 300 * 1024);
  }
  if (method === 'POST' && p === '/api/uploads/replace') {
    if (scope) throw fail(403, 'Нет доступа');
    const ok = (u) => typeof u === 'string' && /^\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/.test(u);
    if (!ok(b.from) || !ok(b.to) || !fs.existsSync(path.join(UPLOADS, b.to.slice(9)))) throw fail(400, 'bad file');
    let n = 0;
    const swap = (o, k) => { if (o[k] === b.from) { o[k] = b.to; n++; } };
    for (const a of db.ads) { swap(a, 'image'); for (const l of Object.keys(a.images || {})) swap(a.images, l); }
    for (const r of Object.values(db.restaurants)) {
      for (const pr of r.promos || []) { swap(pr, 'image'); for (const l of Object.keys(pr.images || {})) swap(pr.images, l); }
      for (const i of r.menu || []) swap(i, 'photo');
    }
    save();
    return { n };
  }
  // Версии (рабочая и тестовая) и переключение планшетов между ними
  if (method === 'GET' && p === '/api/devices/_versions') {
    return (INSTANCE === 'test' ? Promise.resolve(VERSION) : getTestVersion())
      .then((test) => ({ instance: INSTANCE, prod: INSTANCE === 'prod' ? VERSION : null, test, testUrl: TEST_URL, copiedAt: INSTANCE === 'test' ? settingsBackupAt() : 0 }));
  }
  // Тестовая: перенести все пользовательские настройки с рабочей / вернуть как было
  if (method === 'POST' && p === '/api/settings/copy-from-prod') {
    if (me.role !== 'super') throw fail(403, 'Переносит настройки только суперадмин');
    return b.undo ? restoreSettings(me.email) : copySettingsFromProd(me.email);
  }
  if (method === 'POST' && p === '/api/devices/_channel') {
    if (INSTANCE === 'test') throw fail(400, 'Переключать версии можно в рабочем портале');
    if (scope && b.restaurantId && !scope.has(b.restaurantId)) throw fail(403, 'Нет доступа');
    return (b.channel === 'test' ? testAlive() : Promise.resolve()).then(() => {
      let n = 0;
      for (const x of Object.values(db.devices)) {
        if (!x.restaurantId || (scope && !scope.has(x.restaurantId)) || (b.restaurantId && x.restaurantId !== b.restaurantId)) continue;
        // планшеты, которые уже на нужной версии, не перезагружаем (у гостя не пропадёт набранный заказ)
        const ch = b.channel === 'test' ? 'test' : undefined;
        if (x.channel === ch) continue;
        x.channel = ch;
        if (x.table || x.role === 'entrance') { x.queue.push({ type: 'url', url: guestUrl(x) }); n++; }
      }
      save();
      return { n };
    });
  }
  m = p.match(/^\/api\/devices\/([^/]+)(?:\/(command|assign|channel|wifi))?$/);
  const d = m && db.devices[decodeURIComponent(m[1])];
  if (!d) return undefined;
  if (m[2] === 'wifi') {
    // Сети планшета: свои (с паролями — при праве на редактирование), унаследованные от ресторана и парка, статистика
    if (method === 'POST') {
      if (INSTANCE === 'test') throw fail(400, 'Меняется в рабочей админке (app.jetmedia.dev) — планшеты связаны с рабочей');
      if (scope && !scope.has(d.restaurantId)) throw fail(403, 'Нет доступа');
      d.wifiList = cleanNets(b.list);
      save();
    }
    const r = db.restaurants[d.restaurantId], wf = wifiFor(d), edit = permOf(me, 'devices') === 'edit';
    return { own: netsPublic(d.wifiList, edit), restaurant: (r?.wifiList || []).map(({ ssid, primary }) => ({ ssid, primary })),
      fleet: db.fleetWifi.map(({ ssid, primary }) => ({ ssid, primary })), primary: wf.primary, nets: wf.nets.map(({ ssid, level }) => ({ ssid, level })),
      got: !!wf.v && d.telemetry?.wifiV === wf.v, current: d.telemetry?.wifi || '', stats: d.telemetry?.nets || [], restName: r?.name || '' };
  }
  if (scope && (!scope.has(d.restaurantId) || (m[2] === 'assign' && b.restaurantId && !scope.has(b.restaurantId)))) throw fail(403, 'Нет доступа');
  if (method === 'DELETE' && !m[2]) { delete db.devices[d.id]; save(); return {}; }
  if (method === 'POST' && m[2] === 'command') {
    if (!COMMANDS.includes(b.type)) throw fail(400, 'unknown command');
    d.queue.push(b);
    // «Страница» вручную: её и держим; пустая — снова страница стола (если привязан)
    if (b.type === 'url') { if (b.url) d.urlWant = String(b.url); else delete d.urlWant; }
    if (b.type === 'update') d.upd = { at: Date.now(), from: d.telemetry?.version || '', tries: 1, lastTry: Date.now(), status: 'sent' };
    save();
    return {};
  }
  if (method === 'POST' && m[2] === 'channel') {
    if (INSTANCE === 'test') throw fail(400, 'Переключать версии можно в рабочем портале');
    const ch = b.channel === 'test' ? 'test' : undefined;
    return (ch ? testAlive() : Promise.resolve()).then(() => {
      if (d.channel !== ch && (d.table || d.role === 'entrance')) { delete d.urlWant; d.queue.push({ type: 'url', url: guestUrl({ ...d, channel: ch }) }); }
      d.channel = ch;
      save();
      return {};
    });
  }
  if (method === 'POST' && m[2] === 'assign') {
    // Привязка к столу сразу переключает планшет на интерфейс стола
    d.restaurantId = b.restaurantId || null;
    d.role = b.restaurantId && b.table === 'entrance' ? 'entrance' : 'table';
    d.table = b.restaurantId && b.table && d.role === 'table' ? String(b.table) : null;
    const placed = d.table || d.role === 'entrance';
    delete d.urlWant; // привязали к столу — страница стола
    d.queue.push({ type: 'url', url: placed ? guestUrl(d) : '' });
    save();
    return {};
  }
  return undefined;
}

const PUBLIC = {
  'POST /api/device/poll': devicePoll,
  'POST /api/device/alert': deviceAlert,
  'POST /api/device/bye': deviceBye,
  'GET /api/device/fleet-wifi': fleetWifiForProvision,
  'GET /api/guest/state': guestState,
  'POST /api/guest/call': guestCall,
  'POST /api/guest/cancel': guestCancel,
  'POST /api/guest/cancel-why': guestCancelWhy,
  'POST /api/guest/join': guestJoin,
  'GET /api/version': () => ({ version: VERSION, instance: INSTANCE }),
  'GET /api/internal/device': internalDevice,
  'GET /api/internal/settings': internalSettings,
  'GET /api/internal/devices': internalDevices,
  'GET /api/internal/server': internalServer,
  'GET /api/diag/devices': diagDevices,
  'GET /api/diag/events': diagEvents,
  'GET /api/diag/server': diagServer,
  'GET /api/diag/push': diagPush,
  'GET /api/kitchen/state': kitchenState,
  'POST /api/kitchen/ready': kitchenReady,
  'POST /api/guest/order': guestOrder,
  'GET /api/staff/state': staffState,
  'POST /api/staff/action': staffAction,
  'POST /api/staff/undo': staffUndo,
  'POST /api/staff/order': staffOrder,
  'POST /api/staff/login': staffLogin,
  'POST /api/staff/shift': staffShift,
  'POST /api/staff/subscribe': staffSubscribe,
  'POST /api/staff/push-test': staffPushTest,
  'POST /api/staff/push-ack': staffPushAck,
  'POST /api/staff/logout': staffLogout,
  'GET /api/staff/menu': staffMenu,
  'POST /api/guest/impression': guestImpression,
  'POST /api/guest/event': guestEvent,
  'POST /api/guest/lead': guestLead,
  'POST /api/guest/join-request': guestJoinRequest,
  'GET /api/manager/restaurant': managerGet,
  'POST /api/manager/restaurant': managerSave,
  'POST /api/manager/sync': managerSync,
  'GET /api/manager/stats': managerStats,
  'POST /api/menu/webhook': menuWebhook,
};

for (const r of Object.values(db.restaurants)) if (r.promos?.some((p) => p.name === undefined)) r.promos = cleanPromos(r.promos);
// Однократно при первом запуске статистики: вызовы и заказы, которые ещё хранятся (до 7 дней), — в журнал событий
if (!fs.existsSync(path.join(DATA_DIR, 'events'))) {
  const old = [];
  for (const c of db.calls) {
    old.push({ t: c.at, r: c.restaurantId, k: 'call', id: c.id, table: c.table, type: c.type });
    const ack = c.ackAt || c.doneAt;
    if (ack) old.push({ t: ack, r: c.restaurantId, k: 'call_ack', id: c.id, table: c.table, type: c.type, ms: ack - c.at, by: c.by && `name:${c.by}`, bn: c.by });
  }
  for (const o of db.orders) {
    old.push({ t: o.at, r: o.restaurantId, k: 'order', id: o.id, table: o.table, total: o.total, items: (o.items || []).map((i) => [i.id, i.qty, i.price]) });
    if (o.ackAt) old.push({ t: o.ackAt, r: o.restaurantId, k: 'order_ack', id: o.id, table: o.table, ms: o.ackAt - o.at, total: o.total, by: o.ackBy && `name:${o.ackBy}`, bn: o.ackBy });
    if (o.paidAt) old.push({ t: o.paidAt, r: o.restaurantId, k: 'paid', id: o.id, table: o.table, total: o.total, by: o.paidBy && `name:${o.paidBy}`, bn: o.paidBy });
  }
  fs.mkdirSync(path.join(DATA_DIR, 'events'), { recursive: true });
  for (const e of old.filter((x) => x.t).sort((x, y) => x.t - y.t)) events.add(e);
}

// Починка названий акций «[object Object]»: берём название из строки меню акции, если оно уцелело
for (const r of Object.values(db.restaurants)) {
  for (const p of r.promos || []) {
    if (p.name !== BROKEN) continue;
    const it = (r.menu || []).find((i) => i.id === `promo-${p.id}`);
    p.name = (it && Object.values(it.name || {}).find((v) => v && v !== BROKEN)) || '';
  }
}

// Однократно: всё, что было до этого обновления (пилотные тесты), и все нынешние сотрудники — тестовые
db.migrations ??= {};
if (!db.migrations.hours) {
  for (const r of Object.values(db.restaurants)) {
    if (r.hours) continue;
    if (/demo|демо/i.test(r.name)) r.hours = { mode: 'none' };
    else if (/чехов|chek/i.test(r.name)) r.hours = { mode: 'auto', from: 600, to: 0 };
  }
  db.migrations.hours = Date.now();
}
// Все фото акций и рекламы одним ZIP: «Ресторан/Акции/01 Название_RU.jpg», «Реклама/Рекламодатель — название/RU.jpg»,
// плюс постеры Чехова на других языках, которые сделал Claude (assets/chekhoff/gen) — «Чехов/Новые языки (Claude)/…»
const safeName = (x) => String(x || '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'без названия';
function photoFiles() {
  const files = [], seen = new Set();
  const add = (name, url) => {
    const m = String(url || '').match(/^\/uploads\/([a-f0-9]+\.(jpg|png|webp))$/);
    if (!m) return;
    const ext = m[2], full = `${name}.${ext}`;
    if (seen.has(full)) return;
    try { files.push({ name: full, data: fs.readFileSync(path.join(UPLOADS, m[1])) }); seen.add(full); } catch { /* файла нет */ }
  };
  for (const r of Object.values(db.restaurants)) {
    (r.promos || []).forEach((p, i) => {
      const base = `${safeName(r.name)}/Акции/${String(i + 1).padStart(2, '0')} ${safeName(p.name)}${p.active ? '' : ' (выключена)'}`;
      const imgs = Object.entries(p.images || {});
      if (imgs.length) imgs.forEach(([l, u]) => add(`${base}_${l.toUpperCase()}`, u));
      else add(`${base}_ВСЕ ЯЗЫКИ`, p.image);
    });
  }
  for (const a of db.ads) {
    const base = `Реклама/${safeName([a.advertiser, a.title].filter(Boolean).join(' — '))}${a.active ? '' : ' (выключена)'}`;
    const imgs = Object.entries(a.images || {});
    if (imgs.length) imgs.forEach(([l, u]) => add(`${base}/${l.toUpperCase()}`, u));
    else add(`${base}/ВСЕ ЯЗЫКИ`, a.image);
  }
  const gen = new URL('./assets/chekhoff/gen/', import.meta.url);
  try {
    for (const f of fs.readdirSync(gen).sort()) if (/\.(jpg|png|webp)$/.test(f)) files.push({ name: `Чехов/Новые языки (Claude)/${f}`, data: fs.readFileSync(new URL(f, gen)) });
  } catch { /* нет готовых */ }
  return files;
}
function sendPhotosZip(res) {
  const stamp = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="jetmedia-photos-${stamp}.zip"` });
  writeZip(res, photoFiles());
}
// Ссылка только на чтение на тот же ZIP — на 48 часов (передать без пароля к админке)
db.exportLinks ??= {};

// При запуске: недостающие переводы меню из словаря (новые строки словаря — сразу после обновления)
{
  let n = 0;
  for (const r of Object.values(db.restaurants)) n += translateMenu(r);
  if (n) { console.log(`Переводы меню: добавлено ${n}`); save(); }
}

// Однократно: у рекламы была одна картинка — теперь это русская, остальные языки загружают отдельно
if (!db.migrations.adLangs) {
  for (const a of db.ads) if (a.image && !a.images) a.images = { ru: a.image };
  db.migrations.adLangs = true;
}
if (!db.migrations.testAll) {
  for (const r of Object.values(db.restaurants)) {
    r.testBefore = Date.now();
    for (const m of r.staff || []) m.test = true;
    delete r.statsExclude;
  }
  db.migrations.testAll = Date.now();
  save();
}

// Однократно: новые постеры акций Чехова — без цены на картинке, низ свободен под кнопку «Заказать»; названия и цены.
// Старые постеры узнаём по размеру: 1600 × 1972, пережатые ЛК при загрузке до 1039 × 1280. Другие акции не трогаем
const L4 = (ru, en, th, zh) => ({ ru, en, th, zh });
const CHEKHOFF_PROMOS = [
  { name: 'Гиннесс + креветки', price: 640, title: L4('Гиннесс 0,5 л + отварные креветки 500 г', 'Guinness 0.5 L + Boiled Shrimps 500 g', 'กินเนสส์ 0.5 ลิตร + กุ้งต้ม 500 กรัม', '健力士 0.5升 + 水煮虾 500克') },
  { name: 'Гиннесс + лосось', price: 480, title: L4('Гиннесс 0,5 л + копчёный лосось', 'Guinness 0.5 L + Smoked Salmon', 'กินเนสส์ 0.5 ลิตร + แซลมอนรมควัน', '健力士 0.5升 + 烟熏三文鱼') },
  { name: 'Паэлья + бокал вина', price: 630, title: L4('Паэлья на одного + бокал испанского вина', 'Paella for One + a Glass of Spanish Wine', 'ปาเอยาสำหรับ 1 ท่าน + ไวน์สเปน 1 แก้ว', '单人西班牙海鲜饭 + 一杯西班牙葡萄酒') },
  { name: 'Большая паэлья + бутылка вина', price: 2000, title: L4('Большая паэлья на 4–6 человек + бутылка вина', 'Big Paella for 4–6 + a Bottle of Wine', 'ปาเอยาใหญ่ 4–6 ท่าน + ไวน์ 1 ขวด', '4–6人大份西班牙海鲜饭 + 一瓶葡萄酒') },
  { name: 'Гуакамоле + 8 шотов текилы', price: 1200, title: L4('Гуакамоле + 8 шотов текилы', 'Guacamole + 8 Shots of Tequila', 'กัวคาโมเล่ + เตกีล่า 8 ช็อต', '牛油果酱 + 8杯龙舌兰') },
  { name: 'Водка + мясное ассорти', price: 900, title: L4('Водка «Русский Стандарт» 200 мл + мясное ассорти', 'Russian Standard Vodka 200 ml + Meat Platter', 'วอดก้า Russian Standard 200 มล. + เนื้อรวม', '俄罗斯标准伏特加 200毫升 + 肉类拼盘') },
  { name: 'Гиннесс + бургер', price: 450, title: L4('Гиннесс 0,5 л + бургер с говядиной', 'Guinness 0.5 L + Beef Burger', 'กินเนสส์ 0.5 ลิตร + เบอร์เกอร์เนื้อ', '健力士 0.5升 + 牛肉汉堡') },
];
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
const isOldPoster = (p) => {
  const f = String(p.image || '').match(/^\/uploads\/([a-f0-9]+\.jpg)$/);
  try {
    const sz = f && jpegSize(fs.readFileSync(path.join(UPLOADS, f[1])));
    return !!sz && ((Math.abs(sz.w - 1039) <= 2 && Math.abs(sz.h - 1280) <= 2) || (sz.w === 1600 && sz.h === 1972));
  } catch { return false; }
};
if (!db.migrations.chekhoffPromos) {
  for (const r of Object.values(db.restaurants).filter((x) => /чех|chek/i.test(x.name))) {
    const old = (r.promos || []).filter(isOldPoster);
    if (!old.length) { audit('сервер', 'Новые постеры акций Чехова: старых постеров не найдено, ничего не менял', r.id); continue; }
    const fresh = CHEKHOFF_PROMOS.map((x, i) => ({
      id: uid(), name: x.name, price: x.price, active: true, link: '', phone: '', ...qrPlace({}), ...framing({}),
      image: storeFile(fs.readFileSync(new URL(`./assets/chekhoff/promo-${i + 1}.jpg`, import.meta.url)), 'jpg'),
    }));
    r.promos = [...fresh, ...(r.promos || []).filter((p) => !old.includes(p))];
    syncPromoItems(r);
    fresh.forEach((p, i) => { const it = r.menu.find((m) => m.id === `promo-${p.id}`); if (it) it.name = { ...CHEKHOFF_PROMOS[i].title }; });
    audit('сервер', `Акции Чехова: ${old.length} старых постеров заменены на 7 новых (названия и цены заданы)`, r.id);
  }
  db.migrations.chekhoffPromos = Date.now();
  save();
}

// Однократно: Чехов — русские версии 7 постеров, акция без названия → «2 + 1 коктейля» (русский постер, «Заказать по акции»),
// строки меню акций — «Акция N: название» на 4 языках
const CHEKHOFF_SHORT = [
  L4('Гиннесс + креветки', 'Guinness + Shrimps', 'กินเนสส์ + กุ้ง', '健力士 + 虾'),
  L4('Гиннесс + лосось', 'Guinness + Salmon', 'กินเนสส์ + แซลมอน', '健力士 + 三文鱼'),
  L4('Паэлья + бокал вина', 'Paella + Glass of Wine', 'ปาเอยา + ไวน์ 1 แก้ว', '海鲜饭 + 一杯葡萄酒'),
  L4('Большая паэлья + бутылка вина', 'Big Paella + Bottle of Wine', 'ปาเอยาใหญ่ + ไวน์ 1 ขวด', '大份海鲜饭 + 一瓶葡萄酒'),
  L4('Гуакамоле + 8 шотов текилы', 'Guacamole + 8 Tequila Shots', 'กัวคาโมเล่ + เตกีล่า 8 ช็อต', '牛油果酱 + 8杯龙舌兰'),
  L4('Водка + мясное ассорти', 'Vodka + Meat Platter', 'วอดก้า + เนื้อรวม', '伏特加 + 肉类拼盘'),
  L4('Гиннесс + бургер', 'Guinness + Burger', 'กินเนสส์ + เบอร์เกอร์', '健力士 + 汉堡'),
];
const COCKTAILS = L4('2 + 1 коктейля', '2 + 1 Cocktails', 'ค็อกเทล 2 แถม 1', '鸡尾酒买二送一');
const asset = (f) => fs.readFileSync(new URL(`./assets/chekhoff/${f}`, import.meta.url));
const assetUrl = (f) => `/uploads/${crypto.createHash('sha1').update(asset(f)).digest('hex').slice(0, 20)}.jpg`;
if (!db.migrations.chekhoffRu) {
  for (const r of Object.values(db.restaurants).filter((x) => /чех|chek/i.test(x.name))) {
    const done = [];
    r.promos = cleanPromos(r.promos || []);
    // 7 новых постеров (по их картинке): английская версия + русская
    for (let i = 1; i <= 7; i++) {
      const p = r.promos.find((x) => x.image === assetUrl(`promo-${i}.jpg`));
      if (!p) continue;
      p.images = { en: p.image, ru: storeFile(asset(`ru-${i}.jpg`), 'jpg') };
      p.titles = CHEKHOFF_SHORT[i - 1];
      done.push(i);
    }
    // акция без названия — коктейли «Купи 2, получи 1»
    let c = r.promos.find((x) => !x.name.trim());
    const ruImg = storeFile(asset('cocktails-ru.jpg'), 'jpg');
    if (c) c.images = { ...(c.images || {}), en: c.images?.en || c.image, ru: ruImg };
    else r.promos.push((c = { id: uid(), image: ruImg, images: { ru: ruImg }, active: true, link: '', phone: '', ...qrPlace({}), ...framing({}) }));
    Object.assign(c, { name: COCKTAILS.ru, titles: COCKTAILS, price: 0, orderMode: 'free' });
    syncPromoItems(r);
    // названия строк меню: «Акция N: …» (N — номер в списке акций)
    r.promos.forEach((p, k) => {
      const it = r.menu.find((m) => m.id === `promo-${p.id}`);
      if (it) it.name = promoLineName(k + 1, p.titles || { ru: p.name });
    });
    audit('сервер', `Акции Чехова: русские постеры — ${done.length} из 7, «2 + 1 коктейля» ${c.images.en ? 'дополнена' : 'создана'}, строки меню названы «Акция N: …»`, r.id);
  }
  db.migrations.chekhoffRu = Date.now();
  save();
}

// Однократно: у акций появился режим кнопки — строки меню для всех акций всех ресторанов (без цены — «Заказать по акции»)
if (!db.migrations.promoModes) {
  for (const r of Object.values(db.restaurants)) { r.promos = cleanPromos(r.promos || []); syncPromoItems(r); }
  db.migrations.promoModes = Date.now();
  save();
}

// Однократно: записанные приветствия (MP3) убраны — всё озвучивает ElevenLabs; фразы ресторана — отдельно для
// каждого персонажа; персонаж доступен тем ресторанам, где уже выбран (остальным — по разрешению администратора)
if (!db.migrations.charLines) {
  for (const c of db.characters) {
    delete c.audio;
    c.phrases = Object.fromEntries(['recommend', 'dayDish'].map((k) => [k, (c.phrases?.[k] || []).map(({ audio, ...x }) => x)]));
    c.restaurants = Object.values(db.restaurants).filter((r) => r.avatar?.characterId === c.id).map((r) => r.id);
  }
  for (const r of Object.values(db.restaurants)) {
    const a = r.avatar;
    if (!a) continue;
    if (a.greetings?.length && a.characterId) a.lines = { [a.characterId]: { greetings: a.greetings, recommend: [], dayDish: [] } };
    delete a.greetings;
  }
  db.migrations.charLines = Date.now();
  save();
}

// Однократно: у Антона и Маши по 5 вариантов приветствий, рекомендаций и фраз про блюдо дня (assets/phrases.json).
// Списки ресторана, совпадающие со старыми фразами пакета, очищаем — будут звучать новые.
// Доступ: Антон — ресторану «Чехов», Маша — ещё и Veranda
if (!db.migrations.phrases5) {
  const defs = JSON.parse(fs.readFileSync(new URL('./assets/phrases.json', import.meta.url), 'utf8'));
  const canon = (list) => JSON.stringify((list || []).map((o) => Object.fromEntries(Object.entries(o).sort())));
  const restByName = (re) => Object.values(db.restaurants).filter((r) => re.test(r.name || '')).map((r) => r.id);
  for (const c of db.characters) {
    c.greetings ||= c.greeting && Object.keys(c.greeting).length ? [c.greeting] : [];
    delete c.greeting;
    const d = defs[c.id];
    if (!d) continue;
    const old = { greetings: c.greetings, recommend: c.phrases?.recommend, dayDish: c.phrases?.dayDish };
    for (const r of Object.values(db.restaurants)) {
      const L = r.avatar?.lines?.[c.id];
      for (const k of ['greetings', 'recommend', 'dayDish']) if (L && canon(L[k]) === canon(old[k])) L[k] = [];
    }
    c.greetings = d.greetings;
    c.phrases = { recommend: d.recommend, dayDish: d.dayDish };
  }
  const grant = (id, ids) => { const c = db.characters.find((x) => x.id === id); if (c) c.restaurants = [...new Set([...(c.restaurants || []), ...ids])]; };
  grant('chekhov', restByName(/чехов|chekh/i));
  grant('masha', restByName(/veranda|веранда/i));
  db.migrations.phrases5 = Date.now();
  save();
}

// Однократно: раньше синхронизация писала «нет в наличии» в hidden и стирала скрытие менеджера — теперь это off;
// источник перечитаем при следующей проверке (с группами вариантов)
if (!db.migrations.menuOff) {
  for (const r of Object.values(db.restaurants)) {
    for (const i of r.menu || []) if (i.extId) { i.off = !!i.hidden; i.hidden = false; }
    if (r.menuSource) { delete r.menuSource.lastHash; r.menuSource.everyMin ||= 5; delete r.menuSource.interval; }
  }
  db.migrations.menuOff = Date.now();
  save();
}

// Тестовая копия: база скопирована с рабочей — уведомления официантов принадлежат рабочему приложению, убираем их
if (INSTANCE === 'test' && !db.migrations.testInstance) {
  for (const x of Object.values(db.sessions)) x.subs = [];
  db.migrations.testInstance = Date.now();
  save();
}

// Однократно: раньше визит шёл до «Закрыть стол», и забытый стол склеивал вчерашнее с сегодняшним — «Тест» на таком
// визите метил и настоящие заказы следующих дней. Их возвращаем в статистику (последние 30 дней)
if (!db.migrations.unmergeMarks) {
  const to = Date.now(), from = to - 30 * 864e5;
  for (const r of Object.values(db.restaurants)) {
    if (!(r.testIds || []).length) continue;
    const back = unmergeMarks({ log: events, r, from, to, dayFrom: dayFrom(r) });
    if (!back.length) continue;
    markTest(r, back, false);
    audit('система', `Статистика: ${back.length} заказов и вызовов снова учитываются — были помечены «Тест» вместе с незакрытым столом прошлого дня`, r.id);
    console.log(`${r.name}: вернули в статистику ${back.length} заказов и вызовов из склеенных визитов`);
  }
  db.migrations.unmergeMarks = Date.now();
  save();
}

// С какого времени планшет спрашивает причину отмены вызова (по первому ответу гостя): раньше — «причину не спрашивали»
if (!db.migrations.cancelWhy) {
  const first = events.read(Date.now() - 14 * 864e5, Date.now(), null).find((e) => e.k === 'call_why');
  db.migrations.cancelWhy = first ? first.t : Date.now();
  save();
}
setWhySince(db.migrations.cancelWhy);

// Однократно: в ресторан DEMO — копии всех акций Чехова (у копий свои номера, статистика раздельная)
if (!db.migrations.demoPromos) {
  const all = Object.values(db.restaurants);
  const demo = all.find((r) => /^demo$/i.test((r.name || '').trim())), ch = all.find((r) => /чехов|chekh/i.test(r.name || ''));
  if (demo && ch) {
    const have = new Set((demo.promos || []).map((p) => (p.name || '').toLowerCase()));
    const add = (ch.promos || []).filter((p) => !have.has((p.name || '').toLowerCase())).map((p) => ({ ...structuredClone(p), id: uid() }));
    demo.promos = cleanPromos([...(demo.promos || []), ...add]);
    syncPromoItems(demo);
    console.log(`DEMO: добавлено акций из Чехова — ${add.length}`);
  }
  db.migrations.demoPromos = Date.now();
  save();
}

// Однократно: столы «1», «B1» → «Стол 1», «Стол B1» (вместе с планшетами, официантами и заказами)
for (const r of Object.values(db.restaurants)) {
  if ((r.tables || []).some((n) => fullTable(n) !== n)) saveTables(r, r.tables.map((n) => ({ from: n, to: fullTable(n) })));
}
save();

const server = http.createServer(async (req, res) => {
  countRequest();
  try {
    const url = new URL(req.url, 'http://local');
    // /staff и /guest без косой черты → на адрес с чертой
    if (req.method === 'GET' && STATIC[url.pathname + '/']) {
      res.writeHead(301, { location: url.pathname + '/' + url.search });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/' && !currentAdmin(req)) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    // QR-код со стола: телефон гостя открывает ту же страницу, что и планшет
    if (req.method === 'GET' && /^\/t\/[\w-]{8,40}$/.test(url.pathname)) return send(res, 200, FILES['guest.html'], TYPES.html);
    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) return send(res, 200, FILES[file], TYPES[file.split('.').pop()]);

    const up = req.method === 'GET' && url.pathname.match(/^\/uploads\/([a-f0-9]+\.(jpg|png|webp|svg|mp3|ogg|wav))$/);
    if (up) {
      const f = path.join(UPLOADS, up[1]);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': MIME[up[2]], 'cache-control': 'public, max-age=31536000, immutable',
        'content-security-policy': "script-src 'none'",
      });
      return fs.createReadStream(f).pipe(res);
    }
    const go = req.method === 'GET' && url.pathname.match(/^\/go\/([ap])\/([\w-]+)$/);
    if (go) {
      const target = qrRedirect(go[1], go[2], url.searchParams.get('r'), url.searchParams.get('d'));
      if (!target) return send(res, 404, { error: 'link not found' });
      res.writeHead(302, { location: target });
      return res.end();
    }
    // Все фото акций и рекламы одним ZIP: из админки или по временной ссылке только на чтение
    if (req.method === 'GET' && url.pathname === '/api/export/photos.zip') {
      const me = currentAdmin(req);
      if (permOf(me, 'ads') === 'none') return send(res, 403, { error: 'Нет доступа к разделу «Реклама»' });
      return sendPhotosZip(res);
    }
    const ex = req.method === 'GET' && url.pathname.match(/^\/export\/([A-Za-z0-9_-]{20,64})\/photos\.zip$/);
    if (ex) {
      const l = db.exportLinks[ex[1]];
      if (!l || l.until < Date.now()) return send(res, 410, 'Ссылка устарела — создайте новую в админке (Реклама → «Ссылка только на чтение»)', 'text/plain; charset=utf-8');
      return sendPhotosZip(res);
    }
    // CRM: файл договора — загрузка и выдача только с доступом к CRM
    if (req.method === 'POST' && url.pathname === '/api/crm/upload') return send(res, 200, await crmUpload(req, currentAdmin(req)));
    const cf = req.method === 'GET' && url.pathname.match(/^\/api\/crm\/file\/([a-f0-9]{20}\.(pdf|jpg|png|webp))$/);
    if (cf) {
      const me = currentAdmin(req), f = path.join(CRM_DIR, cf[1]);
      if (!me || !crmAccess(me)) return send(res, 403, { error: 'Нет доступа к CRM' });
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': cf[2] === 'pdf' ? 'application/pdf' : MIME[cf[2]] || 'image/jpeg', 'cache-control': 'private, no-store', 'content-security-policy': "script-src 'none'" });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const token = req.headers['x-staff-token'];
      const me = currentAdmin(req);
      if (!me || !canEdit(me, 'rest', 'ads', 'chars')) managerSession(token);
      return send(res, 200, await upload(req));
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      // «admin» — прежний логин портала: это суперадмин
      const email = String(body.email || '').trim().toLowerCase();
      const a = db.admins.find((x) => x.email === (email === 'admin' ? SUPER_EMAIL : email) && !x.disabled);
      if (!passOk(a, body.password)) {
        await new Promise((r) => setTimeout(r, 1000)); // притормаживаем подбор пароля
        return send(res, 403, { error: 'wrong email or password' });
      }
      const token = crypto.randomBytes(24).toString('base64url');
      db.adminSessions[token] = { adminId: a.id, at: Date.now() };
      a.lastLogin = Date.now();
      save();
      audit(a.email, 'Вход в портал');
      res.setHeader('set-cookie', `jm_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_SESSION_MS / 1000}`);
      return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      delete db.adminSessions[cookieToken(req)];
      save();
      res.setHeader('set-cookie', 'jm_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return send(res, 200, {});
    }
    // Озвучка фразы голосом персонажа → переадресация на готовый MP3
    if (req.method === 'GET' && url.pathname === '/api/tts') {
      res.writeHead(302, { location: await guestTts(Object.fromEntries(url.searchParams)), 'cache-control': 'no-store' });
      return res.end();
    }
    const route = PUBLIC[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(body, Object.fromEntries(url.searchParams), req));

    const me = currentAdmin(req);
    if (!me) return send(res, 401, { error: 'not signed in' });
    if (!allowed(me, req.method, url.pathname)) return send(res, 403, { error: denyText(me, req.method, url.pathname) });
    const out = await admin(req.method, url.pathname, body, me, Object.fromEntries(url.searchParams));
    if (out !== undefined && req.method !== 'GET' && !url.pathname.startsWith('/api/admins') && !url.pathname.startsWith('/api/me')) {
      const a = auditText(req.method, url.pathname, body);
      if (a) audit(me.email, a[0], a[1]);
    }
    if (out !== undefined && url.pathname === '/api/me/password') audit(me.email, 'Сменил свой пароль');
    send(res, out === undefined ? 404 : 200, out ?? { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));

// Обновление или перезапуск (docker stop): новые запросы не принимаем, начатые доводим до конца,
// несохранённые изменения пишем на диск сразу — заказы, сделанные за секунду до остановки, не теряются
function shutdown() {
  server.close();
  if (saveTimer) writeDb();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
