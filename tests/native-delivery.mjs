import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'raykit-delivery-'));
const artifacts = join(root, 'artifacts');
const fixtures = join(root, 'fixtures/generated');
const path = name => join(fixtures, name + '.dcm');
const refFile = join(root, 'benchmarks/evidence/comparison-reference.json');
const ref = JSON.parse(readFileSync(refFile));
const platform = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1].trim();
const cliName = 'raykit-0.1.0-' + platform;
const output = process.env.RAYKIT_NATIVE_EVIDENCE_DIR ? resolve(process.env.RAYKIT_NATIVE_EVIDENCE_DIR) : null;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, encoding: 'utf8' });

try {
  const node = join(artifacts, 'raykit-node-0.1.0.tgz');
  const cliArchive = join(artifacts, cliName + '.tar.gz');
  const wheel = join(artifacts, process.env.RAYKIT_WHEEL ?? readdirSync(artifacts).find(name => /^raykit-0.1.0-.*.whl$/.test(name)));
  for (const file of [node, cliArchive, wheel]) assert(existsSync(file), file);
  run('tar', ['-xzf', cliArchive]);
  writeFileSync(join(work, 'package.json'), '{"type":"module","private":true}');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', node]);
  const cli = join(work, cliName, process.platform === 'win32' ? 'raykit.exe' : 'raykit');
  const json = args => JSON.parse(run(cli, args));
  const [x, y] = ref.pixel;
  const cmd = ['sample', path('comparison-ct'), '--sha256', ref.sha256, '--frame', String(ref.frame), '--x', String(x), '--y', String(y)];
  const sample = json(cmd);
  assert.equal(sample.sample.stored, ref.stored);
  assert.equal(sample.sample.modality, ref.modality);
  assert.equal(sample.modality_unit, ref.unit);
  sample.patient.forEach((coord, i) => assert(Math.abs(coord - ref.patient[i]) < 1e-9));
  const inspected = json(['inspect', path('comparison-ct'), '--frame', '150']);
  assert.deepEqual(inspected.frame.views.map(view => view.label), ref.labels);
  const render = ['render', path('comparison-ct'), '--frame', '150', '--window-index', '1', '--out', 'ct.png'];
  json(render);
  const png = readFileSync(join(work, 'ct.png'));
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.throws(() => json(render), error => error.status === 4);
  assert.equal(digest(readFileSync(join(work, 'ct.png'))), digest(png));

  const module = await import(join(work, 'node_modules/@raykit/node/index.js'));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const session = await module.open(path('comparison-ct'), { expected_sha256: ref.sha256 });
  let record;
  try {
    assert.deepEqual(await session.sample(ref.frame, x, y), sample);
    for (const index of [0, 1]) {
      const { pixels } = await session.preview(ref.frame, { voi: { kind: 'window', index } });
      assert.equal(digest(pixels), ref.rgba_sha256[index]);
    }
    record = (await session.request({ op: 'measure', index: ref.frame, request: {
      id: 'comparison-ruler', method: 'raykit:length', version: 1, points: [{ x, y }, { x: x + 10, y }],
    } })).metadata;
    assert.deepEqual(await session.verifyMeasurement(record), record);
    assert(ticks > 0, 'Native work must yield the Node.js event loop');
    await assert.rejects(session.verifyMeasurement({ ...record, values: [{ ...record.values[0], value: 8 }] }),
      error => error.code === 'integrity');
  } finally { clearInterval(timer); await session.close(); }
  await assert.rejects(session.sample(ref.frame, x, y), error => error.code === 'closed');
  writeFileSync(join(work, 'measurement.json'), JSON.stringify(record));
  assert.deepEqual(json(['measurements', 'verify', path('comparison-ct'), 'measurement.json']), record);

  const expectedRevision = 'native-browser-evidence-v1';
  const index = json(['frame-index', path('cine-350'), '--out', 'cine.rki']);
  assert.equal(index.index.sha256, digest(readFileSync(join(work, 'cine.rki'))));
  const proof = json(['frame-index', path('cine-350'), '--proof-frame', '0', '--revision', expectedRevision, '--out', '0.rkp']);
  const cine = await module.open(path('cine-350'));
  let nodeProof;
  try {
    nodeProof = await cine.frameProof(175, expectedRevision);
    assert.equal(nodeProof.root_sha256, proof.index.root_sha256);
    writeFileSync(join(work, '175.rkp'), nodeProof.bytes);
    const first = await cine.frameProof(0, expectedRevision);
    assert.deepEqual(first.bytes, readFileSync(join(work, '0.rkp')));
  } finally { await cine.close(); }
  const tile = json(['tiles', path('detail-signed12'), '--frame', '0', '--directory', 'tiles', '--revision', 'native-detail-v1']);
  const evidence = { node: process.version, platform, ticks, sample, record, index, proof, nodeProofBytes: nodeProof.bytes.length,
    artifacts: Object.fromEntries([cliArchive, node, wheel].map(file => [file.split(/[\\/]/).at(-1), digest(readFileSync(file))])),
    tile, png_sha256: digest(png) };
  const prepRepeats = Number(process.env.RAYKIT_PREP_REPEATS ?? 0);
  assert(Number.isSafeInteger(prepRepeats) && prepRepeats >= 0 && prepRepeats <= 20);
  if (prepRepeats) {
    const procedures = {
      flat: i => ['frame-index', path('cine-350'), '--out', `flat-${i}.rki`],
      singleProof: i => ['frame-index', path('cine-350'), '--proof-frame', '0', '--revision', expectedRevision, '--out', `single-${i}.rkp`],
      proofDirectory: i => ['frame-index', path('cine-350'), '--proof-directory', `proofs-${i}`, '--revision', expectedRevision],
      tiles: i => ['tiles', path('detail-signed12'), '--frame', '0', '--directory', `tiles-${i}`, '--revision', 'native-detail-v1'],
    };
    evidence.preparation = {};
    for (const [name, args] of Object.entries(procedures)) {
      evidence.preparation[name] = Array.from({ length: prepRepeats }, (_, i) => {
        const start = performance.now();
        const prepared = json(args(i));
        return { ms: performance.now() - start, bytes: prepared.bytes };
      });
    }
  }
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence));
  const wheelTest = process.env.RAYKIT_UV_OFFLINE === '0' ? [] : ['--offline'];
  evidence.python = JSON.parse(run('uv', ['run', '--no-project', ...wheelTest, '--with', wheel, 'python',
    join(root, 'tests/python-delivery.py'), path('comparison-ct'), refFile, 'evidence.json', path('large-enhanced-ct')]));
  if (output) {
    mkdirSync(output, { recursive: true });
    mkdirSync(join(output, 'proof'), { recursive: true });
    for (const name of ['0.rkp', '175.rkp']) cpSync(join(work, name), join(output, 'proof', name));
    cpSync(join(work, 'cine.rki'), join(output, 'cine.rki'));
    cpSync(join(work, 'tiles'), join(output, 'tiles'), { recursive: true });
    writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
