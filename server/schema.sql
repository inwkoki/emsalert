-- Run this once in the Supabase SQL editor.
-- The backend talks to these tables with the service-role key, so RLS stays on
-- and no anon/authenticated policy is granted: nothing but the server can read.

create table if not exists push_subscriptions (
  endpoint        text primary key,
  subscription    jsonb not null,
  label           text,
  created_at      timestamptz not null default now()
);

create table if not exists alert_events (
  id              text primary key,
  title           text,
  body            text,
  source          text,
  created_at      timestamptz not null default now(),
  acked_at        timestamptz,
  ack_message     text,
  ack_via         text,
  line_status     text
);

create index if not exists alert_events_created_at_idx on alert_events (created_at desc);

alter table push_subscriptions enable row level security;
alter table alert_events enable row level security;
