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
// Overridable so the escalation and reply paths can be tested end to end
// against a stub instead of the real LINE API.
const LINE_API = env('LINE_API_BASE') || 'https://api.line.me';

// What the team types in the group to page the phone. Deliberately unlikely to
// be typed by accident; override with TRIGGER_KEYWORDS (comma-separated).
// "@ems alert" is there because LINE's @ menu inserts the bot's display name,
// not its id — so the text that actually arrives has a space in it.
const KEYWORDS = (env('TRIGGER_KEYWORDS') || '!call,!alert,!doctor,@emsalert,@ems alert')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

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

type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
type Sub = { endpoint: string; subscription: PushSubscriptionRecord };

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

  // Start the clock. A second of slack so the sweep's `created_at <` comparison
  // is unambiguous rather than racing the deadline exactly.
  if (ESCALATE_AFTER) {
    background(async () => {
      await new Promise((r) => setTimeout(r, ESCALATE_AFTER * 1000 + 1000));
      await escalateOverdue();
    });
  }

  return { id: event.id, ...result };
}

// ---- escalation -------------------------------------------------------------
//
// If an alert is not answered within ESCALATE_AFTER seconds, tell the group so
// they stop waiting and pick up the phone. Two things drive this, deliberately:
//
//   1. a timer started when the alert is raised (fast, exact), and
//   2. a sweep on every later request (catches anything the timer missed —
//      a worker eviction must not silently swallow an escalation).
//
// Both funnel through the same conditional UPDATE, so whoever gets there first
// posts and everyone else sees zero rows changed and does nothing.

const ESCALATE_AFTER = Number(env('ESCALATE_AFTER_SECONDS') || 60);
const ESCALATE_MESSAGE = env('ESCALATE_MESSAGE') || 'โกกิไม่ตอบ กรุณาโทร';

async function escalateOverdue() {
  if (!ESCALATE_AFTER) return 0;
  const cutoff = new Date(Date.now() - ESCALATE_AFTER * 1000).toISOString();
  const due =
    (await db(
      `alert_events?select=id&acked_at=is.null&escalated_at=is.null&created_at=lt.${cutoff}`
    )) ?? [];

  let posted = 0;
  for (const row of due) {
    // Claim it first. The filter repeats the conditions so a concurrent ack or
    // a second sweep cannot both win.
    const claimed = await db(
      `alert_events?id=eq.${encodeURIComponent(row.id)}&acked_at=is.null&escalated_at=is.null`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({ escalated_at: new Date().toISOString() })
      }
    );
    if (!claimed?.length) continue; // someone else got there — answered, or already escalated

    const line = await pushToLine(ESCALATE_MESSAGE);
    if (!line.ok) {
      // Release the claim so the next sweep retries rather than losing it.
      await db(`alert_events?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ escalated_at: null })
      });
      console.error('[escalate] LINE post failed, released for retry', line.status);
      continue;
    }
    console.log('[escalate] no answer for', row.id, '— told the group');
    posted++;
  }
  return posted;
}

// Run work after the response has gone out, where the platform allows it.
function background(task: () => Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const promise = task().catch((err) => console.error('[background]', String(err)));
  runtime?.waitUntil(promise);
}

// ---- LINE -------------------------------------------------------------------

async function pushToLine(message: string) {
  if (!LINE_TOKEN || !LINE_GROUP_ID) return { ok: false, status: 'line-not-configured' };
  const res = await fetch(`${LINE_API}/v2/bot/message/push`, {
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

// Who sent the message, so the alert can say "Call from Ploy" rather than "Call
// from Uf3b2…". Best effort — a failure here must not stop the page.
async function groupMemberName(groupId: string, userId: string) {
  if (!LINE_TOKEN) return null;
  try {
    const res = await fetch(`${LINE_API}/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` }
    });
    if (!res.ok) return null;
    return (await res.json()).displayName ?? null;
  } catch {
    return null;
  }
}

async function replyToLine(replyToken: string, message: string) {
  if (!LINE_TOKEN) return;
  try {
    await fetch(`${LINE_API}/v2/bot/message/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] })
    });
  } catch (err) {
    console.error('[line] reply failed', String(err));
  }
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

  // Backstop: any request is a chance to notice an alert nobody answered, in
  // case the timer's worker was evicted. Runs after the response, off the path.
  if (route !== '/health' && route !== '/vapid-public-key' && ESCALATE_AFTER) {
    background(escalateOverdue);
  }

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

        // --- the team's trigger ---------------------------------------------
        // A message in the configured group that starts with a keyword, or that
        // @-mentions the bot, pages the phone. Only the configured group can do
        // this, so a stray invite elsewhere cannot page anyone.
        if (
          event.type === 'message' &&
          event.message?.type === 'text' &&
          event.source?.type === 'group' &&
          event.source.groupId === LINE_GROUP_ID
        ) {
          const body = String(event.message.text ?? '').trim();
          const lower = body.toLowerCase();

          // Two kinds of keyword:
          //   "!call"     a command — must open the line
          //   "@emsalert" a mention — may sit anywhere, but has to start a word,
          //               so an address like foo@emsalert.com pages nobody.
          let hit: string | null = null;
          let detail = body;
          for (const k of KEYWORDS) {
            if (k.startsWith('@')) {
              const at = lower.indexOf(k);
              if (at >= 0 && (at === 0 || /\s/.test(lower[at - 1]))) {
                hit = k;
                detail = (body.slice(0, at) + ' ' + body.slice(at + k.length)).replace(/\s+/g, ' ').trim();
                break;
              }
            } else if (lower === k || lower.startsWith(k + ' ')) {
              hit = k;
              detail = body.slice(k.length).trim();
              break;
            }
          }

          // Set only when the sender picked the bot from LINE's @ menu, which
          // inserts the display name rather than the id — hence the text paths above.
          const mentioned = Boolean(
            event.message.mention?.mentionees?.some((m: { type?: string }) => m.type === 'bot')
          );

          if (hit || mentioned) {
            const name = event.source.userId
              ? await groupMemberName(event.source.groupId, event.source.userId)
              : null;

            const out = await raiseAlert(base, {
              title: name ? `${name} is calling you` : 'The team is calling you',
              body: detail || 'Tap to respond',
              source: 'line-group'
            });

            if (event.replyToken) {
              await replyToLine(
                event.replyToken,
                out.devices === 0
                  ? 'ยังไม่มีเครื่องลงทะเบียนรับแจ้งเตือน กรุณาโทรตามปกติ'
                  : 'รับทราบ กำลังรอตอบกลับ'
              );
            }
          }
        }
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

    // Every group the bot has seen, newest first — invite it somewhere, then
    // call this. `left: true` means the bot is no longer in that group.
    if (route === '/groups') {
      const rows =
        (await db(
          'line_webhook_events?select=group_id,event_type,received_at,payload&group_id=not.is.null&order=received_at.desc&limit=200'
        )) ?? [];

      const groups = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const g = groups.get(row.group_id) ?? {
          group_id: row.group_id,
          last_seen: row.received_at,
          first_seen: row.received_at,
          events: [] as string[],
          last_message: null as string | null,
          left: false,
          is_current: row.group_id === LINE_GROUP_ID
        };
        (g.events as string[]).push(row.event_type);
        if (!g.last_message && row.payload?.message?.text) g.last_message = row.payload.message.text;
        // Rows arrive newest first, so the first leave/join we see is the latest.
        if (!(g.events as string[]).some((e) => e === 'join')) {
          if (row.event_type === 'leave' || row.event_type === 'memberLeft') g.left = true;
        }
        g.first_seen = row.received_at;
        groups.set(row.group_id, g);
      }
      return json({ configured: LINE_GROUP_ID || null, groups: [...groups.values()] });
    }

    // Post a plain message to the group. No push, no alert, no ack — this is for
    // scheduled notices, so it deliberately does not touch the call log.
    if (route === '/announce' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const message = String(body.message ?? '').trim().slice(0, 1000);
      if (!message) return json({ error: 'missing message' }, 400);

      const line = await pushToLine(message);
      if (!line.ok) {
        return json({ ok: false, error: line.status, detail: line.detail }, line.status === 'line-not-configured' ? 409 : 502);
      }
      return json({ ok: true, sent_to: LINE_GROUP_ID, message });
    }

    // The daily notice, made safe to call repeatedly.
    //
    // GitHub's scheduler is best effort — it has fired this over four hours
    // late — so the caller is not trusted to know what time it is. Several
    // attempts are scheduled and this decides: never before 08:00 Bangkok,
    // and at most once per Bangkok day. The date is the primary key, so the
    // database settles any race, not the caller.
    if (route === '/daily-notice' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const message = String(body.message ?? '').trim().slice(0, 1000);
      if (!message) return json({ error: 'missing message' }, 400);
      const notBefore = Number(body.not_before_hour ?? 8);

      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(new Date());
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const day = `${get('year')}-${get('month')}-${get('day')}`;
      const hour = Number(get('hour'));
      const localTime = `${get('hour')}:${get('minute')}`;

      if (hour < notBefore) {
        return json({ ok: true, skipped: 'too early', day, bangkok_time: localTime });
      }

      // Insert-or-nothing: the day is the primary key, so exactly one caller
      // can win regardless of how many fire at once.
      const claimed = await db('daily_notice_log', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=representation',
        body: JSON.stringify({ day, message })
      });
      if (!claimed?.length) {
        return json({ ok: true, skipped: 'already sent today', day, bangkok_time: localTime });
      }

      const line = await pushToLine(message);
      if (!line.ok) {
        // Give the day back so a later attempt retries instead of losing it.
        await db(`daily_notice_log?day=eq.${day}`, { method: 'DELETE', prefer: 'return=minimal' });
        return json({ ok: false, error: line.status, detail: line.detail, day }, 502);
      }
      return json({ ok: true, sent: true, day, bangkok_time: localTime, message });
    }

    if (route === '/state') {
      const events = await db('alert_events?select=*&order=created_at.desc&limit=10');
      const subs = await db('push_subscriptions?select=endpoint,label,created_at&order=created_at.desc');
      return json({
        latest: events?.[0] ?? null,
        events: events ?? [],
        devices: subs?.length ?? 0,
        // Enough to tell a phone from a laptop, and to spot a stale registration.
        device_list: (subs ?? []).map((s: { label?: string; created_at: string; endpoint: string }) => ({
          label: s.label ?? 'unknown',
          registered: s.created_at,
          service: new URL(s.endpoint).host
        }))
      });
    }

    return json({ error: 'not found', route }, 404);
  } catch (err) {
    console.error('[error]', err);
    return json({ error: 'server error', detail: String(err) }, 500);
  }
});
