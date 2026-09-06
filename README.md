# emsalert — on-call alert → LINE acknowledge

Get a push notification on your phone when the team needs you, tap **"I'm on my
way"**, and it posts to the LINE group automatically. Nobody waits for a reply.

```
[trigger: you, a colleague, a shortcut]
        |  GET /api/trigger?token=…   or   POST /api/notify
        v
[backend: Node + Express on Render] --> [Supabase: subscription + event log]
        |  Web Push (VAPID)
        v
[Android Chrome] -> notification with an "I'm on my way" button
        |                                   |
        |  tap the button ------------------+--> [LINE group, Messaging API]
        |  or open the page -> big green button -^
        v
[page shows: "You're on the way — posted to the LINE group at 21:04"]
```

You can acknowledge **without unlocking into the app** — the notification itself
carries an action button, and the service worker posts to LINE from there. The
page then catches up and shows the on-the-way state either way.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | The page. Dark, one card, one big tap target. |
| `public/sw.js` | Service worker: receives push, shows the notification, handles the ack button. |
| `public/manifest.json`, `public/icon-*.png` | Add-to-Home-Screen support. |
| `server/index.js` | The API. |
| `server/store.js` | Supabase via REST, with an in-memory fallback for local runs. |
| `server/schema.sql` | Run once in the Supabase SQL editor. |
| `render.yaml`, `netlify.toml` | Deploy config for the backend and the page. |

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | — | Sanity check: storage, VAPID, LINE all configured? |
| `GET /api/vapid-public-key` | — | The page fetches this instead of hardcoding the key. |
| `POST /api/subscribe` | `ACCESS_TOKEN` | Register a phone. Keyed by endpoint, so several devices work. |
| `POST /api/notify` | `ACCESS_TOKEN` | Raise an alert. Body: `{title, body, source}`. |
| `GET /api/trigger?token=…` | `TRIGGER_TOKEN` | Same thing as one plain GET — for a bookmark or a phone shortcut. |
| `POST /api/acknowledge` | `ACCESS_TOKEN` | Post to the LINE group. Body: `{id, message, via}`. |
| `GET /api/state` | `ACCESS_TOKEN` | Latest alert + last 10 calls, so the page can show "on the way". |
| `POST /api/line-webhook` | LINE signature | Logs the group ID now; the hook for the phase-2 chatbot. |

Acknowledging the same alert twice (notification button, then the page) posts to
LINE only once. Subscriptions that Chrome has thrown away (404/410) are deleted
automatically on the next push.

## Setup

### 1. Keys and database

```bash
cd server
npm install
npx web-push generate-vapid-keys
```

Create a Supabase project, run `server/schema.sql` in its SQL editor, and copy
the project URL plus the **service role** key. RLS is on and no policy is
granted, so only the backend (with that key) can read those tables.

Copy `server/.env.example` to `server/.env` and fill it in. `ACCESS_TOKEN` is
your access phrase — pick something long; it is the only thing standing between
the internet and your alerts.

### 2. Backend on Render

Point Render at this repo. `render.yaml` sets root dir `server`, `npm install`,
`npm start`, health check `/api/health`. Add every variable from `.env.example`
in the dashboard.

The free tier sleeps after ~15 minutes idle, which adds 30–50s to the first
push after a quiet spell. For something time-sensitive, the ~$7/mo Starter
instance is the one to use.

### 3. Page on Netlify

Publish directory `public` (already in `netlify.toml`). Open the site, tap
**Settings**, and enter the Render URL and the access phrase. Set `APP_URL` on
Render to that Netlify URL so notifications open the right page.

### 4. LINE

1. LINE Developers Console → create a Provider → a Messaging API channel.
2. Issue a long-lived **Channel Access Token** → `LINE_CHANNEL_ACCESS_TOKEN`.
   Copy the Channel Secret too → `LINE_CHANNEL_SECRET` (verifies the webhook).
3. Add the channel's official account as a friend, then invite it into the
   team group like any other member.
4. Set the channel's webhook URL to `https://<your-render-app>/api/line-webhook`
   and turn webhook delivery on.
5. Send any message in the group. The Render log prints
   `[line-webhook] source: {"type":"group","groupId":"C…"}` — copy that
   `groupId` into `LINE_GROUP_ID`.
6. You can turn webhook delivery off again; push messages don't need it. Keep
   the route for phase 2.
7. Test acknowledging before wiring the button, so LINE errors don't get
   tangled up with frontend bugs:

```bash
curl -X POST https://<your-render-app>/api/acknowledge -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"message\":\"test from curl\"}"
```

### 5. Your phone (Galaxy S25 Ultra)

1. Open the Netlify URL in **Chrome** (not Samsung Internet — its push support
   is patchier).
2. ⋮ → **Add to Home screen**. Launch it from that icon from now on.
3. Fill in Settings → **Save & register this device** → allow notifications.
   The pill at the top should read "1 device registered".
4. Settings → **Send a test push to this phone**, then lock the screen and try
   again — it should light up the lock screen with an **I'm on my way** button.
5. **Samsung battery management will kill this if you skip this step:**
   Settings → Apps → Chrome → Battery → **Unrestricted**, and Settings →
   Battery → Background usage limits → turn off **Put unused apps to sleep**
   (or add Chrome to "Never sleeping apps").

## Raising an alert

```bash
curl -X POST https://<your-render-app>/api/notify -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"title\":\"Trauma call\",\"body\":\"ER, resus 2\"}"
```

Or, for a bookmark or a colleague, one GET with no headers:

```
https://<your-render-app>/api/trigger?token=TRIGGER_TOKEN&title=Trauma%20call&body=ER%20resus%202
```

Give colleagues `TRIGGER_TOKEN`, never `ACCESS_TOKEN` — the trigger token can
only raise alerts, not register devices or post to LINE. It does sit in the URL,
so treat it as a low-value secret and rotate it if the link spreads.

## Running locally

```bash
cd server && npm install && npm start
```

Without Supabase it keeps everything in memory (fine for testing, lost on
restart); without LINE keys, acknowledging is recorded but nothing is posted and
the page says so. The page is served at `http://localhost:3000` — a secure
context, so service workers and push work there.

## Testing checklist

- [x] Push encrypts and delivers (verified against a local mock push service)
- [x] Acknowledge is idempotent per alert; dead subscriptions are pruned
- [x] Page reflects an ack made from the notification button
- [ ] Real Android notification with the phone locked
- [ ] Tapping "I'm on my way" posts to the real LINE group
- [ ] Retest with Wi-Fi off (mobile data) and battery saver on

## Phase 2

Two-way LINE chatbot: extend `/api/line-webhook` to parse incoming messages and
reply. The group ID and access token carry straight over — no new LINE channel.
