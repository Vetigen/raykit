export async function observeDraw(target, type, identify, draw) {
  let listener;
  const presented = new Promise((resolve, reject) => {
    listener = event => {
      const at = performance.now();
      try {
        const frame = identify(event);
        if (!frame) return;
        target.removeEventListener(type, listener);
        resolve({ at, ...frame });
      } catch (error) { reject(error); }
    };
    target.addEventListener(type, listener);
  });
  try {
    const [frame] = await Promise.all([presented, Promise.resolve().then(draw)]);
    return frame;
  } finally { target.removeEventListener(type, listener); }
}

export function originalPixel(frame, { row, col }) {
  const index = row * frame.format.columns + col;
  const { pixels } = frame;
  if (frame.encoding === 'mono_i32_le') {
    return new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength).getInt32(index * 4, true);
  }
  if (frame.encoding === 'rgb8') return Array.from(pixels.subarray(index * 3, index * 3 + 3));
  throw new Error(`Unexpected original fixture encoding ${frame.encoding}`);
}
