import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import {
  usingSupabase,
  saveSubscription,
  listSubscriptions,
  deleteSubscription,
  createEvent,
  updateEvent,
  getEvent,
  recentEvents
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:you@example.com',
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  LINE_GROUP_ID,
  ACCESS_TOKEN,
  TRIGGER_TOKEN,
  PUBLIC_BASE_URL,
  APP_URL,
  ACK_MESSAGE = 'On my way.'
} = process.env;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('[warn] VAPID keys missing — push will fail. Run: npx web-push generate-vapid-keys');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
if (!ACCESS_TOKEN) console.warn('[warn] ACCESS_TOKEN not set — every authenticated route will reject.');
if (!usingSupabase) console.warn('[warn] Supabase not configured — using in-memory storage (lost on restart).');

const app = express();
app.set('trust proxy', 1);

// Keep the raw body around so the LINE webhook signature can be verified.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);

// The page is served from Netlify in production, so allow cross-origin calls.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function timingSafeEqual(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function auth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.query.token || '';
  if (!ACCESS_TOKEN || !timingSafeEqual(token, ACCESS_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const baseUrl = (req) =>
  (PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// ---- public -----------------------------------------------------------------

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    storage: usingSupabase ? 'supabase' : 'memory',
    vapid: Boolean(VAPID_PUBLIC_KEY),
    line: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_GROUP_ID)
  })
);

// The page fetches this so the key lives in exactly one place.
app.get('/api/vapid-public-key', (_req, res) =>
  res.type('text/plain').send(VAPID_PUBLIC_KEY || '')
);

// ---- device registration ----------------------------------------------------

app.post('/api/subscribe', auth, async (req, res, next) => {
  try {
    const sub = req.body?.subscription || req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'missing subscription' });
    await saveSubscription(sub, req.body?.label);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/unsubscribe', auth, async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
    await deleteSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- notify -----------------------------------------------------------------

async function fanOut(subs, payloadObject) {
  const payload = JSON.stringify(payloadObject);
  const results = await Promise.allSettled(
    subs.map((row) =>
      webpush.sendNotification(row.subscription, payload, { TTL: 3600, urgency: 'high' })
    )
  );
  let sent = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      sent++;
      continue;
    }
    const code = r.reason?.statusCode;
    console.error('[push] failed', code, r.reason?.body || r.reason?.message);
    // 404/410 = the browser threw the subscription away; stop pushing to it.
    if (code === 404 || code === 410) await deleteSubscription(subs[i].endpoint);
  }
  return { sent, devices: subs.length };
}

async function doNotify(req, { title, body, source }) {
  // No registered phone means nothing to log — don't leave a phantom call in
  // the history that nobody could have answered.
  const subs = await listSubscriptions();
  if (subs.length === 0) return { id: null, sent: 0, devices: 0 };

  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const event = {
    id,
    title: title || 'Incoming call',
    body: body || 'Tap to respond',
    source: source || 'api',
    created_at: new Date().toISOString()
  };
  await createEvent(event);

  // The ack URL + token travel inside the (end-to-end encrypted) push payload so
  // the service worker can acknowledge straight from the notification button,
  // without the page being open and without storing the token on the device.
  const result = await fanOut(subs, {
    ...event,
    ackUrl: `${baseUrl(req)}/api/acknowledge`,
    token: ACCESS_TOKEN,
    appUrl: APP_URL || baseUrl(req)
  });
  return { id, ...result };
}

app.post('/api/notify', auth, async (req, res, next) => {
  try {
    const out = await doNotify(req, req.body || {});
    if (out.devices === 0) return res.status(409).json({ error: 'no device subscribed yet' });
    res.status(202).json(out);
  } catch (err) {
    next(err);
  }
});

// Convenience trigger for a phone shortcut or a bookmark: one GET, no headers.
// Uses TRIGGER_TOKEN when set so a colleague can be given a weaker secret that
// can only raise alerts — it cannot subscribe devices or post to LINE.
app.get('/api/trigger', async (req, res, next) => {
  const expected = TRIGGER_TOKEN || ACCESS_TOKEN;
  if (!expected || !timingSafeEqual(req.query.token || '', expected)) {
    return res.status(401).send('unauthorized');
  }
  try {
    const out = await doNotify(req, {
      title: req.query.title || 'Incoming call',
      body: req.query.body || 'Tap to respond',
      source: req.query.from || 'trigger-link'
    });
    res
      .type('text/plain')
      .send(out.devices === 0 ? 'no device subscribed yet' : `alert sent to ${out.sent} device(s)`);
  } catch (err) {
    next(err);
  }
});

// ---- acknowledge ------------------------------------------------------------

async function pushToLine(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_GROUP_ID) {
    return { ok: false, status: 'line-not-configured' };
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to: LINE_GROUP_ID, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('[line] push failed', res.status, detail);
    return { ok: false, status: `line-${res.status}`, detail };
  }
  return { ok: true, status: 'sent' };
}

app.post('/api/acknowledge', auth, async (req, res, next) => {
  try {
    const message = (req.body?.message || ACK_MESSAGE).toString().slice(0, 500);
    const id = req.body?.id;
    const via = req.body?.via || 'page';

    // Acknowledging the same alert twice (notification button, then the page)
    // should not post to the group twice.
    if (id) {
      const existing = await getEvent(id);
      if (existing?.acked_at) {
        return res.json({
          ok: true,
          duplicate: true,
          acked_at: existing.acked_at,
          message: existing.ack_message
        });
      }
    }

    const line = await pushToLine(message);
    const acked_at = new Date().toISOString();
    if (id) {
      await updateEvent(id, { acked_at, ack_message: message, ack_via: via, line_status: line.status });
    }

    if (!line.ok && line.status !== 'line-not-configured') {
      return res.status(502).json({ ok: false, error: 'line push failed', detail: line.detail });
    }
    res.json({ ok: true, acked_at, message, line: line.status });
  } catch (err) {
    next(err);
  }
});

// ---- state (so the page can show "on the way" after any ack) ----------------

app.get('/api/state', auth, async (_req, res, next) => {
  try {
    const events = await recentEvents(10);
    const subs = await listSubscriptions();
    res.json({ latest: events[0] || null, events, devices: subs.length });
  } catch (err) {
    next(err);
  }
});

// ---- LINE webhook (group ID discovery now, chatbot in phase 2) --------------

app.post('/api/line-webhook', (req, res) => {
  if (LINE_CHANNEL_SECRET) {
    const expected = crypto
      .createHmac('sha256', LINE_CHANNEL_SECRET)
      .update(req.rawBody || Buffer.from(''))
      .digest('base64');
    if (!timingSafeEqual(req.get('x-line-signature') || '', expected)) {
      return res.status(401).end();
    }
  }
  for (const event of req.body?.events || []) {
    console.log('[line-webhook] source:', JSON.stringify(event.source), 'type:', event.type);
  }
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// ---- static page (handy for local testing; Netlify serves it in production) --

app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'server error', detail: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`listening on :${port} (storage: ${usingSupabase ? 'supabase' : 'memory'})`)
);
