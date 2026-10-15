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
  const t = { title: 'my-proj', cwd: 'D:/work/my-proj', outputs: ['D:/work/my-proj/a.js', 'F:/other/b.md', ...Array.from({ length: 5 }, (_, i) => `D:/work/my-proj/x${i}`)] };
  const c = renderCard(t, { ctx: 53, bg: 1, mcp: [{ status: 'connected' }, { status: 'needs-auth' }, { status: 'failed' }] }).split('\n');
  assert.equal(c[0], '📁 my-proj · D:/work/my-proj');
  assert.match(c[1], /^🧠 Context ▓{5}░{5} 53%$/);
  assert.equal(c[2], '🔌 Connectors: 1 connected · 2 need reconnect');
  assert.equal(c[3], '📄 Outputs: a.js, b.md, x0, x1, x2 (+2)');
  assert.equal(c[4], '⏳ Background tasks: 1 running');
  assert.match(renderCard({ title: 'n', cwd: 'F:/n' }, {}), /Outputs: none\n⏳ Background tasks: none\n🤖 Model: account default\n⚙️ Mode: auto-approve, ask only when risky \(auto\)$/);
  assert.match(renderCard({ title: 'n', cwd: 'F:/n', mode: 'default' }, {}), /⚙️ Mode: ask before every action \(ask\)$/);
});

test('chunks split long text under the Telegram limit', () => {
  const parts = chunks('a\n'.repeat(5000));
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 3900));
  assert.equal(parts.join('\n').replace(/\n+/g, '').length, 5000);
});
test('inside rejects escapes and prefix look-alikes', () => {
  assert.ok(inside('F:/workspace/a', 'F:/workspace/a/b.png'));
  assert.ok(!inside('F:/workspace/a', 'F:/workspace/a2/b.png'));
  assert.ok(!inside('F:/workspace/a', 'F:/workspace/a/../b'));
  assert.ok(!inside('F:/workspace/a', 'C:/Windows'));
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
  const W = 'F:\\workspace\\MyApp', M = '/Users/h/workspace/MyApp';
  const src = JSON.stringify({ cwd: W, file: W + '\\src\\a.ts', x: 'f:/workspace/MyApp/b.md', other: 'F:\\workspace\\Other\\c' });
  const out = JSON.parse(rewriteProjectPath(src, W, M)); // must still be valid JSON
  assert.deepEqual(out, { cwd: M, file: M + '/src/a.ts', x: M + '/b.md', other: 'F:\\workspace\\Other\\c' });
  const back = JSON.parse(rewriteProjectPath(JSON.stringify({ cwd: M, file: M + '/src/a.ts' }), M, W)); // Mac → Windows
  assert.deepEqual(back, { cwd: W, file: W + '\\src\\a.ts' });
});

import { parseAlias, routeMachine, mergeHeartbeat } from './hub.mjs';
test('上朝 addressing: nicknames, keywords, default', () => {
  const aliases = { a: { machine: 'Windows', group: 1 }, mac: { machine: 'Mac', group: 4 } };
  const route = { Mac: '(^|[^a-z])mac([^a-z]|$)|麦克|苹果' };
  assert.deepEqual(parseAlias('@a 帮我查一下', aliases), { machine: 'Windows', group: 1, alias: 'a', rest: '帮我查一下' });
  assert.equal(parseAlias('mac：新建项目', aliases).rest, '新建项目');
  assert.equal(parseAlias('帮我查一下', aliases), null);
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

import { parseRelay, touchesSecrets } from './hub.mjs';
test('relay pins: tasks with reply address, and results', () => {
  assert.deepEqual(parseRelay('📨 → Mac @mac：跑测试\n第二行\n（来自 「hub-test」（Claude_A_Win））\n↩ Windows -100123:11', 'Mac'),
    { kind: 'task', alias: 'mac', task: '跑测试\n第二行', from: '「hub-test」（Claude_A_Win）', replyTo: { machine: 'Windows', key: '-100123:11' } });
  assert.deepEqual(parseRelay('📨 → Mac @mac：x\n（来自 上朝·Windows）', 'Mac'), { kind: 'task', alias: 'mac', task: 'x', from: '上朝·Windows', replyTo: undefined });
  assert.deepEqual(parseRelay('📬 → Windows -100:11\n「a」的结果：ok', 'Windows'), { kind: 'result', key: '-100:11', body: '「a」的结果：ok' });
  assert.equal(parseRelay('📨 → Windows @mine：x', 'Mac'), null);
  assert.equal(parseRelay(undefined, 'Mac'), null);
});
test('secret guard blocks the hub tokens, not ordinary work', () => {
  for (const s of [JSON.stringify({ file_path: 'C:\\Users\\u\\.agent-hub\\.env' }), JSON.stringify({ command: 'cd ~/.agent-hub && cat .env' }), JSON.stringify({ command: 'echo $C1_OAUTH_TOKEN' }), JSON.stringify({ file_path: '/Users/u/.codex/auth.json' })])
    assert.ok(touchesSecrets(s), s);
  for (const s of [JSON.stringify({ file_path: 'F:\\workspace\\app\\.env.example' }), JSON.stringify({ command: 'npm test' }), JSON.stringify({ file_path: 'F:/workspace/hub-demo/README.md' })])
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
