import { CpuRenderer, WebGlRenderer } from './renderer.js';
import { open, RaykitSession } from './session.js';
import { RaykitError } from './types.js';
import type { Frame, MappedPoint, OpenOptions, RenderOptions, Sample, ScreenPoint, Source, SourceReference, View, ViewTransform } from './types.js';

export interface PresentedFrame {
  source: SourceReference;
  revision: string;
  requestId: number;
  view: View;
  render: RenderOptions;
  transform: ViewTransform;
  quality: 'original';
  renderer: 'webgl2' | 'cpu';
  time: number;
}

export type ViewSettings = Omit<View, 'viewport'>;
type FrameSettings = { view: ViewSettings; render: RenderOptions };
const defaults: ViewSettings = { pan: [0, 0], zoom: 1, quarter_turns: 0 };
const nextPaint = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

export class RaykitViewport extends EventTarget {
  readonly #gpuCanvas = document.createElement('canvas');
  readonly #cpuCanvas = document.createElement('canvas');
  readonly #cpu = new CpuRenderer(this.#cpuCanvas);
  readonly #resize: ResizeObserver;
  readonly #enableGPU: boolean;
  #gpu?: WebGlRenderer;
  #session?: RaykitSession;
  #frame?: Frame;
  #undrawn?: Frame;
  #wanted?: number;
  #latest?: { index: number; resolve(): void; reject(error: unknown): void };
  #redrawRequested = false;
  #scope = new AbortController();
  #seek?: AbortController;
  #prefetch?: AbortController;
  #paint?: AbortController;
  #cpuFrame?: Frame;
  #cpuSettings?: string;
  #mapping?: { session: RaykitSession; key: string; transform: ViewTransform };
  #view: ViewSettings = defaults;
  #render: RenderOptions = {};
  #presented?: PresentedFrame;
  #playing = 0;
  #disposed = false;
  #hidden = false;

  constructor(readonly surface: HTMLElement, options: { gpu?: boolean } = {}) {
    super();
    this.#enableGPU = options.gpu !== false;
    for (const canvas of [this.#gpuCanvas, this.#cpuCanvas]) {
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      canvas.hidden = true;
      surface.prepend(canvas);
    }
    this.#gpuCanvas.addEventListener('webglcontextlost', this.#gpuLost);
    this.#gpuCanvas.addEventListener('webglcontextrestored', this.#gpuRestored);
    this.#resize = new ResizeObserver(() => this.#redraw());
    this.#resize.observe(surface);
    document.addEventListener('visibilitychange', this.#visibility);
  }

  get frame(): Frame | undefined { return this.#frame; }
  get session(): RaykitSession | undefined { return this.#session; }
  get presented(): PresentedFrame | undefined { return this.#presented; }
  get view(): ViewSettings { return this.#view; }
  get renderOptions(): RenderOptions { return this.#render; }
  get textureBytes(): number { return this.#gpu?.textureBytes ?? 0; }

  async load(source: Source, options: OpenOptions = {}): Promise<RaykitSession> {
    if (this.#disposed) throw new RaykitError('closed');
    this.close();
    const scope = this.#scope;
    const signal = options.signal;
    const abort = () => scope.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const session = await open(source, { ...options, signal: scope.signal });
      if (scope.signal.aborted) { session.close(); throw new RaykitError('cancelled'); }
      this.#session = session;
      if (session.inspection.capabilities.frame_access) await this.showFrame(0, session.inspection.verification !== 'pinned_frame_index');
      if (scope.signal.aborted) throw new RaykitError('cancelled');
      return session;
    } catch (error) {
      if (scope === this.#scope) this.close();
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async showFrame(index: number, prefetch = true, settings?: FrameSettings): Promise<void> {
    this.pause();
    this.#setTarget(index);
    await this.#show(index, prefetch, settings);
  }

  /** Keep one in-flight frame and replace the pending target during continuous input. */
  async scrubFrame(index: number): Promise<void> {
    this.pause();
    this.#setTarget(index);
    return new Promise((resolve, reject) => {
      this.#latest = { index, resolve, reject };
      this.#drain();
    });
  }

  /** Stop playback and give the last requested frame priority over continuous input. */
  async settle(): Promise<void> {
    this.pause();
    if (this.#wanted !== undefined && (this.#pending() || this.#presented?.source.frame !== this.#wanted)) {
      await this.showFrame(this.#wanted, false);
    }
  }

  #pending(): boolean { return !!(this.#seek || this.#latest); }

  #setTarget(index: number): void {
    const session = this.#session;
    if (!session) throw new RaykitError('closed');
    if (!Number.isInteger(index) || index < 0 || index >= session.inspection.frames) throw new RaykitError('invalid_request', 'Frame index');
    this.#wanted = index;
    this.#cancelQueued();
    this.#prefetch?.abort();
  }

  #cancelQueued(): void {
    this.#latest?.reject(new RaykitError('cancelled'));
    this.#latest = undefined;
  }

  #drain(): void {
    const target = this.#latest;
    if (!target || this.#seek) return;
    this.#latest = undefined;
    void this.#show(target.index, false).then(target.resolve, target.reject);
  }

  async #show(index: number, prefetch: boolean, settings?: FrameSettings): Promise<void> {
    const session = this.#session;
    if (!session) throw new RaykitError('closed');
    this.#seek?.abort();
    this.#paint?.abort();
    this.#undrawn = undefined;
    const seek = this.#seek = new AbortController();
    const previous = this.#frame?.source.frame ?? index;
    try {
      const frame = await session.readFrame(index, { output: this.#enableGPU ? 'stored' : 'rgba', signal: seek.signal });
      if (seek.signal.aborted || session !== this.#session) throw new RaykitError('cancelled');
      if (settings) { this.#view = settings.view; this.#render = settings.render; }
      this.#undrawn = frame;
      await this.#draw(frame, session);
      if (seek.signal.aborted || session !== this.#session) throw new RaykitError('cancelled');
      const neighbor = index + (index < previous ? -1 : 1);
      if (!prefetch || this.#latest || neighbor < 0 || neighbor >= session.inspection.frames || this.#hidden) return;
      const controller = this.#prefetch = new AbortController();
      void session.prefetch(neighbor, controller.signal).catch(() => {});
    } finally {
      if (this.#seek === seek) {
        this.#seek = undefined;
        this.#drain();
        if (!this.#pending() && this.#redrawRequested) {
          this.#redrawRequested = false;
          this.#redraw();
        }
      }
    }
  }

  async redraw(): Promise<void> {
    if (this.#seek) {
      if (this.#undrawn) this.#redrawRequested = true;
      return;
    }
    const frame = this.#undrawn ?? this.#frame;
    const session = this.#session;
    if (frame && session) await this.#draw(frame, session);
  }

  async #draw(frame: Frame, session: RaykitSession): Promise<void> {
    const viewport = [this.surface.clientWidth, this.surface.clientHeight] as const;
    if (this.#hidden || !viewport[0] || !viewport[1]) return;
    this.#initGPU();
    this.#paint?.abort();
    const scope = this.#paint = new AbortController();
    const view = { ...this.#view, viewport };
    const render = this.#render;
    try {
      const key = JSON.stringify([view, frame.format.columns, frame.format.rows, frame.geometry.display_spacing_xy]);
      const transform = this.#mapping?.session === session && this.#mapping.key === key ? this.#mapping.transform
        : (await session.transform(frame.source.frame, view, undefined, scope.signal)).transform;
      if (scope.signal.aborted) return;
      this.#mapping = { session, key, transform };
      const dpr = Math.min(devicePixelRatio || 1, 4096 / Math.max(...viewport));
      for (const canvas of [this.#gpuCanvas, this.#cpuCanvas]) {
        const [w, h] = viewport.map(n => Math.max(1, Math.round(n * dpr)));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      }
      await nextPaint();
      if (scope.signal.aborted) return;
      let gpu = false;
      try { gpu = this.#gpu?.draw(frame, transform, viewport, render) ?? false; }
      catch (error) { this.#report(error); }
      if (!gpu) {
        const settings = JSON.stringify(render);
        if (this.#cpuFrame !== frame || settings !== this.#cpuSettings) {
          const rgba = frame.encoding === 'rgba8' && settings === '{}'
            ? frame.pixels : await session.render(frame.source.frame, render, scope.signal);
          if (scope.signal.aborted) return;
          this.#cpu.setPixels(frame, rgba);
          this.#cpuFrame = frame;
          this.#cpuSettings = settings;
          await nextPaint();
          if (scope.signal.aborted) return;
        }
        this.#cpu.draw(transform, viewport);
      }
      this.#gpuCanvas.hidden = !gpu;
      this.#cpuCanvas.hidden = gpu;
      if (scope.signal.aborted) return;
      const presented: PresentedFrame = { source: frame.source, revision: session.revision, requestId: frame.requestId,
        view, render, transform, renderer: gpu ? 'webgl2' : 'cpu', quality: 'original', time: performance.now() };
      this.#undrawn = undefined;
      this.#frame = frame;
      this.#presented = presented;
      this.dispatchEvent(new CustomEvent<PresentedFrame>('presented', { detail: presented }));
    } catch (error) {
      if (!scope.signal.aborted) throw error;
    }
  }

  setView(view: ViewSettings): void {
    this.#view = { pan: [...view.pan], zoom: Math.max(0.01, Math.min(128, view.zoom)), quarter_turns: (view.quarter_turns % 4 + 4) % 4 };
    this.#redraw();
  }

  setRenderOptions(render: RenderOptions): void {
    this.#render = { ...render, window: render.window ? { ...render.window } : render.window };
    this.#redraw();
  }

  reset(): void {
    this.#view = defaults;
    this.#render = {};
    this.#redraw();
  }

  async mapPoint(point: ScreenPoint): Promise<MappedPoint> {
    const session = this.#session;
    const presented = this.#presented;
    if (!session || !presented) throw new RaykitError('closed', 'No presented frame');
    const mapped = await session.transform(presented.source.frame, presented.view, point, this.#scope.signal);
    if (presented !== this.#presented || session !== this.#session) throw new RaykitError('cancelled');
    return mapped;
  }

  async samplePresented(x: number, y: number): Promise<Sample> {
    const session = this.#session;
    const presented = this.#presented;
    if (!session || !presented) throw new RaykitError('closed', 'No presented frame');
    const sample = await session.sample(presented.source.frame, x, y, this.#scope.signal);
    if (presented !== this.#presented || session !== this.#session) throw new RaykitError('cancelled');
    return sample;
  }

  async play(rate = 1): Promise<{ shown: number; skipped: number }> {
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 8) throw new RaykitError('invalid_request', 'Cine playback rate');
    const session = this.#session;
    if (!session || session.inspection.frames < 2) return { shown: 0, skipped: 0 };
    const generation = ++this.#playing;
    const count = session.inspection.frames;
    const durations = session.inspection.frame_durations_ms ?? Array.from({ length: count }, () => 1000 / 15);
    const duration = (i: number) => Math.max(1, durations[i] / rate);
    const cycle = durations.reduce((sum, _, i) => sum + duration(i), 0);
    let index = this.#frame?.source.frame ?? 0;
    let due = performance.now() + duration(index);
    let shown = 0, skipped = 0;
    while (generation === this.#playing && session === this.#session) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(40, due - performance.now()))));
      if (generation !== this.#playing || session !== this.#session || this.#hidden) break;
      const now = performance.now();
      if (now < due) continue;
      index = (index + 1) % count;
      due += duration(index);
      const elapsedCycles = Math.floor(Math.max(0, now - due) / cycle);
      skipped += elapsedCycles * count;
      due += elapsedCycles * cycle;
      while (due <= now) { index = (index + 1) % count; due += duration(index); skipped++; }
      try {
        this.#setTarget(index);
        await this.#show(index, false);
      }
      catch (error) {
        if (error instanceof RaykitError && (error.code === 'closed' || error.code === 'cancelled')) break;
        throw error;
      }
      if (this.#presented?.source.frame === index) shown++;
    }
    return { shown, skipped };
  }

  pause(): void { this.#playing++; }

  close(): void {
    this.pause();
    this.#scope.abort();
    this.#scope = new AbortController();
    this.#seek?.abort(); this.#prefetch?.abort(); this.#paint?.abort();
    this.#seek = undefined;
    this.#cancelQueued();
    this.#wanted = undefined;
    this.#undrawn = undefined;
    this.#redrawRequested = false;
    this.#session?.close();
    this.#session = undefined;
    this.#frame = undefined;
    this.#presented = undefined;
    this.#cpuFrame = undefined;
    this.#mapping = undefined;
    this.#view = defaults;
    this.#render = {};
    this.#gpu?.dispose();
    this.#gpu = undefined;
    for (const canvas of [this.#gpuCanvas, this.#cpuCanvas]) {
      canvas.hidden = true;
      canvas.width = canvas.height = 1;
    }
    this.#cpu.clear();
    this.dispatchEvent(new Event('closed'));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.close();
    this.#resize.disconnect();
    this.#gpuCanvas.removeEventListener('webglcontextlost', this.#gpuLost);
    this.#gpuCanvas.removeEventListener('webglcontextrestored', this.#gpuRestored);
    document.removeEventListener('visibilitychange', this.#visibility);
    this.#gpuCanvas.remove(); this.#cpuCanvas.remove();
  }

  #initGPU(): void {
    if (!this.#enableGPU || this.#gpu) return;
    try { this.#gpu = new WebGlRenderer(this.#gpuCanvas); }
    catch { /* The CPU reference renderer has its own canvas. */ }
  }

  #redraw(): void {
    void this.redraw().catch(error => this.#report(error));
  }

  #report(error: unknown): void {
    const diagnostic = error instanceof RaykitError ? error : new RaykitError('internal', 'Viewport operation failed');
    if (diagnostic.code !== 'closed' && diagnostic.code !== 'cancelled') {
      this.dispatchEvent(new CustomEvent<RaykitError>('diagnostic', { detail: diagnostic }));
    }
  }

  #gpuLost = (event: Event) => {
    event.preventDefault();
    this.#gpu = undefined;
    this.#report(new RaykitError('gpu_lost'));
    this.#redraw();
  };

  #gpuRestored = () => this.#redraw();

  #visibility = () => {
    this.#hidden = document.hidden;
    if (!this.#hidden) { this.#redraw(); return; }
    this.pause();
    this.#seek?.abort(); this.#prefetch?.abort(); this.#paint?.abort();
    this.#cancelQueued();
    this.#wanted = this.#frame?.source.frame;
    this.#undrawn = undefined;
    this.#presented = undefined;
  };
}
