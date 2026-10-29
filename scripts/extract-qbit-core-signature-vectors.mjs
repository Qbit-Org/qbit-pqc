#!/usr/bin/env node
// Extracts a small, consensus-sourced SLH-DSA signature fixture from qbit Core's
// src/test/data/p2mr_pqc_witness_vectors.json, so the package's verify and
// deterministic sign are checked against signatures Core itself ships.
//
// Fetch the pinned source file, then write (or --check) the fixture from the
// repository root:
//
//   gh api "repos/Qbit-Org/qbit/contents/src/test/data/p2mr_pqc_witness_vectors.json?ref=7ebcddb622d6e639041f005a189b048ec2a221fe" \
//     -H "Accept: application/vnd.github.raw" > /tmp/p2mr_pqc_witness_vectors.json
//   node scripts/extract-qbit-core-signature-vectors.mjs --source /tmp/p2mr_pqc_witness_vectors.json [--check]
//
// The source must be byte-identical to the pinned git blob; nothing in the
// fixture is computed by this package.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = join(packageRoot, 'fixtures', 'qbit-core-signature-vectors.json')

export const CORE_SOURCE = {
  repository: 'Qbit-Org/qbit',
  tag: 'v1.0.0',
  commit: '7ebcddb622d6e639041f005a189b048ec2a221fe',
  path: 'src/test/data/p2mr_pqc_witness_vectors.json',
  gitBlob: 'd9a3690645323a10bbb29a311f6db5928fd05b5f',
}

const SIG_HEX_LENGTH = 3680 * 2

// Core's generator derives its three keys from libbitcoinpqc keygen with
// 128-byte random_data filled with these bytes (see each vector's provenance).
const KEY_FILLS = { A: 0x20, B: 0x21, C: 0x22 }

function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function vectorNamed(source, name) {
  if (!Array.isArray(source.vectors)) throw new Error('source has no vectors array')
  const vector = source.vectors.find(candidate => candidate.name === name)
  if (vector === undefined) throw new Error(`source has no vector named ${name}`)
  return vector
}

// A P2MR witness signature is the 3680-byte SLH-DSA signature, followed by a
// sighash-type byte unless the type is SIGHASH_DEFAULT.
function slhSignature(witnessSignatureHex, hashType, label) {
  if (typeof witnessSignatureHex !== 'string' || !/^[0-9a-f]*$/.test(witnessSignatureHex)) {
    throw new Error(`${label} is not lowercase hex`)
  }
  const expectedLength = hashType === '00' ? SIG_HEX_LENGTH : SIG_HEX_LENGTH + 2
  if (witnessSignatureHex.length !== expectedLength) {
    throw new Error(`${label} is ${witnessSignatureHex.length / 2} bytes for hashType ${hashType}`)
  }
  if (hashType !== '00' && witnessSignatureHex.slice(SIG_HEX_LENGTH) !== hashType) {
    throw new Error(`${label} does not end with hashType ${hashType}`)
  }
  return witnessSignatureHex.slice(0, SIG_HEX_LENGTH)
}

// Messages are 32-byte digests and public keys are 32 bytes; fail on a missing
// or renamed source field instead of writing a fixture without it.
function hex32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not 32 bytes of lowercase hex`)
  }
  return value
}
const digest = hex32
const publicKeyHex = hex32

// The fills are stated only in Core's provenance prose, in key order A, B, C;
// fail extraction if a new pin words them differently rather than writing
// stale fills.
function requireFillsInProvenance(text) {
  const [a, b, c] = [KEY_FILLS.A, KEY_FILLS.B, KEY_FILLS.C].map(fill => `0x${fill.toString(16)}`)
  const phrase = `random_data fills ${a}, ${b}, and ${c};`
  if (typeof text !== 'string' || !text.includes(phrase)) {
    throw new Error(`dataSigProvenance no longer says "${phrase}"`)
  }
}

function requireAccepted(vector) {
  if (vector.expected?.accepted !== true) throw new Error(`${vector.name} is not an accepted vector`)
}

export function buildFixture(sourceBytes) {
  const blob = gitBlobSha(sourceBytes)
  if (blob !== CORE_SOURCE.gitBlob) {
    throw new Error(`source git blob ${blob} does not match pinned ${CORE_SOURCE.gitBlob}`)
  }
  const source = JSON.parse(sourceBytes.toString('utf8'))

  const defaultSighash = vectorNamed(source, 'single_key_default_sighash')
  const sighashNone = vectorNamed(source, 'single_key_sighash_none')
  requireAccepted(defaultSighash)
  requireAccepted(sighashNone)
  const dataSigAdd = defaultSighash.dataSigAdd
  if (dataSigAdd === null || typeof dataSigAdd !== 'object')
    throw new Error('single_key_default_sighash has no dataSigAdd')
  requireFillsInProvenance(defaultSighash.dataSigProvenance)

  const keys = {
    A: { randomDataFill: KEY_FILLS.A, publicKey: publicKeyHex(dataSigAdd?.pubkeyA, 'dataSigAdd.pubkeyA') },
    B: { randomDataFill: KEY_FILLS.B, publicKey: publicKeyHex(dataSigAdd?.pubkeyB, 'dataSigAdd.pubkeyB') },
    C: { randomDataFill: KEY_FILLS.C, publicKey: publicKeyHex(dataSigAdd?.pubkeyC, 'dataSigAdd.pubkeyC') },
  }
  if (defaultSighash.pubkey !== keys.A.publicKey) throw new Error('default-sighash vector is not signed by key A')
  if (sighashNone.pubkey !== keys.B.publicKey) throw new Error('sighash-none vector is not signed by key B')
  if (defaultSighash.dataSigPubkey !== keys.A.publicKey) throw new Error('data signature is not by key A')

  if (defaultSighash.hashType !== '00') throw new Error('single_key_default_sighash.hashType is not 00')
  if (sighashNone.hashType !== '02') throw new Error('single_key_sighash_none.hashType is not 02')
  const defaultSig = slhSignature(defaultSighash.signature, '00', 'single_key_default_sighash.signature')
  const noneSig = slhSignature(sighashNone.signature, '02', 'single_key_sighash_none.signature')
  const dataSigC = slhSignature(dataSigAdd.signatureC, '00', 'dataSigAdd.signatureC')
  const rawMessageSigA = slhSignature(
    defaultSighash.dataSigRawMessageSignature,
    '00',
    'single_key_default_sighash.dataSigRawMessageSignature'
  )

  // Accepted cases carry the exact SLH-DSA signature Core ships; deterministic
  // signing with the regenerated key must reproduce it byte for byte.
  const accept = [
    {
      name: 'p2mr_sighash_default',
      from: 'single_key_default_sighash.signature',
      key: 'A',
      message: digest(defaultSighash.p2mrSighash, 'single_key_default_sighash.p2mrSighash'),
      signature: defaultSig,
    },
    {
      name: 'p2mr_sighash_none',
      from: 'single_key_sighash_none.signature (hashType byte 0x02 stripped)',
      key: 'B',
      message: digest(sighashNone.p2mrSighash, 'single_key_sighash_none.p2mrSighash'),
      signature: noneSig,
    },
    {
      name: 'datapqchash_key_c',
      from: 'single_key_default_sighash.dataSigAdd.signatureC',
      key: 'C',
      message: digest(dataSigAdd.dataSigHash, 'dataSigAdd.dataSigHash'),
      signature: dataSigC,
    },
    {
      name: 'raw_message_hash_key_a',
      from: 'single_key_default_sighash.dataSigRawMessageSignature',
      key: 'A',
      message: digest(defaultSighash.dataSigMessageHash, 'single_key_default_sighash.dataSigMessageHash'),
      signature: rawMessageSigA,
    },
  ]

  // Rejected cases reuse the signatures above, so they add no signature bytes.
  const reject = [
    {
      name: 'p2mr_sighash_wrong_domain',
      reason: 'signature over the P2MR sighash checked against the wrong-domain sighash',
      key: 'A',
      message: digest(defaultSighash.wrongDomainSighash, 'single_key_default_sighash.wrongDomainSighash'),
      signatureOf: 'p2mr_sighash_default',
    },
    {
      name: 'p2mr_sighash_wrong_key',
      reason: 'key A signature checked against key B',
      key: 'B',
      message: digest(defaultSighash.p2mrSighash, 'single_key_default_sighash.p2mrSighash'),
      signatureOf: 'p2mr_sighash_default',
    },
    {
      name: 'datapqchash_wrong_message',
      reason: 'data signature checked against Core wrongMessageHash',
      key: 'C',
      message: digest(dataSigAdd.wrongMessageHash, 'dataSigAdd.wrongMessageHash'),
      signatureOf: 'datapqchash_key_c',
    },
    {
      name: 'raw_signature_for_datapqchash',
      reason: 'signature over the raw message hash checked against the tagged data hash',
      key: 'A',
      message: digest(defaultSighash.dataSigHash, 'single_key_default_sighash.dataSigHash'),
      signatureOf: 'raw_message_hash_key_a',
    },
  ]

  return {
    schemaVersion: 1,
    name: 'qbit-core-signature-vectors',
    description:
      'SLH-DSA-SHA2-128s-bounded30 signatures copied from qbit Core test data, for verify and deterministic-sign parity. Generated by scripts/extract-qbit-core-signature-vectors.mjs.',
    algorithm: 'SLH-DSA-SHA2-128s-bounded30',
    source: {
      ...CORE_SOURCE,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      schemaVersion: source.schema_version,
      profile: source.profile,
    },
    keys,
    accept,
    reject,
  }
}

function main(argv) {
  let sourcePath
  let out = DEFAULT_OUT
  let check = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--source' || arg === '--out') {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a path`)
      if (arg === '--source') sourcePath = value
      else out = resolve(value)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!sourcePath) throw new Error('--source <p2mr_pqc_witness_vectors.json> is required')

  const text = `${JSON.stringify(buildFixture(readFileSync(sourcePath)), null, 2)}\n`
  if (check) {
    if (readFileSync(out, 'utf8') !== text) throw new Error(`${out} differs from the regenerated fixture`)
    console.log(`${out} matches ${CORE_SOURCE.repository}@${CORE_SOURCE.commit}:${CORE_SOURCE.path}`)
  } else {
    writeFileSync(out, text)
    console.log(`wrote ${out}`)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`extract-qbit-core-signature-vectors: ${error.message}`)
    process.exit(1)
  }
}
