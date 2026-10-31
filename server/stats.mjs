// Статистика: журнал событий по месяцам (DATA_DIR/events/ГГГГ-ММ.jsonl) и расчёт отчётов.
// Частые события (показы акций, рекламы и персонажа, связь планшетов) — дневными счётчиками в db.stats.
// Время — тайское (UTC+7): по нему считаются дни, часы и дни недели.
import fs from 'node:fs';
import path from 'node:path';

export const TZ_MS = 7 * 3600e3;
export const thDay = (ts = Date.now()) => new Date(ts + TZ_MS).toISOString().slice(0, 10);
const thMonth = (ts) => new Date(ts + TZ_MS).toISOString().slice(0, 7);

export function eventLog(dir) {
  return {
    add(e) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${thMonth(e.t)}.jsonl`), `${JSON.stringify(e)}\n`);
    },
    // События за период [from, to) по ресторанам rids (null — все)
    read(from, to, rids) {
      const out = [];
      const months = new Set([thMonth(to - 1)]);
      for (let t = from; t < to; t += 20 * 864e5) months.add(thMonth(t));
      for (const m of months) {
        let text = '';
        try { text = fs.readFileSync(path.join(dir, `${m}.jsonl`), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.t >= from && e.t < to && (!rids || rids.has(e.r))) out.push(e);
          } catch { /* битая строка — пропускаем */ }
        }
      }
      return out.sort((a, b) => a.t - b.t);
    },
  };
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};
const p90 = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
};
const hourOf = (t) => new Date(t + TZ_MS).getUTCHours();
const weekdayOf = (t) => (new Date(t + TZ_MS).getUTCDay() + 6) % 7; // 0 — понедельник
const daysIn = (from, to) => {
  const out = [];
  for (let t = from; t < to; t += 864e5) out.push(thDay(t));
  return [...new Set(out)];
};
const sumCounter = (stats, prefix, days) => days.reduce((s, d) => s + (stats[`${prefix}|${d}`] || 0), 0);

// Сводка: заказы, выручка через планшет, вызовы, «открытия» столов и доля открытий с заказом
function summary(ev) {
  const orders = ev.filter((e) => e.k === 'order');
  const revenue = orders.reduce((s, e) => s + (e.total || 0), 0);
  const opens = ev.filter((e) => e.k === 'open');
  const byTable = {};
  for (const e of ev) if (['open', 'order', 'close'].includes(e.k)) (byTable[`${e.r}|${e.table}`] ??= []).push(e);
  let withOrder = 0;
  for (const list of Object.values(byTable)) {
    let open = null;
    for (const e of list) {
      if (e.k === 'open') open = { got: false };
      else if (e.k === 'order' && open && !open.got) { open.got = true; withOrder++; }
      else if (e.k === 'close') open = null;
    }
  }
  return {
    orders: orders.length, revenue, avg: orders.length ? Math.round(revenue / orders.length) : 0,
    calls: ev.filter((e) => e.k === 'call' && e.type === 'waiter').length,
    bills: ev.filter((e) => e.k === 'call' && e.type === 'bill').length,
    opens: opens.length, opensWithOrder: withOrder,
    conversion: opens.length ? Math.round((withOrder / opens.length) * 100) : null,
  };
}

function reaction(ev) {
  const callMs = ev.filter((e) => e.k === 'call_ack').map((e) => e.ms);
  const orderMs = ev.filter((e) => e.k === 'order_ack').map((e) => e.ms);
  const acked = new Set(ev.filter((e) => e.k === 'call_ack').map((e) => e.id));
  return {
    callMed: median(callMs), callP90: p90(callMs), orderMed: median(orderMs), orderP90: p90(orderMs),
    reminders: ev.filter((e) => e.k === 'remind').length,
    unanswered: ev.filter((e) => e.k === 'call' && !acked.has(e.id)).length,
  };
}

// Персонал: реакция, заказы, счета; часы — по кнопке «На смене» и по первому и последнему действию за день
const ACTIONS = ['call_ack', 'call_done', 'order_ack', 'order_edit', 'order_reject', 'paid', 'close'];
function staffStats(ev, staffNames, to) {
  const st = {};
  const get = (id, name) => (st[id] ??= { id, name: staffNames[id] || name || '—', calls: 0, callMs: [], orders: 0, ordersSum: 0, paid: 0, paidSum: 0, shiftMs: 0, act: {} });
  const shiftOn = {};
  for (const e of ev) {
    if (!e.by) continue;
    const s = get(e.by, e.bn);
    if (e.k === 'call_ack') { s.calls++; s.callMs.push(e.ms); }
    if (e.k === 'order_ack') { s.orders++; s.ordersSum += e.total || 0; }
    if (e.k === 'paid') { s.paid++; s.paidSum += e.total || 0; }
    if (e.k === 'shift') {
      if (e.on) shiftOn[e.by] ??= e.t;
      else if (shiftOn[e.by] != null) { s.shiftMs += Math.min(e.t - shiftOn[e.by], 14 * 3600e3); delete shiftOn[e.by]; }
    }
    if (ACTIONS.includes(e.k)) {
      const d = thDay(e.t);
      const a = (s.act[d] ??= [e.t, e.t]);
      a[1] = e.t;
    }
  }
  // Смена не закрыта кнопкой — считаем до последнего действия (или конца периода), но не больше 14 часов
  for (const [id, start] of Object.entries(shiftOn)) {
    const s = st[id], last = Math.max(start, ...Object.values(s.act).map((x) => x[1]));
    s.shiftMs += Math.min(Math.max(last, Math.min(to, Date.now())) - start, 14 * 3600e3);
  }
  return Object.values(st).map((s) => ({
    id: s.id, name: s.name, calls: s.calls, callMed: median(s.callMs), orders: s.orders, ordersSum: s.ordersSum,
    paid: s.paid, paidSum: s.paidSum, shiftH: +(s.shiftMs / 3600e3).toFixed(1),
    activeH: +(Object.values(s.act).reduce((x, [a, b]) => x + (b - a), 0) / 3600e3).toFixed(1),
    days: Object.keys(s.act).length,
  })).sort((a, b) => b.calls + b.orders - (a.calls + a.orders));
}

function tableStats(ev) {
  const t = {};
  const get = (e) => (t[`${e.r}|${e.table}`] ??= { table: e.table, opens: 0, orders: 0, revenue: 0, calls: 0, callMs: [] });
  for (const e of ev) {
    if (!e.table) continue;
    if (e.k === 'open') get(e).opens++;
    if (e.k === 'order') { const x = get(e); x.orders++; x.revenue += e.total || 0; }
    if (e.k === 'call') get(e).calls++;
    if (e.k === 'call_ack') get(e).callMs.push(e.ms);
  }
  return Object.values(t).map((x) => ({
    table: x.table, opens: x.opens, orders: x.orders, revenue: x.revenue, avg: x.orders ? Math.round(x.revenue / x.orders) : 0,
    calls: x.calls, callMed: median(x.callMs),
  })).sort((a, b) => String(a.table).localeCompare(String(b.table), 'ru', { numeric: true }));
}

function dishStats(ev, r) {
  const menu = new Map((r?.menu || []).map((i) => [i.id, i]));
  const name = (id) => { const m = menu.get(id); return m ? m.name.ru || m.name.en || Object.values(m.name)[0] : id; };
  const d = {};
  let dayDish = 0, promo = 0;
  for (const e of ev) {
    if (e.k !== 'order') continue;
    for (const [id, qty, price] of e.items || []) {
      const x = (d[id] ??= { id, name: name(id), qty: 0, revenue: 0 });
      x.qty += qty; x.revenue += qty * price;
      if (menu.get(id)?.dayDish) dayDish += qty;
      if (String(id).startsWith('promo-')) promo += qty;
    }
  }
  const list = Object.values(d);
  const idle = [...menu.values()].filter((i) => !i.hidden && !d[i.id]).map((i) => ({ id: i.id, name: name(i.id) }));
  return {
    top: [...list].sort((a, b) => b.qty - a.qty).slice(0, 20),
    topRevenue: [...list].sort((a, b) => b.revenue - a.revenue).slice(0, 20),
    idle: idle.slice(0, 50), idleCount: idle.length, dayDishQty: dayDish, promoQty: promo,
  };
}

function avatarStats(ev, stats, rids, days) {
  const recDish = {};
  for (const e of ev) if (e.k === 'av_rec' || e.k === 'av_add') recDish[`${e.r}|${e.table}|${e.dish}`] = e.t;
  let ordered = 0;
  for (const e of ev) {
    if (e.k !== 'order') continue;
    // Рекомендованное блюдо заказано за этим столом в течение часа
    for (const [id] of e.items || []) {
      const t = recDish[`${e.r}|${e.table}|${id}`];
      if (t && e.t - t < 3600e3 && e.t >= t) { ordered++; delete recDish[`${e.r}|${e.table}|${id}`]; }
    }
  }
  const n = (k) => ev.filter((e) => e.k === k).length;
  return {
    shows: [...rids].reduce((s, rid) => s + sumCounter(stats, `avshow|${rid}`, days), 0),
    talks: n('av_talk'), recs: n('av_rec'), dishOpens: n('av_dish'), adds: n('av_add'), ordered,
  };
}

function timeStats(ev) {
  const hours = { orders: Array(24).fill(0), calls: Array(24).fill(0) };
  const weekdays = { orders: Array(7).fill(0), calls: Array(7).fill(0) };
  const langs = {};
  for (const e of ev) {
    const kind = e.k === 'order' ? 'orders' : e.k === 'call' ? 'calls' : null;
    if (!kind) continue;
    hours[kind][hourOf(e.t)]++;
    weekdays[kind][weekdayOf(e.t)]++;
    if (e.lang) langs[e.lang] = (langs[e.lang] || 0) + 1;
  }
  return { hours, weekdays, langs };
}

function promoStats(ev, r, stats, days) {
  return (r?.promos || []).map((p) => {
    const orders = ev.filter((e) => e.k === 'order').reduce((acc, e) => {
      for (const [id, qty, price] of e.items || []) if (id === `promo-${p.id}`) { acc.qty += qty; acc.revenue += qty * price; }
      return acc;
    }, { qty: 0, revenue: 0 });
    return {
      id: p.id, name: p.name || '—', active: p.active, image: p.image,
      imps: sumCounter(stats, `imp|${p.id}|${r.id}`, days), scans: sumCounter(stats, `scan|${p.id}|${r.id}`, days), ...orders,
    };
  });
}

// Отчёт ресторана (ЛК менеджера и портал при выборе одного ресторана)
export function restaurantReport({ log, db, r, from, to, staffNames }) {
  const rids = new Set([r.id]);
  const days = daysIn(from, to);
  const ev = log.read(from, to, rids);
  const prev = log.read(from - (to - from), from, rids);
  return {
    from, to, summary: summary(ev), prev: summary(prev), reaction: reaction(ev),
    staff: staffStats(ev, staffNames, to), tables: tableStats(ev), dishes: dishStats(ev, r),
    promos: promoStats(ev, r, db.stats, days), avatar: avatarStats(ev, db.stats, rids, days), ...timeStats(ev),
  };
}

// Сеть (портал): по ресторанам, реклама, устройства, расход голоса ElevenLabs
export function networkReport({ log, db, rids, from, to }) {
  const days = daysIn(from, to);
  const ev = log.read(from, to, rids);
  const prev = log.read(from - (to - from), from, rids);
  const rests = [...rids].map((id) => db.restaurants[id]).filter(Boolean);
  const network = rests.map((r) => {
    const mine = ev.filter((e) => e.r === r.id);
    const devices = Object.values(db.devices).filter((d) => d.restaurantId === r.id).length;
    const polls = sumCounter(db.stats, `up|${r.id}`, days);
    return {
      id: r.id, name: r.name, ...summary(mine), callMed: reaction(mine).callMed, devices,
      // Часов на связи в среднем на одно устройство в день (опрос раз в 15 секунд)
      uptimeH: devices ? +((polls * 15) / 3600 / devices / days.length).toFixed(1) : null,
      offline: mine.filter((e) => e.k === 'dev_offline').length, crashes: mine.filter((e) => e.k === 'dev_crash').length,
    };
  }).sort((a, b) => b.revenue - a.revenue);
  const ads = db.ads.map((a) => {
    const byRest = rests.map((r) => ({
      id: r.id, name: r.name, imps: sumCounter(db.stats, `${a.id}|${r.id}`, days), scans: sumCounter(db.stats, `scan|${a.id}|${r.id}`, days),
    })).filter((x) => x.imps || x.scans);
    const imps = byRest.reduce((s, x) => s + x.imps, 0), scans = byRest.reduce((s, x) => s + x.scans, 0);
    const daily = days.map((d) => ({ day: d, imps: rests.reduce((s, r) => s + (db.stats[`${a.id}|${r.id}|${d}`] || 0), 0) }));
    return { id: a.id, advertiser: a.advertiser, title: a.title, image: a.image, active: a.active, imps, scans, ctr: imps ? +((scans / imps) * 100).toFixed(2) : null, byRest, daily };
  }).sort((a, b) => b.imps - a.imps);
  return {
    from, to, summary: summary(ev), prev: summary(prev), reaction: reaction(ev), network, ads,
    avatar: avatarStats(ev, db.stats, rids, days), ...timeStats(ev),
    tts: { chars: ev.filter((e) => e.k === 'tts').reduce((s, e) => s + (e.chars || 0), 0) },
  };
}
