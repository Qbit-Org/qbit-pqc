// The `@qbit-oss/pqc/worker/handler` entry, built as lib/worker-handler.mjs:
// the side of the worker protocol (src/worker-protocol.ts) that runs in the
// worker. It imports the named exports from lib/core.mjs and the error classes
// and byte checks from lib/shared.mjs (tsup.config.ts), sharing the module
// instance of the entry the worker imports init() from.
import {
  deriveP2mrDescriptorKey,
  derivePQCKey,
  keygen,
  secretKeyValidate,
  sign,
  signWithStats,
  verify,
  type PqcClient,
} from './core'
import { isUint8Array, type PqcError, type PqcLoadError } from './shared'
import type { PqcWorkerEndpoint } from './worker'
import {
  DETACHED,
  detachedBytes,
  isMethodName,
  isRecord,
  METHODS,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  resultBytes,
  subscribe,
  transferList,
  zeroAll,
  type MethodName,
  type Response,
  type SerializedError,
} from './worker-protocol'

export type { PqcWorkerEndpoint } from './worker'

/** What {@link servePqcWorker} serves, and where. */
export interface PqcWorkerHandlerOptions {
  /**
   * The client that runs the requests, or a promise for it, such as the one
   * `init()` returns. Requests wait for the promise; when it rejects, as
   * `init()` does with a `PqcLoadError`, every request rejects with that
   * error. Without it, requests run on the named exports, so they use the
   * client the newest successful `init()` in the worker published, and reject
   * with a `PqcError` of kind `'NOT_INITIALIZED'` until one has.
   */
  client?: PqcClient | PromiseLike<PqcClient>
  /**
   * Where requests arrive and results go: in a dedicated worker, its global
   * scope by default; in a Node `worker_threads` worker, pass `parentPort`;
   * or a `MessagePort` the other side holds the other end of.
   */
  endpoint?: PqcWorkerEndpoint
}

// The named exports, which use the client init() published.
const publishedClient: Pick<PqcClient, MethodName> = {
  keygen,
  derivePQCKey,
  deriveP2mrDescriptorKey,
  sign,
  signWithStats,
  verify,
  secretKeyValidate,
}

/**
 * Serves the requests of a worker client (`createPqcWorkerClient` from
 * `@qbit-oss/pqc/worker`) in this worker, until the returned function is
 * called to stop. Each request runs on the client, synchronously, in the
 * order it arrived. The worker zeroes its copies of the request's byte
 * arguments once the call returns or throws, and transfers the keys and
 * signatures of the result to the other side, so none stays in the worker;
 * if sending them fails, it zeroes them and reports the error instead. A
 * thrown error goes back as data the client rebuilds with its class.
 *
 * Messages that are not requests from a worker client are ignored, so the
 * endpoint can carry other messages too.
 */
export function servePqcWorker(options: PqcWorkerHandlerOptions = {}): () => void {
  const endpoint = options.endpoint ?? dedicatedWorkerScope()
  if (!isRecord(endpoint) || typeof endpoint.postMessage !== 'function') {
    throw new TypeError('endpoint must have a postMessage method')
  }
  const client = Promise.resolve(options.client ?? publishedClient)
  // A failed load is reported to each request, not as an unhandled rejection.
  client.catch(() => undefined)

  return subscribe(endpoint, {
    message: message => {
      if (isRecord(message) && message['type'] === REQUEST && typeof message['id'] === 'number') {
        void respond(endpoint, client, message['client'], message['id'], message)
      }
    },
  })
}

function dedicatedWorkerScope(): PqcWorkerEndpoint {
  const scope = globalThis as { DedicatedWorkerGlobalScope?: unknown }
  if (
    typeof scope.DedicatedWorkerGlobalScope !== 'function' ||
    !(globalThis instanceof scope.DedicatedWorkerGlobalScope)
  ) {
    throw new TypeError('servePqcWorker() needs an endpoint outside a dedicated worker')
  }
  return globalThis as unknown as PqcWorkerEndpoint
}

async function respond(
  endpoint: PqcWorkerEndpoint,
  client: Promise<Pick<PqcClient, MethodName>>,
  nonce: unknown,
  id: number,
  request: Record<string, unknown>
): Promise<void> {
  // The byte arguments as they arrived, which are this worker's to zero. A
  // request waits here only while the client loads; when the load fails,
  // every waiting request zeroes its bytes as it rejects.
  const received = receivedBytes(request['args'])
  let response: Response
  let results: Uint8Array[] = []
  try {
    const { method, args } = decodeRequest(request)
    const result = callMethod(await client, method, args)
    results = resultBytes(result)
    response = { type: RESPONSE, client: nonce, id, result }
  } catch (error) {
    response = { type: RESPONSE, client: nonce, id, error: serializeError(error) }
  } finally {
    zeroAll(received)
  }
  try {
    endpoint.postMessage(response, transferList(results))
    // Transferred results are detached already; any the message cloned
    // instead are still here.
    zeroAll(results)
  } catch (error) {
    // Nothing was transferred, so the results are still here.
    zeroAll(results)
    try {
      endpoint.postMessage({ type: RESPONSE, client: nonce, id, error: serializeError(error) } satisfies Response, [])
    } catch {
      // The endpoint takes no message at all: the call stays pending until
      // the client closes.
    }
  }
}

function receivedBytes(args: unknown): Uint8Array[] {
  const views: Uint8Array[] = []
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i += 1) {
      const value: unknown = args[i]
      if (isUint8Array(value)) {
        views[views.length] = value
      }
    }
  }
  return views
}

function decodeRequest(request: Record<string, unknown>): { method: MethodName; args: unknown[] } {
  if (request['version'] !== PROTOCOL_VERSION) {
    throw new Error(
      `worker request uses protocol version ${String(request['version'])}, and this handler ${PROTOCOL_VERSION}: ` +
        'load the client and the handler from the same version of @qbit-oss/pqc'
    )
  }
  const { method, args } = request
  if (!isMethodName(method)) {
    throw new TypeError(`worker request names no client method: ${String(method)}`)
  }
  if (!Array.isArray(args)) {
    throw new TypeError('worker request has no arguments array')
  }
  const kinds = METHODS[method]
  const decoded: unknown[] = []
  for (let i = 0; i < kinds.length; i += 1) {
    const value: unknown = args[i]
    switch (kinds[i]) {
      case 'bytes':
        decoded[i] = value === DETACHED ? detachedBytes() : isUint8Array(value) ? value : null
        break
      case 'uint32':
        decoded[i] = typeof value === 'number' ? value : null
        break
      case 'options':
        decoded[i] = value === true ? { allowLargeMessage: true } : undefined
        break
    }
  }
  return { method, args: decoded }
}

// Called as a method, so a client whose methods use `this` works.
function callMethod(client: Pick<PqcClient, MethodName>, method: MethodName, args: unknown[]): unknown {
  return (client as Record<MethodName, (...args: unknown[]) => unknown>)[method](...args)
}

// Reads what it can of a thrown value without letting a getter on it throw
// here: the response still goes out.
// A PqcError, or a PqcLoadError, by its fields rather than `instanceof`, so an
// error from a client built on another copy of the package keeps them too.
function isPqcErrorLike(error: unknown): error is PqcError {
  return (
    isRecord(error) &&
    typeof error['code'] === 'number' &&
    typeof error['operation'] === 'string' &&
    typeof error['kind'] === 'string'
  )
}

function serializeError(error: unknown): SerializedError {
  try {
    if (isPqcErrorLike(error) && (error.name === 'PqcLoadError' || error.kind === 'LOAD_FAILED')) {
      const { url, status } = error as PqcLoadError
      return {
        class: 'PqcLoadError',
        message: String(error.message),
        url: typeof url === 'string' ? url : undefined,
        status: typeof status === 'number' ? status : undefined,
        cause: serializeCause((error as PqcLoadError).cause),
      }
    }
    if (isPqcErrorLike(error)) {
      return {
        class: 'PqcError',
        message: String(error.message),
        operation: error.operation,
        code: error.code,
        kind: error.kind,
        stats: error.stats,
      }
    }
    if (error instanceof Error) {
      return { class: 'Error', name: String(error.name), message: String(error.message) }
    }
    return { class: 'Error', name: 'Error', message: String(error) }
  } catch {
    return { class: 'Error', name: 'Error', message: 'the worker threw an error it could not describe' }
  }
}

function serializeCause(cause: unknown): { name: string; message: string } | string | undefined {
  if (typeof cause === 'string' || cause === undefined) {
    return cause
  }
  if (isRecord(cause) && typeof cause['message'] === 'string') {
    return { name: typeof cause['name'] === 'string' ? cause['name'] : 'Error', message: cause['message'] }
  }
  return String(cause)
}
