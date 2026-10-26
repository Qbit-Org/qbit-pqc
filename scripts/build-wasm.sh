#!/usr/bin/env bash
set -euo pipefail

STAGE_DIR=
trap 'if [[ -n "$STAGE_DIR" ]]; then rm -rf "$STAGE_DIR"; fi' EXIT

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT="$PKG_ROOT"
cd "$REPO_ROOT"

OUT_DIR=${OUT_DIR:-"wasm"}
# Changing this pin (or SOURCES/flags below) can change which Emscripten system
# objects are linked into pqc.wasm; re-check THIRD_PARTY_NOTICES when it does.
EMSDK_IMAGE=${EMSDK_IMAGE:-"emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7"}
VARIANT=${1:-baseline}

if [[ "$OUT_DIR" == "$REPO_ROOT/"* ]]; then
  OUT_DIR=${OUT_DIR#"$REPO_ROOT/"}
fi

OUTSIDE_REPO="OUT_DIR must be inside the repository for the Docker build (or set USE_LOCAL_EMCC=1)"

if [[ "${USE_LOCAL_EMCC:-0}" == "1" ]]; then
  if ! command -v emcc >/dev/null 2>&1; then
    echo "USE_LOCAL_EMCC=1 was set, but emcc was not found on PATH" >&2
    exit 1
  fi
  EMCC=(emcc)
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required for the pinned Emscripten build; set USE_LOCAL_EMCC=1 to use a local emcc" >&2
    exit 1
  fi
  # The container sees only the repository, mounted at /src. Output aimed
  # anywhere else would stay in the container, and the hashes below would be
  # taken from whatever stale files the host has there.
  case "/$OUT_DIR/" in
    //* | */../*)
      echo "$OUTSIDE_REPO: $OUT_DIR" >&2
      exit 1
      ;;
  esac
  EMCC=(docker run --rm --platform linux/amd64 -u "$(id -u):$(id -g)" -v "$REPO_ROOT:/src" -w /src "$EMSDK_IMAGE" emcc)
fi

mkdir -p "$OUT_DIR"
# A symlink inside the repository can still lead out of it.
if [[ "${USE_LOCAL_EMCC:-0}" != "1" && "$(cd -- "$OUT_DIR" && pwd -P)/" != "$(pwd -P)/"* ]]; then
  echo "$OUTSIDE_REPO: $OUT_DIR resolves to $(cd -- "$OUT_DIR" && pwd -P)" >&2
  exit 1
fi

VENDOR="vendor/libbitcoinpqc-qbit"

SOURCES=(
  native/qbit_pqc_wasm.c
  "$VENDOR/src/bitcoinpqc.c"
  "$VENDOR/src/slh_dsa/utils.c"
  "$VENDOR/src/slh_dsa/keygen.c"
  "$VENDOR/src/slh_dsa/validate.c"
  "$VENDOR/src/slh_dsa/sign.c"
  "$VENDOR/src/slh_dsa/verify.c"
  "$VENDOR/sphincsplus/ref/address.c"
  "$VENDOR/sphincsplus/ref/fors.c"
  "$VENDOR/sphincsplus/ref/hash_sha2.c"
  "$VENDOR/sphincsplus/ref/merkle.c"
  "$VENDOR/sphincsplus/ref/sha2.c"
  "$VENDOR/sphincsplus/ref/sha2_armv8_sha.c"
  "$VENDOR/sphincsplus/ref/sha2_x86_shani.c"
  "$VENDOR/sphincsplus/ref/sign.c"
  "$VENDOR/sphincsplus/ref/sign_stats.c"
  "$VENDOR/sphincsplus/ref/thash_sha2_simple.c"
  "$VENDOR/sphincsplus/ref/utils.c"
  "$VENDOR/sphincsplus/ref/utilsx1.c"
  "$VENDOR/sphincsplus/ref/wots.c"
  "$VENDOR/sphincsplus/ref/wotsx1.c"
  "$VENDOR/sphincsplus/ref/randombytes_custom.c"
)

COMMON_FLAGS=(
  -O3
  -std=c99
  -I "$VENDOR/include"
  -I "$VENDOR/sphincsplus/ref"
  -DPARAMS=sphincs-sha2-128s-bounded30
  -DCUSTOM_RANDOMBYTES=1
  -DSPX_PRODUCTION_BUILD=1
  -DBITCOINPQC_FORSC_MAX_GRIND_ATTEMPTS=1835008
  -DBITCOINPQC_WOTSC_MAX_COUNTER=65535
  # Not a security control here: WebAssembly keeps return addresses off linear
  # memory, and nothing in this module seeds the canary (its only import is
  # emscripten_resize_heap), so the canary is always 0. Kept only because
  # removing the flag changes pqc.wasm.
  -fstack-protector-strong
  -Wall
  -Wextra
  -Werror=implicit-function-declaration
  --no-entry
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sEXIT_RUNTIME=0
  '-sINCOMING_MODULE_JS_API=["locateFile","wasmBinary"]'
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]'
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_qbit_pqc_public_key_size","_qbit_pqc_secret_key_size","_qbit_pqc_signature_size","_qbit_pqc_keygen_entropy_min_size","_qbit_pqc_keygen","_qbit_pqc_secret_key_validate","_qbit_pqc_sign","_qbit_pqc_sign_with_stats","_qbit_pqc_verify"]'
)

build_one() {
  local variant=$1
  shift
  echo "building $variant -> $OUT_DIR"
  # Record which toolchain produced the hashes written below.
  local emcc_version image
  emcc_version=$("${EMCC[@]}" --version)
  head -n 1 <<<"$emcc_version"
  if [[ "${USE_LOCAL_EMCC:-0}" != "1" ]]; then
    # {{json}}, not {{join}}: newer Docker CLIs hand templates RepoDigests as
    # []interface{}, which join rejects.
    image=$(docker image inspect --format '{{json .RepoDigests}} (image ID {{.Id}})' "$EMSDK_IMAGE")
    echo "emsdk image $EMSDK_IMAGE -> $image"
  fi
  # Compile into a fresh staging directory inside OUT_DIR (the Docker build
  # can only write inside the repository) and move both outputs into place
  # only once emcc has written them. A failed build leaves the previous
  # outputs, including the committed wasm/ files, untouched, and a compile that
  # writes nothing cannot leave stale files behind to be hashed.
  STAGE_DIR="$OUT_DIR/.build-stage"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  "${EMCC[@]}" "${COMMON_FLAGS[@]}" "$@" "${SOURCES[@]}" -o "$STAGE_DIR/pqc.mjs"
  if [[ ! -f "$STAGE_DIR/pqc.mjs" || ! -f "$STAGE_DIR/pqc.wasm" ]]; then
    echo "emcc did not write both pqc.mjs and pqc.wasm" >&2
    exit 1
  fi
  chmod 0644 "$STAGE_DIR/pqc.mjs" "$STAGE_DIR/pqc.wasm"
  mv -f "$STAGE_DIR/pqc.mjs" "$STAGE_DIR/pqc.wasm" "$OUT_DIR/"
  rmdir "$STAGE_DIR"
  STAGE_DIR=
  node scripts/check-wasm-hash.mjs --write --dir "$OUT_DIR"
}

case "$VARIANT" in
  baseline)
    build_one baseline
    ;;
  *)
    echo "usage: $0 [baseline]" >&2
    exit 1
    ;;
esac
