import { RaykitError } from './types.js';
import type { EngineCapabilities, Frame, Inspection, MappedPoint, Measurement, MeasurementRequest,
  OpenOptions, Presentation, Reader, RenderOptions, Sample, ScreenPoint, SegmentationOverlay, SliceImage, SliceRequest, Source, SrOptions,
  Stats, Triple, View, Volume, VolumeCandidates, WindowLevel } from './types.js';
import type { Message, Reply } from './worker.js';

const sourceCeiling = 192 * 1024 * 1024;
const defaultWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'raykit' });
type Task = Message extends infer T ? T extends { id: number } ? Omit<T, 'id'> : never : never;
type AppendOptions = Omit<OpenOptions, 'workerFactory' | 'revision'>;
type Pending = {
  id: number;
  task: Task;
  transfer: Transferable[];
  resolve(reply: Reply): void;
  reject(error: RaykitError): void;
  removeAbort(): void;
};

function failure(raw: string): RaykitError {
  try {
    const error = JSON.parse(raw);
    if (typeof error.code === 'string') return new RaykitError(error.code, error.detail);
  } catch { /* Worker diagnostics do not contain raw input. */ }
  return new RaykitError('internal', 'Malformed worker reply');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RaykitError('cancelled');
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RaykitError('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function collect(stream: ReadableStream<Uint8Array>, ceiling: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  try {
    while (true) {
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) { ended = true; break; }
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > ceiling) throw new RaykitError('limit', 'Source bytes');
      chunks.push(value.slice());
      if (chunks.length > 65_536) throw new RaykitError('limit', 'Source chunk count');
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return data.buffer;
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sourceBuffer(source: Source, ceiling: number, signal: AbortSignal): Promise<ArrayBuffer> {
  checkAbort(signal);
  let bytes: Awaited<ReturnType<Reader['read']>>;
  try {
    bytes = (source instanceof Blob || source instanceof ArrayBuffer || source instanceof Uint8Array)
      ? source : await withAbort(source.read(signal, ceiling), signal);
    if (bytes instanceof ReadableStream) return await collect(bytes, ceiling, signal);
    const count = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    if (count > ceiling) throw new RaykitError('limit', 'Source bytes');
    if (bytes instanceof Blob) return await withAbort(bytes.arrayBuffer(), signal);
    return bytes instanceof ArrayBuffer ? bytes.slice(0) : Uint8Array.from(bytes).buffer;
  } catch (error) {
    if (signal.aborted) throw new RaykitError('cancelled');
    if (error instanceof RaykitError) throw error;
    throw new RaykitError('io', 'Source read failed');
  }
}

class Channel {
  readonly #worker: Worker;
  #closed = false;
  #nextId = 1;
  #queue: Pending[] = [];
  #running?: Pending;

  constructor(factory: () => Worker) {
    this.#worker = factory();
    this.#worker.onmessage = (event: MessageEvent<Reply>) => {
      const pending = this.#running;
      if (!pending || pending.id !== event.data.id) return;
      this.#running = undefined;
      pending.removeAbort();
      if (event.data.error) pending.reject(failure(event.data.error));
      else pending.resolve(event.data);
      this.#pump();
    };
    this.#worker.onerror = event => {
      event.preventDefault();
      this.close(new RaykitError('internal', 'Worker terminated'));
    };
    this.#worker.onmessageerror = () => this.close(new RaykitError('internal', 'Worker message could not be read'));
  }

  run(task: Task, signal?: AbortSignal, transfer: Transferable[] = []): Promise<Reply> {
    if (this.#closed) return Promise.reject(new RaykitError('closed'));
    if (signal?.aborted) return Promise.reject(new RaykitError('cancelled'));
    if (this.#queue.length >= 64) return Promise.reject(new RaykitError('limit', 'Pending worker requests'));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const i = this.#queue.indexOf(pending);
        if (i !== -1) this.#queue.splice(i, 1);
        reject(new RaykitError('cancelled'));
      };
      const pending: Pending = { id: this.#nextId++, task, transfer, resolve, reject,
        removeAbort: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(pending);
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#running || this.#closed) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    this.#running = pending;
    try { this.#worker.postMessage({ id: pending.id, ...pending.task }, pending.transfer); }
    catch { this.close(new RaykitError('internal', 'Worker request could not be sent')); }
  }

  close(reason = new RaykitError('closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    if (this.#running) this.#queue.unshift(this.#running);
    this.#running = undefined;
    for (const pending of this.#queue.splice(0)) { pending.removeAbort(); pending.reject(reason); }
  }
}

function metadata<T>(reply: Reply): T {
  if (!reply.metadata) throw new RaykitError('internal', 'Missing worker metadata');
  return JSON.parse(reply.metadata) as T;
}

export class RaykitSession {
  readonly #lifetime = new AbortController();
  constructor(readonly inspection: Inspection, readonly revision: string, private readonly channel: Channel) {}

  async readFrame(index: number, options: { output?: 'rgba' | 'stored'; signal?: AbortSignal } = {}): Promise<Frame> {
    const reply = await this.#request({ op: 'frame', index, output: options.output }, options.signal);
    const info = metadata<Omit<Frame, 'pixels' | 'requestId' | 'workerReadMs'>>(reply);
    if (info.source.frame !== index || info.source.content_sha256 !== this.inspection.content_sha256) {
      throw new RaykitError('integrity', 'Frame reply does not match source and index');
    }
    if (!reply.pixels) throw new RaykitError('internal', 'Missing decoded pixels');
    return { ...info, pixels: reply.pixels, requestId: reply.id, workerReadMs: reply.workMs ?? 0 };
  }

  async render(index: number, options: RenderOptions, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const reply = await this.#request({ op: 'render', index, options }, signal);
    if (!reply.pixels) throw new RaykitError('internal', 'Missing rendered pixels');
    return reply.pixels;
  }

  prefetch(index: number, signal?: AbortSignal): Promise<void> { return this.#value({ op: 'prefetch', index }, signal); }
  sample(index: number, x: number, y: number, signal?: AbortSignal): Promise<Sample> { return this.#value({ op: 'sample', index, x, y }, signal); }
  transform(index: number, view: View, point?: ScreenPoint, signal?: AbortSignal): Promise<MappedPoint> {
    return this.#value({ op: 'transform', index, view, point }, signal);
  }
  measure(index: number, request: MeasurementRequest, signal?: AbortSignal): Promise<Measurement> { return this.#value({ op: 'measure', index, request }, signal); }
  reopenMeasurement(record: Measurement, signal?: AbortSignal): Promise<Measurement> { return this.#value({ op: 'reopen', record }, signal); }
  stats(signal?: AbortSignal): Promise<Stats> { return this.#value({ op: 'stats' }, signal); }
  evict(signal?: AbortSignal): Promise<void> { return this.#value({ op: 'evict' }, signal); }

  async addVolumeSource(source: Source, options: AppendOptions = {}): Promise<{ added: boolean; revision: number; inspection: Inspection }> {
    return metadata(await this.#append(source, options));
  }

  async importSr(source: Source, options: AppendOptions & { expectedSourceSha256?: string } = {}): Promise<Measurement> {
    const { expectedSourceSha256, ...settings } = options;
    return metadata(await this.#append(source, settings, { kind: 'sr', expected_source_sha256: expectedSourceSha256 }));
  }

  async segmentation(source: Source, frame: number, segment: number, options: AppendOptions = {}): Promise<SegmentationOverlay> {
    const reply = await this.#append(source, options, { kind: 'segmentation', frame, segment });
    if (!reply.pixels) throw new RaykitError('internal', 'Missing segmentation mask');
    return { ...metadata<Omit<SegmentationOverlay, 'mask'>>(reply), mask: reply.pixels };
  }

  async presentation(source: Source, frame: number, options: AppendOptions = {}): Promise<Presentation> {
    return metadata(await this.#append(source, options, { kind: 'presentation', frame }));
  }

  async #append(source: Source, options: AppendOptions, attachment?: Record<string, unknown>): Promise<Reply> {
    const { signal, ...settings } = options;
    const scope = new AbortController();
    const abort = () => scope.abort();
    const lifetime = this.#lifetime.signal;
    lifetime.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (lifetime.aborted || signal?.aborted) abort();
    try {
      const limit = settings.limits?.source_bytes ?? sourceCeiling;
      if (!Number.isSafeInteger(limit) || limit > sourceCeiling || limit < 0) throw new RaykitError('limit', 'Source limit');
      const bytes = await sourceBuffer(source, attachment ? Math.min(limit, 64 * 1024 * 1024) : limit, scope.signal);
      return this.channel.run({ op: 'append', bytes, options: JSON.stringify({ ...settings, ...sourceIdentity(source), attachment }) }, scope.signal, [bytes]);
    } finally { lifetime.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); }
  }

  volumeCandidates(signal?: AbortSignal): Promise<VolumeCandidates> { return this.#value({ op: 'volume_candidates' }, signal); }
  buildVolume(index: number, revision: number, signal?: AbortSignal): Promise<Volume> {
    return this.#value({ op: 'volume_build', index, revision }, signal);
  }
  sampleVolume(point: Triple, signal?: AbortSignal): Promise<number | null> { return this.#value({ op: 'volume_sample', point }, signal); }

  async reslice(plane: SliceRequest, window?: WindowLevel, signal?: AbortSignal): Promise<SliceImage> {
    const reply = await this.#request({ op: 'reslice', plane, window }, signal);
    if (!reply.pixels) throw new RaykitError('internal', 'Missing reslice');
    return { ...metadata<Omit<SliceImage, 'pixels'>>(reply), pixels: reply.pixels };
  }

  async document(signal?: AbortSignal): Promise<Blob> {
    const reply = await this.#request({ op: 'document' }, signal);
    return media(reply);
  }

  async video(signal?: AbortSignal): Promise<{ document: Blob; quality: 'preview' }> {
    return { document: media(await this.#request({ op: 'video' }, signal)), quality: 'preview' };
  }

  async exportSr(record: Measurement, options: SrOptions, signal?: AbortSignal): Promise<Blob> {
    return media(await this.#request({ op: 'export_sr', record, options }, signal));
  }

  #request(command: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
    return this.channel.run({ op: 'command', command: JSON.stringify(command) }, signal);
  }

  async #value<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return metadata<T>(await this.#request(command, signal));
  }

  close(): void { this.#lifetime.abort(); this.channel.close(); }
}

function media(reply: Reply): Blob {
    if (!reply.pixels) throw new RaykitError('internal', 'Missing document bytes');
    return new Blob([reply.pixels], { type: metadata<{ media_type: string }>(reply).media_type });
}

export async function open(source: Source, options: OpenOptions = {}): Promise<RaykitSession> {
  const { workerFactory = defaultWorker, signal, revision, ...settings } = options;
  const scope = new AbortController();
  const abort = () => scope.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let channel: Channel | undefined;
  try {
    const max = settings.limits?.source_bytes ?? sourceCeiling;
    if (!Number.isSafeInteger(max) || max < 0 || max > sourceCeiling) throw new RaykitError('limit', 'Source limit');
    const bytes = await sourceBuffer(source, max, scope.signal);
    checkAbort(scope.signal);
    channel = new Channel(workerFactory);
    const reply = await channel.run({ op: 'open', bytes, options: JSON.stringify({ ...settings, ...sourceIdentity(source) }) }, scope.signal, [bytes]);
    checkAbort(scope.signal);
    const info = metadata<Inspection>(reply);
    return new RaykitSession(info, revision ?? info.content_sha256, channel);
  } catch (error) {
    channel?.close();
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}

function sourceIdentity(source: Source): Reader['expected'] {
  return 'read' in source ? source.expected : undefined;
}

export async function inspect(source: Source, options?: OpenOptions): Promise<Inspection> {
  const session = await open(source, options);
  try { return session.inspection; }
  finally { session.close(); }
}

export async function capabilities(options: Pick<OpenOptions, 'signal' | 'workerFactory'> = {}): Promise<EngineCapabilities> {
  const channel = new Channel(options.workerFactory ?? defaultWorker);
  try { return metadata(await channel.run({ op: 'capabilities' }, options.signal)); }
  finally { channel.close(); }
}

export function browserCapabilities(): { simd: boolean; wasmThreads: boolean; execution: 'single-worker-scalar' } {
  // Tiny module with v128.const, drop, and an empty return.
  const simdModule = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,23,1,21,0,
    253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,26,11]);
  const simd = WebAssembly.validate(simdModule);
  let wasmThreads = false;
  if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
    try { wasmThreads = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof SharedArrayBuffer; }
    catch { /* The browser declined shared memory. */ }
  }
  return { simd, wasmThreads, execution: 'single-worker-scalar' };
}
