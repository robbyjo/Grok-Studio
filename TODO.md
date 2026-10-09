# Grok Workbench TODO

Windows local coding workflows come first. The detailed capability/evidence matrix is in [docs/PARITY.md](docs/PARITY.md). Checked items mean the stated scope is implemented and tested; they do not imply full Codex parity.

## Delivered foundation

- [x] Projects, persistent chats, naming/pinning/archive and restore.
- [x] ACP streams, tool activity, plans, runtime configuration and approval/trust UI.
- [x] Cancellation, process cleanup, session-load fixtures and restart recovery.
- [x] Real PowerShell terminal, file previews, Git diffs/status and worktree creation.
- [x] Plain project folders without Git: explanatory Changes state, disabled Git controls and refresh after later initialization; source GUI/backend regression acceptance.
- [x] MCP TOML inventory, add/remove/toggle and native STDIO/HTTP/SSE connection diagnostics.
- [x] Portable Windows x64 executable with a built-in Grok library, adjacent profile/data and relocation tests; no separate Grok executable required.
- [x] Source/dependency licensing, reproducible runtime hash and validation/parity documentation.

## Current priorities

- [x] Publish the initial substantive source/docs to robbyjo/Grok-Studio and verify the remote revision.
- [x] Safe text editor: edit/save existing workspace files, detect external modifications, preserve unsaved drafts and reject paths outside the workspace or Git metadata.
- [x] File-oriented Git changes: stage/unstage individual files, inspect their diffs and commit the staged index with a reviewable message; validate paths and handle conflicts/unborn repositories.
- [x] Keep project branding consistent with Grok Workbench while preserving existing desktop data paths.
- [x] Add Windows CI for build, backend, native UI, packaged GUI and actual portable launch/relocation checks. Hosted-run outcome is recorded separately in VALIDATION.md.
- [x] Authenticate Grok and run the source and final 0.6.0 packaged GUI disposable-repository acceptance suite: real edit/test/approve/reject/cancel/resume, model/effort switches and a real MCP call. Modes were not advertised by this runtime. See [current validation](docs/VALIDATION.md) and [earlier observed live results](docs/LIVE-RESULTS-2026-10-07.md).
- [x] Fresh-profile portable launch/PowerShell/native inventory, relocation and persistence on USER-PC over SSH; no live credentials transferred. USER-PC already has Git/Grok, so this is existing-machine evidence.
- [x] Fresh USER-PC OAuth sign-in, real model request, full app restart and native session resume without credential transfer.
- [ ] Dependency-free/pristine Windows acceptance, Windows reboot persistence and forced real token expiry/refresh.

## Integration parity

- [x] MCP OAuth GUI controls and real official GitHub STDIO OAuth identity acceptance; server-managed memory-only logout. HTTP local credential forgetting is scoped and regression-tested.
- [ ] Real client-managed HTTP OAuth provider sign-in/expiry/reconnect/logout acceptance; STDIO provider OAuth does not complete this distinct gate.
- [x] Edit existing TOML/JSON MCP definitions with exact text/comment/advanced-field preservation, duplicate-source inspection and stale-content checks.
- [x] Runtime effective MCP source/tool inventory and per-tool controls, including plugin/compat/managed provenance supplied by Grok.
- [x] Real native MCP setup, per-tool disable/enable and known-URI resource read acceptance.
- [x] Native MCP resource/template/prompt enumeration, provider pagination, argument forms and reviewed text insertion. Live native fixture acceptance is recorded in VALIDATION.md.
- [x] Skill/plugin management: inventory, registered skill paths, enable/disable, plugin install/update/remove and source/trust/scope review; real native fixture lifecycle passed.
- [x] Git-backed plugin update/version acceptance with a real cloned disposable Git source, preserving its original source on uninstall.
- [ ] Marketplace management and exhaustive managed-policy/compat-source acceptance.
- [x] Existing instruction/rule/hook configuration editors, effective hook source/pinned-policy views and native hook registration/toggles; real native lifecycle passed.
- [x] Real native Windows Stop-hook execution acceptance with a verified file marker.
- [x] Effective instruction/rule inventory through the native loader, Git-bounded ancestor source editing, managed/requirements read-only controls and requirements clamp for runtime mirrors.
- [ ] Exhaustive managed instructions/rules precedence across every compatibility source and administrator deployment.
- [x] Explicit environment setup and reusable project actions: reviewed executable/argv/workspace, edit/remove, captured output and owned-process cancellation.

## Remaining local workflows

- [x] Task → test → review with reviewed automatic worktree creation, configured test execution, persistent results/cancellation/recovery and selected-file apply to clean targets. Real OAuth GUI acceptance passed; see [task workflow](docs/TASK-WORKFLOW.md).
- [x] Lazy Monaco coding editor, local workers, bounded relative-import navigation, completion/diagnostics/find/replace, keyboard saves and guarded file creation/rename. Full project LSP/type graphs remain future work; see [editor scope](docs/CODE-EDITOR.md).
- [x] Fix Windows CI Git-root ancestry under TEMP aliases; prepare exact-successful-CI-artifact manual publication with immutable source/tag/checksum checks. Live Foundation signing remains gated.
- [x] Explicit same-pinned-native-format engine upgrade recipe with verified private durable-profile/SQLite backup and worker revalidation. Unknown format migrations and a published signed newer-engine update remain open.

- [x] Persistent editor tabs, bounded syntax highlighting, literal filename/content search with pagination/cancellation and matching-line navigation.

- [x] Real CLI session import/history, native fork and pre-prompt checkpoints with reviewed file/conversation rewind and recovery backups.
- [x] Worktree branch/base selection, attach/native conversation handoff, reviewed apply to clean targets, recoverable archive and detached restore.
- [x] Git stage/unstage/revert text chunks, local inline review comments, clean-only branch selection and reviewed non-force push.
- [x] Install/authenticate GitHub CLI and pass real GUI PR listing/reviewed draft publication acceptance. Disposable PR #1 was closed without merging and its branch deleted.
- [x] Remote PR diff/inline review drafts, head-bound preview and explicit COMMENT/APPROVE/REQUEST_CHANGES submission, bounded ledger and uncertain-outcome recovery. Real GUI COMMENT/inline acceptance passed on disposable PR #2, subsequently closed without merging and its branch deleted. Self-approval/request-changes are fixture-tested.
- [x] Literal phrase search across saved transcripts and chat metadata, archived/removed scope controls, matching-message navigation and bounded/cancellable results.
- [x] Project rename, reversible sidebar removal and restore/reopen, preserving chats, files, worktrees and in-memory drafts; refuse removal during active turns.
- [x] Project pins/groups, bulk organization, indexed search/pagination and bounded history storage; 100,000-entry/500-chat acceptance with a 60-second concurrent simulated-stream run passed.
- [x] Steering, queued prompts, background/subagent dashboard and owned task controls; real steering/queue/background kill and native subagent inspect/cancel passed.
- [x] Multiple terminal tabs, shell selection, bounded persistent scrollback and explicit editable agent terminal context.
- [x] Process-scoped usage/cost and available-context indicators, opt-in notifications, configurable shortcuts, keyboard focus and reduced-motion support.
- [x] Diagnostics/log viewer, bounded log/history storage, durable drafts and real renderer crash/reload recovery; bounded concurrent history performance acceptance passed.
- [x] Eight overlapping real OAuth model turns with distinct native session IDs; observed peak 8. This is separate from the simulated storage soak.
- [x] Actual two-hour history/storage soak with eight simulated streams: 500 chats/100,000 seeded entries, 13,935 cycles, loaded cache 8 chats/1,600 entries and sampled peak RSS about 348 MiB. Separate from the eight real OAuth turns.
- [x] Aggregate profile inventory/admission budget and reviewed old, archived native session export/prune/hash restore; real native session OAuth resume passed. Budget is admission control, not an OS disk quota.
- [x] Abrupt owned main-process termination/relaunch and interrupted SQLite transaction recovery; durable drafts, paused queues and no automatic agent restart verified. Physical power-loss/reboot remains outside this acceptance.
- [ ] Full screen-reader/assistive-technology audit and provider-reported context-window validation; current account does not report context size.
- [x] Native engine revision/hash/ABI gates, manifest-bound portable download/replacement/binary rollback, retained-file cleanup and failed-worker recovery; Windows worker/PE regressions and actual portable exit/replacement/restart/rollback with GUI draft preservation passed. See [portable updates](docs/PORTABLE-UPDATES.md).
- [x] Optional certificate/Azure signing build configuration, preflight and post-build signature/publisher verification. Azure is paid; no account/resource/billing signup was performed.
- [ ] Actual trusted signing service/certificate build and published signed newer-version update/rollback/clean-machine trust acceptance.
- [ ] SignPath Foundation application/approval: create owner account, confirm MFA/team roles, agree upstream artifact restrictions and validate live signed portable. Gated CI integration and public signing/privacy policy drafts are prepared. [Setup](docs/SIGNPATH.md); no application submitted.
- [x] Investigate Windows agent isolation: real disposable AppContainer ACL/private-file/loopback probe passed and profile cleanup verified. See [investigation](docs/WINDOWS-ISOLATION.md).
- [x] Optional reviewed whole-app Windows Sandbox launch configuration: isolated bounded project copy, no host profile mapping, explicit network switch and disabled device/clipboard redirection.
- [ ] Live Windows Sandbox tool/hook/terminal/descendant containment acceptance. Host reboot deferred during the user's week-long experiment.
- [ ] In-process agent AppContainer/broker integration. Normal launches retain host Windows permissions.

## Later platform/scope work

- [ ] macOS/Linux releases with platform-specific runtime, PTY, signing and security acceptance.
- [ ] Windows ARM64 support.
- [ ] Remote hosts and scheduled automations, deferred by user choice.
- [ ] Browser/computer-use features only where a documented runtime/service supports them.

## Built-in engine and media

- [x] Embed the pinned Apache-2.0 Grok Rust agent library in an isolated native helper; remove the packaged Grok CLI dependency while preserving OAuth and API-key selection.
- [x] Original real OAuth coding/MCP acceptance, native integration lifecycle and CLI import/fork/rewind/handoff acceptance through the embedded engine.
- [x] Session-only API keys, optional Windows encrypted persistence, method selection and forgetting; native GUI secret-omission/encryption acceptance.
- [x] Always-visible account/sign-in control above Settings; OAuth before project selection, saved account status and default encrypted API-key persistence with full app restart/decryption acceptance. Successful OAuth dismisses Account/Settings; unsaved Settings configuration retains its confirmation guard.
- [ ] Real API-key coding/media acceptance with an account-supplied key; OAuth passes do not complete this gate.
- [x] Real OAuth image, speech and video generation plus GUI playback. Video privacy test restored and verified the original zero-data-retention setting.
- [x] Arbitrary-file prompt attachments, durable owned copies, inline bounded images/text, binary references, local image/audio/video preview, export/delete and storage ceiling.
- [ ] General music/sound-effect generation, image-to-video/keyframes and protected remote-bucket retrieval.
