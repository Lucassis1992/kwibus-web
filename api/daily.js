// The daily-puzzle leaderboard (lib/core/daily_board.dart): one board per
// game per day, everyone plays the same puzzle, so the times compare.
//
//   POST /api/daily  {v, game, day, name, a, b?}   put my result on the board
//   GET  /api/daily?game=&day=&v=[&a=&b=]          read the board; with a/b,
//                                                  "me" is where I would land
//
// Storage: one small private blob per entry, board/<game>/<day>/<v>.json,
// so two people finishing at once never overwrite each other; the board is
// put together on read and kept for a short while in boardcache/. Nothing
// about the sender is stored beyond the random install id, the name they
// typed and the score. A device gets one entry per game per day; the first
// one stays.
import { list, get, put } from '@vercel/blob';

// Lowest and highest score that counts per game: milliseconds for the timed
// puzzles, tries for the word, mistakes for the foursomes. Lower is better.
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
const MAX_ENTRIES = 1000;
const CACHE_MS = 20000;
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

  let entries;
  try {
    entries = await loadEntries(game, day);
  } catch (e) {
    console.error('daily: load failed', e?.message || e);
    return res.status(500).end();
  }
  let mine = entries.find((e) => e.v === v) || null;

  if (req.method === 'POST') {
    if (!score) return res.status(400).json({ error: 'score' });
    const name = cleanName(q.name);
    if (name === 'refused') return res.status(422).json({ error: 'name' });
    if (!name) return res.status(400).json({ error: 'name' });
    if (!mine) {
      mine = { v, name, a: score.a, b: score.b, at: Date.now() };
      try {
        await put(`board/${game}/${day}/${v}.json`, JSON.stringify(mine), {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json',
        });
      } catch (e) {
        console.error('daily: put failed', e?.message || e);
        return res.status(500).end();
      }
      entries.push(mine);
      sortEntries(entries);
      await saveCache(game, day, entries);
    }
  }

  return res.status(200).json(board(game, day, entries, v, mine, score));
}

/// The board as the app shows it: the top rows, and where I stand. Without
/// an entry of my own but with a score, "me" is the row I would get.
function board(game, day, entries, v, mine, score) {
  const rows = entries.map((e, i) => ({ rank: i + 1, name: e.name, a: e.a, b: e.b, me: e.v === v }));
  let me = null;
  if (mine) {
    const i = entries.indexOf(mine);
    me = { rank: i + 1, name: mine.name, a: mine.a, b: mine.b, virtual: false };
  } else if (score) {
    const probe = { a: score.a, b: score.b, at: Infinity };
    let rank = 1;
    for (const e of entries) if (compare(e, probe) < 0) rank++;
    me = { rank, name: null, a: score.a, b: score.b, virtual: true };
  }
  return { game, day, n: entries.length, top: rows.slice(0, TOP), me };
}

function compare(x, y) {
  return x.a - y.a || (x.b || 0) - (y.b || 0) || x.at - y.at;
}

function sortEntries(entries) {
  entries.sort(compare);
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

async function loadEntries(game, day) {
  const cached = await readJson(cachePath(game, day));
  if (cached && Array.isArray(cached.entries) && Date.now() - cached.at < CACHE_MS) return cached.entries;
  const page = await list({ prefix: `board/${game}/${day}/`, limit: MAX_ENTRIES });
  const entries = [];
  const blobs = page.blobs.filter((b) => b.pathname.endsWith('.json'));
  for (let i = 0; i < blobs.length; i += 50) {
    const part = await Promise.all(blobs.slice(i, i + 50).map((b) => readJson(b.pathname)));
    for (const e of part) {
      if (e && typeof e.v === 'string' && typeof e.name === 'string' && Number.isInteger(e.a)) entries.push(e);
    }
  }
  sortEntries(entries);
  await saveCache(game, day, entries);
  return entries;
}

function cachePath(game, day) {
  return `boardcache/${game}/${day}.json`;
}

async function saveCache(game, day, entries) {
  try {
    await put(cachePath(game, day), JSON.stringify({ at: Date.now(), entries }), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (e) {
    // The board is still served; the next read just builds it again.
    console.error('daily: cache failed', e?.message || e);
  }
}

async function readJson(pathname) {
  try {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch {
    return null;
  }
}
