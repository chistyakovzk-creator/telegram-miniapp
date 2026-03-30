const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PARTY_ID = 'new_people';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const dbPath = path.join(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err);
    return;
  }
  console.log('Connected to SQLite database');
  bootstrapSchema();
});

function bootstrapSchema() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS party_scores (
        user_id TEXT PRIMARY KEY,
        user_name TEXT,
        taps INTEGER NOT NULL DEFAULT 0,
        multiplier REAL NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referred_id TEXT,
        referred_name TEXT,
        invite_token TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        reward_claimed INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(referrer_id, referred_id)
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_party_scores_taps ON party_scores (taps DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_referrals_token ON referrals (invite_token)`);

    // Миграция старых баз (если колонок ещё нет)
    db.run(`ALTER TABLE referrals ADD COLUMN invite_token TEXT`, () => {});
  });
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function toId(body) {
  return body?.userId ?? body?.user_id ?? null;
}

function toName(body) {
  return body?.userName ?? body?.user_name ?? null;
}

function getScore(userId, cb) {
  db.get(`SELECT taps FROM party_scores WHERE user_id = ?`, [String(userId)], (err, row) => {
    if (err) return cb(err);
    cb(null, row?.taps || 0);
  });
}

function upsertAbsoluteScore({ userId, userName, taps, multiplier = 1 }, cb) {
  const id = String(userId);
  const name = userName ? String(userName) : null;
  const t = Math.max(0, toInt(taps, 0));
  const m = Number(multiplier) || 1;

  db.run(
    `
    INSERT INTO party_scores (user_id, user_name, taps, multiplier)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      taps = excluded.taps,
      user_name = COALESCE(excluded.user_name, party_scores.user_name),
      multiplier = excluded.multiplier,
      updated_at = CURRENT_TIMESTAMP
    `,
    [id, name, t, m],
    (err) => {
      if (err) return cb(err);
      getScore(id, cb);
    }
  );
}

function incrementScore({ userId, userName, delta }, cb) {
  const id = String(userId);
  const name = userName ? String(userName) : null;
  const d = Math.max(0, toInt(delta, 0));
  if (d <= 0) return cb(null, null);

  db.run(
    `
    INSERT INTO party_scores (user_id, user_name, taps, multiplier)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      taps = party_scores.taps + excluded.taps,
      user_name = COALESCE(excluded.user_name, party_scores.user_name),
      updated_at = CURRENT_TIMESTAMP
    `,
    [id, name, d],
    (err) => {
      if (err) return cb(err);
      getScore(id, cb);
    }
  );
}

function getTop(limit, cb) {
  const safe = Math.min(Math.max(toInt(limit, 15), 1), 100);
  db.all(
    `
      SELECT user_id, user_name, taps, multiplier, updated_at as timestamp
      FROM party_scores
      ORDER BY taps DESC
      LIMIT ?
    `,
    [safe],
    cb
  );
}

// ----------------------- SCORE / PARTY -----------------------

// Delta-report mode (new frontend): +delta
app.post('/api/party-taps/report', (req, res) => {
  const { userId, user_id, userName, user_name, partyId, delta } = req.body || {};
  const id = userId ?? user_id;
  const name = userName ?? user_name;
  if (!id) return res.status(400).json({ error: 'userId is required' });
  if (partyId && String(partyId) !== PARTY_ID) return res.json({ ok: true });

  incrementScore({ userId: id, userName: name, delta }, (err, score) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    return res.json({ ok: true, newPeopleScore: score || 0 });
  });
});

// Absolute-score mode (legacy frontend): taps = value
app.post('/api/me/new-people-faction', (req, res) => {
  const body = req.body || {};
  const userId = toId(body);
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const tapsInBody = body.taps;
  if (tapsInBody !== undefined && tapsInBody !== null) {
    upsertAbsoluteScore(
      {
        userId,
        userName: toName(body),
        taps: tapsInBody,
        multiplier: body.multiplier
      },
      (err, score) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Database error' });
        }
        return res.json({ ok: true, newPeopleScore: score });
      }
    );
    return;
  }

  getScore(userId, (err, score) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    return res.json({ ok: true, newPeopleScore: score });
  });
});

// GET: either single user by userId or leaderboard by limit (legacy compatibility)
app.get('/api/me/new-people-faction', (req, res) => {
  const userId = req.query.userId;
  const limit = req.query.limit;

  if (userId) {
    return getScore(userId, (err, score) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }
      return res.json({ ok: true, newPeopleScore: score });
    });
  }

  if (limit !== undefined) {
    return getTop(limit, (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }
      // legacy raw-array response for old frontend
      return res.json(
        (rows || []).map((r) => ({
          user_id: r.user_id,
          user_name: r.user_name,
          taps: r.taps,
          multiplier: r.multiplier,
          timestamp: r.timestamp
        }))
      );
    });
  }

  return res.status(400).json({ error: 'Provide userId or limit' });
});

app.get('/api/leaderboard/new-people', (req, res) => {
  getTop(req.query.limit, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    const top = (rows || []).map((r) => ({
      userId: r.user_id,
      user_name: r.user_name,
      name: r.user_name || 'Игрок',
      score: r.taps,
      taps: r.taps,
      newPeopleScore: r.taps
    }));
    return res.json({ ok: true, top });
  });
});

app.post('/api/leaderboard/new-people', (req, res) => {
  getTop(req.body?.limit, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    const top = (rows || []).map((r) => ({
      userId: r.user_id,
      user_name: r.user_name,
      name: r.user_name || 'Игрок',
      score: r.taps,
      taps: r.taps,
      newPeopleScore: r.taps
    }));
    return res.json({ ok: true, top });
  });
});

// ----------------------- REFERRALS -----------------------

// Создание приглашения (pending) с одноразовым invite_token
app.post('/api/referrals/invite', (req, res) => {
  const referrerId = String(toId(req.body) || '');
  const referrerName = String(toName(req.body) || '');
  if (!referrerId) return res.status(400).json({ error: 'referrerId required' });

  const token = crypto.randomBytes(16).toString('hex');
  db.run(
    `
      INSERT INTO referrals (referrer_id, referred_name, invite_token, status)
      VALUES (?, ?, ?, 'pending')
    `,
    [referrerId, referrerName || null, token],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || 'Database error' });
      }
      const inviteLink = `https://t.me/New_people_start_bot?start=invite_${token}`;
      return res.json({ ok: true, inviteLink, token });
    }
  );
});

// Register referral using start param (e.g. ref_123456)
app.post('/api/referrals/register', (req, res) => {
  const userId = String(toId(req.body) || '');
  const userName = String(toName(req.body) || '');
  const startParam = String(req.body?.startParam || '');
  let referrerId = String(req.body?.referrerId || '');

  if (!userId || !startParam) {
    return res.status(400).json({ error: 'userId and startParam are required' });
  }

  let token = null;
  if (startParam.startsWith('invite_')) token = startParam.slice(7);

  if (token) {
    // Новый формат invite_<token>
    return db.get(
      `SELECT id, referrer_id FROM referrals WHERE invite_token = ? AND status = 'pending'`,
      [token],
      (err, row) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: err.message || 'Database error' });
        }
        if (!row) {
          return res.status(404).json({ error: 'Invite not found or already used' });
        }
        referrerId = String(row.referrer_id || '');
        if (!referrerId || referrerId === userId) return res.json({ ok: true });

        db.run(
          `UPDATE referrals SET referred_id = ?, referred_name = ?, status = 'active' WHERE id = ?`,
          [userId, userName || null, row.id],
          function (upErr) {
            if (upErr) {
              console.error(upErr);
              return res.status(500).json({ error: upErr.message || 'Database error' });
            }
            // Бонус приглашенному
            incrementScore({ userId, userName, delta: 5 }, () => {});
            return res.json({ ok: true, invitedAward: { id: `invited_${userId}`, taps: 5 } });
          }
        );
      }
    );
  }

  // Старый формат ref_<id>
  if (referrerId) {
    if (userId === referrerId) return res.json({ ok: true });
    return db.run(
      `
        INSERT INTO referrals (referrer_id, referred_id, referred_name, status, reward_claimed)
        VALUES (?, ?, ?, 'active', 0)
        ON CONFLICT(referrer_id, referred_id) DO UPDATE SET status = 'active'
      `,
      [referrerId, userId, userName || null],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Database error' });
        }
        incrementScore({ userId, userName, delta: 5 }, () => {});
        return res.json({ ok: true, invitedAward: { id: `invited_${userId}`, taps: 5 } });
      }
    );
  }

  return res.status(400).json({ error: 'Invalid startParam' });
});

// Get referral lists + rewards for referrer
app.post('/api/referrals/me', (req, res) => {
  const userId = String(toId(req.body) || '');
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  db.all(
    `
      SELECT referrer_id, referred_id, referred_name, status, reward_claimed, created_at
      FROM referrals
      WHERE referrer_id = ?
      ORDER BY created_at DESC
    `,
    [userId],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }

      const active = [];
      const pending = [];
      const awards = [];
      for (const r of rows || []) {
        const item = {
          userId: r.referred_id,
          name: r.referred_name || 'Друг',
          status: r.status
        };
        if (String(r.status) === 'active') active.push(item);
        else pending.push(item);

        if (String(r.status) === 'active' && Number(r.reward_claimed || 0) === 0) {
          awards.push({ id: `ref_${r.referrer_id}_${r.referred_id}`, taps: 5 });
        }
      }

      // mark new rewards as claimed
      if (awards.length) {
        db.run(
          `
            UPDATE referrals
            SET reward_claimed = 1
            WHERE referrer_id = ? AND status = 'active' AND reward_claimed = 0
          `,
          [userId],
          (uErr) => {
            if (uErr) console.error(uErr);
          }
        );
      }

      // apply rewards to referrer score
      const totalAward = awards.reduce((a, b) => a + (b.taps || 0), 0);
      if (totalAward > 0) {
        incrementScore({ userId, userName: null, delta: totalAward }, () => {
          return res.json({
            ok: true,
            referralsClaimed: active.length,
            referralsActive: active,
            referralsPending: pending,
            awards
          });
        });
      } else {
        return res.json({
          ok: true,
          referralsClaimed: active.length,
          referralsActive: active,
          referralsPending: pending,
          awards: []
        });
      }
    }
  );
});

// ----------------------- SUBSCRIPTION -----------------------

// Заглушка проверки подписки. Для production замените на реальную проверку Bot API getChatMember.
// Сейчас возвращаем false по умолчанию, либо true если ENV MOCK_SUBSCRIBED=true
app.post('/api/check-subscription', (req, res) => {
  const subscribed = String(process.env.MOCK_SUBSCRIBED || 'false').toLowerCase() === 'true';
  res.json({ ok: true, subscribed });
});

// ----------------------- HEALTH -----------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Tap Elephant backend listening on port ${PORT}`);
});

