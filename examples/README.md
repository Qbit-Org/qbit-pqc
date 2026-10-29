# Examples

Runnable examples for `@qbit-oss/pqc`. They live only in the repository, not in
the npm package. Each one prints the lines that the comments on its
`console.log` calls give.

| Example | What it shows |
| --- | --- |
| [`quick-start.mjs`](quick-start.mjs) | The README quick start: generate a key pair from 128 bytes of random entropy, sign the SHA-256 digest of a message, and verify the signature (`true`) and a tampered copy (`false`). |
| [`wallet-derivation.mjs`](wallet-derivation.mjs) | Derive the P2MR key for a BIP32 leaf key and descriptor index with `deriveP2mrDescriptorKey`, and check it against the key qbit Core derives (vector `mainnet_external_index_42` of `fixtures/qbit-core-derivation.json`). |

## Running an example

In a project that has installed the package (`npm install @qbit-oss/pqc`),
copy an example in and run it with Node `^20.19.0 || >=22.12.0`:

```sh
node quick-start.mjs
```

In a clone of this repository, build first; the examples then import the
built package through its own `exports` map:

```sh
pnpm build
node examples/quick-start.mjs
```

`pnpm smoke:consumer`, which CI's `verify` job runs, packs the package,
installs the tarball in a temporary project outside the repository, and runs
every `examples/*.mjs` there. It fails when an example exits with an error or
prints anything other than what its comments promise, so give every
`console.log` line in a new example a comment with the output it prints.
