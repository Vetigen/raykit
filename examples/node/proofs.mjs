import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { open } from '@vetigen/raykit-node';

const [source, directory, revision, expectedSha256] = process.argv.slice(2);
if (!source || !directory || !revision || !expectedSha256) {
  console.error('Usage: node proofs.mjs SOURCE NEW_DIRECTORY REVISION SOURCE_SHA256');
  process.exitCode = 2;
} else {
  const session = await open(source, { expected_sha256: expectedSha256 });
  try {
    const first = await session.frameProof(0, revision);
    await mkdir(directory);
    for (let index = 0; index < first.frames; index++) {
      const { bytes } = index === 0 ? first : await session.frameProof(index, revision);
      await writeFile(join(directory, index + '.rkp'), bytes, { flag: 'wx' });
    }
    const { bytes: _, ...pin } = first;
    console.log(JSON.stringify(pin));
  } finally { await session.close(); }
}
