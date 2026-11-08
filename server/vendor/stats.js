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
      reminders: 'Понадобилось напоминание', kitchenMed: 'От заказа до кухни (обычно)', readyMed: 'Кухня готовит (обычно)', servedMed: 'От подтверждения до «Подано» (обычно)', servedP90: 'Подача: 9 из 10 быстрее', servedNoKitchen: 'Подано без отметки кухни', redoN: 'Переделано (вернули блюдо)', cancelledN: 'Все отмены заказов (и гостей, и персонала)', vlogHint: 'Нажмите ▸ у визита — заказы и всё, что с ними делали.', guestW: 'Гость', phoneW: 'с телефона', tabletW: 'с планшета', noKitchenW: 'без отметки кухни', lg: { call_why: 'причина отмены', call: '🔔 вызов официанта', call_bill: '🧾 просит счёт', call_ack: '«Иду»', call_done: '«Готово»', call_cancel: 'отменил вызов сам', remind: 'напоминание официантам', remind_order: 'напоминание: заказ ждёт подтверждения', remind_kitchen: 'напоминание: отдать на кухню', forgotten: 'вызов снят по времени — без ответа', waited: 'ждал', order: 'заказ', order_void: 'заказ (потом отменён)', order_ack: 'принял заказ', order_edit: 'изменил', order_kitchen: 'отдал на кухню', order_ready: 'кухня: готово', order_served: '🍽 подано', order_redo: '🔁 переделать', order_cancel: '✕ отменил заказ', order_reject: 'отклонил заказ', order_remove: 'удалил (дубль)', paid: 'оплачено', close: 'стол закрыт', undo: '↩ отменил' }, of: { 'call:ack': 'Иду', 'table:ack': 'Иду', 'order:ack': 'Иду', 'call:done': 'Готово', 'order:confirm': 'Подтвердить', 'order:reject': 'Отклонить', 'order:kitchen': 'На кухню', 'order:served': 'Подано', 'order:paid': 'Счёт оплачен', 'guestpaid:': 'Оплачен', 'order:edit': 'Изменить', 'order:redo': 'Переделать', 'order:cancel': 'Отменить заказ', 'order:remove': 'Удалить (дубль)', 'order:move': 'Перенос блюда', 'order:new': 'Новый заказ' }, phoneOrders: 'Заказов с телефонов', unanswered: 'Вызовы без реакции', staff: 'Официанты и менеджеры', name: 'Имя',
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
      visits: 'Журнал визитов столов', when: 'Когда', test: 'Тест', whyBefore: 'прошлые данные', errTitle: 'Ошибки процесса', errMissed: 'Гость не дождался официанта', errCame: 'Официант подошёл, но не отметил в приложении', errCameCol: 'Подошёл без «Иду»', cameShort: '✅ официант подошёл, не отметил «Иду»', cameFor: 'стол закреплён за', why: { came: 'официант подошёл', waited: 'не дождались', notneeded: 'уже не нужно', mistake: 'нажали случайно' }, whyG: 'гость', whyIs: 'причина', whyNone: 'причина не выбрана', whyOld: 'причину не спрашивали (до обновления)', errMissedCol: 'Не дождались официанта', missWaiter: '🔔 вызов официанта', missBill: '🧾 просил счёт', missWait: 'ждал', missRem: 'напоминаний', missCancel: 'гость отменил сам', missExpired: 'снят по времени', callsCol: 'Вызовы', callAnswer: 'ответ', callNoAnswer: 'без ответа', errAll: 'все рестораны', vAll: 'Все', vMoney: 'С деньгами', vEmpty: 'Без денег', vCancel: 'С ошибкой', vTest: 'Тестовые', vByTime: 'по времени', vByColor: 'по цвету', vOrder: 'Порядок', errHint: 'Стремимся к нулю: заказ гостя не должен отменяться сотрудником, а настоящий заказ — помечаться тестовым. Нажмите, чтобы увидеть каждый.', errCancel: 'Заказы гостей, отменённые сотрудниками', errMarked: 'Заказы, помеченные тестовыми', errCancelled: 'отменил', errRejected: 'отклонил', errMarkedBy: 'пометил', errStaffOrder: 'заказ сотрудника', errCancelCol: 'Отменено заказов гостей', errMarkedCol: 'Помечено тестовыми', partly: 'частично: {m} из {n}', allPeriod: 'все за период', markAllQ: 'Пометить тестовыми все визиты за выбранный период ({n})? Они не войдут в статистику.', unmarkAllQ: 'Снять «Тест» со всех визитов за период ({n})? Они снова войдут в статистику.', whyStaff: 'тестовый сотрудник',
      visitsHint: 'Визит — от первого вызова или заказа до «Закрыть стол». Отметьте «Тест», чтобы визит не шёл в статистику.',
      manager: 'менеджер', waiter: 'официант',
    },
    en: {
      today: 'Today', yesterday: 'Yesterday', d7: '7 days', d30: '30 days', month: 'This month', from: 'From', to: 'to', show: 'Show',
      allRest: 'All restaurants', loading: 'Calculating…', csv: 'Excel', none: 'No data for the period', prev: 'vs previous period',
      summary: 'Summary', orders: 'Orders', revenue: 'Revenue via tablets', avg: 'Average check', calls: 'Waiter calls', bills: 'Bill requests',
      opens: 'Tables opened', conversion: 'With an order', reaction: 'Staff speed', callMed: 'Call response (typical)',
      callP90: 'Call response (worst 10%)', orderMed: 'Order confirmation (typical)', orderP90: 'Order confirmation (worst 10%)',
      reminders: 'Reminders needed', kitchenMed: 'Order to kitchen (typical)', readyMed: 'Kitchen cooking time (typical)', servedMed: 'Confirmation to “Served” (typical)', servedP90: 'Serving: 9 of 10 faster', servedNoKitchen: 'Served without kitchen mark', redoN: 'Remade (dish sent back)', cancelledN: 'All order cancellations (guests’ and staff’s orders)', vlogHint: 'Tap ▸ next to a visit to see its orders and everything done with them.', guestW: 'Guest', phoneW: 'from phone', tabletW: 'from tablet', noKitchenW: 'no kitchen mark', lg: { call_why: 'reason for cancelling', call: '🔔 called the waiter', call_bill: '🧾 asked for the bill', call_ack: '“Going”', call_done: '“Done”', call_cancel: 'cancelled the call', remind: 'reminder to waiters', remind_order: 'reminder: order awaits confirmation', remind_kitchen: 'reminder: pass to the kitchen', forgotten: 'call cleared by timeout — no response', waited: 'waited', order: 'order', order_void: 'order (cancelled later)', order_ack: 'accepted the order', order_edit: 'changed', order_kitchen: 'passed to the kitchen', order_ready: 'kitchen: ready', order_served: '🍽 served', order_redo: '🔁 remake', order_cancel: '✕ cancelled the order', order_reject: 'rejected the order', order_remove: 'deleted (duplicate)', paid: 'paid', close: 'table closed', undo: '↩ undid' }, of: { 'call:ack': 'Going', 'table:ack': 'Going', 'order:ack': 'Going', 'call:done': 'Done', 'order:confirm': 'Confirm', 'order:reject': 'Reject', 'order:kitchen': 'To kitchen', 'order:served': 'Served', 'order:paid': 'Bill paid', 'guestpaid:': 'Paid', 'order:edit': 'Edit', 'order:redo': 'Remake', 'order:cancel': 'Cancel order', 'order:remove': 'Delete (duplicate)', 'order:move': 'Move dish', 'order:new': 'New order' }, phoneOrders: 'Orders from phones', unanswered: 'Calls without response', staff: 'Waiters and managers', name: 'Name',
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
      visits: 'Table visits log', when: 'When', test: 'Test', whyBefore: 'earlier data', errTitle: 'Process errors', errMissed: 'Guest gave up waiting for the waiter', errCame: 'Waiter came but did not mark it in the app', errCameCol: 'Came without “Going”', cameShort: '✅ waiter came, did not press “Going”', cameFor: 'table assigned to', why: { came: 'the waiter came', waited: 'waited too long', notneeded: 'no longer needed', mistake: 'pressed by mistake' }, whyG: 'guest', whyIs: 'reason', whyNone: 'no reason chosen', whyOld: 'reason not asked (before the update)', errMissedCol: 'Gave up waiting', missWaiter: '🔔 waiter call', missBill: '🧾 bill request', missWait: 'waited', missRem: 'reminders', missCancel: 'guest cancelled', missExpired: 'cleared by timeout', callsCol: 'Calls', callAnswer: 'answer', callNoAnswer: 'no answer', errAll: 'all restaurants', vAll: 'All', vMoney: 'With money', vEmpty: 'No money', vCancel: 'With an error', vTest: 'Test', vByTime: 'by time', vByColor: 'by colour', vOrder: 'Order', errHint: 'Aim for zero: a guest order should not be cancelled by staff, and a real order should not be marked as test. Tap to see each one.', errCancel: 'Guest orders cancelled by staff', errMarked: 'Orders marked as test', errCancelled: 'cancelled', errRejected: 'rejected', errMarkedBy: 'marked by', errStaffOrder: 'staff order', errCancelCol: 'Guest orders cancelled', errMarkedCol: 'Marked as test', partly: 'partly: {m} of {n}', allPeriod: 'all in period', markAllQ: 'Mark all visits in the selected period as test ({n})? They will not count in statistics.', unmarkAllQ: 'Unmark all visits in the period ({n})? They will count in statistics again.', whyStaff: 'test staff',
      visitsHint: 'A visit lasts from the first call or order until “Close table”. Tick “Test” to keep a visit out of the statistics.',
      manager: 'manager', waiter: 'waiter',
    },
    th: {
      today: 'วันนี้', yesterday: 'เมื่อวาน', d7: '7 วัน', d30: '30 วัน', month: 'เดือนนี้', from: 'จาก', to: 'ถึง', show: 'แสดง',
      allRest: 'ทุกร้าน', loading: 'กำลังคำนวณ…', csv: 'Excel', none: 'ไม่มีข้อมูลในช่วงนี้', prev: 'เทียบกับช่วงก่อน',
      summary: 'สรุป', orders: 'ออร์เดอร์', revenue: 'ยอดขายผ่านแท็บเล็ต', avg: 'ยอดเฉลี่ยต่อบิล', calls: 'เรียกพนักงาน', bills: 'ขอเช็คบิล',
      opens: 'โต๊ะที่เปิด', conversion: 'มีการสั่ง', reaction: 'ความเร็วพนักงาน', callMed: 'ตอบรับการเรียก (ปกติ)',
      callP90: 'ตอบรับการเรียก (ช้าสุด 10%)', orderMed: 'ยืนยันออร์เดอร์ (ปกติ)', orderP90: 'ยืนยันออร์เดอร์ (ช้าสุด 10%)',
      reminders: 'ต้องเตือนซ้ำ', kitchenMed: 'จากสั่งถึงครัว (ปกติ)', readyMed: 'ครัวทำอาหาร (ปกติ)', servedMed: 'จากยืนยันถึงเสิร์ฟ (ปกติ)', servedP90: 'เสิร์ฟ: 9 ใน 10 เร็วกว่า', servedNoKitchen: 'เสิร์ฟโดยครัวไม่ได้กด', redoN: 'ทำใหม่ (ลูกค้าส่งคืน)', cancelledN: 'ยกเลิกออเดอร์ทั้งหมด (แขกและพนักงาน)', vlogHint: 'แตะ ▸ ที่การใช้โต๊ะ เพื่อดูออร์เดอร์และทุกการกระทำ', guestW: 'แขก', phoneW: 'จากมือถือ', tabletW: 'จากแท็บเล็ต', noKitchenW: 'ครัวไม่ได้กด', lg: { call_why: 'เหตุผลที่ยกเลิก', call: '🔔 เรียกพนักงาน', call_bill: '🧾 ขอเช็คบิล', call_ack: '«กำลังไป»', call_done: '«เรียบร้อย»', call_cancel: 'ยกเลิกการเรียกเอง', remind: 'แจ้งเตือนพนักงาน', remind_order: 'แจ้งเตือน: ออเดอร์รอยืนยัน', remind_kitchen: 'แจ้งเตือน: ส่งเข้าครัว', forgotten: 'การเรียกถูกล้างเพราะหมดเวลา — ไม่มีคนตอบ', waited: 'รอ', order: 'ออร์เดอร์', order_void: 'ออร์เดอร์ (ยกเลิกภายหลัง)', order_ack: 'รับออร์เดอร์', order_edit: 'แก้ไข', order_kitchen: 'ส่งเข้าครัว', order_ready: 'ครัว: พร้อม', order_served: '🍽 เสิร์ฟแล้ว', order_redo: '🔁 ทำใหม่', order_cancel: '✕ ยกเลิกออร์เดอร์', order_reject: 'ปฏิเสธออร์เดอร์', order_remove: 'ลบ (ซ้ำ)', paid: 'ชำระแล้ว', close: 'ปิดโต๊ะ', undo: '↩ ยกเลิก' }, phoneOrders: 'สั่งจากมือถือ', unanswered: 'การเรียกที่ไม่มีคนรับ', staff: 'พนักงานและผู้จัดการ', name: 'ชื่อ',
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
      visits: 'บันทึกการใช้โต๊ะ', when: 'เวลา', test: 'ทดสอบ', allPeriod: 'ทั้งหมดในช่วงนี้', markAllQ: 'ทำเครื่องหมายทุกการใช้โต๊ะในช่วงนี้เป็นการทดสอบ ({n})? จะไม่นับในสถิติ', unmarkAllQ: 'ยกเลิกเครื่องหมายทดสอบทั้งหมดในช่วงนี้ ({n})? จะกลับมานับในสถิติ', partly: 'บางส่วน: {m} จาก {n}', errMissed: 'แขกรอพนักงานไม่ไหว', errCame: 'พนักงานมาแล้วแต่ไม่กดในแอป', errCameCol: 'มาโดยไม่กด «กำลังไป»', cameShort: '✅ พนักงานมาแล้ว ไม่ได้กด «กำลังไป»', cameFor: 'โต๊ะของ', why: { came: 'พนักงานมาแล้ว', waited: 'รอนานเกินไป', notneeded: 'ไม่ต้องการแล้ว', mistake: 'กดผิด' }, whyG: 'แขก', whyIs: 'เหตุผล', whyNone: 'ไม่ได้เลือกเหตุผล', whyOld: 'ไม่ได้ถามเหตุผล (ก่อนอัปเดต)', errMissedCol: 'แขกรอไม่ไหว', missWaiter: '🔔 เรียกพนักงาน', missBill: '🧾 ขอเช็คบิล', missWait: 'รอ', missRem: 'การแจ้งเตือน', missCancel: 'แขกยกเลิกเอง', missExpired: 'ล้างเพราะหมดเวลา', callsCol: 'การเรียก', callAnswer: 'ตอบ', callNoAnswer: 'ไม่มีคนตอบ', errTitle: 'ข้อผิดพลาดของกระบวนการ', errAll: 'ทุกร้าน', vAll: 'ทั้งหมด', vMoney: 'มียอดเงิน', vEmpty: 'ไม่มียอดเงิน', vCancel: 'มีข้อผิดพลาด', vTest: 'ทดสอบ', vByTime: 'ตามเวลา', vByColor: 'ตามสี', vOrder: 'เรียง', errHint: 'เป้าหมายคือศูนย์: ออเดอร์ของแขกไม่ควรถูกพนักงานยกเลิก และออเดอร์จริงไม่ควรถูกทำเครื่องหมายว่าทดสอบ แตะเพื่อดูแต่ละรายการ', errCancel: 'ออเดอร์แขกที่พนักงานยกเลิก', errMarked: 'ออเดอร์ที่ทำเครื่องหมายว่าทดสอบ', errCancelled: 'ยกเลิก', errRejected: 'ปฏิเสธ', errMarkedBy: 'ทำเครื่องหมายโดย', errStaffOrder: 'ออเดอร์พนักงาน', errCancelCol: 'ออเดอร์แขกที่ถูกยกเลิก', errMarkedCol: 'ทำเครื่องหมายทดสอบ', whyBefore: 'ข้อมูลเก่า', whyStaff: 'พนักงานทดสอบ',
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
          `<tr>${cols.map((c) => `<td data-l="${esc(c[0])}">${c[2] ? c[2](r[c[1]], r) : esc(r[c[1]] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
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
        ${card(t.opens, s.opens, delta(s.opens, p?.opens))}${card(t.conversion, s.conversion == null ? '—' : `${s.conversion}%`)}
        ${s.phoneOrders ? card(t.phoneOrders, s.phoneOrders) : ''}</div>
        <p class="js-hint">${t.hint} ${p ? `▲▼ — ${t.prev}` : ''}</p>
        <h3>${t.reaction}</h3><div class="js-cards">${card(t.callMed, dur(re.callMed))}${card(t.callP90, dur(re.callP90))}
        ${card(t.orderMed, dur(re.orderMed))}${card(t.orderP90, dur(re.orderP90))}${re.kitchenMed != null ? card(t.kitchenMed, dur(re.kitchenMed)) : ''}
        ${re.readyMed != null ? card(t.readyMed, dur(re.readyMed)) : ''}${re.servedMed != null ? card(t.servedMed, dur(re.servedMed)) + card(t.servedP90, dur(re.servedP90)) : ''}
        ${re.servedNoKitchen ? card(t.servedNoKitchen, re.servedNoKitchen) : ''}${re.redo ? card(t.redoN, re.redo) : ''}
        ${re.cancelled ? card(t.cancelledN, `${re.cancelled} · ${money(re.cancelledSum)}`) : ''}${card(t.reminders, re.reminders)}${card(t.unanswered, re.unanswered)}</div>`;
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
    let visits = [], markAll = null;
    // Цвет визита: тестовый — серый, с отменой заказа — красный, с деньгами — зелёный, без денег — чёрный.
    // Над журналом — фильтр по цвету и порядок: по времени или группами по цвету (внутри группы — по времени)
    const VCATS = ['money', 'cancel', 'empty', 'test'];
    // красный — ошибка: отменили заказ или гость не дождался официанта
    const vcat = (v) => (v.why ? 'test' : v.cancelled || v.calls?.missed?.length ? 'cancel' : v.total > 0 ? 'money' : 'empty');
    // «Вызовы»: 🔔 2 · 🧾 1 · ответ ~1 мин; не дождался — красным: без ответа 5 мин, напоминаний 5, гость отменил сам
    // гость отменил сам — причина: «не дождались» / не выбрана / не спрашивали (до обновления)
    const whyText = (w) => (t.why[w] ? `${t.whyIs}: «${t.why[w]}»` : w === 'old' ? t.whyOld : w === 'none' ? t.whyNone : '');
    const cancelText = (m) => [t.missCancel, whyText(m.why)].filter(Boolean).join(', ');
    const callsCell = (c) => {
      if (!c || (!c.w && !c.b && !c.missed?.length && !c.came?.length)) return '';
      const miss = (c.missed || []).map((m) => `<span class="js-down">${m.type === 'bill' ? '🧾' : '🔔'} ${t.callNoAnswer} ${dur(m.wait)}${m.reminds ? ` · ${t.missRem} ${m.reminds}` : ''} · ${m.how === 'cancel' ? cancelText(m) : t.missExpired}</span>`)
        .concat((c.came || []).map((m) => `<span class="js-warnc">${t.cameShort} · ${dur(m.wait)}</span>`)).join('<br>');
      const all = [c.w ? `🔔 ${c.w}` : '', c.b ? `🧾 ${c.b}` : '', c.ack != null ? `${t.callAnswer} ~${dur(c.ack)}` : ''].filter(Boolean).join(' · ');
      return [all, miss].filter(Boolean).join('<br>');
    };
    const shownVisits = () => {
      const l = visits.map((v, i) => [v, i]).filter(([v]) => !st.vcat || vcat(v) === st.vcat);
      return st.vsort === 'color' ? l.sort((a, b) => VCATS.indexOf(vcat(a[0])) - VCATS.indexOf(vcat(b[0])) || a[1] - b[1]) : l;
    };
    const vFilterHtml = () => {
      const n = (c) => visits.filter((v) => vcat(v) === c).length, lab = { money: t.vMoney, cancel: t.vCancel, empty: t.vEmpty, test: t.vTest };
      return `<div class="js-vfilt"><button data-vcat="" class="${st.vcat ? '' : 'on'}">${t.vAll} ${visits.length}</button>`
        + VCATS.map((c) => `<button data-vcat="${c}" class="js-vc-${c}${st.vcat === c ? ' on' : ''}"><i></i>${lab[c]} ${n(c)}</button>`).join('')
        + `<span class="js-hint">${t.vOrder}:</span><button data-vsort="time" class="${st.vsort === 'color' ? '' : 'on'}">${t.vByTime}</button><button data-vsort="color" class="${st.vsort === 'color' ? 'on' : ''}">${t.vByColor}</button></div>`;
    };
    function visitsHtml(d) {
      visits = d.visits || [];
      markAll = d.markAll || null;
      if (!visits.length) return '';
      // конец в другой день — с датой: «11-07 18:34–11-08 18:02»
      const when = (v) => { const a = new Date(v.from + TZ).toISOString(), b = new Date(v.to + TZ).toISOString();
        return a.slice(5, 16).replace('T', ' ') + '–' + (a.slice(0, 10) === b.slice(0, 10) ? b.slice(11, 16) : b.slice(5, 16).replace('T', ' ')); };
      // кто и когда поставил «Тест»: «Николай, 08.11 13:05»
      const byText = (v) => (v.markBy ? `<br><small class="js-hint">${esc(v.markBy)}${v.markAt ? ', ' + new Date(v.markAt + TZ).toISOString().slice(8, 10) + '.' + new Date(v.markAt + TZ).toISOString().slice(5, 7) + ' ' + new Date(v.markAt + TZ).toISOString().slice(11, 16) : ''}</small>` : '');
      return `<details class="js-ex"><summary>${t.visits} (${visits.length})</summary><p class="js-hint">${t.visitsHint} ${t.vlogHint}</p>
        ${vFilterHtml()}
        <div class="js-wrap"><table class="js-tbl"><thead><tr><th>${t.when}</th><th>${t.table}</th><th>${t.orders}</th><th>${t.sum}</th><th>${t.staff}</th><th>${t.callsCol}</th><th>${t.test}${opt.markVisit && markAll?.n ? `<br><label class="js-all"><input type="checkbox" data-visitall="1" ${markAll.marked === markAll.n ? 'checked' : ''}> ${t.allPeriod}</label>` : ''}</th></tr></thead>
        <tbody>${shownVisits().map(([v, i]) => `<tr class="js-c-${vcat(v)}${v.why ? ' js-test' : ''}"><td data-l="${esc(t.when)}">${(v.log || []).length ? `<button class="js-vbtn" data-vlog="${i}">▸</button> ` : ''}${when(v)}</td><td data-l="${esc(t.table)}">${esc(v.table)}</td><td data-l="${esc(t.orders)}">${v.orders}</td><td data-l="${esc(t.sum)}">${money(v.total)}</td>
          <td data-l="${esc(t.staff)}">${esc(v.staff.join(', '))}</td><td data-l="${esc(t.callsCol)}">${callsCell(v.calls)}</td><td data-l="${esc(t.test)}">${v.why === 'before' ? t.whyBefore : v.why === 'staff' ? t.whyStaff
            : (opt.markVisit ? `<input type="checkbox" data-visit="${i}" ${v.why === 'mark' ? 'checked' : ''}>` : v.why ? '✓' : '')
              + (v.part ? ` <small>${t.partly.replace('{m}', v.part.marked).replace('{n}', v.part.total)}</small>` : '') + (v.why === 'mark' || v.part ? byText(v) : '')}</td></tr>`).join('')}</tbody></table></div></details>`;
    }
    // Журнал визита: «14:05 · #a1b2 · Boss: изменил: +1 × Салат, −2 × Хлеб · ฿1,250»
    function visitLogHtml(v) {
      const hm = (ts) => new Date(ts + TZ).toISOString().slice(11, 16);
      // названия блюд хранятся на всех языках меню — показываем на языке экрана
      const nm = (n) => (typeof n === 'string' ? n : (n && (n[opt.lang] || n.en || n.ru || Object.values(n)[0])) || '');
      const ls = (list, sign = '') => (list || []).map(([n, q, ml]) => `${sign}${q} × ${esc(nm(n))}${ml ? ` (${esc(nm(ml))})` : ''}`).join(', ');
      return `<ul class="js-vlog">${v.log.map((e) => {
        const who = e.bn ? esc(e.bn) : e.k === 'order' || e.k === 'order_void' ? `${t.guestW} ${e.g || 1}, ${e.src === 'phone' ? t.phoneW : t.tabletW}`
          : e.k === 'call' || e.k === 'call_cancel' ? `${t.guestW} ${e.g || 1}` : '';
        // вызовы: что за вызов, через сколько ответили, сколько ждал гость, напоминания (подряд — одной строкой)
        if (e.k.startsWith('call') || e.k === 'remind' || e.k === 'forgotten') {
          const label = e.k === 'call' ? (e.type === 'bill' ? t.lg.call_bill : t.lg.call) : e.k === 'remind' ? (t.lg['remind_' + e.kind] || t.lg.remind) + (e.n > 1 ? ` ×${e.n}` : '')
            : e.k === 'call_why' ? `${t.whyG}: ${t.lg.call_why} — ${t.why[e.why] || e.why}` : t.lg[e.k];
          const warn = e.k === 'forgotten' || (e.k === 'call_cancel' && e.ms >= 60000) || (e.k === 'call_why' && e.why === 'waited');
          const extra = e.k === 'call_ack' && e.ms != null ? ` · ${dur(e.ms)}` : e.k === 'call_cancel' && e.ms != null ? ` · ${t.lg.waited} ${dur(e.ms)}` : '';
          return `<li${warn ? ' class="js-warn"' : e.k === 'remind' ? ' class="js-hint"' : ''}>${hm(e.t)} · ${who ? `${who}: ` : ''}${label}${extra}</li>`;
        }
        const what = e.k === 'order_edit' ? [ls(e.add, '+'), ls(e.del, '−')].filter(Boolean).join(', ') : e.k === 'undo' ? `«${esc((t.of || L.en.of)[e.of] || e.of)}»` : ls(e.items);
        return `<li${e.k === 'order_cancel' || e.k === 'order_void' || e.k === 'order_redo' ? ' class="js-warn"' : ''}>${hm(e.t)}${e.id ? ` · #${esc(e.id)}` : ''} · ${who ? `${who}: ` : ''}${t.lg[e.k] || e.k}`
          + `${what ? `: ${what}` : ''}${e.total != null ? ` · ${money(e.total)}` : ''}${e.noKitchen ? ` (${t.noKitchenW})` : ''}${e.note ? ` — «${esc(e.note)}»` : ''}</li>`;
      }).join('')}</ul>`;
    }
    // Ошибки процесса — на самом видном месте: больше нуля — красные, ноль — зелёные; по нажатию — каждый заказ
    // scope — ресторан или «все рестораны»; за выбранный период. Каждый заказ — по нажатию: блюда, количество, цена, итог
    const nmOf = (n) => (typeof n === 'string' ? n : (n && (n[opt.lang] || n.en || n.ru || Object.values(n)[0])) || '');
    const period = () => { const a = new Date(st.from + TZ).toISOString(), b = new Date(st.to - 1 + TZ).toISOString(), dm = (x) => `${x.slice(8, 10)}.${x.slice(5, 7)}`;
      return dm(a) === dm(b) ? dm(a) : `${dm(a)}–${dm(b)}`; };
    function errorsHtml(er, scope) {
      if (!er) return '';
      const hm = (ts) => new Date(ts + TZ).toISOString().slice(5, 16).replace('T', ' ');
      const box = (label, x, rows) => `<details class="js-err ${x.n ? 'bad' : 'ok'}"><summary><span>${esc(label)}</span><b>${x.n ? `${x.n} · ${money(x.sum)}` : '0 ✓'}</b></summary>${x.n ? `<ul class="js-elist">${rows}</ul>` : ''}</details>`;
      // без суммы — только количество
      const boxN = (label, x, rows, cls = 'bad') => `<details class="js-err ${x.n ? cls : 'ok'}"><summary><span>${esc(label)}</span><b>${x.n ? x.n : '0 ✓'}</b></summary>${x.n ? `<ul class="js-elist">${rows}</ul>` : ''}</details>`;
      const who = (x) => (x.src === 'staff' ? t.errStaffOrder : `${t.guestW} ${x.g || 1}, ${x.src === 'phone' ? t.phoneW : t.tabletW}`);
      const dishes = (x) => `<div class="js-edish">${(x.items || []).map(([n, q, p]) => `<div><span>${q} × ${esc(nmOf(n))}</span><span>${p != null ? money(p * q) : ''}</span></div>`).join('')}<div class="js-etot"><span></span><b>${money(x.total)}</b></div></div>`;
      const item = (x, tail) => `<li><details><summary>${hm(x.t)} · ${x.rest ? esc(x.rest) + ' · ' : ''}${esc(x.table)} · ${who(x)} · <b>${money(x.total)}</b>${tail}</summary>${dishes(x)}</details></li>`;
      return `<h3 class="js-errh">⚠️ ${t.errTitle} <small class="js-hint">· ${esc(scope || '')} · ${period()}</small></h3><p class="js-hint">${t.errHint}</p><div class="js-errs">`
        + box(t.errCancel, er.cancelled, er.cancelled.list.map((x) => item(x, ` — ${x.k === 'order_reject' ? t.errRejected : t.errCancelled}${x.bn ? `: ${esc(x.bn)}` : ''}${x.note ? ` — «${esc(x.note)}»` : ''}`)).join(''))
        + box(t.errMarked, er.marked, er.marked.list.map((x) => item(x, x.by ? ` — ${t.errMarkedBy} ${esc(x.by)}${x.at ? `, ${hm(x.at)}` : ''}` : '')).join(''))
        + (er.came ? boxN(t.errCame, er.came, er.came.list.map((x) => `<li>${hm(x.t)} · ${x.rest ? esc(x.rest) + ' · ' : ''}${esc(x.table)} · ${x.type === 'bill' ? t.missBill : t.missWaiter} · ${t.missWait} ${dur(x.wait)}${x.waiters?.length ? ` — ${t.cameFor} ${esc(x.waiters.join(', '))}` : ''}</li>`).join(''), 'warnc') : '')
        + (er.missed ? boxN(t.errMissed, er.missed, er.missed.list.map((x) => `<li>${hm(x.t)} · ${x.rest ? esc(x.rest) + ' · ' : ''}${esc(x.table)} · ${x.type === 'bill' ? t.missBill : t.missWaiter} · ${t.missWait} <b>${dur(x.wait)}</b>${x.reminds ? ` · ${t.missRem}: ${x.reminds}` : ''} — ${x.how === 'cancel' ? cancelText(x) : t.missExpired}</li>`).join('')) : '')
        + '</div>';
    }
    function restaurantHtml(d) {
      return errorsHtml(d.errors, d.name || '') + visitsHtml(d) + summaryHtml(d.summary, d.prev, d.reaction) + excludedHtml(d)
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
    // столбцы ошибок в таблице ресторанов: сколько и на какую сумму; больше нуля — красным
    const errCell = (v) => (v?.n ? `<b class="js-down">${v.n} · ${money(v.sum)}</b>` : '<span class="js-up">0</span>');
    function adminHtml(d) {
      const n = d.network;
      return (d.restaurant ? '' : errorsHtml(n.errors, t.errAll) + summaryHtml(n.summary, n.prev, n.reaction))
        + table('network', t.network, [[t.rest, 'name'], [t.orders, 'orders'], [t.revenue, 'revenue', money, (v) => v], [t.avg, 'avg', money, (v) => v],
          [t.calls, 'calls'], [t.react, 'callMed', dur, durCsv], [t.conversion, 'conversion', (v) => (v == null ? '—' : `${v}%`)],
          [t.errCancelCol, 'errCancel', errCell, (v) => (v?.n ? `${v.n} / ${v.sum}` : 0)], [t.errMarkedCol, 'errMarked', errCell, (v) => (v?.n ? `${v.n} / ${v.sum}` : 0)],
          [t.errMissedCol, 'errMissed', (v) => (v?.n ? `<b class="js-down">${v.n}</b>` : '<span class="js-up">0</span>'), (v) => v?.n || 0],
          [t.errCameCol, 'errCame', (v) => (v?.n ? `<b class="js-warnc">${v.n}</b>` : '<span class="js-up">0</span>'), (v) => v?.n || 0],
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
    // keep — пересчёт после отметки «Тест»: журнал остаётся открытым, раскрытые визиты и прокрутка — на месте
    async function load(keep) {
      const was = keep && {
        open: [...el.querySelectorAll('details')].map((x) => x.open),
        vlog: [...el.querySelectorAll('.js-vrow')].map((x) => x.previousElementSibling?.querySelector('[data-vlog]')?.dataset.vlog).filter(Boolean),
        y: window.scrollY, sc: [...el.querySelectorAll('.js-wrap')].map((x) => x.scrollLeft),
      };
      if (keep) el.querySelectorAll('[data-visit], [data-visitall]').forEach((x) => { x.disabled = true; });
      else el.innerHTML = controls(rests) + `<p class="js-hint">${t.loading}</p>`;
      const d = await opt.load(st.from, st.to, st.r, st.tests);
      if (d.error) { el.innerHTML = controls(rests) + `<p class="js-none">${esc(d.error)}</p>`; return; }
      if (opt.admin) rests = d.restaurants;
      el.innerHTML = controls(rests) + `<div class="js-body">${opt.admin ? adminHtml(d) : restaurantHtml(d)}</div>`;
      if (!was) return;
      el.querySelectorAll('details').forEach((x, i) => { if (was.open[i]) x.open = true; });
      for (const i of was.vlog) el.querySelector(`[data-vlog="${i}"]`)?.click();
      el.querySelectorAll('.js-wrap').forEach((x, i) => { x.scrollLeft = was.sc[i] || 0; });
      window.scrollTo(0, was.y);
    }
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.csv) return csv(b.dataset.csv);
      if (b.dataset.vlog !== undefined) {
        const tr = b.closest('tr'), next = tr.nextElementSibling;
        if (next?.classList.contains('js-vrow')) { next.remove(); b.textContent = '▸'; return; }
        tr.insertAdjacentHTML('afterend', `<tr class="js-vrow"><td colspan="7">${visitLogHtml(visits[Number(b.dataset.vlog)])}</td></tr>`);
        b.textContent = '▾';
        return;
      }
      if (b.dataset.recalc) return load();
      // журнал визитов: фильтр по цвету и порядок — без сворачивания журнала
      if (b.dataset.vcat !== undefined) { st.vcat = b.dataset.vcat; return load(true); }
      if (b.dataset.vsort) { st.vsort = b.dataset.vsort; return load(true); }
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
        const v = visits[Number(e.target.dataset.visit)], at = new Date(v.from + TZ).toISOString();
        await opt.markVisit(v.ids, e.target.checked, st.r, `${v.table}, визит ${at.slice(8, 10)}.${at.slice(5, 7)} ${at.slice(11, 16)}`);
        load(true);
      }
      // все визиты периода разом (не только 300 последних в журнале)
      if (e.target.dataset.visitall && markAll) {
        const on = e.target.checked;
        if (!confirm((on ? t.markAllQ : t.unmarkAllQ).replace('{n}', markAll.n))) { e.target.checked = !on; return; }
        const d1 = new Date(st.from + TZ).toISOString(), d2 = new Date(st.to - 1 + TZ).toISOString(), dm = (x) => `${x.slice(8, 10)}.${x.slice(5, 7)}`;
        await opt.markVisit(markAll.ids, on, st.r, `все визиты за ${dm(d1)}${dm(d1) === dm(d2) ? '' : '–' + dm(d2)} (${markAll.n})`);
        load(true);
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
.js-wrap{overflow-x:visible}.js-tbl{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;font-size:14px}.js-tbl th,.js-tbl td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;white-space:normal;overflow-wrap:anywhere;vertical-align:top}
@media (max-width:760px){.js-tbl thead{display:none}.js-tbl,.js-tbl tbody,.js-tbl tr,.js-tbl td{display:block;width:auto}.js-tbl tr{border-bottom:1px solid #e6dfd8;padding:6px 10px}
.js-tbl td{border:0;padding:2px 0}.js-tbl td[data-l]:not(:empty)::before{content:attr(data-l) ': ';color:#8a7f76;font-size:12px}.js-tbl tr.js-vrow td::before{content:none}}
.js-tbl th{font-size:12px;color:#8a7f76;white-space:normal}.js-charts{display:flex;flex-wrap:wrap;gap:12px}.js-chart{background:#fff;border-radius:12px;padding:10px;flex:1 1 320px}
.js-chart h4{margin:0 0 8px;font-size:13px}.js-bars{display:flex;align-items:flex-end;gap:2px;height:120px}.js-bars div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.js-test td{color:#b0a69c}.js-ex{background:#fff;border-radius:12px;padding:8px 12px;margin:0 0 10px}.js-ex summary{cursor:pointer;font-weight:600}.js-ex label{display:inline-block;margin:4px 14px 4px 0;white-space:nowrap}
.js-ex .js-all{font-weight:400;white-space:nowrap;color:#222;display:inline-flex;align-items:center;gap:4px;margin-top:2px}.js-errh{color:#c62828}.js-errs{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 14px}.js-err{flex:1 1 300px;background:#fff;border-radius:12px;padding:10px 14px;border-left:6px solid #2e7d32;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.js-err.bad{border-color:#c62828;background:#fff5f5}.js-err>summary{display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;font-size:14px}.js-err>summary b{font-size:22px;white-space:nowrap}
.js-err.bad>summary b{color:#c62828}.js-err.warnc{border-color:#f5a623;background:#fffaf0}.js-err.warnc>summary b{color:#b26a00}.js-warnc{color:#b26a00}.js-err.ok>summary b{color:#2e7d32}.js-err.ok>summary{cursor:default}
.js-elist{margin:6px 0 2px;padding-left:16px;font-size:13px;line-height:1.5}.js-elist summary{cursor:pointer}.js-edish{margin:4px 0 8px;padding:6px 10px;background:#fff;border-radius:8px;max-width:420px}
.js-edish div{display:flex;justify-content:space-between;gap:12px}.js-etot{border-top:1px solid #eee;margin-top:3px;padding-top:3px}
.js-vfilt{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 8px}.js-vfilt button{padding:4px 10px;border-radius:999px;border:1px solid #ddd;background:#fff;color:#222;cursor:pointer;font-size:13px;margin:0}
.js-vfilt button.on{background:#222;color:#fff;border-color:#222}.js-vfilt i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
.js-vc-money i{background:#2e7d32}.js-vc-cancel i{background:#c62828}.js-vc-empty i{background:#1f1a17}.js-vc-test i{background:#b0a69c}.js-vfilt .js-hint{margin-left:8px}
.js-c-money td{color:#1a7f37}.js-c-cancel td{color:#c62828}.js-c-empty td{color:#1f1a17}.js-c-money td:first-child{box-shadow:inset 4px 0 #2e7d32}.js-c-cancel td:first-child{box-shadow:inset 4px 0 #c62828}
.js-c-empty td:first-child{box-shadow:inset 4px 0 #1f1a17}.js-c-test td:first-child{box-shadow:inset 4px 0 #d8d0c8}.js-vbtn{padding:0 6px!important;margin:0!important;border:1px solid #ddd;border-radius:6px;background:#fff;color:#222;cursor:pointer;font-size:12px}
.js-vlog{margin:2px 0 6px;padding-left:18px;font-size:13px;line-height:1.5}.js-vlog .js-warn{color:#c62828}.js-vrow td{background:#faf7f4}
.js-bars i{display:block;width:100%;background:#c8553d;border-radius:3px 3px 0 0;min-height:1px}.js-bars span{font-size:9px;color:#8a7f76;margin-top:2px}.js-body h3{margin:18px 0 6px}`;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
  window.JetStats = { mount };
})();
