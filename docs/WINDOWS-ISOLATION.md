# Windows agent isolation investigation

Workbench's renderer uses Chromium's sandbox. Grok's pinned agent OS sandbox is unavailable on Windows, so agent tools, hooks, actions, PTYs and subprocesses currently run with the user's Windows permissions. Approval UI is a separate control, not an OS containment boundary.

## Disposable AppContainer probe

`powershell.exe -NoProfile -File scripts/isolation-probe.ps1` compiles `native/isolation-probe/Probe.cs` using the local Windows .NET Framework compiler. The probe creates a unique temporary AppContainer with no capabilities, grants that SID access only to its owned executable/test directory, then starts a hidden child with `SECURITY_CAPABILITIES`.

The real Windows acceptance verified permitted test-file read/write, denied read/write to a private canary whose ACL was restricted to the host user, and denied a loopback TCP connection that the unrestricted host successfully made. The AppContainer profile and handles were removed afterward. This proves those tested boundaries; standard AppContainers can still access Windows locations granted to `ALL APPLICATION PACKAGES` ([isolation model](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [implementation guide](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)). It does not prove exclusive visibility of a workspace.

## Integration still required

The real native helper depends on private RPC and network/authentication. With the probe's no-capability policy, even loopback is denied. A production design must place authentication and permitted network requests in a reviewed broker, grant narrowly scoped workspace access, and apply containment consistently to tools, hooks, PTYs and every descendant process. It also needs path/ACL lifecycle, rollback, escape and compatibility acceptance. The probe is not wired into the agent launcher and does not change current tool permissions.

Windows Sandbox is another investigative option, with platform prerequisites and configurable networking/folder exposure ([Microsoft configuration documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)). Its optional feature was disabled on the test host; no system feature was enabled and no reboot was initiated. AppContainer integration remains an explicit TODO.
