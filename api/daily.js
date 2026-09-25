// The daily-puzzle leaderboard (lib/core/daily_board.dart): one board per
// game per day, everyone plays the same puzzle, so the times compare.
//
//   POST /api/daily  {v, game, day, name, a, b?}   put my result on the board
//   GET  /api/daily?game=&day=&v=[&a=&b=]          read the board; with a/b,
//                                                  "me" is where I would land
//
// Storage: one row per entry in the daily_scores table (see _db.js), with
// the primary key on game, day and device: a device gets one entry per
// board and the first one stays. Nothing about the sender is stored beyond
// the random install id, the name they typed and the score.
import { db, ensure } from './_db.js';

const GAMES = {
  sudoku: [20000, 1e7],
  kroontjes: [2000, 1e7],
  tegelberg: [5000, 1e7],
  evenwicht: [2000, 1e7],
  woordje: [1, 6],
  groepjes: [0, 3],
};
const ID = /^[a-z0-9]{8,32}$/;
const TOP = 10;
// Names that have no place on a public board. Matched on letters only, so
// spacing and accents do not get around it.
const BAD = ['kanker', 'tering', 'tyfus', 'hoer', 'neuk', 'fuck', 'shit', 'nazi', 'hitler', 'nigg', 'cunt', 'slet', 'bitch', 'kut', 'pussy', 'penis'];

export default async function handler(req, res) {
  // The app also runs from a phone or a dev build on another origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).end();
  }
  const q = req.method === 'POST' ? req.body : req.query;
  if (!q || typeof q !== 'object') return res.status(400).json({ error: 'body' });
  const game = typeof q.game === 'string' && GAMES[q.game] ? q.game : null;
  const day = validDay(q.day);
  const v = typeof q.v === 'string' && ID.test(q.v) ? q.v : null;
  if (!game || !day || !v) return res.status(400).json({ error: 'request' });
  const score = cleanScore(game, q.a, q.b);

  let name = null;
  if (req.method === 'POST') {
    if (!score) return res.status(400).json({ error: 'score' });
    name = cleanName(q.name);
    if (name === 'refused') return res.status(422).json({ error: 'name' });
    if (!name) return res.status(400).json({ error: 'name' });
  }
  try {
    await ensure();
    if (name) {
      await db().execute({
        sql: 'INSERT OR IGNORE INTO daily_scores (game, day, v, name, a, b, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [game, day, v, name, score.a, score.b, Date.now()],
      });
    }
    return res.status(200).json(await board(game, day, v, score));
  } catch (e) {
    console.error('daily: db failed', e?.message || e);
    return res.status(500).end();
  }
}

/// The board as the app shows it: the top rows, and where I stand. Without
/// an entry of my own but with a score, "me" is the row I would get.
async function board(game, day, v, score) {
  const c = db();
  const where = 'game = ? AND day = ?';
  const [top, count, mine] = await c.batch(
    [
      { sql: `SELECT v, name, a, b FROM daily_scores WHERE ${where} ORDER BY a, COALESCE(b, 0), at LIMIT ${TOP}`, args: [game, day] },
      { sql: `SELECT COUNT(*) AS n FROM daily_scores WHERE ${where}`, args: [game, day] },
      { sql: `SELECT name, a, b, at FROM daily_scores WHERE ${where} AND v = ?`, args: [game, day, v] },
    ],
    'read',
  );
  const n = Number(count.rows[0]?.n ?? 0);
  const rows = top.rows.map((r, i) => ({ rank: i + 1, name: r.name, a: Number(r.a), b: r.b == null ? null : Number(r.b), me: r.v === v }));
  let me = null;
  const own = mine.rows[0];
  if (own) {
    const rank = await rankOf(game, day, Number(own.a), own.b == null ? 0 : Number(own.b), Number(own.at));
    me = { rank, name: own.name, a: Number(own.a), b: own.b == null ? null : Number(own.b), virtual: false };
  } else if (score) {
    // Where the score would land, behind everyone it ties with.
    const rank = await rankOf(game, day, score.a, score.b ?? 0, null);
    me = { rank, name: null, a: score.a, b: score.b, virtual: true };
  }
  return { game, day, n, top: rows, me };
}

/// One plus the number of entries that beat (a, b, at): lower a, then lower
/// b, then earlier. With [at] null every tie counts as ahead.
async function rankOf(game, day, a, b, at) {
  const r = await db().execute({
    sql: `SELECT COUNT(*) AS c FROM daily_scores WHERE game = ? AND day = ?
          AND (a < ? OR (a = ? AND COALESCE(b, 0) < ?) OR (a = ? AND COALESCE(b, 0) = ? AND ${at == null ? '1' : 'at < ?'}))`,
    args: at == null ? [game, day, a, a, b, a, b] : [game, day, a, a, b, a, b, at],
  });
  return Number(r.rows[0]?.c ?? 0) + 1;
}

function cleanScore(game, a, b) {
  if (a === undefined || a === null || a === '') return null;
  const [lo, hi] = GAMES[game];
  const na = Number(a);
  if (!Number.isInteger(na) || na < lo || na > hi) return null;
  const out = { a: na, b: null };
  if (b !== undefined && b !== null && b !== '') {
    const nb = Number(b);
    if (Number.isInteger(nb) && nb >= 0 && nb < 1e6) out.b = nb;
  }
  return out;
}

/// The name as it goes on the board, null when there is nothing left of it,
/// 'refused' when it is not fit for a public list.
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  if (!name) return null;
  const letters = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  if (BAD.some((w) => letters.includes(w))) return 'refused';
  return name;
}

/// yyyymmdd as the app sends it (its local date), accepted when it is
/// yesterday, today or tomorrow in UTC: the world is at most a day apart.
function validDay(raw) {
  const day = Number(raw);
  if (!Number.isInteger(day)) return null;
  for (const shift of [-1, 0, 1]) {
    const d = new Date(Date.now() + shift * 86400000);
    if (day === d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()) return day;
  }
  return null;
}

