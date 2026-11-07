// Схема зала: вид «Схема» в приложении официанта и редактор схемы в ЛК менеджера.
// Схема — в клетках (а не в пикселях): зона N клеток в ширину растягивается на любой телефон.
// Нет схемы — столы плитками. Быстрые кнопки под столами — какие разрешил менеджер.
// JetFloor.view(el, ctx) — экран официанта; JetFloor.editor(el, ctx) — редактор; JetFloor.sig() — состояние для перерисовки
(() => {
  const L = {
    ru: { list: '☰ Список', floor: '▦ Схема', mine: 'Мои столы', attention: 'Требует внимания', fold: 'свернуть ▾', unfold: 'развернуть ▸', calm: 'Всё спокойно 👌',
      unplaced: 'Не на схеме', tables: 'Столы', yours: 'ваш', min: 'мин', table: 'стол',
      st_free: 'свободен', st_busy: 'гости', st_cook: 'готовится', st_call: 'Вызов официанта', st_bill: 'Просят счёт', st_new: 'Новый заказ', st_ready: 'Готово — нести', st_callAck: 'Официант идёт', st_billAck: 'Несут счёт', paidAll: 'оплачен', carry: 'нести',
      q_ack: 'Иду', q_done: 'Готово', q_confirm: 'Принять', q_served: 'Подано', q_paid: 'Оплачен', q_close: 'Закрыть',
      edTitle: 'Схема зала', edHint: 'Расставьте столы как в зале: тащите пальцем или мышью, стол встанет в клетку. Нажмите на стол — внизу форма и размер. Официанты видят схему в приложении (вид «Схема»). Пока схемы нет — столы у них плитками.',
      edPhone: 'Так схема выглядит на телефоне официанта', zoneAdd: '+ Зона', zoneName: 'Название зоны', cols: 'Клеток в ширину', zoneDel: 'Удалить зону', zoneDelAsk: 'Удалить зону «{n}»? Её столы вернутся в «Не на схеме».',
      edit: 'Правка', preview: 'Как у официанта', pick: 'Нажмите на стол или надпись, чтобы изменить. Столы из «Не на схеме» — нажмите, чтобы поставить.',
      square: '□ Квадрат', round: '○ Круг', wider: 'Шире', narrower: 'Уже', taller: 'Выше', lower: 'Ниже', unplace: 'Убрать со схемы', delDecor: 'Удалить', label: 'Надпись',
      addDecor: 'Добавить надпись:', decor: ['Бар', 'Вход', 'Касса', 'Кухня', 'Окно', 'Стена'], noRoom: 'В зоне нет свободной клетки — сделайте зону шире или уберите стол',
      quickT: 'Быстрые кнопки на схеме', quickHint: 'Что официант делает прямо со схемы, не открывая стол. Остальное — в карточке стола.',
      qh_ack: 'Иду — вызов официанта и просьба счёта', qh_done: 'Готово — вызов выполнен, счёт отнесли', qh_confirm: 'Принять — новый заказ с планшета или телефона',
      qh_served: 'Подано — кухня приготовила, официант отнёс', qh_paid: 'Оплачен — счёт оплачен (деньги — лучше через карточку стола)', qh_close: 'Закрыть стол — всё оплачено (лучше через карточку стола)',
      save: 'Сохранить схему', saved: 'Схема сохранена — официанты увидят её через несколько секунд', unsaved: 'Есть несохранённые изменения', empty: 'Схемы пока нет — добавьте зону', zone1: 'Зал' },
    en: { list: '☰ List', floor: '▦ Floor', mine: 'My tables', attention: 'Needs attention', fold: 'hide ▾', unfold: 'show ▸', calm: 'All calm 👌',
      unplaced: 'Not on the plan', tables: 'Tables', yours: 'yours', min: 'min', table: 'table',
      st_free: 'free', st_busy: 'guests', st_cook: 'cooking', st_call: 'Waiter call', st_bill: 'Bill requested', st_new: 'New order', st_ready: 'Ready — carry it', st_callAck: 'Waiter on the way', st_billAck: 'Bringing the bill', paidAll: 'paid', carry: 'carry',
      q_ack: 'Going', q_done: 'Done', q_confirm: 'Accept', q_served: 'Served', q_paid: 'Paid', q_close: 'Close',
      edTitle: 'Floor plan', edHint: 'Place the tables as in the room: drag with a finger or mouse, a table snaps to the grid. Tap a table to change its shape and size. Waiters see the plan in the app (“Floor” view). Without a plan they see tables as tiles.',
      edPhone: 'This is how the plan looks on a waiter’s phone', zoneAdd: '+ Zone', zoneName: 'Zone name', cols: 'Cells across', zoneDel: 'Delete zone', zoneDelAsk: 'Delete zone “{n}”? Its tables go back to “Not on the plan”.',
      edit: 'Edit', preview: 'Waiter’s view', pick: 'Tap a table or a label to change it. Tap a table under “Not on the plan” to place it.',
      square: '□ Square', round: '○ Round', wider: 'Wider', narrower: 'Narrower', taller: 'Taller', lower: 'Lower', unplace: 'Remove from plan', delDecor: 'Delete', label: 'Label',
      addDecor: 'Add a label:', decor: ['Bar', 'Entrance', 'Cashier', 'Kitchen', 'Window', 'Wall'], noRoom: 'No free cell in this zone — make it wider or remove a table',
      quickT: 'Quick buttons on the plan', quickHint: 'What a waiter does right on the plan, without opening the table. Everything else is in the table card.',
      qh_ack: 'Going — waiter call and bill request', qh_done: 'Done — call handled, bill brought', qh_confirm: 'Accept — new order from a tablet or phone',
      qh_served: 'Served — the kitchen cooked it, the waiter brought it', qh_paid: 'Paid — the bill is paid (money is better through the table card)', qh_close: 'Close table — everything is paid (better through the table card)',
      save: 'Save plan', saved: 'Plan saved — waiters will see it in a few seconds', unsaved: 'Unsaved changes', empty: 'No plan yet — add a zone', zone1: 'Hall' },
    th: { list: '☰ รายการ', floor: '▦ ผังร้าน', mine: 'โต๊ะของฉัน', attention: 'ต้องดูแล', fold: 'ซ่อน ▾', unfold: 'แสดง ▸', calm: 'เรียบร้อยดี 👌',
      unplaced: 'ไม่อยู่ในผัง', tables: 'โต๊ะ', yours: 'ของคุณ', min: 'นาที', table: 'โต๊ะ',
      st_free: 'ว่าง', st_busy: 'มีแขก', st_cook: 'กำลังทำ', st_call: 'เรียกพนักงาน', st_bill: 'ขอเช็คบิล', st_new: 'ออร์เดอร์ใหม่', st_ready: 'พร้อม — นำไปเสิร์ฟ', st_callAck: 'พนักงานกำลังไป', st_billAck: 'กำลังนำบิลไป', paidAll: 'ชำระแล้ว', carry: 'นำไป',
      q_ack: 'กำลังไป', q_done: 'เสร็จ', q_confirm: 'รับ', q_served: 'เสิร์ฟแล้ว', q_paid: 'ชำระแล้ว', q_close: 'ปิดโต๊ะ' },
    my: { list: '☰ စာရင်း', floor: '▦ ပုံစံ', mine: 'ကျွန်ုပ်၏ စားပွဲ', attention: 'ဂရုစိုက်ရန်', fold: 'ဖျောက် ▾', unfold: 'ပြ ▸', calm: 'အားလုံး အဆင်ပြေ 👌',
      unplaced: 'ပုံစံတွင် မပါ', tables: 'စားပွဲများ', yours: 'သင့်', min: 'မိနစ်', table: 'စားပွဲ',
      st_free: 'အားသည်', st_busy: 'ဧည့်သည်ရှိ', st_cook: 'ချက်နေသည်', st_call: 'စားပွဲထိုး ခေါ်', st_bill: 'ဘေလ် တောင်း', st_new: 'အော်ဒါ အသစ်', st_ready: 'အဆင်သင့် — ယူသွား', st_callAck: 'သွားနေပြီ', st_billAck: 'ဘေလ် ယူသွားနေ', paidAll: 'ပေးပြီး', carry: 'ယူသွား',
      q_ack: 'သွားမည်', q_done: 'ပြီးပြီ', q_confirm: 'လက်ခံ', q_served: 'ကျွေးပြီး', q_paid: 'ပေးပြီး', q_close: 'ပိတ်' },
  };
  let lang = 'ru';
  const t = (k) => (L[lang] && L[lang][k] !== undefined ? L[lang][k] : L.en[k] !== undefined ? L.en[k] : L.ru[k]);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem('jf:' + k); localStorage.setItem('jf:' + k, v); } catch { return null; } return null; };
  const short = (tb) => String(tb).replace(/^(стол|table|โต๊ะ|စားပွဲ)\s*/i, '') || String(tb);
  const money = (n) => '฿' + Math.round(n).toLocaleString('en');
  const mins = (ts) => Math.max(0, Math.floor((Date.now() - ts) / 60000));
  const ui = { zone: store('zone') || '', mine: store('mine') === '1', queue: store('queue') !== '0' };
  const RANK = { call: 0, bill: 1, new: 2, ready: 3, callAck: 4, billAck: 5 };
  const COLOR = { call: 'var(--f-call)', bill: 'var(--f-bill)', new: 'var(--f-new)', ready: 'var(--f-ready)', callAck: '#1f1a17', billAck: '#1f1a17' };

  // Что за столом: самое срочное дело, сколько ждут, кто идёт, сумма к оплате; следующая быстрая кнопка
  function stateOf(tb, s, flow, quick, many) {
    const calls = s.calls.filter((c) => c.table === tb);
    const orders = s.orders.filter((o) => o.table === tb && o.status !== 'rejected');
    const nc = calls.filter((c) => c.status === 'new'), ac = calls.filter((c) => c.status !== 'new');
    const pending = orders.filter((o) => o.status === 'pending');
    const ready = orders.filter((o) => o.status === 'confirmed' && o.readyAt && !o.servedAt);
    const cooking = orders.filter((o) => o.status === 'confirmed' && !o.readyAt && !o.servedAt);
    let total = 0, due = 0;
    for (const o of orders) for (const i of o.items) { total += i.price * i.qty; if (!i.paidAt && !o.paidAt) due += i.price * i.qty; }
    const first = (l, f) => Math.min(...l.map(f));
    let st = 'free', since = 0, who = '';
    if (nc.some((c) => c.type !== 'bill')) { st = 'call'; since = first(nc.filter((c) => c.type !== 'bill'), (c) => c.at); }
    else if (nc.length) { st = 'bill'; since = first(nc, (c) => c.at); }
    else if (pending.length) { st = 'new'; since = first(pending, (o) => o.at); }
    else if (ready.length) { st = 'ready'; since = first(ready, (o) => o.readyAt); }
    else if (ac.length) { st = ac.some((c) => c.type !== 'bill') ? 'callAck' : 'billAck'; who = ac[0].by || ''; }
    else if (cooking.length) { st = 'cook'; since = first(cooking, (o) => o.cookFrom || o.confirmedAt || o.at); }
    else if (orders.length || calls.length) st = 'busy';
    let q = null;
    if ((st === 'call' || st === 'bill') && quick.ack) q = 'ack';
    else if (st === 'new' && quick.confirm) q = 'confirm';
    else if (st === 'ready' && quick.served) q = 'served';
    else if ((st === 'callAck' || st === 'billAck') && quick.done) q = 'done';
    else if (st === 'cook' && !flow.kitchenScreen && quick.served) q = 'served'; // экрана кухни нет — «Подано» сразу
    else if (st === 'busy' && due > 0 && quick.paid && !many && !s.restaurant?.pos) q = 'paid';
    else if (st === 'busy' && due === 0 && total > 0 && quick.close) q = 'close';
    return { tb, st, since, who, due, total, q };
  }
  function sub(x) {
    if (x.st === 'call' || x.st === 'bill' || x.st === 'new') return `${x.st === 'call' ? '🔔' : x.st === 'bill' ? '🧾' : '🍽'} ${mins(x.since)}′`;
    if (x.st === 'ready') return `✅ ${t('carry')}`;
    if (x.st === 'callAck' || x.st === 'billAck') return `🤵 ${esc(String(x.who).split(' ')[0])}`;
    if (x.st === 'cook') return `🍳 ${mins(x.since)}′`;
    if (x.st === 'busy') return x.due ? money(x.due) : x.total ? `✓ ${t('paidAll')}` : '';
    return '';
  }
  const zonesOf = (floor) => (floor?.zones || []).filter((z) => z.tables.length || z.decor.length);
  const rowsOf = (z, extra = 0) => Math.max(1, ...z.tables.map((x) => x.y + x.h), ...z.decor.map((x) => x.y + x.h)) + extra;

  // Схема зоны: клетка — по ширине экрана; tiles(x) — кнопка стола с подписью и быстрой кнопкой
  const decorDef = (d, i, style) => `<div class="fdecor" style="${style}">${esc(d.text)}</div>`;
  function planHtml(z, width, k, tile, decor = decorDef, extraRows = 0, cls = '') {
    const cell = Math.max(38, Math.floor((width / z.cols) * k)), gap = 6, rows = rowsOf(z, extraRows);
    const box = (o) => `left:${o.x * cell + gap / 2}px;top:${o.y * cell + gap / 2}px;width:${o.w * cell - gap}px;height:${o.h * cell - gap}px`;
    return `<div class="fplan ${cls}" style="width:${cell * z.cols}px;height:${cell * rows}px;--cell:${cell}px">`
      + z.decor.map((d, i) => decor(d, i, box(d))).join('')
      + z.tables.map((x) => tile(x, box(x))).join('') + '</div>';
  }

  // ---------- экран официанта ----------
  function view(el, ctx) {
    lang = ctx.lang || 'ru';
    const { s, flow, many } = ctx, quick = s.floor?.quick || {}, zones = zonesOf(s.floor), all = s.restaurant.tables || [];
    const st = Object.fromEntries(all.map((tb) => [tb, stateOf(tb, s, flow, quick, many(tb))]));
    const mineSet = new Set(s.myTables || all), showMine = mineSet.size < all.length;
    const placed = new Set(zones.flatMap((z) => z.tables.map((x) => x.t)));
    const zoneOfT = (tb) => zones.find((z) => z.tables.some((x) => x.t === tb))?.name || '';
    if (!zones.some((z) => z.id === ui.zone)) ui.zone = zones[0]?.id || '';
    const z = zones.find((x) => x.id === ui.zone);
    const urgent = (tb) => st[tb] && RANK[st[tb].st] !== undefined && st[tb].st !== 'callAck' && st[tb].st !== 'billAck';
    const chip = (x) => (x.q ? `<span class="fchip" role="button" data-fq="${x.q}" data-ftab="${esc(x.tb)}">${t('q_' + x.q)}</span>` : '');
    const tileCls = (x) => `ftile ${x.st}${['call', 'bill', 'new'].includes(x.st) && mins(x.since) >= 5 ? ' late' : ''}${ui.mine && showMine ? (mineSet.has(x.tb) ? ' fmine' : ' fdim') : ''}`;
    const tile = (p, style) => {
      const x = st[p.t] || stateOf(p.t, s, flow, quick, false);
      return `<button class="${tileCls(x)}${p.sh === 'rd' ? ' rd' : ''}${x.q ? ' hasq' : ''}" style="${style}" data-ftab="${esc(p.t)}"><span class="fn${short(p.t).length > 3 ? ' sm' : ''}">${esc(short(p.t))}</span><span class="fs">${sub(x)}</span>${chip(x)}</button>`;
    };
    const flat = (list) => `<div class="fgrid">${list.map((tb) => { const x = st[tb]; return `<button class="${tileCls(x)}" data-ftab="${esc(tb)}"><span class="fn${short(tb).length > 3 ? ' sm' : ''}">${esc(short(tb))}</span><span class="fs">${sub(x) || t('st_free')}</span>${chip(x)}</button>`; }).join('')}</div>`;
    let html = '';
    if (zones.length) {
      html += `<div class="fzones">${zones.map((x) => { const n = x.tables.filter((p) => urgent(p.t)).length; return `<button class="${x.id === ui.zone ? 'on' : ''}" data-fzone="${esc(x.id)}">${esc(x.name)}${n ? `<span class="fcnt">${n}</span>` : ''}</button>`; }).join('')}
        ${showMine ? `<button class="fminebtn${ui.mine ? ' on' : ''}" data-fmine="1">${ui.mine ? '✓ ' : ''}${t('mine')}</button>` : ''}</div>`;
      const W = Math.min(el.clientWidth || 360, 560);
      html += `<div class="fplanwrap">${planHtml(z, W, ui.queue ? 0.8 : 1, tile, decorDef, 0, ui.queue ? 'compact' : '')}</div>`;
      const rest = all.filter((tb) => !placed.has(tb));
      if (rest.length) html += `<div class="fzh">${t('unplaced')}</div>${flat(rest)}`;
    } else {
      html += showMine ? `<div class="fzones"><span class="fzh" style="margin:0">${t('tables')}</span><button class="fminebtn${ui.mine ? ' on' : ''}" data-fmine="1">${ui.mine ? '✓ ' : ''}${t('mine')}</button></div>` : '';
      html += flat(all);
    }
    // «Требует внимания»: дела из всех зон по срочности; сворачивается — остаётся одна схема
    const items = Object.values(st).filter((x) => RANK[x.st] !== undefined).sort((a, b) => RANK[a.st] - RANK[b.st] || (a.since || 0) - (b.since || 0));
    if (zones.length) {
      html += `<div class="fqueue"><div class="fqh"><b>${t('attention')} · ${items.length}</b><button data-fqueue="1">${ui.queue ? t('fold') : t('unfold')}</button></div>`;
      if (ui.queue) html += items.length ? items.map((x) => `<div class="frow" data-ftab="${esc(x.tb)}"><span class="fdot" style="background:${COLOR[x.st]}">${esc(short(x.tb))}</span>
          <span class="ftx"><b>${t('st_' + x.st)}</b>${['call', 'bill', 'new'].includes(x.st) ? ` · ${mins(x.since)} ${t('min')}` : x.who ? ` · ${esc(x.who)}` : ''}<small>${esc([zoneOfT(x.tb), ctx.tbl(x.tb)].filter(Boolean).join(' · '))}${mineSet.has(x.tb) && showMine ? ` · ${t('yours')}` : ''}</small></span>
          ${x.q ? `<button data-fq="${x.q}" data-ftab="${esc(x.tb)}">${t('q_' + x.q)}</button>` : ''}</div>`).join('') : `<p class="empty">${t('calm')}</p>`;
      html += '</div>';
    }
    el.innerHTML = html;
    el.onclick = (e) => {
      const q = e.target.closest('[data-fq]');
      if (q) { e.stopPropagation(); return ctx.onAct(q.dataset.ftab, q.dataset.fq, st[q.dataset.ftab]); }
      const zb = e.target.closest('[data-fzone]');
      if (zb) { ui.zone = zb.dataset.fzone; store('zone', ui.zone); return ctx.refresh(); }
      if (e.target.closest('[data-fmine]')) { ui.mine = !ui.mine; store('mine', ui.mine ? '1' : '0'); return ctx.refresh(); }
      if (e.target.closest('[data-fqueue]')) { ui.queue = !ui.queue; store('queue', ui.queue ? '1' : '0'); return ctx.refresh(); }
      const tb = e.target.closest('[data-ftab]');
      if (tb) ctx.onOpen(tb.dataset.ftab);
    };
  }

  // ---------- редактор менеджера ----------
  const ed = { rid: null, draft: null, sel: null, zone: null, mode: 'edit', dirty: false, drag: null, msg: '' };
  const uid = () => Math.random().toString(36).slice(2, 8);
  function editor(el, ctx) {
    lang = ctx.lang || 'ru';
    if (ed.drag) return; // тащат стол — не перерисовываем
    if (ed.rid !== ctx.rid || !ed.draft) {
      ed.rid = ctx.rid; ed.draft = JSON.parse(JSON.stringify(ctx.floor || { zones: [], quick: {} })); ed.sel = null; ed.dirty = false;
      if (!ed.draft.zones.length) ed.draft.zones.push({ id: uid(), name: t('zone1'), cols: 6, tables: [], decor: [] });
    }
    const f = ed.draft;
    if (!f.zones.some((z) => z.id === ed.zone)) ed.zone = f.zones[0]?.id || null;
    const z = f.zones.find((x) => x.id === ed.zone);
    const placed = new Set(f.zones.flatMap((x) => x.tables.map((p) => p.t)));
    const rest = (ctx.tables || []).filter((tb) => !placed.has(tb));
    const selT = z?.tables.find((p) => 't:' + p.t === ed.sel), selD = z?.decor[Number(String(ed.sel).slice(2))] && String(ed.sel).startsWith('d:') ? z.decor[Number(String(ed.sel).slice(2))] : null;
    const W = 342; // ширина экрана телефона минус поля — редактор показывает схему как у официанта
    let html = `<div class="ed"><b>${t('edTitle')}</b><span class="empty">${t('edHint')}</span></div>
      <div class="fedwrap"><div class="fphone" aria-label="${esc(t('edPhone'))}">
      <div class="fzones">${f.zones.map((x) => `<button class="${x.id === ed.zone ? 'on' : ''}" data-ezone="${esc(x.id)}">${esc(x.name)}</button>`).join('')}<button class="fminebtn" data-ezadd="1">${t('zoneAdd')}</button></div>
      <div class="fseg"><button class="${ed.mode === 'edit' ? 'on' : ''}" data-emode="edit">${t('edit')}</button><button class="${ed.mode === 'preview' ? 'on' : ''}" data-emode="preview">${t('preview')}</button></div>`;
    if (z && ed.mode === 'edit') {
      html += `<div class="fzrow"><input id="fzName" data-ezname="1" value="${esc(z.name)}" maxlength="20" aria-label="${esc(t('zoneName'))}">
        <label>${t('cols')} <select data-ecols="1">${[4, 5, 6, 7, 8].map((n) => `<option ${n === z.cols ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="ghostbtn" data-ezdel="1">${t('zoneDel')}</button></div>`;
      html += planHtml(z, W, 1, (p, style) => `<div class="ftile busy${p.sh === 'rd' ? ' rd' : ''}${ed.sel === 't:' + p.t ? ' fsel' : ''}" style="${style}" data-et="${esc(p.t)}"><span class="fn${short(p.t).length > 3 ? ' sm' : ''}">${esc(short(p.t))}</span></div>`,
        (d, i, style) => `<div class="fdecor${ed.sel === 'd:' + i ? ' fsel' : ''}" style="${style}" data-ed="${i}">${esc(d.text)}</div>`, 2, 'fedit');
    } else if (z) html += '<div class="fprev"></div>'; // заполняется ниже — тем же кодом, что у официанта
    html += '</div><div class="fside">';
    if (ed.mode === 'edit' && z) {
      html += selT ? `<div class="ftool"><b>${esc(ctx.tbl(selT.t))}:</b><button class="${selT.sh !== 'rd' ? 'on' : ''}" data-esh="sq">${t('square')}</button><button class="${selT.sh === 'rd' ? 'on' : ''}" data-esh="rd">${t('round')}</button>
          <button data-ew="1">${t('wider')}</button><button data-ew="-1">${t('narrower')}</button><button data-eh="1">${t('taller')}</button><button data-eh="-1">${t('lower')}</button><button data-eun="1">${t('unplace')}</button></div>`
        : selD ? `<div class="ftool"><input data-etext="1" value="${esc(selD.text)}" maxlength="14" aria-label="${esc(t('label'))}" style="width:120px">
          <button data-ew="1">${t('wider')}</button><button data-ew="-1">${t('narrower')}</button><button data-eh="1">${t('taller')}</button><button data-eh="-1">${t('lower')}</button><button data-edel="1">${t('delDecor')}</button></div>`
        : `<p class="empty">${t('pick')}</p>`;
      html += `<div class="ftool"><b>${t('unplaced')}:</b> ${rest.map((tb) => `<button class="fput" data-eput="${esc(tb)}">${esc(short(tb))}</button>`).join('') || '—'}</div>
        <div class="ftool"><b>${t('addDecor')}</b> ${t('decor').map((d) => `<button data-eadd="${esc(d)}">${esc(d)}</button>`).join('')}</div>`;
    }
    html += `<div class="ed"><b>${t('quickT')}</b><span class="empty">${t('quickHint')}</span>
      ${['ack', 'done', 'confirm', 'served', 'paid', 'close'].map((k) => `<label class="fq"><input type="checkbox" id="fq-${k}" data-eq="${k}" ${f.quick?.[k] ? 'checked' : ''}> ${t('qh_' + k)}</label>`).join('')}</div>
      <div class="bar"><button data-esave="1">${t('save')}</button><span class="${ed.dirty ? 'due' : 'pok'}">${ed.msg || (ed.dirty ? t('unsaved') : '')}</span></div></div></div>`;
    el.innerHTML = html;
    // «Как у официанта»: тот же экран, что у официанта, с живыми вызовами и заказами — по черновику схемы
    if (ed.mode === 'preview') { const pv = el.querySelector('.fprev'); ui.zone = ed.zone; if (pv && ctx.state) view(pv, { ...ctx.viewCtx, s: { ...ctx.state, floor: { zones: f.zones, quick: f.quick } }, refresh: () => editor(el, ctx), onAct() {}, onOpen() {} }); }
    const redraw = () => { ed.dirty = true; ed.msg = ''; editor(el, ctx); };
    const free = (o, skip) => o.x >= 0 && o.y >= 0 && o.x + o.w <= z.cols
      && ![...z.tables, ...z.decor].some((p) => p !== skip && o.x < p.x + p.w && p.x < o.x + o.w && o.y < p.y + p.h && p.y < o.y + o.h);
    const firstFree = (w, h) => { for (let y = 0; y < 60; y++) for (let x = 0; x + w <= z.cols; x++) if (free({ x, y, w, h })) return { x, y }; return null; };
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const d = b.dataset;
      if (d.ezone) { ed.zone = d.ezone; ed.sel = null; return editor(el, ctx); }
      if (d.emode) { ed.mode = d.emode; return editor(el, ctx); }
      if (d.ezadd) { const nz = { id: uid(), name: `${t('zone1')} ${f.zones.length + 1}`, cols: 6, tables: [], decor: [] }; f.zones.push(nz); ed.zone = nz.id; return redraw(); }
      if (d.ezdel) { if (!confirm(t('zoneDelAsk').replace('{n}', z.name))) return; f.zones.splice(f.zones.indexOf(z), 1); ed.zone = null; ed.sel = null; return redraw(); }
      if (d.esh && selT) { selT.sh = d.esh; return redraw(); }
      const target = selT || selD;
      if ((d.ew || d.eh) && target) {
        const o = { ...target, w: Math.max(1, Math.min(z.cols, target.w + Number(d.ew || 0))), h: Math.max(1, Math.min(8, target.h + Number(d.eh || 0))) };
        if (free(o, target)) Object.assign(target, o); return redraw();
      }
      if (d.eun && selT) { z.tables.splice(z.tables.indexOf(selT), 1); ed.sel = null; return redraw(); }
      if (d.edel && selD) { z.decor.splice(z.decor.indexOf(selD), 1); ed.sel = null; return redraw(); }
      if (d.eput) { const p = firstFree(1, 1); if (!p) return alert(t('noRoom')); z.tables.push({ t: d.eput, ...p, w: 1, h: 1, sh: 'sq' }); ed.sel = 't:' + d.eput; return redraw(); }
      if (d.eadd) { const p = firstFree(1, 1); if (!p) return alert(t('noRoom')); z.decor.push({ ...p, w: 1, h: 1, text: d.eadd }); ed.sel = 'd:' + (z.decor.length - 1); return redraw(); }
      if (d.esave) {
        try { await ctx.onSave(f); ed.dirty = false; ed.msg = t('saved'); } catch (err) { ed.msg = err.message || String(err); }
        return editor(el, ctx);
      }
    };
    el.onchange = (e) => {
      const d = e.target.dataset;
      if (d.eq) { f.quick = { ...f.quick, [d.eq]: e.target.checked }; ed.dirty = true; ed.msg = ''; return; }
      if (d.ecols) { const n = Number(e.target.value); if (z.tables.every((p) => p.x + p.w <= n) && z.decor.every((p) => p.x + p.w <= n)) z.cols = n; return redraw(); }
    };
    el.oninput = (e) => {
      const d = e.target.dataset;
      if (d.ezname) { z.name = e.target.value; ed.dirty = true; el.querySelector(`[data-ezone="${CSS.escape(z.id)}"]`).textContent = z.name; }
      if (d.etext && selD) { selD.text = e.target.value; ed.dirty = true; const n = el.querySelector(`[data-ed="${z.decor.indexOf(selD)}"]`); if (n) n.textContent = selD.text; }
    };
    // перетаскивание: стол или надпись встаёт в ближайшую свободную клетку
    const plan = el.querySelector('.fedit');
    if (!plan) return;
    plan.onpointerdown = (e) => {
      const n = e.target.closest('[data-et], [data-ed]'); if (!n) return;
      const o = n.dataset.et !== undefined ? z.tables.find((p) => p.t === n.dataset.et) : z.decor[Number(n.dataset.ed)];
      ed.sel = n.dataset.et !== undefined ? 't:' + n.dataset.et : 'd:' + n.dataset.ed;
      const cell = plan.clientWidth / z.cols, r = plan.getBoundingClientRect();
      ed.drag = { o, n, cell, r, dx: e.clientX - r.left - o.x * cell, dy: e.clientY - r.top - o.y * cell, moved: false, to: null };
      n.setPointerCapture?.(e.pointerId); n.classList.add('fsel');
      e.preventDefault();
    };
    plan.onpointermove = (e) => {
      const g = ed.drag; if (!g) return;
      const px = e.clientX - g.r.left - g.dx, py = e.clientY - g.r.top - g.dy;
      if (Math.abs(px - g.o.x * g.cell) + Math.abs(py - g.o.y * g.cell) > 4) g.moved = true;
      g.n.style.left = px + 'px'; g.n.style.top = py + 'px';
      const x = Math.round(px / g.cell), y = Math.round(py / g.cell);
      g.to = free({ ...g.o, x, y }, g.o) ? { x, y } : null;
    };
    const end = () => { const g = ed.drag; if (!g) return; ed.drag = null; if (g.moved && g.to) { Object.assign(g.o, g.to); ed.dirty = true; ed.msg = ''; } editor(el, ctx); };
    plan.onpointerup = end; plan.onpointercancel = end;
  }

  const css = `:root{--f-call:#d63a2a;--f-bill:#7a3fa3;--f-new:#e8870c;--f-ready:#2e7d32;--f-cook:#b7791f}
.fzones{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 6px}.fzones button{border:0;background:#efe7df;color:#1f1a17;border-radius:999px;padding:6px 12px;font-size:14px;font-weight:600;display:inline-flex;gap:6px;align-items:center}
.fzones button.on{background:#1f1a17;color:#fff}.fcnt{background:var(--f-call);color:#fff;border-radius:999px;font-size:11px;min-width:18px;height:18px;display:inline-grid;place-items:center;padding:0 5px}
.fzones .fminebtn{margin-left:auto;background:transparent;border:1px solid #d9cdc1;font-size:13px}.fzones .fminebtn.on{background:#fff;border-color:#1f1a17;color:#1f1a17}
.fplanwrap{overflow-x:auto;padding-bottom:16px}.fplan{position:relative;margin:4px auto 0}
.ftile{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:12px;border:2px solid #d9cdc1;background:#fff;color:#1f1a17;padding:0;line-height:1.1;cursor:pointer;touch-action:manipulation;font:inherit;user-select:none;-webkit-user-select:none}
.ftile.rd{border-radius:50%}.ftile .fn{font-size:17px;font-weight:800}.ftile .fn.sm{font-size:13px}.ftile .fs{font-size:11px;font-weight:600;margin-top:2px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.compact .ftile .fs{display:none}.compact .ftile .fn{font-size:15px}
.ftile.free{background:transparent;border-style:dashed;color:#8a7f76}.ftile.cook{border-color:var(--f-cook)}.ftile.cook .fs{color:var(--f-cook)}
.ftile.call,.ftile.bill,.ftile.new,.ftile.ready{color:#fff}.ftile.call{background:var(--f-call);border-color:var(--f-call)}.ftile.bill{background:var(--f-bill);border-color:var(--f-bill)}
.ftile.new{background:var(--f-new);border-color:var(--f-new)}.ftile.ready{background:var(--f-ready);border-color:var(--f-ready)}
.ftile.callAck{border:3px solid var(--f-call)}.ftile.billAck{border:3px solid var(--f-bill)}
.ftile.call::after,.ftile.new::after{content:"";position:absolute;inset:-6px;border-radius:inherit;border:3px solid var(--f-call);opacity:0;animation:fring 1.6s ease-out infinite;pointer-events:none}.ftile.new::after{border-color:var(--f-new)}
@keyframes fring{0%{opacity:.7;transform:scale(.92)}100%{opacity:0;transform:scale(1.12)}}@media (prefers-reduced-motion:reduce){.ftile.call::after,.ftile.new::after{animation:none;opacity:.6}}
.ftile.late .fs::before{content:"⚠ "}.ftile.fdim{opacity:.35}.ftile.fmine{box-shadow:0 0 0 2px #1f1a17}
.fchip{position:absolute;left:50%;bottom:-11px;transform:translateX(-50%);background:#1f1a17;color:#fff;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;border:2px solid #f5f0ea;white-space:nowrap;z-index:2}
.fchip::before{content:"";position:absolute;inset:-10px -8px}
.fplan .ftile.hasq{justify-content:flex-start;padding-top:4px}.fplan .fchip{font-size:11px;padding:3px 8px;bottom:-10px}.fplan .ftile.hasq .fs{margin-top:0}
.fdecor{position:absolute;border-radius:10px;background:repeating-linear-gradient(135deg,#efe7df 0 6px,transparent 6px 12px);border:1px solid #d9cdc1;color:#8a7f76;font-size:11px;font-weight:700;display:grid;place-items:center;text-transform:uppercase;letter-spacing:.05em;text-align:center;overflow:hidden}
.fzh{font-size:12px;font-weight:700;color:#8a7f76;text-transform:uppercase;letter-spacing:.05em;margin:10px 2px 4px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:4px 0 12px}.fgrid .ftile{position:relative;height:84px;border-radius:14px}
.fgrid .fchip{position:static;transform:none;margin-top:6px;border:0}.fgrid .ftile .fn{font-size:20px}
.fqueue{margin-top:6px}.fqh{display:flex;justify-content:space-between;align-items:center;margin:6px 0}.fqh b{font-size:13px;color:#8a7f76;text-transform:uppercase;letter-spacing:.05em}
.fqh button{background:transparent;color:#8a7f76;padding:4px 0;font-size:13px}
.frow{display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:8px 10px;margin-bottom:8px;cursor:pointer}
.fdot{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px;flex:none}
.ftx{flex:1;min-width:0;font-size:15px}.ftx small{display:block;color:#8a7f76;font-size:12px}.frow button{flex:none}
.fseg{display:inline-flex;background:#efe7df;border-radius:10px;padding:3px;margin:4px 0 8px}.fseg button{background:transparent;color:#8a7f76;padding:6px 12px;font-size:13px;border-radius:8px}.fseg button.on{background:#fff;color:#1f1a17;font-weight:700}
.fedwrap{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}.fside{flex:1;min-width:260px}
.fphone{width:100%;max-width:390px;box-sizing:border-box;padding:10px 12px;background:#f5f0ea;border-radius:16px}
@media (min-width:700px){.fphone{border:10px solid #1d1a18;border-radius:30px;min-height:560px}}
.fedit{background-color:#fff;background-image:linear-gradient(#e6ddd3 1px,transparent 1px),linear-gradient(90deg,#e6ddd3 1px,transparent 1px);background-size:var(--cell) var(--cell);border:1px solid #d9cdc1;border-radius:8px}
.fedit .ftile,.fedit .fdecor{cursor:grab;touch-action:none}.fsel{outline:3px solid var(--f-new);outline-offset:2px;z-index:3}
.fzrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px;font-size:13px}.fzrow input{width:140px}.fzrow select{width:auto}
.ftool{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:14px}.ftool button{padding:7px 10px;font-size:13px;background:#efe7df;color:#1f1a17}.ftool button.on{background:#1f1a17;color:#fff}
.ftool .fput{border:2px dashed #d9cdc1;background:transparent;font-weight:700}
label.fq{display:flex!important;flex-direction:row;gap:10px;align-items:flex-start;margin:10px 0;font-size:14px}label.fq input{width:20px!important;height:20px;flex:none;margin:0}`;
  const tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag);
  window.JetFloor = { view, editor, stateOf, sig: () => `${ui.zone}|${ui.mine}|${ui.queue}`, resetEditor: () => { ed.draft = null; } };
})();
