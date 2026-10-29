// docs/qbit-js.md's snippets (test/doc-snippets.test.mjs keeps them in sync),
// type-checked by `pnpm typecheck` against the @qbit-oss/protocol 0.1.0
// declarations in qbit-js/protocol.d.mts, so that the guide's calls match both
// packages' signatures. Run `pnpm build` first: the "." entry's types are the
// built lib/index.d.mts.
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
import type { P2mrPqcVerifyFn } from '@qbit-oss/protocol'

declare const leafPrivateKey: Uint8Array // 32-byte BIP32 leaf private key
declare const index: number // its index in the descriptor range

const pqc = await init()
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
const address = p2mrAddressFromPubkey(pk32, 'mainnet')
// The hash of the single leaf of mr(pk(...)), which the signing keys name
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pk32))

const message = 'Log in to example.com as this address'
const digest = qbitDataSigPqcHash(qbitWalletMessageHash(message))
const signature = pqc.sign(sk64, digest)
const proof = createP2mrMessageProof({ message, address, pubkey: pk32, signature })

const valid = verifyP2mrMessageProof(message, proof, pqc.verify, { expectedAddress: address })

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

// signP2mrPsbt wraps what sign throws, so a PqcError is the cause of its error
const needsNewTransaction = (error: unknown) =>
  P2mrPsbtSigningError.is(error) && error.cause instanceof PqcError && error.cause.kind === 'SIGNING_LIMIT'

// The contract the guide states: the client's verify is a P2mrPqcVerifyFn, and
// the sign closure above is checked against P2mrPsbtSignFn where it is declared.
const verifyPqc: P2mrPqcVerifyFn = pqc.verify
void [valid, result, verifyPqc, needsNewTransaction]
