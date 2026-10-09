# Code signing policy

Current releases are unsigned. SignPath Foundation sponsorship, eligibility and certificate approval are pending; this page does not claim that signing has been provided.

The repository owner is [robbyjo](https://github.com/robbyjo). Proposed author, reviewer and signing approver roles must be confirmed by that human owner before enrollment. External contributions require maintainer review. Every signing request requires a human approval in SignPath; automation submits and verifies artifacts but does not grant signing approval. All team members must enable MFA on GitHub and SignPath before signing is enabled.

Only a successful, GitHub-hosted Windows build of the public source is eligible. The SignPath integration submits that build’s uploaded artifact ID for origin verification. The approved artifact configuration must restrict product/version metadata and sign only the project’s outer portable executable. Bundled upstream Electron/Chromium/PTY/CRT binaries must not be automatically re-signed with the project certificate. Disclose the modified Apache-2.0 Grok library, generated license inventory and Microsoft CRT to the Foundation for review.

After human approval, CI checks the configured certificate thumbprint and publisher, regenerates executable checksums/manifest and runs portable launch/relocation acceptance. A manual release workflow publishes only the exact successful CI artifact, verifies uploaded asset hashes before removing draft status, and refuses existing version tags. Local binaries cannot substitute for CI-origin artifacts.

See the [privacy disclosure](PRIVACY.md), [application/setup procedure](SIGNPATH.md), [third-party notices](../THIRD-PARTY-NOTICES.md) and [release gates](RELEASE-GATES.md). If the Foundation approves sponsorship, update this policy and download/release pages with its required attribution using the actual approved roles. No signing token, credential or paid service has been configured.
