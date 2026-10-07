# Authenticated local workflow acceptance

This is the live acceptance procedure, not a result record. Run it with the Windows portable app and a signed-in Grok account. Automated fixtures cover client protocol behavior and native MCP connections; this suite checks actual model turns and their effects. Passed version-specific results are recorded in [VALIDATION.md](VALIDATION.md).

## Prepare an isolated project

From the source checkout, use a new folder under `.test-data`:

```powershell
New-Item -ItemType Directory -Path (Join-Path $PWD '.test-data') -Force | Out-Null
$taskAcceptance = Join-Path $PWD ('.test-data/live-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskAcceptance | Out-Null
git -C $taskAcceptance init -b main
git -C $taskAcceptance config user.name 'Grok Workbench acceptance'
git -C $taskAcceptance config user.email 'acceptance@example.invalid'
Set-Content -LiteralPath (Join-Path $taskAcceptance 'value.txt') -Value 'original' -Encoding utf8
git -C $taskAcceptance add value.txt
git -C $taskAcceptance commit -m 'Acceptance baseline'
$taskAcceptance
```

Open this folder in Grok Workbench. Use the built-in engine and **Settings → Authentication → Grok account (OAuth) → Connect / sign in with selected method**, then complete browser sign-in. An API key can instead be entered locally in Settings. Keep the existing permission policy visible; tool approval and folder trust are separate decisions. Record app/engine versions, the selected model/mode, date and the test repository HEAD. Keep credentials out of evidence files.

## Checks and required evidence

1. **Read and edit.** Ask Grok to read `value.txt`, replace its contents with `edited by Grok`, and run a shell check that reads it back. Confirm the transcript shows the actual tools and results, the file contains the requested text, and `git diff` shows only that change. Compare the GUI file/diff views with the filesystem.

2. **Approve and reject.** Exercise actions that require approval under the configured Grok policy. For an allowed action, select the exact one-time allow option and verify the expected harmless file effect. For a separate action, select reject and verify its target file was not created. Record the tool request, displayed choices, selected choice and actual disk result. If the runtime allows the actions without prompting, this approval check remains unexercised; successful execution alone does not pass it.

3. **Cancel a running command.** Ask Grok to run a bounded shell command that waits 30 seconds and then writes `late-marker.txt`. Select **Stop turn** after the tool is running. Verify the chat becomes idle/interrupted and no pending approval remains. After the command's original completion time, inspect the marker and process outcome. Record whether cancellation also stopped the underlying command; an idle composer alone does not establish that.

4. **Restart and resume.** Complete a turn containing a distinctive phrase, quit normally and reopen the same EXE with the same companion data folder. Ask Grok about that phrase. Verify the original session is resumed, previous entries are not duplicated, and the model can use the earlier context. A resumed GUI transcript without model context does not pass this check.

5. **Model and mode configuration.** Connect the chat in Settings if needed. Change each runtime-advertised model, effort or mode control while idle, then send a small read-only prompt. Record the selected value, accepted session update and resulting turn. Options absent from the account/runtime are reported as unavailable rather than passed.

6. **Real MCP invocation.** In **Settings → MCP servers**, add a temporary user-scoped STDIO server using your absolute Node executable path and one argument: the absolute path to `tests/fixtures/mcp.mjs` in this checkout. Set `MCP_FIXTURE_LOG` to an absolute log path in the isolated acceptance folder. Test the connection, reconnect the chat, then ask Grok to invoke the server's `say_hello` tool. Verify both the tool activity/result `HELLO_FROM_MCP_FIXTURE` and a `tools/call` entry in the fixture log. `initialize` and `tools/list` from connection diagnostics alone do not pass this check. Remove the temporary server afterward.

7. **Policy and configuration failures.** Disable the temporary MCP server and reconnect; confirm it is unavailable for the next turn. Where folder-trust callbacks are advertised, use a fresh project and verify rejection does not silently trust it. Record unavailable callbacks and provider authentication gaps explicitly.

8. **Final scope review.** Inspect Git status/diff, file contents, pending approvals and running child processes. Confirm only the expected fixture files changed. Record failures with exact UI/runtime errors and reproduction steps. Do not mark the TODO acceptance gate complete until the required scenarios have observed results.

Save a short result table with scenario, pass/fail/unavailable, model/mode and evidence paths. External-provider OAuth, cross-machine credential behavior, clean-machine portability and sustained concurrency require separate acceptance; this bounded suite does not establish full Codex parity.
