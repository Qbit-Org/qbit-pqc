# @qbit-oss/pqc Signing: Message Size and Usage Bound

What signing costs for each message length, and how many signatures one key
may make.

## Message size

Sign a 32-byte digest of your data, as qbit Core does with its sighashes, not
the data itself. Every FORS+C grind attempt hashes the whole message, and a
signature takes tens of thousands of attempts, so signing time grows with the
message length times the number of attempts. `sign` and `signWithStats` are
synchronous and block their thread for that long. Measured in Node 24 and a
Chrome MV3 service worker, and varying with the attempts each message needs:

| Message | Signing time |
| --- | --- |
| 32 bytes | 0.6 s |
| 4 KiB | 0.7–2.5 s |
| 64 KiB | 3.5–7.5 s |
| 256 KiB | 25–80 s |
| 1 MiB | 60–80 s, and 105 s in an MV3 service worker |

The `SIGNING_LIMIT` cap on grind attempts (see [Usage bound](#usage-bound))
does not bound this time: at 1 MiB, about an hour would pass before it fired.
Verifying stays fast, about 2.5 ms at 1 MiB, but copying a message into WASM
memory grows the heap, which never shrinks.

So `sign` and `signWithStats` throw a `RangeError` for a `msg` longer than
`constants.MAX_MESSAGE_SIZE` (65536 bytes), and `verify` returns `false` for
one, before allocating any WASM memory. To sign or verify a longer message,
pass `{ allowLargeMessage: true }` as the last argument:

<!-- snippet: test/types/docs-signing-large-message.mts -->
```ts
const signature = pqc.sign(secretKey, payload, { allowLargeMessage: true })
const valid = pqc.verify(publicKey, payload, signature, { allowLargeMessage: true })
```

`options` must be `undefined` or a plain object (an object literal or
`Object.create(null)`, from the same realm as the package) with no property
other than `allowLargeMessage`, which must be a boolean or `undefined`.
Anything else throws a `TypeError`, whatever the message length. Only the
object's own data properties are read, through functions captured when the
module loads, so a getter is rejected without being called. JavaScript cannot
inspect a `Proxy` without running its traps, so a `Proxy` passed as `options`
runs them, before any other argument is read.

## Usage bound

An SLH-DSA-SHA2-128s-bounded30 key is designed for at most 2^30 signatures.
This package keeps no counter and does not stop at that bound, so callers must
persist a signature counter for each public key and stop signing with a key
once its counter reaches 2^30. qbit Core refuses to sign past the bound.

Re-signing the same `(secretKey, message)` bytes is deterministic: it returns
the same signature, so it reveals nothing new. That holds only while the stored
key is intact. `secretKeyValidate` and signing check the stored root against
the seeds but not the PRF key `SK.prf` (bytes 16–31), so a key corrupted there
still validates and signs the same message differently. Store a checksum with
each key and check it before signing, or count every signature, re-signs
included.

`SIGNING_LIMIT` is a separate cap, on the grind attempts for one message, not
on signatures per key. Retrying the same bytes hits the same limit, so change
the message or transaction bytes before signing again. A `SIGNING_LIMIT` error
from `signWithStats` carries the signing stats, whose `capExceeded` holds the
caps that were hit as bit flags from `constants.SIGN_LIMITS`.
