import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const cargo = args => execFileSync('cargo', args, { cwd, encoding: 'utf8' });
const upstreamDocuments = new Map([
  ['dicom-core@0.10.0', 'dicom-rs-0.10.0'],
  ['dicom-dictionary-std@0.10.0', 'dicom-rs-0.10.0'],
  ['oxiarc-jpeg@0.4.2', 'oxiarc-0.4.2'],
  ['pure_jpegls@2.1.0', 'pure_jpegls-2.1.0'],
]);

/** Inventory only reachable, non-dev Cargo dependencies for the packaged entry point. */
export function writeNotices(directory, crate, target, noDefaults = false) {
  const names = Array.isArray(target) ? target : [target];
  const trees = names.flatMap(platform => cargo(['tree', '--locked', ...(platform ? ['--target', platform] : []), '-p', crate,
    ...(noDefaults ? ['--no-default-features'] : []), '-e', 'normal,build', '--prefix', 'none', '--format', '{p}']).split('\n'));
  const versions = new Set(trees.flatMap(line => {
    const match = /^([^ ]+) v([^ ]+)/.exec(line);
    return match ? [`${match[1]}@${match[2]}`] : [];
  }));
  const metadata = JSON.parse(cargo(['metadata', '--locked', '--format-version', '1', ...(names.length === 1 && names[0] ? ['--filter-platform', names[0]] : [])]));
  const crates = metadata.packages.filter(p => p.source?.startsWith('registry+') && versions.has(`${p.name}@${p.version}`))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  // The caller supplies a generated notices directory dedicated to this build.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const inventory = crates.map(p => {
    const supplement = upstreamDocuments.get(`${p.name}@${p.version}`);
    const source = supplement ? join(cwd, 'third-party/licenses', supplement) : dirname(p.manifest_path);
    const name = `${p.name}-${p.version}`;
    const documents = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && /^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT|UNLICENSE)([.\-_].*)?$/i.test(entry.name))
      .map(entry => entry.name).sort();
    if (documents.length) mkdirSync(join(directory, name), { recursive: true });
    for (const file of documents) copyFileSync(join(source, file), join(directory, name, file));
    return { name: p.name, version: p.version, license: p.license, source: p.repository,
      documents: documents.map(file => `${name}/${file}`) };
  });
  writeFileSync(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  writeFileSync(join(directory, 'README.txt'),
    'Third-party dependency inventory. The SPDX expressions are those declared by each dependency.\n' +
    'The inventory includes license and copyright files from published crates and the pinned upstream repositories.\n' +
    'The RayKit project uses Apache-2.0. Benchmark libraries are outside these packages.\n');
}
