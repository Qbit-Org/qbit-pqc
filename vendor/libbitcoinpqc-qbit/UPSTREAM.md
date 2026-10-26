# Vendored libbitcoinpqc-qbit Inventory

Source: `Qbit-Org/qbit-libbitcoinpqc`

Pinned commit: `70008b9362f4f35f3be94283173fb41d28badb38`

The pinned commit is upstream `main` after Qbit-Org/qbit-libbitcoinpqc#10
(fixes Qbit-Org/qbit-libbitcoinpqc#9) was squash-merged; its tree is identical
to that pull request's reviewed head
`55b20eb4a45f113b3455ba207674a3b825cf0f53`. It makes `bitcoin_pqc_sign` report
an inconsistent secret key as `BITCOIN_PQC_ERROR_BAD_KEY` instead of
`BAD_SIGNATURE`, adds the append-only `BITCOIN_PQC_ERROR_OUT_OF_MEMORY` code
for every internal allocation failure in keygen and sign (including the keygen
seed-derivation buffer, via the low-level `SLH_DSA_KEYGEN_ERROR_OUT_OF_MEMORY`
facade code), and makes `slh_dsa_sign` clear its outputs on rejected arguments.
Keys, signatures and verification results are unchanged. qbit Core v1.0.0
vendors an older copy and calls the low-level `slh_dsa_keygen` and
`slh_dsa_sign` directly, treating any nonzero result as failure, so these codes
do not change its behaviour. The pin also includes the SLH-DSA secret-key
scratch zeroization (Qbit-Org/qbit-libbitcoinpqc#5) and the single
released-stack burn at the return of each secret-key entry point, which
replaces Qbit-Org/qbit-libbitcoinpqc#5's per-SHA-2-block burn
(Qbit-Org/qbit-libbitcoinpqc#6).

Every file listed below is blob-equal to the pinned commit: for each path,
`git hash-object <file>` here matches `git rev-parse <commit>:<path>` in the
upstream checkout. There are no local patches.

`fixtures/slh-dsa-golden.json` intentionally still records the `d165da6a`
source of upstream `tests/golden_vector_tests.rs` (blob `57d0d702`): that file
is unchanged at the pinned commit and the vectors are byte-identical, so the
fixture provenance only moves when the upstream vectors do.

This package intentionally vendors only the C/header inventory needed for the
SLH-DSA-SHA2-128s-bounded30 baseline WASM build. It does not vendor
Dilithium/ML-DSA sources, Haraka sources, SHAKE sources, upstream test helpers,
native AVX2 implementation sources, or generated bindings for other language
targets.

## Copied libbitcoinpqc files

- `LICENSE`
- `include/libbitcoinpqc/bitcoinpqc.h`
- `include/libbitcoinpqc/sign_stats.h`
- `include/libbitcoinpqc/slh_dsa.h`
- `src/bitcoinpqc.c`
- `src/secure_zero.h`
- `src/slh_dsa/keygen.c`
- `src/slh_dsa/sign.c`
- `src/slh_dsa/utils.c`
- `src/slh_dsa/validate.c`
- `src/slh_dsa/verify.c`

## Copied SPHINCS+ ref files

- `sphincsplus/LICENSE`
- `sphincsplus/LICENSES/0BSD.txt`
- `sphincsplus/LICENSES/CC0-1.0.txt`
- `sphincsplus/LICENSES/LicenseRef-SPHINCS-PLUS-Public-Domain.txt`
- `sphincsplus/LICENSES/MIT-0.txt`
- `sphincsplus/LICENSES/MIT.txt`
- `sphincsplus/ref/address.c`
- `sphincsplus/ref/address.h`
- `sphincsplus/ref/api.h`
- `sphincsplus/ref/avx2_compat.h`
- `sphincsplus/ref/context.h`
- `sphincsplus/ref/fors.c`
- `sphincsplus/ref/fors.h`
- `sphincsplus/ref/hash.h`
- `sphincsplus/ref/hash_sha2.c`
- `sphincsplus/ref/merkle.c`
- `sphincsplus/ref/merkle.h`
- `sphincsplus/ref/opt_flags.h`
- `sphincsplus/ref/params.h`
- `sphincsplus/ref/params/params-sphincs-sha2-128s-bounded30.h`
- `sphincsplus/ref/randombytes.h`
- `sphincsplus/ref/randombytes_custom.c`
- `sphincsplus/ref/sha2.c`
- `sphincsplus/ref/sha2.h`
- `sphincsplus/ref/sha2_offsets.h`
- `sphincsplus/ref/sha2_armv8_sha.c`
- `sphincsplus/ref/sha2_armv8_sha.h`
- `sphincsplus/ref/sha2_x86_shani.c`
- `sphincsplus/ref/sha2_x86_shani.h`
- `sphincsplus/ref/sign.c`
- `sphincsplus/ref/sign_stats.c`
- `sphincsplus/ref/sign_stats.h`
- `sphincsplus/ref/thash.h`
- `sphincsplus/ref/thash_sha2_simple.c`
- `sphincsplus/ref/utils.c`
- `sphincsplus/ref/utils.h`
- `sphincsplus/ref/utilsx1.c`
- `sphincsplus/ref/utilsx1.h`
- `sphincsplus/ref/wots.c`
- `sphincsplus/ref/wots.h`
- `sphincsplus/ref/wotsx1.c`
- `sphincsplus/ref/wotsx1.h`

## Blob Manifest

`MANIFEST` records the pinned commit and the upstream git blob SHA-1 of every
vendored file. `pnpm check:vendor` (run in CI) recomputes each blob SHA in Node
and fails on any changed byte, missing file, file not listed in the manifest
(other than `UPSTREAM.md` and `MANIFEST`), symlink, a manifest commit that
differs from the pin, or an inventory above that differs from the
manifest.

CI also fetches the pinned commit from upstream and runs the `--upstream`
check, so a change that edits a vendored file and rewrites its `MANIFEST` line
to match still fails. To run that check locally, or to regenerate `MANIFEST`
when re-vendoring (after copying the files and updating the pin and
inventory), use a clone that contains the pinned commit; its checked-out branch
does not matter:

```sh
git clone https://github.com/Qbit-Org/qbit-libbitcoinpqc <qbit-libbitcoinpqc checkout>
node scripts/check-vendor.mjs --upstream <qbit-libbitcoinpqc checkout>
node scripts/check-vendor.mjs --write-from <qbit-libbitcoinpqc checkout>
```

Both read blob SHAs from `git ls-tree` at the pinned commit, never from the
local copies. `--write-from` writes `MANIFEST` only when every local file
matches its upstream blob, and fails if a vendored path is absent upstream.

## License Notes

`libbitcoinpqc-qbit` is MIT licensed. The vendored SPHINCS+ reference code is
covered by the upstream `sphincsplus/LICENSE` expression and license texts
under `sphincsplus/LICENSES/`.
