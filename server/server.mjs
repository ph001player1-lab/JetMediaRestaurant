// JET MEDIA — минимальный сервер: планшеты опрашивают его раз в 15 с, админ управляет из портала.
// Без зависимостей: только встроенные модули Node.js. Данные — в DATA_DIR/devices.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3000;
const DATA = path.join(process.env.DATA_DIR || './data', 'devices.json');
const PASS = process.env.ADMIN_PASSWORD || 'admin';
const ONLINE_MS = 45_000;
const COMMANDS = ['url', 'reload', 'reboot', 'update'];
const PORTAL = fs.readFileSync(new URL('./portal.html', import.meta.url));

let devices = {};
try { devices = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify(devices, null, 1));
  }, 1000);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

const isAdmin = (req) => req.headers.authorization === 'Basic ' + Buffer.from('admin:' + PASS).toString('base64');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');

  // Планшет: телеметрия → в ответ накопившиеся команды.
  // Пока без авторизации устройств: любое новое устройство просто появляется в списке.
  if (req.method === 'POST' && url.pathname === '/api/device/poll') {
    const b = await readBody(req);
    if (!b.id) return send(res, 400, { error: 'id required' });
    const d = (devices[b.id] ??= { id: b.id, firstSeen: Date.now(), queue: [] });
    d.telemetry = b.telemetry || {};
    d.lastSeen = Date.now();
    d.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const commands = d.queue.splice(0);
    save();
    return send(res, 200, { commands });
  }

  if (!isAdmin(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="JET MEDIA"' });
    return res.end();
  }
  if (url.pathname === '/') return send(res, 200, PORTAL, 'text/html; charset=utf-8');
  if (url.pathname === '/api/devices') {
    const now = Date.now();
    return send(res, 200, Object.values(devices).map(({ queue, ...d }) =>
      ({ ...d, online: now - d.lastSeen < ONLINE_MS, pending: queue.length })));
  }

  const m = url.pathname.match(/^\/api\/devices\/([^/]+)(\/command)?$/);
  const id = m && decodeURIComponent(m[1]);
  if (id && devices[id]) {
    if (req.method === 'DELETE' && !m[2]) { delete devices[id]; save(); return send(res, 200, {}); }
    if (req.method === 'POST' && m[2]) {
      const cmd = await readBody(req);
      if (!COMMANDS.includes(cmd.type)) return send(res, 400, { error: 'unknown command' });
      devices[id].queue.push(cmd);
      save();
      return send(res, 200, {});
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`JET MEDIA server on :${PORT}`));
