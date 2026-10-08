# Portable updates and signing

The portable executable uses a reviewed replacement workflow. Electron Builder's portable target does not use the normal NSIS automatic updater ([target documentation](https://www.electron.build/v26/docs/targets/)). No release is published by these controls or acceptance tests.

## Update and rollback

In Settings, inspect the installed version, then check stable releases or explicitly include alpha releases. Only `robbyjo/Grok-Workbench` releases are considered. Download and verification are separate from the confirmed exit/install step. An unsigned executable requires the unsigned-update opt-in.

The release must include the executable and its `.manifest.json` sidecar, each with a GitHub SHA-256 asset digest. Workbench verifies those digests, the executable's PE product/version, Windows x64, desktop/history schema 1, binding 0.6.0 and the exact installed native-engine hash. Schema/native changes are blocked until a separately reviewed migration is implemented. A manifest declaring a signer requires a valid matching Windows Authenticode signature. Downloads are streamed with a 512 MiB ceiling and trusted HTTPS redirect hosts.

After saving editor/Settings drafts and stopping active work, confirm installation. Workbench drains its owned agents/account helpers, closes terminals, flushes desktop state and exits. A separate hidden Windows worker acknowledges startup from the persistent update folder before Workbench exits, then waits for the executable to close, rechecks hashes/signatures and uses `File.Replace` on the same volume, retaining the previous binary. It then launches the installed executable. External terminal processes and other clients are outside this ownership boundary.

Inspect status after restart to see the retained rollback. Confirm rollback to restore the prior binary; **current profile files stay in place**. This is binary rollback, not restoration of a historical profile snapshot. New updates cannot overwrite a retained rollback. Explicitly discard retained binaries to reclaim their storage first.

The package includes a small Windows GUI bootstrapper built from `native/updater-launcher.rs` with a static CRT. It starts the hidden Windows PowerShell worker independently and remains alive until that worker exits. Workbench verifies the worker's readiness and launcher PID before exiting. This avoids an updater child being terminated with the application. It adds no end-user installation requirement; build machines use the same pinned Rust toolchain as the embedded engine. Failed startup retains the original executable and records diagnostics in `updates/worker.log`.

The journal can recover a replacement that completed before its final status write. A failed or interrupted worker preserves its journal; the explicit recovery control offers retry only after its worker and any other owner process have stopped and both original and selected hashes still match. Unknown hashes, links or unsafe paths require preserving files for repair. Recovery does not guess which binary should win.

Existing published 0.6.3 assets predate these manifests. This source does not retroactively claim that release supports the new updater. Acceptance uses fixtures and real Windows replacement/version inspection; a published, signed, newer-version update remains a separate open gate.

## Signing setup

SignPath Foundation offers free signing for approved open-source projects. Grok Workbench meets basic application criteria but has not applied or been approved; see the [eligibility assessment](SIGNPATH.md). Current local artifacts remain unsigned, and a future SignPath release must use its verified CI signing workflow.

Azure Artifact Signing (formerly Trusted Signing) is **paid**. Microsoft's Basic plan is US$9.99 per account per month, includes 5,000 signatures and charges $0.005 per additional signature. It requires a paid Azure subscription; free/trial/sponsored subscriptions are unsupported ([pricing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku), [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)). No Azure subscription, signing account or billing resource has been created for this project.

If a maintainer chooses Azure later, follow Microsoft's [setup guide](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart): create the account in a supported region, complete legal identity validation, create a Public Trust certificate profile, and assign signing access. Identity verification and billing must be completed by the account owner. The publisher must match the validated identity. Configure credentials locally or as CI secrets; do not commit them.

For Electron Builder 26, configure the following non-secret resource values in the build environment:

```powershell
$env:GROK_SIGNING_PROVIDER = 'azure'
$env:GROK_SIGNING_ENDPOINT = 'https://<regional-endpoint>.codesigning.azure.net/'
$env:GROK_SIGNING_ACCOUNT = '<account-name>'
$env:GROK_SIGNING_PROFILE = '<public-trust-profile>'
$env:GROK_SIGNER_NAME = '<validated-legal-publisher>'
# Configure the selected supported Azure authentication method locally.
npm run package:signed
```

This uses `win.azureSignOptions`, SHA-256 and RFC 3161 timestamping. See [Electron Builder 26 Windows signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/) and [Microsoft signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations). A conventional supported certificate can instead use local `CSC_LINK`, `CSC_KEY_PASSWORD` and `GROK_SIGNER_THUMBPRINT`; the signed build preflight refuses missing inputs.

`package:signed` forces signing, disables publication, verifies the resulting signature/publisher, then writes the manifest and checksum. It does not make an unsigned binary trusted. `package:portable` writes unsigned metadata after a normal local build. Actual certificate/service signing and clean-machine trust verification remain open until configured and exercised.
