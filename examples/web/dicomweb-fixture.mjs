import { readFile } from 'node:fs/promises';

const fixtures = new URL('../../fixtures/generated/', import.meta.url);
const study = '2.25.100';
const series = '2.25.901';
const sop = '1.2.840.10008.5.1.4.1.1.2';
const ids = ['2.25.913', '2.25.911', '2.25.912'];

/** Local, read-only service for the generated phantom. */
export function syntheticDicomweb(req, res, next) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost/');
  const path = `/dicomweb/studies/${study}/series/${series}/instances`;
  if (!pathname.startsWith('/dicomweb/')) { next(); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (pathname === path) {
    const from = Number(searchParams.get('offset') ?? 0), limit = Number(searchParams.get('limit') ?? ids.length);
    const attrib = value => ({ vr: 'UI', Value: [value] });
    const rows = ids.slice(from, from + limit).map(id => ({ '00080016': attrib(sop), '00080018': attrib(id), '0020000D': attrib(study), '0020000E': attrib(series) }));
    res.writeHead(200, { 'content-type': 'application/dicom+json', 'cache-control': 'no-store' }).end(JSON.stringify(rows));
    return;
  }
  const id = pathname.slice(path.length + 1);
  if (!pathname.startsWith(`${path}/`) || !ids.includes(id)) { res.writeHead(404).end(); return; }
  void readFile(new URL(`classic-ct-${Number(id.slice(-3)) - 911}.dcm`, fixtures)).then(bytes => {
    const boundary = 'raykit-synthetic-wado';
    res.writeHead(200, { 'content-type': `multipart/related; type="application/dicom"; boundary="${boundary}"`, 'cache-control': 'no-store' });
    res.write(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
    res.write(bytes); res.end(`\r\n--${boundary}--\r\n`);
  }, () => res.writeHead(404).end());
}
