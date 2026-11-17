import init, { WasmSession, capabilities, linear_memory_bytes } from './generated/raykit_wasm.js';
import type { RangeSource } from './types.js';

export type Message = { id: number } & (
  { op: 'open'; bytes: ArrayBuffer; options: string } | { op: 'append'; bytes: ArrayBuffer; options: string }
  | { op: 'open_index'; manifest: ArrayBuffer; pin: string; range: RangeSource; options: string }
  | { op: 'capabilities' } | { op: 'command'; command: string } | { op: 'cancel' }
);
export interface Reply {
  id: number;
  metadata?: string;
  pixels?: Uint8Array<ArrayBuffer>;
  error?: string;
  workMs?: number;
}

const worker = self as DedicatedWorkerGlobalScope;
// Start loading WASM while the caller is still reading the source.
const initialized = init().then(() => true, () => false);
let session: WasmSession | undefined;
let inputCopyBytes = 0;
let outputCopyBytes = 0;
let rangeSource: RangeSource | undefined;
let openOptions: string;
let rangeReadBytes = 0;
let fullFallbackBytes = 0;
let rangeRequests = 0;
let inFlight: { id: number; controller: AbortController } | undefined;

worker.onmessage = async (event: MessageEvent<Message>) => {
  const msg = event.data;
  if (msg.op === 'cancel') {
    if (inFlight?.id === msg.id) inFlight.controller.abort();
    return;
  }
  const controller = new AbortController();
  inFlight = { id: msg.id, controller };
  let reply: Reply;
  try {
    if (!await initialized) throw '{"code":"internal","detail":"WASM initialization failed"}';
    switch (msg.op) {
      case 'open': {
        session?.free();
        session = undefined;
        rangeSource = undefined;
        const bytes = new Uint8Array(msg.bytes);
        session = await WasmSession.open_in_worker(bytes, msg.options);
        inputCopyBytes = bytes.byteLength;
        outputCopyBytes = 0;
        reply = { id: msg.id, metadata: session.inspection() };
        break;
      }
      case 'open_index': {
        session?.free();
        session = WasmSession.open_index(new Uint8Array(msg.manifest), msg.pin, msg.options);
        const range = msg.range;
        if (range.kind === 'blob') {
          if (range.blob.size !== session.source_bytes()) throw failure('integrity', 'Indexed Blob byte length');
        } else {
          const url = new URL(range.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^"[^"\r\n]+"$/.test(range.etag)) {
            throw failure('invalid_request', 'Range source requires an HTTP URL and strong ETag');
          }
        }
        rangeSource = range;
        openOptions = msg.options;
        inputCopyBytes = msg.manifest.byteLength;
        outputCopyBytes = 0;
        rangeReadBytes = fullFallbackBytes = rangeRequests = 0;
        reply = { id: msg.id, metadata: session.inspection() };
        break;
      }
      case 'capabilities':
        reply = { id: msg.id, metadata: capabilities() };
        break;
      case 'append': {
        if (!session) throw '{"code":"closed"}';
        const bytes = new Uint8Array(msg.bytes);
        inputCopyBytes += bytes.byteLength;
        const result = rangeSource
          ? await withRange(active => active.append(bytes, msg.options), controller.signal)
          : session.append(bytes, msg.options);
        try {
          const pixels = ownedBuffer(result.take_data());
          outputCopyBytes += pixels.byteLength;
          reply = { id: msg.id, metadata: result.metadata(), pixels };
        }
        finally { result.free(); }
        break;
      }
      case 'command': {
        if (!session) throw '{"code":"closed"}';
        const started = performance.now();
        const result = rangeSource
          ? await withRange(active => active.request(msg.command), controller.signal)
          : session.request(msg.command);
        try {
          let metadata = result.metadata();
          const pixels = ownedBuffer(result.take_data());
          outputCopyBytes += pixels.byteLength;
          if (msg.command === '{"op":"stats"}') {
            metadata = JSON.stringify({ ...JSON.parse(metadata), wasm_linear_memory_bytes: linear_memory_bytes(),
              wasm_input_copy_bytes: inputCopyBytes, wasm_output_copy_bytes: outputCopyBytes,
              indexed_range_read_bytes: rangeReadBytes, indexed_full_fallback_bytes: fullFallbackBytes, range_requests: rangeRequests });
          }
          reply = { id: msg.id, metadata, pixels, workMs: performance.now() - started };
        } finally {
          result.free();
        }
        break;
      }
    }
  } catch (error) {
    reply = { id: msg.id, error: controller.signal.aborted ? failure('cancelled') :
      typeof error === 'string' ? error : failure('internal', 'Worker execution failed') };
  } finally {
    if (inFlight?.id === msg.id) inFlight = undefined;
  }
  worker.postMessage(reply, reply.pixels ? [reply.pixels.buffer] : []);
};

function failure(code: string, detail?: string): string { return JSON.stringify({ code, detail }); }

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw failure('cancelled');
}

async function withRange<T>(operation: (active: WasmSession) => T, signal: AbortSignal): Promise<T> {
  const active = session!;
  try { return operation(active); }
  catch (error) {
    if (typeof error !== 'string' || !rangeSource) throw error;
    const { code, detail } = JSON.parse(error);
    if (code !== 'frame_range' || !Number.isInteger(detail)) throw error;
    const [start, end, total] = active.frame_range(detail);
    const read = await readRange(rangeSource, start, end, total, signal);
    checkAbort(signal);
    inputCopyBytes += read.bytes.byteLength;
    if (read.full) {
      const content = JSON.parse(active.inspection());
      const full = await WasmSession.open_in_worker(read.bytes, JSON.stringify({ ...JSON.parse(openOptions),
        expected_sha256: content.content_sha256, expected_size: total }));
      if (signal.aborted) { full.free(); checkAbort(signal); }
      active.adopt_full_source(full);
      rangeSource = undefined;
      return operation(active);
    }
    active.stage_range(detail, read.bytes);
    try { return operation(active); }
    finally { active.clear_range(); }
  }
}

async function readRange(source: RangeSource, start: number, end: number, total: number, signal: AbortSignal) {
  checkAbort(signal);
  rangeRequests++;
  if (source.kind === 'blob') {
    try {
      const bytes = new Uint8Array(await source.blob.slice(start, end).arrayBuffer());
      rangeReadBytes += bytes.byteLength;
      return { bytes, full: false };
    } catch { throw failure('io', 'Indexed Blob read failed'); }
  }
  const headers = new Headers(source.headers);
  headers.set('Range', `bytes=${start}-${end - 1}`);
  headers.set('If-Match', source.etag);
  let response: Response;
  try {
    response = await fetch(source.url, { headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  } catch { throw failure('io', 'HTTP range read failed'); }
  try {
    if (![200, 206, 412, 416].includes(response.status)) throw failure('io', 'HTTP source is unavailable');
    if (response.status === 412 || response.headers.get('ETag') !== source.etag) {
      throw failure('integrity', 'HTTP source representation changed');
    }
    const encoding = response.headers.get('Content-Encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') throw failure('integrity', 'HTTP source encoding');
    const full = response.status === 200;
    if (!full && (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end - 1}/${total}`)) {
      throw failure('integrity', 'HTTP Content-Range does not match the verified index');
    }
    const length = full ? total : end - start;
    const declared = response.headers.get('Content-Length');
    if (declared !== null && Number(declared) !== length) throw failure('integrity', 'HTTP range byte length');
    const reader = response.body?.getReader();
    if (!reader) throw failure('io', 'Missing HTTP source body');
    try {
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (full) fullFallbackBytes += value.byteLength;
        else rangeReadBytes += value.byteLength;
        if (value.byteLength > length - offset) throw failure('integrity', 'HTTP source exceeded the verified byte length');
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== length) throw failure('integrity', 'Truncated HTTP source');
      return { bytes, full };
    } catch (error) {
      if (typeof error === 'string') throw error;
      throw failure('io', 'HTTP source interrupted');
    } finally { reader.releaseLock(); }
  } finally { await response.body?.cancel().catch(() => {}); }
}

function ownedBuffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(data.buffer instanceof ArrayBuffer)) throw new Error('Expected owned WASM output');
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
