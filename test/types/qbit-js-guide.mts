// docs/qbit-js.md's snippets (test/doc-snippets.test.mjs keeps them in sync),
// type-checked by `pnpm typecheck` against the @qbit-oss/protocol 0.1.0
// declarations in qbit-js/protocol.d.mts, so that the guide's calls match both
// packages' signatures. Run `pnpm build` first: the "." entry's types are the
// built lib/index.d.mts.
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
import type { P2mrPqcVerifyFn } from '@qbit-oss/protocol'

declare const leafPrivateKey: Uint8Array // 32-byte BIP32 leaf private key
declare const index: number // its index in the descriptor range

const pqc = await init()
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
// mr(pk(...)) has a single leaf, so its leaf hash is the address's merkle root
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pk32))
const address = p2mrAddressFromRoot(leafHash, 'mainnet')

const message = 'Log in to example.com as this address'
const digest = qbitDataSigPqcHash(qbitWalletMessageHash(message))
const signature = pqc.sign(sk64, digest)
const proof = createP2mrMessageProof({ message, address, pubkey: pk32, signature })

const valid = verifyP2mrMessageProof(message, proof, pqc.verify, { expectedAddress: address })

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

// The contract the guide states: the client's verify is a P2mrPqcVerifyFn, and
// the sign closure above is checked against P2mrPsbtSignFn where it is declared.
const verifyPqc: P2mrPqcVerifyFn = pqc.verify
void [valid, result, verifyPqc]
