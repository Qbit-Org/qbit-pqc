# @qbit-oss/pqc Supported Runtimes

Where the package runs, what CI checks there, and how to supply a WASM module
that is built or instantiated differently.

## Runtimes

The package needs a global `WebAssembly` and ES2020. It is an ES module with
no CommonJS build.

- **Node** `^20.19.0 || >=22.12.0`, the `engines` range. On those versions,
  `require()` loads the ES module through `require(esm)`, sharing its
  instance. CI builds, tests and runs the packed-tarball consumer smoke on
  Node 20.19.0, 22.12.0, 24 and 26. `init()` reads `pqc.wasm` from the
  installed package or compiles the embedded copy; `worker_threads` workers
  sign off the main thread (see [Signing in a worker](worker.md)).
- **Browsers** with WebAssembly. Unbundled, the package loads as ES modules
  and `init()` imports the loader with dynamic `import()`; the bundles the
  bundler smoke builds, IIFE included, need neither. A page's CSP must allow
  compiling WebAssembly (`'wasm-unsafe-eval'`). CI runs every browser check
  in the Chrome for Testing build that `scripts/chrome-for-testing.mjs` pins;
  other browsers are not tested.
- **Chrome MV3 extensions**, in each of their contexts:
  - the service worker, which allows no `import()`, so it passes the
    statically imported Emscripten factory as `createModule` (see
    [Static factory](loading.md#static-factory)). It cannot start a worker;
  - an offscreen document created with the `WORKERS` reason, which can start
    a dedicated worker and relay the service worker's requests to it;
  - a dedicated module worker, which allows `import()`, so every `init()`
    form works there.

  `pnpm test:mv3` runs the service-worker recipe and a sign/verify round trip
  from the service worker through an offscreen document to a dedicated worker
  serving `@qbit-oss/pqc/worker/handler`. [MV3 conformance](mv3-conformance.md)
  gives the CSP and packaging rules.

- **Bundlers**: `pnpm smoke:bundlers` builds pages with each bundler's stock
  settings, with no config file, loader or plugin, and runs them in Chrome:
  webpack 5.111.1 (with webpack-cli 7.2.3), esbuild 0.28.2
  (`--platform=browser`, ESM and IIFE output), and Vite 8.3.4 and 7.3.7 (the
  production build and the dev server). Each builds the default `init()`, the
  static-factory recipe and the external-wasm recipe (see
  [Package entries](loading.md#package-entries)). Other bundlers and versions
  are not tested.
- **React Native** is not supported. Its JavaScript engines provide no global
  `WebAssembly`, which the package needs to run `pqc.wasm`.

Other runtimes with WebAssembly, such as Deno and Bun, are not tested.

## A module built or instantiated differently

`init()` builds the module with the Emscripten factory in `wasm/pqc.mjs`. That
loader reads only `locateFile` and `wasmBinary` from the options object it is
called with (it is built with `INCOMING_MODULE_JS_API` set to those two), so
Emscripten's `instantiateWasm` hook, which other builds use to instantiate
from a precompiled `WebAssembly.Module` or a cache, has no effect on it.

For the package's own `pqc.wasm` bytes from another source, such as a cache,
pass them as `wasmBinary`; `init()` compiles them and loads no file. For
anything else, pass `createModule`: a function that `init()` calls with the
module options (`locateFile`, and `wasmBinary` when it has the bytes) and that
resolves to the module. It may wrap the package's factory or come from a build
of your own. Here `createCustomModule` is the factory of a build that accepts
`instantiateWasm`, and `instantiateFromCache` your hook:

<!-- snippet: test/types/docs-runtimes-create-module.mts -->
```ts
import { init } from '@qbit-oss/pqc/external-wasm'

const pqc = await init({
  createModule: options => createCustomModule({ ...options, instantiateWasm: instantiateFromCache }),
})
```

The module must provide what `PqcWasmModule` lists: `HEAPU8`, `_malloc`,
`_free` and the `_qbit_pqc_*` exports. `init()` checks that its key,
signature and entropy sizes match the package's `constants` and rejects with
a `PqcLoadError` otherwise. It does not check that the module runs the binary
`wasm/SHA256SUMS` pins, so check a build of your own yourself.
