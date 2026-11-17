const loaders = {
  raykit: () => import('./raykit.js'), dwv: () => import('./dwv.js'),
  cornerstone: () => import('./cornerstone.js'), webgpu: () => import('./webgpu.js'),
};
const host = document.querySelector('#viewport');

async function outcome(started, sequence) {
  const latencies = [], presented = [];
  for (const action of sequence) {
    const at = performance.now();
    const { at: timestamp } = await action();
    latencies.push(timestamp - at);
    presented.push(timestamp);
  }
  const intervals = presented.slice(1).map((time, i) => time - presented[i]);
  return { elapsed_ms: performance.now() - started, input_latency_ms: latencies, present_interval_ms: intervals,
    estimated_missed_60hz: intervals.reduce((sum, interval) => sum + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0) };
}

function verifySample(drawn, index, expected) {
  if (drawn.frame !== index || drawn.source_id == null || !Number.isFinite(drawn.at)) {
    throw new Error(`Missing original presentation for frame ${index}`);
  }
  const target = expected.frames === 1 ? expected.sample[2] : expected.rgb_at_0_0[index];
  const { sample } = drawn;
  const delta = Array.isArray(target)
    ? Array.isArray(sample) && sample.length === target.length ? Math.max(...target.map((v, i) => Math.abs(v - sample[i]))) : NaN
    : typeof sample === 'number' ? Math.abs(sample - target) : NaN;
  if (!Number.isFinite(delta) || delta > (expected.tolerance ?? expected.value_tolerance ?? 0)) {
    throw new Error(`Original sample differs for frame ${index}: ${sample} vs ${target}`);
  }
  return { frame: index, source_id: drawn.source_id, sample, delta, reported_frame_work_ms: drawn.work_ms ?? null };
}

window.runRaykitBenchmark = (...args) => new Promise(resolve => {
  const open = document.querySelector('#open-synthetic');
  open.addEventListener('click', () => resolve(measure(...args)), { once: true });
  open.click();
});

async function measure(backend, fixture, expected, options) {
  const started = performance.now();
  const traceBefore = window.raykitWorkerTraces?.length ?? 0;
  let engine;
  try {
    const module = await loaders[backend]();
    const moduleReady = performance.now();
    const bytes = await (await fetch(fixture, { cache: 'no-store' })).arrayBuffer();
    const read = performance.now();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    const hashed = performance.now();
    if (hash !== expected.sha256) throw new Error('Fixture identity mismatch');
    const count = expected.expected.frames;
    const file = new File([bytes], fixture, { type: 'application/dicom' });
    const [row, col] = count === 1 ? expected.expected.sample : [0, 0];
    const probe = { row, col, sha256: hash };
    const sourceReady = performance.now();
    engine = await module.create(host, file, count, probe);
    const first = verifySample(engine.first, 0, expected.expected);
    const firstMs = engine.first.at - sourceReady;
    if (firstMs < 0) throw new Error('Presentation predates the selected source');
    if (engine.count !== count) throw new Error(`Frame count ${engine.count} differs from ${count}`);
    const cases = count > 1 ? [0, Math.floor(count / 2), count - 1] : [0];
    const seek = [];
    for (const i of cases) {
      const before = performance.now();
      const drawn = await engine.seek(i, probe);
      seek.push({ ...verifySample(drawn, i, expected.expected), presented_ms: drawn.at - before });
    }
    const stats = await engine.metrics();
    let interaction;
    if (options.full) {
      const n = 20;
      const range = Array.from({ length: n }, (_, i) => i);
      interaction = count > 1 ? { seek: await outcome(performance.now(), range.map(i => () => engine.seek((i * 53) % count))),
        cine: await playback(engine, count) }
        : { window: await outcome(performance.now(), range.map(i => () => engine.window(-3180 + i * 25, 300 + i * 13))),
          pan_zoom: await outcome(performance.now(), range.map(i => () => engine.panZoom(Math.sin(i) * 2, Math.cos(i) * 2, 1 + i * 0.02))) };
    }
    const worker = backend === 'raykit' ? window.raykitWorkerTraces?.[traceBefore] : undefined;
    const clock = performance.timeOrigin;
    const phases = worker && {
      worker_start_ms: worker.ready - worker.created,
      source_transfer_ms: worker.received - worker.sent,
      worker_hash_ms: worker.hashed - worker.hashing,
      first_render_ms: clock + engine.first.at - worker.frame[engine.first.request_id],
    };
    if (phases && !Object.values(phases).every(time => Number.isFinite(time) && time >= 0)) {
      throw new Error('Worker timing is missing or reversed');
    }
    return { opened: true, backend: engine.name, module_ms: moduleReady - started, source_ms: sourceReady - moduleReady,
      user_open_ms: engine.first.at - started, file_read_ms: read - moduleReady, source_pin_check_ms: hashed - read, phases,
      first_original_ms: firstMs, first_original: first,
      full_series_ms: engine.seriesReadyAt == null ? null : engine.seriesReadyAt - sourceReady,
      seek, interaction, stats, js_heap_bytes: performance.memory?.usedJSHeapSize ?? null,
      assets: performance.getEntriesByType('resource').filter(e => /\.(?:m?js|wasm)$/.test(e.name)).map(e => ({
        name: new URL(e.name).pathname.split('/').pop(), transfer_bytes: e.encodedBodySize,
      })) };
  } catch (error) {
    const message = error?.message ?? error?.error?.message ?? String(error);
    return { opened: false, processed_ms: performance.now() - started, error: message };
  } finally { engine?.close(); }
}

async function playback(engine, count) {
  const sourceIntervalMs = 1000 / 35;
  const started = performance.now();
  let frame = 0, shown = 0, dropped = 0;
  const intervals = [];
  let previous;
  while (performance.now() - started < 2000) {
    const due = started + frame * sourceIntervalMs;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const wanted = Math.max(frame, Math.floor((performance.now() - started) / sourceIntervalMs));
    dropped += wanted - frame;
    const { at: now } = await engine.seek(wanted % count);
    if (previous !== undefined) intervals.push(now - previous);
    previous = now; ++shown; frame = wanted + 1;
  }
  return { source_interval_ms: sourceIntervalMs, shown, dropped, intervals_ms: intervals };
}

window.verifyRaykitGpu = async () => {
  const { verifyGpu } = await import('./raykit.js');
  return verifyGpu(host, await (await fetch('benchmark-signed12.dcm')).blob());
};
