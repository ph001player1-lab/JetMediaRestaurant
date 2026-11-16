// Скриншоты и PDF для ЛК → «Инструкция» (server/guide/): запускает сервер на копии тестовых данных, входит в ЛК
// менеджером, проходит 10 шагов инструкции, отмечает нужные кнопки красными рамками с номерами и снимает кадры;
// затем собирает PDF (по странице на слайд) из тех же текстов (server/guide/guide-ru.json).
//
//   GUIDE_DATA=<папка с копией данных: db.json, events/> GUIDE_CODE=<код ресторана> GUIDE_PIN=<PIN менеджера> \
//   GUIDE_DEVICE=<id планшета стола> node tools/guide-shots.mjs
//
// Данные не меняются: сервер работает на временной копии рядом (GUIDE_DATA-guide-tmp), её потом можно удалить.
// Имена ресторана и менеджера на кадрах заменяются на нейтральные («Ваш ресторан», «Менеджер»).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), OUT = path.join(ROOT, 'server/guide');
const DATA = process.env.GUIDE_DATA, CODE = process.env.GUIDE_CODE, PIN = process.env.GUIDE_PIN, DEV = process.env.GUIDE_DEVICE || '';
if (!DATA || !CODE || !PIN) { console.error('Нужны GUIDE_DATA, GUIDE_CODE, GUIDE_PIN'); process.exit(1); }
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const PORT = 3099, B = `http://localhost:${PORT}`, TMP = `${path.resolve(DATA)}-guide-tmp`;
fs.rmSync(TMP, { recursive: true, force: true });
fs.cpSync(DATA, TMP, { recursive: true });
const sv = spawn('node', [path.join(ROOT, 'server/server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP, INSTANCE: 'test' }, stdio: ['ignore', 'ignore', 'inherit'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(3500);
const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

// рамка с номером вокруг элемента; убрать все — clear()
const MARK = `window.__mark = (el, n) => {
  if (!el) return; const r = el.getBoundingClientRect(), x = r.left + scrollX, y = r.top + scrollY;
  const b = document.createElement('div'); b.className = '__hl';
  b.style.cssText = 'position:absolute;left:' + (x - 4) + 'px;top:' + (y - 4) + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;border:3px solid #e53935;border-radius:10px;z-index:99999;pointer-events:none';
  const c = document.createElement('div'); c.className = '__hl'; c.textContent = n;
  c.style.cssText = 'position:absolute;left:' + Math.max(2, x - 17) + 'px;top:' + Math.max(2, y - 17) + 'px;width:28px;height:28px;border-radius:14px;background:#e53935;color:#fff;font:700 16px system-ui;display:flex;align-items:center;justify-content:center;z-index:100000;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)';
  document.body.append(b, c);
};
window.__clear = () => document.querySelectorAll('.__hl').forEach((x) => x.remove());`;

const b = await chromium.launch();
try {
  const token = (await post('/api/staff/login', { code: CODE, pin: PIN })).token;
  if (!token) throw new Error('Не удалось войти в ЛК');
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5, locale: 'ru-RU' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  p.on('dialog', (d) => d.accept());
  await p.addInitScript((t) => { localStorage.token = t; localStorage.lang = 'ru'; }, token);
  await p.goto(`${B}/staff`); await wait(2500);
  await p.click('[data-tab="tMenu"]'); await wait(1500);
  await p.addScriptTag({ content: MARK });
  // нейтральные имена в шапке
  await p.evaluate(() => {
    const h = document.querySelector('header') || document.body;
    const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) n.nodeValue = n.nodeValue.replace(mgr.restaurant.name, 'Ваш ресторан').replace(/🧪\s*ТЕСТ/, '').replace(/·\s*$/, '');
    document.querySelectorAll('header *').forEach((e) => { if (e.childElementCount === 0 && /^[А-ЯA-Z][а-яa-z]+$/.test(e.textContent.trim()) && e.closest('header') && !e.closest('button')) e.textContent = 'Менеджер'; });
  });
  const mark = (sel, n, nth = 0) => p.evaluate(([s, k, i]) => window.__mark(document.querySelectorAll(s)[i], k), [sel, n, nth]);
  const markEl = (fn, n) => p.evaluate(([f, k]) => window.__mark(new Function(`return (${f})()`)(), k), [fn.toString(), n]);
  const rect = (sel, nth = 0) => p.evaluate(([s, i]) => { const r = document.querySelectorAll(s)[i].getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }, [sel, nth]);
  const shot = async (name, top, bottom, left = 0, right = 1200) => {
    await p.evaluate(() => window.scrollTo(0, 0)); await wait(300);
    await p.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 82, fullPage: true, clip: { x: Math.max(0, left), y: Math.max(0, top), width: right - left, height: bottom - top } });
    await p.evaluate(() => window.__clear());
    console.log('✓', name);
  };
  const tab = async (id) => { await p.click(`[data-tab="${id}"]`); await wait(500); await p.evaluate(() => window.scrollTo(0, 0)); };

  // 1. Что где
  for (const [id, n] of [['tMenu', 1], ['tRules', 2], ['tPromos', 3], ['tUpsell', 4], ['tStats', 5]]) await mark(`#tabs [data-tab="${id}"]`, n);
  const tb = await rect('#tabs');
  await shot('01-tabs.jpg', 0, tb.y + tb.h + 12);

  // 2. Меню → таблица → «✎ Править» → «Сохранить изменения»
  await tab('tMenu');
  await p.click('[data-view="menu|table"]'); await wait(400);
  await p.fill('.msearch', 'пельмен'); await p.dispatchEvent('.msearch', 'input'); await wait(500);
  await mark('[data-view="menu|table"]', 1); await mark('.msearch', 2); await mark('.xl2 [data-medit]', 3); await mark('#tMenu .bar [data-save]', 4);
  const v = await rect('[data-view="menu|table"]'), rows = await p.evaluate(() => { const r = document.querySelectorAll('.xl2 tbody tr'); const e = r[Math.min(r.length - 1, 5)].getBoundingClientRect(); return e.bottom + scrollY; });
  await shot('02-menu.jpg', v.y - 16, rows + 12);

  // 3. Карточка блюда: допы из правила, «✎ Изменить правило»
  await p.evaluate(() => { const i = mgr.restaurant.menu.findIndex((x) => (x.groups || []).some((g) => String(g.id).startsWith('r:')) && /хинкали/i.test(x.name?.ru || '')); openItem(i >= 0 ? i : 0); });
  await wait(600);
  await p.evaluate(() => document.querySelector('#modal [data-gorule]')?.scrollIntoView({ block: 'center' }));
  await wait(300);
  await markEl(() => document.querySelector('#modal [data-gorule]').closest('.ovr'), 1); await mark('#modal [data-gorule]', 2);
  await p.evaluate(() => { const s = document.querySelector('#modal [data-msave]'); if (s && s.getBoundingClientRect().bottom < innerHeight) window.__mark(s, 3); });
  const mo = await p.evaluate(() => { const g = document.querySelector('#modal [data-gorule]').closest('.opted') || document.querySelector('#modal [data-gorule]').closest('.ovr');
    const r = g.getBoundingClientRect(), m = document.querySelector('#modal .ed').getBoundingClientRect(); return { top: r.top + scrollY - 120, bottom: r.bottom + scrollY + 90, left: m.left - 10, right: m.right + 10 }; });
  await shot('03-dish.jpg', mo.top, mo.bottom, mo.left, mo.right);
  await p.click('#modal [data-mclose]').catch(() => {}); await wait(300);

  // 4. Допы и варианты: цена варианта, «Подходит блюд» с галочками
  await tab('tRules');
  const ri = await p.evaluate(() => mgr.restaurant.menuRules.findIndex((x) => /пельмен/i.test(x.name)));
  await p.click(`#rulesList .rcard[data-ri="${ri}"] > summary`); await wait(300);
  await p.click(`#rulesList .rcard[data-ri="${ri}"] .mbox details > summary`); await wait(300);
  await mark(`#rulesList .rcard[data-ri="${ri}"] [data-rgo$="|price"]`, 1);
  await mark(`#rulesList .rcard[data-ri="${ri}"] .mbox details`, 2);
  const rc = await rect(`#rulesList .rcard[data-ri="${ri}"]`), rcb = await rect(`#rulesList .rcard[data-ri="${ri}"] [data-rgcat]`);
  await shot('04-rules.jpg', rc.y - 12, rcb.y + rcb.h + 16);
  await p.click(`#rulesList .rcard[data-ri="${ri}"] > summary`); await wait(200);

  // 5. Новое правило: каких блюд касается, группа, «+ Варианты из раздела меню»
  await p.click('#rulesList [data-radd]'); await wait(300);
  const nr = await p.evaluate(() => mgr.restaurant.menuRules.length - 1);
  const card = `#rulesList .rcard[data-ri="${nr}"]`;
  await p.fill(`${card} [data-rf="name"]`, 'Соус к хинкали');
  await p.fill(`${card} [data-mw]`, 'хинкали'); await p.dispatchEvent(`${card} [data-mw]`, 'change'); await wait(300);
  await p.click(`${card} [data-rgadd]`); await wait(300);
  await p.fill(`${card} [data-rge$="|name"]`, 'Соус');
  await p.selectOption(`${card} select[data-rge$="|type"]`, 'many'); await wait(300);
  await p.fill(`${card} [data-rgcatp]`, '25');
  await p.selectOption(`${card} [data-rgcat]`, { label: 'Соусы' }).catch(() => {}); await wait(400);
  await mark(`${card} .mbox`, 1); await mark(`${card} .gbox .orow2`, 2); await markEl(() => document.querySelector(`#rulesList .rcard:last-of-type [data-rgcat]`).parentElement, 3);
  const nc = await rect(card), ncb = await rect(`${card} [data-rgcat]`);
  await shot('05-rule-new.jpg', nc.y - 12, ncb.y + ncb.h + 50);

  // 6–7. Подсказки: как устроена; добавить блюда словом
  await tab('tUpsell');
  const ui = await p.evaluate(() => Math.max(0, mgr.restaurant.upsell.rules.findIndex((x) => x.id === 'vu-coffee')));
  await p.click(`#tUpsell .rcard[data-ui="${ui}"] > summary`); await wait(300);
  const uc = `#tUpsell .rcard[data-ui="${ui}"]`;
  await mark(`${uc} .mbox`, 1, 0); await mark(`${uc} .mbox`, 2, 1); await markEl(() => document.querySelector('#tUpsell .rcard[open] .ml'), 3); await markEl(() => document.querySelector('#tUpsell .rcard[open] > summary .empty'), 4);
  const u1 = await rect(uc);
  await shot('06-upsell.jpg', u1.y - 12, Math.min(u1.y + u1.h + 12, u1.y + 1500));
  await mark(`${uc} .mbox [data-mw]`, 1); await mark(`${uc} .mbox .chips`, 2); await mark(`${uc} .mbox [data-mpick]`, 3); await mark(`${uc} .mbox [data-mcount]`, 4);
  const mb = await rect(`${uc} .mbox`);
  await shot('07-up-words.jpg', mb.y - 20, mb.y + mb.h + 16);

  // 8. Проверка на планшетах (ЛК) и «↺ Новый гость» (планшет)
  await p.evaluate(() => window.scrollTo(0, 0));
  await markEl(() => document.querySelector('#tUpsell [data-utest]'), 1);
  const tbx = await p.evaluate(() => { const r = document.querySelector('#tUpsell [data-utest]').closest('.upbox').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; });
  await shot('08-up-check.jpg', tbx.y - 16, tbx.y + tbx.h + 16, tbx.x - 16, tbx.x + tbx.w + 16);
  if (DEV) {
    await post('/api/manager/upsell/test', { token, on: true });
    const tp = await ctx.newPage();
    await tp.setViewportSize({ width: 800, height: 1280 });
    await tp.goto(`${B}/guest/?d=${encodeURIComponent(DEV)}&lang=ru`); await wait(3500);
    await tp.evaluate(() => { hideAttract(); renderAll(); }); await wait(500);
    await tp.addStyleTag({ content: '#testTag{display:none!important}' });
    await tp.addScriptTag({ content: MARK });
    await tp.evaluate(() => window.__mark(document.querySelector('#upTest'), 2));
    await wait(300);
    await tp.screenshot({ path: path.join(OUT, '08-up-check-tablet.jpg'), type: 'jpeg', quality: 82, clip: { x: 0, y: 1280 - 92, width: 520, height: 92 } });
    console.log('✓ 08-up-check-tablet.jpg');
    await tp.close();
    await post('/api/manager/upsell/test', { token, on: false });
  }

  // 9. Акции: название в меню по языкам, варианты, «⚠ нет перевода»
  await tab('tPromos');
  const pi = await p.evaluate(() => {
    const i = mgr.restaurant.promos.findIndex((x) => (x.variants || []).length);
    const P = mgr.restaurant.promos[i], vs = P?.variants || [];
    if (vs.length > 3) P.variants = [...new Set([vs[0], vs.find((v) => /манг/i.test(v.name?.ru || '')) || vs[1], vs[vs.length - 1]])]; // короче кадр
    const v = (P?.variants || []).slice(-1)[0];
    if (v) delete v.name.th; // для примера — один перевод не заполнен
    return i;
  });
  if (pi >= 0) {
    await p.click(`[data-pedit="${pi}"]`); await wait(500);
    await markEl(() => document.querySelector('[data-pmn]').closest('.full'), 1);
    const pr = await p.evaluate(() => { const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right }; };
      return { a: box(document.querySelector('[data-pmn]').closest('.full')), z: box(document.querySelector('.pvars')) }; });
    await shot('09-promos.jpg', pr.a.top - 24, pr.a.bottom + 14, pr.a.left - 24, pr.a.right + 18);
    await mark('.pvar', 2);
    await markEl(() => document.querySelector('.pvar .lp.miss') || document.querySelector('.lp.miss'), 3);
    await shot('09-promos-vars.jpg', pr.z.top - 14, pr.z.bottom + 12, pr.z.left - 24, pr.z.right + 18);
  }

  // 10. Результат: «Сейчас на планшетах», рост чека
  await tab('tUpsell');
  await mark('#tUpsell .upks', 1);
  const r10 = await p.evaluate(() => { const a = document.querySelector('#tUpsell .upks').closest('.upbox').getBoundingClientRect();
    const z = [...document.querySelectorAll('#tUpsell .empty')].find((x) => /Средний чек|Рост чека/.test(x.textContent)).getBoundingClientRect();
    return { a: { top: a.top + scrollY - 16, bottom: a.bottom + scrollY + 16 }, z: { top: z.top + scrollY - 40, bottom: z.bottom + scrollY + 6 } }; });
  await shot('10-stats.jpg', r10.a.top, r10.a.bottom);
  await markEl(() => [...document.querySelectorAll('#tUpsell .empty')].find((x) => /Средний чек|Рост чека/.test(x.textContent)), 2);
  await shot('10-stats-2.jpg', r10.z.top, r10.z.bottom);

  // ---- PDF: по странице на слайд (A4 альбомная): заголовок, кадр(ы), текст
  const g = JSON.parse(fs.readFileSync(path.join(OUT, 'guide-ru.json'), 'utf8'));
  const img = (f) => (f && fs.existsSync(path.join(OUT, f)) ? `<img src="data:image/jpeg;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}">` : '');
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const md = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 12mm; } body { font: 15px/1.45 system-ui, sans-serif; color: #1f1a17; margin: 0; }
    section { page-break-after: always; height: 184mm; display: grid; grid-template-columns: 62% 1fr; grid-template-rows: auto auto 1fr; column-gap: 8mm; row-gap: 6px; }
    section > header, section > h2 { grid-column: 1 / 3; }
    header { display: flex; justify-content: space-between; color: #8a7f76; font-size: 12px; } h2 { margin: 0; font-size: 22px; }
    .im { min-height: 0; display: flex; flex-direction: column; gap: 4mm; align-items: flex-start; } .im img { max-height: 160mm; max-width: 100%; object-fit: contain; border: 1px solid #eee4da; border-radius: 8px; }
    .im img + img, .im img:has(+ img) { max-height: 78mm; } ul { margin: 0; padding-left: 20px; font-size: 14px; } li { margin: 0 0 6px; }</style><body>
    ${g.slides.map((s, i) => `<section><header><span>JET MEDIA · ${esc(g.title)}</span><span>${i + 1} / ${g.slides.length}</span></header>
      <h2>${i + 1}. ${esc(s.title)}</h2><div class="im">${img(s.img)}${img(s.img2)}</div><ul>${s.text.map((x) => `<li>${md(x)}</li>`).join('')}</ul></section>`).join('')}</body></html>`;
  const pp = await b.newPage();
  await pp.setContent(html, { waitUntil: 'load' });
  await pp.pdf({ path: path.join(OUT, 'guide-ru.pdf'), format: 'A4', landscape: true, printBackground: true });
  console.log('✓ guide-ru.pdf');
} finally {
  await b.close();
  sv.kill();
}
