const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve('upstream/grok-build/crates/codegen/xai-grok-shell/src');
function patch(file, anchor, replacement) {
  const p = path.join(base, file),
    s = fs.readFileSync(p, 'utf8');
  if (s.includes(replacement)) return;
  if (!s.includes(anchor)) throw new Error('Workbench MCP patch anchor missing: ' + file);
  fs.writeFileSync(p, s.replace(anchor, replacement));
}
const mcp = path.join(base, 'extensions/mcp.rs');
const source = fs.readFileSync('native/studio-engine/patches/mcp-discovery.rs', 'utf8');
const marker = '\n// Workbench discovery extension\n';
const before = fs.readFileSync(mcp, 'utf8');
const original = before.split(marker)[0];
const after = original + marker + source;
if (after !== before) fs.writeFileSync(mcp, after);
patch(
  'extensions/mcp.rs',
  '    match route_mcp_method(args.method.as_ref()) {',
  '    if args.method.as_ref() == "x.ai/mcp/browse" { return handle_studio_browse(agent, args).await; }\n    match route_mcp_method(args.method.as_ref()) {',
);
patch(
  'session/commands.rs',
  '    ReadMcpResource {',
  `    StudioMcpBrowse {
        server: String, operation: String, cursor: Option<String>, name: Option<String>,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
        respond_to: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    ReadMcpResource {`,
);
patch(
  'session/handle.rs',
  '    pub(crate) async fn read_mcp_resource(',
  `    pub(crate) async fn studio_mcp_browse(&self, server: String, operation: String, cursor: Option<String>, name: Option<String>, arguments: Option<serde_json::Map<String, serde_json::Value>>) -> Result<serde_json::Value, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(SessionCommand::StudioMcpBrowse { server, operation, cursor, name, arguments, respond_to: tx }).map_err(|_| "session closed")?;
        rx.await.unwrap_or_else(|_| Err("session closed".to_string()))
    }
    pub(crate) async fn read_mcp_resource(`,
);
patch(
  'session/acp_session_impl/run_loop.rs',
  '                        SessionCommand::ReadMcpResource { server_name, uri, respond_to } => {',
  `                        SessionCommand::StudioMcpBrowse { server, operation, cursor, name, arguments, respond_to } => {
                            let state = session.mcp_state.clone();
                            tokio::task::spawn_local(async move {
                                let result = crate::extensions::mcp::studio_mcp_browse(&state, &server, &operation, cursor, name, arguments).await;
                                let _ = respond_to.send(result);
                            });
                        }
                        SessionCommand::ReadMcpResource { server_name, uri, respond_to } => {`,
);
