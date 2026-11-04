// Показатели сервера для раздела «Сервер» в портале: процессор, память и диск всего сервера (VPS),
// свой процесс (рабочая или тестовая версия): процессор, память, отклик, запросы в минуту, размер данных
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const cur = { hostCpu: 0, procCpu: 0, lagMs: 0, lagMax: 0 };
let prevHost = null, prevProc = { cpu: process.cpuUsage(), t: process.hrtime.bigint() };
// запросы: 12 отрезков по 5 секунд = последняя минута
const reqs = new Array(12).fill(0);
let slot = 0;
export const countRequest = () => { reqs[slot]++; };

// /proc/stat в контейнере — общий для всего сервера: доля времени, когда процессоры были заняты
function hostCpuTimes() {
  try {
    const v = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
  } catch { return null; }
}
function sample() {
  const h = hostCpuTimes();
  if (h && prevHost && h.total > prevHost.total) cur.hostCpu = 100 * (1 - (h.idle - prevHost.idle) / (h.total - prevHost.total));
  else if (!h) cur.hostCpu = Math.min(100, (100 * os.loadavg()[0]) / os.cpus().length);
  prevHost = h;
  const c = process.cpuUsage(), t = process.hrtime.bigint();
  const us = c.user - prevProc.cpu.user + (c.system - prevProc.cpu.system), dt = Number(t - prevProc.t) / 1000;
  cur.procCpu = dt > 0 ? (100 * us) / dt : 0; // % одного ядра
  prevProc = { cpu: c, t };
  // таймер замера срабатывает раз в 20 мс: задержка сверх этого — сколько сервер был занят и не отвечал
  cur.lagMs = Math.max(0, lag.mean / 1e6 - 20) || 0;
  cur.lagMax = Math.max(0, lag.max / 1e6 - 20) || 0;
  lag.reset();
  slot = (slot + 1) % reqs.length;
  reqs[slot] = 0;
}
sample();
setInterval(sample, 5000).unref();

const readNum = (f) => {
  try { const v = fs.readFileSync(f, 'utf8').trim(); return /^\d+$/.test(v) ? Number(v) : null; } catch { return null; }
};
// Ограничения контейнера (у тестовой: полпроцессора и 384 МБ)
function limits() {
  let mem = readNum('/sys/fs/cgroup/memory.max') ?? readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (mem && mem > 1e15) mem = null; // «без ограничения»
  let cpus = null;
  try {
    const [q, p] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (q !== 'max') cpus = Number(q) / Number(p);
  } catch { /* нет ограничения */ }
  return { memLimit: mem, cpus };
}

function walk(dir, onFile) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, onFile);
    else { try { onFile(e.name, fs.statSync(p).size, p); } catch { /* файл удалили */ } }
  }
}
// Размер данных: база, картинки, голос, журнал событий (раз в минуту — обход папки)
let dataCache = { at: 0, v: null };
function dataStats(dir) {
  if (Date.now() - dataCache.at < 60_000 && dataCache.v) return dataCache.v;
  const v = { total: 0, db: 0, images: 0, imagesN: 0, voice: 0, voiceN: 0, events: 0, other: 0 };
  const up = path.join(dir, 'uploads'), ev = path.join(dir, 'events');
  walk(dir, (name, size, p) => {
    v.total += size;
    if (p.startsWith(up + path.sep)) {
      if (/\.(mp3|ogg|wav)$/.test(name)) { v.voice += size; v.voiceN++; } else { v.images += size; v.imagesN++; }
    } else if (p.startsWith(ev + path.sep)) v.events += size;
    else if (/^db\.json/.test(name)) v.db += size;
    else v.other += size;
  });
  dataCache = { at: Date.now(), v };
  return v;
}

export function selfStats(dir) {
  const l = limits();
  return {
    uptime: process.uptime(), cpu: cur.procCpu, cpus: l.cpus, rss: process.memoryUsage().rss, memLimit: l.memLimit,
    lagMs: cur.lagMs, lagMax: cur.lagMax, rpm: reqs.reduce((a, b) => a + b, 0), data: dataStats(dir),
  };
}

export function hostStats(dir) {
  let disk = null;
  try {
    const s = fs.statfsSync(dir);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch { /* старый Node */ }
  let mem = { total: os.totalmem(), avail: os.freemem() };
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number((m.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]) * 1024;
    if (kb('MemTotal')) mem = { total: kb('MemTotal'), avail: kb('MemAvailable') || kb('MemFree') };
  } catch { /* не Linux */ }
  return { cpu: cur.hostCpu, cores: os.cpus().length, load: os.loadavg(), mem, disk, uptime: os.uptime(), node: process.version };
}
