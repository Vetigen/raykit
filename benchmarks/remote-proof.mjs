import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const archive = process.env.RAYKIT_NATIVE_EVIDENCE_DIR ?? 'benchmarks/results/delivery-native';
const { proof: { index }, index: flat } = JSON.parse(await readFile(archive + '/acceptance.json'));
const flatIndex = await readFile(archive + '/cine.rki');
const proof = await readFile(archive + '/proof/0.rkp');
const full = await readFile('fixtures/generated/cine-350.dcm');
const sha256 = createHash('sha256').update(full).digest('hex');
assert.equal(sha256, index.source.content_sha256);
const etag = '"synthetic-cine-v1"';
const requestDelayMs = 24;
const bytesPerSecond = 10 * 1024 * 1024;
const repeats = Number(process.env.RAYKIT_REMOTE_REPEATS ?? 8);
assert(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 40);
let transfers = [];
const pins = JSON.stringify({ rootSha256: index.root_sha256, revision: index.revision, flatSha256: flat.index.sha256 });
const server = await serve('examples/web/dist', (req, res, next) => {
  let data;
  let status = 200;
  const headers = { 'cache-control': 'no-store' };
  if (req.url === '/proof/0.rkp') data = proof;
  else if (req.url === '/cine.rki') data = flatIndex;
  else if (req.url === '/pin') data = Buffer.from(pins);
  else if (req.url === '/cine.dcm') {
    data = full;
    if (req.headers.range) {
      assert.equal(req.headers['if-match'], etag);
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      status = 206;
      data = full.subarray(Number(a), Number(b) + 1);
      headers['Content-Range'] = 'bytes ' + a + '-' + b + '/' + full.length;
      headers.ETag = etag;
    }
  } else { next(); return; }
  const start = performance.now();
  const expected = data.length;
  const row = { url: req.url, status, bytes: 0, total: expected, ms: null };
  transfers.push(row);
  const chunk = 64 * 1024;
  let offset = 0;
  const write = () => {
    if (res.destroyed || res.writableEnded) return;
    if (!offset) res.writeHead(status, { ...headers, 'content-length': expected });
    const sent = data.subarray(offset, offset + chunk);
    offset += sent.length;
    row.bytes = offset;
    res.write(sent);
    if (offset === expected) { row.ms = performance.now() - start; res.end(); }
    else {
      const due = start + requestDelayMs + offset / bytesPerSecond * 1000;
      setTimeout(write, Math.max(1, due - performance.now()));
    }
  };
  setTimeout(write, requestDelayMs + Math.min(expected, chunk) / bytesPerSecond * 1000);
}, { '/sdk': process.env.RAYKIT_WEB_DIST ?? 'packages/web/dist' });
let browser;
const observations = [];
try {
  browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (let trial = 0; trial < repeats; trial++) {
    for (const mode of (trial % 2 ? ['proof','flat','full'] : ['full','flat','proof'])) {
      const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
      try {
        await page.goto(server.url);
        transfers = [];
        const elapsed = await page.evaluate(async ({ mode, sha256, etag }) => {
          const { RaykitViewport, frameProofHttp, indexedHttp } = await import('/sdk/index.js');
          const div = document.createElement('div');
          Object.assign(div.style, { width: '640px', height: '512px', position: 'relative' });
          document.body.append(div);
          const viewport = new RaykitViewport(div);
          const startPin = performance.now();
          const pin = await fetch('/pin').then(r => r.json());
          const pinMs = performance.now() - startPin;
          const started = performance.now();
          const source = mode === 'proof' ? frameProofHttp('/proof/', pin)
            : mode === 'flat' ? indexedHttp('/cine.dcm', {
                bytes: new Uint8Array(await fetch('/cine.rki').then(r => r.arrayBuffer())), sha256: pin.flatSha256,
              }, { etag })
            : { read: async signal => (await fetch('/cine.dcm', { signal })).blob() };
          const session = await viewport.load(source, { expected_sha256: sha256 });
          const firstOriginalMs = viewport.presented.time - started;
          const original = viewport.presented.source;
          const sample = await viewport.samplePresented(0, 0);
          const stats = await session.stats();
          viewport.dispose();
          return { pinMs, firstOriginalMs, original, sample, stats };
        }, { mode, sha256, etag });
        assert.equal(elapsed.original.content_sha256, sha256);
        assert.equal(elapsed.original.frame, 0);
        assert(elapsed.sample.values.every((n, i) => Math.abs(n - [32,64,63][i]) <= 2));
        // Each application request is complete by the verified draw, except any optional background prefetch.
        const bodies = transfers.filter(row => row.url !== '/pin');
        assert.equal(bodies.length, mode === 'flat' ? 2 : 1);
        observations.push({ mode, trial, ...elapsed, transfers });
      } finally { await page.close(); }
    }
  }
  console.log(JSON.stringify({ chromium: browser.version(), repeats, sha256, requestDelayMs, bytesPerSecond,
    proofBytes: proof.length, flatManifestBytes: flatIndex.length, fullBytes: full.length, observations }, null, 2));
} finally { await browser?.close(); server.close(); }
