// Types for qbit-core-release-signers.mjs (consumed by test/*.test.ts).
export interface QbitCoreReleaseSigner {
  readonly alias: string
  readonly publicKeyFile: string
  readonly publicKeyBlobSha: string
  readonly signingFingerprint: string
  readonly primaryFingerprint: string
}

export interface QbitCoreReleaseSigners {
  readonly repository: string
  readonly tag: string
  readonly commit: string
  // Annotated tag object id; null only if a future pin names a lightweight tag.
  readonly tagObjectSha: string | null
  readonly manifest: {
    readonly path: string
    readonly blobSha: string
    readonly policyId: string
    readonly releaseLine: string
    readonly releaseSignatureQuorum: number
  }
  readonly signers: readonly QbitCoreReleaseSigner[]
}

export const QBIT_CORE_RELEASE_SIGNERS: QbitCoreReleaseSigners
