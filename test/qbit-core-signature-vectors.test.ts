import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import signatureFixture from '../fixtures/qbit-core-signature-vectors.json'
import { constants, init, type PqcClient, type PqcKeyPair } from '../src/index'

// Signatures in fixtures/qbit-core-signature-vectors.json are copied verbatim
// from qbit Core's src/test/data/p2mr_pqc_witness_vectors.json (see
// scripts/extract-qbit-core-signature-vectors.mjs). Nothing here produces the
// expected bytes: verify must agree with Core, and deterministic signing with
// the regenerated keys must reproduce Core's signatures exactly.

type KeyId = 'A' | 'B' | 'C'

interface QbitCoreSignatureFixture {
  schemaVersion: number
  algorithm: string
  source: { repository: string; tag: string; commit: string; path: string; gitBlob: string; sha256: string }
  keys: Record<KeyId, { randomDataFill: number; publicKey: string }>
  accept: { name: string; key: KeyId; message: string; signature: string }[]
  reject: { name: string; key: KeyId; message: string; signatureOf: string }[]
}

const fixture = signatureFixture as QbitCoreSignatureFixture

const PINNED_CORE_COMMIT = '7ebcddb622d6e639041f005a189b048ec2a221fe'
const PINNED_SOURCE_GIT_BLOB = 'd9a3690645323a10bbb29a311f6db5928fd05b5f'
const PINNED_SOURCE_SHA256 = '4efb0a13b60b50b95e74e2979b4d8edee36184001f7d0448c5e1afaabc2dcfb4'

// Strict: a malformed fixture field must fail loudly, not decode to a shorter
// buffer that verify would then reject for the wrong reason.
function fromHex(hex: string, expectedBytes: number): Uint8Array {
  if (typeof hex !== 'string' || hex.length !== expectedBytes * 2 || !/^[0-9a-f]*$/.test(hex)) {
    // Report only the shape: the value may be signature or key hex.
    const shape = typeof hex === 'string' ? `${hex.length} characters` : typeof hex
    throw new Error(`expected ${expectedBytes} bytes of lowercase hex, got ${shape}`)
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}
const MESSAGE_BYTES = 32
// Core's generator calls keygen with exactly 128 bytes of random_data.
const CORE_RANDOM_DATA_BYTES = 128
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
// Compare signatures by digest so a mismatch never prints signature hex into
// CI logs (docs/mv3-conformance.md, Security Checklist).
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

describe('qbit Core signature vectors', () => {
  let client: PqcClient
  const keyPairs = new Map<KeyId, PqcKeyPair>()

  beforeAll(async () => {
    client = await init()
    for (const [id, key] of Object.entries(fixture.keys) as [KeyId, QbitCoreSignatureFixture['keys'][KeyId]][]) {
      keyPairs.set(id, client.keygen(new Uint8Array(CORE_RANDOM_DATA_BYTES).fill(key.randomDataFill)))
    }
  })

  it('names the pinned Core source and algorithm', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.algorithm).toBe(constants.ALGORITHM)
    expect(fixture.source.repository).toBe('Qbit-Org/qbit')
    expect(fixture.source.tag).toBe('v1.0.0')
    expect(fixture.source.commit).toBe(PINNED_CORE_COMMIT)
    expect(fixture.source.path).toBe('src/test/data/p2mr_pqc_witness_vectors.json')
    expect(fixture.source.gitBlob).toBe(PINNED_SOURCE_GIT_BLOB)
    expect(fixture.source.sha256).toBe(PINNED_SOURCE_SHA256)
    expect(fixture.accept.length).toBeGreaterThan(0)
    expect(fixture.reject.length).toBeGreaterThan(0)
  })

  it("regenerates Core's keys from its random_data fills", () => {
    for (const [id, key] of Object.entries(fixture.keys) as [KeyId, QbitCoreSignatureFixture['keys'][KeyId]][]) {
      expect(toHex(keyPairs.get(id)!.publicKey) === key.publicKey, `key ${id} public key matches Core`).toBe(true)
    }
  })

  for (const vector of fixture.accept) {
    it(`accepts and reproduces Core signature ${vector.name}`, () => {
      const publicKey = fromHex(fixture.keys[vector.key].publicKey, constants.PK_SIZE)
      const message = fromHex(vector.message, MESSAGE_BYTES)
      const signature = fromHex(vector.signature, constants.SIG_SIZE)
      expect(client.verify(publicKey, message, signature)).toBe(true)

      const pair = keyPairs.get(vector.key)
      expect(pair, `key ${vector.key} regenerated in beforeAll`).toBeDefined()
      expect(sha256Hex(client.sign(pair!.secretKey, message)), 'sha256 of the re-signed signature').toBe(
        sha256Hex(signature)
      )
    })
  }

  for (const vector of fixture.reject) {
    it(`rejects ${vector.name}`, () => {
      const signed = fixture.accept.find(candidate => candidate.name === vector.signatureOf)
      expect(signed, `${vector.signatureOf} is an accepted vector`).toBeDefined()
      const publicKey = fromHex(fixture.keys[vector.key].publicKey, constants.PK_SIZE)
      const message = fromHex(vector.message, MESSAGE_BYTES)
      expect(client.verify(publicKey, message, fromHex(signed!.signature, constants.SIG_SIZE))).toBe(false)
    })
  }
})
