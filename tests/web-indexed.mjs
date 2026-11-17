import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from './static-server.mjs';

const engine = process.env.RAYKIT_BROWSER ?? 'chromium';
const cine = await readFile('fixtures/generated/cine-350.dcm');
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const identity = manifest['cine-350.dcm'];
const etag = `"${identity.sha256}"`;
let stopped = 0;
const service = await serve('examples/web/dist', (req, res, next) => {
  const test = req.url.match(/^\/range-case\/(\w+)$/)?.[1];
  if (!test) { next(); return; }
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
  if (!range || req.headers['if-match'] !== etag) { res.writeHead(400).end(); return; }
  const start = Number(range[1]), end = Number(range[2]);
  const headers = { etag, 'content-type': 'application/dicom' };
  if (test === 'changed') { res.writeHead(412, { ...headers, etag: '"changed"' }).end(); return; }
  if (test === 'lost') { res.writeHead(403).end(); return; }
  if (test === 'full' || test === 'wrongfull' || test === 'large') {
    const body = Buffer.from(cine);
    if (test === 'wrongfull') body[8] ^= 1;
    res.writeHead(200, { ...headers, 'content-length': body.length + (test === 'large' ? 1 : 0) }).end(body);
    return;
  }
  const body = Buffer.from(cine.subarray(start, end + 1));
  if (test === 'wrong') body[0] ^= 1;
  const finish = () => res.writeHead(206, {
    ...headers, 'content-length': body.length - (test === 'short' ? 1 : 0),
    'content-range': `bytes ${start}-${end}/${cine.length + (test === 'total' ? 1 : 0)}`,
  }).end(test === 'short' ? body.subarray(1) : body);
  if (test === 'slow' && start > 100_000) {
    const timer = setTimeout(finish, 600);
    res.on('close', () => { if (res.writableEnded) return; clearTimeout(timer); stopped++; });
  } else finish();
}, { '/sdk': 'packages/web/dist', '/fixtures': 'fixtures/generated' });

let browser;
try {
  browser = await { chromium, firefox, webkit }[engine].launch(engine === 'chromium' ? {
    executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  } : {});
  const page = await browser.newPage({ viewport: { width: 960, height: 820 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(service.url);
  const results = await page.evaluate(async ({ manifest, etag }) => {
    const { open, indexedBlob, indexedHttp, RaykitViewport } = await import('/sdk/index.js');
    const size = file => ({ expected_sha256: manifest[file].sha256, expected_size: manifest[file].bytes, revision: 'synthetic-pinned' });
    const blob = file => fetch(`/fixtures/${file}`).then(r => r.blob());
    function vp() {
      const host = document.createElement('div');
      host.style.cssText = 'width:320px;height:240px;position:relative';
      document.body.append(host);
      const viewport = new RaykitViewport(host);
      return { viewport, close() { viewport.dispose(); host.remove(); } };
    }
    const rejected = async operation => {
      try { await operation; return 'success'; } catch (error) { return error.code ?? error.message; }
    };
    const list = {};
    for (const file of ['cine-fragments.dcm', 'cine-extended.dcm', 'cine-350.dcm']) {
      const bytes = await blob(file);
      const options = size(file);
      const full = await open(bytes, options);
      const index = await full.createFrameIndex();
      const view = vp();
      try {
        const session = await view.viewport.load(indexedBlob(bytes, index), options);
        const count = session.inspection.frames;
        const matches = [];
        for (const n of [0, Math.floor(count / 2), count - 1]) {
          if (n !== 0) await view.viewport.showFrame(n, false);
          const drawn = view.viewport.presented;
          const sample = await view.viewport.samplePresented(0, 0);
          const reference = await full.sample(n, 0, 0);
          matches.push(drawn.source.frame === n && drawn.revision === options.revision && drawn.quality === 'original' &&
            drawn.source.content_sha256 === options.expected_sha256 && JSON.stringify(sample) === JSON.stringify(reference));
        }
        const stats = await session.stats();
        list[file] = { matches, reads: stats.range_requests, verification: session.inspection.verification,
          count: session.inspection.frames, bytes: stats.indexed_range_read_bytes, manifestBytes: index.bytes.length };
      } finally { view.close(); full.close(); }
      if (file !== 'cine-350.dcm') continue;
      const wrongManifest = index.bytes.slice(); wrongManifest[0] ^= 1;
      list.wrongManifest = await rejected(open(indexedBlob(bytes, { ...index, bytes: wrongManifest }), options));
      list.wrongSourceHash = await rejected(open(indexedBlob(bytes, index), { ...options, expected_sha256: '0'.repeat(64) }));
      list.oldLength = await rejected(open(indexedBlob(bytes.slice(0, -1), index), options));
      for (const mode of ['wrong', 'changed', 'short', 'total', 'wrongfull', 'large', 'lost', 'full']) {
        const v = vp();
        let shown = 0;
        v.viewport.addEventListener('presented', () => shown++);
        try {
          const code = await rejected(v.viewport.load(indexedHttp(`/range-case/${mode}`, index, { etag }), options));
          const shownFirst = shown;
          const stats = code === 'success' ? await v.viewport.session.stats() : null;
          list[mode] = { code, shown: shownFirst, stats: stats ? {
            range: stats.indexed_range_read_bytes, fallback: stats.indexed_full_fallback_bytes,
            sha: v.viewport.presented.source.content_sha256, revision: v.viewport.presented.revision,
          } : null };
        } finally { v.close(); }
      }

      const left = vp(), right = vp();
      try {
        await left.viewport.load(indexedHttp('/range-case/slow', index, { etag }), options);
        await right.viewport.load(indexedBlob(bytes, index), options);
        const delayed = rejected(left.viewport.scrubFrame(175));
        await new Promise(r => setTimeout(r, 80));
        const other = right.viewport.showFrame(175, false);
        await left.viewport.showFrame(1, false);
        await other;
        list.panel = { cancelled: await delayed, left: left.viewport.presented.source.frame, right: right.viewport.presented.source.frame };
      } finally { left.close(); right.close(); }
    }
    return list;
  }, { manifest, etag });

  for (const file of ['cine-fragments.dcm', 'cine-extended.dcm', 'cine-350.dcm']) {
    assert.deepEqual(results[file].matches, [true, true, true]);
    assert.equal(results[file].verification, 'pinned_frame_index');
    assert.equal(results[file].reads, 3);
    assert.ok(results[file].bytes < manifest[file].bytes);
  }
  for (const code of ['wrongManifest', 'wrongSourceHash', 'oldLength']) assert.equal(results[code], 'integrity');
  for (const test of ['wrong', 'changed', 'short', 'total', 'wrongfull', 'large', 'lost']) {
    assert.equal(results[test].code, test === 'lost' ? 'io' : 'integrity', test);
    assert.equal(results[test].shown, 0, test);
  }
  assert.deepEqual(results.full, { code: 'success', shown: 1, stats: { range: 0, fallback: cine.length, sha: identity.sha256, revision: 'synthetic-pinned' } });
  assert.deepEqual(results.panel, { cancelled: 'cancelled', left: 1, right: 175 });
  assert.equal(stopped, 1);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ version: browser.version(), engine, transportAbort: stopped, ...results }, null, 2));
} finally { await browser?.close(); service.close(); }
