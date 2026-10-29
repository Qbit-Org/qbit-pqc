// The README's API overview (test/doc-snippets.test.mjs keeps the two in sync),
// type-checked by `pnpm typecheck` under node16 and bundler resolution, so its
// calls match the built lib/index.d.mts. Run `pnpm build` first.
import { init } from '@qbit-oss/pqc'

declare const leafPrivateKey: Uint8Array // 32-byte BIP32 leaf private key
declare const index: number // descriptor range position, 0 to 0x7fffffff
declare const message: Uint8Array // 32-byte digest of the data to sign

const pqc = await init()
const entropy = crypto.getRandomValues(new Uint8Array(pqc.constants.MIN_ENTROPY))
const { pk32, sk64 } = pqc.deriveP2mrDescriptorKey(leafPrivateKey, index)
const { publicKey, secretKey } = pqc.keygen(entropy)
const signature = pqc.sign(secretKey, message)
const { sig: diagnosticSignature, stats } = pqc.signWithStats(secretKey, message)
const valid = pqc.verify(publicKey, message, signature)
const secretKeyOk = pqc.secretKeyValidate(secretKey)
