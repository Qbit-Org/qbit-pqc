// These declarations shadow the globals of the same names for the whole
// factory, so updateMemoryViews builds HEAPU8 and the other heap views, and
// _emscripten_resize_heap computes how far to grow memory, with constructors
// and Math functions captured before any of it runs. init() in src/index.ts
// passes the copies the package captured when it loaded; without them the
// glue's own copies, from when this module was evaluated, are used.
var qbitPqcIntrinsics = Module["qbitPqcIntrinsics"] ?? qbitPqcGlueIntrinsics;
var Int8Array = qbitPqcIntrinsics.Int8Array;
var Uint8Array = qbitPqcIntrinsics.Uint8Array;
var Int16Array = qbitPqcIntrinsics.Int16Array;
var Uint16Array = qbitPqcIntrinsics.Uint16Array;
var Int32Array = qbitPqcIntrinsics.Int32Array;
var Uint32Array = qbitPqcIntrinsics.Uint32Array;
var Float32Array = qbitPqcIntrinsics.Float32Array;
var Float64Array = qbitPqcIntrinsics.Float64Array;
var BigInt64Array = qbitPqcIntrinsics.BigInt64Array;
var BigUint64Array = qbitPqcIntrinsics.BigUint64Array;
var Math = qbitPqcIntrinsics.Math;
