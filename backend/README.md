# Tap Elephant backend (SQLite for “Рейтинг партий”)

Этот backend предназначен только для того, чтобы заработал фронтенд `/api/...` из `index.html`.

## Требования
- Node.js 18+

## Запуск локально
```bash
cd backend
npm install
npm start
```
Сервер будет слушать порт `3000` (или `PORT` из env).

## Endpoints
1. `POST /api/party-taps/report`
   - body: `{ userId, partyId, delta, userName? }`
2. `POST /api/me/new-people-faction`
   - body: `{ userId }`
   - fallback: `GET /api/me/new-people-faction?userId=...`
3. `GET /api/leaderboard/new-people?limit=15`
   - fallback: `POST /api/leaderboard/new-people` body `{ limit }`

## Важно
Хранение очков — SQLite (`backend/leaderboard.db`).

## Интеграция с фронтендом
Текущий фронтенд шлёт запросы на относительные URL `/api/...`.
Значит backend должен быть доступен с того же домена, либо в `index.html` нужно заменить эндпоинты на абсолютные URL.

