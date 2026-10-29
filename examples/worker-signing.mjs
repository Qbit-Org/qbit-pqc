import { isMainThread, parentPort, Worker } from 'node:worker_threads'

import { init } from '@qbit-oss/pqc'
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

if (isMainThread) {
  // This same file, started as a worker_threads worker, runs the else branch.
  const worker = new Worker(new URL(import.meta.url))
  const pqc = createPqcWorkerClient(worker)

  const entropy = crypto.getRandomValues(new Uint8Array(pqc.constants.MIN_ENTROPY))
  const { publicKey, secretKey } = await pqc.keygen(entropy)
  const message = new TextEncoder().encode('hello, qbit')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
  const signature = await pqc.sign(secretKey, digest)

  console.log(signature.length) // 3680
  console.log(await pqc.verify(publicKey, digest, signature)) // true

  pqc.close()
  await worker.terminate()
} else {
  servePqcWorker({ client: init(), endpoint: parentPort })
}
