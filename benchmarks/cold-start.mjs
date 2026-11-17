import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const browserName = process.env.RAYKIT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
const repeats = Number(process.env.RAYKIT_REPEATS ?? 12);
const before = process.env.RAYKIT_STARTUP_BASELINE;
const after = process.env.RAYKIT_STARTUP_SDK ?? 'packages/web/dist';
assert.ok(before, 'Set RAYKIT_STARTUP_BASELINE to the earlier web package dist directory');
assert.ok(browserType && Number.isSafeInteger(repeats) && repeats > 0);
const fixtures = ['benchmark-signed12.dcm', 'cine-350.dcm'];
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const args = browserName === 'chromium' ? ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--enable-precise-memory-info', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface'] : [];
const viewport = { width: 640, height: 512 };
const reopenWaitMs = 200;
const getDigest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const assets = {};
for (const [variant, directory] of Object.entries({ before, after })) {
  assets[variant] = {};
  for (const file of ['viewport.js', 'worker.js', 'generated/raykit_wasm_bg.wasm']) {
    assets[variant][file] = await getDigest(`${directory}/${file}`);
  }
}
assert.equal(assets.after['worker.js'], assets.before['worker.js']);
assert.equal(assets.after['generated/raykit_wasm_bg.wasm'], assets.before['generated/raykit_wasm_bg.wasm']);
assert.notEqual(assets.after['viewport.js'], assets.before['viewport.js']);

const service = await serve('benchmarks', (req, res, next) => {
  if (req.url !== '/startup') { next(); return; }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="image" style="width:640px;height:512px;position:relative"></div>');
}, { '/before': before, '/after': after, '/fixtures': 'fixtures/generated' });

const observations = [];
let browserVersion;
try {
  for (let trial = 0; trial < repeats; trial++) {
    for (const fixture of fixtures) {
      for (const variant of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
        const browser = await browserType.launch({ executablePath: browserName === 'chromium' ? process.env.RAYKIT_CHROMIUM : undefined, args });
        browserVersion = browser.version();
        try {
          const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
          await page.goto(`${service.url}/startup`);
          const result = await page.evaluate(async ({ variant, fixture, reference, reopenWaitMs }) => {
            const { RaykitViewport } = await import(`/${variant}/index.js`);
            const { originalPixel } = await import('/src/presentation.js');
            const blob = await (await fetch(`/fixtures/${fixture}`)).blob();
            const sourceFile = new File([blob], fixture);
            const options = { expected_sha256: reference.sha256, expected_size: reference.bytes };
            const target = document.getElementById('image');

            // Count resource initialization without changing the renderer configuration.
            const getContext = HTMLCanvasElement.prototype.getContext;
            let contextCalls = 0;
            HTMLCanvasElement.prototype.getContext = function (type, ...settings) {
              if (type === 'webgl2') contextCalls++;
              return getContext.call(this, type, ...settings);
            };

            const started = performance.now();
            const view = new RaykitViewport(target);
            const constructorMs = performance.now() - started;
            try {
              const record = async (since, initialContextCalls) => {
                await view.load(sourceFile, options);
                const { source, requestId, quality, renderer, time } = view.presented;
                if (source.content_sha256 !== reference.sha256 || source.frame !== 0 ||
                    source !== view.frame.source || requestId !== view.frame.requestId || quality !== 'original') {
                  throw Error('Invalid first original frame identity');
                }
                const expected = reference.expected;
                const [row, col, wanted] = expected.sample ?? [0, 0, expected.rgb_at_0_0[0]];
                const sample = originalPixel(view.frame, { row, col });
                const delta = Array.isArray(wanted)
                  ? Math.max(...wanted.map((n, i) => Math.abs(n - sample[i]))) : Math.abs(wanted - sample);
                if (!Number.isFinite(delta) || delta > (expected.tolerance ?? expected.value_tolerance ?? 0)) {
                  throw Error('First original pixel differs from the reference');
                }
                return { ms: time - since, context_requests: contextCalls - initialContextCalls, renderer, sample, delta,
                  worker_frame_ms: view.frame.workerReadMs };
              };
              const cold = await record(started, 0);
              await new Promise(resolve => setTimeout(resolve, reopenWaitMs));
              const reopen = await record(performance.now(), contextCalls);
              return { constructor_ms: constructorMs, cold, reopen };
            } finally {
              HTMLCanvasElement.prototype.getContext = getContext;
              view.dispose();
            }
          }, { variant, fixture, reference: manifest[fixture], reopenWaitMs });
          assert.ok(result.cold.ms >= 0 && result.reopen.ms >= 0);
          if (browserName === 'chromium') {
            assert.equal(result.cold.renderer, 'webgl2');
            assert.equal(result.cold.context_requests, variant === 'before' ? 2 : 1);
            assert.ok(result.reopen.context_requests <= 1);
          }
          observations.push({ trial, variant, fixture, ...result });
        } finally { await browser.close(); }
      }
    }
  }
} finally { service.close(); }

function metric(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
  return { n: sorted.length, median, p95: sorted[Math.ceil(0.95 * sorted.length) - 1] };
}

const summaries = {};
for (const fixture of fixtures) {
  summaries[fixture] = {};
  for (const variant of ['before', 'after']) {
    const runs = observations.filter(run => run.fixture === fixture && run.variant === variant);
    summaries[fixture][variant] = {
      cold_ms: metric(runs.map(run => run.cold.ms)),
      same_viewport_ms: metric(runs.map(run => run.reopen.ms)),
      constructor_ms: metric(runs.map(run => run.constructor_ms)),
      cold_worker_frame_ms: metric(runs.map(run => run.cold.worker_frame_ms)),
      cold_context_requests: metric(runs.map(run => run.cold.context_requests)),
      reopen_context_requests: metric(runs.map(run => run.reopen.context_requests)),
    };
  }
}
const procStatus = platform() === 'linux' ? await readFile('/proc/self/status', 'utf8') : '';
const report = {
  profile: {
    before_commit: process.env.RAYKIT_STARTUP_BASELINE_REVISION ?? 'e204eac8d42689ab47c76ebf1ff9b92de37ed477',
    after_commit: process.env.RAYKIT_STARTUP_REVISION ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    platform: platform(), release: release(), cpu: cpus()[0].model, memory_bytes: totalmem(),
    cpu_affinity: procStatus.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
    browser: browserName, browser_version: browserVersion, flags: args, viewport, device_scale_factor: 1, repetitions: repeats,
    measurement: 'prepared-file-to-first-original-draw-event',
    same_viewport_reopen_wait_ms: reopenWaitMs,
    fixture_hashes: Object.fromEntries(fixtures.map(name => [name, manifest[name].sha256])),
    assets,
  },
  summaries,
  observations,
};
await mkdir('benchmarks/results', { recursive: true });
await writeFile(`benchmarks/results/cold-start-${browserName}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(summaries, null, 2));
