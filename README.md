# Telegram Agent Hub

Run all your AI coding agents from Telegram — several Claude Code subscription accounts, Codex, on more than one computer — with the same reach as sitting at the desk: chat with any project session, approve risky actions with a button, open or resume projects, see usage at a glance, and let agents hand work to each other.

[中文说明（完整规则）](README.zh-CN.md)

```
                    ┌─────────────── Telegram ────────────────┐
 you (phone) ──────▶│ 上朝 (command group): assign work,       │
                    │   results come back here                 │
                    │ Claude_A_Win  ─ 圣旨 (dispatcher)         │
                    │   ├ topic: project-x  ← one session each │
                    │   └ topic: project-y                     │
                    │ Claude_B_Win / Codex_Win / Claude_Mac …  │
                    └───────▲──────────────────────▲───────────┘
                            │ bot (Windows)        │ bot (Mac)
                    ┌───────┴────────┐     ┌───────┴────────┐
                    │ hub.mjs        │     │ hub.mjs        │
                    │ Claude Agent   │     │ Claude Agent   │
                    │ SDK + Codex    │     │ SDK            │
                    └────────────────┘     └────────────────┘
```

One hub process and one bot per computer. One Telegram forum group per agent account; each topic in it is one project session; the group's General topic (「圣旨」) is a small dispatcher agent you talk to in plain language. A shared command group (「上朝」) connects everything: you assign work there, and the hubs exchange tasks, results, moved sessions and updates there.

## Features

**Chat and files**
- Two-way chat per project topic (live progress message only with `progressMessage: true`; the topic's status mark shows it), pinned session card (folder, context %, the account's 5-hour and weekly limits, model, effort, mode).
- Agent replies are rendered from Markdown (bold, code blocks with language, links, lists, quotes; tables as monospace). Long replies are split without breaking code blocks; a chunk Telegram rejects is resent as plain text.
- Phone → agent: photos and albums (collected for 1.5 s into one message), images sent as files (≤ 5 MB, ≤ 8000 px) and PDFs (≤ 10 MB, ≤ 100 pages, Claude only) go to the agent directly; anything else is saved in `inbox/` and passed as a path.
- Agent → phone: the `send_file` tool and `/get <path>` work for any file on the machine (folders are zipped); the hub's own folder and secret-looking files (`.env`, keys, `auth.json`, dotfiles …) are refused.
- Automatic file sync: after each turn, the files the agent itself wrote or edited with its tools (not what tests, builds or scripts left on disk; it sends those with send_file when they matter) (images, PDF, Office, csv, media, html, zip, txt, md) are sent to the topic — up to 3 directly, the rest behind buttons. `autoSendFiles: false` turns it off.
- Per-turn change summary for git projects (「📝 N files +a −b」, via a temporary index — your staging area is never touched); `/diff` sends the full diff of the last turn, secret files masked.
- Steering: a message sent while the agent is working goes straight into the running turn (Claude: `priority: 'next'`, read after the current step; Codex: `turn/steer`) — 「💬 已插话」 instead of queuing. `/stop` still interrupts at once; hub-fed work (handoffs, relays) still queues.
- Memory takeover: if a project's latest session is open in the desktop app, the topic continues from a copy with the full memory (marked ⑂) instead of asking; an existing topic whose session is open on the desktop offers 「📋 复制一份在这里继续」. Topics started from an existing conversation show 「📜 之前的对话」 (the last few exchanges, collapsed); `/history [n]` sends up to 50 as a Markdown file.
- Topic status: every topic name carries a mark, 🟡 working (here, or in the desktop app / a terminal), 🔴 waiting for you (a permission or option card), 🔵 the turn ended but background tasks still run (it wakes up when they finish), 🟢 idle; desktop activity is checked every 30 s. The "renamed" service line is deleted, only the newest "renamed" service line stays per topic (clients take the new name from it), topics get one plain 💻 icon (`topicIcon`) instead of coloured letters, and there is no "⏳ in progress" message (`progressMessage: true` brings it back). Rename a topic in Telegram and the hub keeps your name, changing only the mark. `topicStatus: false` turns it off.
- Sessions open in the desktop app can go on in Telegram too: no copy prompt, the same session continues (silently); busy there → 「⏳」 and it runs once that turn ends (6 h max). Limitation: the app continues from the last message it knows, so it never shows the Telegram turns and the two sides branch. Memory is bridged: your next desktop prompt in that session first gets a "meanwhile in Telegram" background note (needs `/approvals on` on that machine, then one restart of the desktop app), and when the topic resumes after the desktop wrote, the hub adds the Telegram turns that branch lacks. Only sessions the desktop app runs: ones open in a terminal or running as background agents still get the copy button.
- Desktop → topic sync: when you keep chatting with a topic's session in the desktop app / terminal, each finished exchange (your message + the final reply) is posted to the topic as 「🖥 桌面：」, silently, with the pictures and files it sent you there; replies a session gives on its own after a background task finishes are posted too. More than 3 at once → one line pointing to `/history`. Nothing older than the binding is backfilled. Claude project topics only.
- New desktop sessions get a topic by themselves: a session you create or use in the desktop app (after the feature's first run; ones untouched since stay out) gets a topic of the same name in its account's group once the app has titled it, bound to the session itself (not a copy), so its turns keep syncing as above. A topic you delete is not recreated; renaming a session on the desktop renames its topic. Sidebar sections have no Telegram counterpart (topics can't be grouped and bots can't create groups). `autoSync: false` in config turns it off.
- Notices and approval cards go to 上朝, never the bot DM (the DM is only a fallback when 上朝 isn't configured or posting fails); plain notices are silent, and successes (an update installed and the like) are not posted at all. Topic card pins are silent too, since Telegram notifies pins even in muted groups.
- `/screen [n]` screenshots this machine's desktop; `/shot <url|port> [width]` screenshots a web page with the installed Edge/Chrome in headless mode. Owner only, no AI, no quota; in 上朝 `/screen mac` asks the Mac.

**Projects and sessions**
- `/open <dir>` resumes the folder's latest conversation, `/new <dir>` starts one, or tell 圣旨 "continue project X". New tasks get their own folder under the workspace root, so every topic is named after its project. `/sync` brings desktop-app sessions in as topics. Deleting a topic never deletes memory.
- A session is never driven by two topics at once (`/open` forks a copy instead); a session still open in the desktop app / terminal asks you to close it there first.
- Idle sessions are closed after 30 minutes and resumed on the next message. A turn interrupted by a crash or reboot continues by itself once.

**Accounts, models, quota**
- Several Claude accounts on one machine (one `claude setup-token` each). Pinned usage panel (5-hour / weekly, refreshed every 15 min), alert at `usageAlert` % with one-tap switch, `/account` to continue the same conversation on another account. A turn that hits the limit offers to switch, or resumes by itself after the reset.
- Expired / revoked logins are reported once a day per account; with `tokenIssued` you are warned 30 and 7 days before a setup-token's one-year expiry.
- Defaults: dispatchers (圣旨, 上朝) run **Sonnet with low effort** and a tool allowlist (圣旨: Glob + hub tools; 上朝: assigning only), without your user settings, plugins or other MCP servers. Project topics use the account's default model; `/model` per topic or group, `/effort` per topic (default / low … max). Codex uses `xhigh` effort per turn (`codexEffort`); its model comes from its own `config.toml`.
- **Codex** through `codex app-server` (approvals included).

**Command group 上朝 and agents working together**
- Start a message with a nickname (`@a fix the login bug`) and it goes straight to that account's 圣旨, which picks or creates the project topic. Forwarded / quoted messages never count as named. Unnamed tasks: the chief dispatcher (`commandDefault`) suggests who should do it and you confirm with a button. Results come back to 上朝 (✅ done / 💬 waiting for you / ⚠️ not finished).
- `send_to_agent(@b, task)` from any session, same machine or the other one; the result returns to the asking topic as 「📬」. Agent-made tasks are labelled as such and cannot fan out again. Loop guards: 3 hops, `handoffPerHour` per topic (reset by your own message).
- Two computers: if the other machine is offline you're told (「🏖 Mac is on leave」) instead of anything being queued; each hub only acts on messages younger than 10 minutes (update bundles excepted). `/move mac [code]` carries a session (transcript, memory, optionally the code) to the other machine.

**Permissions and safety**
- Risky actions arrive as cards — *allow once* / *allow for this session* / *deny*, with the command or diff shown (secret files masked). Default mode `auto` (only risky actions ask); `/mode ask|auto` per topic or group. No full-bypass mode from Telegram.
- `/approvals on` (then restart the desktop app once) sends what Claude Desktop / terminal sessions on that machine need from you to Telegram buttons, in that session's topic or in 上朝 when it has none: permission prompts (allow once / deny) and Claude's option cards (one button per option; multi-select takes one for now; for your own answer just type it in that topic while the card is open, or tap 「✏️ 其他」 and the input box opens). No timeout: the card waits for your tap; 「💻」 hands it back to the computer, and a turn you stop there closes the card. A port clash (default 7788) only disables this, with a notice in 上朝.
- 上朝 has three channels: General (renamed 「下旨」) for your tasks, dispatcher replies and reports; 「🤖 机器通道」 for hub-to-hub traffic (cross-machine tasks, results, update bundles, pairing keys, receipts), best muted; 「🔔 待你处理」 for the hub's notices and cards for you. Typing in the two sub-channels is not taken as a task. Set the same `exchangeThreads: { machine, todo }` (topic ids) on both machines and give the hub bot "Manage topics"; without it everything stays in General as before.
- The desktop app's site approval ("Allow Claude to act on <site>?") goes through no hook, only its on-screen buttons. When a session (or one of its background agents) is stuck on it, the topic turns 🔴 and gets a card: the site + allow once / always allow this site / deny / I'll do it at the computer. A tap makes the hub switch the app to that session, check the site in the dialog is the one on the card, and click the same button with a real mouse click (only if the point is that button, not something covering it). Answered at the desk → the card closes. Windows: `desktop-approve.ps1`; macOS: `desktop-approve.js` (give node Accessibility in System Settings → Privacy & Security, then restart the hub once). Needs the computer unlocked with the app open, and brings the app window to the front. The JavaScript card ("execute JavaScript on <site>?") shows the code and has no "always": some sites (shops, for one) are one-by-one by the app's own rule, and the hub doesn't approve them by itself.
- Topics where you work on the hub itself (config `hubAdminTopics`, topic keys) may read and edit the hub's code; every other topic still can't touch the hub folder, and the hub's secrets (.env, .env.dpapi, state.json), login files and token variables stay off limits everywhere.
- `/selftest` (or `/selftest mac`) in 上朝: a read-only self-check (hooks, desktop sessions, sidebars, today's counts of auto topics / status marks / memory bridges / permission cards, the Mac's Accessibility). `/tidy` (or `/tidy mac`): delete topics in this machine's groups the hub doesn't know. The two hubs can send each other these (signed, in the machine channel), e.g. Windows asks the Mac to self-check or to set its group photo.
- `/panic` (private chat, 上朝 or any group): stops every session on the machine (in 上朝: on both), denies pending cards, clears queues and auto-resumes, and keeps the hub paused across restarts — nothing new runs, no peer tasks or bundles are accepted. `/resume_hub` ends it.
- Signed cross-machine messages (see *Security*), DPAPI-encrypted secrets on Windows, secret redaction, stranger removal, append-only audit log.

**Operations**
- Autostart (Task Scheduler + `start-hub.vbs` / launchd), watchdog (reconnects first, restarts only when idle), heartbeats in group descriptions (no proactive offline alerts: a task sent to an offline machine gets 「🏖 … 今天请假了」; `peerAlerts: true` opts in), replies that failed to send are retried every minute.
- Crash-loop guard: 3 crashes within 2 minutes of starting → the last version that ran 2 stable minutes (`good/hub.mjs`) is put back, the bad one kept as `logs/hub.mjs.crashed`, and you are told in 上朝.
- Deploy without cutting a turn: create `restart.flag` next to `hub.mjs`; the hub restarts once every topic is idle (asks you after 6 hours).
- Daily Agent SDK update at `updateHour` when idle — only releases ≥ 3 days old, self-test plus a real turn per account, rolled back on failure.
- Remote update of the other machine (`scripts/push-update.mjs`), checked and rolled back automatically after 3 quick crashes.
- `/clear` wipes chat clutter (usage panel and memory stay). Phone files and daily logs are kept 30 days; audit logs are kept.

UI text is Chinese (pinned panels are English). Contributions for other languages are welcome.

## Requirements

- Node.js 20+ on each computer
- Claude Code subscription login(s) — no API key needed (the Claude Agent SDK runs the bundled `claude` binary)
- Optional: Codex (desktop app or CLI, logged in); git (change summaries); Edge or Chrome (`/shot`)
- A Telegram account

## Setup

1. **Bots** — in @BotFather create one bot per computer.
2. **Groups**
   - For each agent account: a supergroup with *Topics* enabled. Add that machine's bot as admin (manage topics, pin, delete messages, ban users, change group info).
   - One command group (上朝): you plus every machine's bot, all bots as admins.
   - Your numeric user id: e.g. ask @userinfobot. Group ids: start the hub and write something in a group it doesn't know yet — it tells you the id (in 上朝; by DM until 上朝 is configured).
3. **Config** — `cp .env.example .env` and `cp examples/config.windows.json config.json` (or `config.mac.json`), then fill in ids, nicknames, folders and the other hub's bot in `peerBots`. See *Config* below.
4. **Claude accounts**
   - Each account the machine should drive: log in as that account and run `claude setup-token`; put the token in `.env` under the name `agents.<id>.tokenEnv` says. A machine that only uses its own login needs no token.
   - Usage panel (optional): a full login in its own folder, e.g. `CLAUDE_CONFIG_DIR=~/.claude-usage-a claude auth login`, then set `usageConfigDir`.
   - **Keep transcripts**: Claude Code deletes conversations idle longer than `cleanupPeriodDays` (default 30), which breaks `/open`, `/account`, `/fork`, `/move` and auto-resume for older topics. Add `"cleanupPeriodDays": 3650` to `~/.claude/settings.json` on every machine (the hub reminds you daily until it is ≥ 365).
5. **Run** — `npm ci`, then `node hub.mjs`. Send `/start` in a group's General topic.
6. **Autostart**
   - Windows (PowerShell in the hub folder). `start-hub.vbs` restarts the hub itself and expects `C:\Program Files\nodejs\node.exe` — edit the path if node lives elsewhere:
     ```powershell
     $a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$PWD\start-hub.vbs`"" -WorkingDirectory $PWD
     $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
     $s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
     Register-ScheduledTask AgentHub -Action $a -Trigger $t -Settings $s
     ```
   - macOS: `bash scripts/install-macos.sh` (installs to `~/.agent-hub`, launchd keeps it running). For `/screen`, grant *Screen Recording* to the node binary and restart the hub.
7. **Second computer** — give it its own bot, group(s) and config (`machine`, `peers`, `watch`, `peerBots`, same `commandAliases` / `exchange`, `selfUpdate: true` if it should accept updates). The two hubs pair themselves the first time they see each other in 上朝. Later updates, from the first machine's hub folder:
   ```
   node scripts/push-update.mjs Mac path/to/mac/config.json
   ```
   It reads the bot token from `.env` (or `.env.dpapi` on Windows), signs the bundle with the pairing key from `state.json`, and posts `agent-hub.zip → Mac v<ver>` to 上朝; the Mac installs it (after your tap unless `confirmBundles: false`).

## Commands

| Where | Command |
|---|---|
| 圣旨 (General) | plain language ("open project X", "new project Y and add a README"), `/open <dir>`, `/new <dir>`, `/sync`, `/get <path>`, `/clear` |
| topic | plain chat, `/stop`, `/model`, `/effort`, `/mode ask\|auto`, `/account`, `/fork`, `/handoff`, `/move <machine> [code]`, `/get <path>`, `/diff` |
| 上朝 | `@nickname task`, unnamed tasks, `/stop`, `/clear [machine]`, `/approvals on\|off [machine]`, `/screen [machine]`, `/shot [machine] …` |
| anywhere | `/status`, `/screen [n]`, `/shot <url\|port> [width]`, `/panic`, `/resume_hub`, `/approvals on\|off`, `/start` (help) |

## Config

| key | meaning |
|---|---|
| `machine` | this computer's name (`Windows`, `Mac`, …) |
| `defaultRoots` | where relative project names are looked up / created |
| `groups` | `{ chatId: { title, agent, owner? } }` — `owner: "mac-hub"` marks another machine's group (listed for names only) |
| `agents` | `{ id: { type: "claude"\|"codex", label, tokenEnv?, tokenIssued?, usageConfigDir?, sidebarDir? } }` — `tokenIssued: "YYYY-MM-DD"` enables expiry warnings |
| `commandGroups`, `exchange` | the command group (上朝) id |
| `commandDefault` | machine that answers unnamed 上朝 messages (chief dispatcher) |
| `commandRoute` | `{ Machine: regex }` keywords that route an unnamed message to that machine |
| `commandAliases` | `{ nickname: { machine, group } }` |
| `peers`, `watch` | the other machine(s); heartbeat watching (`peerAlerts: true` = a notice in 上朝 when a peer goes offline / comes back) |
| `peerBots` | the other hub's bot (username or numeric id). Only these bots are trusted in the command group and allowed in your groups — required for anything cross-machine |
| `selfUpdate` | accept update bundles from the other machine |
| `confirmBundles` | default: you tap to accept each update / move bundle; `false` = accept automatically from `peerBots` (a changed pairing key always needs your tap) |
| `handoffPerHour` | agent-initiated sends per topic per hour (default 10, 0 = no limit) |
| `autoSendFiles` | `false` = don't send a turn's new files automatically |
| `dispatcherModel`, `dispatcherEffort` | dispatcher model / effort (default `sonnet` / `low`) |
| `projectEffort` | effort for Claude topics without `/effort` (default: the model's own) |
| `codexEffort`, `codexServiceTier` | Codex effort per turn (default `xhigh`); `codexServiceTier: "default"` = standard speed instead of the tier in Codex's `config.toml` |
| `usageAlert` | usage % that triggers the switch offer (default 90) |
| `moveInto` | group id that receives sessions moved here (default: first Claude group) |
| `keepAwake` | macOS: `false` = don't keep the Mac awake with `caffeinate` |
| `tz`, `updateHour`, `hookPort` | time zone (default: system), daily SDK update hour (4), `/approvals` hook port (7788) |

## Security

- **Owner only.** The hub obeys only `OWNER_ID`. Anyone else added to your groups (whoever added them) is removed at once and you are told in 上朝; only you, this machine's bot and `peerBots` may stay.
- **Signed cross-machine messages.** Each hub keeps an X25519 key in `state.json` (not `.env`). The hubs exchange public keys in 上朝 the first time they meet (「🔑 → Mac …」, trust on first use) and HMAC every task, result, move bundle and update bundle with the derived key (last line `#sig …`; bundles are signed together with the file's SHA-256 and verified before unpacking). Unsigned, wrong, older than 10 minutes or replayed → rejected (🚫 in 上朝, logged and audited). A stolen bot token alone can't run tasks or install code.
  - **Changed key** (reinstalled hub, cleared `state.json` — or an impostor): never accepted automatically; you get *accept new key / reject* in 上朝 (only your own tap counts).
  - **Re-pair**: stop one hub, delete `pair` from its `state.json`, start it; accept the new key when asked.
  - **Escape hatch** if pairing is broken and every signed bundle is rejected: post or forward `agent-hub.zip` in 上朝 yourself, with a caption that routes to the target machine (e.g. containing `mac`). Bundles posted by you are installed without a signature (not while `/panic` is active). `push-update.mjs` keeps a copy in the hub folder for this.
- **Secrets.** Bot and Claude tokens never enter agent environments. Any Claude tool call that touches the hub folder, its secrets or login files, the Mac keychain item, or dumps the whole environment (`printenv`, `env`, `Get-ChildItem env:` …) is blocked — a speed bump, not a sandbox (Codex has no such hook). Everything sent to Telegram and every log line is redacted: `.env` values whose name contains TOKEN / KEY / SECRET / PASS and common token formats (sk-…, ghp_…, bot tokens, private keys) become `[secret]`.
- **DPAPI on Windows.** After the new version has run 2 stable minutes, secret `.env` values are moved into `.env.dpapi`, encrypted for this Windows user; `.env` keeps only plain settings. To rotate a token, write `NAME=new value` into `.env` and restart — plaintext wins and is sealed again. If decryption fails (other Windows user, reinstall, password reset by an admin) the hub won't start (reason in `logs/crash.log`): write all tokens back into `.env` and delete `.env.dpapi`. macOS keeps a plain `.env` (chmod 600), because the keychain is locked after a reboot until you log in.
- **Audit log.** `logs/audit-<date>.log` is append-only and never pruned; it records metadata only (command or message length, buttons, auto-approved tool summaries, peer message types), never message content.
- Agents run as your OS user with access to the whole machine (by design). For real isolation run the hub under a separate OS user. Archives containing links are rejected.

### Protect the Telegram account

Whoever is logged in to your Telegram can drive every connected computer.
- Turn on two-step verification (cloud password + recovery email); set a passcode lock in the phone app and a local passcode in Telegram Desktop.
- Settings → Devices: terminate sessions you don't recognize; set *automatically terminate old sessions* to 1 week.
- Optional: auto-delete messages in the groups (e.g. after 1 week) — Telegram otherwise keeps every code snippet, diff and path.
- Keep a remote-desktop tool (with 2FA) on each machine for when the hub itself is down or a GUI dialog needs a click.

## Limitations

- Telegram bots can download files up to 20 MB and can only delete messages younger than 48 h.
- Codex topics: no `/fork`, no limit auto-resume, no secret guard hook.
- `/screen` on Windows needs an unlocked, connected session; on macOS it needs Screen Recording permission.
- Driving several subscription accounts through the Agent SDK may be subject to your provider's terms — check them.

## Tests

`node --test hub.test.mjs`

## License

MIT
