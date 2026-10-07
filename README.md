# Grok Studio

A Windows-first desktop GUI for [Grok Build](https://github.com/xai-org/grok-build). The long-term target is comparable **local coding workflows** to the Codex desktop app wherever Grok's runtime supports them. This is an independent client, not an official xAI or OpenAI application.

Project repository: [robbyjo/Grok-Studio](https://github.com/robbyjo/Grok-Studio). Development priorities are tracked in [TODO.md](TODO.md).

**Current release: 0.4.0 alpha, Windows x64 portable.** Full Codex local workflow parity is not complete. Uses Electron, React, TypeScript, a native PowerShell terminal, and Grok's Agent Client Protocol (ACP). macOS and Linux are architectural targets, not validated releases.

## Run on Windows

Requirements: Windows 10/11 x64; Git for Git workflows; your project's development tools. The portable executable includes the official `grok 1.0.46` runtime. Grok sign-in and network access are needed for model-backed coding; this is not an offline model.

1. Copy `release/Grok-Studio-0.4.0-Portable.exe` to a writable folder and double-click it. No installer or separate Electron/Node/Grok installation is needed to open the GUI. The executable extracts application files to a temporary directory while running.
2. Open a project. The default runtime selection is **bundled**. Open the integrated terminal and run `grok login` to authenticate the portable Grok profile.
3. Send a prompt. Grok starts in the project's folder. Approval requests appear above the composer. “Stop turn” cancels the agent turn.
4. To connect MCPs, open **Settings → MCP servers** in a project chat. Add a STDIO command with one argument per line, or a Streamable HTTP/SSE URL; choose user or project scope. Select **Test connection** to check handshake and tool discovery. After a configuration change, reconnect the chat to load the new configuration.

The portable alpha is unsigned. STDIO MCP servers can require separate tools such as Node, Python or `npx`; those server dependencies are not bundled. OAuth setup and advanced MCP policies currently use Grok's terminal interface. Untrusted project servers are reported as blocked; diagnostics do not silently grant folder trust.

Build from source with Node.js 22.12+ and npm:

```powershell
git clone https://github.com/robbyjo/Grok-Studio.git
cd Grok-Studio
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

Run `npm run runtime` to obtain the pinned runtime for development, or use an existing absolute Grok executable path in Settings. `npm run package:portable` builds the portable distributable. The runtime download is verified against the recorded release hash and packaging stops on a mismatch.

## Working features

- Native project folder selection, rename, reversible sidebar removal and restoration; multiple project chats, titles, pins and archives.
- Search saved transcripts and chat metadata with literal phrases, archived/removed-project scope controls, highlighted snippets and matching-message navigation.
- Persistent local transcripts and Grok session IDs; reconnect/resume using `session/load`.
- Streamed Markdown, reasoning disclosures, tool input/output, plans, and completion records.
- Per-chat agent processes, simultaneous independent chats, cancellation, crash/error display, and cleanup on quit.
- Exact Grok approval choices, including rejection and cancellation. No automatic always-approve flag.
- Interactive project trust requests when the installed runtime enables that feature.
- Runtime-advertised model, reasoning-effort, and agent-mode selectors.
- Up to five explicitly selected text attachments, 1 MiB per file.
- Native interactive PowerShell terminal with input, resize, cancellation via Ctrl+C, and output history while the app is open.
- File browser and UTF-8 editor for existing files up to 1 MiB; Ctrl+S, external-change detection, draft retention across files/chats and an unsaved-draft quit warning.
- Per-file staged/unstaged diffs, reviewed commits and text chunk actions; persistent local inline comments, clean-only branch controls and reviewed push. Optional GitHub CLI PR listing/draft publication.
- Worktrees from a chosen branch/reference, attach and native conversation handoff, reviewed apply to a clean checkout, recoverable archive and restore.
- MCP inventory, add, remove, enable/disable and connection diagnostics through Grok's native configuration commands; user/project scopes, environment variables and HTTP headers.

Settings now includes native MCP catalogs/tool policies, OAuth sign-in/status/local logout, skill/plugin/hook management, direct configuration/rules editing, reusable project actions, CLI session import/fork/checkpoints and worktree lifecycle controls. The official [GitHub OAuth integration](docs/GITHUB-MCP.md) passed a real identity check. Grok owns execution, scopes and managed policy. Resource reads use known URIs; this runtime exposes no MCP resource/prompt enumeration API to the desktop bridge. See [the audited parity checklist](docs/PARITY.md) for remaining gates and limits.

## Data and execution

Portable launches keep state and Electron profile/cache in `Grok Desktop Data` beside the executable, including prompts and tool output. The portable Grok profile is `Grok Desktop Data/grok`; Grok manages credentials, sessions and user MCP configuration there. Move the executable **and this folder together** to retain the profile. Project paths and external MCP dependencies remain references to their actual locations; moving the app does not move projects or install server dependencies. Signing in again may be necessary on another computer. No existing personal credentials are copied automatically.

The original `Grok Desktop Data` folder name is deliberately retained for compatibility. Nonportable development/unpacked launches preserve the original `grok-desktop` folder under per-user app data and the usual Grok profile. `GROK_DESKTOP_DATA_DIR` overrides desktop storage; `GROK_HOME` overrides the Grok profile, including for portable launches. Use absolute paths. Drafts and terminal scrollback are session-local. Corrupt state is preserved and reported instead of overwritten.

The renderer has no Node access. A sandboxed, isolated preload exposes an allowlisted IPC bridge with sender validation. The file APIs canonicalize paths and rejects paths/symlinks outside the selected chat workspace. Markdown does not execute raw HTML or scripts. Remote pages cannot navigate the app; HTTP links open in the system browser.

**Grok's OS-level agent sandbox is unavailable on Windows in the inspected upstream source.** Tool approvals are not a Windows filesystem sandbox. Configured Grok allow rules still apply. The interactive terminal executes as the signed-in Windows user. Project trust may enable project hooks/servers and is displayed separately from tool approval. The GUI does not import account credentials automatically. Explicit HTTP MCP logout edits only the selected credential key; GitHub STDIO logout closes native processes and clears their memory-only tokens.

Select **Files** to edit, save or reload a file. Reloading a changed draft requires an explicit discard choice. Saves reject stale content, Git metadata, external paths, hardlinks, binary files and invalid UTF-8. Saving and Git mutations reject active agent turns. Drafts are held in memory; crashes can lose them. Content hashes detect external changes before replacement, but this is not a cross-process filesystem lock.

Select **Search chats** or press **Ctrl+Shift+F** to search this desktop profile. Search ignores case, treats punctuation literally and returns up to 100 matching messages/chat metadata records, sorted by recent chat; narrow the phrase when more results exist. It includes full saved messages, reasoning, plans and tool input/output, including output beyond the tool card's display limit. Selecting a result opens its chat, expands an activity card when applicable and highlights the matching entry. The match snippet remains visible for clipped activity output. Archived chats are included by default; removed projects are opt-in. Use **Refresh results** after a streaming turn or metadata change. Search does not read external CLI sessions, workspace file contents or Grok credential files. Indexed search, pagination and sustained large-history performance remain TODO.

Use a project's **…** button to rename it or **Remove from sidebar**. Removal retains saved chats, archive/pin flags, files, worktrees and in-memory file drafts; it closes idle Grok connections and terminals, and refuses active turns. Restore through **Removed projects**, or reopen the same folder to reuse its original project identity and chats. This is a sidebar operation; it does not delete the project or its history. Removed projects are hidden at startup and new chats require restoration.

Select **Changes** to inspect a file, stage/unstage it and **Review staged commit**. The review lists staged paths and their diff; enter a message and choose **Commit staged index**. A changed index requires another review. Commits require Git identity, may run repository hooks and refuse unresolved conflicts or staged files outside a selected nested workspace. The terminal and external tools can still change the workspace; stop other writers before committing. Tracked text modifications support reviewed stage/unstage/revert chunks and local inline comments. Settings provides clean-only branch switching, reviewed non-force push and GitHub CLI PR listing/draft creation. PR publication requires an explicit review and an installed, authenticated GitHub CLI. Worktree archive saves a Git recovery ref before removal; ignored files, submodules and embedded repositories block removal. Native rewind saves transcript/file recovery records before execution.

## Develop and verify

```powershell
npm run dev           # Vite + Electron; restart when main/preload code changes
npm run typecheck
npm test              # real child-process ACP fixture; filesystem and Git regression tests
npm run build
npm run test:ui       # launches Electron; isolated state and real Windows terminal
npm run package:portable # preferred unsigned Windows x64 executable, runtime included
npm run test:portable # actual portable launcher, profile relocation and embedded runtime
 npm run test:live    # explicit real account/model acceptance; billable requests
 npm run test:native-sessions # real CLI import/fork/rewind/handoff acceptance
```

`npm ci` may require the explicit Electron installation step shown above because Electron 44 does not automatically download its runtime through an install script. Dependencies are locked in `package-lock.json`. Targeted overrides pin `@electron/get` and `shell-quote` to compatible patched versions used in validation.

In a managed workspace, Electron may report an ACL error about `ALL APPLICATION PACKAGES`. For a development checkout, grant **read/execute to the Electron runtime folder only**, as directed by that error. Do not disable Chromium's sandbox or grant project directories broad permissions. The native tests in this workspace needed an unrestricted shell launch to avoid the outer managed shell's token restrictions.

The [Windows CI workflow](.github/workflows/windows.yml) installs the pinned runtime, builds and tests the source and packaged GUI, launches and relocates the actual portable EXE, then uploads the tested executable and SHA-256 file as Actions artifacts. It runs without model credentials; live authenticated acceptance remains separate.

A protocol-only smoke test can use a separately downloaded Grok executable:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/smoke-runtime.ts C:\path\to\grok.exe
```

It uses an isolated Grok home and negotiates ACP without authenticating or sending any model prompt. Paid/model-backed behavior needs a signed-in account for live acceptance testing. See [validation evidence and remaining checks](docs/VALIDATION.md) and the [authenticated acceptance procedure](docs/LIVE-ACCEPTANCE.md).

## Sources and licensing

- [Grok Build](https://github.com/xai-org/grok-build), source inspected at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`.
- [Upstream ACP integration guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
- [ACP v1 protocol](https://agentclientprotocol.com/protocol/v1/initialization).
- [Codex app-server integration](https://developers.openai.com/blog/codex-as-a-platform) and [Codex workflows](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex).
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Our client source is Apache-2.0, with dependency notices in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The read-only `upstream/` reference checkout is excluded from distributables. The pinned, unmodified Grok Windows binary is bundled along with upstream license and full third-party notices. No Codex desktop assets or application code were copied.
