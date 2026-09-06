#!/usr/bin/env node
// Midnight-proof group switcher.
//
//   npm run group          list every group the bot has seen
//   npm run group -- <id>  point the alerts and the daily notice at that group
//
// Reads the access phrase from ACCESS-PHRASE.local.json so no secret is typed.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PROJECT = 'mvagebjizddemohhelta';
const API = `https://${PROJECT}.supabase.co/functions/v1/api`;

const token = JSON.parse(readFileSync(new URL('../ACCESS-PHRASE.local.json', import.meta.url), 'utf8'))
  .access_phrase;

const res = await fetch(`${API}/groups`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`Could not read groups: HTTP ${res.status}`);
  process.exit(1);
}
const { configured, groups } = await res.json();

const target = process.argv[2];

// Node on Windows can trip a libuv assertion when process.exit() runs with a
// keep-alive socket still open, so every path below just falls off the end.
if (!target) {
  console.log(`currently configured: ${configured ?? '(none)'}\n`);
  if (!groups.length) {
    console.log('No groups seen yet. Invite the bot to a group, then run this again.');
    console.log('(The join event alone is enough — nobody needs to send a message.)');
  }
  for (const g of groups) {
    const flags = [
      g.is_current ? 'CURRENT' : null,
      g.left ? 'bot has left' : null
    ].filter(Boolean);
    console.log(`${g.group_id}${flags.length ? '   [' + flags.join(', ') + ']' : ''}`);
    console.log(`    last seen ${g.last_seen}`);
    if (g.last_message) console.log(`    last message: ${g.last_message}`);
  }
  const candidates = groups.filter((g) => !g.left && !g.is_current);
  if (candidates.length) {
    console.log(`\nTo switch:\n  npm run group -- ${candidates[0].group_id}`);
  }
} else {
  await switchTo(target);
}

async function switchTo(id) {
  const chosen = groups.find((g) => g.group_id === id);
  if (!chosen) {
    console.error('That id is not in the webhook log. Run without arguments to see what is.');
    process.exitCode = 1;
    return;
  }
  if (chosen.left) {
    console.error('The bot has left that group — invite it again first.');
    process.exitCode = 1;
    return;
  }

  execFileSync(
    'npx',
    ['--yes', 'supabase@latest', 'secrets', 'set', `LINE_GROUP_ID=${id}`, '--project-ref', PROJECT],
    { stdio: 'inherit', shell: true }
  );

  const check = await fetch(`${API}/groups`, { headers: { Authorization: `Bearer ${token}` } });
  const after = await check.json();
  console.log(
    after.configured === id
      ? `\nDone. Alerts, !call and the daily notice now go to ${id}`
      : `\nSet, but the function still reports ${after.configured} — give it a few seconds and re-check.`
  );
}
