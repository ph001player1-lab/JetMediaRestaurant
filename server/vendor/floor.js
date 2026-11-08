// Схема зала: вид «Схема» в приложении официанта и редактор схемы в ЛК менеджера.
// Схема — в клетках (а не в пикселях): зона N клеток в ширину растягивается на любой телефон.
// Нет схемы — столы плитками. Быстрые кнопки под столами — какие разрешил менеджер.
// JetFloor.view(el, ctx) — экран официанта; JetFloor.editor(el, ctx) — редактор; JetFloor.sig() — состояние для перерисовки
(() => {
  const L = {
    ru: { list: '☰ Список', floor: '▦ Схема', mine: 'Мои столы', attention: 'Требует внимания', fold: 'свернуть ▾', unfold: 'развернуть ▸', calm: 'Всё спокойно 👌',
      unplaced: 'Не на схеме', tables: 'Столы', yours: 'ваш', min: 'мин', table: 'стол',
      st_free: 'свободен', st_busy: 'гости', st_cook: 'готовится', st_call: 'Вызов официанта', st_bill: 'Просят счёт', st_new: 'Новый заказ', st_ready: 'Готово — нести', st_callAck: 'Официант идёт', st_billAck: 'Несут счёт', paidAll: 'оплачен', carry: 'нести',
      q_ack: 'Иду', q_done: 'Готово', q_confirm: 'Принять', q_kitchen: 'На кухню', q_served: 'Подано', q_paid: 'Оплачен', q_close: 'Закрыть',
      st_tokitchen: 'Заказ не отдан на кухню',
      st_pay: 'Гости за столом', st_close: 'Всё оплачено', allFree: 'Все столы свободны', due: 'к оплате', later: 'Дальше по столам',
      need_pay: 'Взять оплату', need_close: 'Закрыть стол — всё оплачено', need_void: 'Закрыть стол — заказ отменён', st_void: 'Заказ отменён', voided: 'отменён', need_closePos: 'Закрыть стол после оплаты в кассе',
      lb_free: 'свободен', lb_call: 'вызов {m}′', lb_bill: 'счёт {m}′', lb_new: 'новый заказ', lb_tokitchen: 'отдать на кухню', lb_ready: 'нести', lb_ack: 'идёт {n}',
      lb_cook: 'ждём кухню {m}′', lb_pay: 'взять оплату', lb_close: 'закрыть стол', todo: 'Нужно сделать', atKitchen: 'На кухне', yourMove: 'ваш ход',
      need_call: 'Подойти к гостю', need_bill: 'Принести счёт', need_new: 'Подтвердить заказ', need_tokitchen: 'Отдать заказ на кухню', need_ready: 'Отнести — блюда готовы',
      need_callAck: 'Идёт {n} — потом «Готово»', need_billAck: 'Счёт несёт {n} — потом «Готово»', need_cook: 'Ждём кухню', need_cookNoScreen: 'Когда отнесёте — «Подано»',
      qh_kitchen: 'На кухню — заказ отдали на кухню (если нет экрана кухни)',
      edTitle: 'Схема зала', edHint: 'Расставьте столы как в зале: тащите пальцем или мышью, стол встанет в клетку. Нажмите на стол — внизу форма и размер. Официанты видят схему в приложении (вид «Схема»). Пока схемы нет — столы у них плитками.',
      edPhone: 'Так схема выглядит на телефоне официанта', zoneAdd: '+ Зона', zoneName: 'Название зоны', cols: 'Клеток в ширину', zoneDel: 'Удалить зону', zoneDelAsk: 'Удалить зону «{n}»? Её столы вернутся в «Не на схеме».',
      edit: 'Правка', preview: 'Как у официанта', pick: 'Нажмите на стол или надпись, чтобы изменить. Столы из «Не на схеме» — нажмите, чтобы поставить.',
      square: '□ Квадрат', round: '○ Круг', wider: 'Шире', narrower: 'Уже', taller: 'Выше', lower: 'Ниже', unplace: 'Убрать со схемы', delDecor: 'Удалить', label: 'Надпись',
      addDecor: 'Добавить надпись:', trHint: 'Перевод для официантов (пусто — как написано):', customLabel: 'Своя надпись', newLabel: 'Надпись', ghostTable: 'Стол без планшета', tableNo: 'Номер стола',
      ghostNote: 'Стол без планшета — только рисунок на схеме: серый, пунктиром, без вызовов и заказов. Номер — любой текст.', ghostHint: 'Стол без планшета', decor: ['Бар', 'Вход', 'Касса', 'Кухня', 'Окно', 'Стена'], noRoom: 'В зоне нет свободной клетки — сделайте зону шире или уберите стол',
      quickT: 'Быстрые кнопки на схеме', quickHint: 'Что официант делает прямо со схемы, не открывая стол. Остальное — в карточке стола.',
      qh_ack: 'Иду — вызов официанта и просьба счёта', qh_done: 'Готово — вызов выполнен, счёт отнесли', qh_confirm: 'Принять — новый заказ с планшета или телефона',
      qh_served: 'Подано — кухня приготовила, официант отнёс', qh_paid: 'Оплачен — счёт оплачен (деньги — лучше через карточку стола)', qh_close: 'Закрыть стол — всё оплачено (лучше через карточку стола)',
      save: 'Сохранить схему', saved: 'Схема сохранена — официанты увидят её через несколько секунд', unsaved: 'Есть несохранённые изменения', empty: 'Схемы пока нет — добавьте зону', zone1: 'Зал' },
    en: { list: '☰ List', floor: '▦ Floor', mine: 'My tables', attention: 'Needs attention', fold: 'hide ▾', unfold: 'show ▸', calm: 'All calm 👌',
      unplaced: 'Not on the plan', tables: 'Tables', yours: 'yours', min: 'min', table: 'table',
      st_free: 'free', st_busy: 'guests', st_cook: 'cooking', st_call: 'Waiter call', st_bill: 'Bill requested', st_new: 'New order', st_ready: 'Ready — carry it', st_callAck: 'Waiter on the way', st_billAck: 'Bringing the bill', paidAll: 'paid', carry: 'carry',
      q_ack: 'Going', q_done: 'Done', q_confirm: 'Accept', q_kitchen: 'To kitchen', q_served: 'Served', q_paid: 'Paid', q_close: 'Close',
      st_tokitchen: 'Order not in the kitchen yet',
      st_pay: 'Guests at the table', st_close: 'All paid', allFree: 'All tables are free', due: 'to pay', later: 'Next at the tables',
      need_pay: 'Take the payment', need_close: 'Close the table — all paid', need_void: 'Close the table — order cancelled', st_void: 'Order cancelled', voided: 'cancelled', need_closePos: 'Close the table after payment at the cashier',
      lb_free: 'free', lb_call: 'call {m}′', lb_bill: 'bill {m}′', lb_new: 'new order', lb_tokitchen: 'to kitchen', lb_ready: 'carry', lb_ack: '{n} going',
      lb_cook: 'kitchen {m}′', lb_pay: 'take payment', lb_close: 'close table', todo: 'To do', atKitchen: 'In the kitchen', yourMove: 'your move',
      need_call: 'Go to the guest', need_bill: 'Bring the bill', need_new: 'Confirm the order', need_tokitchen: 'Pass the order to the kitchen', need_ready: 'Carry it — the food is ready',
      need_callAck: '{n} is going — then “Done”', need_billAck: '{n} brings the bill — then “Done”', need_cook: 'Waiting for the kitchen', need_cookNoScreen: 'When you bring it — “Served”',
      qh_kitchen: 'To kitchen — the order was passed to the kitchen (when there is no kitchen screen)',
      edTitle: 'Floor plan', edHint: 'Place the tables as in the room: drag with a finger or mouse, a table snaps to the grid. Tap a table to change its shape and size. Waiters see the plan in the app (“Floor” view). Without a plan they see tables as tiles.',
      edPhone: 'This is how the plan looks on a waiter’s phone', zoneAdd: '+ Zone', zoneName: 'Zone name', cols: 'Cells across', zoneDel: 'Delete zone', zoneDelAsk: 'Delete zone “{n}”? Its tables go back to “Not on the plan”.',
      edit: 'Edit', preview: 'Waiter’s view', pick: 'Tap a table or a label to change it. Tap a table under “Not on the plan” to place it.',
      square: '□ Square', round: '○ Round', wider: 'Wider', narrower: 'Narrower', taller: 'Taller', lower: 'Lower', unplace: 'Remove from plan', delDecor: 'Delete', label: 'Label',
      addDecor: 'Add a label:', trHint: 'Translation for waiters (empty — as written):', customLabel: 'Custom label', newLabel: 'Label', ghostTable: 'Table without a tablet', tableNo: 'Table number',
      ghostNote: 'A table without a tablet is only a drawing on the plan: grey, dashed, no calls or orders. The number is any text.', ghostHint: 'Table without a tablet', decor: ['Bar', 'Entrance', 'Cashier', 'Kitchen', 'Window', 'Wall'], noRoom: 'No free cell in this zone — make it wider or remove a table',
      quickT: 'Quick buttons on the plan', quickHint: 'What a waiter does right on the plan, without opening the table. Everything else is in the table card.',
      qh_ack: 'Going — waiter call and bill request', qh_done: 'Done — call handled, bill brought', qh_confirm: 'Accept — new order from a tablet or phone',
      qh_served: 'Served — the kitchen cooked it, the waiter brought it', qh_paid: 'Paid — the bill is paid (money is better through the table card)', qh_close: 'Close table — everything is paid (better through the table card)',
      save: 'Save plan', saved: 'Plan saved — waiters will see it in a few seconds', unsaved: 'Unsaved changes', empty: 'No plan yet — add a zone', zone1: 'Hall' },
    th: { list: '☰ รายการ', floor: '▦ ผังร้าน', mine: 'โต๊ะของฉัน', attention: 'ต้องดูแล', fold: 'ซ่อน ▾', unfold: 'แสดง ▸', calm: 'เรียบร้อยดี 👌',
      unplaced: 'ไม่อยู่ในผัง', tables: 'โต๊ะ', yours: 'ของคุณ', min: 'นาที', table: 'โต๊ะ',
      st_free: 'ว่าง', st_busy: 'มีแขก', st_cook: 'กำลังทำ', st_call: 'เรียกพนักงาน', st_bill: 'ขอเช็คบิล', st_new: 'ออร์เดอร์ใหม่', st_ready: 'พร้อม — นำไปเสิร์ฟ', st_callAck: 'พนักงานกำลังไป', st_billAck: 'กำลังนำบิลไป', paidAll: 'ชำระแล้ว', carry: 'นำไป',
      q_ack: 'กำลังไป', q_done: 'เสร็จ', q_confirm: 'รับ', q_kitchen: 'ส่งครัว', q_served: 'เสิร์ฟแล้ว', q_paid: 'ชำระแล้ว', q_close: 'ปิดโต๊ะ', decor: ['บาร์', 'ทางเข้า', 'แคชเชียร์', 'ครัว', 'หน้าต่าง', 'ผนัง'],
      st_tokitchen: 'ออร์เดอร์ยังไม่ถึงครัว',
      st_pay: 'แขกอยู่ที่โต๊ะ', st_close: 'ชำระครบแล้ว', allFree: 'ทุกโต๊ะว่าง', due: 'ค้างชำระ', later: 'ต่อไปที่โต๊ะ',
      need_pay: 'รับชำระเงิน', need_close: 'ปิดโต๊ะ — ชำระครบแล้ว', need_void: 'ปิดโต๊ะ — ออเดอร์ถูกยกเลิก', st_void: 'ออเดอร์ถูกยกเลิก', voided: 'ยกเลิก', need_closePos: 'ปิดโต๊ะหลังชำระที่แคชเชียร์',
      lb_free: 'ว่าง', lb_call: 'เรียก {m}′', lb_bill: 'บิล {m}′', lb_new: 'ออร์เดอร์ใหม่', lb_tokitchen: 'ส่งครัว', lb_ready: 'นำไป', lb_ack: '{n} ไปแล้ว',
      lb_cook: 'รอครัว {m}′', lb_pay: 'รับเงิน', lb_close: 'ปิดโต๊ะ', todo: 'ต้องทำ', atKitchen: 'ในครัว', yourMove: 'ตาคุณ',
      need_call: 'ไปหาแขก', need_bill: 'นำบิลไป', need_new: 'ยืนยันออร์เดอร์', need_tokitchen: 'ส่งออร์เดอร์เข้าครัว', need_ready: 'นำไปเสิร์ฟ — อาหารพร้อม',
      need_callAck: '{n} กำลังไป — แล้วกด “เสร็จ”', need_billAck: '{n} นำบิลไป — แล้วกด “เสร็จ”', need_cook: 'รอครัว', need_cookNoScreen: 'เสิร์ฟแล้วกด “เสิร์ฟแล้ว”' },
    my: { list: '☰ စာရင်း', floor: '▦ ပုံစံ', mine: 'ကျွန်ုပ်၏ စားပွဲ', attention: 'ဂရုစိုက်ရန်', fold: 'ဖျောက် ▾', unfold: 'ပြ ▸', calm: 'အားလုံး အဆင်ပြေ 👌',
      unplaced: 'ပုံစံတွင် မပါ', tables: 'စားပွဲများ', yours: 'သင့်', min: 'မိနစ်', table: 'စားပွဲ',
      st_free: 'အားသည်', st_busy: 'ဧည့်သည်ရှိ', st_cook: 'ချက်နေသည်', st_call: 'စားပွဲထိုး ခေါ်', st_bill: 'ဘေလ် တောင်း', st_new: 'အော်ဒါ အသစ်', st_ready: 'အဆင်သင့် — ယူသွား', st_callAck: 'သွားနေပြီ', st_billAck: 'ဘေလ် ယူသွားနေ', paidAll: 'ပေးပြီး', carry: 'ယူသွား',
      q_ack: 'သွားမည်', q_done: 'ပြီးပြီ', q_confirm: 'လက်ခံ', q_kitchen: 'မီးဖိုချောင်', q_served: 'ကျွေးပြီး', q_paid: 'ပေးပြီး', q_close: 'ပိတ်', decor: ['ဘား', 'ဝင်ပေါက်', 'ငွေကောင်တာ', 'မီးဖိုချောင်', 'ပြတင်းပေါက်', 'နံရံ'],
      st_tokitchen: 'အော်ဒါ မီးဖိုချောင် မရောက်သေး',
      st_pay: 'ဧည့်သည် ရှိ', st_close: 'အားလုံး ပေးပြီး', allFree: 'စားပွဲအားလုံး အားသည်', due: 'ပေးရန်', later: 'နောက်ထပ်',
      need_pay: 'ငွေ လက်ခံ', need_close: 'စားပွဲ ပိတ် — ပေးပြီး', need_void: 'စားပွဲ ပိတ် — မှာစာ ပယ်ဖျက်ပြီး', st_void: 'မှာစာ ပယ်ဖျက်ပြီး', voided: 'ပယ်ဖျက်', need_closePos: 'ကောင်တာတွင် ပေးပြီးမှ စားပွဲ ပိတ်',
      lb_free: 'အားသည်', lb_call: 'ခေါ် {m}′', lb_bill: 'ဘေလ် {m}′', lb_new: 'အော်ဒါသစ်', lb_tokitchen: 'မီးဖိုချောင်', lb_ready: 'ယူသွား', lb_ack: '{n} သွားနေ',
      lb_cook: 'စောင့် {m}′', lb_pay: 'ငွေယူ', lb_close: 'ပိတ်', todo: 'လုပ်ရန်', atKitchen: 'မီးဖိုချောင်တွင်', yourMove: 'သင့်အလှည့်',
      need_call: 'ဧည့်သည်ထံ သွား', need_bill: 'ဘေလ် ယူသွား', need_new: 'အော်ဒါ အတည်ပြု', need_tokitchen: 'အော်ဒါကို မီးဖိုချောင်သို့ ပို့', need_ready: 'ယူသွား — အစားအစာ အဆင်သင့်',
      need_callAck: '{n} သွားနေ — ပြီးလျှင် “ပြီးပြီ”', need_billAck: '{n} ဘေလ် ယူသွားနေ — ပြီးလျှင် “ပြီးပြီ”', need_cook: 'မီးဖိုချောင်ကို စောင့်', need_cookNoScreen: 'ကျွေးပြီးလျှင် “ကျွေးပြီး”' },
  };
  let lang = 'ru';
  const t = (k) => (L[lang] && L[lang][k] !== undefined ? L[lang][k] : L.en[k] !== undefined ? L.en[k] : L.ru[k]);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem('jf:' + k); localStorage.setItem('jf:' + k, v); } catch { return null; } return null; };
  const short = (tb) => String(tb).replace(/^(стол|table|โต๊ะ|စားပွဲ)\s*/i, '') || String(tb);
  const money = (n) => '฿' + Math.round(n).toLocaleString('en');
  const mins = (ts) => Math.max(0, Math.floor((Date.now() - ts) / 60000));
  const ui = { zone: store('zone') || '', mine: store('mine') === '1', queue: store('queue') !== '0' };
  // «ваш ход»: что официант должен сделать, по срочности
  const RANK = { call: 0, bill: 1, new: 2, tokitchen: 3, ready: 4, callAck: 5, billAck: 6, pay: 7, close: 8 };
  const URGENT = new Set(['call', 'bill', 'new', 'tokitchen', 'ready']);
  const COLOR = { call: 'var(--f-call)', bill: 'var(--f-bill)', new: 'var(--f-new)', tokitchen: 'var(--f-kit)', ready: 'var(--f-ready)', callAck: 'var(--f-call)', billAck: 'var(--f-bill)', cook: 'var(--f-cook)', pay: 'var(--f-pay)', close: 'var(--f-close)' };

  // Что за столом: самое срочное дело, сколько ждут, кто идёт, сумма к оплате; следующая быстрая кнопка
  function stateOf(tb, s, flow, quick, many) {
    const calls = s.calls.filter((c) => c.table === tb);
    const orders = s.orders.filter((o) => o.table === tb && o.status !== 'rejected');
    const voids = s.orders.filter((o) => o.table === tb && o.status === 'rejected');
    const nc = calls.filter((c) => c.status === 'new'), ac = calls.filter((c) => c.status !== 'new');
    const pending = orders.filter((o) => o.status === 'pending');
    const ready = orders.filter((o) => o.status === 'confirmed' && o.readyAt && !o.servedAt);
    const toKitchen = flow.kitchenBtn && !flow.kitchenScreen ? orders.filter((o) => o.status === 'confirmed' && !o.kitchenAt && !o.paidAt && !o.servedAt) : [];
    const cooking = orders.filter((o) => o.status === 'confirmed' && !o.readyAt && !o.servedAt && !toKitchen.includes(o));
    let total = 0, due = 0;
    for (const o of orders) for (const i of o.items) { total += i.price * i.qty; if (!i.paidAt && !o.paidAt) due += i.price * i.qty; }
    const first = (l, f) => Math.min(...l.map(f));
    let st = 'free', since = 0, who = '';
    if (nc.some((c) => c.type !== 'bill')) { st = 'call'; since = first(nc.filter((c) => c.type !== 'bill'), (c) => c.at); }
    else if (nc.length) { st = 'bill'; since = first(nc, (c) => c.at); }
    else if (pending.length) { st = 'new'; since = first(pending, (o) => o.at); }
    else if (toKitchen.length) { st = 'tokitchen'; since = first(toKitchen, (o) => o.confirmedAt || o.at); }
    else if (ready.length) { st = 'ready'; since = first(ready, (o) => o.readyAt); }
    else if (ac.length) { st = ac.some((c) => c.type !== 'bill') ? 'callAck' : 'billAck'; who = ac[0].by || ''; }
    else if (cooking.length) { st = 'cook'; since = first(cooking, (o) => o.kitchenAt || o.cookFrom || o.confirmedAt || o.at); }
    // стол занят, срочного нет: пока не освободится — взять оплату, потом закрыть стол
    // остались только отменённые заказы — гостю виден «отменён», пока стол не закрыли: тоже «закрыть стол»
    else if (orders.length || calls.length || voids.length) st = !s.restaurant?.pos && due > 0 ? 'pay' : 'close';
    let q = null;
    if ((st === 'call' || st === 'bill') && quick.ack) q = 'ack';
    else if (st === 'new' && quick.confirm) q = 'confirm';
    else if (st === 'tokitchen' && quick.kitchen) q = 'kitchen';
    else if (st === 'ready' && quick.served) q = 'served';
    else if ((st === 'callAck' || st === 'billAck') && quick.done) q = 'done';
    else if (st === 'cook' && !flow.kitchenScreen && quick.served) q = 'served'; // экрана кухни нет — «Подано» сразу
    else if (st === 'pay' && quick.paid && !many) q = 'paid';
    else if (st === 'close' && quick.close) q = 'close';
    return { tb, st, since, who, due, total, q, pos: !!s.restaurant?.pos, voided: st === 'close' && !orders.length && !calls.length && voids.length > 0 };
  }
  function sub(x) {
    if (x.st === 'call' || x.st === 'bill' || x.st === 'new' || x.st === 'tokitchen') return `${{ call: '🔔', bill: '🧾', new: '🍽', tokitchen: '📋' }[x.st]} ${mins(x.since)}′`;
    if (x.st === 'ready') return `✅ ${t('carry')}`;
    if (x.st === 'callAck' || x.st === 'billAck') return `🤵 ${esc(String(x.who).split(' ')[0])}`;
    if (x.st === 'cook') return `🍳 ${mins(x.since)}′`;
    if (x.st === 'pay') return money(x.due);
    if (x.st === 'close') return x.voided ? `✕ ${t('voided')}` : x.total && !x.pos ? `✓ ${t('paidAll')}` : '';
    return '';
  }
  const statusText = (x) => t('lb_' + (x.st === 'billAck' || x.st === 'callAck' ? 'ack' : x.st)).replace('{m}', mins(x.since)).replace('{n}', String(x.who || '').split(' ')[0]);
  const zonesOf = (floor) => (floor?.zones || []).filter((z) => z.tables.length || z.decor.length);
  const rowsOf = (z, extra = 0) => Math.max(1, ...z.tables.map((x) => x.y + x.h), ...z.decor.map((x) => x.y + x.h)) + extra;

  // Схема зоны: клетка — по ширине экрана; tiles(x) — кнопка стола с подписью и быстрой кнопкой
  const DECOR_KEYS = ['bar', 'entrance', 'cashier', 'kitchen', 'window', 'wall'];
  const presetKey = (text) => { for (const l of Object.values(L)) { const i = (l.decor || []).indexOf(text); if (i >= 0) return DECOR_KEYS[i]; } return ''; };
  const decorText = (d) => { const k = d.key || presetKey(d.text); return k ? t('decor')[DECOR_KEYS.indexOf(k)] : d.tr?.[lang] || d.text; };
  const ghostHtml = (d, style, extra = '', attr = '') => `<div class="ftile ghostt${d.sh === 'rd' ? ' rd' : ''}${extra}" style="${style}" ${attr}><span class="fn${String(d.text).length > 3 ? ' sm' : ''}">${esc(d.text)}</span></div>`;
  const decorDef = (d, i, style) => (d.kind === 'table' ? ghostHtml(d, style) : `<div class="fdecor" style="${style}">${esc(decorText(d))}</div>`);
  function planHtml(z, width, k, tile, decor = decorDef, extraRows = 0, cls = '', overlay = () => '') {
    // схема рисуется в клетках по 52 px, на экран её вписывает масштаб (attachZoom): вся зона видна, текст уменьшается вместе с ней
    const cell = 52, gap = 6, rows = rowsOf(z, extraRows);
    const box = (o) => `left:${o.x * cell + gap / 2}px;top:${o.y * cell + gap / 2}px;width:${o.w * cell - gap}px;height:${o.h * cell - gap}px`;
    return `<div class="fplan ${cls}" style="width:${cell * z.cols}px;height:${cell * rows}px;--cell:${cell}px">`
      + z.decor.map((d, i) => decor(d, i, box(d))).join('')
      + z.tables.map((x) => tile(x, box(x))).join('') + overlay(cell, gap) + '</div>';
  }

  // ---------- Масштаб схемы: по умолчанию вся зона на экране; два пальца — масштаб, один палец (когда увеличено) —
  // двигать; двойное касание по пустому месту — увеличить / вернуть; колесо мыши и тачпад в редакторе (кнопок нет — не закрывают столы).
  // Сильно уменьшено — кнопки и надписи у столов прячутся (действия — в «Нужно сделать»). Масштаб зоны помнит телефон
  const zs = {};
  let gesture = false;
  const zget = (key) => zs[key] || (zs[key] = (() => { try { return JSON.parse(localStorage.getItem('jf:z:' + key)); } catch { return null; } })() || { z: 0, x: 0, y: 0 });
  const zoomWrap = (inner) => `<div class="fzwrap">${inner}</div>`;
  function attachZoom(root, key, maxH, opts = {}) {
    const wrap = root.querySelector('.fzwrap'), plan = wrap?.querySelector('.fplan');
    if (!plan) return;
    // схема скрыта (другая вкладка ЛК, приложение открывается) — размеров нет; считаем, как только станет видна
    if (!wrap.clientWidth || !plan.offsetWidth) {
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => { if (!wrap.isConnected) return ro.disconnect(); if (wrap.clientWidth && plan.offsetWidth) { ro.disconnect(); attachZoom(root, key, maxH, opts); } });
        ro.observe(wrap); ro.observe(plan);
      } else setTimeout(() => wrap.isConnected && attachZoom(root, key, maxH, opts), 300);
      return;
    }
    const W = wrap.clientWidth, w = plan.offsetWidth, h = plan.offsetHeight;
    const fit = Math.min(1.3, W / w, Math.max(160, maxH) / h), st = zget(key);
    if (!st.z || Math.abs(st.z - (st.fit || fit)) < 0.01) st.z = fit; // был «вся зона» — остаётся «вся зона» при другом экране
    st.fit = fit;
    const H = Math.ceil(h * fit);
    wrap.style.height = H + 'px';
    const apply = (save) => {
      st.z = Math.min(Math.max(st.z, fit), Math.max(fit * 3, 2.5));
      const cw = w * st.z, ch = h * st.z;
      st.x = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, st.x));
      st.y = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, st.y));
      plan.style.transform = `translate(${st.x}px,${st.y}px) scale(${st.z})`;
      plan.classList.toggle('fsmall', st.z < 0.72);
      wrap.classList.toggle('fzin', st.z > fit + 0.01);
      if (save) try { localStorage.setItem('jf:z:' + key, JSON.stringify(st)); } catch { /* без памяти — по умолчанию */ }
    };
    const zoomAt = (nz, cx, cy) => { const k = nz / st.z; st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.z = nz; apply(true); };
    apply();
    const pt = (t) => { const r = wrap.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    let t0 = null, lastTap = 0, moved = false;
    wrap.addEventListener('touchstart', (e) => {
      moved = false;
      if (e.touches.length === 2) {
        const a = pt(e.touches[0]), b = pt(e.touches[1]);
        t0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z: st.z, x: st.x, y: st.y };
        gesture = true;
        opts.onPinch?.();
      } else if (e.touches.length === 1 && st.z > fit + 0.01 && !e.target.closest('.fedit [data-et], .fedit [data-ed]')) t0 = { p: pt(e.touches[0]), x: st.x, y: st.y };
    }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      if (!t0) return;
      if (e.touches.length === 2 && t0.d) {
        e.preventDefault();
        const a = pt(e.touches[0]), b = pt(e.touches[1]), k = Math.hypot(a.x - b.x, a.y - b.y) / t0.d;
        st.z = t0.z * k; st.x = (a.x + b.x) / 2 - (t0.m.x - t0.x) * k; st.y = (a.y + b.y) / 2 - (t0.m.y - t0.y) * k;
        moved = true;
        apply();
      } else if (e.touches.length === 1 && t0.p) {
        const a = pt(e.touches[0]);
        if (Math.abs(a.x - t0.p.x) + Math.abs(a.y - t0.p.y) > 6) moved = true;
        if (moved) { e.preventDefault(); gesture = true; st.x = t0.x + a.x - t0.p.x; st.y = t0.y + a.y - t0.p.y; apply(); }
      }
    }, { passive: false });
    wrap.addEventListener('touchend', (e) => {
      if (e.touches.length) return;
      if (t0) apply(true);
      t0 = null;
      setTimeout(() => { gesture = false; }, 60);
      // двойное касание по пустому месту: увеличить в 2 раза / вернуть «вся зона»
      if (!moved && !e.target.closest('.ftile, button, .fqn, .fdecor')) {
        const now = Date.now();
        if (now - lastTap < 320) { const p = pt(e.changedTouches[0]); if (st.z > fit + 0.01) { st.z = fit; apply(true); } else zoomAt(fit * 2, p.x, p.y); lastTap = 0; e.preventDefault(); } else lastTap = now;
      }
    });
    // после движения палец отпустили на столе — не открываем его
    wrap.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    wrap.addEventListener('wheel', (e) => { if (!opts.wheel && !e.ctrlKey) return; e.preventDefault(); const p = pt(e); zoomAt(st.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y); }, { passive: false });
  }

  // ---------- экран официанта ----------
  function view(el, ctx) {
    if (gesture) return; // палец двигает или увеличивает схему — не перерисовываем под ним
    lang = ctx.lang || 'ru';
    const { s, flow, many } = ctx, quick = s.floor?.quick || {}, zones = zonesOf(s.floor), all = s.restaurant.tables || [];
    const st = Object.fromEntries(all.map((tb) => [tb, stateOf(tb, s, flow, quick, many(tb))]));
    const mineSet = new Set(s.myTables || all), showMine = mineSet.size < all.length;
    const placed = new Set(zones.flatMap((z) => z.tables.map((x) => x.t)));
    const zoneOfT = (tb) => zones.find((z) => z.tables.some((x) => x.t === tb))?.name || '';
    if (!zones.some((z) => z.id === ui.zone)) ui.zone = zones[0]?.id || '';
    const z = zones.find((x) => x.id === ui.zone);
    const urgent = (tb) => st[tb] && URGENT.has(st[tb].st);
    const late = (x) => ['call', 'bill', 'new', 'tokitchen'].includes(x.st) && mins(x.since) >= 5;
    const tileCls = (x) => `ftile ${x.st}${late(x) ? ' late' : ''}${ui.mine && showMine ? (mineSet.has(x.tb) ? ' fmine' : ' fdim') : ''}`;
    const qbtn = (x, cls, style = '') => `<button class="${cls} q-${x.st}" style="${style}" data-fq="${x.q}" data-ftab="${esc(x.tb)}">${t('q_' + x.q)}</button>`;
    const tile = (p, style) => {
      const x = st[p.t] || stateOf(p.t, s, flow, quick, false);
      return `<button class="${tileCls(x)}${p.sh === 'rd' ? ' rd' : ''}" style="${style}" data-ftab="${esc(p.t)}"><span class="fn${short(p.t).length > 3 ? ' sm' : ''}">${esc(short(p.t))}</span><span class="fs">${sub(x)}</span></button>`;
    };
    // плитки (нет схемы или стол не на схеме): кнопка действия — отдельно под плиткой, не на ней
    const flat = (list) => `<div class="fgrid">${list.map((tb) => { const x = st[tb]; return `<div class="fcell"><button class="${tileCls(x)}" data-ftab="${esc(tb)}"><span class="fn${short(tb).length > 3 ? ' sm' : ''}">${esc(short(tb))}</span><span class="fs">${sub(x) || t('st_free')}</span></button>${x.q ? qbtn(x, 'fqb') : ''}</div>`; }).join('')}</div>`;
    let html = '';
    if (zones.length) {
      html += `<div class="fzones">${zones.map((x) => { const n = x.tables.filter((p) => urgent(p.t)).length; return `<button class="${x.id === ui.zone ? 'on' : ''}" data-fzone="${esc(x.id)}">${esc(x.name)}${n ? `<span class="fcnt">${n}</span>` : ''}</button>`; }).join('')}
        ${showMine ? `<button class="fminebtn${ui.mine ? ' on' : ''}" data-fmine="1">${ui.mine ? '✓ ' : ''}${t('mine')}</button>` : ''}</div>`;
      // кнопка действия — в свободной клетке рядом со столом (справа, слева, снизу, сверху): нажатие на стол
      // не сработает как действие, и наоборот. Рядом места нет — действие в «Нужно сделать» ниже
      const occ = new Set(), mark = (o) => { for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) occ.add(`${x},${y}`); };
      z.tables.forEach(mark); z.decor.forEach(mark);
      const chips = [];
      for (const p of z.tables) {
        const x = st[p.t];
        if (!x?.q) continue;
        const c = [[p.x + p.w, p.y], [p.x - 1, p.y], [p.x, p.y + p.h], [p.x, p.y - 1]].find(([cx, cy]) => cx >= 0 && cx < z.cols && cy >= 0 && !occ.has(`${cx},${cy}`));
        if (!c) continue;
        occ.add(c.join(','));
        chips.push({ x, cx: c[0], cy: c[1], side: c[0] > p.x + p.w - 1 ? 'r' : c[0] < p.x ? 'l' : c[1] > p.y ? 'b' : 't' });
      }
      // нет быстрой кнопки — рядом пишем, что со столом: свободен, ждём кухню, взять оплату, закрыть стол…
      for (const p of z.tables) {
        const x = st[p.t];
        if (!x || x.q) continue;
        const c = [[p.x + p.w, p.y], [p.x - 1, p.y], [p.x, p.y + p.h], [p.x, p.y - 1]].find(([cx, cy]) => cx >= 0 && cx < z.cols && cy >= 0 && !occ.has(`${cx},${cy}`));
        if (!c) continue;
        occ.add(c.join(','));
        chips.push({ x, cx: c[0], cy: c[1], side: c[0] > p.x + p.w - 1 ? 'r' : c[0] < p.x ? 'l' : c[1] > p.y ? 'b' : 't', label: true });
      }
      const extra = Math.max(0, ...chips.map((c) => c.cy + 1)) - rowsOf(z);
      const overlay = (cell, gap) => chips.map(({ x, cx, cy, side, label }) => {
        const h = Math.min(cell - gap, 36), pos = `left:${cx * cell + gap / 2}px;top:${cy * cell + (cell - h) / 2}px;width:${cell - gap}px;height:${h}px`;
        // кнопка — по ширине текста, с центром в своей клетке (не меньше клетки)
        const bpos = `left:${cx * cell + cell / 2}px;top:${cy * cell + (cell - h) / 2}px;min-width:${cell - gap}px;height:${h}px;transform:translateX(-50%)`;
        return label ? `<span class="fstat s-${x.st} fs-${side}" style="${pos}">${esc(statusText(x))}</span>` : qbtn(x, `fqn fq-${side}`, bpos);
      }).join('');
      const W = Math.min(el.clientWidth || 360, 560);
      html += zoomWrap(planHtml(z, W, 1, tile, decorDef, Math.max(0, extra), '', overlay));
      const rest = all.filter((tb) => !placed.has(tb));
      if (rest.length) html += `<div class="fzh">${t('unplaced')}</div>${flat(rest)}`;
    } else {
      html += showMine ? `<div class="fzones"><span class="fzh" style="margin:0">${t('tables')}</span><button class="fminebtn${ui.mine ? ' on' : ''}" data-fmine="1">${ui.mine ? '✓ ' : ''}${t('mine')}</button></div>` : '';
      html += flat(all);
    }
    // «Нужно сделать»: что требуется от официанта по каждому столу, по срочности, со всех зон;
    // «На кухне»: где мяч у кухни — сколько готовится. Сворачивается — остаётся одна схема
    const todo = Object.values(st).filter((x) => RANK[x.st] !== undefined && RANK[x.st] < 7).sort((a, b) => RANK[a.st] - RANK[b.st] || (a.since || 0) - (b.since || 0));
    const later = Object.values(st).filter((x) => x.st === 'pay' || x.st === 'close').sort((a, b) => RANK[a.st] - RANK[b.st]);
    const cooking = Object.values(st).filter((x) => x.st === 'cook').sort((a, b) => a.since - b.since);
    const where = (x) => esc([zoneOfT(x.tb), ctx.tbl(x.tb)].filter(Boolean).join(' · ')) + (mineSet.has(x.tb) && showMine ? ` · ${t('yours')}` : '');
    const row = (x, title, info) => `<div class="frow r-${x.st}" data-ftab="${esc(x.tb)}"><span class="fdot" style="background:${COLOR[x.st]}">${esc(short(x.tb))}</span>
      <span class="ftx"><b>${title}</b><small>${info} · ${where(x)}</small></span>${x.q ? qbtn(x, 'fqr') : ''}</div>`;
    html += `<div class="fqueue"><div class="fqh"><b>${t('todo')} · ${todo.length}</b><button data-fqueue="1">${ui.queue ? t('fold') : t('unfold')}</button></div>`;
    if (ui.queue) {
      html += todo.length ? todo.map((x) => row(x, esc(t('need_' + x.st).replace('{n}', String(x.who).split(' ')[0] || '')),
        `${t('st_' + x.st)}${x.since && x.st !== 'ready' ? ` · ${mins(x.since)} ${t('min')}` : ''}`)).join('')
        : !later.length && !cooking.length ? `<p class="empty">${t('allFree')}</p>` : '';
      if (cooking.length) html += `<div class="fqh"><b>${t('atKitchen')} · ${cooking.length}</b></div>`
        + cooking.map((x) => row(x, `${t('st_cook')} · ${mins(x.since)} ${t('min')}`, t(x.q === 'served' ? 'need_cookNoScreen' : 'need_cook'))).join('');
      // пока стол не освободился: взять оплату, закрыть стол
      if (later.length) html += `<div class="fqh"><b>${t('later')} · ${later.length}</b></div>`
        + later.map((x) => row(x, x.st === 'pay' ? `${t('need_pay')} · ${money(x.due)}` : t(x.voided ? 'need_void' : x.pos ? 'need_closePos' : 'need_close'),
          x.st === 'pay' ? `${t('st_pay')} · ${t('due')} ${money(x.due)}` : t(x.voided ? 'st_void' : 'st_close'))).join('');
    }
    html += '</div>';
    el.innerHTML = html;
    if (z) attachZoom(el, 'v:' + z.id, Math.round(window.innerHeight * (ui.queue ? 0.5 : 0.75)));
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
    if (ed.drag || gesture) return; // тащат стол или двигают схему — не перерисовываем
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
        <label>${t('cols')} <select data-ecols="1">${[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => `<option ${n === z.cols ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="ghostbtn" data-ezdel="1">${t('zoneDel')}</button></div>`;
      html += zoomWrap(planHtml(z, W, 1, (p, style) => `<div class="ftile busy${p.sh === 'rd' ? ' rd' : ''}${ed.sel === 't:' + p.t ? ' fsel' : ''}" style="${style}" data-et="${esc(p.t)}"><span class="fn${short(p.t).length > 3 ? ' sm' : ''}">${esc(short(p.t))}</span></div>`,
        (d, i, style) => (d.kind === 'table' ? ghostHtml(d, style, ed.sel === 'd:' + i ? ' fsel' : '', `data-ed="${i}"`)
          : `<div class="fdecor${ed.sel === 'd:' + i ? ' fsel' : ''}" style="${style}" data-ed="${i}">${esc(decorText(d))}</div>`), 2, 'fedit'));
    } else if (z) html += '<div class="fprev"></div>'; // заполняется ниже — тем же кодом, что у официанта
    html += '</div><div class="fside">';
    if (ed.mode === 'edit' && z) {
      html += selT ? `<div class="ftool"><b>${esc(ctx.tbl(selT.t))}:</b><button class="${selT.sh !== 'rd' ? 'on' : ''}" data-esh="sq">${t('square')}</button><button class="${selT.sh === 'rd' ? 'on' : ''}" data-esh="rd">${t('round')}</button>
          <button data-ew="1">${t('wider')}</button><button data-ew="-1">${t('narrower')}</button><button data-eh="1">${t('taller')}</button><button data-eh="-1">${t('lower')}</button><button data-eun="1">${t('unplace')}</button></div>`
        : selD ? `<div class="ftool">${selD.kind === 'table' ? `<b>${t('ghostTable')}:</b><button class="${selD.sh !== 'rd' ? 'on' : ''}" data-edsh="sq">${t('square')}</button><button class="${selD.sh === 'rd' ? 'on' : ''}" data-edsh="rd">${t('round')}</button>` : ''}
          <input id="fdText" data-etext="1" value="${esc(selD.text)}" maxlength="14" aria-label="${esc(t(selD.kind === 'table' ? 'tableNo' : 'label'))}" style="width:120px">
          <button data-ew="1">${t('wider')}</button><button data-ew="-1">${t('narrower')}</button><button data-eh="1">${t('taller')}</button><button data-eh="-1">${t('lower')}</button><button data-edel="1">${t('delDecor')}</button></div>
          ${selD.kind !== 'table' && !(selD.key || presetKey(selD.text)) ? `<div class="ftool"><span class="empty">${t('trHint')}</span>${['ru', 'en', 'th', 'my'].map((l) => `<label class="ftr">${l.toUpperCase()} <input id="fdTr-${l}" data-etr="${l}" value="${esc(selD.tr?.[l] || '')}" maxlength="14"></label>`).join('')}</div>` : ''}`
        : `<p class="empty">${t('pick')}</p>`;
      html += `<div class="ftool"><b>${t('unplaced')}:</b> ${rest.map((tb) => `<button class="fput" data-eput="${esc(tb)}">${esc(short(tb))}</button>`).join('') || '—'}</div>
        <div class="ftool"><b>${t('addDecor')}</b> ${t('decor').map((d, i) => `<button data-eadd="${DECOR_KEYS[i]}">${esc(d)}</button>`).join('')}<button data-eaddc="1">+ ${t('customLabel')}</button></div>
        <div class="ftool"><button data-eghost="1">+ ${t('ghostTable')}</button><span class="empty">${t('ghostNote')}</span></div>`;
    }
    html += `<div class="ed"><b>${t('quickT')}</b><span class="empty">${t('quickHint')}</span>
      ${['ack', 'done', 'confirm', 'kitchen', 'served', 'paid', 'close'].map((k) => `<label class="fq"><input type="checkbox" id="fq-${k}" data-eq="${k}" ${f.quick?.[k] ? 'checked' : ''}> ${t('qh_' + k)}</label>`).join('')}</div>
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
      if (d.eadd) { const p = firstFree(1, 1); if (!p) return alert(t('noRoom')); z.decor.push({ ...p, w: 1, h: 1, key: d.eadd, text: t('decor')[DECOR_KEYS.indexOf(d.eadd)] }); ed.sel = 'd:' + (z.decor.length - 1); return redraw(); }
      // своя надпись и стол без планшета: сразу выделены, поле текста — в фокусе
      if (d.eaddc || d.eghost) {
        const p = firstFree(1, 1); if (!p) return alert(t('noRoom'));
        const nums = [...(ctx.tables || []).map(short), ...f.zones.flatMap((x) => x.decor.filter((q) => q.kind === 'table').map((q) => q.text))].map((v) => parseInt(v, 10)).filter((v) => v > 0);
        z.decor.push(d.eghost ? { ...p, w: 1, h: 1, text: String(Math.max(0, ...nums) + 1), kind: 'table', sh: 'sq' } : { ...p, w: 1, h: 1, text: t('newLabel') });
        ed.sel = 'd:' + (z.decor.length - 1); redraw();
        const inp = el.querySelector('#fdText'); if (inp) { inp.focus(); inp.select(); }
        return;
      }
      if (d.edsh && selD) { selD.sh = d.edsh; return redraw(); }
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
      if (d.etr && selD) { selD.tr = { ...selD.tr, [d.etr]: e.target.value }; ed.dirty = true; return; }
      if (d.etext && selD) { delete selD.key; selD.text = e.target.value; ed.dirty = true; const n = el.querySelector(`[data-ed="${z.decor.indexOf(selD)}"]`); if (n) (n.querySelector('.fn') || n).textContent = selD.text; }
    };
    // перетаскивание: стол или надпись встаёт в ближайшую свободную клетку
    const plan = el.querySelector('.fedit');
    if (!plan) return;
    attachZoom(el, 'e:' + z.id, 520, { wheel: true, onPinch: () => { ed.drag = null; } });
    plan.onpointerdown = (e) => {
      const n = e.target.closest('[data-et], [data-ed]'); if (!n) return;
      const o = n.dataset.et !== undefined ? z.tables.find((p) => p.t === n.dataset.et) : z.decor[Number(n.dataset.ed)];
      ed.sel = n.dataset.et !== undefined ? 't:' + n.dataset.et : 'd:' + n.dataset.ed;
      const cell = plan.offsetWidth / z.cols, r = plan.getBoundingClientRect(), k = r.width / plan.offsetWidth; // k — масштаб схемы
      ed.drag = { o, n, cell, r, k, dx: (e.clientX - r.left) / k - o.x * cell, dy: (e.clientY - r.top) / k - o.y * cell, moved: false, to: null };
      n.setPointerCapture?.(e.pointerId); n.classList.add('fsel');
      e.preventDefault();
    };
    plan.onpointermove = (e) => {
      const g = ed.drag; if (!g) return;
      const px = (e.clientX - g.r.left) / g.k - g.dx, py = (e.clientY - g.r.top) / g.k - g.dy;
      if (Math.abs(px - g.o.x * g.cell) + Math.abs(py - g.o.y * g.cell) > 4) g.moved = true;
      g.n.style.left = px + 'px'; g.n.style.top = py + 'px';
      const x = Math.round(px / g.cell), y = Math.round(py / g.cell);
      g.to = free({ ...g.o, x, y }, g.o) ? { x, y } : null;
    };
    const end = () => { const g = ed.drag; if (!g) return; ed.drag = null; if (g.moved && g.to) { Object.assign(g.o, g.to); ed.dirty = true; ed.msg = ''; } editor(el, ctx); };
    plan.onpointerup = end; plan.onpointercancel = end;
  }

  const css = `:root{--f-call:#d63a2a;--f-bill:#7a3fa3;--f-new:#f2b705;--f-ready:#1f6fd1;--f-cook:#ef7d00;--f-kit:#0f766e;--f-pay:#2e7d32;--f-close:#64748b}
.fzones{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 6px}.fzones button{border:0;background:#efe7df;color:#1f1a17;border-radius:999px;padding:6px 12px;font-size:14px;font-weight:600;display:inline-flex;gap:6px;align-items:center}
.fzones button.on{background:#1f1a17;color:#fff}.fcnt{background:var(--f-call);color:#fff;border-radius:999px;font-size:11px;min-width:18px;height:18px;display:inline-grid;place-items:center;padding:0 5px}
.fzones .fminebtn{margin-left:auto;background:transparent;border:1px solid #d9cdc1;font-size:13px}.fzones .fminebtn.on{background:#fff;border-color:#1f1a17;color:#1f1a17}
.fplanwrap{overflow-x:auto;padding-bottom:16px}.fplan{position:relative;margin:4px auto 0}
.fzwrap{position:relative;overflow:hidden;margin:4px 0 16px;border-radius:12px;touch-action:pan-y}.fzwrap.fzin{touch-action:none;box-shadow:inset 0 0 0 1px #d9cdc1}
.fzwrap .fplan{position:absolute;left:0;top:0;margin:0;transform-origin:0 0}
.fsmall .fqn,.fsmall .fstat,.fsmall .ftile .fs{display:none}
.ftile{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:12px;border:2px solid #d9cdc1;background:#fff;color:#1f1a17;padding:0;line-height:1.1;cursor:pointer;touch-action:manipulation;font:inherit;user-select:none;-webkit-user-select:none}
.ftile.rd{border-radius:50%}.ftile .fn{font-size:17px;font-weight:800}.ftile .fn.sm{font-size:13px}.ftile .fs{font-size:11px;font-weight:600;margin-top:2px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.compact .ftile .fs{display:none}.compact .ftile .fn{font-size:15px}
.ftile.free{background:#fff;border-color:#d9cdc1;color:#1f1a17}.ftile.cook{background:var(--f-cook);border-color:var(--f-cook);color:#fff}
.ftile.call,.ftile.bill,.ftile.ready{color:#fff}.ftile.new{color:#1f1a17}.ftile.call{background:var(--f-call);border-color:var(--f-call)}.ftile.bill{background:var(--f-bill);border-color:var(--f-bill)}
.ftile.new{background:var(--f-new);border-color:var(--f-new)}.ftile.tokitchen{background:var(--f-kit);border-color:var(--f-kit);color:#fff}.ftile.ready{background:var(--f-ready);border-color:var(--f-ready)}
.ftile.pay{background:var(--f-pay);border-color:var(--f-pay);color:#fff}.ftile.close{background:var(--f-close);border-color:var(--f-close);color:#fff}
.ftile.callAck{background:#fde3df;border:3px solid var(--f-call)}.ftile.billAck{background:#efe3f7}.ftile.billAck{border:3px solid var(--f-bill)}
.ftile.call::after,.ftile.new::after{content:"";position:absolute;inset:-6px;border-radius:inherit;border:3px solid var(--f-call);opacity:0;animation:fring 1.6s ease-out infinite;pointer-events:none}.ftile.new::after{border-color:var(--f-new)}
@keyframes fring{0%{opacity:.7;transform:scale(.92)}100%{opacity:0;transform:scale(1.12)}}@media (prefers-reduced-motion:reduce){.ftile.call::after,.ftile.new::after{animation:none;opacity:.6}}
.ftile.late .fs::before{content:"⚠ "}.ftile.fdim{opacity:.35}.ftile.fmine{box-shadow:0 0 0 2px #1f1a17}
.fqn{position:absolute;z-index:2;background:#1f1a17;color:#fff;font:inherit;font-size:10px;font-weight:700;line-height:1.05;padding:2px 5px;border-radius:9px;border:0;display:grid;place-items:center;text-align:center;overflow-wrap:normal;word-break:keep-all;letter-spacing:-.2px;box-shadow:0 0 0 2px #f5f0ea}
.fqn::after{content:"";position:absolute;width:6px;height:6px;background:#1f1a17;transform:rotate(45deg)}.fq-r::after{left:-3px;top:calc(50% - 3px)}.fq-l::after{right:-3px;top:calc(50% - 3px)}.fq-b::after{top:-3px;left:calc(50% - 3px)}.fq-t::after{bottom:-3px;left:calc(50% - 3px)}
.fdecor{position:absolute;border-radius:10px;background:repeating-linear-gradient(135deg,#efe7df 0 6px,transparent 6px 12px);border:1px solid #d9cdc1;color:#8a7f76;font-size:10px;font-weight:700;display:grid;place-items:center;text-align:center;overflow:hidden;overflow-wrap:anywhere;line-height:1.05;padding:2px}
.fzh{font-size:12px;font-weight:700;color:#8a7f76;text-transform:uppercase;letter-spacing:.05em;margin:10px 2px 4px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px 8px;margin:4px 0 12px}.fcell{display:flex;flex-direction:column;gap:6px}
.fgrid .ftile{position:relative;height:74px;border-radius:14px}.fgrid .ftile .fn{font-size:20px}
.fqb{background:#1f1a17;color:#fff;border:0;border-radius:10px;padding:8px 4px;font:inherit;font-size:13px;font-weight:700}
.fqueue{margin-top:6px}.fqh{display:flex;justify-content:space-between;align-items:center;margin:6px 0}.fqh b{font-size:13px;color:#8a7f76;text-transform:uppercase;letter-spacing:.05em}
.fqh button{background:transparent;color:#8a7f76;padding:4px 0;font-size:13px}
.frow{display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:8px 10px;margin-bottom:8px;cursor:pointer}
.fdot{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px;flex:none}
.ftx{flex:1;min-width:0;font-size:15px}.ftx small{display:block;color:#8a7f76;font-size:12px}.frow .fqr{flex:none}.frow.r-cook,.frow.r-pay,.frow.r-close{background:transparent;border:1px dashed #d9cdc1}.frow.r-new .fdot{color:#1f1a17}
.fstat{position:absolute;display:grid;place-items:center;text-align:center;font-size:10px;font-weight:600;line-height:1.05;color:#5f564f;pointer-events:none;overflow-wrap:normal;word-break:keep-all;letter-spacing:-.2px}
.fstat.s-free{color:#8a7f76;font-weight:500}.fstat.s-cook{color:var(--f-cook);font-weight:700}.fstat.s-pay{color:var(--f-pay);font-weight:800}.fstat.s-close{color:var(--f-close);font-weight:700}
.fstat.s-call,.fstat.s-callAck{color:var(--f-call);font-weight:800}.fstat.s-bill,.fstat.s-billAck{color:var(--f-bill);font-weight:800}.fstat.s-new{color:#9a7400;font-weight:800}
.fstat.s-tokitchen{color:var(--f-kit);font-weight:800}.fstat.s-ready{color:var(--f-ready);font-weight:800}
.fseg{display:inline-flex;background:#efe7df;border-radius:10px;padding:3px;margin:4px 0 8px}.fseg button{background:transparent;color:#8a7f76;padding:6px 12px;font-size:13px;border-radius:8px}.fseg button.on{background:#fff;color:#1f1a17;font-weight:700}
.fedwrap{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}.fside{flex:1;min-width:260px}
.fphone{width:100%;max-width:390px;box-sizing:border-box;padding:10px 12px;background:#f5f0ea;border-radius:16px}
@media (min-width:700px){.fphone{border:10px solid #1d1a18;border-radius:30px;min-height:560px}}
.fedit{background-color:#fff;background-image:linear-gradient(#e6ddd3 1px,transparent 1px),linear-gradient(90deg,#e6ddd3 1px,transparent 1px);background-size:var(--cell) var(--cell);border:1px solid #d9cdc1;border-radius:8px}
.fedit .ftile,.fedit .fdecor{cursor:grab;touch-action:none}
.ftr{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700}.ftr input{width:96px!important}
.ftile.ghostt{background:transparent;border:2px dashed #c9bdb1;color:#a39a91}.fplan:not(.fedit) .ghostt{pointer-events:none;cursor:default}.fsel{outline:3px solid var(--f-new);outline-offset:2px;z-index:3}
.fzrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px;font-size:13px}.fzrow input{width:140px}.fzrow select{width:auto}
.ftool{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:14px}.ftool button{padding:7px 10px;font-size:13px;background:#efe7df;color:#1f1a17}.ftool button.on{background:#1f1a17;color:#fff}
.ftool .fput{border:2px dashed #d9cdc1;background:transparent;font-weight:700}
label.fq{display:flex!important;flex-direction:row;gap:10px;align-items:flex-start;margin:10px 0;font-size:14px}label.fq input{width:20px!important;height:20px;flex:none;margin:0}`;
  const tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag);
  window.JetFloor = { view, editor, stateOf, sig: () => `${ui.zone}|${ui.mine}|${ui.queue}`, resetEditor: () => { ed.draft = null; } };
})();
