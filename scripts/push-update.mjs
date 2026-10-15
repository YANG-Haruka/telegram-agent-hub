// Sends a hub update to another machine through the command group: posts "agent-hub.zip → <Machine> v<ver>" and that
// machine's hub (config selfUpdate: true) installs it by itself, with checks and automatic rollback.
// Run from the hub folder of the sending machine:  node scripts/push-update.mjs <Machine> <path/to/that-machine/config.json>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [machine, peerConfig] = process.argv.slice(2);
if (!machine || !peerConfig) { console.error('usage: node scripts/push-update.mjs <Machine> <path/to/its/config.json>'); process.exit(1); }
const ROOT = process.cwd();
const parse = f => Object.fromEntries(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
// Windows: the hub keeps its secrets DPAPI-encrypted in .env.dpapi (a plaintext one in .env wins). Same decrypt as hub.mjs dpapi().
function sealed() {
  if (process.platform !== 'win32' || !fs.existsSync(path.join(ROOT, '.env.dpapi'))) return {};
  const e = Object.entries(parse('.env.dpapi'));
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; [Console]::In.ReadToEnd().Split() | ? { $_ } | % { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($_), $null, 'CurrentUser')) }`],
    { input: e.map(([, b]) => b).join('\n'), windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().split(/\s+/).filter(Boolean);
  if (out.length !== e.length) throw new Error('.env.dpapi: decrypt failed');
  return Object.fromEntries(e.map(([k], i) => [k, Buffer.from(out[i], 'base64').toString('utf8')]));
}
const env = { ...sealed(), ...Object.fromEntries(Object.entries(fs.existsSync(path.join(ROOT, '.env')) ? parse('.env') : {}).filter(([, v]) => v)) };
if (!env.TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN not found in .env / .env.dpapi (run this from the hub folder)'); process.exit(1); }
const { exchange, machine: me } = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (JSON.parse(fs.readFileSync(peerConfig, 'utf8')).machine !== machine) { console.error(`${peerConfig} is not ${machine}'s config`); process.exit(1); }

const FILES = ['hub.mjs', 'package.json', 'package-lock.json', 'config.json'];
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-'));
for (const f of FILES.slice(0, 3)) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
fs.copyFileSync(peerConfig, path.join(stage, 'config.json'));
// Kept next to the hub: if the pairing is ever broken, post this file in the command group yourself (escape hatch, see README).
const zip = path.join(ROOT, 'agent-hub.zip');
fs.rmSync(zip, { force: true });
try {
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', stage, ...FILES]);
  else execFileSync('zip', ['-j', '-q', zip, ...FILES.map(f => path.join(stage, f))]);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
const ver = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'hub.mjs'))).digest('hex').slice(0, 7);

// Once the two hubs are paired the other machine only installs a signed bundle: same derive + HMAC as hub.mjs
// (deriveKey / sigLine), over caption|sha256(zip). The pairing key is read from state.json, never written.
let caption = `agent-hub.zip → ${machine} v${ver}`;
const pair = fs.existsSync(path.join(ROOT, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8')).pair : null;
if (pair?.priv && pair.peer?.[machine]) {
  const key = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: crypto.createPrivateKey(pair.priv),
    publicKey: crypto.createPublicKey({ key: Buffer.from(pair.peer[machine], 'base64'), format: 'der', type: 'spki' }) }), 'agent-hub', 'agent-hub pair v1', 32));
  const ts = Math.floor(Date.now() / 1000), sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  caption += `\n#sig ${ts} ${crypto.createHmac('sha256', key).update(`${me}|${machine}|${ts}|${caption}|${sha}`).digest('base64url')}`;
} else console.log(`not paired with ${machine} yet (no pair.peer.${machine} in state.json): sending unsigned`);

// The other hub reads this message directly (bot-to-bot in the command group) and installs it.
const fd = new FormData();
fd.append('chat_id', String(exchange));
fd.append('caption', caption);
fd.append('disable_notification', 'true');
fd.append('document', new Blob([fs.readFileSync(zip)]), 'agent-hub.zip');
const r = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
if (!r.ok) { console.error('sendDocument failed:', r.description); process.exit(1); }
console.log(`sent agent-hub.zip → ${machine} v${ver} (${fs.statSync(zip).size} bytes, msg ${r.result.message_id}); copy kept at ${zip}`);
