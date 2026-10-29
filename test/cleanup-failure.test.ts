import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  errorCodes,
  init,
  PqcError,
  type PqcClient,
  type PqcKeyPair,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// Regression coverage for cleanup that throws. Every public call zeroes its
// wasm allocations, then frees them, in a finally block, and zero() writes
// through module.HEAPU8. A module from a custom factory that copied HEAPU8
// once still holds a view on the old buffer after wasm memory grows, and
// writing through that view throws a TypeError. The first zero() to throw
// skipped every zero() and free() after it, leaking those allocations, and
// its TypeError replaced the call's own error: a native failure, or the
// TypeError for an input detached during the call. Each test grows wasm
// memory from inside a public call on such a module, then checks which error
// the call throws and that it freed everything it allocated. All key material
// is synthetic.

// Four times the 16 MiB a fresh instance starts with, so allocating it grows
// wasm memory.
const GROW_BYTES = 64 * 1024 * 1024
const DETACHED_ERROR = /must not be a view on a detached or out-of-bounds ArrayBuffer/
const MESSAGE = new TextEncoder().encode('qbit-pqc-cleanup-failure')
const OUT_OF_MEMORY = errorCodes.BITCOIN_PQC_ERROR_OUT_OF_MEMORY

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 71) % 256)) & 0xff
  }
  return entropy
}

function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

function messageOf(run: () => unknown): string {
  return (thrown(run) as Error).message
}

interface StaleHeap {
  client: PqcClient
  module: PqcWasmModule
  // Pointers the wrapper allocated and has not freed.
  live: Set<number>
  // Grows wasm memory, after which module.HEAPU8 views the detached old buffer.
  grow(): void
}

// A client on a module whose HEAPU8 is an own data property, copied once from
// the real module. The glue replaces the real module's HEAPU8 when memory
// grows, never this one.
async function staleHeapClient(): Promise<StaleHeap> {
  const { module: real } = await freshClient()
  const module = Object.create(real) as PqcWasmModule
  Object.defineProperty(module, 'HEAPU8', { value: real.HEAPU8, writable: true })
  const live = new Set<number>()
  module._malloc = byteLength => {
    const ptr = real._malloc(byteLength)
    if (ptr !== 0) {
      live.add(ptr)
    }
    return ptr
  }
  module._free = ptr => {
    live.delete(ptr)
    real._free(ptr)
  }
  return {
    client: await init({ createModule: async () => module }),
    module,
    live,
    grow: () => real._free(real._malloc(GROW_BYTES)),
  }
}

// The message zero() throws once module.HEAPU8 is stale.
function staleFillMessage(module: PqcWasmModule): string {
  return messageOf(() => module.HEAPU8.fill(0, 0, 1))
}

describe('a zero() that throws during cleanup', () => {
  const entropy = syntheticEntropy(0x2b)
  const masterSeed = syntheticEntropy(0x2c).subarray(0, 32)
  let pair: PqcKeyPair
  let signature: Uint8Array

  beforeAll(async () => {
    const reference = await init()
    pair = reference.keygen(entropy)
    signature = reference.sign(pair.secretKey, MESSAGE)
  })

  function expectStaleAndFreed(heap: StaleHeap): void {
    // Control: memory grew, so the module's HEAPU8 is a view on a detached buffer.
    expect(heap.module.HEAPU8.byteLength).toBe(0)
    expect([...heap.live]).toEqual([])
  }

  // Each native call grows memory, then fails as an out-of-memory native
  // allocation would.
  const nativeFailures: Array<{
    name: string
    fail: (module: PqcWasmModule, native: () => number) => void
    call: (client: PqcClient) => unknown
  }> = [
    {
      name: 'keygen',
      fail: (module, native) => {
        module._qbit_pqc_keygen = native
      },
      call: client => client.keygen(entropy),
    },
    {
      name: 'derivePQCKey',
      fail: (module, native) => {
        module._qbit_pqc_keygen = native
      },
      call: client => client.derivePQCKey(masterSeed, 0, 0, 0),
    },
    {
      name: 'sign',
      fail: (module, native) => {
        module._qbit_pqc_sign = native
      },
      call: client => client.sign(pair.secretKey, MESSAGE),
    },
    {
      name: 'verify',
      fail: (module, native) => {
        module._qbit_pqc_verify = native
      },
      call: client => client.verify(pair.publicKey, MESSAGE, signature),
    },
    {
      name: 'secretKeyValidate',
      fail: (module, native) => {
        module._qbit_pqc_secret_key_validate = native
      },
      call: client => client.secretKeyValidate(pair.secretKey),
    },
  ]

  it.each(nativeFailures)('$name frees everything and throws the native error', async ({ fail, call }) => {
    const heap = await staleHeapClient()
    fail(heap.module, () => {
      heap.grow()
      return OUT_OF_MEMORY
    })

    const error = thrown(() => call(heap.client))

    expectStaleAndFreed(heap)
    expect(error).toBeInstanceOf(PqcError)
    expect((error as PqcError).kind).toBe('OUT_OF_MEMORY')
  })

  it('signWithStats frees everything and throws the error from reading its stats', async () => {
    const heap = await staleHeapClient()
    heap.module._qbit_pqc_sign_with_stats = () => {
      heap.grow()
      return OUT_OF_MEMORY
    }

    const error = thrown(() => heap.client.signWithStats(pair.secretKey, MESSAGE))

    expectStaleAndFreed(heap)
    // The stats are read through the stale view before the native result is
    // checked, so that read fails first.
    const stale = heap.module.HEAPU8.buffer
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(messageOf(() => new Uint8Array(stale, 0, 1)))
    expect((error as TypeError).message).not.toBe(staleFillMessage(heap.module))
  })

  it('verify frees everything, then throws the zeroing error, when the call itself succeeded', async () => {
    const heap = await staleHeapClient()
    const verify = heap.module._qbit_pqc_verify
    heap.module._qbit_pqc_verify = (...args) => {
      const rc = verify(...args)
      heap.grow()
      return rc
    }

    const error = thrown(() => heap.client.verify(pair.publicKey, MESSAGE, signature))

    expectStaleAndFreed(heap)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(staleFillMessage(heap.module))
  })

  it('sign reports msg detached during the call, not the zeroing error', async () => {
    const heap = await staleHeapClient()
    const msg = MESSAGE.slice()
    const malloc = heap.module._malloc
    let mallocs = 0
    heap.module._malloc = byteLength => {
      mallocs += 1
      // sk has been copied in, and this allocation is msg's.
      if (mallocs === 2) {
        structuredClone(msg.buffer, { transfer: [msg.buffer] })
        heap.grow()
      }
      return malloc(byteLength)
    }

    const error = thrown(() => heap.client.sign(pair.secretKey, msg))

    expect(msg.length).toBe(0)
    expectStaleAndFreed(heap)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toMatch(DETACHED_ERROR)
  })

  it('sign rethrows the failed copy into the stale heap, not the zeroing error', async () => {
    const heap = await staleHeapClient()
    const malloc = heap.module._malloc
    heap.module._malloc = byteLength => {
      heap.grow()
      return malloc(byteLength)
    }

    const error = thrown(() => heap.client.sign(pair.secretKey, MESSAGE))

    expectStaleAndFreed(heap)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(messageOf(() => heap.module.HEAPU8.set(new Uint8Array(1), 0)))
    expect((error as TypeError).message).not.toBe(staleFillMessage(heap.module))
  })
})
