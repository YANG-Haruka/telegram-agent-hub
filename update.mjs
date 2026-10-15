// Daily self-update of the Claude Agent SDK (which bundles the claude binary the hub runs).
// Installs the latest version, runs the self-test plus one real tiny turn, and rolls back on failure.
// Prints one line: "up-to-date X" | "updated X -> Y" | "rolled-back X (Y failed: reason)". Exit 0 unless rolled back.
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

async function smoke() {
  execFileSync(process.execPath, ['--test', 'hub.test.mjs'], { stdio: 'ignore', windowsHide: true, timeout: 300000 });
  const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const { query } = await import(PKG); // first import in this process → the freshly installed version
  let ok = false;
  const token = Object.entries(env).find(([k, v]) => /_OAUTH_TOKEN$/.test(k) && v)?.[1]; // any account's token; else the machine's own login
  for await (const m of query({ prompt: 'Reply with exactly: OK', options: { model: 'haiku', maxTurns: 1, env: { ...process.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) } } }))
    if (m.type === 'result') ok = !m.is_error && /OK/.test(m.result || '');
  if (!ok) throw new Error('real turn failed');
}

try {
  npm(['install', `${PKG}@${latest}`, '--save-exact', '--no-audit', '--no-fund']);
  await smoke();
  console.log(`updated ${cur} -> ${latest}`);
} catch (e) {
  try { npm(['install', `${PKG}@${cur}`, '--save-exact', '--no-audit', '--no-fund']); } catch {}
  console.log(`rolled-back ${cur} (${latest} failed: ${String(e.message).split('\n')[0].slice(0, 200)})`);
  process.exit(2);
}
process.exit(0);
