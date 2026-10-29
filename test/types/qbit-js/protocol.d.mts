// Declarations copied from Qbit-Org/qbit-js packages/protocol/src/index.ts at
// 2f4637f08be83d4d47ddb6d79eb384d61fccecfb (@qbit-oss/protocol 0.1.0), each
// under the line range it came from, so test/types/qbit-js-guide.mts can
// type-check docs/qbit-js.md without a qbit-js dependency
// (test/types/tsconfig.node16.json maps @qbit-oss/protocol here). The JSDoc
// above each declaration is removed, and functions and classes keep only their
// signatures (`export declare`, a default parameter made optional, no
// `override`); types and members are otherwise as written there. When the
// guide moves to a newer @qbit-oss/protocol, copy these again from that
// version.

// index.ts:89
export declare const P2MR_LEAF_VERSION_V1 = 0xc0
// index.ts:135
export declare const QBIT_WALLET_MESSAGE_DOMAIN = 'QbitWalletSignedMessage'
// index.ts:136
export declare const QBIT_DATA_SIG_PQC_DOMAIN = 'QbitDataSigPQC'
// index.ts:137
export declare const P2MR_MESSAGE_PROOF_TYPE = 'p2mr-message'
// index.ts:138
export declare const P2MR_MESSAGE_PROOF_VERSION = 1
// index.ts:139
export declare const P2MR_MESSAGE_PROOF_MODE = 'p2mr-pubkey'
// index.ts:140
export declare const P2MR_MESSAGE_ALGORITHM = 'SLH-DSA-SHA2-128s-bounded30'

// index.ts:3
export type QbitNetworkName = 'mainnet' | 'testnet4' | 'signet' | 'regtest'

// index.ts:5-25
export interface QbitNetworkParams {
  name: QbitNetworkName
  bech32Hrp: string
  p2pPort: number
  rpcPort: number
  /**
   * `true` when these SDK parameters match qbit Core v1.0.0 chainparams
   * (src/kernel/chainparams.cpp, src/chainparamsbase.cpp:46-54) and are
   * supported for production use.
   *
   * This does NOT mean "is mainnet": it is `true` for all four networks. To
   * identify mainnet, check `name === 'mainnet'` or `bech32Hrp === 'qb'`.
   */
  mainnetReady: boolean
  bip32: {
    public: number
    private: number
    publicPrefix: string
    privatePrefix: string
  }
}

// index.ts:218-235
export type QbitProtocolErrorCode =
  | 'UNKNOWN_NETWORK'
  | 'INVALID_BECH32'
  | 'WRONG_HRP'
  | 'WRONG_ENCODING'
  | 'WRONG_WITNESS_VERSION'
  | 'WRONG_PROGRAM_LENGTH'
  | 'INVALID_BYTES'
  | 'INVALID_SCRIPT'
  | 'INVALID_URI'
  | 'WRONG_URI_SCHEME'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_PSBT'
  | 'INVALID_SIGHASH'
  | 'INVALID_AMOUNT'
  | 'INVALID_INTEGER'
  | 'SIGNING_FAILED'
  | 'INVALID_SIGNER'

// index.ts:245-268
export declare class QbitProtocolError extends Error {
  readonly code: QbitProtocolErrorCode

  static is(value: unknown): value is QbitProtocolError

  constructor(code: QbitProtocolErrorCode, message: string)
}

// index.ts:313-329
export interface P2mrMessageProof {
  type: typeof P2MR_MESSAGE_PROOF_TYPE
  version: typeof P2MR_MESSAGE_PROOF_VERSION
  address: string
  message_hash: string
  datasig_hash: string
  domain: typeof QBIT_DATA_SIG_PQC_DOMAIN
  message_domain: typeof QBIT_WALLET_MESSAGE_DOMAIN
  algorithm: typeof P2MR_MESSAGE_ALGORITHM
  proof_mode: typeof P2MR_MESSAGE_PROOF_MODE
  pubkey: string
  signature: string
  leaf_version: number
  leaf_script: string
  control_block: string
  p2mr_merkle_root: string
}

// index.ts:331-339
export interface CreateP2mrMessageProofParams {
  message: string
  address: string
  pubkey: Uint8Array
  signature: Uint8Array
  leafVersion?: number
  leafScript?: Uint8Array
  controlBlock?: Uint8Array
}

// index.ts:341-345
export type P2mrPqcVerifyFn = (
  pubkey: Uint8Array,
  digest: Uint8Array,
  signature: Uint8Array
) => boolean

// index.ts:360-368
export type VerifyP2mrMessageProofOptions =
  | {
      expectedAddress: string
      expectedNetwork?: QbitNetworkName | QbitNetworkParams
    }
  | {
      expectedAddress?: string
      expectedNetwork: QbitNetworkName | QbitNetworkParams
    }

// index.ts:1191-1199
export interface P2mrOutpoint {
  /**
   * Transaction id in serialization (internal) byte order — the reverse of the
   * big-endian txid shown by explorers and RPC. Exactly 32 bytes.
   */
  txid: Uint8Array
  /** Output index within the funding transaction (uint32). */
  vout: number
}

// index.ts:1201-1205
export interface P2mrTransactionInput {
  prevout: P2mrOutpoint
  /** nSequence (uint32). */
  sequence: number
}

// index.ts:1207-1211
export interface P2mrTransactionOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  scriptPubKey: Uint8Array
}

// index.ts:1213-1220
export interface P2mrTransaction {
  /** nVersion (uint32, as qbit Core's `CTransaction::version`; a legacy int32 `-1` is `0xffffffff`). */
  version: number
  /** nLockTime (uint32). */
  locktime: number
  inputs: readonly P2mrTransactionInput[]
  outputs: readonly P2mrTransactionOutput[]
}

// index.ts:1223-1227
export interface P2mrSpentOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  scriptPubKey: Uint8Array
}

// index.ts:1611-1614
export interface PsbtKeyValue {
  key: Uint8Array
  value: Uint8Array
}

// index.ts:1617-1621
export interface Psbt {
  global: PsbtKeyValue[]
  inputs: PsbtKeyValue[][]
  outputs: PsbtKeyValue[][]
}

// index.ts:2095-2105
export interface P2mrPsbtSignContext {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
  /** Sighash type the digest was computed with (and the type byte appended to the witness signature when not `SIGHASH_DEFAULT`). */
  hashType: number
  /** The unsigned transaction being signed. */
  tx: P2mrTransaction
  /** The outputs being spent, one per transaction input in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
}

// index.ts:2119
export type P2mrPsbtSignFn = (sighash: Uint8Array, context: P2mrPsbtSignContext) => Uint8Array | undefined

// index.ts:2121-2135
export interface P2mrSigningKey {
  inputIndex: number
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  pubkey: Uint8Array
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  leafHash: Uint8Array
  /**
   * Sighash type; defaults to `SIGHASH_DEFAULT`. Any other type requires
   * `allowNonDefaultSighash: true`, must equal the input's
   * `PSBT_IN_SIGHASH_TYPE` field when that field is present, and must equal the
   * type of every P2MR signature already on the input (qbit Core's
   * `SIGHASH_MISMATCH` rules).
   */
  hashType?: number
}

// index.ts:2138-2142
export interface P2mrSigningPlanRef {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
}

// index.ts:2161-2163
export type P2mrPsbtOnSignedFn = (
  event: P2mrSigningPlanRef & { field: { key: Uint8Array; value: Uint8Array } }
) => void

// index.ts:2165-2182
export interface P2mrSigningOptions {
  /**
   * Permit sighash types other than `SIGHASH_DEFAULT`. Off by default because
   * `NONE`, `SINGLE` and the `ANYONECANPAY` variants do not commit to every
   * input and output, so a signature made with them can be lifted into a
   * transaction the user never approved. Only set this after the application's
   * approval flow has shown the requested type to the user.
   */
  allowNonDefaultSighash?: boolean
  /**
   * `false` skips the restricted-output check, matching qbit Core's regtest
   * `-p2mronly=0`. By default every output of the unsigned transaction must be
   * one Core's restricted-output mode allows (see
   * {@link isRestrictedOutputModeOutput}, with reserved witness outputs
   * refused), or signing throws `INVALID_SCRIPT` before any signer call.
   */
  restrictedOutputMode?: boolean
}

// index.ts:2184-2188
export interface SignP2mrPsbtResult {
  psbt: Psbt
  /** Plans that produced a signature, so the caller's key management can advance its counters. */
  signed: P2mrSigningPlanRef[]
}

// index.ts:2191
export type P2mrPsbtSigningPhase = 'sign' | 'onSigned'

// index.ts:2212-2247
export declare class P2mrPsbtSigningError extends QbitProtocolError {
  readonly psbt: Psbt
  readonly signed: P2mrSigningPlanRef[]
  readonly failed: P2mrSigningPlanRef
  readonly phase: P2mrPsbtSigningPhase
  readonly cause: unknown

  static is(value: unknown): value is P2mrPsbtSigningError

  constructor(params: {
    psbt: Psbt
    signed: P2mrSigningPlanRef[]
    failed: P2mrSigningPlanRef
    phase: P2mrPsbtSigningPhase
    cause: unknown
  })
}

// index.ts:522
export declare function bytesToHex(bytes: Uint8Array): string

// index.ts:571
export declare function qbitWalletMessageHash(message: string): Uint8Array

// index.ts:600
export declare function qbitDataSigPqcHash(messageHash: Uint8Array): Uint8Array

// index.ts:777-780
export declare function p2mrAddressFromRoot(
  root: Uint8Array,
  network: QbitNetworkName | QbitNetworkParams
): string

// index.ts:784
export declare function singleKeyLeafScript(pk32: Uint8Array): Uint8Array

// index.ts:839-842
export declare function p2mrLeafHash(
  leafVersion: number,
  script?: Uint8Array
): Uint8Array

// index.ts:928
export declare function createP2mrMessageProof(params: CreateP2mrMessageProofParams): P2mrMessageProof

// index.ts:1007-1012
export declare function verifyP2mrMessageProof(
  message: string,
  proof: unknown,
  verifyPqc: P2mrPqcVerifyFn,
  options: VerifyP2mrMessageProofOptions
): boolean

// index.ts:2295-2300
export declare function validateP2mrSigningPlans(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
  } & P2mrSigningOptions
): void

// index.ts:2324-2331
export declare function signP2mrPsbt(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
    sign: P2mrPsbtSignFn
    onSigned?: P2mrPsbtOnSignedFn
  } & P2mrSigningOptions
): SignP2mrPsbtResult

// index.ts:2538-2541
export declare function p2mrAddressFromPubkey(
  pk32: Uint8Array,
  network: QbitNetworkName | QbitNetworkParams
): string
