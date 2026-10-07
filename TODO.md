# Grok Studio TODO

Windows local coding workflows come first. The detailed capability/evidence matrix is in [docs/PARITY.md](docs/PARITY.md). Checked items mean the stated scope is implemented and tested; they do not imply full Codex parity.

## Delivered foundation

- [x] Projects, persistent chats, naming/pinning/archive and restore.
- [x] ACP streams, tool activity, plans, runtime configuration and approval/trust UI.
- [x] Cancellation, process cleanup, session-load fixtures and restart recovery.
- [x] Real PowerShell terminal, file previews, Git diffs/status and worktree creation.
- [x] MCP TOML inventory, add/remove/toggle and native STDIO/HTTP/SSE connection diagnostics.
- [x] Portable Windows x64 executable with bundled Grok, adjacent profile/data and relocation tests.
- [x] Source/dependency licensing, reproducible runtime hash and validation/parity documentation.

## Current priorities

- [x] Publish the initial substantive source/docs to robbyjo/Grok-Studio and verify the remote revision.
- [x] Safe text editor: edit/save existing workspace files, detect external modifications, preserve unsaved drafts and reject paths outside the workspace or Git metadata.
- [x] File-oriented Git changes: stage/unstage individual files, inspect their diffs and commit the staged index with a reviewable message; validate paths and handle conflicts/unborn repositories.
- [x] Keep project branding consistent with Grok Studio while preserving existing desktop data paths.
- [x] Add Windows CI for build, backend, native UI, packaged GUI and actual portable launch/relocation checks. Hosted-run outcome is recorded separately in VALIDATION.md.
- [x] Authenticate Grok and run the source and 0.4.0 packaged GUI disposable-repository acceptance suite: real edit/test/approve/reject/cancel/resume, model/effort switches and a real MCP call. Modes were not advertised by this runtime. See [observed live results](docs/LIVE-RESULTS-2026-10-07.md).
- [ ] Test portability on a clean Windows machine and cross-machine authentication behavior.

## Integration parity

- [x] MCP OAuth GUI controls and real official GitHub STDIO OAuth identity acceptance; server-managed memory-only logout. HTTP local credential forgetting is scoped and regression-tested.
- [ ] Real client-managed HTTP OAuth provider sign-in/expiry/reconnect/logout acceptance; STDIO provider OAuth does not complete this distinct gate.
- [x] Edit existing TOML/JSON MCP definitions with exact text/comment/advanced-field preservation, duplicate-source inspection and stale-content checks.
- [x] Runtime effective MCP source/tool inventory and per-tool controls, including plugin/compat/managed provenance supplied by Grok.
- [x] Real native MCP setup, per-tool disable/enable and known-URI resource read acceptance.
- [ ] MCP resources/prompts enumeration. No enumeration extension is exposed by this runtime; GUI reports this limit.
- [x] Skill/plugin management: inventory, registered skill paths, enable/disable, plugin install/update/remove and source/trust/scope review; real native fixture lifecycle passed.
- [x] Git-backed plugin update/version acceptance with a real cloned disposable Git source, preserving its original source on uninstall.
- [ ] Marketplace management and exhaustive managed-policy/compat-source acceptance.
- [x] Existing instruction/rule/hook configuration editors, effective hook source/pinned-policy views and native hook registration/toggles; real native lifecycle passed.
- [x] Real native Windows Stop-hook execution acceptance with a verified file marker.
- [ ] Managed instructions/rules precedence across every ancestor/source.
- [x] Explicit environment setup and reusable project actions: reviewed executable/argv/workspace, edit/remove, captured output and owned-process cancellation.

## Remaining local workflows

- [x] Real CLI session import/history, native fork and pre-prompt checkpoints with reviewed file/conversation rewind and recovery backups.
- [x] Worktree branch/base selection, attach/native conversation handoff, reviewed apply to clean targets, recoverable archive and detached restore.
- [x] Git stage/unstage/revert text chunks, local inline review comments, clean-only branch selection and reviewed non-force push.
- [ ] Live GitHub CLI PR listing/draft publication acceptance. GUI integration exists; GitHub CLI is not installed on this machine. Comments remain local; remote review submission is not implemented.
- [x] Literal phrase search across saved transcripts and chat metadata, archived/removed scope controls, matching-message navigation and bounded/cancellable results.
- [x] Project rename, reversible sidebar removal and restore/reopen, preserving chats, files, worktrees and in-memory drafts; refuse removal during active turns.
- [ ] Project pins/groups, bulk organization, indexed search/pagination, bounded history storage and sustained large-history acceptance.
- [ ] Steering, queued prompts, background/subagent dashboard and task controls.
- [ ] Multiple terminal tabs, shell selection, persistent scrollback and explicit agent terminal context.
- [ ] Usage/context/cost indicators, notifications, configurable shortcuts and accessibility.
- [ ] Diagnostics/log viewer, crash recovery, bounded storage and sustained concurrency/performance tests.
- [ ] Signing, runtime/update version gates and rollback.
- [ ] Investigate actual Windows agent isolation; Grok's inspected OS sandbox is unavailable on Windows.

## Later platform/scope work

- [ ] macOS/Linux releases with platform-specific runtime, PTY, signing and security acceptance.
- [ ] Windows ARM64 support.
- [ ] Remote hosts and scheduled automations, deferred by user choice.
- [ ] Image/audio/browser/computer-use features only where a documented runtime/service supports them.
