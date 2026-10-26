import { describe, expect, it } from 'vitest'

import { assertPackedPackageRoot } from '../scripts/stage-packed-consumer.mjs'

describe('packed consumer provenance', () => {
  it('accepts the installed package in an external consumer project', () => {
    expect(
      assertPackedPackageRoot({
        consumerDir: '/tmp/qbit-pqc-consumer/consumer',
        packageRoot: '/tmp/qbit-pqc-consumer/consumer/node_modules/@qbit-oss/pqc',
        repoRoot: '/workspace/qbit-pqc',
      })
    ).toBe('/tmp/qbit-pqc-consumer/consumer/node_modules/@qbit-oss/pqc')
  })

  it('rejects a package root that is not the clean consumer install', () => {
    expect(() =>
      assertPackedPackageRoot({
        consumerDir: '/tmp/qbit-pqc-consumer/consumer',
        packageRoot: '/workspace/qbit-pqc',
        repoRoot: '/workspace/qbit-pqc',
      })
    ).toThrow(/packed package root must be/)
  })

  it('rejects a staged consumer placed inside the repository', () => {
    expect(() =>
      assertPackedPackageRoot({
        consumerDir: '/workspace/qbit-pqc/.context/consumer',
        packageRoot: '/workspace/qbit-pqc/.context/consumer/node_modules/@qbit-oss/pqc',
        repoRoot: '/workspace/qbit-pqc',
      })
    ).toThrow(/must be outside the repository/)
  })
})
