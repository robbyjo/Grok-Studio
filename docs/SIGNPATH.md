# SignPath Foundation eligibility assessment

Updated October 9, 2026. **Grok Workbench meets the basic application criteria, but full eligibility and approval are unconfirmed.** The owner has no SignPath account yet. CI integration and draft signing/privacy policies are prepared; no application, account, certificate or live signing has been completed.

[Microsoft lists SignPath Foundation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options#open-source-signpath-foundation) as a free option for qualifying open-source projects. This is separate from paid Azure Artifact Signing.

## Verified project facts

- [robbyjo/Grok-Workbench](https://github.com/robbyjo/Grok-Workbench) is public and licensed under Apache-2.0.
- It has active development, documented functionality and published Windows portable releases.
- The repository was created October 7, 2026. At this assessment it had zero stars/forks; these are observations, not invented eligibility thresholds.
- [Windows CI](../.github/workflows/windows.yml) uses GitHub-hosted runners, pinned action commits, dependency locks, a pinned public Grok revision, reproducible source patches, tests and artifact upload. Its SignPath job is disabled until approved enrollment/configuration.
- Current releases use locally built unsigned executables. They must not be presented as CI-origin-verified artifacts.

## Conditions still to address

The [Foundation terms](https://signpath.org/terms.html) add reputation review, MFA for all team members, named author/reviewer/approver roles, a public code signing policy, privacy disclosures and manual approval of every signing request. Repository visibility and Apache-2.0 alone do not guarantee acceptance. No minimum project age or star count is stated.

Dependency eligibility also needs review. The app includes modified Apache-2.0 Grok source, upstream Electron/Chromium and PTY binaries, and Microsoft CRT system libraries. Foundation rules restrict signing modified upstream binaries and allow unsigned upstream OSS components inside signed packages. Its system-library exception may cover the CRT; the Foundation must confirm the proposed artifact configuration. Do not automatically re-sign every bundled executable with a project certificate. See [third-party notices](../THIRD-PARTY-NOTICES.md).

The generated Cargo notice inventory also contains public-domain and data-license entries, including CC0 dependencies and CDLA-Permissive-2.0 certificate-root data. A permissive license inventory is not proof that every component satisfies the Foundation's OSI-license condition. Include these in the dependency review; metadata also lists dependencies for other targets and development.

Privacy documentation must accurately cover xAI requests/authentication, configured MCP providers, GitHub, update checks and any enabled native telemetry. Avoid claiming that no network transfer occurs without reviewing native defaults.

## Proposed path after acceptance

Apply through the [Foundation application page](https://signpath.org/apply), identifying the project owner and disclosing the upstream packaging. The owner confirmed GitHub MFA; SignPath MFA and signing responsibilities remain to be confirmed. No account settings were changed during this assessment.

The official [GitHub integration](https://docs.signpath.io/trusted-build-systems/github) submits an uploaded GitHub Actions artifact for origin verification. Configure the approved project, artifact restrictions and signing policy, store the submitter token in CI secrets, and obtain human signing approval. Then verify the signed executable, rerun portable acceptance, regenerate its checksum/manifest and publish that exact signed artifact. Never upload a local binary as a substitute or retain the unsigned artifact's checksum after signing.

The publisher would be **SignPath Foundation**, rather than a personal certificate issued to the maintainer. Sponsorship attribution should be added only after it is actually provided. Current releases remain unsigned.

## Owner setup and prepared integration

The [application draft](SIGNPATH-APPLICATION.md) records the public answers prepared in the browser; personal fields and required consent remain with the owner. Complete SignPath account setup through the [Foundation application/setup pages](https://signpath.org/apply), enable its MFA, and confirm author/reviewer/signing-approver responsibilities. GitHub MFA is already confirmed. Account creation, legal agreements and human signing approval belong to the account owner. The prepared [code signing policy](CODE-SIGNING-POLICY.md) and [privacy disclosure](PRIVACY.md) are public application material; role membership and sponsorship attribution remain pending confirmation/approval.

After acceptance, install/configure the SignPath GitHub integration for this public repository. Agree the ZIP artifact restrictions for the outer `Grok-Workbench-*-Portable.exe`, product name `Grok Workbench`, and common version. Disclose the bundled upstream/native/CRT and dependency-license exceptions rather than assuming approval. Require GitHub-hosted builders and manual signing approval in the approved SignPath policy. Configure a protected GitHub environment `code-signing` with a human reviewer.

Set repository variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, `SIGNPATH_ARTIFACT_SLUG`, `GROK_SIGNER_THUMBPRINT`, and `GROK_SIGNER_NAME` to the approved values. Put the restricted submitter credential in the environment secret `SIGNPATH_API_TOKEN`; never in source or chat. Set `SIGNPATH_ENABLED=true` only after the setup is reviewed. The signing job consumes the preceding successful Windows artifact ID, waits for human approval, verifies identity, regenerates metadata, exercises the signed portable and uploads a distinct SHA-bound signed artifact. Publication is a separate [manual CI release workflow](RELEASE-GATES.md).
