// JET MEDIA — минимальный сервер без зависимостей (только встроенные модули Node.js).
//   /api/device/*  — планшеты: телеметрия раз в 15 с, в ответ команды
//   /guest/        — интерфейс стола (меню, вызов официанта, заказ)
//   /staff/        — приложение персонала (PWA): вызовы и заказы ресторана
//   /              — портал администратора (Basic Auth)
// Данные — в DATA_DIR/db.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://app.jetmedia.dev';
const ONLINE_MS = 45_000;
const KEEP_MS = 7 * 24 * 3600_000;
const COMMANDS = ['url', 'reload', 'reboot', 'update'];
const STATIC = {
  '/': 'portal.html',
  '/guest/': 'guest.html',
  '/staff/': 'staff.html',
  '/staff/manifest.json': 'manifest.json',
  '/staff/sw.js': 'sw.js',
};
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/manifest+json', js: 'text/javascript' };
const FILES = Object.fromEntries(Object.values(STATIC).map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url))]));

let db = { devices: {}, restaurants: {}, calls: [], orders: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  // первая версия сервера хранила только devices.json
  try { db.devices = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'devices.json'), 'utf8')); } catch {}
}

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
const fail = (status, message) => Object.assign(new Error(message), { status });
const isAdmin = (req) => req.headers.authorization === 'Basic ' + Buffer.from('admin:' + PASS).toString('base64');

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

function guestState(b, q) {
  const t = tableOf(q.d);
  if (!t) return { unassigned: true };
  return {
    restaurant: { name: t.r.name, langs: t.r.langs },
    table: t.table,
    menu: t.r.menu || [],
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
    save();
  }
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
    total: items.reduce((s, i) => s + i.price * i.qty, 0), status: 'pending', at: Date.now(),
  };
  db.orders.push(o);
  save();
  return o;
}

// ---------- Персонал (вход по коду ресторана)

function restaurantByCode(code) {
  const r = Object.values(db.restaurants).find((x) => x.staffCode && x.staffCode === String(code || ''));
  if (!r) throw fail(403, 'wrong code');
  return r;
}

function staffState(b, q) {
  const r = restaurantByCode(q.code);
  return {
    restaurant: { id: r.id, name: r.name },
    calls: db.calls.filter((c) => c.restaurantId === r.id && !c.closed && c.status !== 'done'),
    orders: db.orders.filter((o) => o.restaurantId === r.id && !o.closed),
  };
}

const NEXT = { call: { ack: 'ack', done: 'done' }, order: { confirm: 'confirmed', reject: 'rejected' } };

function staffAction(b) {
  const r = restaurantByCode(b.code);
  const by = String(b.staff || '').slice(0, 40);
  if (b.kind === 'table') {
    // «Стол свободен»: закрываем сессию стола
    for (const x of [...db.calls, ...db.orders]) {
      if (x.restaurantId === r.id && x.table === b.id && !x.closed) x.closed = Date.now();
    }
  } else {
    const x = (b.kind === 'call' ? db.calls : db.orders).find((y) => y.id === b.id && y.restaurantId === r.id);
    const status = NEXT[b.kind]?.[b.action];
    if (!x || !status) throw fail(400, 'bad action');
    Object.assign(x, { status, by, [`${status}At`]: Date.now() });
  }
  save();
  return {};
}

// ---------- Администратор

function cleanMenu(menu) {
  return menu
    .filter((i) => i && i.name && Object.values(i.name).some(Boolean))
    .map((i) => ({
      id: i.id || uid(), cat: i.cat || {}, name: i.name, desc: i.desc || {},
      price: Number(i.price) || 0, photo: String(i.photo || ''), promo: !!i.promo,
    }));
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
    };
    save();
    return db.restaurants[id];
  }
  let m = p.match(/^\/api\/restaurants\/([^/]+)$/);
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
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    // /staff и /guest без косой черты → на адрес с чертой
    if (req.method === 'GET' && STATIC[url.pathname + '/']) {
      res.writeHead(301, { location: url.pathname + '/' + url.search });
      return res.end();
    }
    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file && (url.pathname !== '/' || isAdmin(req))) return send(res, 200, FILES[file], TYPES[file.split('.').pop()]);

    const body = req.method === 'POST' ? await readBody(req) : {};
    const route = PUBLIC[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, route(body, Object.fromEntries(url.searchParams), req));

    if (!isAdmin(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="JET MEDIA"' });
      return res.end();
    }
    const out = admin(req.method, url.pathname, body);
    send(res, out === undefined ? 404 : 200, out ?? { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));
