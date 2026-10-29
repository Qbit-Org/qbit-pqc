# Releasing

How `@qbit-oss/pqc` is versioned, branched and tagged. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md), and [RELEASE.md](RELEASE.md) is the checklist
every candidate and release must pass.

## Versioning

- [SemVer](https://semver.org). Before 1.0 the version is `0.MINOR.PATCH`:
  - **MINOR** (`0.1.x` → `0.2.0`) for any breaking change: a removed or renamed
    export, an incompatible type or signature, input that used to be accepted
    and is now rejected, an existing failure that now surfaces with a different
    error kind or code, or different output for the same input.
  - **PATCH** (`0.1.0` → `0.1.1`) for backward-compatible fixes and additions.
  - A caret range stays inside one line below 1.0 (`^0.1.0` means
    `>=0.1.0 <0.2.0`), so consumers never receive a breaking change from a
    patch update.
- A change to the keys or signatures produced for the same input is breaking
  whatever else changes; see "Derivation Fixture Gate" in
  [RELEASE.md](RELEASE.md) for what it also requires.
- Release candidates are `X.Y.Z-rc.N`, with `N` starting at `0` (what
  `npm version preminor --preid rc` produces). They are published under the npm
  dist-tag `candidate`, never `latest`. The registry points `latest` at a new
  package's first version whatever its dist-tag, so the package's first
  publish is a final release, never a candidate: it starts at `0.1.0`. Only
  final releases move `latest`.
- 1.0.0 is cut once the public API is declared stable. From then on breaking
  changes bump MAJOR.

## Branches

- `main` is the integration branch. Feature and fix PRs target `main`.
- `release/X.Y` stabilizes one minor line. It is cut from `main` when the line
  starts stabilizing and takes only fixes, docs, and version and CHANGELOG
  updates, each through a PR with green `verify`, `mv3-smoke` and
  `bundler-smoke` checks. Never merge `main` into a release branch.
- **Fixes flow back to `main`** through a back-merge PR from `release/X.Y` into
  `main`. Keep one draft back-merge PR open while the line has fixes `main`
  lacks, and merge it at least once per published version and before the next
  line is cut, so `main` never lacks a released fix. If it conflicts, resolve
  on a short-lived `backmerge/X.Y` branch cut from `release/X.Y` with `main`
  merged in, not on `release/X.Y` itself.
- A fix that lands on `main` first and is also needed on an active line is
  cherry-picked (`git cherry-pick -x`) onto `release/X.Y` in its own PR.
- The `package.json` version on `main` is never published. A back-merge may
  carry a release line's version onto `main`; that is expected.

## Versions on a release branch

`package.json` on `release/X.Y` always holds the next version to be published
from that branch: `X.Y.0-rc.0` when the branch is cut, or `0.1.0` for the first
line (see Versioning). CHANGELOG entries collect under that version's heading,
marked `unreleased`, as their PRs merge.

## Cutting a release candidate

1. Check that `verify`, `mv3-smoke` and `bundler-smoke` are green on the tip of
   `release/X.Y`, that the [RELEASE.md](RELEASE.md) checklist passes, and that
   the CHANGELOG section lists every change on the branch.
2. Create the annotated tag `vX.Y.Z-rc.N` on that commit and push it. The
   publish workflow publishes that version under the dist-tag `candidate`
   (see Publishing), once another maintainer has
   [approved](#approving-a-publish) its `publish` job.
3. In a PR to `release/X.Y`, date the candidate's CHANGELOG section, open the
   next one, and bump the version to `X.Y.Z-rc.N+1`.

## Final release

1. In a PR to `release/X.Y`, set the version to `X.Y.Z` and turn the candidate
   sections into one dated `X.Y.Z` section.
2. Create and push the annotated tag `vX.Y.Z`; the publish workflow publishes
   it under `latest`, once another maintainer has
   [approved](#approving-a-publish) its `publish` job. Then bump the version
   to `X.Y.(Z+1)-rc.0` in a PR.
3. Merge the back-merge PR into `main`.

## Tags

Tags are `vX.Y.Z` and `vX.Y.Z-rc.N`, one per release. A tag names no package,
so it would survive a future rename. Tags are created only on release
branches, by a maintainer, and are never moved. Pushing a tag starts the
publish workflow.

## Publishing

`.github/workflows/publish.yml` publishes the package when a `v*` tag is
pushed to `Qbit-Org/qbit-pqc`; its jobs never run in any other repository,
such as a fork. It has three jobs, so that only code that `pnpm-lock.yaml`
pins can shape what is published, and nothing that runs third-party code can
publish:

1. `build` holds no secret and no `id-token` permission. Besides pnpm,
   Node.js and the SHA-pinned actions, it runs only code that
   `pnpm-lock.yaml` pins: the locked dev dependencies and the package's
   `prepack`. Before installing anything, it fails unless:
   - the tag is `v` followed by the `package.json` version;
   - the version is `X.Y.Z` (published under the dist-tag `latest`) or
     `X.Y.Z-rc.N` (under `candidate`), and not `0.0.0`;
   - CHANGELOG.md has a `## <version>` section;
   - the tagged commit is on `release/X.Y`, the release branch of that
     version.

   Install, build, tests, typecheck, `check:wasm`, `pack:check` and
   `scripts/check-publish.mjs` must then pass on that commit. It packs the
   tarball with `npm pack`, records its SHA-256 sum in the same step, and
   uploads it as the run's `npm-tarball` artifact. The sum and the
   artifact's ID are job outputs.
2. `smoke` runs after `build` and holds no secret or `id-token` either. It
   runs the checks `build` does not need in order to pack the tarball,
   including those that fetch data or run code outside the lockfile: the
   comparison of the vendored C sources with a fetch of the pinned upstream
   commit, `check:wasm:repro`, which rebuilds the WASM in the emsdk Docker
   image that `scripts/build-wasm.sh` pins by digest, and the fresh-consumer
   smoke, which packs its own copy of the package from the tagged commit.
3. `publish` runs once both pass, in the `npm` environment, so it starts
   only once a required reviewer [approves it](#approving-a-publish). It is
   the only job that can request the OIDC token for npm trusted publishing
   or read the `NPM_TOKEN` bootstrap secret, and it checks out nothing,
   installs nothing and runs no repository or dependency code. It downloads
   `build`'s artifact by its ID and fails unless:
   - the version `build` reports is a release version and the tag's, and
     the dist-tag is the one that version implies;
   - the artifact holds exactly the tarball of that version, and the
     tarball matches the SHA-256 sum `build` recorded;
   - npm's own tarball reader, the one `npm publish` uses, reads the
     tarball's `package.json` as `@qbit-oss/pqc` at the tagged version, and
     lists no path twice (`npm pack --dry-run` on the tarball);
   - as an extra layer, GNU tar lists every entry of the tarball under
     `package/`, with no empty, `.` or `..` path component, and exactly one
     `package/package.json`.

   It then runs `npm publish <tarball> --provenance --access public
   --ignore-scripts`, with `--tag candidate` for a release candidate. A
   final release gets no `--tag`, so npm applies `latest`, and the npm
   client refuses a final release that is not above the highest final
   release on npm that is not deprecated: a release on an older line, such
   as `0.1.4` after `0.2.0`, needs a per-line dist-tag in the workflow
   first. A version already on npm is skipped if npm's `dist.integrity` for
   it is the tarball's, and fails the job otherwise, so re-running the
   failed `publish` job finishes a partial publish with the same tarball
   and never publishes different bytes. While `NPM_TOKEN` is set, the job
   fails if the package already exists on npm, or if npm answers anything
   but `E404` (not found) when asked whether it does.

No job that runs third-party code can publish, and code outside the
lockfile, such as the emsdk image, runs only in `smoke`, which can stop a
release but cannot change the tarball `publish` checks. What remains is the
build itself: a compromised locked dev dependency, pnpm, Node.js or pinned
action could still alter the tarball before `build` records its sum.

npm authenticates the `publish` job through the package's trusted publisher
(OIDC), so no long-lived npm token is stored in GitHub, and every version
carries a provenance statement linking it to the workflow run and commit.

Publish only through this workflow. `package.json` sets
`publishConfig.provenance`, so `npm publish` fails outside a CI job that can
attest provenance. `npm publish` from a checkout runs `prepublishOnly` first:
the same `scripts/check-publish.mjs` that `build` runs, which refuses to
publish if `package.json` or a file under its `files` is untracked or differs
from the commit, if the version is not a release version, or if
`pnpm check:wasm` fails. Outside CI it also runs `pnpm check:wasm:repro`; in
CI it leaves that rebuild to `smoke`. `pnpm pack:check` also requires every
packed file to be tracked by git, except tsup's output, which must be exactly
`lib/index.mjs`, `lib/index.mjs.map` and `lib/index.d.mts`. It only warns
about uncommitted changes, so it can run before a commit.

### Approving a publish

The run uses the workflow file of the tagged commit, so its own checks prove
nothing if that file was edited. The approver therefore checks, against their
own `git fetch origin --tags` rather than the run's log:

- [ ] the run is for the expected tag `vX.Y.Z` or `vX.Y.Z-rc.N`, and its
      commit (on the run page) is that tag's commit and is on `release/X.Y`:
      `git merge-base --is-ancestor <commit> origin/release/X.Y`;
- [ ] `.github/workflows/publish.yml` at that commit is the version reviewed
      on `release/X.Y`:
      `git diff origin/release/X.Y <commit> -- .github/workflows/publish.yml`
      prints nothing;
- [ ] every commit the release adds came through an approved PR to
      `release/X.Y`: review `git log <previous tag>..<commit>` and match each
      commit to its merged, approved PR. For a line's first release, review
      the branch's first-parent chain back to where it was cut from `main`:

      ```bash
      bp=$(git rev-list --first-parent <commit> | grep -m1 -Fxf <(git rev-list --first-parent origin/main))
      git log --first-parent $bp..<commit>
      ```

      Not `git merge-base origin/main <commit>`: after a back-merge into
      `main`, that is the release commit the back-merge brought in, which
      hides every commit before it;
- [ ] CHANGELOG.md at that commit has the `## <version>` section, listing the
      release's changes.

`publish` cannot start until `build` and `smoke` have passed.

If any item fails, reject the deployment; nothing is published.

### First publish

npm lets a trusted publisher be configured only for a package that already
exists, so the first version is published with a short-lived token, and
trusted publishing takes over from the next release.

1. Create the environment `npm` (Settings → Environments):
   - Deployment branches and tags: Selected branches and tags, with the tag
     rule `v*`.
   - Required reviewers: the release maintainers, with Prevent self-review
     checked, so whoever pushed the tag cannot approve its publish.
   - Allow administrators to bypass configured protection rules: unchecked.

   A pushed tag then publishes nothing until another maintainer approves.
2. Create a granular npm access token, expiring after one day, that can
   publish ("Read and write") only `@qbit-oss/pqc`, or only the `@qbit-oss`
   scope if npm cannot select the package before it exists. Select "Bypass
   two-factor authentication" if the account requires 2FA to publish.
3. Save it as the `NPM_TOKEN` secret of the `npm` environment, where only the
   approved `publish` job can read it, and push the first tag. With no
   trusted publisher configured, npm falls back to the token; the run still
   signs provenance.
4. Delete the secret and revoke the token. The workflow fails while
   `NPM_TOKEN` is set and the package exists on npm.
5. Configure the package's trusted publisher (on npmjs.com, the package's
   Settings → Trusted publishing → GitHub Actions): repository
   `Qbit-Org/qbit-pqc`, workflow `publish.yml`, environment `npm`, with
   npm publish allowed; a new configuration allows only `npm stage publish`
   unless it is selected. The CLI does the same:
   `npm trust github @qbit-oss/pqc --repo Qbit-Org/qbit-pqc --file publish.yml --env npm --allow-publish`.
   A configuration expires 48 hours after it is created unless a publish
   uses it, so create it just before pushing the next tag, and recreate it
   if it expired.
6. Once a trusted publish has succeeded, set the package's publishing access
   to "Require two-factor authentication and disallow tokens"; it does not
   affect the trusted publisher.

## Status

0.1.0 was published to npm on 2026-10-26 under `latest`, with the bootstrap
token described in "First publish". Every later version is published through
the package's trusted publisher.
