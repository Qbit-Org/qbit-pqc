## What and why

<!-- What this changes, and why. Link the issue it fixes, if any. -->

## Target branch

<!-- main for features and fixes; release/X.Y only for fixes, docs, and
version and CHANGELOG updates ("Branches" in RELEASING.md). -->

## Checklist

- [ ] `pnpm verify` passed (see CONTRIBUTING.md for the checks it leaves to CI).
- [ ] `vendor/`, `fixtures/`, `wasm/` and `native/` are untouched, or this
      description says why they change and how they were regenerated.
- [ ] CHANGELOG.md has an entry if the published package's API or behaviour
      changes.
- [ ] README.md, `docs/` and CONTRIBUTING.md match the change.
