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
import { eventLog, thDay, restaurantReport, networkReport } from './stats.mjs';
import { countRequest, selfStats, hostStats } from './sysinfo.mjs';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://app.jetmedia.dev';
const ONLINE_MS = 45_000;
const OFFLINE_ALERT_MS = 3 * 60_000; // столько минут без связи — пишем администратору в Telegram
const KEEP_MS = 7 * 24 * 3600_000;
const REMIND_MS = 45_000;
const MAX_REMINDERS = 5;
const COMMANDS = ['url', 'reload', 'reboot', 'update', 'say'];
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
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png' };
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
    at: Date.now(), here: INSTANCE, host: hostStats(DATA_DIR), telegram: !!(db.telegram?.token && db.telegram.chats?.length),
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
const logEvent = (rid, k, data = {}) => events.add({ t: Date.now(), r: rid, k, ...data });
const bump = (key, n = 1) => { db.stats[key] = (db.stats[key] || 0) + n; };
const fail = (status, message) => Object.assign(new Error(message), { status });
// ---------- Администраторы портала: вход по почте и паролю, роли, журнал изменений
//   super  — всё, включая список админов;  admin — всё, кроме админов (или только свои рестораны, если список задан);
//   viewer — только статистика (всех ресторанов или своих)
const SUPER_EMAIL = (process.env.SUPERADMIN_EMAIL || 'ph001player1@gmail.com').toLowerCase();
const ROLES = ['super', 'admin', 'viewer'];
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
function allowed(a, method, p) {
  if (p.startsWith('/api/me')) return true;
  if (a.role === 'super') return true;
  if (p.startsWith('/api/admins')) return false;
  if (a.role === 'viewer') return method === 'GET' && (p === '/api/stats' || p === '/api/restaurants');
  if (!scopeOf(a)) return true;
  return /^\/api\/(devices|restaurants|stats)(\/|$)/.test(p);
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
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)\/test-visit$/))) return [`Статистика: визит ${b.test ? 'помечен тестовым' : 'снова учитывается'}`, m[1]];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)$/))) return [`Ресторан удалён: ${m[1]}`, m[1]];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/command$/))) return [`Команда «${b.type}» устройству ${dev(m[1])}`, db.devices[dev(m[1])]?.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/assign$/))) return [`Устройство ${dev(m[1])} → ${db.restaurants[b.restaurantId]?.name || 'не привязано'}${b.table ? ` · ${b.table}` : ''}`, b.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)$/))) return [`Устройство удалено: ${dev(m[1])}`];
  if (p === '/api/uploads/replace') return ['Картинка пережата и заменена'];
  if ((m = p.match(/^\/api\/join-requests\/([^/]+)$/))) {
    const jr = db.joinReqs.find((x) => x.id === m[1]);
    return [`Заявка на подключение ${jr ? `${jr.name || ''} ${jr.phone}` : m[1]}: ${b.done === undefined ? 'удалена' : b.done ? 'обработана' : 'снова новая'}`];
  }
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
  if (p.startsWith('/api/telegram')) return [`Telegram: ${{ '/api/telegram': 'бот изменён', '/api/telegram/find': 'поиск чатов', '/api/telegram/test': 'тест', '/api/telegram/remove': 'получатель удалён' }[p] || p}`];
  return [`${method} ${p}`];
}

// Администраторы: список, добавление и изменение (почта, имя, роль, рестораны, пароль, отключение), удаление
function adminsApi(method, p, b, me) {
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
    email, name: String(b.name || '').slice(0, 60), role, disabled: !!b.disabled,
    restaurants: role === 'super' ? [] : (Array.isArray(b.restaurants) ? b.restaurants : []).filter((id) => db.restaurants[id]),
  }, pass ? hashPass(pass) : {});
  if (a.disabled || pass) for (const [k, s] of Object.entries(db.adminSessions)) if (s.adminId === a.id && a.id !== me.id) delete db.adminSessions[k];
  save();
  audit(me.email, `${was ? 'Админ изменён' : 'Админ добавлен'}: ${email} — ${{ super: 'суперадмин', admin: 'админ', viewer: 'просмотр статистики' }[role]}`
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
  if (d.offlineAlert) {
    tgAlert(`🟢 ${deviceName(d)}: снова на связи (не было ${Math.round((Date.now() - d.lastSeen) / 60_000)} мин)`);
    d.offlineAlert = 0;
  }
  // Сбои, после которых агент перезапустился сам: падение, зависание, нехватка памяти
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 5)) {
    const text = String(e).slice(0, 300);
    d.events = [{ at: Date.now(), text }, ...(d.events || [])].slice(0, 10);
    tgAlert(`⚠️ ${deviceName(d)}: ${text}`);
    if (d.restaurantId) logEvent(d.restaurantId, 'dev_crash', { dev: d.id });
  }
  d.telemetry = b.telemetry || {};
  d.lastSeen = Date.now();
  d.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const commands = d.queue.splice(0);
  save();
  return { commands };
}

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

const tgAlert = (text) => tgSend(db.telegram, text);
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

// Раз в минуту: устройства, пропавшие больше чем на 3 минуты, — одним сообщением
setInterval(() => {
  const now = Date.now();
  const lost = Object.values(db.devices).filter((d) => d.lastSeen && !d.offlineAlert && now - d.lastSeen > OFFLINE_ALERT_MS);
  if (!lost.length) return;
  for (const d of lost) {
    d.offlineAlert = now;
    if (d.restaurantId) logEvent(d.restaurantId, 'dev_offline', { dev: d.id });
  }
  save();
  tgAlert('🔴 Нет связи с устройствами:\n' + lost.map((d) => {
    const t = d.telemetry || {};
    const low = t.battery <= 5 && !t.charging ? ', вероятно, сел аккумулятор' : '';
    return `• ${deviceName(d)} — с ${clock(d.lastSeen)}, заряд ${t.battery ?? '?'}%${low}`;
  }).join('\n'));
}, 60_000);

const tgPublic = () => ({ bot: db.telegram.bot, connected: !!db.telegram.token, chats: db.telegram.chats });

async function telegramAdmin(method, p, b) {
  const tg = db.telegram;
  if (method === 'GET') return tgPublic();
  if (p === '/api/telegram') {
    const token = String(b.token || '').trim();
    const me = token ? await tgApi(token, 'getMe') : null;
    Object.assign(tg, { token, bot: me ? me.username : '', chats: token === tg.token ? tg.chats : [] });
  }
  if (p === '/api/telegram/find') await tgFindChats(tg);
  if (p === '/api/telegram/test') await tgSend(tg, '✅ JET MEDIA: тестовое сообщение. Оповещения об устройствах будут приходить сюда.', true);
  if (p === '/api/telegram/remove') tg.chats = tg.chats.filter((c) => c.id !== b.id);
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
      type: 'promo', id: p.id, image: p.image, images: p.images || {}, phone: p.phone || '', // текст акции — на самой картинке
      // кнопка на слайде: «Заказать · цена» или «Заказать по акции» (строка меню создаётся сама)
      order: promoMode(p) !== 'none' && (r.menu || []).some((i) => i.id === `promo-${p.id}` && onMenu(i)) ? `promo-${p.id}` : '',
      price: promoMode(p) === 'price' ? p.price : 0,
      qr: p.link ? `${PUBLIC_URL}/go/p/${p.id}?r=${r.id}` : '', ...qrPlace(p), ...framing(p),
    })),
    // блюдо — только с галочкой «В показе акций» (блюдо дня без неё остаётся в меню и в советах персонажа)
    ...(r.menu || []).filter((i) => i.promo && i.photo && onMenu(i)).map((i) => ({ type: 'item', id: i.id, image: i.photo, title: i.name, price: i.price })),
  ];
  const ads = r.tariff === 'premium' ? [] : db.ads
    .filter((a) => a.active && a.image && (!a.restaurants?.length || a.restaurants.includes(r.id)) && !(r.blockedAds || []).includes(a.id)
      && !blockedCats(r).includes(a.cat || 'other'))
    .map((a) => ({
      type: 'ad', id: a.id, image: a.image, phone: a.phone || '', // рекламодатель и название — только для поиска в портале
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
  if (d) d.pageSeen = Date.now(); // страница планшета открыта — для «есть ли в ресторане включённые планшеты»
  const r = d && db.restaurants[d.restaurantId];
  if (!r || (!d.table && d.role !== 'entrance')) return { unassigned: true };
  const base = {
    restaurant: { name: r.name, langs: r.langs, address: r.address || '' },
    build: BUILD, instance: INSTANCE, version: VERSION,
    menu: (r.menu || []).filter(onMenu), tags: r.customTags || [],
    slides: slidesFor(r, d.id),
    display: { ...DISPLAY, ...r.display, palette: themeOf(r.display?.theme) },
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
    display: { ...DISPLAY, ...r.display, palette: themeOf(r.display?.theme) },
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

function guestCall(b) {
  const t = guestOf(b);
  if (!t) throw fail(400, 'device is not assigned');
  if (!['waiter', 'bill'].includes(b.type)) throw fail(400, 'bad call type');
  // Счёт: «мой» (scope — номер гостя) или всего стола (0). Повторное нажатие не создаёт второй вызов
  const scope = b.type === 'bill' && b.scope === 'me' ? t.n : 0;
  let c = openAt(db.calls, t.r, t.table).find((x) => x.type === b.type && x.status !== 'done' && (x.scope || 0) === scope);
  if (!c) {
    if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
    c = { id: uid(), restaurantId: t.r.id, table: t.table, type: b.type, status: 'new', at: Date.now(), guest: t.n, guestName: t.name, scope };
    db.calls.push(c);
    logEvent(t.r.id, 'call', { id: c.id, table: t.table, dev: t.dev || undefined, type: b.type, lang: b.lang, guest: t.n, phone: t.phone ? 1 : undefined });
  }
  touchTable(t.r, t.table);
  // Гость нажал ещё раз — напоминаем, но не чаще раза в 20 секунд
  if (Date.now() - (c.notifiedAt || 0) > 20_000) {
    c.notifiedAt = Date.now();
    // счёт: для кого (гость или весь стол) и на какую сумму — по неоплаченным строкам
    if (b.type === 'bill') {
      const due = openAt(db.orders, t.r, t.table).filter((o) => o.status !== 'rejected').reduce((a, o) => a + o.items
        .filter((i) => !i.paidAt && !o.paidAt && (!scope || (i.g || o.guest || 1) === scope)).reduce((x, i) => x + i.price * i.qty, 0), 0);
      notify(t.r.id, t.table, 'bill', ` · ฿${due.toLocaleString('en')}`, false, scope ? t : 'table');
    } else notify(t.r.id, t.table, b.type, '', false, t.n > 1 ? t : null);
  }
  save();
  return c;
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
  // каждая строка — гостя, который заказал (официант потом может перенести её на другого гостя)
  const items = buildItems(t.r, b.items).map((i) => ({ ...i, g: t.n }));
  if (!items.length) throw fail(400, 'empty order');
  if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
  const o = {
    id: uid(), restaurantId: t.r.id, table: t.table, items,
    total: items.reduce((s, i) => s + i.price * i.qty, 0), status: 'pending', at: Date.now(), notifiedAt: Date.now(),
    guest: t.n, guestName: t.name, src: t.phone ? 'phone' : 'tablet',
  };
  db.orders.push(o);
  logEvent(t.r.id, 'order', { id: o.id, table: t.table, dev: t.dev || undefined, total: o.total, items: items.map((i) => [i.id, i.qty, i.price]), lang: b.lang, guest: t.n, phone: t.phone ? 1 : undefined });
  touchTable(t.r, t.table);
  notify(t.r.id, t.table, 'order', ` · ฿${o.total}`, false, t.n > 1 ? t : null);
  save();
  return o;
}

// Строки заказа по меню: цены и названия берём из меню, а не из запроса
function buildItems(r, list) {
  const menu = new Map((r.menu || []).filter(onMenu).map((i) => [i.id, i]));
  return (list || [])
    .filter((x) => menu.has(x.id) && x.qty > 0)
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
  en: { table: 'Table', waiter: 'Waiter call', bill: 'Bill requested', order: 'New order', again: 'Reminder', guest: 'Guest', ready: 'Order is ready', wholeTable: 'whole table' },
  th: { table: 'โต๊ะ', waiter: 'เรียกพนักงาน', bill: 'ขอเช็คบิล', order: 'ออร์เดอร์ใหม่', again: 'เตือนอีกครั้ง', guest: 'แขก', ready: 'อาหารพร้อมเสิร์ฟ', wholeTable: 'ทั้งโต๊ะ' },
  ru: { table: 'Стол', waiter: 'Вызов официанта', bill: 'Просят счёт', order: 'Новый заказ', again: 'Напоминание', guest: 'Гость', ready: 'Заказ готов', wholeTable: 'весь стол' },
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
  db.sessions[token] = { restaurantId: r.id, staffId: member.id, at: Date.now(), onShift: true, subs: [], lang: b.lang || 'en' };
  logEvent(r.id, 'shift', { by: member.id, bn: member.name, on: true });
  save();
  return { token };
}

function staffState(b, q) {
  const { s, r, member } = session(q.token);
  return {
    restaurant: { name: r.name, pos: r.menuSource?.type === 'pos', tables: r.tables || [] },
    build: BUILD, instance: INSTANCE, version: VERSION,
    me: { name: member.name, role: member.role, onShift: s.onShift, push: s.subs.length > 0 },
    // «Столы» официанта: его столы из ЛК менеджера, а если не назначены — все столы ресторана
    myTables: (r.tables || []).filter((tb) => member.role === 'manager' || !member.tables?.length || servesTable(member.tables, tb)),
    vapidKey: db.vapid.publicKey,
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    flow: pick(flowOf(r), ['phones', 'kitchenBtn', 'kitchenScreen']), customTags: r.customTags || [],
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
function staffOrder(b) {
  const { r, member } = session(b.token);
  const table = String(b.table || '');
  if (!(r.tables || []).includes(table)) throw fail(400, 'unknown table');
  const guest = Math.min(99, Math.max(1, Math.round(Number(b.guest)) || 1));
  const items = buildItems(r, b.items).map((i) => ({ ...i, g: guest }));
  if (!items.length) throw fail(400, 'empty order');
  if (tableIsFree(r, table)) logEvent(r.id, 'open', { table });
  const now = Date.now();
  const o = {
    id: uid(), restaurantId: r.id, table, items, total: items.reduce((s, i) => s + i.price * i.qty, 0),
    status: 'confirmed', at: now, confirmedAt: now, ackAt: now, ackBy: member.name, by: member.name, src: 'staff',
    guest, guestName: guestNames(r, table)[guest] || '',
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

// ---------- Экран кухни: подтверждённые заказы по ссылке из ЛК менеджера (без входа); повар отмечает «Готово»,
// официанты стола получают уведомление «Заказ готов»
function kitchenRest(k) {
  const r = Object.values(db.restaurants).find((x) => flowOf(x).kitchenScreen && x.flow?.kitchenKey && x.flow.kitchenKey === String(k || ''));
  if (!r) throw fail(403, 'bad kitchen link');
  return r;
}
function kitchenState(b, q) {
  const r = kitchenRest(q.k), now = Date.now(), tags = new Map((r.menu || []).map((m) => [m.id, m.tags || []]));
  const list = db.orders.filter((o) => o.restaurantId === r.id && o.status === 'confirmed' && !o.test
    && now - (o.confirmedAt || o.at) < 12 * 3600e3 && (!o.readyAt || now - o.readyAt < 15 * 60e3));
  return {
    restaurant: { name: r.name, langs: r.langs }, build: BUILD,
    orders: list.map((o) => {
      // блюда, разделённые между гостями, — одной строкой; was — сколько было, когда заказ ушёл на кухню
      const cur = kitchenSnap(o), was = o.kitchenItems || cur;
      const keys = [...new Set([...Object.keys(was), ...Object.keys(cur)])];
      const items = keys.map((k) => ({ name: (cur[k] || was[k]).name, ml: (cur[k] || was[k]).ml, qty: cur[k]?.qty || 0, was: was[k]?.qty || 0, tags: tags.get(k.split('|')[0]) || [] }));
      return {
        id: o.id, table: o.table, at: o.cookFrom || o.confirmedAt || o.at, readyAt: o.readyAt || 0, editedAt: o.editedAt || 0,
        changed: items.some((i) => i.qty !== i.was), items,
      };
    }),
  };
}
function kitchenReady(b) {
  const r = kitchenRest(b.k);
  const o = db.orders.find((x) => x.id === b.id && x.restaurantId === r.id && x.status === 'confirmed');
  if (!o) throw fail(400, 'bad order');
  if (b.undo) delete o.readyAt;
  else if (!o.readyAt) {
    o.readyAt = Date.now();
    o.kitchenItems = kitchenSnap(o); // кухня приготовила это — следующие правки покажутся как новые
    logEvent(r.id, 'order_ready', { id: o.id, table: o.table, ms: o.readyAt - (o.confirmedAt || o.at) });
    notify(r.id, o.table, 'ready');
  }
  save();
  return {};
}

// Меню для правки заказа официантом
function staffMenu(b, q) {
  const { r } = session(q.token);
  return (r.menu || []).filter(onMenu).map(({ id, sku, name, price, options, groups }) => ({ id, sku, name, price, options, groups }));
}

function staffShift(b) {
  const { s, r, member } = session(b.token);
  if (s.onShift !== !!b.on) logEvent(r.id, 'shift', { by: member.id, bn: member.name, on: !!b.on });
  s.onShift = !!b.on;
  save();
  return {};
}

function staffSubscribe(b) {
  const { s } = session(b.token);
  if (!b.sub?.endpoint || !b.sub.keys?.p256dh) throw fail(400, 'bad subscription');
  s.subs = s.subs.filter((x) => x.endpoint !== b.sub.endpoint).concat(b.sub);
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

function staffAction(b) {
  const { r, member } = session(b.token);
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
      logEvent(r.id, 'order_kitchen', { ...who, id: x.id, table: x.table, ms: x.kitchenAt - x.at });
    }
  } else if (b.kind === 'order' && (b.action === 'test' || b.action === 'untest')) {
    // «Тестовый заказ» — только менеджер: весь визит стола с этим заказом не идёт в статистику
    if (member.role !== 'manager') throw fail(403, 'managers only');
    if (!db.orders.some((y) => y.id === b.id && y.restaurantId === r.id)) throw fail(400, 'bad action');
    markTest(r, [b.id], b.action === 'test');
    audit(`${member.name} (менеджер)`, `Заказ ${b.action === 'test' ? 'помечен тестовым' : 'снова учитывается'}`, r.id);
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
      const items = buildItems(r, b.items);
      if (!items.length) throw fail(400, 'empty order');
      Object.assign(x, { items, total: items.reduce((s, i) => s + i.price * i.qty, 0), editedAt: Date.now(), editedBy: member.name });
      // к уже готовому заказу добавили блюда — кухне снова есть что готовить
      const was = x.kitchenItems || {}, cur = kitchenSnap(x);
      if (x.readyAt && Object.keys(cur).some((k) => cur[k].qty > (was[k]?.qty || 0))) {
        delete x.readyAt;
        x.cookFrom = Date.now();
      }
      logEvent(r.id, 'order_edit', { ...who, id: x.id, table: x.table, total: x.total });
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
    }
    Object.assign(x, { status, by: member.name, [`${status}At`]: Date.now() });
    if (status === 'confirmed') x.kitchenItems = kitchenSnap(x);
  }
  save();
  return {};
}

// Пуш всем сотрудникам ресторана, которые на смене и включили уведомления
// Официантам этого стола (без назначенных столов — всех столов); менеджерам — напоминания
// и вызовы, которые некому отправить
function notify(restaurantId, table, kind, extra = '', reminder = false, guest = null) {
  const r = db.restaurants[restaurantId];
  if (!r) return;
  const member = (s) => (r.staff || []).find((m) => m.id === s.staffId);
  const active = Object.values(db.sessions).filter((s) => s.restaurantId === restaurantId && s.onShift && s.subs.length && member(s));
  const waiters = active.filter((s) => member(s).role === 'waiter' && (!member(s).tables?.length || servesTable(member(s).tables, table)));
  const managers = active.filter((s) => member(s).role === 'manager');
  for (const s of new Set([...waiters, ...(reminder || !waiters.length ? managers : [])])) {
    const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en;
    const who = guest === 'table' ? ` · ${L.wholeTable}` : guest ? ` · ${guest.name || `${L.guest} ${guest.n}`}` : '';
    const data = { title: tableLabel(table, L.table), body: (reminder ? `${L.again}: ` : '') + L[kind] + who + extra, tag: `${kind}-${table}` };
    for (const sub of s.subs) {
      sendPush(sub, data, db.vapid).then((ok) => {
        if (!ok) { s.subs = s.subs.filter((x) => x !== sub); save(); }
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
    if (x.closed || (x.reminders || 0) >= MAX_REMINDERS || now - (x.notifiedAt || x.at) < REMIND_MS) continue;
    x.reminders = (x.reminders || 0) + 1;
    x.notifiedAt = now;
    notify(x.restaurantId, x.table, kind, '', true);
    logEvent(x.restaurantId, 'remind', { table: x.table, kind });
  }
}, 15_000);

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
      name: r.name, langs: r.langs || [], tables: r.tables || [], tariff: r.tariff || 'standard', staff: r.staff || [],
      menu: r.menu || [], promos: r.promos || [], blockedAds: r.blockedAds || [], staffArchive: r.staffArchive || [],
      menuSource: publicSource(r.menuSource),
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

const SECTIONS = { testVisit: 'пометка тестового визита', staffArchive: 'уволенные', staff: 'персонал', menu: 'меню', promos: 'акции', blockedAds: 'блокировка рекламы', menuSource: 'источник меню', customTags: 'особые пожелания', tagRules: 'правила отметок', display: 'показ и дизайн', avatar: 'ИИ-персонаж', tables: 'столы', flow: 'заказы и кухня' };
function managerSave(b) {
  const { r, member } = managerSession(b.token);
  const changed = Object.keys(SECTIONS).filter((k) => b[k] !== undefined).map((k) => SECTIONS[k]);
  if (changed.length) audit(`${member.name} (менеджер)`, `ЛК: сохранено — ${changed.join(', ')}`, r.id);
  if (Array.isArray(b.staff)) setStaff(r, b.staff, b.fired || {});
  if (Array.isArray(b.staffArchive)) setArchive(r, b.staffArchive);
  if (b.testVisit) markTest(r, b.testVisit.ids, b.testVisit.test);
  // Меню из ЛК: при синхронизации — только ★ блюдо дня, 📣 в показе акций, ⦸ скрыть (хештеги и настройки синхронизации — в админке)
  if (Array.isArray(b.menu)) setMenu(r, b.menu, undefined, false);
  if (Array.isArray(b.promos)) r.promos = cleanPromos(b.promos);
  if (Array.isArray(b.promos) || Array.isArray(b.menu)) syncPromoItems(r);
  // «реклама после каждых N слайдов» задаёт админка — из ЛК не меняется
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
  for (const k of Object.values(db.tableKeys)) if (k.r === r.id) k.table = move(k.table) || k.table;
  r.tables = rows.map((x) => x.to);
}

// Статистика ресторана для ЛК менеджера (без внешней рекламы)
function managerStats(b, q) {
  const { r } = managerSession(q.token);
  const { from, to } = period(q);
  return restaurantReport({ log: events, db, r, from, to, staffNames: staffNamesOf(r), tests: q.tests === '1' });
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
      Object.assign(it, { dayDish: !!n.dayDish, promo: !!n.promo, hidden: !!n.hidden });
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
      hidden: !!i.hidden, off: !!i.off, photoManual: !!i.photoManual, fromPromo: i.fromPromo ? String(i.fromPromo) : undefined,
      tags: (Array.isArray(i.tags) ? i.tags : []).filter((x) => tagKeys(r).includes(x)),
    }));
}

// Числа — в своих пределах, цвета — только #rrggbb, тема — из списка; иначе значение по умолчанию
function cleanDisplay(d) {
  return Object.fromEntries(Object.entries(DISPLAY).map(([k, def]) => {
    if (k === 'theme') return [k, themeOf(d.theme).id];
    if (k === 'slideFx') return [k, ['ltr', 'rtl', 'ttb', 'btt'].includes(d.slideFx) ? d.slideFx : def];
    if (k === 'arrows') return [k, ARROWS.includes(d.arrows) ? d.arrows : def];
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

function cleanAd(a) {
  return {
    id: a.id || uid(), advertiser: String(a.advertiser || ''), title: String(a.title || ''), image: String(a.image || ''),
    restaurants: (a.restaurants || []).map(String), active: !!a.active, cat: AD_CATS[a.cat] ? a.cat : 'other',
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
  if (a.leadToMe !== false && db.telegram.token) { await tgSend(db.telegram, text); lead.sent.push('me'); }
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
  await tgSend(db.telegram, `🤝 Заявка на подключение ресторана\nИмя: ${name || '—'}\nТелефон: ${phone}\n`
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
function markTest(r, ids, test) {
  const set = new Set(r.testIds || []);
  for (const id of (ids || []).map(String).slice(0, 200)) test ? set.add(id) : set.delete(id);
  r.testIds = [...set].slice(-20000);
  for (const o of db.orders) if (o.restaurantId === r.id && (ids || []).includes(o.id)) o.test = !!test;
}
const period = (q) => {
  const now = Date.now(), to = Math.min(Number(q.to) || now, now + 864e5);
  return { to, from: Math.max(Number(q.from) || to - 7 * 864e5, to - 400 * 864e5) };
};

function admin(method, p, b, me, q) {
  const scope = scopeOf(me);
  if (method === 'GET' && p === '/api/me') return publicAdmin(me);
  if (method === 'POST' && p === '/api/me/password') {
    if (!passOk(me, b.old)) throw fail(400, 'Текущий пароль неверный');
    if (String(b.password || '').length < 8) throw fail(400, 'Новый пароль — не короче 8 символов');
    Object.assign(me, hashPass(b.password));
    save();
    return {};
  }
  if (p.startsWith('/api/admins')) return adminsApi(method, p, b, me);
  if (method === 'GET' && p === '/api/audit') return readAudit(q, scope);
  // Статистика: сеть (все доступные рестораны) и, если выбран ресторан, его подробный отчёт
  if (method === 'GET' && p === '/api/stats') {
    const { from, to } = period(q);
    const rids = new Set(Object.keys(db.restaurants).filter((id) => !scope || scope.has(id)));
    const r = q.r && rids.has(q.r) ? db.restaurants[q.r] : null;
    return {
      restaurants: [...rids].map((id) => ({ id, name: db.restaurants[id].name })),
      network: networkReport({ log: events, db, rids: r ? new Set([r.id]) : rids, from, to, tests: q.tests === '1' }),
      restaurant: r ? restaurantReport({ log: events, db, r, from, to, staffNames: staffNamesOf(r), tests: q.tests === '1' }) : null,
    };
  }
  if (p.startsWith('/api/telegram') && (method === 'GET' || method === 'POST')) return telegramAdmin(method, p, b);
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
  if (method === 'GET' && p === '/api/devices') {
    const list = () => {
      const now = Date.now();
      return Object.values(db.devices).filter((d) => !scope || scope.has(d.restaurantId)).map(({ queue, ...d }) =>
        ({ ...d, online: now - d.lastSeen < ONLINE_MS, pending: (queue || []).length }));
    };
    return INSTANCE === 'test' ? pullAllDevices().then(list) : list();
  }
  if (method === 'GET' && p === '/api/restaurants') {
    const list = Object.values(db.restaurants).filter((r) => !scope || scope.has(r.id));
    if (me.role === 'viewer') return list.map((r) => ({ id: r.id, name: r.name }));
    return list.map((r) => ({ ...r, menuSource: publicSource(r.menuSource), tagRules: r.tagRules || DEFAULT_RULES, customTags: r.customTags || [] }));
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
      // реклама: после каждых N слайдов ресторана и какая реклама в этом ресторане не показывается
      blockedAds: Array.isArray(b.blockedAds) ? b.blockedAds.map(String) : prev.blockedAds || [],
      blockedCats: Array.isArray(b.blockedCats) ? b.blockedCats.filter((c) => AD_CATS[c]) : prev.blockedCats,
      display: b.adEvery !== undefined ? { ...prev.display, adEvery: Math.min(10, Math.max(1, Math.round(Number(b.adEvery)) || 2)) } : prev.display,
      menuSource: b.menuSource ? cleanSource(b.menuSource, prev.menuSource) : prev.menuSource,
      customTags: Array.isArray(b.customTags) ? cleanCustomTags(b.customTags) : prev.customTags,
      syncKey: prev.syncKey || crypto.randomBytes(12).toString('hex'),
    };
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
  if (method === 'GET' && p === '/api/server') {
    if (scope) throw fail(403, 'Нет доступа');
    return serverPanel();
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
    markTest(db.restaurants[m[1]], b.ids, b.test);
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
    for (const a of db.ads) add(a.image, 'slide');
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
    for (const a of db.ads) swap(a, 'image');
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
      .then((test) => ({ instance: INSTANCE, prod: INSTANCE === 'prod' ? VERSION : null, test, testUrl: TEST_URL }));
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
  m = p.match(/^\/api\/devices\/([^/]+)(?:\/(command|assign|channel))?$/);
  const d = m && db.devices[decodeURIComponent(m[1])];
  if (!d) return undefined;
  if (scope && (!scope.has(d.restaurantId) || (m[2] === 'assign' && b.restaurantId && !scope.has(b.restaurantId)))) throw fail(403, 'Нет доступа');
  if (method === 'DELETE' && !m[2]) { delete db.devices[d.id]; save(); return {}; }
  if (method === 'POST' && m[2] === 'command') {
    if (!COMMANDS.includes(b.type)) throw fail(400, 'unknown command');
    d.queue.push(b);
    save();
    return {};
  }
  if (method === 'POST' && m[2] === 'channel') {
    if (INSTANCE === 'test') throw fail(400, 'Переключать версии можно в рабочем портале');
    const ch = b.channel === 'test' ? 'test' : undefined;
    return (ch ? testAlive() : Promise.resolve()).then(() => {
      if (d.channel !== ch && (d.table || d.role === 'entrance')) d.queue.push({ type: 'url', url: guestUrl({ ...d, channel: ch }) });
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
    d.queue.push({ type: 'url', url: placed ? guestUrl(d) : '' });
    save();
    return {};
  }
  return undefined;
}

const PUBLIC = {
  'POST /api/device/poll': devicePoll,
  'POST /api/device/alert': deviceAlert,
  'GET /api/guest/state': guestState,
  'POST /api/guest/call': guestCall,
  'POST /api/guest/cancel': guestCancel,
  'POST /api/guest/join': guestJoin,
  'GET /api/version': () => ({ version: VERSION, instance: INSTANCE }),
  'GET /api/internal/device': internalDevice,
  'GET /api/internal/devices': internalDevices,
  'GET /api/internal/server': internalServer,
  'GET /api/kitchen/state': kitchenState,
  'POST /api/kitchen/ready': kitchenReady,
  'POST /api/guest/order': guestOrder,
  'GET /api/staff/state': staffState,
  'POST /api/staff/action': staffAction,
  'POST /api/staff/order': staffOrder,
  'POST /api/staff/login': staffLogin,
  'POST /api/staff/shift': staffShift,
  'POST /api/staff/subscribe': staffSubscribe,
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
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const token = req.headers['x-staff-token'];
      const me = currentAdmin(req);
      if (!me || me.role === 'viewer') managerSession(token);
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
    if (!allowed(me, req.method, url.pathname)) return send(res, 403, { error: 'Нет доступа' });
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
