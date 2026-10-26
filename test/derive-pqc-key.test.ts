import { createHmac } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import { constants, derivePQCKey, init, type PqcClient } from '../src/index'

const UINT32_MAX = 0xffffffff
const HKDF_SALT = Buffer.from('qbit-sphincs-v1', 'utf8')
const HKDF_INFO_PREFIX = Buffer.from('qbit/sphincs+/1', 'utf8')

function seedBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`qbit-pqc-derive-unit:${label}`)
}

function referenceEntropy(
  masterSeed: Uint8Array,
  account: number,
  change: number,
  index: number
): Uint8Array {
  const prk = createHmac('sha256', HKDF_SALT).update(masterSeed).digest()
  const info = Buffer.alloc(HKDF_INFO_PREFIX.length + 12)
  HKDF_INFO_PREFIX.copy(info)
  info.writeUInt32LE(account, HKDF_INFO_PREFIX.length)
  info.writeUInt32LE(change, HKDF_INFO_PREFIX.length + 4)
  info.writeUInt32LE(index, HKDF_INFO_PREFIX.length + 8)

  const okm = Buffer.alloc(constants.MIN_ENTROPY)
  let previous = Buffer.alloc(0)
  for (let counter = 1; counter <= 4; counter += 1) {
    previous = createHmac('sha256', prk)
      .update(previous)
      .update(info)
      .update(Buffer.of(counter))
      .digest()
    previous.copy(okm, (counter - 1) * previous.length)
  }

  return new Uint8Array(okm)
}

describe('derivePQCKey', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  it('rejects an empty master seed', () => {
    expect(() => derivePQCKey(new Uint8Array(), 0, 0, 0)).toThrow(RangeError)
  })

  it.each([
    ['zero HKDF fields', 0, 0, 0],
    ['maximum uint32 HKDF fields', UINT32_MAX, UINT32_MAX, UINT32_MAX],
  ])(
    'derives expected key sizes and HKDF input encoding for %s',
    (_name, account, change, index) => {
      const masterSeed = seedBytes(_name)
      const derived = client.derivePQCKey(masterSeed, account, change, index)
      const expected = client.keygen(referenceEntropy(masterSeed, account, change, index))

      expect(derived.pk32).toHaveLength(constants.PK_SIZE)
      expect(derived.sk64).toHaveLength(constants.SK_SIZE)
      expect(derived.pk32).toEqual(expected.publicKey)
      expect(derived.sk64).toEqual(expected.secretKey)
    }
  )

  it('is deterministic across calls without sharing mutable result buffers', () => {
    const masterSeed = seedBytes('determinism')

    const first = derivePQCKey(masterSeed, 7, 1, 99)
    const second = derivePQCKey(masterSeed, 7, 1, 99)
    const differentIndex = derivePQCKey(masterSeed, 7, 1, 100)

    expect(second.pk32).toEqual(first.pk32)
    expect(second.sk64).toEqual(first.sk64)
    expect(second.pk32).not.toBe(first.pk32)
    expect(second.sk64).not.toBe(first.sk64)
    expect(differentIndex.sk64).not.toEqual(first.sk64)
  })

  it('rejects HKDF fields outside uint32', () => {
    const masterSeed = seedBytes('bounds')

    expect(() => derivePQCKey(masterSeed, -1, 0, 0)).toThrow(RangeError)
    expect(() => derivePQCKey(masterSeed, 0, UINT32_MAX + 1, 0)).toThrow(RangeError)
    expect(() => derivePQCKey(masterSeed, 0, 0, 1.5)).toThrow(TypeError)
  })
})
