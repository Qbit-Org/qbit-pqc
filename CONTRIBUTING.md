# Contributing

How to build, check and change `@qbit-oss/pqc` from a clone of the repository.
This file is not part of the npm package. Security issues are reported
privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue or
pull request.

## Prerequisites

- Node.js: the version in `.nvmrc`, which CI's required jobs run.
  `package.json` `engines` accepts `^20.19.0 || >=22.12.0`, and CI's
  `node-matrix` job builds and tests on both floors and on current lines.
  `pnpm test:mv3` and `pnpm smoke:bundlers` need Node.js 22.12 or later, which
  the locked `@puppeteer/browsers` requires. On Node.js 20, `pnpm install`
  warns about its `engines`, and the other checks use only its offline
  helpers.
- pnpm: the version that `packageManager` in `package.json` pins, through
  Corepack. Run `corepack enable` once, or prefix each command with
  `corepack pnpm`. If `corepack` is not on `PATH` (Node.js 25 and later no
  longer bundle it), install it with `npm install --global corepack`.

Install the locked dependencies:

```sh
corepack pnpm install --frozen-lockfile
```

In `pnpm-workspace.yaml`, `minimumReleaseAge` makes pnpm resolve only
versions published at least 14 days ago, and `onlyBuiltDependencies` lets only
`esbuild` run an install script. Keep both when you add or update a
dependency.

## Checks

Run one command before you push:

```sh
pnpm verify
```

It runs, in CI's order, every check of CI's `verify` job that needs no
network or Docker: `format:check`, `build`, `test`, `typecheck`,
`check:vendor` against `MANIFEST` only, `check:wasm`, `pack:check` and
`smoke:consumer`. With a warm pnpm store it takes under a minute.

## Formatting

TypeScript and JavaScript are formatted with Prettier, using
`.prettierrc.json`:

```sh
pnpm format        # rewrite files in place
pnpm format:check  # what CI's verify job runs
```

`.prettierignore` leaves out build output, the byte-exact paths below,
Markdown, YAML, `package.json` and `pnpm-lock.yaml`. Keep the existing wrapping
of the prose and workflow files by hand.

## Heavy and CI-only checks

`pnpm verify` leaves out the checks that download something. CI runs all of
them except `build:wasm`; run them locally when a change touches what they
cover.

- `pnpm check:vendor --upstream <checkout>` compares `MANIFEST` itself with the
  upstream tree at the pinned commit, so a vendored file whose `MANIFEST` line
  was rewritten to match is caught. It needs `git` and a fetch of that commit,
  as CI does it:

  ```sh
  pin=$(node --input-type=module -e "import { readFileSync } from 'node:fs'; import { parseUpstreamPin } from './scripts/check-vendor.mjs'; console.log(parseUpstreamPin(readFileSync('vendor/libbitcoinpqc-qbit/UPSTREAM.md', 'utf8')))")
  upstream=$(mktemp -d)
  git init -q "$upstream"
  git -C "$upstream" fetch -q --depth=1 https://github.com/Qbit-Org/qbit-libbitcoinpqc.git "$pin"
  pnpm check:vendor --upstream "$upstream"
  ```

- `pnpm check:wasm:repro` rebuilds the WASM in the pinned emsdk Docker image
  and compares the hashes of the result with the committed `wasm/` files. It
  needs Docker, pulls the image the first time, and runs it as `linux/amd64`,
  emulated on other hosts.
- `pnpm build:wasm` rebuilds `wasm/pqc.mjs`, `wasm/pqc.wasm` and
  `wasm/SHA256SUMS` in place, in the same image, or with a local `emcc` when
  `USE_LOCAL_EMCC=1` is set (see Build below). Run it only when `native/`,
  `vendor/`, the build flags in `scripts/build-wasm.sh` or the image pin
  change, commit all three files, and check that `pnpm check:wasm:repro`
  passes without overrides. A new image or new flags can change which
  Emscripten objects are linked in, so re-check `THIRD_PARTY_NOTICES` too.
- `pnpm test:mv3` and `pnpm smoke:bundlers` run the packed tarball in the
  pinned Chrome for Testing build. Install it into `.context/browsers` with
  the locked `@puppeteer/browsers`:

  ```sh
  pnpm exec browsers install chrome@156.0.8078.47 --path .context/browsers
  ```

  `scripts/chrome-for-testing.mjs` holds the pinned version. On a host that
  blocks unprivileged user namespaces, such as Ubuntu 23.10 or later, set
  `CHROME_NO_SANDBOX=1`; see "CI Commands" in
  [docs/mv3-conformance.md](docs/mv3-conformance.md).
  `pnpm smoke:bundlers` also installs webpack, esbuild and Vite with npm, at
  the exact versions in `scripts/run-bundler-smoke.mjs`, into throwaway
  projects outside the repository.

## Byte-exact paths

These paths are published, or compiled into the published WASM, and checks
compare them, or what is built from them, byte for byte with a pinned hash or
upstream blob. That is what lets anyone check that the published WASM is built
from the pinned upstream C sources and still derives the keys and signatures
qbit Core does. Never reformat them, and change them only as described here:

- Every vendored file in `vendor/libbitcoinpqc-qbit/` is blob-equal to the
  upstream commit that `UPSTREAM.md` pins, as `MANIFEST` records
  (`pnpm check:vendor`). Re-vendor only from an upstream checkout, as
  `UPSTREAM.md` describes.
- `fixtures/` holds the conformance vectors derived from qbit Core and from
  the upstream Rust tests. `pnpm test` checks the package against each of
  them, and `slh-dsa-golden.json` against its SHA-256 sidecar. Changing the
  derivation vectors is a breaking change; see "Derivation Fixture Gate" in
  [RELEASE.md](RELEASE.md).
- `wasm/` is build output, committed so that `pnpm build` and the tests need
  neither Docker nor Emscripten. `wasm/SHA256SUMS` pins `pqc.mjs` and
  `pqc.wasm` (`pnpm check:wasm`), and `pnpm check:wasm:repro` rebuilds them
  from source. Change it only with `pnpm build:wasm`.
- `native/` is the C source compiled with the vendored sources into
  `wasm/pqc.wasm`. Change it only together with the rebuilt `wasm/` files.

`.gitattributes` turns off line-ending conversion for `fixtures/`, `vendor/`
and `wasm/`, so a checkout with `core.autocrlf` cannot rewrite them, and
Prettier ignores all four paths.

## Pull requests

Target the branch that "Branches" in [RELEASING.md](RELEASING.md) names:
`main` for features and fixes, and `release/X.Y` only for fixes, docs, and
version and CHANGELOG updates. Pull requests need green `verify`, `mv3-smoke`
and `bundler-smoke` checks and are squash-merged.

When a change alters the published package's API or behaviour, add an entry to
[CHANGELOG.md](CHANGELOG.md) under the target branch's unreleased version, and
update the README and `docs/` to match.

## Build

```sh
pnpm build:wasm
pnpm check:wasm
pnpm check:wasm:repro
pnpm build
pnpm smoke:load
pnpm test
pnpm typecheck
pnpm test:mv3
pnpm smoke:bundlers
pnpm pack:check
pnpm smoke:consumer
```

The committed SLH-DSA golden fixture is in `fixtures/slh-dsa-golden.json`, with
a SHA-256 sidecar in `fixtures/slh-dsa-golden.json.sha256`. The fixture's
`source` block records its provenance: the upstream repository and commit, the
Rust test file path, and that file's git blob and SHA-256.

`build:wasm` uses this pinned Emscripten Docker image, `emscripten/emsdk:4.0.10`,
by default:

```text
emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7
```

For local-only development, set `USE_LOCAL_EMCC=1` to use `emcc` from `PATH`.
`pnpm check:wasm:repro` refuses to run with `USE_LOCAL_EMCC=1`, `EMSDK_IMAGE`
or `OUT_DIR` set, because its pass is meant to show that the pinned image
rebuilds the committed files; add `QBIT_PQC_REPRO_ALLOW_OVERRIDES=1` to run it
with them anyway. The checked-in `wasm/SHA256SUMS` file records the expected
`pqc.mjs` and `pqc.wasm` hashes; the package exports it as
`@qbit-oss/pqc/wasm/SHA256SUMS`.

The npm tarball keeps the TypeScript source, public fixtures, and pinned
vendored C inventory for auditability while excluding repository-only build,
test, and CI files. See [`RELEASE.md`](RELEASE.md) for the enforced package
policy and release checklist.
Versioning, release branches and tags are described in
[`RELEASING.md`](RELEASING.md); changes are listed in [`CHANGELOG.md`](CHANGELOG.md).
