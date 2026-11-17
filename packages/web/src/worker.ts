import * as baseline from './generated/raykit_wasm.js';
import type { WasmSession, WasmTiles } from './generated/raykit_wasm.js';
import type { ProofSource, RangeSource, TiledSource } from './types.js';

export type Message = { id: number } & (
  { op: 'open'; bytes: ArrayBuffer; options: string } | { op: 'append'; bytes: ArrayBuffer; options: string }
  | { op: 'open_index'; manifest: ArrayBuffer; pin: string; range: RangeSource; options: string }
  | { op: 'open_proof'; source: ProofSource['frameProof']; options: string }
  | { op: 'open_tiles'; source: TiledSource }
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
const initialized = baseline.default().then(() => true, () => false);
let advancedFlight: Promise<typeof baseline> | undefined;
let engine = baseline;
let session: WasmSession | undefined;
let inputCopyBytes = 0;
let outputCopyBytes = 0;
let rangeSource: RangeSource | undefined;
let proofSource: ProofSource['frameProof'] | undefined;
let tiles: { source: TiledSource; image: WasmTiles } | undefined;
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
  const controller = rangeSource || proofSource || tiles || ['open_proof', 'open_tiles'].includes(msg.op) ? new AbortController() : undefined;
  if (controller) inFlight = { id: msg.id, controller };
  let reply: Reply;
  try {
    if (!['open_proof', 'open_tiles'].includes(msg.op) && !await initialized) throw failure('io', 'Baseline engine could not be loaded');
    if (msg.op.startsWith('open')) {
      session?.free();
      tiles?.image.free();
      session = rangeSource = proofSource = tiles = undefined;
    }
    switch (msg.op) {
      case 'open': {
        const bytes = new Uint8Array(msg.bytes);
        const prefix = bytes.subarray(0, 64 * 1024);
        engine = baseline.codec_hint(prefix) === 2 ? await advancedEngine() : baseline;
        inputCopyBytes = bytes.byteLength + prefix.byteLength;
        session = await engine.WasmSession.open_in_worker(bytes, msg.options);
        if (engine === baseline && !baseline.advanced_codecs() && needsAdvanced(session)) {
          session.free();
          session = undefined;
          engine = await advancedEngine();
          session = await engine.WasmSession.open_in_worker(bytes, msg.options);
          inputCopyBytes += bytes.byteLength;
        }
        outputCopyBytes = 0;
        reply = { id: msg.id, metadata: session.inspection() };
        break;
      }
      case 'open_index': {
        engine = baseline;
        session = baseline.WasmSession.open_index(new Uint8Array(msg.manifest), msg.pin, msg.options);
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
      case 'open_proof': {
        const source = msg.source;
        const url = new URL(source.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')
          || !/^[a-f0-9]{64}$/i.test(source.rootSha256) || !source.revision || source.revision.length > 256) {
          throw failure('invalid_request', 'Frame proof source');
        }
        rangeReadBytes = fullFallbackBytes = rangeRequests = 0;
        const [packet, loaded] = await Promise.all([readProof(source, source.firstFrame, controller!.signal), initialized]);
        if (!loaded) throw failure('io', 'Baseline engine could not be loaded');
        checkAbort(controller!.signal);
        engine = baseline;
        session = baseline.WasmSession.open_proof(packet, source.rootSha256, source.revision, source.firstFrame, msg.options);
        proofSource = source;
        inputCopyBytes = packet.byteLength;
        outputCopyBytes = 0;
        reply = { id: msg.id, metadata: session.inspection() };
        break;
      }
      case 'open_tiles': {
        const source = msg.source;
        const url = directory(source.baseUrl);
        if (!/^[a-f0-9]{64}$/i.test(source.manifestSha256) || !source.revision || source.revision.length > 256) {
          throw failure('invalid_request', 'Tiled source pin and revision');
        }
        rangeReadBytes = fullFallbackBytes = rangeRequests = 0;
        const [manifest, loaded] = await Promise.all([
          readBounded(new URL('manifest.json', url), source.headers, 2 * 1024 * 1024, controller!.signal, 'Tile manifest'), initialized,
        ]);
        if (!loaded) throw failure('io', 'Baseline engine could not be loaded');
        checkAbort(controller!.signal);
        const image = new baseline.WasmTiles(manifest, source.manifestSha256, source.revision);
        tiles = { source, image };
        reply = { id: msg.id, metadata: image.info() };
        break;
      }
      case 'capabilities':
        reply = { id: msg.id, metadata: baseline.capabilities() };
        break;
      case 'append': {
        if (!session) throw '{"code":"closed"}';
        const bytes = new Uint8Array(msg.bytes);
        inputCopyBytes += bytes.byteLength;
        const result = controller
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
        if (tiles) {
          reply = await tileCommand(msg, tiles, controller!.signal);
          break;
        }
        if (!session) throw '{"code":"closed"}';
        const started = performance.now();
        const result = controller
          ? await withRange(active => active.request(msg.command), controller.signal)
          : session.request(msg.command);
        try {
          let metadata = result.metadata();
          const pixels = ownedBuffer(result.take_data());
          outputCopyBytes += pixels.byteLength;
          if (msg.command === '{"op":"stats"}') {
            metadata = JSON.stringify({ ...JSON.parse(metadata), wasm_linear_memory_bytes: engine.linear_memory_bytes()
              + (engine === baseline ? 0 : baseline.linear_memory_bytes()),
              wasm_input_copy_bytes: inputCopyBytes, wasm_output_copy_bytes: outputCopyBytes,
              indexed_range_read_bytes: rangeReadBytes, indexed_full_fallback_bytes: fullFallbackBytes, range_requests: rangeRequests,
              engine: engine === baseline ? 'baseline' : 'advanced' });
          }
          reply = { id: msg.id, metadata, pixels, workMs: performance.now() - started };
        } finally {
          result.free();
        }
        break;
      }
    }
  } catch (error) {
    reply = { id: msg.id, error: controller?.signal.aborted ? failure('cancelled') :
      typeof error === 'string' ? error : failure('internal', 'Worker execution failed') };
  } finally {
    if (inFlight?.id === msg.id) inFlight = undefined;
  }
  worker.postMessage(reply, reply.pixels ? [reply.pixels.buffer] : []);
};

function failure(code: string, detail?: string): string { return JSON.stringify({ code, detail }); }

async function advancedEngine(): Promise<typeof baseline> {
  if (baseline.advanced_codecs()) return baseline;
  advancedFlight ??= (async () => {
    let advanced;
    try {
      advanced = await import('./generated/advanced/raykit_wasm.js');
      await advanced.default();
    } catch { throw failure('io', 'Advanced codec engine could not be loaded'); }
    if (advanced.engine_version() !== baseline.engine_version()) throw failure('integrity', 'Advanced codec engine version');
    if (!advanced.advanced_codecs()) throw failure('unsupported', 'Advanced codec engine is unavailable');
    return advanced;
  })().catch(error => { advancedFlight = undefined; throw error; });
  return advancedFlight;
}

function needsAdvanced(session: WasmSession): boolean {
  const info = JSON.parse(session.inspection());
  return ['jpeg_ls_lossless', 'jpeg_ls_near_lossless', 'jpeg2000_lossless', 'jpeg2000', 'htj2k_lossless',
    'htj2k_lossless_rpcl', 'htj2k'].includes(info.transfer_syntax)
    || info.transfer_syntax === 'jpeg_extended' && info.pixel_format?.bits_stored === 12;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw failure('cancelled');
}

function directory(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw failure('invalid_request', 'Resource directory URL');
  }
  return url;
}

async function tileCommand(msg: { id: number; command: string }, active: NonNullable<typeof tiles>, signal: AbortSignal): Promise<Reply> {
  const command = JSON.parse(msg.command);
  const rect = command.op === 'render' ? command.rect
    : command.op === 'sample' ? { x: command.x, y: command.y, width: 1, height: 1 } : undefined;
  if (rect) {
    for (const index of active.image.need(JSON.stringify(rect))) {
      const bytes = await readBounded(new URL(index + '.bin', active.source.baseUrl), active.source.headers, 1024 * 1024, signal, 'Image tile');
      checkAbort(signal);
      active.image.stage(index, bytes);
    }
  }
  const result = active.image.request(msg.command);
  try {
    const data = result.metadata();
    return { id: msg.id, metadata: command.op === 'stats'
      ? JSON.stringify({ ...JSON.parse(data), bytes_read: rangeReadBytes, requests: rangeRequests }) : data,
      pixels: ownedBuffer(result.take_data()) };
  } finally { result.free(); }
}

async function withRange<T>(operation: (active: WasmSession) => T, signal: AbortSignal): Promise<T> {
  const active = session!;
  try { return operation(active); }
  catch (error) {
    if (typeof error !== 'string' || (!rangeSource && !proofSource)) throw error;
    const { code, detail } = JSON.parse(error);
    if (code !== 'frame_range' || !Number.isInteger(detail)) throw error;
    if (proofSource) {
      const bytes = await readProof(proofSource, detail, signal);
      checkAbort(signal);
      inputCopyBytes += bytes.byteLength;
      active.stage_proof(detail, bytes);
      return operation(active);
    }
    const [start, end, total] = active.frame_range(detail);
    const read = await readRange(rangeSource!, start, end, total, signal);
    checkAbort(signal);
    inputCopyBytes += read.bytes.byteLength;
    if (read.full) {
      const content = JSON.parse(active.inspection());
      const full = await baseline.WasmSession.open_in_worker(read.bytes, JSON.stringify({ ...JSON.parse(openOptions),
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

async function readProof(source: ProofSource['frameProof'], frame: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= 4096) throw failure('invalid_request', 'Frame proof index');
  return readBounded(new URL(frame + '.rkp', source.baseUrl), source.headers, 41 * 1024 * 1024, signal, 'Frame proof');
}

async function readBounded(url: URL, headers: Record<string, string> | undefined, limit: number,
  signal: AbortSignal, label: string): Promise<Uint8Array<ArrayBuffer>> {
  rangeRequests++;
  try {
    const response = await fetch(url, {
      headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    try {
      if (response.status !== 200 || !response.body) throw failure('io', label + ' is unavailable');
      const declared = response.headers.get('Content-Length');
      if (declared !== null && Number(declared) > limit) throw failure('limit', label + ' response bytes');
      const reader = response.body.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          rangeReadBytes += value.byteLength;
          if (length > limit || chunks.length >= 65_536) throw failure('limit', label + ' response bytes');
          chunks.push(value);
        }
        const packet = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { packet.set(chunk, offset); offset += chunk.byteLength; }
        return packet;
      } finally { reader.releaseLock(); }
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    if (signal.aborted) throw failure('cancelled');
    if (typeof error === 'string') throw error;
    throw failure('io', label + ' read failed');
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
