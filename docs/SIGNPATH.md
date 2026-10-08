# SignPath Foundation eligibility assessment

Checked October 8, 2026. **Grok Workbench meets the basic application criteria, but full eligibility and approval are unconfirmed.** No application, service account, certificate or signing integration has been created.

[Microsoft lists SignPath Foundation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options#open-source-signpath-foundation) as a free option for qualifying open-source projects. This is separate from paid Azure Artifact Signing.

## Verified project facts

- [robbyjo/Grok-Workbench](https://github.com/robbyjo/Grok-Workbench) is public and licensed under Apache-2.0.
- It has active development, documented functionality and published Windows portable releases.
- The repository was created October 7, 2026. At this assessment it had zero stars/forks; these are observations, not invented eligibility thresholds.
- [Windows CI](../.github/workflows/windows.yml) uses GitHub-hosted runners, pinned action commits, dependency locks, a pinned public Grok revision, reproducible source patches, tests and artifact upload. It has no SignPath submission step.
- Current releases use locally built unsigned executables. They must not be presented as CI-origin-verified artifacts.

## Conditions still to address

The [Foundation terms](https://signpath.org/terms.html) add reputation review, MFA for all team members, named author/reviewer/approver roles, a public code signing policy, privacy disclosures and manual approval of every signing request. Repository visibility and Apache-2.0 alone do not guarantee acceptance. No minimum project age or star count is stated.

Dependency eligibility also needs review. The app includes modified Apache-2.0 Grok source, upstream Electron/Chromium and PTY binaries, and Microsoft CRT system libraries. Foundation rules restrict signing modified upstream binaries and allow unsigned upstream OSS components inside signed packages. Its system-library exception may cover the CRT; the Foundation must confirm the proposed artifact configuration. Do not automatically re-sign every bundled executable with a project certificate. See [third-party notices](../THIRD-PARTY-NOTICES.md).

The generated Cargo notice inventory also contains public-domain and data-license entries, including CC0 dependencies and CDLA-Permissive-2.0 certificate-root data. A permissive license inventory is not proof that every component satisfies the Foundation's OSI-license condition. Include these in the dependency review; metadata also lists dependencies for other targets and development.

Privacy documentation must accurately cover xAI requests/authentication, configured MCP providers, GitHub, update checks and any enabled native telemetry. Avoid claiming that no network transfer occurs without reviewing native defaults.

## Proposed path after acceptance

Apply through the [Foundation application page](https://signpath.org/apply.html), identifying the project owner and disclosing the upstream packaging. The owner must confirm MFA and signing responsibilities; no account settings were changed during this assessment.

The official [GitHub integration](https://docs.signpath.io/trusted-build-systems/github) submits an uploaded GitHub Actions artifact for origin verification. Configure the approved project, artifact restrictions and signing policy, store the submitter token in CI secrets, and obtain human signing approval. Then verify the signed executable, rerun portable acceptance, regenerate its checksum/manifest and publish that exact signed artifact. Never upload a local binary as a substitute or retain the unsigned artifact's checksum after signing.

The publisher would be **SignPath Foundation**, rather than a personal certificate issued to the maintainer. Sponsorship attribution should be added only after it is actually provided. Current releases remain unsigned.
