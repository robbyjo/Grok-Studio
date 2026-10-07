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
- [ ] Authenticate Grok and run a disposable-repository acceptance suite: real edit/test/approve/reject/cancel/resume, model/mode switches and a real MCP tool call. This requires account authentication; fixtures do not complete this gate. See [the live acceptance procedure](docs/LIVE-ACCEPTANCE.md).
- [ ] Test portability on a clean Windows machine and cross-machine authentication behavior.

## Integration parity

- [ ] MCP OAuth sign-in/status/logout GUI and provider acceptance.
- [ ] Edit existing MCP definitions without dropping advanced fields; inspect sources and shadowing.
- [ ] Inventory plugin/compat/managed MCP servers, tools/resources/prompts and per-tool policies.
- [ ] Skill/plugin management: inventory, install/update/remove/enable, trust and scopes.
- [ ] Instructions/rules/hooks editors and effective policy/source views.
- [ ] Environment setup scripts and reusable project actions.

## Remaining local workflows

- [ ] CLI session import, fork and checkpoint/rewind.
- [ ] Worktree branch selection, attach/handoff/apply and recoverable archive.
- [ ] Git chunk actions, inline review comments, branch/push and pull request integration.
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
