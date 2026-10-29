// Type-level compatibility of the derived-key types, checked by `pnpm typecheck`
// under node16 and bundler resolution against the built lib/index.d.mts.
import { derivePQCKey, type PqcClient, type PqcDerivedKey, type PqcDerivedKeyPair } from '@qbit-oss/pqc'

declare const client: PqcClient
declare const pk32: Uint8Array
declare const sk64: Uint8Array

// Code that builds its own key pair as a PqcDerivedKey keeps type-checking.
const own: PqcDerivedKey = { pk32, sk64 }
// @ts-expect-error A PqcDerivedKey has no aliases.
void own.secretKey

// The derive functions return the aliases as required fields, and their result
// is still a PqcDerivedKey.
const derived: PqcDerivedKeyPair = client.deriveP2mrDescriptorKey(sk64.subarray(0, 32), 0)
const secretKey: Uint8Array = derived.secretKey
const publicKey: Uint8Array = derivePQCKey(sk64, 0, 0, 0).publicKey
const asBefore: PqcDerivedKey = derived
void [secretKey, publicKey, asBefore]
