-- Run this once in the Supabase SQL editor (project mvagebjizddemohhelta).
--
-- The Edge Function reaches these tables with the service-role key, which
-- bypasses RLS. RLS is enabled and no policy is created, so the anon key —
-- the one that would be exposed if it ever reached the page — can read nothing.

create table if not exists push_subscriptions (
  endpoint      text primary key,
  subscription  jsonb not null,
  label         text,
  created_at    timestamptz not null default now()
);

create table if not exists alert_events (
  id            text primary key,
  title         text,
  body          text,
  source        text,
  created_at    timestamptz not null default now(),
  acked_at      timestamptz,
  ack_message   text,
  ack_via       text,
  line_status   text
);

create index if not exists alert_events_created_at_idx on alert_events (created_at desc);

-- Every event LINE sends lands here. This is how you read the group ID:
--   select distinct group_id from line_webhook_events where group_id is not null;
create table if not exists line_webhook_events (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  event_type    text,
  source_type   text,
  group_id      text,
  user_id       text,
  payload       jsonb
);

alter table push_subscriptions  enable row level security;
alter table alert_events        enable row level security;
alter table line_webhook_events enable row level security;
