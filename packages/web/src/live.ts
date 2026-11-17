import { RaykitError } from './types.js';

export interface LiveFrame { id: number; timestampMs: number; pixels: ImageData }
export interface LiveSource {
  id: string;
  revision: string;
  frames(signal: AbortSignal): AsyncIterable<LiveFrame>;
}

/** Displays host-decoded preview frames. Frame time is in the host's performance clock. */
export class LiveViewport extends EventTarget {
  #scope?: AbortController;
  #paint?: number;
  #lastTimestamp = -Infinity;
  #lastFrame = -1;
  #pending?: LiveFrame;
  #dropped = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly maxLatenessMs = 250) { super(); }

  async start(source: LiveSource): Promise<void> {
    this.close();
    const scope = this.#scope = new AbortController();
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new RaykitError('gpu_lost', 'Live canvas unavailable');
    try {
      for await (const frame of source.frames(scope.signal)) {
        if (scope.signal.aborted) break;
        const width = frame.pixels.width, height = frame.pixels.height;
        if (width * height > 4 * 1024 * 1024 || width > 4096 || height > 4096) throw new RaykitError('limit', 'Live frame dimensions');
        if (!Number.isSafeInteger(frame.id) || frame.id <= this.#lastFrame || !Number.isFinite(frame.timestampMs)
          || frame.timestampMs <= this.#lastTimestamp || Math.abs(performance.now() - frame.timestampMs) > this.maxLatenessMs) {
          this.#dropped++; continue;
        }
        this.#lastTimestamp = frame.timestampMs;
        this.#lastFrame = frame.id;
        if (this.#pending) this.#dropped++;
        this.#pending = frame;
        if (this.#paint !== undefined) continue;
        this.#paint = requestAnimationFrame(() => {
          this.#paint = undefined;
          const latest = this.#pending;
          this.#pending = undefined;
          if (scope.signal.aborted || !latest) return;
          if (performance.now() - latest.timestampMs > this.maxLatenessMs) { this.#dropped++; return; }
          if (this.canvas.width !== latest.pixels.width) this.canvas.width = latest.pixels.width;
          if (this.canvas.height !== latest.pixels.height) this.canvas.height = latest.pixels.height;
          context.putImageData(latest.pixels, 0, 0);
          this.dispatchEvent(new CustomEvent('presented', { detail: { source: source.id, revision: source.revision, frame: latest.id,
            timestampMs: latest.timestampMs, quality: 'preview', measurementAvailable: false, dropped: this.#dropped } }));
        });
      }
    } finally {
      if (scope === this.#scope && !scope.signal.aborted) {
        this.close();
        this.dispatchEvent(new Event('ended'));
      }
    }
  }

  close(): void {
    this.#scope?.abort(); this.#scope = undefined;
    if (this.#paint !== undefined) cancelAnimationFrame(this.#paint);
    this.#paint = undefined;
    this.#pending = undefined;
    this.#lastTimestamp = -Infinity;
    this.#lastFrame = -1;
    this.#dropped = 0;
    this.canvas.width = this.canvas.height = 1;
  }
}
