//! Grok Studio's in-process binding of the Apache-2.0 Grok Build agent library.
//! Loaded only by an app-owned Electron utility process. No grok executable.
//! The original AuthManager retains OAuth PKCE/refresh and API-key behavior.
use napi_derive::napi;
use std::sync::{Arc, Mutex, OnceLock};

static STATUS: OnceLock<Arc<Mutex<String>>> = OnceLock::new();
static CONFIG: OnceLock<xai_grok_shell::agent::config::Config> = OnceLock::new();

#[napi]
pub fn start(cwd: String, secret: String, mode: String) -> napi::Result<u32> {
    if secret.len() < 32 {
        return Err(napi::Error::from_reason(
            "Private engine secret is too short",
        ));
    }
    if STATUS.get().is_some() {
        return Err(napi::Error::from_reason("Engine already started"));
    }
    std::env::set_current_dir(&cwd).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut config =
        xai_grok_shell::config::load_agent_config_for_studio().map_err(napi::Error::from_reason)?;
    let preferred = match mode.as_str() {
        "oauth" => Some(xai_grok_shell::auth::PreferredAuthMethod::Oidc),
        "api" => Some(xai_grok_shell::auth::PreferredAuthMethod::ApiKey),
        _ => None,
    };
    if config.grok_com_config.preferred_method.is_some()
        && preferred.is_some()
        && config.grok_com_config.preferred_method != preferred
    {
        return Err(napi::Error::from_reason(
            "Authentication choice conflicts with the configured method pin.",
        ));
    }
    if preferred.is_some() {
        config.grok_com_config.preferred_method = preferred;
    }
    CONFIG
        .set(config.clone())
        .map_err(|_| napi::Error::from_reason("Engine already started"))?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let address = listener
        .local_addr()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let port = address.port();
    drop(listener);
    let status = Arc::new(Mutex::new("starting".to_owned()));
    STATUS
        .set(Arc::clone(&status))
        .map_err(|_| napi::Error::from_reason("Engine already started"))?;
    std::thread::spawn(move || {
        let outcome = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())
            .and_then(|runtime| {
                runtime
                    .block_on(xai_grok_shell::agent::run_agent_server(
                        xai_grok_shell::agent::ServerConfig {
                            bind_addr: address,
                            secret,
                        },
                        config,
                    ))
                    .map_err(|e| e.to_string())
            });
        if let Ok(mut state) = status.lock() {
            *state = match outcome {
                Ok(()) => "stopped".into(),
                Err(error) => error,
            };
        }
    });
    Ok(u32::from(port))
}

#[napi]
pub fn status() -> String {
    STATUS
        .get()
        .and_then(|s| s.lock().ok().map(|v| v.clone()))
        .unwrap_or_else(|| "not started".into())
}

/// Nonsecret startup flags used to verify the same resolution as the Grok CLI.
#[napi]
pub fn configuration_status() -> String {
    CONFIG
        .get()
        .map(|cfg| {
            serde_json::json!({
                "subagentsEnabled":cfg.subagents_enabled,
                "managedMcpsEnabled":cfg.managed_mcps_enabled,
                "subagentsMaxDepth":cfg.subagents_max_depth,
            })
            .to_string()
        })
        .unwrap_or_else(|| "{}".into())
}

#[napi]
pub async fn mcp(input: String) -> napi::Result<String> {
    use xai_grok_shell::util::config as conf;
    let data: serde_json::Value = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("Invalid MCP operation"))?;
    let cwd = std::env::current_dir().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let operation = data["operation"].as_str().unwrap_or("");
    let name = data["name"].as_str().unwrap_or("");
    let scope = data["scope"].as_str().unwrap_or("user");
    let path = match scope {
        "user" => conf::user_config_path(),
        "project" => conf::project_config_path(&cwd),
        _ => return Err(napi::Error::from_reason("Invalid MCP scope")),
    };
    let result = match operation {
        "list" => {
            let disabled = conf::disabled_mcp_server_names(&cwd);
            let rows:Vec<_>=conf::load_mcp_server_configs_with_project(&cwd).into_iter().map(|(name,(config,scope))|{
                let value=serde_json::to_value(config).unwrap_or_default();
                serde_json::json!({"name":name,"scope":scope,"enabled":!disabled.contains(&name)&&value["enabled"]!=false,
                    "transport":if value["command"].is_string(){"stdio"}else{value["type"].as_str().unwrap_or("http")},
                    "target":value["command"].as_str().or(value["url"].as_str()).unwrap_or("")})
            }).collect();
            serde_json::json!(rows)
        }
        "doctor" => {
            serde_json::to_value(xai_grok_shell::mcp_doctor::run_doctor(&cwd, Some(name)).await)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        "add" => {
            if conf::cli_known_mcp_server_names(&cwd).contains(name) {
                return Err(napi::Error::from_reason(
                    "This MCP server already exists; use the configuration editor.",
                ));
            }
            let config = serde_json::from_value(data["config"].clone())
                .map_err(|_| napi::Error::from_reason("Invalid MCP configuration"))?;
            conf::save_mcp_server_config_at(&path, name, &config)
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            serde_json::json!({"saved":true})
        }
        "remove" => {
            if !conf::delete_mcp_server_config_at(&path, name)
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
            {
                return Err(napi::Error::from_reason("No MCP definition in this scope"));
            }
            serde_json::json!({"saved":true})
        }
        "enable" | "disable" => {
            if !conf::cli_known_mcp_server_names(&cwd).contains(name) {
                return Err(napi::Error::from_reason("Unknown MCP server"));
            }
            conf::save_mcp_server_enabled_in(name, operation == "enable", &cwd)
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            serde_json::json!({"saved":true})
        }
        _ => return Err(napi::Error::from_reason("Unknown MCP operation")),
    };
    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub async fn generate(
    kind: String,
    prompt: String,
    aspect: String,
    duration: u32,
    voice: String,
) -> napi::Result<napi::bindgen_prelude::Buffer> {
    if prompt.is_empty() || prompt.len() > 20_000 {
        return Err(napi::Error::from_reason("Invalid media prompt"));
    }
    let cfg = CONFIG
        .get()
        .ok_or_else(|| napi::Error::from_reason("Connect the engine first"))?;
    let am = Arc::new(cfg.create_auth_manager());
    am.configure_refresher(cfg.grok_com_config.auth_provider_command.clone(), None);
    // Use the same managed policy / remote settings / ZDR resolution as an agent boot.
    let initial = cfg.clone();
    let media_auth = Arc::clone(&am);
    let cfg = tokio::task::spawn_blocking(move || {
        xai_grok_shell::agent::init::bootstrap(&initial, &media_auth, None).map(|(cfg, _)| cfg)
    })
    .await
    .map_err(|_| napi::Error::from_reason("Media configuration could not be resolved"))?
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let provider = Some(xai_grok_shell::auth::shared_api_key_provider(Arc::clone(
        &am,
    )));
    let credentials = xai_grok_shell::agent::media_tool_config::MediaToolCredentials {
        static_bearer: None,
        tier_restricted: false,
    };
    let bytes = match kind.as_str() {
        "image" => {
            let config =
                xai_grok_shell::agent::media_tool_config::image_gen_config(&cfg, &credentials);
            let client =
                xai_grok_tools::implementations::grok_build::image_gen::ImageGenClient::new(
                    &config, provider,
                )
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            client
                .generate(&prompt, &aspect)
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        "video" => {
            if duration < 1 || duration > 15 {
                return Err(napi::Error::from_reason(
                    "Video duration must be 1–15 seconds",
                ));
            }
            let config =
                xai_grok_shell::agent::media_tool_config::video_gen_config(&cfg, &credentials);
            let client =
                xai_grok_tools::implementations::grok_build::video_gen::VideoGenClient::new(
                    &config, provider,
                )
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            use xai_grok_tools::implementations::grok_build::video_gen::{
                VideoKeyframePins, VideoOutcome,
            };
            match client
                .generate_with_images(
                    "grok-imagine-video",
                    &prompt,
                    Some(duration),
                    Some(&aspect),
                    "480p",
                    None,
                    vec![],
                    vec![],
                    VideoKeyframePins::default(),
                )
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
            {
                VideoOutcome::Bytes(bytes) => bytes,
                VideoOutcome::UploadedUrl(_) => {
                    return Err(napi::Error::from_reason(
                        "Video was stored in the configured remote bucket; this GUI cannot download its protected output.",
                    ));
                }
            }
        }
        "audio" => {
            let key = am
                .side_call_bearer_async()
                .await
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let response = client
                .post("https://api.x.ai/v1/tts")
                .bearer_auth(key)
                .json(&serde_json::json!({"text": prompt, "voice_id": voice, "language": "en"}))
                .send()
                .await
                .map_err(|_| {
                    napi::Error::from_reason("Speech generation network request failed")
                })?;
            if !response.status().is_success() {
                return Err(napi::Error::from_reason(format!(
                    "Speech generation returned HTTP {}. Check account access or API-key authentication.",
                    response.status().as_u16()
                )));
            }
            if response
                .content_length()
                .is_some_and(|n| n > 50 * 1024 * 1024)
            {
                return Err(napi::Error::from_reason("Audio output exceeds 50 MiB"));
            }
            response
                .bytes()
                .await
                .map_err(|_| napi::Error::from_reason("Could not read generated audio"))?
                .to_vec()
        }
        _ => return Err(napi::Error::from_reason("Unsupported media kind")),
    };
    if bytes.len() > 50 * 1024 * 1024 {
        return Err(napi::Error::from_reason("Generated output exceeds 50 MiB"));
    }
    Ok(bytes.into())
}
