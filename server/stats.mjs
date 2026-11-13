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
  const cancelled = new Set(ev.filter((e) => e.k === 'call_cancel').map((e) => e.id));
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
    phoneOrders: orders.filter((e) => e.phone).length,
    calls: ev.filter((e) => e.k === 'call' && e.type === 'waiter' && !cancelled.has(e.id)).length,
    bills: ev.filter((e) => e.k === 'call' && e.type === 'bill' && !cancelled.has(e.id)).length,
    opens: opens.length, opensWithOrder: withOrder,
    conversion: opens.length ? Math.round((withOrder / opens.length) * 100) : null,
  };
}

// Заказ в статистике — каким он стал в итоге: правки официанта меняют сумму и блюда; отменённый или отклонённый
// заказ не считается (в журнале визитов остаётся как «order_void»). Исходный вид — в _items/_total для журнала
function finalOrders(ev0) {
  // «↩ Отменить» официанта: события отменённого действия не считаются
  const undone = new Set(ev0.filter((e) => e.k === 'undo').flatMap((e) => (e.acts || []).map((x) => `${x.k}|${x.id}|${x.t}`)));
  const ev = undone.size ? ev0.filter((e) => !undone.has(`${e.k}|${e.id}|${e.t}`)) : ev0;
  const last = {}, voided = new Set();
  for (const e of ev) {
    if (e.k === 'order_edit' && e.id && e.items) last[e.id] = e;
    else if ((e.k === 'order_cancel' || e.k === 'order_reject') && e.id) voided.add(e.id);
  }
  return ev.map((e) => {
    if (e.k !== 'order' || (!voided.has(e.id) && !last[e.id])) return e;
    const x = { ...e, _items: e.items, _total: e.total };
    if (voided.has(e.id)) x.k = 'order_void';
    else Object.assign(x, { total: last[e.id].total ?? e.total, items: last[e.id].items });
    return x;
  });
}
// Первое событие каждого заказа: время «готово»/«подано» считаем по первой подаче (дозаказ и «переделать» — отдельно)
const firstById = (list) => [...list.reduce((m, e) => (m.has(e.id) ? m : m.set(e.id, e)), new Map()).values()];

function reaction(ev) {
  const callMs = ev.filter((e) => e.k === 'call_ack').map((e) => e.ms);
  const orderMs = ev.filter((e) => e.k === 'order_ack').map((e) => e.ms);
  const kitchenMs = ev.filter((e) => e.k === 'order_kitchen').map((e) => e.ms);
  const readyMs = firstById(ev.filter((e) => e.k === 'order_ready')).map((e) => e.ms);
  // от подтверждения до «Подано» — по первой подаче заказа
  const served = firstById(ev.filter((e) => e.k === 'order_served'));
  const servedMs = served.map((e) => e.ms);
  // отменённый гостем вызов — не «без ответа»
  const acked = new Set(ev.filter((e) => e.k === 'call_ack' || e.k === 'call_cancel').map((e) => e.id));
  return {
    callMed: median(callMs), callP90: p90(callMs), orderMed: median(orderMs), orderP90: p90(orderMs),
    kitchenMed: median(kitchenMs), readyMed: median(readyMs), servedMed: median(servedMs), servedP90: p90(servedMs),
    servedNoKitchen: served.filter((e) => e.noKitchen).length,
    redo: ev.filter((e) => e.k === 'order_redo').length,
    cancelled: ev.filter((e) => e.k === 'order_cancel').length,
    cancelledSum: ev.filter((e) => e.k === 'order_cancel').reduce((s, e) => s + (e.total || 0), 0),
    reminders: ev.filter((e) => e.k === 'remind').length,
    unanswered: ev.filter((e) => e.k === 'call' && !acked.has(e.id)).length,
  };
}

// Персонал: реакция, заказы, счета; часы — по кнопке «На смене» и по первому и последнему действию за день
const ACTIONS = ['order', 'call_ack', 'call_done', 'order_ack', 'order_edit', 'order_reject', 'order_kitchen', 'order_served', 'order_redo', 'order_cancel', 'paid', 'close'];
function staffStats(ev, staffNames, to) {
  const st = {};
  const get = (id, name) => (st[id] ??= { id, name: staffNames[id] || name || '—', calls: 0, callMs: [], orders: 0, ordersSum: 0, paid: 0, paidSum: 0, shiftMs: 0, act: {} });
  const shiftOn = {};
  for (const e of ev) {
    if (!e.by) continue;
    const s = get(e.by, e.bn);
    if (e.k === 'call_ack') { s.calls++; s.callMs.push(e.ms); }
    if (e.k === 'order_ack' || e.k === 'order') { s.orders++; s.ordersSum += e.total || 0; } // подтвердил или сам открыл
    if (e.k === 'paid') { s.paid++; s.paidSum += e.total || 0; }
    if (e.k === 'shift') {
      // когда за период впервые встал на смену и когда последний раз закончил её
      if (e.on) { shiftOn[e.by] ??= e.t; s.shiftFrom ??= e.t; }
      else { s.shiftTo = e.t; if (shiftOn[e.by] != null) { s.shiftMs += Math.min(e.t - shiftOn[e.by], 14 * 3600e3); delete shiftOn[e.by]; } }
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
    s.shiftOpen = true; // ещё на смене (или смену не закрыли кнопкой)
  }
  return Object.values(st).map((s) => ({
    id: s.id, name: s.name, calls: s.calls, callMed: median(s.callMs), orders: s.orders, ordersSum: s.ordersSum,
    paid: s.paid, paidSum: s.paidSum, shiftH: +(s.shiftMs / 3600e3).toFixed(1),
    activeH: +(Object.values(s.act).reduce((x, [a, b]) => x + (b - a), 0) / 3600e3).toFixed(1),
    // первое и последнее действие за период; смена — с первого «На смене» до последнего конца смены
    firstAct: Object.values(s.act).length ? Math.min(...Object.values(s.act).map((x) => x[0])) : null,
    lastAct: Object.values(s.act).length ? Math.max(...Object.values(s.act).map((x) => x[1])) : null,
    shiftFrom: s.shiftFrom ?? null, shiftTo: s.shiftOpen ? null : s.shiftTo ?? null, shiftOpen: !!s.shiftOpen,
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

const dishName = (r, all = false) => {
  const menu = new Map((r?.menu || []).map((i) => [i.id, i]));
  return (id) => { const m = menu.get(id); return !m ? id : all ? m.name : m.name.ru || m.name.en || Object.values(m.name)[0]; };
};
// Журнал визита: заказы и всё, что с ними делали (кто, когда, что добавили/убрали, переделка, отмена с причиной)
const LOG_KINDS = new Set(['order', 'order_void', 'order_ack', 'order_edit', 'order_kitchen', 'order_ready', 'order_served', 'order_redo',
  'order_cancel', 'order_reject', 'order_remove', 'paid', 'close', 'undo', 'call', 'call_ack', 'call_done', 'call_cancel', 'call_why', 'remind', 'forgotten']);
// Выбранное в группах меню по «блюдо|выбор» — названия вариантов акций («Наполеон») и цена
const modsOf = (r) => new Map((r?.menu || []).flatMap((i) => (i.groups || []).flatMap((g) => (g.opts || []).map((o) => [`${i.id}|${o.id}`, o]))));
// «Акция 1: Десерт» + выбранный вариант → «Акция 1: Десерт · Наполеон» (на всех языках названия)
const withMods = (n, id, ms, mods) => {
  const os = (ms || []).map((m) => mods?.get(`${id}|${m}`)).filter(Boolean);
  if (!os.length) return n;
  const nm = (o, l) => o.name?.[l] || o.name?.ru || o.name?.en || Object.values(o.name || {})[0] || '';
  if (typeof n === 'string') return `${n} · ${os.map((o) => nm(o, 'ru')).join(', ')}`;
  return Object.fromEntries(Object.entries(n || {}).map(([l, v]) => [l, `${v} · ${os.map((o) => nm(o, l)).join(', ')}`]));
};
function visitLog(events, name, mods) {
  const lines = (list) => (list || []).map(([id, qty, , ms]) => [withMods(name(id), id, String(id).startsWith('promo-') ? ms : null, mods), qty]);
  const out = [];
  for (const e of events) {
    if (!LOG_KINDS.has(e.k) || out.length >= 150) continue;
    // напоминания подряд — одной строкой «напоминание ×3»
    const prev = out[out.length - 1];
    if (e.k === 'remind' && prev?.k === 'remind' && prev.kind === e.kind) { prev.n++; continue; }
    const x = { t: e.t, k: e.k };
    out.push(x);
    if (e.k === 'remind') { Object.assign(x, { kind: e.kind, n: 1 }); continue; }
    if (e.k === 'forgotten') { x.kind = e.kind; if (e.type) x.type = e.type; continue; }
    if (e.k.startsWith('call')) { if (e.type) x.type = e.type; if (e.guest) x.g = e.guest; if (e.ms != null && e.k !== 'call_done') x.ms = e.ms; if (e.why) x.why = e.why; }
    if (e.id) x.id = String(e.id).slice(-4);
    if (e.bn) x.bn = e.bn;
    if (e.k === 'order' || e.k === 'order_void') Object.assign(x, { items: lines(e._items || e.items), total: e._total ?? e.total, src: e.src || (e.phone ? 'phone' : 'tablet'), g: e.guest });
    if (e.k === 'order_redo') x.items = e.items;
    if (e.add?.length) x.add = e.add;
    if (e.del?.length) x.del = e.del;
    if (e.note) x.note = e.note;
    if (e.k === 'order_edit' || e.k === 'order_cancel' || e.k === 'paid') x.total = e.total;
    if (e.noKitchen) x.noKitchen = 1;
    if (e.k === 'undo') x.of = e.of;
  }
  return out;
}

// С какого времени планшет спрашивает причину отмены вызова: раньше причина — «не спрашивали (до обновления)»,
// позже и гость ничего не выбрал — «не выбрана». Задаёт сервер при запуске
let WHY_SINCE = 0;
export const setWhySince = (t) => { WHY_SINCE = Number(t) || 0; };
// Вызовы визита: сколько вызовов официанта и просьб счёта, через сколько обычно отвечали; «не дождался» — никто не нажал
// «Иду», и гость отменил сам через минуту и больше, или вызов сняли по времени без ответа (отмена быстрее — нажал по ошибке)
function callsOf(events) {
  const calls = new Map();
  for (const e of events) {
    if (e.k === 'call' && e.id) calls.set(e.id, { type: e.type === 'bill' ? 'bill' : 'waiter', t: e.t, g: e.guest || 1 });
    else if (e.k === 'call_ack' && calls.has(e.id)) Object.assign(calls.get(e.id), { ack: e.ms ?? 0, by: e.bn || '' });
    else if (e.k === 'call_cancel' && calls.has(e.id) && calls.get(e.id).ack == null) calls.get(e.id).cancel = e.ms ?? 0;
    else if (e.k === 'call_why' && calls.has(e.id)) calls.get(e.id).why = e.why;
  }
  const list = [...calls.values()];
  // причина отмены от гостя (планшет спрашивает): «не дождались» — ошибка всегда; «официант подошёл» — официант не нажал
  // «Иду» (отдельно, жёлтым); «не нужно», «случайно» — не ошибка; причины нет — ждал минуту и больше без реакции — ошибка
  const missed = [], came = [];
  for (const c of list) {
    if (c.ack != null || c.cancel == null) continue;
    const reminds = events.filter((e) => e.k === 'remind' && e.kind === c.type && e.t >= c.t && e.t <= c.t + c.cancel).length;
    if (c.why === 'came') { came.push({ t: c.t, type: c.type, wait: c.cancel }); continue; }
    if (c.why === 'notneeded' || c.why === 'mistake' || (c.why !== 'waited' && c.cancel < 60e3)) continue;
    missed.push({ t: c.t, type: c.type, wait: c.cancel, reminds, how: 'cancel', why: c.why || (c.t < WHY_SINCE ? 'old' : 'none') });
  }
  // снят по времени без ответа (старые записи — без номера вызова: по столу и времени)
  for (const e of events.filter((x) => x.k === 'forgotten' && x.kind === 'call')) {
    const c = e.id ? calls.get(e.id) : list.filter((x) => x.ack == null && x.t <= e.t).pop();
    if (c && missed.some((m) => m.t === c.t)) continue;
    const t0 = c?.t ?? e.t;
    missed.push({ t: t0, type: c?.type || e.type || 'waiter', wait: e.t - t0, reminds: events.filter((x) => x.k === 'remind' && x.t >= t0 && x.t <= e.t).length, how: 'expired' });
  }
  const acks = list.filter((c) => c.ack != null).map((c) => c.ack);
  return { w: list.filter((c) => c.type === 'waiter').length, b: list.filter((c) => c.type === 'bill').length, ack: acks.length ? median(acks) : null,
    missed: missed.sort((a, b) => a.t - b.t), came };
}

function dishStats(ev, r) {
  const menu = new Map((r?.menu || []).map((i) => [i.id, i])), name = dishName(r);
  const d = {};
  let dayDish = 0, promo = 0;
  // какие варианты акций берут: «Акция 1: Десерт · Наполеон — 5 порций»
  const mods = modsOf(r), pv = {};
  for (const e of ev) {
    if (e.k !== 'order') continue;
    for (const [id, qty, price, ms] of e.items || []) {
      const x = (d[id] ??= { id, name: name(id), qty: 0, revenue: 0 });
      x.qty += qty; x.revenue += qty * price;
      if (menu.get(id)?.dayDish) dayDish += qty;
      if (!String(id).startsWith('promo-')) continue;
      promo += qty;
      for (const m of ms || []) {
        const o = mods.get(`${id}|${m}`);
        if (!o) continue;
        const y = (pv[`${id}|${m}`] ??= { id, name: withMods(name(id), id, [m], mods), qty: 0, revenue: 0 });
        y.qty += qty; y.revenue += qty * (Number(o.price) || 0);
      }
    }
  }
  const list = Object.values(d);
  const idle = [...menu.values()].filter((i) => !i.hidden && !d[i.id]).map((i) => ({ id: i.id, name: name(i.id) }));
  return {
    top: [...list].sort((a, b) => b.qty - a.qty).slice(0, 20),
    topRevenue: [...list].sort((a, b) => b.revenue - a.revenue).slice(0, 20),
    idle: idle.slice(0, 50), idleCount: idle.length, dayDishQty: dayDish, promoQty: promo,
    promoVariants: Object.values(pv).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue),
  };
}

// Подсказки к заказу («всплывашки»): по правилу — сколько раз показали (А — после «Добавить», Б — в корзине,
// В — перед отправкой), сколько блюд добавили из подсказки, отказов и выручка добавленного
function upsellStats(ev, r) {
  const names = new Map((r?.upsell?.rules || []).map((x) => [x.id, x.name || x.id])), by = {};
  for (const e of ev) {
    if (!['up_show', 'up_add', 'up_no'].includes(e.k) || !e.rule) continue;
    const x = (by[e.rule] ??= { name: names.get(e.rule) || e.rule, shown: 0, added: 0, no: 0, revenue: 0 });
    if (e.k === 'up_show') x.shown++;
    else if (e.k === 'up_no') x.no++;
    else { x.added++; x.revenue += e.price || 0; }
  }
  return Object.values(by).map((x) => ({ ...x, conv: x.shown ? Math.round((100 * x.added) / x.shown) : 0 })).sort((a, b) => b.revenue - a.revenue || b.added - a.added);
}

function avatarStats(ev, stats, rids, daysOf) {
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
    shows: [...rids].reduce((s, rid) => s + sumCounter(stats, `avshow|${rid}`, daysOf(rid)), 0),
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

// ---------- Тестовые данные (данные не удаляются — только не попадают в отчёты)
// Тестовое: всё раньше r.testBefore; действия тестовых сотрудников (галочка в «Персонале», в т. ч. уволенных
// с «убрать статистику»); заказы и визиты, помеченные «тест». Визит стола (от «стол открыт» до «закрыть стол»),
// где есть тестовое, выпадает целиком: заказы, вызовы, реакции, действия гостя.
// dayFrom — начало рабочего дня ресторана (минуты от полуночи по Пхукету; нет часов — 6:00): визит не переходит через него
export function testCtx(r, dayFrom) {
  const staff = [...(r.staff || []), ...(r.staffArchive || [])].filter((m) => m.test);
  return { ids: new Set(staff.map((m) => m.id)), names: new Set(staff.map((m) => m.name)), marks: new Set(r.testIds || []), before: r.testBefore || 0,
    removed: new Set(r.removedIds || []), // заказы, удалённые менеджером как дубль
    by: r.testBy || {}, dayFrom: Number.isFinite(dayFrom) ? dayFrom : 360 }; // кто и когда пометил «Тест»
}
const isTestStaff = (c, e) => !!e.by && (c.ids.has(e.by) || (e.by.startsWith('name:') && c.names.has(e.by.slice(5))));

// Визиты столов и почему визит тестовый: 'before' — прошлые данные, 'staff' — тестовый сотрудник, 'mark' — помечен весь;
// part — помечена часть (новые заказы, пришедшие в визит после пометки, — настоящие).
// Визит заканчивается «Закрыть стол», а если стол забыли закрыть — после 3 часов без действий или с началом нового рабочего дня
// (split: false — как было раньше, только «Закрыть стол»: для однократного пересчёта старых пометок)
const VISIT_GAP_MS = 3 * 3600e3;
const workDay = (c, t) => Math.floor((t + 7 * 3600e3 - c.dayFrom * 60e3) / 864e5);
function visitsOf(ev, ctxs, { split = true } = {}) {
  const out = [], open = {}, byId = new Map();
  for (const e of ev) {
    const c = ctxs[e.r];
    if (!c || !e.table) continue;
    // причина отмены вызова приходит после отмены, а стол к этому времени уже мог закрыться — к визиту этого вызова
    if (e.k === 'call_why' && byId.has(e.id)) { byId.get(e.id).events.push(e); continue; }
    const key = `${e.r}|${e.table}`, v0 = open[key];
    // Стол, оставшийся открытым с прошлых (тестовых) данных: после отметки начинается новый визит
    if (e.k === 'open' || !v0 || (v0.from < c.before && e.t >= c.before)
      || (split && (e.t - v0.to > VISIT_GAP_MS || workDay(c, e.t) !== workDay(c, v0.to)))) {
      if (open[key]) out.push(open[key]);
      open[key] = { r: e.r, table: e.table, from: e.t, to: e.t, ids: [], orders: 0, total: 0, staff: new Set(), events: [], why: null };
    }
    const v = open[key];
    v.events.push(e);
    v.to = e.t;
    if (e.id && !v.ids.includes(e.id)) { v.ids.push(e.id); byId.set(e.id, v); }
    if (e.k === 'order') { v.orders++; v.total += e.total || 0; }
    if (e.bn) v.staff.add(e.bn);
    v.why ||= e.t < c.before ? 'before' : isTestStaff(c, e) ? 'staff' : null;
    if (e.k === 'close') { out.push(v); delete open[key]; }
  }
  const all = out.concat(Object.values(open));
  // «Тест» поставлен вручную: весь визит или его часть; кто и когда пометил — по последней пометке
  for (const v of all) {
    const c = ctxs[v.r], marked = v.ids.filter((id) => c.marks.has(id));
    if (!marked.length) continue;
    const by = marked.map((id) => c.by[id]).filter(Array.isArray).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
    if (by) { v.markBy = by[0]; v.markAt = by[1]; }
    if (v.why) continue;
    if (marked.length === v.ids.length) v.why = 'mark';
    else v.part = { marked: marked.length, total: v.ids.length };
  }
  return all;
}

// Однократно: раньше визит шёл до «Закрыть стол», и забытый стол склеивал вчерашнее с сегодняшним — галочка «Тест»
// на таком визите метила и настоящие заказы следующих дней. Части склеенного визита после первой, где были заказы,
// возвращаем в статистику: отдаём их номера, чтобы снять пометку
export function unmergeMarks({ log, r, from, to, dayFrom }) {
  const ctxs = { [r.id]: testCtx(r, dayFrom) };
  const ev = finalOrders(log.read(from, to, new Set([r.id])));
  const next = visitsOf(ev, ctxs), whereOf = new Map();
  next.forEach((v) => v.events.forEach((e) => whereOf.set(e, v)));
  const back = new Set();
  for (const old of visitsOf(ev, ctxs, { split: false })) {
    if (old.events.some((e) => e.t < ctxs[r.id].before || isTestStaff(ctxs[r.id], e)) || !old.ids.some((id) => ctxs[r.id].marks.has(id))) continue;
    const parts = [...new Set(old.events.map((e) => whereOf.get(e)))].sort((a, b) => a.from - b.from);
    for (const v of parts.slice(1)) if (v.events.some((e) => e.k === 'order')) v.ids.forEach((id) => back.add(id));
  }
  return [...back].filter((id) => ctxs[r.id].marks.has(id));
}

// Только «боевые» события
function realOnly(ev, ctxs) {
  const drop = new Set();
  for (const v of visitsOf(ev, ctxs)) {
    if (v.why) v.events.forEach((e) => drop.add(e));
    else if (v.part) v.events.forEach((e) => { if (e.id && ctxs[v.r].marks.has(e.id)) drop.add(e); }); // только помеченное
  }
  return ev.filter((e) => {
    const c = ctxs[e.r];
    return !drop.has(e) && (!c || (e.t >= c.before && !isTestStaff(c, e) && !(e.id && c.removed?.has(e.id))));
  });
}
// Дневные счётчики (показы акций, появления персонажа) — только после начала боевой работы
const realDays = (days, c) => (c?.before ? days.filter((d) => d > thDay(c.before)) : days);

// Ошибки процесса (стремимся к нулю): заказ гостя с планшета или телефона отменили или отклонили сотрудники;
// заказы, помеченные «Тест» вручную (не прошлые данные и не тестовый сотрудник). По каждому — когда, стол, сумма, кто
function processErrors(ev, visits, ctxs, names = {}, rests = {}, tests = false, waitersOf = null, rmap = {}) {
  // блюда заказа — коротко: название, сколько, цена (по нажатию в статистике)
  const lines = (e) => (e._items || e.items || []).map(([id, qty, price]) => [(names[e.r] || ((x) => x))(id), qty, price]);
  const why = {};
  for (const e of ev) if ((e.k === 'order_cancel' || e.k === 'order_reject') && e.id) why[e.id] = { k: e.k, bn: e.bn || '', note: e.note || '' };
  const cancelled = ev.filter((e) => e.k === 'order_void' && e.src !== 'staff')
    .map((e) => ({ t: e.t, table: e.table, total: e._total ?? e.total ?? 0, src: e.phone ? 'phone' : 'tablet', g: e.guest || 1, items: lines(e), rest: rests[e.r] || '', ...why[e.id] }));
  const marked = [];
  for (const v of visits) {
    if (v.why !== 'mark' && !v.part) continue;
    const c = ctxs[v.r];
    for (const e of v.events) {
      if ((e.k !== 'order' && e.k !== 'order_void') || !c.marks.has(e.id)) continue;
      const by = c.by[e.id] || [];
      marked.push({ t: e.t, table: e.table, total: e._total ?? e.total ?? 0, by: by[0] || '', at: by[1] || 0, src: e.src === 'staff' ? 'staff' : e.phone ? 'phone' : 'tablet',
        g: e.guest || 1, items: lines(e), rest: rests[e.r] || '' });
    }
  }
  // гость не дождался официанта (тестовые визиты — только «с тестовыми»)
  const real = visits.filter((v) => tests || !v.why);
  const missed = real.flatMap((v) => callsOf(v.events).missed.map((m) => ({ ...m, table: v.table, rest: rests[v.r] || '' })));
  // официант подошёл (по словам гостя), но не нажал «Иду»: за кем закреплён стол
  const came = real.flatMap((v) => callsOf(v.events).came.map((m) => ({ ...m, table: v.table, rest: rests[v.r] || '',
    waiters: waitersOf && rmap[v.r] ? waitersOf(rmap[v.r], v.table) : [] })));
  const pack = (l) => ({ n: l.length, sum: l.reduce((a, x) => a + (x.total || 0), 0), list: l.sort((a, b) => b.t - a.t).slice(0, 50) });
  return { cancelled: pack(cancelled), marked: pack(marked), missed: pack(missed), came: pack(came) };
}

// Отчёт ресторана (ЛК менеджера и портал при выборе одного ресторана); tests — показать вместе с тестовыми
export function restaurantReport({ log, db, r, from, to, staffNames, tests, dayFrom = () => null, waitersOf = null }) {
  const rids = new Set([r.id]);
  const ctxs = { [r.id]: testCtx(r, dayFrom(r)) };
  const raw = finalOrders(log.read(from, to, rids));
  const ev = tests ? raw : realOnly(raw, ctxs);
  const prevRaw = finalOrders(log.read(from - (to - from), from, rids));
  const prev = tests ? prevRaw : realOnly(prevRaw, ctxs);
  const days = tests ? daysIn(from, to) : realDays(daysIn(from, to), ctxs[r.id]);
  const all = visitsOf(raw, ctxs).filter((v) => v.ids.length);
  const testVisits = all.filter((v) => v.why), partVisits = all.filter((v) => v.part);
  // из частично помеченных — только помеченные заказы
  const partOrders = partVisits.flatMap((v) => v.events.filter((e) => e.k === 'order' && ctxs[r.id].marks.has(e.id)));
  return {
    name: r.name, from, to, tests: !!tests, summary: summary(ev), prev: summary(prev), reaction: reaction(ev), errors: processErrors(ev, all, ctxs, { [r.id]: dishName(r, true) }, {}, tests, waitersOf, { [r.id]: r }),
    excluded: { visits: testVisits.length + partVisits.length, orders: testVisits.reduce((s, v) => s + v.orders, 0) + partOrders.length,
      total: testVisits.reduce((s, v) => s + v.total, 0) + partOrders.reduce((s, e) => s + (e.total || 0), 0) },
    // журнал визитов: последние 300, у каждого — тестовый ли и почему
    // «Тест» для всех визитов периода разом: визиты, которые можно отметить (не прошлые данные и не тестовый сотрудник)
    markAll: (() => { const m = all.filter((v) => !v.why || v.why === 'mark'); return { n: m.length, marked: m.filter((v) => v.why).length, ids: m.flatMap((v) => v.ids) }; })(),
    // по времени начала, новые сверху (в списке визиты идут в порядке завершения — забытый стол завершается позже)
    visits: [...all].sort((a, b) => b.from - a.from).slice(0, 300).map(({ events, staff, r: rid, ...v }) => ({ ...v, staff: [...staff],
      cancelled: events.filter((e) => e.k === 'order_void').length, calls: callsOf(events), log: visitLog(events, dishName(r, true), modsOf(r)) })),
    staff: staffStats(ev, staffNames, to), tables: tableStats(ev), dishes: dishStats(ev, r), upsell: upsellStats(ev, r),
    promos: promoStats(ev, r, db.stats, days), avatar: avatarStats(ev, db.stats, rids, () => days), ...timeStats(ev),
  };
}

// Сеть (портал): по ресторанам, реклама, устройства, расход голоса ElevenLabs
export function networkReport({ log, db, rids, from, to, tests, dayFrom = () => null, waitersOf = null }) {
  const days = daysIn(from, to);
  const rests = [...rids].map((id) => db.restaurants[id]).filter(Boolean);
  const ctxs = Object.fromEntries(rests.map((r) => [r.id, testCtx(r, dayFrom(r))]));
  const raw = finalOrders(log.read(from, to, rids)), prevRaw = finalOrders(log.read(from - (to - from), from, rids));
  const ev = tests ? raw : realOnly(raw, ctxs);
  const prev = tests ? prevRaw : realOnly(prevRaw, ctxs);
  const allVisits = visitsOf(raw, ctxs), errAll = [];
  const network = rests.map((r) => {
    const er = processErrors(ev.filter((e) => e.r === r.id), allVisits.filter((v) => v.r === r.id), ctxs, { [r.id]: dishName(r, true) }, { [r.id]: r.name }, tests, waitersOf, { [r.id]: r });
    const mine = ev.filter((e) => e.r === r.id);
    errAll.push(er);
    const devices = Object.values(db.devices).filter((d) => d.restaurantId === r.id).length;
    const polls = sumCounter(db.stats, `up|${r.id}`, days);
    return {
      id: r.id, name: r.name, ...summary(mine), callMed: reaction(mine).callMed, devices,
      adScans: db.ads.reduce((s, a) => s + sumCounter(db.stats, `scan|${a.id}|${r.id}`, days), 0), leads: mine.filter((e) => e.k === 'lead').length,
      // Часов на связи в среднем на одно устройство в день (опрос раз в 15 секунд)
      uptimeH: devices ? +((polls * 15) / 3600 / devices / days.length).toFixed(1) : null,
      offline: mine.filter((e) => e.k === 'dev_offline').length, crashes: mine.filter((e) => e.k === 'dev_crash').length,
      errCancel: { n: er.cancelled.n, sum: er.cancelled.sum }, errMarked: { n: er.marked.n, sum: er.marked.sum }, errMissed: { n: er.missed.n }, errCame: { n: er.came.n },
    };
  }).sort((a, b) => b.revenue - a.revenue);
  const ads = db.ads.map((a) => {
    const byRest = rests.map((r) => ({
      id: r.id, name: r.name, imps: sumCounter(db.stats, `${a.id}|${r.id}`, days), scans: sumCounter(db.stats, `scan|${a.id}|${r.id}`, days),
    })).filter((x) => x.imps || x.scans);
    const imps = byRest.reduce((s, x) => s + x.imps, 0), scans = byRest.reduce((s, x) => s + x.scans, 0);
    for (const x of byRest) x.leads = ev.filter((e) => e.k === 'lead' && e.ad === a.id && e.r === x.id).length;
    const daily = days.map((d) => ({ day: d, imps: rests.reduce((s, r) => s + (db.stats[`${a.id}|${r.id}|${d}`] || 0), 0) }));
    return { id: a.id, advertiser: a.advertiser, title: a.title, image: a.image, active: a.active, imps, scans, ctr: imps ? +((scans / imps) * 100).toFixed(2) : null,
      leads: ev.filter((e) => e.k === 'lead' && e.ad === a.id).length, byRest, daily };
  }).sort((a, b) => b.imps - a.imps);
  // Устройства: где стоят, часы на связи, заказы и выручка с планшета, вызовы, разговоры с персонажем,
  // показы и сканы рекламы, заявки. Старые события без устройства относим к планшету, который сейчас стоит за этим столом
  const tableDev = {};
  for (const d of Object.values(db.devices)) if (rids.has(d.restaurantId) && d.table && d.role !== 'entrance') tableDev[`${d.restaurantId}|${d.table}`] = d.id;
  const per = {};
  for (const e of ev) {
    const id = e.dev || (e.table && tableDev[`${e.r}|${e.table}`]);
    if (!id || e.src === 'staff') continue;
    const x = (per[id] ??= { orders: 0, revenue: 0, calls: 0, talks: 0, leads: 0 });
    if (e.k === 'order') { x.orders++; x.revenue += e.total || 0; }
    if (e.k === 'call') x.calls++;
    if (e.k === 'av_talk') x.talks++;
    if (e.k === 'lead') x.leads++;
  }
  const devices = Object.values(db.devices).filter((d) => rids.has(d.restaurantId)).map((d) => ({
    id: d.id, rest: db.restaurants[d.restaurantId]?.name || '', place: d.role === 'entrance' ? 'вход' : d.table || '—',
    online: Date.now() - (d.lastSeen || 0) < 45000, hours: +((sumCounter(db.stats, `dup|${d.id}`, days) * 15) / 3600).toFixed(1),
    orders: 0, revenue: 0, calls: 0, talks: 0, leads: 0, ...per[d.id],
    adImps: sumCounter(db.stats, `dimp|${d.id}`, days), adScans: sumCounter(db.stats, `dscan|${d.id}`, days),
  })).sort((a, b) => b.revenue - a.revenue || b.adScans + b.leads - (a.adScans + a.leads));
  return {
    from, to, summary: summary(ev), prev: summary(prev), reaction: reaction(ev), network, ads, devices,
    // ошибки процесса по всем ресторанам: сколько и на какую сумму, по нажатию — каждый заказ с рестораном
    errors: (() => { const pack = (k) => { const l = errAll.flatMap((x) => x[k].list).sort((a, b) => b.t - a.t);
      return { n: errAll.reduce((a, x) => a + x[k].n, 0), sum: errAll.reduce((a, x) => a + x[k].sum, 0), list: l.slice(0, 80) }; };
    return { cancelled: pack('cancelled'), marked: pack('marked'), missed: pack('missed'), came: pack('came') }; })(),
    avatar: avatarStats(ev, db.stats, rids, (rid) => (tests ? days : realDays(days, ctxs[rid]))), ...timeStats(ev),
    tts: { chars: ev.filter((e) => e.k === 'tts').reduce((s, e) => s + (e.chars || 0), 0) },
  };
}

// для умной настройки подсказок (smart.mjs): итоговые заказы, только «боевые» события, визиты
export { finalOrders, realOnly, visitsOf };
