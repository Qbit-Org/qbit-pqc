#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT="$PKG_ROOT"
REPRO_DIR="$PKG_ROOT/.context/repro/wasm"

# A pass must mean that the pinned Docker image rebuilt the committed files, so
# the overrides that scripts/build-wasm.sh reads need an explicit opt-in. A
# local emcc that only copies the committed files would pass otherwise.
OVERRIDES=()
if [[ -n "${EMSDK_IMAGE:-}" ]]; then
  OVERRIDES+=("EMSDK_IMAGE=$EMSDK_IMAGE")
fi
if [[ "${USE_LOCAL_EMCC:-0}" == "1" ]]; then
  OVERRIDES+=("USE_LOCAL_EMCC=1")
fi
if [[ -n "${OUT_DIR:-}" ]]; then
  OVERRIDES+=("OUT_DIR=$OUT_DIR")
fi
if ((${#OVERRIDES[@]} > 0)); then
  if [[ "${QBIT_PQC_REPRO_ALLOW_OVERRIDES:-}" != "1" ]]; then
    echo "check-wasm-repro: refusing to run with ${OVERRIDES[*]}" >&2
    echo "check-wasm-repro: unset them to rebuild with the pinned Docker image, or set QBIT_PQC_REPRO_ALLOW_OVERRIDES=1 to keep them" >&2
    exit 1
  fi
  echo "check-wasm-repro: QBIT_PQC_REPRO_ALLOW_OVERRIDES=1, rebuilding with ${OVERRIDES[*]}"
  # The rebuild must not land in wasm/, which it is compared with.
  if [[ -n "${OUT_DIR:-}" ]]; then
    echo "check-wasm-repro: ignoring OUT_DIR; the rebuild always goes to ${REPRO_DIR#"$REPO_ROOT/"}"
  fi
fi

cd "$REPO_ROOT"
rm -rf "$REPRO_DIR"
OUT_DIR="$REPRO_DIR" scripts/build-wasm.sh baseline

# Private per-run directory: fixed /tmp paths can be pre-planted as symlinks by
# another user and collide between concurrent runs. The EXIT trap keeps the
# script's exit status.
TMP_ROOT=${TMPDIR:-/tmp}
TMP=$(mktemp -d "${TMP_ROOT%/}/qbit-pqc-repro.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

node scripts/check-wasm-hash.mjs --dir "$REPRO_DIR" >"$TMP/actual.txt"
node scripts/check-wasm-hash.mjs --dir "wasm" >"$TMP/expected.txt"

diff -u "$TMP/expected.txt" "$TMP/actual.txt"
if ((${#OVERRIDES[@]} > 0)); then
  echo "reproducible WASM hash check passed with build overrides: ${OVERRIDES[*]}"
else
  echo "reproducible WASM hash check passed"
fi
