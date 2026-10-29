# @qbit-oss/pqc Signing in a Worker

`sign` and `signWithStats` take about 0.6 s per signature and block the
thread they run on. Two entries move them, and every other client method, to
a dedicated worker:

- `@qbit-oss/pqc/worker/handler` runs in the worker. `servePqcWorker()`
  serves the requests that arrive there on a client, usually the one
  `init()` loads.
- `@qbit-oss/pqc/worker` runs on the other side, in a page, an offscreen
  document or Node's main thread. `createPqcWorkerClient(endpoint)` returns a
  client with the methods of the client `init()` returns, each returning a
  promise.

## In a browser

The worker loads the WASM module and serves it:

<!-- snippet: test/types/docs-worker-browser.mts -->
```ts
// pqc-worker.js
import { init } from '@qbit-oss/pqc'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init() })
```

The page starts the worker as a module worker and calls it:

<!-- snippet: test/types/docs-worker-browser.mts -->
```ts
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'

const worker = new Worker(new URL('./pqc-worker.js', import.meta.url), { type: 'module' })
const pqc = createPqcWorkerClient(worker)

const signature = await pqc.sign(secretKey, digest)
const valid = await pqc.verify(publicKey, digest, signature)
```

`client` takes the promise `init()` returns, so requests wait for the load,
and every request rejects with its `PqcLoadError` if the load fails. Any
`init()` options work here; to keep the embedded copy of `pqc.wasm` out of
the worker's bundle, import `init` from `@qbit-oss/pqc/external-wasm` and say
where the file is (see [Package entries](loading.md#package-entries)).
Without `client`, the handler runs each request on the named exports, which
use the client the newest successful `init()` in the worker published, and
reject with `kind: 'NOT_INITIALIZED'` until one has.

## In Node

In a `worker_threads` worker, pass `parentPort` as the endpoint. This example
is both sides in one file: run directly, it starts itself as the worker and
signs there.

<!-- snippet: examples/worker-signing.mjs -->
```js
import { isMainThread, parentPort, Worker } from 'node:worker_threads'

import { init } from '@qbit-oss/pqc'
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

if (isMainThread) {
  // This same file, started as a worker_threads worker, runs the else branch.
  const worker = new Worker(new URL(import.meta.url))
  const pqc = createPqcWorkerClient(worker)

  const entropy = crypto.getRandomValues(new Uint8Array(pqc.constants.MIN_ENTROPY))
  const { publicKey, secretKey } = await pqc.keygen(entropy)
  const message = new TextEncoder().encode('hello, qbit')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
  const signature = await pqc.sign(secretKey, digest)

  console.log(signature.length) // 3680
  console.log(await pqc.verify(publicKey, digest, signature)) // true

  pqc.close()
  await worker.terminate()
} else {
  servePqcWorker({ client: init(), endpoint: parentPort })
}
```

## Chrome MV3 extensions

An MV3 service worker cannot start a worker. An offscreen document can: it
starts the dedicated worker and holds the client, and the service worker
sends it requests with `chrome.runtime.sendMessage`. The manifest needs the
`offscreen` permission.

<!-- snippet: test/types/docs-worker-mv3.mts -->
```ts
// pqc-worker.js, started by the offscreen document
import { init } from '@qbit-oss/pqc/external-wasm'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init({ locateFile: path => new URL(`/wasm/${path}`, location.origin).href }) })
```

<!-- snippet: test/types/docs-worker-mv3.mts -->
```ts
// offscreen.js, loaded by offscreen.html
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'

const worker = new Worker(new URL('./pqc-worker.js', import.meta.url), { type: 'module' })
const pqc = createPqcWorkerClient(worker, { onError: event => console.error('PQC worker error', event) })

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'pqc-sign') {
    return false
  }
  pqc.sign(Uint8Array.from(message.secretKey), Uint8Array.from(message.digest)).then(
    signature => sendResponse({ signature: Array.from(signature) }),
    error => sendResponse({ error: `${error.name}: ${error.message}`, kind: error.kind })
  )
  return true
})
```

<!-- snippet: test/types/docs-worker-mv3.mts -->
```ts
// In the service worker
// One createDocument() call, which concurrent requests share; a failed one is
// tried again by the next request.
let offscreenDocument: Promise<void> | undefined
function ensureOffscreenDocument(): Promise<void> {
  offscreenDocument ??= (async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Sign with @qbit-oss/pqc off the service worker thread',
      })
    }
  })().catch(error => {
    offscreenDocument = undefined
    throw error
  })
  return offscreenDocument
}

// sendMessage() rejects with "Receiving end does not exist" until the
// offscreen document's script has added its listener, which can be after
// createDocument() resolves: retry on that error only, for at most 5 s.
async function sendToOffscreen(message: object): Promise<any> {
  await ensureOffscreenDocument()
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (error) {
      if (attempt === 50 || !String(error).includes('Receiving end does not exist')) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

const response = await sendToOffscreen({
  type: 'pqc-sign',
  secretKey: Array.from(secretKey),
  digest: Array.from(digest),
})
```

`chrome.runtime` messages are serialized as JSON, so bytes travel as arrays of
numbers and errors as the fields the relay copies. Those copies, of the
secret key too, are strings and arrays the package cannot zero; keep secret
keys out of the relay where you can, for example by deriving them in the
worker. The MV3 smoke (`pnpm test:mv3`) runs this relay with the package's
golden vectors.

## Endpoints

`createPqcWorkerClient` and `servePqcWorker` take an endpoint: a `Worker`, a
`MessagePort`, a dedicated worker's global scope, Node's `worker_threads`
`Worker`, `MessagePort` or `parentPort`, or any object with
`postMessage(message, transfer)` and message events. They listen with
`addEventListener` when the endpoint has it, and with Node's `on` otherwise,
and call `start()` when it exists, as a `MessagePort` needs. In a dedicated
worker, `servePqcWorker` uses the worker's global scope unless `endpoint`
names another; elsewhere it needs one. An endpoint of your own must copy or
transfer each message before `postMessage` returns, as a `Worker` or
`MessagePort` does: both sides zero their byte buffers once it returns, so an
endpoint that kept the message to send later would send zeros.

Requests and responses are tagged, so the endpoint can carry other messages,
which both sides ignore. Each client draws a random 128-bit nonce, and every
request carries it and an id; the handler sends both back, and a client
settles only its own calls. Clients that share a worker, even from separate
copies of the package in one app, never take each other's results. Calls
made at once settle independently, as the worker answers them. One worker
runs one call at a time, in the order the calls arrived; for signatures in
parallel, start several workers, each with its own client.

## Arguments and buffers

The client copies each byte argument into a fresh buffer and transfers that
buffer to the worker, so the caller's buffers are never detached or changed;
once posted, it zeroes any copy the endpoint cloned rather than moved.
`options` is read on the calling thread, before the request is sent, with
the same rules and errors as a call on that thread, and only its
`allowLargeMessage` boolean is sent. A value that is not a `Uint8Array`, or a
view on a detached buffer, reaches the worker's client as a value it rejects
with the same `TypeError`, so errors come in the order a call on the calling
thread would throw them, with one exception: when the handler serves the
named exports and no `init()` in the worker has succeeded yet, invalid
`options` throw their `TypeError` where a direct call of a named export would
throw `NOT_INITIALIZED`, which it checks first.

In the worker, the handler zeroes its copies of the byte arguments when the
call returns or throws, and requests that wait for a load that fails zero
theirs as they reject. The keys and signatures of a result are transferred
back, and the handler zeroes any the endpoint cloned instead, so the worker
keeps no copy of them; if sending them fails, the handler zeroes them and
sends the error instead. When `close()` rejects calls the
worker is still running, the client keeps receiving their answers and zeroes
the keys and signatures they carry (see [Closing](#closing)); it zeroes those
of any other answer with its nonce that no call waits for, too. Inside the call, the worker's client zeroes its
copies in WASM memory as it always does (see
[SECURITY.md](../SECURITY.md#security-boundaries)).

Copies the package does not zero:

- the caller's own buffers, and the keys and signatures the client returns,
  which belong to the caller, as on one thread;
- the parts of a message that are cloned rather than transferred: the method
  name, the HKDF fields or range index, and the `allowLargeMessage` flag. Byte
  buffers are transferred, not cloned; whether the engine copies memory when
  it transfers a buffer is up to the engine;
- anything an application relays outside the package, such as the JSON of
  `chrome.runtime` messages above;
- the memory of a worker that crashes or is terminated during a call, which
  the engine frees without zeroing;
- the answers to calls a client stopped waiting for with a second `close()`
  or `close({ force: true })`, which arrive with no listener to zero them;
- the results of a `client` passed to `servePqcWorker` that returns views on
  part of a buffer, or on a `SharedArrayBuffer`. Those are cloned, not
  transferred, and stay in the worker. The client `init()` returns gives each
  result a buffer of its own.

## Errors

Structured cloning turns a `PqcError` into a plain `Error`, so the handler
sends errors as data and the client rebuilds them. A `PqcError` and a
`PqcLoadError` are instances of the package's own classes, the ones every
entry exports, so `instanceof` works, with `operation`, `kind`, `code`,
`nativeName`, `stats` and `message`, and a `PqcLoadError`'s `url`, `status`
and `cause`. A `TypeError`, `RangeError` or other built-in error keeps its
class and message. Stacks are those of the calling thread.

`@qbit-oss/pqc/worker` exports `PqcError`, `PqcLoadError`, `errorCodes` and
`constants` too: the same objects every entry exports. Import them from there
in code that holds the client, so its bundle reaches neither the WASM module
nor the code that loads it.

Errors the endpoint reports, as opposed to calls, go to the `onError` option
of `createPqcWorkerClient`: a browser `Worker`'s `error` event, fired when its
script cannot load or throws an uncaught error, and `messageerror` events. The
client stays open, since a browser offers no reliable event for a worker that
is gone, and calls the worker still answers settle as usual. Decide in
`onError` whether to close the client and terminate the worker. On a Node
`worker_threads` `Worker`, the client adds no `error` listener, so an uncaught
error in the worker reaches Node's own handling as it would without the
client, and the worker's `exit` event closes the client.

## Closing

`client.close()` rejects every pending call, and every later one, with an
`Error` whose `name` is `'PqcWorkerClosedError'`. It does not terminate the
worker or close the endpoint, which belong to the caller. While the worker
may still answer the calls it rejected, the client keeps listening for those
answers only, to zero the keys and signatures they carry, and stops when the
last one has arrived or the endpoint reports that the worker is gone. A second
`close()`, or `close({ force: true })`, stops listening at once.

The client closes itself only when the endpoint reports that the worker is
gone: Node's `exit` event on a `worker_threads` `Worker`, or a `close` event,
which a `MessagePort` fires, where the runtime supports it, when its other end
closes. The error's `cause` is that event or exit code. A browser fires no
event when `worker.terminate()` stops a worker, so call
`close({ force: true })` after `terminate()`: no answers will come to zero.

There is no timeout. A worker that stops answering without one of those events
leaves calls pending until `close()`.

## Bundles

`@qbit-oss/pqc/worker` imports only `lib/shared.mjs`, the package's internal
module for the error classes, `constants`, byte checks and `options` rules,
which `lib/core.mjs`, the implementation, imports too. So nothing the calling
side imports refers to the Emscripten loader or `pqc.wasm`, through `import`,
`import()` or `new URL(..., import.meta.url)`, and a bundle of it carries
neither, nor an embedded copy; `instanceof` still works across entries,
since they share that one module. The package's consumer smoke walks the
built files `lib/worker.mjs` reaches and checks this.
