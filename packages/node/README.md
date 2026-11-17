# RayKit by Vetigen for Node.js

Run `npm install @raykit/node` on Node.js 22.14 or later. npm selects the optional native package for Linux with glibc 2.28 or later, macOS, or Windows on x64 and arm64.

Open a local Part 10 file without a DOM. A native session serializes submitted operations and performs IO, verification, decoding and rendering on the Node-API async work pool.

```js
import { open } from '@raykit/node';

const source = await open('computed-tomography.dcm');
try {
  const first = await source.frameInfo(0);
  const view = await source.preview(0);
  console.log(first.geometry, view.pixels.byteLength);
} finally {
  await source.close();
}
```

Frames and pixel coordinates are zero-based. `preview` returns an owned RGBA8 buffer. `sample` returns the original value, modality conversion, verified unit and patient coordinate when available. `verifyMeasurement` recomputes and checks the saved result from the same source. `frameIndex` and `frameProof` build private index artifacts for a separately authorized consumer. Transfer the proof pin over the channel the consuming application trusts.

The session owns one source snapshot. Await `close()` to drain accepted requests and release native state. Keep the queue bounded in application code when submitting many frames.
