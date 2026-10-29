import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import { constants, init, type PqcClient } from '../src/index'

// derivePQCKey hashes with a SHA-256, HMAC-SHA-256 and HKDF of its own in
// src/core.ts, written against captured intrinsics (see the top of that
// file). Through derivePQCKey they only ever see two HMAC keys, the 15-byte
// salt and the 32-byte PRK, and SHA-256 messages of 64 + seed length, 92, 96
// and 124 bytes. Messages under 65 bytes and HMAC's branch for keys longer
// than a block are reachable only by calling the functions directly. They are
// module-private, so this file evaluates src/core.ts itself, with the types
// stripped and an export list appended, and compares them with node:crypto.

const HKDF_SALT = Buffer.from('qbit-sphincs-v1', 'utf8')
const HKDF_INFO_PREFIX = Buffer.from('qbit/sphincs+/1', 'utf8')
const SHA256_BLOCK_BYTES = 64

// 0 to 200 bytes covers every padding layout of one to four blocks. Between 55
// and 56 bytes in the last block, the 0x80 byte and the 8-byte bit count stop
// fitting after the message; 63, 64 and 65 straddle a full block. 2^16 + 1 is
// a long message whose bit count takes three bytes.
const LENGTHS = [...Array.from({ length: 201 }, (_, length) => length), 2 ** 16 + 1]

interface HashInternals {
  sha256(message: Uint8Array): Uint8Array
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array
  derivePQCKeygenEntropy(masterSeed: Uint8Array, account: number, change: number, index: number): Uint8Array
}

async function loadHashInternals(): Promise<HashInternals> {
  const source = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(`${source}\nexport { sha256, hmacSha256, derivePQCKeygenEntropy }\n`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  return (await import(/* @vite-ignore */ url)) as HashInternals
}

function patternBytes(length: number, tag: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (tag * 59 + i * 151 + (i >>> 8) * 7) & 0xff
  }
  return bytes
}

// Path fields that differ per seed and set high bits, so a byte-order or
// width mistake in the info encoding shows.
function pathFor(length: number): [account: number, change: number, index: number] {
  return [length, length & 1, Math.imul(length + 1, 0x9e3779b9) >>> 0]
}

function hkdfEntropy(masterSeed: Uint8Array, account: number, change: number, index: number): Uint8Array {
  const info = Buffer.alloc(HKDF_INFO_PREFIX.length + 12)
  HKDF_INFO_PREFIX.copy(info)
  info.writeUInt32LE(account, HKDF_INFO_PREFIX.length)
  info.writeUInt32LE(change, HKDF_INFO_PREFIX.length + 4)
  info.writeUInt32LE(index, HKDF_INFO_PREFIX.length + 8)
  return new Uint8Array(hkdfSync('sha256', masterSeed, HKDF_SALT, info, constants.MIN_ENTROPY))
}

function nodeHmac(key: Uint8Array, data: Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('derivePQCKey hashing against node:crypto', () => {
  let internals: HashInternals

  beforeAll(async () => {
    internals = await loadHashInternals()
  })

  it('SHA-256 matches for messages of 0 to 200 bytes and 2^16 + 1 bytes', () => {
    const mismatches = LENGTHS.filter(length => {
      const message = patternBytes(length, 1)
      return hex(internals.sha256(message)) !== createHash('sha256').update(message).digest('hex')
    })
    expect(mismatches).toEqual([])
  })

  it('HMAC-SHA-256 matches for keys of 0 to 200 bytes and 2^16 + 1 bytes', () => {
    const data = patternBytes(37, 2)
    const mismatches = LENGTHS.filter(length => {
      const key = patternBytes(length, 3)
      return hex(internals.hmacSha256(key, data)) !== nodeHmac(key, data)
    })
    expect(mismatches).toEqual([])
  })

  it.each([15, 32, SHA256_BLOCK_BYTES, SHA256_BLOCK_BYTES + 1, 200])(
    'HMAC-SHA-256 with a %i-byte key matches for data of 0 to 200 bytes and 2^16 + 1 bytes',
    keyLength => {
      const key = patternBytes(keyLength, 4)
      const mismatches = LENGTHS.filter(length => {
        const data = patternBytes(length, 5)
        return hex(internals.hmacSha256(key, data)) !== nodeHmac(key, data)
      })
      expect(mismatches).toEqual([])
    }
  )

  it('HKDF entropy matches hkdfSync for seeds of 0 to 200 bytes and 2^16 + 1 bytes', () => {
    const mismatches = LENGTHS.filter(length => {
      const seed = patternBytes(length, 6)
      const path = pathFor(length)
      const entropy = internals.derivePQCKeygenEntropy(seed, ...path)
      return hex(entropy) !== hex(hkdfEntropy(seed, ...path))
    })
    expect(mismatches).toEqual([])
  })

  describe('derivePQCKey', () => {
    let client: PqcClient

    beforeAll(async () => {
      client = await init()
    })

    // The seed lengths that put the HMAC inner message (the 64-byte padded
    // salt, then the seed) on one of those boundaries, 2^16 + 1 included.
    const boundarySeedLengths = LENGTHS.filter(
      length => length > 0 && [55, 56, 63, 0, 1].includes(length % SHA256_BLOCK_BYTES)
    )

    it.each(boundarySeedLengths)('of a %i-byte seed is keygen of the hkdfSync entropy', length => {
      const seed = patternBytes(length, 7)
      const path = pathFor(length)
      const expected = client.keygen(hkdfEntropy(seed, ...path))

      const derived = client.derivePQCKey(seed, ...path)
      expect(derived.pk32).toEqual(expected.publicKey)
      expect(derived.sk64).toEqual(expected.secretKey)
    })
  })
})
