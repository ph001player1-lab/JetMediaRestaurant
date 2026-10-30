// Источники меню: сайт ресторана, POS-система или JSON-фид собственной системы.
// Каждый адаптер возвращает блюда в общем виде:
//   { extId, sku, cat: {lang}, name: {lang}, desc: {lang}, price, photo, options: [{ key, label: {lang}, price }], available }
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

const FILLINGS = {
  chicken: { ru: 'Курица', en: 'Chicken' }, pork: { ru: 'Свинина', en: 'Pork' }, beef: { ru: 'Говядина', en: 'Beef' },
  shrimp: { ru: 'Креветки', en: 'Shrimp' }, seafood: { ru: 'Морепродукты', en: 'Seafood' }, vegetables: { ru: 'Овощи', en: 'Vegetables' },
};

function cardOptions(tag, price) {
  try {
    const volume = JSON.parse(attr(tag, 'data-dish-volume-options') || '[]');
    if (volume.length) {
      return volume.map((o) => ({ key: String(o.key), label: { ru: o.labelRu || o.label, en: o.labelEn || o.label }, price: Number(o.price) || price }));
    }
    const fillings = attr(tag, 'data-dish-fillings').split(',').map((s) => s.trim()).filter(Boolean);
    if (fillings.length) return fillings.map((f) => ({ key: f, label: FILLINGS[f] || { en: f }, price }));
    // Одна группа вариантов без доплаты (например, «варёные / жареные»); несколько групп уточнит официант
    const fixed = Object.values(JSON.parse(attr(tag, 'data-dish-fixed-options') || '{}'));
    if (fixed.length === 1) {
      return fixed[0].map((o) => ({ key: String(o.key), label: { ru: o.labelRu || o.label, en: o.labelEn || o.label }, price }));
    }
  } catch { /* битый JSON в атрибуте — без вариантов */ }
  return [];
}

function parseDishCards(html, lang) {
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
        options: cardOptions(tag, price),
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

async function fromWebsite(src) {
  const lang = src.lang || 'en';
  const html = await (await get(src.url)).text();
  const cards = parseDishCards(html, lang);
  if (cards) {
    // Названия категорий на английском — со страницы hreflang="en", если она есть
    const alt = html.match(/<link[^>]*href="([^"]+)"[^>]*hreflang="en"/) || html.match(/<link[^>]*hreflang="en"[^>]*href="([^"]+)"/);
    if (alt && alt[1] !== src.url && lang !== 'en') {
      try {
        const en = new Map((parseDishCards(await (await get(alt[1])).text(), 'en') || []).map((i) => [i.extId, i.cat.en]));
        for (const i of cards) if (en.get(i.extId)) i.cat.en = en.get(i.extId);
      } catch { /* без английских категорий */ }
    }
    return cards;
  }
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
