# Grok Studio

A Windows-first desktop GUI for [Grok Build](https://github.com/xai-org/grok-build). The long-term target is comparable **local coding workflows** to the Codex desktop app wherever Grok's runtime supports them. This is an independent client, not an official xAI or OpenAI application.

Project repository: [robbyjo/Grok-Studio](https://github.com/robbyjo/Grok-Studio). The existing 0.1.1 binary retains its original Grok Desktop label. Development priorities are tracked in [TODO.md](TODO.md).

**Current release: 0.1.1 alpha, Windows x64 portable.** Full Codex local workflow parity is not complete. Uses Electron, React, TypeScript, a native PowerShell terminal, and Grok's Agent Client Protocol (ACP). macOS and Linux are architectural targets, not validated releases.

## Run on Windows

Requirements: Windows 10/11 x64; Git for Git workflows; your project's development tools. The portable executable includes the official `grok 1.0.46` runtime. Grok sign-in and network access are needed for model-backed coding; this is not an offline model.

1. Copy `release/Grok-Desktop-0.1.1-Portable.exe` to a writable folder and double-click it. No installer or separate Electron/Node/Grok installation is needed to open the GUI. The executable extracts application files to a temporary directory while running.
2. Open a project. The default runtime selection is **bundled**. Open the integrated terminal and run `grok login` to authenticate the portable Grok profile.
3. Send a prompt. Grok starts in the project's folder. Approval requests appear above the composer. “Stop turn” cancels the agent turn.
4. To connect MCPs, open **Settings → MCP servers** in a project chat. Add a STDIO command with one argument per line, or a Streamable HTTP/SSE URL; choose user or project scope. Select **Test connection** to check handshake and tool discovery. After a configuration change, reconnect the chat to load the new configuration.

The portable alpha is unsigned. STDIO MCP servers can require separate tools such as Node, Python or `npx`; those server dependencies are not bundled. OAuth setup and advanced MCP policies currently use Grok's terminal interface. Untrusted project servers are reported as blocked; diagnostics do not silently grant folder trust.

Build from source with Node.js 22.12+ and npm:

```powershell
cd E:\Projects\Grok-Build
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

Run `npm run runtime` to obtain the pinned runtime for development, or use an existing absolute Grok executable path in Settings. `npm run package:portable` builds the portable distributable. The runtime download is verified against the recorded release hash and packaging stops on a mismatch.

## Working features

- Native project folder selection; multiple project chats; titles, search by title, pins, archives, and restore.
- Persistent local transcripts and Grok session IDs; reconnect/resume using `session/load`.
- Streamed Markdown, reasoning disclosures, tool input/output, plans, and completion records.
- Per-chat agent processes, simultaneous independent chats, cancellation, crash/error display, and cleanup on quit.
- Exact Grok approval choices, including rejection and cancellation. No automatic always-approve flag.
- Interactive project trust requests when the installed runtime enables that feature.
- Runtime-advertised model, reasoning-effort, and agent-mode selectors.
- Up to five explicitly selected text attachments, 1 MiB per file.
- Native interactive PowerShell terminal with input, resize, cancellation via Ctrl+C, and output history while the app is open.
- Read-only file browser/preview, real staged/unstaged Git diffs, status, branch, and worktree list.
- Create a new branch/worktree from current HEAD and start a chat there, preserving the original checkout's uncommitted changes.
- MCP inventory, add, remove, enable/disable and connection diagnostics through Grok's native configuration commands; user/project scopes, environment variables and HTTP headers.

Grok's native tools, MCP connections, skills, hooks, plugins, project instructions and permission policy stay owned by Grok. MCP GUI management is implemented for TOML server definitions. OAuth controls, resource/tool browsers, advanced policy editors, skill/plugin management and comprehensive subagent/task dashboards remain missing. See [the audited parity checklist](docs/PARITY.md); inherited runtime features are distinguished from tested GUI behavior.

## Data and execution

Portable launches keep state and Electron profile/cache in `Grok Desktop Data` beside the executable, including prompts and tool output. The portable Grok profile is `Grok Desktop Data/grok`; Grok manages credentials, sessions and user MCP configuration there. Move the executable **and this folder together** to retain the profile. Project paths and external MCP dependencies remain references to their actual locations; moving the app does not move projects or install server dependencies. Signing in again may be necessary on another computer. No existing personal credentials are copied automatically.

Nonportable development/unpacked launches use Electron's per-user app data and the usual Grok profile. `GROK_DESKTOP_DATA_DIR` overrides desktop storage; `GROK_HOME` overrides the Grok profile, including for portable launches. Use absolute paths. Drafts and terminal scrollback are session-local. Corrupt state is preserved and reported instead of overwritten.

The renderer has no Node access. A sandboxed, isolated preload exposes an allowlisted IPC bridge with sender validation. The file preview API canonicalizes paths and rejects paths/symlinks outside the selected chat workspace. Markdown does not execute raw HTML or scripts. Remote pages cannot navigate the app; HTTP links open in the system browser.

**Grok's OS-level agent sandbox is unavailable on Windows in the inspected upstream source.** Tool approvals are not a Windows filesystem sandbox. Configured Grok allow rules still apply. The interactive terminal executes as the signed-in Windows user. Project trust may enable project hooks/servers and is displayed separately from tool approval. The GUI never parses or copies Grok's credential files.

Worktree deletion, applying changes back, commits/pushes, and checkpoint rollback currently use the terminal or Grok tools; there are no dedicated GUI operations for them.

## Develop and verify

```powershell
npm run dev           # Vite + Electron; restart when main/preload code changes
npm run typecheck
npm test              # real child-process ACP fixture; filesystem and Git regression tests
npm run build
npm run test:ui       # launches Electron; isolated state and real Windows terminal
npm run package:portable # preferred unsigned Windows x64 executable, runtime included
npm run test:portable # actual portable launcher, profile relocation and embedded runtime
```

`npm ci` may require the explicit Electron installation step shown above because Electron 44 does not automatically download its runtime through an install script. Dependencies are locked in `package-lock.json`. Targeted overrides pin `@electron/get` and `shell-quote` to compatible patched versions used in validation.

In a managed workspace, Electron may report an ACL error about `ALL APPLICATION PACKAGES`. For a development checkout, grant **read/execute to the Electron runtime folder only**, as directed by that error. Do not disable Chromium's sandbox or grant project directories broad permissions. The native tests in this workspace needed an unrestricted shell launch to avoid the outer managed shell's token restrictions.

A protocol-only smoke test can use a separately downloaded Grok executable:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/smoke-runtime.ts C:\path\to\grok.exe
```

It uses an isolated Grok home and negotiates ACP without authenticating or sending any model prompt. Paid/model-backed behavior needs a signed-in account for live acceptance testing. See [validation evidence and remaining checks](docs/VALIDATION.md).

## Sources and licensing

- [Grok Build](https://github.com/xai-org/grok-build), source inspected at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`.
- [Upstream ACP integration guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
- [ACP v1 protocol](https://agentclientprotocol.com/protocol/v1/initialization).
- [Codex app-server integration](https://developers.openai.com/blog/codex-as-a-platform) and [Codex workflows](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex).
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Our client source is Apache-2.0, with dependency notices in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The read-only `upstream/` reference checkout is excluded from distributables. The pinned, unmodified Grok Windows binary is bundled along with upstream license and full third-party notices. No Codex desktop assets or application code were copied.
