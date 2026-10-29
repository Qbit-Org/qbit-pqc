import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  init,
  type PqcClient,
  type PqcDerivedKeyPair,
} from '../src/index'

// A derived key's publicKey and secretKey are keygen's names for pk32 and sk64.
// They must be the same arrays, not copies: wallet code zeroes pk32 and sk64
// after use, and a copy under the other name would keep the secret key.

// A synthetic secp256k1 leaf key: nonzero and below the group order.
const LEAF = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

describe('derived key aliases', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  const derivations: [string, () => PqcDerivedKeyPair][] = [
    ['client.derivePQCKey', () => client.derivePQCKey(LEAF, 0, 0, 7)],
    ['derivePQCKey', () => derivePQCKey(LEAF, 0, 0, 7)],
    ['client.deriveP2mrDescriptorKey', () => client.deriveP2mrDescriptorKey(LEAF, 7)],
    ['deriveP2mrDescriptorKey', () => deriveP2mrDescriptorKey(LEAF, 7)],
  ]

  it.each(derivations)('%s returns publicKey and secretKey as pk32 and sk64 themselves', (_name, derive) => {
    const derived = derive()
    expect(derived.publicKey).toBe(derived.pk32)
    expect(derived.secretKey).toBe(derived.sk64)
    expect(Object.keys(derived)).toEqual(['pk32', 'sk64', 'publicKey', 'secretKey'])
    for (const [alias, original] of [
      ['publicKey', derived.pk32],
      ['secretKey', derived.sk64],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(derived, alias)).toEqual({
        value: original,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  })

  it.each(derivations)('%s: zeroing pk32 and sk64 after use zeroes the aliases', (_name, derive) => {
    const derived = derive()
    const { pk32, sk64 } = derived
    expect(pk32).toHaveLength(constants.PK_SIZE)
    expect(sk64).toHaveLength(constants.SK_SIZE)
    expect(sk64.some(byte => byte !== 0)).toBe(true)

    pk32.fill(0)
    sk64.fill(0)
    expect(derived.publicKey).toEqual(new Uint8Array(constants.PK_SIZE))
    expect(derived.secretKey).toEqual(new Uint8Array(constants.SK_SIZE))
  })

  it('derives the same key through every entry point', () => {
    const keys = derivations.map(([, derive]) => derive())
    for (const key of keys) {
      expect(key.publicKey).toEqual(keys[0]!.pk32)
      expect(key.secretKey).toEqual(keys[0]!.sk64)
    }
  })
})
