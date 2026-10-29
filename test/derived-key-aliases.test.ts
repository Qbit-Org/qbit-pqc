import { deepStrictEqual } from 'node:assert'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  init,
  type PqcClient,
  type PqcDerivedKeyPair,
} from '../src/index'

// A derived key's publicKey and secretKey are keygen's names for pk32 and sk64:
// non-enumerable getters over the same arrays, not copies. Wallet code zeroes
// pk32 and sk64 after use, so a copy under the other name would keep the secret
// key, and code that enumerates, compares or serializes a derived key must see
// the 0.1.0 shape, { pk32, sk64 }, with the secret key once.

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

  it.each(derivations)('%s reads publicKey and secretKey as pk32 and sk64 themselves', (_name, derive) => {
    const derived = derive()
    expect(derived.publicKey).toBe(derived.pk32)
    expect(derived.secretKey).toBe(derived.sk64)
    for (const alias of ['publicKey', 'secretKey']) {
      const descriptor = Object.getOwnPropertyDescriptor(derived, alias)
      expect(descriptor?.get).toBeTypeOf('function')
      expect(descriptor?.set).toBeUndefined()
      expect(descriptor?.enumerable).toBe(false)
    }
  })

  it.each(derivations)('%s enumerates, compares and serializes as { pk32, sk64 }', (_name, derive) => {
    const derived = derive()
    const { pk32, sk64 } = derived
    expect(Object.keys(derived)).toEqual(['pk32', 'sk64'])
    expect(Object.keys({ ...derived })).toEqual(['pk32', 'sk64'])
    expect(Object.keys(structuredClone(derived))).toEqual(['pk32', 'sk64'])
    expect(JSON.stringify(derived)).toBe(JSON.stringify({ pk32, sk64 }))
    expect(derived).toEqual({ pk32, sk64 })
    expect(derived).toStrictEqual({ pk32, sk64 })
    deepStrictEqual(derived, { pk32, sk64 })
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

  it.each(derivations)('%s: the aliases follow a reassigned or deleted pk32 and sk64', (_name, derive) => {
    const derived = derive()
    const replacement = new Uint8Array(constants.SK_SIZE)
    derived.sk64 = replacement
    expect(derived.secretKey).toBe(replacement)

    const mutable = derived as Partial<PqcDerivedKeyPair>
    delete mutable.pk32
    expect(derived.publicKey).toBeUndefined()
  })

  it.each(derivations)('%s: assigning to an alias throws and changes nothing', (_name, derive) => {
    const derived = derive()
    const { sk64 } = derived
    const writable = derived as { secretKey: Uint8Array }
    // Test modules are strict mode, where assigning to a getter-only property throws.
    expect(() => {
      writable.secretKey = new Uint8Array(constants.SK_SIZE)
    }).toThrow(TypeError)
    expect(derived.sk64).toBe(sk64)
    expect(derived.secretKey).toBe(sk64)
  })

  it('derives the same key through every entry point', () => {
    const keys = derivations.map(([, derive]) => derive())
    for (const key of keys) {
      expect(key.publicKey).toEqual(keys[0]!.pk32)
      expect(key.secretKey).toEqual(keys[0]!.sk64)
    }
  })
})
