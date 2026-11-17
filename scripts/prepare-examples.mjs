import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = spawnSync('cargo', ['run', '--locked', '--release', '-p', 'raykit-core', '--example', 'generate-fixtures', '--', 'fixtures/generated', '--long-cine'], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const flutterAssets = new URL('examples/flutter/assets/raykit/', root);
mkdirSync(flutterAssets, { recursive: true });
for (const file of ['signed12.dcm', 'detail-signed12.dcm', 'cine-350.dcm', 'large-enhanced-ct.dcm', 'large-enhanced-mr.dcm', 'manifest.json']) {
  copyFileSync(new URL(`fixtures/generated/${file}`, root), new URL(file, flutterAssets));
}
