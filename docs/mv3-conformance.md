# @qbit-oss/pqc MV3 Conformance

`@qbit-oss/pqc` ships an Emscripten ES module loader, `wasm/pqc.mjs`, and
`wasm/pqc.wasm`, a copy of which is embedded in `lib/index.mjs`. Chrome MV3
extension service workers must load these artifacts from the packaged
extension, not from a remote URL.

## Required MV3 CSP

MV3 manifests that load `@qbit-oss/pqc` need extension-page CSP that permits local
WASM compilation:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

Keep script sources restricted to `'self'`. Do not add remote script hosts or
plain `'unsafe-eval'` for PQC. The `wasm-unsafe-eval` token is required because
Chrome treats WebAssembly compilation as a separate CSP capability.

## Service Worker Loading

Use a module service worker:

```json
{
  "background": {
    "service_worker": "background.mjs",
    "type": "module"
  }
}
```

Service workers do not allow `import()`, which `init()` uses for the loader,
so MV3 service workers should statically import the Emscripten factory and
pass it to `init()`:

<!-- snippet: test/types/mv3-wasm-import.mts -->
```ts
import { init } from '@qbit-oss/pqc/external-wasm'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

The extension bundle must package `pqc.wasm` at the path `locateFile` returns.
`@qbit-oss/pqc/external-wasm` is the package API without the copy of
`pqc.wasm` embedded in `lib/index.mjs`, so the service worker bundle carries
only the file the extension packages. To package no `pqc.wasm` file instead,
import `init` from `@qbit-oss/pqc` and pass no `locateFile` (or `wasmBinary`):
`init()` then compiles the embedded copy, the same binary `wasm/SHA256SUMS`
pins. Both entries share one module instance and one published client (see
[Package entries](loading.md#package-entries)).

Call `init()` when the service worker starts, and have event handlers
`await ready()` before they sign or verify: the client does not survive a
service-worker restart. Signing blocks the service worker for about 0.6 s per
signature; [Service workers](loading.md#service-workers) describes signing in
a Worker that an offscreen document starts instead.

The package MV3 smoke packs `@qbit-oss/pqc`, installs that tarball in
a clean project outside the repository, copies the installed runtime artifacts
into an extension, and loads them through `chrome-extension://...` with the
recipe above, and fails if any script it copies into the extension carries
the base64 copy of `pqc.wasm` that `lib/index.mjs` embeds. A passing
run first validates that the source is the external consumer's installed
`node_modules/@qbit-oss/pqc` path, then reports
`artifactSource: installed-packed-tarball`. This prevents a repo-root build
from masking missing npm files.

Extensions that consume `@qbit-oss/pqc` should add their own build/package gate
that statically imports both `@qbit-oss/pqc/external-wasm` and
`@qbit-oss/pqc/wasm/pqc.mjs`, emits an `init` entry with `createModule` and
`locateFile`, verifies the manifest's MV3 CSP, and checks that the SHA-256 of
the packaged `wasm/pqc.wasm` matches its entry in the package's
`wasm/SHA256SUMS`. A bundle that imports only the external-wasm entry contains
no base64 WASM (a string starting `AGFzbQ`); a gate can require that.

## CI Commands

The package-focused CI workflow's `verify` job installs only from
`pnpm-lock.yaml` and runs the integrity gates; `.github/workflows/ci.yml` in
the repository is the authoritative list:

```sh
pnpm format:check
pnpm build
pnpm test
pnpm typecheck
pnpm check:vendor --upstream <shallow fetch of the pinned upstream commit>
pnpm check:wasm
pnpm check:wasm:repro
pnpm pack:check
pnpm smoke:consumer
```

`pnpm verify` runs the same steps except the two that download something:
`check:vendor` checks against `MANIFEST` only, and `check:wasm:repro` is
skipped.

A separate `mv3-smoke` job installs the pinned Chrome for Testing build with the
locked `@puppeteer/browsers` devDependency, then runs the MV3 smoke:

```sh
pnpm exec browsers install chrome@156.0.8078.47 --path .context/browsers
pnpm test:mv3
```

A `bundler-smoke` job installs the same Chrome for Testing build and runs
`pnpm smoke:bundlers`. It packs the package, installs the tarball with exact
versions of webpack, esbuild and Vite into throwaway projects outside the
repository, and builds pages with each bundler's stock settings; every page
must match the golden vectors through the default `init()` and through
`init({ createModule })` without requesting `pqc.wasm`, and through the
external-wasm entry's `init({ createModule, locateFile })`, which must request
only the `pqc.wasm` that `locateFile` names and whose build output must embed
no WASM. The bundlers are downloaded when the smoke runs, which is why it is
not part of `verify`.

The pinned version lives in `scripts/chrome-for-testing.mjs`. `pnpm test:mv3`
and `pnpm smoke:bundlers` use only that build for the current platform, at the
path where the install command above puts it in the repository's
`.context/browsers`, and fail if the browser reports a different version.
They do not fall back to a system Chrome for Testing install or look in parent
directories. A binary named by `--chrome` or `CHROME_FOR_TESTING_PATH` is a
deliberate override and is not version-checked.

Chrome's Linux sandbox needs unprivileged user namespaces. On a host that
blocks them, such as Ubuntu 23.10 or later, Chrome aborts with "No usable
sandbox"; set `CHROME_NO_SANDBOX=1` to run the smokes without the sandbox. On
Linux, `CI=true` does the same unless `CHROME_NO_SANDBOX=0` keeps the sandbox
on.

Do not use branded Google Chrome for automated MV3 conformance.

The committed golden fixture's `source` block records the upstream
`Qbit-Org/qbit-libbitcoinpqc` commit, test file path, git blob and SHA-256 the
vectors were generated from. `pnpm test` checks those vectors against the WASM
build. Check the fixture against its sidecar from the repository root with
`sha256sum` (or `shasum -a 256 -c` on macOS):

```sh
sha256sum -c fixtures/slh-dsa-golden.json.sha256
```

Regenerating the vectors from the upstream Rust tests is a maintainer step that
needs a checkout of `Qbit-Org/qbit-libbitcoinpqc` at the recorded commit; CI
does not run it.

## Security Checklist

- Zeroization: entropy, secret-key, signature, and stats scratch buffers copied
  into the WASM heap are zeroed before `_free`; tests must keep covering failure
  paths.
- No secret-key logging: scripts and tests may compare fixture hex internally,
  but must not log generated secret keys, signatures, entropy, or full key hex
  dumps.
- Local WASM packaging: ship `pqc.mjs`, `pqc.wasm`, and `SHA256SUMS` from the
  package, together with `LICENSE` and `THIRD_PARTY_NOTICES` for the code they
  contain; do not fetch PQC WASM from a CDN or app backend. `lib/index.mjs`
  embeds a copy of the pinned `pqc.wasm`, which its `init()` compiles unless
  `locateFile` or `moduleUrl` says where to load the file from;
  `lib/external-wasm.mjs` embeds none. Both import `lib/core.mjs`, so an
  extension that copies the package's files rather than bundling them must
  copy the whole `lib/` directory, or at least `lib/external-wasm.mjs` with
  `lib/core.mjs`, which together hold no embedded copy.
- Reproducibility: `check:wasm` must match committed hashes and
  `check:wasm:repro` must rebuild to the same hashes from the pinned Emscripten
  image.
- CSP: MV3 manifests must include `'wasm-unsafe-eval'` with `'self'` script
  sources and must not loosen CSP beyond the WASM requirement.
