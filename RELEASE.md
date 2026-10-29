# Release Checklist

Every release candidate and release must pass this checklist. Versions,
release branches and tags are described in [RELEASING.md](RELEASING.md).
0.1.0 was published to npm on 2026-10-26 under `latest`, with the bootstrap
token that "First publish" in RELEASING.md describes; later versions are
published through the package's trusted publisher.

## Package Policy

The npm tarball intentionally includes the compiled TypeScript and WASM
runtime, TypeScript source, public conformance fixtures, documentation, and the
pinned vendored C inventory. Keeping the source and C inventory beside the
runtime makes the cryptographic implementation and its provenance inspectable
without expanding the runtime dependency graph.

Repository-only build inputs and automation stay out of the tarball. This
includes `.github`, `.context`, `native`, `scripts`, `test`, workspace lock and
configuration files, and generated local artifacts. `pnpm pack:check` enforces
the required files and this closed allowlist against both npm's dry-run manifest
and the exact archive produced after `prepack`, and requires those inventories to
match. It and the `prepublishOnly` guard also check packed files against git,
as "Publishing" in [RELEASING.md](RELEASING.md) describes. The source
repository remains the complete reproducible-build context.

## Derivation Fixture Gate

`fixtures/qbit-core-derivation.json` and
`fixtures/qbit-core-binary-derivation.json` pin the wallet key-derivation
contract to qbit Core v1.0.0 (`7ebcddb622d6e639041f005a189b048ec2a221fe`).
The second fixture was produced by an unmodified qbit Core release binary; see
`docs/derivation.md`, "Core Binary Oracle", for how to regenerate it.

- Re-vendoring `vendor/libbitcoinpqc-qbit`, rebuilding `wasm/`, or bumping the
  qbit Core reference must leave both fixtures byte-identical. `pnpm test`
  must pass unchanged, and when a qbit Core release binary is available, rerun
  `scripts/generate-qbit-core-binary-vectors.mjs --check` against it.
- The generator trusts only the operator release keys pinned in
  `scripts/qbit-core-release-signers.mjs` (from `contrib/keys/operator-keys/keys.json`
  at the Core commit) and refuses any other `--core-tag`/`--core-commit`.
  Bumping the Core reference requires re-pinning that file from the new
  release commit first, with every value re-derived and reviewed as described
  in `docs/derivation.md`, "Re-pinning the operator keys".
- Any change to the vectors in either fixture means wallet-derived P2MR keys no
  longer match qbit Core, and funds at previously derived addresses could not
  be recovered by importing the descriptor into Core. That is a breaking
  change: it requires a breaking version bump (see RELEASING.md), an explicit
  release note naming the old and new Core references, and a recovery plan for
  existing wallets.
  Never land it as a routine dependency or Core-reference bump.

## Candidate Verification

- [ ] Confirm the release commit and upstream C pin.
- [ ] Run `node scripts/check-vendor.mjs --upstream <qbit-libbitcoinpqc clone>`
      to confirm the vendored C inventory and its `MANIFEST` are blob-equal to
      the upstream pin (see `vendor/libbitcoinpqc-qbit/UPSTREAM.md`).
- [ ] Confirm the version and npm dist-tag (`candidate` for `X.Y.Z-rc.N`,
      `latest` for `X.Y.Z`); never publish `0.0.0`.
- [ ] Confirm npm `@qbit-oss` ownership, required 2FA policy, and maintainer
      access.
- [ ] Confirm the repository visibility, and that GitHub private vulnerability
      reporting is enabled: SECURITY.md names it as the only reporting channel.
- [ ] Run `corepack pnpm install --frozen-lockfile` in a clean clone.
- [ ] Run `pnpm build`, `pnpm typecheck`, and `pnpm test`.
- [ ] Confirm both derivation fixtures are byte-identical to the previous
      release, or that this is a documented major release (see Derivation
      Fixture Gate).
- [ ] Run `pnpm check:wasm` and `pnpm check:wasm:repro`.
- [ ] Run `pnpm pack:check` and review the reported tarball size.
- [ ] Run `pnpm smoke:consumer` against a freshly packed and installed tarball.
- [ ] Run `pnpm test:mv3` with Chrome for Testing. The host must validate an
      external clean-consumer `node_modules/@qbit-oss/pqc` source before the
      smoke reports `artifactSource: installed-packed-tarball`.
- [ ] Run `pnpm smoke:bundlers` with Chrome for Testing: the default `init()`
      and the static-factory recipe must pass in every bundler it builds with.
- [ ] Verify the working tree is clean after all checks.

## Publishing Gate

Publishing runs in `.github/workflows/publish.yml` when a tag is pushed. Its
`publish` job, which starts only once a required reviewer approves it,
publishes exactly the tarball its `build` job packed; "Publishing" in
[RELEASING.md](RELEASING.md) describes what each job checks.

- [ ] Configure the package's npm trusted publisher as step 5 of "First
      publish" in RELEASING.md describes. The first publish uses a token
      instead.
- [ ] Protect the `npm` environment with required reviewers who cannot
      approve their own tag's publish, and restrict who can push `v*` tags.
- [ ] Publish only by pushing the tag, never with a local `npm publish`.
- [ ] Approve the `publish` job only after the checks in "Approving a
      publish" in RELEASING.md.
- [ ] Install the published version in a fresh Node project and a fresh MV3
      extension project; repeat keygen, sign, verify, and negative verification.
- [ ] Verify the npm provenance statement, package files, version, and dist-tag.
- [ ] Compare `npm view @qbit-oss/pqc@<version> dist.integrity` with the
      `integrity` that `pnpm pack:check` printed for the tagged commit, in
      the publish run's `build` job or locally with the same npm version.
- [ ] Update downstream wallet integrations to the exact package version and
      run their PQC conformance and extension packaging checks before release.
