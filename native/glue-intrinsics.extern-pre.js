// The typed-array constructors and Math functions as they were when this
// module was evaluated. The factory below uses them only when its caller
// passes no qbitPqcIntrinsics of its own (see native/glue-intrinsics.pre.js).
const qbitPqcGlueIntrinsics = Object.freeze({
  Int8Array: Int8Array,
  Uint8Array: Uint8Array,
  Int16Array: Int16Array,
  Uint16Array: Uint16Array,
  Int32Array: Int32Array,
  Uint32Array: Uint32Array,
  Float32Array: Float32Array,
  Float64Array: Float64Array,
  BigInt64Array: BigInt64Array,
  BigUint64Array: BigUint64Array,
  Math: Object.freeze({ ceil: Math.ceil, max: Math.max, min: Math.min }),
});
