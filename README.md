# Grok Studio

A Windows-first desktop application with **Grok Build built in**, supporting Grok account OAuth and xAI API keys. The target is comparable local coding workflows to Codex wherever Grok supports them. This is an independent Apache-2.0 project; full workflow parity is still being developed.

**0.6.0 alpha · Windows 10/11 x64 · portable executable.** macOS, Linux and ARM64 are future targets. See [TODO.md](TODO.md), the [parity audit](docs/PARITY.md), and [validation evidence](docs/VALIDATION.md).

## Run on Windows

1. Put `Grok-Studio-0.6.0-Portable.exe` in a writable folder and open it. Electron, Node, the native Grok engine and its app-local Microsoft C++ runtime are included. There is no Grok CLI installation step.
2. Open a project. In **Settings → Authentication**, choose **Grok account (OAuth)** or **xAI API key**, then **Connect / sign in with selected method**. Complete OAuth in your browser, or enter an API key locally. Keys are session-only by default; optional Windows encrypted storage remembers them for this Windows account and machine.
3. Send a prompt. Tool approvals and project-trust requests appear above the composer. **Stop turn** cancels the turn. Git and your project's development tools are needed for the corresponding workflows.
4. Open **Settings → MCP servers** to add a STDIO command or HTTP/SSE endpoint, test the connection, edit configuration, and inspect effective tools/policies. Reconnect after changing configuration. MCP servers can require their own Node/Python/tools and provider sign-in. The optional [official GitHub OAuth MCP integration](docs/GITHUB-MCP.md) has real identity-check acceptance.

The alpha is unsigned. Model requests require network access and account access/billing. The portable launcher extracts application files into a temporary directory while running.

## Local workflows

- Projects and chats: pins, groups, bulk organization, rename, archive and reversible sidebar removal; SQLite history with paginated literal search and matching-message navigation.
- Coding: streamed Markdown/reasoning/tool activity/plans, exact approval choices, cancellation and session resume; advertised model/effort/mode controls; CLI session import, fork, file checkpoints and reviewed rewind with recovery records.
- Task controls: steering, bounded prompt queues, background/subagent dashboard, owned-task kill and subagent inspect/cancel; up to eight concurrent native connections.
- Files and Git: UTF-8 editor with durable drafts and stale-content checks; file/chunk stage/unstage/revert, local inline review comments, reviewed commits, clean-only branches, non-force push, and optional authenticated GitHub CLI PR listing/draft publication. Review comments remain local.
- Worktrees: branch/base selection, attach, native conversation handoff, reviewed apply to a clean target, recoverable archive and detached restore.
- Terminals: multiple PowerShell/pwsh/cmd/Git Bash tabs, bounded persistent scrollback, and explicit editable terminal context for the next agent prompt.
- Integrations: original Grok tools, MCP, OAuth, skill/plugin lifecycle, instruction/rule/hook editors, effective policy views and reviewed project setup/actions.
- Desktop: usage/cost indicators, context display when reported by the engine, opt-in notifications, configurable shortcuts, keyboard focus and reduced-motion support; diagnostics, bounded history storage and renderer crash recovery.

## Media and attachments

Use **Media** to generate images, speech or 1–15 second video, preview images, and play audio/video in the GUI. Export, attach or delete stored outputs. Sound generation currently means text-to-speech; general music and sound-effect generation are not implemented. Video uses the upstream 480p generation client. API-key/provider permissions determine available services.

Image, speech and video generation/playback passed with real **OAuth**. Video acceptance temporarily enabled account coding-data retention with explicit user consent, then restored and verified the original zero-data-retention setting. Video access can be blocked by zero-data-retention policy; the GUI shows that error and offers explicit account privacy controls. It does not silently change privacy. Protected remote-bucket video output is not downloaded by this GUI.

Select **Attach files** for up to five files per prompt, up to 50 MiB each. Images up to 8 MiB are supplied inline, bounded text is supplied as text, and other files are supplied as local references. Audio/video/PDF/binary interpretation depends on the model's tools; accepting a file does not guarantee native multimodal understanding. Attachments are copied into the desktop profile and survive composer recovery. Media storage has a 256 MiB/1,000-file ceiling. Generated and imported images/audio/video have private local previews; arbitrary HTML is not rendered.

## Data and execution

Portable state, histories, drafts, media, terminal scrollback, diagnostics and the Grok profile live in **`Grok Desktop Data` beside the executable**. Move the executable and that folder together. The legacy directory name is retained for compatibility. Absolute project paths and external MCP dependencies must still exist at their configured locations.

Grok's original authentication manager owns OAuth sign-in/refresh in `Grok Desktop Data/grok`. API keys optionally use Electron's Windows encrypted storage; a copied encrypted key may require re-entry on another computer/account. Normal launches do not copy credentials from other profiles. Cross-machine OAuth credential portability remains an open acceptance gate.

Development/unpacked launches retain the legacy `grok-desktop` app-data directory and ordinary Grok home. `GROK_DESKTOP_DATA_DIR` and `GROK_HOME` override them; use absolute paths. History is stored transactionally in SQLite, with atomic metadata JSON backups and corruption recovery. The configurable history budget is 64–2,048 MiB (default 512); new turns are blocked near the budget until history is pruned. This budget is separate from media, terminal scrollback and bounded diagnostics. Upstream-managed Grok session/cache files are not automatically pruned by this desktop budget. Pruning/deleting desktop history removes those records; export anything you need first.

The renderer has no Node access. A sandboxed preload exposes allowlisted, sender-validated IPC. Each chat's native engine runs in an app-owned helper process with isolated native global state. The private loopback ACP socket uses a random secret. File APIs canonicalize workspace paths and reject Git metadata, path escapes, hardlinks, invalid UTF-8 and stale saves. Review hashes detect intervening edits but are not locks against other writers.

**Grok's OS-level agent sandbox is unavailable on Windows in the inspected upstream source.** Approvals are not a Windows filesystem sandbox. Terminals, hooks, project actions and allowed agent tools execute as the current Windows user. Project trust and tool approvals are separate controls.

## Build and verify

Developer prerequisites: Node.js **24+**, npm, Git, Rust **1.95.0**, and MSVC C++ build tools/Windows SDK. `PROTOC` can select a protobuf compiler; otherwise a compiler on PATH or a checksum-pinned Windows download is used. The first native build can take several minutes. End users need none of these engine build tools.

```powershell
git clone https://github.com/robbyjo/Grok-Studio.git
cd Grok-Studio
npm ci
node node_modules/electron/install.js
rustup toolchain install 1.95.0 --profile minimal
rustup default 1.95.0
npm run engine:build
npm run build
npm start
```

```powershell
npm run dev
npm test
npm run test:ui
npm run package:portable  # compiles the engine and packages the executable
npm run test:portable     # actual launcher, MCP, PTY and profile relocation
npm run test:live         # real billable OAuth coding/MCP acceptance
npx tsx scripts/task-acceptance.ts --run
npx tsx scripts/media-acceptance.ts --run
```

Media acceptance does not change account privacy unless `--temporary-retention` is explicitly supplied after obtaining account-holder consent. It records the original setting and restores/verifies it in `finally`.

The original CLI is an optional compatibility/development fixture: `npm run runtime` downloads a pinned executable for CLI import and legacy transport tests. It is excluded from the 0.6.0 distributable. An absolute CLI path can still be selected in Settings; media generation requires the built-in engine.

The [Windows CI workflow](.github/workflows/windows.yml) builds the pinned Rust source, checks source and packaged GUI tests, launches/relocates the real portable executable, and uploads the executable with a SHA-256 sidecar. It uses no model credentials. In a managed workspace, a Chromium ACL error may require read/execute permission on the Electron runtime directory; keep Chromium's sandbox enabled.

## Sources and licensing

The engine embeds [Grok Build](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) at pinned revision `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, using its original Rust agent and authentication implementation. [Build modifications](native/UPSTREAM-CHANGES.md), Cargo.lock, upstream Apache license and generated Cargo dependency notices accompany the engine. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) describes distribution obligations. No Codex application code or assets are embedded. The reference checkout and optional CLI are excluded from packaging.
