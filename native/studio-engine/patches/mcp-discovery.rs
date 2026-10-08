// Apache-2.0 Workbench extension: same session client and OAuth/policy boundary as resource reads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioMcpBrowse {
    session_id: Option<String>, server: String, operation: String,
    #[serde(default)] cursor: Option<String>, #[serde(default)] name: Option<String>,
    #[serde(default)] arguments: Option<serde_json::Map<String, serde_json::Value>>,
}
async fn handle_studio_browse(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req = parse_params::<StudioMcpBrowse>(args)?;
    if req.operation == "instructions" {
        let cwd = agent.launch_cwd().to_path_buf();
        let trusted = crate::agent::folder_trust::project_scope_allowed(&cwd);
        let (compat, paths, subagents) = { let cfg = agent.cfg.borrow(); (cfg.compat_resolved, cfg.paths.clone(), cfg.subagents_enabled) };
        let files = xai_grok_agent::prompt::agents_md::read_agents_config_with_paths(&cwd.to_string_lossy(), compat, &paths, trusted).await;
        let rows: Vec<_> = files.into_iter().enumerate().map(|(order, file)| serde_json::json!({"order":order,"path":file.file_path,"name":file.file_name,"source":file.source,"content":file.content})).collect();
        let result = serde_json::json!({"projectTrusted":trusted,"instructions":rows,"subagentsEnabled":subagents,"policy":"Requirements clamp effective options; per-option precedence is resolved by the pinned native engine. Instructions are combined in the displayed native order, not overwritten by a GUI merge."});
        if serde_json::to_vec(&result).map_or(true, |v| v.len() > 512 * 1024) { return Err(acp::Error::invalid_params().data("Instruction inventory exceeds 512 KiB")); }
        return to_ext_response(Ok(result));
    }
    if req.server.len() > 256 || req.cursor.as_ref().is_some_and(|s| s.len() > 4096)
        || req.name.as_ref().is_some_and(|s| s.len() > 256)
        || serde_json::to_vec(&req.arguments).map_or(true, |v| v.len() > 16000) {
        return Err(acp::Error::invalid_params());
    }
    let result = if let Some(ref sid) = req.session_id {
        let handle = agent.session_handle_waiting_for_load(&acp::SessionId::new(sid.clone())).await
            .ok_or_else(|| acp::Error::invalid_params().data("session not found"))?;
        handle.studio_mcp_browse(req.server, req.operation, req.cursor, req.name, req.arguments).await
    } else {
        let state = agent.agent_mcp_state();
        ensure_agent_pool_initialized(&state).await;
        studio_mcp_browse(&state, &req.server, &req.operation, req.cursor, req.name, req.arguments).await
    }.map_err(|e| acp::Error::internal_error().data(e))?;
    to_ext_response(Ok(result))
}
pub(crate) async fn studio_mcp_browse(
    state: &Arc<TokioMutex<McpState>>, server: &str, operation: &str, cursor: Option<String>,
    name: Option<String>, arguments: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    let client = { let lock = state.lock().await; Arc::clone(lock.get_client(server).ok_or("MCP server not initialized")?) };
    let _request = client.begin_outbound_request();
    let service = client.ensure_initialized().await.map_err(|_| "MCP initialization failed")?;
    let params = cursor.map(|cursor| serde_json::from_value::<rmcp::model::PaginatedRequestParams>(serde_json::json!({"cursor":cursor}))).transpose().map_err(|_| "Invalid cursor")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let value = match operation {
            "resources" => serde_json::to_value(service.list_resources(params).await.map_err(|e| e.to_string())?),
            "templates" => serde_json::to_value(service.list_resource_templates(params).await.map_err(|e| e.to_string())?),
            "prompts" => serde_json::to_value(service.list_prompts(params).await.map_err(|e| e.to_string())?),
            "prompt" => {
                let params = serde_json::from_value::<rmcp::model::GetPromptRequestParams>(serde_json::json!({"name":name.ok_or("Choose a prompt")?,"arguments":arguments})).map_err(|_| "Invalid prompt arguments")?;
                serde_json::to_value(service.get_prompt(params).await.map_err(|e| e.to_string())?)
            },
            _ => return Err("Unsupported MCP discovery operation".to_string()),
        }.map_err(|_| "Cannot encode MCP result".to_string())?;
        if serde_json::to_vec(&value).map_or(true, |v| v.len() > 512 * 1024) { return Err("MCP result exceeds 512 KiB; use a smaller provider page".to_string()); }
        for key in ["resources", "resourceTemplates", "prompts", "messages"] {
            if value.get(key).and_then(|v| v.as_array()).is_some_and(|v| v.len() > 200) {
                return Err("MCP result exceeds 200 entries; use a smaller provider page".to_string());
            }
        }
        Ok(value)
    }).await.map_err(|_| "MCP discovery timed out".to_string())??;
    Ok(result)
}
