// The worker_threads worker scripts/consumer-smoke.mjs starts, copied beside
// it into the clean consumer project by scripts/run-consumer-smoke.mjs. It
// imports the package BY NAME and serves the client that the
// ./external-wasm entry's default init() loads from the installed
// wasm/pqc.wasm.
import { parentPort } from 'node:worker_threads'

import { init } from '@qbit-oss/pqc/external-wasm'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init(), endpoint: parentPort })
