import { RaykitError, RaykitSession, RaykitViewport } from '@vetigen/raykit-web';
import type { Measurement, MeasurementRequest, OpenOptions, PatientPlane, PixelPoint, PresentedFrame, RenderOptions, ScreenPoint, SegmentationOverlay, Source, SourceSample, Triple } from '@vetigen/raykit-web';

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
.panel-label{position:absolute;top:.35rem;left:.4rem;z-index:3;background:#101722df;padding:.1rem .4rem;pointer-events:none}
.scale{position:absolute;right:.5rem;bottom:.4rem;z-index:3;background:#101722df;padding:.25rem .5rem;pointer-events:none;max-width:80%}
.scale i{display:block;height:.4rem;background:linear-gradient(to right,black,red,yellow,white)}
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
const presets = {
  'preset:soft': { label: 'RayKit soft tissue', window: { center: 40, width: 400 } },
  'preset:bone': { label: 'RayKit bone', window: { center: 500, width: 2000 } },
  'preset:lung': { label: 'RayKit lung', window: { center: -600, width: 1500 } },
} as const;
const layers = ['length', 'angle', 'vhs', 'norberg', 'tplo', 'segmentation', 'pointer'] as const;
type Layer = typeof layers[number];
type Look = { id: string; label: string; render: RenderOptions };
const projections = { vhs: 'lateral_thorax', norberg: 'ventrodorsal_extended_hips', tplo: 'mediolateral_stifle' } as const;
const projectionLabels = { vhs: 'Lateral thorax', norberg: 'Ventrodorsal extended hips', tplo: 'Mediolateral stifle' } as const;
type Panel = { viewport: RaykitViewport; surface: HTMLElement; overlay: HTMLCanvasElement; label: HTMLElement; scale: HTMLElement; records: Measurement[];
  draft: PixelPoint[]; editing?: Measurement; generation: number; playing: boolean;
  preset?: keyof typeof presets; hidden: Set<Layer>; pointer?: { pixel: PixelPoint; frame: PresentedFrame['source'] };
  frame?: number; sliderTarget?: number;
  segmentation?: { source: SegmentationOverlay['source']; image: HTMLCanvasElement } };

export class RaykitViewer extends HTMLElement {
  readonly #root = this.attachShadow({ mode: 'open' });
  readonly #panels: Panel[] = [];
  #active = 0;
  #linkingView = false;
  #pointerTicket = 0;
  readonly #registrations = new WeakMap<RaykitSession, WeakMap<RaykitSession, string>>();
  #drag?: { panel: Panel; start: ScreenPoint; last: ScreenPoint; pointer: number; moved: boolean; landmark: number };

  connectedCallback(): void {
    if (this.#panels.length) return;
    this.#root.innerHTML = `<style>${styles}</style>
      <div class="bar" role="toolbar" aria-label="Image tools">
        <button data-action="open">Open DICOM</button><input data-file hidden type="file">
        <button data-action="new">Add panel</button><button data-action="close">Close panel</button>
        <button data-action="compare">Compare same source</button><label><input data-link type="checkbox" checked> Link views</label>
        <label>Tool <select data-tool>
          <option value="pan">Pan / zoom</option><option value="window">Window / level</option><option value="sample">Pixel value</option>
          <option value="length">Ruler</option><option value="angle">Angle</option><option value="vhs">VHS</option>
          <option value="norberg">Norberg angle</option><option value="tplo">TPLO</option>
        </select></label>
        <button data-action="zoom-in" aria-label="Zoom in">+</button><button data-action="zoom-out" aria-label="Zoom out">−</button>
        <button data-action="rotate">Rotate</button><button data-action="invert">Invert</button>
        <label>Palette <select data-palette><option value="gray">Gray</option><option value="hot">Hot</option></select></label>
        <label>Display <select data-voi></select></label>
        <details><summary>Layers</summary>
          <label><input type="checkbox" data-layer="length" checked> Ruler</label>
          <label><input type="checkbox" data-layer="angle" checked> Angle</label>
          <label><input type="checkbox" data-layer="vhs" checked> VHS</label>
          <label><input type="checkbox" data-layer="norberg" checked> Norberg</label>
          <label><input type="checkbox" data-layer="tplo" checked> TPLO</label>
          <label><input type="checkbox" data-layer="segmentation" checked> Segmentation</label>
          <label><input type="checkbox" data-layer="pointer" checked> Pointer</label>
        </details>
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
    this.#field<HTMLSelectElement>('[data-voi]').onchange = event => {
      const panel = this.#panel;
      if (panel) this.#applyLook(panel, (event.currentTarget as HTMLSelectElement).value);
    };
    this.#root.querySelectorAll<HTMLInputElement>('[data-layer]').forEach(input => {
      input.onchange = () => {
        const panel = this.#panel;
        if (!panel) return;
        const layer = input.dataset.layer as Layer;
        if (input.checked) panel.hidden.delete(layer);
        else panel.hidden.add(layer);
        this.#paint(panel);
      };
    });
    this.#field<HTMLSelectElement>('[data-palette]').onchange = event => {
      const panel = this.#panel;
      if (panel) panel.viewport.setRenderOptions({ ...panel.viewport.renderOptions, palette: (event.currentTarget as HTMLSelectElement).value === 'hot' ? 'hot' : 'gray' });
    };
    const seek = this.#field<HTMLInputElement>('[data-seek]');
    seek.oninput = () => {
      const panel = this.#panel;
      if (!panel) return;
      panel.playing = false;
      panel.sliderTarget = seek.valueAsNumber - 1;
      this.#run(Promise.all(this.#linked(panel).map(item => item.viewport.scrubFrame(panel.sliderTarget!))));
    };
    const release = () => {
      const panel = this.#panel;
      if (!panel) return;
      panel.sliderTarget = undefined;
      this.#run(Promise.all(this.#linked(panel).map(item => item.viewport.settle())));
      this.#controls();
    };
    seek.onchange = release;
    seek.onpointercancel = release;
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
  get viewports(): readonly RaykitViewport[] { return this.#panels.map(panel => panel.viewport); }
  get measurements(): readonly Measurement[] { return this.#panel?.records.map(record => structuredClone(record)) ?? []; }

  #click = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLButtonElement && target.dataset.action) this.#run(this.#action(target.dataset.action));
  };

  async open(source: Source, options: OpenOptions = {}): Promise<void> {
    const panel = this.#panel;
    if (!panel) throw new RaykitError('closed');
    const generation = ++panel.generation;
    const loading = panel.viewport.load(source, options);
    this.#status('Opening source…');
    try {
      const opened = await loading;
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

  async compare(): Promise<void> {
    const panel = this.#panel;
    const session = panel?.viewport.session;
    const frame = panel?.viewport.frame;
    if (!panel || !session || !frame || this.#panels.length >= 4) return;
    const initial = frame.views?.find(candidate => candidate.selection.kind === 'window' && candidate.selection.index === 0);
    if (initial && this.#lookId(panel) === 'default') this.#applyLook(panel, lookId(initial.selection));
    const other = this.#addPanel()!;
    const view = frame.views?.find(candidate => candidate.selection.kind === 'window' && candidate.selection.index > 0);
    await other.viewport.attach(session, {
      frame: frame.source.frame,
      view: panel.viewport.view,
      render: view ? { voi: view.selection } : {},
    });
    if (this.#panels.includes(panel) && panel.viewport.session === session && this.#panel === other) this.#select(panel);
  }

  async openPanel(source: Source, options: OpenOptions = {}): Promise<RaykitViewport> {
    const panel = this.#addPanel();
    if (!panel) throw new RaykitError('limit', 'Comparison panel count');
    await this.open(source, options);
    return panel.viewport;
  }

  /** Bind a host-verified registration to the currently authorized source revisions. */
  registerPair(left: RaykitViewport, right: RaykitViewport, registration: {
    left: { sha256: string; revision: string };
    right: { sha256: string; revision: string };
    frameOfReference: string;
  }): void {
    const a = left.session;
    const b = right.session;
    const matching = (viewport: RaykitViewport, expected: typeof registration.left) => {
      const shown = viewport.presented;
      return shown && shown.source.content_sha256 === expected.sha256 && shown.revision === expected.revision
        && shown.source.frame_of_reference_uid === registration.frameOfReference;
    };
    if (!a || !b || a === b || !registration.frameOfReference || !a.inspection.study_uid
      || a.inspection.study_uid !== b.inspection.study_uid || !matching(left, registration.left) || !matching(right, registration.right)) {
      throw new RaykitError('integrity', 'Registration does not match the displayed sources');
    }
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!this.#registrations.has(from)) this.#registrations.set(from, new WeakMap());
      this.#registrations.get(from)!.set(to, registration.frameOfReference);
    }
  }

  #linked(panel: Panel): Panel[] {
    const session = panel.viewport.session;
    return !session || !this.#field<HTMLInputElement>('[data-link]').checked ? [panel]
      : this.#panels.filter(item => item.viewport.session === session);
  }

  #looks(panel: Panel): Look[] {
    const frame = panel.viewport.frame;
    const choices: Look[] = [];
    for (const view of frame?.views ?? []) {
      choices.push({ id: lookId(view.selection), label: 'Device · ' + view.label, render: { voi: view.selection } });
    }
    if (frame?.modality_unit === 'HU') {
      for (const [id, preset] of Object.entries(presets)) choices.push({ id, label: preset.label, render: { window: preset.window } });
    }
    if (frame?.quantitative_scale) choices.push({ id: 'quantitative',
      label: frame.quantitative_scale.quantity.meaning, render: { quantitative: true } });
    return choices;
  }

  #applyLook(panel: Panel, id: string): void {
    const { palette, invert } = panel.viewport.renderOptions;
    const look = this.#looks(panel).find(choice => choice.id === id);
    if (id !== 'default' && !look) return;
    panel.preset = id in presets ? id as keyof typeof presets : undefined;
    panel.viewport.setRenderOptions({ palette, invert, ...look?.render });
  }

  #lookId(panel: Panel): string {
    const options = panel.viewport.presented?.render ?? {};
    if (options.quantitative) return 'quantitative';
    if (options.voi) return lookId(options.voi);
    if (options.window) return panel.preset ?? 'manual';
    return 'default';
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

  #addPanel(): Panel | undefined {
    if (this.#panels.length >= 4) return;
    const surface = document.createElement('div');
    surface.className = 'surface';
    surface.tabIndex = 0;
    surface.setAttribute('role', 'region');
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.setAttribute('aria-hidden', 'true');
    surface.append(overlay);
    const label = document.createElement('output');
    label.className = 'panel-label';
    label.hidden = true;
    surface.append(label);
    const scale = document.createElement('output');
    scale.className = 'scale';
    scale.hidden = true;
    surface.append(scale);
    this.#field('.grid').append(surface);
    const viewport = new RaykitViewport(surface);
    const panel: Panel = { surface, overlay, viewport, label, scale, records: [], draft: [], hidden: new Set(), generation: 0, playing: false };
    this.#panels.push(panel);
    this.#select(panel);
    viewport.addEventListener('presented', event => {
      const detail = (event as CustomEvent<PresentedFrame>).detail;
      panel.label.hidden = false;
      const series = viewport.session?.inspection.series_description;
      panel.label.textContent = (series ? series + ' · ' : '') + (this.#looks(panel).find(look => look.id === this.#lookId(panel))?.label
        ?? (detail.render.window ? 'Manual window' : 'Initial display')) + ' · ' + (detail.source.frame + 1);
      const mapping = detail.render.quantitative ? viewport.frame?.quantitative_scale : null;
      panel.scale.hidden = !mapping;
      panel.scale.replaceChildren();
      if (mapping) {
        const ramp = document.createElement('i');
        if (detail.render.invert) ramp.style.transform = 'scaleX(-1)';
        panel.scale.append(mapping.quantity.meaning, ramp, mapping.value_range.join(' – ') + ' ' + mapping.unit.value);
      }
      if (panel.frame !== detail.source.frame) {
        panel.frame = detail.source.frame;
        panel.draft = [];
        panel.editing = undefined;
        if (panel === this.#panel) this.#result('');
      }
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
        detail: { panel: this.#panels.indexOf(panel), ...detail } }));
    });
    viewport.addEventListener('viewchange', () => {
      if (this.#linkingView || panel !== this.#panel) return;
      this.#linkingView = true;
      try { for (const item of this.#linked(panel)) if (item !== panel) item.viewport.setView(viewport.view); }
      finally { this.#linkingView = false; }
    });
    viewport.addEventListener('diagnostic', event => this.#error((event as CustomEvent<RaykitError>).detail));
    viewport.addEventListener('closed', () => {
      panel.records = [];
      panel.segmentation = undefined;
      panel.pointer = undefined;
      panel.preset = undefined;
      panel.draft = [];
      panel.editing = undefined;
      panel.playing = false;
      panel.sliderTarget = undefined;
      panel.frame = undefined;
      if (this.#drag?.panel === panel) this.#drag = undefined;
      label.hidden = true;
      scale.hidden = true;
      if (panel === this.#panel) {
        this.#status('Source closed.');
        this.#result('');
        this.#controls();
      }
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
    return panel;
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
    seek.value = String((panel?.sliderTarget ?? frame ?? 0) + 1);
    this.#field('[data-count]').textContent = frame === undefined ? '—' : `${frame + 1} / ${count}`;
    for (const action of ['previous', 'next', 'play', 'zoom-in', 'zoom-out', 'rotate', 'invert', 'reset']) {
      this.#field<HTMLButtonElement>(`[data-action=${action}]`).disabled = frame === undefined || (['previous', 'next', 'play'].includes(action) && count < 2);
    }
    this.#field('[data-action=play]').textContent = panel?.playing ? 'Pause' : 'Play';
    this.#field<HTMLButtonElement>('[data-action=new]').disabled = this.#panels.length === 4;
    this.#field<HTMLButtonElement>('[data-action=compare]').disabled = frame === undefined || this.#panels.length === 4;
    this.#field<HTMLSelectElement>('[data-palette]').value = viewport?.renderOptions.palette ?? 'gray';
    const display = this.#field<HTMLSelectElement>('[data-voi]');
    display.disabled = !viewport?.frame?.display;
    display.replaceChildren(new Option('Initial display', 'default'));
    if (panel) {
      display.append(...this.#looks(panel).map(look => new Option(look.label, look.id)));
      const id = this.#lookId(panel);
      if (id === 'manual') display.append(new Option('Manual window', 'manual'));
      display.value = id;
    }
    this.#root.querySelectorAll<HTMLInputElement>('[data-layer]').forEach(input => {
      input.checked = !panel?.hidden.has(input.dataset.layer as Layer);
    });
  }

  async #action(action: string): Promise<void> {
    const panel = this.#panel;
    if (!panel) return;
    const vp = panel.viewport;
    switch (action) {
      case 'open': this.#field<HTMLInputElement>('[data-file]').click(); break;
      case 'new': this.#addPanel(); this.#panel?.surface.focus(); break;
      case 'compare': await this.compare(); break;
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
      case 'reset': panel.preset = undefined; vp.reset(); vp.setView(vp.view); break;
      case 'previous': case 'next':
        await this.#seek((vp.presented?.source.frame ?? 0) + (action === 'previous' ? -1 : 1));
        break;
      case 'play':
        if (panel.playing) { panel.playing = false; await vp.settle(); this.#controls(); break; }
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
    panel.playing = false; panel.sliderTarget = undefined;
    const index = Math.max(0, Math.min(wanted, session.inspection.frames - 1));
    const panels = this.#linked(panel);
    await Promise.all(panels.map(item => item.viewport.showFrame(index, panels.length === 1)));
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
    if (panel) {
      if (tool !== 'pan' && tool !== 'window') {
        panel.playing = false;
        this.#run(panel.viewport.settle());
        this.#controls();
      }
      panel.draft = []; panel.editing = undefined; this.#paint(panel);
    }
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
      const window = vp.renderOptions.window ?? this.#looks(panel).find(look => look.id === this.#lookId(panel))?.render.window
        ?? (display?.voi.kind === 'window' ? display.voi.window : display?.automatic_window);
      if (window) {
        panel.preset = undefined;
        vp.setRenderOptions({ ...vp.renderOptions, quantitative: undefined, voi: undefined, window: { ...window, center: window.center + dy * window.width / 220,
          width: Math.max((window.function ?? 'linear') === 'linear' ? 1 : 0.01, window.width * Math.exp(dx * 0.01)) } });
      }
    }
  }

  async #pointerUp(panel: Panel, event: PointerEvent): Promise<void> {
    const drag = this.#drag;
    this.#drag = undefined;
    const viewport = panel.viewport;
    const session = viewport.session;
    if (drag?.panel !== panel || drag.pointer !== event.pointerId || !session || !viewport.presented) return;
    const tool = this.#tool;
    if (tool === 'pan' || tool === 'window' || (drag.moved && drag.landmark < 0)) return;
    const before = viewport.presented.source.frame;
    await viewport.settle();
    if (viewport.session !== session || tool !== this.#tool || !viewport.presented) return;
    const index = viewport.presented.source.frame;
    if (drag.landmark >= 0 && index !== before) return;
    const { pixel, patient } = await viewport.mapPoint(this.#point(panel, event));
    const format = viewport.frame?.format;
    if (tool !== this.#tool || !pixel || !format || pixel.x < -0.5 || pixel.y < -0.5 || pixel.x >= format.columns - 0.5 || pixel.y >= format.rows - 0.5) return;
    if (tool === 'sample') {
      const ticket = ++this.#pointerTicket;
      const targets = this.#linked(panel).filter(item => item.viewport.presented?.source.frame === index).map(item => ({ item, pixel }));
      const plane = viewport.frame?.geometry.patient_plane;
      const anchor = viewport.presented;
      if (patient && plane && this.#field<HTMLInputElement>('[data-link]').checked) {
        for (const item of this.#panels) {
          const other = item.viewport.session;
          const space = other && this.#registrations.get(session)?.get(other);
          if (!other || !space) continue;
          const match = await other.locatePatient(patient, space, planeNormal(plane));
          if (ticket !== this.#pointerTicket || anchor !== viewport.presented || item.viewport.session !== other) return;
          if (!match) { item.pointer = undefined; this.#paint(item); continue; }
          if (item.viewport.presented?.source.frame !== match.frame) await item.viewport.showFrame(match.frame, false);
          if (ticket !== this.#pointerTicket || anchor !== viewport.presented || item.viewport.session !== other) return;
          targets.push({ item, pixel: match.pixel });
        }
      }
      const results = await Promise.all(targets.map(async target => {
        const actual = target.item.viewport.presented!;
        const value = await target.item.viewport.session!.sampleAt(actual.source.frame, Math.round(target.pixel.x), Math.round(target.pixel.y));
        return { ...target, actual, value };
      }));
      if (ticket !== this.#pointerTicket || results.some(({item, actual}) => item.viewport.presented !== actual)) return;
      for (const { item, actual, pixel } of results) {
        item.pointer = { pixel, frame: actual.source };
        this.#paint(item);
      }
      this.#result(results.map(({ item, value }) => `Panel ${this.#panels.indexOf(item) + 1} · ${sampleText(value)}`).join('\n'));
      return;
    }
    if (drag.landmark < 0) panel.draft.push(pixel);
    else panel.draft[drag.landmark] = pixel;
    this.#paint(panel);
    if (panel.editing && drag.moved) await this.#commit(panel);
  }

  async #commit(panel: Panel): Promise<void> {
    const tool = this.#tool as keyof typeof methods;
    await panel.viewport.settle();
    if (this.#tool !== tool) return;
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
    if (!panel.hidden.has('segmentation') && segmentation?.source.frame === source.frame && segmentation.source.content_sha256 === source.content_sha256) {
      const { origin, x_axis: a, y_axis: b } = transform;
      ctx.save(); ctx.transform(a[0], a[1], b[0], b[1], origin.x, origin.y);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(segmentation.image, -0.5, -0.5);
      ctx.restore();
    }
    const count = (point: PixelPoint) => project(presented, point);
    const pointer = panel.pointer;
    if (!panel.hidden.has('pointer') && pointer?.frame.frame === source.frame && pointer.frame.content_sha256 === source.content_sha256) {
      const { x, y } = count(pointer.pixel);
      ctx.strokeStyle = '#f4dc97'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 2]); ctx.beginPath();
      ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke(); ctx.setLineDash([]);
    }
    const draftTool = this.#tool;
    const visible = (r: Measurement) => r.source.frame === source.frame && r.source.content_sha256 === source.content_sha256
      && !layers.some(layer => panel.hidden.has(layer) && r.input.method === methods[layer as keyof typeof methods]?.[0]);
    const paths = panel.records.filter(r => visible(r) && r.input.id !== panel.editing?.input.id)
      .map(r => ({ points: r.input.points.map(count), method: r.input.method, color: '#62ccbb',
        label: (Object.keys(methods).find(key => methods[key as keyof typeof methods][0] === r.input.method) ?? r.input.method)
          + ' · ' + r.values.map(value => Number(value.value.toFixed(2)) + ' ' + value.unit).join(' / ') }));
    if (draftTool in methods && panel.draft.length) paths.push({ points: panel.draft.map(count), method: methods[draftTool as keyof typeof methods][0], color: '#ffdc7e', label: '' });
    for (const { points, method, color, label } of paths) {
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
      if (label && points[0]) {
        ctx.font = '12px system-ui, sans-serif';
        ctx.strokeStyle = '#07131a'; ctx.lineWidth = 3;
        ctx.strokeText(label, points[0].x + 8, points[0].y - 7);
        ctx.fillText(label, points[0].x + 8, points[0].y - 7);
      }
    }
    for (const record of panel.records) {
      if (!visible(record) || record.input.method !== methods.tplo[0] || record.calibration.kind !== 'projection') continue;
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

function lookId(voi: NonNullable<RenderOptions['voi']>): string { return voi.kind + ':' + voi.index; }

function sampleText({ sample, modality_unit: unit, quantitative, doppler_axes: axes }: SourceSample): string {
  const value = sample.kind === 'color' ? sample.space + ' ' + sample.values.join(', ')
    : sample.padding ? 'Padding · stored ' + sample.stored
    : 'Stored ' + sample.stored + ' · ' + sample.modality + (unit ? ' ' + unit : ' modality');
  return value + (quantitative ? ' · ' + quantitative.quantity.meaning + ' ' + quantitative.value + ' ' + quantitative.unit.value : '')
    + (axes ? ' · Spectral axis ' + axes.spectral + ' ' + axes.spectral_unit + ' at ' + axes.time + ' s' : '');
}

function planeNormal(plane: PatientPlane): Triple {
  const [a, b, c] = plane.column_axis, [d, e, f] = plane.row_axis;
  return [b * f - c * e, c * d - a * f, a * e - b * d];
}

function project(presented: PresentedFrame, point: PixelPoint): ScreenPoint {
  const { origin, x_axis: x, y_axis: y } = presented.transform;
  return { x: origin.x + point.x * x[0] + point.y * y[0], y: origin.y + point.x * x[1] + point.y * y[1] };
}

export function registerRaykitViewer(): void {
  if (!customElements.get('raykit-viewer')) customElements.define('raykit-viewer', RaykitViewer);
}

declare global { interface HTMLElementTagNameMap { 'raykit-viewer': RaykitViewer } }
