// Runs once the module is instantiated, before the factory resolves. Own
// `buffer` and `grow` properties on the memory shadow
// WebAssembly.Memory.prototype's, through the getter and method captured
// before (native/glue-intrinsics.pre.js), so the views updateMemoryViews
// builds whenever a call grows memory are on this memory's buffer, and the
// memory grows, whatever that prototype holds by then. The first views, built
// while the module was instantiated, read the prototype. Reads of
// %TypedArray%.prototype.length and ArrayBuffer.prototype.byteLength in the
// growth computation still go through the prototypes.
if (typeof qbitPqcMemoryBuffer == "function" && typeof qbitPqcMemoryGrow == "function") {
  var qbitPqcMemory = wasmMemory;
  Object.defineProperties(qbitPqcMemory, {
    buffer: { get: () => qbitPqcMemoryBuffer(qbitPqcMemory) },
    grow: { value: pages => qbitPqcMemoryGrow(qbitPqcMemory, pages) },
  });
}
