// Writes a VAPID keypair as JSON. Paste the whole file into the Supabase secret
// VAPID_KEYS; the function derives the browser's applicationServerKey from it.
import * as webpush from 'jsr:@negrel/webpush@0.3';

const out = Deno.args[0] ?? 'vapid-keys.local.json';
const keys = await webpush.generateVapidKeys({ extractable: true });
await Deno.writeTextFile(out, JSON.stringify(await webpush.exportVapidKeys(keys)));

const raw = await crypto.subtle.exportKey('raw', keys.publicKey);
const b64url = btoa(String.fromCharCode(...new Uint8Array(raw)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

console.log(`wrote ${out}`);
console.log(`public key (informational, the function serves this): ${b64url}`);
