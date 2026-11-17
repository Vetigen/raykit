import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from './static-server.mjs';

const browserName = process.env.RAYKIT_BROWSER ?? 'chromium';
const paths = { sdk: new URL('../packages/web/dist/', import.meta.url), viewer: new URL('../examples/web/dist/', import.meta.url) };
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const fixtures = ['benchmark-signed12.dcm', 'cine-350.dcm'];
const rows = fixtures.map(name => ({ name, ...manifest[name] }));

function instrumentWorker(fallback) {
  const report = detail => self.postMessage({ raykitSourceTest: detail });
  self.addEventListener('unhandledrejection', event => report({ kind: 'unhandled-rejection', reason: String(event.reason) }));
  for (const name of ['instantiateStreaming', 'instantiate']) {
    const instantiate = WebAssembly[name]?.bind(WebAssembly);
    if (instantiate) WebAssembly[name] = async (...args) => {
      const result = await instantiate(...args);
      report({ kind: 'wasm-ready' });
      return result;
    };
  }
  if (fallback && self.crypto) Object.defineProperty(self.crypto, 'subtle', { value: undefined });
  const subtle = self.crypto?.subtle;
  report({ kind: 'crypto', available: typeof subtle?.digest === 'function' });
  if (!subtle) return;
  const digest = subtle.digest.bind(subtle);
  const held = new URL(self.location.href).searchParams.has('hold-digest') ? Promise.withResolvers() : undefined;
  if (held) self.addEventListener('message', event => {
    if (event.data === 'release-test-digest') { event.stopImmediatePropagation(); held.resolve(); }
  });
  Object.defineProperty(subtle, 'digest', { value: async (algorithm, data) => {
    report({ kind: 'digest', algorithm, bytes: data.byteLength });
    if (held) await held.promise;
    return digest(algorithm, data);
  } });
}

function serveInstrumented(fallback) {
  return serve('examples/web/dist', (req, res, next) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const sdk = pathname.startsWith('/sdk/');
    const worker = pathname === '/sdk/worker.js' || /^\/assets\/worker-[\w-]+\.js$/.test(pathname);
    if (!sdk && !worker) return next();
    const directory = sdk ? paths.sdk : paths.viewer;
    const file = new URL(sdk ? pathname.slice('/sdk/'.length) : `.${pathname}`, directory);
    if (!file.href.startsWith(directory.href)) return res.writeHead(404).end();
    void readFile(file).then(bytes => {
      res.writeHead(200, { 'content-type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
      res.end(worker ? `(${instrumentWorker.toString()})(${fallback});\n${bytes.toString('utf8')}` : bytes);
    }, () => res.writeHead(404).end());
  });
}

function monitorWorkers() {
  window.sourceTest = { workers: [], rejected: [], holdDigest: false };
  window.addEventListener('unhandledrejection', event => { window.sourceTest.rejected.push(String(event.reason)); });
  window.Worker = class extends Worker {
    constructor(url, options) {
      const workerUrl = new URL(url, location.href);
      if (window.sourceTest.holdDigest) workerUrl.searchParams.set('hold-digest', '1');
      super(workerUrl, options);
      this.observed = { worker: this, ops: [], events: [], closed: 0, changes: new EventTarget() };
      window.sourceTest.workers.push(this.observed);
      this.addEventListener('message', event => {
        if (!event.data?.raykitSourceTest) return;
        this.observed.events.push(event.data.raykitSourceTest);
        this.observed.changes.dispatchEvent(new Event('observation'));
      });
    }
    postMessage(message, ...args) {
      if (message.op) this.observed.ops.push(message.op);
      return super.postMessage(message, ...args);
    }
    terminate() { this.observed.closed++; super.terminate(); }
  };
  window.sourceTest.waitFor = async (worker, kind) => {
    const signal = AbortSignal.timeout(8_000);
    while (!worker.events.some(event => event.kind === kind)) {
      await new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const waited = new AbortController();
        worker.changes.addEventListener('observation', () => { waited.abort(); resolve(); }, { once: true, signal: waited.signal });
        signal.addEventListener('abort', () => { waited.abort(); reject(signal.reason); }, { once: true, signal: waited.signal });
      });
    }
  };
}

const browser = await { chromium, firefox, webkit }[browserName].launch(browserName === 'chromium' ? {
  executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
} : {});
try {
  for (const fallback of [false, true]) {
    const service = await serveInstrumented(fallback);
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(monitorWorkers);
      await page.goto(service.url);
      const samples = await page.evaluate(async rows => {
        const { open } = await import('/sdk/index.js');
        const viewer = document.querySelector('raykit-viewer');
        const report = [];
        const inspectFrame = (frame, row, col) => {
          const index = row * frame.format.columns + col;
          const { pixels } = frame;
          const value = frame.encoding === 'mono_i32_le'
            ? new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength).getInt32(index * 4, true)
            : frame.encoding === 'rgb8' ? [...pixels.subarray(index * 3, index * 3 + 3)] : null;
          return { index: frame.source.frame, hash: frame.source.content_sha256, value };
        };
        for (const { name, sha256, expected } of rows) {
          const blob = await (await fetch(name)).blob();
          const opts = { expected_sha256: sha256.toUpperCase(), expected_size: blob.size, revision: 'synthetic-original' };
          const indices = expected.frames > 1 ? [0, 175, 349] : [0];
          const [row, col] = expected.sample ?? [0, 0];
          const session = await open(blob, opts);
          const sdkFrames = [];
          for (const index of indices) sdkFrames.push(inspectFrame(await session.readFrame(index, { output: 'stored' }), row, col));
          const revision = session.revision;
          const hash = session.inspection.content_sha256;
          session.close();
          const closed = await session.readFrame(0).then(() => 'opened', error => error.code);

          const viewerFrames = [];
          await viewer.open(blob, opts);
          for (const index of indices) {
            if (index > 0) await viewer.viewport.showFrame(index, false);
            const { frame, presented } = viewer.viewport;
            viewerFrames.push({ ...inspectFrame(frame, row, col), original: presented.quality === 'original' &&
              presented.source.content_sha256 === sha256 && presented.source.frame === index &&
              presented.requestId === frame.requestId && presented.revision === revision });
          }
          viewer.viewport.close();
          report.push({ name, revision, hash, closed, sdkFrames, viewerFrames });
        }
        return report;
      }, rows);
      for (const [i, result] of samples.entries()) {
        const { name, sha256, expected } = rows[i];
        assert.equal(result.name, name);
        assert.equal(result.hash, sha256);
        assert.equal(result.revision, 'synthetic-original');
        assert.equal(result.closed, 'closed');
        const indices = expected.frames > 1 ? [0, 175, 349] : [0];
        for (const frames of [result.sdkFrames, result.viewerFrames]) {
          assert.deepEqual(frames.map(frame => frame.index), indices);
          for (const frame of frames) {
            assert.equal(frame.hash, sha256);
            const target = expected.sample?.[2] ?? expected.rgb_at_0_0[frame.index];
            if (Array.isArray(target)) {
              assert.equal(frame.value?.length, target.length);
              assert.ok(frame.value.every((value, i) => Math.abs(value - target[i]) <= expected.tolerance));
            } else assert.equal(frame.value, target);
          }
        }
        assert.ok(result.viewerFrames.every(frame => frame.original));
      }
      const workers = await page.evaluate(() => window.sourceTest.workers.map(({ events, ops, closed }) => ({ events, ops, closed })));
      assert.equal(workers.length, rows.length * 2);
      for (const [i, { events, ops, closed }] of workers.entries()) {
        assert.equal(closed, 1);
        assert.equal(ops.filter(op => op === 'open').length, 1);
        assert.equal(events.filter(event => event.kind === 'wasm-ready').length, 1);
        assert.deepEqual(events.filter(event => event.kind === 'crypto'), [{ kind: 'crypto', available: !fallback }]);
        assert.deepEqual(events.filter(event => event.kind === 'digest'), fallback ? [] : [
          { kind: 'digest', algorithm: 'SHA-256', bytes: rows[Math.floor(i / 2)].bytes },
        ]);
      }

      const lifecycle = await page.evaluate(async ({ rows, fallback }) => {
        const { open } = await import('/sdk/index.js');
        const viewer = document.querySelector('raykit-viewer');
        const present = [];
        viewer.addEventListener('raykit-presented', event => present.push(event.detail.source.content_sha256));
        const last = () => window.sourceTest.workers.at(-1);
        const [small, cine] = await Promise.all(rows.map(async ({ name }) => (await fetch(name)).blob()));
        const outcome = work => work.then(() => 'opened', error => error.code);
        const hash = await outcome(viewer.open(cine, { expected_sha256: '0'.repeat(64) }));
        const badHash = { code: hash, drawn: present.length, closed: last().closed };
        const before = window.sourceTest.workers.length;
        const limit = await outcome(viewer.open(cine, { limits: { source_bytes: cine.size - 1 } }));
        const size = await outcome(open(small, { expected_size: small.size + 1 }));
        const preAborted = new AbortController(); preAborted.abort();
        const preCancelled = await outcome(open(small, { signal: preAborted.signal }));
        const rejectedBeforeWorker = window.sourceTest.workers.length === before;
        const streamedLimit = await outcome(open({ async read() {
          return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); controller.close(); } });
        } }, { limits: { source_bytes: 32 } }));
        const streamedLimitClosed = last().closed;
        const wasmLimit = await outcome(open(cine, { limits: { frames: 4097 } }));
        const oversizedHashed = last().events.some(event => event.kind === 'digest');

        const pendingOpen = async (signal) => {
          const read = Promise.withResolvers();
          const opening = outcome(viewer.open({ async read() { return read.promise; } }, { signal }));
          const worker = last();
          await window.sourceTest.waitFor(worker, 'wasm-ready');
          return { read, opening, worker, eager: worker.ops.length === 0 };
        };
        const failure = await pendingOpen();
        failure.read.reject(new Error('Synthetic reader failure'));
        const io = { code: await failure.opening, eager: failure.eager, closed: failure.worker.closed };
        const abort = new AbortController();
        const cancelled = await pendingOpen(abort.signal);
        abort.abort();
        const aborted = { code: await cancelled.opening, eager: cancelled.eager, closed: cancelled.worker.closed };
        cancelled.read.resolve(cine);

        const previous = await pendingOpen();
        await viewer.open(small);
        previous.read.resolve(cine);
        const replaced = { code: await previous.opening, eager: previous.eager, closed: previous.worker.closed, drawn: present.slice() };
        let cancelledHash = null;
        if (!fallback) {
          const abort = new AbortController();
          const before = present.length;
          window.sourceTest.holdDigest = true;
          const opening = outcome(viewer.open(cine, { signal: abort.signal }));
          const worker = last();
          await window.sourceTest.waitFor(worker, 'digest');
          abort.abort();
          cancelledHash = { code: await opening, closed: worker.closed, drawn: present.length - before };
          window.sourceTest.holdDigest = false;
        }
        const disposing = await pendingOpen();
        viewer.remove();
        const disposed = { code: await disposing.opening, eager: disposing.eager, closed: disposing.worker.closed };
        disposing.read.resolve(cine);

        const callerBytes = new Uint8Array(await cine.arrayBuffer());
        window.sourceTest.holdDigest = !fallback;
        const digesting = open(callerBytes, { expected_sha256: rows[1].sha256 });
        const hashing = last();
        if (!fallback) await window.sourceTest.waitFor(hashing, 'digest');
        callerBytes.fill(0);
        if (!fallback) hashing.worker.postMessage('release-test-digest');
        const session = await digesting;
        const copiedSha = session.inspection.content_sha256;
        session.close();
        return { badHash, limit, size, preCancelled, rejectedBeforeWorker, streamedLimit, streamedLimitClosed, wasmLimit, oversizedHashed,
          io, aborted, replaced, cancelledHash, disposed, copiedSha, openWorkers: window.sourceTest.workers.filter(worker => !worker.closed).length };
      }, { rows, fallback });
      assert.deepEqual(lifecycle, { badHash: { code: 'integrity', drawn: 0, closed: 1 }, limit: 'limit', size: 'integrity',
        preCancelled: 'cancelled', rejectedBeforeWorker: true, streamedLimit: 'limit', streamedLimitClosed: 1,
        wasmLimit: 'limit', oversizedHashed: false,
        io: { code: 'io', eager: true, closed: 1 }, aborted: { code: 'cancelled', eager: true, closed: 1 },
        replaced: { code: 'cancelled', eager: true, closed: 1, drawn: [rows[0].sha256] },
        cancelledHash: fallback ? null : { code: 'cancelled', closed: 1, drawn: 0 },
        disposed: { code: 'cancelled', eager: true, closed: 1 }, copiedSha: rows[1].sha256, openWorkers: 0 });
      assert.deepEqual(await page.evaluate(() => window.sourceTest.rejected), []);
      assert.deepEqual(await page.evaluate(() => window.sourceTest.workers.flatMap(w => w.events.filter(e => e.kind === 'unhandled-rejection'))), []);
      assert.deepEqual(errors, []);
      console.log(`${browserName} ${browser.version()}: ${fallback ? 'Rust fallback' : 'Web Crypto'} source opening passed.`);
    } finally { await page.close(); service.close(); }
  }
} finally { await browser.close(); }
