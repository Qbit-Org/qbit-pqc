import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  parseLsRemoteTag,
  verifySha256sumsSignatures,
} from '../scripts/generate-qbit-core-binary-vectors.mjs'
import { QBIT_CORE_RELEASE_SIGNERS } from '../scripts/qbit-core-release-signers.mjs'

// Release provenance of fixtures/qbit-core-binary-derivation.json rests on
// verifySha256sumsSignatures(): the keys handed to the generator with
// --signer-keys must never be trusted on their own. These tests build throwaway
// OpenPGP keys shaped like the operator keys (certifying primary + signing
// subkey) and check that only signatures from the pinned set count.

const gpgAvailable = spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0
// Skipping the signature tests is only acceptable on a developer machine; CI
// must not report the trust root as tested when gpg is missing.
if (!gpgAvailable && process.env.CI) throw new Error('gpg is required in CI to run the release-signature tests')

const FINGERPRINT = /^[0-9A-F]{40}$/
const SHA1 = /^[0-9a-f]{40}$/
const SUMS = 'ae121af03263b55d530e3f3e8719a71362d0950cba82f54a2bc2d6c437a029b5  qbit-1.0.0-x86_64-linux-gnu.tar.gz\n'

class TestKeyring {
  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'qbit-pqc-signer-test-'))
    this.keys = new Map()
  }

  gpg(args, options = {}) {
    return execFileSync(
      'gpg',
      ['--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
      { env: { ...process.env, GNUPGHOME: this.home }, stdio: ['ignore', 'pipe', 'pipe'], ...options }
    ).toString()
  }

  // Primary key with cert+sign capability and one signing subkey, like the
  // published operator keys (the primary can sign; the subkey is what
  // keys.json lists as signing_fingerprint).
  generate(alias) {
    this.gpg(['--quick-gen-key', alias, 'ed25519', 'cert,sign', '0'])
    const primaryFingerprint = this.fingerprints(alias)[0]
    this.gpg(['--quick-add-key', primaryFingerprint, 'ed25519', 'sign', '0'])
    const [primary, signing] = this.fingerprints(primaryFingerprint)
    expect(primary).toBe(primaryFingerprint)
    expect(signing).toMatch(FINGERPRINT)
    expect(signing).not.toBe(primary)
    const key = { alias, primaryFingerprint: primary, signingFingerprint: signing }
    this.keys.set(alias, key)
    return key
  }

  fingerprints(selector) {
    return this.gpg(['--with-colons', '--list-keys', selector])
      .split('\n')
      .filter(line => line.startsWith('fpr:'))
      .map(line => line.split(':')[9])
  }

  exportPublicKey(alias, dir) {
    const key = this.keys.get(alias)
    writeFileSync(join(dir, `${alias}.asc`), this.gpg(['--armor', '--export', key.primaryFingerprint]))
  }

  // Detached armored signature by exactly the given (sub)key fingerprints.
  sign(path, fingerprints, output) {
    this.gpg(['--armor', '--detach-sign', ...fingerprints.flatMap(fpr => ['-u', `${fpr}!`]), '--output', output, path])
  }

  pin(aliases, quorum) {
    return {
      manifest: { releaseSignatureQuorum: quorum },
      signers: aliases.map(alias => {
        const key = this.keys.get(alias)
        return { alias, signingFingerprint: key.signingFingerprint, primaryFingerprint: key.primaryFingerprint }
      }),
    }
  }

  dispose() {
    spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: this.home }, stdio: 'ignore' })
    rmSync(this.home, { recursive: true, force: true })
  }
}

// Independent copy of the trust root, re-derived from Qbit-Org/qbit at
// 7ebcddb622d6e639041f005a189b048ec2a221fe with the commands in
// scripts/qbit-core-release-signers.mjs (gh api contents for keys.json and each
// public_key_file, git hash-object for blob ids, gpg --import-options show-only
// for the primary and signing-subkey fingerprints, git ls-remote for the tag),
// not copied from that module. Any edit to the pin, including to an operator
// the fixture's signatures do not exercise, must be repeated here by hand.
const EXPECTED_RELEASE_SIGNERS = {
  repository: 'Qbit-Org/qbit',
  tag: 'v1.0.0',
  commit: '7ebcddb622d6e639041f005a189b048ec2a221fe',
  tagObjectSha: 'c72d230476ffe94e2f672d925f34288159233dfc',
  manifest: {
    path: 'contrib/keys/operator-keys/keys.json',
    blobSha: '321e9c3db427053a31ea80a88cc86a3bdc95913c',
    policyId: 'qbit-release-keys-mainnet-000002',
    releaseLine: 'mainnet',
    releaseSignatureQuorum: 3,
  },
  signers: [
    {
      alias: 'operator-01',
      publicKeyFile: 'contrib/keys/operator-keys/public-keys/operator-01-release.asc',
      publicKeyBlobSha: 'e11fc5112b8d2bf764a8a8e7f1676962cb823852',
      signingFingerprint: '289EA3EC2F1939A24984840ED26CFC05586D371E',
      primaryFingerprint: '51F569645F0545B0E6C840C2357052443CE094D8',
    },
    {
      alias: 'operator-02',
      publicKeyFile: 'contrib/keys/operator-keys/public-keys/operator-02-release.asc',
      publicKeyBlobSha: '45f80146780825084d3422b665daf39d755ce2b3',
      signingFingerprint: '1B95A7AA02F5530BDB1CD92387012E62F6CC1393',
      primaryFingerprint: 'A762712935A3FFBC6523EAEBA637B315184F8119',
    },
    {
      alias: 'operator-03',
      publicKeyFile: 'contrib/keys/operator-keys/public-keys/operator-03-release.asc',
      publicKeyBlobSha: 'a149a66ecf1a67f3350e9cc2db895eebf86fe130',
      signingFingerprint: '05A14A415C26F4216DC254FE52D5CC557D764586',
      primaryFingerprint: 'E875FE223D78E2BA7F785B587BFF9C2A1FB522FC',
    },
    {
      alias: 'operator-04',
      publicKeyFile: 'contrib/keys/operator-keys/public-keys/operator-04-release.asc',
      publicKeyBlobSha: '6cfbc04aba27bac41c7494bea88954b50aae20d3',
      signingFingerprint: '71E5D38304B66183448285AB81859E1B1DEA4ED5',
      primaryFingerprint: '4317D4DF4268F36F4ACDF971371CB0839D6DF8C0',
    },
    {
      alias: 'operator-05',
      publicKeyFile: 'contrib/keys/operator-keys/public-keys/operator-05-release.asc',
      publicKeyBlobSha: '962f0aed43b529864eb920c46f41b4519d836d92',
      signingFingerprint: 'D57AB80A8580EC27CDB45455E9FC0931AE6CA9BD',
      primaryFingerprint: 'C1B34E63408E73C6CE9E74979E845F66807D4014',
    },
  ],
}

describe('pinned qbit Core release signers', () => {
  const pinned = QBIT_CORE_RELEASE_SIGNERS

  it('matches the independently derived v1.0.0 operator-key manifest exactly', () => {
    expect(pinned).toStrictEqual(EXPECTED_RELEASE_SIGNERS)
  })

  // Structural invariants a re-pin must keep, independent of the values above.
  it('lists distinct operators with distinct signing and primary fingerprints and a usable quorum', () => {
    expect(pinned.tagObjectSha).toMatch(SHA1)
    expect(pinned.manifest.blobSha).toMatch(SHA1)
    expect(pinned.signers.length).toBeGreaterThanOrEqual(pinned.manifest.releaseSignatureQuorum)
    const aliases = pinned.signers.map(signer => signer.alias)
    const signing = pinned.signers.map(signer => signer.signingFingerprint)
    const primary = pinned.signers.map(signer => signer.primaryFingerprint)
    expect(new Set(aliases).size).toBe(pinned.signers.length)
    expect(new Set(signing).size).toBe(pinned.signers.length)
    expect(new Set(primary).size).toBe(pinned.signers.length)
    // A signing subkey fingerprint can never double as another key's primary.
    expect(signing.filter(fpr => primary.includes(fpr))).toEqual([])
    for (const signer of pinned.signers) {
      expect(signer.alias).toMatch(/^operator-\d{2}$/)
      expect(signer.publicKeyFile).toBe(`contrib/keys/operator-keys/public-keys/${signer.alias}-release.asc`)
      expect(signer.publicKeyBlobSha).toMatch(SHA1)
      expect(signer.signingFingerprint).toMatch(FINGERPRINT)
      expect(signer.primaryFingerprint).toMatch(FINGERPRINT)
    }
  })
})

describe('parseLsRemoteTag', () => {
  const remote = 'https://github.com/Qbit-Org/qbit.git'

  it('peels an annotated tag to its commit', () => {
    const stdout =
      'c72d230476ffe94e2f672d925f34288159233dfc\trefs/tags/v1.0.0\n' +
      '7ebcddb622d6e639041f005a189b048ec2a221fe\trefs/tags/v1.0.0^{}\n'
    expect(parseLsRemoteTag(stdout, remote, 'v1.0.0')).toEqual({
      commit: '7ebcddb622d6e639041f005a189b048ec2a221fe',
      tagObjectSha: 'c72d230476ffe94e2f672d925f34288159233dfc',
    })
  })

  it('treats a lightweight tag as the commit itself', () => {
    const stdout = '7ebcddb622d6e639041f005a189b048ec2a221fe\trefs/tags/v1.0.0\n'
    expect(parseLsRemoteTag(stdout, remote, 'v1.0.0')).toEqual({
      commit: '7ebcddb622d6e639041f005a189b048ec2a221fe',
      tagObjectSha: null,
    })
  })

  it('rejects a missing tag and unparseable output', () => {
    expect(() => parseLsRemoteTag('', remote, 'v1.0.0')).toThrow(/has no refs\/tags\/v1\.0\.0/)
    expect(() => parseLsRemoteTag('not a ref line\n', remote, 'v1.0.0')).toThrow(/unparseable git ls-remote line/)
    expect(() =>
      parseLsRemoteTag('7ebcddb622d6e639041f005a189b048ec2a221fe\trefs/tags/v1.0.1\n', remote, 'v1.0.0')
    ).toThrow(/has no refs\/tags\/v1\.0\.0/)
  })
})

describe.skipIf(!gpgAvailable)('verifySha256sumsSignatures', () => {
  const OPERATORS = ['op-01', 'op-02', 'op-03', 'op-04', 'op-05']
  const ATTACKERS = ['attacker-01', 'attacker-02', 'attacker-03']
  let keyring
  let workDirs

  beforeAll(() => {
    keyring = new TestKeyring()
    workDirs = []
    for (const alias of [...OPERATORS, ...ATTACKERS]) keyring.generate(alias)
  })

  afterAll(() => {
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
    keyring?.dispose()
  })

  // A release directory: SHA256SUMS, SHA256SUMS.asc signed by `signedBy`
  // (aliases, or `{ alias, primary: true }` to sign with the primary key), and
  // a --signer-keys directory holding the public keys of `keyAliases`.
  function release({ keyAliases, signedBy, tamper = false }) {
    const dir = mkdtempSync(join(tmpdir(), 'qbit-pqc-release-test-'))
    workDirs.push(dir)
    const sums = join(dir, 'SHA256SUMS')
    const asc = join(dir, 'SHA256SUMS.asc')
    const keysDir = join(dir, 'keys')
    mkdirSync(keysDir)
    writeFileSync(sums, SUMS)
    keyring.sign(
      sums,
      signedBy.map(entry => {
        const alias = typeof entry === 'string' ? entry : entry.alias
        const key = keyring.keys.get(alias)
        return typeof entry === 'string' ? key.signingFingerprint : key.primaryFingerprint
      }),
      asc
    )
    if (tamper) writeFileSync(sums, SUMS.replace('ae12', 'ae13'))
    for (const alias of keyAliases) keyring.exportPublicKey(alias, keysDir)
    return { sums, asc, keysDir }
  }

  it('rejects a full quorum of valid signatures from keys that are not pinned', async () => {
    // Three attacker keys in --signer-keys plus a
    // SHA256SUMS they signed used to satisfy the quorum.
    const { sums, asc, keysDir } = release({ keyAliases: ATTACKERS, signedBy: ATTACKERS })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, QBIT_CORE_RELEASE_SIGNERS)).rejects.toThrow(
      /0 valid from pinned operator keys \(quorum 3\), 3 valid from keys that are not pinned, 0 bad/
    )
  })

  it('accepts the pinned quorum and records which pinned operators signed', async () => {
    const { sums, asc, keysDir } = release({ keyAliases: OPERATORS, signedBy: ['op-03', 'op-01', 'op-02'] })
    const result = await verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))
    expect(result).toEqual({
      signers: ['op-01', 'op-02', 'op-03'].map(alias => ({
        alias,
        signingFingerprint: keyring.keys.get(alias).signingFingerprint,
        primaryFingerprint: keyring.keys.get(alias).primaryFingerprint,
      })),
      untrusted: 0,
      unverifiable: 0,
    })
  })

  it('ignores extra keys in --signer-keys and their signatures once the pinned quorum is met', async () => {
    const { sums, asc, keysDir } = release({
      keyAliases: [...OPERATORS, ...ATTACKERS],
      signedBy: ['op-01', 'op-02', 'op-03', 'attacker-01'],
    })
    const result = await verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))
    expect(result.signers.map(signer => signer.alias)).toEqual(['op-01', 'op-02', 'op-03'])
    expect(result.untrusted).toBe(1)
  })

  it('does not count unpinned keys toward the quorum', async () => {
    const { sums, asc, keysDir } = release({
      keyAliases: [...OPERATORS, ...ATTACKERS],
      signedBy: ['op-01', 'op-02', 'attacker-01', 'attacker-02'],
    })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))).rejects.toThrow(
      /2 valid from pinned operator keys \(quorum 3\), 2 valid from keys that are not pinned/
    )
  })

  it('does not count a signature whose key is not in --signer-keys', async () => {
    const { sums, asc, keysDir } = release({ keyAliases: ['op-01', 'op-02'], signedBy: ['op-01', 'op-02', 'op-03'] })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))).rejects.toThrow(
      /2 valid from pinned operator keys \(quorum 3\), 0 valid from keys that are not pinned, 0 bad, 1 from keys not in --signer-keys/
    )
  })

  it('requires the pinned primary key behind a pinned signing fingerprint', async () => {
    const pinned = keyring.pin(OPERATORS, 3)
    pinned.signers[0].primaryFingerprint = keyring.keys.get('attacker-01').primaryFingerprint
    const { sums, asc, keysDir } = release({ keyAliases: OPERATORS, signedBy: ['op-01', 'op-02', 'op-03'] })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, pinned)).rejects.toThrow(
      /2 valid from pinned operator keys \(quorum 3\), 1 valid from keys that are not pinned/
    )
  })

  it('does not accept an operator primary key in place of its pinned signing subkey', async () => {
    const { sums, asc, keysDir } = release({
      keyAliases: OPERATORS,
      signedBy: [{ alias: 'op-01', primary: true }, 'op-02', 'op-03'],
    })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))).rejects.toThrow(
      /2 valid from pinned operator keys \(quorum 3\), 1 valid from keys that are not pinned/
    )
  })

  // gpg stops at the first bad signature, so only one BADSIG is reported.
  it('rejects a tampered SHA256SUMS even when the pinned operators signed the original', async () => {
    const { sums, asc, keysDir } = release({ keyAliases: OPERATORS, signedBy: ['op-01', 'op-02', 'op-03'], tamper: true })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(OPERATORS, 3))).rejects.toThrow(
      /0 valid from pinned operator keys \(quorum 3\), 0 valid from keys that are not pinned, [1-9]\d* bad/
    )
  })

  it('rejects a pinned set that cannot reach its own quorum or repeats a fingerprint', async () => {
    const { sums, asc, keysDir } = release({ keyAliases: OPERATORS, signedBy: ['op-01', 'op-02', 'op-03'] })
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(['op-01', 'op-02'], 3))).rejects.toThrow(
      /only 2 pinned signers for a quorum of 3/
    )
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, keyring.pin(['op-01', 'op-01', 'op-02'], 3))).rejects.toThrow(
      /signing fingerprint .* listed twice/
    )
    // Two aliases over one primary key would let that operator count twice.
    const sharedPrimary = keyring.pin(OPERATORS, 3)
    sharedPrimary.signers[1].primaryFingerprint = sharedPrimary.signers[0].primaryFingerprint
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, sharedPrimary)).rejects.toThrow(
      /primary fingerprint .* listed twice/
    )
    const signingAsPrimary = keyring.pin(OPERATORS, 3)
    signingAsPrimary.signers[1].primaryFingerprint = signingAsPrimary.signers[0].signingFingerprint
    await expect(verifySha256sumsSignatures(sums, asc, keysDir, signingAsPrimary)).rejects.toThrow(
      /both a signing and a primary key/
    )
    await expect(
      verifySha256sumsSignatures(sums, asc, keysDir, { ...keyring.pin(OPERATORS, 3), manifest: { releaseSignatureQuorum: 0 } })
    ).rejects.toThrow(/positive integer/)
  })
})
