// Runs once the runtime has initialized (after run()) and before the factory
// resolves, so before init() settles. Own `buffer` and `grow` properties on
// the memory shadow WebAssembly.Memory.prototype's, through the getter and
// method captured before (native/glue-intrinsics.pre.js), and the heap views
// built while the module was instantiated, through the prototype's getter,
// are rebuilt through the captured one. So once init() has settled, the views
// are on this memory's buffer, including those updateMemoryViews builds
// whenever a call grows memory, and the memory grows, whatever that prototype
// holds by then. Reads of %TypedArray%.prototype.length and
// ArrayBuffer.prototype.byteLength in the growth computation still go through
// the prototypes.
if (typeof qbitPqcMemoryBuffer == "function" && typeof qbitPqcMemoryGrow == "function") {
  var qbitPqcMemory = wasmMemory;
  Object.defineProperties(qbitPqcMemory, {
    buffer: { get: () => qbitPqcMemoryBuffer(qbitPqcMemory) },
    grow: { value: pages => qbitPqcMemoryGrow(qbitPqcMemory, pages) },
  });
  updateMemoryViews();
}
