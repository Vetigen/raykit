import { RaykitError, RaykitViewport } from '@raykit/web';
import type { Measurement, MeasurementRequest, OpenOptions, PixelPoint, PresentedFrame, ScreenPoint, SegmentationOverlay, Source } from '@raykit/web';

const styles = `
:host{display:block;min-height:30rem;font:14px/1.5 system-ui,sans-serif;color:#e9edf4;background:#11151c;color-scheme:dark}
*{box-sizing:border-box}button,select,input{font:inherit}button,select{padding:.3rem .6rem;color:inherit;background:#202a39;border:1px solid #54627a;border-radius:.3rem}
button:not(:disabled){cursor:pointer}button:disabled,select:disabled,input:disabled{opacity:.45}
.bar,.readout,.cine,.method{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.55rem .8rem;background:#151d28}
.bar{border-bottom:1px solid #29374a}.method:empty{display:none}.cine input[type=range]{width:min(40%,20rem);accent-color:#62ccbb}
.grid{display:grid;gap:2px;background:#15232b;min-height:24rem;height:var(--raykit-height, min(65vh, 42rem));grid-template-rows:minmax(0,1fr)}
.grid[data-panels='2'],.grid[data-panels='3'],.grid[data-panels='4']{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid[data-panels='3'],.grid[data-panels='4']{grid-template-rows:repeat(2,minmax(0,1fr))}
.surface{position:relative;min-width:0;min-height:0;overflow:hidden;isolation:isolate;background:#020307;touch-action:none;outline:0;border:1px solid #263748}
.surface[data-active='true']{border-color:#62ccbb}.surface:focus-visible{box-shadow:inset 0 0 0 2px #62ccbb}
.overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}.count{font-variant-numeric:tabular-nums}
output{white-space:pre-wrap}.error{color:#ffb6ab}input[type=number]{width:6rem}
`;

const methods = {
  length: ['raykit:length', 'Start, end'],
  angle: ['raykit:angle', 'Arm 1, vertex, arm 2'],
  vhs: ['raykit:canine-vhs', 'Long axis base and apex, short axis ends, cranial T4 and subsequent cranial margins'],
  norberg: ['raykit:norberg', 'Left and right head centers, left and right cranial effective rims'],
  tplo: ['raykit:tplo', 'Cranial and caudal medial plateau, proximal and distal mechanical axis, osteotomy center'],
} as const;
type Tool = keyof typeof methods | 'pan' | 'window' | 'sample';
const projections = { vhs: 'lateral_thorax', norberg: 'ventrodorsal_extended_hips', tplo: 'mediolateral_stifle' } as const;
const projectionLabels = { vhs: 'Lateral thorax', norberg: 'Ventrodorsal extended hips', tplo: 'Mediolateral stifle' } as const;
type Panel = { viewport: RaykitViewport; surface: HTMLElement; overlay: HTMLCanvasElement; records: Measurement[];
  draft: PixelPoint[]; editing?: Measurement; generation: number; playing: boolean;
  segmentation?: { source: SegmentationOverlay['source']; image: HTMLCanvasElement } };

export class RaykitViewer extends HTMLElement {
  readonly #root = this.attachShadow({ mode: 'open' });
  readonly #panels: Panel[] = [];
  #active = 0;
  #drag?: { panel: Panel; start: ScreenPoint; last: ScreenPoint; pointer: number; moved: boolean; landmark: number };

  connectedCallback(): void {
    if (this.#panels.length) return;
    this.#root.innerHTML = `<style>${styles}</style>
      <div class="bar" role="toolbar" aria-label="Image tools">
        <button data-action="open">Open DICOM</button><input data-file hidden type="file">
        <button data-action="new">Add panel</button><button data-action="close">Close panel</button>
        <label>Tool <select data-tool>
          <option value="pan">Pan / zoom</option><option value="window">Window / level</option><option value="sample">Pixel value</option>
          <option value="length">Ruler</option><option value="angle">Angle</option><option value="vhs">VHS</option>
          <option value="norberg">Norberg angle</option><option value="tplo">TPLO</option>
        </select></label>
        <button data-action="zoom-in" aria-label="Zoom in">+</button><button data-action="zoom-out" aria-label="Zoom out">−</button>
        <button data-action="rotate">Rotate</button><button data-action="invert">Invert</button>
        <label>Palette <select data-palette><option value="gray">Gray</option><option value="hot">Hot</option></select></label>
        <button data-action="reset">Reset view</button>
      </div>
      <div class="method" data-method></div>
      <div class="grid"></div>
      <div class="cine" role="group" aria-label="Frame navigation">
        <button data-action="previous" aria-label="Previous frame">◀</button><button data-action="play">Play</button>
        <button data-action="next" aria-label="Next frame">▶</button><input data-seek aria-label="Frame number" type="range" min="1" max="1" value="1">
        <output class="count" data-count>—</output>
        <label>Speed <select data-speed><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label>
      </div>
      <div class="readout"><output data-status aria-live="polite">Choose a local DICOM file.</output><output data-result aria-live="polite"></output></div>`;
    this.#root.addEventListener('click', this.#click);
    this.#field<HTMLInputElement>('[data-file]').onchange = event => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.#run(this.open(file));
      input.value = '';
    };
    this.#field<HTMLSelectElement>('[data-tool]').onchange = () => this.#method();
    this.#field<HTMLSelectElement>('[data-palette]').onchange = event => {
      const panel = this.#panel;
      if (panel) panel.viewport.setRenderOptions({ ...panel.viewport.renderOptions, palette: (event.currentTarget as HTMLSelectElement).value === 'hot' ? 'hot' : 'gray' });
    };
    this.#field<HTMLInputElement>('[data-seek]').oninput = event => this.#run(this.#seek(Number((event.currentTarget as HTMLInputElement).value) - 1));
    this.#addPanel();
    this.#controls();
  }

  disconnectedCallback(): void {
    for (const panel of this.#panels.splice(0)) panel.viewport.dispose();
    this.#drag = undefined;
    this.#active = 0;
  }

  get #panel(): Panel | undefined { return this.#panels[this.#active]; }
  get viewport(): RaykitViewport | undefined { return this.#panel?.viewport; }
  get measurements(): readonly Measurement[] { return this.#panel?.records.map(record => structuredClone(record)) ?? []; }

  #click = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLButtonElement && target.dataset.action) this.#run(this.#action(target.dataset.action));
  };

  async open(source: Source, options: OpenOptions = {}): Promise<void> {
    const panel = this.#panel;
    if (!panel) throw new RaykitError('closed');
    const generation = ++panel.generation;
    panel.records = [];
    panel.segmentation = undefined;
    panel.draft = [];
    panel.editing = undefined;
    panel.playing = false;
    this.#status('Opening source…');
    this.#result('');
    this.#controls();
    try {
      const opened = await panel.viewport.load(source, options);
      if (generation !== panel.generation || panel !== this.#panel) return;
      const info = opened.inspection;
      if (!info.capabilities.frame_access) {
        this.#status(info.capabilities.host_document ? 'Document ready for the host PDF viewer.' : (info.capabilities.frame_limitation ?? 'Frame access unavailable.'));
        if (info.capabilities.host_document) this.dispatchEvent(new CustomEvent('raykit-document', { detail: { session: opened } }));
      }
    } finally {
      if (generation === panel.generation) { this.#controls(); this.#paint(panel); }
    }
  }

  async restoreMeasurement(record: Measurement): Promise<Measurement> {
    const panel = this.#panel;
    const session = panel?.viewport.session;
    if (!panel || !session) throw new RaykitError('closed');
    const actual = await session.reopenMeasurement(record);
    if (session !== panel.viewport.session) throw new RaykitError('cancelled');
    await this.#seek(actual.source.frame, panel);
    if (session !== panel.viewport.session) throw new RaykitError('cancelled');
    panel.records = [...panel.records.filter(r => r.input.id !== actual.input.id), actual];
    this.#paint(panel);
    this.#reportMeasurement(actual);
    return actual;
  }

  setSegmentation(segmentation: SegmentationOverlay): void {
    const panel = this.#panel;
    const frame = panel?.viewport.frame;
    const [w, h] = segmentation.dimensions;
    if (!panel || !frame || segmentation.source.content_sha256 !== frame.source.content_sha256
      || segmentation.source.instance_uid !== frame.source.instance_uid || segmentation.source.frame !== frame.source.frame
      || w !== frame.format.columns || h !== frame.format.rows || segmentation.mask.byteLength !== w * h) {
      throw new RaykitError('integrity', 'Segmentation does not match the active source frame');
    }
    if (w * h > 4 * 1024 * 1024) throw new RaykitError('limit', 'Overlay pixels');
    const image = document.createElement('canvas');
    image.width = w; image.height = h;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < segmentation.mask.length; i++) if (segmentation.mask[i]) rgba.set([66, 220, 190, 135], i * 4);
    image.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
    panel.segmentation = { source: segmentation.source, image };
    this.#paint(panel);
  }

  #field<T extends HTMLElement>(selector: string): T { return this.#root.querySelector<T>(selector)!; }
  get #tool(): Tool { return this.#field<HTMLSelectElement>('[data-tool]').value as Tool; }

  #addPanel(): void {
    if (this.#panels.length >= 4) return;
    const surface = document.createElement('div');
    surface.className = 'surface';
    surface.tabIndex = 0;
    surface.setAttribute('role', 'region');
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.setAttribute('aria-hidden', 'true');
    surface.append(overlay);
    this.#field('.grid').append(surface);
    const viewport = new RaykitViewport(surface);
    const panel: Panel = { surface, overlay, viewport, records: [], draft: [], generation: 0, playing: false };
    this.#panels.push(panel);
    this.#select(panel);
    viewport.addEventListener('presented', event => {
      this.#paint(panel);
      if (panel === this.#panel) {
        const frame = viewport.frame;
        const geometry = frame?.geometry;
        const orientation = geometry?.increasing_column && geometry.increasing_row
          ? `Columns ${geometry.increasing_column.join('/')}, rows ${geometry.increasing_row.join('/')}.` : 'Orientation unavailable.';
        const calibrated = !geometry || geometry.calibration.kind === 'none' ? ' Physical calibration unavailable.' : '';
        this.#status(`Original · ${frame?.format.columns} × ${frame?.format.rows} · ${orientation}${calibrated}`);
        this.#controls();
      }
    this.dispatchEvent(new CustomEvent('raykit-presented', { bubbles: true, composed: true,
      detail: { panel: this.#panels.indexOf(panel), ...(event as CustomEvent<PresentedFrame>).detail } }));
    });
    viewport.addEventListener('diagnostic', event => this.#error((event as CustomEvent<RaykitError>).detail));
    viewport.addEventListener('closed', () => {
      this.#paint(panel);
      this.dispatchEvent(new CustomEvent('raykit-closed', { detail: { panel: this.#panels.indexOf(panel) } }));
    });
    surface.onpointerdown = event => this.#pointerDown(panel, event);
    surface.onpointermove = event => this.#pointerMove(panel, event);
    surface.onpointerup = event => this.#run(this.#pointerUp(panel, event));
    surface.onpointercancel = () => { this.#drag = undefined; };
    surface.onfocus = () => this.#select(panel);
    surface.addEventListener('wheel', event => {
      if (!viewport.presented) return;
      event.preventDefault();
      this.#select(panel);
      viewport.setView({ ...viewport.view, zoom: viewport.view.zoom * Math.exp(-event.deltaY * 0.002) });
    }, { passive: false });
    surface.onkeydown = event => {
      const actions: Record<string, string> = { ArrowLeft: 'previous', ArrowRight: 'next', '+': 'zoom-in', '-': 'zoom-out', r: 'rotate', Escape: 'undo' };
      const action = actions[event.key];
      if (action) { event.preventDefault(); this.#run(this.#action(action)); }
    };
  }

  #select(panel: Panel): void {
    this.#active = this.#panels.indexOf(panel);
    this.#panels.forEach((item, index) => {
      item.surface.dataset.active = String(item === panel);
      item.surface.setAttribute('aria-label', `Image panel ${index + 1}`);
    });
    this.#field('.grid').dataset.panels = String(this.#panels.length);
    this.#controls();
  }

  #controls(): void {
    const panel = this.#panel;
    const viewport = panel?.viewport;
    const frame = viewport?.presented?.source.frame;
    const count = viewport?.session?.inspection.frames ?? 0;
    const seek = this.#field<HTMLInputElement>('[data-seek]');
    seek.disabled = frame === undefined || count < 2;
    seek.max = String(Math.max(count, 1));
    seek.value = String((frame ?? 0) + 1);
    this.#field('[data-count]').textContent = frame === undefined ? '—' : `${frame + 1} / ${count}`;
    for (const action of ['previous', 'next', 'play', 'zoom-in', 'zoom-out', 'rotate', 'invert', 'reset']) {
      this.#field<HTMLButtonElement>(`[data-action=${action}]`).disabled = frame === undefined || (['previous', 'next', 'play'].includes(action) && count < 2);
    }
    this.#field('[data-action=play]').textContent = panel?.playing ? 'Pause' : 'Play';
    this.#field<HTMLButtonElement>('[data-action=new]').disabled = this.#panels.length === 4;
    this.#field<HTMLSelectElement>('[data-palette]').value = viewport?.renderOptions.palette ?? 'gray';
  }

  async #action(action: string): Promise<void> {
    const panel = this.#panel;
    if (!panel) return;
    const vp = panel.viewport;
    switch (action) {
      case 'open': this.#field<HTMLInputElement>('[data-file]').click(); break;
      case 'new': this.#addPanel(); this.#panel?.surface.focus(); break;
      case 'close':
        panel.generation++;
        vp.dispose();
        panel.surface.remove();
        this.#panels.splice(this.#active, 1);
        if (this.#panels.length === 0) this.#addPanel();
        else this.#select(this.#panels[Math.min(this.#active, this.#panels.length - 1)]);
        this.#result('');
        break;
      case 'zoom-in': case 'zoom-out': vp.setView({ ...vp.view, zoom: vp.view.zoom * (action === 'zoom-in' ? 1.25 : 0.8) }); break;
      case 'rotate': vp.setView({ ...vp.view, quarter_turns: vp.view.quarter_turns + 1 }); break;
      case 'invert': vp.setRenderOptions({ ...vp.renderOptions, invert: !vp.renderOptions.invert }); break;
      case 'reset': vp.reset(); break;
      case 'previous': case 'next':
        await this.#seek((vp.presented?.source.frame ?? 0) + (action === 'previous' ? -1 : 1));
        break;
      case 'play':
        if (panel.playing) { panel.playing = false; vp.pause(); this.#controls(); break; }
        panel.playing = true; this.#controls();
        try { await vp.play(Number(this.#field<HTMLSelectElement>('[data-speed]').value)); }
        finally { panel.playing = false; this.#controls(); }
        break;
      case 'undo': panel.draft.pop(); this.#paint(panel); break;
      case 'measure': await this.#commit(panel); break;
      case 'export': this.#save(panel); break;
      case 'import': this.#field<HTMLInputElement>('[data-record]').click(); break;
    }
  }

  async #seek(wanted: number, panel = this.#panel): Promise<void> {
    const session = panel?.viewport.session;
    if (!panel || !session) return;
    panel.playing = false; panel.viewport.pause(); panel.draft = []; panel.editing = undefined;
    await panel.viewport.showFrame(Math.max(0, Math.min(wanted, session.inspection.frames - 1)));
  }

  #method(): void {
    const tool = this.#tool;
    const bar = this.#field('[data-method]');
    if (tool in methods) {
      const [, landmarks] = methods[tool as keyof typeof methods];
      bar.innerHTML = `<span>${landmarks}</span>${tool in projections ? `<label><input data-confirm type="checkbox"> Confirm ${projectionLabels[tool as keyof typeof projections]}</label>` : ''}
        ${tool === 'tplo' ? '<label>Target angle (°) <input data-target type="number" step="any"></label><label>Radius (mm) <input data-radius type="number" min="0" step="any"></label>' : ''}
        <button data-action="undo">Undo point</button><button data-action="measure">Calculate</button>
        <button data-action="export">Export measures</button><button data-action="import">Import measures</button><input type="file" hidden data-record accept="application/json,.json">`;
      this.#field<HTMLInputElement>('[data-record]').onchange = event => this.#run(this.#readRecords(event.currentTarget as HTMLInputElement));
    } else { bar.replaceChildren(); }
    const panel = this.#panel;
    if (panel) { panel.draft = []; panel.editing = undefined; this.#paint(panel); }
  }

  #point(panel: Panel, event: PointerEvent): ScreenPoint {
    const bounds = panel.surface.getBoundingClientRect();
    return { x: event.clientX - bounds.left - panel.surface.clientLeft, y: event.clientY - bounds.top - panel.surface.clientTop };
  }

  #pointerDown(panel: Panel, event: PointerEvent): void {
    if (event.button !== 0) return;
    this.#select(panel);
    if (!panel.viewport.presented) return;
    const p = this.#point(panel, event);
    let landmark = -1;
    if (this.#tool in methods) {
      const projected = (pixel: PixelPoint) => project(panel.viewport.presented!, pixel);
      const latest = [...panel.records].reverse().find(record => record.source.frame === panel.viewport.presented?.source.frame
        && record.input.method === methods[this.#tool as keyof typeof methods][0]);
      if (panel.draft.length === 0 && latest) {
        landmark = latest.input.points.findIndex(pixel => near(p, projected(pixel)));
        if (landmark >= 0) { panel.editing = latest; panel.draft = [...latest.input.points]; }
      } else landmark = panel.draft.findIndex(pixel => near(p, projected(pixel)));
    }
    this.#drag = { panel, start: p, last: p, pointer: event.pointerId, moved: false, landmark };
    panel.surface.setPointerCapture(event.pointerId);
  }

  #pointerMove(panel: Panel, event: PointerEvent): void {
    const drag = this.#drag;
    if (drag?.panel !== panel || drag.pointer !== event.pointerId) return;
    const p = this.#point(panel, event), vp = panel.viewport;
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    drag.last = p;
    drag.moved ||= Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3;
    if (this.#tool === 'pan') vp.setView({ ...vp.view, pan: [vp.view.pan[0] + dx, vp.view.pan[1] + dy] });
    if (this.#tool === 'window') {
      const display = vp.frame?.display;
      const window = vp.renderOptions.window ?? (display?.voi.kind === 'window' ? display.voi.window : display?.automatic_window);
      if (window) vp.setRenderOptions({ ...vp.renderOptions, window: { ...window, center: window.center + dy * window.width / 220,
        width: Math.max((window.function ?? 'linear') === 'linear' ? 1 : 0.01, window.width * Math.exp(dx * 0.01)) } });
    }
  }

  async #pointerUp(panel: Panel, event: PointerEvent): Promise<void> {
    const drag = this.#drag;
    this.#drag = undefined;
    const viewport = panel.viewport;
    const session = viewport.session;
    if (drag?.panel !== panel || drag.pointer !== event.pointerId || !session || !viewport.presented) return;
    const tool = this.#tool;
    const index = viewport.presented.source.frame;
    if (tool === 'pan' || tool === 'window' || (drag.moved && drag.landmark < 0)) return;
    const { pixel } = await viewport.mapPoint(this.#point(panel, event));
    const format = viewport.frame?.format;
    if (tool !== this.#tool || !pixel || !format || pixel.x < -0.5 || pixel.y < -0.5 || pixel.x >= format.columns - 0.5 || pixel.y >= format.rows - 0.5) return;
    if (tool === 'sample') {
      const sample = await session.sample(index, Math.round(pixel.x), Math.round(pixel.y));
      if (session !== viewport.session || index !== viewport.presented?.source.frame) return;
      this.#result(sample.kind === 'monochrome' ? `Stored ${sample.stored}, modality ${sample.modality}${sample.padding ? ' (padding)' : ''}` : `${sample.space} ${sample.values.join(', ')}`);
      return;
    }
    if (drag.landmark < 0) panel.draft.push(pixel);
    else panel.draft[drag.landmark] = pixel;
    this.#paint(panel);
    if (panel.editing && drag.moved) await this.#commit(panel);
  }

  async #commit(panel: Panel): Promise<void> {
    const tool = this.#tool as keyof typeof methods;
    const frame = panel.viewport.presented;
    const session = panel.viewport.session;
    if (!frame || !session || !(tool in methods)) return;
    const previous = panel.editing;
    const input: MeasurementRequest = { id: previous?.input.id ?? crypto.randomUUID(), method: methods[tool][0], version: 1, points: [...panel.draft] };
    if (tool in projections) {
      if (previous?.input.parameters) input.parameters = previous.input.parameters;
      else {
        if (!this.#field<HTMLInputElement>('[data-confirm]').checked) throw new RaykitError('geometry', 'Confirm the projection for these landmarks');
        input.parameters = { projection: projections[tool as keyof typeof projections] };
        if (tool === 'tplo') {
          input.parameters.target_deg = this.#field<HTMLInputElement>('[data-target]').valueAsNumber;
          input.parameters.radius_mm = this.#field<HTMLInputElement>('[data-radius]').valueAsNumber;
        }
      }
    }
    const measurement = await session.measure(frame.source.frame, input);
    if (session !== panel.viewport.session || frame.source.frame !== panel.viewport.presented?.source.frame) return;
    panel.records = [...panel.records.filter(r => r.input.id !== input.id), measurement];
    panel.draft = []; panel.editing = undefined;
    this.#reportMeasurement(measurement);
    this.#paint(panel);
  }

  #reportMeasurement(measurement: Measurement): void {
    this.#result(measurement.values.map(v => `${v.name.replaceAll('_', ' ')} ${Number(v.value.toFixed(2))} ${v.unit}`).join(' · '));
    this.dispatchEvent(new CustomEvent('raykit-measurement', { detail: structuredClone(measurement) }));
  }

  #paint(panel: Panel): void {
    const canvas = panel.overlay;
    const ratio = Math.min(devicePixelRatio || 1, 4096 / Math.max(panel.surface.clientWidth, panel.surface.clientHeight, 1));
    const width = Math.max(1, Math.round(panel.surface.clientWidth * ratio));
    const height = Math.max(1, Math.round(panel.surface.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    const presented = panel.viewport.presented;
    if (!ctx) return;
    ctx.resetTransform();
    ctx.clearRect(0, 0, width, height);
    if (!presented) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const { source, transform } = presented;
    const segmentation = panel.segmentation;
    if (segmentation?.source.frame === source.frame && segmentation.source.content_sha256 === source.content_sha256) {
      const { origin, x_axis: a, y_axis: b } = transform;
      ctx.save(); ctx.transform(a[0], a[1], b[0], b[1], origin.x, origin.y);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(segmentation.image, -0.5, -0.5);
      ctx.restore();
    }
    const count = (point: PixelPoint) => project(presented, point);
    const draftTool = this.#tool;
    const paths = panel.records.filter(r => r.source.frame === presented.source.frame && r.input.id !== panel.editing?.input.id)
      .map(r => ({ points: r.input.points.map(count), method: r.input.method, color: '#62ccbb' }));
    if (draftTool in methods && panel.draft.length) paths.push({ points: panel.draft.map(count), method: methods[draftTool as keyof typeof methods][0], color: '#ffdc7e' });
    for (const { points, method, color } of paths) {
      ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 2;
      const segments = method === methods.norberg[0] ? [[0, 1], [0, 2], [1, 3]]
        : method === methods.vhs[0] ? [[0, 1], [2, 3], points.slice(4).map((_, i) => i + 4)]
        : method === methods.tplo[0] ? [[0, 1], [2, 3]] : [points.map((_, i) => i)];
      for (const segment of segments) {
        ctx.beginPath();
        for (const i of segment) if (points[i]) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }
      for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
    }
    for (const record of panel.records) {
      if (record.source.frame !== source.frame || record.input.method !== methods.tplo[0] || record.calibration.kind !== 'projection') continue;
      const center = record.input.points[4];
      const radius = record.values.find(v => v.name === 'radius')?.value;
      if (!center || !radius) continue;
      const [sx, sy] = record.calibration.spacing_xy;
      const { origin, x_axis: a, y_axis: b } = transform;
      ctx.save(); ctx.transform(a[0], a[1], b[0], b[1], origin.x, origin.y);
      ctx.strokeStyle = '#62ccbb'; ctx.lineWidth = 0.25;
      ctx.beginPath(); ctx.ellipse(center.x, center.y, radius / sx, radius / sy, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }

  #save(panel: Panel): void {
    if (panel.records.length === 0) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(panel.records, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'raykit-measurements.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async #readRecords(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 128 * 1024) throw new RaykitError('limit', 'Measurement file bytes');
    let records: Measurement[];
    try { records = JSON.parse(await file.text()) as Measurement[]; }
    catch { throw new RaykitError('invalid_request', 'Measurement JSON'); }
    if (!Array.isArray(records) || records.length > 128) throw new RaykitError('invalid_request', 'Measurement list');
    for (const record of records) await this.restoreMeasurement(record);
  }

  #run(task: Promise<unknown>): void { void task.catch(error => this.#error(error)); }
  #status(text: string, error = false): void { const el = this.#field('[data-status]'); el.textContent = text; el.className = error ? 'error' : ''; }
  #result(text: string): void { this.#field('[data-result]').textContent = text; }
  #error(error: unknown): void {
    if (error instanceof RaykitError && ['cancelled', 'closed'].includes(error.code)) return;
    this.#status(error instanceof RaykitError ? error.message : 'Viewer operation failed.', true);
    this.dispatchEvent(new CustomEvent('raykit-error', { detail: error }));
  }
}

function near(a: ScreenPoint, b: ScreenPoint): boolean { return Math.hypot(a.x - b.x, a.y - b.y) <= 12; }

function project(presented: PresentedFrame, point: PixelPoint): ScreenPoint {
  const { origin, x_axis: x, y_axis: y } = presented.transform;
  return { x: origin.x + point.x * x[0] + point.y * y[0], y: origin.y + point.x * x[1] + point.y * y[1] };
}

export function registerRaykitViewer(): void {
  if (!customElements.get('raykit-viewer')) customElements.define('raykit-viewer', RaykitViewer);
}

declare global { interface HTMLElementTagNameMap { 'raykit-viewer': RaykitViewer } }
