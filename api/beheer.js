// The maker's overview (kwibus.online/beheer): turns the stored event batches
// into one session list per day. Days before today are compacted once into
// day/<yyyy-mm-dd>.json so the raw files are read only once.
import { list, get, put } from '@vercel/blob';
import { names } from './_names.js';

const MAX_DAYS = 365;

function unauthorized(res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({ error: 'sleutel klopt niet' });
}

export default async function handler(req, res) {
  const key = process.env.KW_ADMIN_KEY;
  const given = req.headers['x-kw-key'] || req.query.key;
  if (!key || typeof given !== 'string' || given.length !== key.length || !timingSafeEqual(given, key)) {
    return unauthorized(res);
  }
  let days = Math.min(MAX_DAYS, Math.max(1, parseInt(req.query.days, 10) || 30));
  const today = new Date().toISOString().slice(0, 10);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const perDay = await Promise.all(dates.map((d) => sessionsFor(d, d < today)));
  const sessions = [];
  perDay.forEach((list, i) => {
    for (const s of list) sessions.push({ day: dates[i], ...s });
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ today, days, names, sessions });
}

function timingSafeEqual(a, b) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readJson(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || !r.stream) return null;
  try {
    return JSON.parse(await new Response(r.stream).text());
  } catch {
    return null;
  }
}

async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function sessionsFor(day, compactable) {
  const compactPath = `day/${day}.json`;
  if (compactable) {
    const done = await readJson(compactPath).catch(() => null);
    if (done && Array.isArray(done.sessions)) return done.sessions;
  }
  const blobs = await listAll(`ev/${day}/`);
  if (blobs.length === 0) return [];
  const batches = [];
  // Read in groups so a busy day does not open hundreds of connections at once.
  for (let i = 0; i < blobs.length; i += 25) {
    const chunk = blobs.slice(i, i + 25);
    const got = await Promise.all(chunk.map((b) => readJson(b.pathname).catch(() => null)));
    batches.push(...got.filter(Boolean));
  }
  const sessions = fold(batches);
  if (compactable) {
    await put(compactPath, JSON.stringify({ day, sessions }), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    }).catch((e) => console.error('beheer: compact failed', e?.message || e));
  }
  return sessions;
}

// One record per visit: who (anonymous visitor id), what device, and every
// game screen that was opened, with how long it stayed open.
function fold(batches) {
  const bySession = new Map();
  const events = [];
  for (const b of batches) {
    if (!b || !Array.isArray(b.ev)) continue;
    for (const e of b.ev) events.push({ ...e, v: b.v, s: b.s });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    let s = bySession.get(e.s);
    if (!s) {
      s = { s: e.s, v: e.v, first: e.at, last: e.at, plays: [] };
      bySession.set(e.s, s);
    }
    s.last = Math.max(s.last, e.at);
    s.first = Math.min(s.first, e.at);
    if (e.t === 'open') {
      Object.assign(s, {
        new: !!e.new, platform: e.platform, lang: e.lang, w: e.w, h: e.h, tz: e.tz,
      });
    } else if (e.t === 'start') {
      s.plays.push({
        game: e.game, mode: e.mode, n: e.n, names: e.names || [], daily: !!e.daily, resumed: !!e.resumed,
        start: e.at, last: e.at, secs: null, finished: false, won: null,
      });
    } else if (e.t === 'end' || e.t === 'finish' || e.t === 'ping') {
      const p = [...s.plays].reverse().find((x) => x.game === e.game);
      if (!p) continue;
      p.last = Math.max(p.last, e.at);
      if (e.t === 'end') p.secs = e.secs;
      if (e.t === 'finish') {
        p.finished = true;
        if (e.won === true || e.won === false) p.won = e.won;
      }
    }
  }
  for (const s of bySession.values()) {
    for (const p of s.plays) {
      // No end event (tab closed): the last sign of life stands in for it.
      if (p.secs == null) {
        p.secs = Math.max(0, Math.round((p.last - p.start) / 1000));
        p.open = true;
      }
    }
  }
  return [...bySession.values()];
}
