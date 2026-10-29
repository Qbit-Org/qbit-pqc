import { deriveP2mrDescriptorKey, init, secretKeyValidate } from '@qbit-oss/pqc'

await init()

// The 32-byte private BIP32 leaf key a wallet derives at m/87h/0h/0h/0/42, the
// receive key at index 42 of mr(pk(pqc(<xprv>/87h/0h/0h/0/*))) on mainnet. This
// one is the test leaf of vector mainnet_external_index_42 in
// fixtures/qbit-core-derivation.json.
const leafPrivateKey = Buffer.from('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100', 'hex')
const index = 42

const { pk32, sk64 } = deriveP2mrDescriptorKey(leafPrivateKey, index)

// The public key qbit Core's descriptor wallet derives for that leaf and index.
const corePk32 = '86139270dc44be7079b37dd241eae4587d1f30940bceaf03661b7ab237c8806e'

console.log(Buffer.from(pk32).toString('hex') === corePk32) // true
console.log(secretKeyValidate(sk64)) // true
