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
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const { exchange } = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (JSON.parse(fs.readFileSync(peerConfig, 'utf8')).machine !== machine) { console.error(`${peerConfig} is not ${machine}'s config`); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bundle-'));
for (const f of ['hub.mjs', 'package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
fs.copyFileSync(peerConfig, path.join(stage, 'config.json'));
const zip = path.join(os.tmpdir(), 'agent-hub.zip');
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),['-a', '-cf', zip, '-C', stage, 'hub.mjs', 'package.json', 'package-lock.json', 'config.json']);
else execFileSync('zip', ['-j', '-q', zip, ...['hub.mjs', 'package.json', 'package-lock.json', 'config.json'].map(f => path.join(stage, f))]);
const ver = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'hub.mjs'))).digest('hex').slice(0, 7);

const fd = new FormData();
fd.append('chat_id', String(exchange));
fd.append('caption', `agent-hub.zip → ${machine} v${ver}`);
fd.append('disable_notification', 'true');
fd.append('document', new Blob([fs.readFileSync(zip)]), 'agent-hub.zip');
const r = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
if (!r.ok) { console.error('sendDocument failed:', r.description); process.exit(1); }
console.log(`sent agent-hub.zip → ${machine} v${ver} (${fs.statSync(zip).size} bytes)`);
