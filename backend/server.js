const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PARTY_ID = 'new_people';
const BOSS_REWARD_TAPS = 5000;
const BOSS_ATTACKER_WINDOW_MS = 2 * 60 * 1000;
const BOSSES = [
  { id: 'er', name: 'Медведь Единой России', emoji: '🐻', hpMax: 1000000, nextId: 'ldpr' },
  { id: 'ldpr', name: 'Орёл ЛДПР', emoji: '🦅', hpMax: 2500000, nextId: 'yabloko' },
  { id: 'yabloko', name: 'Яблоко', emoji: '🍏', hpMax: 5000000, nextId: 'kprf' },
  { id: 'kprf', name: 'Серп и молот', emoji: '🔨🌾', hpMax: 12000000, nextId: 'sr' },
  { id: 'sr', name: 'Тигр Справедливой России', emoji: '🐯', hpMax: 30000000, nextId: null }
];

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
    db.run(`
      CREATE TABLE IF NOT EXISTS global_boss (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        boss_id TEXT NOT NULL,
        current_hp INTEGER NOT NULL,
        max_hp INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        defeated_at DATETIME,
        defeat_seq INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS boss_recent_attackers (
        user_id TEXT PRIMARY KEY,
        user_name TEXT,
        last_hit_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS boss_reward_claims (
        user_id TEXT PRIMARY KEY,
        last_claimed_seq INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_boss_attackers_last_hit ON boss_recent_attackers (last_hit_at DESC)`);
    db.run(
      `INSERT OR IGNORE INTO global_boss (id, boss_id, current_hp, max_hp, is_active) VALUES (1, ?, ?, ?, 1)`,
      [BOSSES[0].id, BOSSES[0].hpMax, BOSSES[0].hpMax]
    );

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

function bossById(id) {
  return BOSSES.find((b) => b.id === id) || BOSSES[0];
}

function buildBossStatePayload(row) {
  const current = bossById(row?.boss_id);
  const next = current.nextId ? bossById(current.nextId) : null;
  return {
    bossId: current.id,
    bossName: current.name,
    bossEmoji: current.emoji,
    currentHp: Math.max(0, Number(row?.current_hp || current.hpMax)),
    maxHp: Math.max(1, Number(row?.max_hp || current.hpMax)),
    isActive: Number(row?.is_active || 0) === 1,
    nextBossId: next ? next.id : null,
    nextBossName: next ? next.name : null,
    nextBossEmoji: next ? next.emoji : null,
    defeatSeq: Number(row?.defeat_seq || 0),
    reward: BOSS_REWARD_TAPS
  };
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

// ----------------------- GLOBAL BOSS -----------------------

app.get('/api/boss/state', (_req, res) => {
  db.get(`SELECT * FROM global_boss WHERE id = 1`, [], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    return res.json({ ok: true, ...buildBossStatePayload(row) });
  });
});

app.post('/api/boss/attack', (req, res) => {
  const userId = String(toId(req.body) || '');
  const userName = String(toName(req.body) || '');
  const damage = Math.max(0, toInt(req.body?.damage, 0));
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (damage <= 0) return res.status(400).json({ error: 'damage must be > 0' });

  const nowMs = Date.now();
  db.serialize(() => {
    db.run(
      `
      INSERT INTO boss_recent_attackers (user_id, user_name, last_hit_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        user_name = COALESCE(excluded.user_name, boss_recent_attackers.user_name),
        last_hit_at = excluded.last_hit_at
      `,
      [userId, userName || null, nowMs]
    );

    db.get(`SELECT * FROM global_boss WHERE id = 1`, [], (getErr, row) => {
      if (getErr) {
        console.error(getErr);
        return res.status(500).json({ error: 'Database error' });
      }
      const current = bossById(row?.boss_id);
      const oldHp = Math.max(0, Number(row?.current_hp || current.hpMax));
      const newHp = oldHp - damage;

      if (newHp > 0) {
        return db.run(
          `
          UPDATE global_boss
          SET current_hp = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
          `,
          [newHp],
          (upErr) => {
            if (upErr) {
              console.error(upErr);
              return res.status(500).json({ error: 'Database error' });
            }
            return db.get(`SELECT * FROM global_boss WHERE id = 1`, [], (finalErr, finalRow) => {
              if (finalErr) {
                console.error(finalErr);
                return res.status(500).json({ error: 'Database error' });
              }
              return res.json({ ok: true, bossDefeated: false, ...buildBossStatePayload(finalRow) });
            });
          }
        );
      }

      const nextBoss = current.nextId ? bossById(current.nextId) : BOSSES[0];
      const newDefeatSeq = Number(row?.defeat_seq || 0) + 1;
      return db.run(
        `
        UPDATE global_boss
        SET boss_id = ?, current_hp = ?, max_hp = ?, is_active = 1, defeated_at = CURRENT_TIMESTAMP, defeat_seq = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        `,
        [nextBoss.id, nextBoss.hpMax, nextBoss.hpMax, newDefeatSeq],
        (upErr) => {
          if (upErr) {
            console.error(upErr);
            return res.status(500).json({ error: 'Database error' });
          }
          db.run(`DELETE FROM boss_recent_attackers WHERE last_hit_at < ?`, [nowMs - BOSS_ATTACKER_WINDOW_MS], () => {});
          return db.get(`SELECT * FROM global_boss WHERE id = 1`, [], (finalErr, finalRow) => {
            if (finalErr) {
              console.error(finalErr);
              return res.status(500).json({ error: 'Database error' });
            }
            return res.json({
              ok: true,
              bossDefeated: true,
              defeatedBossId: current.id,
              defeatedBossName: current.name,
              defeatSeq: newDefeatSeq,
              reward: BOSS_REWARD_TAPS,
              ...buildBossStatePayload(finalRow)
            });
          });
        }
      );
    });
  });
});

app.post('/api/boss/claim-reward', (req, res) => {
  const userId = String(toId(req.body) || '');
  const userName = String(toName(req.body) || '');
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  db.get(`SELECT defeat_seq FROM global_boss WHERE id = 1`, [], (stateErr, row) => {
    if (stateErr) {
      console.error(stateErr);
      return res.status(500).json({ error: 'Database error' });
    }
    const currentSeq = Number(row?.defeat_seq || 0);
    db.get(`SELECT last_claimed_seq FROM boss_reward_claims WHERE user_id = ?`, [userId], (claimErr, claimRow) => {
      if (claimErr) {
        console.error(claimErr);
        return res.status(500).json({ error: 'Database error' });
      }
      const alreadyClaimed = Number(claimRow?.last_claimed_seq || 0);
      if (currentSeq <= 0 || alreadyClaimed >= currentSeq) {
        return res.json({ ok: true, awarded: false, reward: 0, defeatSeq: currentSeq });
      }
      return incrementScore({ userId, userName, delta: BOSS_REWARD_TAPS }, (incErr, score) => {
        if (incErr) {
          console.error(incErr);
          return res.status(500).json({ error: 'Database error' });
        }
        db.run(
          `
          INSERT INTO boss_reward_claims (user_id, last_claimed_seq)
          VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            last_claimed_seq = excluded.last_claimed_seq,
            updated_at = CURRENT_TIMESTAMP
          `,
          [userId, currentSeq],
          (upErr) => {
            if (upErr) {
              console.error(upErr);
              return res.status(500).json({ error: 'Database error' });
            }
            return res.json({
              ok: true,
              awarded: true,
              reward: BOSS_REWARD_TAPS,
              defeatSeq: currentSeq,
              newPeopleScore: score || 0
            });
          }
        );
      });
    });
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

