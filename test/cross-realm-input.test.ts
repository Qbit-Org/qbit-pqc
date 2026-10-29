import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  constants,
  deriveP2mrDescriptorKey,
  derivePQCKey,
  init,
  keygen,
  secretKeyValidate,
  sign,
  signWithStats,
  verify,
  type PqcClient,
} from '../src/index'

// Uint8Array from a separate realm (same situation as an iframe or worker
// handing bytes to the main page): `instanceof Uint8Array` is false for it.
function foreignBytes(bytes: Uint8Array): Uint8Array {
  return runInNewContext('Uint8Array.from(source)', { source: Array.from(bytes) }) as Uint8Array
}

function patternBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 29) & 0xff)
}

describe('cross-realm Uint8Array inputs', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  it('creates arrays that instanceof would have rejected', () => {
    const foreign = runInNewContext('new Uint8Array(64)') as unknown
    expect(foreign instanceof Uint8Array).toBe(false)
    expect(Object.prototype.toString.call(foreign)).toBe('[object Uint8Array]')
  })

  it('accepts foreign-realm arrays in every public API and matches same-realm results', () => {
    const entropy = patternBytes(constants.MIN_ENTROPY, 7)
    const message = patternBytes(48, 3)

    const local = keygen(entropy)
    const foreign = keygen(foreignBytes(entropy))
    expect(foreign).toEqual(local)

    const signature = sign(foreignBytes(local.secretKey), foreignBytes(message))
    expect(verify(local.publicKey, message, signature)).toBe(true)
    expect(verify(foreignBytes(local.publicKey), foreignBytes(message), foreignBytes(signature))).toBe(true)

    const withStats = signWithStats(foreignBytes(local.secretKey), foreignBytes(message))
    expect(verify(local.publicKey, message, withStats.sig)).toBe(true)

    expect(secretKeyValidate(foreignBytes(local.secretKey))).toBe(true)

    const masterSeed = patternBytes(64, 11)
    expect(derivePQCKey(foreignBytes(masterSeed), 0, 1, 2)).toEqual(derivePQCKey(masterSeed, 0, 1, 2))

    const leafPrivateKey = patternBytes(32, 13)
    expect(deriveP2mrDescriptorKey(foreignBytes(leafPrivateKey), 2)).toEqual(deriveP2mrDescriptorKey(leafPrivateKey, 2))

    expect(client.keygen(foreignBytes(entropy))).toEqual(local)
    expect(client.secretKeyValidate(foreignBytes(local.secretKey))).toBe(true)
  })

  it('keeps foreign-realm length checks', () => {
    expect(() => keygen(runInNewContext('new Uint8Array(1)') as Uint8Array)).toThrow(RangeError)
    expect(() => derivePQCKey(runInNewContext('new Uint8Array(0)') as Uint8Array, 0, 0, 0)).toThrow(RangeError)
    expect(() => deriveP2mrDescriptorKey(runInNewContext('new Uint8Array(31)') as Uint8Array, 0)).toThrow(RangeError)
  })

  it('still accepts Uint8Array subclasses such as Buffer', () => {
    const entropy = patternBytes(constants.MIN_ENTROPY, 7)
    expect(keygen(Buffer.from(entropy))).toEqual(keygen(entropy))
  })

  // A genuine Uint8Array is read through its internal slots, so a replaced
  // prototype or an overridden length changes neither acceptance nor the
  // bytes used.
  it('uses the real contents of a Uint8Array whose prototype or length was tampered with', () => {
    const entropy = patternBytes(constants.MIN_ENTROPY, 7)
    const expected = keygen(entropy)
    const tampered: Array<[string, Uint8Array]> = [
      ['null prototype', Object.setPrototypeOf(entropy.slice(), null) as Uint8Array],
      [
        'own length that disagrees with its contents',
        Object.defineProperty(entropy.slice(), 'length', { value: constants.MIN_ENTROPY + 1 }),
      ],
      [
        'prototype that reports a fake length',
        Object.setPrototypeOf(
          entropy.slice(),
          Object.create(Uint8Array.prototype, { length: { get: () => constants.MIN_ENTROPY + 1 } })
        ) as Uint8Array,
      ],
    ]
    for (const [label, value] of tampered) {
      expect(keygen(value), label).toEqual(expected)
    }
  })

  const spoofedTag = (target: object) => Object.defineProperty(target, Symbol.toStringTag, { value: 'Uint8Array' })

  const rejected: Array<[string, () => unknown]> = [
    ['Int8Array', () => new Int8Array(constants.MIN_ENTROPY)],
    ['Uint8ClampedArray', () => new Uint8ClampedArray(constants.MIN_ENTROPY)],
    ['Uint16Array', () => new Uint16Array(constants.MIN_ENTROPY)],
    ['DataView', () => new DataView(new ArrayBuffer(constants.MIN_ENTROPY))],
    ['ArrayBuffer', () => new ArrayBuffer(constants.MIN_ENTROPY)],
    ['number array', () => Array.from({ length: constants.MIN_ENTROPY }, () => 0)],
    ['foreign-realm Int8Array', () => runInNewContext(`new Int8Array(${constants.MIN_ENTROPY})`)],
    ['foreign-realm Uint8ClampedArray', () => runInNewContext(`new Uint8ClampedArray(${constants.MIN_ENTROPY})`)],
    ['foreign-realm DataView', () => runInNewContext('new DataView(new ArrayBuffer(64))')],
    ['plain object with a fake Symbol.toStringTag', () => spoofedTag({ length: constants.MIN_ENTROPY })],
    ['Int8Array with a fake Symbol.toStringTag', () => spoofedTag(new Int8Array(constants.MIN_ENTROPY))],
    ['DataView with a fake Symbol.toStringTag', () => spoofedTag(new DataView(new ArrayBuffer(constants.MIN_ENTROPY)))],
    ['object inheriting Uint8Array.prototype', () => Object.create(Uint8Array.prototype)],
    ['Proxy around a Uint8Array', () => new Proxy(new Uint8Array(constants.MIN_ENTROPY), {})],
    ['null', () => null],
  ]

  it.each(rejected)('rejects %s with TypeError', (_label, make) => {
    const value = make() as Uint8Array
    const pair = keygen(patternBytes(constants.MIN_ENTROPY, 7))
    expect(() => keygen(value)).toThrow(new TypeError('entropy must be a Uint8Array'))
    expect(() => derivePQCKey(value, 0, 0, 0)).toThrow(new TypeError('masterSeed must be a Uint8Array'))
    expect(() => deriveP2mrDescriptorKey(value, 0)).toThrow(new TypeError('leafPrivateKey must be a Uint8Array'))
    expect(() => sign(pair.secretKey, value)).toThrow(new TypeError('msg must be a Uint8Array'))
    expect(() => verify(pair.publicKey, new Uint8Array(1), value)).toThrow(new TypeError('sig must be a Uint8Array'))
    expect(() => secretKeyValidate(value)).toThrow(new TypeError('sk must be a Uint8Array'))
  })
})
