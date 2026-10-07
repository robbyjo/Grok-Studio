# Validation record

Validation performed on Windows x64 on October 6–7, 2026 (America/New_York). Current portable release: 0.2.0.

## Confirmed

- TypeScript checks and production renderer/main/preload build pass.
- Backend regression suite: **24 tests passed, none skipped** with the pinned runtime present. Covers fragmented Unicode JSON-RPC, protocol errors/timeouts/process exit, transcript persistence/replay deduplication and restoration, cross-session update isolation, exact allow/reject/cancel choices, busy-chat rejection, cancel/shutdown, unsupported protocol/load capability, trust decisions, filesystem traversal and junction escape, binary/size limits, real Git diffs, dirty checkout preservation, worktree conflicts, portable/legacy path routing and MCP validation/lifecycle. Editor tests cover Unicode/BOM/CRLF preservation, invalid Unicode/UTF-8, stale-content refusal, temporary cleanup and hardlink/Git-metadata rejection. Git tests cover literal filenames, stale index rejection, unborn repositories, rename unstaging, real merge conflicts, preserving unstaged edits and refusing commits that include staged files outside a nested workspace.
- **Real MCP transport acceptance:** official Grok added/listed/toggled/removed definitions in isolated user/project config; initialized a local STDIO fixture plus local Streamable HTTP and SSE servers; negotiated MCP and discovered a tool on each. Inventory omitted configured environment secrets. Duplicate add was refused. Untrusted project server was blocked; explicit trust for the isolated fixture allowed handshake/discovery. Missing executable produced a failing health report, including native doctor's nonzero exit. These are genuine runtime connections, not simulated Grok transport responses. Doctor does not exercise model-backed tool invocation or tool-call approvals.
- Official Windows runtime `grok 1.0.46 (2765805b9442)` negotiated ACP v1 with `loadSession`, embedded context, session list/resume/close and HTTP/SSE MCP support. It advertised no image/audio prompt support. Isolated smoke-test home; no authentication or model prompt was sent.
- Downloaded smoke-test executable SHA256: `e09c0893cee4850a569bd90e7aed956ea503b34f551637d58187ca4dfb931611`. This is a locally recorded hash, not a verified publisher-signature or sidecar-hash assertion.
- Reference source commit: `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (source snapshot and released binary revisions differ).
- `npm audit --omit=dev` reported zero vulnerabilities for production dependencies on October 7, after targeted transitive overrides. This is an advisory snapshot, not a security certification.

## Native UI and distribution

Native Electron validation passed from both the source build and the final 0.2.0 packaged Windows executable. It exercises an isolated test project and data directory, persisted chat operations, real file preview/Git diffs, a real PowerShell/ConPTY terminal, renderer Node isolation, rejection of an out-of-root file read, settings, archive/restore and restart persistence. The terminal evaluated `40 + 2` and returned `TERMINAL_42`; the assertion checks the result rather than the echoed command. The GUI added an MCP server, showed successful native handshake/tool discovery, disabled/re-enabled it and removed it. Screenshots were visually inspected. The 0.2.0 scenario also edited/saved/reloaded files, retained a draft across file switching, rejected an external modification without losing either draft or disk content, exercised Ctrl+S and staged/unstaged/committed a real file while preserving another untracked file. A native-dialog response stub exercises the real unsaved-draft quit guard: repeated close does not bypass it, canceling an application quit retains a PowerShell variable in the same live terminal.

`npm run package:portable` produced **release/Grok-Studio-0.2.0-Portable.exe**, 140,684,979 bytes, SHA-256 **421bd9aae0eb6d6ff9255cd413f864a0015e06829ff024f20fd4631106527b7d**. Authenticode reports **NotSigned**. The source and packaged GUI acceptance scenarios both passed; actual portable launch and relocation also passed for this artifact. Branding is Grok Studio; original portable and nonportable data locations remain compatible.

Historical 0.1.1: `npm run package:portable` produced **release/Grok-Desktop-0.1.1-Portable.exe**, 140,669,231 bytes, SHA-256 **14cd9be5d1d745a7f20d316846f74a757ad5cb9079dc72b05232f58c0552611c**. Authenticode reports **NotSigned**. It bundles the unmodified pinned Grok runtime and runtime/dependency notices. No installer is required.

`npm run test:portable` launched the actual self-extracting EXE from an isolated folder containing spaces, without desktop/Grok home overrides. It verified adjacent desktop and Electron session storage, adjacent Grok home, the embedded runtime's hash, a healthy MCP connection, native terminal execution and saved chat metadata. The terminal also resolved `grok` on its PATH and returned the bundled runtime version; no separate CLI installation was needed. After quit, it moved the whole executable/data folder within the isolated workspace and relaunched. Saved title/pin and user MCP configuration survived, paths resolved to the new location and MCP connectivity passed again. Output: `PORTABLE_LAUNCH_RUNTIME_MCP_TERMINAL_OK` and `PORTABLE_RELOCATION_PROFILE_PERSISTENCE_OK`. This tests portability on this Windows machine, not clean-machine or cross-machine authentication behavior.

Historical 0.1.0 artifact: `npm run package:win` produced `release/Grok Desktop Setup 0.1.0.exe` (116,198,623 bytes), SHA256 `9d8541c03db8d7879c816eea2846132672e1979a9d2b20dfde09a62bf3c510a0`, unsigned. This earlier installer is superseded by the portable delivery above; clean-machine installer/uninstaller testing was not performed.

Screenshots under `.test-data/` are native test captures with a deliberately labeled fixture project. They are not evidence of a live Grok model run.

## Windows CI

The pinned-action workflow in `.github/workflows/windows.yml` runs the build/typechecks, formatting, all backend/native MCP tests, source GUI, portable packaging, packaged GUI and actual portable launcher/relocation. It uploads the executable/hash only after acceptance passes. Hosted execution has not yet been observed; local results above are separate. No account/model credentials are configured.

## Not yet validated

- Authenticated paid/model-backed turns, account/model availability, actual agent file edits/shell commands and their production approval behavior.
- OAuth browser login, external MCP providers, bearer/OAuth credentials, model-backed MCP calls, resource/prompt support, tool policies, managed configurations, vendor trust rollout, skill/plugin interoperability and subagent/background events.
- Clean-machine portability, cross-machine credential portability, signing, auto-update, Windows ARM64, large histories and sustained concurrent-session performance.
- macOS/Linux builds and OS-specific agent sandbox behavior.

The isolated deterministic ACP fixture proves client protocol/state behavior; it does not establish Grok model quality or full Codex feature parity. Before everyday use, sign in to Grok and run a small temporary-repository task: read files, request an edit, approve/reject a shell command, stop a long command, resume after restart, switch advertised model/mode, and verify no unrelated files change.
