// Agent Hub: Telegram forum groups <-> local Claude Code (Agent SDK) and Codex (app-server) sessions.
// One bot per machine, one group per agent account (config.json "groups"), one topic per project session,
// 「圣旨」(General) = dispatcher agent. Same file runs on Windows and macOS.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { query, listSessions, getSessionMessages, renameSession, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const HOME = path.dirname(fileURLToPath(import.meta.url));
// A fresh checkout has no .env / config.json yet: the module still loads (unit tests) with the example config;
// actually starting the hub without them stops with a hint (see startup).
const ENV_FILE = path.join(HOME, '.env'), CFG_FILE = path.join(HOME, 'config.json');
const ENV = Object.fromEntries((fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '').replace(/^\uFEFF/, '').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const CFG = JSON.parse(fs.readFileSync(fs.existsSync(CFG_FILE) ? CFG_FILE : path.join(HOME, 'examples', 'config.windows.json'), 'utf8'));
const OWNER = Number(ENV.OWNER_ID);
const STATE_FILE = path.join(HOME, 'state.json');
const INBOX = path.join(HOME, 'inbox');
const STALE_SEC = 15 * 60;
const MAX_UP = 50 * 1024 * 1024, MAX_DOWN = 20 * 1024 * 1024;

// ---------- small utils ----------
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
const secrets = [ENV.TELEGRAM_BOT_TOKEN, ENV.C1_OAUTH_TOKEN, ENV.C2_OAUTH_TOKEN].filter(Boolean);
function log(...a) {
  let line = `${new Date().toISOString()} ${a.map(x => typeof x === 'string' ? x : (x?.stack || JSON.stringify(x))).join(' ')}`;
  for (const s of secrets) line = line.split(s).join('<secret>');
  console.log(line);
  fs.appendFileSync(path.join(HOME, 'logs', `hub-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = p => path.resolve(p).toLowerCase();
export const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
export function chunks(text, n = 3900) {
  const out = [];
  while (text.length > n) { let i = text.lastIndexOf('\n', n); if (i < n / 2) i = n; out.push(text.slice(0, i)); text = text.slice(i).replace(/^\n/, ''); }
  if (text) out.push(text);
  return out;
}

let state = { topics: {}, pendingMsgs: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
catch (e) { if (fs.existsSync(STATE_FILE)) { fs.renameSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`); log('state.json corrupt, starting empty'); } }
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  for (let i = 0; ; i++) { try { fs.renameSync(tmp, STATE_FILE); return; } catch (e) { if (i >= 3) throw e; } }
}

// single instance: one getUpdates consumer per token
const IS_MAIN = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const PID = path.join(HOME, 'hub.pid');
if (IS_MAIN && !(ENV.TELEGRAM_BOT_TOKEN && ENV.OWNER_ID && fs.existsSync(CFG_FILE))) {
  console.error('Missing setup: copy .env.example to .env (TELEGRAM_BOT_TOKEN, OWNER_ID) and examples/config.*.json to config.json. See README.');
  process.exit(1);
}
if (IS_MAIN) {
  // A pid file from before the last boot is stale even if that pid now belongs to some other process.
  try { const old = Number(fs.readFileSync(PID, 'utf8')); if (old && old !== process.pid && fs.statSync(PID).mtimeMs > Date.now() - os.uptime() * 1000) { process.kill(old, 0); console.error(`hub already running (pid ${old})`); process.exit(1); } } catch {}
  fs.writeFileSync(PID, String(process.pid));
}
const execFileP = promisify(execFile);
// After a self-update: if the new version dies 3 times before staying up 2 minutes, put back ./prev (saved by the updater).
if (IS_MAIN && state.verifyUpdate) {
  state.updateBoots = (state.updateBoots || 0) + 1; save();
  if (state.updateBoots > 3 && fs.existsSync(path.join(HOME, 'prev', 'hub.mjs'))) {
    for (const f of ['hub.mjs', 'package.json', 'package-lock.json', 'config.json']) fs.copyFileSync(path.join(HOME, 'prev', f), path.join(HOME, f));
    try { childProcess.execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: HOME, stdio: 'ignore', timeout: 600000, shell: process.platform === 'win32' }); } catch {}
    Object.assign(state, { verifyUpdate: false, updateBoots: 0, rolledBack: true }); save(); process.exit(1);
  }
}

export const bot = new Bot(ENV.TELEGRAM_BOT_TOKEN || '0:unset') // placeholder only when imported by tests;
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
// Watchdog input: time of the last successful getUpdates (long poll returns at least every ~30 s).
let lastPollOk = Date.now();
bot.api.config.use(async (prev, method, payload, signal) => { const r = await prev(method, payload, signal); if (method === 'getUpdates' && r.ok) lastPollOk = Date.now(); return r; });
const key = (chatId, threadId) => `${chatId}:${threadId}`;
const topicLink = (chatId, threadId) => `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${threadId}`;
// Telegram never tells bots a topic was deleted; we only learn it when a send into it fails.
export const isTopicGone = e => /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e?.description || e?.message || '');
function topicGone(chatId, threadId, deleted = true) {
  const k = key(chatId, threadId), t = state.topics[k];
  if (!t) return;
  t.closed = true; if (deleted) t.deleted = true; t.busy = false; save();
  const s = live.get(k); if (s) { try { s.q.close(); } catch {} live.delete(k); }
  log(`topic ${deleted ? 'deleted' : 'closed'}: ${t.title}`);
}
async function send(chatId, threadId, text, extra = {}) {
  let last;
  for (const c of chunks(text)) last = await bot.api.sendMessage(chatId, c, { message_thread_id: threadId, ...extra }).catch(e => {
    log('send failed', e.description || e.message);
    if (threadId && isTopicGone(e)) topicGone(chatId, threadId);
  });
  return last;
}

// ---------- buttons: generic "wait for one tap" ----------
export const waits = new Map(); // id -> { resolve, chatId, threadId, msgId, options, html, plain, choice } (exported for the e2e harness)
// extra.onId(id) runs once the wait exists; extra.choice marks an agent's ask_choice (a newer user message cancels it).
async function askButtons(chatId, threadId, html, options, vertical = false, extra = {}) {
  const id = crypto.randomBytes(6).toString('base64url');
  const btns = options.map(([label], i) => ({ text: label.slice(0, 60), callback_data: `b:${id}:${i}` }));
  const o = { message_thread_id: threadId, reply_markup: { inline_keyboard: vertical ? btns.map(b => [b]) : [btns] } };
  let plain = false; // too long or unparsable HTML: fall back to plain text instead of losing the card
  const msg = await (html.length <= 4000 ? bot.api.sendMessage(chatId, html, { ...o, parse_mode: 'HTML' }) : Promise.reject(new Error('too long')))
    .catch(() => { plain = true; return bot.api.sendMessage(chatId, (html = unhtml(html).slice(0, 3900)), o); });
  state.pendingMsgs.push([chatId, msg.message_id]); save();
  const value = await new Promise(resolve => { waits.set(id, { resolve, chatId, threadId, msgId: msg.message_id, options, html, plain, choice: !!extra.choice }); extra.onId?.(id); });
  return value;
}
// Confirms an incoming update / move bundle: asks the owner in DM (or in this machine's first group if the bot can't
// DM them). Safe default; config confirmBundles=false accepts bundles from the trusted peer bot automatically.
const askOwner = (html, options) => CFG.confirmBundles === false ? Promise.resolve(options[0][1]) : askButtons(OWNER, undefined, html, options)
  .catch(() => askButtons(Number(Object.entries(CFG.groups).find(([, g]) => g.owner !== 'mac-hub')[0]), undefined, html, options));
const unhtml = h => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export function finishWait(id, i, note) {
  const w = waits.get(id); if (!w) return false;
  waits.delete(id);
  state.pendingMsgs = state.pendingMsgs.filter(([c, m]) => !(c === w.chatId && m === w.msgId)); save();
  const n = note ?? w.options[i][0];
  bot.api.editMessageText(w.chatId, w.msgId, `${w.html}\n\n${w.plain ? n : esc(n)}`, w.plain ? {} : { parse_mode: 'HTML' })
    .catch(() => bot.api.editMessageReplyMarkup(w.chatId, w.msgId, { reply_markup: { inline_keyboard: [] } }).catch(() => {}));
  w.resolve(i < 0 ? null : w.options[i][1]);
  return true;
}
bot.on('callback_query:data', async ctx => {
  const [, id, i] = ctx.callbackQuery.data.split(':');
  if (ctx.from.id !== OWNER) return ctx.answerCallbackQuery();
  const w = waits.get(id);
  if (!w || w.chatId !== ctx.callbackQuery.message?.chat.id || w.msgId !== ctx.callbackQuery.message?.message_id) {
    await ctx.answerCallbackQuery({ text: '已过期' });
    return ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  const t = new Date().toLocaleTimeString('zh-CN', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' });
  finishWait(id, Number(i), `${w.options[Number(i)][0]}（${t}）`);
  await ctx.answerCallbackQuery();
});

// ---------- permission cards ----------
// Cuts raw text (before escaping, so HTML tags stay intact) and always says so: never approve a hidden tail.
export const clip = (s, n = 2500) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}\n…（截断，共 ${s.length} 字，完整内容请在电脑上看）` : s; };
export function renderTool(name, input) {
  const cut = (s, n = 40) => { const l = String(s ?? '').split('\n'); return clip(l.slice(0, n).join('\n') + (l.length > n ? `\n…（还有 ${l.length - n} 行）` : '')); };
  const diff = (a, b) => cut([...String(a ?? '').split('\n').map(l => '➖ ' + l), ...String(b ?? '').split('\n').map(l => '➕ ' + l)].join('\n'));
  if (name === 'Bash' || name === 'PowerShell') return `<pre>${esc(cut(input.command, 30))}</pre>${input.description ? '\n' + esc(input.description) : ''}`;
  if (name === 'Edit') return `${esc(input.file_path)}\n<pre>${esc(diff(input.old_string, input.new_string))}</pre>`;
  if (name === 'MultiEdit') return `${esc(input.file_path)}\n<pre>${esc(cut((input.edits || []).map(e => diff(e.old_string, e.new_string)).join('\n…\n')))}</pre>`;
  // ponytail: Write shows the new content, not a diff against the old file; add a line diff if overwrites get confusing.
  if (name === 'Write') return `${esc(input.file_path)}${fs.existsSync(input.file_path) ? '（覆盖已有文件）' : '（新建）'}\n<pre>${esc(cut(input.content))}</pre>`;
  if (name === 'mcp__tg__send_file') return `发送到手机：\n<pre>${esc((input.paths || []).join('\n'))}</pre>`;
  return `<pre>${esc(clip(JSON.stringify(input, null, 1), 1500))}</pre>`;
}

async function askPermission(k, toolName, input, { signal, suggestions }) {
  const t = state.topics[k];
  if (toolName === 'AskUserQuestion') {
    return { behavior: 'deny', message: '用户在手机 Telegram 上，暂不支持选项卡片。请把问题和选项用纯文本写在回复里，然后结束这一轮等用户回复。' };
  }
  const s = live.get(k);
  if (s) { s.waiting++; progressSoon(k); }
  refreshSoon();
  bot.api.sendMessage(OWNER, `🔐 ${t.title} · ${CFG.agents[t.agent].label} 等你批准 ${toolName}\n${topicLink(t.chatId, t.threadId)}`).catch(() => {});
  // "Allow for this session" = the CLI's own rule suggestions, kept in memory only; never a mode switch.
  const rules = (suggestions || []).filter(x => x.type === 'addRules' || x.type === 'addDirectories').map(x => ({ ...x, destination: 'session' }));
  let wid;
  const p = askButtons(t.chatId, t.threadId, `🔐 <b>${esc(toolName)}</b> · ${esc(t.title)}\n${renderTool(toolName, input)}`,
    [['✅ 允许一次', 'allow'], ...(rules.length ? [['🔁 本会话都允许', 'always']] : []), ['❌ 拒绝', 'deny']], false, { onId: id => { wid = id; } });
  signal?.addEventListener('abort', () => wid && finishWait(wid, -1, '⏹ 已取消'), { once: true });
  let v;
  try { v = await p; } finally { if (s) s.waiting--; }
  if (v === 'always') return { behavior: 'allow', updatedInput: input, updatedPermissions: rules };
  return v === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户在 Telegram 上拒绝了这个操作。', interrupt: v === null };
}

// ---------- send_file tool (agent -> phone) ----------
const PHOTO = /\.(jpe?g|png|gif|webp)$/i, VIDEO = /\.(mp4|mov|webm)$/i;
// ponytail: name-based speed bump, not a guarantee (the agent can read any file anyway).
const SECRET_NAME = /(^\.)|(\.env)|(\.pem$)|(\.key$)|(\.p12$)|(\.pfx$)|(^id_)|(credential)|(secret)|(token)/i;
async function sendFileTo(t, p, caption, asDocument) {
  const real = fs.realpathSync(path.resolve(t.cwd, p)), root = fs.realpathSync(t.cwd);
  if (!inside(root, real)) throw new Error(`${p} 不在项目目录内`);
  if (path.relative(root, real).split(path.sep).some(seg => SECRET_NAME.test(seg))) throw new Error(`${p} 看起来是密钥/隐藏文件，拒绝发送`);
  const size = fs.statSync(real).size;
  if (size > MAX_UP) throw new Error(`${p} 超过 50MB，请在电脑上查看：${real}`);
  const f = new InputFile(real), o = { message_thread_id: t.threadId, caption: caption?.slice(0, 1000) };
  if (!asDocument && PHOTO.test(real) && size <= 10 * 1024 * 1024) return bot.api.sendPhoto(t.chatId, f, o).catch(() => bot.api.sendDocument(t.chatId, new InputFile(real), o)); // e.g. PHOTO_INVALID_DIMENSIONS
  if (!asDocument && VIDEO.test(real)) return bot.api.sendVideo(t.chatId, f, o);
  return bot.api.sendDocument(t.chatId, f, o);
}
const tgServer = k => createSdkMcpServer({
  name: 'tg', version: '1.0.0',
  tools: [tool('send_file', '把电脑上的文件、截图、视频发到用户手机上的 Telegram 话题。用户只能通过这个工具看到文件。路径相对项目目录或绝对路径（必须在项目目录内）。',
    { paths: z.array(z.string()).min(1).max(10), caption: z.string().optional(), asDocument: z.boolean().optional() },
    async ({ paths, caption, asDocument }) => {
      const t = state.topics[k], res = [];
      for (const p of paths) { try { await sendFileTo(t, p, caption, asDocument); res.push(`sent ${p}`); } catch (e) { res.push(`failed ${p}: ${e.message}`); } }
      return { content: [{ type: 'text', text: res.join('\n') }] };
    }, { alwaysLoad: true }), ...collabTools(k)],
});

// ---------- sessions ----------
const PHONE_PROMPT = [
  '你正在通过 Telegram 和用户对话，用户在手机上。',
  '1. 想让用户看到的截图、图片、视频、文件，必须调用 mcp__tg__send_file 工具发送，否则用户看不到。',
  '2. 回复简洁，少用宽表格。',
  '3. 需要用户做选择时，用纯文本列出选项，然后结束这一轮等用户回复。',
  '',
  '【协作规则】用户的每个项目话题都是一个独立的 agent 会话，你可以用 mcp__tg__list_topics 查看，用 mcp__tg__handoff 把工作交给它们。',
  '- 任务属于当前项目：自己直接做，不要交出去。',
  '- 用户明确说「交给 / 让 XX 项目去做」，或任务明显属于另一个已有项目（要改那个项目的代码或文档）：用 handoff 交过去，note 写清目标、已知结论、关键文件路径、希望对方完成什么；交完告诉用户交给了谁。',
  '- 收到「任务交接（由 agent 发起）」：直接开始处理；做完后用纯文本总结结果。只有当发起方明确要求回传时，才 handoff 回去。',
  '- 不确定该不该交接时，先问用户。不要为了省事把任务来回转交。',
  '- 要找另一个账号 / 工具 / 另一台电脑上的 agent 帮忙（用户说「让 @codex 看看」这类），用 mcp__tg__send_to_agent，agent 填称呼（@mine、@id、@codex、@mac）。',
].join('\n');
// General of each group runs a dispatcher session: understands plain requests and routes them.
const DISPATCH_PROMPT = g => [
  `你是 Telegram 群「${g.title}」的调度员，运行在群的「圣旨」频道（General 话题）里。用户在手机上用自然语言给你下指令。`,
  `默认项目根目录：${CFG.defaultRoots.join('、')}。找项目目录先看根目录下一层（Glob pattern「*」），不要用「**」全盘搜，会超时。`,
  '- 用户想继续 / 查看某个项目：先用 mcp__tg__list_topics 看是否已经有话题；有就把链接给用户。没有就在磁盘上找到目录（可用 Glob / Bash 在根目录下查找），用 mcp__tg__open_project 打开（自动接上上次的对话），把话题链接告诉用户。',
  '- 新项目：mcp__tg__open_project fresh=true，目录放在默认根目录下，名字按用户说的（没说就起一个简短的英文名）。如果用户同时交代了要做的事，打开后用 mcp__tg__handoff 把任务交给新话题。',
  '- 给已有项目布置任务：用 mcp__tg__handoff 交给那个话题（topic 填 list_topics / open_project 给的 key），note 写清用户的要求，然后告诉用户去哪个话题看。',
  '- 「上朝」派来的任务（消息开头会写明）：同样处理——判断属于哪个项目，已有话题就 handoff；没有就找到目录 open_project 再 handoff；需要新项目就 fresh=true 再 handoff。结果会自动回报到上朝，你最后回一句交给了哪个话题即可。',
  '- 凡是涉及某个项目内容的事（哪怕只是读一个文件、数行数），都交给那个项目的话题去做，你自己不读项目文件，这样每件事都留在对应话题里。',
  `- 不属于已有项目的新任务（调研、杂事、查电脑信息也算）：给任务起一个简短的英文文件夹名（小写、用连字符，例如 search、sole-proprietor-research），open_project(path=这个名字, fresh=true) 在 ${CFG.defaultRoots[0]} 下新建子文件夹和话题，再 handoff 过去。绝不直接用根目录开话题。不要停下来等，也不要说做不了。`,
  '- open_project 提示「桌面 App 里开着」：问用户是先在桌面关掉，还是复制一份（ifOpen=fork）。',
  '- 只有关于这个群 / 话题本身的问题（有哪些项目、进度）才直接回答。回复要短。',
].join('\n');
// 上朝 (command group, shared by both machines' bots): the hub whose machine the message names takes it
// (routing keywords in config "commandRoute"; nothing named → "commandDefault"). The task goes to the chosen agent
// group's 圣旨, which opens or creates the project topic; results are reported back to 上朝.
// Addressing in 上朝: a nickname at the start ("@a …", "b：…") picks machine + agent group deterministically
// (config "commandAliases": { a: { machine, group } }); otherwise keyword routing, then the default machine.
export function parseAlias(text, aliases = CFG.commandAliases || {}) {
  const m = /^\s*@?([\p{L}\p{N}_-]+)\s*[:：,，]?\s*/u.exec(text || '');
  const a = m && aliases[m[1].toLowerCase()];
  return a ? { ...a, alias: m[1].toLowerCase(), rest: text.slice(m[0].length) } : null;
}
export function routeMachine(text, route = CFG.commandRoute || {}, fallback = CFG.commandDefault, aliases = CFG.commandAliases || {}) {
  const a = parseAlias(text, aliases);
  if (a) return a.machine;
  for (const [machine, re] of Object.entries(route)) if (new RegExp(re, 'i').test(text || '')) return machine;
  return fallback;
}
const aliasList = () => Object.entries(CFG.commandAliases || {}).map(([n, a]) => `@${n} = ${a.machine} 上的「${CFG.groups[String(a.group)]?.title || '（另一台电脑的群）'}」`).join('；');
// The 上朝 dispatcher only picks WHO (which agent group); that group's own 圣旨 picks or creates the project topic.
// Messages that name an agent never reach it: the hub routes them straight to that group's 圣旨 (assignToGroup).
const COMMAND_PROMPT = () => [
  `你是「${CFG.machine}」这台电脑在 Telegram 指挥群「上朝」里的总调度：用户没点名的任务由你决定交给哪个号。`,
  '你只决定「交给谁」，不决定具体项目、不开话题、不亲自做事：你没有读写文件、运行命令的工具，也不要凭记忆回答项目内容。接到任务的号会在自己群的「圣旨」里选好或新建项目话题去做，结果自动回报到上朝。',
  `所有号的称呼：${aliasList()}。`,
  `这台电脑上的号：${ownGroups().map(([, g]) => `「${g.title}」= ${CFG.agents[g.agent]?.label}（${CFG.agents[g.agent]?.type}）`).join('；')}。`,
  '- 任务：先判断谁最合适（可以 list_topics 看哪个群已经有相关项目的话题），再用 mcp__tg__ask_choice 给用户 2-4 个选项确认，比如「交给 @mine」「交给 @codex」「交给 @mac」「取消」。用户选了就 mcp__tg__send_to_agent(agent=称呼, task=用户原话 + 你知道的背景，比如可能是哪个项目)，然后在这里回一句交给了谁。',
  '- 只有关于号 / 话题 / 电脑本身的问题（状态、进度、有哪些项目）才直接回答。凡是要读或改项目内容的（哪怕只是看看、评价、总结一个文件）都算任务。回复要短。',
].join('\n');
function commandKey(chatId) {
  const k = `${chatId}:cmd`;
  const agent = Object.keys(CFG.agents).find(a => CFG.agents[a].type === 'claude');
  if (!state.topics[k]) { state.topics[k] = { chatId: Number(chatId), threadId: undefined, agent, cwd: rootsAbsFirst(), sessionId: null, title: '上朝', isDispatcher: true, isCommand: true, busy: false }; save(); }
  return k;
}
const rootsAbsFirst = () => path.resolve(CFG.defaultRoots[0].replace(/^~(?=$|[\\/])/, os.homedir()));

function dispatcherKey(chatId, g) {
  const k = `${chatId}:general`;
  if (!state.topics[k]) { state.topics[k] = { chatId: Number(chatId), threadId: undefined, agent: g.agent, cwd: path.resolve(CFG.defaultRoots[0].replace(/^~(?=$|[\\/])/, os.homedir())), sessionId: null, title: '圣旨', isDispatcher: true, busy: false, ...(CFG.agents[g.agent]?.type === 'claude' ? {} : { account: claudeAccounts()[0] }) }; save(); }
  return k;
}

export const live = new Map(); // key -> { q, push, busy, waiting, queue, buf, typing }

function agentEnv(agent) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION|OAUTH)|TELEGRAM_|ANTHROPIC_API_KEY)/.test(k)));
  const tok = ENV[CFG.agents[agent].tokenEnv];
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  return env;
}

function channel() {
  const items = []; let wake = null;
  return {
    push(m) { items.push(m); wake?.(); },
    async *iter() { for (;;) { while (items.length) yield items.shift(); await new Promise(r => (wake = r)); wake = null; } },
  };
}

// ---------- per-topic pinned session card (mirrors the desktop right panel) ----------
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Record a file only once its tool_result comes back without error (not when the edit is merely proposed).
export function noteOutputs(t, msg, pend) {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (msg.type === 'assistant' && b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
      const f = b.input?.file_path || b.input?.notebook_path;
      if (f) pend.set(b.id, f);
    }
    if (msg.type === 'user' && b.type === 'tool_result' && pend.has(b.tool_use_id)) {
      const f = pend.get(b.tool_use_id); pend.delete(b.tool_use_id);
      if (!b.is_error) t.outputs = [f, ...(t.outputs || []).filter(x => x !== f)].slice(0, 30);
    }
  }
}
// Permission modes switchable from Telegram: only "ask" (every action needs a tap) and "auto" (classifier, ask when risky).
export const MODES = { default: 'ask before every action', auto: 'auto-approve, ask only when risky' };
const modeOf = t => t?.mode || state.groupModes?.[t?.chatId] || 'auto';
const modeLine = m => `⚙️ Mode: ${MODES[m]} (${m === 'default' ? 'ask' : m})`;

// Models: per topic (/model in a topic), per group (/model in 圣旨), dispatcher defaults to Sonnet (routing only).
export const MODELS = [['Fable 5.1', 'fable'], ['Opus 5.5', 'opus'], ['Sonnet 5.5', 'sonnet'], ['Haiku 5.5', 'haiku'], ['账号默认', 'default']];
const modelOf = t => (t?.model && t.model !== 'default' ? t.model : null)
  || (t?.isDispatcher ? CFG.dispatcherModel || 'sonnet' : state.groupModels?.[t?.chatId]) || undefined;
const modelLabel = m => !m || m === 'default' ? 'account default' : (MODELS.find(([, v]) => v === m)?.[0] || m);
export const modelLine = (picked, actual) => `🤖 Model: ${modelLabel(picked)}${actual && picked && !String(actual).includes(picked) ? ` (${actual})` : !picked && actual ? ` (${actual})` : ''}`;

export function renderCard(t, info) {
  const rel = f => { const r = path.relative(t.cwd, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : path.basename(f); };
  const outs = t.outputs || [];
  const conn = info.mcp || [];
  const ok = conn.filter(m => m.status === 'connected').length, bad = conn.filter(m => ['failed', 'needs-auth'].includes(m.status)).length;
  return [
    `📁 ${t.title} · ${t.cwd}`,
    info.ctx != null ? `🧠 Context ${bar(info.ctx)} ${Math.round(info.ctx)}%` : '🧠 Context: –',
    `🔌 Connectors: ${conn.length ? `${ok} connected${bad ? ` · ${bad} need reconnect` : ''}` : '–'}`,
    `📄 Outputs: ${outs.length ? outs.slice(0, 5).map(rel).join(', ') + (outs.length > 5 ? ` (+${outs.length - 5})` : '') : 'none'}`,
    `⏳ Background tasks: ${info.bg ? `${info.bg} running` : 'none'}`,
    accountOf(t) && `👤 Account: ${CFG.agents[accountOf(t)]?.label || accountOf(t)}${t.account && t.account !== t.agent ? ' (switched)' : ''}`,
    modelLine(modelOf(t), t.modelActual),
    modeLine(modeOf(t)),
  ].filter(Boolean).join('\n');
}
async function refreshCard(k) {
  const t = state.topics[k], s = live.get(k);
  if (!t || t.isDispatcher) return;
  const info = { bg: s?.bg || 0 };
  if (s) {
    info.mcp = await s.q.mcpServerStatus().then(l => l.filter(m => m.name !== 'tg'), () => null);
    info.ctx = await s.q.getContextUsage({ detail: 'summary' }).then(c => c?.percentage ?? null, () => null);
  }
  info.mcp ??= t.lastMcp; info.ctx ??= t.lastCtx;
  t.lastMcp = info.mcp; t.lastCtx = info.ctx;
  const text = renderCard(t, info);
  if (text === t.cardText) return;
  if (t.cardMsgId) {
    const ok = await bot.api.editMessageText(t.chatId, t.cardMsgId, text).then(() => true, e => /not modified/.test(e.description || ''));
    if (ok) { t.cardText = text; save(); return; }
  }
  const m = await bot.api.sendMessage(t.chatId, text, { message_thread_id: t.threadId, disable_notification: true }).catch(() => null);
  if (!m) return;
  // Not silent: Telegram Desktop doesn't refresh a topic's pinned bar for silent pins. Happens once per topic.
  await bot.api.pinChatMessage(t.chatId, m.message_id, { disable_notification: false }).catch(e => log('card pin failed', e.description || e.message));
  t.cardMsgId = m.message_id; t.cardText = text; save();
}
const cardTimers = new Map();
const refreshCardSoon = (k, ms = 3000) => { clearTimeout(cardTimers.get(k)); cardTimers.set(k, setTimeout(() => refreshCard(k).catch(e => log('card failed', e)), ms)); };

// Agents run as the same OS user, so they could read the hub's tokens. This blocks the obvious ways (any tool whose
// input names the hub's .env, a login store or a token variable). ponytail: a speed bump, not a sandbox — the real
// guarantees are the owner taps on update/move bundles; full isolation needs the hub under a separate OS user.
// Also covers whatever this config actually names: each account's token variable and its usage login folder.
const SECRET_TERMS = Object.values(CFG.agents || {}).flatMap(a => [a.tokenEnv, a.usageConfigDir && path.basename(a.usageConfigDir)]).filter(Boolean).map(x => x.toLowerCase());
export const touchesSecrets = (s, terms = SECRET_TERMS) => /agent-hub[\\/]+\.env|agent-hub\b[\s\S]*\.env\b|\.claude-usage|\.credentials\.json|\.codex[\\/]+auth\.json|OAUTH_TOKEN|TELEGRAM_BOT_TOKEN|HUB_HOOK_TOKEN/i.test(s)
  || terms.some(x => s.toLowerCase().includes(x));
const secretGuard = async input => touchesSecrets(JSON.stringify(input.tool_input || {}))
  ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Hub 的密钥和登录文件不允许读取或修改。' } }
  : {};
function startSession(k) {
  const t = state.topics[k];
  if (CFG.agents[t.agent]?.type === 'codex' && !t.isDispatcher) return startCodexSession(k);
  const ch = channel();
  const s = { push: ch.push, busy: false, waiting: 0, queue: [], buf: '', typing: null, pendEdits: new Map(), account: accountOf(t) };
  const append = t.isCommand ? `${PHONE_PROMPT}\n\n${COMMAND_PROMPT()}` : t.isDispatcher ? `${PHONE_PROMPT}\n\n${DISPATCH_PROMPT(CFG.groups[String(t.chatId)])}` : PHONE_PROMPT;
  // Dispatchers start a fresh conversation when their rules change: old history ("last time I did it myself") outweighs new rules.
  // Dispatchers keep their transcripts under the hub dir (never openable as a project), so a project topic opened on the
  // workspace root never resumes a dispatcher's conversation.
  const cwd = t.isDispatcher ? path.join(HOME, 'dispatch') : t.cwd;
  if (t.isDispatcher) fs.mkdirSync(cwd, { recursive: true });
  const ph = crypto.createHash('sha1').update(append + cwd).digest('hex').slice(0, 10);
  if (t.isDispatcher && t.promptHash !== ph) { t.sessionId = null; t.promptHash = ph; save(); }
  s.q = query({
    prompt: ch.iter(),
    options: {
      // /fork: first start copies the source session's full history into a new session id
      cwd, resume: t.sessionId || t.forkFrom || undefined, forkSession: !t.sessionId && !!t.forkFrom, permissionMode: modeOf(t), model: modelOf(t),
      ...(t.isDispatcher ? { effort: CFG.dispatcherEffort || 'low' } : {}), // routing only: Sonnet + low effort, never Opus
      // Dispatchers only route: without file/shell tools they can't "just do it" (and skip confirmation / the project topic).
      // 圣旨 keeps Glob (find project folders) + open_project/handoff; 上朝 only picks the agent (send_to_agent).
      ...(t.isDispatcher ? { disallowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent',
        ...(t.isCommand ? ['Glob', 'mcp__tg__open_project', 'mcp__tg__handoff'] : [])] } : {}),
      env: agentEnv(accountOf(t)),
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      mcpServers: { tg: tgServer(k) },
      hooks: { PreToolUse: [{ hooks: [secretGuard] }] }, // runs in every permission mode, auto included
      canUseTool: (name, input, opts) => askPermission(k, name, input, opts),
    },
  });
  live.set(k, s);
  (async () => {
    try {
      for await (const m of s.q) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (t.sessionId !== m.session_id) {
            const fresh = !t.sessionId;
            t.sessionId = m.session_id; delete t.forkFrom; save();
            if (fresh) renameSession(m.session_id, `tg:${t.title}`).catch(() => {});
          }
          if (m.model && t.modelActual !== m.model) { t.modelActual = m.model; save(); }
          refreshCardSoon(k);
        }
        if (m.type === 'system' && m.subtype === 'background_tasks_changed') { s.bg = (m.tasks || []).length; refreshCardSoon(k); }
        if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') s.limited = m.rate_limit_info; // handled when the turn ends
        if (m.type === 'assistant' || m.type === 'user') noteOutputs(t, m, s.pendEdits);
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') { s.steps = (s.steps || 0) + 1; s.lastTool = toolSummary(b); progressSoon(k); }
        if (m.type === 'assistant' && !m.parent_tool_use_id) for (const b of m.message.content) {
          if (b.type === 'text') s.buf += (s.buf ? '\n\n' : '') + b.text;
          if (b.type === 'image' && b.source?.type === 'base64') bot.api.sendPhoto(t.chatId, new InputFile(Buffer.from(b.source.data, 'base64'), 'image.png'), { message_thread_id: t.threadId }).catch(() => {});
        }
        if (m.type === 'result') endTurn(k, m.is_error ? `⚠️ ${m.subtype}${m.result ? ': ' + m.result : ''}` : '');
      }
    } catch (e) {
      log('session error', k, e);
      await send(t.chatId, t.threadId, `⚠️ 会话出错：${e.message}\n再发一条消息会自动重新接上。`);
    } finally {
      clearInterval(s.typing); clearInterval(s.progTick); clearTimeout(s.progTimer);
      if (live.get(k) === s) { live.delete(k); t.busy = false; save(); } // a newer session for this topic may already be live
    }
  })();
  return s;
}

// ---------- live progress: one message per long turn, edited in place, deleted when the turn ends ----------
export function toolSummary(b) {
  const i = b.input || {}, short = (x, n = 50) => String(x ?? '').replace(/\s+/g, ' ').slice(0, n);
  const arg = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  return `${b.name.replace(/^mcp__\w+__/, '')}${arg ? `: ${short(arg)}` : ''}`;
}
export const fmtElapsed = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
function progressSoon(k) {
  const s = live.get(k);
  if (!s?.busy || s.progTimer) return;
  const wait = s.progMsg ? 4000 : Math.max(0, 8000 - (Date.now() - s.turnStart)); // first appears after 8 s, then ≤1 edit / 4 s
  s.progTimer = setTimeout(() => { s.progTimer = null; updateProgress(k).catch(() => {}); }, wait);
}
async function updateProgress(k) {
  const t = state.topics[k], s = live.get(k);
  if (!s?.busy) return;
  const text = `⏳ 进行中 ${fmtElapsed(Date.now() - s.turnStart)} · 第 ${s.steps || 0} 步${s.lastTool ? `\n🔧 ${s.lastTool}` : ''}${s.waiting ? '\n🟡 等你批准' : ''}`;
  if (text === s.progText) return;
  s.progText = text;
  if (s.progMsg) await bot.api.editMessageText(t.chatId, s.progMsg, text).catch(() => {});
  else { const m = await bot.api.sendMessage(t.chatId, text, { message_thread_id: t.threadId, disable_notification: true }).catch(() => null); if (m) { s.progMsg = m.message_id; clearInterval(s.typing); } } // the progress message shows it's alive; save the group's flood budget
}

// content.reportTo (set by deliverHandoff for 上朝 tasks) travels with the queued message, so only that task's turn reports back.
function startTurn(k, content) {
  const t = state.topics[k], s = live.get(k);
  s.busy = true; t.busy = true;
  if (content.reportTo || content.replyTo) t.turnMeta = { reportTo: content.reportTo, replyTo: content.replyTo }; else delete t.turnMeta; // survives a restart
  save();
  clearInterval(s.typing); clearInterval(s.progTick);
  Object.assign(s, { turnStart: Date.now(), steps: 0, lastTool: '', progMsg: null, progText: '', reportTo: content.reportTo, replyTo: content.replyTo });
  s.progTick = setInterval(() => progressSoon(k), 15000); // keeps the elapsed time moving during long single steps
  progressSoon(k);
  const typing = () => bot.api.sendChatAction(t.chatId, 'typing', { message_thread_id: t.threadId }).catch(() => {});
  typing(); s.typing = setInterval(typing, 4500);
  s.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: t.sessionId || '' });
}

async function endTurn(k, err) {
  const t = state.topics[k], s = live.get(k);
  if (!s) return;
  clearInterval(s.typing); clearInterval(s.progTick); clearTimeout(s.progTimer); s.progTimer = null;
  if (s.progMsg) { bot.api.deleteMessage(t.chatId, s.progMsg).catch(() => {}); s.progMsg = null; }
  const took = Date.now() - (s.turnStart || Date.now());
  const text = (s.buf.trim() || (err ? '' : '（本轮没有文字回复）')) + (err ? `\n\n${err}` : '') + (took > 60e3 ? `\n\n⏱ 用时 ${fmtElapsed(took)} · ${s.steps} 步` : '');
  s.lastBuf = s.buf.trim(); s.buf = ''; s.busy = false; t.busy = false; delete t.turnMeta; delete t.autoResumed; save();
  await send(t.chatId, t.threadId, text);
  refreshSoon(); refreshCardSoon(k, 500);
  if (s.reportTo) { // task came from 上朝: report this turn's result back there
    const to = s.reportTo; s.reportTo = null;
    const head = t.isDispatcher ? `📋 ${groupTitle(t.chatId)} 的圣旨` // acknowledgement: which topic got it (or a direct answer)
      : err ? `⚠️「${t.title}」（${groupTitle(t.chatId)}）没做完` : /[？?]\s*$/.test(s.lastBuf || '') ? `💬「${t.title}」（${groupTitle(t.chatId)}）在等你回复` : `✅「${t.title}」（${groupTitle(t.chatId)}）做完了`;
    send(to, undefined, `${head}：\n\n${text.length > 900 ? text.slice(0, 900) + '…' : text}\n\n${topicLink(t.chatId, t.threadId)}`);
  }
  // A 圣旨 that answered without handing off returns its own answer; otherwise the topic it handed to does.
  if (s.replyTo) { const r = s.replyTo; s.replyTo = null; returnResult(r, t, text).catch(e => log('returnResult failed', e)); }
  if (s.afterTurn) { const f = s.afterTurn; s.afterTurn = null; f(s.lastText = text).catch(e => log('afterTurn failed', e)); }
  if (s.limited) { const info = s.limited; s.limited = null; offerLimitChoice(k, info, s.queue.splice(0)).catch(e => log('limit choice failed', e)); return; }
  if (s.busy) return; // a new message already started the next turn while we were sending
  if (s.queue.length) startTurn(k, s.queue.shift());
  else if (s.account !== accountOf(t)) { try { s.q.close(); } catch {} live.delete(k); } // account switched mid-turn: next message resumes on the new account
}

// ---------- accounts: same session, different Claude account (transcripts are shared in ~/.claude) ----------
const accountOf = t => t?.account || t?.agent;
const claudeAccounts = () => Object.entries(CFG.agents).filter(([, a]) => a.type === 'claude' && a.tokenEnv).map(([id]) => id);
// Switches a topic's account; an idle session restarts on its next message, a busy one after its current turn.
function switchAccount(k, acct) {
  const t = state.topics[k];
  if (acct === t.agent) delete t.account; else t.account = acct;
  save();
  const s = live.get(k);
  if (s && !s.busy) { try { s.q.close(); } catch {} live.delete(k); }
  refreshCardSoon(k, 500);
}
// Starts a turn on topic k, or queues it behind the running one.
async function feed(k, content) {
  const t = state.topics[k];
  let s = live.get(k);
  if (!s) {
    if (t.sessionId && (await externalSessions()).some(r => r.sessionId === t.sessionId)) { await send(t.chatId, t.threadId, '⚠️ 这个会话正在桌面 App 里开着，没能自动继续。关掉桌面后发「继续」即可。'); return false; }
    s = live.get(k) || startSession(k);
  }
  if (s.busy || s.queue.length) s.queue.push(content); else startTurn(k, content);
  return true;
}
// The account hit its limit mid-turn: offer to switch accounts now, otherwise resume by itself when the limit resets.
// ponytail: messages queued behind the failed turn are kept in memory only (lost if the hub restarts before resuming).
const CONTINUE = [{ type: 'text', text: '刚才额度用完，这一轮被打断了。现在接着把没做完的任务做完。' }];
const heldAfterLimit = new Map();
async function offerLimitChoice(k, info, held) {
  const t = state.topics[k], acct = accountOf(t), other = claudeAccounts().find(a => a !== acct);
  const at = info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
  if (held.length) heldAfterLimit.set(k, held);
  if (at) { t.resumeAt = at; save(); }
  const v = await askButtons(t.chatId, t.threadId, `⛔ <b>${esc(CFG.agents[acct]?.label || acct)}</b> 的额度用完了，这一轮没做完。${at ? `\n不选的话 ${fmtWhen(at)} 重置后自动继续。` : ''}`,
    [...(other ? [[`切到 ${CFG.agents[other].label} 马上继续`, 'switch']] : []), ...(at ? [['⏰ 等重置后自动继续', 'wait']] : []), ['先不管', 'no']], true, { choice: true });
  if (v === 'switch') { delete t.resumeAt; save(); switchAccount(k, other); return resumeTopic(k); }
  if (v === 'no') { delete t.resumeAt; heldAfterLimit.delete(k); save(); }
}
async function resumeTopic(k) {
  const held = heldAfterLimit.get(k) || []; heldAfterLimit.delete(k);
  if (await feed(k, CONTINUE)) for (const c of held) await feed(k, c);
}
function resumeDueTopics() {
  for (const [k, t] of Object.entries(state.topics)) if (t.resumeAt && t.resumeAt <= Date.now() && !live.get(k)?.busy) {
    delete t.resumeAt; save();
    for (const [id, w] of waits) if (w.choice && w.chatId === t.chatId && w.threadId === t.threadId) finishWait(id, -1, '⏰ 额度已重置，自动继续');
    send(t.chatId, t.threadId, '⏰ 额度已重置，自动继续刚才的任务。').then(() => resumeTopic(k)).catch(e => log('resume failed', e));
  }
}
async function cmdAccount(k, arg) {
  const t = state.topics[k];
  if (CFG.agents[t.agent]?.type !== 'claude' && !t.isDispatcher) return send(t.chatId, t.threadId, 'Codex 只有一个账号，不能切换。');
  const accts = claudeAccounts();
  let acct = accts.find(a => a === arg || CFG.agents[a].label.toLowerCase().includes(arg.toLowerCase()) && arg);
  if (!acct) acct = await askButtons(t.chatId, t.threadId, `「${esc(t.title)}」现在用 <b>${esc(CFG.agents[accountOf(t)].label)}</b>。换成哪个账号继续？（同一段对话，记忆不变；换号后第一轮会重新读一遍历史）`,
    [...accts.map(a => [CFG.agents[a].label, a]), ['取消', '']], true);
  if (!acct) return;
  switchAccount(k, acct);
  return send(t.chatId, t.threadId, `👤 已切换到 ${CFG.agents[acct].label}${live.get(k)?.busy ? '（这一轮结束后生效）' : ''}，直接继续发消息即可。`);
}
// Usage alert: once per window per account, offer to move that account's sessions to the other account.
const alerting = new Set();
function checkUsageAlert(agent, u) {
  const r = u?.rate_limits, limit = CFG.usageAlert ?? 90;
  if (!r || u.stale) return;
  for (const [win, label] of [['five_hour', '5 小时'], ['seven_day', '本周']]) {
    const w = r[win];
    if (!w || (w.utilization ?? 0) < limit) continue;
    const id = `${agent}:${win}:${w.resets_at}`;
    state.alerted ??= [];
    if (state.alerted.includes(id) || alerting.has(id)) continue;
    state.alerted = [...state.alerted.slice(-50), id]; save();
    const other = claudeAccounts().find(a => a !== agent);
    const mine = Object.entries(state.topics).filter(([, t]) => !t.closed && accountOf(t) === agent);
    const msg = `⚠️ <b>${esc(CFG.agents[agent].label)}</b> ${label}用量已到 ${Math.round(w.utilization)}%${w.resets_at ? `（${fmtWhen(w.resets_at)} 重置）` : ''}。`;
    if (!other || !mine.length) { bot.api.sendMessage(OWNER, msg, { parse_mode: 'HTML' }).catch(() => {}); continue; }
    alerting.add(id);
    askButtons(OWNER, undefined, `${msg}\n要把它的 ${mine.length} 个会话切到 <b>${esc(CFG.agents[other].label)}</b> 继续吗？（对话和记忆不变）`, [[`切到 ${CFG.agents[other].label}`, 'y'], ['先不用', 'n']])
      .then(v => { if (v === 'y') for (const [kk] of mine) switchAccount(kk, other); }).finally(() => alerting.delete(id));
  }
}

// ---------- Codex: one `codex app-server` (JSON-RPC over stdio) per topic, same session interface as Claude ----------
// Prefer the newest codex.exe bundled with the Codex desktop app (the npm CLI here is too old for the default model).
function codexExe() {
  if (process.platform !== 'win32') return 'codex';
  try {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    const exes = fs.readdirSync(dir).map(d => path.join(dir, d, 'codex.exe')).filter(f => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (exes[0]) return exes[0];
  } catch {}
  try { return path.join(execSyncCached('npm root -g'), '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'); } catch { return 'codex'; }
}
let npmRoot = null;
function execSyncCached(cmd) { if (npmRoot == null) npmRoot = String(childProcess.execSync(cmd, { windowsHide: true })).trim(); return npmRoot; }

function codexRpc(cwd, onNotify, onRequest) {
  const p = childProcess.spawn(codexExe(), ['app-server'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stderr.on('data', d => log('codex stderr', String(d).slice(0, 300)));
  let buf = '', id = 0; const waiters = {};
  p.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method) { waiters[m.id]?.(m); delete waiters[m.id]; }
      else if (m.method && m.id != null) Promise.resolve().then(() => onRequest?.(m)).then(result => write({ jsonrpc: '2.0', id: m.id, ...(result === undefined ? { error: { code: -32601, message: 'not supported' } } : { result }) }),
        e => { log('codex request failed', m.method, e.message); write({ jsonrpc: '2.0', id: m.id, result: { decision: 'cancel' } }); });
      else if (m.method) onNotify?.(m);
    }
  });
  p.on('error', e => log('codex spawn failed', e.message));
  p.on('exit', () => { for (const i in waiters) { waiters[i]({ error: { message: 'codex app-server exited' } }); delete waiters[i]; } });
  p.stdin.on('error', () => {});
  const write = o => { try { p.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
  const call = (method, params) => new Promise((res, rej) => {
    const i = ++id; waiters[i] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); write({ jsonrpc: '2.0', id: i, method, params });
  });
  const init = call('initialize', { clientInfo: { name: 'agent-hub', version: '0.2' } }).then(r => { write({ jsonrpc: '2.0', method: 'initialized' }); return r; });
  const kill = () => { try { process.platform === 'win32' ? childProcess.execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {}) : p.kill(); } catch {} };
  return { p, call, init, kill };
}
const codexPolicy = mode => mode === 'default' ? 'untrusted' : 'on-request'; // ask → untrusted (asks for most commands); auto → only escalations

async function codexLatestThread(cwd) {
  const rpc = codexRpc(cwd);
  try {
    await rpc.init;
    const r = await rpc.call('thread/list', { cwd, sortKey: 'recency_at', sortDirection: 'desc', limit: 1 });
    return r?.data?.[0] || null;
  } catch (e) { log('codex thread/list failed', e.message); return null; } finally { rpc.kill(); }
}

function startCodexSession(k) {
  const t = state.topics[k];
  const s = { busy: false, waiting: 0, queue: [], buf: '', typing: null, pendEdits: new Map(), account: 'codex', codex: true };
  const items = new Map(); // itemId -> item (to render file changes in approval cards)
  let threadId = t.sessionId, turnId = null, closed = false;
  const rpc = codexRpc(t.cwd, m => {
    const pr = m.params || {};
    if (m.method === 'item/started' && pr.item) {
      items.set(pr.item.id, pr.item);
      if (pr.item.type === 'commandExecution') { s.steps = (s.steps || 0) + 1; s.lastTool = `shell: ${String(pr.item.command || '').slice(0, 50)}`; progressSoon(k); }
      if (pr.item.type === 'fileChange') { s.steps = (s.steps || 0) + 1; s.lastTool = `edit: ${(pr.item.changes || []).map(c => path.basename(c.path || '')).join(', ').slice(0, 50)}`; progressSoon(k); }
      if (pr.item.type === 'mcpToolCall') { s.steps = (s.steps || 0) + 1; s.lastTool = `${pr.item.server || ''}.${pr.item.tool || ''}`; progressSoon(k); }
    }
    if (m.method === 'item/completed' && pr.item) {
      if (pr.item.type === 'agentMessage' && pr.item.text) {
        if (pr.item.phase === 'commentary') { s.lastTool = `💬 ${pr.item.text.replace(/\s+/g, ' ').slice(0, 60)}`; progressSoon(k); }
        else s.buf += (s.buf ? '\n\n' : '') + pr.item.text;
      }
      if (pr.item.type === 'fileChange' && pr.item.status !== 'failed' && pr.item.status !== 'declined')
        for (const c of pr.item.changes || []) if (c.path) t.outputs = [c.path, ...(t.outputs || []).filter(x => x !== c.path)].slice(0, 30);
    }
    if (m.method === 'turn/started') turnId = pr.turn?.id || turnId;
    if (m.method === 'turn/completed') { turnId = null; const st = pr.turn?.status; endTurn(k, st === 'failed' ? `⚠️ Codex 这一轮失败了${pr.turn?.error?.message ? '：' + pr.turn.error.message : ''}` : st === 'interrupted' ? '⏹ 已中断' : ''); }
  }, async m => {
    const pr = m.params || {};
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
      const isCmd = m.method.includes('commandExecution');
      const it = items.get(pr.itemId) || {};
      const ch = it.changes || [];
      const body = isCmd ? `<pre>${esc(clip(pr.command || it.command, 1500))}</pre>${pr.cwd ? `目录：${esc(pr.cwd)}\n` : ''}${pr.reason ? esc(pr.reason) : ''}`
        : `${ch.slice(0, 4).map(c => `${esc(c.path || '')}\n<pre>${esc(clip(String(c.diff || '').split('\n').slice(0, 40).join('\n'), 700))}</pre>`).join('\n')}${ch.length > 4 ? `\n…还有 ${ch.length - 4} 个文件` : ''}${pr.reason ? esc(pr.reason) : ''}`;
      s.waiting++; progressSoon(k); refreshSoon();
      bot.api.sendMessage(OWNER, `🔐 ${t.title} · Codex 等你批准\n${topicLink(t.chatId, t.threadId)}`).catch(() => {});
      try {
        const v = await askButtons(t.chatId, t.threadId, `🔐 <b>${isCmd ? '运行命令' : '修改文件'}</b> · ${esc(t.title)} · Codex\n${body}`,
          [['✅ 允许一次', 'accept'], ['🔁 本会话都允许', 'acceptForSession'], ['❌ 拒绝', 'decline']]);
        return { decision: v || 'cancel' };
      } finally { s.waiting--; }
    }
    return undefined; // other server requests (user-input forms, MCP elicitation…): not supported from Telegram yet
  });
  rpc.p.on('exit', () => {
    closed = true;
    if (live.get(k) !== s) return;
    if (s.busy) { const n = s.queue.length; s.queue = []; endTurn(k, `⚠️ Codex 进程退出了${n ? `，排队的 ${n} 条消息没有处理，请重发` : ''}。再发一条消息会重新接上。`); }
    clearInterval(s.typing); clearInterval(s.progTick); live.delete(k); t.busy = false; save();
  });
  const ready = (async () => {
    await rpc.init;
    const common = { cwd: t.cwd, approvalPolicy: codexPolicy(modeOf(t)), sandbox: 'workspace-write' };
    const r = threadId ? await rpc.call('thread/resume', { threadId, ...common }).catch(async e => { // thread gone: start fresh instead of failing forever
      log('codex resume failed', e.message); await send(t.chatId, t.threadId, `⚠️ 上次的 Codex 线程接不上了（${e.message}），已开新线程。`);
      return rpc.call('thread/start', common);
    }) : await rpc.call('thread/start', common);
    threadId = r.thread.id;
    if (t.sessionId !== threadId) { t.sessionId = threadId; save(); }
    if (r.model && t.modelActual !== r.model) { t.modelActual = r.model; save(); }
    refreshCardSoon(k);
  })().catch(async e => { log('codex start failed', e); await send(t.chatId, t.threadId, `⚠️ Codex 启动失败：${e.message}`); rpc.kill(); });
  s.push = async msg => {
    await ready;
    if (closed) return;
    const input = [];
    for (const b of msg.message.content) {
      if (b.type === 'text') input.push({ type: 'text', text: b.text });
      if (b.type === 'image') { const f = path.join(INBOX, String(t.threadId), `${Date.now()}.jpg`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(b.source.data, 'base64')); input.push({ type: 'localImage', path: f }); }
    }
    const r = await rpc.call('turn/start', { threadId, input, approvalPolicy: codexPolicy(modeOf(t)) }).catch(async e => { await endTurn(k, `⚠️ ${e.message}`); return null; });
    if (r?.turn?.id) turnId = r.turn.id;
  };
  s.q = {
    interrupt: () => turnId ? rpc.call('turn/interrupt', { threadId, turnId }) : Promise.resolve(),
    close: () => { closed = true; rpc.kill(); },
    setPermissionMode: async () => {}, // applied per turn via approvalPolicy
    setModel: async () => {},
    getContextUsage: async () => null,
    mcpServerStatus: async () => [],
  };
  live.set(k, s);
  return s;
}

// ---------- external sessions (desktop / terminal) via `claude agents --json` ----------
// User's CLI if installed, else the binary bundled with the Agent SDK (Macs may only have the desktop app).
const CLAUDE_EXE = (() => {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return local;
  try {
    const dir = path.join(HOME, 'node_modules', '@anthropic-ai');
    const pkg = fs.readdirSync(dir).find(d => d.startsWith('claude-agent-sdk-'));
    const bin = pkg && path.join(dir, pkg, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (bin && fs.existsSync(bin)) return bin;
  } catch {}
  return 'claude';
})();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function externalSessions() {
  return new Promise(res => execFile(CLAUDE_EXE, ['agents', '--json', '--all'], { timeout: 20000, windowsHide: true }, (err, out) => {
    if (err) { log('agents --json failed', err.message); return res([]); }
    let rows = []; try { rows = JSON.parse(out); } catch {}
    const ours = new Set(Object.values(state.topics).map(t => t.sessionId).filter(Boolean));
    res(rows.filter(r => !ours.has(r.sessionId) && (r.kind === 'interactive'
      ? alive(r.pid)
      : ['working', 'blocked'].includes(r.state) && Date.now() - r.startedAt < 48 * 3600e3)));
  }));
}

// ---------- commands ----------
function resolveDir(arg) {
  arg = arg.trim().replace(/^["']|["']$/g, '');
  if (!arg) return null;
  const home = s => s.replace(/^~(?=$|[\\/])/, os.homedir());
  arg = home(arg);
  const roots = CFG.defaultRoots.map(home);
  let p = path.isAbsolute(arg) ? arg : null;
  if (!p) for (const r of roots) { const c = path.join(r, arg); if (fs.existsSync(c)) { p = c; break; } }
  p = path.resolve(p || path.join(roots[0], arg));
  if (inside(HOME, p) || inside(p, HOME)) throw new Error('这个目录是 Hub 自己的（或包含 Hub 目录），不能打开');
  // A topic per project/task: the workspace root itself would be one anonymous "workspace" topic for everything.
  if (roots.some(r => norm(path.resolve(r)) === norm(p))) throw new Error(`不能直接用根目录 ${p} 开话题：请在下面按项目或任务建一个子文件夹（例如 ${path.join(p, 'search')}，新任务用 fresh=true / /new）`);
  return p;
}
async function createTopic(chatId, agent, cwd, sessionId, wanted) {
  const base = (wanted || path.basename(cwd) || cwd).slice(0, 100);
  const taken = new Set(Object.values(state.topics).filter(t => t.chatId === chatId).map(t => t.title));
  let title = base; for (let n = 2; taken.has(title); n++) title = `${base} #${n}`;
  const ft = await bot.api.createForumTopic(chatId, title);
  const k = key(chatId, ft.message_thread_id);
  state.topics[k] = { chatId, threadId: ft.message_thread_id, agent, cwd, sessionId: sessionId || null, title, busy: false };
  save();
  return state.topics[k];
}
function lastAssistantText(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].type === 'assistant' && !msgs[i].parent_tool_use_id && msgs[i].message?.content;
    const txt = Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() : '';
    if (txt) return txt;
  }
  return '';
}

async function cmdOpen(ctx, g, arg, fresh) {
  const chatId = ctx.chat.id, reply = text => send(chatId, undefined, text);
  const p = resolveDir(arg);
  if (!p) return reply(fresh ? '用法：/new <目录>，例如 /new F:\\workspace\\NewApp 或 /new NewApp' : '用法：/open <目录>，例如 /open my-app');
  if (!fs.existsSync(p)) {
    if (!fresh) return reply(`找不到目录：${p}\n新项目请用 /new`);
    const ok = await askButtons(chatId, undefined, `目录不存在：\n<pre>${esc(p)}</pre>要创建吗？`, [['📁 创建', 'y'], ['取消', 'n']]);
    if (ok !== 'y') return;
    fs.mkdirSync(p, { recursive: true });
  }
  return reply((await openProject(chatId, g.agent, p, { fresh })).text);
}

// Shared by /open, /new and the General dispatcher agent. Returns { text, link? }.
// ifOpen: what to do when the folder's latest session is open in the desktop app — 'refuse' or 'fork' (copy with full memory).
async function openProject(chatId, agent, p, { fresh = false, ifOpen = 'refuse' } = {}) {
  let sessionId = null, forkFrom = null, sessions = [], codexPreview = '';
  const isCodex = CFG.agents[agent]?.type === 'codex';
  if (isCodex) { if (!fresh) { const th = await codexLatestThread(p); if (th) { sessions = [{ sessionId: th.id }]; codexPreview = th.name || th.preview || ''; } } }
  else try { sessions = (await listSessions({ dir: p })).sort((a, b) => b.lastModified - a.lastModified); } catch {}
  if (!fresh) {
    let existing = Object.values(state.topics).find(t => t.chatId === chatId && norm(t.cwd) === norm(p) && !t.deleted && !t.isDispatcher);
    if (existing) { // reopenForumTopic doubles as an existence probe: open → TOPIC_NOT_MODIFIED, closed → reopened, deleted → TOPIC_ID_INVALID
      const ok = await bot.api.reopenForumTopic(chatId, existing.threadId).then(() => true, e => /TOPIC_NOT_MODIFIED/.test(e.description || ''));
      if (ok) { existing.closed = false; save(); } else { topicGone(chatId, existing.threadId); existing = null; }
    }
    if (existing) return { text: `这个项目已经有话题了：${existing.title}\n${topicLink(chatId, existing.threadId)}`, link: topicLink(chatId, existing.threadId), key: key(chatId, existing.threadId) };
    sessionId = sessions[0]?.sessionId || null;
    // Already driven by a hub topic in another group (another account): two processes on one transcript would branch it.
    if (sessionId && !isCodex && Object.values(state.topics).some(x => x.sessionId === sessionId && !x.deleted)) { forkFrom = sessionId; sessionId = null; }
    else if (sessionId && !isCodex && (await externalSessions()).some(r => r.sessionId === sessionId)) {
      if (ifOpen !== 'fork') return { text: `「${path.basename(p)}」最近的会话正在桌面 App 或终端里开着。可以先在电脑上关掉它再打开，或者复制一份（带完整记忆）在这里继续。` };
      forkFrom = sessionId; sessionId = null;
    }
  }
  // No trust prompt: the owner chose whole-machine access (design doc §0.4); SDK sessions run repo hooks/.mcp.json without asking.
  const t = await createTopic(chatId, agent, p, sessionId, forkFrom ? `${path.basename(p)} ⑂` : undefined);
  if (forkFrom) { t.forkFrom = forkFrom; save(); }
  const from = sessionId || forkFrom;
  let intro = sessionId ? `已接上「${t.title}」上次的对话（${CFG.agents[agent].label}）。`
    : forkFrom ? `最近的会话正在别处用着（桌面 App 或另一个群的话题），已复制一份带完整记忆的副本在这里继续（${CFG.agents[agent].label}）。` : `新会话「${t.title}」（${CFG.agents[agent].label}）。`;
  if (isCodex && codexPreview) intro += `\n\n上次的线程：${codexPreview.slice(0, 300)}`;
  if (from && !isCodex) {
    try {
      const msgs = await getSessionMessages(from);
      const pend = new Map(); for (const m of msgs) noteOutputs(t, m, pend);
      save();
      const last = lastAssistantText(msgs); if (last) intro += `\n\n上次最后的回复：\n${last.slice(0, 600)}${last.length > 600 ? '…' : ''}`;
    } catch {}
  }
  await refreshCard(key(chatId, t.threadId)).catch(e => log('card failed', e));
  await send(chatId, t.threadId, `${intro}\n\n目录：${p}\n直接在这里发消息即可。`);
  const link = topicLink(chatId, t.threadId);
  return { text: `已开话题：${t.title}\n${link}`, link, key: key(chatId, t.threadId), title: t.title, resumed: !!sessionId, forked: !!forkFrom };
}

async function cmdStatus(ctx) {
  const lines = [];
  for (const [chatId, g] of Object.entries(CFG.groups)) {
    if (g.owner === 'mac-hub') continue;
    lines.push(`【${g.title}】${CFG.agents[g.agent].label}`);
    const ts = Object.entries(state.topics).filter(([, t]) => String(t.chatId) === chatId && !t.closed && !t.isDispatcher);
    if (!ts.length) lines.push('  （没有话题）');
    for (const [k, t] of ts) {
      const s = live.get(k);
      const st = !s ? '⚪ 未启动' : s.waiting ? '🟡 等你批准' : s.busy ? `🟢 运行中${s.queue.length ? `（排队 ${s.queue.length}）` : ''}` : '⚪ 空闲';
      lines.push(`  ${st} ${t.title}`);
    }
  }
  const ext = await externalSessions();
  lines.push('', `【外部会话（桌面 App / 终端，只读）】${ext.length ? '' : '无'}`);
  for (const r of ext) lines.push(`  ${r.status === 'busy' || r.state === 'working' ? '🟢' : r.state === 'blocked' || r.status === 'waiting' ? '🟡' : '⚪'} ${path.basename(r.cwd || '')} · ${r.name || r.sessionId?.slice(0, 8)}`);
  await send(ctx.chat.id, ctx.message.message_thread_id, lines.join('\n'));
}

async function cmdStop(k) {
  const t = state.topics[k], s = live.get(k);
  if (!s) return send(t.chatId, t.threadId, '当前没有在运行。');
  s.queue = [];
  for (const [id, w] of waits) if (w.chatId === t.chatId && w.threadId === t.threadId) finishWait(id, -1, '⏹ 已停止');
  await s.q.interrupt().catch(() => {});
  await send(t.chatId, t.threadId, '⏹ 已停止当前这一轮，排队的消息已清空。');
}

// ---------- /fork and /handoff: carry a session's memory to another topic ----------
const ownGroups = () => Object.entries(CFG.groups).filter(([, g]) => g.owner !== 'mac-hub');
const claudeGroups = () => Object.entries(CFG.groups).filter(([, g]) => g.owner !== 'mac-hub' && CFG.agents[g.agent]?.type === 'claude');
const transcriptPath = t => path.join(os.homedir(), '.claude', 'projects', t.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${t.sessionId}.jsonl`);

// ---------- /move: carry a Claude session (transcript + subagent files + project memory) to the other machine ----------
// Transport = a zip posted in 上朝 addressed "→ <machine>" (see postToExchange / onPeerMessage).
// The receiving hub rewrites the project path (F:\workspace\X ↔ ~/workspace/X) and opens a topic resuming it.
const projDirOf = cwd => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const rootsAbs = () => CFG.defaultRoots.map(r => path.resolve(r.replace(/^~(?=$|[\\/])/, os.homedir())));
// Never carried by "/move … code": dependencies, VCS, build output, caches, secrets.
const CODE_SKIP = /^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|out|\.next|\.nuxt|target|\.cache|\.turbo|coverage|\.env(\..*)?)$/i;
// Windows: always the built-in bsdtar (Git Bash's GNU tar on PATH reads "C:\…" as a remote host and can't write zip).
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// An archive from another machine must contain plain files only: a symlink could make us read or overwrite anything.
export function assertNoLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`archive contains a link: ${path.basename(p)}`);
    if (e.isDirectory()) assertNoLinks(p);
  }
}
const tarZip = (zip, dir) => childProcess.execFileSync(TAR, ['-a', '-cf', zip, '-C', dir, '.'], { windowsHide: true });
const tarUnzip = (zip, dir) => childProcess.execFileSync(TAR, ['-xf', zip, '-C', dir], { windowsHide: true });
// Rewrites every occurrence of the old project path (JSON-escaped backslash or slash form, any case) to the new one,
// including sub-paths, so tool calls in the history point at the right files on this machine.
export function rewriteProjectPath(text, from, to) {
  const segs = from.replace(/[\\/]+$/, '').split(/[\\/]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`${segs.join('(?:\\\\\\\\|/)')}((?:(?:\\\\\\\\|/)[^"\\\\/\\s]+)*)`, 'gi');
  // The text is JSON: write the target JSON-escaped, with the target machine's separator.
  const T = JSON.stringify(to).slice(1, -1), sep = to.includes('\\') ? '\\\\' : '/';
  return text.replace(re, (_, rest) => T + rest.replace(/\\\\|\//g, sep));
}

async function cmdMove(k, arg) {
  const t = state.topics[k];
  if (CFG.agents[t.agent]?.type !== 'claude') return send(t.chatId, t.threadId, '目前只有 Claude 的会话能 /move。');
  if (!t.sessionId) return send(t.chatId, t.threadId, '这个话题还没有对话记录，先聊几句再 /move。');
  if (live.get(k)?.busy) return send(t.chatId, t.threadId, '这一轮还没结束，结束后再 /move。');
  const peers = Object.entries(CFG.peers || {});
  if (!peers.length) return send(t.chatId, t.threadId, '没有配置其它电脑（config.json 的 peers）。');
  const withCode = /\b(code|代码)\b|代码/i.test(arg);
  arg = arg.replace(/\b(code)\b|带?代码/gi, '').trim();
  let target = peers.find(([n]) => n === arg.toLowerCase())?.[0];
  if (!target) target = peers.length === 1 ? peers[0][0] : await askButtons(t.chatId, t.threadId, `把「${esc(t.title)}」搬到哪台电脑？`, [...peers.map(([n]) => [n, n]), ['取消', '']]);
  if (!target) return;
  const age = await peerAge(CFG.peers[target]);
  if (age > PEER_OFFLINE_MIN) return send(t.chatId, t.threadId, `${offlineNote(CFG.peers[target], age)}，现在搬不过去，等它上线再 /move。`);
  const transcript = transcriptPath(t);
  if (!fs.existsSync(transcript)) return send(t.chatId, t.threadId, `找不到对话记录：${transcript}`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-move-'));
  fs.copyFileSync(transcript, path.join(stage, 'transcript.jsonl'));
  const pd = projDirOf(t.cwd);
  if (fs.existsSync(path.join(pd, t.sessionId))) fs.cpSync(path.join(pd, t.sessionId), path.join(stage, 'session'), { recursive: true });
  if (fs.existsSync(path.join(pd, 'memory'))) fs.cpSync(path.join(pd, 'memory'), path.join(stage, 'memory'), { recursive: true });
  const root = rootsAbs().find(r => inside(r, t.cwd));
  const relPath = (root ? path.relative(root, t.cwd) : path.basename(t.cwd)).split(path.sep).join('/');
  if (withCode) fs.cpSync(t.cwd, path.join(stage, 'code'), { recursive: true, filter: src => !CODE_SKIP.test(path.basename(src)) });
  fs.writeFileSync(path.join(stage, 'meta.json'), JSON.stringify({ kind: 'agent-hub-move', from: CFG.machine, sessionId: t.sessionId, title: t.title, srcCwd: t.cwd, relPath, withCode, outputs: t.outputs || [] }, null, 1));
  const zip = path.join(os.tmpdir(), `agent-hub-move-${t.sessionId.slice(0, 8)}.zip`);
  tarZip(zip, stage);
  const size = fs.statSync(zip).size;
  if (size > MAX_DOWN) return send(t.chatId, t.threadId, `打包后 ${(size / 1048576).toFixed(1)} MB，超过 bot 能下载的 20 MB 上限，暂时搬不了。`);
  if (!CFG.exchange) return send(t.chatId, t.threadId, '没有配置交换群（config.json 的 exchange）。');
  // 上朝: both machines' bots are there; the caption says who it is for
  await postToExchange({ file: zip, caption: `📦 搬家包 → ${CFG.peers[target]}：${t.title}（来自 ${CFG.machine}）` });
  t.movedTo = CFG.peers[target]; save(); // next message here asks first: continuing on both machines forks the history
  return send(t.chatId, t.threadId, `📦 已打包（${(size / 1024).toFixed(0)} KB）发往 ${target}，那边收到后会自动开话题（离线的话上线后接收）。之后请在 ${target} 那边继续；在这里再发消息会先问你。\n${withCode ? '项目代码也一起带过去了（不含 node_modules、.git、构建产物和 .env；那边已有的文件不会被覆盖）。' : '只带了对话记忆。那台电脑上没有这个项目的话，改用「/move ' + target + ' code」连代码一起带。'}`);
}

// Receiving side: a move bundle from the other machine lands in the first Claude group (or config "moveInto"),
// i.e. the same account on this machine; it opens (or re-points) a topic resuming the session.
async function receiveMove(m, doc) {
  const intoId = String(CFG.moveInto || ownGroups().find(([, g]) => CFG.agents[g.agent]?.type === 'claude')?.[0]), g = CFG.groups[intoId];
  if (!g) return send(CFG.exchange, undefined, `⚠️ ${CFG.machine} 没有 Claude 群，接收不了搬家包。`);
  const v = await askOwner(`📦 ${esc(m.caption || doc.file_name)}（${Math.round((doc.file_size || 0) / 1024)} KB）\n要在 ${esc(CFG.machine)} 上接收吗？`, [['✅ 接收', 'y'], ['❌ 不要', 'n']]);
  if (v !== 'y') return;
  try { await importMove(doc, intoId, g); }
  catch (e) { log('move import failed', e); await send(CFG.exchange, undefined, `⚠️ ${CFG.machine} 接收搬家包失败：${e.message}`); }
}
async function importMove(doc, intoId, g) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-import-'));
    tarUnzip(await download(doc.file_id, 'import', doc.file_name), dir);
    assertNoLinks(dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!/^[0-9a-f-]{36}$/i.test(meta.sessionId || '')) throw new Error('bad sessionId in bundle');
    if (!meta.relPath || meta.relPath.split('/').some(x => !x || x === '.' || x === '..' || /[:\\]/.test(x))) throw new Error(`bad project path in bundle: ${meta.relPath}`);
    const target = path.join(rootsAbs()[0], ...meta.relPath.split('/'));
    let codeMissing = !fs.existsSync(target);
    if (codeMissing) fs.mkdirSync(target, { recursive: true });
    // Code travels only with "/move … code"; never overwrite files that already exist on this machine.
    if (meta.withCode && fs.existsSync(path.join(dir, 'code'))) { fs.cpSync(path.join(dir, 'code'), target, { recursive: true, force: false, errorOnExist: false }); codeMissing = false; }
    const pd = projDirOf(target);
    fs.mkdirSync(pd, { recursive: true });
    // Moving back: the incoming copy wins, but a transcript that grew here in the meantime is kept as a backup.
    const tf = path.join(pd, `${meta.sessionId}.jsonl`), incoming = rewriteProjectPath(fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8'), meta.srcCwd, target);
    let backup = null;
    if (fs.existsSync(tf) && !incoming.startsWith(fs.readFileSync(tf, 'utf8').trimEnd())) { backup = `${tf}.bak-${Date.now()}`; fs.copyFileSync(tf, backup); }
    fs.writeFileSync(tf, incoming);
    if (fs.existsSync(path.join(dir, 'session'))) fs.cpSync(path.join(dir, 'session'), path.join(pd, meta.sessionId), { recursive: true });
    // Memory: newer file wins (tar keeps mtimes), so what was learned on the other machine comes along.
    const newer = (src, dest) => !fs.existsSync(dest) || fs.statSync(src).isDirectory() || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs;
    if (fs.existsSync(path.join(dir, 'memory'))) fs.cpSync(path.join(dir, 'memory'), path.join(pd, 'memory'), { recursive: true, filter: newer });
    const existing = Object.entries(state.topics).find(([, t]) => String(t.chatId) === intoId && norm(t.cwd) === norm(target) && !t.deleted && !t.isDispatcher);
    let link;
    if (backup) log('move: kept diverged transcript as', backup);
    if (existing) {
      const [kk, t] = existing; const s = live.get(kk); if (s) { try { s.q.close(); } catch {} live.delete(kk); }
      t.sessionId = meta.sessionId; t.closed = false; delete t.movedTo; save(); link = topicLink(t.chatId, t.threadId);
      await send(t.chatId, t.threadId, `📦 这个话题已切换到从 ${meta.from} 搬来的会话「${meta.title}」，直接发消息接着聊。`);
    } else link = (await openProject(Number(intoId), g.agent, target)).link;
    await send(CFG.exchange, undefined, `📦 已接收从 ${meta.from} 搬来的会话「${meta.title}」${link ? `：${link}` : ''}${codeMissing ? `\n⚠️ 这台电脑上原本没有项目目录，已新建空目录 ${target}。请先把代码同步过来（例如 git clone），否则它只有记忆没有文件。` : ''}`);
    log('imported move bundle', meta.title, '->', target);
}

// /fork — copy this session (full history) into a new topic, in this or another account's group.
async function cmdFork(k) {
  const t = state.topics[k];
  if (!t.sessionId) return send(t.chatId, t.threadId, '这个话题还没有对话记录，先聊几句再 /fork。');
  if (CFG.agents[t.agent]?.type === 'codex') return send(t.chatId, t.threadId, 'Codex 话题暂不支持 /fork，可以用 /handoff 把结论交给别的话题。');
  const groups = claudeGroups();
  const target = groups.length === 1 ? groups[0][0] : await askButtons(t.chatId, t.threadId,
    `把「${esc(t.title)}」完整复制一份到哪个账号继续？（原话题不受影响）`, [...groups.map(([id, g]) => [`${g.title} · ${CFG.agents[g.agent].label}`, id]), ['取消', '']], true);
  if (!target) return;
  const g = CFG.groups[target];
  const nt = await createTopic(Number(target), g.agent, t.cwd, null, `${t.title} ⑂`);
  nt.forkFrom = t.sessionId; nt.outputs = [...(t.outputs || [])]; save();
  await refreshCard(key(nt.chatId, nt.threadId)).catch(e => log('card failed', e));
  await send(nt.chatId, nt.threadId, `⑂ 从「${t.title}」（${CFG.agents[t.agent].label}）复制而来，带着完整的对话记忆，现在用 ${CFG.agents[g.agent].label} 继续。\n直接发消息即可；原话题不受影响。`);
  return send(t.chatId, t.threadId, `⑂ 已复制到 ${g.title}：${topicLink(nt.chatId, nt.threadId)}`);
}

const HANDOFF_PROMPT = b => `请为另一个会话写一份交接说明，它会在项目「${b.title}」（目录 ${b.cwd}）里接着工作。包括：这次会话的目标、已经完成的工作和结论、关键文件路径、做过的重要决定、还没解决的问题和建议的下一步。只输出交接说明本身，不要做其它操作。`;

// /handoff — this session writes a handoff note; the target topic's session receives it (keeps its own memory too).
async function cmdHandoff(k) {
  const a = state.topics[k];
  if (!a.sessionId) return send(a.chatId, a.threadId, '这个话题还没有对话记录，没有可交接的内容。');
  const others = Object.entries(state.topics).filter(([kk, t]) => kk !== k && !t.closed && !t.isDispatcher && ownGroups().some(([id]) => id === String(t.chatId)));
  if (!others.length) return send(a.chatId, a.threadId, '没有其它项目话题可以交接。先用 /open 或 /new 开一个。');
  const kb = await askButtons(a.chatId, a.threadId, `把「${esc(a.title)}」的结论交给哪个话题？`,
    [...others.slice(0, 20).map(([kk, t]) => [`${CFG.groups[String(t.chatId)].title} · ${t.title}`, kk]), ['取消', '']], true);
  if (!kb) return;
  let s = live.get(k);
  if (!s) {
    if ((await externalSessions()).some(r => r.sessionId === a.sessionId)) return send(a.chatId, a.threadId, '这个会话正在桌面 App 或终端里开着，先在电脑上关掉再 /handoff。');
    s = live.get(k) || startSession(k);
  }
  if (s.busy) return send(a.chatId, a.threadId, '这一轮还没结束，等它结束后再 /handoff。');
  const b = state.topics[kb];
  s.afterTurn = note => deliverHandoff(k, kb, note, false);
  await send(a.chatId, a.threadId, `📝 正在写交接说明，写完会自动发到「${b.title}」…`);
  startTurn(k, [{ type: 'text', text: HANDOFF_PROMPT(b) }]);
}

const groupTitle = chatId => CFG.groups[String(chatId)]?.title || CFG.commandGroups?.[String(chatId)]?.title || 'Telegram';
// Posts the note in B's topic and starts B on it automatically. byAgent = the agent chose to hand off (not the user).
// From a dispatcher (圣旨): it is the user's own task; if the dispatcher's turn came from 上朝, B reports back there too.
async function deliverHandoff(ka, kb, note, byAgent) {
  const a = state.topics[ka], b = state.topics[kb];
  if (a.isDispatcher) {
    const sa = live.get(ka) || {}, { reportTo, replyTo } = sa;
    sa.replyTo = null; // the topic now owes the result; the dispatcher's own reply no longer does
    b.handoffHops = 0; save();
    await send(b.chatId, b.threadId, `📨 ${reportTo ? '来自「上朝」' : '来自「圣旨」'}的任务：\n\n${note}`);
    let sb = live.get(kb);
    if (!sb) {
      if (b.sessionId && (await externalSessions()).some(r => r.sessionId === b.sessionId)) { await send(b.chatId, b.threadId, '⚠️ 这个会话正在桌面 App 里开着，任务已贴在上面，关掉桌面后发「继续」即可。'); return 'target session is open in the desktop app; task posted, not started'; }
      sb = live.get(kb) || startSession(kb); // re-check: another message may have started it while we awaited
    }
    const content = Object.assign([{ type: 'text', text: `这是用户布置的任务，直接开始做：\n\n${note}` }], { reportTo, replyTo });
    if (sb.busy || sb.queue.length) sb.queue.push(content); else startTurn(kb, content);
    return `delivered to「${b.title}」: ${topicLink(b.chatId, b.threadId)}`;
  }
  const file = transcriptPath(a);
  const ref = fs.existsSync(file) ? `需要细节时，那个会话的完整对话记录在：${file}` : `那个会话的 sessionId 是 ${a.sessionId}，记录在 ~/.claude/projects 下。`;
  const msg = `📨 来自「${a.title}」（${groupTitle(a.chatId)}）的${byAgent ? '任务交接（由 agent 发起）' : '交接说明'}：\n\n${note}\n\n${ref}`;
  b.handoffHops = byAgent ? (a.handoffHops || 0) + 1 : 0; save();
  await send(b.chatId, b.threadId, msg);
  let sb = live.get(kb);
  if (!sb) {
    if (b.sessionId && (await externalSessions()).some(r => r.sessionId === b.sessionId)) { await send(b.chatId, b.threadId, '⚠️ 这个会话正在桌面 App 里开着，交接内容已贴在上面，关掉桌面后发「继续」即可。'); return 'target session is open in the desktop app; note posted, not started'; }
    sb = live.get(kb) || startSession(kb);
  }
  const content = [{ type: 'text', text: `${msg}\n\n${byAgent ? '这是另一个 agent 交给你的任务，按协作规则直接开始处理。' : '请先阅读这份交接说明，简要复述你接手后的理解和打算，然后等我确认。'}` }];
  if (sb.busy || sb.queue.length) sb.queue.push(content); else startTurn(kb, content);
  return `delivered to「${b.title}」`;
}

// Tools for agent-initiated collaboration. ponytail: loop guard = 3 hops per chain, 3 handoffs per topic per hour.
const topicList = () => Object.entries(state.topics).filter(([, t]) => !t.closed && !t.isDispatcher && ownGroups().some(([id]) => id === String(t.chatId)))
  .map(([kk, t]) => `${kk} | ${CFG.groups[String(t.chatId)].title} | ${t.title} | ${t.cwd} | ${live.get(kk)?.busy ? 'busy' : 'idle'}`).join('\n');
// 上朝 → an agent group: the task is posted in that group's 圣旨 and its dispatcher picks or creates the project
// topic. content.reportTo makes the dispatcher's reply and the topic's result come back to 上朝.
// replyTo = { machine, key } of the agent topic that asked: the result is also handed back to it (returnResult).
async function assignToGroup(groupId, task, fromLabel, replyTo) {
  const g = CFG.groups[String(groupId)], dk = dispatcherKey(Number(groupId), g);
  await send(Number(groupId), undefined, `📨 来自「上朝」的任务（${fromLabel}）：\n${task}`);
  const content = Object.assign([{ type: 'text', text: `「上朝」派来的任务（${fromLabel}），已经确认要做：直接选好或新开话题 handoff 过去，不要反问用户，也不要说做不了。\n\n${task}` }], { reportTo: CFG.exchange, replyTo });
  const s = live.get(dk) || startSession(dk);
  if (s.busy || s.queue.length) s.queue.push(content); else startTurn(dk, content);
  return `posted to「${g.title}」's 圣旨`;
}
// Agent → agent by nickname (config commandAliases). Same machine: straight to the target group's 圣旨.
// Other machine: posted in 上朝 as "📨 → <machine> …", which that machine's bot receives. Every hop is visible in 上朝.
async function sendToAgent(fromLabel, alias, task, replyTo) {
  const a = CFG.commandAliases?.[alias.toLowerCase().replace(/^@/, '')];
  if (!a) return `unknown agent: ${alias}. Known: ${Object.keys(CFG.commandAliases || {}).map(x => '@' + x).join(', ')}`;
  if (!CFG.exchange) return 'no exchange group configured';
  const name = alias.toLowerCase().replace(/^@/, '');
  const back = replyTo ? '; the result will also be handed back to you as a new message' : '';
  if (a.machine === CFG.machine) {
    await send(CFG.exchange, undefined, `📨 ${fromLabel} → @${name}：${task}`);
    return `sent to @${name}: ${await assignToGroup(a.group, task, fromLabel, replyTo)}${back}`;
  }
  const age = await peerAge(a.machine);
  if (age > PEER_OFFLINE_MIN) { // offline = not sent at all (nothing is held for later); the asking agent tells the user
    const note = offlineNote(a.machine, age);
    await send(CFG.exchange, undefined, `${note}：${fromLabel} 想派给 @${name} 的任务没有发出。`);
    return `NOT SENT: ${note}. Tell the user ${a.machine} is offline (on leave today) and do the work another way or later.`;
  }
  await postToExchange({ text: `📨 → ${a.machine} @${name}：${task.slice(0, 3000)}\n（来自 ${fromLabel}）${replyTo ? `\n↩ ${replyTo.machine} ${replyTo.key}` : ''}` });
  return `relayed to @${name} on ${a.machine}${back}`;
}
// A machine counts as online while its heartbeat line in 上朝's description is fresh (written every 5 min).
const PEER_OFFLINE_MIN = 12;
const peerAge = async machine => peerAgeMin(await bot.api.getChat(CFG.exchange).then(c => c.description || '', () => ''), Date.now(), machine);
const offlineNote = (machine, age) => `🏖 ${machine} 今天请假了（${Number.isFinite(age) ? `最后在线 ${fmtHM(Date.now() - age * 60e3)}` : '还没上过线'}）`;
// Cross-machine messages: "📨 → M @alias：task\n（来自 X）[\n↩ M2 key]" (a task) or "📬 → M key\nresult" (a result for topic key).
export function parseRelay(text, machine) {
  text = text || '';
  const res = new RegExp(`^📬 → ${machine} (\\S+)\\n`).exec(text);
  if (res) return { kind: 'result', key: res[1], body: text.slice(res[0].length) };
  const m = new RegExp(`^📨 → ${machine} @([\\p{L}\\p{N}_-]+)：`, 'u').exec(text);
  if (!m) return null;
  let task = text.slice(m[0].length), replyTo, from;
  const back = /\n↩ (\S+) (\S+)\s*$/.exec(task); if (back) { replyTo = { machine: back[1], key: back[2] }; task = task.slice(0, back.index); }
  const f = /\n（来自 (.+)）\s*$/.exec(task); if (f) { from = f[1]; task = task.slice(0, f.index); }
  return { kind: 'task', alias: m[1].toLowerCase(), task, from, replyTo };
}
// A delegated task finished: hand its result back to the topic that asked (here or, via 上朝, on the other machine).
async function returnResult(replyTo, t, text) {
  const body = `「${t.title}」（${groupTitle(t.chatId)}${replyTo.machine === CFG.machine ? '' : ` · ${CFG.machine}`}）的结果：\n\n${text.slice(0, 3000)}`;
  if (replyTo.machine === CFG.machine) return deliverResult(replyTo.key, body);
  await postToExchange({ text: `📬 → ${replyTo.machine} ${replyTo.key}\n${body}` });
}
async function deliverResult(k, body) {
  const t = state.topics[k];
  if (!t || t.deleted) return log('result for unknown topic', k);
  await send(t.chatId, t.threadId, `📬 你派出去的任务有结果了：${body}`);
  await feed(k, [{ type: 'text', text: `这是你用 send_to_agent 派出去的任务的结果，${body}\n\n根据结果继续你手上的工作；如果不需要再做什么，简短确认即可，不要再次派同样的任务。` }]);
}
// Cross-machine items are plain messages in 上朝 addressed "… → <machine>". The two hubs' bots see each other's messages
// there (verified 2026-10-15), and Telegram keeps undelivered updates for 24 h while the other hub is offline.
async function postToExchange(item) { // { text } or { file, caption }
  if (item.file) await bot.api.sendDocument(CFG.exchange, new InputFile(item.file), { caption: item.caption, disable_notification: true });
  else await bot.api.sendMessage(CFG.exchange, item.text, { disable_notification: true });
}
export const isPeerBot = (u, peers = CFG.peerBots || []) => peers.some(p => String(p) === String(u.id) || String(p).replace(/^@/, '').toLowerCase() === String(u.username || '').toLowerCase());
// The other machine's bot said something in 上朝: act on what is addressed to this machine.
async function onPeerMessage(m) {
  const text = m.text || m.caption || '', doc = m.document, r = parseRelay(m.text, CFG.machine);
  if (text.startsWith(`🧹 → ${CFG.machine}`) && m.date > Date.now() / 1000 - 600) return clearOwnGroups(); // "/clear <this machine>" sent from the other hub
  if (!r && !(doc && text.split('\n')[0].includes(`→ ${CFG.machine}`))) return; // its acks, reports, items for someone else
  const isBundle = /^agent-hub(-mac)?\.zip$/i.test(doc?.file_name || '');
  state.relayed ??= [];
  // Only what arrives while we're online counts: anything older than 10 min (sent while this hub was down) is dropped,
  // except an update bundle, so a machine that was off still comes back on the newest version.
  if (state.relayed.includes(m.message_id) || (!isBundle && m.date < Date.now() / 1000 - 600)) return;
  state.relayed = [...state.relayed.slice(-200), m.message_id]; save();
  if (r?.kind === 'result') return deliverResult(r.key, r.body);
  if (r) {
    await send(CFG.exchange, undefined, `📥 ${CFG.machine} 收到：@${r.alias} ${r.task.split('\n')[0].slice(0, 80)}`);
    const a = CFG.commandAliases?.[r.alias];
    if (!a || !CFG.groups[String(a.group)]) return send(CFG.exchange, undefined, `⚠️ ${CFG.machine} 不认识 @${r.alias}，没有执行。`);
    return assignToGroup(a.group, r.task, r.from || '另一台电脑', r.replyTo);
  }
  if (/^agent-hub-move-.*\.zip$/i.test(doc.file_name || '')) return receiveMove(m, doc);
  if (isBundle && CFG.selfUpdate) return receiveBundle(m, doc);
}

const PER_HOUR = () => CFG.handoffPerHour ?? 10; // agent-initiated sends per topic per hour; 0 = no limit (tests)
const collabTools = k => [
  tool('ask_choice', '在 Telegram 里给用户弹按钮做选择（比如确认任务交给谁），等用户点完返回所选文字。options 2-6 个，每个简短。',
    { question: z.string(), options: z.array(z.string()).min(2).max(6) },
    async ({ question, options }) => {
      const t = state.topics[k];
      const v = await askButtons(t.chatId, t.threadId, esc(question), options.map(o => [o, o]), true, { choice: true });
      return { content: [{ type: 'text', text: v ? `用户选择：${v}` : '用户没有选择（已取消）' }] };
    }, { alwaysLoad: true }),
  tool('send_to_agent', `把任务派给另一个 agent（可以在另一台电脑上）。agent 填称呼：${Object.keys(CFG.commandAliases || {}).map(x => '@' + x).join('、') || '(none)'}。任务会发到对方群的「圣旨」，由它选好或新建项目话题去做，结果回报到「上朝」群。task 要自成一体：做什么、哪个项目、背景。`,
    { agent: z.string(), task: z.string().min(10) },
    async ({ agent, task }) => {
      const t = state.topics[k];
      const now = Date.now(); t.handoffTimes = (t.handoffTimes || []).filter(x => now - x < 3600e3);
      if (!t.isDispatcher && PER_HOUR() && t.handoffTimes.length >= PER_HOUR()) return { content: [{ type: 'text', text: `这个话题一小时内已经派出 ${PER_HOUR()} 次任务，请先回复用户。` }], isError: true };
      t.handoffTimes.push(now); save();
      const from = t.isCommand ? `上朝·${CFG.machine}` : `「${t.title}」（${groupTitle(t.chatId)}）`;
      return { content: [{ type: 'text', text: await sendToAgent(from, agent, task, t.isDispatcher ? undefined : { machine: CFG.machine, key: k }) }] };
    }, { alwaysLoad: true }),
  tool('open_project', '在 Telegram 里为一个项目目录开话题。fresh=false：接上这个目录最近一次的对话（相当于 continue）；fresh=true：开全新会话，目录不存在会创建。path 可以是绝对路径，或相对默认根目录的路径。ifOpen=fork：该目录最近的会话正在桌面 App 里开着时，复制一份带完整记忆的副本。返回话题链接，要转告用户。',
    { path: z.string(), fresh: z.boolean().optional(), ifOpen: z.enum(['refuse', 'fork']).optional(), group: z.string().optional().describe('在哪个群开：群名或账号名（如 Claude_B_Win、Claude B、Codex）。不填 = 当前群') },
    async ({ path: arg, fresh, ifOpen, group }) => {
      const t = state.topics[k];
      let p; try { p = resolveDir(arg); } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
      if (!p) return { content: [{ type: 'text', text: 'empty path' }], isError: true };
      let chatId = t.chatId, agent = t.agent;
      if (group || t.isCommand) {
        const q = (group || '').toLowerCase();
        const hit = ownGroups().find(([, g]) => q && (g.title.toLowerCase().includes(q) || CFG.agents[g.agent]?.label.toLowerCase().includes(q) || g.agent === q)) || (t.isCommand && !q ? ownGroups()[0] : null);
        if (!hit) return { content: [{ type: 'text', text: `找不到群：${group}。可选：${ownGroups().map(([, g]) => `${g.title}（${CFG.agents[g.agent]?.label}）`).join('、')}` }], isError: true };
        chatId = Number(hit[0]); agent = hit[1].agent;
      }
      if (!fs.existsSync(p)) { if (!fresh) return { content: [{ type: 'text', text: `目录不存在：${p}（新项目请用 fresh=true）` }], isError: true }; fs.mkdirSync(p, { recursive: true }); }
      const r = await openProject(chatId, agent, p, { fresh: !!fresh, ifOpen: ifOpen || 'refuse' });
      return { content: [{ type: 'text', text: `${r.text}${r.link ? '' : '（未打开）'}\n目录：${p}${r.key ? `\nhandoff 时 topic 填：${r.key}` : ''}` }] };
    }, { alwaysLoad: true }),
  tool('list_topics', '列出用户在 Telegram 里的所有项目话题（每个话题是另一个 agent 会话）：key | 群 | 标题 | 目录 | 状态。',
    {}, async () => ({ content: [{ type: 'text', text: topicList() || '(none)' }] }), { alwaysLoad: true }),
  tool('handoff', '把任务或结论交给另一个项目话题里的 agent，对方会自动开始处理。note 要自成一体：目标、背景结论、关键文件、要对方做什么。topic 填 list_topics 里的 key 或标题。',
    { topic: z.string(), note: z.string().min(20) },
    async ({ topic, note }) => {
      const a = state.topics[k];
      const same = Object.keys(state.topics).filter(kk => state.topics[kk].title === topic && !state.topics[kk].closed && !state.topics[kk].isDispatcher);
      if (!state.topics[topic] && same.length > 1) return { content: [{ type: 'text', text: `有 ${same.length} 个话题叫「${topic}」，请改用 key：${same.map(kk => `${kk}（${groupTitle(state.topics[kk].chatId)}）`).join('、')}` }], isError: true };
      const kb = state.topics[topic] ? topic : same[0];
      if (!kb || kb === k) return { content: [{ type: 'text', text: `unknown topic: ${topic}` }], isError: true };
      if ((a.handoffHops || 0) >= 3) return { content: [{ type: 'text', text: '交接链已经传了 3 次，为防止循环不再自动转交。请把结果回复给用户，由用户决定。' }], isError: true };
      const now = Date.now(); a.handoffTimes = (a.handoffTimes || []).filter(x => now - x < 3600e3);
      if (!a.isDispatcher && PER_HOUR() && a.handoffTimes.length >= PER_HOUR()) return { content: [{ type: 'text', text: `这个话题一小时内已经交接 ${PER_HOUR()} 次，请先回复用户。` }], isError: true };
      a.handoffTimes.push(now); save();
      return { content: [{ type: 'text', text: await deliverHandoff(k, kb, note, true) }] };
    }, { alwaysLoad: true }),
];

// ---------- /sync: desktop sidebar sessions -> topics ----------
// Sidebars are copied between the two desktop instances, so each session goes to the account that touched it last.
export function partitionSidebar(byAgent) {
  const best = new Map();
  for (const [agent, rows] of Object.entries(byAgent)) for (const r of rows) {
    const b = best.get(r.cliSessionId);
    if (!b || r.lastActivityAt > b.r.lastActivityAt) best.set(r.cliSessionId, { agent, r });
  }
  const out = {};
  for (const { agent, r } of best.values()) (out[agent] ??= []).push(r);
  for (const a in out) out[a].sort((x, y) => y.lastActivityAt - x.lastActivityAt);
  return out;
}
function readSidebar(dir) {
  const rows = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^local_.*\.json$/.test(e.name)) {
        try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (!j.isArchived && j.cliSessionId && j.cwd) rows.push({ cliSessionId: j.cliSessionId, title: j.title || '', cwd: j.cwd, lastActivityAt: j.lastActivityAt || 0 }); } catch {}
      }
    }
  };
  try { walk(dir.replace(/^~(?=$|[\\/])/, os.homedir())); } catch {}
  return rows;
}
// /sync → pick one from a list; /sync <keyword> → matching titles; /sync all → everything.
async function cmdSync(chatId, g, arg = '') {
  const byAgent = {};
  for (const [a, c] of Object.entries(CFG.agents)) if (c.sidebarDir) byAgent[a] = readSidebar(c.sidebarDir);
  const have = new Set(Object.values(state.topics).map(t => t.sessionId).filter(Boolean));
  const avail = (partitionSidebar(byAgent)[g.agent] || []).filter(r => !have.has(r.cliSessionId) && fs.existsSync(r.cwd));
  if (!avail.length) return send(chatId, undefined, '没有需要同步的会话（侧边栏里的会话都已经有话题了）。');
  const label = r => r.title || path.basename(r.cwd);
  let todo;
  if (arg.toLowerCase() === 'all') todo = avail;
  else if (arg) {
    todo = avail.filter(r => `${label(r)} ${r.cwd}`.toLowerCase().includes(arg.toLowerCase()));
    if (!todo.length) return send(chatId, undefined, `没找到标题或目录包含「${arg}」的会话。发 /sync 看完整列表。`);
  } else {
    const shown = avail.slice(0, 20);
    const pickId = await askButtons(chatId, undefined, `这个账号桌面侧边栏里还没同步的会话（${avail.length} 个，按最近使用排序）。点一个同步成话题：`,
      [...shown.map(r => [label(r), r.cliSessionId]), ['取消', '']], true);
    if (!pickId) return;
    todo = avail.filter(r => r.cliSessionId === pickId);
  }
  if (todo.length > 1) await send(chatId, undefined, `开始同步 ${todo.length} 个会话，每个建一个话题，大约 ${Math.ceil(todo.length * 12 / 60)} 分钟（Telegram 限制每分钟发送条数）…`);
  for (const r of todo) {
    const t = await createTopic(chatId, g.agent, r.cwd, r.cliSessionId, r.title);
    try { const pend = new Map(); for (const m of await getSessionMessages(r.cliSessionId)) noteOutputs(t, m, pend); save(); } catch {}
    await refreshCard(key(chatId, t.threadId)).catch(e => log('card failed', e));
    if (todo.length === 1) await send(chatId, undefined, `✅ 已同步「${t.title}」：${topicLink(chatId, t.threadId)}\n进话题直接发消息就能接着聊。桌面 App 里正开着这个会话的话，要先在桌面关掉。`);
    else await new Promise(res => setTimeout(res, 10000)); // ponytail: fixed pacing under the 20 msg/min group limit
  }
  if (todo.length > 1) await send(chatId, undefined, `✅ 同步完成：${todo.length} 个话题。进话题直接发消息就能接着聊。\n桌面 App 里正开着的会话，要先在桌面关掉才能在这里继续。`);
}

// /mode [ask|auto] — in a project topic: that session; in General: default for this group's topics.
async function cmdMode(chatId, threadId, k, arg) {
  const pick = { ask: 'default', default: 'default', auto: 'auto' };
  let mode = pick[arg.toLowerCase()];
  const scope = k ? `话题「${state.topics[k].title}」` : '本群（没单独设置过的话题）';
  const cur = k ? modeOf(state.topics[k]) : (state.groupModes?.[chatId] || 'auto');
  if (!mode) mode = await askButtons(chatId, threadId, `${esc(scope)}当前模式：<b>${cur === 'default' ? 'ask' : 'auto'}</b>\n选择新模式：`,
    [['🙋 ask：每个操作都问', 'default'], ['⚡ auto：有风险才问', 'auto']]);
  if (!mode) return;
  if (k) {
    const t = state.topics[k]; t.mode = mode; save();
    await live.get(k)?.q.setPermissionMode(mode).catch(e => log('setPermissionMode failed', e));
    refreshCardSoon(k, 500);
  } else {
    state.groupModes ??= {}; state.groupModes[chatId] = mode; save();
    for (const [kk, t] of Object.entries(state.topics)) if (t.chatId === chatId && !t.mode) { await live.get(kk)?.q.setPermissionMode(mode).catch(() => {}); refreshCardSoon(kk, 500); }
  }
  refreshSoon();
  return send(chatId, threadId, `✅ ${scope}已切换为 ${mode === 'default' ? 'ask（每个操作都问）' : 'auto（有风险才问）'}`);
}

// /model [fable|opus|sonnet|haiku|default] — topic: that session; 圣旨: group default for topics without their own choice.
async function cmdModel(chatId, threadId, k, arg) {
  let model = MODELS.find(([l, v]) => v === arg.toLowerCase() || l.toLowerCase() === arg.toLowerCase())?.[1];
  const scope = k ? `话题「${state.topics[k].title}」` : '本群（没单独设置过的话题）';
  const cur = k ? modelOf(state.topics[k]) : state.groupModels?.[chatId];
  if (!model) model = await askButtons(chatId, threadId, `${esc(scope)}当前模型：<b>${esc(modelLabel(cur))}</b>\n选择新模型：`, MODELS, true);
  if (!model) return;
  const apply = async (kk, m) => { const s = live.get(kk); if (s) await s.q.setModel(m === 'default' ? undefined : m).catch(e => log('setModel failed', e)); refreshCardSoon(kk, 1500); };
  if (k) { state.topics[k].model = model; save(); await apply(k, model); }
  else {
    state.groupModels ??= {}; if (model === 'default') delete state.groupModels[chatId]; else state.groupModels[chatId] = model; save();
    for (const [kk, t] of Object.entries(state.topics)) if (t.chatId === chatId && !t.model && !t.isDispatcher) await apply(kk, model);
  }
  refreshSoon();
  return send(chatId, threadId, `✅ ${scope}的模型已切换为 ${modelLabel(model)}${k ? '' : '（「圣旨」调度员自己固定用 Sonnet）'}`);
}

// ---------- inbound messages ----------
async function download(fileId, threadId, name) {
  const f = await bot.api.getFile(fileId);
  if (f.file_size > MAX_DOWN) throw new Error('文件超过 20MB，Telegram 不允许 bot 下载');
  const dir = path.join(INBOX, String(threadId)); fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name || f.file_path || '').replace(/[^.\w]/g, '').slice(0, 8);
  const dest = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
  const r = await fetch(`https://api.telegram.org/file/bot${ENV.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

async function onTopicMessage(ctx, k) {
  const t = state.topics[k], m = ctx.message;
  const content = [];
  const text = m.text || m.caption || '';
  try {
    if (m.photo) {
      const dest = await download(m.photo.at(-1).file_id, t.threadId, 'photo.jpg');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(dest).toString('base64') } });
      content.push({ type: 'text', text: `（图片已保存在 ${dest}）` });
    }
    const doc = m.document || m.video || m.animation || m.audio;
    if (doc) content.push({ type: 'text', text: `用户发来文件：${await download(doc.file_id, t.threadId, doc.file_name)}` });
    if (m.voice || m.video_note) return send(t.chatId, t.threadId, '语音暂不支持，请打字。');
  } catch (e) { return send(t.chatId, t.threadId, `⚠️ ${e.message}`); }
  if (text) content.push({ type: 'text', text });
  if (!content.length) return;
  // A human message starts a fresh chain and a fresh 3-sends budget (relays have no ctx.from, so agents can't reset it).
  if (ctx.from && (t.handoffHops || t.handoffTimes?.length)) { t.handoffHops = 0; t.handoffTimes = []; save(); }
  if (t.closed && !t.deleted) { t.closed = false; save(); }
  if (t.movedTo && ctx.from) { // /move'd away: carrying on here too would fork the conversation
    const v = await askButtons(t.chatId, t.threadId, `这个会话已经搬到 ${esc(t.movedTo)}。在这里继续的话，两边的记录会分叉（以后从 ${esc(t.movedTo)} 搬回来时，这边新增的内容会另存备份）。`,
      [['在这里继续', 'y'], ['不发了', '']]);
    if (!v) return;
    delete t.movedTo; save();
  }
  // An unanswered ask_choice here is superseded by the newer message instead of blocking it forever.
  for (const [id, w] of waits) if (w.choice && w.chatId === t.chatId && w.threadId === t.threadId) finishWait(id, -1, '↪ 没选，按新消息处理');

  let s = live.get(k);
  if (!s) {
    if (t.sessionId && (await externalSessions()).some(r => r.sessionId === t.sessionId))
      return send(t.chatId, t.threadId, '这个会话现在正在桌面 App 或终端里开着，先在电脑上关掉再发。');
    s = live.get(k) || startSession(k); // re-check: a second message (album, quick follow-up) may have started it meanwhile
  }
  if (s.busy || s.queue.length) { s.queue.push(content); return send(t.chatId, t.threadId, `⏳ 已排队（${s.queue.length} 条），/stop 可清空`); }
  startTurn(k, content);
}

// Don't await here: grammY handles updates one at a time, so a handler that waits for a button tap
// would block the callback_query that resolves it (deadlock).
bot.on('message', ctx => { onMessage(ctx).catch(e => log('message handler failed', e)); });
const seenUnknown = new Set();
async function onMessage(ctx) {
  const m = ctx.message, chatId = ctx.chat.id;
  // Closing a topic in Telegram stops its session (frees memory); reopening it marks it open again.
  if (m.forum_topic_closed && m.message_thread_id) return topicGone(chatId, m.message_thread_id, false);
  if (m.forum_topic_reopened && m.message_thread_id) { const t = state.topics[key(chatId, m.message_thread_id)]; if (t) { t.closed = false; save(); } return; }
  // Another hub's bot in 上朝: only the bots listed in config "peerBots" (username or id) are trusted — anything they send
  // can run tasks or install code here, so an unknown bot added to the group is ignored (fail closed).
  if (CFG.commandGroups?.[String(chatId)] && ctx.from?.is_bot && ctx.from.id !== bot.botInfo?.id) {
    if (isPeerBot(ctx.from)) return onPeerMessage(m);
    if (!seenUnknown.has(ctx.from.id)) { seenUnknown.add(ctx.from.id); log('ignored untrusted bot in 上朝', ctx.from.username, ctx.from.id); }
    return;
  }
  if (ctx.from?.id !== OWNER) return;
  if (ctx.chat.type === 'private') {
    if (/^\/status/.test(m.text || '')) return cmdStatus(ctx);
    return ctx.reply('在各个 agent 的群里用 /open、/new 开项目；这里只接收「等你批准」提醒。/status 看全部状态。');
  }
  if (CFG.commandGroups?.[String(chatId)]) { // 上朝: only the machine the message is meant for answers
    const text = m.text || m.caption || '';
    const target = routeMachine(text);
    if (target !== CFG.machine) { // the chief dispatcher speaks up when the addressed machine is offline, instead of silence
      if (CFG.commandDefault !== CFG.machine) return;
      const age = await peerAge(target);
      if (age > PEER_OFFLINE_MIN) send(chatId, undefined, `${offlineNote(target, age)}，这条它收不到，等它回来再发。`);
      return;
    }
    if (m.date < Date.now() / 1000 - STALE_SEC) return send(chatId, undefined, `（${CFG.machine}）这条消息是 ${Math.round((Date.now() / 1000 - m.date) / 60)} 分钟前发的，Hub 当时不在线，需要的话请重发。`);
    const ck = commandKey(chatId), c = /^\/(\w+)(?:@\w+)?/.exec(text);
    if (c?.[1] === 'status') return cmdStatus(ctx);
    if (c?.[1] === 'stop') return cmdStop(ck);
    if (c?.[1] === 'clear') return cmdClear(chatId, undefined, true); // "/clear mac" → the Mac clears its groups
    if (c?.[1] === 'approvals') return cmdApprovals(chatId, undefined, text.slice(c[0].length).trim()); // "/approvals on mac" → the Mac
    const a = parseAlias(text); // named ("@a …"): straight to that group's 圣旨, no 上朝 AI in between
    if (a && a.rest.trim() && CFG.groups[String(a.group)] && !m.photo && !m.document) {
      await assignToGroup(a.group, a.rest, `你点名 @${a.alias}`);
      return send(chatId, undefined, `📨 已交给 @${a.alias}（${CFG.groups[String(a.group)].title} 的圣旨），它会选好项目话题去做，结果回报到这里。`);
    }
    return onTopicMessage(ctx, ck);
  }
  const g = CFG.groups[String(chatId)];
  if (!g && !CFG.commandGroups?.[String(chatId)] && !seenUnknown.has(chatId)) { // a group we were added to but don't know yet
    seenUnknown.add(chatId);
    log('unknown group', chatId, ctx.chat.title);
    bot.api.sendMessage(OWNER, `👋 ${CFG.machine} 的 bot 在一个还没配置的群里收到了消息：「${ctx.chat.title}」（id ${chatId}）。`).catch(() => {});
  }
  if (!g || g.owner === 'mac-hub') return;
  if (m.date < Date.now() / 1000 - STALE_SEC) return send(chatId, m.message_thread_id, `这条消息是 ${Math.round((Date.now() / 1000 - m.date) / 60)} 分钟前发的，Hub 当时不在线。需要的话请重发。`);
  const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(m.text || '');
  const threadId = m.is_topic_message ? m.message_thread_id : undefined;
  const k = threadId && key(chatId, threadId);
  if (cmd?.[1] === 'status') return cmdStatus(ctx);
  if (cmd?.[1] === 'mode') return cmdMode(chatId, threadId, k && state.topics[k] ? k : null, cmd[2].trim());
  if (cmd?.[1] === 'model') return cmdModel(chatId, threadId, k && state.topics[k] ? k : null, cmd[2].trim());
  if (cmd?.[1] === 'account' && k && state.topics[k]) return cmdAccount(k, cmd[2].trim());
  if (cmd?.[1] === 'sync') return cmdSync(chatId, g, cmd[2].trim());
  if (cmd?.[1] === 'approvals') return cmdApprovals(chatId, threadId, cmd[2].trim());
  if (cmd?.[1] === 'clear' && !threadId) return cmdClear(chatId, undefined, false);
  if (cmd && ['open', 'new'].includes(cmd[1])) return cmdOpen(ctx, g, cmd[2], cmd[1] === 'new').catch(e => send(chatId, undefined, `⚠️ ${e.message}`));
  if (cmd?.[1] === 'start') return send(chatId, threadId, '在「圣旨」里直接说你要做什么（比如“继续做 my-app”“新建一个项目 xxx”），或用 /open <目录> 接上已有项目，/new <目录> 开新项目。话题里直接发消息就是跟 agent 对话。\n/mode 切换 ask（每个操作都问）/ auto（有风险才问）；/model 切换模型；/account 换账号继续（额度快满时用）；/stop 停止当前这一轮；/get <路径> 取文件；/status 看状态。\n/sync 把桌面侧边栏的会话同步成话题；/fork 带完整记忆复制到新话题（可换账号）；/handoff 把结论交给另一个话题；/move mac 把会话搬到另一台电脑（加 code 连代码一起带）；/approvals on|off 把这台电脑桌面 App 的权限请求推到手机；/clear（在圣旨里）清空本群消息和话题（记忆保留）。');
  if (!k) { // 「圣旨」(General): plain requests go to the dispatcher agent
    const dk = dispatcherKey(chatId, g);
    if (cmd?.[1] === 'stop') return cmdStop(dk);
    return cmd ? send(chatId, undefined, '不认识的命令。直接用中文说你要做什么就行，或发 /start 看命令列表。') : onTopicMessage(ctx, dk);
  }
  if (!state.topics[k]) return send(chatId, threadId, '这个话题不是 Hub 开的。在「圣旨」里说你要做什么，或用 /open <目录>、/new <目录> 开一个。');
  if (cmd?.[1] === 'stop') return cmdStop(k);
  if (cmd?.[1] === 'fork') return cmdFork(k);
  if (cmd?.[1] === 'move') return cmdMove(k, cmd[2].trim()).catch(e => send(chatId, threadId, `⚠️ /move 失败：${e.message}`));
  if (cmd?.[1] === 'handoff') return cmdHandoff(k);
  if (cmd?.[1] === 'get') {
    const t = state.topics[k];
    return sendFileTo(t, cmd[2].trim(), undefined, true).catch(e => send(chatId, threadId, `⚠️ ${e.message}`));
  }
  return onTopicMessage(ctx, k);
}

bot.catch(err => log('update error', err.error || err));

// ---------- pinned usage panels ----------
// Claude plan limits need a full `claude auth login` (setup-tokens can't read them): agents[x].usageConfigDir,
// null = the default ~/.claude login. Codex limits come from `codex app-server` account/rateLimits/read.
const TZ = () => CFG.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtHM = d => new Date(d).toLocaleTimeString('zh-CN', { timeZone: TZ(), hour12: false, hour: '2-digit', minute: '2-digit' });
// "15:19" within a day, else "Sun Oct 18 16:59"
const fmtWhen = d => { const t = new Date(d); if (t - Date.now() < 86400e3) return fmtHM(t);
  return `${t.toLocaleDateString('en-US', { timeZone: TZ(), weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')} ${fmtHM(t)}`; };
export const bar = p => { const n = Math.max(0, Math.min(10, Math.round((p ?? 0) / 10))); return '▓'.repeat(n) + '░'.repeat(10 - n); };
const limitLine = (label, p, reset) => p == null ? null : `${label} ${bar(p)} ${String(Math.round(p)).padStart(3)}%${reset ? ` · resets ${fmtWhen(reset)}` : ''}`;

// The usage endpoint throttles hard: fetch at most every USAGE_TTL per account, keep the last good answer,
// and fall back to the CLI's own cache (cachedUsageUtilization in that login's .claude.json).
const USAGE_TTL = 15 * 60 * 1000;
const usageCache = {};
function cliUsageCache(a) {
  try {
    const f = a.usageConfigDir ? path.join(a.usageConfigDir.replace(/^~(?=$|[\\/])/, os.homedir()), '.claude.json') : path.join(os.homedir(), '.claude.json');
    const c = JSON.parse(fs.readFileSync(f, 'utf8')).cachedUsageUtilization;
    return c?.utilization ? { rate_limits: c.utilization, at: c.fetchedAtMs } : null;
  } catch { return null; }
}
async function claudeUsage(agent) {
  const a = CFG.agents[agent];
  if (!('usageConfigDir' in a)) return { error: '未配置用量读取（需要该账号的完整登录）' };
  const c = usageCache[agent];
  if (c && Date.now() - (c.retryAt || c.at) < USAGE_TTL) return c.retryAt ? { ...c, stale: true } : c;
  const env = agentEnv(agent); delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (a.usageConfigDir) env.CLAUDE_CONFIG_DIR = a.usageConfigDir;
  async function* idle() { await new Promise(() => {}); }
  const q = query({ prompt: idle(), options: { cwd: HOME, env } });
  let u = null;
  try { u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), new Promise((_, r) => setTimeout(() => r(new Error('超时')), 60000))]); }
  catch (e) { log('usage fetch failed', agent, e.message); } finally { q.close(); }
  if (u?.rate_limits) return (usageCache[agent] = { rate_limits: u.rate_limits, at: Date.now() });
  const fallback = [c, cliUsageCache(a)].filter(Boolean).sort((x, y) => y.at - x.at)[0];
  if (fallback) usageCache[agent] = { ...fallback, retryAt: Date.now() }; // don't hammer the endpoint while it refuses
  return fallback ? { ...fallback, stale: true } : { error: 'unavailable' };
}

async function codexUsage() {
  const { spawn } = await import('node:child_process');
  const exe = codexExe();
  if (process.platform === 'win32' && !fs.existsSync(exe)) return { error: '找不到 codex.exe' };
  const p = spawn(exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', id = 0; const waiters = {};
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters[m.id]?.(m); } catch {} } });
  const call = (method, params) => new Promise((res, rej) => { const i = ++id; waiters[i] = res; setTimeout(() => rej(new Error('超时')), 30000); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  try {
    await call('initialize', { clientInfo: { name: 'agent-hub', version: '0.1' } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const r = await call('account/rateLimits/read', {});
    return r.result || { error: r.error?.message || 'unknown' };
  } catch (e) { return { error: e.message }; } finally { p.kill(); }
}

// Only the 5-hour and weekly windows (plus Codex reset coupons). The pinned bar shows line 1.
export function claudeLimits(u) {
  const r = u?.rate_limits;
  if (u?.error || !r) return ['⚠️ Usage unavailable'];
  // A window that has already reset reads as 0%, not the stale number.
  const w = x => x && x.resets_at && new Date(x.resets_at) < new Date() ? { utilization: 0 } : x;
  const L = [limitLine('⏱ 5h  ', w(r.five_hour)?.utilization ?? 0, w(r.five_hour)?.resets_at), limitLine('📅 Week', w(r.seven_day)?.utilization, w(r.seven_day)?.resets_at)].filter(Boolean);
  if (u.stale && u.at && Date.now() - u.at > USAGE_TTL) L.push(`🕒 as of ${fmtHM(u.at)}`);
  return L;
}
export function codexLimits(u) {
  const r = u?.rateLimits;
  if (u?.error || !r) return ['⚠️ Usage unavailable'];
  const L = [r.primary, r.secondary].filter(Boolean).map(w => limitLine(w.windowDurationMins >= 10080 ? '📅 Week' : '⏱ 5h  ', w.usedPercent, w.resetsAt * 1000));
  const coupons = (u.rateLimitResetCredits?.credits || []).filter(c => c.status === 'available');
  if (coupons.length) L.push(`🎟 Reset credits: ${coupons.length} (expire ${fmtWhen(coupons[0].expiresAt * 1000)})`);
  return L;
}
function sessionCounts(chatId) {
  const c = { run: 0, wait: 0, idle: 0, off: 0 };
  for (const [k, t] of Object.entries(state.topics)) {
    if ((chatId && String(t.chatId) !== String(chatId)) || t.closed || t.isDispatcher) continue;
    const s = live.get(k);
    if (!s) c.off++; else if (s.waiting) c.wait++; else if (s.busy) c.run++; else c.idle++;
  }
  return c;
}
export const countsText = c => `👥 Sessions: 🟢 ${c.run} running · 🟡 ${c.wait} waiting · ⚪ ${c.idle} idle · 💤 ${c.off} off`;

const pinnedThisRun = new Set(); // re-pin existing panels once per start (an earlier pin may have failed or been displaced)
async function upsertPanel(chatId, text) {
  state.panels ??= {};
  const p = state.panels[chatId];
  if (p?.msgId && !pinnedThisRun.has(chatId)) {
    const ok = await bot.api.pinChatMessage(Number(chatId), p.msgId, { disable_notification: true }).then(() => true, e => { log('re-pin failed', e.description || e.message); return false; });
    if (ok) pinnedThisRun.add(chatId);
  }
  if (p?.text === text) return;
  if (p?.msgId) {
    const ok = await bot.api.editMessageText(Number(chatId), p.msgId, text).then(() => true, e => /not modified/.test(e.description || ''));
    if (ok) { p.text = text; save(); return; }
  }
  const m = await bot.api.sendMessage(Number(chatId), text, { disable_notification: true }).catch(e => log('panel send failed', e.description || e.message));
  if (!m) return;
  await bot.api.pinChatMessage(Number(chatId), m.message_id, { disable_notification: true }).catch(e => log('pin failed', e.description || e.message));
  state.panels[chatId] = { msgId: m.message_id, text }; save();
}

let panelBusy = false;
async function refreshPanels() {
  if (panelBusy) return; panelBusy = true;
  try {
    const rows = [];
    for (const [chatId, g] of Object.entries(CFG.groups)) {
      if (g.owner === 'mac-hub') continue;
      const a = CFG.agents[g.agent];
      const usage = a.type === 'claude' ? await claudeUsage(g.agent) : await codexUsage();
      if (a.type === 'claude') checkUsageAlert(g.agent, usage);
      const limits = a.type === 'claude' ? claudeLimits(usage) : codexLimits(usage);
      await upsertPanel(chatId, [...limits, '', countsText(sessionCounts(chatId)), modelLine(state.groupModels?.[chatId]), modeLine(state.groupModes?.[chatId] || 'auto')].join('\n'));
      rows.push(...(rows.length ? [''] : []), `[${a.label}]`, ...limits);
    }
    await upsertPanel(String(OWNER), [...rows, '', countsText(sessionCounts(null)), `🖥 Desktop/terminal sessions: ${(await externalSessions()).length}`].join('\n'));
  } catch (e) { log('panel refresh failed', e); } finally { panelBusy = false; }
}
let panelTimer = null;
const refreshSoon = () => { clearTimeout(panelTimer); panelTimer = setTimeout(refreshPanels, 20000); };

// ---------- desktop / terminal permission prompts → phone (Claude Code PermissionRequest HTTP hook) ----------
// Loopback only, bearer token from .env (HUB_HOOK_TOKEN). Hub-owned sessions are skipped (their prompts already go to topics).
// No answer within HOOK_WAIT → return no decision, so the normal prompt on the computer takes over.
const HOOK_WAIT = 280e3;
export function hookDecision(v) {
  if (v === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (v === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '用户在 Telegram 上拒绝了这个操作。' } } };
  return {};
}
async function onDesktopPermission(req) {
  if (Object.values(state.topics).some(t => t.sessionId && t.sessionId === req.session_id)) return {};
  const where = `${path.basename(req.cwd || '') || '?'} · ${String(req.session_id || '').slice(0, 8)}`;
  let timer;
  const p = askButtons(OWNER, undefined, `🖥 <b>桌面会话请求权限</b> · ${esc(where)}\n🔐 <b>${esc(req.tool_name)}</b>\n${renderTool(req.tool_name, req.tool_input || {})}`, [['✅ 允许一次', 'allow'], ['❌ 拒绝', 'deny']]);
  const timeout = new Promise(res => { timer = setTimeout(() => {
    for (const [id, w] of waits) if (w.chatId === OWNER && w.html.includes(esc(where))) finishWait(id, -1, '⌛ 已超时，请回电脑上处理');
    res(null);
  }, HOOK_WAIT); });
  const v = await Promise.race([p, timeout]);
  clearTimeout(timer);
  return hookDecision(v);
}
// /clear — wipes chat clutter: deletes the hub's topics in a group and every other message there except the pinned
// usage panel. Sessions and memory stay on disk (/open resumes them). Bots can't list history, so this deletes by
// message id up to a fresh probe message; Telegram only lets bots delete messages younger than 48 h.
export async function clearGroup(chatId) {
  for (const [k, t] of Object.entries(state.topics)) if (String(t.chatId) === String(chatId)) {
    const s = live.get(k); if (s) { try { s.q.close(); } catch {} live.delete(k); }
    if (t.threadId) await bot.api.deleteForumTopic(chatId, t.threadId).catch(() => {});
    delete state.topics[k];
  }
  save();
  const keep = new Set([state.panels?.[String(chatId)]?.msgId].filter(Boolean));
  const probe = await bot.api.sendMessage(chatId, '🧹', { disable_notification: true });
  for (let hi = probe.message_id; hi > 0; hi -= 100) {
    const ids = []; for (let i = Math.max(1, hi - 99); i <= hi; i++) if (!keep.has(i)) ids.push(i);
    // one undeletable message (e.g. "group created") fails the whole batch → fall back to one by one
    await bot.api.deleteMessages(chatId, ids).catch(async () => { for (const i of ids) await bot.api.deleteMessage(chatId, i).catch(() => {}); });
  }
}
// All of this machine's agent groups, plus 上朝 on the machine that runs the chief dispatcher.
async function clearOwnGroups() {
  for (const [id] of ownGroups()) await clearGroup(id).catch(e => log('clear failed', id, e.message));
  if (CFG.exchange && CFG.commandDefault === CFG.machine) await clearGroup(CFG.exchange).catch(e => log('clear failed', e.message));
  refreshPanels();
}
async function cmdClear(chatId, threadId, everything) {
  const v = await askButtons(chatId, threadId, everything ? `🧹 清空 ${esc(CFG.machine)} 所有群的消息和话题？（用量面板保留；对话记忆不丢，/open 能接上）`
    : '🧹 清空本群所有话题和消息？（用量面板保留；对话记忆不丢，/open 能接上）', [['🧹 清空', 'y'], ['取消', '']]);
  if (v === 'y') return everything ? clearOwnGroups() : clearGroup(chatId);
}
// /approvals on|off — adds/removes the PermissionRequest HTTP hook in this machine's ~/.claude/settings.json (backup first),
// creating HUB_HOOK_TOKEN on first use. Same thing enable-desktop-approvals.ps1 does, but from Telegram.
async function cmdApprovals(chatId, threadId, arg) {
  const on = !/^off|关/.test(arg || '');
  if (on && !ENV.HUB_HOOK_TOKEN) {
    ENV.HUB_HOOK_TOKEN = crypto.randomBytes(24).toString('hex');
    fs.appendFileSync(path.join(HOME, '.env'), `\nHUB_HOOK_TOKEN=${ENV.HUB_HOOK_TOKEN}\n`);
    startHookServer();
  }
  const f = path.join(os.homedir(), '.claude', 'settings.json'), url = `http://127.0.0.1:${CFG.hookPort || 7788}/permission`;
  const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) : {};
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${Date.now()}`);
  j.hooks ??= {};
  const rest = (j.hooks.PermissionRequest || []).filter(e => !(e.hooks || []).some(h => h.url === url));
  j.hooks.PermissionRequest = on ? [...rest, { hooks: [{ type: 'http', url, headers: { Authorization: `Bearer ${ENV.HUB_HOOK_TOKEN}` }, timeout: 300 }] }] : rest;
  if (!j.hooks.PermissionRequest.length) delete j.hooks.PermissionRequest;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  return send(chatId, threadId, on ? `✅ ${CFG.machine}：桌面 App / 终端会话的权限请求会推到你的私聊（5 分钟没点就回电脑上处理）。新开的会话生效。/approvals off 关闭。` : `✅ ${CFG.machine}：已关闭，桌面会话的权限请求回到电脑上处理。`);
}
function startHookServer() {
  if (!ENV.HUB_HOOK_TOKEN) return;
  import('node:http').then(({ createServer }) => createServer((rq, rs) => {
    if (rq.method !== 'POST' || rq.url !== '/permission' || rq.headers.authorization !== `Bearer ${ENV.HUB_HOOK_TOKEN}`) { rs.writeHead(403).end(); return; }
    let body = '';
    rq.on('data', d => { body += d; if (body.length > 1e6) rq.destroy(); });
    rq.on('end', async () => {
      let out = {};
      try { out = await onDesktopPermission(JSON.parse(body)); } catch (e) { log('hook failed', e); }
      rs.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  }).listen(CFG.hookPort || 7788, '127.0.0.1', () => log(`permission hook listening on 127.0.0.1:${CFG.hookPort || 7788}`)));
}

// ---------- health: watchdog, heartbeat, peer-hub monitoring ----------
// Heartbeat = this hub's groups' description; the other machine's bot reads it with getChat (config "watch").
const HB_RE = /\(([0-9T:.\-]+Z)\)/;
// Version = fingerprint of this hub.mjs, so the other machine can see whether a self-update actually landed.
export const HUB_VERSION = crypto.createHash('sha1').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 7);
// In the shared exchange group (上朝) each machine owns one line of the description; we rewrite only ours.
export function mergeHeartbeat(desc, machine, line) {
  const rest = String(desc || '').split('\n').filter(l => HB_RE.test(l) && !l.includes(` ${machine} Hub `)); // hubs own the description (255-char limit)
  return [...rest, line].sort().join('\n');
}
async function heartbeat() {
  const txt = `🟢 ${CFG.machine} Hub online · ${fmtHM(Date.now())} · v${HUB_VERSION} (${new Date().toISOString()})`;
  const set = (chatId, d) => bot.api.setChatDescription(Number(chatId), d).catch(e => /not modified/.test(e.description || '') || log('heartbeat failed', e.description || e.message));
  for (const [chatId, g] of Object.entries(CFG.groups)) if (g.owner !== 'mac-hub') await set(chatId, txt);
  if (!CFG.exchange) return;
  // Both hubs read-modify-write the same description; re-check once so a simultaneous write by the other one doesn't drop our line.
  const desc = () => bot.api.getChat(CFG.exchange).then(c => c.description || '', () => '');
  await set(CFG.exchange, mergeHeartbeat(await desc(), CFG.machine, txt));
  await new Promise(r => setTimeout(r, 5000));
  const now = await desc(); if (!now.includes(txt)) await set(CFG.exchange, mergeHeartbeat(now, CFG.machine, txt));
}
const peerDown = {};
// Age in minutes of a heartbeat line (the one for `machine` if given) inside a description.
export const peerAgeMin = (desc, now = Date.now(), machine) => {
  const line = machine ? String(desc || '').split('\n').find(l => l.includes(` ${machine} Hub `)) : desc;
  const at = Date.parse(HB_RE.exec(line || '')?.[1] || ''); return at ? (now - at) / 60000 : Infinity;
};
async function watchPeers() {
  for (const w of CFG.watch || []) {
    const desc = await bot.api.getChat(w.chatId || CFG.exchange).then(c => c.description || '', () => '');
    const age = peerAgeMin(desc, Date.now(), w.machine), down = age > 30;
    if (!Number.isFinite(age)) continue; // never came online yet → nothing to report
    if (down === !!peerDown[w.label]) continue;
    peerDown[w.label] = down;
    await bot.api.sendMessage(OWNER, down
      ? `⚠️ ${w.label} ${Number.isFinite(age) ? `已经 ${Math.round(age)} 分钟` : '一直'}没有心跳（那台电脑可能关机、睡眠或断网）。恢复后会再通知你。`
      : `✅ ${w.label} 恢复在线。`).catch(() => {});
  }
}

// ---------- self-update from a bundle the Windows hub posts in 上朝 (config selfUpdate=true, i.e. the Mac) ----------
const BUNDLE_FILES = ['hub.mjs', 'package.json', 'package-lock.json', 'config.json'];
async function receiveBundle(m, doc) {
  if (doc.file_unique_id === state.lastBundle || m.date <= (state.lastBundleAt || 0)) return; // already installed, or older than it
  const v = await askOwner(`🔄 收到 ${esc(CFG.machine)} Hub 更新包：${esc(m.caption || doc.file_name)}（${Math.round((doc.file_size || 0) / 1024)} KB）。安装吗？`, [['✅ 安装', 'y'], ['❌ 不装', 'n']]);
  if (v === 'y') return installBundle(m, doc);
}
async function installBundle(pm, doc) {
    log('self-update: new bundle', doc.file_name, doc.file_unique_id);
    state.lastBundle = doc.file_unique_id; state.lastBundleAt = pm.date; save(); // at most once; failures are reported below
    const fail = async why => { log('self-update failed', why); await bot.api.sendMessage(OWNER, `⚠️ ${CFG.machine} Hub 更新失败，已保持原版本：${String(why).slice(0, 300)}`).catch(() => {}); };
    const dir = path.join(os.tmpdir(), `agent-hub-update-${Date.now()}`), prev = path.join(HOME, 'prev');
    try {
      const zip = await download(doc.file_id, 'update', doc.file_name);
      fs.mkdirSync(dir, { recursive: true });
      await execFileP(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32' ? ['-xf', zip, '-C', dir] : ['-o', '-q', zip, '-d', dir]);
      assertNoLinks(dir);
      const missing = BUNDLE_FILES.filter(f => !fs.existsSync(path.join(dir, f)));
      if (missing.length) return fail(`安装包缺文件：${missing.join(', ')}`);
      if (JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).machine !== CFG.machine) return fail('安装包里的 config.json 不是这台电脑的');
      await execFileP(process.execPath, ['--check', path.join(dir, 'hub.mjs')]);
    } catch (e) { return fail(e.message); }
    fs.mkdirSync(prev, { recursive: true });
    for (const f of BUNDLE_FILES) fs.copyFileSync(path.join(HOME, f), path.join(prev, f));
    const lockSame = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8') === fs.readFileSync(path.join(HOME, 'package-lock.json'), 'utf8');
    const npmCi = () => execFileP('npm', ['ci', '--no-audit', '--no-fund'], { cwd: HOME, timeout: 600000, shell: process.platform === 'win32' });
    for (const f of BUNDLE_FILES) fs.copyFileSync(path.join(dir, f), path.join(HOME, f)); // .env, state.json, logins untouched
    if (!lockSame) try { await npmCi(); } catch (e) { // roll back to the files (and dependencies) we were running
      for (const f of BUNDLE_FILES) fs.copyFileSync(path.join(prev, f), path.join(HOME, f));
      await npmCi().catch(e2 => log('rollback npm ci failed', e2.message));
      return fail(`npm ci：${e.message}`);
    }
    state.verifyUpdate = true; state.updateBoots = 0; save();
    await bot.api.sendMessage(OWNER, `🔄 ${CFG.machine} Hub 已从置顶安装包更新，空闲时自动重启生效。`).catch(() => {});
    return restartWhenIdle('self-update');
}
// Restarts (exit → Task Scheduler / launchd starts us again) only once no turn is running or waiting for a tap.
// Deploys ask for it by creating RESTART_FLAG instead of killing the process mid-turn.
const RESTART_FLAG = path.join(HOME, 'restart.flag');
function restartWhenIdle(why) {
  if ([...live.values()].some(s => s.busy || s.waiting || s.queue.length)) return setTimeout(() => restartWhenIdle(why), 30e3);
  log(`restarting (${why})`); process.exit(1);
}

// ---------- daily self-update (update.mjs: Claude Agent SDK + bundled claude binary, with smoke test and rollback) ----------
async function dailyUpdate() {
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ(), hour: '2-digit', hour12: false }));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ() });
  if (hour !== (CFG.updateHour ?? 4) || state.lastUpdateCheck === today) return;
  state.lastUpdateCheck = today; save();
  const out = await new Promise(res => execFile(process.execPath, [path.join(HOME, 'update.mjs')], { cwd: HOME, windowsHide: true, timeout: 900000 }, (e, so) => res(String(so || e?.message || '').trim().split('\n').pop())));
  log('daily update:', out);
  if (out.startsWith('rolled-back')) return bot.api.sendMessage(OWNER, `⚠️ Hub 自动更新失败，已退回原版本：${out}`).catch(() => {});
  if (!out.startsWith('updated')) return;
  await bot.api.sendMessage(OWNER, `🔄 Hub 的 Claude 已自动更新（${out.replace('updated ', '')}），没有任务在跑时会自动重启生效。`).catch(() => {});
  restartWhenIdle('SDK update');
}

// ---------- startup ----------
if (IS_MAIN) {
  setInterval(() => dailyUpdate().catch(e => log('update failed', e)), 20 * 60e3);
  // Watchdog: if long polling silently stalls (sleep, dead socket), exit so Task Scheduler / launchd restarts us.
  let lastTick = Date.now();
  setInterval(() => {
    const slept = Date.now() - lastTick > 2 * 60e3; lastTick = Date.now();
    if (slept) { log('woke from sleep'); lastPollOk = Date.now(); return; } // the machine slept: give polling a chance before killing ourselves
    if (Date.now() - lastPollOk > 3 * 60e3) { log('watchdog: polling stalled > 3 min, exiting for restart'); process.exit(1); }
  }, 60e3);
  fs.mkdirSync(rootsAbsFirst(), { recursive: true }); // dispatchers run in the default root (e.g. ~/workspace on a fresh Mac)
  // macOS: keep the machine from idle-sleeping while the hub runs (a closed laptop lid still sleeps).
  if (process.platform === 'darwin' && CFG.keepAwake !== false) childProcess.spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});
  process.on('unhandledRejection', e => log('unhandledRejection', e));
  startHookServer();
  setInterval(() => heartbeat().then(watchPeers).catch(e => log('health failed', e)), 5 * 60e3);
  setInterval(resumeDueTopics, 60e3);
  let restartAsked = false;
  setInterval(() => { if (!restartAsked && fs.existsSync(RESTART_FLAG)) { restartAsked = true; fs.rmSync(RESTART_FLAG, { force: true }); restartWhenIdle('requested'); } }, 10e3);
  for (const [chatId, msgId] of state.pendingMsgs) bot.api.editMessageReplyMarkup(chatId, msgId, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  state.pendingMsgs = [];
  // Turns cut off by a crash / power loss / reboot continue by themselves (once: a turn that keeps killing the hub doesn't loop).
  const interrupted = Object.entries(state.topics).filter(([, t]) => t.busy).map(([k]) => k);
  for (const k of interrupted) state.topics[k].busy = false;
  save();
  process.on('exit', () => { try { if (fs.readFileSync(PID, 'utf8') === String(process.pid)) fs.unlinkSync(PID); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  bot.start({ allowed_updates: ['message', 'callback_query'], onStart: me => {
    log(`hub started as @${me.username} v${HUB_VERSION}`); refreshPanels(); heartbeat().then(() => setTimeout(watchPeers, 60e3));
    if (state.rolledBack) { state.rolledBack = false; save(); bot.api.sendMessage(OWNER, `⚠️ ${CFG.machine} Hub 的新版本反复启动失败，已自动退回上一个版本（v${HUB_VERSION}）。`).catch(() => {}); }
    setTimeout(() => { if (state.verifyUpdate) { state.verifyUpdate = false; state.updateBoots = 0; save(); } }, 120e3);
    for (const k of interrupted) {
      const t = state.topics[k];
      if (t.autoResumed) { delete t.autoResumed; save(); send(t.chatId, t.threadId, '⚠️ Hub 重启过，这一轮又被打断了，不再自动继续。需要的话请重发。'); continue; }
      t.autoResumed = true; save();
      send(t.chatId, t.threadId, '⚠️ Hub 重启过，接着刚才的任务继续做。')
        .then(() => feed(k, Object.assign([{ type: 'text', text: 'Hub 刚才重启，你上一轮被打断了。接着把没做完的做完（已经做完的部分不要重做）。' }], t.turnMeta || {})))
        .catch(e => log('auto-resume failed', k, e));
    }
  } });
  setInterval(refreshPanels, 5 * 60 * 1000); // session counts; Claude usage itself is cached for USAGE_TTL
}
