import { RaykitViewport, WebGlRenderer } from '@raykit/web';

export async function create(host, file, count) {
  const viewport = new RaykitViewport(host);
  try {
    const session = await viewport.load(file);
    return {
      name: `RayKit ${viewport.presented?.renderer}`,
      count: session.inspection.frames,
      async seek(index) { await viewport.showFrame(index, false); },
      async sample(index, row, col) {
        const value = await session.sample(index, col, row);
        return value.kind === 'color' ? value.values : value.stored;
      },
      window(center, width) { return presented(viewport, () => viewport.setRenderOptions({ window: { center, width, function: 'linear' } })); },
      panZoom(x, y, zoom) { return presented(viewport, () => viewport.setView({ pan: [x, y], zoom, quarter_turns: 0 })); },
      async metrics() { return { ...(await session.stats()), texture_bytes_estimate: viewport.textureBytes }; },
      close() { viewport.dispose(); },
    };
  } catch (error) { viewport.dispose(); throw error; }
}

function presented(viewport, update) {
  return new Promise(resolve => {
    viewport.addEventListener('presented', resolve, { once: true });
    update();
  });
}

export async function verifyGpu(host, file) {
  const viewport = new RaykitViewport(host, { gpu: false });
  const session = await viewport.load(file);
  try {
    const frame = await session.readFrame(0, { output: 'stored' });
    const canvas = document.createElement('canvas');
    const { columns, rows } = frame.format;
    canvas.width = columns; canvas.height = rows;
    const gl = new WebGlRenderer(canvas);
    const transform = { origin: { x: 0.5, y: 0.5 }, x_axis: [1, 0], y_axis: [0, 1] };
    const frames = [{ center: -3180, width: 2, function: 'linear_exact' }, { center: -3180, width: 1, function: 'linear' },
      { center: -3180, width: 370, function: 'sigmoid' }, { center: -2199, width: 1203, function: 'linear' }];
    let maximum = 0;
    try {
      for (const window of frames) {
        const cpu = await session.render(0, { window });
        if (!gl.draw(frame, transform, [columns, rows], { window })) throw new Error('WebGL2 validation profile unavailable');
        const gpu = gl.capture();
        for (let row = 0; row < rows; row++) for (let col = 0; col < columns * 4; col++) {
          maximum = Math.max(maximum, Math.abs(cpu[row * columns * 4 + col] - gpu[(rows - 1 - row) * columns * 4 + col]));
        }
      }
      const enlarged = document.createElement('canvas');
      enlarged.width = columns * 2; enlarged.height = rows * 2;
      const interpolation = new WebGlRenderer(enlarged);
      try {
        const window = { center: -3120, width: 140, function: 'linear_exact' };
        interpolation.draw(frame, { origin: { x: 1, y: 1 }, x_axis: [2, 0], y_axis: [0, 2] }, [enlarged.width, enlarged.height], { window });
        const gpu = interpolation.capture();
        const checks = [10, 21, 39].map(x => {
          const y = 10;
          const dx = x + 0.25, dy = y + 0.25;
          const raw = -2000 + dx * 40 + dy * 6;
          const expected = Math.round((1 - Math.max(0, Math.min(1, (2 * raw - 100 - window.center) / window.width + 0.5))) * 255);
          const actual = gpu[((enlarged.height - 1 - (2 * y + 1)) * enlarged.width + 2 * x + 1) * 4];
          return { expected, actual };
        });
        return { maximum, interpolation: checks, decoder_frames: (await session.stats()).session.decoded_frames };
      } finally { interpolation.dispose(); }
    } finally { gl.dispose(); }
  } finally { viewport.dispose(); }
}
