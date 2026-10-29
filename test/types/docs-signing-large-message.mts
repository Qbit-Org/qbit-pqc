// docs/signing.md's allowLargeMessage snippet (test/doc-snippets.test.mjs keeps
// the two in sync), type-checked by `pnpm typecheck`.
import { init } from '@qbit-oss/pqc'

declare const publicKey: Uint8Array
declare const secretKey: Uint8Array
declare const payload: Uint8Array // longer than constants.MAX_MESSAGE_SIZE

const pqc = await init()
const signature = pqc.sign(secretKey, payload, { allowLargeMessage: true })
const valid = pqc.verify(publicKey, payload, signature, { allowLargeMessage: true })
void valid
