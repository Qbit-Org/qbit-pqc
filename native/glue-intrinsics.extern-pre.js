// The typed-array constructors, Math functions, and the WebAssembly.Memory
// buffer getter and grow method (uncurried), as they were when this module was
// evaluated. The factory below uses each one that its caller's
// qbitPqcIntrinsics does not supply as a function (see
// native/glue-intrinsics.pre.js). Without WebAssembly, the memory entries are
// undefined and the module cannot be instantiated anyway.
const qbitPqcGlueIntrinsics = (() => {
  const memory = typeof WebAssembly == "object" ? WebAssembly.Memory?.prototype : undefined;
  const buffer = memory && Object.getOwnPropertyDescriptor(memory, "buffer")?.get;
  const grow = memory?.grow;
  const uncurry = method => (typeof method == "function" ? Function.prototype.call.bind(method) : undefined);
  return Object.freeze({
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
    mathCeil: Math.ceil,
    mathMax: Math.max,
    mathMin: Math.min,
    memoryBuffer: uncurry(buffer),
    memoryGrow: uncurry(grow),
  });
})();
