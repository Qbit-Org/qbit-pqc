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
npm install @qbit-oss/pqc @qbit-oss/protocol@~0.1.0
```

`~0.1.0` keeps `@qbit-oss/protocol` on the 0.1 line this page was checked
against: below 1.0, a minor release such as 0.2.0 may change the callbacks and
helpers used here.

## Keys and addresses

Derive the key for a wallet position as the
[derivation contract](derivation.md) describes, then the address of its
single-key `mr(pk(...))` output and the hash of that output's leaf, which
signing keys name:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
import { PqcError, init } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  P2mrPsbtSigningError,
  bytesToHex,
  createP2mrMessageProof,
  p2mrAddressFromPubkey,
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
const address = p2mrAddressFromPubkey(pk32, 'mainnet')
// The hash of the single leaf of mr(pk(...)), which the signing keys name
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pk32))
```

`pk32` is the public key qbit-js takes wherever it asks for a P2MR `pubkey`;
qbit-js never needs `sk64`. The values that cross between the two packages are
all `Uint8Array`s:

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
`verifyP2mrMessageProof` returns `false` for anything `verifyPqc` throws. The
named `verify` export looks up the client when it is called and throws a
`PqcError` with `kind: 'NOT_INITIALIZED'` until an `init()` call has
succeeded, so called too early it makes every proof read as invalid. Prefer
the client from `await init()`, as above. `await ready()` before verifying
works only if some code calls `init()`: `ready()` does not start a load, and
without one it waits forever.

## PSBT signing

[`signP2mrPsbt`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2324)
computes the sighash of each signing plan (an input, public key and leaf hash)
and asks a `sign` callback for its signature:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
declare const psbt: Psbt // from parsePsbt or createP2mrPsbt
declare function secretKeyFor(pubkey: Uint8Array): Uint8Array | undefined // the wallet's keyring
// Persists the counts in one transaction, refusing any that would take a key past 2^30
declare function reserveSignatures(uses: Map<string, number>): Promise<void>

const keys: P2mrSigningKey[] = [{ inputIndex: 0, pubkey: pk32, leafHash }]
const sign: P2mrPsbtSignFn = (sighash, context) => {
  const secretKey = secretKeyFor(context.pubkey)
  return secretKey === undefined ? undefined : pqc.sign(secretKey, sighash)
}

validateP2mrSigningPlans({ psbt, keys })
const uses = new Map<string, number>() // signing plans per public key, by hex
for (const { pubkey } of keys) {
  const hex = bytesToHex(pubkey)
  uses.set(hex, (uses.get(hex) ?? 0) + 1)
}
await reserveSignatures(uses)
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

## Signature counters

A key is designed for at most 2^30 signatures, and this package counts none
(see [Usage bound](signing.md#usage-bound)); every PSBT signature and message
proof uses one. `signP2mrPsbt` reports each stored signature to an optional
[`onSigned`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2161-L2163)
callback, but `onSigned` must be synchronous too, so it cannot wait for
storage to persist a counter. Reserve the uses before signing instead, as the
snippet above does:
[`validateP2mrSigningPlans`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2295)
runs the same checks on `keys` as `signP2mrPsbt`, without calling a signer or
changing the PSBT, so a PSBT that would be refused costs no reservation. Then
count the plans for each public key, persist those counts in one step that
refuses any key they would take past 2^30, and only then call `signP2mrPsbt`.
A plan that failed in phase `'sign'` counts as used.

## Where to sign in a Chrome extension

A signature takes about 0.6 s and blocks the thread it runs on, so an MV3
extension signs in a dedicated worker that an offscreen document starts, as
[Service workers](loading.md#service-workers) describes. Relaying a request to
that worker is asynchronous, and `sign` cannot wait for a reply. Run the whole
`signP2mrPsbt` call, `sign` and `onSigned` included, in the worker that holds
the initialized client, and send it the PSBT and keys in one request rather
than relaying each signature. `chrome.runtime.sendMessage` carries only
JSON-serializable messages, so send the PSBT's `serializePsbt` bytes and each
key's `pubkey` and `leafHash` as hex (`bytesToHex`), and turn them back into
bytes in the worker (`hexToBytes`, then `parsePsbt` for the PSBT);
`postMessage` from the offscreen document keeps `Uint8Array`s. Sign
message proofs there too. `verify` takes a few milliseconds and can run
wherever a client is initialized.

That worker cannot use `chrome.storage`: an offscreen document gets only
`chrome.runtime`, and a dedicated worker no extension API. Keep the counters in
IndexedDB, which the worker can open and the service worker and extension pages
share, so one place validates, reserves and signs. Reserving in the service
worker with `chrome.storage` before relaying also works, but splits those
steps: the service worker must then run `validateP2mrSigningPlans` and count
the plans itself, and the worker must sign only the keys it was sent.

## Failures and retries

When `sign` throws, returns a promise or returns a malformed signature, or
`onSigned` throws or returns a promise, `signP2mrPsbt` throws a
[`P2mrPsbtSigningError`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts#L2212)
whose `psbt` holds every signature stored so far and whose `signed` lists
them. Retry with that `psbt` and only the keys not in `signed`; a key whose
signature is already present is refused before any signer call. Re-signing
the same sighash with an intact key returns the same signature, so a retried
plan reveals nothing new; [Usage bound](signing.md#usage-bound) says when that
holds.

`signP2mrPsbt` wraps what `sign` throws, so a `PqcError` from `pqc.sign` is
the `cause` of the `P2mrPsbtSigningError` (in phase `'sign'`), not the error
you catch. One with `kind: 'SIGNING_LIMIT'` recurs for the same sighash, so
change the transaction before signing again:

<!-- snippet: test/types/qbit-js-guide.mts -->
```ts
// signP2mrPsbt wraps what sign throws, so a PqcError is the cause of its error
const needsNewTransaction = (error: unknown) =>
  P2mrPsbtSigningError.is(error) && error.cause instanceof PqcError && error.cause.kind === 'SIGNING_LIMIT'
```

## Checklist

- Make sure an `init()` call has succeeded before `verifyP2mrMessageProof`
  calls `verifyPqc`: the named `verify` resolves the client at call time, and
  its `NOT_INITIALIZED` error reads as an invalid proof. Passing `pqc.verify`
  from `await init()` rules that out.
- Sign `qbitDataSigPqcHash(qbitWalletMessageHash(message))` or the sighash
  `signP2mrPsbt` passes, never the message text or transaction bytes.
- Keep `sign` and `onSigned` synchronous, and run `signP2mrPsbt` in the worker
  that holds the client.
- Reserve each public key's counter uses before `signP2mrPsbt`, after
  `validateP2mrSigningPlans` passes, in storage the reserving context can use,
  and stop at 2^30 per key.
- After a `P2mrPsbtSigningError`, retry with its `psbt` and only the keys not
  in `signed`, and look for a `SIGNING_LIMIT` `PqcError` in its `cause`.

## qbit-js references

- [qbit-js README](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/README.md)
- [`@qbit-oss/protocol` README](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/README.md):
  message-proof binding, the signing preflight, the retry contract and
  sighash types.
- [`packages/protocol/src/index.ts`](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/src/index.ts):
  the declarations this page relies on, with their full documentation.
