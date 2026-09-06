// Persistence layer.
//
// Uses Supabase (via its REST API — no extra npm dependency) when SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY are set. Falls back to in-memory storage so the
// server still boots and can be tested locally without any database.

const URL_BASE = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const usingSupabase = Boolean(URL_BASE && KEY);

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- in-memory fallback -----------------------------------------------------
const mem = { subs: new Map(), events: new Map() };

// ---- subscriptions ----------------------------------------------------------

export async function saveSubscription(subscription, label) {
  const row = {
    endpoint: subscription.endpoint,
    subscription,
    label: label || null
  };
  if (!usingSupabase) {
    mem.subs.set(row.endpoint, { ...row, created_at: new Date().toISOString() });
    return;
  }
  await rest('push_subscriptions', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=minimal'
  });
}

export async function listSubscriptions() {
  if (!usingSupabase) return [...mem.subs.values()];
  return (await rest('push_subscriptions?select=endpoint,subscription,label')) || [];
}

export async function deleteSubscription(endpoint) {
  if (!usingSupabase) {
    mem.subs.delete(endpoint);
    return;
  }
  await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    prefer: 'return=minimal'
  });
}

// ---- alert events -----------------------------------------------------------

export async function createEvent(event) {
  if (!usingSupabase) {
    mem.events.set(event.id, { ...event });
    return event;
  }
  await rest('alert_events', { method: 'POST', body: event, prefer: 'return=minimal' });
  return event;
}

export async function updateEvent(id, patch) {
  if (!usingSupabase) {
    const existing = mem.events.get(id);
    if (!existing) return null;
    Object.assign(existing, patch);
    return existing;
  }
  const rows = await rest(`alert_events?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  return rows?.[0] || null;
}

export async function getEvent(id) {
  if (!usingSupabase) return mem.events.get(id) || null;
  const rows = await rest(`alert_events?id=eq.${encodeURIComponent(id)}&select=*`);
  return rows?.[0] || null;
}

export async function recentEvents(limit = 10) {
  if (!usingSupabase) {
    return [...mem.events.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }
  return (
    (await rest(`alert_events?select=*&order=created_at.desc&limit=${limit}`)) || []
  );
}
