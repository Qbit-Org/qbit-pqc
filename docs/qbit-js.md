# Using @qbit-oss/pqc with qbit-js

[qbit-js](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/README.md)'s
`@qbit-oss/protocol` builds P2MR addresses, message proofs and PSBTs, and
leaves SLH-DSA signing and verification to the caller. This page shows where
this package plugs in: which bytes to sign, which callbacks to pass, and what
qbit-js expects of them. It was checked against `@qbit-oss/protocol` 0.1.0
(Qbit-Org/qbit-js at `2f4637f`) and `@qbit-oss/pqc` 0.1.1; every qbit-js link
below is pinned to that commit.

## Install

```sh
npm install @qbit-oss/pqc @qbit-oss/protocol
```

## Keys and addresses

Derive the key for a wallet position as the
[derivation contract](derivation.md) describes, then build the single-key leaf
qbit-js signs for:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
import { init } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  createP2mrMessageProof,
  p2mrAddressFromRoot,
  p2mrLeafHash,
  qbitDataSigPqcHash,
  qbitWalletMessageHash,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  verifyP2mrMessageProof,
  type P2mrPsbtSignFn,
  type P2mrSigningKey,
  type Psbt,
} from '@qbit-oss/protocol'

declare const leafPrivateKey: Uint8Array // 32-byte BIP32 leaf private key
declare const index: number // its index in the descriptor range

const pqc = await init()
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
// mr(pk(...)) has a single leaf, so its leaf hash is the address's merkle root
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pk32))
const address = p2mrAddressFromRoot(leafHash, 'mainnet')
```

`pk32` is the public key qbit-js takes wherever it asks for a P2MR `pubkey`;
qbit-js never needs `sk64`. The values that cross between the
two packages are all `Uint8Array`s:

| Value | qbit-js | `@qbit-oss/pqc` | Bytes |
| --- | --- | --- | --- |
| Public key | `pubkey` (`P2MR_PROGRAM_BYTES`) | `pk32`, `constants.PK_SIZE` | 32 |
| Secret key | not used | `sk64`, `constants.SK_SIZE` | 64 |
| Digest to sign | `sighash`, `qbitDataSigPqcHash(...)` | `msg` of `sign` and `verify` | 32 |
| Signature | `signature` (`PQC_SIGNATURE_BYTES`) | what `sign` returns, `constants.SIG_SIZE` | 3680 |
| Leaf hash | `leafHash` | not used | 32 |

A 32-byte digest is far below `constants.MAX_MESSAGE_SIZE`, so no call here
needs `allowLargeMessage`.

## Message proofs

[`createP2mrMessageProof`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L928)
takes the signature from the caller. Sign the digest qbit-js derives from the
message, never the message text: this package applies no domain separation of
its own, and the proof's signature is checked over that digest.

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
const message = 'Log in to example.com as this address'
const digest = qbitDataSigPqcHash(qbitWalletMessageHash(message))
const signature = pqc.sign(sk64, digest)
const proof = createP2mrMessageProof({ message, address, pubkey: pk32, signature })
```

To check a proof, pass the client's `verify` as
[`verifyP2mrMessageProof`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L1007)'s
`verifyPqc`, with the address or network the proof must be for:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
const valid = verifyP2mrMessageProof(message, proof, pqc.verify, { expectedAddress: address })
```

[`P2mrPqcVerifyFn`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L341-L345)
is `(pubkey, digest, signature) => boolean`, the first three parameters of
`verify(pk, msg, sig, options?)` in the same order. The client's methods are
closures, so `pqc.verify` can be passed without binding it.
`verifyP2mrMessageProof` returns `false` for anything `verifyPqc` throws, so
the named `verify` export, which throws a `PqcError` with
`kind: 'NOT_INITIALIZED'` until an `init()` call has succeeded, would make
every proof read as invalid. Pass the client's method, or `await ready()`
before passing the named export.

## PSBT signing

[`signP2mrPsbt`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2324)
computes the sighash of each signing plan (an input, public key and leaf hash)
and asks a `sign` callback for its signature:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
declare const psbt: Psbt // from parsePsbt or createP2mrPsbt
declare function secretKeyFor(pubkey: Uint8Array): Uint8Array | undefined // the wallet's keyring
declare function reserveSignatures(pubkey: Uint8Array, count: number): Promise<void> // persists a counter

const keys: P2mrSigningKey[] = [{ inputIndex: 0, pubkey: pk32, leafHash }]
const sign: P2mrPsbtSignFn = (sighash, context) => {
  const secretKey = secretKeyFor(context.pubkey)
  return secretKey === undefined ? undefined : pqc.sign(secretKey, sighash)
}

validateP2mrSigningPlans({ psbt, keys })
await reserveSignatures(pk32, keys.length)
const result = signP2mrPsbt({ psbt, keys, sign })
```

- [`P2mrPsbtSignFn`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2119)
  must return synchronously. A returned promise fails the plan with a
  `P2mrPsbtSigningError` in phase `'sign'`, whose `cause` has the code
  `INVALID_SIGNER`, and the key use still counts as consumed. `pqc.sign` is
  synchronous once `init()` has resolved.
- Return `undefined`, not `null`, to skip a plan.
- Return the 3680-byte signature as `sign` produced it. For a sighash type
  other than `SIGHASH_DEFAULT`, qbit-js appends the type byte itself.
- `context` also carries the `hashType`, the unsigned `tx` and the
  `spentOutputs` being committed to, for an approval screen. Only
  `SIGHASH_DEFAULT` is signed unless the caller passes
  `allowNonDefaultSighash: true`; the protocol README explains when that is
  safe.

## Where to sign in a Chrome extension

A signature takes about 0.6 s and blocks the thread it runs on, so an MV3
extension signs in a dedicated worker, as
[Service workers](loading.md#service-workers) describes. Relaying a request to
that worker is asynchronous, and `sign` cannot wait for a reply. Run the whole
`signP2mrPsbt` call, `sign` and `onSigned` included, inside the worker that
holds the initialized client, and send it the PSBT and keys in one request
rather than relaying each signature. Sign message proofs there too. `verify`
takes a few milliseconds and can run wherever a client is initialized.

## Signature counters

A key is designed for at most 2^30 signatures, and this package counts none
(see [Usage bound](signing.md#usage-bound)); every PSBT signature and message
proof uses one. `signP2mrPsbt` reports each stored signature to an optional
[`onSigned`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2161-L2163)
callback, but `onSigned` must be synchronous too, so it cannot wait for
`chrome.storage` or IndexedDB to persist a counter. Reserve the uses before
signing instead, as the snippet above does:
[`validateP2mrSigningPlans`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2295)
runs the same checks on `keys` as `signP2mrPsbt`, without calling a signer or
changing the PSBT, so a PSBT that would be refused costs no reservation. Then
persist one use per entry of `keys` for each public key, refuse to sign once a
key would pass 2^30, and only then call `signP2mrPsbt`. A plan that failed in
phase `'sign'` counts as used.

## Checklist

- Await `init()` before passing `verify` to qbit-js, and pass the client's
  method; a throwing `verifyPqc` reads as an invalid proof.
- Sign `qbitDataSigPqcHash(qbitWalletMessageHash(message))` or the sighash
  `signP2mrPsbt` passes, never the message text or transaction bytes.
- Keep `sign` and `onSigned` synchronous, and run `signP2mrPsbt` in the worker
  that holds the client.
- Reserve counter uses before `signP2mrPsbt`, after
  `validateP2mrSigningPlans` passes, and stop at 2^30 per key.
- After a
  [`P2mrPsbtSigningError`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2212),
  retry with its `psbt` and only the keys not in its `signed` list. Re-signing
  the same sighash with an intact key returns the same signature, so the retry
  reveals nothing new; [Usage bound](signing.md#usage-bound) says when that
  holds. A `PqcError` with `kind: 'SIGNING_LIMIT'` recurs for the same
  sighash, so change the transaction before signing again.

## qbit-js references

- [qbit-js README](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/README.md)
- [`@qbit-oss/protocol` README](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/README.md):
  message-proof binding, the signing preflight, the retry contract and
  sighash types.
- [`packages/protocol/src/index.ts`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts):
  the declarations this page relies on, with their full documentation.
