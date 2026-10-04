# Trade app

Needs Node 18+, no dependencies.

    node server.js          # http://localhost:3000

Open `/#admin` to create the admin passcode, then set the TronGrid API key and deposit address.
Users sign up on the login screen; the admin can add or remove users.

## Where data is saved
Users, balances, admin passcode, TronGrid key, deposit address, used transactions and login sessions are saved to:
- **Upstash Redis** if `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set (use this on Render's free plan), or
- a **file** (`DATA_FILE`, default `./data.json`) otherwise (Termux, a VPS, or a paid Render service with a disk mounted).

Run a single instance only. The Admin panel shows which store is in use.

## Deploy on Render (free)
1. Create a free database at upstash.com (Redis). Copy its **REST URL** and **REST token**.
2. Push this folder to GitHub (`data.json` and `.env` are git-ignored; never commit them).
3. Render > New > Web Service > your repo. Build: `npm install`. Start: `node server.js`. Plan: Free.
   (Or use the included `render.yaml` as a Blueprint.)
4. Environment variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_PASSCODE`, `ADMIN_RESET_KEY`.
5. Open `https://YOUR-SERVICE.onrender.com/#admin`, log in, set the TronGrid key and deposit address.
The first request after the service sleeps takes up to a minute; saved data and logins are kept.

## Other environment variables
PORT, HOST, TRONGRID_API_KEY (fallback key), STORE_PREFIX (default `tradeapp`),
CLIENT_IP_HEADER (header your proxy sets with the visitor IP; automatic on Render),
TRUST_PROXY=1 (use the last X-Forwarded-For entry), ALLOW_ANY_RECIPIENT=1 (demo only).

## Clean slate
    node server.js --wipe-all          # shows what would be deleted
    node server.js --wipe-all --yes    # deletes admin, key, address, users, balances, used transactions, sessions
Add the two `UPSTASH_*` variables to wipe the cloud database from your own machine (e.g. Termux).
