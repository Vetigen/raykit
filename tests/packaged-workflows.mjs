import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from './static-server.mjs';
import { artifacts, flutterArchive, version } from '../scripts/release-lib.mjs';

const root = resolve('.');
const tree = mkdtempSync(join(tmpdir(), 'raykit-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const web = join(tree, 'examples/web');
const flutter = join(tree, 'examples/flutter');
const engine = process.env.RAYKIT_BROWSER ?? 'chromium';
const browsers = { chromium, firefox, webkit };
assert.ok(browsers[engine], 'Unknown browser ' + engine);
const reference = JSON.parse(readFileSync(join(root, 'benchmarks/evidence/comparison-reference.json')));
const published = process.argv.includes('--published');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} exited with ${result.status}`);
}

function copy(path) {
  const output = join(tree, path);
  mkdirSync(join(output, '..'), { recursive: true });
  cpSync(join(root, path), output, { recursive: true });
}

function assertNotices(directory) {
  const inventory = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
  for (const name of ['dicom-core', 'dicom-dictionary-std', 'jpeg-decoder', 'oxiarc-jpeg', 'pure_jpegls', 'openjpeg2-pure-rs']) {
    const crate = inventory.find(crate => crate.name === name);
    assert.ok(crate?.license && crate.documents.length, `Missing license files for ${name}`);
    for (const file of crate.documents) assert.ok(existsSync(join(directory, file)));
  }
  assert.ok(!inventory.some(crate => crate.name.startsWith('openjph') || crate.name === 'jpeg-encoder'));
}

function assertPortableBinary(path) {
  const bytes = readFileSync(path);
  for (const localPath of [homedir(), root, tree]) {
    assert.ok(!bytes.includes(localPath), 'Binary preserved a local build path');
  }
}

try {
  for (const path of ['tsconfig.base.json', 'examples/web/package.json', 'examples/web/tsconfig.json', 'examples/web/vite.config.mjs',
    'examples/web/dicomweb-fixture.mjs', 'examples/web/index.html', 'examples/web/src', 'fixtures/generated']) copy(path);
  const packages = ['web', 'web-component'];
  const files = packages.map(name => join(artifacts, 'raykit-' + name + '-' + version + '.tgz'));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(tree, 'npm-cache'),
    ...(published ? ['--registry', 'https://registry.npmjs.org', '@raykit/web-component@' + version] : files),
    'vite@7.3.1', 'typescript@5.9.3'], web);
  const lock = JSON.parse(readFileSync(join(web, 'package-lock.json')));
  for (const [index, name] of packages.entries()) {
    const pkg = lock.packages['node_modules/@raykit/' + name];
    assert.equal(pkg.version, version);
    assert.equal(pkg.integrity, 'sha512-' + createHash('sha512').update(readFileSync(files[index])).digest('base64'));
  }
  assertNotices(join(web, 'node_modules/@raykit/web/dist/notices'));
  for (const name of ['web', 'web-component']) {
    assert.deepEqual(readFileSync(join(web, 'node_modules/@raykit', name, 'dist/LICENSE')), readFileSync(join(root, 'LICENSE')));
  }
  assertPortableBinary(join(web, 'node_modules/@raykit/web/dist/generated/raykit_wasm_bg.wasm'));
  assertPortableBinary(join(web, 'node_modules/@raykit/web/dist/generated/advanced/raykit_wasm_bg.wasm'));
  run(npm, ['run', 'build'], web);
  const requests = [];
  const sdk = join(web, 'node_modules/@raykit/web/dist');
  const service = await serve(join(web, 'dist'), (req, res, next) => {
    requests.push(req.url);
    next();
  }, { '/installed-sdk': sdk });
  let browser;
  try {
    browser = await browsers[engine].launch(engine === 'chromium' ? {
      executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    } : {});
    const page = await browser.newPage();
    await page.goto(service.url);
    await page.locator('[data-fixture="signed12.dcm"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
    const result = await page.locator('raykit-viewer').evaluate(async viewer => {
      const session = viewer.viewport.session;
      const sample = await session.sample(0, 10, 10);
      const measure = await session.measure(0, { id: 'packaged-distance', method: 'raykit:length', version: 1,
        points: [{ x: 0, y: 0 }, { x: 6, y: 16 }] });
      await viewer.restoreMeasurement(measure);
      return { stored: sample.stored, values: viewer.measurements[0].values, supported: session.inspection.capabilities.frame_access };
    });
    assert.deepEqual(result, { stored: -1540, values: [{ name: 'length', value: 5, unit: 'millimeter' }], supported: true });
    await page.locator('[data-fixture="cine-350.dcm"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.session?.inspection.frames === 350 &&
      document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
    const last = await page.locator('raykit-viewer').evaluate(async viewer => {
      const viewport = viewer.viewport;
      await viewport.showFrame(349, false);
      return viewport.presented.source.frame;
    });
    assert.equal(last, 349);
    await page.locator('#open-indexed').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.session?.inspection.verification === 'pinned_frame_index' &&
      document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
    const range = await page.locator('raykit-viewer').evaluate(async viewer => {
      const vp = viewer.viewport;
      await vp.scrubFrame(175);
      await vp.showFrame(349, false);
      const original = await vp.samplePresented(0, 0);
      return { original, reads: (await vp.session.stats()).range_requests };
    });
    assert.deepEqual(range, { original: { kind: 'color', space: 'rgb', values: [189, 87, 75] }, reads: 3 });
    await page.locator('[data-fixture="large-enhanced-ct.dcm"]').click();
    await page.locator('#build-volume').click();
    await page.waitForFunction(() => document.querySelector('#volume-status').value.includes('300 source slices'));
    await page.locator('#volume-plane').selectOption('Oblique');
    await page.locator('#volume-slab').selectOption('maximum');
    await page.waitForFunction(() => document.querySelector('#volume-status').value.startsWith('oblique · maximum'));
    await page.locator('#volume-width').fill('200');
    await page.waitForFunction(async () => (await document.querySelector('raykit-viewer').viewport.session.stats()).plane_cache_hits >= 1);
    await page.locator('raykit-viewer').locator('[data-action="close"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.session === undefined);
    await page.locator('[data-fixture="comparison-ct.dcm"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.frame?.views?.[1]?.label === 'Bone');
    const compared = await page.locator('raykit-viewer').evaluate(async viewer => {
      await viewer.compare();
      await Promise.all(viewer.viewports.map(vp => vp.showFrame(150, false)));
      const values = await Promise.all(viewer.viewports.map(panel => panel.samplePresented(256, 256)));
      return { frames: viewer.viewports.map(panel => panel.session === viewer.viewport.session ? panel.presented.source.frame : null),
        values: values.map(value => value.modality), windows: viewer.viewports.map(panel => panel.presented.render.voi.index) };
    });
    assert.deepEqual(compared, { frames: [150, 150], values: [448, 448], windows: [0, 1] });
    const exact = await page.evaluate(async ref => {
      const api = await import('/installed-sdk/index.js');
      const fixture = name => fetch(name + '.dcm').then(response => response.blob());
      const content = await fixture('comparison-ct');
      const surface = document.body.appendChild(document.createElement('div'));
      Object.assign(surface.style, { width: '390px', height: '360px' });
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (type === 'webgl2') return null;
        return getContext.call(this, type, ...args);
      };
      let panel;
      try {
        panel = new api.RaykitViewport(surface);
        const session = await panel.load(content, { expected_sha256: ref.sha256 });
        await panel.showFrame(ref.frame, false);
        const [x, y] = ref.pixel;
        const sample = await session.sampleAt(ref.frame, x, y);
        const rgba = await Promise.all([0, 1].map(async index => {
          const pixels = await session.render(ref.frame, { voi: { kind: 'window', index } });
          const digest = await crypto.subtle.digest('SHA-256', pixels);
          return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }));
        const measurement = await session.measure(ref.frame, {
          id: 'comparison-ruler', method: 'raykit:length', version: 1, points: [{ x, y }, { x: x + 10, y }],
        });
        const reopened = await session.reopenMeasurement(measurement);
        const tamper = await session.verifyMeasurement({ ...measurement, values: [{ ...measurement.values[0], value: 8 }] })
          .then(() => 'accepted', error => error.code);
        const badPin = await api.open(content, { expected_sha256: '0'.repeat(64) }).then(
          opened => { opened.close(); return 'accepted'; }, error => error.code);
        return { sample, rgba, measurement, reopened, tamper, badPin,
          renderer: panel.presented.renderer, frame: panel.presented.source.frame, engine: (await session.stats()).engine };
      } finally {
        panel?.dispose();
        surface.remove();
        HTMLCanvasElement.prototype.getContext = getContext;
      }
    }, reference);
    assert.equal(exact.renderer, 'cpu');
    assert.equal(exact.frame, reference.frame);
    assert.equal(exact.engine, 'baseline');
    assert.equal(exact.sample.source.content_sha256, reference.sha256);
    assert.equal(exact.sample.sample.stored, reference.stored);
    assert.equal(exact.sample.sample.modality, reference.modality);
    assert.equal(exact.sample.modality_unit, reference.unit);
    assert.deepEqual(exact.sample.patient, reference.patient);
    assert.deepEqual(exact.rgba, reference.rgba_sha256);
    assert.deepEqual(exact.measurement.values, [{ name: 'length', value: 7, unit: 'millimeter' }]);
    assert.deepEqual(exact.reopened, exact.measurement);
    assert.equal(exact.tamper, 'integrity');
    assert.equal(exact.badPin, 'integrity');
    assert(requests.some(url => url.startsWith('/installed-sdk/worker.js')));
    assert(!requests.some(url => url.startsWith('/installed-sdk/generated/advanced/')));
    const jpeg = JSON.parse(readFileSync(join(root, 'fixtures/generated/manifest.json')))['jpeg-ls.dcm'];
    const codec = await page.evaluate(async sha => {
      const api = await import('/installed-sdk/index.js');
      const file = await fetch('jpeg-ls.dcm').then(response => response.blob());
      const session = await api.open(file, { expected_sha256: sha });
      try {
        const frame = await session.readFrame(0, { output: 'stored' });
        const view = new DataView(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
        return { engine: (await session.stats()).engine, stored: Array.from({ length: view.byteLength / 4 },
          (_, index) => view.getInt32(index * 4, true)) };
      } finally { session.close(); }
    }, jpeg.sha256);
    assert.equal(codec.engine, 'advanced');
    assert.deepEqual(codec.stored, jpeg.expected.stored);
    assert(requests.some(url => url.startsWith('/installed-sdk/generated/advanced/raykit_wasm_bg.wasm')));
    await page.locator('#custom-worker').click();
    await page.waitForFunction(() => document.querySelector('#sample-error').value.includes('stored -1540'));
    if (existsSync(join(root, 'fixtures/generated/delivery/pins.json'))) {
      await page.locator('#open-proof').click();
      await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.session?.inspection.verification === 'pinned_frame_proof' &&
        document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
      const proof = await page.locator('raykit-viewer').evaluate(async viewer => (await viewer.viewport.session.stats()).range_requests);
      assert.equal(proof, 1);
      await page.locator('#open-tiles').click();
      await page.waitForFunction(() => document.querySelector('#tiled-status').value.includes('Original resolution'));
    }
    const evidence = { engine, browser: browser.version(), ...exact, advanced_codec: codec.engine };
    if (process.env.RAYKIT_WEB_EVIDENCE) writeFileSync(process.env.RAYKIT_WEB_EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); service.close(); }

  if (!process.argv.includes('--web')) {
    for (const path of ['examples/flutter/pubspec.yaml', 'examples/flutter/analysis_options.yaml', 'examples/flutter/lib',
      'examples/flutter/test', 'examples/flutter/assets/raykit']) copy(path);
    mkdirSync(join(tree, 'packages'));
    run('tar', ['-xzf', join(artifacts, flutterArchive)], join(tree, 'packages'));
    renameSync(join(tree, 'packages/raykit'), join(tree, 'packages/flutter'));
    assertNotices(join(tree, 'packages/flutter/notices'));
    assert.deepEqual(readFileSync(join(tree, 'packages/flutter/LICENSE')), readFileSync(join(root, 'LICENSE')));
    run('flutter', ['pub', 'get'], flutter);
    run('flutter', ['test', '--no-pub', '--concurrency=1', 'test/example_test.dart'], flutter);
    if (process.platform === 'linux') assertPortableBinary(join(flutter, 'build/native_assets/linux/libraykit_ffi.so'));
    console.log('Independent web and Flutter package consumers passed.');
  }
} finally { rmSync(tree, { recursive: true, force: true }); }
