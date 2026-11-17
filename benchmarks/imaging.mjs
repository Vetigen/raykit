import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const browserName = process.env.RAYKIT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
const repeats = Number(process.env.RAYKIT_IMAGING_REPEATS ?? 6);
const baseline = process.env.RAYKIT_BASELINE_SDK ?? 'benchmarks/results/sdk-dacd04d/npm/package/dist';
const reference = 'dacd04d94fdb06f6a3c18afe2d5d958feb403090';
const current = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.ok(browserType && Number.isSafeInteger(repeats) && repeats > 0);
const baselineWasm = createHash('sha256').update(await readFile(`${baseline}/generated/raykit_wasm_bg.wasm`)).digest('hex');
assert.equal(baselineWasm, '65d562a291c486d0b4c6cd35014cf8b747f2b7fd4f68fe0edad4fec0224c8aa3');
const currentWasm = createHash('sha256').update(await readFile('packages/web/dist/generated/raykit_wasm_bg.wasm')).digest('hex');
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const cine = await readFile('fixtures/generated/cine-350.dcm');
const etag = `"${manifest['cine-350.dcm'].sha256}"`;
const service = await serve('benchmarks', (req, res, next) => {
  if (req.url === '/imaging') { res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="image" style="width:640px;height:512px;position:relative"></div>'); return; }
  if (req.url !== '/range-cine') { next(); return; }
  assert.equal(req.headers['if-match'], etag);
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
  const start = Number(range[1]), end = Number(range[2]);
  res.writeHead(206, { etag, 'content-type': 'application/dicom', 'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${cine.length}` }).end(cine.subarray(start, end + 1));
}, { '/before': baseline, '/after': 'packages/web/dist', '/fixtures': 'fixtures/generated' });

const args = browserName === 'chromium' ? ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--enable-precise-memory-info', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface'] : [];
const raw = [];
let version;
try {
  for (let trial = 0; trial < repeats; trial++) {
    for (const variant of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
      const browser = await browserType.launch({ executablePath: browserName === 'chromium' ? process.env.RAYKIT_CHROMIUM : undefined, args });
      version = browser.version();
      let timer;
      try {
        const page = await browser.newPage({ viewport: { width: 640, height: 512 }, deviceScaleFactor: 1 });
        await page.goto(`${service.url}/imaging`);
        const cdp = browserName === 'chromium' && platform() === 'linux' ? await browser.newBrowserCDPSession() : undefined;
        let peak = 0;
        let pending = false;
        const sample = async () => {
          if (!cdp || pending) return;
          pending = true;
          try {
            const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
            const values = await Promise.all(processInfo.filter(p => p.type === 'renderer').map(async ({ id }) => {
              const stats = await readFile(`/proc/${id}/status`, 'utf8').catch(() => '');
              return Number(/^VmRSS:\s+(\d+)/m.exec(stats)?.[1] ?? 0) * 1024;
            }));
            peak = Math.max(peak, values.reduce((a, b) => a + b, 0));
          } catch { /* A renderer may have exited between the two observations. */ }
          finally { pending = false; }
        };
        if (cdp) timer = setInterval(() => void sample(), 50);
        const tests = await page.evaluate(async ({ variant, manifest, etag, trial }) => {
          const api = await import(`/${variant}/index.js`);
          const host = document.getElementById('image');
          const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
          const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
          const materialize = async name => {
            const bytes = await (await fetch(`/fixtures/${name}`)).arrayBuffer();
            if (await hash(bytes) !== manifest[name].sha256) throw Error(`Unexpected ${name} bytes`);
            return new File([bytes], name);
          };
          const cine = await materialize('cine-350.dcm');
          const checks = manifest[cine.name].expected;
          const expected = { expected_sha256: manifest[cine.name].sha256, expected_size: cine.size };
          const burst = async indices => {
            const vp = new api.RaykitViewport(host);
            try {
              const session = await vp.load(cine, expected);
              const before = await session.stats();
              const presented = [];
              vp.addEventListener('presented', ({ detail }) => {
                if (vp.frame.source !== detail.source || detail.source.content_sha256 !== expected.expected_sha256 ||
                  detail.requestId !== vp.frame.requestId || detail.quality !== 'original') throw Error('Mismatched presented frame');
                presented.push({ frame: detail.source.frame, ms: detail.time, id: detail.requestId });
              });
              const start = performance.now();
              const pending = [];
              for (const [i, index] of indices.entries()) {
                await sleep(start + i * 8 - performance.now());
                pending.push((vp.scrubFrame ? vp.scrubFrame(index) : vp.showFrame(index, false)).catch(error => {
                  if (error.code !== 'cancelled') throw error;
                }));
              }
              const released = performance.now();
              const last = indices.at(-1);
              if (vp.settle) await vp.settle(); else await vp.showFrame(last, false);
              await Promise.all(pending);
              if (vp.presented?.source.frame !== last) throw Error('Incorrect final scrub frame');
              const after = await session.stats();
              const shown = new Set(presented.filter(p => p.frame !== last).map(p => p.frame)).size;
              return { input_ms: released - start, release_ms: Math.max(0, vp.presented.time - released), interim_frames: shown,
                decode_count: after.session.decoded_frames - before.session.decoded_frames,
                decoded_bytes: after.session.produced_pixel_bytes - before.session.produced_pixel_bytes,
                output_copy_bytes: after.wasm_output_copy_bytes - before.wasm_output_copy_bytes,
                texture_bytes_estimate: vp.textureBytes, renderer: vp.presented.renderer, presented };
            } finally { vp.dispose(); }
          };
          const steady = await burst(Array.from({ length: 40 }, (_, i) => 35 + i * 8));
          const reverse = await burst(Array.from({ length: 40 }, (_, i) => i < 21 ? 12 + i * 13 : 272 - (i - 20) * 11));
          const volumeTests = async name => {
            const source = await materialize(name);
            const session = await api.open(source, { expected_sha256: manifest[name].sha256 });
            try {
              const candidates = await session.volumeCandidates();
              if (!candidates.candidates[0].available) return { unavailable: candidates.candidates[0].limitation };
              let start = performance.now();
              const volume = await session.buildVolume(0, candidates.revision);
              const initMs = performance.now() - start;
              const large = volume.dimensions[2] === 300;
              const center = large ? [179.2, 204.8, 180] : [-8.86, 7.98, 15.8];
              const patient = await session.sampleVolume(center);
              if (patient !== (large ? 448 : 136)) throw Error('Unexpected patient-space value');
              const plane = { center, orientation: { kind: 'axial' }, dimensions: [512, 512], spacing_xy: large ? [0.7, 0.8] : [0.016, 0.017], slab: { kind: 'single' } };
              const window = { center: large ? 500 : 150, width: large ? 900 : 400, function: 'linear' };
              const draw = async (plane, window) => {
                start = performance.now();
                const result = await session.reslice(plane, window);
                const ms = performance.now() - start;
                return { ms, sha256: await hash(result.pixels) };
              };
              const axial = await draw(plane, window);
              const coronal = await draw({ ...plane, orientation: { kind: 'coronal' } }, window);
              const oblique = { ...plane, orientation: { kind: 'oblique', axes: [1, 0, 0, 0, Math.SQRT1_2, Math.SQRT1_2] }, slab: { kind: 'maximum', thickness_mm: large ? 4.8 : 2.4 } };
              const mip = await draw(oblique, window);
              const windows = [];
              for (let i = 1; i <= 5; i++) windows.push(await draw(oblique, { ...window, center: window.center + i }));
              const moved = await draw({ ...oblique, center: [center[0], center[1] + 0.7, center[2]] }, window);
              return { init_ms: initMs, voxel_bytes: volume.voxel_bytes, axial, coronal, mip, windows, moved, stats: await session.stats() };
            } finally { session.close(); }
          };
          const small = await volumeTests('enhanced-ct-oblique.dcm');
          const big = await volumeTests('large-enhanced-ct.dcm');
          const range = {};
          if (api.indexedBlob) {
            const full = await api.open(cine, expected);
            let start = performance.now();
            const index = await full.createFrameIndex();
            range.build_ms = performance.now() - start;
            range.manifest_bytes = index.bytes.byteLength;
            range.manifest_sha256 = index.sha256;
            full.close();
            for (const [name, source] of Object.entries({ blob: api.indexedBlob(cine, index), http: api.indexedHttp('/range-cine', index, { etag }) })) {
              const vp = new api.RaykitViewport(host);
              try {
                start = performance.now();
                const opened = await vp.load(source, expected);
                const first = vp.presented.time - start;
                const rows = [];
                let total = 0;
                for (const frame of [0, 175, 349]) {
                  start = performance.now();
                  if (frame > 0) await vp.showFrame(frame, false);
                  const ms = frame === 0 ? first : vp.presented.time - start;
                  const sample = await vp.samplePresented(0, 0);
                  if (sample.values.some((x, i) => Math.abs(x - checks.rgb_at_0_0[frame][i]) > checks.tolerance)) throw Error('Incorrect range sample');
                  const stats = await opened.stats();
                  rows.push({ frame, ms, bytes: stats.indexed_range_read_bytes - total, sample: sample.values });
                  total = stats.indexed_range_read_bytes;
                }
                range[name] = { renderer: vp.presented.renderer, rows };
              } finally { vp.dispose(); }
            }
            for (const mode of trial % 2 ? [true, false] : [false, true]) {
              const vp = new api.RaykitViewport(host);
              try {
                start = performance.now();
                await vp.load(cine, { ...expected, prepare_first_frame: mode });
                if (vp.frame.source.content_sha256 !== expected.expected_sha256 || vp.frame.source.frame !== 0) throw Error('Incorrect prepared first frame');
                range[mode ? 'overlap_ms' : 'sequential_ms'] = vp.presented.time - start;
              } finally { vp.dispose(); }
            }
          }
          return { steady, reverse, small, big, range };
        }, { variant, manifest, etag, trial });
        await sample();
        raw.push({ trial, variant, ...tests, peak_renderer_rss_bytes: peak || null });
        console.log(`${variant} trial ${trial + 1}/${repeats}, ${tests.steady.interim_frames} intermediate frames`);
      } finally { clearInterval(timer); await browser.close(); }
    }
  }
} finally { service.close(); }

function metric(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? { n, median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2, p95: sorted[Math.ceil(n * .95) - 1] } : null;
}

for (let trial = 0; trial < repeats; trial++) {
  const before = raw.find(row => row.trial === trial && row.variant === 'before');
  const after = raw.find(row => row.trial === trial && row.variant === 'after');
  for (const plane of ['axial', 'coronal', 'mip', 'moved']) assert.equal(after.small[plane].sha256, before.small[plane].sha256);
  assert.deepEqual(after.small.windows.map(v => v.sha256), before.small.windows.map(v => v.sha256));
  assert.equal(after.big.voxel_bytes, 300 * 1024 ** 2);
  assert.ok(after.big.stats.volume.peak_slice_cache_bytes <= 16 * 1024 ** 2);
  assert.equal(after.big.stats.plane_cache_hits, 5);
  assert.deepEqual(after.range.http.rows.map(r => r.bytes), after.range.blob.rows.map(r => r.bytes));
}
const summary = Object.fromEntries(['before', 'after'].map(variant => {
  const runs = raw.filter(r => r.variant === variant);
  return [variant, {
    ...Object.fromEntries(['steady', 'reverse'].map(mode => [mode, Object.fromEntries(['release_ms', 'interim_frames', 'decode_count',
      'decoded_bytes', 'output_copy_bytes', 'texture_bytes_estimate'].map(key => [key, metric(runs.map(row => row[mode][key]))]))])),
    ...Object.fromEntries(['small', 'big'].map(name => [name, {
      init_ms: metric(runs.map(r => r[name].init_ms)), axial_ms: metric(runs.map(r => r[name].axial?.ms)),
      coronal_ms: metric(runs.map(r => r[name].coronal?.ms)), mip_ms: metric(runs.map(r => r[name].mip?.ms)),
      moved_ms: metric(runs.map(r => r[name].moved?.ms)), window_ms: metric(runs.flatMap(r => r[name].windows?.map(w => w.ms) ?? [])),
    }])),
    peak_renderer_rss_bytes: metric(runs.map(r => r.peak_renderer_rss_bytes)),
    range: Object.fromEntries(['build_ms', 'manifest_bytes', 'sequential_ms', 'overlap_ms'].map(key => [key, metric(runs.map(row => row.range[key]))])),
    ...Object.fromEntries(['blob', 'http'].map(name => [name, runs.every(r => r.range[name]) ?
      [0, 1, 2].map(i => ({ ms: metric(runs.map(r => r.range[name].rows[i].ms)), bytes: runs[0].range[name].rows[i].bytes })) : null])),
  }];
}));
const profile = { before: reference, after: current, wasm_sha256: { before: baselineWasm, after: currentWasm },
  browser: browserName, version, platform: platform(), release: release(), cpu: cpus()[0].model, host_memory: totalmem(), repeats,
  cpu_affinity: /^Cpus_allowed_list:\s*(.+)$/m.exec(await readFile('/proc/self/status', 'utf8').catch(() => ''))?.[1] ?? null,
  viewport: [640, 512], dpr: 1, input_interval_ms: 8, fixture_hashes: Object.fromEntries(['cine-350.dcm', 'enhanced-ct-oblique.dcm',
    'large-enhanced-ct.dcm'].map(name => [name, manifest[name].sha256])) };
await mkdir('benchmarks/results', { recursive: true });
await writeFile(`benchmarks/results/imaging-${browserName}.json`, `${JSON.stringify({ profile, summary, raw }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
