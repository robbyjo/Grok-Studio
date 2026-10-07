# GitHub OAuth provider

On October 7, 2026 the official GitHub MCP v2.0.1 Windows STDIO server was installed in the selected portable Grok profile. Browser authorization completed, and its real `get_me` tool returned an authenticated identity through Grok Studio's native ACP connection. The 0.4.0 GUI's **Sign in / verify identity** button returned the real identity, and its **Clear GitHub connection** confirmation completed after verified native process shutdown. No PAT was used. The identity and token are not published in this repository.

The current definition intentionally requests only `read:user`, uses `--read-only --toolsets context`, and exposes the identity tool. This validates provider OAuth, not repository write access or HTTP client OAuth. [GitHub's official local OAuth documentation](https://github.com/github/github-mcp-server/blob/v2.0.1/docs/oauth-login.md) describes the baked-in OAuth application and memory-only token. Disconnecting or quitting clears that process's token; provider consent remains until revoked in GitHub account settings. Subsequent connections may need browser authorization again.

## Reproduce installation on Windows x64

Run `scripts/install-github-mcp.ps1 -GrokHome '<selected Grok profile>'`. The script downloads a pinned release, verifies archive and executable SHA256, installs the executable and available license notices under `tools/github`, and touches no credentials. Restart Grok Workbench. The optional provider is separate from the portable application artifact.

In Settings → MCP servers, add a user STDIO definition:

```text
Name: github-oauth
Command: github-mcp-server.exe
Arguments (one per line):
stdio
--read-only
--toolsets
context
--oauth-scopes
read:user
Environment:
GITHUB_PERSONAL_ACCESS_TOKEN=
```

Connect Grok and send a benign first prompt to initialize its lazy MCP clients. In Effective runtime integrations, load the MCP catalog and choose **Sign in / verify identity**. Complete the browser authorization yourself. **Clear GitHub connection** closes native processes and clears their in-memory tokens; it does not revoke consent or delete other servers' credentials.

The profile-relative executable name and startup PATH entry support moving the portable profile together with the application. Transferring account credentials is a separate explicit choice. GitHub's hosted MCP server requires a registered OAuth client; this STDIO acceptance does not establish hosted-server OAuth parity.

Pinned archive SHA256: `ec37110134fd94f2980ae78ed0d69493623e730da97f0983050cc46539c30a30`.

Pinned executable SHA256: `e4cdefe436b7d7073fb8a542389f3e08764787003e5f240861e1a91937a2bb65`.

Repeat with `npm run test:github-oauth` after installing the optional provider. It sends one real benign model prompt to initialize Grok's lazy MCP clients, waits for the account's browser authorization, verifies the identity through both the backend and GUI, and clears the connection. Its ignored local report contains only acceptance flags, not the identity or credentials.
