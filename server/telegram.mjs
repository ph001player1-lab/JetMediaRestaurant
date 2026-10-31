// Оповещения администратору в Telegram. Бот создаётся у @BotFather, токен вводится в портале;
// получатели — чаты, которые написали боту /start (или группы, куда бота добавили).
const fail = (message) => Object.assign(new Error(message), { status: 400 });

export async function tgApi(token, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => { throw fail(`Telegram недоступен: ${e.message}`); });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw fail(`Telegram: ${j.description || `HTTP ${r.status}`}`);
  return j.result;
}

// strict — для кнопки «Тест»: ошибку показываем в портале, а не только в логе
export async function tgSend(tg, text, strict = false) {
  if (!tg?.token || !tg.chats?.length) {
    if (strict) throw fail('Нет получателей: напишите боту /start и нажмите «Найти чаты»');
    return;
  }
  for (const c of tg.chats) {
    try {
      await tgApi(tg.token, 'sendMessage', { chat_id: c.id, text, disable_web_page_preview: true });
    } catch (e) {
      if (strict) throw e;
      console.error('telegram:', c.id, e.message);
    }
  }
}

// Добавляет в получатели всех, кто написал боту за последние сутки
export async function tgFindChats(tg) {
  const updates = await tgApi(tg.token, 'getUpdates', { allowed_updates: ['message', 'my_chat_member', 'channel_post'] });
  for (const u of updates) {
    const m = u.message || u.channel_post || u.my_chat_member;
    if (!m?.chat || ['left', 'kicked'].includes(u.my_chat_member?.new_chat_member?.status)) continue;
    const { id, title, first_name, last_name, username } = m.chat;
    if (!tg.chats.some((c) => c.id === id)) {
      tg.chats.push({ id, name: title || [first_name, last_name].filter(Boolean).join(' ') || username || String(id) });
    }
  }
  // отмечаем сообщения прочитанными, чтобы не разбирать их повторно
  if (updates.length) await tgApi(tg.token, 'getUpdates', { offset: updates.at(-1).update_id + 1, limit: 1 });
}
