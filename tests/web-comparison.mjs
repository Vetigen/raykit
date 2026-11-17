import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serve } from './static-server.mjs';

const reference = JSON.parse(await readFile('benchmarks/evidence/comparison-reference.json', 'utf8'));
const repeats = Number(process.env.RAYKIT_COMPARISON_REPEATS ?? 5);
assert(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 100);
const server = await serve('examples/web/dist', undefined, {
  '/sdk': process.env.RAYKIT_WEB_DIST ?? 'packages/web/dist',
  '/fixtures': 'fixtures/generated',
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  const results = await page.evaluate(async ({ reference, repeats }) => {
    const { open, RaykitViewport } = await import('/sdk/index.js');
    const ct = await fetch('/fixtures/comparison-ct.dcm').then(r => r.blob());
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      n => n.toString(16).padStart(2, '0')).join('');
    const view = document.querySelector('raykit-viewer');
    await view.open(ct, { expected_sha256: reference.sha256 });
    await view.compare();
    const slider = view.shadowRoot.querySelector('[data-seek]');
    slider.value = String(reference.frame + 1);
    const drawn = Promise.all(view.viewports.map(panel => new Promise(resolve => {
      const notify = event => {
        if (event.detail.source.frame !== reference.frame) return;
        panel.removeEventListener('presented', notify);
        resolve();
      };
      panel.addEventListener('presented', notify);
    })));
    slider.dispatchEvent(new Event('input'));
    await drawn;
    slider.dispatchEvent(new Event('change'));
    const session = view.viewport.session;
    const visualSelections = view.viewports.map(panel => panel.presented.render.voi?.index ?? 0);
    const uiPresentations = view.viewports.map(panel => panel.presented.source.frame);
    const layouts = [];
    for (const count of [1, 2, 4]) {
      const trials = [];
      for (let trial = 0; trial < repeats; trial++) {
        let reads = 0;
        const surfaces = Array.from({ length: count }, () => {
          const surface = document.createElement('div');
          Object.assign(surface.style, { width: '384px', height: '384px', position: 'relative' });
          document.body.append(surface);
          return surface;
        });
        const panels = surfaces.map(surface => new RaykitViewport(surface, { gpu: false }));
        const started = performance.now();
        const source = await open({ read: async () => { reads++; return ct; } }, { expected_sha256: reference.sha256 });
        const opened = performance.now();
        await Promise.all(panels.map((panel, i) => panel.attach(source, { frame: reference.frame, render: {
          voi: { kind: 'window', index: i % 2 },
        } })));
        const presented = performance.now();
        const stats = await source.stats();
        const pixels = await Promise.all(panels.map(panel => panel.samplePresented(...reference.pixel)));
        const digests = await Promise.all(panels.map(panel => hash(panel.frame.pixels)));
        source.close();
        panels[0].close();
        const survivor = count > 1 ? await panels.at(-1).samplePresented(...reference.pixel) : null;
        panels.forEach(panel => panel.dispose());
        surfaces.forEach(surface => surface.remove());
        const closed = await source.stats().then(() => false, error => error.code === 'closed');
        trials.push({ reads, stats, pixels, digests, openedMs: opened - started, displayMs: presented - opened,
          firstOriginalMs: presented - started, closed, survivor });
      }
      layouts.push({ count, trials });
    }
    const frame = reference.frame;
    const selected = await session.views(frame);
    const geo = await session.transform(frame, { viewport: [512, 512], pan: [0, 0], zoom: 1, quarter_turns: 0 }, { x: 256.5, y: 256.5 });
    const record = await session.measure(frame, { id: 'comparison-ruler', method: 'raykit:length', version: 1,
      points: [{ x: 256, y: 256 }, { x: 266, y: 256 }] });
    await view.open(ct, { expected_sha256: reference.sha256, revision: 'independent-reopen' });
    const restored = await view.restoreMeasurement(record);
    const aborted = new AbortController();
    const first = session.readFrame(frame + 1, { signal: aborted.signal }).catch(error => error.code);
    const second = session.readFrame(frame + 1);
    aborted.abort();
    const cancelled = await first;
    const shared = await second;
    session.revoke();
    return { layouts, visualSelections, uiPresentations, selected, geo, record, restored, cancelled,
      otherFrame: shared.source.frame, invalidated: view.viewports[1].presented === undefined,
      sha256: await hash(await ct.arrayBuffer()) };
  }, { reference, repeats });
  assert.deepEqual(errors, []);
  assert.equal(results.sha256, reference.sha256);
  assert.deepEqual(results.visualSelections, [0, 1]);
  assert.deepEqual(results.uiPresentations, [reference.frame, reference.frame]);
  assert.deepEqual(results.selected.map(row => [row.scope, row.label]), reference.labels.map(label => ['shared', label]));
  assert.deepEqual(results.restored, results.record);
  assert(Math.abs(results.record.values[0].value - 7) < 1e-9);
  assert.equal(results.cancelled, 'cancelled');
  assert.equal(results.otherFrame, reference.frame + 1);
  assert(results.invalidated);
  for (const { count, trials } of results.layouts) {
    for (const trial of trials) {
      assert.equal(trial.reads, 1);
      assert.equal(trial.stats.session.decoded_frames, 1);
      assert(trial.closed);
      for (let i = 0; i < count; i++) {
        assert.deepEqual(trial.pixels[i], { kind: 'monochrome', stored: reference.stored, modality: reference.modality, padding: false });
        assert.equal(trial.digests[i], reference.rgba_sha256[i % 2]);
      }
      if (count > 1) assert.deepEqual(trial.survivor, trial.pixels[0]);
    }
  }
  console.log(JSON.stringify({ browser: browser.version(), renderer: 'cpu', viewport: [384, 384], repeats,
    source: reference.sha256, layouts: results.layouts, sample: results.layouts[0].trials[0].pixels[0],
    units: reference.unit, record: results.record }, null, 2));
} finally {
  await browser?.close();
  server.close();
}
