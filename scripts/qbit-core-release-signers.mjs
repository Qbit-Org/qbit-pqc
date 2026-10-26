// Trusted qbit Core release-signing keys for the Core binary oracle
// (scripts/generate-qbit-core-binary-vectors.mjs).
//
// This is the trust root for fixtures/qbit-core-binary-derivation.json: a
// SHA256SUMS signature only counts toward the release quorum when it was made
// by a signing key listed here, and the key's primary fingerprint matches too.
// Keys supplied on the command line (--signer-keys) are never trusted on their
// own, so an attacker who controls the release artifacts and the key directory
// cannot have a modified tarball recorded as an unmodified release.
//
// Pinned from the qbit source tree at the release commit:
//
//   repository  Qbit-Org/qbit
//   tag         v1.0.0  (annotated tag object c72d230476ffe94e2f672d925f34288159233dfc)
//   commit      7ebcddb622d6e639041f005a189b048ec2a221fe
//   manifest    contrib/keys/operator-keys/keys.json
//               git blob 321e9c3db427053a31ea80a88cc86a3bdc95913c
//               policy_id qbit-release-keys-mainnet-000002 (policy_sequence 2)
//               release_lines.mainnet.release_signature_quorum = 3
//
// keys.json lists each operator's signing_fingerprint (a signing subkey) and
// public_key_file. primaryFingerprint is the primary-key fingerprint of that
// public_key_file at the same commit; publicKeyBlobSha is the file's git blob
// id. Re-derive every value with:
//
//   REF=7ebcddb622d6e639041f005a189b048ec2a221fe
//   gh api "repos/Qbit-Org/qbit/contents/contrib/keys/operator-keys/keys.json?ref=$REF" \
//     --jq '{sha, content}'                      # blob sha; base64 -d the content
//   gh api "repos/Qbit-Org/qbit/contents/contrib/keys/operator-keys/public-keys/operator-01-release.asc?ref=$REF" \
//     --jq .content | base64 -d > operator-01-release.asc
//   git hash-object operator-01-release.asc       # publicKeyBlobSha
//   gpg --batch --with-colons --import-options show-only --import operator-01-release.asc \
//     | awk -F: '$1=="fpr"{print $10}'            # primary fingerprint, then subkey fingerprint
//   git ls-remote https://github.com/Qbit-Org/qbit.git 'refs/tags/v1.0.0^{}'   # tag -> commit
//
// Bumping the Core reference (RELEASE.md, "Derivation Fixture Gate") means
// re-pinning this file from keys.json at the new release commit; the generator
// refuses a --core-tag/--core-commit that does not match the pin.

function fingerprint(value) {
  if (!/^[0-9A-F]{40}$/.test(value)) throw new Error(`pinned fingerprint is not 40 uppercase hex characters: ${value}`)
  return value
}

export const QBIT_CORE_RELEASE_SIGNERS = Object.freeze({
  repository: 'Qbit-Org/qbit',
  tag: 'v1.0.0',
  commit: '7ebcddb622d6e639041f005a189b048ec2a221fe',
  // Annotated tag object refs/tags/v1.0.0 points at; a re-created tag is a
  // provenance change even when it names the same commit.
  tagObjectSha: 'c72d230476ffe94e2f672d925f34288159233dfc',
  manifest: Object.freeze({
    path: 'contrib/keys/operator-keys/keys.json',
    blobSha: '321e9c3db427053a31ea80a88cc86a3bdc95913c',
    policyId: 'qbit-release-keys-mainnet-000002',
    releaseLine: 'mainnet',
    releaseSignatureQuorum: 3,
  }),
  signers: Object.freeze(
    [
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
    ].map(signer =>
      Object.freeze({
        ...signer,
        signingFingerprint: fingerprint(signer.signingFingerprint),
        primaryFingerprint: fingerprint(signer.primaryFingerprint),
      })
    )
  ),
})
