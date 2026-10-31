// Статистика JET MEDIA: общий модуль для ЛК менеджера и админ-портала.
// JetStats.mount(el, { lang, admin, load(from, to, restaurantId) → Promise<data> })
(function () {
  const L = {
    ru: {
      today: 'Сегодня', yesterday: 'Вчера', d7: '7 дней', d30: '30 дней', month: 'Этот месяц', from: 'С', to: 'по', show: 'Показать',
      allRest: 'Все рестораны', loading: 'Считаю…', csv: 'Excel', none: 'Нет данных за период', prev: 'к прошлому периоду',
      summary: 'Сводка', orders: 'Заказы', revenue: 'Выручка через планшет', avg: 'Средний чек', calls: 'Вызовы официанта', bills: 'Просили счёт',
      opens: 'Столы открывались', conversion: 'С заказом', reaction: 'Скорость персонала', callMed: 'Реакция на вызов (обычно)',
      callP90: 'Реакция на вызов (худшие 10%)', orderMed: 'Подтверждение заказа (обычно)', orderP90: 'Подтверждение заказа (худшие 10%)',
      reminders: 'Понадобилось напоминание', unanswered: 'Вызовы без реакции', staff: 'Официанты и менеджеры', name: 'Имя',
      callsAcked: 'Вызовов принято', react: 'Реакция', ordersAcked: 'Заказов принял или открыл', sum: 'Сумма', paid: 'Счетов закрыл',
      shiftH: 'Часов на смене (кнопка)', activeH: 'Часов работы (1-е–посл. действие)', days: 'Дней', tables: 'Столы', table: 'Стол',
      dishes: 'Блюда', topQty: 'Чаще всего заказывают', topRev: 'Больше всего выручки', qty: 'Порций', dish: 'Блюдо',
      dayDish: 'Блюдо дня: заказано порций', promoQty: 'Акции: заказано', idle: 'Ни разу не заказали за период', promos: 'Акции',
      promo: 'Акция', imps: 'Показов', scans: 'Сканов QR', avatar: 'ИИ-персонаж', shows: 'Появлений на экране', talks: 'Разговоров',
      recs: 'Рекомендаций', dishOpens: '«Показать блюдо»', adds: 'Добавлений в заказ', ordered: 'Рекомендованное заказали',
      hours: 'По часам', weekdays: 'По дням недели', langs: 'Языки гостей', network: 'Рестораны', rest: 'Ресторан', devices: 'Устройств',
      uptime: 'Часов на связи в день', offline: 'Пропадали', crashes: 'Сбоев', ads: 'Внешняя реклама', advertiser: 'Рекламодатель',
      adName: 'Название', ctr: 'Сканов от показов, %', devicesT: 'Устройства', device: 'Устройство', place: 'Стол / вход', now: 'Сейчас',
      hoursOn: 'Часов на связи', adImps: 'Показов рекламы', adScans: 'Сканов рекламы', leads: 'Заявок', online: 'онлайн', offlineNow: 'офлайн', byRest: 'По ресторанам: показы / сканы / заявки', tts: 'Озвучка ElevenLabs, символов', sec: 'с', min: 'мин',
      wd: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], hint: 'Время — тайское. Выручка — только заказы через планшет.',
      withTests: 'С тестовыми', recalc: 'Пересчитать', excluded: 'Не учтено как тестовое', visitsN: 'визитов', ordersN: 'заказов',
      visits: 'Журнал визитов столов', when: 'Когда', test: 'Тест', whyBefore: 'прошлые данные', whyStaff: 'тестовый сотрудник',
      visitsHint: 'Визит — от первого вызова или заказа до «Закрыть стол». Отметьте «Тест», чтобы визит не шёл в статистику.',
      manager: 'менеджер', waiter: 'официант',
    },
    en: {
      today: 'Today', yesterday: 'Yesterday', d7: '7 days', d30: '30 days', month: 'This month', from: 'From', to: 'to', show: 'Show',
      allRest: 'All restaurants', loading: 'Calculating…', csv: 'Excel', none: 'No data for the period', prev: 'vs previous period',
      summary: 'Summary', orders: 'Orders', revenue: 'Revenue via tablets', avg: 'Average check', calls: 'Waiter calls', bills: 'Bill requests',
      opens: 'Tables opened', conversion: 'With an order', reaction: 'Staff speed', callMed: 'Call response (typical)',
      callP90: 'Call response (worst 10%)', orderMed: 'Order confirmation (typical)', orderP90: 'Order confirmation (worst 10%)',
      reminders: 'Reminders needed', unanswered: 'Calls without response', staff: 'Waiters and managers', name: 'Name',
      callsAcked: 'Calls taken', react: 'Response', ordersAcked: 'Orders taken or opened', sum: 'Amount', paid: 'Bills closed',
      shiftH: 'Hours on shift (button)', activeH: 'Hours worked (first–last action)', days: 'Days', tables: 'Tables', table: 'Table',
      dishes: 'Dishes', topQty: 'Ordered most often', topRev: 'Most revenue', qty: 'Portions', dish: 'Dish',
      dayDish: 'Dish of the day: portions ordered', promoQty: 'Promos: ordered', idle: 'Never ordered in the period', promos: 'Promos',
      promo: 'Promo', imps: 'Impressions', scans: 'QR scans', avatar: 'AI host', shows: 'Appearances', talks: 'Conversations',
      recs: 'Recommendations', dishOpens: '“Show dish”', adds: 'Added to order', ordered: 'Recommended and ordered',
      hours: 'By hour', weekdays: 'By weekday', langs: 'Guest languages', network: 'Restaurants', rest: 'Restaurant', devices: 'Devices',
      uptime: 'Hours online per day', offline: 'Went offline', crashes: 'Crashes', ads: 'External ads', advertiser: 'Advertiser',
      adName: 'Name', ctr: 'Scans per impressions, %', devicesT: 'Devices', device: 'Device', place: 'Table / entrance', now: 'Now',
      hoursOn: 'Hours online', adImps: 'Ad impressions', adScans: 'Ad scans', leads: 'Leads', online: 'online', offlineNow: 'offline', byRest: 'By restaurant: impressions / scans / leads', tts: 'ElevenLabs voice, characters', sec: 's', min: 'min',
      wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], hint: 'Thailand time. Revenue counts tablet orders only.',
      withTests: 'Include test data', recalc: 'Recalculate', excluded: 'Left out as test', visitsN: 'visits', ordersN: 'orders',
      visits: 'Table visits log', when: 'When', test: 'Test', whyBefore: 'earlier data', whyStaff: 'test staff',
      visitsHint: 'A visit lasts from the first call or order until “Close table”. Tick “Test” to keep a visit out of the statistics.',
      manager: 'manager', waiter: 'waiter',
    },
    th: {
      today: 'วันนี้', yesterday: 'เมื่อวาน', d7: '7 วัน', d30: '30 วัน', month: 'เดือนนี้', from: 'จาก', to: 'ถึง', show: 'แสดง',
      allRest: 'ทุกร้าน', loading: 'กำลังคำนวณ…', csv: 'Excel', none: 'ไม่มีข้อมูลในช่วงนี้', prev: 'เทียบกับช่วงก่อน',
      summary: 'สรุป', orders: 'ออร์เดอร์', revenue: 'ยอดขายผ่านแท็บเล็ต', avg: 'ยอดเฉลี่ยต่อบิล', calls: 'เรียกพนักงาน', bills: 'ขอเช็คบิล',
      opens: 'โต๊ะที่เปิด', conversion: 'มีการสั่ง', reaction: 'ความเร็วพนักงาน', callMed: 'ตอบรับการเรียก (ปกติ)',
      callP90: 'ตอบรับการเรียก (ช้าสุด 10%)', orderMed: 'ยืนยันออร์เดอร์ (ปกติ)', orderP90: 'ยืนยันออร์เดอร์ (ช้าสุด 10%)',
      reminders: 'ต้องเตือนซ้ำ', unanswered: 'การเรียกที่ไม่มีคนรับ', staff: 'พนักงานและผู้จัดการ', name: 'ชื่อ',
      callsAcked: 'รับการเรียก', react: 'เวลาตอบรับ', ordersAcked: 'รับหรือเปิดออร์เดอร์', sum: 'ยอดรวม', paid: 'ปิดบิล',
      shiftH: 'ชั่วโมงเข้ากะ (ปุ่ม)', activeH: 'ชั่วโมงทำงาน (แรก–สุดท้าย)', days: 'วัน', tables: 'โต๊ะ', table: 'โต๊ะ',
      dishes: 'เมนู', topQty: 'สั่งบ่อยที่สุด', topRev: 'ยอดขายสูงสุด', qty: 'จำนวน', dish: 'เมนู',
      dayDish: 'เมนูประจำวัน: จำนวนที่สั่ง', promoQty: 'โปรโมชัน: สั่ง', idle: 'ไม่มีใครสั่งในช่วงนี้', promos: 'โปรโมชัน',
      promo: 'โปรโมชัน', imps: 'แสดงผล', scans: 'สแกน QR', avatar: 'ผู้ช่วย AI', shows: 'ปรากฏบนจอ', talks: 'การสนทนา',
      recs: 'การแนะนำ', dishOpens: '“ดูเมนู”', adds: 'เพิ่มในออร์เดอร์', ordered: 'สั่งตามคำแนะนำ',
      hours: 'รายชั่วโมง', weekdays: 'รายวันในสัปดาห์', langs: 'ภาษาของแขก', network: 'ร้านอาหาร', rest: 'ร้าน', devices: 'อุปกรณ์',
      uptime: 'ชั่วโมงออนไลน์ต่อวัน', offline: 'ออฟไลน์', crashes: 'ขัดข้อง', ads: 'โฆษณาภายนอก', advertiser: 'ผู้ลงโฆษณา',
      adName: 'ชื่อ', ctr: 'สแกนต่อการแสดง %', devicesT: 'อุปกรณ์', device: 'อุปกรณ์', place: 'โต๊ะ / ทางเข้า', now: 'ตอนนี้',
      hoursOn: 'ชั่วโมงออนไลน์', adImps: 'แสดงโฆษณา', adScans: 'สแกนโฆษณา', leads: 'คำขอ', online: 'ออนไลน์', offlineNow: 'ออฟไลน์', byRest: 'ตามร้าน: แสดง / สแกน / คำขอ', tts: 'เสียง ElevenLabs ตัวอักษร', sec: 'วิ', min: 'นาที',
      wd: ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'], hint: 'เวลาประเทศไทย ยอดขายนับเฉพาะออร์เดอร์ผ่านแท็บเล็ต',
      withTests: 'รวมข้อมูลทดสอบ', recalc: 'คำนวณใหม่', excluded: 'ไม่นับ (ทดสอบ)', visitsN: 'ครั้ง', ordersN: 'ออร์เดอร์',
      visits: 'บันทึกการใช้โต๊ะ', when: 'เวลา', test: 'ทดสอบ', whyBefore: 'ข้อมูลเก่า', whyStaff: 'พนักงานทดสอบ',
      visitsHint: 'การใช้โต๊ะ: ตั้งแต่การเรียกหรือออร์เดอร์แรกจนถึง “ปิดโต๊ะ” ติ๊ก “ทดสอบ” เพื่อไม่นับในสถิติ',
      manager: 'ผู้จัดการ', waiter: 'พนักงาน',
    },
  };
  const TZ = 7 * 3600e3;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const money = (n) => `฿${Math.round(n || 0).toLocaleString('en')}`;
  // Начало тайского дня (в мс), d — смещение в днях от сегодня
  const dayStart = (d = 0) => { const n = new Date(Date.now() + TZ); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + d) - TZ; };
  const isoTh = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
  const fromIso = (s) => Date.parse(`${s}T00:00:00Z`) - TZ;

  function mount(el, opt) {
    const t = L[opt.lang] || L.en;
    const dur = (ms) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} ${t.sec}` : `${Math.floor(ms / 60000)} ${t.min} ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')} ${t.sec}`);
    const st = { from: dayStart(-6), to: dayStart(1), r: '', preset: 'd7' };
    const tables = {};

    // Таблица с выгрузкой в CSV (Excel открывает файл с «;» и BOM без вопросов)
    function table(id, title, cols, rows) {
      tables[id] = { title, cols, rows };
      if (!rows.length) return `<h3>${esc(title)}</h3><p class="js-none">${t.none}</p>`;
      return `<div class="js-th"><h3>${esc(title)}</h3><button data-csv="${id}">⬇ ${t.csv}</button></div>
        <div class="js-wrap"><table class="js-tbl"><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
          `<tr>${cols.map((c) => `<td>${c[2] ? c[2](r[c[1]], r) : esc(r[c[1]] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    function csv(id) {
      const tb = tables[id];
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const text = [tb.cols.map((c) => cell(c[0])).join(';'), ...tb.rows.map((r) => tb.cols.map((c) => cell(c[3] ? c[3](r[c[1]], r) : r[c[1]])).join(';'))].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
      a.download = `${tb.title} ${isoTh(st.from)}_${isoTh(st.to - 1)}.csv`;
      a.click();
    }
    const delta = (cur, prev) => {
      if (prev == null || cur == null || !prev) return '';
      const p = Math.round(((cur - prev) / prev) * 100);
      return p ? `<small class="${p > 0 ? 'js-up' : 'js-down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%</small>` : '';
    };
    const card = (label, value, extra = '') => `<div class="js-card"><span>${esc(label)}</span><b>${value}</b>${extra}</div>`;
    const bars = (title, values, labels) => {
      const max = Math.max(1, ...values);
      return `<div class="js-chart"><h4>${esc(title)}</h4><div class="js-bars">${values.map((v, i) =>
        `<div title="${esc(labels[i])}: ${v}"><i style="height:${Math.round((v / max) * 100)}%"></i><span>${esc(labels[i])}</span></div>`).join('')}</div></div>`;
    };
    const durCsv = (v) => (v == null ? '' : Math.round(v / 1000));

    function summaryHtml(s, p, re) {
      return `<h3>${t.summary}</h3><div class="js-cards">
        ${card(t.orders, s.orders, delta(s.orders, p?.orders))}${card(t.revenue, money(s.revenue), delta(s.revenue, p?.revenue))}
        ${card(t.avg, money(s.avg), delta(s.avg, p?.avg))}${card(t.calls, s.calls, delta(s.calls, p?.calls))}${card(t.bills, s.bills)}
        ${card(t.opens, s.opens, delta(s.opens, p?.opens))}${card(t.conversion, s.conversion == null ? '—' : `${s.conversion}%`)}</div>
        <p class="js-hint">${t.hint} ${p ? `▲▼ — ${t.prev}` : ''}</p>
        <h3>${t.reaction}</h3><div class="js-cards">${card(t.callMed, dur(re.callMed))}${card(t.callP90, dur(re.callP90))}
        ${card(t.orderMed, dur(re.orderMed))}${card(t.orderP90, dur(re.orderP90))}${card(t.reminders, re.reminders)}${card(t.unanswered, re.unanswered)}</div>`;
    }
    function timeHtml(d) {
      const langs = Object.entries(d.langs || {}).sort((a, b) => b[1] - a[1]);
      return `<div class="js-charts">${bars(`${t.hours}: ${t.orders}`, d.hours.orders, d.hours.orders.map((_, i) => String(i)))}
        ${bars(`${t.hours}: ${t.calls}`, d.hours.calls, d.hours.calls.map((_, i) => String(i)))}
        ${bars(`${t.weekdays}: ${t.orders}`, d.weekdays.orders, t.wd)}
        </div>${langs.length ? `<h3>${t.langs}</h3><div class="js-cards">${langs.map(([l, n]) =>
          card(l.toUpperCase(), `${Math.round((n / langs.reduce((s, x) => s + x[1], 0)) * 100)}%`, `<small>${n}</small>`)).join('')}</div>` : ''}`;
    }
    function avatarHtml(a) {
      return `<h3>${t.avatar}</h3><div class="js-cards">${card(t.shows, a.shows)}${card(t.talks, a.talks)}${card(t.recs, a.recs)}
        ${card(t.dishOpens, a.dishOpens)}${card(t.adds, a.adds)}${card(t.ordered, a.ordered)}</div>`;
    }
    // Сколько не учтено как тестовое
    const excludedHtml = (d) => (!d.tests && d.excluded?.visits ? `<p class="js-hint">🧪 ${t.excluded}: ${d.excluded.visits} ${t.visitsN}, ${d.excluded.orders} ${t.ordersN}, ${money(d.excluded.total)}</p>` : '');
    // Журнал визитов: у каждого — «Тест» (прошлые данные и тестовые сотрудники — без галочки, с причиной)
    let visits = [];
    function visitsHtml(d) {
      visits = d.visits || [];
      if (!visits.length) return '';
      const when = (v) => new Date(v.from + TZ).toISOString().slice(5, 16).replace('T', ' ') + '–' + new Date(v.to + TZ).toISOString().slice(11, 16);
      return `<details class="js-ex"><summary>${t.visits} (${visits.length})</summary><p class="js-hint">${t.visitsHint}</p>
        <div class="js-wrap"><table class="js-tbl"><thead><tr><th>${t.when}</th><th>${t.table}</th><th>${t.orders}</th><th>${t.sum}</th><th>${t.staff}</th><th>${t.test}</th></tr></thead>
        <tbody>${visits.map((v, i) => `<tr class="${v.why ? 'js-test' : ''}"><td>${when(v)}</td><td>${esc(v.table)}</td><td>${v.orders}</td><td>${money(v.total)}</td>
          <td>${esc(v.staff.join(', '))}</td><td>${v.why === 'before' ? t.whyBefore : v.why === 'staff' ? t.whyStaff
            : opt.markVisit ? `<input type="checkbox" data-visit="${i}" ${v.why === 'mark' ? 'checked' : ''}>` : v.why ? '✓' : ''}</td></tr>`).join('')}</tbody></table></div></details>`;
    }
    function restaurantHtml(d) {
      return visitsHtml(d) + summaryHtml(d.summary, d.prev, d.reaction) + excludedHtml(d)
        + table('staff', t.staff, [[t.name, 'name'], [t.callsAcked, 'calls'], [t.react, 'callMed', dur, durCsv], [t.ordersAcked, 'orders'],
          [t.sum, 'ordersSum', money, (v) => v], [t.paid, 'paid'], [t.shiftH, 'shiftH'], [t.activeH, 'activeH'], [t.days, 'days']], d.staff)
        + table('tables', t.tables, [[t.table, 'table'], [t.opens, 'opens'], [t.orders, 'orders'], [t.revenue, 'revenue', money, (v) => v],
          [t.avg, 'avg', money, (v) => v], [t.calls, 'calls'], [t.react, 'callMed', dur, durCsv]], d.tables)
        + `<h3>${t.dishes}</h3><div class="js-cards">${card(t.dayDish, d.dishes.dayDishQty)}${card(t.promoQty, d.dishes.promoQty)}${card(t.idle, d.dishes.idleCount)}</div>`
        + table('top', t.topQty, [[t.dish, 'name'], [t.qty, 'qty'], [t.revenue, 'revenue', money, (v) => v]], d.dishes.top)
        + table('topRev', t.topRev, [[t.dish, 'name'], [t.revenue, 'revenue', money, (v) => v], [t.qty, 'qty']], d.dishes.topRevenue)
        + (d.dishes.idle.length ? `<details><summary>${t.idle} (${d.dishes.idleCount})</summary><p>${d.dishes.idle.map((x) => esc(x.name)).join(', ')}</p></details>` : '')
        + table('promos', t.promos, [[t.promo, 'name'], [t.imps, 'imps'], [t.scans, 'scans'], [t.qty, 'qty'], [t.revenue, 'revenue', money, (v) => v]], d.promos)
        + avatarHtml(d.avatar) + timeHtml(d);
    }
    function adminHtml(d) {
      const n = d.network;
      return (d.restaurant ? '' : summaryHtml(n.summary, n.prev, n.reaction))
        + table('network', t.network, [[t.rest, 'name'], [t.orders, 'orders'], [t.revenue, 'revenue', money, (v) => v], [t.avg, 'avg', money, (v) => v],
          [t.calls, 'calls'], [t.react, 'callMed', dur, durCsv], [t.conversion, 'conversion', (v) => (v == null ? '—' : `${v}%`)],
          [t.devices, 'devices'], [t.uptime, 'uptimeH'], [t.offline, 'offline'], [t.crashes, 'crashes'], [t.adScans, 'adScans'], [t.leads, 'leads']], n.network)
        + table('devices', t.devicesT, [[t.device, 'id'], [t.rest, 'rest'], [t.place, 'place'], [t.now, 'online', (v) => (v ? `<span class="js-up">${t.online}</span>` : `<span class="js-down">${t.offlineNow}</span>`), (v) => (v ? t.online : t.offlineNow)],
          [t.hoursOn, 'hours'], [t.orders, 'orders'], [t.revenue, 'revenue', money, (v) => v], [t.calls, 'calls'], [t.talks, 'talks'],
          [t.adImps, 'adImps'], [t.adScans, 'adScans'], [t.leads, 'leads']], n.devices || [])
        + table('ads', t.ads, [[t.advertiser, 'advertiser'], [t.adName, 'title'], [t.imps, 'imps'], [t.scans, 'scans'], [t.ctr, 'ctr'], [t.leads, 'leads'],
          [t.byRest, 'byRest', (v) => esc((v || []).map((x) => `${x.name}: ${x.imps}/${x.scans}/${x.leads || 0}`).join('; ')), (v) => (v || []).map((x) => `${x.name}: ${x.imps}/${x.scans}/${x.leads || 0}`).join('; ')]], n.ads)
        + `<div class="js-cards">${card(t.tts, (n.tts?.chars || 0).toLocaleString('en'))}</div>`
        + (d.restaurant ? `<hr><h2>${esc(d.restaurants.find((x) => x.id === st.r)?.name || '')}</h2>${restaurantHtml(d.restaurant)}` : avatarHtml(n.avatar) + timeHtml(n));
    }

    function controls(rests) {
      const pre = [['today', 0, 1], ['yesterday', -1, 0], ['d7', -6, 1], ['d30', -29, 1]];
      return `<div class="js-ctl">${pre.map(([k]) => `<button data-pre="${k}" class="${st.preset === k ? 'on' : ''}">${t[k]}</button>`).join('')}
        <button data-pre="month" class="${st.preset === 'month' ? 'on' : ''}">${t.month}</button>
        <label>${t.from} <input type="date" id="jsFrom" value="${isoTh(st.from)}"></label><label>${t.to} <input type="date" id="jsTo" value="${isoTh(st.to - 1)}"></label>
        <button data-go="1">${t.show}</button>
        <label><input type="checkbox" id="jsTests" ${st.tests ? 'checked' : ''}> ${t.withTests}</label>
        <button data-recalc="1">↻ ${t.recalc}</button>
        ${rests ? `<select id="jsRest"><option value="">${t.allRest}</option>${rests.map((r) => `<option value="${esc(r.id)}" ${st.r === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : ''}</div>`;
    }

    let rests = null;
    async function load() {
      el.innerHTML = controls(rests) + `<p class="js-hint">${t.loading}</p>`;
      const d = await opt.load(st.from, st.to, st.r, st.tests);
      if (d.error) { el.innerHTML = controls(rests) + `<p class="js-none">${esc(d.error)}</p>`; return; }
      if (opt.admin) rests = d.restaurants;
      el.innerHTML = controls(rests) + `<div class="js-body">${opt.admin ? adminHtml(d) : restaurantHtml(d)}</div>`;
    }
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.csv) return csv(b.dataset.csv);
      if (b.dataset.recalc) return load();
      if (b.dataset.pre) {
        st.preset = b.dataset.pre;
        if (st.preset === 'month') { const n = new Date(Date.now() + TZ); st.from = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1) - TZ; st.to = dayStart(1); }
        else { const p = { today: [0, 1], yesterday: [-1, 0], d7: [-6, 1], d30: [-29, 1] }[st.preset]; st.from = dayStart(p[0]); st.to = dayStart(p[1]); }
        load();
      }
      if (b.dataset.go) {
        st.preset = '';
        st.from = fromIso(el.querySelector('#jsFrom').value);
        st.to = fromIso(el.querySelector('#jsTo').value) + 864e5;
        if (st.to <= st.from) st.to = st.from + 864e5;
        load();
      }
    };
    el.onchange = async (e) => {
      if (e.target.id === 'jsRest') { st.r = e.target.value; load(); }
      if (e.target.id === 'jsTests') { st.tests = e.target.checked; load(); }
      if (e.target.dataset.visit !== undefined) {
        await opt.markVisit(visits[Number(e.target.dataset.visit)].ids, e.target.checked, st.r);
        load();
      }
    };
    load();
  }

  // Оформление — один раз на страницу
  const css = `.js-ctl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 14px}.js-ctl button{padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#222;cursor:pointer;margin:0}
.js-ctl button.on{background:#222;color:#fff;border-color:#222}.js-ctl input,.js-ctl select{padding:5px 8px;border-radius:8px;border:1px solid #ddd;font:inherit}
.js-cards{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 10px}.js-card{background:#fff;border-radius:12px;padding:10px 14px;min-width:150px;flex:1 1 150px;display:flex;flex-direction:column;gap:2px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.js-card span{font-size:12px;color:#8a7f76}.js-card b{font-size:22px}.js-up{color:#1a7f37}.js-down{color:#c62828}.js-hint,.js-none{color:#8a7f76;font-size:13px}
.js-th{display:flex;align-items:center;gap:10px}.js-th button{padding:4px 10px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#222;cursor:pointer;font-size:12px;margin:0}
.js-wrap{overflow-x:auto}.js-tbl{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;font-size:14px}.js-tbl th,.js-tbl td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}
.js-tbl th{font-size:12px;color:#8a7f76;white-space:normal}.js-charts{display:flex;flex-wrap:wrap;gap:12px}.js-chart{background:#fff;border-radius:12px;padding:10px;flex:1 1 320px}
.js-chart h4{margin:0 0 8px;font-size:13px}.js-bars{display:flex;align-items:flex-end;gap:2px;height:120px}.js-bars div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.js-test td{color:#b0a69c}.js-ex{background:#fff;border-radius:12px;padding:8px 12px;margin:0 0 10px}.js-ex summary{cursor:pointer;font-weight:600}.js-ex label{display:inline-block;margin:4px 14px 4px 0;white-space:nowrap}
.js-bars i{display:block;width:100%;background:#c8553d;border-radius:3px 3px 0 0;min-height:1px}.js-bars span{font-size:9px;color:#8a7f76;margin-top:2px}.js-body h3{margin:18px 0 6px}`;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
  window.JetStats = { mount };
})();
