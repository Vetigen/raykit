import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, cpus, release, totalmem } from 'node:os';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';
import { browserMemory } from './browser-memory.mjs';

const count = Number(process.env.RAYKIT_DELIVERY_REPEATS ?? 8);
assert(Number.isSafeInteger(count) && count > 0 && count <= 40);
const currentOnly = process.env.RAYKIT_CURRENT_ONLY === '1';
const dirs = {
  ...(!currentOnly ? { before: process.env.RAYKIT_BASELINE_SDK ?? 'benchmarks/results/sdk-f128/package/dist' } : {}),
  scalar: process.env.RAYKIT_WEB_DIST ?? 'packages/web/dist',
};
if (process.env.RAYKIT_SIMD_DIST) dirs.simd = process.env.RAYKIT_SIMD_DIST;
const mounts = { '/fixtures': 'fixtures/generated' };
for (const [version, path] of Object.entries(dirs)) mounts['/' + version] = path;
const assets = {};
for (const [version, path] of Object.entries(dirs)) {
  assets[version] = {};
  for (const filename of ['index.js', 'worker.js', 'viewport.js', 'renderer.js', 'session.js',
    'generated/raykit_wasm.js', 'generated/raykit_wasm_bg.wasm', 'generated/advanced/raykit_wasm_bg.wasm']) {
    if (version === 'before' && filename.startsWith('generated/advanced/')) continue;
    const bytes = await readFile(path + '/' + filename);
    assets[version][filename] = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json'));
const reference = JSON.parse(await readFile('benchmarks/evidence/comparison-reference.json'));
const server = await serve('examples/web/dist', undefined, mounts);
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const measurements = [];
let browser;
try {
  for (let repeat = 0; repeat < count; repeat++) {
    const versions = Object.keys(dirs);
    if (repeat % 2) versions.reverse();
    for (const version of versions) {
      // A fresh process keeps startup, GPU preparation and the HTTP cache cold.
      browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args });
      const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
      const peaks = {};
      const cdp = process.platform === 'linux' ? await browser.newBrowserCDPSession() : undefined;
      const sampleMemory = async () => {
        if (!cdp) return;
        const values = await browserMemory(cdp).catch(() => ({}));
        for (const [kind, bytes] of Object.entries(values)) peaks[kind] = Math.max(peaks[kind] ?? 0, bytes);
      };
      const sampler = setInterval(() => void sampleMemory(), 50);
      try {
        await page.goto(server.url);
        const observation = await page.evaluate(async ({ version, manifest, mkMip, reference, currentOnly }) => {
          const test = (value, note) => { if (!value) throw new Error(note); };
          const begin = performance.now();
          const { RaykitViewport, open } = await import('/' + version + '/index.js');
          const importMs = performance.now() - begin;
          const digest = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
            v => v.toString(16).padStart(2,'0')).join('');
          const fixture = async key => {
            const name = key + '.dcm';
            const bytes = await fetch('/fixtures/' + name).then(r => r.arrayBuffer());
            test(await digest(bytes) === manifest[name].sha256, 'Fixture bytes');
            return new File([bytes], name);
          };
          const fixtures = {};
          for (const name of ['benchmark-signed12', 'detail-signed12', 'cine-350', 'jpeg-ls']) fixtures[name] = await fixture(name);
          const run = async gpu => {
            const viewport = document.createElement('div');
            Object.assign(viewport.style, { width: '640px', height: '512px', position: 'relative' });
            document.body.append(viewport);
            const constructorStart = performance.now();
            const vp = new RaykitViewport(viewport, { gpu });
            const constructorMs = performance.now() - constructorStart;
            let firstOriginal = 0;
            const load = async (name, sample, x, y) => {
              const now = performance.now();
              const session = await vp.load(fixtures[name], { expected_sha256: manifest[name+'.dcm'].sha256 });
              const elapsed = vp.presented.time - now;
              test(vp.presented.source.content_sha256 === manifest[name+'.dcm'].sha256 && vp.presented.source.frame === 0,
                'First original frame identity');
              const actual = await vp.samplePresented(x,y);
              test(actual.stored === sample || actual.values?.every((v,i)=>Math.abs(v-sample[i]) <= 2), 'First frame sample');
              return { elapsed, renderer: vp.presented.renderer, stats: await session.stats(), display: vp.displayStats };
            };
            const signed = await load('benchmark-signed12', -1540, 10, 10);
            firstOriginal = signed.elapsed;
            const reopened = await load('benchmark-signed12', -1540, 10, 10);
            const detail = await load('detail-signed12', -1508, 127, 10);
            const wl = [];
            for (const fn of ['linear','sigmoid']) {
              const changes = [];
              for (let i = 0; i < 12; i++) {
                const selected = { center: -1515 + i, width: 55, function: fn };
                const presented = new Promise(resolve => {
                  const handler = event => {
                    if (event.detail.render.window?.center !== selected.center || event.detail.render.window.function !== fn) return;
                    vp.removeEventListener('presented', handler);
                    resolve(event.detail);
                  };
                  vp.addEventListener('presented', handler);
                });
                const start = performance.now();
                vp.setRenderOptions({ window: selected });
                const event = await presented;
                test(event.source.frame === 0, 'Window change must keep frame');
                changes.push(event.time - start);
              }
              wl.push({ function: fn, timings: changes });
            }
            const detailStats = await vp.session.stats();
            const cine = await load('cine-350', [32,64,63],0,0);
            const seek = [];
            for (const target of [175, 349, 0, 175, 349, 0]) {
              const start = performance.now();
              await vp.showFrame(target, false);
              test(vp.presented.source.frame === target, 'Exact cine seek');
              seek.push(vp.presented.time - start);
            }
            const duration = 2000;
            const cineStart = performance.now();
            const running = vp.play();
            await new Promise(resolve => setTimeout(resolve,duration));
            vp.pause();
            const played = await running;
            const elapsed = performance.now() - cineStart;
            const during = await vp.session.stats();
            const display = vp.displayStats;
            let recovery = null;
            if (gpu) {
              const canvas = viewport.querySelector('canvas:not([hidden])');
              const gl = canvas?.getContext('webgl2');
              const loss = gl?.getExtension('WEBGL_lose_context');
              if (loss) {
                const wait = renderer => new Promise(resolve => {
                  const listener = event => {
                    if (event.detail.renderer !== renderer) return;
                    vp.removeEventListener('presented', listener);
                    resolve(event.detail.time);
                  };
                  vp.addEventListener('presented', listener);
                });
                const start = performance.now(), cpu = wait('cpu');
                loss.loseContext();
                const converted = (await cpu) - start;
                await new Promise(resolve => setTimeout(resolve,40));
                const restored = wait('webgl2');
                const resume = performance.now();
                loss.restoreContext();
                recovery = { fallbackMs: converted, restoredMs: await restored - resume, display: vp.displayStats };
                test(vp.presented.source.content_sha256 === manifest['cine-350.dcm'].sha256, 'Context recovery source');
              }
            }
            const closeStart = performance.now();
            vp.dispose();
            viewport.remove();
            return { constructorMs, firstOriginal, signed, reopened, detail, wl, detailStats, cine, seek,
              played, elapsed, during, display, recovery, closeMs: performance.now() - closeStart };
          };
          const cpu = await run(false);
          const gpu = await run(true);
          const codecTimes = {};
          for (const name of ['benchmark-signed12', 'jpeg-ls']) {
            const start = performance.now();
            const source = await open(fixtures[name]);
            try {
              const frame = await source.readFrame(0);
              const done = performance.now();
              codecTimes[name] = { ms: done - start, bytes: frame.pixels.length, stats: await source.stats() };
            } finally { source.close(); }
          }
          let mip = null;
          let mpr = null;
          if (mkMip) {
            const image = await open(await fixture('comparison-ct'));
            try {
              const choices = await image.volumeCandidates();
              const geometry = await image.buildVolume(0, choices.revision);
              const observations = [];
              for (const z of [120, 121.2, 122.4, 123.6, 124.8]) {
                const request = { center: [geometry.center[0], geometry.center[1], z], orientation: { kind: 'axial' },
                  dimensions: [512,512], spacing_xy: [0.7,0.8], slab: { kind: 'maximum', thickness_mm: 40 } };
                const start = performance.now();
                const plane = await image.reslice(request, undefined, undefined, { sampling: 'nearest' });
                const ms = performance.now() - start;
                observations.push({ ms, sha256: await digest(plane.pixels), stats: await image.stats() });
              }
              mip = observations;
              if (currentOnly) {
                const [x, y] = reference.pixel;
                const sample = await image.sampleAt(reference.frame, x, y);
                test(sample.source.content_sha256 === reference.sha256
                  && sample.sample.stored === reference.stored && sample.sample.modality === reference.modality
                  && sample.modality_unit === reference.unit && sample.patient.every((v, i) => v === reference.patient[i]),
                  'Packaged comparison CT');
                for (const index of [0, 1]) {
                  const rgba = await image.render(reference.frame, { voi: { kind: 'window', index } });
                  test(await digest(rgba) === reference.rgba_sha256[index], 'Device window reference');
                }
                const record = await image.measure(reference.frame, {
                  id: 'comparison-ruler', method: 'raykit:length', version: 1, points: [{ x, y }, { x: x + 10, y }],
                });
                test(record.values[0].value === 7 && record.values[0].unit === 'millimeter', 'Physical ruler');
                const tamper = await image.verifyMeasurement({ ...record, values: [{ ...record.values[0], value: 8 }] })
                  .then(() => 'accepted', error => error.code);
                test(tamper === 'integrity', 'Altered measurement must be rejected');
                mpr = {};
                for (const kind of ['axial', 'coronal', 'sagittal']) {
                  const start = performance.now();
                  const plane = await image.reslice({
                    center: reference.patient, orientation: { kind }, dimensions: [257, 257], spacing_xy: [0.7, 0.8],
                    slab: { kind: 'single' },
                  }, undefined, undefined, { sampling: 'nearest' });
                  const ms = performance.now() - start;
                  const values = new DataView(plane.pixels.buffer, plane.pixels.byteOffset, plane.pixels.byteLength);
                  test(plane.encoding === 'modality_f32_le' && values.getFloat32((128 * 257 + 128) * 4, true) === reference.modality,
                    'MPR central modality value');
                  mpr[kind] = { ms, sha256: await digest(plane.pixels) };
                }
              }
            } finally { image.close(); }
          }
          return { importMs, cpu, gpu, codecTimes, mip, mpr };
        }, { version, manifest, mkMip: repeat < 3 && version !== 'simd', reference, currentOnly });
        await sampleMemory();
        measurements.push({ version, repeat, browser: browser.version(), peak_rss_bytes: peaks, ...observation });
      } finally { clearInterval(sampler); await browser.close(); browser = undefined; }
    }
  }
  const before = measurements.find(run => run.version === (currentOnly ? 'scalar' : 'before') && run.mip)?.mip.map(row => row.sha256);
  for (const row of measurements.filter(run => run.mip)) assert.deepEqual(row.mip.map(a => a.sha256), before);
  assert(measurements.every(row => row.gpu.signed.renderer === 'webgl2' && row.cpu.signed.renderer === 'cpu'));
  if (process.platform === 'linux') assert(measurements.every(row => row.peak_rss_bytes.renderer > 0));
  const timing = values => {
    const ordered = [...values].sort((a, b) => a - b);
    return { n: ordered.length, median: (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2,
      p95: ordered[Math.ceil(0.95 * ordered.length) - 1] };
  };
  const trend = Object.fromEntries(Object.keys(dirs).map(version => {
    const rows = measurements.filter(row => row.version === version);
    return [version, {
      cpu: { first_original_ms: timing(rows.map(row => row.cpu.firstOriginal)),
        cine_seek_ms: timing(rows.flatMap(row => row.cpu.seek)), cine_dropped: rows.map(row => row.cpu.played.skipped) },
      webgl2: { first_original_ms: timing(rows.map(row => row.gpu.firstOriginal)),
        cine_seek_ms: timing(rows.flatMap(row => row.gpu.seek)), cine_dropped: rows.map(row => row.gpu.played.skipped) },
      mpr_ms: Object.fromEntries(['axial', 'coronal', 'sagittal'].flatMap(plane => {
        const values = rows.flatMap(row => row.mpr ? [row.mpr[plane].ms] : []);
        return values.length ? [[plane, timing(values)]] : [];
      })),
    }];
  }));
  console.log(JSON.stringify({ count, cpu: cpus()[0].model, architecture: arch(), os: release(), args, viewport: [640,512],
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    source_dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    runner: { image: process.env.ImageOS, version: process.env.ImageVersion, total_memory_bytes: totalmem(),
      actions_run: process.env.GITHUB_RUN_ID }, trend,
    fixtures: Object.fromEntries(Object.entries(manifest).filter(([name]) => ['benchmark-signed12.dcm','detail-signed12.dcm','cine-350.dcm',
      'jpeg-ls.dcm','comparison-ct.dcm'].includes(name)).map(([name,row]) => [name,row.sha256])), assets, measurements }, null, 2));
} finally { await browser?.close(); server.close(); }
