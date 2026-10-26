import createPqcModule from '../wasm/pqc.mjs'
import { init, type PqcClient, type PqcWasmModule } from '../src/index'

export interface FreshClient {
  client: PqcClient
  // The module the client runs on, which the client does not expose.
  module: PqcWasmModule
}

// init() shares one client among calls with the same options. A new
// createModule function each time gives a test a module of its own, built
// here and handed back with the client. `initClient` is the init() to call,
// for a test that loads its own copy of the package.
export async function freshClient(initClient: typeof init = init): Promise<FreshClient> {
  let module: PqcWasmModule | undefined
  const client = await initClient({
    createModule: async options => (module = await createPqcModule(options)),
  })
  if (module === undefined) {
    throw new Error('init() did not build a module of its own')
  }
  return { client, module }
}
