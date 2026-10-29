# @qbit-oss/pqc Initialization and Loading

How `init()` shares, publishes and reports a load, where it loads the WASM
module from, which package entry to import, and how to use it in service
workers.

## Initialization

`init()` loads the WASM module and resolves with a client, which it also
publishes for the named exports. Calls with the same options share one load:
they return distinct promises that resolve to the same client, so calling
`init()` wherever the package is used does not instantiate another 17 MB
module each time. Options are the same when `moduleUrl` has the same string
form (a `URL` matches its `href`), `createModule`, `locateFile` and
`wasmBinary` are the same objects, and `expectedWasmSha256` is the same
string; `init()`, `init(undefined)` and `init({})` are the same. A call with
other options loads a new module, so keep the promise from one `init()` call,
or pass the same functions, instead of new closures on each call.

The named exports use the client of the newest `init()` call that succeeded,
through either [package entry](#package-entries).
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
a `createModule` factory that fails, and bytes whose SHA-256 is not
`expectedWasmSha256` (see [Checking pqc.wasm](#checking-pqcwasm)). Its `cause`
is the original error. Its `url` names the file that failed, when `init()`
knows it: the `moduleUrl` loader, when that cannot be imported or exports no
factory, or the location the loader asked for `pqc.wasm` at. Otherwise it is
undefined, as when the loader had the bytes (the embedded copy, or
`wasmBinary`) and fetched nothing. The message names both.
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

### Package entries

`@qbit-oss/pqc` and `@qbit-oss/pqc/external-wasm` export the same API and
differ only in where `init()` gets `pqc.wasm` when no option says:

- `@qbit-oss/pqc` (`lib/index.mjs`) embeds a copy of `pqc.wasm`, which
  `init()` compiles unless `locateFile` or `moduleUrl` says where the file is,
  or `wasmBinary` passes the bytes. It needs no configuration: no bundler has
  to emit `pqc.wasm` and no server has to serve it.
- `@qbit-oss/pqc/external-wasm` (`lib/external-wasm.mjs`) embeds no copy, so a
  bundle that imports only this entry is about 70 KB smaller (25 KB gzipped).
  Its `init()` loads `pqc.wasm` from `locateFile`, beside `moduleUrl`, or the
  package's own `wasm/pqc.wasm`, unless `wasmBinary` passes the bytes. Use it
  when you serve or package `pqc.wasm` yourself, as a Chrome MV3 extension
  that passes `locateFile` does. Node reads the package's file from the
  installed package. Bundlers that handle `new URL('...', import.meta.url)`,
  such as webpack 5 and Vite's production build, emit the file and point
  `init()` at their copy; esbuild leaves the URL as written, so with esbuild
  pass `locateFile` or `moduleUrl`.

Given `locateFile`, a `wasmBinary` that is not `null` or `undefined`, or
`moduleUrl` without `createModule`, the two `init()` functions do the same
thing, load errors included.

Both entries are one module instance: each imports `lib/core.mjs`, the one copy
of the implementation, which no `exports` entry names, and exports only the
public API, `lib/index.mjs` with its own `init()`. However an app and its
dependencies import them, with `import` or `require()`, they share the
published client, `ready()`, `isInitialized()`, the named exports, the
`PqcError` and `PqcLoadError` classes, `constants` and `errorCodes`, so
`instanceof` works across entries. Calls through the two entries share a load
when they load the same way, as with the same `locateFile` function; `init()`
through `@qbit-oss/pqc`, which compiles the embedded copy, and `init()`
through `@qbit-oss/pqc/external-wasm`, which loads the file, load separately.
Code that copies the package's files without a bundler must copy the whole
`lib/` directory, since the entries import the files beside them.

### Static factory

Service workers, Chrome MV3 extension service workers included, do not allow
`import()`, which `init()` uses for the loader, so they should statically
import the Emscripten factory and pass it to `init()`:

<!-- snippet: test/types/mv3-wasm-import.mts -->
```ts
import { init } from '@qbit-oss/pqc/external-wasm'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

With `createModule`, `moduleUrl` is ignored. A factory of your own that calls
the package's should pass on the options object `init()` gives it: besides
`locateFile` and `wasmBinary`, it carries `qbitPqcIntrinsics`, the copies of
globals the glue builds its heap views and grows memory with (see
[API details](api.md)). With `locateFile`, as here, `pqc.wasm` is loaded from
the extension, and the external-wasm entry keeps a second copy out of the
service worker bundle. To ship no `pqc.wasm` file instead, import `init` from
`@qbit-oss/pqc` and leave out `locateFile` and `wasmBinary`:
`init({ createModule: createPqcModule })` compiles the embedded copy. That is
the static-factory recipe the bundler smoke checks, beside this one.

The factory subpath ships its own type declarations, so this snippet
type-checks under `tsc --strict` with `node16` or `bundler` module resolution.
See [`docs/mv3-conformance.md`](mv3-conformance.md) for the required MV3 CSP, local WASM
packaging rules, Chrome for Testing smoke command, and security checklist.

### Checking pqc.wasm

`wasm/SHA256SUMS` pins the SHA-256 of `pqc.wasm`, and `constants.WASM_SHA256`
is that digest for the installed version. To have `init()` refuse any other
bytes, pass it as `expectedWasmSha256`:

<!-- snippet: test/types/docs-loading-expected-wasm-sha256.mts -->
```ts
import { constants, init } from '@qbit-oss/pqc'

const pqc = await init({
  moduleUrl: new URL('/pqc/pqc.mjs', location.href),
  expectedWasmSha256: constants.WASM_SHA256,
})
```

`init()` then hashes the bytes it is about to compile and, when their digest
differs, rejects with a `PqcLoadError` (`kind: 'LOAD_FAILED'`) before compiling
them. The message names both digests, and `url` is the file the bytes came
from, when `init()` read one. Bytes that match are passed to the factory, which
`init()` calls once, as `wasmBinary`; if they then fail to compile, `url` is
undefined, as for `wasmBinary`. The value must be 64 lowercase hex characters;
any other value rejects with a `TypeError` before anything loads. A call with
a digest never shares a load made without one, or with another one.

The check covers each source of the bytes:

- `wasmBinary`: `init()` hashes a copy and passes the copy to the loader, so
  writing to your buffer afterwards does not change what is compiled.
- The embedded copy, which the default `init()` and `createModule` without
  `locateFile` compile.
- `moduleUrl` and `locateFile`, with or without `createModule`, as in the
  service worker recipe above: `init()` works out where the loader would load
  `pqc.wasm` from, by the rules above, reads it itself with `fetch()` (or from
  the file system in Node), and passes the bytes to the loader as
  `wasmBinary`, so the loader loads no file. A failed read gives the
  `PqcLoadError` the file's `url`, and the `status` of an error response.

To work that location out without the loader, `init()` calls `locateFile`
itself, once, with the `prefix` the loader would pass: the directory of the
`moduleUrl` module (a file path in Node, a URL elsewhere, or `''` for a
`blob:` or `data:` URL) or, when `moduleUrl` is not in effect, the package's
own `wasm/` directory. In Node, a `moduleUrl` that is a symlink counts as the
file it points to, as Node's module resolution follows symlinks unless it runs
with `--preserve-symlinks`. When the factory itself asks `locateFile` where
`pqc.wasm` is, it gets the location `init()` read; any other file is located
as without the option.

Because `init()` works the location out itself, two cases can differ from
where the loader would look:

- A `moduleUrl` that is a path, such as `./pqc/pqc.mjs`, is resolved against
  the package's own module URL, as `import()` resolves it there. A bundler
  that rewrites `import.meta.url`, as webpack does, can make that a path on
  the build machine. Pass an absolute URL. A bare specifier, such as
  `@qbit-oss/pqc/wasm/pqc.mjs`, is resolved with `import.meta.resolve`
  (browsers, Node), which applies package exports and import maps. Where that
  is missing, as in a bundle that strips it, `init()` rejects and asks for an
  absolute URL. Import maps and HTTP redirects that `import()` applies to a
  URL or path `moduleUrl` are not followed, so the `pqc.wasm` read is beside
  the URL as written. In Node, a symlinked loader is followed to its real
  file, as Node's resolver does, unless `--preserve-symlinks` or
  `NODE_PRESERVE_SYMLINKS=1` is set.
- With `createModule`, `locateFile` receives the package's `wasm/` directory
  as `prefix`, not the directory of wherever your copy of the loader lives.
  The two are the same when the factory is `@qbit-oss/pqc/wasm/pqc.mjs` as
  installed.

Either way, a wrong location fails closed: `init()` rejects with a
`PqcLoadError` and compiles nothing, because the bytes it reads there are
missing or do not have the digest. A `moduleUrl` that `init()` cannot resolve
rejects too, naming it, rather than falling back to the package's own
`pqc.wasm`, which need not match a loader from another copy. In Node, `init()`
reads only a path or a URL starting with `file://` (lower case, as the loader
reads it). It rejects any other URL, naming its scheme: one with `//` after its
scheme, a `data:` or `blob:` URL, and `file:/x` or `FILE://` forms. A path
such as `build:v2/pqc.wasm` is still a path. For the most predictable result, have
`locateFile` return an absolute URL, or pass the bytes as `wasmBinary`.

Not checked:

- The loader itself: the package's `wasm/pqc.mjs`, the module `moduleUrl`
  names, or a `createModule` factory. It runs before any bytes are hashed, so
  ship it with your app and compare it with `wasm/SHA256SUMS` when you build.
- A `createModule` factory that ignores `wasmBinary` and compiles bytes of its
  own.
- Code that runs in the same JavaScript context before `init()` settles,
  which can replace `WebAssembly` or `fetch`.

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
there to the worker. A dedicated worker allows `import()`, so the default
`init()` works there. `@qbit-oss/pqc/worker` provides the client for the
offscreen document and the handler for the worker;
[Signing in a worker](worker.md#chrome-mv3-extensions) shows the relay.
