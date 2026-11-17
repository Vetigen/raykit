import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifacts, flutter, flutterArchive, root, run, version } from './release-lib.mjs';

const work = resolve(process.argv[2]);
const registry = process.argv.includes('--registry');
const integration = process.argv.includes('--integration');
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
  run('tar', ['-xzf', join(artifacts, flutterArchive)], { cwd: packages });
  pubspec = pubspec.replace('path: ../../packages/flutter', 'path: ../../packages/raykit');
}
if (integration) {
  pubspec = pubspec.replace('dev_dependencies:\n', 'dev_dependencies:\n  integration_test:\n    sdk: flutter\n');
  mkdirSync(join(app, 'integration_test'));
  cpSync(join(root, 'tests/flutter-consumer/integration_test.dart'), join(app, 'integration_test/release_test.dart'));
}
writeFileSync(manifest, pubspec);
for (const file of ['acceptance.dart', 'package_test.dart']) {
  cpSync(join(root, 'tests/flutter-consumer', file), join(app, 'test', file));
}
run(flutter, ['pub', 'get'], { cwd: app });
console.log(app);
