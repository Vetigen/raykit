import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export class RaykitError extends Error {
  constructor(code, detail) {
    super(detail ? code + ': ' + detail : code);
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

export async function open(path, options = {}) {
  let binding;
  try { binding = require('./native/raykit.node'); }
  catch { throw new RaykitError('unsupported', 'Native addon is unavailable for this Node.js platform'); }
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
