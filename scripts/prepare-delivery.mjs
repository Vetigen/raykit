import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'fixtures/generated');
const identities = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'raykit-demo-'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed');
  return result.stdout;
}

try {
  run('cargo', ['build', '--release', '--locked', '-p', 'raykit-cli']);
  const { target_directory } = JSON.parse(run('cargo', ['metadata', '--no-deps', '--locked', '--format-version=1']));
  const cli = join(target_directory, 'release', process.platform === 'win32' ? 'raykit.exe' : 'raykit');
  const cine = 'cine-350.dcm';
  const radiograph = 'detail-signed12.dcm';
  const proof = JSON.parse(run(cli, ['frame-index', join(fixtures, cine), '--proof-directory', join(stage, 'proof'),
    '--revision', 'synthetic-cine-v1', '--sha256', identities[cine].sha256]));
  const tiles = JSON.parse(run(cli, ['tiles', join(fixtures, radiograph), '--frame', '0', '--directory', join(stage, 'tiles'),
    '--revision', 'synthetic-radiograph-v1', '--sha256', identities[radiograph].sha256]));
  for (const name of ['proof', 'tiles']) cpSync(join(stage, name), join(fixtures, 'delivery', name), { recursive: true });
  writeFileSync(join(fixtures, 'delivery', 'pins.json'), JSON.stringify({ proof, tiles }, null, 2) + '\n');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
