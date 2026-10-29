// The `@qbit-oss/pqc/worker` entry, built as lib/worker.mjs: a client for a
// worker that runs servePqcWorker (src/worker-handler.ts). It imports only
// lib/shared.mjs (src/shared.ts), for the error classes, constants, byte
// checks and options reader that lib/core.mjs uses too, so it shares their one
// copy and `instanceof` works across entries. Nothing it imports reaches the
// Emscripten loader or pqc.wasm (scripts/package-surface.mjs checks the built
// graph). The types it names from src/core.ts are erased from the build.
import type { PqcDerivedKeyPair, PqcKeyPair, PqcMessageOptions, PqcSignWithStatsResult } from './core'
import {
  constants,
  PqcError,
  PqcLoadError,
  readAllowLargeMessage,
  isUint8Array,
  withDerivedKeyAliases,
  type PqcSignStats,
} from './shared'

// The classes the client's errors are instances of, and the constants, so code
// that imports the client checks them without importing an entry that loads
// the WASM module. They are the objects every entry exports.
export {
  constants,
  errorCodes,
  PqcError,
  PqcLoadError,
  type PqcErrorKind,
  type PqcNativeErrorCode,
  type PqcNativeErrorName,
  type PqcSignStats,
} from './shared'
import {
  copyBytes,
  isRecord,
  METHODS,
  PROTOCOL_VERSION,
  randomNonce,
  REQUEST,
  RESPONSE,
  resultBytes,
  subscribe,
  transferList,
  usesEventTarget,
  zeroAll,
  type MethodName,
  type Request,
  type SerializedError,
} from './worker-protocol'

/**
 * Where a worker client sends requests and receives results, and where
 * {@link servePqcWorker} receives requests and sends results: a `Worker`, a
 * `MessagePort`, a dedicated worker's global scope, Node's `worker_threads`
 * `Worker`, `MessagePort` or `parentPort`, or any object with `postMessage`
 * and message events. Events are received through `addEventListener` when
 * the object has it, as `{ data }` events, and through Node's `on` otherwise,
 * as the message itself. `start()`, which a `MessagePort` needs, is called
 * when present.
 */
export interface PqcWorkerEndpoint {
  /**
   * Sends `message` to the other side, transferring the buffers in
   * `transfer`. It must copy or transfer the message before it returns, as a
   * `Worker` or `MessagePort` does: once it returns, the client and the
   * handler zero their byte buffers, so an endpoint that held on to the
   * message to send it later would send zeros.
   */
  postMessage(message: unknown, transfer: ArrayBuffer[]): void
  /** Listens for an event, as on a `Worker` or `MessagePort`. */
  addEventListener?(type: string, listener: (event: any) => void): void
  /** Stops listening for an event added with `addEventListener`. */
  removeEventListener?(type: string, listener: (event: any) => void): void
  /** Listens for an event, as on Node's `worker_threads` `Worker`. */
  on?(type: string, listener: (value: any) => void): unknown
  /** Stops listening for an event added with `on`. */
  off?(type: string, listener: (value: any) => void): unknown
  /** Starts delivering messages, as a `MessagePort` needs. */
  start?(): void
}

/**
 * The client {@link createPqcWorkerClient} returns: the methods of a
 * `PqcClient`, each run in the worker and returning a promise, which settles
 * with what the method returns there or rejects with what it throws. Calls
 * are independent: each request carries the client's random nonce and an id,
 * and its promise settles when the worker answers it, in whatever order the
 * worker does.
 *
 * Byte arguments are copied into fresh buffers, which are transferred to the
 * worker, so the caller's buffers are never detached; the worker zeroes its
 * copies after the call. The keys and signatures in a result are buffers the
 * worker transferred back, and a derived key reads its keys as `publicKey` and
 * `secretKey` too, as on the calling thread. `options` is read on the calling
 * thread, before the request is sent, which throws what a call on this thread
 * would throw for it.
 *
 * Errors keep their class: a `PqcError` or `PqcLoadError` is rebuilt as an
 * instance of the package's own class, with its `operation`, `kind`, `code`,
 * `nativeName` and `stats`, and a `PqcLoadError`'s `url`, `status` and
 * `cause`; a `TypeError` or `RangeError` keeps its type and message. Once the
 * client is closed, every pending call and every later call rejects with an
 * `Error` whose `name` is `'PqcWorkerClosedError'`.
 */
export interface PqcWorkerClient {
  /** The package's frozen `constants`, read without asking the worker. */
  readonly constants: typeof constants
  /** `PqcClient.keygen` in the worker. */
  keygen(entropy: Uint8Array): Promise<PqcKeyPair>
  /** `PqcClient.derivePQCKey` in the worker: the HKDF primitive, not BIP32 path fields. */
  derivePQCKey(
    masterSeed: Uint8Array,
    hkdfAccount: number,
    hkdfChange: number,
    hkdfIndex: number
  ): Promise<PqcDerivedKeyPair>
  /** `PqcClient.deriveP2mrDescriptorKey` in the worker. */
  deriveP2mrDescriptorKey(leafPrivateKey: Uint8Array, rangeIndex: number): Promise<PqcDerivedKeyPair>
  /** `PqcClient.sign` in the worker, which takes about 0.6 s off the calling thread. */
  sign(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): Promise<Uint8Array>
  /** `PqcClient.signWithStats` in the worker. */
  signWithStats(sk: Uint8Array, msg: Uint8Array, options?: PqcMessageOptions): Promise<PqcSignWithStatsResult>
  /** `PqcClient.verify` in the worker. */
  verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array, options?: PqcMessageOptions): Promise<boolean>
  /** `PqcClient.secretKeyValidate` in the worker. */
  secretKeyValidate(sk: Uint8Array): Promise<boolean>
  /**
   * Rejects every pending call, and every later one, with a
   * `PqcWorkerClosedError`. It neither terminates the worker nor closes the
   * endpoint, which belong to the caller. While the worker may still answer
   * the calls it rejected, the client keeps listening for those answers only,
   * to zero the keys and signatures they carry, until the last one arrives or
   * the endpoint reports that the worker is gone. A second `close()`, or
   * `close({ force: true })`, stops listening at once, and answers that arrive
   * after that are not zeroed. A browser `Worker`
   * stopped with `terminate()` reports nothing, so call `close({ force: true })`
   * after `terminate()`.
   */
  close(options?: PqcWorkerCloseOptions): void
}

/** Options for {@link createPqcWorkerClient}. */
export interface PqcWorkerClientOptions {
  /**
   * Called with each `error` or `messageerror` event the endpoint fires, such
   * as the `ErrorEvent` of a browser `Worker` whose script failed to load or
   * threw an uncaught error. The client stays open, and calls the worker still
   * answers settle as usual: a browser has no reliable event for a worker that
   * is gone, so decide here whether to close it. No `error` listener is added
   * to a Node `worker_threads` `Worker`, whose uncaught errors reach Node's own
   * handling as before; its `exit` event closes the client.
   */
  onError?: (event: unknown) => void
}

/** Options for {@link PqcWorkerClient.close}. */
export interface PqcWorkerCloseOptions {
  /** Stop listening at once, without waiting for answers to zero. */
  force?: boolean
}

/**
 * Returns a client for the worker behind `endpoint`, which must run
 * {@link servePqcWorker}. The client closes itself, rejecting every pending
 * call, only when the endpoint reports that the worker is gone: Node's `exit`
 * event on a `worker_threads` `Worker`, or a `close` event, which a
 * `MessagePort` fires where the runtime supports it when its other end
 * closes. `error` and `messageerror` events go to `options.onError` and leave
 * the client open.
 */
export function createPqcWorkerClient(
  endpoint: PqcWorkerEndpoint,
  options: PqcWorkerClientOptions = {}
): PqcWorkerClient {
  if (!isRecord(endpoint) || typeof endpoint.postMessage !== 'function') {
    throw new TypeError('endpoint must have a postMessage method')
  }
  const onError = options.onError
  // Every request and response of this client carries it (src/worker-protocol.ts).
  const nonce = randomNonce()
  let lastId = 0
  const pending = new Map<
    number,
    { method: MethodName; resolve: (value: any) => void; reject: (reason: unknown) => void }
  >()
  let closedError: Error | undefined
  // The calls close() rejected while the worker was still there to answer
  // them. Their answers are no one's, so the client keeps listening for them
  // only to zero the keys they carry.
  const abandoned = new Set<number>()

  const reportError = (event: unknown) => onError?.(event)
  const unsubscribe = subscribe(
    endpoint,
    usesEventTarget(endpoint)
      ? {
          message: onMessage,
          error: reportError,
          messageerror: reportError,
          close: event => close('the endpoint was closed', event, true),
        }
      : {
          message: onMessage,
          messageerror: reportError,
          exit: code => close(`the worker exited with code ${String(code)}`, code, true),
        }
  )

  function onMessage(message: unknown): void {
    if (
      !isRecord(message) ||
      message['type'] !== RESPONSE ||
      message['client'] !== nonce ||
      typeof message['id'] !== 'number'
    ) {
      return
    }
    const id = message['id']
    if (abandoned.delete(id)) {
      zeroAll(resultBytes(message['result']))
      if (abandoned.size === 0) {
        unsubscribe()
      }
      return
    }
    const call = pending.get(id)
    if (call === undefined) {
      // An answer for this client that no call waits for, such as a second
      // answer to one request: its keys are no one's.
      zeroAll(resultBytes(message['result']))
      return
    }
    pending.delete(id)
    // A malformed answer rejects its call rather than throwing into the
    // endpoint's event dispatch.
    try {
      if ('error' in message) {
        call.reject(rebuildError(message['error']))
      } else if (call.method === 'derivePQCKey' || call.method === 'deriveP2mrDescriptorKey') {
        // Structured cloning drops the non-enumerable aliases.
        call.resolve(withDerivedKeyAliases(message['result'] as { pk32: Uint8Array; sk64: Uint8Array }))
      } else {
        call.resolve(message['result'])
      }
    } catch (error) {
      zeroAll(resultBytes(message['result']))
      call.reject(error)
    }
  }

  // `detach` when no answer is coming, or the caller wants none.
  function close(reason: string, cause: unknown, detach: boolean): void {
    if (closedError === undefined) {
      closedError = closedClientError(reason, cause)
      const calls = [...pending]
      pending.clear()
      for (const [id, call] of calls) {
        abandoned.add(id)
        call.reject(closedError)
      }
    }
    if (detach) {
      abandoned.clear()
    }
    if (abandoned.size === 0) {
      unsubscribe()
    }
  }

  function call(method: MethodName, args: readonly unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (closedError !== undefined) {
        reject(closedError)
        return
      }
      let encoded: { args: unknown[]; copies: Uint8Array[] }
      try {
        encoded = encodeArguments(method, args)
      } catch (error) {
        reject(error)
        return
      }
      lastId += 1
      const id = lastId
      const request: Request = {
        type: REQUEST,
        version: PROTOCOL_VERSION,
        client: nonce,
        id,
        method,
        args: encoded.args,
      }
      pending.set(id, { method, resolve, reject })
      try {
        endpoint.postMessage(request, transferList(encoded.copies))
      } catch (error) {
        pending.delete(id)
        reject(error)
      } finally {
        // Transferred copies are detached already; any the message cloned
        // instead, and every copy when posting failed, are still here.
        zeroAll(encoded.copies)
      }
    })
  }

  return Object.freeze({
    constants,
    keygen: entropy => call('keygen', [entropy]),
    derivePQCKey: (masterSeed, hkdfAccount, hkdfChange, hkdfIndex) =>
      call('derivePQCKey', [masterSeed, hkdfAccount, hkdfChange, hkdfIndex]),
    deriveP2mrDescriptorKey: (leafPrivateKey, rangeIndex) =>
      call('deriveP2mrDescriptorKey', [leafPrivateKey, rangeIndex]),
    sign: (sk, msg, options) => call('sign', [sk, msg, options]),
    signWithStats: (sk, msg, options) => call('signWithStats', [sk, msg, options]),
    verify: (pk, msg, sig, options) => call('verify', [pk, msg, sig, options]),
    secretKeyValidate: sk => call('secretKeyValidate', [sk]),
    close: closeOptions =>
      close('close() was called', undefined, closedError !== undefined || closeOptions?.force === true),
  } satisfies PqcWorkerClient)
}

// The request arguments for `args` (see src/worker-protocol.ts). `options`
// comes last in every method that takes it and is read first, as the client
// on this thread reads it, so an error it causes is thrown before any copy.
function encodeArguments(method: MethodName, args: readonly unknown[]): { args: unknown[]; copies: Uint8Array[] } {
  const kinds = METHODS[method]
  const encoded: unknown[] = []
  const copies: Uint8Array[] = []
  const last = kinds.length - 1
  const allowLargeMessage = kinds[last] === 'options' ? readAllowLargeMessage(args[last]) : undefined
  for (let i = 0; i < kinds.length; i += 1) {
    const value = args[i]
    switch (kinds[i]) {
      case 'bytes': {
        const copy = isUint8Array(value) ? copyBytes(value) : null
        if (isUint8Array(copy)) {
          copies[copies.length] = copy
        }
        encoded[i] = copy
        break
      }
      case 'uint32':
        encoded[i] = typeof value === 'number' ? value : null
        break
      case 'options':
        encoded[i] = allowLargeMessage
        break
    }
  }
  return { args: encoded, copies }
}

function closedClientError(reason: string, cause: unknown): Error {
  const error = new Error(`@qbit-oss/pqc worker client is closed: ${reason}`)
  error.name = 'PqcWorkerClosedError'
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, writable: true, value: cause })
  }
  return error
}

const ERROR_CLASSES: Record<string, ErrorConstructor> = Object.assign(Object.create(null), {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
})

// The error the worker serialized, as an instance of the class it threw
// there: the package's PqcError and PqcLoadError, which the worker's copy of
// the package shares the definitions of, or a built-in Error class.
function rebuildError(serialized: unknown): Error {
  if (!isRecord(serialized)) {
    return new Error('the worker failed without an error')
  }
  const error = serialized as SerializedError
  const message = String(error.message)
  let rebuilt: Error
  if (error.class === 'PqcLoadError') {
    const cause = typeof error.cause === 'string' || error.cause === undefined ? error.cause : rebuildCause(error.cause)
    rebuilt = new PqcLoadError(error.url, error.status, { cause })
  } else if (error.class === 'PqcError') {
    rebuilt = new PqcError(
      error.operation,
      error.code,
      error.stats === undefined ? {} : { stats: error.stats as PqcSignStats }
    )
    // Errors the wrapper raises itself, such as NOT_INITIALIZED, replace the
    // kind PqcError derives from the code, as src/index.ts does.
    if ((rebuilt as PqcError).kind !== error.kind) {
      Object.defineProperty(rebuilt, 'kind', { value: error.kind })
    }
  } else {
    const ErrorClass = ERROR_CLASSES[String(error.name)] ?? Error
    rebuilt = new ErrorClass(message)
    if (rebuilt.name !== error.name) {
      rebuilt.name = String(error.name)
    }
  }
  if (rebuilt.message !== message) {
    Object.defineProperty(rebuilt, 'message', { value: message })
  }
  return rebuilt
}

function rebuildCause({ name, message }: { name: string; message: string }): Error {
  const cause = new (ERROR_CLASSES[name] ?? Error)(message)
  if (cause.name !== name) {
    cause.name = name
  }
  return cause
}
