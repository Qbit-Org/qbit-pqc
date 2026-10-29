// These declarations shadow the globals of the same names for the whole
// factory, so updateMemoryViews builds HEAPU8 and the other heap views, and
// _emscripten_resize_heap computes how far to grow memory, with constructors
// and Math functions captured before any of it runs. init() in src/index.ts
// passes the copies the package captured when it loaded as qbitPqcIntrinsics.
// Each entry is used only if it is a function; otherwise, as when the factory
// gets no qbitPqcIntrinsics, the glue's own copy from when this module was
// evaluated is, so no shadowed name is ever left undefined.
var qbitPqcPassedIntrinsics = Module["qbitPqcIntrinsics"];
function qbitPqcIntrinsic(name) {
  var passed = qbitPqcPassedIntrinsics?.[name];
  return typeof passed == "function" ? passed : qbitPqcGlueIntrinsics[name];
}
var Int8Array = qbitPqcIntrinsic("Int8Array");
var Uint8Array = qbitPqcIntrinsic("Uint8Array");
var Int16Array = qbitPqcIntrinsic("Int16Array");
var Uint16Array = qbitPqcIntrinsic("Uint16Array");
var Int32Array = qbitPqcIntrinsic("Int32Array");
var Uint32Array = qbitPqcIntrinsic("Uint32Array");
var Float32Array = qbitPqcIntrinsic("Float32Array");
var Float64Array = qbitPqcIntrinsic("Float64Array");
var BigInt64Array = qbitPqcIntrinsic("BigInt64Array");
var BigUint64Array = qbitPqcIntrinsic("BigUint64Array");
var Math = { ceil: qbitPqcIntrinsic("mathCeil"), max: qbitPqcIntrinsic("mathMax"), min: qbitPqcIntrinsic("mathMin") };
// Used by native/glue-intrinsics.post.js.
var qbitPqcMemoryBuffer = qbitPqcIntrinsic("memoryBuffer");
var qbitPqcMemoryGrow = qbitPqcIntrinsic("memoryGrow");
