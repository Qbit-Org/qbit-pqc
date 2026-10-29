// The endpoints the worker entries accept, and the types of the client's
// methods, type-checked by `pnpm typecheck` under node16 and bundler
// resolution against the built lib/worker.d.mts and lib/worker-handler.d.mts
// (run `pnpm build` first). The DOM's Worker and MessagePort, and Node's
// worker_threads Worker, MessagePort and parentPort, must all fit.
/// <reference types="node" />
import { MessageChannel as NodeMessageChannel, Worker as NodeWorker, parentPort } from 'node:worker_threads'

import { init } from '@qbit-oss/pqc'
import { PqcError } from '@qbit-oss/pqc/external-wasm'
import { createPqcWorkerClient, type PqcWorkerClient } from '@qbit-oss/pqc/worker'
import { servePqcWorker, type PqcWorkerEndpoint } from '@qbit-oss/pqc/worker/handler'

const client: PqcWorkerClient = createPqcWorkerClient(new Worker('pqc-worker.js', { type: 'module' }))
createPqcWorkerClient(new MessageChannel().port1)
createPqcWorkerClient(new NodeWorker('./pqc-worker.mjs'))
createPqcWorkerClient(new NodeMessageChannel().port1)

const stop: () => void = servePqcWorker({ client: init() })
servePqcWorker({ client: await init(), endpoint: new MessageChannel().port2 })
if (parentPort !== null) {
  servePqcWorker({ endpoint: parentPort })
}
stop()

const endpoint: PqcWorkerEndpoint = new MessageChannel().port1
void endpoint

const sk = new Uint8Array(client.constants.SK_SIZE)
const msg = new Uint8Array(32)
const signature: Uint8Array = await client.sign(sk, msg, { allowLargeMessage: true })
const { sig, stats } = await client.signWithStats(sk, msg)
const valid: boolean = await client.verify(new Uint8Array(32), msg, signature)
const { pk32, sk64 } = await client.deriveP2mrDescriptorKey(new Uint8Array(32), 0)
const { publicKey, secretKey } = await client.keygen(new Uint8Array(client.constants.MIN_ENTROPY))
const ok: boolean = await client.secretKeyValidate(secretKey)
void [sig, stats.forscAttempts, valid, pk32, sk64, publicKey, ok]
client.close()

await client.sign(sk, msg).catch((error: unknown) => {
  if (error instanceof PqcError) {
    void error.kind
  }
})

// @ts-expect-error The methods return promises.
const blocking: Uint8Array = client.sign(sk, msg)
void blocking
