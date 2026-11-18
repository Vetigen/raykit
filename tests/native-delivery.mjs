import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  addonArchive, artifacts, cArchive, cliArchive, nativeTarget, nodeArchive, npm, npmPackageName, npmRegistryArgs,
  python, root, run as runTool, tar, version, wheelArchive,
} from '../scripts/release-lib.mjs';
import { installFromTarballs } from './npm-registry.mjs';

const fixtures = join(root, 'fixtures/generated');
const path = name => join(fixtures, name + '.dcm');
const refFile = join(root, 'benchmarks/evidence/comparison-reference.json');
const ref = JSON.parse(readFileSync(refFile));
const target = nativeTarget();
const platform = target.rust;
const cliName = cliArchive(platform).replace(/\.tar\.gz$/, '');
const output = process.env.RAYKIT_NATIVE_EVIDENCE_DIR ? resolve(process.env.RAYKIT_NATIVE_EVIDENCE_DIR) : null;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path('comparison-ct');
const published = process.argv.includes('--published');

async function verifyDelivery(work) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, encoding: 'utf8' });
  const node = join(artifacts, nodeArchive);
  const addon = join(artifacts, addonArchive(target));
  const nodePackage = npmPackageName('node');
  const addonPackage = npmPackageName(target.nodePackage);
  const cliFile = join(artifacts, cliArchive(platform));
  const sdkFile = join(artifacts, cArchive(platform));
  const wheel = join(artifacts, wheelArchive(target));
  for (const file of [node, addon, cliFile, sdkFile, wheel]) assert(existsSync(file), file);
  for (const file of [cliFile, sdkFile]) run(tar, ['-xzf', file]);
  writeFileSync(join(work, 'package.json'), '{"type":"module","private":true}');
  if (published) runTool(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...npmRegistryArgs(),
    '--cache', join(work, 'npm-cache'), nodePackage + '@' + version], { cwd: work });
  else await installFromTarballs(work, nodePackage, [node, addon]);
  const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
  for (const [pkg, file] of [[nodePackage, node], [addonPackage, addon]]) {
    const installed = lock.packages['node_modules/' + pkg];
    assert.equal(installed.version, version);
    assert.equal(installed.integrity, 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64'));
  }
  const cli = join(work, cliName, process.platform === 'win32' ? 'raykit.exe' : 'raykit');
  assert.equal(run(cli, ['--version']).trim(), 'raykit ' + version);
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

  writeFileSync(join(work, 'binding.mjs'), `export * from '${nodePackage}';\n`);
  const module = await import(pathToFileURL(join(work, 'binding.mjs')));
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
    assert.deepEqual(record.values, [{ name: 'length', value: 7, unit: 'millimeter' }]);
    assert.deepEqual(await session.verifyMeasurement(record), record);
    assert(ticks > 0, 'Native work must yield the Node.js event loop');
    await assert.rejects(session.verifyMeasurement({ ...record, values: [{ ...record.values[0], value: 8 }] }),
      error => error.code === 'integrity');
  } finally { clearInterval(timer); await session.close(); }
  await assert.rejects(session.sample(ref.frame, x, y), error => error.code === 'closed');
  writeFileSync(join(work, 'measurement.json'), JSON.stringify(record));
  assert.deepEqual(json(['measurements', 'verify', path('comparison-ct'), 'measurement.json']), record);
  const tampered = { ...record, values: [{ ...record.values[0], value: 8 }] };
  writeFileSync(join(work, 'tampered.json'), JSON.stringify(tampered));
  assert.throws(() => json(['measurements', 'verify', source, 'tampered.json']), error => error.status === 3);

  const sdk = join(work, cArchive(platform).replace(/\.tar\.gz$/, ''));
  cpSync(join(root, 'tests/c-sdk-consumer'), join(work, 'c'), { recursive: true });
  const isWindows = process.platform === 'win32';
  run('cmake', ['-S', 'c', '-B', 'c-build', '-DRAYKIT_SDK=' + sdk, '-DCMAKE_BUILD_TYPE=Release',
    ...(isWindows ? ['-A', target.arch === 'arm64' ? 'ARM64' : 'x64'] : [])]);
  run('cmake', ['--build', 'c-build', '--config', 'Release']);
  const c = join(work, 'c-build', isWindows ? 'Release/raykit_c.exe' : 'raykit_c');
  const settings = JSON.stringify({ expected_sha256: ref.sha256 });
  const request = (command, ...args) => JSON.parse(run(c, [source, settings, JSON.stringify(command), ...args]));
  assert.deepEqual(request({ op: 'sample_at', index: ref.frame, x, y }), sample);
  assert.deepEqual(request({ op: 'verify', record }), record);
  assert.throws(() => request({ op: 'verify', record: tampered }), error =>
    error.status === 1 && JSON.parse(error.stdout).code === 'integrity');
  for (const index of [0, 1]) {
    request({ op: 'frame', index: ref.frame, output: 'rgba', options: { voi: { kind: 'window', index } } }, 'view.rgba');
    assert.equal(digest(readFileSync(join(work, 'view.rgba'))), ref.rgba_sha256[index]);
  }

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
  const evidence = { version, node: process.version, platform, ticks, sample, record, rgba_sha256: ref.rgba_sha256,
    c_abi: 1, tamper_rejected: true, index, proof, nodeProofBytes: nodeProof.bytes.length,
    artifacts: Object.fromEntries([cliFile, sdkFile, node, addon, wheel].map(file => [file.split(/[\\/]/).at(-1), digest(readFileSync(file))])),
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
  run(python, ['-m', 'venv', 'python']);
  const interpreter = join(work, 'python', isWindows ? 'Scripts/python.exe' : 'bin/python');
  run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--report', 'python-install.json',
    ...(published ? ['--index-url', 'https://pypi.org/simple/', 'raykit-dicom==' + version] : [wheel])]);
  const install = JSON.parse(readFileSync(join(work, 'python-install.json'))).install.find(item => item.metadata.name === 'raykit-dicom');
  assert.equal(install.download_info.archive_info.hashes.sha256, digest(readFileSync(wheel)));
  evidence.python = JSON.parse(run(interpreter, [join(root, 'tests/python-delivery.py'), source, refFile, 'evidence.json', path('large-enhanced-ct')]));
  if (output) {
    mkdirSync(output, { recursive: true });
    mkdirSync(join(output, 'proof'), { recursive: true });
    for (const name of ['0.rkp', '175.rkp']) cpSync(join(work, name), join(output, 'proof', name));
    cpSync(join(work, 'cine.rki'), join(output, 'cine.rki'));
    cpSync(join(work, 'tiles'), join(output, 'tiles'), { recursive: true });
    writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[2] === '--consumer-process') {
  await verifyDelivery(process.argv[3]);
} else {
  const work = mkdtempSync(join(tmpdir(), 'raykit-delivery-'));
  try {
    // Windows keeps a loaded Node addon open until its process exits.
    runTool(process.execPath, [fileURLToPath(import.meta.url), '--consumer-process', work, ...process.argv.slice(2)]);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}
