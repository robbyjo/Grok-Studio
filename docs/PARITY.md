# Local workflow parity audit

Snapshot: October 7, 2026; Grok Studio 0.2.0 and official Grok 1.0.46 Windows x64. **Full local workflow parity is not achieved.** Earlier validation covered the foundation, not every local desktop feature. This checklist covers the identified local feature families, including MCP. It is an ongoing acceptance inventory, not a guarantee that a changing Codex product has no additional features.

The target is comparable Codex desktop workflows where Grok supports them. Harness capability, inherited Grok behavior, visible GUI controls and end-to-end validation are separate claims. No authenticated model turn was run here; fixture tests are labeled. Remote hosts and scheduled automations remain deferred by the user's choice.

## Core local workflows

| Workflow                            | Current GUI / evidence                                                      | Remaining acceptance work                                                               |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Project folders/new chats           | Native dialog and metadata implemented; seeded project context tested in UI | Manual dialog acceptance, project removal/rename, multiple roots and relocated projects |
| Chat naming/pinning/archive         | Native UI and restart persistence tested                                    | Project pins, custom groups, bulk actions, read/unread                                  |
| Search                              | Titles only                                                                 | Transcript/file/branch search and large histories                                       |
| Transcripts                         | ACP fixture + filesystem tests; native metadata persistence                 | Live model restart, large histories, import/export/migrations                           |
| Streaming Markdown/reasoning/plans  | ACP fixture tests; renderer implemented                                     | Authenticated long responses and vendor event coverage                                  |
| Tool input/output/progress          | ACP tool cards and fixture tests                                            | Actual edit/shell/MCP calls in model-backed turns                                       |
| Model/effort/mode selectors         | Runtime-advertised options; bridge implemented                              | Live account catalog and mode transitions                                               |
| Text attachments                    | Up to five explicitly selected files, 1 MiB each                            | Dialog acceptance, drag/drop, @file and selected-file context                           |
| Image/audio inputs                  | Not advertised by inspected Grok release                                    | Capability-gated support in a future runtime                                            |
| Steering/queue/edit/resubmit        | Missing; active-chat prompts rejected                                       | Durable queue and consistent history                                                    |
| Reconnect/resume                    | ACP fixture load/replay/deduplication tested                                | Authenticated resume, external sessions and event cursors                               |
| CLI import/fork/rewind              | Missing GUI workflows                                                       | Session browser, fork/checkpoints and recovery                                          |
| Parallel chats                      | Separate processes implemented                                              | Sustained authenticated concurrency, conflicts/resource limits                          |
| Background tasks/subagents          | Native behavior inherited; no dashboard                                     | Task tree, logs, progress/cancel and notifications                                      |
| Usage/context/cost                  | Missing                                                                     | Capability-gated accounting; distinguish estimates                                      |
| Preferences/notifications/shortcuts | Basic fixed shortcuts and runtime settings                                  | Completion/attention notifications, configurable shortcuts/theme/shell, accessibility   |

## Permissions and integrations

| Workflow                           | Current GUI / evidence                                                                                         | Remaining acceptance work                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Tool allow/reject/cancel           | Exact ACP options tested with child-process fixture                                                            | Authenticated edit/shell/MCP requests under real policy                              |
| Folder trust                       | Vendor callback fixture tested; real MCP project blocks tested                                                 | Production/authenticated acceptance; never silently grant trust                      |
| Windows agent sandbox              | **Unavailable in inspected runtime**; disclosed in UI                                                          | Actual Windows isolation design; renderer sandbox is separate                        |
| Grok sign-in                       | Advertised methods routed; native login through terminal                                                       | Live browser login/account change/expiry/cancellation                                |
| MCP inventory/scope                | Effective TOML definitions through native CLI; real runtime + UI tests                                         | Shadowed definitions, plugin/compat/managed inventory and source navigation          |
| MCP add/remove/enable/disable      | STDIO/HTTP/SSE, user/project scopes, argv/env/headers; runtime + UI tests                                      | Editing advanced definitions without losing fields; source edge cases                |
| MCP connection/discovery           | **Real Grok** initialized STDIO/HTTP/SSE fixtures and listed tools; GUI test passed                            | External providers, sustained reconnect/backoff/timeouts                             |
| MCP trust/failure reporting        | Untrusted project blocked; explicit trust for isolated fixture passed; missing command produces failing report | Production policy and authenticated tools                                            |
| MCP authentication                 | Native credentials/config inherited; env/header inputs                                                         | Dedicated OAuth sign-in/status/logout GUI; provider OAuth/bearer tests               |
| MCP tools/resources/prompts/policy | Native tool execution; dedicated browsers/editors missing                                                      | Model discovery/calls, resources/prompts compatibility, allow/deny/approval controls |
| Skills/plugins                     | Native Grok loading inherited                                                                                  | GUI inventory/install/update/remove/enable, scopes/trust and interoperability        |
| Instructions/rules/hooks           | Native loading inherited                                                                                       | Editors, effective policy/source display, actual hook execution                      |
| Browser/computer-use integrations  | No dedicated client capability promised; MCP can supply accepted tools                                         | Integration-specific runtime/approval validation; not automatic desktop parity       |

## Files, Git, terminal and distribution

| Workflow                              | Current GUI / evidence                                                                      | Remaining acceptance work                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| File browsing/preview                 | UTF-8 edit/save, stale-content rejection, drafts and quit warning; real filesystem/UI tests | Tabs, syntax/search/IDE opening, durable drafts, special ACL and cross-process race acceptance         |
| Diff/status/branch                    | Per-file staged/unstaged diffs, status and worktrees tested                                 | Side-by-side navigation, watch refresh and inline comments                                             |
| Stage/revert/commit/push/PR           | File stage/unstage and reviewed commits; real Git and native GUI tests                      | Chunk/revert actions, branch controls, push and PR review; concurrent external Git writers             |
| Worktree creation                     | Real Git tests preserve dirty original; new chat from HEAD                                  | Branch/ref selection, working changes, setup scripts and dialog acceptance                             |
| Worktree attach/handoff/apply/archive | Missing GUI workflows                                                                       | Recoverable lifecycle, conflicts, ignored assets and saved chats                                       |
| Interactive terminal                  | Real PowerShell/ConPTY tested, including packaged native dependency                         | Multiple tabs, shell choice, persistent scrollback/reconnect                                           |
| Agent reading GUI terminal output     | Missing bridge; agent has separate native shell tools                                       | Explicitly scoped terminal context and output ordering                                                 |
| Setup scripts/reusable actions        | Missing                                                                                     | Project-scoped setup/actions, platform overrides and cancellation                                      |
| Portable runtime/distribution         | Bundled, hash-pinned Grok; adjacent profile/data routing                                    | Actual launcher/relocation results in VALIDATION.md; clean-machine QA, signing, updates/version gating |
| Reliability/diagnostics               | Process/cancel recovery and corrupt-state preservation tested                               | Log viewer, crash recovery, bounded storage/history and performance                                    |
| Mac/Linux/Windows ARM64               | No validated release                                                                        | Platform builds, shell/PTY, signing/notarization and security                                          |

## Acceptance gates and next priorities

1. Actual portable launch/relocation, embedded runtime, terminal and profile checks pass locally. Test a clean Windows machine without development dependencies and cross-machine authentication.
2. Run authenticated acceptance in a disposable repository: read/edit/test, approve/reject shell, cancel, restart/resume, change model/mode, and discover/call a known MCP tool. Connection diagnostics alone do not satisfy this gate.
3. Complete daily GUI gaps: MCP OAuth/advanced policies/catalogs, skill/plugin management, richer editor, Git chunks/push/comments, CLI session import/fork and environment actions.
4. Complete worktree lifecycle, task dashboards, steering/queue, context/usage and notifications. Validate signing/update/recovery/performance before a stable release. Add Mac/Linux afterward.

## Architecture and source basis

Electron main owns native dialogs, file/Git operations and PTYs. The renderer uses an isolated, sandboxed preload with allowlisted IPC. ACP covers sessions, prompts, updates, modes/config and permissions; Grok executes its own native tools. Only the implemented folder-trust extension is advertised. Credentials remain Grok-owned; portable launches select their profile with GROK_HOME and never copy personal credentials.

MCP management uses separate argv elements with no shell and shares native config/policy. Inventory omits configured env/header values and they are not stored in desktop state. Changes reject active turns, block new turns during writes and disconnect idle chat processes so reconnection loads changes. Doctor exit code 1 with a health report is shown as a failing diagnostic.

The editor uses same-directory temporary replacement and content-hash checks; it does not acquire an OS lock against external writers. Drafts are memory-only. Git actions use literal paths and an index hash for stale-review rejection. Native Git hooks can run and may change the index; external commands can race a GUI operation. Active agent turns block GUI saves/staging/commits, and canceled quit preserves existing sessions.

Primary sources checked for this audit:

- [Codex/ChatGPT MCP](https://learn.chatgpt.com/docs/extend/mcp): transports/auth, shared config, desktop setup and advanced policies.
- [Local environments](https://learn.chatgpt.com/docs/environments/local-environment), [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [terminal](https://learn.chatgpt.com/docs/integrated-terminal), [projects/chats](https://learn.chatgpt.com/docs/projects), [code review](https://learn.chatgpt.com/docs/code-review).
- [Pinned Grok MCP guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md), [CLI](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/mcp_cmd.rs), [doctor](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/mcp_doctor.rs), [ACP guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).

Commands/results and practical limits are in [VALIDATION.md](VALIDATION.md). No parity percentage is claimed: these rows have different scope, and implemented but unvalidated behavior is not end-to-end completion.
