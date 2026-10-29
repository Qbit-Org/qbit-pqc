# qbit PQC Derivation Contract

This document records the wallet contract for deriving qbit-compatible
PQC keys. It is a compatibility spec and fixture source, not wallet/keyring
integration.

## Scope

`@qbit-oss/pqc` remains the SLH-DSA package. It accepts deterministic keygen
entropy, derives P2MR keys from a BIP32 leaf key as qbit Core's descriptor
wallet does (`deriveP2mrDescriptorKey`, built on the lower-level
`derivePQCKey` HKDF primitive), signs messages, and verifies signatures. It
does not parse seed phrases, derive BIP32 keys, build descriptors, or sign
transactions.

The wallet layer is responsible for this chain:

```text
mnemonic -> BIP39 seed -> BIP32 root private key
  -> 32-byte private leaf at m/87h/{coin_type}h/0h/{change}/{index}
  -> @qbit-oss/pqc deriveP2mrDescriptorKey(leaf, index):
     qbit Core PQC HKDF using account=0, change=0, index={index}
     -> 128-byte SLH-DSA keygen entropy -> {pk32, sk64}
  -> @qbit-oss/pqc sign/verify
```

The `master_seed` passed to qbit Core `DerivePQCKey(...)` is the concrete
private BIP32 leaf key bytes, not the BIP39 seed bytes and not the mnemonic.
Core passes the leaf's 32-byte secp256k1 key: a key with leading zero bytes
keeps them, and the 33-byte `00 || key` serialization inside an xprv is not the
key. `deriveP2mrDescriptorKey` rejects any other length, and a 32-byte value
that is zero or not below secp256k1's group order, which no BIP32 derivation
produces. `derivePQCKey` accepts
any non-empty seed, so a 31-byte unpadded key, a 33-byte xprv-style key or a
64-byte BIP39 seed silently derives a key that Core never generates.

## Wallet Layer

The wallet layer owns the mnemonic and passphrase and derives account
pubkeys and addresses through the canonical path and HKDF contract above.

For qbit Core recovery/interoperability, a wallet exports private
receive/change descriptors:

```text
mr(pk(pqc(<network-private-extended-key>/87h/{coin_type}h/0h/0/*)))
mr(pk(pqc(<network-private-extended-key>/87h/{coin_type}h/0h/1/*)))
```

The descriptor path change is `0` or `1`, but the canonical HKDF tuple remains
`(account, change, index) = (0, 0, index)`, which
`deriveP2mrDescriptorKey(leaf, index)` fixes.

SLH-DSA-SHA2-128s-bounded30 keys have a bounded signature budget. Wallets that
sign with them should keep qbit Core-style PQC signature usage counters per PQC
pubkey, serialize counter reservations, and persist each reservation before
signing so that concurrent or interrupted signs cannot reuse a counter value.

Counters are not enough to spend P2MR outputs. Signing a P2MR transaction or
message also needs qbit's P2MR signing preimage (sighash), which this package
does not compute: `sign` signs whatever bytes it is given.

## Signing Cost

Wallets sign the 32-byte sighash, never the transaction or message itself,
because signing time grows with the length of what is signed. SLH-DSA's
message digest `H_msg(R, PK.seed, PK.root, M)` starts, in the SHA2 parameter
sets, with SHA-256 over `R || PK.seed || PK.root || M`. A bounded30 signature
uses FORS+C: the signer varies `R` until the digest gives index 0 for the
FORS tree the signature leaves out, and because `R` comes first, every attempt
hashes all of `M` again. A signature takes tens of thousands of attempts, so
signing costs O(attempts × |M|), while verifying computes `H_msg` once.

The digest construction and the FORS+C condition belong to the signature
scheme qbit Core verifies, so this cost cannot change without a consensus
change. Instead, `sign` and `signWithStats` reject a message longer than
64 KiB (`constants.MAX_MESSAGE_SIZE`) unless the caller passes
`{ allowLargeMessage: true }`; [Message size](signing.md#message-size) gives
measured signing times.

## Descriptor Path

qbit Core P2MR wallet descriptors use:

```text
mr(pk(pqc(<xprv-or-qprv>/87h/{coin_type}h/0h/{path_change}/*)))
```

The canonical path is:

```text
m/87h/{coin_type}h/0h/{path_change}/{index}
```

Rules:

- Purpose is `87h`.
- Coin type is `0h` on mainnet.
- Coin type is `1h` on test chains: testnet, signet, and regtest.
- Account is `0h` for the current qbit Core wallet descriptors.
- Path change is `0` for receive/external addresses and `1` for internal change.
- Index is a non-hardened child number, `0` to `0x7fffffff`, and is the
  descriptor range position.

Public `xpub` descriptors are not enough to derive PQC public keys, because
the PQC keygen entropy is derived from private leaf key bytes. qbit Core
therefore rejects public P2MR descriptor imports for watch-only derivation; use
qbit Core `exportpubkeydb` / `importpubkeydb` for watch-only P2MR tracking.

## HKDF

qbit Core derives the 128-byte SLH-DSA keygen entropy with HKDF-SHA256:

```text
salt = utf8("qbit-sphincs-v1")
info_prefix = utf8("qbit/sphincs+/1")

PRK = HMAC_SHA256(key = salt, data = master_seed)
info = info_prefix || uint32_le(hkdf_account) || uint32_le(hkdf_change) || uint32_le(hkdf_index)
OKM = HKDF-expand-SHA256(PRK, info, 128 bytes)
```

qbit Core's descriptor wallet derives every P2MR key in
`P2MRPubkeyProvider::GetPubKey`
([`src/script/descriptor.cpp:618-620`](https://github.com/Qbit-Org/qbit/blob/7ebcddb622d6e639041f005a189b048ec2a221fe/src/script/descriptor.cpp#L618-L620)
at the pinned commit) with this HKDF tuple:

```text
hkdf_account = 0
hkdf_change = 0
hkdf_index = descriptor range position, or 0 for a non-ranged descriptor
```

The path change field never enters the HKDF tuple. Receive/change separation
is already encoded in the private BIP32 leaf path: `.../0/{index}` for receive
and `.../1/{index}` for change, both with `hkdf_change = 0`. Do not also set
`hkdf_change = 1` for canonical wallet generation; that creates a different
PQC key than qbit Core generates for ranged descriptors at the pinned commit.
The derivation fixtures include a `change=1` vector only to document Core's
recovery/matching tolerance for already-known pubkeys.

A non-ranged `pqc(...)` key, such as
`mr(pk(pqc(<xprv>/87h/{coin_type}h/0h/{path_change}/{index})))` or a single
exported leaf key, uses `hkdf_index = 0` whatever its path. It therefore gets a
different PQC key than the ranged descriptor at the same leaf, except at index
`0`. A wallet that exports per-address descriptors must derive their keys with
`deriveP2mrDescriptorKey(leaf, 0)`, not with the leaf's index.

`OKM` is passed directly to the bounded30 SLH-DSA seeded keygen.
`deriveP2mrDescriptorKey(leafPrivateKey, rangeIndex)` derives exactly the keys
above: it requires a 32-byte leaf key and `0 <= rangeIndex <= 0x7fffffff`, and
fixes `hkdf_account` and `hkdf_change` to `0`. The low-level
`derivePQCKey(masterSeed, hkdfAccount, hkdfChange, hkdfIndex)` primitive takes
any non-empty seed and any uint32 tuple; its numbers are HKDF fields, not BIP32
path fields. Both return `{pk32, sk64}`. The resulting secret key is 64 bytes
and the public key is the last 32 bytes of that secret key.

## Fixtures

The committed harness fixture is
`fixtures/qbit-core-derivation.json`. The release-binary oracle fixture,
`fixtures/qbit-core-binary-derivation.json`, is described under
"Core Binary Oracle" below.

It records:

- qbit Core source files and commit used to define the contract.
- Canonical descriptor generation examples plus explicit recovery/matching and
  primitive-boundary vectors.
- Private leaf seed bytes for deterministic tests.
- Separate BIP32 path fields and HKDF fields to avoid conflating path change
  with canonical descriptor-generation HKDF `change=0`.
- Derived 128-byte keygen entropy.
- Expected public and secret keys from `@qbit-oss/pqc`.
- SHA-256 of the deterministic SLH-DSA signature for each vector.
- Fallback harness provenance for reproducing the Core OKM and key outputs.

`test/qbit-core-derivation.test.ts` reimplements only the small
HKDF reference algorithm, then verifies the fixture with the package WASM and
the public `derivePQCKey(...)` API. It also checks that
`deriveP2mrDescriptorKey(...)` reproduces the descriptor-generation vectors,
not the recovery-only one, and rejects the primitive-only index.

## Core Binary Oracle

`fixtures/qbit-core-derivation.json` above was produced by a C++ harness that
re-implements Core's `DerivePQCKey` against this repository's vendored
libbitcoinpqc. It cannot detect a divergence between that vendored code and
what qbit Core actually ships.

`fixtures/qbit-core-binary-derivation.json` closes that gap. Every `publicKeyHex`
and `address` in it was produced by an unmodified qbit Core v1.0.0 release
binary (`7ebcddb622d6e639041f005a189b048ec2a221fe`) running on regtest, driven
by `scripts/generate-qbit-core-binary-vectors.mjs`:

1. The script verifies the release tarball against the published `SHA256SUMS`
   and its operator signatures, resolves the release tag to its commit, extracts
   the tarball, and checks `qbitd --version`. The signature check trusts only
   the operator keys pinned in `scripts/qbit-core-release-signers.mjs`, taken
   from `contrib/keys/operator-keys/keys.json` in the qbit source tree at the
   release commit (git blob `321e9c3db427053a31ea80a88cc86a3bdc95913c`, policy
   `qbit-release-keys-mainnet-000002`): a signature counts toward the mainnet
   quorum of three only when both its signing-subkey fingerprint and its
   primary-key fingerprint match one pinned operator, whatever keys were passed
   with `--signer-keys`. `--core-tag` is resolved with
   `git ls-remote https://github.com/Qbit-Org/qbit.git` and must peel to
   `--core-commit` and to the pinned annotated tag object; both must also equal
   the pinned release, so bumping Core means re-pinning first.
2. A fixed public `tprv` is built from the BIP32 test vector 1 seed
   (`000102030405060708090a0b0c0d0e0f`).
3. `deriveaddresses "mr(pk(pqc(<tprv>/87h/1h/0h/0/*)))" [0,4]` and the same for
   the internal chain `/1/*` with range `[0,1]`.
4. `importdescriptors` of those descriptors into a blank descriptor wallet, then
   `getaddressinfo <address>` returns `desc = mr(pk(<pk32>))`, Core's derived
   PQC public key for that position.
5. The private BIP32 leaf at each path is derived independently with
   `node:crypto` (self-tested against the BIP32 test vectors). Because the chain
   is P2MR-only, the leaf is cross-checked through Core itself: an un-ranged
   `pqc(KEY)` always uses HKDF index 0, so
   `deriveaddresses "mr(pk(pqc(<tprv>/87h/1h/0h/{change}/{index})))"` must equal
   `deriveaddresses "mr(pk(pqc(<leaf as a depth-5 tprv>)))"`.
6. `signdatapqchash` for the first external address is recorded as a
   cross-implementation `verify` vector. Core signs
   `TaggedHash("QbitDataSigPQC", message_hash)`, the 32-byte result of
   `SHA256(SHA256(tag) || SHA256(tag) || message_hash)`, with the leaf's PQC
   key; the result is checked with `verifydatapqchash` before it is written.

The fixture records the release asset, its SHA-256, the pinned signer policy
(manifest path, blob id, policy id, quorum), the alias and signing and primary
fingerprints of each pinned operator that signed `SHA256SUMS`, how the tag was
resolved (remote and tag object), the `qbitd`/`qbit-cli` binary hashes, and the
Core tag, commit, and version string. `test/qbit-core-binary-derivation.test.ts`
asserts that the recorded signers are a subset of the pinned operator set and
meet its quorum, that the recorded tag resolution and signer policy match the
pin, that `deriveP2mrDescriptorKey(leaf, index).pk32` and
`derivePQCKey(leaf, 0, 0, index).pk32` equal Core's `pk32` for every vector,
including the internal-chain vectors with HKDF `change=0`, that each address
commits to that `pk32` as a single P2MR leaf, and that the package verifies and
byte-for-byte reproduces Core's `signdatapqchash` signature. It also checks that
`derivePQCKey` with HKDF change `1`, account `1` or a hardened index misses
Core's key for every vector, and that `deriveP2mrDescriptorKey(leaf, 0)`
derives the key behind Core's address for each leaf's un-ranged descriptor
(step 5).
`test/qbit-core-binary-vectors-generator.test.mjs` exercises the signature
check with throwaway keys: a full quorum of valid signatures from keys that are
not pinned is rejected, as are unpinned keys mixed into the quorum, a pinned
signing fingerprint behind the wrong primary key, an operator's primary key used
in place of its pinned signing subkey, and a tampered `SHA256SUMS`.

### Regenerating the oracle fixture

Requirements: Linux x86_64 (or another platform with a release tarball), Node
20+, `tar`, and `gpg`. The script has no npm dependencies and is not packed.

```sh
# 1. Release artifacts from https://github.com/Qbit-Org/qbit/releases/tag/v1.0.0
mkdir -p /tmp/qbit-release && cd /tmp/qbit-release
gh release download v1.0.0 -R Qbit-Org/qbit \
  -p 'qbit-1.0.0-x86_64-linux-gnu.tar.gz' -p 'SHA256SUMS' -p 'SHA256SUMS.asc'

# 2. Operator release keys, as published in the qbit source tree
#    (contrib/keys/operator-keys/public-keys/ at the release commit). The
#    script only counts signatures from the operators pinned in
#    scripts/qbit-core-release-signers.mjs, so the directory may hold any or
#    all of them; the v1.0.0 SHA256SUMS.asc is signed by operator-01..03.
mkdir -p /tmp/qbit-keys
for n in 01 02 03 04 05; do
  gh api "repos/Qbit-Org/qbit/contents/contrib/keys/operator-keys/public-keys/operator-$n-release.asc?ref=7ebcddb622d6e639041f005a189b048ec2a221fe" \
    --jq .content | base64 -d > /tmp/qbit-keys/operator-$n-release.asc
done

# 3. Regenerate (or verify with --check) from the repository root. The script
#    resolves refs/tags/v1.0.0 on github.com itself and fails unless it peels
#    to --core-commit and the pinned tag object; both must match the pin.
node scripts/generate-qbit-core-binary-vectors.mjs \
  --tarball /tmp/qbit-release/qbit-1.0.0-x86_64-linux-gnu.tar.gz \
  --sha256sums /tmp/qbit-release/SHA256SUMS \
  --sha256sums-asc /tmp/qbit-release/SHA256SUMS.asc \
  --signer-keys /tmp/qbit-keys \
  --core-tag v1.0.0 \
  --core-commit 7ebcddb622d6e639041f005a189b048ec2a221fe \
  --check
```

Without `--check` the script overwrites the fixture. Reruns against the same
release asset are byte-identical. `--check` compares the vectors and the Core
tag, commit, and version string; a rerun from another platform's release asset
passes when the vectors match and reports which provenance fields differ. Any
vector difference, with or without a Core reference bump, is a breaking change;
see `RELEASE.md`, "Derivation Fixture Gate".

### Re-pinning the operator keys for a new Core reference

`scripts/qbit-core-release-signers.mjs` is the trust root for the oracle and is
only valid for the release it names. When the Core reference is bumped (a
breaking change, see `RELEASE.md`), re-pin it before regenerating:

```sh
REF=<new release commit>
# Manifest: record its git blob id, policy_id and mainnet release_signature_quorum.
gh api "repos/Qbit-Org/qbit/contents/contrib/keys/operator-keys/keys.json?ref=$REF" \
  --jq '{sha, content}'            # base64 -d the content to read it
# For each signer in keys.json: the public key's blob id and both fingerprints.
gh api "repos/Qbit-Org/qbit/contents/contrib/keys/operator-keys/public-keys/operator-01-release.asc?ref=$REF" \
  --jq .content | base64 -d > operator-01-release.asc
git hash-object operator-01-release.asc
gpg --batch --with-colons --import-options show-only --import operator-01-release.asc \
  | awk -F: '$1=="fpr"{print $10}'  # primary fingerprint, then signing subkey
# Tag object and commit.
git ls-remote https://github.com/Qbit-Org/qbit.git 'refs/tags/<tag>' 'refs/tags/<tag>^{}'
```

The `signing_fingerprint` in `keys.json` must equal the subkey fingerprint shown
by `gpg`; the primary fingerprint comes from the key file, since `keys.json`
does not list it. A reviewer re-derives every pinned value the same way.

## Core Sources

This contract is based on the following qbit Core code:

- `src/crypto/pqc.cpp`: `DerivePQCKey(...)`, HKDF constants, and SLH-DSA keygen.
- `src/script/descriptor.cpp`: `pqc(...)` descriptor wrapper, canonical
  descriptor-generation HKDF tuple, and recovery matching helpers.
- `src/wallet/scriptpubkeyman.cpp`: legacy persistence path and recovery
  compatibility behavior.
- `src/libbitcoinpqc/include/libbitcoinpqc/slh_dsa.h` and
  `src/libbitcoinpqc/src/slh_dsa/keygen.c`: bounded30 seeded keygen contract.

Core's recovery helpers (`src/script/descriptor.cpp:1549-1600`) also try HKDF
change `1`, and HKDF index `0` at a non-zero position, when matching a pubkey
the wallet already knows; ranged descriptor generation never produces those
keys. New qbit wallet code should generate canonical ranged descriptors and
derive their keys with `deriveP2mrDescriptorKey`, which fixes HKDF
account/change to `0`.
