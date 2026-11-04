// Источники меню: сайт ресторана, POS-система или JSON-фид собственной системы.
// Каждый адаптер возвращает блюда в общем виде:
//   { extId, sku, cat: {lang}, name: {lang}, desc: {lang}, price, photo, options: [{ key, label: {lang}, price }], available,
//     groups: [{ id, name: {lang}, type: 'one'|'many', req, opts: [{ id, name: {lang}, price (доплата), def (выбрано по умолчанию) }] }],
//     srcTags: ['vegan', …] — отметки источника как есть }
// options — варианты с полной ценой (объём, размер); groups — группы выбора как в источнике (начинка, острота, добавки)
import crypto from 'node:crypto';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; JetMediaMenuBot/1.0; +https://jetmedia.dev)' };

const decode = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const text = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : '';
};

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} — HTTP ${res.status}`);
  return res;
}

// ---------- Сайт: тема WordPress с карточками <article data-dish-…> (так устроен сайт VERANDA)
// Выбор у блюда — 1:1 как в окне выбора на сайте:
//   volume — объём с полной ценой (варианты), filling — начинка (выбрать обязательно), thai-coconut — кокосовое молоко
//   (+ data-dish-modifier-price), temperature — горячий / холодный, dumplings — способ приготовления и бульон
//   (бульон только у варёных — поэтому одна группа: «Варёные, с бульоном» / «Варёные, без бульона» / «Жареные»)

// Названия групп — заголовки окна выбора на странице (<fieldset data-modifier-fieldset><legend>)
function modifierLegends(html) {
  const out = {};
  for (const m of html.matchAll(/<fieldset[^>]*data-modifier-fieldset="([\w-]+)"([^>]*)>[\s\S]*?<legend[^>]*>([\s\S]*?)<\/legend>/g)) {
    const key = m[1] === 'dumplings' ? (/data-dumpling-broth/.test(m[2]) ? 'broth' : 'cooking') : m[1] === 'thai-coconut' ? 'coconut' : m[1];
    out[key] ??= text(m[3]);
  }
  return out;
}
const LEGENDS = {
  cooking: { ru: 'Способ приготовления', en: 'Cooking method' }, broth: { ru: 'Бульон', en: 'Broth' },
  coconut: { ru: 'Кокосовое молоко', en: 'Coconut milk' }, filling: { ru: 'Начинка', en: 'Filling' },
  temperature: { ru: 'Температура', en: 'Temperature' }, volume: { ru: 'Объём', en: 'Volume' },
};
const optName = (o) => ({ ru: String(o.labelRu || o.label || o.key).replace(/\s*\+\s*\d+\s*฿/, ''), en: String(o.labelEn || o.label || o.key).replace(/\s*\+\s*\d+\s*฿/, '') });

function cardChoices(tag, price, legends) {
  const none = { options: [], groups: [] };
  let fixed, volume;
  try {
    volume = JSON.parse(attr(tag, 'data-dish-volume-options') || '[]');
    fixed = JSON.parse(attr(tag, 'data-dish-fixed-options') || '{}') || {};
  } catch { return none; } // битый JSON в атрибуте — без выбора
  const mod = attr(tag, 'data-dish-modifier'), extra = Number(attr(tag, 'data-dish-modifier-price')) || 0;
  const gname = (key) => ({ ru: legends.ru?.[key] || LEGENDS[key]?.ru || key, en: legends.en?.[key] || LEGENDS[key]?.en || key });
  if (Array.isArray(volume) && volume.length) {
    return { options: volume.filter((o) => o && o.key).map((o) => ({ key: String(o.key), label: optName(o), price: Number(o.price) || price })), groups: [] };
  }
  if (mod === 'dumplings' && fixed.cooking) {
    const opts = [];
    for (const c of fixed.cooking) {
      if (c.key === 'boiled' && fixed.broth?.length) {
        for (const br of fixed.broth) {
          opts.push({ id: `${c.key}-${br.key}`, price: 0, def: br.key === 'without',
            name: { ru: `${optName(c).ru}, ${String(br.messageRu || optName(br).ru).toLowerCase()}`, en: `${optName(c).en}, ${String(br.messageEn || optName(br).en).toLowerCase()}` } });
        }
      } else opts.push({ id: String(c.key), name: optName(c), price: 0, def: false });
    }
    return { options: [], groups: [{ id: 'cooking', name: gname('cooking'), type: 'one', req: true, opts }] };
  }
  const allowed = attr(tag, 'data-dish-fillings').split(',').map((x) => x.trim()).filter(Boolean);
  const groups = Object.entries(fixed).filter(([, list]) => Array.isArray(list) && list.length).map(([key, list]) => ({
    id: key, name: gname(key), type: 'one', req: true,
    opts: list.filter((o) => key !== 'filling' || !allowed.length || allowed.includes(o.key)).map((o) => ({
      id: String(o.key), name: optName(o),
      // кокосовое молоко: «с молоком» — доплата из data-dish-modifier-price, «без» — выбор по умолчанию, как на сайте
      price: key === 'coconut' && o.key === 'with' ? extra : 0, def: key === 'coconut' && o.key === 'without',
    })),
  }));
  return { options: [], groups };
}

function parseDishCards(html, lang, legends = {}) {
  if (!html.includes('data-dish-id')) return null;
  const cats = {};
  for (const m of html.matchAll(/<a[^>]*href="#(menu-cat-\d+)"[^>]*>([\s\S]*?)<\/a>/g)) cats[m[1]] ??= text(m[2]);
  const items = [];
  const parts = html.split(/<section id="(menu-cat-\d+)"/); // [до, id1, содержимое1, id2, …]
  for (let i = 1; i < parts.length; i += 2) {
    for (const m of parts[i + 1].matchAll(/<article\s[^>]*data-dish-id="[^"]*"[^>]*>[\s\S]*?<\/article>/g)) {
      const tag = m[0].slice(0, m[0].indexOf('>') + 1);
      const price = Number(attr(tag, 'data-dish-price')) || 0;
      const img = m[0].match(/<img[^>]*\ssrc="([^"]+)"/);
      items.push({
        // одно блюдо бывает в нескольких категориях — в каждой отдельной позицией
        extId: `${attr(tag, 'data-dish-id')}@${parts[i]}`,
        sku: attr(tag, 'data-dish-sku').trim(),
        cat: { [lang]: cats[parts[i]] || '' },
        name: { ru: attr(tag, 'data-dish-title-ru') || attr(tag, 'data-dish-title'), en: attr(tag, 'data-dish-title-en') },
        desc: {},
        price,
        photo: img ? img[1] : '',
        ...cardChoices(tag, price, legends),
      });
    }
  }
  return items.length ? items : null;
}

// ---------- Сайт: разметка schema.org (JSON-LD Menu → MenuSection → MenuItem)

function parseJsonLd(html, lang) {
  const items = [];
  const walk = (node, cat) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, cat));
    if (!node || typeof node !== 'object') return;
    const type = [].concat(node['@type'] || []);
    if (type.includes('MenuItem')) {
      const offer = [].concat(node.offers || [])[0] || {};
      const image = [].concat(node.image || [])[0];
      items.push({
        extId: String(node['@id'] || node.name), cat: { [lang]: cat || '' }, name: { [lang]: node.name || '' },
        desc: { [lang]: node.description || '' }, price: Number(offer.price) || 0,
        photo: typeof image === 'string' ? image : image?.url || '', options: [],
      });
    }
    const next = type.includes('MenuSection') ? node.name : cat;
    for (const k of ['@graph', 'hasMenu', 'hasMenuSection', 'hasMenuItem', 'mainEntity']) if (node[k]) walk(node[k], next);
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(m[1]), ''); } catch { /* не JSON */ }
  }
  return items.length ? items : null;
}

// ---------- Сайт: магазин WooCommerce (WordPress)

async function wooProducts(url, lang) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    let list;
    try {
      list = await (await get(`${new URL(url).origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`)).json();
    } catch { break; }
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) {
      items.push({
        extId: String(p.id), cat: { [lang]: decode(p.categories?.[0]?.name || '') }, name: { [lang]: decode(p.name) },
        desc: { [lang]: text(p.short_description || '') },
        price: Number(p.prices?.price || 0) / 10 ** (p.prices?.currency_minor_unit ?? 2),
        photo: p.images?.[0]?.src || '', options: [],
      });
    }
    if (list.length < 100) break;
  }
  return items.length ? items : null;
}

// ---------- Сайт на foodmenu.online: меню лежит в странице готовым JSON (const DISHES = {…}),
// переводы — та же страница с ?lang=en|ru|th|cn

const dishesRaw = (html) => html.match(/const DISHES = (\{[\s\S]*?\});\n/)?.[1] || '';
const dishesJson = (html) => {
  try { return JSON.parse(dishesRaw(html)) || null; } catch { return null; }
};
const tagName = (x) => String(typeof x === 'string' ? x : x?.n || x?.name || x?.title || '').trim();

// Все группы выбора блюда — 1:1 как в источнике: «выберите одно» и добавки-галочки, доплаты, выбор по умолчанию.
// Проверка изменений экономная: сначала одна страница и её «отпечаток»; переводы качаем, только если меню изменилось
async function fromFoodmenu(src, html) {
  const raw = dishesRaw(html), base = dishesJson(html);
  if (!base) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  if (src.lastHash === hash) return { unchanged: true, hash };
  const LANGS = { en: 'en', ru: 'ru', th: 'th', zh: 'cn' };
  const tr = { [src.lang || 'en']: base };
  for (const [ours, theirs] of Object.entries(LANGS)) {
    const u = new URL(src.url);
    u.searchParams.set('lang', theirs);
    try { tr[ours] = dishesJson(await (await get(u)).text()) || tr[ours]; } catch { /* без этого перевода */ }
  }
  const pick = (get) => Object.fromEntries(Object.keys(tr).map((l) => [l, String(get(tr[l]) ?? '').trim()]).filter(([, v]) => v));
  const items = Object.values(base).map((d) => ({
    extId: String(d.id), sku: d.sku || '',
    cat: pick((t) => t[d.id]?.cat), name: pick((t) => t[d.id]?.name), desc: pick((t) => t[d.id]?.desc),
    price: Number(d.price || d.min) || 0,
    photo: d.img ? new URL(d.img, src.url).href : '',
    options: [],
    groups: (d.opts || []).map((g, gi) => ({
      id: String(g.cat || gi), type: g.type === 'checkbox' ? 'many' : 'one', req: !!g.req,
      name: pick((t) => t[d.id]?.opts?.[gi]?.n),
      opts: (g.opts || []).map((o, oi) => ({
        id: String(o.id), name: pick((t) => t[d.id]?.opts?.[gi]?.opts?.[oi]?.n), price: Number(o.p) || 0, def: !!o.c,
      })),
    })),
    srcTags: [...(d.tags || []), ...(d.allg || [])].map(tagName).filter(Boolean),
    available: !d.off,
  }));
  items.hash = hash;
  return items;
}

async function fromWebsite(src) {
  const lang = src.lang || 'en';
  const html = await (await get(src.url)).text();
  if (html.includes('data-dish-id')) {
    // «Отпечаток» карточек, разделов и окна выбора: не изменились — меню не трогаем и английскую страницу не качаем
    // (v2 — разбор с группами выбора: после обновления разбора меню перечитывается один раз)
    const sig = [...html.matchAll(/<article\s[^>]*data-dish-id[^>]*>|<section id="menu-cat-\d+"|<a[^>]*href="#menu-cat-\d+"[^>]*>[\s\S]*?<\/a>|<img[^>]*\ssrc="[^"]+"|<legend[^>]*>[\s\S]*?<\/legend>/g)].join('');
    const hash = crypto.createHash('sha1').update(`v2|${sig}`).digest('hex');
    if (src.lastHash === hash) return { unchanged: true, hash };
    // язык самой страницы (<html lang="ru-RU">) — по нему подписываем разделы; вторая страница (hreflang) даёт другой язык
    const pageLang = { ru: 'ru', en: 'en', th: 'th', zh: 'zh' }[(html.match(/<html[^>]*\slang="([a-z]{2})/i)?.[1] || '').toLowerCase()] || lang;
    const other = pageLang === 'ru' ? 'en' : 'ru';
    const legends = { [pageLang]: modifierLegends(html) };
    const cards = parseDishCards(html, pageLang, legends);
    // Названия разделов и групп выбора на втором языке — со страницы hreflang, если она есть
    const re = (l) => new RegExp(`<link[^>]*href="([^"]+)"[^>]*hreflang="${l}"|<link[^>]*hreflang="${l}"[^>]*href="([^"]+)"`);
    const m = html.match(re(other)), alt = m && (m[1] || m[2]);
    if (cards && alt && alt !== src.url) {
      try {
        const altHtml = await (await get(alt)).text();
        legends[other] = modifierLegends(altHtml);
        for (const i of cards) for (const g of i.groups) if (legends[other][g.id]) g.name[other] = legends[other][g.id];
        const tr = new Map((parseDishCards(altHtml, other) || []).map((i) => [i.extId, i.cat[other]]));
        for (const i of cards) if (tr.get(i.extId)) i.cat[other] = tr.get(i.extId);
      } catch { /* без второго языка разделов */ }
    }
    if (cards) { cards.hash = hash; return cards; }
  }
  const fm = await fromFoodmenu(src, html);
  if (fm) return fm;
  const items = parseJsonLd(html, lang) || (await wooProducts(src.url, lang));
  if (!items) throw new Error('на странице не найдено меню в понятном формате — пришлите адрес нам, добавим разбор этого сайта');
  return items;
}

// ---------- POS: Loyverse (https://developer.loyverse.com)

async function fromLoyverse(src) {
  if (!src.token) throw new Error('не указан API-токен Loyverse');
  const lang = src.lang || 'en';
  const auth = { authorization: `Bearer ${src.token}` };
  const all = async (path) => {
    const out = [];
    let cursor = '';
    do {
      const j = await (await get(`https://api.loyverse.com/v1.0/${path}?limit=250${cursor ? `&cursor=${cursor}` : ''}`, auth)).json();
      out.push(...(j[path] || []));
      cursor = j.cursor || '';
    } while (cursor);
    return out;
  };
  const cats = Object.fromEntries((await all('categories')).map((c) => [c.id, c.name]));
  const priceOf = (v) => Number(v.default_price ?? v.stores?.[0]?.price) || 0;
  return (await all('items')).filter((i) => !i.deleted_at).map((i) => {
    const vs = i.variants || [];
    return {
      extId: i.id, sku: vs[0]?.sku || '', cat: { [lang]: cats[i.category_id] || '' }, name: { [lang]: i.item_name },
      desc: { [lang]: i.description || '' }, price: vs[0] ? priceOf(vs[0]) : 0, photo: i.image_url || '',
      options: vs.length > 1 ? vs.map((v) => ({
        key: v.variant_id,
        label: { [lang]: [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(' / ') },
        price: priceOf(v),
      })) : [],
      available: !vs.length || vs.some((v) => (v.stores || []).some((s) => s.available_for_sale !== false)),
    };
  });
}

// ---------- JSON-фид собственной системы ресторана
// Формат: { items: [{ id, category, name, description, price, photo, available, options: [{ id, name, price }] }] },
// текстовые поля — строка или объект { en, th, ru, zh }.

async function fromJson(src) {
  const lang = src.lang || 'en';
  const j = await (await get(src.url, src.token ? { authorization: `Bearer ${src.token}` } : {})).json();
  const L = (v) => (v && typeof v === 'object' ? v : { [lang]: v || '' });
  return (j.items || j).map((i) => ({
    extId: String(i.id), sku: i.sku || '', cat: L(i.category), name: L(i.name), desc: L(i.description),
    price: Number(i.price) || 0, photo: i.photo || i.image || '',
    options: (i.options || []).map((o, k) => ({ key: String(o.id ?? k), label: L(o.name || o.label), price: Number(o.price) || 0 })),
    available: i.available !== false,
  }));
}

export const POS_VENDORS = { loyverse: fromLoyverse };

export async function fetchMenu(src) {
  if (src.type === 'website') return fromWebsite(src);
  if (src.type === 'json') return fromJson(src);
  if (src.type === 'pos') {
    const adapter = POS_VENDORS[src.vendor];
    if (!adapter) throw new Error(`интеграция с ${src.vendor || 'POS'} пока не подключена`);
    return adapter(src);
  }
  throw new Error('источник меню не задан');
}
