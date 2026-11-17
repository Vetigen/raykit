import { TiledSession } from './session.js';
import { RaykitError } from './types.js';
import type { MeasurementRequest, PixelPoint, RenderOptions, ScreenPoint, TileRegion } from './types.js';

type Display = Pick<RenderOptions, 'window' | 'palette' | 'invert'>;

/** Draw a viewport-sized region plus the neighboring samples needed for interpolation. */
export class TiledViewport extends EventTarget {
  readonly #raster = document.createElement('canvas');
  #pending?: AbortController;
  #drawn?: { x: number; y: number; sx: number; sy: number; rect: TileRegion };
  #closed = false;
  #x: number;
  #y: number;
  #zoom = 1;
  #display: Display = {};
  readonly #resize: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, readonly session: TiledSession) {
    super();
    this.#x = (session.inspection.format.columns - 1) / 2;
    this.#y = (session.inspection.format.rows - 1) / 2;
    this.#resize = new ResizeObserver(() => {
      void this.draw().catch(error => {
        if (error.code !== 'cancelled' && error.code !== 'closed') this.dispatchEvent(new CustomEvent('diagnostic', { detail: error }));
      });
    });
    this.#resize.observe(canvas);
  }

  /** Center and zoom use original source pixels; zoom 1 shows at least one CSS pixel per source pixel. */
  async setView(center: PixelPoint, zoom: number): Promise<void> {
    if (![zoom, center.x, center.y].every(Number.isFinite) || zoom < 1 || zoom > 32) throw new RaykitError('invalid_request', 'Tiled view');
    const { columns, rows } = this.session.inspection.format;
    this.#x = Math.max(0, Math.min(columns - 1, center.x));
    this.#y = Math.max(0, Math.min(rows - 1, center.y));
    this.#zoom = zoom;
    await this.draw();
  }

  async setDisplay(options: Display): Promise<void> {
    this.#display = structuredClone(options);
    await this.draw();
  }

  async draw(): Promise<void> {
    if (this.#closed) throw new RaykitError('closed');
    this.#pending?.abort();
    const scope = this.#pending = new AbortController();
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    const { format, display_spacing_xy: [dx, dy] } = this.session.inspection;
    const zoom = Math.max(this.#zoom, width / 1024, height / 1024);
    const sx = zoom * dx / Math.min(dx, dy), sy = zoom * dy / Math.min(dx, dy);
    const x = width / 2 - this.#x * sx, y = height / 2 - this.#y * sy;
    const extent = (origin: number, span: number, scale: number, total: number) => {
      const first = Math.max(0, Math.floor(-origin / scale) - 1);
      const end = Math.min(total, Math.ceil((span - origin) / scale) + 2);
      return [first, end - first] as const;
    };
    const [rx, rw] = extent(x, width, sx, format.columns);
    const [ry, rh] = extent(y, height, sy, format.rows);
    const rect = { x: rx, y: ry, width: rw, height: rh };
    const rgba = await this.session.renderRegion(rect, this.#display, scope.signal);
    if (this.#closed || scope.signal.aborted) throw new RaykitError('cancelled');
    const ratio = Math.min(devicePixelRatio || 1, 4096 / Math.max(width, height));
    const ctx = this.canvas.getContext('2d', { alpha: false });
    const raster = this.#raster.getContext('2d', { alpha: false });
    if (!ctx || !raster) throw new RaykitError('unsupported', 'Tile canvas unavailable');
    this.#raster.width = rw; this.#raster.height = rh;
    raster.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), rw, rh), 0, 0);
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.#raster, x + (rx - .5) * sx, y + (ry - .5) * sy, rw * sx, rh * sy);
    this.#drawn = { x, y, sx, sy, rect };
    this.dispatchEvent(new CustomEvent('presented', { detail: { source: this.session.inspection.source,
      revision: this.session.inspection.revision, quality: 'original', rect, time: performance.now() } }));
  }

  mapPoint(point: ScreenPoint): PixelPoint | null {
    const drawn = this.#drawn;
    if (!drawn || point.x < 0 || point.y < 0 || point.x >= this.canvas.clientWidth || point.y >= this.canvas.clientHeight) return null;
    const x = (point.x - drawn.x) / drawn.sx;
    const y = (point.y - drawn.y) / drawn.sy;
    const { columns, rows } = this.session.inspection.format;
    return x < -.5 || x >= columns - .5 || y < -.5 || y >= rows - .5 ? null : { x, y };
  }

  async sample(point: ScreenPoint) {
    const drawn = this.#drawn;
    const pixel = this.mapPoint(point);
    if (!pixel || !drawn) throw new RaykitError('invalid_request', 'No presented source pixel');
    const sample = await this.session.sample(Math.round(pixel.x), Math.round(pixel.y));
    if (drawn !== this.#drawn) throw new RaykitError('cancelled');
    return { pixel, sample };
  }

  async measure(request: Omit<MeasurementRequest, 'points'>, points: ScreenPoint[]) {
    const drawn = this.#drawn;
    const mapped = points.map(point => this.mapPoint(point));
    if (!drawn || !mapped.every(point => point !== null)) throw new RaykitError('geometry', 'Source points are outside the displayed image');
    const record = await this.session.measure({ ...request, points: mapped });
    if (drawn !== this.#drawn) throw new RaykitError('cancelled');
    return record;
  }

  close(): void {
    this.#closed = true;
    this.#resize.disconnect();
    this.#pending?.abort();
    this.#drawn = undefined;
    this.canvas.width = this.canvas.height = 1;
    this.#raster.width = this.#raster.height = 1;
    this.session.close();
  }
}
