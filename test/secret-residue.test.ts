import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  PqcError,
  type PqcClient,
  type PqcDerivedKeyPair,
  type PqcKeyPair,
  type PqcWasmModule,
} from '../src/index'
import { freshClient } from './fresh-client'

// Secret residue in WASM linear memory after each public operation, on its
// success and error paths. Every call runs on a fresh module, so whatever is
// left behind can only come from that call. All key material is synthetic and
// derived from fixed test entropy.
//
// Memory: before and after the call, all of linear memory is searched for
// every FRAGMENT_BYTES-byte window of each secret the call handles: SK_SEED,
// SK_PRF, the keygen entropy (the caller's, or the entropy derivePQCKey
// derives), derivePQCKey's master seed, and the seed native signing derives
// from the key and message. Windows rather than whole values, because freeing
// an unwiped buffer overwrites its first 8 bytes with the allocator's
// free-list links, which hides a 16-byte secret from a search for all of it
// (see the control below). Shorter windows would start to match by chance.
//
// Stack: the native entry points that take a secret (keygen, sign,
// signWithStats and secretKeyValidate) zero BITCOIN_PQC_BURN_STACK_BYTES
// (4 KiB under Emscripten) of the stack below their frame before returning.
// That wipes the frames the call released only if none reached further down.
// A deeper frame, after an emsdk bump say, leaves hash state or PRF outputs
// below the burn, which no byte search can recognise. So the free stack is
// painted before the call, and afterwards the deepest byte that is no longer
// paint shows how deep the call wrote (paint-and-diff). A call that reached
// one of those entry points must have:
//  - written at least BURN_STACK_BYTES deep, so the burn ran at full size;
//  - written at most OUTER_FRAMES_BYTES deeper than that. The burn sits below
//    the export's and the library's outer frames (16 to 224 bytes with emsdk
//    4.0.10), so anything deeper is a frame that outran the burn;
//  - left non-zero bytes only within AFTER_BURN_BYTES of the top. After the
//    burn only those outer frames run, plus, in sign, the check of the new
//    signature against the public key (under 1 KiB).
// The burn hides how deep the work itself goes. In a build with a 16-byte
// burn, keygen, sign and secretKeyValidate write 1680, 1696 and 1536 bytes
// deep (emsdk 4.0.10, -O3), so the burn covers today's frames with about
// 2.5 KiB to spare.

// SLH-DSA-SHA2-128s secret key layout: [SK_SEED || SK_PRF || PUB_SEED || root]
const SPX_N = 16
const MESSAGE = new Uint8Array([0x71, 0x62, 0x69, 0x74, 0x2d, 0x70, 0x71, 0x63])
const HKDF_SALT = Buffer.from('qbit-sphincs-v1', 'utf8')
const HKDF_INFO_PREFIX = Buffer.from('qbit/sphincs+/1', 'utf8')
const UINT32_MAX = 0xffffffff

const FRAGMENT_BYTES = 8
// BITCOIN_PQC_BURN_STACK_BYTES under __EMSCRIPTEN__ in
// vendor/libbitcoinpqc-qbit/src/secure_zero.h.
const BURN_STACK_BYTES = 4096
const OUTER_FRAMES_BYTES = 512
const AFTER_BURN_BYTES = 2048
// Emscripten's default stack is 64 KiB, so its top 16 KiB is free stack.
const PAINT_BYTES = 16 * 1024
const STACK_PAINT = 0xa5
const WASM_GLOBAL_SECTION = 6

type Secrets = Record<string, Uint8Array>
type StackCheck = 'burned' | 'untouched' | 'unchecked'

interface StackUse {
  // How far below the stack top the call wrote.
  written: number
  // How far below the stack top the deepest non-zero byte it left lies.
  nonZero: number
}

interface Probe {
  value?: unknown
  error?: unknown
  stack: StackUse
}

function syntheticEntropy(seedByte: number): Uint8Array {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 151) % 256)) & 0xff
  }
  return entropy
}

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[offset] ^= 0x80
  return copy
}

function keyMaterial(secretKey: Uint8Array): { SK_SEED: Uint8Array; SK_PRF: Uint8Array } {
  return {
    SK_SEED: secretKey.slice(0, SPX_N),
    SK_PRF: secretKey.slice(SPX_N, 2 * SPX_N),
  }
}

function hkdfEntropy(masterSeed: Uint8Array, account: number, change: number, index: number): Uint8Array {
  const info = Buffer.alloc(HKDF_INFO_PREFIX.length + 12)
  HKDF_INFO_PREFIX.copy(info)
  info.writeUInt32LE(account, HKDF_INFO_PREFIX.length)
  info.writeUInt32LE(change, HKDF_INFO_PREFIX.length + 4)
  info.writeUInt32LE(index, HKDF_INFO_PREFIX.length + 8)
  return new Uint8Array(hkdfSync('sha256', masterSeed, HKDF_SALT, info, constants.MIN_ENTROPY))
}

// The seed native signing derives from the key and message
// (slh_dsa_derandomize in vendor/libbitcoinpqc-qbit/src/slh_dsa/utils.c):
// SHA-256(sk || msg), then SHA-256 of that digest and 0x01. SPHINCS+ takes
// its first SPX_N bytes as optrand.
function signingSeed(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const first = createHash('sha256').update(secretKey).update(message).digest()
  const second = createHash('sha256').update(first).update(Buffer.of(1)).digest()
  return new Uint8Array(Buffer.concat([first, second]))
}

// Emscripten initialises the module's first global, __stack_pointer, to the
// top of the stack, which grows down from there. Every call starts and ends
// with the stack pointer at that address.
function readStackTop(wasm: Uint8Array): number {
  let at = 8 // magic number and version
  const readLeb128 = (): number => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const byte = wasm[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) {
        return value
      }
    }
  }
  while (at < wasm.length) {
    const id = wasm[at++]!
    const size = readLeb128()
    if (id === WASM_GLOBAL_SECTION) {
      readLeb128() // number of globals
      // (global (mut i32) (i32.const <top>)). The operand is signed LEB128,
      // which reads the same as unsigned for a non-negative value.
      if (wasm[at] !== 0x7f || wasm[at + 1] !== 0x01 || wasm[at + 2] !== 0x41) {
        throw new Error('the first global of pqc.wasm is not a mutable i32 constant')
      }
      at += 3
      return readLeb128()
    }
    at += size
  }
  throw new Error('pqc.wasm has no global section')
}

const stackTop = readStackTop(readFileSync(new URL('../wasm/pqc.wasm', import.meta.url)))

function memoryBytes(module: PqcWasmModule): Buffer {
  return Buffer.from(module.HEAPU8.buffer, module.HEAPU8.byteOffset, module.HEAPU8.byteLength)
}

// Memory is all zero past its last non-zero byte, and no window of a secret
// is all zero (the search before each call would report one), so the search
// can stop there.
function writtenPrefix(memory: Buffer): Buffer {
  const words = new Uint32Array(memory.buffer, memory.byteOffset, memory.byteLength >>> 2)
  let end = words.length
  while (end > 0 && words[end - 1] === 0) {
    end -= 1
  }
  return memory.subarray(0, Math.min(memory.length, end * 4 + FRAGMENT_BYTES - 1))
}

// Every place in wasm memory that holds a FRAGMENT_BYTES-byte window of a
// secret, reported as the address where that copy of the secret would start.
function findFragments(module: PqcWasmModule, secrets: Secrets): string[] {
  const memory = writtenPrefix(memoryBytes(module))
  const found = new Set<string>()
  for (const [name, secret] of Object.entries(secrets)) {
    for (let i = 0; i + FRAGMENT_BYTES <= secret.length; i += 1) {
      const window = secret.subarray(i, i + FRAGMENT_BYTES)
      for (let at = memory.indexOf(window); at !== -1; at = memory.indexOf(window, at + 1)) {
        found.add(`${name} at ${at - i}`)
      }
    }
  }
  return [...found]
}

function paintStack(module: PqcWasmModule): void {
  module.HEAPU8.fill(STACK_PAINT, stackTop - PAINT_BYTES, stackTop)
}

function measureStack(module: PqcWasmModule): StackUse {
  const heap = module.HEAPU8
  let deepest = stackTop - PAINT_BYTES
  while (deepest < stackTop && heap[deepest] === STACK_PAINT) {
    deepest += 1
  }
  let nonZero = deepest
  while (nonZero < stackTop && (heap[nonZero] === 0 || heap[nonZero] === STACK_PAINT)) {
    nonZero += 1
  }
  return { written: stackTop - deepest, nonZero: stackTop - nonZero }
}

// Runs `call` with a fresh client and that client's module, and checks that
// it leaves no fragment of `secrets` in memory and, per `stack`, what it wrote
// to the stack: 'burned' for a call that reaches a burning entry point,
// 'untouched' for one rejected before any wasm code runs.
async function probe(
  secrets: Secrets,
  stack: StackCheck,
  call: (client: PqcClient, module: PqcWasmModule) => unknown
): Promise<Probe> {
  const { client, module } = await freshClient()
  paintStack(module)
  expect(findFragments(module, secrets)).toEqual([])

  const outcome: Omit<Probe, 'stack'> = {}
  try {
    outcome.value = call(client, module)
  } catch (error) {
    outcome.error = error
  }
  const used = measureStack(module)

  expect(findFragments(module, secrets)).toEqual([])
  if (stack === 'burned') {
    expect(used.written, 'stack written').toBeGreaterThanOrEqual(BURN_STACK_BYTES)
    expect(used.written, 'stack written').toBeLessThanOrEqual(BURN_STACK_BYTES + OUTER_FRAMES_BYTES)
    expect(used.nonZero, 'deepest non-zero stack byte').toBeLessThanOrEqual(AFTER_BURN_BYTES)
  } else if (stack === 'untouched') {
    expect(used.written, 'stack written').toBe(0)
  }
  return { ...outcome, stack: used }
}

// Makes the wrapper's `n`th allocation fail, as an exhausted heap would. The
// wrapper calls `_malloc` through the module object, so replacing it there is
// enough.
function failAllocation(module: PqcWasmModule, n: number): void {
  const malloc = module._malloc
  let calls = 0
  module._malloc = size => {
    calls += 1
    return calls === n ? 0 : malloc(size)
  }
}

function expectPqcError(error: unknown, kind: string): void {
  expect(error).toBeInstanceOf(PqcError)
  expect((error as PqcError).kind).toBe(kind)
}

describe('WASM linear-memory secret residue', () => {
  const keygenEntropy = syntheticEntropy(0x5a)
  const masterSeed = syntheticEntropy(0x21).slice(0, 64)
  const derivedEntropy = hkdfEntropy(masterSeed, 0, 0, 0)
  let pair: PqcKeyPair
  let derived: PqcKeyPair
  let signature: Uint8Array
  let inconsistentKey: Uint8Array

  beforeAll(async () => {
    const { client: keyed, module } = await freshClient()
    pair = keyed.keygen(keygenEntropy)
    derived = keyed.keygen(derivedEntropy)
    signature = keyed.sign(pair.secretKey, MESSAGE)
    inconsistentKey = flipByte(pair.secretKey, 4 * SPX_N - 1)

    // The heap starts above the stack top, so the paint cannot reach it.
    const ptr = module._malloc(1)
    expect(ptr).toBeGreaterThanOrEqual(stackTop)
    module._free(ptr)
  })

  describe('keygen', () => {
    it('returns the key pair', async () => {
      const secrets = { ...keyMaterial(pair.secretKey), entropy: keygenEntropy }
      const { value } = await probe(secrets, 'burned', client => client.keygen(keygenEntropy))
      expect(value).toEqual(pair)
    })

    it('rejects one byte too little entropy', async () => {
      const short = keygenEntropy.subarray(0, constants.MIN_ENTROPY - 1)
      const { error } = await probe({ entropy: keygenEntropy }, 'untouched', client => client.keygen(short))
      expect(error).toBeInstanceOf(RangeError)
    })

    it('fails the last allocation before the native call', async () => {
      const { error } = await probe({ entropy: keygenEntropy }, 'unchecked', (client, module) => {
        failAllocation(module, 3)
        return client.keygen(keygenEntropy)
      })
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/WASM malloc failed/)
    })
  })

  describe('derivePQCKey', () => {
    it('returns keygen of the HKDF-derived entropy', async () => {
      const secrets = {
        ...keyMaterial(derived.secretKey),
        'master seed': masterSeed,
        'derived entropy': derivedEntropy,
      }
      const { value } = await probe(secrets, 'burned', client => client.derivePQCKey(masterSeed, 0, 0, 0))
      expect(value).toEqual({ pk32: derived.publicKey, sk64: derived.secretKey })
      // The aliases read the same arrays, so they leave no other copy to zero.
      const { pk32, sk64, publicKey, secretKey } = value as PqcDerivedKeyPair
      expect(publicKey).toBe(pk32)
      expect(secretKey).toBe(sk64)
    })

    it('rejects an index outside uint32', async () => {
      const { error } = await probe({ 'master seed': masterSeed }, 'untouched', client =>
        client.derivePQCKey(masterSeed, 0, 0, UINT32_MAX + 1)
      )
      expect(error).toBeInstanceOf(RangeError)
    })

    it('fails the last allocation before the native call', async () => {
      const secrets = { 'master seed': masterSeed, 'derived entropy': derivedEntropy }
      const { error } = await probe(secrets, 'unchecked', (client, module) => {
        failAllocation(module, 3)
        return client.derivePQCKey(masterSeed, 0, 0, 0)
      })
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/WASM malloc failed/)
    })
  })

  describe.each([
    { name: 'sign', allocations: 3, sign: (c: PqcClient, sk: Uint8Array) => c.sign(sk, MESSAGE) },
    {
      name: 'signWithStats',
      allocations: 4,
      sign: (c: PqcClient, sk: Uint8Array) => c.signWithStats(sk, MESSAGE).sig,
    },
  ])('$name', ({ allocations, sign }) => {
    it('returns the signature', async () => {
      const secrets = {
        ...keyMaterial(pair.secretKey),
        'signing seed': signingSeed(pair.secretKey, MESSAGE),
      }
      const { value } = await probe(secrets, 'burned', client => sign(client, pair.secretKey))
      expect(value).toEqual(signature)
    })

    it('rejects an inconsistent key with BAD_KEY', async () => {
      const { error } = await probe(keyMaterial(inconsistentKey), 'burned', client => sign(client, inconsistentKey))
      expectPqcError(error, 'BAD_KEY')
    })

    it.each([4 * SPX_N - 1, 4 * SPX_N + 1])('rejects a %i-byte key', async length => {
      const sk = new Uint8Array(length)
      sk.set(pair.secretKey.subarray(0, Math.min(length, pair.secretKey.length)))
      const { error } = await probe(keyMaterial(pair.secretKey), 'untouched', client => sign(client, sk))
      expect(error).toBeInstanceOf(RangeError)
    })

    it('fails the last allocation before the native call', async () => {
      const { error } = await probe(keyMaterial(pair.secretKey), 'unchecked', (client, module) => {
        failAllocation(module, allocations)
        return sign(client, pair.secretKey)
      })
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/WASM malloc failed/)
    })
  })

  describe('secretKeyValidate', () => {
    it('accepts the key', async () => {
      const { value } = await probe(keyMaterial(pair.secretKey), 'burned', client =>
        client.secretKeyValidate(pair.secretKey)
      )
      expect(value).toBe(true)
    })

    it('rejects an inconsistent key', async () => {
      const { value } = await probe(keyMaterial(inconsistentKey), 'burned', client =>
        client.secretKeyValidate(inconsistentKey)
      )
      expect(value).toBe(false)
    })

    it('rejects a 63-byte key', async () => {
      const { error } = await probe(keyMaterial(pair.secretKey), 'untouched', client =>
        client.secretKeyValidate(pair.secretKey.subarray(0, 4 * SPX_N - 1))
      )
      expect(error).toBeInstanceOf(RangeError)
    })
  })

  // verify takes no secret and does not burn its stack; these check that it
  // leaves no key material either.
  describe('verify', () => {
    it('accepts the signature', async () => {
      const { value } = await probe(keyMaterial(pair.secretKey), 'unchecked', client =>
        client.verify(pair.publicKey, MESSAGE, signature)
      )
      expect(value).toBe(true)
    })

    it('rejects a tampered signature', async () => {
      const { value } = await probe(keyMaterial(pair.secretKey), 'unchecked', client =>
        client.verify(pair.publicKey, MESSAGE, flipByte(signature, 100))
      )
      expect(value).toBe(false)
    })

    it('returns false for a signature one byte short, without entering wasm', async () => {
      const { value, error } = await probe(keyMaterial(pair.secretKey), 'untouched', client =>
        client.verify(pair.publicKey, MESSAGE, signature.subarray(0, constants.SIG_SIZE - 1))
      )
      expect(error).toBeUndefined()
      expect(value).toBe(false)
    })
  })

  it('control: finds an unwiped secret whose first 8 bytes free() overwrote', async () => {
    const { module } = await freshClient()
    const { SK_SEED } = keyMaterial(pair.secretKey)
    const ptr = module._malloc(SPX_N)
    // Keeps the freed chunk out of the top chunk, which free() would merge
    // it into without writing over it.
    module._malloc(SPX_N)
    module.HEAPU8.set(SK_SEED, ptr)
    module._free(ptr)

    expect(memoryBytes(module).indexOf(SK_SEED)).toBe(-1)
    expect(findFragments(module, { SK_SEED })).toEqual([`SK_SEED at ${ptr}`])
  })

  it('control: the signing seed is the one native signing uses', () => {
    // The signature opens with R = HMAC-SHA-256(SK_PRF, optrand || msg)
    // truncated to SPX_N, after FORS+C grinding XORed a counter into its
    // first 4 bytes.
    const optrand = signingSeed(pair.secretKey, MESSAGE).subarray(0, SPX_N)
    const r = createHmac('sha256', pair.secretKey.subarray(SPX_N, 2 * SPX_N))
      .update(optrand)
      .update(MESSAGE)
      .digest()
    expect(signature.subarray(4, SPX_N)).toEqual(new Uint8Array(r.subarray(4, SPX_N)))
  })

  it('control: the stack probe sees the frames verify leaves unburned', async () => {
    const { value, stack } = await probe({}, 'unchecked', client => client.verify(pair.publicKey, MESSAGE, signature))
    expect(value).toBe(true)
    expect(stack.written).toBeGreaterThan(0)
    expect(stack.nonZero).toBeGreaterThan(0)
  })
})
