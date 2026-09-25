// The one database behind the API: a Turso (libSQL, SQLite in the cloud)
// database, reached over HTTP so it works from a serverless function. The
// URL and token come from the Vercel project's environment variables
// (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN). The tables are made on first use.
import { createClient } from '@libsql/client/web';

let client;
let ready;

export function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) throw new Error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN ontbreken');
    client = createClient({ url, authToken });
  }
  return client;
}

/// Runs the schema once per warm instance.
export function ensure() {
  ready ??= db().batch(
    [
      `CREATE TABLE IF NOT EXISTS daily_scores (
        game TEXT NOT NULL, day INTEGER NOT NULL, v TEXT NOT NULL,
        name TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER, at INTEGER NOT NULL,
        PRIMARY KEY (game, day, v))`,
      `CREATE INDEX IF NOT EXISTS daily_scores_rank ON daily_scores (game, day, a, b, at)`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, day TEXT NOT NULL, rec INTEGER NOT NULL,
        v TEXT NOT NULL, s TEXT NOT NULL, t TEXT NOT NULL, at INTEGER NOT NULL,
        game TEXT, mode TEXT, platform TEXT, lang TEXT,
        n INTEGER, w INTEGER, h INTEGER, tz INTEGER, secs INTEGER,
        new INTEGER, daily INTEGER, resumed INTEGER, won INTEGER, names TEXT)`,
      `CREATE INDEX IF NOT EXISTS events_day ON events (day, at)`,
    ],
    'write',
  );
  return ready;
}
