import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const cargo = args => execFileSync('cargo', args, { cwd, encoding: 'utf8' });

/** Inventory only reachable, non-dev Cargo dependencies for the packaged entry point. */
export function writeNotices(directory, crate, target) {
  const names = Array.isArray(target) ? target : [target];
  const trees = names.flatMap(platform => cargo(['tree', '--locked', ...(platform ? ['--target', platform] : []), '-p', crate, '-e', 'normal,build', '--prefix', 'none', '--format', '{p}']).split('\n'));
  const versions = new Set(trees.flatMap(line => {
    const match = /^([^ ]+) v([^ ]+)/.exec(line);
    return match ? [`${match[1]}@${match[2]}`] : [];
  }));
  const metadata = JSON.parse(cargo(['metadata', '--locked', '--format-version', '1', ...(names.length === 1 && names[0] ? ['--filter-platform', names[0]] : [])]));
  const crates = metadata.packages.filter(p => p.source?.startsWith('registry+') && versions.has(`${p.name}@${p.version}`))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  mkdirSync(directory, { recursive: true });
  const inventory = crates.map(p => {
    const source = dirname(p.manifest_path);
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
    'Where upstream crates include license or copyright files, copies accompany this inventory.\n' +
    'The RayKit project license is pending. Benchmark libraries are outside these packages.\n');
}
