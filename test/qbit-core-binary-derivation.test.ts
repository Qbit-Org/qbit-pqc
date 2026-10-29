import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import binaryFixture from '../fixtures/qbit-core-binary-derivation.json'
import harnessFixture from '../fixtures/qbit-core-derivation.json'
import { QBIT_CORE_RELEASE_SIGNERS } from '../scripts/qbit-core-release-signers.mjs'
import { constants, deriveP2mrDescriptorKey, derivePQCKey, init, type PqcClient } from '../src/index'

// Vectors in fixtures/qbit-core-binary-derivation.json were produced by an
// unmodified qbit Core release binary (see scripts/generate-qbit-core-binary-vectors.mjs
// and docs/derivation.md, "Core Binary Oracle"). Nothing here re-implements
// Core's DerivePQCKey: the package output is compared with Core's output.

interface QbitCoreBinaryFixture {
  schemaVersion: number
  name: string
  core: {
    repository: string
    tag: string
    commit: string
    tagResolution: { method: string; remote: string; tagObjectSha: string | null }
    versionString: string
    release: {
      asset: string
      assetSha256: string
      signerPolicy: {
        manifest: string
        manifestBlobSha: string
        policyId: string
        releaseLine: string
        releaseSignatureQuorum: number
      }
      sha256sumsSignedBy: { alias: string; signingFingerprint: string; primaryFingerprint: string }[]
    }
    binaries: { qbitdSha256: string; qbitCliSha256: string }
  }
  generator: { path: string; method: string }
  network: string
  algorithm: string
  bip32: { seedSource: string; seedHex: string; tprv: string }
  chains: Record<string, { descriptor: string; coreNormalizedDescriptor: string; range: [number, number] }>
  vectors: QbitCoreBinaryVector[]
  dataSignature: QbitCoreDataSignatureVector
}

interface QbitCoreBinaryVector {
  name: string
  chain: string
  descriptor: string
  bip32Path: string
  path: { purpose: number; coinType: number; account: number; change: number; index: number }
  hkdf: { account: number; change: number; index: number }
  leafPrivateKeyHex: string
  leafCrossCheck: { descriptor: string; address: string }
  publicKeyHex: string
  address: string
  scriptPubKeyHex: string
}

interface QbitCoreDataSignatureVector {
  vector: string
  rpc: string
  proofMode: string
  domain: string
  messageUtf8: string
  messageHashHex: string
  datasigHashHex: string
  publicKeyHex: string
  signatureHex: string
  leafVersion: number
  leafScriptHex: string
  controlBlockHex: string
  p2mrMerkleRootHex: string
}

const fixture = binaryFixture as QbitCoreBinaryFixture
const harness = harnessFixture as { source: { repository: string; commit: string } }

// qbit Core v1.0.0 is the pinned derivation reference. Changing it is a
// breaking (major) release; see RELEASE.md, "Derivation Fixture Gate".
const PINNED_CORE_TAG = 'v1.0.0'
const PINNED_CORE_COMMIT = '7ebcddb622d6e639041f005a189b048ec2a221fe'
// Trusted operator release keys at that commit; the fixture's recorded
// signers must be a subset of this set (scripts/qbit-core-release-signers.mjs).
const PINNED_SIGNERS = QBIT_CORE_RELEASE_SIGNERS

const OP_CHECKSIGPQC = 0xb3
const P2MR_LEAF_VERSION = 0xc0
const WITNESS_V2_P2MR_PREFIX = '5220'
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const HARDENED = 0x80000000

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(`invalid lowercase hex: ${hex.slice(0, 32)}...`)
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function sha256(...chunks: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256')
  for (const chunk of chunks) {
    hash.update(chunk)
  }
  return new Uint8Array(hash.digest())
}

// BIP340-style tagged hash as used by qbit Core's HashWriter{TaggedHash(tag)}.
function taggedHash(tag: string, ...chunks: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  return sha256(tagHash, tagHash, ...chunks)
}

// Single-leaf P2MR Merkle root for the leaf `<pk32> OP_CHECKSIGPQC`, i.e. the
// witness program qbit Core commits to for mr(pk(<pk32>)).
function p2mrSingleLeafProgramHex(pk32Hex: string): string {
  const leafScript = new Uint8Array([0x20, ...hexToBytes(pk32Hex), OP_CHECKSIGPQC])
  return bytesToHex(taggedHash('P2MRLeaf', new Uint8Array([P2MR_LEAF_VERSION, leafScript.length]), leafScript))
}

// The witness program of a segwit address, without checking its bech32m
// checksum: the addresses decoded here are qbit Core's output.
function witnessProgramHex(address: string): string {
  const words = Array.from(address.slice(address.lastIndexOf('1') + 1, -6), char => BECH32_CHARSET.indexOf(char))
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  // words[0] is the witness version.
  for (const word of words.slice(1)) {
    accumulator = ((accumulator << 5) | word) & 0xfff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 0xff)
    }
  }
  return bytesToHex(Uint8Array.from(bytes))
}

function findVector(name: string): QbitCoreBinaryVector {
  const vector = fixture.vectors.find(candidate => candidate.name === name)
  if (vector === undefined) {
    throw new Error(`fixture vector ${name} is missing`)
  }
  return vector
}

describe('qbit Core release binary derivation oracle', () => {
  let client: PqcClient

  beforeAll(async () => {
    client = await init()
  })

  it('records an unmodified qbit Core release binary as the vector source', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.name).toBe('qbit-core-binary-derivation')
    expect(fixture.network).toBe('regtest')
    expect(fixture.algorithm).toBe(constants.ALGORITHM)
    expect(fixture.generator.path).toBe('scripts/generate-qbit-core-binary-vectors.mjs')

    expect(fixture.core.repository).toBe('Qbit-Org/qbit')
    expect(fixture.core.tag).toBe(PINNED_CORE_TAG)
    expect(fixture.core.commit).toBe(PINNED_CORE_COMMIT)
    expect(fixture.core.versionString).toBe(`qbit daemon version ${PINNED_CORE_TAG} qbitd`)
    expect(fixture.core.release.asset).toMatch(/^qbit-\d+\.\d+\.\d+-[a-z0-9_-]+\.tar\.gz$/)
    expect(fixture.core.release.assetSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.core.binaries.qbitdSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.core.binaries.qbitCliSha256).toMatch(/^[0-9a-f]{64}$/)

    // Both derivation fixtures must describe the same qbit Core commit.
    expect(harness.source.repository).toBe(fixture.core.repository)
    expect(harness.source.commit).toBe(fixture.core.commit)
  })

  it('records release provenance checked against the pinned operator keys and tag', () => {
    // The pin itself names the same release the fixture claims.
    expect(PINNED_SIGNERS.repository).toBe(fixture.core.repository)
    expect(PINNED_SIGNERS.tag).toBe(PINNED_CORE_TAG)
    expect(PINNED_SIGNERS.commit).toBe(PINNED_CORE_COMMIT)

    // --core-commit was resolved from the tag on the pinned repository, not
    // only asserted by the operator who ran the generator.
    expect(fixture.core.tagResolution).toEqual({
      method: 'git ls-remote',
      remote: `https://github.com/${PINNED_SIGNERS.repository}.git`,
      tagObjectSha: PINNED_SIGNERS.tagObjectSha,
    })

    // SHA256SUMS signatures were counted against the operator-key manifest
    // published in the qbit source tree at the release commit.
    expect(fixture.core.release.signerPolicy).toEqual({
      manifest: PINNED_SIGNERS.manifest.path,
      manifestBlobSha: PINNED_SIGNERS.manifest.blobSha,
      policyId: PINNED_SIGNERS.manifest.policyId,
      releaseLine: 'mainnet',
      releaseSignatureQuorum: PINNED_SIGNERS.manifest.releaseSignatureQuorum,
    })

    // Every recorded signer is a pinned operator (alias, signing subkey and
    // primary key all match), and distinct pinned operators meet the quorum.
    const signers = fixture.core.release.sha256sumsSignedBy
    for (const signer of signers) {
      const pinned = PINNED_SIGNERS.signers.find(candidate => candidate.alias === signer.alias)
      expect(pinned, `fixture signer ${signer.alias} is not a pinned operator`).toBeDefined()
      expect(signer).toEqual({
        alias: pinned?.alias,
        signingFingerprint: pinned?.signingFingerprint,
        primaryFingerprint: pinned?.primaryFingerprint,
      })
    }
    expect(new Set(signers.map(signer => signer.alias)).size).toBe(signers.length)
    expect(signers.length).toBeGreaterThanOrEqual(PINNED_SIGNERS.manifest.releaseSignatureQuorum)
  })

  it('covers the external descriptor range and an internal-chain vector', () => {
    const external = fixture.vectors.filter(vector => vector.chain === 'external')
    const internal = fixture.vectors.filter(vector => vector.chain === 'internal')

    expect(fixture.chains['external']?.range).toEqual([0, 4])
    expect(external.map(vector => vector.path.index)).toEqual([0, 1, 2, 3, 4])
    expect(internal.length).toBeGreaterThanOrEqual(1)
    expect(fixture.vectors).toHaveLength(external.length + internal.length)

    for (const vector of fixture.vectors) {
      const pathChange = vector.chain === 'external' ? 0 : 1
      const chain = fixture.chains[vector.chain]
      expect(chain).toBeDefined()
      expect(vector.descriptor).toBe(`mr(pk(pqc(${fixture.bip32.tprv}/87h/1h/0h/${pathChange}/*)))`)
      expect(chain?.descriptor.startsWith(`${vector.descriptor}#`)).toBe(true)
      expect(vector.path).toEqual({
        purpose: 87,
        coinType: 1,
        account: 0,
        change: pathChange,
        index: vector.path.index,
      })
      expect(vector.bip32Path).toBe(`m/87h/1h/0h/${pathChange}/${vector.path.index}`)
      expect(vector.leafCrossCheck.descriptor).toBe(
        `mr(pk(pqc(${fixture.bip32.tprv}/87h/1h/0h/${pathChange}/${vector.path.index})))`
      )
      // Core derives ranged pqc() keys with HKDF account=0, change=0,
      // index=position on both chains. The path change is not the HKDF change.
      expect(vector.hkdf).toEqual({ account: 0, change: 0, index: vector.path.index })
      if (vector.path.index === 0) {
        expect(vector.leafCrossCheck.address).toBe(vector.address)
      }
    }
  })

  for (const vector of fixture.vectors) {
    it(`derives the same pk32 as qbit Core for ${vector.name}`, () => {
      const leaf = hexToBytes(vector.leafPrivateKeyHex)
      expect(leaf).toHaveLength(32)
      expect(vector.publicKeyHex).toMatch(/^[0-9a-f]{64}$/)

      const derived = derivePQCKey(leaf, 0, 0, vector.path.index)
      expect(bytesToHex(derived.pk32)).toBe(vector.publicKeyHex)
      expect(derived.pk32).toHaveLength(constants.PK_SIZE)
      expect(derived.sk64).toHaveLength(constants.SK_SIZE)
      expect(bytesToHex(derived.sk64.slice(constants.SK_SIZE - constants.PK_SIZE))).toBe(vector.publicKeyHex)

      const generated = deriveP2mrDescriptorKey(leaf, vector.path.index)
      expect(bytesToHex(generated.pk32)).toBe(vector.publicKeyHex)
      expect(generated.sk64).toEqual(derived.sk64)

      // Core's address commits to exactly this pk32 as a single P2MR leaf.
      expect(vector.scriptPubKeyHex).toBe(`${WITNESS_V2_P2MR_PREFIX}${p2mrSingleLeafProgramHex(vector.publicKeyHex)}`)
      expect(vector.address.startsWith('qbrt1z')).toBe(true)
    })
  }

  // Each of these derivePQCKey calls returns a valid key that importing the
  // wallet's descriptor into qbit Core never finds.
  for (const vector of fixture.vectors) {
    it(`misses ${vector.name} with HKDF change 1, account 1 or a hardened index`, () => {
      const leaf = hexToBytes(vector.leafPrivateKeyHex)
      const { index } = vector.path
      const hardened = (index | HARDENED) >>> 0

      // The path's change field selects the leaf; it is not the HKDF change.
      expect(bytesToHex(derivePQCKey(leaf, 0, 1, index).pk32)).not.toBe(vector.publicKeyHex)
      expect(bytesToHex(derivePQCKey(leaf, 1, 0, index).pk32)).not.toBe(vector.publicKeyHex)
      expect(bytesToHex(derivePQCKey(leaf, 0, 0, hardened).pk32)).not.toBe(vector.publicKeyHex)
      expect(() => deriveP2mrDescriptorKey(leaf, hardened)).toThrow(RangeError)
    })
  }

  it("derives each leaf's un-ranged descriptor key with rangeIndex 0, as qbit Core does", () => {
    for (const vector of fixture.vectors) {
      // Control: the decoder recovers the program of Core's ranged address.
      expect(witnessProgramHex(vector.address)).toBe(vector.scriptPubKeyHex.slice(WITNESS_V2_P2MR_PREFIX.length))

      // Core derives the un-ranged mr(pk(pqc(<tprv>/87h/1h/0h/{change}/{index})))
      // with HKDF index 0, so it shares its key with the ranged descriptor only
      // at position 0.
      const unranged = bytesToHex(deriveP2mrDescriptorKey(hexToBytes(vector.leafPrivateKeyHex), 0).pk32)
      expect(vector.leafCrossCheck.address.startsWith('qbrt1z')).toBe(true)
      expect(witnessProgramHex(vector.leafCrossCheck.address), vector.name).toBe(p2mrSingleLeafProgramHex(unranged))
      expect(unranged === vector.publicKeyHex, vector.name).toBe(vector.path.index === 0)
    }
  })

  it('verifies and reproduces the qbit Core signdatapqchash vector', () => {
    const dataSignature = fixture.dataSignature
    const vector = findVector(dataSignature.vector)

    expect(dataSignature.rpc).toBe('signdatapqchash')
    expect(dataSignature.proofMode).toBe('p2mr-pubkey')
    expect(dataSignature.domain).toBe('QbitDataSigPQC')
    expect(dataSignature.publicKeyHex).toBe(vector.publicKeyHex)
    expect(dataSignature.leafVersion).toBe(P2MR_LEAF_VERSION)
    expect(dataSignature.leafScriptHex).toBe(`20${vector.publicKeyHex}b3`)
    expect(dataSignature.controlBlockHex).toBe('c1')
    expect(vector.scriptPubKeyHex).toBe(`${WITNESS_V2_P2MR_PREFIX}${dataSignature.p2mrMerkleRootHex}`)

    // Core signs ComputeQbitDataSigPQCHash(message_hash), the tagged hash of
    // the caller's 32-byte message hash, not the message hash itself.
    const messageHash = sha256(new TextEncoder().encode(dataSignature.messageUtf8))
    expect(bytesToHex(messageHash)).toBe(dataSignature.messageHashHex)
    const datasigHash = taggedHash('QbitDataSigPQC', messageHash)
    expect(bytesToHex(datasigHash)).toBe(dataSignature.datasigHashHex)

    const signature = hexToBytes(dataSignature.signatureHex)
    expect(signature).toHaveLength(constants.SIG_SIZE)

    const derived = derivePQCKey(hexToBytes(vector.leafPrivateKeyHex), 0, 0, vector.path.index)
    expect(bytesToHex(derived.pk32)).toBe(dataSignature.publicKeyHex)
    expect(client.verify(derived.pk32, datasigHash, signature)).toBe(true)
    expect(client.verify(derived.pk32, messageHash, signature)).toBe(false)

    // bounded30 signing is deterministic: the package must reproduce Core's
    // signature bytes exactly from the derived secret key.
    expect(bytesToHex(client.sign(derived.sk64, datasigHash))).toBe(dataSignature.signatureHex)
  })
})
