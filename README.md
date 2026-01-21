# Interview App (TypeScript)

## Structure

- `frontend`: Vite + React + TypeScript (UI)
- `server`: Node + TypeScript (Express + WebSocket + OpenAI Realtime)
- `Actual`: old scaffold (can be ignored)

## Setup

1. Server

```
cd server
copy .env.example .env
# set OPENAI_API_KEY in .env
npm install
npm run dev
```

2. Frontend

```
cd ..\frontend
npm install
npm run dev
```

Open http://localhost:5173

## Notes

- The frontend connects to the server at `ws://localhost:3000/ws`.
- If you change the server port, set `VITE_WS_PORT` in a frontend `.env` file.
- Firebase/Supabase config is read from `frontend/public/config.js`.
