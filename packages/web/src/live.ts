import { open, RaykitSession } from './session.js';
import { RaykitError } from './types.js';
import type { Source } from './types.js';
import type { RaykitViewport } from './viewport.js';

export interface CaptureIdentity { acquisition: string; frame: string }
export interface LiveFrame { id: number; timestampMs: number; pixels: ImageData; capture?: CaptureIdentity }
export interface LiveSource {
  id: string;
  revision: string;
  frames(signal: AbortSignal): AsyncIterable<LiveFrame>;
}
export interface LivePresentation {
  source: string;
  revision: string;
  frame: number;
  timestampMs: number;
  capture?: CaptureIdentity;
  quality: 'preview';
  measurementAvailable: false;
  dropped: number;
}
export interface OriginalBinding {
  capture: CaptureIdentity;
  source: Source;
  sha256: string;
  instanceUid: string;
  dicomFrame: number;
}

/** Host-decoded preview. Only a presented image can be frozen. */
export class LiveViewport extends EventTarget {
  #scope?: AbortController;
  #binding?: AbortController;
  #original?: { viewport: RaykitViewport; session: RaykitSession };
  #identity?: Pick<LiveSource, 'id' | 'revision'>;
  #paint?: number;
  #lastTimestamp = -Infinity;
  #lastFrame = -1;
  #pending?: LiveFrame;
  #shown?: LivePresentation;
  #frozen?: LivePresentation;
  #dropped = 0;
  #whileFrozen = 0;
  #connection: 'idle' | 'streaming' | 'disconnected' | 'ended' = 'idle';

  constructor(readonly canvas: HTMLCanvasElement, readonly maxLatenessMs = 250) { super(); }

  get presented(): LivePresentation | undefined { return this.#shown; }
  get frozen(): LivePresentation | undefined { return this.#frozen; }
  get status() {
    return { connection: this.#connection, frozen: !!this.#frozen, unseen: this.#whileFrozen, dropped: this.#dropped,
      lastImageAgeMs: this.#shown && Math.max(0, performance.now() - this.#shown.timestampMs),
      original: !!this.#original && this.#original.viewport.session === this.#original.session &&
        this.#original.viewport.presented?.source.content_sha256 === this.#original.session.inspection.content_sha256 };
  }

  async start(source: LiveSource): Promise<void> {
    if (!source.id || !source.revision) throw new RaykitError('invalid_request', 'Live source identity');
    if (source.id !== this.#identity?.id || source.revision !== this.#identity.revision) this.close();
    else this.#stopTransport();
    this.#identity = { id: source.id, revision: source.revision };
    const scope = this.#scope = new AbortController();
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new RaykitError('gpu_lost', 'Live canvas unavailable');
    this.#connection = 'streaming';
    this.#state();
    try {
      for await (const frame of source.frames(scope.signal)) {
        if (scope.signal.aborted || this.#scope !== scope) return;
        const { width, height } = frame.pixels;
        if (width * height > 4 * 1024 * 1024 || width > 4096 || height > 4096) throw new RaykitError('limit', 'Live frame dimensions');
        if (!Number.isSafeInteger(frame.id) || frame.id <= this.#lastFrame || !Number.isFinite(frame.timestampMs)
          || frame.timestampMs <= this.#lastTimestamp || Math.abs(performance.now() - frame.timestampMs) > this.maxLatenessMs) {
          this.#dropped++;
          continue;
        }
        this.#lastTimestamp = frame.timestampMs;
        this.#lastFrame = frame.id;
        if (this.#pending) this.#dropped++;
        this.#pending = { ...frame, capture: validCapture(frame.capture) ? Object.freeze({ ...frame.capture }) : undefined };
        if (this.#frozen) {
          this.#whileFrozen++;
          this.#state();
        } else if (this.#paint === undefined) {
          this.#paint = requestAnimationFrame(() => {
            this.#paint = undefined;
            if (this.#scope === scope && !scope.signal.aborted) this.#draw(context);
          });
        }
      }
      if (this.#scope === scope && !scope.signal.aborted) {
        this.#draw(context);
        this.#connection = 'ended';
        this.dispatchEvent(new Event('ended'));
        this.#state();
      }
    } catch (error) {
      if (scope.signal.aborted || this.#scope !== scope) return;
      this.#connection = 'disconnected';
      this.#state();
      throw error;
    } finally {
      if (this.#scope === scope) this.#stopTransport(this.#connection === 'ended');
    }
  }

  #draw(context: CanvasRenderingContext2D): void {
    const latest = this.#pending;
    const identity = this.#identity;
    if (!latest || !identity || this.#frozen) return;
    this.#pending = undefined;
    if (performance.now() - latest.timestampMs > this.maxLatenessMs) { this.#dropped++; return; }
    if (this.canvas.width !== latest.pixels.width) this.canvas.width = latest.pixels.width;
    if (this.canvas.height !== latest.pixels.height) this.canvas.height = latest.pixels.height;
    context.putImageData(latest.pixels, 0, 0);
    this.#shown = Object.freeze({ source: identity.id, revision: identity.revision, frame: latest.id, capture: latest.capture,
      timestampMs: latest.timestampMs, quality: 'preview', measurementAvailable: false, dropped: this.#dropped });
    this.dispatchEvent(new CustomEvent('presented', { detail: this.#shown }));
  }

  freeze(): LivePresentation | undefined {
    if (this.#frozen || !this.#shown) return this.#frozen;
    this.#frozen = this.#shown;
    this.#whileFrozen = this.#pending ? 1 : 0;
    this.#state();
    return this.#frozen;
  }

  goLive(): void {
    this.#unbind();
    this.#frozen = undefined;
    this.#whileFrozen = 0;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (context) this.#draw(context);
    this.#state();
  }

  /** The host authorizes the binding using exact acquisition/frame IDs from its capture pipeline. */
  async bindOriginal(viewport: RaykitViewport, resolve: (frame: LivePresentation, signal: AbortSignal) => Promise<OriginalBinding>): Promise<void> {
    const frozen = this.#frozen;
    const capture = frozen?.capture;
    if (!frozen || !capture) throw new RaykitError('geometry', 'Frozen preview has no exact capture binding');
    this.#unbind();
    const scope = this.#binding = new AbortController();
    const binding = await resolve(frozen, scope.signal);
    if (scope.signal.aborted || this.#frozen !== frozen) throw new RaykitError('cancelled');
    if (binding.capture.acquisition !== capture.acquisition || binding.capture.frame !== capture.frame
      || !/^[a-f0-9]{64}$/i.test(binding.sha256) || !binding.instanceUid || !Number.isSafeInteger(binding.dicomFrame) || binding.dicomFrame < 0) {
      throw new RaykitError('integrity', 'Original capture identity differs');
    }
    const session = await open(binding.source, { signal: scope.signal, expected_instance_uid: binding.instanceUid, expected_sha256: binding.sha256 });
    try {
      const { geometry } = await session.frameInfo(binding.dicomFrame, scope.signal);
      const calibration = geometry.calibration;
      if (calibration.kind === 'none' || calibration.kind === 'ultrasound' &&
        !calibration.regions.some(region => region.spatial_format === 1 && region.units_xy.every(unit => unit === 3))) {
        throw new RaykitError('geometry', 'Original capture has no physical calibration');
      }
      if (scope.signal.aborted || this.#frozen !== frozen) throw new RaykitError('cancelled');
      this.#original = { viewport, session };
      await viewport.attach(session, { frame: binding.dicomFrame });
      if (scope.signal.aborted || this.#frozen !== frozen || viewport.presented?.source.frame !== binding.dicomFrame
        || viewport.presented.source.content_sha256 !== binding.sha256.toLowerCase()) {
        throw new RaykitError('cancelled');
      }
      this.#state();
    } catch (error) {
      if (this.#binding === scope) this.#unbind();
      throw error;
    } finally { session.close(); }
  }

  disconnect(): void {
    this.#stopTransport();
    this.#connection = 'disconnected';
    this.#state();
  }

  #stopTransport(keepPending = false): void {
    this.#scope?.abort();
    this.#scope = undefined;
    if (this.#paint !== undefined) cancelAnimationFrame(this.#paint);
    this.#paint = undefined;
    if (!keepPending) this.#pending = undefined;
  }

  #unbind(): void {
    this.#binding?.abort();
    this.#binding = undefined;
    const original = this.#original;
    this.#original = undefined;
    if (original?.viewport.session === original?.session) original?.viewport.close();
  }

  #state(): void { this.dispatchEvent(new CustomEvent('state', { detail: this.status })); }

  close(): void {
    this.#stopTransport();
    this.#unbind();
    this.#identity = this.#shown = this.#frozen = undefined;
    this.#lastTimestamp = -Infinity;
    this.#lastFrame = -1;
    this.#dropped = this.#whileFrozen = 0;
    this.canvas.width = this.canvas.height = 1;
    this.#connection = 'idle';
    this.#state();
  }
}

function validCapture(capture?: CaptureIdentity): capture is CaptureIdentity {
  return !!capture && typeof capture.acquisition === 'string' && typeof capture.frame === 'string'
    && capture.acquisition.length > 0 && capture.acquisition.length <= 128 && capture.frame.length > 0 && capture.frame.length <= 128;
}

/** Accepts an application-owned MediaStream, including a WebRTC receiver stream. */
export function mediaStreamSource(stream: MediaStream, options: {
  id: string; revision: string; capture?: (frame: VideoFrameCallbackMetadata) => CaptureIdentity | undefined;
  initialSequence?: number;
}): LiveSource {
  let sequence = options.initialSequence ?? 0;
  return { id: options.id, revision: options.revision, async *frames(signal) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || typeof video.requestVideoFrameCallback !== 'function') throw new RaykitError('unsupported', 'MediaStream frame callbacks');
    const tracks = stream.getVideoTracks();
    const ended = new AbortController();
    const stop = () => ended.abort();
    signal.addEventListener('abort', stop, { once: true });
    for (const track of tracks) track.addEventListener('ended', stop, { once: true });
    if (signal.aborted || !tracks.some(track => track.readyState === 'live')) stop();
    try {
      if (ended.signal.aborted) return;
      await video.play();
      while (!ended.signal.aborted) {
        const next = await new Promise<{ time: number; metadata: VideoFrameCallbackMetadata } | undefined>(resolve => {
          const cb = video.requestVideoFrameCallback((_time, metadata) => {
            ended.signal.removeEventListener('abort', abort);
            resolve({ time: performance.now(), metadata });
          });
          const abort = () => { video.cancelVideoFrameCallback(cb); resolve(undefined); };
          ended.signal.addEventListener('abort', abort, { once: true });
          if (ended.signal.aborted) abort();
        });
        if (!next) break;
        const { videoWidth: width, videoHeight: height } = video;
        if (!width || !height || width * height > 4 * 1024 * 1024 || width > 4096 || height > 4096) {
          throw new RaykitError('limit', 'Live video dimensions');
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        context.drawImage(video, 0, 0);
        yield { id: sequence++, timestampMs: next.time, pixels: context.getImageData(0, 0, width, height),
          capture: options.capture?.(next.metadata) };
      }
    } finally {
      signal.removeEventListener('abort', stop);
      for (const track of tracks) track.removeEventListener('ended', stop);
      video.pause();
      video.srcObject = null;
    }
  } };
}
