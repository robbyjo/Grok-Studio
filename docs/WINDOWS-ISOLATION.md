# Windows isolation

## Optional whole-app Windows Sandbox launch (0.7.0)

**Project settings → Isolated Windows Sandbox project copy** prepares a reviewed portable payload and bounded project copy under the desktop profile's `sandboxes` folder. It opens a generated `.wsb` configuration when Windows Sandbox is available. It does not install or enable Windows features, change the host's network rules, or reboot Windows.

The guest receives exactly two folder mappings: a read-only payload folder and a writable **copy** of the project. The original project and host authentication/profile directories are not mapped. Recognized credential files, vendor configuration, `.git`, generated folders and links are omitted. Files with custom secret names may still be included; inspect your project first. Snapshot limits are 10,000 entries, 20 directory levels, 50 MiB per file and 256 MiB total. Executable hashes bind preview to preparation. File copying uses bounded opened handles and rejects hard links and workspace path escapes.

Networking defaults **off**; enabling it explicitly permits the guest to use online services and access the local network. This is a network on/off control, not a hostname firewall. vGPU, clipboard, microphone, camera and printer sharing are disabled; Protected Client is enabled. These are Windows Sandbox configuration settings ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)). The operating system supplies the VM boundary for the whole guest app, rather than Workbench trying to intercept selected native tools.

Inside the guest, open `C:\WorkbenchProject` and sign in freshly. Git/development tools and external MCP executables may need installation inside the guest. Guest chats, authentication and tools are ephemeral and disappear when Sandbox closes. Changes to the mapped project copy remain in the displayed recovery folder. Review/copy them manually; there is no automatic apply, host-profile transfer or native session handoff. Prepared folders count toward the aggregate profile admission budget and remain until removed manually.

Configuration, snapshot bounds, credential exclusion and stale-executable checks have automated acceptance. **Live guest launch and tool/hook/terminal/descendant containment acceptance remain open**: Windows Sandbox is unavailable on GPU and the user is running a week-long experiment, so feature enablement/reboot was deferred. Normal Workbench launches remain outside this boundary.

## In-process AppContainer investigation

Workbench's renderer uses Chromium's sandbox. Grok's pinned agent OS sandbox is unavailable on Windows, so agent tools, hooks, actions, PTYs and subprocesses currently run with the user's Windows permissions. Approval UI is a separate control, not an OS containment boundary.

## Disposable AppContainer probe

`powershell.exe -NoProfile -File scripts/isolation-probe.ps1` compiles `native/isolation-probe/Probe.cs` using the local Windows .NET Framework compiler. The probe creates a unique temporary AppContainer with no capabilities, grants that SID access only to its owned executable/test directory, then starts a hidden child with `SECURITY_CAPABILITIES`.

The real Windows acceptance verified permitted test-file read/write, denied read/write to a private canary whose ACL was restricted to the host user, and denied a loopback TCP connection that the unrestricted host successfully made. The AppContainer profile and handles were removed afterward. This proves those tested boundaries; standard AppContainers can still access Windows locations granted to `ALL APPLICATION PACKAGES` ([isolation model](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [implementation guide](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)). It does not prove exclusive visibility of a workspace.

## Integration still required

The real native helper depends on private RPC and network/authentication. With the probe's no-capability policy, even loopback is denied. A production design must place authentication and permitted network requests in a reviewed broker, grant narrowly scoped workspace access, and apply containment consistently to tools, hooks, PTYs and every descendant process. It also needs path/ACL lifecycle, rollback, escape and compatibility acceptance. The probe is not wired into the agent launcher and does not change current tool permissions.

Windows Sandbox is another investigative option, with platform prerequisites and configurable networking/folder exposure ([Microsoft configuration documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)). Its optional feature was disabled on the test host; no system feature was enabled and no reboot was initiated. AppContainer integration remains an explicit TODO.
