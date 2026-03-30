const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PARTY_ID = 'new_people';

// SQLite (файл создается рядом со server.js)
const dbPath = path.join(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
    db.run(`
      CREATE TABLE IF NOT EXISTS party_scores (
        user_id TEXT PRIMARY KEY,
        user_name TEXT,
        taps INTEGER NOT NULL DEFAULT 0,
        multiplier REAL NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
});

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// 1) Рапорт очков партии при тапах (весь онлайн отдаёт вклад).
app.post('/api/party-taps/report', (req, res) => {
  const { userId, partyId, delta, userName } = req.body || {};
  if (!userId || !partyId) {
    return res.status(400).json({ error: 'bad_request', message: 'userId and partyId are required' });
  }

  if (String(partyId) !== PARTY_ID) {
    // Пока поддерживаем только new_people.
    return res.json({ ok: true });
  }

  const d = Math.round(toNumber(delta));
  if (d <= 0) {
    return res.status(400).json({ error: 'bad_delta', message: 'delta must be > 0' });
  }

  const id = String(userId);
  const name = userName ? String(userName) : null;

  // Upsert: taps = taps + delta
  // SQLite должен поддерживать ON CONFLICT.
  const sql = `
    INSERT INTO party_scores (user_id, user_name, taps, multiplier)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      taps = party_scores.taps + excluded.taps,
      updated_at = CURRENT_TIMESTAMP
  `;

  db.run(sql, [id, name, d], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Возвращаем актуальный score для удобства фронта
    db.get(`SELECT taps FROM party_scores WHERE user_id = ?`, [id], (err2, row) => {
      if (err2) {
        console.error(err2);
        return res.json({ ok: true });
      }
      return res.json({ ok: true, newPeopleScore: row?.taps || 0 });
    });
  });
});

// 2) Получить ваши очки и текущую фракцию (фронт считает прогресс сам)
app.post('/api/me/new-people-faction', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'bad_request', message: 'userId is required' });
  }

  const id = String(userId);
  db.get(`SELECT taps FROM party_scores WHERE user_id = ?`, [id], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    return res.json({ ok: true, newPeopleScore: row?.taps || 0 });
  });
});

// Fallback GET (чтобы совпасть с фронт-фолбэком)
app.get('/api/me/new-people-faction', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'bad_request', message: 'userId is required' });
  const id = String(userId);
  db.get(`SELECT taps FROM party_scores WHERE user_id = ?`, [id], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    return res.json({ ok: true, newPeopleScore: row?.taps || 0 });
  });
});

// 3) Топ-15 по очкам партии
app.get('/api/leaderboard/new-people', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 15;
  limit = Math.min(limit, 50);

  db.all(
    `
      SELECT user_id, user_name, taps
      FROM party_scores
      ORDER BY taps DESC
      LIMIT ?
    `,
    [limit],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }

      const top = (rows || []).map((r) => ({
        userId: r.user_id,
        name: r.user_name || 'Игрок',
        score: r.taps,
        newPeopleScore: r.taps
      }));

      return res.json({ ok: true, top });
    }
  );
});

// Fallback POST для таблицы (на случай если фронт решит fallback)
app.post('/api/leaderboard/new-people', (req, res) => {
  let limit = parseInt(req.body?.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 15;
  limit = Math.min(limit, 50);

  db.all(
    `
      SELECT user_id, user_name, taps
      FROM party_scores
      ORDER BY taps DESC
      LIMIT ?
    `,
    [limit],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }
      const top = (rows || []).map((r) => ({
        userId: r.user_id,
        name: r.user_name || 'Игрок',
        score: r.taps,
        newPeopleScore: r.taps
      }));
      return res.json({ ok: true, top });
    }
  );
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Tap Elephant backend listening on port ${PORT}`);
});

