import { Worker } from 'node:worker_threads'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  constants,
  init,
  PqcError,
  PqcLoadError,
  type PqcClient,
  type PqcSignStats,
  type PqcWasmModuleFactory,
} from '../src/index'
import { createPqcWorkerClient, type PqcWorkerClient, type PqcWorkerEndpoint } from '../src/worker'
import { servePqcWorker, type PqcWorkerHandlerOptions } from '../src/worker-handler'
import { REQUEST, RESPONSE } from '../src/worker-protocol'
import createPqcModule from '../wasm/pqc.mjs'
import { freshClient } from './fresh-client'

// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const ROOT_OFFSET = 48
const MESSAGE = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
// A BIP32 leaf private key below secp256k1's group order.
const LEAF = new Uint8Array(32).map((_, i) => i + 1)

function entropy(seedByte: number): Uint8Array {
  return new Uint8Array(constants.MIN_ENTROPY).map((_, i) => (seedByte + ((i * 53) % 256)) & 0xff)
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[offset] ^= 0x80
  return copy
}

function detached(length: number): Uint8Array {
  const view = new Uint8Array(length)
  structuredClone(view.buffer, { transfer: [view.buffer] })
  return view
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject')
    },
    (reason: unknown) => reason
  )
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

// The fields a PqcError carries, which a rebuilt one must match.
function pqcErrorFields(error: unknown) {
  const { name, message, operation, code, kind, nativeName, stats } = error as PqcError
  return { name, message, operation, code, kind, nativeName, stats }
}

// What createPqcWorkerClient and servePqcWorker run on: the two ends of a
// MessageChannel, closed after each test.
const channels: MessageChannel[] = []
const clients: PqcWorkerClient[] = []

function connect(options: Omit<PqcWorkerHandlerOptions, 'endpoint'> = {}): {
  client: PqcWorkerClient
  handlerPort: MessagePort
  clientPort: MessagePort
} {
  const channel = new MessageChannel()
  channels.push(channel)
  servePqcWorker({ ...options, endpoint: channel.port1 })
  const client = createPqcWorkerClient(channel.port2)
  clients.push(client)
  return { client, handlerPort: channel.port1, clientPort: channel.port2 }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close()
    port2.close()
  }
  vi.restoreAllMocks()
})

// An endpoint a test drives itself: it records what the client posts and
// delivers the messages the test dispatches, as a browser Worker would.
class FakeWorker extends EventTarget {
  // What the client posted, cloned with its transfer list as a real endpoint
  // clones it, and the buffers it listed to transfer.
  readonly sent: { message: any; transfer: ArrayBuffer[] }[] = []

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    this.sent.push({ message: structuredClone(message, { transfer }), transfer })
  }

  deliver(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  // Answers the request sent[index], as the handler does: with the nonce of
  // the client that sent it and its id.
  answer(index: number, fields: { result?: unknown; error?: unknown }): void {
    const { client, id } = this.sent[index]!.message
    this.deliver({ type: RESPONSE, client, id, ...fields })
  }
}

describe('worker client round trips', () => {
  let pqc: PqcClient
  let publicKey: Uint8Array
  let secretKey: Uint8Array
  let signature: Uint8Array

  beforeAll(async () => {
    ;({ client: pqc } = await freshClient())
    ;({ publicKey, secretKey } = pqc.keygen(entropy(0x11)))
    signature = pqc.sign(secretKey, MESSAGE)
  })

  it('return what each PqcClient method returns, and the same constants', async () => {
    const { client } = connect({ client: pqc })

    expect(client.constants).toBe(constants)
    expect(await client.keygen(entropy(0x11))).toEqual({ publicKey, secretKey })
    expect(await client.derivePQCKey(LEAF, 1, 2, 3)).toEqual(pqc.derivePQCKey(LEAF, 1, 2, 3))
    expect(await client.deriveP2mrDescriptorKey(LEAF, 7)).toEqual(pqc.deriveP2mrDescriptorKey(LEAF, 7))
    expect(await client.sign(secretKey, MESSAGE)).toEqual(signature)
    expect(await client.signWithStats(secretKey, MESSAGE)).toEqual(pqc.signWithStats(secretKey, MESSAGE))
    expect(await client.verify(publicKey, MESSAGE, signature)).toBe(true)
    expect(await client.verify(publicKey, MESSAGE, flipByte(signature, 0))).toBe(false)
    expect(await client.verify(publicKey.subarray(1), MESSAGE, signature)).toBe(false)
    expect(await client.secretKeyValidate(secretKey)).toBe(true)
    expect(await client.secretKeyValidate(flipByte(secretKey, ROOT_OFFSET))).toBe(false)
  })

  it("never detach or change the caller's buffers, and return buffers of their own", async () => {
    const { client } = connect({ client: pqc })
    const seed = entropy(0x22)
    const sk = new Uint8Array(secretKey)
    const msg = new Uint8Array(MESSAGE)
    // A view into a larger buffer, which a transfer would take whole.
    const backing = new Uint8Array(64 + publicKey.length)
    backing.set(publicKey, 64)
    const pk = backing.subarray(64)
    const sig = new Uint8Array(signature)

    const pair = await client.keygen(seed)
    const signed = await client.sign(sk, msg)
    expect(await client.verify(pk, msg, sig)).toBe(true)

    expect(seed).toEqual(entropy(0x22))
    expect(sk).toEqual(secretKey)
    expect(msg).toEqual(MESSAGE)
    expect(backing.subarray(64)).toEqual(publicKey)
    expect(sig).toEqual(signature)
    for (const result of [pair.publicKey, pair.secretKey, signed]) {
      expect(result.byteOffset).toBe(0)
      expect(result.buffer.byteLength).toBe(result.length)
    }
  })

  it('pass allowLargeMessage, which the calling thread reads from options, to the worker', async () => {
    const received: unknown[] = []
    const recording = {
      ...pqc,
      verify: (...args: Parameters<PqcClient['verify']>) => {
        received.push(args[3])
        return pqc.verify(...args)
      },
    }
    const { client } = connect({ client: recording })
    const large = new Uint8Array(constants.MAX_MESSAGE_SIZE + 1)

    expect(await client.verify(publicKey, large, signature, { allowLargeMessage: true })).toBe(false)
    expect(await client.verify(publicKey, MESSAGE, signature, { allowLargeMessage: false })).toBe(true)
    expect(await client.verify(publicKey, MESSAGE, signature)).toBe(true)

    expect(received).toEqual([{ allowLargeMessage: true }, undefined, undefined])
  })

  it('give derived keys the publicKey and secretKey aliases, which structured cloning drops', async () => {
    const { client } = connect({ client: pqc })

    for (const derived of [await client.deriveP2mrDescriptorKey(LEAF, 7), await client.derivePQCKey(LEAF, 1, 2, 3)]) {
      expect(Object.keys(derived)).toEqual(['pk32', 'sk64'])
      expect(derived.publicKey).toBe(derived.pk32)
      expect(derived.secretKey).toBe(derived.sk64)
    }
  })

  it('call the methods of a custom client as methods, so they can use this', async () => {
    class Recorder {
      readonly calls: string[] = []
      secretKeyValidate(sk: Uint8Array): boolean {
        this.calls.push('secretKeyValidate')
        return pqc.secretKeyValidate(sk)
      }
    }
    const recorder = new Recorder()
    const { client } = connect({ client: recorder as unknown as PqcClient })

    expect(await client.secretKeyValidate(secretKey)).toBe(true)
    expect(recorder.calls).toEqual(['secretKeyValidate'])
  })

  it('resolve concurrent calls independently', async () => {
    const { client } = connect({ client: pqc })
    const other = pqc.keygen(entropy(0x33))

    const results = await Promise.all([
      client.sign(other.secretKey, MESSAGE),
      client.verify(publicKey, MESSAGE, signature),
      client.keygen(entropy(0x33)),
      client.secretKeyValidate(flipByte(secretKey, ROOT_OFFSET)),
      client.sign(secretKey, MESSAGE),
      client.sign(secretKey.subarray(1), MESSAGE).catch((error: unknown) => error),
    ])

    expect(results[0]).toEqual(pqc.sign(other.secretKey, MESSAGE))
    expect(results[1]).toBe(true)
    expect(results[2]).toEqual(other)
    expect(results[3]).toBe(false)
    expect(results[4]).toEqual(signature)
    expect(results[5]).toBeInstanceOf(RangeError)
  })

  it('settle each call with its own response, in whatever order the worker answers', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    clients.push(client)

    const first = client.verify(publicKey, MESSAGE, signature)
    const second = client.secretKeyValidate(secretKey)
    const third = client.sign(secretKey, MESSAGE)
    const [a, b, c] = worker.sent.map(({ message }) => message.id as number)
    expect(new Set([a, b, c]).size).toBe(3)

    worker.answer(2, { result: signature })
    worker.answer(0, { result: false })
    worker.answer(1, { result: true })

    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(await third).toEqual(signature)
  })

  it('serve messages from an endpoint that carries other messages too, ignoring those', async () => {
    const { client, clientPort } = connect({ client: pqc })
    const response = deferred<unknown>()
    clientPort.addEventListener('message', event => response.resolve(event.data), { once: true })

    clientPort.postMessage({ hello: 'worker' })
    clientPort.postMessage({ type: REQUEST, id: 'not a number' })
    expect(await client.secretKeyValidate(secretKey)).toBe(true)

    expect(await response.promise).toMatchObject({ type: RESPONSE })
  })
})

describe('errors from the worker', () => {
  let pqc: PqcClient
  let secretKey: Uint8Array
  let client: PqcWorkerClient

  beforeAll(async () => {
    ;({ client: pqc } = await freshClient())
    ;({ secretKey } = pqc.keygen(entropy(0x44)))
  })

  it('rebuild a native PqcError with its class and fields: BAD_KEY from sign and signWithStats', async () => {
    ;({ client } = connect({ client: pqc }))
    const badKey = flipByte(secretKey, ROOT_OFFSET)

    for (const method of ['sign', 'signWithStats'] as const) {
      const expected = thrownBy(() => pqc[method](badKey, MESSAGE))
      const rebuilt = await rejectionOf(client[method](badKey, MESSAGE))

      expect(rebuilt).toBeInstanceOf(PqcError)
      expect(rebuilt).not.toBeInstanceOf(PqcLoadError)
      expect(pqcErrorFields(rebuilt)).toEqual(pqcErrorFields(expected))
      expect(rebuilt).toMatchObject({ kind: 'BAD_KEY', operation: method, nativeName: 'BITCOIN_PQC_ERROR_BAD_KEY' })
    }
  })

  it('reject a call whose answer cannot be built, instead of throwing into the event dispatch', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    const pending = rejectionOf(client.deriveP2mrDescriptorKey(LEAF, 0))

    // A derived key that is not an object cannot take its aliases.
    expect(() => worker.answer(0, { result: 42 })).not.toThrow()

    expect(await pending).toBeInstanceOf(TypeError)
  })

  it('rebuild a PqcError or PqcLoadError from another copy of the package by its fields', async () => {
    // As a client built on a second copy of the package throws them: not
    // instances of this copy's classes.
    class ForeignPqcError extends Error {
      override readonly name = 'PqcError'
      readonly operation = 'sign'
      readonly code = constants.ERROR_CODES.BITCOIN_PQC_ERROR_BAD_KEY
      readonly kind = 'BAD_KEY'
      readonly stats = undefined
    }
    class ForeignPqcLoadError extends Error {
      override readonly name = 'PqcLoadError'
      readonly operation = 'init'
      readonly code = 0
      readonly kind = 'LOAD_FAILED'
      readonly url = 'https://example.test/pqc.wasm'
      readonly status = 404
    }
    const foreign = new ForeignPqcError('sign failed with BITCOIN_PQC_ERROR_BAD_KEY (-2)')
    ;({ client } = connect({
      client: {
        ...pqc,
        sign: () => {
          throw foreign
        },
        keygen: () => {
          throw new ForeignPqcLoadError('init() could not load https://example.test/pqc.wasm (HTTP 404)')
        },
      },
    }))

    const bad = await rejectionOf(client.sign(secretKey, MESSAGE))
    expect(bad).toBeInstanceOf(PqcError)
    expect(pqcErrorFields(bad)).toEqual({ ...pqcErrorFields(foreign), nativeName: 'BITCOIN_PQC_ERROR_BAD_KEY' })
    const load = await rejectionOf(client.keygen(entropy(1)))
    expect(load).toBeInstanceOf(PqcLoadError)
    expect(load).toMatchObject({ kind: 'LOAD_FAILED', url: 'https://example.test/pqc.wasm', status: 404 })
  })

  it('rebuild the stats a PqcError carries', async () => {
    const stats: PqcSignStats = {
      forscAttempts: 1,
      forscMaxAttempts: 2,
      wotscAttempts: [3, 4, 5, 6, 7],
      wotscLayerCount: 5,
      wotscMaxAttempts: 8,
      wotscMaxObservedAttempts: 9,
      capExceeded: 1,
    }
    const original = new PqcError('signWithStats', constants.ERROR_CODES.BITCOIN_PQC_ERROR_SIGNING_LIMIT, { stats })
    ;({ client } = connect({
      client: {
        ...pqc,
        signWithStats: () => {
          throw original
        },
      },
    }))

    const rebuilt = await rejectionOf(client.signWithStats(secretKey, MESSAGE))

    expect(rebuilt).toBeInstanceOf(PqcError)
    expect(pqcErrorFields(rebuilt)).toEqual(pqcErrorFields(original))
    expect((rebuilt as PqcError).kind).toBe('SIGNING_LIMIT')
  })

  it('rebuild NOT_INITIALIZED from a worker that serves the named exports before init()', async () => {
    vi.resetModules()
    const fresh = (await import('../src/index')) as typeof import('../src/index')
    const handler = (await import('../src/worker-handler')) as typeof import('../src/worker-handler')
    const workerClient = (await import('../src/worker')) as typeof import('../src/worker')
    const channel = new MessageChannel()
    channels.push(channel)
    handler.servePqcWorker({ endpoint: channel.port1 })
    client = workerClient.createPqcWorkerClient(channel.port2)
    clients.push(client)

    const expected = thrownBy(() => fresh.sign(secretKey, MESSAGE))
    const rebuilt = await rejectionOf(client.sign(secretKey, MESSAGE))

    expect(rebuilt).toBeInstanceOf(fresh.PqcError)
    expect(pqcErrorFields(rebuilt)).toEqual(pqcErrorFields(expected))
    expect(rebuilt).toMatchObject({ kind: 'NOT_INITIALIZED', code: 0, nativeName: undefined })

    // Once init() in the worker publishes a client, the same handler uses it.
    await fresh.init({ createModule: options => createPqcModule(options) })
    expect(await client.secretKeyValidate(secretKey)).toBe(true)
  })

  it('read options on the calling side first: invalid options throw before NOT_INITIALIZED', async () => {
    vi.resetModules()
    const fresh = (await import('../src/index')) as typeof import('../src/index')
    const handler = (await import('../src/worker-handler')) as typeof import('../src/worker-handler')
    const workerClient = (await import('../src/worker')) as typeof import('../src/worker')
    const channel = new MessageChannel()
    channels.push(channel)
    handler.servePqcWorker({ endpoint: channel.port1 })
    client = workerClient.createPqcWorkerClient(channel.port2)
    clients.push(client)
    const badOptions = { allowLargeMessage: 'yes' } as never

    // A direct call finds no client before it reads options; the worker client
    // reads them before it sends the request (docs/worker.md).
    expect(thrownBy(() => fresh.sign(secretKey, MESSAGE, badOptions))).toMatchObject({ kind: 'NOT_INITIALIZED' })
    const rebuilt = await rejectionOf(client.sign(secretKey, MESSAGE, badOptions))
    expect(rebuilt).toBeInstanceOf(TypeError)
    expect((rebuilt as Error).message).toBe('options.allowLargeMessage must be a boolean')
  })

  it('rebuild LOAD_FAILED, with url, status and cause, for every request when the load fails', async () => {
    const failingFactory: PqcWasmModuleFactory = () => Promise.reject(new TypeError('no module'))
    const load = init({ createModule: failingFactory })
    ;({ client } = connect({ client: load }))
    const expected = await rejectionOf(load)

    for (const call of [client.sign(secretKey, MESSAGE), client.secretKeyValidate(secretKey)]) {
      const rebuilt = await rejectionOf(call)
      expect(rebuilt).toBeInstanceOf(PqcLoadError)
      expect(rebuilt).toBeInstanceOf(PqcError)
      const { url, status } = rebuilt as PqcLoadError
      expect({ ...pqcErrorFields(rebuilt), url, status }).toEqual({
        ...pqcErrorFields(expected),
        url: undefined,
        status: undefined,
      })
      expect((rebuilt as PqcLoadError).cause).toEqual(new TypeError('no module'))
      expect((rebuilt as PqcLoadError).cause).toBeInstanceOf(TypeError)
    }

    const fetchFailure = new PqcLoadError('https://example.test/pqc.wasm', 404, { cause: 'HTTP 404' })
    ;({ client } = connect({ client: Promise.reject(fetchFailure) }))
    const rebuilt = await rejectionOf(client.keygen(entropy(1)))
    expect(rebuilt).toBeInstanceOf(PqcLoadError)
    expect(rebuilt).toMatchObject({
      kind: 'LOAD_FAILED',
      url: 'https://example.test/pqc.wasm',
      status: 404,
      cause: 'HTTP 404',
      message: fetchFailure.message,
    })
  })

  it('keep the type and message of a TypeError or RangeError, in the order a call on this thread throws them', async () => {
    ;({ client } = connect({ client: pqc }))
    const getter = {
      get allowLargeMessage() {
        return true
      },
    }
    const calls: [string, (target: PqcClient | PqcWorkerClient) => unknown][] = [
      ['short sk', target => target.sign(secretKey.subarray(1), MESSAGE)],
      ['sk not a Uint8Array', target => target.sign([...secretKey] as unknown as Uint8Array, MESSAGE)],
      ['sk a function', target => target.sign((() => 0) as unknown as Uint8Array, MESSAGE)],
      ['detached msg after a short sk', target => target.sign(secretKey.subarray(1), detached(32))],
      ['detached sk', target => target.secretKeyValidate(detached(64))],
      ['oversized msg', target => target.sign(secretKey, new Uint8Array(constants.MAX_MESSAGE_SIZE + 1))],
      ['options with a getter', target => target.sign(secretKey, MESSAGE, getter)],
      ['options of a class', target => target.verify(secretKey, MESSAGE, MESSAGE, new (class {})() as never)],
      ['options with a symbol key', target => target.verify(secretKey, MESSAGE, MESSAGE, { [Symbol()]: 1 } as never)],
      ['options before a bad sk', target => target.sign(detached(64), MESSAGE, 'yes' as never)],
      ['short entropy', target => target.keygen(new Uint8Array(1))],
      ['empty seed before a bad index', target => target.derivePQCKey(new Uint8Array(0), 'x' as never, 0, 0)],
      ['index not a number', target => target.derivePQCKey(LEAF, 0, 0, '1' as never)],
      ['index too large', target => target.deriveP2mrDescriptorKey(LEAF, 0x80000000)],
      ['leaf of zeros', target => target.deriveP2mrDescriptorKey(new Uint8Array(32), 0)],
    ]

    for (const [label, call] of calls) {
      const expected = thrownBy(() => call(pqc)) as Error
      const rebuilt = (await rejectionOf(call(client) as Promise<unknown>)) as Error
      expect(rebuilt.constructor, label).toBe(expected.constructor)
      expect([rebuilt.name, rebuilt.message], label).toEqual([expected.name, expected.message])
      expect([TypeError, RangeError], label).toContain(rebuilt.constructor)
    }
  })

  it('reject a request from another protocol version, naming both', async () => {
    const { clientPort } = connect({ client: pqc })
    const response = deferred<any>()
    clientPort.addEventListener('message', event => response.resolve(event.data), { once: true })

    clientPort.postMessage({ type: REQUEST, version: 99, id: 1, method: 'secretKeyValidate', args: [secretKey] })

    expect((await response.promise).error).toMatchObject({ class: 'Error', message: expect.stringContaining('99') })
  })
})

describe('the copies the worker holds', () => {
  let pqc: PqcClient
  let secretKey: Uint8Array

  beforeAll(async () => {
    ;({ client: pqc } = await freshClient())
    ;({ secretKey } = pqc.keygen(entropy(0x55)))
  })

  // A client that records the arguments the worker passes it and the results
  // it returns there.
  function recording(fail = false) {
    const args: unknown[][] = []
    const results: unknown[] = []
    const record =
      <A extends unknown[]>(run: (...args: A) => unknown) =>
      (...callArgs: A) => {
        args.push(callArgs)
        if (fail) throw new RangeError('refused')
        const result = run(...callArgs)
        results.push(result)
        return result
      }
    const client = {
      ...pqc,
      keygen: record(pqc.keygen),
      derivePQCKey: record(pqc.derivePQCKey),
      sign: record(pqc.sign),
      signWithStats: record(pqc.signWithStats),
    } as PqcClient
    return { client, args, results }
  }

  function bytesIn(values: unknown[]): Uint8Array[] {
    return values.flatMap(value =>
      value instanceof Uint8Array
        ? [value]
        : typeof value === 'object' && value !== null
          ? Object.values(value).filter(item => item instanceof Uint8Array)
          : []
    )
  }

  it('zeroes its copies of the byte arguments, and transfers the results it returns away', async () => {
    const worker = recording()
    const { client } = connect({ client: worker.client })

    await client.keygen(entropy(0x66))
    await client.derivePQCKey(LEAF, 0, 0, 1)
    await client.signWithStats(secretKey, MESSAGE)

    const inputs = bytesIn(worker.args.flat())
    expect(inputs.length).toBe(4)
    for (const input of inputs) {
      expect(input.length).toBeGreaterThan(0)
      expect(input.every(byte => byte === 0)).toBe(true)
    }
    const outputs = bytesIn(worker.results)
    expect(outputs.length).toBe(5)
    for (const output of outputs) {
      // Transferred: the worker's view no longer has any bytes.
      expect(output.byteLength).toBe(0)
    }
  })

  it('zeroes its copies when the call throws', async () => {
    const worker = recording(true)
    const { client } = connect({ client: worker.client })

    expect(await rejectionOf(client.sign(secretKey, MESSAGE))).toBeInstanceOf(RangeError)

    const inputs = bytesIn(worker.args.flat())
    expect(inputs.length).toBe(2)
    for (const input of inputs) {
      expect(input.every(byte => byte === 0)).toBe(true)
    }
  })

  it('zeroes the results and reports the error when it cannot send them', async () => {
    const worker = recording()
    const channel = new MessageChannel()
    channels.push(channel)
    let refuse = true
    const endpoint: PqcWorkerEndpoint = {
      postMessage(message, transfer) {
        if (refuse) {
          refuse = false
          throw new DOMException('could not clone the result', 'DataCloneError')
        }
        channel.port1.postMessage(message, transfer)
      },
      addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
      start: () => channel.port1.start(),
    }
    servePqcWorker({ client: worker.client, endpoint })
    const client = createPqcWorkerClient(channel.port2)
    clients.push(client)

    const error = await rejectionOf(client.keygen(entropy(0x77)))

    expect(error).toMatchObject({ name: 'DataCloneError', message: 'could not clone the result' })
    const outputs = bytesIn(worker.results)
    expect(outputs.length).toBe(2)
    for (const output of outputs) {
      expect(output.length).toBeGreaterThan(0)
      expect(output.every(byte => byte === 0)).toBe(true)
    }
  })

  it('posts the client its own copies, transferred, and zeroes them when posting fails', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    const sk = new Uint8Array(secretKey)

    const pending = rejectionOf(client.sign(sk, MESSAGE))
    const [{ message, transfer }] = worker.sent
    expect(message.args[0]).toEqual(sk)
    expect(message.args[1]).toEqual(MESSAGE)
    // The client's own copies, which posting moved away.
    expect(transfer.map(buffer => buffer.byteLength)).toEqual([0, 0])

    const copies: Uint8Array[] = []
    const failing = createPqcWorkerClient({
      postMessage(request: any) {
        copies.push(...request.args.filter((arg: unknown) => arg instanceof Uint8Array))
        throw new Error('the worker is gone')
      },
      addEventListener() {},
    })
    expect(await rejectionOf(failing.sign(sk, MESSAGE))).toEqual(new Error('the worker is gone'))
    expect(copies.length).toBe(2)
    for (const copy of copies) {
      expect(copy.every(byte => byte === 0)).toBe(true)
    }
    expect(sk).toEqual(secretKey)
    client.close()
    await pending
  })

  it('zeroes its copies after posting, should the endpoint clone rather than transfer them', async () => {
    const posted: unknown[] = []
    const listed: ArrayBuffer[] = []
    const client = createPqcWorkerClient({
      postMessage(message, transfer) {
        posted.push(structuredClone(message))
        listed.push(...transfer)
      },
      addEventListener() {},
    })
    void client.sign(new Uint8Array(secretKey), MESSAGE).catch(() => undefined)

    expect((posted[0] as any).args[0]).toEqual(secretKey)
    expect(listed.length).toBe(2)
    for (const buffer of listed) {
      expect(new Uint8Array(buffer).every(byte => byte === 0)).toBe(true)
    }
    client.close({ force: true })
  })

  it('zeroes the results it sent, should the endpoint clone rather than transfer them', async () => {
    const worker = recording()
    const channel = new MessageChannel()
    channels.push(channel)
    const endpoint: PqcWorkerEndpoint = {
      // Clones, ignoring the transfer list.
      postMessage: message => channel.port1.postMessage(message),
      addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
      start: () => channel.port1.start(),
    }
    servePqcWorker({ client: worker.client, endpoint })
    const client = createPqcWorkerClient(channel.port2)
    clients.push(client)

    const pair = await client.keygen(entropy(0x77))

    expect(pair).toEqual(pqc.keygen(entropy(0x77)))
    const outputs = bytesIn(worker.results)
    expect(outputs.length).toBe(2)
    for (const output of outputs) {
      expect(output.length).toBeGreaterThan(0)
      expect(output.every(byte => byte === 0)).toBe(true)
    }
  })

  it('zeroes the byte arguments of every request waiting for a load that fails', async () => {
    const load = deferred<PqcClient>()
    const rejected = (async () => {
      await load.promise
      throw new PqcLoadError(undefined, undefined, { cause: new Error('no module') })
    })()
    const channel = new MessageChannel()
    channels.push(channel)
    const received: Uint8Array[] = []
    const endpoint: PqcWorkerEndpoint = {
      postMessage: (message, transfer) => channel.port1.postMessage(message, transfer),
      addEventListener: (type, listener) =>
        channel.port1.addEventListener(type, event => {
          for (const arg of (event as MessageEvent).data?.args ?? []) {
            if (arg instanceof Uint8Array) received.push(arg)
          }
          listener(event)
        }),
      start: () => channel.port1.start(),
    }
    servePqcWorker({ client: rejected, endpoint })
    const client = createPqcWorkerClient(channel.port2)
    clients.push(client)

    const calls = [client.sign(secretKey, MESSAGE), client.keygen(entropy(1))].map(rejectionOf)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received.length).toBe(3)
    expect(received.some(view => view.some(byte => byte !== 0))).toBe(true)
    load.resolve(pqc)

    for (const error of await Promise.all(calls)) {
      expect(error).toBeInstanceOf(PqcLoadError)
    }
    for (const view of received) {
      expect(view.every(byte => byte === 0)).toBe(true)
    }
  })

  it('zeroes the answers to calls close() rejected, then stops listening', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    const pending = [client.keygen(entropy(1)), client.sign(secretKey, MESSAGE)].map(rejectionOf)
    const removed = vi.spyOn(worker, 'removeEventListener')
    client.close()
    await Promise.all(pending)
    expect(removed).not.toHaveBeenCalled()

    const pair = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(secretKey) }
    worker.answer(0, { result: pair })
    expect(pair.publicKey.every(byte => byte === 0)).toBe(true)
    expect(pair.secretKey.every(byte => byte === 0)).toBe(true)
    expect(removed).not.toHaveBeenCalled()

    const signature = new Uint8Array(constants.SIG_SIZE).fill(2)
    worker.answer(1, { result: signature })
    expect(signature.every(byte => byte === 0)).toBe(true)
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(['close', 'error', 'message', 'messageerror'])

    // Once it stopped listening, later messages are not its own.
    const later = new Uint8Array(secretKey)
    worker.answer(1, { result: later })
    expect(later).toEqual(secretKey)
  })

  it('zeroes the answers to abandoned calls even after an error event, which leaves it listening', async () => {
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const client = createPqcWorkerClient(worker, { onError: event => errors.push(event) })
    const pending = rejectionOf(client.keygen(entropy(1)))
    client.close()
    await pending

    const error = new Event('error')
    worker.dispatchEvent(error)
    const pair = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(secretKey) }
    worker.answer(0, { result: pair })

    expect(errors).toEqual([error])
    expect(pair.secretKey.every(byte => byte === 0)).toBe(true)
  })

  it('a second close(), or close({ force: true }), stops listening at once', async () => {
    const closes: [string, (client: PqcWorkerClient) => void][] = [
      ['close() twice', client => (client.close(), client.close())],
      ['close({ force: true })', client => client.close({ force: true })],
    ]
    for (const [label, close] of closes) {
      const worker = new FakeWorker()
      const client = createPqcWorkerClient(worker)
      const pending = rejectionOf(client.sign(secretKey, MESSAGE))
      const removed = vi.spyOn(worker, 'removeEventListener')
      close(client)
      await pending

      expect(removed.mock.calls.length, label).toBe(4)
    }
  })

  it("leaves another client's results on the same endpoint alone", async () => {
    const channel = new MessageChannel()
    channels.push(channel)
    servePqcWorker({ client: pqc, endpoint: channel.port1 })
    const first = createPqcWorkerClient(channel.port2)
    const second = createPqcWorkerClient(channel.port2)
    clients.push(first, second)

    const [one, two] = await Promise.all([first.keygen(entropy(0x88)), second.keygen(entropy(0x99))])

    expect(one).toEqual(pqc.keygen(entropy(0x88)))
    expect(two).toEqual(pqc.keygen(entropy(0x99)))
  })
})

describe('clients that share an endpoint', () => {
  let pqc: PqcClient

  beforeAll(async () => {
    ;({ client: pqc } = await freshClient())
  })

  it('take only their own responses, even from separate copies of the package with the same request ids', async () => {
    const channel = new MessageChannel()
    channels.push(channel)
    servePqcWorker({ client: pqc, endpoint: channel.port1 })
    // Two copies of the client module, as two bundles of the package would
    // load: each numbers its requests from 1.
    vi.resetModules()
    const first = (await import('../src/worker')).createPqcWorkerClient(channel.port2)
    vi.resetModules()
    const second = (await import('../src/worker')).createPqcWorkerClient(channel.port2)
    clients.push(first, second)

    const [one, two] = await Promise.all([first.keygen(entropy(0x88)), second.keygen(entropy(0x99))])

    expect(one).toEqual(pqc.keygen(entropy(0x88)))
    expect(two).toEqual(pqc.keygen(entropy(0x99)))
  })

  it('never settle a call with a response that carries its id but another client nonce', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    const pending = client.secretKeyValidate(new Uint8Array(64))
    const { client: nonce, id } = worker.sent[0]!.message

    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    const foreign = new Uint8Array(64).fill(7)
    worker.deliver({ type: RESPONSE, client: 'another client', id, result: foreign })
    worker.deliver({ type: RESPONSE, id, result: false })
    worker.answer(0, { result: true })

    expect(await pending).toBe(true)
    // Another client's result is left as it arrived, for that client to read.
    expect(foreign.every(byte => byte === 7)).toBe(true)
  })

  it('zero an answer with their own nonce that no call waits for, such as a second answer', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    const pending = client.sign(new Uint8Array(64), MESSAGE)
    worker.answer(0, { result: new Uint8Array(constants.SIG_SIZE).fill(1) })
    await pending

    const again = new Uint8Array(constants.SIG_SIZE).fill(2)
    worker.answer(0, { result: again })
    const unknown = { pk32: new Uint8Array(32).fill(3), sk64: new Uint8Array(64).fill(4) }
    worker.deliver({ type: RESPONSE, client: worker.sent[0]!.message.client, id: 999, result: unknown })

    expect(again.every(byte => byte === 0)).toBe(true)
    expect(unknown.sk64.every(byte => byte === 0)).toBe(true)
  })
})

describe('a closed or failed worker', () => {
  const workers: Worker[] = []

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.terminate()))
  })

  // A worker_threads worker running `source`, which a client talks to through
  // Node's Worker, with on() rather than addEventListener.
  function nodeWorker(source: string): Worker {
    const worker = new Worker(source, { eval: true })
    workers.push(worker)
    return worker
  }

  function expectClosed(error: unknown, reason: RegExp): void {
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'PqcWorkerClosedError', message: expect.stringMatching(reason) })
  }

  it('rejects pending and later calls when the worker is terminated', async () => {
    const worker = nodeWorker("require('node:worker_threads').parentPort.on('message', () => {})")
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    const pending = Promise.all(
      [client.sign(new Uint8Array(64), MESSAGE), client.verify(LEAF, MESSAGE, MESSAGE)].map(rejectionOf)
    )

    await worker.terminate()

    for (const error of await pending) {
      expectClosed(error, /the worker exited with code \d+$/)
    }
    expectClosed(await rejectionOf(client.secretKeyValidate(new Uint8Array(64))), /exited/)
  })

  it("rejects pending calls when a crashed worker exits, adding no listener for the Worker's error event", async () => {
    const worker = nodeWorker(
      "require('node:worker_threads').parentPort.on('message', () => { throw new Error('worker crashed') })"
    )
    // The app's own listener: without one, Node treats the error as uncaught,
    // as it would without the client.
    const crashes: unknown[] = []
    worker.on('error', error => crashes.push(error))
    const client = createPqcWorkerClient(worker)
    clients.push(client)
    expect(worker.listenerCount('error')).toBe(1)

    const error = await rejectionOf(client.keygen(entropy(1)))

    expectClosed(error, /the worker exited with code 1$/)
    expect(crashes).toMatchObject([{ message: 'worker crashed' }])
  })

  it("passes a browser Worker's error event to onError and stays open, settling calls the worker answers", async () => {
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const client = createPqcWorkerClient(worker, { onError: event => errors.push(event) })
    clients.push(client)
    const pending = client.secretKeyValidate(new Uint8Array(64))

    const error = new Event('error')
    const messageError = new MessageEvent('messageerror')
    worker.dispatchEvent(error)
    worker.dispatchEvent(messageError)
    worker.answer(0, { result: true })

    expect(errors).toEqual([error, messageError])
    expect(await pending).toBe(true)
    void client.verify(LEAF, MESSAGE, MESSAGE).catch(() => undefined)
    expect(worker.sent.length).toBe(2)
  })

  it('rejects pending calls when the other end of a MessagePort closes', async () => {
    const channel = new MessageChannel()
    channels.push(channel)
    const client = createPqcWorkerClient(channel.port2)
    clients.push(client)
    const pending = client.keygen(entropy(1))

    channel.port1.close()

    expectClosed(await rejectionOf(pending), /endpoint was closed/)
  })

  it('close() rejects pending and later calls without posting them, and stops listening', async () => {
    const worker = new FakeWorker()
    const client = createPqcWorkerClient(worker)
    const pending = client.sign(new Uint8Array(64), MESSAGE)
    const removed = vi.spyOn(worker, 'removeEventListener')

    client.close()
    client.close()

    expectClosed(await rejectionOf(pending), /close\(\) was called/)
    expectClosed(await rejectionOf(client.verify(LEAF, MESSAGE, MESSAGE)), /close\(\)/)
    expect(worker.sent.length).toBe(1)
    // The second close() stopped waiting for the answer to the call it rejected.
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(['close', 'error', 'message', 'messageerror'])
  })

  it('close() with no call pending stops listening at once', () => {
    const worker = new FakeWorker()
    const removed = vi.spyOn(worker, 'removeEventListener')

    createPqcWorkerClient(worker).close()

    expect(removed.mock.calls.length).toBe(4)
  })
})

describe('the ./worker entry', () => {
  it('exports the error classes and constants every entry exports, so instanceof works', async () => {
    const worker = await import('../src/worker')
    const main = await import('../src/index')

    expect(worker.PqcError).toBe(main.PqcError)
    expect(worker.PqcLoadError).toBe(main.PqcLoadError)
    expect(worker.errorCodes).toBe(main.errorCodes)
    expect(worker.constants).toBe(main.constants)
  })
})

describe('endpoints', () => {
  it('a client needs postMessage and addEventListener or on', () => {
    expect(() => createPqcWorkerClient({} as PqcWorkerEndpoint)).toThrow(TypeError)
    expect(() => createPqcWorkerClient({ postMessage() {} })).toThrow(
      'endpoint must have an addEventListener or on method'
    )
  })

  it('servePqcWorker() needs an endpoint outside a dedicated worker', () => {
    expect(() => servePqcWorker()).toThrow('servePqcWorker() needs an endpoint outside a dedicated worker')
  })

  it('the client is frozen', () => {
    const client = createPqcWorkerClient(new FakeWorker())
    clients.push(client)
    expect(Object.isFrozen(client)).toBe(true)
  })
})
