// Районы Пхукета и схема острова: где ресторан, показ рекламы по районам, карта в портале.
// Координаты — центры районов и упрощённый контур острова (схема, не точная карта)
export const DISTRICTS = [
  { id: 'maikhao', ru: 'Май Кхао', en: 'Mai Khao', lat: 8.14, lon: 98.302 },
  { id: 'naiyang', ru: 'Най Янг', en: 'Nai Yang', lat: 8.088, lon: 98.302 },
  { id: 'naithon', ru: 'Най Тон', en: 'Nai Thon', lat: 8.051, lon: 98.283 },
  { id: 'thalang', ru: 'Таланг', en: 'Thalang', lat: 8.03, lon: 98.335 },
  { id: 'paklok', ru: 'Пакхлок и Ао По', en: 'Pa Khlok & Ao Po', lat: 8.03, lon: 98.4 },
  { id: 'bangtao', ru: 'Банг Тао и Лагуна', en: 'Bang Tao & Laguna', lat: 7.998, lon: 98.3 },
  { id: 'surin', ru: 'Сурин', en: 'Surin', lat: 7.975, lon: 98.282 },
  { id: 'kamala', ru: 'Камала', en: 'Kamala', lat: 7.952, lon: 98.285 },
  { id: 'kohkaew', ru: 'Ко Кэу', en: 'Ko Kaeo', lat: 7.95, lon: 98.385 },
  { id: 'kathu', ru: 'Кату', en: 'Kathu', lat: 7.913, lon: 98.335 },
  { id: 'patong', ru: 'Патонг', en: 'Patong', lat: 7.893, lon: 98.298 },
  { id: 'town', ru: 'Пхукет-таун', en: 'Phuket Town', lat: 7.885, lon: 98.39 },
  { id: 'karon', ru: 'Карон', en: 'Karon', lat: 7.845, lon: 98.299 },
  { id: 'chalong', ru: 'Чалонг', en: 'Chalong', lat: 7.835, lon: 98.345 },
  { id: 'kata', ru: 'Ката', en: 'Kata', lat: 7.818, lon: 98.302 },
  { id: 'panwa', ru: 'Панва', en: 'Cape Panwa', lat: 7.81, lon: 98.398 },
  { id: 'naiharn', ru: 'Най Харн', en: 'Nai Harn', lat: 7.778, lon: 98.307, ly: 16 }, // подпись — под точкой, рядом Раваи
  { id: 'rawai', ru: 'Раваи', en: 'Rawai', lat: 7.778, lon: 98.33 },
];
export const DISTRICT_IDS = new Set(DISTRICTS.map((d) => d.id));
// Контур острова по часовой стрелке от северной оконечности (широта, долгота)
export const OUTLINE = [
  [8.2, 98.296], [8.15, 98.293], [8.1, 98.294], [8.085, 98.284], [8.062, 98.276], [8.03, 98.273], [8.008, 98.285], [7.985, 98.29],
  [7.972, 98.272], [7.957, 98.279], [7.932, 98.273], [7.912, 98.284], [7.895, 98.292], [7.876, 98.288], [7.86, 98.281], [7.846, 98.292],
  [7.83, 98.29], [7.815, 98.294], [7.8, 98.3], [7.785, 98.299], [7.77, 98.302], [7.757, 98.305], [7.762, 98.32], [7.774, 98.331],
  [7.79, 98.345], [7.81, 98.356], [7.8, 98.376], [7.795, 98.405], [7.815, 98.416], [7.84, 98.406], [7.862, 98.401], [7.882, 98.411],
  [7.912, 98.42], [7.95, 98.421], [7.99, 98.42], [8.03, 98.426], [8.07, 98.411], [8.1, 98.391], [8.14, 98.362], [8.17, 98.333], [8.2, 98.31],
];
const BOUNDS = { lat: [7.7, 8.25], lon: [98.2, 98.5] };
export const onIsland = (g) => g && g.lat >= BOUNDS.lat[0] && g.lat <= BOUNDS.lat[1] && g.lon >= BOUNDS.lon[0] && g.lon <= BOUNDS.lon[1];

// Ближайший район к точке (для подсказки, когда вставили ссылку на карту)
export function nearestDistrict(g) {
  if (!onIsland(g)) return '';
  const k = Math.cos((g.lat * Math.PI) / 180);
  let best = '', bd = Infinity;
  for (const d of DISTRICTS) {
    const dist = (d.lat - g.lat) ** 2 + ((d.lon - g.lon) * k) ** 2;
    if (dist < bd) { bd = dist; best = d.id; }
  }
  return best;
}

export function cleanGeo(g) {
  const lat = Number(g?.lat), lon = Number(g?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 } : null;
}

// Координаты из ссылки Google Maps или из текста «7.8961, 98.2966»
function coordsIn(text) {
  let s = String(text || '');
  try { s = decodeURIComponent(s); } catch { /* как есть */ }
  const pats = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // точка самого места
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, // центр карты
    /[?&](?:q|ll|query|center|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) return cleanGeo({ lat: m[1], lon: m[2] });
  }
  return null;
}
const placeName = (u) => {
  const m = String(u).match(/\/maps\/place\/([^/@?]+)/);
  try { return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).slice(0, 120) : ''; } catch { return ''; }
};
const GOOGLE = /^(?:[\w-]+\.)*(?:google\.[a-z.]+|goo\.gl|app\.goo\.gl)$/i;

// Ссылка «Поделиться» из Google Maps: короткую (maps.app.goo.gl) раскрываем по переадресациям — только адреса Google
export async function resolveMapLink(input) {
  const text = String(input || '').trim().slice(0, 2000);
  let geo = coordsIn(text), name = placeName(text);
  let url = /^https?:\/\//i.test(text) ? text : '';
  for (let hop = 0; !geo && url && hop < 5; hop++) {
    let host;
    try { host = new URL(url).hostname; } catch { break; }
    if (!GOOGLE.test(host)) break;
    let res;
    try { res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Mozilla/5.0 JetMedia' } }); } catch { break; }
    const next = res.headers.get('location');
    if (next) {
      url = new URL(next, url).toString();
      geo = coordsIn(url);
      name ||= placeName(url);
      continue;
    }
    // страница без переадресации: координаты бывают в тексте страницы
    const body = (await res.text().catch(() => '')).slice(0, 300_000);
    geo = coordsIn(body.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s]+/)?.[0] || '') || coordsIn(body.match(/\[null,null,(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)\]/)?.slice(1).join(',') || '');
    break;
  }
  return { geo, name, district: geo ? nearestDistrict(geo) : '' };
}
