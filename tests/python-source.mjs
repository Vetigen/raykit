import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifacts, python, pythonSdist, root, run, version } from '../scripts/release-lib.mjs';

const work = mkdtempSync(join(tmpdir(), 'raykit-pip-source-'));
try {
  run(python, ['-m', 'venv', 'venv'], { cwd: work });
  const interpreter = join(work, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const file = join(artifacts, pythonSdist);
  run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir',
    '--report', 'install.json', '--only-binary=numpy',
    ...(process.argv.includes('--published')
      ? ['--index-url', 'https://pypi.org/simple/', '--no-binary=raykit-dicom', 'raykit-dicom==' + version] : [file])], { cwd: work });
  const install = JSON.parse(readFileSync(join(work, 'install.json'))).install.find(item => item.metadata.name === 'raykit-dicom');
  assert.equal(install.download_info.archive_info.hashes.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
  assert.equal(run(interpreter, ['-c', "from importlib.metadata import version; print(version('raykit-dicom'))"],
    { cwd: work, capture: true }).trim(), version);
  run(interpreter, [
    join(root, 'tests/python-delivery.py'), join(root, 'fixtures/generated/comparison-ct.dcm'),
    join(root, 'benchmarks/evidence/comparison-reference.json'), join(root, 'benchmarks/evidence/delivery-native.json'),
    join(root, 'fixtures/generated/large-enhanced-ct.dcm'),
  ], { cwd: work });
} finally {
  rmSync(work, { recursive: true, force: true });
}
