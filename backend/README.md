# Tap Elephant backend (full rewrite, SQLite)

Этот backend покрывает текущий фронт целиком:
- рейтинг партий (new_people),
- топ-15,
- рефералы,
- заглушка проверки подписки.

## Запуск
```bash
cd backend
npm install
npm start
```

Порт: `3000` (или `PORT` из env).  
База: `backend/leaderboard.db` (SQLite).

## API

### Рейтинг / очки
- `POST /api/party-taps/report`
  - body: `{ userId|user_id, userName|user_name, partyId, delta }`
  - увеличивает score на `delta`

- `POST /api/me/new-people-faction`
  - режим 1: body `{ userId|user_id }` -> вернуть текущий score
  - режим 2: body `{ userId|user_id, userName|user_name, taps, multiplier }` -> сохранить абсолютный score

- `GET /api/me/new-people-faction?userId=...`
  - вернуть текущий score пользователя

- `GET /api/me/new-people-faction?limit=15`
  - legacy-режим: вернуть массив строк топа

- `GET /api/leaderboard/new-people?limit=15`
  - новый режим: `{ ok, top: [...] }`

- `POST /api/leaderboard/new-people`
  - fallback (body `{ limit }`)

### Рефералы
- `POST /api/referrals/register`
  - body: `{ userId|user_id, userName|user_name, referrerId, startParam }`

- `POST /api/referrals/me`
  - body: `{ userId|user_id }`
  - возвращает `{ referralsClaimed, referralsActive, referralsPending, awards }`

### Подписка
- `POST /api/check-subscription`
  - сейчас заглушка
  - true только если env `MOCK_SUBSCRIBED=true`

### Health
- `GET /api/health` -> `{ status: "ok" }`

## Важно
- Это SQLite single-file backend, отлично для старта.
- Для production лучше добавить:
  - проверку `initData` Telegram,
  - реальную проверку подписки через Bot API,
  - rate limiting,
  - авторизацию запросов.

