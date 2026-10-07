const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const revision = '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8';
const root = path.resolve('upstream/grok-build');
if (!fs.existsSync(path.join(root, 'Cargo.toml'))) {
  cp.execFileSync('git', ['clone', 'https://github.com/xai-org/grok-build.git', root], {
    stdio: 'inherit',
  });
  cp.execFileSync('git', ['checkout', '--detach', revision], { cwd: root, stdio: 'inherit' });
}
const actual = cp
  .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  .trim();
if (actual !== revision)
  throw new Error(
    `Engine source must be pinned to ${revision}; found ${actual}. Checkout the pin in ${root}.`,
  );
const file = path.join(root, 'crates/build/xai-proto-build/src/lib.rs');
let text = fs.readFileSync(file, 'utf8');
const marker = '// Grok Studio Windows build: protoc cannot write /dev/stdout.';
if (!text.includes(marker)) {
  const anchor = '        let includes = Vec::from_iter(includes);';
  if (!text.includes(anchor)) throw new Error('Proto build patch no longer applies.');
  text = text.replace(
    anchor,
    `${anchor}
        ${marker}
        // Apache-2.0 modification: conservatively track input directories on Windows.
        if cfg!(windows) {
            for include in &includes { println!("cargo:rerun-if-changed={}", include.display()); }
            for proto in protos { println!("cargo:rerun-if-changed={}", proto.display()); }
            return Ok(());
        }`,
  );
  fs.writeFileSync(file, text);
}
const pdf = path.join(root, 'crates/codegen/xai-grok-tools/src/implementations/read_file/pdf.rs');
let pdfText = fs.readFileSync(pdf, 'utf8');
if (!pdfText.includes('// Grok Studio: pdf_oxide 0.3.43 mutable render API.')) {
  const before = 'let (doc, page_count, page_indices) = open_pdf';
  const patched = 'let (mut doc, page_count, page_indices) = open_pdf';
  if (!pdfText.includes(before) && !pdfText.includes(patched))
    throw new Error('PDF compatibility patch no longer applies.');
  pdfText = pdfText
    .replace(before, patched)
    .replace(patched, '// Grok Studio: pdf_oxide 0.3.43 mutable render API.\n    ' + patched)
    .replace(
      'pdf_oxide::rendering::render_page(&doc,',
      'pdf_oxide::rendering::render_page(&mut doc,',
    );
  fs.writeFileSync(pdf, pdfText);
}
console.log('Pinned Grok library source prepared; Windows compatibility patches applied.');
// The CLI resolves skipped runtime fields before applying policy. The one-shot
// disk loader alone leaves subagents and managed MCPs at serde defaults.
const configFile = path.join(root, 'crates/codegen/xai-grok-shell/src/config/mod.rs');
let configText = fs.readFileSync(configFile, 'utf8');
if (!configText.includes('pub fn load_agent_config_for_studio()')) {
  const anchor = 'pub fn load_agent_config_disk_only()';
  if (!configText.includes(anchor)) throw new Error('Runtime resolution patch no longer applies.');
  const helper = `// Grok Studio Apache-2.0 modification: resolve CLI runtime fields, then clamp policy.
pub fn load_agent_config_for_studio() -> Result<crate::agent::config::Config, String> {
    let effective = load_effective_config_disk_only().map_err(|e| e.to_string())?;
    let mut config = crate::agent::config::Config::new_from_toml_cfg(&effective)?;
    config.resolve_runtime_fields(&crate::agent::config::RuntimeResolutionContext {
        raw_config: &effective, remote_settings: None, is_headless: false,
        cli_subagents: None, cli_web_search_model: None, cli_session_summary_model: None,
        memory_enabled_override: None, disable_web_search: false, todo_gate: false,
        laziness_debug_log: None, storage_mode: None,
    });
    apply_policy(&mut config);
    Ok(config)
}
`;
  configText = configText.replace(anchor, helper + anchor);
  fs.writeFileSync(configFile, configText);
}
const persist = path.join(root, 'crates/codegen/xai-grok-shell/src/util/config/persist.rs');
let persistText = fs.readFileSync(persist, 'utf8');
const originalLock = 'Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {';
const windowsLock =
  'Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || (cfg!(windows) && e.raw_os_error() == Some(33)) => {';
if (!persistText.includes(windowsLock)) {
  if (!persistText.includes(originalLock))
    throw new Error('Windows configuration-lock patch no longer applies.');
  persistText = persistText.replace(originalLock, windowsLock);
  fs.writeFileSync(persist, persistText);
}
