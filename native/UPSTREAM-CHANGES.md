# Embedded Grok Build source

Grok Workbench embeds xai-org/grok-build at revision
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (Apache-2.0) as a Rust library.
`scripts/engine-source.cjs` applies these modifications to the pinned checkout:

- Windows protobuf rebuild tracking uses input directories; protoc's Unix
  `/dev/stdout` dependency-report path is unavailable on Windows.
- PDF rendering borrows its document mutably for the pinned pdf_oxide 0.3.43 API.
- A library startup loader resolves runtime-only fields with the original CLI
  resolver before applying managed settings/requirements policy. The one-shot
  disk loader alone leaves skipped subagent/MCP/memory fields at serde defaults.
- Windows configuration locking retries `ERROR_LOCK_VIOLATION` (33) as lock
  contention, using the existing bounded retry. It never writes without the lock.

The Studio binding and process bridge are additional source, not upstream changes.
Cargo.lock pins pdf_oxide 0.3.43 and process-wrap 9.0.0 to the upstream declared
baselines for Windows API compatibility. The original OAuth and API-key
authentication, agent loop, tools, MCP, sessions, skills and plugins remain in
the upstream library. Rust and the Windows C++ build tools are developer build
dependencies; end users do not install them or the Grok CLI.
