// The browser snippets of README.md and docs/worker.md: a module worker that
// serves the client, and the page that calls it (test/doc-snippets.test.mjs
// keeps them in sync). Type-checked by `pnpm typecheck`; run `pnpm build`
// first.
// pqc-worker.js
import { init } from '@qbit-oss/pqc'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init() })

import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'

declare const publicKey: Uint8Array
declare const secretKey: Uint8Array
declare const digest: Uint8Array

const worker = new Worker(new URL('./pqc-worker.js', import.meta.url), { type: 'module' })
const pqc = createPqcWorkerClient(worker)

const signature = await pqc.sign(secretKey, digest)
const valid = await pqc.verify(publicKey, digest, signature)
void (valid satisfies boolean)
