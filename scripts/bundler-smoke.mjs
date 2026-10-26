// Bundler smoke page for @qbit-oss/pqc. scripts/run-bundler-smoke.mjs copies
// it into each page of a throwaway project, next to the golden fixture, and
// each bundler builds it from there. It imports the package BY NAME, as an
// external consumer would, and reports through
// globalThis.__QBIT_PQC_BUNDLER_SMOKE__ without logging keys or signatures.
import { constants } from '@qbit-oss/pqc'

import { fixture } from './golden-fixture.js'

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error('invalid fixture hex length')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function deterministicEntropy(seedByte) {
  const entropy = new Uint8Array(constants.MIN_ENTROPY)
  for (let i = 0; i < entropy.length; i += 1) {
    entropy[i] = (seedByte + ((i * 37) % 256)) & 0xff
  }
  return entropy
}

function check(condition, label) {
  if (!condition) {
    throw new Error(label)
  }
}

async function checkVectors(loadClient) {
  const client = await loadClient()
  const vectorNames = []
  for (const vector of fixture.vectors) {
    const message = hexToBytes(vector.messageHex)
    const pair = client.keygen(deterministicEntropy(vector.seedByte))
    check(bytesToHex(pair.publicKey) === vector.publicKeyHex, `${vector.name} public key mismatch`)
    check(bytesToHex(pair.secretKey) === vector.secretKeyHex, `${vector.name} secret key mismatch`)
    check(client.secretKeyValidate(pair.secretKey), `${vector.name} secret key validation failed`)

    const signature = client.sign(pair.secretKey, message)
    check(bytesToHex(signature) === vector.signatureHex, `${vector.name} signature mismatch`)
    check(client.verify(pair.publicKey, message, signature), `${vector.name} verification failed`)

    const tampered = new Uint8Array(signature)
    tampered[0] ^= 0xff
    check(!client.verify(pair.publicKey, message, tampered), `${vector.name} tampered signature verified`)
    vectorNames.push(vector.name)
  }
  return vectorNames
}

// `loadClient` is the loading recipe under test.
export async function runSmoke(recipe, loadClient) {
  let report
  try {
    report = { ok: true, recipe, vectorNames: await checkVectors(loadClient) }
  } catch (error) {
    report = { ok: false, recipe, error: String(error?.stack ?? error) }
  }
  globalThis.__QBIT_PQC_BUNDLER_SMOKE__ = report
}
