import { constants, init, keygen, sign, verify } from '@qbit-oss/pqc'

await init()

const entropy = crypto.getRandomValues(new Uint8Array(constants.MIN_ENTROPY))
const { publicKey, secretKey } = keygen(entropy)

const message = new TextEncoder().encode('hello, qbit')
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
const signature = sign(secretKey, digest)

console.log(verify(publicKey, digest, signature)) // true

const tampered = signature.slice()
tampered[0] ^= 1
console.log(verify(publicKey, digest, tampered)) // false
