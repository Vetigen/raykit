import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from './static-server.mjs';

const native = resolve(process.env.RAYKIT_NATIVE_EVIDENCE_DIR ?? 'benchmarks/results/delivery-native');
const sdk = resolve(process.env.RAYKIT_WEB_DIST ?? 'packages/web/dist');
const evidence = JSON.parse(await readFile(resolve(native, 'acceptance.json')));
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json'));
const initial = await readFile(resolve(native, 'proof/0.rkp'));
const wrong = await readFile(resolve(native, 'proof/175.rkp'));
const corrupted = Buffer.from(initial);
corrupted[corrupted.length - 1] ^= 1;
const metadataTampered = Buffer.from(initial);
metadataTampered[metadataTampered.readUInt32LE(4) - 1] ^= 1;
const tile = await readFile(resolve(native, 'tiles/0.bin'));
tile[0] ^= 1;
let fault = '';
const network = [];
const server = await serve('examples/web/dist', (req, res, next) => {
  network.push(req.url);
  const bad = {
    '/corrupt/0.rkp': corrupted, '/wrong-frame/0.rkp': wrong, '/truncated/0.rkp': initial.subarray(0, 128),
    '/wrong-metadata/0.rkp': metadataTampered, '/wrong-tile/0.bin': tile,
  }[req.url];
  if (bad) { res.writeHead(200).end(bad); return; }
  if (fault === 'network' && req.url.endsWith('/advanced/raykit_wasm_bg.wasm')) {
    res.writeHead(503).end(); return;
  }
  if (fault === 'version' && req.url.endsWith('/advanced/raykit_wasm.js')) {
    void readFile(resolve(sdk, 'generated/advanced/raykit_wasm.js'), 'utf8').then(js => {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(
        js.replace(/export function engine_version\(\) \{[\s\S]*?\n\}/, 'export function engine_version() { return "other-version"; }'),
      );
    });
    return;
  }
  next();
}, {
  '/sdk': sdk, '/proof': resolve(native, 'proof'), '/tiles': resolve(native, 'tiles'), '/wrong-tile': resolve(native, 'tiles'),
  '/fixtures': 'fixtures/generated',
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 920 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  const result = await page.evaluate(async ({ evidence, manifest }) => {
    const api = await import('/sdk/index.js');
    const blob = name => fetch('/fixtures/' + name + '.dcm').then(res => res.blob());
    const test = (condition, detail) => { if (!condition) throw new Error(detail); };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const once = (target, event, filter = () => true) => new Promise(resolve => {
      const listen = value => {
        if (!filter(value.detail)) return;
        target.removeEventListener(event, listen);
        resolve(value.detail);
      };
      target.addEventListener(event, listen);
    });
    const panel = (gpu = false) => {
      const element = document.createElement('div');
      Object.assign(element.style, { width: '384px', height: '384px', position: 'relative' });
      document.body.append(element);
      return new api.RaykitViewport(element, { gpu });
    };
    const viewport = panel();
    const index = evidence.proof.index;
    const pin = { rootSha256: index.root_sha256, revision: index.revision };
    const begin = performance.now();
    const session = await viewport.load(api.frameProofHttp('/proof/', pin), { expected_sha256: index.source.content_sha256 });
    const ms = viewport.presented.time - begin;
    const first = await session.stats();
    const firstSample = await viewport.samplePresented(0, 0);
    const samplePixels = session.sample.bind(session);
    let releaseSample;
    session.sample = async (...args) => {
      const value = await samplePixels(...args);
      await new Promise(resolve => { releaseSample = resolve; });
      return value;
    };
    const sampleDuringRedraw = viewport.samplePresented(0, 0);
    while (!releaseSample) await sleep(1);
    await viewport.redraw();
    releaseSample();
    test(JSON.stringify(await sampleDuringRedraw) === JSON.stringify(firstSample), 'Redrawing does not invalidate the original sample');
    releaseSample = undefined;
    const sampleBeforeSeek = viewport.samplePresented(0, 0).catch(error => error.code);
    while (!releaseSample) await sleep(1);
    await viewport.showFrame(175, false);
    releaseSample();
    test(await sampleBeforeSeek === 'cancelled', 'A different frame invalidates the original sample request');
    session.sample = samplePixels;
    const mid = await viewport.samplePresented(0, 0);
    const later = await session.stats();
    viewport.dispose();
    test(first.range_requests === 1 && first.indexed_range_read_bytes === evidence.proof.bytes, 'First proof needs exactly one response');
    test(later.range_requests === 2 && later.session.decoded_frames === 2, 'Later proof read');
    for (const [value, frame] of [[firstSample, '0'], [mid, '175']]) {
      const ref = manifest['cine-350.dcm'].expected.rgb_at_0_0[frame];
      test(ref.every((v, i) => Math.abs(v - value.values[i]) <= 2), 'Indexed cine sample');
    }
    const rejected = {};
    for (const dir of ['corrupt', 'wrong-frame', 'truncated', 'wrong-metadata', 'missing']) {
      const p = panel();
      rejected[dir] = await p.load(api.frameProofHttp('/' + dir + '/', pin)).then(() => 'opened', e => e.code);
      test(!p.presented, 'Invalid proof drew a frame');
      p.dispose();
    }
    for (const [name, invalid] of [
      ['root', { ...pin, rootSha256: '0'.repeat(64) }],
      ['revision', { ...pin, revision: 'other' }],
    ]) {
      rejected[name] = await api.open(api.frameProofHttp('/proof/', invalid)).then(() => 'opened', error => error.code);
    }

    const compare = await api.open(await blob('comparison-ct'), { expected_sha256: evidence.sample.source.content_sha256 });
    const sample = await compare.sampleAt(150, 256, 256);
    const restored = await compare.reopenMeasurement(evidence.record);
    compare.close();
    test(JSON.stringify(sample.sample) === JSON.stringify(evidence.sample.sample), 'Cross-language sample');
    test(sample.patient.every((x, i) => Math.abs(x - evidence.sample.patient[i]) < 1e-9), 'Cross-language patient coordinate');
    test(restored.values[0].value === evidence.record.values[0].value, 'Cross-language measurement');

    const tilePin = evidence.tile.manifest;
    const config = { baseUrl: '/tiles/', manifestSha256: tilePin.sha256, revision: tilePin.revision };
    const tiled = await api.openTiled(config);
    const full = await api.open(await blob('detail-signed12'));
    const region = { x: 254, y: 254, width: 8, height: 8 };
    const window = { window: { center: -1500, width: 90, function: 'sigmoid' }, palette: 'hot' };
    const a = await full.render(0, window);
    const b = await tiled.renderRegion(region, window);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) {
      test(a[((254 + y) * 2048 + 254) * 4 + x] === b[y * 32 + x], 'Tile boundary differs from full-frame pixels');
    }
    const tileSample = await tiled.sample(256, 256);
    const fullSample = await full.sample(0, 256, 256);
    test(JSON.stringify(tileSample) === JSON.stringify(fullSample), 'Original tile sample');
    const tilesBefore = await tiled.stats();
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '384px', height: '384px' });
    document.body.append(canvas);
    const view = new api.TiledViewport(canvas, tiled);
    await view.setView({ x: 256, y: 256 }, 2).catch(e => { if (e.code !== 'cancelled') throw e; });
    await view.setView({ x: 256, y: 256 }, 2);
    const point = await view.sample({ x: 192, y: 192 });
    test(point.pixel.x === 256 && point.pixel.y === 256, 'Tile screen-to-source projection');
    const measurement = await view.measure({ id: 'tiled-ruler', method: 'raykit:length', version: 1 },
      [{ x: 192, y: 192 }, { x: 212, y: 192 }]);
    test((await full.reopenMeasurement(measurement)).values[0].value === measurement.values[0].value, 'Tiled source record');
    const old = view.setView({ x: 420, y: 420 }, 1).catch(e => e.code);
    await view.setView({ x: 1800, y: 1700 }, 3);
    test(view.mapPoint({ x: 192, y: 192 }).x === 1800, 'Latest tile gesture');
    test(await old === 'cancelled', 'Old tile request was cancelled');
    const tilesAfter = await tiled.stats();
    view.close();
    full.close();
    const invalidTile = await api.openTiled({ ...config, baseUrl: '/wrong-tile/' });
    rejected.tile = await invalidTile.sample(0, 0).then(() => 'read', error => error.code);
    invalidTile.close();

    const t1 = await api.open(await blob('comparison-mr-t1'));
    const t2 = await api.open(await blob('comparison-mr-t2'));
    const shifted = await api.open(await blob('comparison-mr-shifted'));
    const mrSample = await t1.sampleAt(0, 3, 2);
    const { column_axis: x, row_axis: y } = mrSample.geometry.patient_plane;
    const normal = [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
    const reference = mrSample.source.frame_of_reference_uid;
    const mr = await t2.locatePatient(mrSample.patient, reference, normal);
    const misaligned = await shifted.locatePatient(mrSample.patient, reference, normal);
    test(mr?.frame === 1 && !misaligned, 'Registered patient coordinate and rejected shifted MR');
    const mapped = await t2.sampleAt(mr.frame, 3, 2);
    test(mapped.quantitative.value === mapped.sample.stored * .25 + .5 && mapped.quantitative.unit.value === '1/s', 'Quantitative MR scale');
    const hot = await t2.render(mr.frame, { quantitative: true });
    const gray = await t2.render(mr.frame, {});
    test(hot.some((value, i) => value !== gray[i]), 'Quantitative display');
    [t1,t2,shifted].forEach(item => item.close());

    const preview = new api.LiveViewport(document.createElement('canvas'), 2000);
    const original = panel(false);
    const color = await blob('us-rgb-planar');
    const noCalibration = await blob('us-gray-time');
    const capture = { acquisition: 'synthetic-ultrasound', frame: 'exact-0' };
    const img = (red = 12) => {
      const pixels = new ImageData(8,6);
      for (let offset = 0; offset < pixels.data.length; offset += 4) pixels.data.set([red,34,56,255], offset);
      return pixels;
    };
    const firstDraw = once(preview,'presented');
    const stream = preview.start({ id: 'synthetic', revision: 'v1', async *frames(signal) {
      yield { id: 0, timestampMs: performance.now(), pixels: img(), capture };
      while (!signal.aborted) await sleep(15);
    } });
    await firstDraw;
    const frozen = preview.freeze();
    preview.disconnect();
    await stream;
    test(frozen.frame === 0 && preview.presented === frozen && preview.status.lastImageAgeMs >= 0, 'Freeze survives disconnect');
    await preview.start({ id: 'synthetic', revision: 'v1', async *frames() {
      yield { id: 0, timestampMs: performance.now(), pixels: img(99) };
      yield { id: 2, timestampMs: performance.now(), pixels: img(98) };
    } });
    test(preview.frozen === frozen && preview.status.unseen === 1 && preview.status.dropped === 1, 'Reconnect, duplicate, and unseen frames');
    const orig = { capture, source: color, sha256: manifest['us-rgb-planar.dcm'].sha256, instanceUid: '2.25.840', dicomFrame: 0 };
    rejected.capture = await preview.bindOriginal(original, async () => ({ ...orig, capture: { ...capture, frame: 'other' } }))
      .then(() => 'bound', error => error.code);
    rejected.calibration = await preview.bindOriginal(original, async () => ({ ...orig, source: noCalibration,
      sha256: manifest['us-gray-time.dcm'].sha256, instanceUid: '2.25.842' })).then(() => 'bound', error => error.code);
    test(!original.presented, 'Incorrect capture cannot yield a measurement');
    await preview.bindOriginal(original, async () => orig);
    test(preview.status.original && original.presented.source.content_sha256 === orig.sha256, 'Exact original shown');
    const verified = await original.session.measure(0, { id: 'live-distance', method: 'raykit:length', version: 1,
      points: [{ x: 0,y: 0 }, { x: 3,y: 0 }], parameters: { require_mm: true } });
    preview.goLive();
    test(preview.presented.frame === 2 && !preview.status.original && !original.presented, 'Return to live keeps last frame on normal end');
    preview.close();
    original.dispose();

    const gpu = panel(true);
    const superseded = await gpu.load(await blob('signed12'));
    test(gpu.presented.renderer === 'webgl2' && gpu.displayStats.gpuAttempts === 1, 'First graphics setup');
    const next = gpu.load(color);
    test(!gpu.presented && gpu.textureBytes === 6, 'Old source and its texture are released during replacement');
    await next;
    const graphics = gpu.displayStats;
    test(gpu.presented.renderer === 'webgl2' && graphics.gpuAttempts === 1 && graphics.textureAllocations === 2,
      'One program handles both sources');
    test(await superseded.stats().then(() => false, error => error.code === 'closed'), 'Previous worker is released');
    gpu.dispose();
    test(gpu.textureBytes === 0, 'Closing releases the graphics resources');

    const seriesViewport = panel();
    const series = new api.ProgressiveSeries('v1');
    const follow = new api.LiveSeries(series, seriesViewport);
    const append = i => series.append({ sequence: i, manifestRevision: 'v1', expected: 3, members: [{
      instanceUid: '2.25.' + (911+i), revision: 'v1', acquisitionTimeMs: i,
      sha256: manifest['classic-ct-'+i+'.dcm'].sha256, byteLength: manifest['classic-ct-'+i+'.dcm'].bytes,
      source: { read: () => blob('classic-ct-'+i) },
    }] });
    const firstAcquisition = once(seriesViewport, 'presented');
    append(0);
    await firstAcquisition;
    follow.freeze();
    follow.disconnect();
    test(append(2) === 1 && append(1) === 1 && append(2) === 0, 'Late acquisition and duplicate');
    test(seriesViewport.presented.source.instance_uid === '2.25.911' && follow.status.unseen === 2, 'Frozen series unseen count');
    const latest = once(seriesViewport, 'presented', detail => detail.source.instance_uid === '2.25.913');
    follow.reconnect(); follow.goLive();
    await latest;
    follow.close();
    seriesViewport.dispose();
    return { graphics, proof: { ms, first, later, firstSample, mid }, tile: { tilesBefore, tilesAfter, sample: tileSample, measurement, region },
      sample, mr: { from: mrSample.patient, match: mr, misaligned, quantitative: mapped.quantitative },
      live: { frozen: frozen.frame, original: verified, resumed: 2, acquisitions: series.progress.available }, rejected };
  }, { evidence, manifest });
  assert.deepEqual(result.rejected, { corrupt: 'integrity', 'wrong-frame': 'integrity', truncated: 'integrity',
    'wrong-metadata': 'integrity', missing: 'io', root: 'integrity', revision: 'integrity', tile: 'integrity', capture: 'integrity',
    calibration: 'geometry' });
  const codec = async (fixture) => page.evaluate(async fixture => {
    const { open } = await import('/sdk/index.js');
    const content = await fetch('/fixtures/' + fixture + '.dcm').then(r => r.blob());
    try {
      const started = performance.now();
      const session = await open(content);
      try {
        await session.readFrame(0);
        return { ms: performance.now() - started, stats: await session.stats() };
      } finally { session.close(); }
    } catch (error) { return { error: error.code }; }
  }, fixture);
  network.length = 0;
  const basic = await codec('signed12');
  const basicRequests = network.filter(url => url.endsWith('.wasm'));
  assert(!basicRequests.some(url => url.includes('/advanced/')));
  fault = 'network';
  assert.equal((await codec('jpeg-ls')).error, 'io');
  fault = 'version';
  assert.equal((await codec('jpeg-ls')).error, 'integrity');
  fault = '';
  network.length = 0;
  const advanced = await codec('jpeg-ls');
  const advancedRequests = network.filter(url => url.endsWith('.wasm'));
  assert.equal(advanced.stats.engine, 'advanced');
  assert(advancedRequests.some(url => url.includes('/advanced/')));
  await page.locator('#custom-worker').click();
  await page.waitForFunction(() => document.querySelector('#sample-error').value.includes('stored -1540'));
  await page.locator('#open-mr-pair').click();
  await page.waitForFunction(() => document.querySelector('raykit-viewer').viewports.at(-1)?.presented?.source.instance_uid === '2.25.1972');
  const firstPanel = await page.locator('raykit-viewer').evaluate(viewer => {
    const panel = viewer.viewports[0];
    const tr = panel.presented.transform;
    const screen = panel.surface.getBoundingClientRect();
    return { x: screen.left + panel.surface.clientLeft + tr.origin.x + tr.x_axis[0]*3 + tr.y_axis[0]*2,
      y: screen.top + panel.surface.clientTop + tr.origin.y + tr.x_axis[1]*3 + tr.y_axis[1]*2 };
  });
  await page.locator('raykit-viewer select[data-tool]').selectOption('sample');
  await page.mouse.click(firstPanel.x, firstPanel.y);
  await page.waitForFunction(() => document.querySelector('raykit-viewer').shadowRoot.querySelector('[data-result]').textContent.includes('Panel 2'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), ...result, codec: { basic, advanced, basicRequests, advancedRequests } }, null, 2));
} finally { await browser?.close(); server.close(); }
