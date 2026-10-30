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
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript', svg: 'image/svg+xml' };
const FILES = Object.fromEntries(Object.values(STATIC).map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url))]));

let db = { devices: {}, restaurants: {}, calls: [], orders: [], sessions: {}, vapid: null, ads: [], stats: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  // первая версия сервера хранила только devices.json
  try { db.devices = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'devices.json'), 'utf8')); } catch {}
}
db.sessions ??= {};
db.ads ??= [];
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
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
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

function tableOf(deviceId) {
  const d = db.devices[deviceId];
  const r = d && db.restaurants[d.restaurantId];
  return r && d.table ? { r, table: d.table } : null;
}

const openAt = (list, r, table) => list.filter((x) => x.restaurantId === r.id && x.table === table && !x.closed);

// Карусель простоя: акции и блюда ресторана, через каждые две — внешняя реклама (кроме тарифа Premium)
function slidesFor(r) {
  const own = [
    ...(r.promos || []).filter((p) => p.active && p.image).map((p) => ({ type: 'promo', id: p.id, image: p.image, title: p.title, text: p.text })),
    ...(r.menu || []).filter((i) => (i.promo || i.dayDish) && i.photo).map((i) => ({ type: 'item', id: i.id, image: i.photo, title: i.name, price: i.price })),
  ];
  const ads = r.tariff === 'premium' ? [] : db.ads
    .filter((a) => a.active && a.image && (!a.restaurants?.length || a.restaurants.includes(r.id)) && !(r.blockedAds || []).includes(a.id))
    .map((a) => ({ type: 'ad', id: a.id, image: a.image, title: a.title }));
  if (!own.length) return ads;
  const out = [];
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

function guestImpression(b) {
  const t = tableOf(b.d);
  if (!t || !db.ads.some((a) => a.id === b.id)) throw fail(400, 'bad impression');
  for (const key of [`${b.id}|${t.r.id}|${day()}`, `${b.id}|*|${day()}`]) db.stats[key] = (db.stats[key] || 0) + 1;
  save();
  return {};
}

function guestState(b, q) {
  const t = tableOf(q.d);
  if (!t) return { unassigned: true };
  return {
    restaurant: { name: t.r.name, langs: t.r.langs },
    table: t.table,
    menu: t.r.menu || [],
    slides: slidesFor(t.r),
    calls: openAt(db.calls, t.r, t.table).filter((c) => c.status !== 'done'),
    orders: openAt(db.orders, t.r, t.table),
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
  const menu = new Map((t.r.menu || []).map((i) => [i.id, i]));
  const items = (b.items || [])
    .filter((x) => menu.has(x.id) && x.qty > 0)
    .slice(0, 50)
    .map((x) => {
      const m = menu.get(x.id);
      return { id: m.id, name: m.name, price: Number(m.price) || 0, qty: Math.min(99, x.qty | 0) };
    });
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
    restaurant: { name: r.name },
    me: { name: member.name, role: member.role, onShift: s.onShift, push: s.subs.length > 0 },
    vapidKey: db.vapid.publicKey,
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    orders: db.orders.filter((o) => o.restaurantId === r.id && !o.closed),
  };
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
    // «Стол свободен»: закрываем сессию стола
    for (const x of [...db.calls, ...db.orders]) {
      if (x.restaurantId === r.id && x.table === b.id && !x.closed) x.closed = Date.now();
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
    ...db.orders.filter((o) => o.status === 'pending').map((o) => [o, 'order']),
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
    },
    ads: db.ads.filter((a) => a.active && (!a.restaurants?.length || a.restaurants.includes(r.id)))
      .map((a) => ({ id: a.id, title: a.title, advertiser: a.advertiser, image: a.image, views: views(a.id, r.id) })),
  };
}

function managerSave(b) {
  const { r } = managerSession(b.token);
  if (Array.isArray(b.staff)) r.staff = cleanStaff(b.staff);
  if (Array.isArray(b.menu)) r.menu = cleanMenu(b.menu);
  if (Array.isArray(b.promos)) r.promos = cleanPromos(b.promos);
  if (Array.isArray(b.blockedAds)) r.blockedAds = b.blockedAds.map(String);
  save();
  return {};
}

// ---------- Администратор

function cleanMenu(menu) {
  return menu
    .filter((i) => i && i.name && Object.values(i.name).some(Boolean))
    .map((i) => ({
      id: i.id || uid(), cat: i.cat || {}, name: i.name, desc: i.desc || {},
      price: Number(i.price) || 0, photo: String(i.photo || ''), promo: !!i.promo, dayDish: !!i.dayDish,
    }));
}

function cleanPromos(list) {
  return list.filter((p) => p && p.image).map((p) => ({
    id: p.id || uid(), image: String(p.image), title: p.title || {}, text: p.text || {}, active: !!p.active,
  }));
}

function cleanAd(a) {
  return {
    id: a.id || uid(), advertiser: String(a.advertiser || ''), title: String(a.title || ''), image: String(a.image || ''),
    restaurants: (a.restaurants || []).map(String), active: !!a.active,
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
  if (method === 'GET' && p === '/api/restaurants') return Object.values(db.restaurants);
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
    };
    save();
    return db.restaurants[id];
  }
  if (method === 'GET' && p === '/api/ads') return db.ads.map((a) => ({ ...a, views: views(a.id) }));
  if (method === 'POST' && p === '/api/ads') {
    const ad = cleanAd(b);
    const i = db.ads.findIndex((a) => a.id === ad.id);
    if (i >= 0) db.ads[i] = ad; else db.ads.push(ad);
    save();
    return ad;
  }
  let m = p.match(/^\/api\/ads\/([^/]+)$/);
  if (m && method === 'DELETE') { db.ads = db.ads.filter((a) => a.id !== m[1]); save(); return {}; }
  m = p.match(/^\/api\/restaurants\/([^/]+)$/);
  if (m && method === 'DELETE') { delete db.restaurants[m[1]]; save(); return {}; }

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
    d.table = b.restaurantId && b.table ? String(b.table) : null;
    d.queue.push({ type: 'url', url: d.table ? `${PUBLIC_URL}/guest/?d=${encodeURIComponent(d.id)}` : '' });
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
  'POST /api/guest/impression': guestImpression,
  'GET /api/manager/restaurant': managerGet,
  'POST /api/manager/restaurant': managerSave,
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
    if (route) return send(res, 200, route(body, Object.fromEntries(url.searchParams), req));

    if (!isAdmin(req)) return send(res, 401, { error: 'not signed in' });
    const out = admin(req.method, url.pathname, body);
    send(res, out === undefined ? 404 : 200, out ?? { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));
