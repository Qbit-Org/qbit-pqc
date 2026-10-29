// Type-checked by scripts/run-consumer-smoke.mjs in the project that installed
// the packed tarball, with `moduleResolution: node10`, which reads no
// `exports` map: each subpath's types must resolve through the package's
// `typesVersions` (tsconfig.json beside this file).
import { init as initEmbedded, type PqcClient } from '@qbit-oss/pqc'
import { init, PqcError } from '@qbit-oss/pqc/external-wasm'

export async function load(): Promise<PqcClient> {
  const client: PqcClient = await init({ locateFile: path => `/wasm/${path}` })
  return client.constants.SIG_SIZE === 3680 ? client : initEmbedded()
}

export function isPqcError(error: unknown): error is PqcError {
  return error instanceof PqcError
}
