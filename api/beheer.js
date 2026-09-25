// The maker's overview (kwibus.online/beheer): turns the stored events into
// one session list per day. Events live in the events table (see _db.js);
// days from before the move to the database (2026-09-25) are read from the
// compacted day/<yyyy-mm-dd>.json files in the old Blob store as long as
// that store answers.
import { get } from '@vercel/blob';
import { db, ensure } from './_db.js';
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

async function sessionsFor(day, past) {
  let rows = [];
  try {
    await ensure();
    const r = await db().execute({ sql: 'SELECT * FROM events WHERE day = ? ORDER BY at', args: [day] });
    rows = r.rows;
  } catch (e) {
    console.error('beheer: db failed', e?.message || e);
  }
  if (rows.length === 0 && past) {
    const done = await readJson(`day/${day}.json`).catch(() => null);
    if (done && Array.isArray(done.sessions)) return done.sessions;
    return [];
  }
  return fold(
    rows.map((r) => ({
      v: r.v, s: r.s, t: r.t, at: Number(r.at),
      game: r.game ?? undefined, mode: r.mode ?? undefined, platform: r.platform ?? undefined, lang: r.lang ?? undefined,
      n: num(r.n), w: num(r.w), h: num(r.h), tz: num(r.tz), secs: num(r.secs),
      new: bool(r.new), daily: bool(r.daily), resumed: bool(r.resumed), won: bool(r.won),
      names: r.names ? JSON.parse(r.names) : undefined,
    })),
  );
}

function num(v) {
  return v == null ? undefined : Number(v);
}

function bool(v) {
  return v == null ? null : Number(v) === 1;
}

// One record per visit: who (anonymous visitor id), what device, and every
// game screen that was opened, with how long it stayed open.
function fold(events) {
  const bySession = new Map();
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
