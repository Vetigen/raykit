import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Serve the exact packed files with npm's normal name, version and optional dependency resolution.
export async function installFromTarballs(work, name, tarballs) {
  const packages = new Map();
  const files = new Map();
  for (const tarball of tarballs) {
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    packages.set(manifest.name, { manifest, filename: basename(tarball) });
    files.set(basename(tarball), readFileSync(tarball));
  }
  const server = createServer((req, response) => {
    const path = decodeURIComponent(req.url).slice(1);
    const file = files.get(path);
    const entry = packages.get(path);
    if (file) { response.end(file); return; }
    if (!entry) { response.writeHead(404).end(); return; }
    const bytes = files.get(entry.filename);
    const manifest = { ...entry.manifest, dist: {
      tarball: `${url}/${entry.filename}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    } };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: path, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: manifest } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict',
      '--registry', url, '--cache', join(work, 'npm-cache'), name];
    const command = process.platform === 'win32' ? process.execPath : 'npm';
    if (process.platform === 'win32') args.unshift(join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
    await exec(command, args, { cwd: work });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
