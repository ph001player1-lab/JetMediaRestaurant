// Умная настройка подсказок к заказу: раз в сутки по «боевым» событиям ресторана за 30 дней (показы, «взяли»,
// «нет, спасибо», «не тронули», все заказы) подбирает частоту, сколько отказов терпеть, сколько висит всплывашка,
// сколько карточек и ценовой потолок — в границах менеджера и маленькими шагами; считает «вес» каждой подсказки
// (сколько приносит за показ), популярность блюд, пары «берут вместе» из всех заказов, рост чека по контрольной группе.
// Сеть: то же по типам разделов («пиво → закуски») и районам — что где работает, подсказки новым ресторанам.

export const SMART_MIN = 300; // показов всплывашки за 30 дней — тогда умная меняет частоту и прочее
export const RULE_MIN = 30; // показов подсказки — тогда её «вес» считается по её данным
export const UPLIFT_MIN = 30; // визитов в каждой группе — тогда показываем рост чека

const lc = (x) => String(x ?? '').trim().toLowerCase();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pctl = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]; };
const pc = (x) => `${Math.round(x * 100)}%`;
const hourTh = (t) => new Date(t + 7 * 3600e3).getUTCHours();

// Тип раздела меню — чтобы сравнивать рестораны с разными названиями разделов («Бутылочное пиво» и «Пиво» — пиво)
const TYPES = [
  ['kids', /дет|kid/], ['breakfast', /завтрак|breakfast/],
  ['spirits', /крепк|водк|виски|whisk|(^|\s)ром|коньяк|cognac|джин|(^|\s)gin|текил|tequila|шот|shot|vodka|(^|\s)rum/],
  ['beer', /пив|beer/], ['wine', /(^|\s)вин|wine|игрист|sparkling/],
  ['soft', /безалк|лимонад|(^|\s)сок|фреш|морс|smoothie|смузи|soft|juice|fresh|напит/], ['cocktail', /коктейл|cocktail/],
  ['coffee', /кофе|(^|\s)чай|coffee|(^|\s)tea/], ['dessert', /десерт|торт|пирожн|печень|сладк|меренг|кекс|dessert|cake|sweet|пасха/],
  ['soup', /суп|soup/], ['salad', /салат|salad/], ['dumplings', /пельмен|вареник|хинкал|dumpling/],
  ['snack', /закуск|snack|appetizer|starter/], ['side', /гарнир|side/], ['bread', /хлеб|выпечк|bread|bakery/],
  ['pasta', /паст|пицц|pasta|pizza/], ['asian', /тайск|азиат|суши|ролл|вок|thai|sushi|roll|wok|испан|мексик/],
  ['main', /горяч|мяс|птиц|огн|гриль|рыб|морепрод|main|meat|fish|seafood|grill|вегетариан|vegan/],
];
export const TYPE_NAMES = {
  kids: 'Детское', breakfast: 'Завтраки', spirits: 'Крепкое', beer: 'Пиво', wine: 'Вино', soft: 'Безалкогольные', cocktail: 'Коктейли',
  coffee: 'Кофе и чай', dessert: 'Десерты', soup: 'Супы', salad: 'Салаты', dumplings: 'Пельмени и вареники', snack: 'Закуски', side: 'Гарниры',
  bread: 'Хлеб и выпечка', pasta: 'Паста и пицца', asian: 'Азия и кухни мира', main: 'Горячее', other: 'Прочее',
};
export const typeOfCat = (cat) => { const s = lc(cat?.ru || cat?.en || cat); return (TYPES.find(([, re]) => re.test(s)) || ['other'])[0]; };

// Один шаг в сторону цели: не дальше границ, закреплённое (🔒) не трогаем
function stepper(v, bounds, locks, changes) {
  return (k, dir, why, by = 1) => {
    if (!dir || locks?.[k] || !bounds[k]) return;
    const [lo, hi] = bounds[k], to = clamp(Math.round((v[k] + dir * by) * 2) / 2, lo, hi);
    if (to === v[k]) return;
    changes.push({ k, from: v[k], to, why });
    v[k] = to;
  };
}

// ev — «боевые» события ресторана за 30 дней (без тестовых), visits — визиты из них; cur — нынешние значения умной;
// compiled — подсказки как их получает планшет (кому / что предлагаем), чтобы не советовать уже существующее
export function analyzeUpsell({ r, ev, visits, cur, bounds, locks, compiled = [], now = Date.now() }) {
  const menu = new Map((r.menu || []).map((i) => [i.id, i]));
  const price = (id) => Number(menu.get(id)?.price) || 0, catOf = (id) => lc(menu.get(id)?.cat?.ru || menu.get(id)?.cat?.en);
  const ups = ev.filter((e) => e.k?.startsWith('up_'));
  const pop = ups.filter((e) => e.mode === 'popup');
  const P = pop.filter((e) => e.k === 'up_show').length, A = pop.filter((e) => e.k === 'up_add').length;
  const N = pop.filter((e) => e.k === 'up_no').length, I = pop.filter((e) => e.k === 'up_ign').length;

  // ---- подсказки: показали / взяли / отказались / не тронули / выручка; «вес» — сколько приносит за показ
  const rules = {};
  for (const e of ups) {
    if (!e.rule) continue;
    const x = (rules[e.rule] ??= { shows: 0, adds: 0, no: 0, ign: 0, rev: 0 });
    if (e.k === 'up_show') x.shows++; else if (e.k === 'up_add') { x.adds++; x.rev += e.price || 0; } else if (e.k === 'up_no') x.no++; else if (e.k === 'up_ign') x.ign++;
  }
  const allShows = Object.values(rules).reduce((s, x) => s + x.shows, 0), allAdds = Object.values(rules).reduce((s, x) => s + x.adds, 0);
  const p0 = (allAdds + 1) / (allShows + 10); // доля взятий по ресторану — исходная для подсказок с малыми данными
  const offerAvg = Object.fromEntries(compiled.map((x) => [x.id, x.offer.length ? x.offer.reduce((s, id) => s + price(id), 0) / x.offer.length : 0]));
  for (const [id, x] of Object.entries(rules)) {
    x.conv = x.shows ? x.adds / x.shows : 0;
    const sm = (x.adds + p0 * 10) / (x.shows + 10), avg = x.adds ? x.rev / x.adds : offerAvg[id] || 0;
    x.w = Math.round(sm * avg * 100) / 100; // ожидаемая выручка за показ, ฿
    x.enough = x.shows >= RULE_MIN;
  }
  const maxW = Math.max(0, ...Object.values(rules).map((x) => x.w));
  for (const x of Object.values(rules)) x.wn = maxW ? Math.round((x.w / maxW) * 100) / 100 : 0;

  // ---- популярность блюд: все заказы + взятое из подсказок (втрое весомее) — порядок карточек в карусели
  const items = {};
  for (const e of ev) {
    if (e.k === 'order') for (const [id, qty] of e.items || []) items[id] = (items[id] || 0) + (qty || 1);
    else if (e.k === 'up_add' && e.dish) items[e.dish] = (items[e.dish] || 0) + 3;
  }

  // ---- частота и прочее — только на достаточной выборке
  const v = { ...cur }, changes = [], step = stepper(v, bounds, locks, changes);
  const enough = P >= SMART_MIN;
  if (enough) {
    const at = (n) => ({ s: pop.filter((e) => e.k === 'up_show' && e.n === n).length, a: pop.filter((e) => e.k === 'up_add' && e.n === n).length });
    const noRate = N / P, c1 = at(1), conv1 = c1.s ? c1.a / c1.s : 0, k = v.perVisit, ck = at(k);
    if (ck.s >= RULE_MIN) {
      const cK = ck.a / ck.s;
      if (cK >= Math.max(0.05, conv1 * 0.5) && noRate < 0.3) step('perVisit', 1, `${k}-ю подсказку за визит берут в ${pc(cK)} случаев, отказов ${pc(noRate)} — гостям не надоедает`);
      else if (cK < 0.02 || noRate > 0.45) step('perVisit', -1, `${k}-ю подсказку за визит берут редко (${pc(cK)}), отказов ${pc(noRate)}`);
    }
    // после «Нет, спасибо»: берут ли дальше
    const dS = pop.filter((e) => e.k === 'up_show' && e.nn >= 1).length, dA = pop.filter((e) => e.k === 'up_add' && e.nn >= 1).length;
    if (dS >= RULE_MIN) {
      const cD = dA / dS;
      if (cD >= 0.05) step('maxNo', 1, `после отказа гости всё равно берут из следующих подсказок (${pc(cD)})`);
      else if (cD < 0.015) step('maxNo', -1, `после отказа почти не берут (${pc(cD)}) — раньше перестаём предлагать`);
    }
    // сколько висит: столько, сколько обычно нужно на решение, плюс 2 секунды
    const ms = pop.filter((e) => (e.k === 'up_add' || e.k === 'up_no') && e.ms > 0).map((e) => e.ms);
    if (ms.length >= RULE_MIN) {
      const target = clamp(Math.round(pctl(ms, 0.8) / 1000 + 2), ...bounds.showSec), d = Math.sign(target - v.showSec);
      if (d) step('showSec', d, `8 из 10 гостей решают за ${Math.round(pctl(ms, 0.8) / 1000)} с${I / P > 0.35 ? `, не трогают ${pc(I / P)}` : ''}`);
    }
    // сколько карточек: берут из первых — меньше, листают дальше — больше
    const pos = pop.filter((e) => e.k === 'up_add' && e.pos >= 0).map((e) => e.pos);
    if (pos.length >= 20) {
      const target = clamp(pctl(pos, 0.9) + 3, ...bounds.cards), d = Math.sign(target - v.cards);
      if (d) step('cards', d, d > 0 ? `берут и с дальних карточек (до ${pctl(pos, 0.9) + 1}-й)` : `берут почти всегда из первых ${pctl(pos, 0.9) + 1} карточек`, 2);
    }
    // ценовой потолок: во сколько раз взятое дороже блюда, к которому подсказка
    const ratios = pop.filter((e) => e.k === 'up_add' && e.price > 0 && e.tp > 0).map((e) => e.price / e.tp);
    if (ratios.length >= 20) {
      const target = clamp(Math.round(pctl(ratios, 0.9) * 1.25 * 2) / 2, ...bounds.priceCap), d = Math.sign(target - v.priceCap);
      if (d) step('priceCap', d, `берут добавки до ×${Math.round(pctl(ratios, 0.9) * 10) / 10} цены блюда`, Math.min(1, Math.abs(target - v.priceCap)));
    }
  }

  // ---- лучшее время: доля взятий по часам (не меньше 20 показов в час)
  const hours = {};
  for (const e of pop) {
    if (e.k !== 'up_show' && e.k !== 'up_add') continue;
    const h = (hours[hourTh(e.t)] ??= { s: 0, a: 0 });
    if (e.k === 'up_show') h.s++; else h.a++;
  }
  const bestHours = Object.entries(hours).filter(([, h]) => h.s >= 20).map(([h, x]) => ({ h: Number(h), conv: x.a / x.s, s: x.s })).sort((a, b) => b.conv - a.conv).slice(0, 3);

  // ---- контрольная группа: средний чек визита с подсказками и без
  const grp = { c: [], t: [] };
  for (const vis of visits) {
    if (!vis.orders) continue;
    const g = [...vis.events].reverse().find((e) => e.k === 'up_grp')?.g;
    if (g === 'c' || g === 't') grp[g].push(vis.total);
  }
  const avgOf = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
  const uplift = { c: grp.c.length, t: grp.t.length, avgC: avgOf(grp.c), avgT: avgOf(grp.t) };
  if (uplift.c >= UPLIFT_MIN && uplift.t >= UPLIFT_MIN && uplift.avgC) uplift.pct = Math.round((uplift.avgT / uplift.avgC - 1) * 1000) / 10;

  // ---- пары из всех заказов: что берут в одном визите (по разделам), чего ещё нет в подсказках
  const sets = visits.map((vis) => new Set(vis.events.filter((e) => e.k === 'order').flatMap((e) => (e.items || []).map((x) => x[0])).filter((id) => menu.has(id))))
    .filter((s) => s.size);
  const V = sets.length, cnt = {}, pair = {};
  for (const s of sets) {
    const l = [...s];
    for (const a of l) { cnt[a] = (cnt[a] || 0) + 1; for (const b of l) if (a !== b) pair[`${a}|${b}`] = (pair[`${a}|${b}`] || 0) + 1; }
  }
  const covered = (a, b) => compiled.some((x) => !x.nodrink && x.when.includes(a) && x.offer.includes(b));
  const byCat = {};
  for (const [k, n] of Object.entries(pair)) {
    if (n < 5) continue;
    const [a, b] = k.split('|'), ca = catOf(a), cb = catOf(b);
    if (!ca || !cb || ca === cb || cnt[a] < 8 || covered(a, b)) continue;
    const conf = n / cnt[a], lift = conf / (cnt[b] / V);
    if (conf < 0.15 || lift < 1.3) continue;
    const x = (byCat[`${ca}>${cb}`] ??= { whenCat: menu.get(a).cat, offerCat: menu.get(b).cat, n: 0, conf: 0, lift: 0, k: 0, offer: {}, ex: [] });
    x.n += n; x.conf += conf; x.lift += lift; x.k++; x.offer[b] = (x.offer[b] || 0) + n;
    if (x.ex.length < 3) x.ex.push([a, b, Math.round(conf * 100)]);
  }
  const pairs = Object.entries(byCat).map(([key, x]) => ({ key: `pair:${key}`, whenCat: x.whenCat, offerCat: x.offerCat, n: x.n, conf: Math.round((x.conf / x.k) * 100),
    lift: Math.round((x.lift / x.k) * 10) / 10, offer: Object.entries(x.offer).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id), ex: x.ex }))
    .sort((a, b) => b.n * b.conf - a.n * a.conf).slice(0, 8);

  // ---- для сети: по типам разделов — показы всплывашки по типу блюда, взятое по паре типов, визиты с типом и с парой
  const net = { shows: {}, adds: {}, rev: {}, vis: {}, visAB: {}, V };
  for (const e of pop) {
    if (e.k === 'up_show' && e.dish) { const a = typeOfCat(menu.get(e.dish)?.cat); net.shows[a] = (net.shows[a] || 0) + 1; }
    if (e.k === 'up_add' && e.tr && e.dish) {
      const key = `${typeOfCat(menu.get(e.tr)?.cat)}>${typeOfCat(menu.get(e.dish)?.cat)}`;
      net.adds[key] = (net.adds[key] || 0) + 1; net.rev[key] = (net.rev[key] || 0) + (e.price || 0);
    }
  }
  for (const s of sets) {
    const ts = [...new Set([...s].map((id) => typeOfCat(menu.get(id)?.cat)))];
    for (const a of ts) { net.vis[a] = (net.vis[a] || 0) + 1; for (const b of ts) if (a !== b) net.visAB[`${a}>${b}`] = (net.visAB[`${a}>${b}`] || 0) + 1; }
  }

  return {
    at: now, enough, sample: { shows: P, adds: A, no: N, ign: I, need: SMART_MIN, visits: V }, values: v, changes,
    rules, items, pairs, uplift, bestHours, net,
  };
}

// Сеть: сводка по ресторанам и районам, что работает (пары типов разделов) — портал и подсказки новым ресторанам
export function networkUpsell(list, districts = []) {
  const dname = (id) => districts.find((d) => d.id === id)?.ru || 'Без района';
  const pairs = {}, dist = {};
  const rests = list.map(({ r, a }) => {
    const shows = a.sample.shows, adds = a.sample.adds, rev = Object.values(a.rules).reduce((s, x) => s + x.rev, 0);
    const d = (dist[r.district || ''] ??= { id: r.district || '', name: dname(r.district), rests: 0, shows: 0, adds: 0, rev: 0, up: [] });
    d.rests++; d.shows += shows; d.adds += adds; d.rev += rev; if (a.uplift.pct != null) d.up.push(a.uplift.pct);
    for (const [k, n] of Object.entries(a.net.adds)) {
      const [ta, tb] = k.split('>'), x = (pairs[k] ??= { a: ta, b: tb, adds: 0, shows: 0, rev: 0, visA: 0, visAB: 0, rests: new Set(), dist: {} });
      x.adds += n; x.rev += a.net.rev[k] || 0; x.rests.add(r.id);
      const y = (x.dist[r.district || ''] ??= { shows: 0, adds: 0 }); y.adds += n;
    }
    for (const [k, n] of Object.entries(a.net.visAB)) {
      const [ta, tb] = k.split('>'), x = (pairs[k] ??= { a: ta, b: tb, adds: 0, shows: 0, rev: 0, visA: 0, visAB: 0, rests: new Set(), dist: {} });
      x.visAB += n; x.visA += a.net.vis[ta] || 0; x.rests.add(r.id);
    }
    // показы — по типу блюда, к которому подсказка (одинаковы для всех пар с этим типом)
    for (const x of Object.values(pairs)) if (a.net.shows[x.a] && x.rests.has(r.id)) {
      x.shows += a.net.shows[x.a]; (x.dist[r.district || ''] ??= { shows: 0, adds: 0 }).shows += a.net.shows[x.a];
    }
    return { id: r.id, name: r.name, district: dname(r.district), mode: r.upsell?.mode || 'smart', shows, adds, conv: shows ? adds / shows : 0, rev,
      uplift: a.uplift.pct ?? null, perVisit: a.values.perVisit, visits: a.sample.visits };
  });
  const pl = Object.entries(pairs).map(([k, x]) => ({ key: k, a: x.a, b: x.b, an: TYPE_NAMES[x.a], bn: TYPE_NAMES[x.b], adds: x.adds, shows: x.shows,
    conv: x.shows ? x.adds / x.shows : null, rev: x.rev, conf: x.visA ? x.visAB / x.visA : null, visAB: x.visAB, rests: x.rests.size,
    dist: Object.entries(x.dist).filter(([, y]) => y.shows >= 20).map(([id, y]) => ({ name: dname(id), conv: y.adds / y.shows, shows: y.shows })).sort((p, q) => q.conv - p.conv) }))
    .filter((x) => x.a !== x.b && x.a !== 'other' && x.b !== 'other' && (x.adds >= 3 || x.visAB >= 10))
    .sort((p, q) => (q.conv ?? 0) - (p.conv ?? 0) || (q.conf ?? 0) - (p.conf ?? 0)).slice(0, 40);
  return {
    rests: rests.sort((p, q) => q.rev - p.rev), pairs: pl,
    districts: Object.values(dist).map((d) => ({ ...d, conv: d.shows ? d.adds / d.shows : 0, uplift: d.up.length ? Math.round((d.up.reduce((s, x) => s + x, 0) / d.up.length) * 10) / 10 : null, up: undefined }))
      .sort((p, q) => q.conv - p.conv),
  };
}
