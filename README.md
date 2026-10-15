# Telegram Agent Hub

Run all your AI coding agents from Telegram — several Claude Code subscription accounts, Codex, on more than one computer — with the same reach as sitting at the desk: chat with any project session, approve risky actions with a button, open or resume projects, see usage at a glance, and let agents hand work to each other.

[中文说明](README.zh-CN.md)

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

One hub process and one bot per computer. One Telegram forum group per agent account; each topic in it is one project session; the group's General topic (「圣旨」) is a small dispatcher agent you talk to in plain language. A shared command group (「上朝」) connects everything: you assign work there, and the two hubs exchange tasks, results, moved sessions and updates there.

## Features

- **Two-way chat per project**: text, photos and files in; agents send files/screenshots back (`send_file` tool). Live progress message, per-topic session card (context %, connectors, outputs, model, mode).
- **Permissions on your phone**: risky actions arrive as cards — *allow once* / *allow for this session* / *deny*, with the command or diff shown. `/mode ask|auto` per topic or group. Claude Desktop / terminal sessions can also send their permission prompts to you (`/approvals on`).
- **Projects**: `/open <dir>` resumes the folder's latest conversation, `/new <dir>` starts one, or just tell 圣旨 "continue project X". A new task gets its own folder under the workspace root (e.g. `search`), so every topic is named after its project or task. `/sync` brings desktop-app sessions in as topics. Deleting a topic never deletes memory.
- **Several Claude accounts** on one machine (one `claude setup-token` each). Pinned usage panel (5-hour / weekly), alert at 90 % with one-tap switch, `/account` to continue the same conversation on another account; if a turn hits the limit it offers to switch or resumes by itself after the reset.
- **Codex** through `codex app-server` (approvals included).
- **Command group 上朝**: start a message with a nickname (`@a fix the login bug`) and it goes straight to that account's 圣旨, which picks or creates the project topic. Unnamed tasks: the chief dispatcher asks you who should do it. Results come back to 上朝.
- **Agents working together**: `send_to_agent(@b, task)` from any session, same machine or the other one; the result is handed back to the asking session. Loop guards (hop limit, rate limit reset by your own messages).
- **Two computers**: the hubs' bots talk to each other in 上朝. If a machine is offline you're told ("🏖 Mac is on leave today") instead of anything being queued. `/move mac [code]` carries a session (transcript, memory, optionally the code) to the other machine.
- **Ops**: autostart (Task Scheduler / launchd), watchdog, heartbeats with offline alerts, daily Agent SDK update (only releases ≥3 days old, smoke-tested, rolled back on failure), remote update of the other machine with checks and automatic rollback, `/clear` to wipe chat clutter.

UI text is Chinese (pinned panels are English). Contributions for other languages are welcome.

## Requirements

- Node.js 20+ on each computer
- Claude Code subscription login(s) — no API key needed (the Claude Agent SDK runs the bundled `claude` binary)
- Optional: Codex (desktop app or CLI, logged in)
- A Telegram account

## Setup

1. **Bots** — in @BotFather create one bot per computer.
2. **Groups**
   - For each agent account: a supergroup with *Topics* enabled. Add that machine's bot as admin (manage topics, pin, delete messages, change group info).
   - One command group (上朝): you plus every machine's bot, all bots as admins.
   - Your numeric user id: e.g. ask @userinfobot. Group ids: start the hub and write something in a group it doesn't know yet — it DMs you the id.
3. **Config** — `cp .env.example .env` and `cp examples/config.windows.json config.json` (or `config.mac.json`), then fill in ids, nicknames and folders. See *Config* below.
4. **Claude accounts**
   - Each account the machine should drive: log in as that account and run `claude setup-token`; put the token in `.env` under the name `agents.<id>.tokenEnv` says. A machine that only uses its own login needs no token.
   - Usage panel (optional): a full login in its own folder, e.g. `CLAUDE_CONFIG_DIR=~/.claude-usage-a claude auth login`, then set `usageConfigDir`.
5. **Run** — `npm ci`, then `node hub.mjs`. Send `/start` in a group's General topic.
6. **Autostart**
   - Windows (PowerShell in the hub folder):
     ```powershell
     $a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$PWD\start-hub.vbs`"" -WorkingDirectory $PWD
     $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
     $s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
     Register-ScheduledTask AgentHub -Action $a -Trigger $t -Settings $s
     ```
   - macOS: `bash scripts/install-macos.sh` (installs to `~/.agent-hub`, launchd keeps it running).
7. **Second computer** — give it its own bot, group(s) and config (`machine`, `peers`, `watch`, same `commandAliases`/`exchange`). Later updates: on the first machine run `node scripts/push-update.mjs Mac path/to/mac/config.json`; the Mac (with `selfUpdate: true`) installs it itself.

## Commands

| Where | Command |
|---|---|
| 圣旨 (General) | plain language ("open project X", "new project Y and add a README"), `/open <dir>`, `/new <dir>`, `/sync`, `/clear` |
| topic | plain chat, `/stop`, `/model`, `/mode ask\|auto`, `/account`, `/fork`, `/handoff`, `/move <machine> [code]`, `/get <path>` |
| 上朝 | `@nickname task`, unnamed tasks, `/status`, `/stop`, `/clear [machine]`, `/approvals on [machine]` |
| anywhere | `/status`, `/start` (help) |

## Config

| key | meaning |
|---|---|
| `machine` | this computer's name (`Windows`, `Mac`, …) |
| `defaultRoots` | where relative project names are looked up / created |
| `groups` | `{ chatId: { title, agent, owner? } }` — `owner: "mac-hub"` marks another machine's group (listed for names only) |
| `agents` | `{ id: { type: "claude"\|"codex", label, tokenEnv?, usageConfigDir?, sidebarDir? } }` |
| `commandGroups`, `exchange` | the command group (上朝) id |
| `commandDefault` | machine that answers unnamed 上朝 messages (chief dispatcher) |
| `commandRoute` | `{ Machine: regex }` keywords that route an unnamed message to that machine |
| `commandAliases` | `{ nickname: { machine, group } }` |
| `peers`, `watch` | the other machine(s); heartbeat watching |
| `peerBots` | the other hub's bot (username or numeric id). Only these bots are trusted in the command group — required for anything cross-machine |
| `selfUpdate` | accept update bundles pushed from the other machine |
| `confirmBundles` | default: you tap to accept each update / move bundle; `false` = accept automatically from `peerBots` |
| optional | `tz`, `usageAlert` (90), `handoffPerHour` (10, 0 = off), `dispatcherModel` (`sonnet`), `dispatcherEffort` (`low`), `keepAwake`, `moveInto`, `hookPort` (7788), `updateHour` (4) |

## Security notes

- The hub obeys only `OWNER_ID`. Bot tokens and Claude tokens are never put into agent environments, and every Claude tool call that names the hub's secrets is blocked.
- Agents run as your OS user with access to the whole machine (by design). That is a speed bump, not a sandbox: for real isolation run the hub under a separate OS user.
- Default permission mode is `auto` (risky actions still ask). No full-bypass mode is offered from Telegram.
- Cross-machine messages are only accepted from the bots listed in `peerBots`; any other bot in the command group is ignored. Update and move bundles need your tap unless `confirmBundles: false`, and archives containing links are rejected.
- Deploying a new version never cuts a running turn: create `restart.flag` next to `hub.mjs` and the hub restarts once all topics are idle. A turn interrupted by a crash or reboot continues by itself once.

## Limitations

- Telegram bots can download files up to 20 MB and can only delete messages younger than 48 h.
- Codex topics: no `/fork`, no limit auto-resume.
- Driving several subscription accounts through the Agent SDK may be subject to your provider's terms — check them.

## Tests

`node --test hub.test.mjs`

## License

MIT
