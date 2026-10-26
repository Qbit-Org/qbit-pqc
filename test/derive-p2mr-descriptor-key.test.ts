import { beforeAll, describe, expect, it } from 'vitest'

import derivationFixture from '../fixtures/qbit-core-derivation.json'
import { deriveP2mrDescriptorKey, derivePQCKey, init, type PqcClient } from '../src/index'

// deriveP2mrDescriptorKey(leaf, i) is derivePQCKey(leaf, 0, 0, i) restricted to
// the inputs qbit Core's descriptor wallet can produce. derivePQCKey accepts
// each misencoded leaf and hardened index rejected below and derives a key
// that importing the wallet's descriptor into Core never finds. Parity with
// Core's own keys is in qbit-core-derivation.test.ts and
// qbit-core-binary-derivation.test.ts.

const HARDENED = 0x80000000
const MAX_RANGE_INDEX = 0x7fffffff

interface DerivationVector {
  name: string
  coreBehavior: string
  masterSeedHex: string
  publicKeyHex: string
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function patternBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 29) & 0xff)
}

// A descriptor-generation vector whose leaf key starts with a zero byte: an
// unpadded hex or bigint round trip turns it into 31 bytes.
function leadingZeroLeafVector(): DerivationVector {
  const vector = (derivationFixture.vectors as DerivationVector[]).find(
    candidate =>
      candidate.coreBehavior === 'canonical_descriptor_generation' &&
      candidate.masterSeedHex.startsWith('00')
  )
  if (vector === undefined) {
    throw new Error('derivation fixture has no leaf key with a leading zero byte')
  }
  return vector
}

describe('deriveP2mrDescriptorKey', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  it('derives derivePQCKey(leaf, 0, 0, rangeIndex) on the client and the top-level export', () => {
    const leaf = patternBytes(32, 5)

    for (const rangeIndex of [0, 1, MAX_RANGE_INDEX]) {
      const expected = client.derivePQCKey(leaf, 0, 0, rangeIndex)
      expect(client.deriveP2mrDescriptorKey(leaf, rangeIndex)).toEqual(expected)
      expect(deriveP2mrDescriptorKey(leaf, rangeIndex)).toEqual(expected)
    }
  })

  it('rejects a leaf key that is not exactly 32 bytes', () => {
    const vector = leadingZeroLeafVector()
    const leaf = hexToBytes(vector.masterSeedHex)
    expect(bytesToHex(deriveP2mrDescriptorKey(leaf, 0).pk32)).toBe(vector.publicKeyHex)

    const misencoded: Array<[string, Uint8Array]> = [
      ['the leaf without its leading zero byte', leaf.slice(1)],
      ['the xprv serialization 00 || leaf', Uint8Array.of(0, ...leaf)],
    ]
    for (const [label, bytes] of misencoded) {
      expect(() => deriveP2mrDescriptorKey(bytes, 0), label).toThrow(RangeError)
      expect(() => deriveP2mrDescriptorKey(bytes, 0), label).toThrow(
        `leafPrivateKey must be 32 bytes, got ${bytes.length}`
      )
      // The same leaf through derivePQCKey: accepted, and not Core's key.
      expect(bytesToHex(derivePQCKey(bytes, 0, 0, 0).pk32), label).not.toBe(vector.publicKeyHex)
    }

    // Empty, a BIP32 master seed and a BIP39 seed.
    for (const length of [0, 16, 64]) {
      expect(() => client.deriveP2mrDescriptorKey(patternBytes(length, 3), 0)).toThrow(
        `leafPrivateKey must be 32 bytes, got ${length}`
      )
    }
    expect(() => derivePQCKey(patternBytes(64, 3), 0, 0, 0)).not.toThrow()
  })

  it('accepts only leaf keys from 1 to n - 1, n being the secp256k1 group order', () => {
    const order = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    const minus = (bytes: Uint8Array, k: number) => {
      const out = bytes.slice()
      for (let i = out.length - 1, borrow = k; borrow > 0 && i >= 0; i -= 1) {
        const value = out[i]! - borrow
        out[i] = value & 0xff
        borrow = value < 0 ? 1 : 0
      }
      return out
    }
    const one = new Uint8Array(32)
    one[31] = 1
    const valid: Array<[string, Uint8Array]> = [
      ['1', one],
      ['n - 1', minus(order, 1)],
      ['n - 256', minus(order, 256)],
    ]
    for (const [label, leaf] of valid) {
      expect(client.deriveP2mrDescriptorKey(leaf, 0), label).toEqual(client.derivePQCKey(leaf, 0, 0, 0))
    }
    const invalid: Array<[string, Uint8Array]> = [
      ['zero (a wiped buffer)', new Uint8Array(32)],
      ['n', order],
      ['n + 1', (() => {
        const out = order.slice()
        out[31] = out[31]! + 1
        return out
      })()],
      ['all 0xff', new Uint8Array(32).fill(0xff)],
    ]
    for (const [label, leaf] of invalid) {
      expect(() => deriveP2mrDescriptorKey(leaf, 0), label).toThrow(
        'leafPrivateKey must be a secp256k1 private key: nonzero and below the curve order'
      )
    }
  })

  it('rejects a hardened or out-of-range rangeIndex', () => {
    const leaf = patternBytes(32, 7)
    const hardenedFive = (5 | HARDENED) >>> 0

    // 5 | HARDENED is the same hardened index as a negative int32.
    for (const rangeIndex of [HARDENED, hardenedFive, 5 | HARDENED, 0xffffffff, -1, 2 ** 32]) {
      expect(() => deriveP2mrDescriptorKey(leaf, rangeIndex), `${rangeIndex}`).toThrow(RangeError)
      expect(() => deriveP2mrDescriptorKey(leaf, rangeIndex), `${rangeIndex}`).toThrow(
        `rangeIndex must be between 0 and ${MAX_RANGE_INDEX}`
      )
    }
    expect(() => derivePQCKey(leaf, 0, 0, hardenedFive)).not.toThrow()

    for (const rangeIndex of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', 5n, undefined]) {
      const call = () => deriveP2mrDescriptorKey(leaf, rangeIndex as number)
      expect(call, `${String(rangeIndex)}`).toThrow(TypeError)
      expect(call, `${String(rangeIndex)}`).toThrow('rangeIndex must be a uint32 integer')
    }
  })

  it('rejects a leaf key that is not a Uint8Array', () => {
    const leaf = patternBytes(32, 9)

    for (const value of [bytesToHex(leaf), Array.from(leaf), leaf.buffer, undefined]) {
      const call = () => deriveP2mrDescriptorKey(value as unknown as Uint8Array, 0)
      expect(call).toThrow(TypeError)
      expect(call).toThrow('leafPrivateKey must be a Uint8Array')
    }
  })
})
