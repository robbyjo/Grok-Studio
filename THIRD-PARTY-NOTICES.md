# Third-party notices

Grok Desktop is an independent Apache-2.0 client. Product names identify their respective projects; no affiliation or endorsement is claimed.

The Windows distributable bundles the official Grok Build 1.0.46 executable, pinned to SHA-256 `e09c0893cee4850a569bd90e7aed956ea503b34f551637d58187ca4dfb931611`. Grok Build is Apache-2.0 with third-party obligations. Its upstream license and full notices are preserved under `resources/runtime/notices` in the extracted application, with source copies under `resources/grok`. These notices come from the inspected upstream revision `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; we have not independently mapped every compiled dependency in the released executable to that source revision. The binary is redistributed unmodified. Users can select another Grok executable in Settings. No Codex code or assets are embedded. The development reference checkout is excluded from packaging.

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
