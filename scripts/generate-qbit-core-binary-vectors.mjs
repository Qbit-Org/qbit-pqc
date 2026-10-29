#!/usr/bin/env node
// Generate fixtures/qbit-core-binary-derivation.json from an UNMODIFIED qbit
// Core release binary running on regtest.
//
// The fixture is an independent oracle for derivePQCKey(): every pk32 in it was
// produced by qbit Core itself (deriveaddresses + importdescriptors +
// getaddressinfo), not by this repository's vendored libbitcoinpqc or by any
// re-implementation of Core's DerivePQCKey. The only local cryptography is the
// BIP32 leaf derivation below, and every leaf key is cross-checked against Core
// before it is written: Core given <tprv>/<path>/<index> and Core given our
// leaf key as a standalone tprv must derive the same (un-ranged) P2MR address.
//
// Release provenance: the tarball must match the published SHA256SUMS, and
// SHA256SUMS must carry the mainnet release quorum of signatures from the
// operator keys pinned in scripts/qbit-core-release-signers.mjs (taken from
// contrib/keys/operator-keys/keys.json at the release commit). Keys given with
// --signer-keys are only material for gpg; a signature counts only if both its
// signing and primary fingerprints match a pinned operator. --core-tag is
// resolved to its commit with `git ls-remote` against the pinned repository and
// must equal --core-commit, which must also equal the pinned release.
//
// Rerun (see docs/derivation.md, "Core Binary Oracle"):
//
//   node scripts/generate-qbit-core-binary-vectors.mjs \
//     --tarball <dir>/qbit-1.0.0-x86_64-linux-gnu.tar.gz \
//     --sha256sums <dir>/SHA256SUMS \
//     --sha256sums-asc <dir>/SHA256SUMS.asc \
//     --signer-keys <dir-with-operator-*-release.asc> \
//     --core-tag v1.0.0 \
//     --core-commit 7ebcddb622d6e639041f005a189b048ec2a221fe
//
// Add --check to compare the generated JSON with the committed fixture instead
// of overwriting it (exit 1 on any difference).
//
// Repository-only: scripts/ is excluded from the npm tarball by
// scripts/pack-policy.mjs. Node built-ins only; no dependencies.

import { spawn, execFile as execFileCb } from 'node:child_process'
import { createECDH, createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { QBIT_CORE_RELEASE_SIGNERS } from './qbit-core-release-signers.mjs'
import { installTerminationHandlers } from './termination-handlers.mjs'

const execFile = promisify(execFileCb)

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

const FIXTURE_NAME = 'qbit-core-binary-derivation'
const FIXTURE_SCHEMA_VERSION = 1
const DEFAULT_OUT = join(repoRoot, 'fixtures', `${FIXTURE_NAME}.json`)

// BIP32 test vector 1 seed. Public test data; never use it for real funds.
const BIP32_TEST_VECTOR_1_SEED_HEX = '000102030405060708090a0b0c0d0e0f'
const PURPOSE = 87
const REGTEST_COIN_TYPE = 1
const ACCOUNT = 0
// Fixed ranges keep reruns byte-identical.
const CHAINS = [
  { name: 'external', pathChange: 0, range: [0, 4] },
  { name: 'internal', pathChange: 1, range: [0, 1] },
]
const DATA_SIGNATURE_MESSAGE_UTF8 = 'qbit-pqc:qbit-core-binary-derivation:signdatapqchash'

const RPC_READY_TIMEOUT_MS = 60_000
const RPC_STOP_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/generate-qbit-core-binary-vectors.mjs',
  '         --tarball <qbit-<ver>-<platform>.tar.gz> --sha256sums <SHA256SUMS>',
  '         --sha256sums-asc <SHA256SUMS.asc> --signer-keys <dir of operator-*.asc>',
  '         --core-tag <vX.Y.Z> --core-commit <40-hex>',
  '         [--out <fixture.json>] [--check]',
  '',
  `--core-tag/--core-commit must match the pinned release (${QBIT_CORE_RELEASE_SIGNERS.tag},`,
  `${QBIT_CORE_RELEASE_SIGNERS.commit}) in scripts/qbit-core-release-signers.mjs; the`,
  `SHA256SUMS quorum (${QBIT_CORE_RELEASE_SIGNERS.manifest.releaseSignatureQuorum}) is taken from the pinned operator-key manifest.`,
].join('\n')

function usage(message) {
  throw new Error(`error: ${message}\n${USAGE}`)
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, check: false }
  const valued = new Map([
    ['--tarball', 'tarball'],
    ['--sha256sums', 'sha256sums'],
    ['--sha256sums-asc', 'sha256sumsAsc'],
    ['--signer-keys', 'signerKeys'],
    ['--core-tag', 'coreTag'],
    ['--core-commit', 'coreCommit'],
    ['--out', 'out'],
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') {
      options.check = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    const key = valued.get(arg)
    if (key === undefined) usage(`unknown argument ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) usage(`${arg} requires a value`)
    options[key] = value
    i += 1
  }

  for (const key of ['tarball', 'sha256sums', 'sha256sumsAsc', 'signerKeys', 'coreTag', 'coreCommit']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) usage(`missing --${camelToFlag(key)}`)
  }
  for (const key of ['tarball', 'sha256sums', 'sha256sumsAsc']) {
    options[key] = resolve(options[key])
    if (!isFile(options[key])) usage(`--${camelToFlag(key)} is not a file: ${options[key]}`)
  }
  options.signerKeys = resolve(options.signerKeys)
  if (!isDirectory(options.signerKeys)) usage(`--signer-keys is not a directory: ${options.signerKeys}`)
  if (!/^v\d+\.\d+\.\d+$/.test(options.coreTag)) usage(`--core-tag must look like vX.Y.Z, got ${options.coreTag}`)
  if (!/^[0-9a-f]{40}$/.test(options.coreCommit)) usage('--core-commit must be a 40-character lowercase hex commit id')
  // The pinned operator keys are only known to be the release policy at the
  // pinned commit. Bumping Core means re-pinning scripts/qbit-core-release-signers.mjs.
  if (options.coreTag !== QBIT_CORE_RELEASE_SIGNERS.tag || options.coreCommit !== QBIT_CORE_RELEASE_SIGNERS.commit) {
    usage(
      `--core-tag ${options.coreTag} / --core-commit ${options.coreCommit} do not match the pinned release ` +
        `${QBIT_CORE_RELEASE_SIGNERS.tag} / ${QBIT_CORE_RELEASE_SIGNERS.commit}; re-pin scripts/qbit-core-release-signers.mjs ` +
        `from ${QBIT_CORE_RELEASE_SIGNERS.manifest.path} at the new release commit first`
    )
  }
  options.out = resolve(options.out)
  return options
}

function camelToFlag(key) {
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Hashing / encoding helpers
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash('sha256').update(data).digest()
}

function hash160(data) {
  return createHash('ripemd160').update(sha256(data)).digest()
}

function sha256File(path) {
  return sha256(readFileSync(path)).toString('hex')
}

function taggedHash(tag, data) {
  const tagHash = sha256(Buffer.from(tag, 'utf8'))
  return sha256(Buffer.concat([tagHash, tagHash, data]))
}

function compactSize(n) {
  if (n < 0xfd) return Buffer.from([n])
  throw new RangeError(`compactSize only implemented for < 0xfd, got ${n}`)
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58check(payload) {
  const checksum = sha256(sha256(payload)).subarray(0, 4)
  const bytes = Buffer.concat([payload, checksum])
  let n = BigInt(`0x${bytes.toString('hex')}`)
  let out = ''
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

// execFile sets stderr to '' on spawn-level failures; fall back to the message.
function errorText(error) {
  return (typeof error.stderr === 'string' && error.stderr.trim()) || error.message
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ---------------------------------------------------------------------------
// Independent BIP32 (private derivation only), built on node:crypto.
// This is deliberately not Core's code and not this package's code.
// ---------------------------------------------------------------------------

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const BIP32_HARDENED = 0x80000000
const XPRV_VERSION = 0x0488ade4
const TPRV_VERSION = 0x04358394

function bufferToBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`)
}

function bigIntToScalar(n) {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
}

function secp256k1CompressedPublicKey(privateKey) {
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(privateKey)
  return ecdh.getPublicKey(null, 'compressed')
}

function bip32MasterFromSeed(seed) {
  const I = createHmac('sha512', 'Bitcoin seed').update(seed).digest()
  const key = Buffer.from(I.subarray(0, 32))
  const k = bufferToBigInt(key)
  if (k === 0n || k >= SECP256K1_N) throw new Error('invalid BIP32 master key for seed')
  return { key, chainCode: Buffer.from(I.subarray(32)), depth: 0, parentFingerprint: Buffer.alloc(4), childNumber: 0 }
}

function bip32CkdPriv(node, index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError(`bad child index ${index}`)
  const serIndex = Buffer.alloc(4)
  serIndex.writeUInt32BE(index)
  const parentPublicKey = secp256k1CompressedPublicKey(node.key)
  const data = index >= BIP32_HARDENED ? Buffer.concat([Buffer.from([0]), node.key]) : parentPublicKey
  const I = createHmac('sha512', node.chainCode)
    .update(Buffer.concat([data, serIndex]))
    .digest()
  const il = bufferToBigInt(I.subarray(0, 32))
  if (il >= SECP256K1_N) throw new Error(`invalid child key at index ${index} (IL >= n)`)
  const k = (il + bufferToBigInt(node.key)) % SECP256K1_N
  if (k === 0n) throw new Error(`invalid child key at index ${index} (k == 0)`)
  return {
    key: bigIntToScalar(k),
    chainCode: Buffer.from(I.subarray(32)),
    depth: node.depth + 1,
    parentFingerprint: Buffer.from(hash160(parentPublicKey).subarray(0, 4)),
    childNumber: index,
  }
}

function bip32ParsePath(path) {
  const parts = path.split('/')
  if (parts[0] !== 'm') throw new Error(`BIP32 path must start with m: ${path}`)
  return parts.slice(1).map(part => {
    const match = /^(\d+)(h|H|')?$/.exec(part)
    if (match === null) throw new Error(`bad BIP32 path element ${part} in ${path}`)
    const n = Number(match[1])
    if (n >= BIP32_HARDENED) throw new RangeError(`BIP32 path index too large: ${part}`)
    return match[2] === undefined ? n : n + BIP32_HARDENED
  })
}

function bip32DerivePath(master, path) {
  return bip32ParsePath(path).reduce((node, index) => bip32CkdPriv(node, index), master)
}

function bip32SerializePrivate(node, version) {
  const versionBytes = Buffer.alloc(4)
  versionBytes.writeUInt32BE(version)
  const childNumber = Buffer.alloc(4)
  childNumber.writeUInt32BE(node.childNumber)
  return base58check(
    Buffer.concat([
      versionBytes,
      Buffer.from([node.depth]),
      node.parentFingerprint,
      childNumber,
      node.chainCode,
      Buffer.from([0]),
      node.key,
    ])
  )
}

// Self-test the BIP32 code against published BIP32 test vectors before trusting
// it for anything. (bip-0032.mediawiki, test vectors 1-3.)
function bip32SelfTest() {
  const vectors = [
    [
      '000102030405060708090a0b0c0d0e0f',
      'm',
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    ],
    [
      '000102030405060708090a0b0c0d0e0f',
      'm/0h/1/2h/2/1000000000',
      'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
    ],
    [
      'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
      'm/0/2147483647h/1/2147483646h/2',
      'xprvA2nrNbFZABcdryreWet9Ea4LvTJcGsqrMzxHx98MMrotbir7yrKCEXw7nadnHM8Dq38EGfSh6dqA9QWTyefMLEcBYJUuekgW4BYPJcr9E7j',
    ],
    [
      '4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be',
      'm/0h',
      'xprv9uPDJpEQgRQfDcW7BkF7eTya6RPxXeJCqCJGHuCJ4GiRVLzkTXBAJMu2qaMWPrS7AANYqdq6vcBcBUdJCVVFceUvJFjaPdGZ2y9WACViL4L',
    ],
  ]
  for (const [seedHex, path, expected] of vectors) {
    const node = bip32DerivePath(bip32MasterFromSeed(Buffer.from(seedHex, 'hex')), path)
    assertEqual(bip32SerializePrivate(node, XPRV_VERSION), expected, `BIP32 self-test ${path}`)
  }
}

// ---------------------------------------------------------------------------
// Release artifact verification
// ---------------------------------------------------------------------------

function verifyTarballChecksum(tarballPath, sha256sumsPath) {
  const asset = basename(tarballPath)
  const expectedByName = new Map()
  for (const line of readFileSync(sha256sumsPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (match === null) throw new Error(`unparseable SHA256SUMS line: ${JSON.stringify(line)}`)
    expectedByName.set(match[2], match[1])
  }
  const expected = expectedByName.get(asset)
  if (expected === undefined) throw new Error(`${asset} is not listed in ${sha256sumsPath}`)
  const actual = sha256File(tarballPath)
  assertEqual(actual, expected, `sha256(${asset}) does not match SHA256SUMS`)
  return { asset, sha256: actual }
}

// Verify SHA256SUMS.asc against the pinned operator keys. `trusted` is
// QBIT_CORE_RELEASE_SIGNERS (or, in tests, an object of the same shape): the
// keys in signerKeysDir only let gpg check signatures; a signature counts
// toward the quorum only if its signing fingerprint is a pinned
// signingFingerprint AND the key's primary fingerprint is that signer's pinned
// primaryFingerprint. Returns the pinned signers that signed, sorted by alias.
export async function verifySha256sumsSignatures(sha256sumsPath, ascPath, signerKeysDir, trusted) {
  const quorum = trusted.manifest.releaseSignatureQuorum
  if (!Number.isInteger(quorum) || quorum < 1)
    throw new Error(`pinned release quorum must be a positive integer, got ${quorum}`)
  // One pinned entry per operator key: a primary key listed under two aliases
  // (or a fingerprint used as both a signing and a primary key) would let one
  // operator count twice toward the quorum.
  const pinnedBySigningFingerprint = new Map()
  const pinnedPrimaryFingerprints = new Set()
  for (const signer of trusted.signers) {
    if (pinnedBySigningFingerprint.has(signer.signingFingerprint)) {
      throw new Error(`pinned signing fingerprint ${signer.signingFingerprint} is listed twice`)
    }
    if (pinnedPrimaryFingerprints.has(signer.primaryFingerprint)) {
      throw new Error(`pinned primary fingerprint ${signer.primaryFingerprint} is listed twice`)
    }
    pinnedBySigningFingerprint.set(signer.signingFingerprint, signer)
    pinnedPrimaryFingerprints.add(signer.primaryFingerprint)
  }
  for (const fingerprint of pinnedPrimaryFingerprints) {
    if (pinnedBySigningFingerprint.has(fingerprint)) {
      throw new Error(`pinned fingerprint ${fingerprint} is listed as both a signing and a primary key`)
    }
  }
  if (pinnedBySigningFingerprint.size < quorum) {
    throw new Error(`only ${pinnedBySigningFingerprint.size} pinned signers for a quorum of ${quorum}`)
  }

  const keyFiles = readdirSync(signerKeysDir)
    .filter(name => name.endsWith('.asc'))
    .sort()
    .map(name => join(signerKeysDir, name))
  if (keyFiles.length === 0) throw new Error(`no .asc public keys in ${signerKeysDir}`)

  const gnupgHome = mkdtempSync(join(tmpdir(), 'qbit-core-oracle-gnupg-'))
  const env = { ...process.env, GNUPGHOME: gnupgHome }
  try {
    await execFile('gpg', ['--batch', '--quiet', '--import', ...keyFiles], { env }).catch(error => {
      throw new Error(`gpg --import failed for ${signerKeysDir}:\n${errorText(error)}`)
    })
    // gpg exits non-zero when any signature cannot be verified (for example a
    // signer whose key is not in --signer-keys). Decide from the status lines
    // instead, so the pinned-key quorum rule below is what accepts or rejects.
    const { stdout, stderr } = await execFile(
      'gpg',
      ['--batch', '--status-fd', '1', '--verify', ascPath, sha256sumsPath],
      { env }
    ).catch(error => {
      if (typeof error.stdout !== 'string' || !error.stdout.includes('[GNUPG:]')) {
        throw new Error(`gpg --verify failed:\n${errorText(error)}`)
      }
      return { stdout: error.stdout, stderr: error.stderr ?? '' }
    })
    // Keyed by pinned alias, so several signatures from one operator (or from
    // several subkeys of one primary key) count once.
    const signers = new Map()
    let bad = 0
    let unverifiable = 0
    let untrusted = 0
    for (const line of stdout.split('\n')) {
      // VALIDSIG <fingerprint> <date> <timestamp> <expiry> <version> <reserved> <pubkey-algo> <hash-algo> <class> <primary-fingerprint>
      const valid = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})(?: \S+){8} ([0-9A-F]{40})\b/.exec(line)
      if (valid !== null) {
        const [, signingFingerprint, primaryFingerprint] = valid
        const pinned = pinnedBySigningFingerprint.get(signingFingerprint)
        // A cryptographically valid signature from a key that is not pinned
        // (including a pinned operator's primary key rather than its pinned
        // signing subkey) never counts, whatever --signer-keys contains.
        if (pinned === undefined || pinned.primaryFingerprint !== primaryFingerprint) {
          untrusted += 1
          continue
        }
        signers.set(pinned.alias, { alias: pinned.alias, signingFingerprint, primaryFingerprint })
        continue
      }
      // A signature by a key that is not in --signer-keys cannot be checked;
      // it does not count toward the quorum but is not a failure by itself.
      if (/^\[GNUPG:\] ERRSIG\b/.test(line)) unverifiable += 1
      // A wrong signature, or one from a revoked/expired key, is a failure.
      if (/^\[GNUPG:\] (BADSIG|REVKEYSIG|EXPKEYSIG|EXPSIG)\b/.test(line)) bad += 1
    }
    if (bad > 0 || signers.size < quorum) {
      throw new Error(
        `SHA256SUMS signature verification failed: ${signers.size} valid from pinned operator keys (quorum ${quorum}), ` +
          `${untrusted} valid from keys that are not pinned, ${bad} bad, ${unverifiable} from keys not in --signer-keys\n${stderr}`
      )
    }
    return {
      signers: [...signers.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
      untrusted,
      unverifiable,
    }
  } finally {
    // Import/verify may have started a gpg-agent for this home; stop it before
    // removing the directory. Best effort: nothing depends on it.
    await execFile('gpgconf', ['--kill', 'all'], { env }).catch(() => {})
    rmSync(gnupgHome, { recursive: true, force: true })
  }
}

// `git ls-remote <remote> refs/tags/<tag> refs/tags/<tag>^{}` prints the tag
// ref and, for an annotated tag, the peeled commit. Returns the commit the tag
// resolves to and the annotated tag object id (null for a lightweight tag).
export function parseLsRemoteTag(stdout, remote, tag) {
  const refs = new Map()
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line)
    if (match === null) throw new Error(`unparseable git ls-remote line from ${remote}: ${JSON.stringify(line)}`)
    refs.set(match[2], match[1])
  }
  const ref = refs.get(`refs/tags/${tag}`)
  if (ref === undefined) throw new Error(`${remote} has no refs/tags/${tag}`)
  const peeled = refs.get(`refs/tags/${tag}^{}`)
  return peeled === undefined ? { commit: ref, tagObjectSha: null } : { commit: peeled, tagObjectSha: ref }
}

export async function resolveReleaseTag(remote, tag) {
  const { stdout } = await execFile('git', ['ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).catch(
    error => {
      throw new Error(`git ls-remote ${remote} refs/tags/${tag} failed: ${errorText(error)}`)
    }
  )
  return parseLsRemoteTag(stdout, remote, tag)
}

async function extractRelease(tarballPath, stageDir) {
  await execFile('tar', ['-xzf', tarballPath, '-C', stageDir])
  const entries = readdirSync(stageDir)
  if (entries.length !== 1) throw new Error(`expected one top-level directory in tarball, got ${entries.join(', ')}`)
  const binDir = join(stageDir, entries[0], 'bin')
  const qbitd = join(binDir, 'qbitd')
  const qbitCli = join(binDir, 'qbit-cli')
  for (const path of [qbitd, qbitCli]) {
    if (!isFile(path)) throw new Error(`release tarball did not contain ${path}`)
  }
  return { qbitd, qbitCli }
}

async function readCoreVersion(qbitd, expectedTag) {
  const { stdout } = await execFile(qbitd, ['--version']).catch(error => {
    throw new Error(`${qbitd} --version failed: ${errorText(error)}`)
  })
  const firstLine = stdout.split('\n')[0].trim()
  const match = /^qbit daemon version (v\d+\.\d+\.\d+)\b/.exec(firstLine)
  if (match === null) throw new Error(`unexpected qbitd --version output: ${JSON.stringify(firstLine)}`)
  assertEqual(match[1], expectedTag, 'qbitd --version does not match --core-tag')
  return firstLine
}

// ---------------------------------------------------------------------------
// Regtest node lifecycle and RPC
// ---------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

class RegtestNode {
  constructor(binaries, datadir, rpcPort) {
    this.binaries = binaries
    this.datadir = datadir
    this.rpcPort = rpcPort
    this.child = undefined
    this.exited = undefined
    this.stderr = []
  }

  async start() {
    this.child = spawn(
      this.binaries.qbitd,
      [
        '-regtest',
        `-datadir=${this.datadir}`,
        '-server=1',
        '-listen=0',
        '-dnsseed=0',
        '-rpcbind=127.0.0.1',
        '-rpcallowip=127.0.0.1',
        `-rpcport=${this.rpcPort}`,
        '-printtoconsole=0',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    this.child.stderr.on('data', chunk => {
      this.stderr.push(String(chunk))
      if (this.stderr.length > 50) this.stderr.shift()
    })
    this.exited = new Promise(resolveExit => {
      this.child.on('exit', (code, signal) => resolveExit({ code, signal }))
    })

    const deadline = Date.now() + RPC_READY_TIMEOUT_MS
    for (;;) {
      if (hasExited(this.child)) {
        throw new Error(
          `qbitd exited early (code ${this.child.exitCode}, signal ${this.child.signalCode}):\n${this.stderr.join('')}`
        )
      }
      try {
        await this.rpc('getblockchaininfo')
        return
      } catch {
        if (Date.now() > deadline) throw new Error(`qbitd RPC did not become ready within ${RPC_READY_TIMEOUT_MS} ms`)
        await sleep(250)
      }
    }
  }

  async rpc(method, ...params) {
    return this.cli([method, ...params.map(p => (typeof p === 'string' ? p : JSON.stringify(p)))])
  }

  async walletRpc(wallet, method, ...params) {
    return this.cli([
      `-rpcwallet=${wallet}`,
      method,
      ...params.map(p => (typeof p === 'string' ? p : JSON.stringify(p))),
    ])
  }

  async cli(args) {
    const { stdout } = await execFile(
      this.binaries.qbitCli,
      ['-regtest', `-datadir=${this.datadir}`, `-rpcport=${this.rpcPort}`, ...args],
      { maxBuffer: 16 * 1024 * 1024 }
    ).catch(error => {
      throw new Error(
        `qbit-cli ${args[0]}${args[0].startsWith('-rpcwallet') ? ` ${args[1]}` : ''} failed: ${errorText(error)}`
      )
    })
    const text = stdout.trim()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async stop() {
    if (this.child === undefined || hasExited(this.child)) return
    try {
      await this.cli(['stop'])
    } catch {
      this.child.kill('SIGTERM')
    }
    let timer
    const timeout = new Promise(resolveTimeout => {
      timer = setTimeout(() => resolveTimeout(undefined), RPC_STOP_TIMEOUT_MS)
    })
    const result = await Promise.race([this.exited, timeout])
    clearTimeout(timer)
    if (result === undefined) {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }
}

// ---------------------------------------------------------------------------
// Vector generation
// ---------------------------------------------------------------------------

async function withChecksum(node, descriptor) {
  const info = await node.rpc('getdescriptorinfo', descriptor)
  if (typeof info?.checksum !== 'string') throw new Error(`getdescriptorinfo returned no checksum for ${descriptor}`)
  return { descriptor: `${descriptor}#${info.checksum}`, normalized: info.descriptor }
}

// deriveaddresses for an un-ranged descriptor (Core rejects a range argument).
async function deriveSingle(node, descriptor) {
  const addresses = await node.rpc('deriveaddresses', descriptor)
  if (!Array.isArray(addresses) || addresses.length !== 1 || typeof addresses[0] !== 'string') {
    throw new Error(`deriveaddresses ${descriptor} returned ${JSON.stringify(addresses)}`)
  }
  return addresses[0]
}

function parseP2mrPubkeyDescriptor(desc) {
  const match = /^mr\(pk\(([0-9a-f]{64})\)\)#[0-9a-z]{8}$/.exec(desc)
  if (match === null) throw new Error(`getaddressinfo desc is not a single-key P2MR pubkey descriptor: ${desc}`)
  return match[1]
}

function expectedP2mrSingleLeafProgram(pk32Hex) {
  // Core: ComputeP2MRLeafHash(0xc0, <pk32> OP_CHECKSIGPQC) is the Merkle root
  // of a single-leaf P2MR tree. Verified below against Core's p2mr_merkle_root.
  const leafScript = Buffer.concat([Buffer.from([0x20]), Buffer.from(pk32Hex, 'hex'), Buffer.from([0xb3])])
  return taggedHash(
    'P2MRLeaf',
    Buffer.concat([Buffer.from([0xc0]), compactSize(leafScript.length), leafScript])
  ).toString('hex')
}

async function generateChainVectors(node, wallet, master, tprv, chain) {
  const bare = `mr(pk(pqc(${tprv}/${PURPOSE}h/${REGTEST_COIN_TYPE}h/${ACCOUNT}h/${chain.pathChange}/*)))`
  const { descriptor, normalized } = await withChecksum(node, bare)
  const [lo, hi] = chain.range

  const addresses = await node.rpc('deriveaddresses', descriptor, chain.range)
  if (!Array.isArray(addresses) || addresses.length !== hi - lo + 1) {
    throw new Error(`deriveaddresses returned ${addresses?.length} addresses for range [${lo},${hi}]`)
  }

  const imported = await node.walletRpc(wallet, 'importdescriptors', [
    { desc: descriptor, timestamp: 'now', range: chain.range, active: false },
  ])
  if (!Array.isArray(imported) || imported.length !== 1 || imported[0]?.success !== true) {
    throw new Error(`importdescriptors failed: ${JSON.stringify(imported)}`)
  }

  const vectors = []
  for (let index = lo; index <= hi; index += 1) {
    const address = addresses[index - lo]
    const info = await node.walletRpc(wallet, 'getaddressinfo', address)
    assertEqual(info.ismine, true, `${address} ismine`)
    assertEqual(info.solvable, true, `${address} solvable`)
    assertEqual(info.isscript, true, `${address} isscript`)
    assertEqual(info.iswitness, true, `${address} iswitness`)
    assertEqual(info.witness_version, 2, `${address} witness_version`)
    assertEqual(info.scriptPubKey, `5220${info.witness_program}`, `${address} scriptPubKey`)
    const pk32Hex = parseP2mrPubkeyDescriptor(info.desc)

    // Core must recompute the same address from the bare pk32 it reported.
    const explicit = await withChecksum(node, `mr(pk(${pk32Hex}))`)
    assertEqual(await deriveSingle(node, explicit.descriptor), address, `deriveaddresses mr(pk(${pk32Hex}))`)
    assertEqual(expectedP2mrSingleLeafProgram(pk32Hex), info.witness_program, `${address} single-leaf P2MR program`)

    // Independent BIP32 leaf, cross-checked through Core itself. The chain is
    // P2MR-only (no wpkh()), so use the fact that an un-ranged pqc(KEY) always
    // derives with HKDF index 0: Core deriving <tprv>/<path>/<index> on its own
    // must produce the same address as Core handed our leaf as a depth-5 tprv.
    const bip32Path = `m/${PURPOSE}h/${REGTEST_COIN_TYPE}h/${ACCOUNT}h/${chain.pathChange}/${index}`
    const leaf = bip32DerivePath(master, bip32Path)
    const corePathDescriptor = `mr(pk(pqc(${tprv}/${PURPOSE}h/${REGTEST_COIN_TYPE}h/${ACCOUNT}h/${chain.pathChange}/${index})))`
    const corePath = await withChecksum(node, corePathDescriptor)
    const localLeaf = await withChecksum(node, `mr(pk(pqc(${bip32SerializePrivate(leaf, TPRV_VERSION)})))`)
    const crossCheckAddress = await deriveSingle(node, corePath.descriptor)
    assertEqual(
      await deriveSingle(node, localLeaf.descriptor),
      crossCheckAddress,
      `BIP32 leaf cross-check for ${bip32Path}`
    )
    if (index === 0) {
      // Ranged position 0 and the un-ranged form share HKDF index 0.
      assertEqual(crossCheckAddress, address, `un-ranged descriptor at ${bip32Path}`)
    }

    vectors.push({
      name: `regtest_${chain.name}_${index}`,
      chain: chain.name,
      descriptor: bare,
      bip32Path,
      path: { purpose: PURPOSE, coinType: REGTEST_COIN_TYPE, account: ACCOUNT, change: chain.pathChange, index },
      hkdf: { account: 0, change: 0, index },
      leafPrivateKeyHex: leaf.key.toString('hex'),
      leafCrossCheck: { descriptor: corePathDescriptor, address: crossCheckAddress },
      publicKeyHex: pk32Hex,
      address,
      scriptPubKeyHex: info.scriptPubKey,
    })
  }

  return { descriptor, normalizedDescriptor: normalized, range: chain.range, vectors }
}

async function generateDataSignatureVector(node, wallet, vector) {
  const message = Buffer.from(DATA_SIGNATURE_MESSAGE_UTF8, 'utf8')
  const messageHash = sha256(message)
  const messageHashHex = messageHash.toString('hex')
  const proof = await node.walletRpc(wallet, 'signdatapqchash', vector.address, messageHashHex)

  const expectedDatasigHash = taggedHash('QbitDataSigPQC', messageHash).toString('hex')
  assertEqual(proof.address, vector.address, 'signdatapqchash address')
  assertEqual(proof.message_hash, messageHashHex, 'signdatapqchash message_hash')
  assertEqual(proof.datasig_hash, expectedDatasigHash, 'signdatapqchash datasig_hash (TaggedHash QbitDataSigPQC)')
  assertEqual(proof.domain, 'QbitDataSigPQC', 'signdatapqchash domain')
  assertEqual(proof.algorithm, 'SLH-DSA-SHA2-128s-bounded30', 'signdatapqchash algorithm')
  assertEqual(proof.proof_mode, 'p2mr-pubkey', 'signdatapqchash proof_mode')
  assertEqual(proof.pubkey, vector.publicKeyHex, 'signdatapqchash pubkey')
  assertEqual(proof.leaf_version, 192, 'signdatapqchash leaf_version')
  assertEqual(proof.leaf_script, `20${vector.publicKeyHex}b3`, 'signdatapqchash leaf_script')
  assertEqual(proof.control_block, 'c1', 'signdatapqchash control_block')
  assertEqual(`5220${proof.p2mr_merkle_root}`, vector.scriptPubKeyHex, 'signdatapqchash p2mr_merkle_root')
  if (!/^[0-9a-f]{7360}$/.test(proof.signature))
    throw new Error(`unexpected signature encoding/length: ${proof.signature.length}`)

  const verification = await node.rpc('verifydatapqchash', {
    address: proof.address,
    message_hash: proof.message_hash,
    signature: proof.signature,
    pubkey: proof.pubkey,
    leaf_script: proof.leaf_script,
    control_block: proof.control_block,
    leaf_version: proof.leaf_version,
    proof_mode: proof.proof_mode,
  })
  assertEqual(verification?.valid, true, `verifydatapqchash: ${JSON.stringify(verification)}`)

  return {
    vector: vector.name,
    rpc: 'signdatapqchash',
    proofMode: proof.proof_mode,
    domain: proof.domain,
    signedBytes:
      'datasigHashHex = SHA256(SHA256(utf8(domain)) || SHA256(utf8(domain)) || messageHash); the SLH-DSA signature is over these 32 bytes.',
    messageUtf8: DATA_SIGNATURE_MESSAGE_UTF8,
    messageHashHex,
    datasigHashHex: proof.datasig_hash,
    publicKeyHex: proof.pubkey,
    signatureHex: proof.signature,
    leafVersion: proof.leaf_version,
    leafScriptHex: proof.leaf_script,
    controlBlockHex: proof.control_block,
    p2mrMerkleRootHex: proof.p2mr_merkle_root,
  }
}

// Set while a run owns temporary directories / a qbitd child, so a SIGINT or
// SIGTERM can stop the daemon and remove them (see main()).
let interruptCleanup = async () => {}

async function generate(options) {
  bip32SelfTest()

  const trusted = QBIT_CORE_RELEASE_SIGNERS
  const release = verifyTarballChecksum(options.tarball, options.sha256sums)
  const signatures = await verifySha256sumsSignatures(
    options.sha256sums,
    options.sha256sumsAsc,
    options.signerKeys,
    trusted
  )
  console.log(
    `SHA256SUMS signed by ${signatures.signers.map(signer => signer.alias).join(', ')} ` +
      `(pinned ${trusted.manifest.policyId}, quorum ${trusted.manifest.releaseSignatureQuorum}; ` +
      `${signatures.untrusted} valid signatures from keys that are not pinned, ${signatures.unverifiable} unverifiable)`
  )

  // --core-commit is otherwise only the operator's assertion: resolve the tag
  // on the pinned repository and require the same commit.
  const remote = `https://github.com/${trusted.repository}.git`
  const tagResolution = await resolveReleaseTag(remote, options.coreTag)
  assertEqual(
    tagResolution.commit,
    options.coreCommit,
    `${remote} refs/tags/${options.coreTag} does not resolve to --core-commit`
  )
  assertEqual(
    tagResolution.tagObjectSha,
    trusted.tagObjectSha,
    `${remote} refs/tags/${options.coreTag} is not the pinned tag object`
  )

  const stageDir = mkdtempSync(join(tmpdir(), 'qbit-core-oracle-release-'))
  const datadir = mkdtempSync(join(tmpdir(), 'qbit-core-oracle-regtest-'))
  let node
  const cleanup = async () => {
    try {
      if (node !== undefined) await node.stop()
    } finally {
      rmSync(datadir, { recursive: true, force: true })
      rmSync(stageDir, { recursive: true, force: true })
    }
  }
  interruptCleanup = cleanup
  try {
    const binaries = await extractRelease(options.tarball, stageDir)
    const versionString = await readCoreVersion(binaries.qbitd, options.coreTag)

    const seed = Buffer.from(BIP32_TEST_VECTOR_1_SEED_HEX, 'hex')
    const master = bip32MasterFromSeed(seed)
    const tprv = bip32SerializePrivate(master, TPRV_VERSION)

    node = new RegtestNode(binaries, datadir, await findFreePort())
    await node.start()
    const chainInfo = await node.rpc('getblockchaininfo')
    assertEqual(chainInfo.chain, 'regtest', 'chain')

    const wallet = 'oracle'
    await node.cli(['-named', 'createwallet', `wallet_name=${wallet}`, 'blank=true', 'load_on_startup=false'])

    const chains = {}
    const vectors = []
    for (const chain of CHAINS) {
      const result = await generateChainVectors(node, wallet, master, tprv, chain)
      chains[chain.name] = {
        descriptor: result.descriptor,
        coreNormalizedDescriptor: result.normalizedDescriptor,
        range: result.range,
      }
      vectors.push(...result.vectors)
    }

    const dataSignature = await generateDataSignatureVector(node, wallet, vectors[0])

    return {
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      name: FIXTURE_NAME,
      description:
        'PQC public keys and P2MR addresses produced by an unmodified qbit Core release binary on regtest. Independent oracle for derivePQCKey(); see docs/derivation.md.',
      core: {
        repository: trusted.repository,
        tag: options.coreTag,
        commit: options.coreCommit,
        tagResolution: {
          method: 'git ls-remote',
          remote,
          tagObjectSha: tagResolution.tagObjectSha,
        },
        versionString,
        release: {
          asset: release.asset,
          assetSha256: release.sha256,
          signerPolicy: {
            manifest: trusted.manifest.path,
            manifestBlobSha: trusted.manifest.blobSha,
            policyId: trusted.manifest.policyId,
            releaseLine: trusted.manifest.releaseLine,
            releaseSignatureQuorum: trusted.manifest.releaseSignatureQuorum,
          },
          sha256sumsSignedBy: signatures.signers,
        },
        binaries: {
          qbitdSha256: sha256File(binaries.qbitd),
          qbitCliSha256: sha256File(binaries.qbitCli),
        },
      },
      generator: {
        path: 'scripts/generate-qbit-core-binary-vectors.mjs',
        method:
          'deriveaddresses mr(pk(pqc(tprv/87h/1h/0h/{change}/*))) + importdescriptors + getaddressinfo desc=mr(pk(<pk32>)) on an unmodified qbit Core release binary (regtest). BIP32 leaves derived independently with node:crypto and cross-checked against Core: deriveaddresses mr(pk(pqc(tprv/path/index))) == deriveaddresses mr(pk(pqc(<leaf as depth-5 tprv>))) (both un-ranged, HKDF index 0). signdatapqchash output verified with verifydatapqchash.',
      },
      network: 'regtest',
      algorithm: 'SLH-DSA-SHA2-128s-bounded30',
      bip32: {
        seedSource: 'BIP32 test vector 1 seed (public test data, not a BIP39 seed)',
        seedHex: BIP32_TEST_VECTOR_1_SEED_HEX,
        tprv,
      },
      derivation: {
        descriptor: 'mr(pk(pqc(<tprv>/87h/1h/0h/{change}/*)))',
        hkdf: 'For every vector, including the internal chain, qbit Core calls DerivePQCKey(leaf, account=0, change=0, index=<descriptor position>). The BIP32 path change (0/1) is not the HKDF change.',
        masterSeed: 'leafPrivateKeyHex is the 32-byte private BIP32 leaf key passed to DerivePQCKey as master_seed.',
      },
      chains,
      vectors,
      dataSignature,
    }
  } finally {
    interruptCleanup = async () => {}
    await cleanup()
  }
}

function formatFixture(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`
}

// Everything that must stay byte-identical across reruns: the vectors and the
// Core tag/commit/version, but not which platform's release asset produced
// them or how the tag was resolved. A rerun on another platform must still be
// able to confirm the vectors.
const PROVENANCE_KEYS = ['tagResolution', 'release', 'binaries']

export function derivationContent(fixture) {
  const core = { ...fixture.core }
  for (const key of PROVENANCE_KEYS) delete core[key]
  return JSON.stringify({ ...fixture, core }, null, 2)
}

function provenanceDifferences(existing, fixture) {
  return PROVENANCE_KEYS.filter(key => JSON.stringify(existing.core[key]) !== JSON.stringify(fixture.core[key])).map(
    key => `core.${key}`
  )
}

export function checkFixture(outPath, fixture, text) {
  if (!isFile(outPath)) throw new Error(`${outPath} does not exist; run without --check to create it`)
  const existingText = readFileSync(outPath, 'utf8')
  if (existingText === text) {
    console.log(
      `${outPath}: byte-identical to ${fixture.core.versionString} (${fixture.core.release.asset}, ${fixture.vectors.length} vectors)`
    )
    return
  }
  let existing
  try {
    existing = JSON.parse(existingText)
  } catch (error) {
    throw new Error(`${outPath} is not valid JSON: ${error.message}`)
  }
  if (
    typeof existing !== 'object' ||
    existing === null ||
    typeof existing.core !== 'object' ||
    existing.core === null
  ) {
    throw new Error(`${outPath} does not look like a ${FIXTURE_NAME} fixture`)
  }
  if (derivationContent(existing) !== derivationContent(fixture)) {
    throw new Error(
      `${outPath} vectors differ from those generated by ${fixture.core.versionString} (${fixture.core.release.asset})`
    )
  }
  const differences = provenanceDifferences(existing, fixture)
  if (differences.length === 0) {
    throw new Error(
      `${outPath} is not byte-identical to this run although no vector or provenance field differs; ` +
        'its formatting is not what the generator writes (rerun without --check to rewrite it)'
    )
  }
  console.log(
    `${outPath}: vectors match ${fixture.core.versionString}; release provenance differs in ${differences.join(', ')} ` +
      `(fixture: ${existing.core.release?.asset}, this run: ${fixture.core.release.asset})`
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fixture = await generate(options)
  const text = formatFixture(fixture)

  if (options.check) {
    checkFixture(options.out, fixture, text)
    return
  }

  writeFileSync(options.out, text)
  console.log(
    `wrote ${options.out} (${fixture.vectors.length} vectors from ${fixture.core.versionString}, ${fixture.core.release.asset})`
  )
}

// Run only as a CLI; test/qbit-core-binary-vectors-generator.test.mjs imports
// the verification helpers above without generating anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installTerminationHandlers({
    cleanup: () => interruptCleanup(),
    onSignal: signal => console.error(`interrupted by ${signal}; stopping qbitd and removing temporary directories`),
    onCleanupError: (signal, error) => console.error(`${signal} cleanup failed: ${error.message}`),
  })

  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
