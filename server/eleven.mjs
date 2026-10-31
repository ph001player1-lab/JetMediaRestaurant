// Голоса персонажей через ElevenLabs: сервер озвучивает фразу один раз и хранит MP3 в uploads,
// дальше планшеты получают готовый файл. Ключ API хранится на сервере (вводится в портале).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ELEVEN_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function elevenApi(key, p, opts = {}) {
  const r = await fetch(`https://api.elevenlabs.io${p}`, {
    ...opts, headers: { 'xi-api-key': key, ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000),
  }).catch((e) => { throw fail(502, `ElevenLabs недоступен: ${e.message}`); });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.detail?.message || j.detail?.status || JSON.stringify(j.detail ?? j).slice(0, 200); } catch {}
    throw fail(r.status === 401 ? 400 : 502, `ElevenLabs: ${msg}`);
  }
  return r;
}

// Голоса аккаунта: свои (созданные, клонированные) — первыми
export async function elevenVoices(key) {
  const j = await (await elevenApi(key, '/v1/voices')).json();
  const own = (v) => (v.category === 'premade' ? 1 : 0);
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category }))
    .sort((a, b) => own(a) - own(b) || a.name.localeCompare(b.name));
}

// Остаток символов на тарифе (если ключу разрешено читать данные пользователя)
export async function elevenUsage(key) {
  try {
    const j = await (await elevenApi(key, '/v1/user/subscription')).json();
    return { used: j.character_count, limit: j.character_limit };
  } catch { return null; }
}

// MP3 фразы голосом voiceId: из кэша или новый синтез (одинаковые запросы одновременно — один синтез)
const pending = new Map();
export function cachedTts(dir, voiceId, model, text) {
  const name = `${crypto.createHash('sha1').update(`${voiceId}|${model}|${text}`).digest('hex').slice(0, 24)}.mp3`;
  return { name, url: `/uploads/${name}`, cached: fs.existsSync(path.join(dir, name)) };
}
export async function synthesize(dir, key, voiceId, model, text) {
  const f = cachedTts(dir, voiceId, model, text);
  if (f.cached) return f.url;
  if (!pending.has(f.name)) {
    pending.set(f.name, (async () => {
      const r = await elevenApi(key, `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model }),
      });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(await r.arrayBuffer()));
    })().finally(() => pending.delete(f.name)));
  }
  await pending.get(f.name);
  return f.url;
}
