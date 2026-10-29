// The Chrome MV3 relay of docs/worker.md: the dedicated worker, the offscreen
// document that starts it and holds the client, and the service worker that
// sends it requests (test/doc-snippets.test.mjs keeps them in sync).
// Type-checked by `pnpm typecheck`; run `pnpm build` first.

// The chrome.* calls the snippets make.
declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        listener: (message: any, sender: unknown, sendResponse: (response?: unknown) => void) => boolean
      ): void
    }
    sendMessage(message: unknown): Promise<any>
  }
  offscreen: {
    hasDocument(): Promise<boolean>
    createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>
  }
}
declare const secretKey: Uint8Array
declare const digest: Uint8Array

// pqc-worker.js, started by the offscreen document
import { init } from '@qbit-oss/pqc/external-wasm'
import { servePqcWorker } from '@qbit-oss/pqc/worker/handler'

servePqcWorker({ client: init({ locateFile: path => new URL(`/wasm/${path}`, location.origin).href }) })

// offscreen.js, loaded by offscreen.html
import { createPqcWorkerClient } from '@qbit-oss/pqc/worker'

const worker = new Worker(new URL('./pqc-worker.js', import.meta.url), { type: 'module' })
const pqc = createPqcWorkerClient(worker, { onError: event => console.error('PQC worker error', event) })

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'pqc-sign') {
    return false
  }
  pqc.sign(Uint8Array.from(message.secretKey), Uint8Array.from(message.digest)).then(
    signature => sendResponse({ signature: Array.from(signature) }),
    error => sendResponse({ error: `${error.name}: ${error.message}`, kind: error.kind })
  )
  return true
})

// In the service worker
// One createDocument() call, which concurrent requests share; a failed one is
// tried again by the next request.
let offscreenDocument: Promise<void> | undefined
function ensureOffscreenDocument(): Promise<void> {
  offscreenDocument ??= (async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Sign with @qbit-oss/pqc off the service worker thread',
      })
    }
  })().catch(error => {
    offscreenDocument = undefined
    throw error
  })
  return offscreenDocument
}

// sendMessage() rejects with "Receiving end does not exist" until the
// offscreen document's script has added its listener, which can be after
// createDocument() resolves: retry on that error only, for at most 5 s.
async function sendToOffscreen(message: object): Promise<any> {
  await ensureOffscreenDocument()
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (error) {
      if (attempt === 50 || !String(error).includes('Receiving end does not exist')) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

const response = await sendToOffscreen({
  type: 'pqc-sign',
  secretKey: Array.from(secretKey),
  digest: Array.from(digest),
})
void response
