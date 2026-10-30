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

const PORT = 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://app.jetmedia.dev';
const ONLINE_MS = 45_000;
const KEEP_MS = 7 * 24 * 3600_000;
const REMIND_MS = 45_000;
const MAX_REMINDERS = 5;
const COMMANDS = ['url', 'reload', 'reboot', 'update'];
const STATIC = {
  '/': 'portal.html',
  '/guest/': 'guest.html',
  '/staff/': 'staff.html',
  '/staff/manifest.json': 'manifest.json',
  '/staff/sw.js': 'sw.js',
  '/login': 'login.html',
  '/favicon.ico': 'favicon.svg',
  '/favicon.svg': 'favicon.svg',
  '/vendor/qrcode.js': 'vendor/qrcode.js',
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript', svg: 'image/svg+xml' };
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
  showHint: true, hint: {}, // подпись под заголовком слайда; пустой текст — стандартная «Листайте, чтобы посмотреть ещё»
};
// ИИ-персонаж: как часто появляется в карусели, сколько держится, приветствия и подбор блюд по пожеланиям
const AVATAR = { enabled: false, characterId: '', speak: true, everyMin: 3, durationSec: 20, startWith: true, greetings: [], filters: [] };
// Отметки блюд для подбора по особым пожеланиям
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
db.stats ??= {};
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
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const fail = (status, message) => Object.assign(new Error(message), { status });
// Вход администратора — страница /login и cookie; cookie меняется вместе с паролем
const ADMIN_COOKIE = crypto.createHmac('sha256', PASS).update('jetmedia-admin').digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const isAdmin = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`jm_admin=${ADMIN_COOKIE}`);

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
  // Новые устройства — только с ключом регистрации; уже известные пускаем как есть
  if (DEVICE_KEY && b.key !== DEVICE_KEY && !db.devices[b.id]) throw fail(403, 'bad device key');
  const d = (db.devices[b.id] ??= { id: b.id, firstSeen: Date.now(), queue: [] });
  d.telemetry = b.telemetry || {};
  d.lastSeen = Date.now();
  d.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const commands = d.queue.splice(0);
  save();
  return { commands };
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
      type: 'promo', id: p.id, image: p.image, title: p.title, text: p.text, phone: p.phone || '',
      qr: p.link ? `${PUBLIC_URL}/go/p/${p.id}?r=${r.id}` : '',
    })),
    ...(r.menu || []).filter((i) => (i.promo || i.dayDish) && i.photo).map((i) => ({ type: 'item', id: i.id, image: i.photo, title: i.name, price: i.price })),
  ];
  const ads = r.tariff === 'premium' ? [] : db.ads
    .filter((a) => a.active && a.image && (!a.restaurants?.length || a.restaurants.includes(r.id)) && !(r.blockedAds || []).includes(a.id))
    .map((a) => ({ type: 'ad', id: a.id, image: a.image, title: a.title, phone: a.phone || '', qr: a.link ? `${PUBLIC_URL}/go/a/${a.id}?r=${r.id}` : '' }));
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
  return c ? { ...c, ...pick(a, ['speak', 'everyMin', 'durationSec', 'startWith', 'greetings', 'filters']) } : null;
}

function guestImpression(b) {
  const d = db.devices[b.d];
  const rid = d?.restaurantId;
  if (!db.restaurants[rid] || !db.ads.some((a) => a.id === b.id)) throw fail(400, 'bad impression');
  for (const key of [`${b.id}|${rid}|${day()}`, `${b.id}|*|${day()}`]) db.stats[key] = (db.stats[key] || 0) + 1;
  save();
  return {};
}

function guestState(b, q) {
  const d = db.devices[q.d];
  const r = d && db.restaurants[d.restaurantId];
  if (!r || (!d.table && d.role !== 'entrance')) return { unassigned: true };
  const base = {
    restaurant: { name: r.name, langs: r.langs },
    build: BUILD,
    menu: (r.menu || []).filter((i) => !i.hidden),
    slides: slidesFor(r),
    display: { ...DISPLAY, ...r.display },
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
    c = { id: uid(), restaurantId: t.r.id, table: t.table, type: b.type, status: 'new', at: Date.now() };
    db.calls.push(c);
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
  const o = {
    id: uid(), restaurantId: t.r.id, table: t.table, items,
    total: items.reduce((s, i) => s + i.price * i.qty, 0), status: 'pending', at: Date.now(), notifiedAt: Date.now(),
  };
  db.orders.push(o);
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
  save();
  return { token };
}

function staffState(b, q) {
  const { s, r, member } = session(q.token);
  return {
    restaurant: { name: r.name, pos: r.menuSource?.type === 'pos' },
    build: BUILD,
    me: { name: member.name, role: member.role, onShift: s.onShift, push: s.subs.length > 0 },
    vapidKey: db.vapid.publicKey,
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    orders: db.orders.filter((o) => o.restaurantId === r.id && !o.closed),
  };
}

// Меню для правки заказа официантом
function staffMenu(b, q) {
  const { r } = session(q.token);
  return (r.menu || []).filter((i) => !i.hidden).map(({ id, sku, name, price, options }) => ({ id, sku, name, price, options }));
}

function staffShift(b) {
  session(b.token).s.onShift = !!b.on;
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
  delete db.sessions[b.token];
  save();
  return {};
}

const NEXT = { call: { ack: 'ack', done: 'done' }, order: { confirm: 'confirmed', reject: 'rejected' } };

function staffAction(b) {
  const { r, member } = session(b.token);
  if (b.kind === 'table') {
    // «Стол свободен» или «Счёт оплачен» (когда касса не подключена): закрываем сессию стола
    for (const x of [...db.calls, ...db.orders]) {
      if (x.restaurantId !== r.id || x.table !== b.id || x.closed) continue;
      if (b.action === 'paid' && x.items) Object.assign(x, { paidAt: Date.now(), paidBy: member.name });
      x.closed = Date.now();
    }
  } else if (b.kind === 'order' && (b.action === 'ack' || b.action === 'edit')) {
    const x = db.orders.find((y) => y.id === b.id && y.restaurantId === r.id && !y.closed && y.status !== 'rejected');
    if (!x) throw fail(400, 'bad action');
    // «Иду» по заказу — останавливаем напоминания; правка заказа тоже значит, что официант им занялся
    if (!x.ackAt) Object.assign(x, { ackAt: Date.now(), ackBy: member.name });
    if (b.action === 'edit') {
      const items = buildItems(r, b.items);
      if (!items.length) throw fail(400, 'empty order');
      Object.assign(x, { items, total: items.reduce((s, i) => s + i.price * i.qty, 0), editedAt: Date.now(), editedBy: member.name });
    }
  } else {
    const x = (b.kind === 'call' ? db.calls : db.orders).find((y) => y.id === b.id && y.restaurantId === r.id);
    const status = NEXT[b.kind]?.[b.action];
    if (!x || !status) throw fail(400, 'bad action');
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
  const waiters = active.filter((s) => member(s).role === 'waiter' && (!member(s).tables?.length || member(s).tables.includes(table)));
  const managers = active.filter((s) => member(s).role === 'manager');
  for (const s of new Set([...waiters, ...(reminder || !waiters.length ? managers : [])])) {
    const L = PUSH_TEXT[s.lang] || PUSH_TEXT.en;
    const data = { title: `${L.table} ${table}`, body: (reminder ? `${L.again}: ` : '') + L[kind] + extra, tag: `${kind}-${table}` };
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
      menu: r.menu || [], promos: r.promos || [], blockedAds: r.blockedAds || [],
      menuSource: publicSource(r.menuSource),
      display: { ...DISPLAY, ...r.display },
      avatar: { ...AVATAR, ...r.avatar },
    },
    ads: db.ads.filter((a) => a.active && (!a.restaurants?.length || a.restaurants.includes(r.id)))
      .map((a) => ({ id: a.id, title: a.title, advertiser: a.advertiser, image: a.image, views: views(a.id, r.id), scans: scans(a.id, r.id) })),
    characters: db.characters.map((c) => ({ id: c.id, name: c.name, image: c.images.idle })),
    devices: Object.values(db.devices).filter((d) => d.restaurantId === r.id).map((d) => ({
      id: d.id, entrance: d.role === 'entrance', table: d.table, online: Date.now() - d.lastSeen < ONLINE_MS,
      lastSeen: d.lastSeen, ...pick(d.telemetry, ['battery', 'charging', 'wifi', 'rssi', 'version']),
    })),
  };
}

function managerSave(b) {
  const { r } = managerSession(b.token);
  if (Array.isArray(b.staff)) r.staff = cleanStaff(b.staff);
  if (Array.isArray(b.menu)) r.menu = cleanMenu(b.menu);
  if (Array.isArray(b.promos)) r.promos = cleanPromos(b.promos);
  if (Array.isArray(b.blockedAds)) r.blockedAds = b.blockedAds.map(String);
  if (b.menuSource) r.menuSource = cleanSource(b.menuSource, r.menuSource);
  if (b.display) r.display = cleanDisplay(b.display);
  if (b.avatar) r.avatar = cleanAvatar(b.avatar);
  save();
  return {};
}

async function managerSync(b) {
  const { r } = managerSession(b.token);
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
      hidden: !!i.hidden, photoManual: !!i.photoManual,
      tags: (Array.isArray(i.tags) ? i.tags : []).filter((x) => DISH_TAGS.includes(x)),
    }));
}

function cleanDisplay(d) {
  const num = (v, min, max, def) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  const color = (v, def) => (/^#[0-9a-f]{6}$/i.test(v) ? v : def);
  return {
    idleSec: num(d.idleSec, 10, 600, DISPLAY.idleSec), slideSec: num(d.slideSec, 3, 60, DISPLAY.slideSec),
    titleSize: num(d.titleSize, 16, 80, DISPLAY.titleSize), textSize: num(d.textSize, 12, 48, DISPLAY.textSize),
    textColor: color(d.textColor, DISPLAY.textColor), bgColor: color(d.bgColor, DISPLAY.bgColor),
    showHint: d.showHint !== false, hint: texts(d.hint),
  };
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

function cleanPromos(list) {
  return list.filter((p) => p && p.image).map((p) => ({
    id: p.id || uid(), image: String(p.image), title: p.title || {}, text: p.text || {}, active: !!p.active,
    link: String(p.link || '').trim(), phone: String(p.phone || '').trim(),
  }));
}

// Пакет ИИ-персонажа (JSON): имя, картинки «молчит» и «говорит», голос, приветствие и сценарий кнопок.
// Формат описан в docs/character-pack.md.
function cleanCharacter(p) {
  if (!p || !p.images?.idle) throw fail(400, 'pack needs images.idle');
  const lines = (o) => (o && typeof o === 'object' ? o : {});
  return {
    id: String(p.id || uid()).replace(/[^\w-]/g, '').slice(0, 40) || uid(),
    name: lines(p.name),
    images: { idle: storeDataUri(p.images.idle), talk: storeDataUri(p.images.talk || p.images.idle) },
    voice: { pitch: Number(p.voice?.pitch) || 1, rate: Number(p.voice?.rate) || 1 },
    greeting: lines(p.greeting),
    dialog: p.dialog && typeof p.dialog === 'object' ? p.dialog : { start: 'hello', nodes: {} },
  };
}

function cleanAd(a) {
  return {
    id: a.id || uid(), advertiser: String(a.advertiser || ''), title: String(a.title || ''), image: String(a.image || ''),
    restaurants: (a.restaurants || []).map(String), active: !!a.active,
    link: String(a.link || '').trim(), phone: String(a.phone || '').trim(),
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
      tables: (m.tables || []).map(String),
    };
  });
}

function admin(method, p, b) {
  if (method === 'GET' && p === '/api/devices') {
    const now = Date.now();
    return Object.values(db.devices).map(({ queue, ...d }) =>
      ({ ...d, online: now - d.lastSeen < ONLINE_MS, pending: queue.length }));
  }
  if (method === 'GET' && p === '/api/restaurants') {
    return Object.values(db.restaurants).map((r) => ({ ...r, menuSource: publicSource(r.menuSource) }));
  }
  if (method === 'POST' && p === '/api/restaurants') {
    const id = b.id || uid();
    const prev = db.restaurants[id] || { staffCode: String(crypto.randomInt(100000, 1000000)) };
    db.restaurants[id] = {
      ...prev, id,
      name: String(b.name || 'Ресторан'),
      tables: (b.tables || []).map(String),
      langs: b.langs || prev.langs || ['en', 'th', 'ru', 'zh'],
      menu: Array.isArray(b.menu) ? cleanMenu(b.menu) : prev.menu || [],
      staff: Array.isArray(b.staff) ? cleanStaff(b.staff) : prev.staff || [],
      promos: Array.isArray(b.promos) ? cleanPromos(b.promos) : prev.promos || [],
      tariff: b.tariff === 'premium' ? 'premium' : 'standard',
      blockedAds: prev.blockedAds || [],
      menuSource: b.menuSource ? cleanSource(b.menuSource, prev.menuSource) : prev.menuSource,
      syncKey: prev.syncKey || crypto.randomBytes(12).toString('hex'),
    };
    save();
    return db.restaurants[id];
  }
  if (method === 'GET' && p === '/api/ads') return db.ads.map((a) => ({ ...a, views: views(a.id), scans: scans(a.id) }));
  if (method === 'GET' && p === '/api/characters') return db.characters;
  if (method === 'POST' && p === '/api/characters') {
    const c = cleanCharacter(b);
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
  if (m && method === 'DELETE') { delete db.restaurants[m[1]]; save(); return {}; }
  m = p.match(/^\/api\/restaurants\/([^/]+)\/sync$/);
  if (m && method === 'POST' && db.restaurants[m[1]]) {
    return syncMenu(db.restaurants[m[1]]).then(() => publicSource(db.restaurants[m[1]].menuSource));
  }

  m = p.match(/^\/api\/devices\/([^/]+)(?:\/(command|assign))?$/);
  const d = m && db.devices[decodeURIComponent(m[1])];
  if (!d) return undefined;
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
  'GET /api/guest/state': guestState,
  'POST /api/guest/call': guestCall,
  'POST /api/guest/order': guestOrder,
  'GET /api/staff/state': staffState,
  'POST /api/staff/action': staffAction,
  'POST /api/staff/login': staffLogin,
  'POST /api/staff/shift': staffShift,
  'POST /api/staff/subscribe': staffSubscribe,
  'POST /api/staff/logout': staffLogout,
  'GET /api/staff/menu': staffMenu,
  'POST /api/guest/impression': guestImpression,
  'GET /api/manager/restaurant': managerGet,
  'POST /api/manager/restaurant': managerSave,
  'POST /api/manager/sync': managerSync,
  'POST /api/menu/webhook': menuWebhook,
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    // /staff и /guest без косой черты → на адрес с чертой
    if (req.method === 'GET' && STATIC[url.pathname + '/']) {
      res.writeHead(301, { location: url.pathname + '/' + url.search });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/' && !isAdmin(req)) {
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
      if (!isAdmin(req)) managerSession(token);
      return send(res, 200, await upload(req));
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!crypto.timingSafeEqual(sha(body.password), sha(PASS))) {
        await new Promise((r) => setTimeout(r, 1000)); // притормаживаем подбор пароля
        return send(res, 403, { error: 'wrong password' });
      }
      res.setHeader('set-cookie', `jm_admin=${ADMIN_COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
      return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      res.setHeader('set-cookie', 'jm_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return send(res, 200, {});
    }
    const route = PUBLIC[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(body, Object.fromEntries(url.searchParams), req));

    if (!isAdmin(req)) return send(res, 401, { error: 'not signed in' });
    const out = await admin(req.method, url.pathname, body);
    send(res, out === undefined ? 404 : 200, out ?? { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));
