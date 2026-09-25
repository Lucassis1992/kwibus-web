// Receives the anonymous usage events from the app (lib/core/usage.dart) and
// stores each event as one row in the events table (see _db.js), under the
// day it was received. Nothing about the sender is added: no IP address, no
// user agent.
import { db, ensure } from './_db.js';

const TYPES = new Set(['open', 'start', 'end', 'finish', 'ping']);
const ID = /^[a-z0-9]{8,32}$/;
const STR = /^[a-zA-Z0-9_-]{1,40}$/;

function clean(ev) {
  if (!ev || typeof ev !== 'object' || !TYPES.has(ev.t)) return null;
  const at = Number(ev.at);
  if (!Number.isFinite(at) || at < 1.7e12 || at > 4e12) return null;
  const out = { t: ev.t, at: Math.round(at) };
  for (const k of ['game', 'mode', 'platform', 'lang']) {
    if (typeof ev[k] === 'string' && STR.test(ev[k])) out[k] = ev[k];
  }
  for (const k of ['n', 'w', 'h', 'tz', 'secs']) {
    const v = Number(ev[k]);
    if (Number.isFinite(v) && Math.abs(v) < 1e7) out[k] = Math.round(v);
  }
  for (const k of ['new', 'daily', 'resumed']) {
    if (typeof ev[k] === 'boolean') out[k] = ev[k];
  }
  if (ev.won === true || ev.won === false || ev.won === null) out.won = ev.won;
  if (Array.isArray(ev.names)) {
    const names = ev.names
      .filter((n) => typeof n === 'string')
      .map((n) => n.replace(/[\p{C}]/gu, '').trim().slice(0, 24))
      .filter(Boolean)
      .slice(0, 8);
    if (names.length) out.names = names;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || !ID.test(body.v || '') || !ID.test(body.s || '') || !Array.isArray(body.ev)) {
    return res.status(400).end();
  }
  const ev = body.ev.slice(0, 50).map(clean).filter(Boolean);
  if (ev.length === 0) return res.status(204).end();
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await ensure();
    await db().batch(
      ev.map((e) => ({
        sql: `INSERT INTO events (day, rec, v, s, t, at, game, mode, platform, lang, n, w, h, tz, secs, new, daily, resumed, won, names)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          day, now, body.v, body.s, e.t, e.at,
          e.game ?? null, e.mode ?? null, e.platform ?? null, e.lang ?? null,
          e.n ?? null, e.w ?? null, e.h ?? null, e.tz ?? null, e.secs ?? null,
          flag(e.new), flag(e.daily), flag(e.resumed), flag(e.won),
          e.names ? JSON.stringify(e.names) : null,
        ],
      })),
      'write',
    );
  } catch (e) {
    console.error('track: insert failed', e?.message || e);
    return res.status(500).end();
  }
  res.status(204).end();
}

/// true/false as 1/0; anything else (unknown) as null.
function flag(v) {
  return v === true ? 1 : v === false ? 0 : null;
}
