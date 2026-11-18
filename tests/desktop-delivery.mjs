import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { artifacts, desktopArchive, nativeTarget, root, run, tar } from '../scripts/release-lib.mjs';

const target = nativeTarget();
const name = desktopArchive(target.desktop);
const evidence = JSON.parse(readFileSync(join(root, 'benchmarks/evidence/delivery-native.json')));
const reference = JSON.parse(readFileSync(join(root, 'benchmarks/evidence/comparison-reference.json')));
const work = mkdtempSync(join(tmpdir(), 'raykit-desktop-consumer-'));
try {
  run(tar, ['-xzf', join(artifacts, name)], { cwd: work });
  const binary = join(work, name.replace(/\.tar\.gz$/, ''), {
    linux: 'raykit_example', darwin: 'raykit_example.app/Contents/MacOS/raykit_example', win32: 'raykit_example.exe',
  }[target.os]);
  const measurement = join(work, 'measurement.json');
  const output = join(work, 'result.json');
  const env = { ...process.env, RAYKIT_VERIFY_OUTPUT: output };
  const args = ['--verify', join(root, 'fixtures/generated/comparison-ct.dcm'), String(reference.frame), ...reference.pixel.map(String), measurement];
  const launch = () => spawnSync(binary, args, { cwd: dirname(binary), env, encoding: 'utf8', timeout: 60_000 });
  writeFileSync(measurement, JSON.stringify(evidence.record));
  const result = launch();
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? '');
  const actual = JSON.parse(readFileSync(output));
  assert.deepEqual(actual.sample, evidence.sample);
  assert.deepEqual(actual.measurement, evidence.record);
  rmSync(output);
  writeFileSync(measurement, JSON.stringify({ ...evidence.record,
    values: [{ ...evidence.record.values[0], value: 8 }] }));
  const rejected = launch();
  assert.equal(rejected.status, 1, rejected.error?.message ?? rejected.stderr ?? '');
  assert.ok(!existsSync(output));
  console.log(JSON.stringify({ target: target.desktop, archive: name, runtime: actual, tamper_rejected: true }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
