import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifacts, flutter, flutterArchive, root, run, tar, version } from './release-lib.mjs';

const work = resolve(process.argv[2]);
const registry = process.argv.includes('--registry');
const simulator = process.argv.includes('--simulator');
const acceptance = process.argv.includes('--acceptance');
const example = join(root, 'examples/flutter');
const app = join(work, 'examples/flutter');
mkdirSync(app, { recursive: true });
for (const file of ['pubspec.yaml', 'analysis_options.yaml', 'lib', 'test', 'android', 'ios', 'linux', 'macos', 'windows']) {
  cpSync(join(example, file), join(app, file), {
    recursive: true,
    filter: path => !/(?:^|[/\\])(?:ephemeral|Pods|\.symlinks|build|local\.properties|Generated\.xcconfig|flutter_export_environment\.sh)(?:$|[/\\])/.test(path.slice(example.length)),
  });
}
const assets = join(app, 'assets/raykit');
cpSync(join(example, 'assets/raykit'), assets, { recursive: true });
cpSync(join(root, 'benchmarks/evidence/comparison-reference.json'), join(assets, 'comparison-reference.json'));

const manifest = join(app, 'pubspec.yaml');
let pubspec = readFileSync(manifest, 'utf8').replace('dev_dependencies:\n', 'dev_dependencies:\n  crypto: ^3.0.6\n');
if (registry) {
  pubspec = pubspec.replace('raykit:\n    path: ../../packages/flutter', 'raykit: ' + version);
} else {
  const packages = join(work, 'packages');
  mkdirSync(packages);
  run(tar, ['-xzf', join(artifacts, flutterArchive)], { cwd: packages });
  pubspec = pubspec.replace('path: ../../packages/flutter', 'path: ../../packages/raykit');
}
if (simulator) cpSync(join(root, 'tests/flutter-consumer/ios_smoke.dart'), join(app, 'lib/ios_smoke.dart'));
if (acceptance) {
  pubspec = pubspec.replace('dev_dependencies:\n', 'dev_dependencies:\n  ffi: ^2.1.5\n');
  for (const file of ['native_workflow_test.dart', 'imaging_quality_test.dart']) {
    cpSync(join(root, 'packages/flutter/test', file), join(app, 'test', file));
  }
  for (const file of ['fixtures/generated', 'benchmarks/evidence/imaging-reference.json', 'tests/measurement-cases.json']) {
    mkdirSync(join(work, file, '..'), { recursive: true });
    cpSync(join(root, file), join(work, file), { recursive: true });
  }
}
writeFileSync(manifest, pubspec);
for (const file of ['acceptance.dart', 'package_test.dart']) {
  cpSync(join(root, 'tests/flutter-consumer', file), join(app, 'test', file));
}
run(flutter, ['pub', 'get'], { cwd: app });
if (registry) {
  const lock = readFileSync(join(app, 'pubspec.lock'), 'utf8');
  const entry = lock.match(/^  raykit:\n(?:    .*\n)+/m)?.[0];
  if (!entry?.includes('source: hosted\n') || !entry.includes(`version: "${version}"\n`) ||
    !entry.includes('url: "https://pub.dev"\n')) {
    throw new Error('The consumer did not resolve the exact raykit version from pub.dev');
  }
}
console.log(app);
