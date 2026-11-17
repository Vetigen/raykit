const loaders = {
  raykit: () => import('./raykit.js'), dwv: () => import('./dwv.js'),
  cornerstone: () => import('./cornerstone.js'), webgpu: () => import('./webgpu.js'),
};
const host = document.querySelector('#viewport');
const paint = () => new Promise(requestAnimationFrame);

async function outcome(started, sequence) {
  const latencies = [], presented = [];
  for (const action of sequence) {
    const at = performance.now();
    await action();
    const timestamp = performance.now();
    latencies.push(timestamp - at);
    presented.push(timestamp);
  }
  const intervals = presented.slice(1).map((time, i) => time - presented[i]);
  return { elapsed_ms: performance.now() - started, input_latency_ms: latencies, present_interval_ms: intervals,
    estimated_missed_60hz: intervals.reduce((sum, interval) => sum + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0) };
}

window.runRaykitBenchmark = async (backend, fixture, expected, options) => {
  const started = performance.now();
  let engine;
  try {
    const module = await loaders[backend]();
    const moduleReady = performance.now();
    const bytes = await (await fetch(fixture, { cache: 'no-store' })).arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== expected.sha256) throw new Error('Fixture identity mismatch');
    const count = expected.expected.frames;
    const file = new File([bytes], fixture, { type: 'application/dicom' });
    const sourceReady = performance.now();
    engine = await module.create(host, file, count);
    const ready = performance.now();
    await paint();
    const first = performance.now();
    if (engine.count !== count) throw new Error(`Frame count ${engine.count} differs from ${count}`);
    const cases = count > 1 ? [0, Math.floor(count / 2), count - 1] : [0];
    const seek = [];
    for (const i of cases) {
      const before = performance.now();
      await engine.seek(i);
      const presented = await paint();
      const value = await engine.sample(i, count === 1 ? 10 : 0, count === 1 ? 10 : 0);
      const target = count === 1 ? expected.expected.sample[2] : expected.expected.rgb_at_0_0[i];
      const delta = Array.isArray(value) ? Math.max(...value.map((v, idx) => Math.abs(v - target[idx]))) : Math.abs(value - target);
      if (!Number.isFinite(delta) || delta > (expected.expected.tolerance ?? 0)) throw new Error(`Original sample differs for frame ${i}: ${value} vs ${target}`);
      seek.push({ frame: i, presented_ms: presented - before, sample: value, delta });
    }
    const stats = await engine.metrics();
    let interaction;
    if (options.full) {
      const n = 20;
      const range = Array.from({ length: n }, (_, i) => i);
      interaction = count > 1 ? { seek: await outcome(performance.now(), range.map(i => () => engine.seek((i * 53) % count))) }
        : { window: await outcome(performance.now(), range.map(i => () => engine.window(-3180 + i * 25, 300 + i * 13))),
          pan_zoom: await outcome(performance.now(), range.map(i => () => engine.panZoom(Math.sin(i) * 2, Math.cos(i) * 2, 1 + i * 0.02))) };
    }
    return { opened: true, backend: engine.name, module_ms: moduleReady - started, source_ms: sourceReady - moduleReady,
      frame_open_ms: ready - sourceReady, first_ms: first - sourceReady, engine_first_ms: engine.readyTime ?? null,
      seek, interaction, stats, js_heap_bytes: performance.memory?.usedJSHeapSize ?? null,
      assets: performance.getEntriesByType('resource').filter(e => /\.(?:m?js|wasm)$/.test(e.name)).map(e => ({
        name: new URL(e.name).pathname.split('/').pop(), transfer_bytes: e.encodedBodySize,
      })) };
  } catch (error) {
    const message = error?.message ?? error?.error?.message ?? String(error);
    return { opened: false, processed_ms: performance.now() - started, error: message };
  } finally { engine?.close(); }
};

window.verifyRaykitGpu = async () => {
  const { verifyGpu } = await import('./raykit.js');
  return verifyGpu(host, await (await fetch('benchmark-signed12.dcm')).blob());
};
