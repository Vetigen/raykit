import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
  '.dcm': 'application/dicom', '.jpg': 'image/jpeg' };

export async function serve(directory, middleware) {
  const root = resolve(directory);
  const files = async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1/').pathname);
      const path = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      createReadStream(path).pipe(res);
    } catch { res.writeHead(404).end(); }
  };
  const server = createServer((req, res) => middleware ? middleware(req, res, () => void files(req, res)) : void files(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
