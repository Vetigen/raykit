import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNotices } from './notices.mjs';
import {
  artifacts, flutterArchive, nodeArchive, npm, python, pythonSdist, releaseTargets,
  requireFresh, root, run, stageRust, version,
} from './release-lib.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--web', '--flutter', '--python-source'].includes(arg))) {
  throw new Error('Expected --web, --flutter or --python-source');
}
const staging = mkdtempSync(join(tmpdir(), 'raykit-package-'));

try {
  if (!args.length || args.includes('--web')) {
    requireFresh(artifacts, [`raykit-web-${version}.tgz`, `raykit-web-component-${version}.tgz`, nodeArchive]);
    run(npm, ['run', 'build:web']);
    run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifacts, './packages/web', './packages/web-component']);
    const node = join(staging, 'node');
    mkdirSync(node);
    for (const file of ['index.js', 'index.d.ts', 'package.json', 'README.md']) {
      cpSync(join(root, 'packages/node', file), join(node, file));
    }
    cpSync(join(root, 'LICENSE'), join(node, 'LICENSE'));
    run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifacts], { cwd: node });
  }
  if (!args.length || args.includes('--flutter')) {
    requireFresh(artifacts, [flutterArchive]);
    const flutter = join(staging, 'raykit');
    mkdirSync(flutter);
    for (const name of ['lib', 'hook', 'shaders', 'pubspec.yaml', 'README.md', 'CHANGELOG.md']) {
      cpSync(join(root, 'packages/flutter', name), join(flutter, name), { recursive: true });
    }
    cpSync(join(root, 'LICENSE'), join(flutter, 'LICENSE'));
    stageRust(join(flutter, 'native'));
    writeNotices(join(flutter, 'notices'), 'raykit-ffi', [
      ...releaseTargets.targets.map(t => t.rust), 'aarch64-linux-android', 'aarch64-apple-ios', 'aarch64-apple-ios-sim',
    ]);
    run('tar', ['-czf', join(artifacts, flutterArchive), 'raykit'], { cwd: staging });
  }
  if (args.includes('--python-source')) {
    requireFresh(artifacts, [pythonSdist]);
    const source = join(staging, 'python');
    cpSync(join(root, 'packages/python'), source, { recursive: true });
    cpSync(join(root, 'LICENSE'), join(source, 'LICENSE'));
    stageRust(join(source, 'native'));
    writeNotices(join(source, 'raykit_dicom/notices'), 'raykit-ffi', releaseTargets.targets.map(t => t.rust));
    run(python, ['-m', 'build', '--sdist', '--outdir', artifacts], { cwd: source });
  }
} finally {
  rmSync(staging, { force: true, recursive: true });
}
