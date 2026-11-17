import init, { WasmSession, capabilities, linear_memory_bytes } from './generated/raykit_wasm.js';

export type Message = { id: number } & (
  { op: 'open'; bytes: ArrayBuffer; options: string } | { op: 'append'; bytes: ArrayBuffer; options: string }
  | { op: 'capabilities' } | { op: 'command'; command: string }
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

worker.onmessage = async (event: MessageEvent<Message>) => {
  const msg = event.data;
  let reply: Reply;
  try {
    if (!await initialized) throw '{"code":"internal","detail":"WASM initialization failed"}';
    switch (msg.op) {
      case 'open': {
        session?.free();
        session = undefined;
        const bytes = new Uint8Array(msg.bytes);
        session = await WasmSession.open_in_worker(bytes, msg.options);
        inputCopyBytes = bytes.byteLength;
        outputCopyBytes = 0;
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
        const result = session.append(bytes, msg.options);
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
        const result = session.request(msg.command);
        try {
          let metadata = result.metadata();
          const pixels = ownedBuffer(result.take_data());
          outputCopyBytes += pixels.byteLength;
          if (msg.command === '{"op":"stats"}') {
            metadata = JSON.stringify({ ...JSON.parse(metadata), wasm_linear_memory_bytes: linear_memory_bytes(),
              wasm_input_copy_bytes: inputCopyBytes, wasm_output_copy_bytes: outputCopyBytes });
          }
          reply = { id: msg.id, metadata, pixels, workMs: performance.now() - started };
        } finally {
          result.free();
        }
        break;
      }
    }
  } catch (error) {
    reply = { id: msg.id, error: typeof error === 'string' ? error : '{"code":"internal","detail":"Worker execution failed"}' };
  }
  worker.postMessage(reply, reply.pixels ? [reply.pixels.buffer] : []);
};

function ownedBuffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(data.buffer instanceof ArrayBuffer)) throw new Error('Expected owned WASM output');
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
