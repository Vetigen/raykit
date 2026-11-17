import type { RenderOptions, SourceReference } from './types.js';
import type { PresentedFrame, RaykitViewport, ViewSettings } from './viewport.js';

export interface SharedViewEvent {
  version: 1;
  origin: string;
  sequence: number;
  source: SourceReference;
  revision: string;
  view: ViewSettings;
  render: RenderOptions;
}

export class SharedView extends EventTarget {
  #localSequence = 0;
  #inbound = 0;
  #applied = new Map<string, number>();
  #pending = new Map<string, number>();
  #latestRemote?: string;
  #lastSent?: string;
  #applying?: number;
  #closed = false;

  constructor(readonly viewport: RaykitViewport, readonly origin: string, readonly canAccess: (event: SharedViewEvent) => Promise<boolean>) {
    super();
    viewport.addEventListener('presented', this.#presented);
  }

  #presented = (event: Event) => {
    if (this.#closed || this.#applying !== undefined) return;
    const presented = (event as CustomEvent<PresentedFrame>).detail;
    const { viewport: _, ...view } = presented.view;
    const outgoing: SharedViewEvent = { version: 1, origin: this.origin, sequence: ++this.#localSequence,
      source: presented.source, revision: presented.revision, view, render: presented.render };
    const key = state(outgoing);
    if (key === this.#latestRemote || key === this.#lastSent) return;
    this.#lastSent = key;
    this.dispatchEvent(new CustomEvent('view', { detail: outgoing }));
  };

  async apply(wanted: SharedViewEvent): Promise<boolean> {
    if (this.#closed || !valid(wanted) || wanted.origin === this.origin
      || (this.#applied.get(wanted.origin) ?? 0) >= wanted.sequence
      || (this.#pending.get(wanted.origin) ?? 0) >= wanted.sequence
      || (!this.#applied.has(wanted.origin) && this.#applied.size >= 64)) return false;
    const event = structuredClone(wanted);
    const session = this.viewport.session;
    if (!session || session.revision !== event.revision || session.inspection.instance_uid !== event.source.instance_uid
      || session.inspection.sop_class_uid !== event.source.sop_class_uid
      || session.inspection.content_sha256 !== event.source.content_sha256
      || event.source.frame >= session.inspection.frames) return false;
    const generation = ++this.#inbound;
    this.#pending.set(event.origin, event.sequence);
    try {
      if (!await this.canAccess(event) || this.#closed || generation !== this.#inbound || session !== this.viewport.session) return false;
      const key = state(event);
      if (this.#latestRemote === key || this.#lastSent === key) { this.#applied.set(event.origin, event.sequence); return false; }
      this.#applying = generation;
      this.viewport.pause();
      await this.viewport.showFrame(event.source.frame, false, { view: event.view, render: event.render });
      if (this.#closed || generation !== this.#inbound || session !== this.viewport.session) return false;
      this.#latestRemote = key;
      this.#applied.set(event.origin, event.sequence);
      return true;
    } finally {
      if (this.#applying === generation) this.#applying = undefined;
      if (this.#pending.get(event.origin) === event.sequence) this.#pending.delete(event.origin);
    }
  }

  close(): void { this.#closed = true; this.#inbound++; this.viewport.removeEventListener('presented', this.#presented); }
}

function state(event: SharedViewEvent): string {
  const window = event.render.window;
  return JSON.stringify([event.source.instance_uid, event.revision, event.source.content_sha256, event.source.frame,
    event.view.pan, event.view.zoom, event.view.quarter_turns, event.render.invert ?? false, event.render.palette ?? 'gray',
    window ? [window.center, window.width, window.function ?? 'linear'] : null,
    event.render.voi ? [event.render.voi.kind, event.render.voi.index] : null, event.render.quantitative ?? false]);
}

function valid(event: SharedViewEvent): boolean {
  const { view, source, render } = event;
  const window = render?.window;
  const voi = render?.voi;
  return event.version === 1 && typeof event.origin === 'string' && event.origin.length > 0 && event.origin.length <= 128
    && Number.isSafeInteger(event.sequence) && event.sequence > 0 && !!source && Number.isSafeInteger(source.frame) && source.frame >= 0
    && Array.isArray(view?.pan) && view.pan.length === 2 && view.pan.every(Number.isFinite)
    && Number.isFinite(view.zoom) && view.zoom >= 0.01 && view.zoom <= 128
    && Number.isInteger(view.quarter_turns) && view.quarter_turns >= 0 && view.quarter_turns <= 3
    && !!render && (!window || !voi && Number.isFinite(window.center) && Number.isFinite(window.width) && window.width > 0)
    && (!voi || ['window', 'lut'].includes(voi.kind) && Number.isSafeInteger(voi.index) && voi.index >= 0)
    && (render.quantitative === undefined || typeof render.quantitative === 'boolean' && (!render.quantitative || !voi && !window));
}
