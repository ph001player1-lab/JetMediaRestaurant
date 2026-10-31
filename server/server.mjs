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

const PORT = 3000;
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
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png' };
const FILES = Object.fromEntries(Object.values(STATIC).map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url))]));
// Версия интерфейса: открытые страницы стола и персонала сами перезагружаются, когда она меняется
const BUILD = crypto.createHash('sha1').update(Buffer.concat(Object.values(FILES))).digest('hex').slice(0, 10);
const UPLOADS = path.join(DATA_DIR, 'uploads');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Что можно хранить в uploads: фото, картинки персонажей (в т. ч. SVG) и звук
const FILE_TYPES = { ...IMAGE_TYPES, 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
const MIME = Object.fromEntries(Object.entries(FILE_TYPES).map(([m, e]) => [e, m]));
const MAX_BODY = 25 * 1024 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;
const SYNC_EVERY = { hourly: 3600_000, daily: 24 * 3600_000 };
// Показ акций и рекламы на планшете: задержка простоя, длительность слайда, шрифты и цвета подписи
const DISPLAY = {
  idleSec: 60, slideSec: 7, titleSize: 38, textSize: 22, textColor: '#ffffff', bgColor: '#000000',
  theme: 'classic', // цветовая тема планшета (themes.mjs), выбирается во вкладке «Дизайн»
};
const DISPLAY_RANGE = { idleSec: [10, 600], slideSec: [3, 60], titleSize: [16, 80], textSize: [12, 48] };
// ИИ-персонаж: как часто появляется в карусели, сколько держится, приветствия и подбор блюд по пожеланиям
const AVATAR = { enabled: false, characterId: '', speak: true, everyMin: 3, durationSec: 20, startWith: true, greetings: [], filters: [] };
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
db.pending ??= {};
db.stats ??= {};
db.telegram ??= { token: '', bot: '', chats: [] };
db.eleven ??= { key: '', model: 'eleven_v3' };
db.vapid ??= createVapidKeys();

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cutoff = Date.now() - KEEP_MS;
    db.calls = db.calls.filter((x) => !x.closed || x.closed > cutoff);
    db.orders = db.orders.filter((x) => !x.closed || x.closed > cutoff);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }, 1000);
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
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)\/sync$/))) return ['Синхронизация меню', m[1]];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)\/test-visit$/))) return [`Статистика: визит ${b.test ? 'помечен тестовым' : 'снова учитывается'}`, m[1]];
  if ((m = p.match(/^\/api\/restaurants\/([^/]+)$/))) return [`Ресторан удалён: ${m[1]}`, m[1]];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/command$/))) return [`Команда «${b.type}» устройству ${dev(m[1])}`, db.devices[dev(m[1])]?.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)\/assign$/))) return [`Устройство ${dev(m[1])} → ${db.restaurants[b.restaurantId]?.name || 'не привязано'}${b.table ? ` · ${b.table}` : ''}`, b.restaurantId];
  if ((m = p.match(/^\/api\/devices\/([^/]+)$/))) return [`Устройство удалено: ${dev(m[1])}`];
  if ((m = p.match(/^\/api\/pending\/([^/]+)\/approve$/))) return [`Новое устройство добавлено: ${dev(m[1])}`];
  if ((m = p.match(/^\/api\/pending\/([^/]+)$/))) return [`Новое устройство скрыто: ${dev(m[1])}`];
  if (p === '/api/ads') return [`Реклама сохранена: ${b.advertiser || ''}${b.title ? ` — ${b.title}` : ''}`];
  if ((m = p.match(/^\/api\/ads\/([^/]+)$/))) return [`Реклама удалена: ${db.ads.find((a) => a.id === m[1])?.advertiser || m[1]}`];
  if (p === '/api/characters') return [`Персонаж загружен: ${b.id || ''}`];
  if ((m = p.match(/^\/api\/characters\/([^/]+)\/voice$/))) return [`Голос персонажа ${m[1]} изменён`];
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
  if (d.restaurantId) bump(`up|${d.restaurantId}|${day()}`);
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

// Карусель простоя: акции и блюда ресторана, через каждые две — внешняя реклама (кроме тарифа Premium)
function slidesFor(r) {
  const own = [
    ...(r.promos || []).filter((p) => p.active && p.image).map((p) => ({
      type: 'promo', id: p.id, image: p.image, images: p.images || {}, phone: p.phone || '', // текст акции — на самой картинке
      // кнопка на слайде: «Заказать · цена» или «Заказать по акции» (строка меню создаётся сама)
      order: promoMode(p) !== 'none' && (r.menu || []).some((i) => i.id === `promo-${p.id}` && !i.hidden) ? `promo-${p.id}` : '',
      price: promoMode(p) === 'price' ? p.price : 0,
      qr: p.link ? `${PUBLIC_URL}/go/p/${p.id}?r=${r.id}` : '', ...qrPlace(p), ...framing(p),
    })),
    ...(r.menu || []).filter((i) => (i.promo || i.dayDish) && i.photo).map((i) => ({ type: 'item', id: i.id, image: i.photo, title: i.name, price: i.price })),
  ];
  const ads = r.tariff === 'premium' ? [] : db.ads
    .filter((a) => a.active && a.image && (!a.restaurants?.length || a.restaurants.includes(r.id)) && !(r.blockedAds || []).includes(a.id))
    .map((a) => ({
      type: 'ad', id: a.id, image: a.image, phone: a.phone || '', // рекламодатель и название — только для поиска в портале
      qr: a.link ? `${PUBLIC_URL}/go/a/${a.id}?r=${r.id}` : '', ...qrPlace(a), ...framing(a),
    }));
  // ИИ-персонаж — первым слайдом карусели
  // ИИ-персонаж в список не входит: планшет вставляет его в карусель по своему расписанию
  const out = [];
  if (!own.length) return ads;
  own.forEach((s, i) => { out.push(s); if (i % 2 === 1 && ads.length) out.push(ads[Math.floor(i / 2) % ads.length]); });
  if (own.length === 1 && ads.length) out.push(ads[0]);
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
function qrRedirect(kind, id, rid) {
  const r = db.restaurants[rid];
  const target = kind === 'a' ? db.ads.find((a) => a.id === id) : (r?.promos || []).find((p) => p.id === id);
  if (!target?.link || !/^https?:\/\//.test(target.link)) return null;
  for (const key of [`scan|${id}|${rid}|${day()}`, `scan|${id}|*|${day()}`]) db.stats[key] = (db.stats[key] || 0) + 1;
  save();
  return target.link;
}

// ИИ-персонаж ресторана: включён и выбран из библиотеки персонажей
function avatarFor(r) {
  const a = { ...AVATAR, ...r.avatar };
  const c = a.enabled && db.characters.find((x) => x.id === a.characterId);
  return c ? { ...c, tts: !!(db.eleven.key && c.voice?.eleven), ...pick(a, ['speak', 'everyMin', 'durationSec', 'startWith', 'greetings', 'filters']) } : null;
}

// Показ слайда: реклама (как раньше), акция ресторана или появление ИИ-персонажа
function guestImpression(b) {
  const d = db.devices[b.d];
  const rid = d?.restaurantId, r = db.restaurants[rid];
  if (!r) throw fail(400, 'bad impression');
  if (b.kind === 'avatar') bump(`avshow|${rid}|${day()}`);
  else if ((r.promos || []).some((p) => p.id === b.id)) bump(`imp|${b.id}|${rid}|${day()}`);
  else if (db.ads.some((a) => a.id === b.id)) for (const key of [`${b.id}|${rid}|${day()}`, `${b.id}|*|${day()}`]) bump(key);
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
  logEvent(t.r.id, b.k, { table: t.table, dish: String(b.dish || '').slice(0, 40) || undefined, lang: b.lang });
  return {};
}

// Первый вызов или заказ за свободным столом — «стол открыт» (до «Закрыть стол»)
const tableIsFree = (r, table) => !openAt(db.calls, r, table).length && !openAt(db.orders, r, table).length;

function guestState(b, q) {
  const d = db.devices[q.d];
  const r = d && db.restaurants[d.restaurantId];
  if (!r || (!d.table && d.role !== 'entrance')) return { unassigned: true };
  const base = {
    restaurant: { name: r.name, langs: r.langs },
    build: BUILD,
    menu: (r.menu || []).filter((i) => !i.hidden),
    slides: slidesFor(r),
    display: { ...DISPLAY, ...r.display, palette: themeOf(r.display?.theme) },
    avatar: avatarFor(r),
  };
  // Планшет у входа: только витрина — карусель и просмотр меню, без заказов и вызовов
  if (d.role === 'entrance') return { ...base, mode: 'entrance' };
  return {
    ...base, mode: 'table', table: d.table,
    calls: openAt(db.calls, r, d.table).filter((c) => c.status !== 'done'),
    orders: openAt(db.orders, r, d.table),
  };
}

function guestCall(b) {
  const t = tableOf(b.d);
  if (!t) throw fail(400, 'device is not assigned');
  if (!['waiter', 'bill'].includes(b.type)) throw fail(400, 'bad call type');
  // Повторное нажатие не создаёт второй вызов
  let c = openAt(db.calls, t.r, t.table).find((x) => x.type === b.type && x.status !== 'done');
  if (!c) {
    if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
    c = { id: uid(), restaurantId: t.r.id, table: t.table, type: b.type, status: 'new', at: Date.now() };
    db.calls.push(c);
    logEvent(t.r.id, 'call', { id: c.id, table: t.table, type: b.type, lang: b.lang });
  }
  // Гость нажал ещё раз — напоминаем, но не чаще раза в 20 секунд
  if (Date.now() - (c.notifiedAt || 0) > 20_000) {
    c.notifiedAt = Date.now();
    notify(t.r.id, t.table, b.type);
  }
  save();
  return c;
}

function guestOrder(b) {
  const t = tableOf(b.d);
  if (!t) throw fail(400, 'device is not assigned');
  const items = buildItems(t.r, b.items);
  if (!items.length) throw fail(400, 'empty order');
  if (tableIsFree(t.r, t.table)) logEvent(t.r.id, 'open', { table: t.table });
  const o = {
    id: uid(), restaurantId: t.r.id, table: t.table, items,
    total: items.reduce((s, i) => s + i.price * i.qty, 0), status: 'pending', at: Date.now(), notifiedAt: Date.now(),
  };
  db.orders.push(o);
  logEvent(t.r.id, 'order', { id: o.id, table: t.table, total: o.total, items: items.map((i) => [i.id, i.qty, i.price]), lang: b.lang });
  notify(t.r.id, t.table, 'order', ` · ฿${o.total}`);
  save();
  return o;
}

// Строки заказа по меню: цены и названия берём из меню, а не из запроса
function buildItems(r, list) {
  const menu = new Map((r.menu || []).filter((i) => !i.hidden).map((i) => [i.id, i]));
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
      return { id: m.id, opt: opt?.key || '', name, price: Number(opt ? opt.price : m.price) || 0, qty: Math.min(99, x.qty | 0) };
    });
}

// ---------- Персонал: вход по коду ресторана + личному PIN, уведомления через Web Push

const PUSH_TEXT = {
  en: { table: 'Table', waiter: 'Waiter call', bill: 'Bill requested', order: 'New order', again: 'Reminder' },
  th: { table: 'โต๊ะ', waiter: 'เรียกพนักงาน', bill: 'ขอเช็คบิล', order: 'ออร์เดอร์ใหม่', again: 'เตือนอีกครั้ง' },
  ru: { table: 'Стол', waiter: 'Вызов официанта', bill: 'Просят счёт', order: 'Новый заказ', again: 'Напоминание' },
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
    build: BUILD,
    me: { name: member.name, role: member.role, onShift: s.onShift, push: s.subs.length > 0 },
    vapidKey: db.vapid.publicKey,
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    orders: db.orders.filter((o) => o.restaurantId === r.id && !o.closed),
  };
}

// Заказ на стол от официанта или менеджера: сразу принят (реакции ждать не от кого)
function staffOrder(b) {
  const { r, member } = session(b.token);
  const table = String(b.table || '');
  if (!(r.tables || []).includes(table)) throw fail(400, 'unknown table');
  const items = buildItems(r, b.items);
  if (!items.length) throw fail(400, 'empty order');
  if (tableIsFree(r, table)) logEvent(r.id, 'open', { table });
  const now = Date.now();
  const o = {
    id: uid(), restaurantId: r.id, table, items, total: items.reduce((s, i) => s + i.price * i.qty, 0),
    status: 'confirmed', at: now, confirmedAt: now, ackAt: now, ackBy: member.name, by: member.name, src: 'staff',
  };
  db.orders.push(o);
  logEvent(r.id, 'order', { id: o.id, table, total: o.total, items: items.map((i) => [i.id, i.qty, i.price]), by: member.id, bn: member.name, src: 'staff' });
  save();
  return o;
}

// Меню для правки заказа официантом
function staffMenu(b, q) {
  const { r } = session(q.token);
  return (r.menu || []).filter((i) => !i.hidden).map(({ id, sku, name, price, options }) => ({ id, sku, name, price, options }));
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
  if (b.kind === 'table') {
    // «Стол свободен» или «Счёт оплачен» (когда касса не подключена): закрываем сессию стола
    for (const x of [...db.calls, ...db.orders]) {
      if (x.restaurantId !== r.id || x.table !== b.id || x.closed) continue;
      if (b.action === 'paid' && x.items && !x.paidAt) {
        Object.assign(x, { paidAt: Date.now(), paidBy: member.name });
        logEvent(r.id, 'paid', { ...who, id: x.id, table: x.table, total: x.total });
      }
      x.closed = Date.now();
    }
    logEvent(r.id, 'close', { ...who, table: b.id });
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
    if (!x.paidAt) logEvent(r.id, 'paid', { ...who, id: x.id, table: x.table, total: x.total });
    Object.assign(x, { paidAt: Date.now(), paidBy: member.name });
  } else if (b.kind === 'order' && (b.action === 'ack' || b.action === 'edit')) {
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && !y.closed && y.status !== 'rejected');
    if (!x) throw fail(400, 'bad action');
    // «Иду» по заказу — останавливаем напоминания; правка заказа тоже значит, что официант им занялся
    ackOrder(x);
    if (b.action === 'edit') {
      const items = buildItems(r, b.items);
      if (!items.length) throw fail(400, 'empty order');
      Object.assign(x, { items, total: items.reduce((s, i) => s + i.price * i.qty, 0), editedAt: Date.now(), editedBy: member.name });
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
  }
  save();
  return {};
}

// Пуш всем сотрудникам ресторана, которые на смене и включили уведомления
// Официантам этого стола (без назначенных столов — всех столов); менеджерам — напоминания
// и вызовы, которые некому отправить
function notify(restaurantId, table, kind, extra = '', reminder = false) {
  const r = db.restaurants[restaurantId];
  if (!r) return;
  const member = (s) => (r.staff || []).find((m) => m.id === s.staffId);
  const active = Object.values(db.sessions).filter((s) => s.restaurantId === restaurantId && s.onShift && s.subs.length && member(s));
  const waiters = active.filter((s) => member(s).role === 'waiter' && (!member(s).tables?.length || servesTable(member(s).tables, table)));
  const managers = active.filter((s) => member(s).role === 'manager');
  for (const s of new Set([...waiters, ...(reminder || !waiters.length ? managers : [])])) {
    const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en;
    const data = { title: tableLabel(table, L.table), body: (reminder ? `${L.again}: ` : '') + L[kind] + extra, tag: `${kind}-${table}` };
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
      name: r.name, tables: r.tables || [], tariff: r.tariff || 'standard', staff: r.staff || [],
      menu: r.menu || [], promos: r.promos || [], blockedAds: r.blockedAds || [], staffArchive: r.staffArchive || [],
      menuSource: publicSource(r.menuSource),
      display: { ...DISPLAY, ...r.display },
      avatar: { ...AVATAR, ...r.avatar },
    },
    ads: db.ads.filter((a) => a.active && (!a.restaurants?.length || a.restaurants.includes(r.id)))
      .map((a) => ({
      id: a.id, title: a.title, advertiser: a.advertiser, image: a.image, link: a.link, phone: a.phone, ...qrPlace(a), ...framing(a),
      views: views(a.id, r.id), scans: scans(a.id, r.id),
    })),
    characters: db.characters.map((c) => ({ id: c.id, name: c.name, image: c.images.idle, greeting: c.greeting, recorded: Object.keys(c.audio?.greeting || {}) })),
    themes: THEMES,
    devices: Object.values(db.devices).filter((d) => d.restaurantId === r.id).map((d) => ({
      id: d.id, entrance: d.role === 'entrance', table: d.table, online: Date.now() - d.lastSeen < ONLINE_MS,
      lastSeen: d.lastSeen, ...pick(d.telemetry, ['battery', 'charging', 'wifi', 'rssi', 'version']),
    })),
  };
}

const SECTIONS = { testVisit: 'пометка тестового визита', staffArchive: 'уволенные', staff: 'персонал', menu: 'меню', promos: 'акции', blockedAds: 'блокировка рекламы', menuSource: 'источник меню', display: 'показ и дизайн', avatar: 'ИИ-персонаж', tables: 'столы' };
function managerSave(b) {
  const { r, member } = managerSession(b.token);
  const changed = Object.keys(SECTIONS).filter((k) => b[k] !== undefined).map((k) => SECTIONS[k]);
  if (changed.length) audit(`${member.name} (менеджер)`, `ЛК: сохранено — ${changed.join(', ')}`, r.id);
  if (Array.isArray(b.staff)) setStaff(r, b.staff, b.fired || {});
  if (Array.isArray(b.staffArchive)) setArchive(r, b.staffArchive);
  if (b.testVisit) markTest(r, b.testVisit.ids, b.testVisit.test);
  if (Array.isArray(b.menu)) r.menu = cleanMenu(b.menu);
  if (Array.isArray(b.promos)) r.promos = cleanPromos(b.promos);
  if (Array.isArray(b.promos) || Array.isArray(b.menu)) syncPromoItems(r);
  if (Array.isArray(b.blockedAds)) r.blockedAds = b.blockedAds.map(String);
  if (b.menuSource) r.menuSource = cleanSource(b.menuSource, r.menuSource);
  if (b.display) r.display = cleanDisplay(b.display);
  if (b.avatar) r.avatar = cleanAvatar(b.avatar);
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
  await syncMenu(r);
  return publicSource(r.menuSource);
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
  return {
    ...prev, type,
    url: String(b.url ?? prev.url ?? '').trim(),
    vendor: POS_VENDORS[b.vendor] ? b.vendor : 'loyverse',
    token: b.token ? String(b.token).trim() : prev.token || '',
    lang: ['en', 'th', 'ru', 'zh'].includes(b.lang) ? b.lang : prev.lang || 'en',
    interval: ['hourly', 'daily', 'off'].includes(b.interval) ? b.interval : prev.interval || 'hourly',
  };
}

const pick = (o = {}, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const nonEmpty = (o = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

// Поля из источника (названия на его языках, категория, цена, варианты, наличие) обновляем;
// переводы на другие языки, «блюдо дня», акции и своё фото сохраняем.
// Блюда, пропавшие из источника, скрываем, а добавленные вручную не трогаем.
function mergeMenu(r, items) {
  const old = new Map((r.menu || []).filter((i) => i.extId).map((i) => [i.extId, i]));
  const seen = new Set();
  const synced = items.filter((s) => s.extId && Object.values(s.name || {}).some(Boolean)).map((s) => {
    seen.add(s.extId);
    const o = old.get(s.extId) || { id: uid(), cat: {}, name: {}, desc: {} };
    return {
      ...o, extId: s.extId, sku: s.sku || o.sku || '',
      cat: { ...o.cat, ...nonEmpty(s.cat) }, name: { ...o.name, ...nonEmpty(s.name) }, desc: { ...o.desc, ...nonEmpty(s.desc) },
      price: Number(s.price) || 0, options: s.options || [],
      photo: o.photoManual ? o.photo : s.photo || o.photo || '',
      hidden: s.available === false,
    };
  });
  const manual = (r.menu || []).filter((i) => !i.extId);
  const gone = [...old.values()].filter((i) => !seen.has(i.extId)).map((i) => ({ ...i, hidden: true }));
  r.menu = [...synced, ...manual, ...gone];
}

const syncing = new Set();
async function syncMenu(r) {
  const src = r.menuSource;
  if (!src || src.type === 'manual' || syncing.has(r.id)) return;
  syncing.add(r.id);
  try {
    const items = await fetchMenu(src);
    mergeMenu(r, items);
    Object.assign(src, { lastCount: items.length, lastError: '' });
  } catch (e) {
    src.lastError = e.message;
  } finally {
    src.lastSync = Date.now();
    syncing.delete(r.id);
    save();
  }
}

// Проверяем источники раз в 5 минут; каждый ресторан — с выбранной частотой (раз в час или раз в день)
setInterval(() => {
  for (const r of Object.values(db.restaurants)) {
    const s = r.menuSource;
    if (s && s.type !== 'manual' && SYNC_EVERY[s.interval] && Date.now() - (s.lastSync || 0) > SYNC_EVERY[s.interval]) syncMenu(r);
  }
}, 5 * 60_000);

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

function cleanMenu(menu) {
  return menu
    .filter((i) => i && i.name && typeof i.name === 'object' && Object.values(i.name).some(Boolean))
    .map((i) => ({
      id: i.id || uid(), cat: i.cat || {}, name: i.name, desc: i.desc || {},
      price: Number(i.price) || 0, photo: String(i.photo || ''), promo: !!i.promo, dayDish: !!i.dayDish,
      extId: i.extId || undefined, sku: String(i.sku || ''), options: Array.isArray(i.options) ? i.options : [],
      hidden: !!i.hidden, photoManual: !!i.photoManual, fromPromo: i.fromPromo ? String(i.fromPromo) : undefined,
      tags: (Array.isArray(i.tags) ? i.tags : []).filter((x) => DISH_TAGS.includes(x)),
    }));
}

// Числа — в своих пределах, цвета — только #rrggbb, тема — из списка; иначе значение по умолчанию
function cleanDisplay(d) {
  return Object.fromEntries(Object.entries(DISPLAY).map(([k, def]) => {
    if (k === 'theme') return [k, themeOf(d.theme).id];
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

function cleanAvatar(a) {
  const num = (v, min, max, def) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  return {
    enabled: !!a.enabled, characterId: String(a.characterId || ''), speak: a.speak !== false,
    everyMin: num(a.everyMin, 1, 60, AVATAR.everyMin), durationSec: num(a.durationSec, 10, 180, AVATAR.durationSec),
    startWith: a.startWith !== false,
    greetings: (Array.isArray(a.greetings) ? a.greetings : []).map(texts).filter((g) => Object.keys(g).length).slice(0, 20),
    filters: (Array.isArray(a.filters) ? a.filters : []).filter((f) => DISH_TAGS.includes(f)),
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
  const c = r && avatarFor(r), text = String(q.t || '').trim().slice(0, 400);
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
    greeting: lines(p.greeting),
    // Варианты рекомендаций в стиле персонажа: { recommend: [{ru,en,th,zh}], dayDish: [...] }, {dish} — название блюда
    // У варианта может быть запись начала фразы (audio: { ru: MP3 }) — тогда после неё звучит только название блюда
    phrases: Object.fromEntries(['recommend', 'dayDish'].map((k) => [k, (Array.isArray(p.phrases?.[k]) ? p.phrases[k] : []).slice(0, 20).map((o) => {
      const text = Object.fromEntries(Object.entries(lines(o)).filter(([l, v]) => LANG4.includes(l) && typeof v === 'string' && v.includes('{dish}')).map(([l, v]) => [l, v.slice(0, 200)]));
      const audio = Object.fromEntries(Object.entries(lines(o?.audio)).filter(([l, v]) => LANG4.includes(l) && v).map(([l, v]) => [l, storeDataUri(v)]));
      return Object.keys(audio).length ? { ...text, audio } : text;
    }).filter((o) => Object.keys(o).some((l) => l !== 'audio'))])),
    // Записанное приветствие (MP3) по языкам: играет вместо синтеза; остальные фразы — синтез, как раньше
    audio: { greeting: Object.fromEntries(Object.entries(lines(p.audio?.greeting))
      .filter(([l, v]) => ['en', 'th', 'ru', 'zh'].includes(l) && v).map(([l, v]) => [l, storeDataUri(v)])) },
    dialog: p.dialog && typeof p.dialog === 'object' ? p.dialog : { start: 'hello', nodes: {} },
  };
}

function cleanAd(a) {
  return {
    id: a.id || uid(), advertiser: String(a.advertiser || ''), title: String(a.title || ''), image: String(a.image || ''),
    restaurants: (a.restaurants || []).map(String), active: !!a.active,
    link: String(a.link || '').trim(), phone: String(a.phone || '').trim(), ...qrPlace(a), ...framing(a),
  };
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
    const now = Date.now();
    return Object.values(db.devices).filter((d) => !scope || scope.has(d.restaurantId)).map(({ queue, ...d }) =>
      ({ ...d, online: now - d.lastSeen < ONLINE_MS, pending: queue.length }));
  }
  if (method === 'GET' && p === '/api/restaurants') {
    const list = Object.values(db.restaurants).filter((r) => !scope || scope.has(r.id));
    if (me.role === 'viewer') return list.map((r) => ({ id: r.id, name: r.name }));
    return list.map((r) => ({ ...r, menuSource: publicSource(r.menuSource) }));
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
      menu: Array.isArray(b.menu) ? cleanMenu(b.menu) : prev.menu || [],
      staff: prev.staff || [],
      promos: Array.isArray(b.promos) ? cleanPromos(b.promos) : prev.promos || [],
      tariff: b.tariff === 'premium' ? 'premium' : 'standard',
      blockedAds: prev.blockedAds || [],
      menuSource: b.menuSource ? cleanSource(b.menuSource, prev.menuSource) : prev.menuSource,
      syncKey: prev.syncKey || crypto.randomBytes(12).toString('hex'),
    };
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
  if (method === 'GET' && p === '/api/ads') return db.ads.map((a) => ({ ...a, views: views(a.id), scans: scans(a.id) }));
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
    db.characters = db.characters.filter((x) => x.id !== c.id).concat(c);
    save();
    return c;
  }
  if (method === 'POST' && p === '/api/ads') {
    const ad = cleanAd(b);
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
    return syncMenu(db.restaurants[m[1]]).then(() => publicSource(db.restaurants[m[1]].menuSource));
  }

  m = p.match(/^\/api\/devices\/([^/]+)(?:\/(command|assign))?$/);
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
  if (method === 'POST' && m[2] === 'assign') {
    // Привязка к столу сразу переключает планшет на интерфейс стола
    d.restaurantId = b.restaurantId || null;
    d.role = b.restaurantId && b.table === 'entrance' ? 'entrance' : 'table';
    d.table = b.restaurantId && b.table && d.role === 'table' ? String(b.table) : null;
    const placed = d.table || d.role === 'entrance';
    d.queue.push({ type: 'url', url: placed ? `${PUBLIC_URL}/guest/?d=${encodeURIComponent(d.id)}` : '' });
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

// Однократно: столы «1», «B1» → «Стол 1», «Стол B1» (вместе с планшетами, официантами и заказами)
for (const r of Object.values(db.restaurants)) {
  if ((r.tables || []).some((n) => fullTable(n) !== n)) saveTables(r, r.tables.map((n) => ({ from: n, to: fullTable(n) })));
}
save();

http.createServer(async (req, res) => {
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
      const target = qrRedirect(go[1], go[2], url.searchParams.get('r'));
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
}).listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));
