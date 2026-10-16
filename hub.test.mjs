import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary, fmtElapsed, peerAgeMin } from './hub.mjs';
test('progress helpers', () => {
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'npm   test' } }), 'Bash: npm test');
  assert.equal(toolSummary({ name: 'mcp__tg__send_file', input: {} }), 'send_file');
  assert.equal(fmtElapsed(5000), '5s'); assert.equal(fmtElapsed(83000), '1m23s');
});
test('peer heartbeat age', () => {
  const now = Date.parse('2026-10-15T07:00:00Z');
  assert.equal(peerAgeMin('🟢 Mac Hub online · 15:50 (2026-10-15T06:50:00.000Z)', now), 10);
  assert.equal(peerAgeMin('', now), Infinity);
});
import { modelLine, chunks, inside, renderTool, claudeLimits, codexLimits, countsText, renderCard, noteOutputs, partitionSidebar, isTopicGone } from './hub.mjs';

test('deleted-topic errors are recognised', () => {
  assert.ok(isTopicGone({ description: 'Bad Request: message thread not found' }));
  assert.ok(isTopicGone({ description: 'Bad Request: TOPIC_DELETED' }));
  assert.ok(!isTopicGone({ description: 'Too Many Requests: retry after 5' }));
});

test('sync assigns each shared sidebar session to the account that used it last', () => {
  const p = partitionSidebar({
    c1: [{ cliSessionId: 'a', lastActivityAt: 5 }, { cliSessionId: 'b', lastActivityAt: 9 }, { cliSessionId: 'x', lastActivityAt: 1 }],
    c2: [{ cliSessionId: 'a', lastActivityAt: 7 }, { cliSessionId: 'b', lastActivityAt: 3 }],
  });
  assert.deepEqual(p.c1.map(r => r.cliSessionId), ['b', 'x']);
  assert.deepEqual(p.c2.map(r => r.cliSessionId), ['a']);
});

test('outputs are recorded only after a successful tool_result', () => {
  const t = {}, pend = new Map();
  noteOutputs(t, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'F:/p/ok.py' } }, { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: 'F:/p/denied.py' } }] } }, pend);
  assert.equal(t.outputs, undefined);
  noteOutputs(t, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }, { type: 'tool_result', tool_use_id: 'b', is_error: true }] } }, pend);
  assert.deepEqual(t.outputs, ['F:/p/ok.py']);
});

test('session card mirrors the desktop right panel', () => {
  const t = { title: 'project-x', cwd: 'D:/work/project-x', outputs: ['D:/work/project-x/a.js', 'F:/other/b.md', ...Array.from({ length: 5 }, (_, i) => `D:/work/project-x/x${i}`)] };
  const c = renderCard(t, { ctx: 53, bg: 1, mcp: [{ status: 'connected' }, { status: 'needs-auth' }, { status: 'failed' }] }).split('\n');
  assert.equal(c[0], '📁 project-x · D:/work/project-x');
  assert.match(c[1], /^🧠 Context ▓{5}░{5} 53%$/);
  assert.equal(c[2], '🔌 Connectors: 1 connected · 2 need reconnect');
  assert.equal(c[3], '📄 Outputs: a.js, b.md, x0, x1, x2 (+2)');
  assert.equal(c[4], '⏳ Background tasks: 1 running');
  assert.match(renderCard({ title: 'n', cwd: 'F:/n' }, {}), /Outputs: none\n⏳ Background tasks: none\n🤖 Model: account default\n🎚 Effort: [^\n]+\n⚙️ Mode: auto-approve, ask only when risky \(auto\)$/);
  assert.match(renderCard({ title: 'n', cwd: 'F:/n', mode: 'default' }, {}), /⚙️ Mode: ask before every action \(ask\)$/);
});

test('chunks split long text under the Telegram limit', () => {
  const parts = chunks('a\n'.repeat(5000));
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 3900));
  assert.equal(parts.join('\n').replace(/\n+/g, '').length, 5000);
});
test('inside rejects escapes and prefix look-alikes', () => {
  assert.ok(inside('D:/work/a', 'D:/work/a/b.png'));
  assert.ok(!inside('D:/work/a', 'D:/work/a2/b.png'));
  assert.ok(!inside('D:/work/a', 'D:/work/a/../b'));
  assert.ok(!inside('D:/work/a', 'C:/Windows'));
});
test('renderTool escapes HTML and shows a diff for Edit', () => {
  const h = renderTool('Edit', { file_path: 'x.js', old_string: 'a<b', new_string: 'a>b' });
  assert.match(h, /➖ a&lt;b/); assert.match(h, /➕ a&gt;b/);
  assert.match(renderTool('Bash', { command: 'rm -rf <dir>' }), /&lt;dir&gt;/);
});
test('panel lines: only 5h / weekly, coupons for Codex', () => {
  const soon = new Date(Date.now() + 3600e3).toISOString(), later = new Date(Date.now() + 3 * 86400e3).toISOString();
  const c = claudeLimits({ rate_limits: { five_hour: { utilization: 3, resets_at: soon }, seven_day: { utilization: 63.4, resets_at: later }, model_scoped: [{ display_name: 'Fable', utilization: 0 }] } });
  assert.equal(c.length, 2);
  assert.match(c[0], /^⏱ 5h {3}░{10}   3% · resets \d\d:\d\d$/);
  assert.match(c[1], /^📅 Week ▓{6}░{4}  63% · resets [A-Z][a-z]{2} [A-Z][a-z]{2} \d+ \d\d:\d\d$/);
  assert.deepEqual(claudeLimits({ error: 'x' }), ['⚠️ Usage unavailable']);
  const x = codexLimits({ rateLimits: { primary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 5 * 86400 } },
    rateLimitResetCredits: { credits: [{ status: 'available', expiresAt: Date.now() / 1000 + 20 * 86400 }] } });
  assert.match(x[0], /^📅 Week .* 81% · resets /); assert.match(x[1], /^🎟 Reset credits: 1 \(expire .*\)$/);
  assert.equal(countsText({ run: 0, wait: 1, idle: 2, off: 0 }), '👥 Sessions: 🟢 0 running · 🟡 1 waiting · ⚪ 2 idle · 💤 0 off');
});

test('model line', () => {
  assert.equal(modelLine(undefined), '🤖 Model: account default');
  assert.equal(modelLine(undefined, 'claude-opus-5-5'), '🤖 Model: account default (claude-opus-5-5)');
  assert.equal(modelLine('sonnet', 'claude-sonnet-5-5'), '🤖 Model: Sonnet 5.5');
});

import { rewriteProjectPath } from './hub.mjs';
test('move rewrites Windows project paths to the Mac path (escaped, slash, sub-paths, any case)', () => {
  const W = 'D:\\work\\project-y', M = '/Users/you/workspace/project-y';
  const src = JSON.stringify({ cwd: W, file: W + '\\src\\a.ts', x: 'd:/work/project-y/b.md', other: 'D:\\work\\Other\\c' });
  const out = JSON.parse(rewriteProjectPath(src, W, M)); // must still be valid JSON
  assert.deepEqual(out, { cwd: M, file: M + '/src/a.ts', x: M + '/b.md', other: 'D:\\work\\Other\\c' });
  const back = JSON.parse(rewriteProjectPath(JSON.stringify({ cwd: M, file: M + '/src/a.ts' }), M, W)); // Mac → Windows
  assert.deepEqual(back, { cwd: W, file: W + '\\src\\a.ts' });
});

import { parseAlias, routeMachine, mergeHeartbeat } from './hub.mjs';
test('上朝 addressing: nicknames, keywords, default', () => {
  const aliases = { a: { machine: 'Windows', group: 1 }, mac: { machine: 'Mac', group: 4 } };
  const route = { Mac: '(^|[^a-z])mac([^a-z]|$)|麦克|苹果' };
  assert.deepEqual(parseAlias('@a 帮我查一下', aliases), { machine: 'Windows', group: 1, alias: 'a', rest: '帮我查一下' });
  assert.equal(parseAlias('@mac：新建项目', aliases).rest, '新建项目');
  assert.equal(parseAlias('@a帮我查一下', aliases).rest, '帮我查一下'); // ASCII nickname: Chinese right after it is the task
  assert.equal(parseAlias('帮我查一下', aliases), null);
  assert.equal(parseAlias('mac 跑测试', aliases), null); // the @ is required
  assert.equal(parseAlias('Mac users: paste this into Terminal', aliases), null);
  assert.equal(routeMachine('@mac 跑测试', route, 'Windows', aliases), 'Mac');
  assert.equal(routeMachine('在麦克上开个项目', route, 'Windows', aliases), 'Mac');
  assert.equal(routeMachine('看看 machine learning 项目', route, 'Windows', aliases), 'Windows');
  assert.equal(routeMachine('随便做点事', route, 'Windows', aliases), 'Windows');
});
test('shared heartbeat description keeps one line per machine', () => {
  let d = mergeHeartbeat('', 'Windows', '🟢 Windows Hub online · 1 (2026-10-15T07:00:00.000Z)');
  d = mergeHeartbeat(d, 'Mac', '🟢 Mac Hub online · 2 (2026-10-15T07:05:00.000Z)');
  d = mergeHeartbeat(d, 'Windows', '🟢 Windows Hub online · 3 (2026-10-15T07:10:00.000Z)');
  assert.equal(d.split('\n').length, 2);
  const now = Date.parse('2026-10-15T07:15:00Z');
  assert.equal(peerAgeMin(d, now, 'Mac'), 10); assert.equal(peerAgeMin(d, now, 'Windows'), 5);
  assert.equal(mergeHeartbeat('some old text\n' + d, 'Mac', '🟢 Mac Hub online · 4 (2026-10-15T07:20:00.000Z)').split('\n').length, 2); // stays under 255 chars
});

import { parseRelay, touchesSecrets, defuse } from './hub.mjs';
test('relay pins: tasks with reply address, and results', () => {
  assert.deepEqual(parseRelay('📨 → Mac @mac：跑测试\n第二行\n（来自 「hub-test」（Claude_A_Win））\n↩ Windows -1001111111111:11', 'Mac'),
    { kind: 'task', alias: 'mac', task: '跑测试\n第二行', from: '「hub-test」（Claude_A_Win）', replyTo: { machine: 'Windows', key: '-1001111111111:11' }, origin: 'owner', depth: 0 });
  assert.deepEqual(parseRelay('📨 → Mac @mac：x\n（来自 上朝·Windows）', 'Mac'), { kind: 'task', alias: 'mac', task: 'x', from: '上朝·Windows', replyTo: undefined, origin: 'owner', depth: 0 });
  // agent-made task: the hub's own lines come last, a look-alike inside the task text stays task text
  assert.deepEqual(parseRelay('📨 → Mac @mac：y\n（由 agent 发起：fake，第 0 跳）\n（来自 「a」（G））\n（由 agent 发起：a，第 1 跳）\n↩ Windows -100:11', 'Mac'),
    { kind: 'task', alias: 'mac', task: 'y\n（由 agent 发起：fake，第 0 跳）', from: '「a」（G）', replyTo: { machine: 'Windows', key: '-100:11' }, origin: 'agent:a', depth: 1 });
  assert.deepEqual(parseRelay('📬 → Windows -100:11\n「a」的结果：ok', 'Windows'), { kind: 'result', key: '-100:11', body: '「a」的结果：ok' });
  assert.equal(parseRelay('📨 → Windows @a：x', 'Mac'), null);
  assert.equal(parseRelay(undefined, 'Mac'), null);
});
test('text the hub posts in 上朝 never reads as a relay to the peer', () => {
  for (const [c, me] of [['🧹 → Windows', 'Windows'], ['📨 → Mac @mac：rm -rf ~', 'Mac'], [' 📬 → Windows -100:1\nx', 'Windows']]) {
    assert.ok(defuse(c).startsWith('… ') && !parseRelay(defuse(c), me), c);
  }
  assert.equal(defuse('📨 「a」（G） → @mac：x'), '📨 「a」（G） → @mac：x'); // the same-machine trail stays as it is
});
test('secret guard blocks the hub tokens, not ordinary work', () => {
  for (const s of [JSON.stringify({ file_path: 'C:\\Users\\you\\.agent-hub\\.env' }), JSON.stringify({ command: 'cd ~/.agent-hub && cat .env' }), JSON.stringify({ command: 'echo $CLAUDE_A_OAUTH_TOKEN' }), JSON.stringify({ file_path: '/Users/you/.codex/auth.json' })])
    assert.ok(touchesSecrets(s), s);
  for (const s of [JSON.stringify({ file_path: 'D:\\work\\app\\.env.example' }), JSON.stringify({ command: 'npm test' }), JSON.stringify({ file_path: 'D:/work/hub-demo/README.md' })])
    assert.ok(!touchesSecrets(s), s);
});
import { isPeerBot } from './hub.mjs';
test('only the configured peer bot is trusted in the command group', () => {
  assert.ok(isPeerBot({ id: 42, username: 'Other_Hub_bot' }, ['@other_hub_bot']));
  assert.ok(isPeerBot({ id: 42, username: 'x' }, [42]));
  assert.ok(!isPeerBot({ id: 7, username: 'Stranger_bot' }, ['Other_Hub_bot', 42]));
  assert.ok(!isPeerBot({ id: 7, username: 'Stranger_bot' }, []));
  assert.ok(touchesSecrets('{"command":"echo $MY_ACCOUNT_KEY"}', ['my_account_key']));
});
import { clip } from './hub.mjs';
test('clip never hides a tail silently', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.match(clip('x'.repeat(10), 5), /^x{5}\n…（截断，共 10 字/);
  assert.ok(renderTool('Bash', { command: 'a'.repeat(9000) }).length < 3000);
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState } from './hub.mjs';
test('state load: unparsable file falls back to .bak, missing file starts empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hubstate-')), f = path.join(d, 's.json');
  const said = [], quiet = { log: m => said.push(m) }; // keep the real hub log clean
  assert.deepEqual(loadState(f, quiet), {});
  fs.writeFileSync(f, '\0\0\0'); fs.writeFileSync(`${f}.bak`, '{"topics":{"a":1}}');
  assert.deepEqual(loadState(f, quiet), { topics: { a: 1 } });
  assert.deepEqual(said, ['s.json corrupt, loaded .bak']);
  assert.ok(fs.readdirSync(d).some(n => n.startsWith('s.json.corrupt-')));
  fs.rmSync(d, { recursive: true, force: true });
});
import { retryLater } from './hub.mjs';
test('unsent replies: only transient send failures are kept for retry', () => {
  assert.equal(retryLater(new Error('fetch failed')), true); // network (HttpError has no error_code)
  assert.equal(retryLater({ error_code: 429, description: 'Too Many Requests: retry after 300' }), true);
  assert.equal(retryLater({ error_code: 502 }), true);
  assert.equal(retryLater({ error_code: 400, description: 'Bad Request: message thread not found' }), false);
  assert.equal(retryLater({ error_code: 403 }), false);
});
import { isAuthError, tokenDaysLeft, reapable } from './hub.mjs';
test('session lifecycle: auth errors, token expiry, idle sessions to close', () => {
  assert.ok(isAuthError('Failed to authenticate. API Error: 401 {"type":"authentication_error"}'));
  assert.ok(isAuthError('OAuth token has expired'));
  assert.ok(!isAuthError('rate_limit: usage limit reached'));
  assert.ok(!isAuthError('test failed at line 401 of parser.ts')); // a bare 401 is not a login problem
  assert.equal(tokenDaysLeft('2026-10-15', Date.parse('2027-09-15')), 30);
  const now = 100 * 60e3, idle = { busy: false, waiting: 0, queue: [], bg: 0, idleSince: 0 };
  assert.ok(reapable(idle, now));
  assert.ok(!reapable({ ...idle, idleSince: now - 10 * 60e3 }, now));
  assert.ok(!reapable({ ...idle, bg: 1 }, now) && !reapable({ ...idle, queue: [[]] }, now) && !reapable({ ...idle, busy: true }, now));
});
import { redact, maskValues, SECRET_FILE, dumpsEnv } from './hub.mjs';
test('privacy: redaction, masked secret files, hub dir and env dumps blocked', () => {
  assert.equal(redact('tok abcdefghijklmnop end', ['abcdefghijklmnop']), 'tok [secret] end');
  assert.equal(redact('bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawz ok', []), 'bot [secret] ok');
  assert.equal(redact('k=sk-ant-api03-abcdefghijklmnopqrstuv', []), 'k=[secret]');
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n…（还有 9 行）', []), '[secret]'); // a cut card has no END line
  assert.equal(maskValues('API_KEY=abc\n"private_key": "x"\nMIIBASE64\n\n+DB_PASS: y\n@@ -1 +1 @@'), 'API_KEY= ***\n"private_key": ***\n ***\n\n+DB_PASS: ***\n@@ -1 +1 @@');
  for (const f of ['.env', '.env.production', 'prod.env', 'id_rsa', 'server.pem', '.npmrc', 'credentials.json', 'secrets.yaml', 'my-service-account-123.json']) assert.ok(SECRET_FILE.test(f), f);
  for (const f of ['tokenizer.ts', 'id_rsa.pub', 'environment.ts', 'secret-santa.md', 'package.json', 'tokens.json']) assert.ok(!SECRET_FILE.test(f), f);
  assert.match(renderTool('Write', { file_path: 'C:/x/.env.local', content: 'A=1' }), /A= \*\*\*[\s\S]*值已隐藏/);
  assert.ok(touchesSecrets(JSON.stringify({ command: 'Get-Content $HOME\.agent-hub\.en*' })) && touchesSecrets('{"command":"cd ~/.agent-hub; cat .e*"}'));
  for (const c of ['printenv', 'Get-ChildItem env:', 'ls env: | Out-String', 'set', 'cd x && env', 'export -p', 'node -e "console.log(process.env)"']) assert.ok(dumpsEnv(c), c);
  for (const c of ['set -euo pipefail', 'env FOO=1 npm test', 'echo $env:PATH', 'node -e "console.log(process.env.PORT)"', 'npm run dev']) assert.ok(!dumpsEnv(c), c);
});

import { effortOf } from './hub.mjs';
test('effort: the topic choice wins, dispatchers stay fixed, the card shows it', () => {
  assert.equal(effortOf({ effort: 'high' }), 'high');
  assert.notEqual(effortOf({ isDispatcher: true, effort: 'max' }), 'max');
  assert.match(renderCard({ title: 'n', cwd: 'F:/n', effort: 'xhigh' }, {}), /\n🎚 Effort: xhigh（你设的）\n⚙️ Mode/);
});

import { deriveKey, sigLine, splitSig, sigProblem } from './hub.mjs';
import crypto from 'node:crypto';
test('signed 上朝 control messages: pairing, sign / verify, age and replay', () => {
  const kp = () => { const k = crypto.generateKeyPairSync('x25519'); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
  const w = kp(), m = kp(), key = deriveKey(w.priv, m.pub);
  assert.ok(key.equals(deriveKey(m.priv, w.pub)) && key.length === 32); // both ends derive the same key
  assert.ok(!key.equals(deriveKey(kp().priv, m.pub)));
  const body = '📨 → Mac @mac：跑测试\n（来自 上朝·Windows）\n↩ Windows -100:11', ts = 1_800_000_000;
  const sg = splitSig(`${body}\n${sigLine(key, 'Windows', 'Mac', body, ts)}`);
  assert.equal(sg.body, body); assert.equal(sg.ts, ts);
  assert.equal(parseRelay(sg.body, 'Mac').replyTo.key, '-100:11'); // the #sig line never reaches parseRelay
  assert.equal(sigProblem(key, 'Windows', 'Mac', sg, ts + 30), null);
  // what Telegram may strip in transit (control / zero-width characters, line-end spaces) doesn't break the signature
  const sent = body.replace('跑测试', '跑\u200b测\x07试  '), sg2 = splitSig(`${sent}\n${sigLine(key, 'Windows', 'Mac', sent, ts)}`);
  assert.equal(sigProblem(key, 'Windows', 'Mac', { ...sg2, body }, ts), null);
  assert.equal(sigProblem(key, 'Windows', 'Mac', { ...sg, body: body.replace('跑测试', 'rm -rf ~') }, ts), '签名不对');
  assert.equal(sigProblem(key, 'Mac', 'Windows', sg, ts), '签名不对'); // bound to the direction
  assert.equal(sigProblem(deriveKey(kp().priv, m.pub), 'Windows', 'Mac', sg, ts), '签名不对');
  assert.match(sigProblem(key, 'Windows', 'Mac', sg, ts + 601), /10 分钟/);
  assert.match(sigProblem(key, 'Windows', 'Mac', sg, ts, [sg.mac]), /重放/);
  assert.equal(sigProblem(key, 'Windows', 'Mac', splitSig(body), ts), '没有签名');
  assert.deepEqual(splitSig('x\n#sig nope'), { body: 'x\n#sig nope' });
  assert.ok(defuse('🔑 → Mac MCowBQYDK2VuAyEA').startsWith('… '));
});
import { mergeEnv, ENV_NOTE } from './hub.mjs';
test('.env split / merge for .env.dpapi', () => {
  const text = '\uFEFF# note\nTELEGRAM_BOT_TOKEN=1:new\r\nOWNER_ID=42\nCLAUDE_A_OAUTH_TOKEN=\nAPI_KEY = a=b\n';
  const r = mergeEnv(text, { TELEGRAM_BOT_TOKEN: '1:old', CLAUDE_A_OAUTH_TOKEN: 'sealed', HUB_HOOK_TOKEN: 'h' });
  assert.deepEqual(r.env, { OWNER_ID: '42', CLAUDE_A_OAUTH_TOKEN: 'sealed', TELEGRAM_BOT_TOKEN: '1:new', HUB_HOOK_TOKEN: 'h', API_KEY: 'a=b' }); // plaintext wins, empty doesn't
  assert.deepEqual(r.plain, { TELEGRAM_BOT_TOKEN: '1:new', API_KEY: 'a=b' });
  assert.equal(r.rest, `${ENV_NOTE}\n# note\nOWNER_ID=42\nCLAUDE_A_OAUTH_TOKEN=\n`);
  const again = mergeEnv(r.rest, { ...r.plain }); // idempotent: nothing left to move, note not doubled
  assert.deepEqual(again.plain, {}); assert.equal(again.rest, r.rest); assert.equal(again.env.TELEGRAM_BOT_TOKEN, '1:new');
  assert.deepEqual(mergeEnv('K_TOKEN=YWJj==\n').env, { K_TOKEN: 'YWJj==' }); // .env.dpapi lines keep base64 padding
});
import { mdToHtml, mdChunks, defuseChunk } from './hub.mjs';
test('agent Markdown renders to Telegram HTML, chunks stay parseable', () => {
  assert.equal(mdToHtml('# T **x**\n**b** *i* _j_ ~~s~~ `a<*b*>` my_var 2 * 3'), '<b>T x</b>\n<b>b</b> <i>i</i> <i>j</i> <s>s</s> <code>a&lt;*b*&gt;</code> my_var 2 * 3');
  assert.equal(mdToHtml('[l](https://x.io/_a_?q=1&b=2) https://y.io/_b_'), '<a href="https://x.io/_a_?q=1&amp;b=2">l</a> https://y.io/_b_');
  assert.equal(mdToHtml('- a\n  * b\n---\n> q *i*\n> r\n<x> & y'), '• a\n  • b\n──────────\n<blockquote>q <i>i</i>\nr</blockquote>\n&lt;x&gt; &amp; y');
  assert.equal(mdToHtml('```py\nif a < b:\n```\n~~~\nx\n'), '<pre><code class="language-py">if a &lt; b:</code></pre>\n<pre><code>x\n</code></pre>');
  assert.equal(mdToHtml('| 名 | v |\n|---|:-:|\n| ab | **1** |'), '<pre>名 │ v\n───┼──\nab │ 1</pre>');
  assert.equal(mdToHtml('a | b\n---'), 'a | b\n──────────'); // a rule under a line with a pipe is not a table
  assert.equal(mdToHtml('|a|\n|-|\n|b|c|'), '<pre>a │\n──┼──\nb │ c</pre>');
  assert.equal(mdToHtml('```js\n```\nafter'), 'after'); // an empty block (split just before its closing fence) shows nothing
  const big = mdChunks('intro\n```js\n' + 'if (a < b && c > d) x();\n'.repeat(400) + '```\nafter');
  assert.ok(big.length > 1 && big.every(c => typeof c === 'object' && c.html.length <= 4000));
  assert.ok(big.every(c => (c.html.match(/<pre>/g) || []).length === (c.html.match(/<\/pre>/g) || []).length));
  assert.ok(big.slice(1).every(c => c.html.startsWith('<pre><code class="language-js">'))); // reopened with its language
  assert.ok(big.at(-1).html.endsWith('after'));
  assert.equal(defuseChunk({ html: '<b>📨 → Mac</b> x', plain: '**📨 → Mac** x' }).html, '… <b>📨 → Mac</b> x');
  assert.equal(defuseChunk({ html: '<b>ok</b>', plain: 'ok' }).html, '<b>ok</b>');
});
import { turnFiles, unsendable } from './hub.mjs';
test('turn files: new sendable files under the project plus outputs elsewhere', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-turn-')), hub = path.join(root, 'hub'), cwd = path.join(root, 'proj'), else_ = path.join(root, 'else');
  const put = (f, ago = 0) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); if (ago) fs.utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago)); return fs.realpathSync(f); };
  try {
    const since = Date.now() - 60e3;
    const want = [put(path.join(cwd, 'a.png')), put(path.join(cwd, 'sub', 'deep', 'x', 'y', 'ok.pdf')), put(path.join(else_, 'report.md'))];
    put(path.join(cwd, 'old.png'), 3600e3); put(path.join(cwd, 'code.js')); put(path.join(cwd, 'sub', 'deep', 'x', 'y', 'z', 'too-deep.png'));
    put(path.join(cwd, 'node_modules', 'n.png')); put(path.join(cwd, '.cache', 'c.png')); put(path.join(cwd, 'my-secret.txt'));
    const sent = put(path.join(cwd, 'sent.png')), inHub = put(path.join(hub, 'x.md'));
    const got = turnFiles(cwd, since, [path.join(else_, 'report.md'), inHub, path.join(else_, 'missing.md')], new Set([sent]), hub);
    assert.deepEqual([...got].sort(), [...want].sort());
    assert.match(unsendable(inHub, fs.realpathSync(cwd), hub), /Hub/);
    assert.match(unsendable(path.join(root, '.ssh', 'k.txt'), cwd, hub), /密钥/); // outside the project: the whole path is checked
    assert.equal(unsendable(path.join(else_, 'report.md'), cwd, hub), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
import { parseNumstat, diffSummary, maskSecretDiff, gitTree } from './hub.mjs';
import { execFileSync } from 'node:child_process';
test('turn change summary and masked /diff', () => {
  const n = parseNumstat('3\t1\tsrc/a.js\n-\t-\timg.png\n10\t0\tdocs/b.md\n');
  assert.deepEqual([n.files.length, n.add, n.del], [3, 13, 1]);
  assert.equal(diffSummary(n), '📝 3 个文件 +13 −1\n· docs/b.md +10 −0\n· src/a.js +3 −1\n· img.png +0 −0\n/diff 看完整改动');
  assert.equal(diffSummary(parseNumstat('')), '');
  const d = 'diff --git a/x.js b/x.js\n+ok\ndiff --git a/conf/.env b/conf/.env\n+TOKEN=abc\n';
  assert.equal(maskSecretDiff(d), 'diff --git a/x.js b/x.js\n+ok\ndiff --git a/conf/.env b/conf/.env\n（密钥类文件，内容已隐藏）\n');
});
test('git snapshot never touches the real index or worktree', { skip: (() => { try { execFileSync('git', ['--version']); return false; } catch { return 'no git'; } })() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-git-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir }).toString();
  try {
    g('init', '-q'); fs.writeFileSync(path.join(dir, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'i');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n'); // untracked, not staged
    const idx = fs.readFileSync(path.join(dir, '.git', 'index'));
    const t1 = await gitTree(dir);
    fs.appendFileSync(path.join(dir, 'a.txt'), '2\n');
    const t2 = await gitTree(dir);
    assert.ok(t1 && t2 && t1 !== t2);
    assert.deepEqual(fs.readFileSync(path.join(dir, '.git', 'index')), idx);
    assert.match(g('status', '--porcelain'), /^ M a\.txt\n\?\? b\.txt\n$/); // nothing staged, b.txt still untracked
    assert.equal(parseNumstat(g('diff', '--numstat', t1, t2)).add, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
import { imageInfo, pdfPages, fileBlock, folderFiles } from './hub.mjs';
test('phone files: images and PDFs inlined only within the API limits', () => {
  const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108012c0258030122000211010311010000', 'hex');
  const gif = Buffer.from('474946383961' + '4001' + 'f000' + '0000', 'hex');
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBPVP8X', 8); webp.writeUIntLE(1919, 24, 3); webp.writeUIntLE(1079, 27, 3);
  assert.deepEqual(imageInfo(png(800, 600)), { type: 'image/png', w: 800, h: 600 });
  assert.deepEqual(imageInfo(jpg), { type: 'image/jpeg', w: 600, h: 300 });
  assert.deepEqual(imageInfo(gif), { type: 'image/gif', w: 320, h: 240 });
  assert.deepEqual(imageInfo(webp), { type: 'image/webp', w: 1920, h: 1080 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
  assert.equal(fileBlock(png(800, 600), 'image/png').source.media_type, 'image/png');
  assert.equal(fileBlock(png(800, 600), 'image/jpeg').source.media_type, 'image/png'); // the bytes win over mime_type
  assert.equal(fileBlock(png(1080, 9000), 'image/png'), null); // long screenshot: path only
  assert.equal(fileBlock(png(800, 600), 'application/octet-stream'), null);
  const pdf = n => Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Pages /Count ${n} /Kids [] >> endobj\n3 0 obj << /Type /Outlines /Count 3 >> endobj`);
  assert.equal(pdfPages(pdf(12)), 12);
  assert.equal(fileBlock(pdf(12), 'application/pdf').type, 'document');
  assert.equal(fileBlock(pdf(12), 'application/pdf', false), null); // Codex: the path only
  assert.equal(fileBlock(pdf(250), 'application/pdf'), null);
  assert.equal(fileBlock(Buffer.from('hello'), 'application/pdf'), null);
});
test('/get folder: secrets, dependencies and the hub folder are left out; size capped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-get-')), dir = path.join(root, 'proj'), hub = path.join(dir, 'hubdir');
  const put = (f, n = 1) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'.repeat(n)); };
  try {
    put(path.join(dir, 'a.txt')); put(path.join(dir, 'sub', 'b.md')); put(path.join(dir, '.env')); put(path.join(dir, 'sub', 'api-token.txt'));
    put(path.join(dir, 'node_modules', 'x.js')); put(path.join(dir, '.git', 'HEAD')); put(path.join(hub, 'state.json'));
    assert.deepEqual(folderFiles(dir, hub).sort(), ['a.txt', path.join('sub', 'b.md')]);
    put(path.join(dir, 'big.bin'), 100);
    assert.throws(() => folderFiles(dir, hub, 50), /太大/);
    assert.match(unsendable(path.join(root, '.codex', 'auth.json'), path.join(root, '.codex'), hub), /密钥/); // whole path checked even inside the project
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
import { screenArgs, shotArgs, looksBlank } from './hub.mjs';
import zlib from 'node:zlib';
test('/screen and /shot arguments; blank captures detected', () => {
  assert.deepEqual(screenArgs(''), { n: 0 }); assert.deepEqual(screenArgs(' mac '), { n: 0 }); assert.deepEqual(screenArgs('2 mac'), { n: 2 });
  assert.ok(screenArgs('0').error && screenArgs('1 2').error && screenArgs('all').error);
  assert.deepEqual(shotArgs('3000'), { url: 'http://localhost:3000/', width: 1280, height: 720 });
  assert.deepEqual(shotArgs('localhost:5173/app 390 mac'), { url: 'http://localhost:5173/app', width: 390, height: 720 });
  assert.equal(shotArgs('example.com 1920').url, 'https://example.com/'); assert.equal(shotArgs('example.com 1920').height, 1080);
  assert.equal(shotArgs('http://127.0.0.1:8080/x?y=1').url, 'http://127.0.0.1:8080/x?y=1');
  for (const bad of ['', 'file:///C:/x.html', 'javascript:alert(1)', 'a.com 100', 'a.com 5000', 'a.com wide', 'a b c', '99999']) assert.ok(shotArgs(bad).error, bad);
  const png = (w, h, raw) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return Buffer.concat([b, zlib.deflateSync(raw)]); };
  assert.ok(looksBlank(png(1440, 900, Buffer.alloc(1440 * 900 * 3)))); // all black
  assert.ok(!looksBlank(png(1440, 900, crypto.randomBytes(1440 * 900 * 3).subarray(0, 300000)))); // real content barely compresses
});

import { exchanges, introHtml, historyMd } from './hub.mjs';
test('recap: typed user turns and the final assistant text per exchange; noise left out', () => {
  const u = c => ({ type: 'user', parent_tool_use_id: null, message: { content: c } });
  const a = (...c) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: c } });
  const msgs = [
    u('This session is being continued from a previous conversation…'),
    u('修一下登录'), a({ type: 'text', text: '我先看看。' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
    u([{ type: 'tool_result', tool_use_id: 't1', content: 'file' }]),
    { type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'subagent noise' }] } },
    a({ type: 'text', text: '修好了。' }),
    u([{ type: 'text', text: '<task-notification> <task-id>x</task-id>' }]), a({ type: 'text', text: '后台任务完成。' }),
    u([{ type: 'image', source: {} }]), a({ type: 'thinking', thinking: '…' }),
    u('看看图'), a({ type: 'tool_use', id: 't2', name: 'mcp__ccd_turn__wrap_up', input: { recap: '图发你了。', ask: '要换吗？' } }),
    u([{ type: 'text', text: '这是用户布置的任务，直接开始做：\n\n加个测试' }]), a({ type: 'text', text: '加好了' }),
  ];
  assert.deepEqual(exchanges(msgs), [
    { user: '修一下登录', reply: '修好了。' }, // the notification's answer doesn't overwrite it
    { user: '（图片 / 文件）', reply: '' },
    { user: '看看图', reply: '图发你了。\n要换吗？' }, // desktop app: the answer is in wrap_up
    { user: '加个测试', reply: '加好了' },
  ]);
  assert.equal(exchanges(msgs, 1).length, 1);
  const html = introHtml('已接上 <x>', exchanges(msgs), '目录：F:/p');
  assert.match(html, /^已接上 &lt;x&gt;\n\n<b>📜 之前的对话（最近 4 轮）<\/b>\n<blockquote expandable><b>你：<\/b>修一下登录\n<b>Claude：<\/b>修好了。/);
  assert.match(html, /（没有文字回复）[\s\S]*<\/blockquote>\n\n目录：F:\/p$/);
  assert.equal(introHtml('head', []), 'head');
  const long = Array.from({ length: 4 }, () => ({ user: '&'.repeat(500), reply: '<'.repeat(500) }));
  const fit = introHtml('h', long);
  assert.ok(fit.length <= 4000 && /最近 \d 轮/.test(fit) && !/最近 4 轮/.test(fit)); // oldest dropped until it fits
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(introHtml('h', [{ user: `${'a'.repeat(399)}😀`, reply: '' }]))); // cut never splits an emoji
  assert.match(historyMd('p', [{ user: 'q', reply: '' }]), /^# p：最近 1 轮对话\n\n## 1\n\n\*\*你：\*\*\n\nq\n\n\*\*Claude：\*\*\n\n（没有文字回复）$/);
});

import { mirrorScan, mirrorHtml } from './hub.mjs';
test('desktop mirror: new transcript bytes → finished exchanges and the bytes they used', () => {
  const L = o => JSON.stringify(o) + '\n', B = (...ls) => Buffer.from(ls.join(''));
  const u = c => L({ type: 'user', message: { role: 'user', content: c } });
  const a = (stop, ...c) => L({ type: 'assistant', message: { role: 'assistant', content: c, stop_reason: stop } });
  const text = t => ({ type: 'text', text: t });
  const ex1 = [u('改一下标题'), a(null, text('我看看'), { type: 'tool_use', id: 't1', name: 'Edit', input: {} }), u([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), a('end_turn', text('改好了'))];
  // A finished exchange (end_turn), noise skipped (meta / sidechain / file-history lines), partial last line left for next time.
  const noise = [L({ type: 'user', isMeta: true, message: { content: 'Base directory for this skill' } }), L({ type: 'assistant', isSidechain: true, message: { content: [text('sub')] } }), L({ type: 'file-history-snapshot' })];
  const partial = '{"type":"user","message":{"content":"下一';
  let buf = B(...ex1, ...noise, partial), r = mirrorScan(buf, false);
  assert.deepEqual(r.ex, [{ user: '改一下标题', reply: '改好了' }]);
  assert.equal(r.used, buf.length - Buffer.byteLength(partial)); // byte offsets, not characters (中文 = 3 bytes)
  // Unfinished: mid tool call → nothing, the offset stays at its user line; earlier finished ones still go.
  const open = [u('再跑一下测试'), a(null, text('跑一下'), { type: 'tool_use', id: 't2', name: 'Bash', input: {} })];
  buf = B(...ex1, ...open); r = mirrorScan(buf, true);
  assert.deepEqual(r.ex.map(e => e.user), ['改一下标题']);
  assert.equal(r.used, Buffer.byteLength(ex1.join('')));
  assert.equal(r.waiting, false);
  // Ends on text without end_turn: waits until the caller says the session settled.
  buf = B(u('就这样？'), a(null, text('对。'))); r = mirrorScan(buf, false);
  assert.deepEqual([r.ex, r.used, r.waiting], [[], 0, true]);
  assert.deepEqual(mirrorScan(buf, true), { ex: [{ user: '就这样？', reply: '对。' }], used: buf.length, waiting: false });
  // Desktop app: the answer is in wrap_up; its tool_result after it still counts as the end.
  buf = B(u('看看'), a(null, { type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: '看完了' } }), u([{ type: 'tool_result', tool_use_id: 'w', content: '' }]));
  assert.deepEqual(mirrorScan(buf, true).ex, [{ user: '看看', reply: '看完了' }]);
  // Only a user line so far / no answer before the next one (interrupted): not posted.
  assert.deepEqual(mirrorScan(B(u('在吗')), true), { ex: [], used: 0, waiting: false });
  buf = B(u('算了'), u('[Request interrupted by user]')); r = mirrorScan(buf, false);
  assert.deepEqual([r.ex, r.used], [[], buf.length]); // the interruption opens nothing typed
  // The session woke up by itself (background task done): posted with no user side; a notification mid-turn stays in that turn.
  const tn = u('<task-notification> <task-id>b1</task-id> done');
  buf = B(tn, a('end_turn', text('练完了，对比如下'))); r = mirrorScan(buf, false);
  assert.deepEqual(r.ex, [{ user: '', auto: true, reply: '练完了，对比如下' }]);
  assert.equal(mirrorHtml(r.ex[0]), '🖥 桌面（后台任务结束后）：\n<b>Claude：</b>练完了，对比如下');
  assert.deepEqual(mirrorScan(B(tn, a(null, text('跑一下'), { type: 'tool_use', id: 't3', name: 'Bash', input: {} })), true), { ex: [], used: 0, waiting: false });
  assert.deepEqual(mirrorScan(B(u('等它'), tn, a('end_turn', text('好了'))), false).ex, [{ user: '等它', reply: '好了' }]);
  assert.deepEqual(exchanges([JSON.parse(tn), JSON.parse(a('end_turn', text('x')))]), []); // recaps still skip them
  // Lines belonging to a turn already used up (late writes), and nothing at all.
  assert.deepEqual(mirrorScan(B(a('end_turn', text('late'))), false), { ex: [], used: Buffer.byteLength(a('end_turn', text('late'))), waiting: false });
  assert.deepEqual(mirrorScan(Buffer.alloc(0), false), { ex: [], used: 0, waiting: false });
  // One message per exchange, escaped and cut to fit.
  assert.equal(mirrorHtml({ user: '<a>', reply: 'b&c' }), '🖥 桌面：\n<b>你：</b>&lt;a&gt;\n<b>Claude：</b>b&amp;c');
  assert.ok(mirrorHtml({ user: 'q', reply: '<'.repeat(9000) }).length <= 4000);
});

import { DESKTOP_APP } from "./hub.mjs";
test("takeover only touches CLI processes the Claude desktop app started", () => {
  for (const p of [String.raw`C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe`, "/Applications/Claude.app/Contents/MacOS/Claude", "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"])
    assert.ok(DESKTOP_APP.test(p), p);
  for (const p of [String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, String.raw`C:\Users\u\.local\bin\claude.exe`, String.raw`C:\Program Files\nodejs\node.exe`, "/bin/zsh", "/usr/local/bin/node", ""])
    assert.ok(!DESKTOP_APP.test(p), p);
});

import { STATUS_MARKS, stripMark } from './hub.mjs';
test('topic status marks come off a renamed title', () => {
  for (const m of Object.values(STATUS_MARKS)) assert.equal(stripMark(m + 'my-project'), 'my-project');
  assert.equal(stripMark('my-project'), 'my-project');
  assert.equal(stripMark('🟡 🟢 x'), '🟢 x'); // one mark only: a title may itself start with an emoji
});

import { missingTg, recapText } from './hub.mjs';
test('telegram turns a branch lacks; their recap never shows as the user message', () => {
  const L = (uuid, parentUuid, type = 'assistant', extra = {}) => JSON.stringify({ uuid, parentUuid, type, ...extra });
  // d1 (desktop) → t1 (Telegram, hub) ; d1 → d2 (desktop again, from its own leaf) — newest is d2's branch
  const lines = [L('d0', null, 'user'), L('d1', 'd0'), L('tu', 'd1', 'user'), L('t1', 'tu'), L('du', 'd1', 'user'), L('m', 'du', 'system'), L('d2', 'm'), L('s', 'd2', 'assistant', { isSidechain: true }), '{"type":"last-prompt"}', 'partial'];
  const log = [{ leaf: 't1', at: 0, user: 'q', reply: 'a' }, { leaf: 'd1', at: 0 }];
  assert.deepEqual(missingTg(lines, log).map(e => e.leaf), ['t1']);
  assert.deepEqual(missingTg([...lines, L('tu2', 't1', 'user'), L('t2', 'tu2')], log), []); // newest on the Telegram branch: nothing lacks
  const r = recapText([{ at: Date.now(), user: '改一下', reply: '改好了' }], '用户在 Telegram 里聊了');
  assert.match(r, /用户：改一下\nClaude：改好了/);
  assert.deepEqual(exchanges([{ type: 'user', message: { content: [{ type: 'text', text: r }, { type: 'text', text: '这是用户布置的任务，直接开始做：真正的问题' }] } }, { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }]),
    [{ user: '真正的问题', reply: '好' }]);
});

import { askQuestions } from './hub.mjs';
test('a desktop option card becomes buttons; taps become the answers', async () => {
  const input = { questions: [{ question: '用哪个方案？', options: [{ label: 'A', description: '快' }, { label: 'B' }] }, { question: '现在发吗？', multiSelect: true, options: [{ label: '发' }, { label: '等等' }] }] };
  const seen = [], taps = ['1', '0'];
  const ask = (html, opts, vertical) => { seen.push({ html, opts, vertical }); return Promise.resolve(taps.shift()); };
  assert.deepEqual(await askQuestions(input, 'p · 1234', ask), { '用哪个方案？': 'B', '现在发吗？': '发' });
  assert.ok(seen[0].vertical && seen[0].html.includes('• <b>A</b> — 快') && seen[0].opts.at(-1)[1] === '');
  assert.match(seen[1].html, /只能选一个/);
  assert.equal(await askQuestions(input, 'p', () => Promise.resolve('')), null); // 回电脑上答
  assert.equal(await askQuestions(input, 'p', () => Promise.resolve(null)), null); // timed out
  assert.equal(await askQuestions({}, 'p', () => Promise.resolve('0')), null);
});

import { bgScan } from './hub.mjs';
test('background tasks a session left running: started by a tool result, finished by its notification', () => {
  const L = o => JSON.stringify(o);
  const started = id => L({ type: 'user', message: { content: [{ type: 'tool_result', content: `Command running in background with ID: ${id}. Output is being written to: x` }] } });
  const note = (id, st) => L({ type: 'user', message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>t</tool-use-id>\n<status>${st}</status>\n</task-notification>` } });
  assert.deepEqual([...bgScan([started('a1'), started('b2'), note('a1', 'completed')].join('\n'))], ['b2']);
  assert.deepEqual([...bgScan([note('b2', 'running')].join('\n'), new Set(['b2']))], ['b2']); // a progress event, not the end
  assert.deepEqual([...bgScan([note('b2', 'stopped'), '{"type":"queue-operation","content":"<task-id>zz</task-id>"}', 'partial {'].join('\n'), new Set(['b2']))], []);
  const queued = L({ type: 'queue-operation', content: '<task-notification>\n<task-id>q7</task-id>\n<status>completed</status>' }); // finished mid-turn
  assert.deepEqual([...bgScan(queued, new Set(['q7', 'x']))], ['x']);
  assert.deepEqual([...bgScan(L({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', content: 'running in background with ID: s9' }] } }))], []);
});
test('a tool output quoting another session\'s background line is not a background task', () => {
  const quote = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '09:13 user [{"content":"Command running in background with ID: zz9. Output"}]' }] } });
  const real = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Command running in background with ID: ok1. Output is being written to: f' }] }] } });
  assert.deepEqual([...bgScan([quote, real].join('\n'))], ['ok1']);
});

import { hubCodeOnly, pendingWebCall } from './hub.mjs';
test('hub-admin topics may touch the hub code, never its secrets', () => {
  for (const ok of [String.raw`C:\Users\u\.agent-hub\hub.mjs`, 'cd ~/.agent-hub && node --test hub.test.mjs', '~/.agent-hub/RULES.md'])
    assert.ok(!touchesSecrets(hubCodeOnly(JSON.stringify({ x: ok }))), ok);
  for (const bad of [String.raw`C:\Users\u\.agent-hub\.env`,'~/.agent-hub/.env.dpapi', '~/.agent-hub/state.json', 'echo $C1_OAUTH_TOKEN', '~/.claude/.credentials.json'])
    assert.ok(touchesSecrets(hubCodeOnly(JSON.stringify({ x: bad }))), bad);
  assert.ok(touchesSecrets(JSON.stringify({ x: '~/.agent-hub/hub.mjs' }))); // other topics: the whole folder stays off limits
});
test('a browser call with no result is the desktop app waiting for a site approval', () => {
  const L = o => JSON.stringify(o);
  const call = name => L({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } });
  assert.equal(pendingWebCall([L({ type: 'user', message: { content: 'go' } }), call('mcp__Claude_Browser__javascript_tool'), L({ type: 'attachment' })].join('\n')), 'javascript_tool');
  assert.equal(pendingWebCall([call('mcp__claude-in-chrome__navigate')].join('\n')), 'navigate');
  assert.equal(pendingWebCall([call('Bash')].join('\n')), null);
  assert.equal(pendingWebCall([call('mcp__Claude_Browser__navigate'), L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })].join('\n')), null);
});
import { lastHost } from './hub.mjs';
test('the site a stuck browser agent was on: the last navigated URL', () => {
  const t = [JSON.stringify({ input: { url: 'https://a.example.com/x' } }), JSON.stringify({ input: { url: 'https://shop.example.com/doc?id=1' } }), JSON.stringify({ input: { tabId: 't' } })].join('\n');
  assert.equal(lastHost(t), 'shop.example.com');
  assert.equal(lastHost('{"input":{"text":"no url"}}'), '');
});
