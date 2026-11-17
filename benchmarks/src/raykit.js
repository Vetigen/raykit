import { RaykitViewport, WebGlRenderer } from '@raykit/web';
import { observeDraw, originalPixel } from './presentation.js';

export async function create(host, file, count, probe) {
  const viewport = new RaykitViewport(host);
  let session;
  const present = (index, draw, point) => observeDraw(viewport, 'presented', ({ detail }) => {
    if (detail.source.frame !== index) return;
    const frame = viewport.frame;
    if (detail.quality !== 'original' || detail.source.content_sha256 !== probe.sha256 ||
        detail.source !== frame?.source || detail.requestId !== frame.requestId) {
      throw new Error('Presented RayKit frame does not match the selected source');
    }
    return { at: detail.time, source_id: detail.source.content_sha256, frame: index,
      sample: point && originalPixel(frame, point), work_ms: frame.workerReadMs, request_id: frame.requestId };
  }, draw);
  try {
    const first = await present(0, async () => { session = await viewport.load(file, { expected_sha256: probe.sha256 }); }, probe);
    return {
      name: `RayKit ${viewport.presented?.renderer}`,
      count: session.inspection.frames,
      first,
      seek(index, point) { return present(index, () => viewport.showFrame(index, false), point); },
      window(center, width) { return present(0, () => viewport.setRenderOptions({ window: { center, width, function: 'linear' } })); },
      panZoom(x, y, zoom) { return present(0, () => viewport.setView({ pan: [x, y], zoom, quarter_turns: 0 })); },
      async metrics() { return { ...(await session.stats()), texture_bytes_estimate: viewport.textureBytes }; },
      close() { viewport.dispose(); },
    };
  } catch (error) { viewport.dispose(); throw error; }
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
