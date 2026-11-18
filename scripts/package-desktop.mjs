import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeNotices } from './notices.mjs';
import { artifacts, desktopArchive, flutter, nativeTarget, requireFresh, root, run, tar } from './release-lib.mjs';

const target = nativeTarget();
if (!target.desktop) throw new Error('No standalone desktop archive for ' + target.rust);
const [host, arch] = target.desktop.split('-');
const app = resolve(process.env.RAYKIT_FLUTTER_APP ?? join(root, 'examples/flutter'));
const bundle = {
  linux: 'build/linux/' + arch + '/release/bundle',
  windows: 'build/windows/' + arch + '/runner/Release',
  macos: 'build/macos/Build/Products/Release/raykit_example.app',
}[host];
const archive = desktopArchive(target.desktop);
const name = archive.replace(/\.tar\.gz$/, '');

requireFresh(artifacts, [archive]);
run(flutter, ['build', host, '--release'], { cwd: app });
const stage = mkdtempSync(join(tmpdir(), 'raykit-desktop-'));
try {
  const out = join(stage, name);
  mkdirSync(out);
  cpSync(join(app, bundle), host === 'macos' ? join(out, 'raykit_example.app') : out, { recursive: true, verbatimSymlinks: true });
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
  writeNotices(join(out, 'notices'), 'raykit-ffi', target.rust);
  run(tar, ['-czf', join(artifacts, archive), name], { cwd: stage });
} finally { rmSync(stage, { recursive: true, force: true }); }
