# Third-party notices for GFPAK Open

## ooz-wasm 2.0.0 (browser-side Oodle decompression)

- **Project:** [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm)
- **Underlying decoder:** [powzix/ooz](https://github.com/powzix/ooz)
- **Version:** 2.0.0 (pinned in package.json)
- **License:** GNU General Public License, version 3 or later (GPL-3.0-or-later)
- **Bundled license:** [web/public/licenses/ooz-wasm-GPL-3.0.txt](web/public/licenses/ooz-wasm-GPL-3.0.txt)
- **Source code:** The linked upstream repositories, this project's `package.json` dependency and `web/src/oodle-wasm.js` integration.

The upstream WASM runtime implements an independent open-source decompressor for
Kraken, Mermaid, Selkie, Leviathan, LZNA and Bitknit Oodle streams. The package
embeds its WebAssembly module in its JavaScript distribution, loaded on demand.
No proprietary Oodle DLL, game asset or console key is redistributed.

**Licensing consideration for the repository owner:** Unlike permissively
licensed libraries, GPL-3.0-or-later carries copyleft obligations for
redistribution of a combined program. GFPAK Open currently has no top-level
license. Before distributing a build containing this dependency, the owner
should ensure that the application licensing and corresponding-source terms
are compatible with the GPL, including providing the relevant source code and
license notices. This notice does not itself grant a license to GFPAK Open's
original code.

## What this integration does not do

The browser only decodes compressed data supplied locally by its user.
It neither uploads those files nor downloads copyrighted game content.
Some newer or malformed Oodle frames may not decode correctly with the
independently maintained implementation; the viewer reports a failure rather
than synthesizing model data.
