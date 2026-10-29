# @qbit-oss/pqc Initialization and Loading

How `init()` shares, publishes and reports a load, where it loads the WASM
module from, and how to use it in service workers.

## Initialization

`init()` loads the WASM module and resolves with a client, which it also
publishes for the named exports. Calls with the same options share one load:
they return distinct promises that resolve to the same client, so calling
`init()` wherever the package is used does not instantiate another 17 MB
module each time. Options are the same when `moduleUrl` has the same string
form (a `URL` matches its `href`) and `createModule`, `locateFile` and
`wasmBinary` are the same objects; `init()`, `init(undefined)` and `init({})`
are the same. A call with other options loads a new module, so keep the
promise from one `init()` call, or pass the same functions, instead of new
closures on each call.

The named exports use the client of the newest `init()` call that succeeded.
An earlier call that settles later does not replace it, and a call that fails
never unpublishes: after a failed re-init, the named exports keep using the
previous client. Until a call succeeds, they throw a `PqcError` with
`kind: 'NOT_INITIALIZED'` and `code` 0. `isInitialized()` tells whether a
client is published, and `ready()` resolves with it as soon as one is,
waiting until then; it does not start a load. Code that turns any thrown
error into `false`, such as a message-proof check, should `await ready()`
first.

When `init()` cannot load the WASM module, it rejects with a `PqcLoadError`
(`kind: 'LOAD_FAILED'`, `code` 0). That covers a loader that cannot be
imported or exports no factory, a `pqc.wasm` that cannot be fetched, compiled
or instantiated (as when a CSP without `'wasm-unsafe-eval'` blocks compiling
the embedded copy), a module that does not match this version of the package,
and a `createModule` factory that fails. Its `cause` is the original error.
Its `url` names the file that failed, when `init()` knows it: the `moduleUrl`
loader, when that cannot be imported or exports no factory, or the location
the loader asked for `pqc.wasm` at. Otherwise it is undefined, as when the
loader had the bytes (the embedded copy, or `wasmBinary`) and fetched nothing.
The message names both.
Emscripten's own error names neither the URL nor the HTTP status, so in a
browser `init()` requests an `http(s)` or `chrome-extension:` `url` once more,
waiting at most 10 s, only to report the status of an error response as
`status`.

## Loading

By default, `init()` imports the Emscripten loader `wasm/pqc.mjs` and compiles
a copy of `wasm/pqc.wasm` that the build embeds in `lib/index.mjs` as base64.
The copy is the binary that `wasm/SHA256SUMS` pins, and the package's tests
check it against that hash. Because `init()` fetches no `pqc.wasm` file and
imports the loader by a literal path, bundlers need no configuration for
either: `pnpm smoke:bundlers` checks the default `init()` and the
static-factory recipe below in pages built with the stock settings of webpack
5, esbuild (`--platform=browser`, ESM and IIFE output) and Vite 7 and 8 (both
the production build and the dev server). The embedded copy adds about 70 KB
to `lib/index.mjs` (25 KB gzipped).

Only on Node does the loader import Node's `module` builtin. The package's
`browser` field maps that import to an empty module, so browser builds need no
fallback for it. webpack and Vite still emit `pqc.wasm` as an asset, because
the package refers to the file, but the default `init()` does not request it.

`init()` fetches `pqc.wasm` only when told where it is, through `moduleUrl` or
`locateFile`, for example to cache the file separately or to check its hash
where you deploy it. To serve the loader and `pqc.wasm` with your app, copy
both from the same package version and pass the loader's URL as `moduleUrl`;
`pqc.wasm` is then loaded from the loader's directory:

<!-- snippet: test/types/docs-loading-module-url.mts -->
```ts
const pqc = await init({ moduleUrl: new URL('/pqc/pqc.mjs', location.href) })
```

When the loader's URL has no directory, such as a `blob:` or `data:` URL, the
package's own `pqc.wasm` file is loaded. `locateFile(path, prefix)` overrides
where `pqc.wasm` comes from: it is called with `'pqc.wasm'` and the loader's
directory (a URL, or a file path in Node) and returns the URL or path to load,
or `undefined` to keep the default: beside `moduleUrl` when it is set, the
package's `pqc.wasm` file otherwise.
`wasmBinary` passes the WASM bytes instead, and no file is loaded.

Service workers, Chrome MV3 extension service workers included, do not allow
`import()`, which `init()` uses for the loader, so they should statically
import the Emscripten factory and pass it to `init()`:

<!-- snippet: test/types/mv3-wasm-import.mts -->
```ts
import { init } from '@qbit-oss/pqc'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

With `createModule`, `moduleUrl` is ignored. A factory of your own that calls
the package's should pass on the options object `init()` gives it: besides
`locateFile` and `wasmBinary`, it carries the typed-array constructors and
`Math` functions the glue builds its heap views with (see
[API details](api.md)). With `locateFile`, as here,
`pqc.wasm` is loaded from the extension. Without `locateFile` or `wasmBinary`,
`init()` compiles the embedded copy, so the extension need not ship
`pqc.wasm`; that form, `init({ createModule: createPqcModule })`, is the
static-factory recipe the bundler smoke checks.

The factory subpath ships its own type declarations, so this snippet
type-checks under `tsc --strict` with `node16` or `bundler` module resolution.
See [`docs/mv3-conformance.md`](mv3-conformance.md) for the required MV3 CSP, local WASM
packaging rules, Chrome for Testing smoke command, and security checklist.

### Service workers

Call `init()` when the service worker starts, at the top level of its module
rather than in an event handler, and have handlers wait for it with
`await ready()` or the promise `init()` returned. The client does not survive
a restart: Chrome stops an idle MV3 service worker and starts it again for the
next event with fresh module state, so `init()` runs again and the client from
before the restart is gone.

Signing is synchronous. `sign` and `signWithStats` take about 0.6 s per
signature and block the thread they run on, so an MV3 service worker handles
no other event while it signs (`verify` takes a few milliseconds). To sign off
that thread, create an offscreen document (`chrome.offscreen.createDocument`
with the `WORKERS` reason) that starts a dedicated module `Worker`, call
`init()` and sign in that worker, and relay each request from the service
worker to the offscreen document with `chrome.runtime.sendMessage` and from
there to the worker with `postMessage`. A dedicated worker allows `import()`,
so the default `init()` works there.
