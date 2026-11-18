import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export class RaykitError extends Error {
  constructor(code, detail, options) {
    super(detail ? code + ': ' + detail : code, options);
    this.name = 'RaykitError';
    this.code = code;
    this.detail = detail;
  }
}

function failure(error) {
  let value;
  try { value = JSON.parse(error.message); } catch { /* Native runtime error */ }
  return value?.code ? new RaykitError(value.code, value.detail) : new RaykitError('internal', 'Native operation failed');
}

async function call(operation) {
  try { return await operation(); } catch (error) { throw failure(error); }
}

let nativeBinding;

function loadBinding() {
  const { platform, arch } = process;
  const libc = platform !== 'linux' ? ''
    : (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl');
  const target = `@vetigen/raykit-node-${platform}-${arch}${platform === 'win32' ? '-msvc' : libc}`;
  if (!['x64', 'arm64'].includes(arch) || !['linux', 'darwin', 'win32'].includes(platform) || libc === '-musl') {
    throw new RaykitError('unsupported', `No RayKit native addon for ${platform}/${arch}${libc}`);
  }
  try { return require(target); }
  catch (error) {
    throw new RaykitError('unsupported', `Cannot load ${target}. Install @vetigen/raykit-node with optional dependencies enabled.`,
      { cause: error });
  }
}

export async function open(path, options = {}) {
  const binding = nativeBinding ??= loadBinding();
  const file = path instanceof URL ? fileURLToPath(path) : resolve(path);
  const native = await call(() => binding.openNative(file, JSON.stringify(options)));
  return new RaykitSession(native);
}

export class RaykitSession {
  #native;
  #tail = Promise.resolve();
  #closing;
  #pending = 0;

  constructor(native) {
    this.#native = native;
    this.inspection = Object.freeze(JSON.parse(native.metadata));
  }

  request(command) {
    if (this.#closing) return Promise.reject(new RaykitError('closed'));
    if (this.#pending >= 64) return Promise.reject(new RaykitError('limit', 'Pending native requests'));
    const payload = JSON.stringify(command);
    this.#pending++;
    const work = this.#tail.then(async () => {
      const { metadata, bytes } = await call(() => this.#native.request(payload));
      return { metadata: JSON.parse(metadata), bytes };
    }).finally(() => { this.#pending--; });
    this.#tail = work.then(() => {}, () => {});
    return work;
  }

  async frameInfo(index) { return (await this.request({ op: 'frame_info', index })).metadata; }
  async sample(index, x, y) { return (await this.request({ op: 'sample_at', index, x, y })).metadata; }
  async preview(index, options = {}) {
    const { metadata, bytes } = await this.request({ op: 'frame', index, output: 'rgba', options });
    return { ...metadata, pixels: bytes };
  }
  async frameIndex() {
    const { metadata, bytes } = await this.request({ op: 'create_frame_index' });
    return { ...metadata, bytes };
  }
  async frameProof(index, revision) {
    const { metadata, bytes } = await this.request({ op: 'frame_proof', index, revision });
    return { ...metadata, bytes };
  }
  async verifyMeasurement(record) {
    return (await this.request({ op: 'verify', record })).metadata;
  }
  close() {
    return this.#closing ??= this.#tail.then(() => call(() => this.#native.close())).then(() => {});
  }
  [Symbol.asyncDispose]() { return this.close(); }
}

export async function inspect(path, options) {
  const session = await open(path, options);
  try { return session.inspection; } finally { await session.close(); }
}
