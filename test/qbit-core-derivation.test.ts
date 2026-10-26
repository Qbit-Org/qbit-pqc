import { createHash, createHmac } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import derivationFixture from '../fixtures/qbit-core-derivation.json'
import {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  init,
  type PqcClient,
} from '../src/index'

interface QbitCoreDerivationFixture {
  schemaVersion: number
  name: string
  algorithm: string
  sizes: {
    masterSeedBytes: number
    keygenEntropyBytes: number
    publicKeyBytes: number
    secretKeyBytes: number
    signatureBytes: number
  }
  derivation: {
    purpose: number
    defaultAccount: number
    mainnetCoinType: number
    testRegtestCoinType: number
    descriptor: string
    saltUtf8: string
    infoPrefixUtf8: string
    infoLayout: string
    hkdf: string
    keygen: string
  }
  vectors: QbitCoreDerivationVector[]
}

interface QbitCoreDerivationVector {
  name: string
  network: string
  descriptorTemplate: string
  coreBehavior: 'canonical_descriptor_generation' | 'recovery_match_only' | 'primitive_only'
  range?: [number, number]
  path?: QbitCorePath
  hkdf: QbitCoreHkdf
  descriptorPath?: string
  boundary?: boolean
  masterSeedHex: string
  messageHex: string
  keygenEntropyHex: string
  publicKeyHex: string
  secretKeyHex: string
  signatureSha256Hex: string
}

interface QbitCorePath {
  purpose: number
  coinType: number
  account: number
  change: number
  index: number
}

interface QbitCoreHkdf {
  account: number
  change: number
  index: number
}

const fixture = derivationFixture as QbitCoreDerivationFixture
const encoder = new TextEncoder()

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex length: ${hex.length}`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint32Le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`uint32 value out of range: ${value}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function hmacSha256(key: Uint8Array, ...chunks: Uint8Array[]): Uint8Array {
  const hmac = createHmac('sha256', key)
  for (const chunk of chunks) {
    hmac.update(chunk)
  }
  return new Uint8Array(hmac.digest())
}

function deriveQbitCorePqcEntropy(vector: QbitCoreDerivationVector): Uint8Array {
  const salt = encoder.encode(fixture.derivation.saltUtf8)
  const prefix = encoder.encode(fixture.derivation.infoPrefixUtf8)
  const masterSeed = hexToBytes(vector.masterSeedHex)
  const prk = hmacSha256(salt, masterSeed)
  const info = concatBytes(
    prefix,
    uint32Le(vector.hkdf.account),
    uint32Le(vector.hkdf.change),
    uint32Le(vector.hkdf.index)
  )

  const okm = new Uint8Array(fixture.sizes.keygenEntropyBytes)
  let previous = new Uint8Array()
  let offset = 0
  for (let counter = 1; offset < okm.length; counter += 1) {
    const block = hmacSha256(prk, previous, info, new Uint8Array([counter]))
    const copyLength = Math.min(block.length, okm.length - offset)
    okm.set(block.slice(0, copyLength), offset)
    previous = block
    offset += copyLength
  }
  return okm
}

function expectDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is missing`)
  }
  return value
}

function expectedDescriptorPath(path: QbitCorePath): string {
  return `m/${path.purpose}h/${path.coinType}h/${path.account}h/${path.change}/${path.index}`
}

describe('qbit Core PQC derivation contract', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  it('documents the qbit Core bounded30 sizes used by the derivation vectors', () => {
    expect(fixture.schemaVersion).toBe(2)
    expect(fixture.name).toBe('qbit-core-pqc-derivation')
    expect(fixture.algorithm).toBe(constants.ALGORITHM)
    expect(fixture.sizes.masterSeedBytes).toBe(32)
    expect(fixture.sizes.keygenEntropyBytes).toBe(constants.MIN_ENTROPY)
    expect(fixture.sizes.publicKeyBytes).toBe(constants.PK_SIZE)
    expect(fixture.sizes.secretKeyBytes).toBe(constants.SK_SIZE)
    expect(fixture.sizes.signatureBytes).toBe(constants.SIG_SIZE)
  })

  it('covers canonical descriptor, recovery, and primitive boundary cases', () => {
    const descriptorVectors = fixture.vectors.filter(vector =>
      vector.descriptorTemplate.startsWith('mr(pk(pqc(')
    )

    expect(descriptorVectors.length).toBeGreaterThanOrEqual(3)
    expect(
      descriptorVectors.filter(vector => vector.coreBehavior === 'canonical_descriptor_generation')
        .length
    ).toBeGreaterThanOrEqual(3)
    expect(
      fixture.vectors.some(
        vector => vector.coreBehavior === 'recovery_match_only' && vector.hkdf.change === 1
      )
    ).toBe(true)
    expect(fixture.vectors.some(vector => vector.hkdf.index === 0xffffffff)).toBe(true)
    expect(fixture.vectors.some(vector => vector.hkdf.index > 0)).toBe(true)
  })

  for (const vector of fixture.vectors) {
    it(`matches qbit Core derivation vector ${vector.name}`, () => {
      if (vector.coreBehavior === 'primitive_only') {
        expect(vector.path).toBeUndefined()
        expect(vector.range).toBeUndefined()
        expect(vector.descriptorPath).toBeUndefined()
      } else {
        const path = expectDefined(vector.path, `${vector.name}.path`)
        expect(path.purpose).toBe(fixture.derivation.purpose)
        expect(path.account).toBe(fixture.derivation.defaultAccount)
        expect(vector.descriptorPath).toBe(expectedDescriptorPath(path))
        expect(vector.range).toEqual([path.index, path.index])

        if (vector.coreBehavior === 'canonical_descriptor_generation') {
          expect(vector.hkdf.change).toBe(0)
        }
      }

      expect(hexToBytes(vector.masterSeedHex)).toHaveLength(fixture.sizes.masterSeedBytes)

      const masterSeed = hexToBytes(vector.masterSeedHex)
      const entropy = deriveQbitCorePqcEntropy(vector)
      expect(bytesToHex(entropy)).toBe(vector.keygenEntropyHex)

      const pair = client.keygen(entropy)
      expect(bytesToHex(pair.publicKey)).toBe(vector.publicKeyHex)
      expect(bytesToHex(pair.secretKey)).toBe(vector.secretKeyHex)
      expect(bytesToHex(pair.secretKey.slice(constants.SK_SIZE - constants.PK_SIZE))).toBe(
        vector.publicKeyHex
      )

      const derived = derivePQCKey(
        masterSeed,
        vector.hkdf.account,
        vector.hkdf.change,
        vector.hkdf.index
      )
      expect(bytesToHex(derived.pk32)).toBe(vector.publicKeyHex)
      expect(bytesToHex(derived.sk64)).toBe(vector.secretKeyHex)
      expect(derived.pk32).toEqual(pair.publicKey)
      expect(derived.sk64).toEqual(pair.secretKey)

      const message = hexToBytes(vector.messageHex)
      const signature = client.sign(pair.secretKey, message)
      expect(signature).toHaveLength(constants.SIG_SIZE)
      expect(sha256Hex(signature)).toBe(vector.signatureSha256Hex)
      expect(client.verify(pair.publicKey, message, signature)).toBe(true)
    })
  }

  it('deriveP2mrDescriptorKey derives exactly the descriptor-generation vectors', () => {
    for (const vector of fixture.vectors) {
      const masterSeed = hexToBytes(vector.masterSeedHex)
      if (vector.coreBehavior === 'primitive_only') {
        // Its HKDF index is above every descriptor range position.
        expect(() => deriveP2mrDescriptorKey(masterSeed, vector.hkdf.index), vector.name).toThrow(
          RangeError
        )
        continue
      }

      const { index } = expectDefined(vector.path, `${vector.name}.path`)
      const derived = deriveP2mrDescriptorKey(masterSeed, index)
      if (vector.coreBehavior === 'canonical_descriptor_generation') {
        expect(bytesToHex(derived.pk32), vector.name).toBe(vector.publicKeyHex)
        expect(bytesToHex(derived.sk64), vector.name).toBe(vector.secretKeyHex)
      } else {
        // Core matches this HKDF change=1 key when recovering but never generates it.
        expect(bytesToHex(derived.pk32), vector.name).not.toBe(vector.publicKeyHex)
      }
    }
  })

  it('domain-separates account, change, and index in the HKDF info string', () => {
    const [vector] = fixture.vectors
    if (vector === undefined) {
      throw new Error('derivation fixture has no vectors')
    }

    const baseline = bytesToHex(deriveQbitCorePqcEntropy(vector))
    expect(
      bytesToHex(
        deriveQbitCorePqcEntropy({
          ...vector,
          hkdf: { ...vector.hkdf, account: vector.hkdf.account + 1 },
        })
      )
    ).not.toBe(baseline)
    expect(
      bytesToHex(
        deriveQbitCorePqcEntropy({
          ...vector,
          hkdf: { ...vector.hkdf, change: vector.hkdf.change + 1 },
        })
      )
    ).not.toBe(baseline)
    expect(
      bytesToHex(
        deriveQbitCorePqcEntropy({
          ...vector,
          hkdf: { ...vector.hkdf, index: vector.hkdf.index + 1 },
        })
      )
    ).not.toBe(baseline)
  })
})
