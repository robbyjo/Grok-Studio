# Third-party notices

Grok Workbench is an independent Apache-2.0 application. Product names identify their respective projects; no affiliation or endorsement is claimed.

Version 0.6.1 embeds the Grok Build Rust agent library (xai-grok-shell 1.0.45) from Apache-2.0 source revision `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, with a N-API binding. The executable does not bundle grok.exe. Upstream modifications are identified in `native/UPSTREAM-CHANGES.md` and reproduced by `scripts/engine-source.cjs`. `native/studio-engine/Cargo.lock` pins the Rust dependency graph. The extracted application preserves `engine/notices/GROK-LICENSE`, `UPSTREAM-CHANGES.md`, `CARGO-LICENSES.txt` (generated upstream/Rust dependency licenses and notices), and `engine.json` (source revision/build hash). Source copies are in `resources/engine`. Cargo metadata includes some target-specific and developer dependencies beyond the Windows release; their notices are retained conservatively. Packages with alternative licenses are used under their permissive alternatives. No Codex code or assets are embedded. The reference checkout and optional compatibility CLI are excluded from packaging.

Earlier 0.4.0 artifacts redistributed the unmodified official Grok 1.0.46 Windows executable with its upstream notices; those historical artifacts have a different architecture and license bundle layout.

App-local Microsoft Visual C++ runtime DLLs accompany the Windows executable, sourced from the developer's licensed Visual Studio x64 CRT redist directory and verified as Microsoft-signed. These Microsoft components retain their own software license terms, not Apache-2.0. `engine/notices/MSVC-REDIST.txt` preserves the installed redistribution notice; `msvc-runtime.json` records the version and individual hashes. See [Microsoft's redistribution documentation](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files) and [Visual Studio license terms](https://visualstudio.microsoft.com/license-terms/). App-local deployment requires shipping updated runtime DLLs with application updates.

Direct runtime components:

| Component                                 | License                            | Source                                                                             |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Electron and its Node/Chromium components | MIT plus bundled component notices | https://github.com/electron/electron                                               |
| React / React DOM                         | MIT                                | https://github.com/facebook/react                                                  |
| lucide-react                              | ISC                                | https://github.com/lucide-icons/lucide                                             |
| react-markdown / remark-gfm               | MIT                                | https://github.com/remarkjs/react-markdown, https://github.com/remarkjs/remark-gfm |
| xterm.js / fit addon                      | MIT                                | https://github.com/xtermjs/xterm.js                                                |
| @lydell/node-pty / microsoft node-pty     | MIT                                | https://github.com/lydell/node-pty, https://github.com/microsoft/node-pty          |

Electron distributables include Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`. Dependency packages retain their license files when included by electron-builder. `package-lock.json` records the exact dependency graph. A generated full production dependency notice list is included as `DEPENDENCY-LICENSES.txt` when packaging.
