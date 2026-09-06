// On-call alert API — one Supabase Edge Function, routed internally.
//
// Deploy with "Verify JWT" OFF: LINE's webhook cannot send a Supabase JWT, and
// every other route is guarded by our own ACCESS_TOKEN instead.
//
//   GET  /health              is everything configured?
//   GET  /vapid-public-key    the page needs this to subscribe
//   POST /subscribe           register a phone            (ACCESS_TOKEN)
//   POST /notify              raise an alert              (ACCESS_TOKEN)
//   GET  /trigger?token=      same, as one plain URL      (TRIGGER_TOKEN)
//   POST /acknowledge         post to the LINE group      (ACCESS_TOKEN)
//   GET  /state               latest alert + last 10      (ACCESS_TOKEN)
//   POST /line-webhook        records events so you can read the group ID

import * as webpush from 'jsr:@negrel/webpush@0.3';

const env = (k: string) => Deno.env.get(k) ?? '';

const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const ACCESS_TOKEN = env('ACCESS_TOKEN');
const TRIGGER_TOKEN = env('TRIGGER_TOKEN');
const VAPID_KEYS = env('VAPID_KEYS');
const VAPID_SUBJECT = env('VAPID_SUBJECT') || 'mailto:you@example.com';
const LINE_TOKEN = env('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_SECRET = env('LINE_CHANNEL_SECRET');
const LINE_GROUP_ID = env('LINE_GROUP_ID');
const ACK_MESSAGE = env('ACK_MESSAGE') || 'On my way.';
const APP_URL = env('APP_URL');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-line-signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });

// ---- database ---------------------------------------------------------------

async function db(path: string, init: RequestInit & { prefer?: string } = {}) {
  const { prefer, ...rest } = init;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...rest,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...(rest.headers ?? {})
    }
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

// ---- constant-time compare --------------------------------------------------

function safeEqual(a: string, b: string) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const authorized = (req: Request) =>
  Boolean(ACCESS_TOKEN) &&
  safeEqual((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''), ACCESS_TOKEN);

// ---- VAPID ------------------------------------------------------------------

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let appServerPromise: Promise<webpush.ApplicationServer> | null = null;
let publicKeyPromise: Promise<string> | null = null;

async function vapid() {
  if (!VAPID_KEYS) throw new Error('VAPID_KEYS is not set');
  const keys = await webpush.importVapidKeys(JSON.parse(VAPID_KEYS), { extractable: true });
  return keys;
}

function applicationServer() {
  appServerPromise ??= (async () =>
    webpush.ApplicationServer.new({
      contactInformation: VAPID_SUBJECT,
      vapidKeys: await vapid()
    }))();
  return appServerPromise;
}

function publicKey() {
  publicKeyPromise ??= (async () => {
    const keys = await vapid();
    return b64url(await crypto.subtle.exportKey('raw', keys.publicKey));
  })();
  return publicKeyPromise;
}

// ---- push -------------------------------------------------------------------

type Sub = { endpoint: string; subscription: PushSubscriptionJSON };

async function fanOut(subs: Sub[], payload: unknown) {
  const server = await applicationServer();
  const body = JSON.stringify(payload);
  let sent = 0;

  await Promise.all(
    subs.map(async (row) => {
      try {
        await server.subscribe(row.subscription as never).pushTextMessage(body, {
          urgency: webpush.Urgency.High,
          ttl: 3600
        });
        sent++;
      } catch (err) {
        const status = (err as { response?: Response })?.response?.status;
        console.error('[push] failed', status ?? '', String(err));
        // 404/410: Chrome threw the subscription away. Stop pushing to it.
        if (status === 404 || status === 410) {
          await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`, {
            method: 'DELETE',
            prefer: 'return=minimal'
          });
        }
      }
    })
  );
  return { sent, devices: subs.length };
}

async function raiseAlert(base: string, input: { title?: string; body?: string; source?: string }) {
  const subs: Sub[] = await db('push_subscriptions?select=endpoint,subscription');
  // Nothing registered means nothing to answer — don't log a phantom call.
  if (!subs.length) return { id: null, sent: 0, devices: 0 };

  const event = {
    id: `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
    title: input.title || 'Incoming call',
    body: input.body || 'Tap to respond',
    source: input.source || 'api',
    created_at: new Date().toISOString()
  };
  await db('alert_events', { method: 'POST', body: JSON.stringify(event), prefer: 'return=minimal' });

  // The ack URL and token ride inside the encrypted push payload, so the service
  // worker can answer straight from the notification button — no open page, and
  // nothing secret stored on the device.
  const result = await fanOut(subs, {
    ...event,
    ackUrl: `${base}/acknowledge`,
    token: ACCESS_TOKEN,
    appUrl: APP_URL
  });
  return { id: event.id, ...result };
}

// ---- LINE -------------------------------------------------------------------

async function pushToLine(message: string) {
  if (!LINE_TOKEN || !LINE_GROUP_ID) return { ok: false, status: 'line-not-configured' };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_GROUP_ID, messages: [{ type: 'text', text: message }] })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('[line] push failed', res.status, detail);
    return { ok: false, status: `line-${res.status}`, detail };
  }
  return { ok: true, status: 'sent' };
}

async function verifyLineSignature(raw: string, signature: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(LINE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return safeEqual(btoa(String.fromCharCode(...new Uint8Array(mac))), signature);
}

// ---- routing ----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  // Everything after the function name, e.g. /functions/v1/api/notify -> /notify
  const route = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
  const base = `${url.origin}${url.pathname.slice(0, url.pathname.length - route.length)}`;

  try {
    // ---- public -------------------------------------------------------------

    if (route === '/health') {
      return json({
        ok: true,
        vapid: Boolean(VAPID_KEYS),
        line: Boolean(LINE_TOKEN && LINE_GROUP_ID),
        access_token: Boolean(ACCESS_TOKEN),
        app_url: APP_URL || null
      });
    }

    if (route === '/vapid-public-key') return text(await publicKey());

    if (route === '/line-webhook' && req.method === 'POST') {
      const raw = await req.text();
      if (LINE_SECRET) {
        const sig = req.headers.get('x-line-signature') ?? '';
        if (!(await verifyLineSignature(raw, sig))) return text('bad signature', 401);
      }
      const payload = JSON.parse(raw || '{}');
      for (const event of payload.events ?? []) {
        // Recorded to a table, not just the log — read the group ID straight
        // out of the table editor instead of scrolling through logs.
        console.log('[line-webhook]', event.type, JSON.stringify(event.source));
        await db('line_webhook_events', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({
            event_type: event.type,
            source_type: event.source?.type ?? null,
            group_id: event.source?.groupId ?? null,
            user_id: event.source?.userId ?? null,
            payload: event
          })
        });
      }
      return text('ok');
    }

    // ---- trigger link (weaker token, alerts only) ---------------------------

    if (route === '/trigger') {
      const expected = TRIGGER_TOKEN || ACCESS_TOKEN;
      if (!expected || !safeEqual(url.searchParams.get('token') ?? '', expected)) {
        return text('unauthorized', 401);
      }
      const out = await raiseAlert(base, {
        title: url.searchParams.get('title') ?? undefined,
        body: url.searchParams.get('body') ?? undefined,
        source: url.searchParams.get('from') ?? 'trigger-link'
      });
      return text(out.devices === 0 ? 'no device subscribed yet' : `alert sent to ${out.sent} device(s)`);
    }

    // ---- everything below needs the access phrase ---------------------------

    if (!authorized(req)) return json({ error: 'unauthorized' }, 401);

    if (route === '/subscribe' && req.method === 'POST') {
      const body = await req.json();
      const subscription = body.subscription ?? body;
      if (!subscription?.endpoint) return json({ error: 'missing subscription' }, 400);
      await db('push_subscriptions', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          subscription,
          label: body.label ?? null
        })
      });
      return json({ ok: true }, 201);
    }

    if (route === '/notify' && req.method === 'POST') {
      const out = await raiseAlert(base, await req.json().catch(() => ({})));
      if (out.devices === 0) return json({ error: 'no device subscribed yet' }, 409);
      return json(out, 202);
    }

    if (route === '/acknowledge' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const message = String(body.message || ACK_MESSAGE).slice(0, 500);
      const id = body.id as string | undefined;
      const via = body.via ?? 'page';

      // Notification button then page must not post to the group twice.
      if (id) {
        const rows = await db(`alert_events?id=eq.${encodeURIComponent(id)}&select=*`);
        if (rows?.[0]?.acked_at) {
          return json({ ok: true, duplicate: true, acked_at: rows[0].acked_at, line: rows[0].line_status });
        }
      }

      const line = await pushToLine(message);
      const acked_at = new Date().toISOString();
      if (id) {
        await db(`alert_events?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ acked_at, ack_message: message, ack_via: via, line_status: line.status })
        });
      }
      if (!line.ok && line.status !== 'line-not-configured') {
        return json({ ok: false, error: 'line push failed', detail: line.detail }, 502);
      }
      return json({ ok: true, acked_at, message, line: line.status });
    }

    if (route === '/state') {
      const events = await db('alert_events?select=*&order=created_at.desc&limit=10');
      const subs = await db('push_subscriptions?select=endpoint');
      return json({ latest: events?.[0] ?? null, events: events ?? [], devices: subs?.length ?? 0 });
    }

    return json({ error: 'not found', route }, 404);
  } catch (err) {
    console.error('[error]', err);
    return json({ error: 'server error', detail: String(err) }, 500);
  }
});
