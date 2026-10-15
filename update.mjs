// Daily self-update of the Claude Agent SDK (which bundles the claude binary the hub runs).
// Installs the latest version, runs the self-test plus one real tiny turn, and rolls back on failure.
// Prints one line: "up-to-date X" | "updated X -> Y" | "skipped X (…)" | "rolled-back X (Y failed: reason)" | "rollback-failed …".
// Exit 0 unless rolled back.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PKG = '@anthropic-ai/claude-agent-sdk';
const npm = args => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 600000, shell: process.platform === 'win32' }).toString().trim();
const installed = () => JSON.parse(fs.readFileSync(`node_modules/${PKG}/package.json`, 'utf8')).version;

const cur = installed();
// Newest stable release that has been public for 3+ days: a bad or hijacked publish is usually pulled by then.
let times = {}; try { times = JSON.parse(npm(['view', PKG, 'time', '--json'])); } catch {}
const MIN_AGE = 3 * 86400e3;
const latest = Object.entries(times).filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && Date.now() - Date.parse(t) >= MIN_AGE).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))[0]?.[0];
if (!latest) { console.log(`up-to-date ${cur} (registry gave no usable versions)`); process.exit(0); }
if (latest === cur || Date.parse(times[latest]) <= Date.parse(times[cur] || 0)) { console.log(`up-to-date ${cur}`); process.exit(0); }

const parse = f => Object.fromEntries(fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
// Windows: the hub keeps its secrets DPAPI-encrypted in .env.dpapi (a plaintext one in .env wins). Same decrypt as hub.mjs dpapi().
function sealed() {
  if (process.platform !== 'win32' || !fs.existsSync('.env.dpapi')) return {};
  const e = Object.entries(parse('.env.dpapi'));
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; [Console]::In.ReadToEnd().Split() | ? { $_ } | % { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($_), $null, 'CurrentUser')) }`],
    { input: e.map(([, b]) => b).join('\n'), windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().split(/\s+/).filter(Boolean);
  if (out.length !== e.length) throw new Error('.env.dpapi: decrypt failed');
  return Object.fromEntries(e.map(([k], i) => [k, Buffer.from(out[i], 'base64').toString('utf8')]));
}

const LIMITED = /429|rate.?limit|usage limit|limit reached/i;
// The real turn passes on any account (each token in turn; none = the machine's own login). If every account is only
// rate-limited, the new version can't be checked today: that is not a failed update.
async function smoke() {
  execFileSync(process.execPath, ['--test', 'hub.test.mjs'], { stdio: 'ignore', windowsHide: true, timeout: 300000 });
  const env = { ...sealed(), ...Object.fromEntries(Object.entries(parse('.env')).filter(([, v]) => v)) };
  const { query } = await import(PKG); // first import in this process → the freshly installed version
  const tokens = Object.entries(env).filter(([k, v]) => /_OAUTH_TOKEN$/.test(k) && v).map(([, v]) => v);
  const why = [];
  for (const token of tokens.length ? tokens : [null]) {
    let ok = false, limited = false;
    try {
      for await (const m of query({ prompt: 'Reply with exactly: OK', options: { model: 'haiku', maxTurns: 1, env: { ...process.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) } } })) {
        if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') limited = true;
        if (m.type === 'result') { ok = !m.is_error && /OK/.test(m.result || ''); if (m.is_error && LIMITED.test(m.result || '')) limited = true; }
      }
    } catch (e) { why.push(String(e.message).split('\n')[0].slice(0, 80)); if (LIMITED.test(e.message)) limited = true; }
    if (ok) return;
    why.push(limited ? 'limited' : 'failed');
  }
  const e = new Error(`real turn failed (${why.join(', ')})`);
  e.limited = why.filter(w => w === 'limited').length === (tokens.length || 1);
  throw e;
}

try {
  npm(['install', `${PKG}@${latest}`, '--save-exact', '--no-audit', '--no-fund']);
  await smoke();
  console.log(`updated ${cur} -> ${latest}`);
} catch (e) {
  try { npm(['install', `${PKG}@${cur}`, '--save-exact', '--no-audit', '--no-fund']); } catch {}
  let now = 'unknown'; try { now = installed(); } catch {}
  const reason = String(e.message).split('\n')[0].slice(0, 200);
  if (now !== cur) { console.log(`rollback-failed: ${now} installed, wanted ${cur} (${latest} failed: ${reason})`); process.exit(2); }
  if (e.limited) { console.log(`skipped ${cur} (${latest} not checked: every account is rate-limited; trying again tomorrow)`); process.exit(0); }
  console.log(`rolled-back ${cur} (${latest} failed: ${reason})`);
  process.exit(2);
}
process.exit(0);
