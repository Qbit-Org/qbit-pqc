// The messages between the worker client (src/worker.ts, built as
// lib/worker.mjs) and the handler (src/worker-handler.ts, built as
// lib/worker-handler.mjs). Each file bundles its own copy of this module,
// which holds no state; the intrinsics and byte checks come from
// src/shared.ts (lib/shared.mjs), which both import.
//
// A request names a client method and carries its arguments, encoded so that
// the worker's client validates them as a call on the caller's thread would,
// with the same errors in the same order:
// - a byte argument travels as a fresh copy of its bytes, whose buffer is
//   transferred, never the caller's own; as DETACHED for a Uint8Array on a
//   detached or out-of-bounds buffer, which the worker turns back into such a
//   view; and as null for anything that is not a Uint8Array;
// - a uint32 argument travels as itself when it is a number, and as null
//   otherwise;
// - `options` is read on the calling thread, where any error it causes is
//   thrown, and travels as its allowLargeMessage boolean.
//
// Every request and response carries the nonce of the client that made the
// request, random for each client, so clients that share an endpoint, even
// from different copies of the package, never take each other's responses.
import { isUint8Array, TYPED_ARRAY_INTRINSICS } from './shared'

export const REQUEST = '@qbit-oss/pqc/worker:request'
export const RESPONSE = '@qbit-oss/pqc/worker:response'
export const PROTOCOL_VERSION = 1
export const DETACHED = 'detached'

export type ArgumentKind = 'bytes' | 'uint32' | 'options'

export type MethodName =
  'keygen' | 'derivePQCKey' | 'deriveP2mrDescriptorKey' | 'sign' | 'signWithStats' | 'verify' | 'secretKeyValidate'

// The arguments of each PqcClient method a worker serves, in order. A table
// with no prototype: a method name it lacks, such as 'constructor', finds
// nothing.
export const METHODS: Readonly<Record<MethodName, readonly ArgumentKind[]>> = Object.assign(Object.create(null), {
  keygen: ['bytes'],
  derivePQCKey: ['bytes', 'uint32', 'uint32', 'uint32'],
  deriveP2mrDescriptorKey: ['bytes', 'uint32'],
  sign: ['bytes', 'bytes', 'options'],
  signWithStats: ['bytes', 'bytes', 'options'],
  verify: ['bytes', 'bytes', 'bytes', 'options'],
  secretKeyValidate: ['bytes'],
})

export function isMethodName(method: unknown): method is MethodName {
  return typeof method === 'string' && METHODS[method as MethodName] !== undefined
}

export interface Request {
  type: typeof REQUEST
  version: number
  client: string
  id: number
  method: MethodName
  args: unknown[]
}

export type Response =
  | { type: typeof RESPONSE; client: unknown; id: number; result: unknown }
  | { type: typeof RESPONSE; client: unknown; id: number; error: SerializedError }

/**
 * An error the worker threw, as data that survives structured cloning, which
 * would turn a PqcError into a plain Error and drop its fields. `cause` is the
 * cause of a PqcLoadError: its message, or the string it threw.
 */
export type SerializedError =
  | {
      class: 'PqcLoadError'
      message: string
      url: string | undefined
      status: number | undefined
      cause: { name: string; message: string } | string | undefined
    }
  | {
      class: 'PqcError'
      message: string
      operation: string
      code: number
      kind: string
      stats: unknown
    }
  | { class: 'Error'; name: string; message: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const {
  Uint8Array: IntrinsicUint8Array,
  typedArrayLength,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayByteLength,
  typedArrayValues,
  typedArraySet,
  typedArrayFill,
} = TYPED_ARRAY_INTRINSICS
// Not among the shared intrinsics: only transferList asks whether a buffer is a
// plain ArrayBuffer, and how long it is.
const arrayBufferByteLength = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
) as (buffer: unknown) => number
const { structuredClone: intrinsicStructuredClone } = globalThis

// The test assertAttached in src/shared.ts makes, as a boolean.
function isAttached(view: Uint8Array): boolean {
  try {
    typedArrayValues(view)
    return true
  } catch {
    return false
  }
}

/** A fresh copy of `view`'s bytes, or DETACHED when it no longer addresses its buffer. */
export function copyBytes(view: Uint8Array): Uint8Array | typeof DETACHED {
  if (!isAttached(view)) {
    return DETACHED
  }
  const length = typedArrayLength(view)
  const copy = new IntrinsicUint8Array(length)
  typedArraySet(copy, new IntrinsicUint8Array(typedArrayBuffer(view), typedArrayByteOffset(view), length), 0)
  return copy
}

// A Uint8Array on a detached buffer, which the worker's client rejects as it
// rejects the caller's.
export function detachedBytes(): Uint8Array {
  const view = new IntrinsicUint8Array(0)
  const buffer = typedArrayBuffer(view)
  intrinsicStructuredClone(buffer, { transfer: [buffer as ArrayBuffer] })
  return view
}

/**
 * Overwrites every view in `views` with zeros, going on past one that throws.
 * A detached view has nothing left to zero.
 */
export function zeroAll(views: readonly Uint8Array[]): void {
  for (let i = 0; i < views.length; i += 1) {
    const view = views[i]!
    try {
      if (isAttached(view)) {
        typedArrayFill(view, 0)
      }
    } catch {
      // A view that cannot be zeroed holds no bytes this module can reach.
    }
  }
}

/**
 * The ArrayBuffer to transfer for `view`, when the view spans the whole of a
 * plain ArrayBuffer and so transferring it moves no other bytes; otherwise
 * undefined, and `view` is copied when the message is cloned. The client's
 * own copies and the results PqcClient returns always span their buffer.
 */
function ownBuffer(view: Uint8Array): ArrayBuffer | undefined {
  if (!isAttached(view)) {
    return undefined
  }
  const buffer = typedArrayBuffer(view)
  let bufferLength: number
  try {
    bufferLength = arrayBufferByteLength(buffer)
  } catch {
    // A SharedArrayBuffer, which cannot be transferred.
    return undefined
  }
  return typedArrayByteOffset(view) === 0 && typedArrayByteLength(view) === bufferLength
    ? (buffer as ArrayBuffer)
    : undefined
}

/** The Uint8Arrays of a result: the value itself, or the values of its own enumerable properties. */
export function resultBytes(result: unknown): Uint8Array[] {
  if (isUint8Array(result)) {
    return [result]
  }
  if (!isRecord(result)) {
    return []
  }
  const views: Uint8Array[] = []
  const values = Object.values(result)
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (isUint8Array(value)) {
      views[views.length] = value
    }
  }
  return views
}

/** The distinct buffers of `views` that can be transferred. */
export function transferList(views: readonly Uint8Array[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = []
  for (let i = 0; i < views.length; i += 1) {
    const buffer = ownBuffer(views[i]!)
    if (buffer !== undefined && !buffers.includes(buffer)) {
      buffers[buffers.length] = buffer
    }
  }
  return buffers
}

/** 128 random bits as hex, from the platform's cryptographic generator. */
export function randomNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new IntrinsicUint8Array(16))
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i]! + 0x100).toString(16).slice(1)
  }
  return hex
}

// The shape of a PqcWorkerEndpoint (src/worker.ts) this module relies on.
export interface Endpoint {
  addEventListener?(type: string, listener: (event: any) => void): void
  removeEventListener?(type: string, listener: (event: any) => void): void
  on?(type: string, listener: (value: any) => void): unknown
  off?(type: string, listener: (value: any) => void): unknown
  start?(): void
}

// Whether `endpoint` delivers events through addEventListener, as a Worker or
// MessagePort does, rather than through Node's on(), as a worker_threads
// Worker does.
export function usesEventTarget(endpoint: Endpoint): boolean {
  if (typeof endpoint.addEventListener === 'function') {
    return true
  }
  if (typeof endpoint.on === 'function') {
    return false
  }
  throw new TypeError('endpoint must have an addEventListener or on method')
}

// Listens for each event in `listeners`, with addEventListener when the
// endpoint has it, whose message events carry the message as `data`, and with
// Node's on() otherwise, which passes the message itself. Returns a function
// that stops listening; calling it again does nothing.
export function subscribe(endpoint: Endpoint, listeners: Record<string, (payload: any) => void>): () => void {
  const added: [string, (payload: any) => void][] = []
  const useEvents = usesEventTarget(endpoint)
  for (const [type, listener] of Object.entries(listeners)) {
    const handler = useEvents && type === 'message' ? (event: { data?: unknown }) => listener(event.data) : listener
    if (useEvents) {
      endpoint.addEventListener!(type, handler)
    } else {
      endpoint.on!(type, handler)
    }
    added.push([type, handler])
  }
  endpoint.start?.()
  return () => {
    for (const [type, handler] of added.splice(0)) {
      if (useEvents) {
        endpoint.removeEventListener?.(type, handler)
      } else {
        endpoint.off?.(type, handler)
      }
    }
  }
}
