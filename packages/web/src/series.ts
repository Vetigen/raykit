import { RaykitError } from './types.js';
import { open, RaykitSession } from './session.js';
import type { Source } from './types.js';
import type { RaykitViewport } from './viewport.js';

export interface SeriesMember {
  instanceUid: string;
  revision: string;
  source: Source;
  sha256?: string;
  byteLength?: number;
  preview?: Blob;
  acquisitionTimeMs?: number;
}
export interface SeriesDelta { sequence: number; manifestRevision: string; expected?: number; members: readonly SeriesMember[] }

export class ProgressiveSeries extends EventTarget {
  readonly #members = new Map<string, SeriesMember>();
  #sequence = -1;
  #expected?: number;
  readonly #announced = new Map<SeriesMember, number>();

  constructor(readonly pinnedManifestRevision?: string) { super(); }

  get progress() { return { available: this.#members.size, expected: this.#expected }; }
  get members(): readonly SeriesMember[] { return Array.from(this.#members.values()); }
  get latest(): SeriesMember | undefined {
    return this.members.reduce<SeriesMember | undefined>((best, current) => {
      if (!best) return current;
      const difference = current.acquisitionTimeMs !== undefined && best.acquisitionTimeMs !== undefined
        ? current.acquisitionTimeMs - best.acquisitionTimeMs : 0;
      return (difference || this.#announced.get(current)! - this.#announced.get(best)!) >= 0 ? current : best;
    }, undefined);
  }

  append(delta: SeriesDelta): number {
    if (this.pinnedManifestRevision && delta.manifestRevision !== this.pinnedManifestRevision) {
      throw new RaykitError('integrity', 'Series manifest revision');
    }
    if (!Number.isSafeInteger(delta.sequence) || delta.sequence < 0 || delta.members.length > 4096) throw new RaykitError('invalid_request', 'Series delta');
    const expected = delta.sequence >= this.#sequence ? delta.expected ?? this.#expected : this.#expected;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > 4096)) {
      throw new RaykitError('invalid_request', 'Series member count');
    }
    const additions = new Map<string, SeriesMember>();
    for (const member of delta.members) {
      if (!member.instanceUid || !member.revision) throw new RaykitError('invalid_request', 'Series instance identity');
      if (member.acquisitionTimeMs !== undefined && !Number.isFinite(member.acquisitionTimeMs)) throw new RaykitError('invalid_request', 'Series acquisition time');
      if (this.pinnedManifestRevision && (!member.sha256 || member.byteLength === undefined)) {
        throw new RaykitError('integrity', 'Pinned series requires exact original bytes');
      }
      const key = JSON.stringify([member.instanceUid, member.revision]);
      const old = this.#members.get(key) ?? additions.get(key);
      if (old) {
        if (old.sha256 !== member.sha256 || old.byteLength !== member.byteLength || old.acquisitionTimeMs !== member.acquisitionTimeMs)
          throw new RaykitError('integrity', 'Series member changed in place');
        continue;
      }
      additions.set(key, Object.freeze({ ...member }));
    }
    const total = this.#members.size + additions.size;
    if (total > 4096 || (expected !== undefined && total > expected)) throw new RaykitError('limit', 'Series member count');
    this.#expected = expected;
    this.#sequence = Math.max(this.#sequence, delta.sequence);
    for (const [key, member] of additions) {
      this.#members.set(key, member);
      this.#announced.set(member, delta.sequence);
    }
    if (additions.size || delta.expected !== undefined) this.dispatchEvent(new CustomEvent('progress', { detail: this.progress }));
    return additions.size;
  }

  preview(member: SeriesMember): { quality: 'preview'; document: Blob; measurementAvailable: false } | undefined {
    const original = this.#members.get(JSON.stringify([member.instanceUid, member.revision]));
    return original?.preview ? { quality: 'preview', document: original.preview, measurementAvailable: false } : undefined;
  }

  async show(viewport: RaykitViewport, member: SeriesMember, signal?: AbortSignal): Promise<void> {
    const canonical = this.#members.get(JSON.stringify([member.instanceUid, member.revision]));
    if (!canonical) throw new RaykitError('invalid_request', 'Series member is unavailable');
    if (viewport.session?.revision === canonical.revision && viewport.session.inspection.instance_uid === canonical.instanceUid
      && (!canonical.sha256 || viewport.session.inspection.content_sha256 === canonical.sha256)) return;
    await viewport.load(canonical.source, { revision: canonical.revision, expected_instance_uid: canonical.instanceUid,
      expected_sha256: canonical.sha256, expected_size: canonical.byteLength, signal });
  }

  async open(member: SeriesMember, signal?: AbortSignal): Promise<RaykitSession> {
    const canonical = this.#members.get(JSON.stringify([member.instanceUid, member.revision]));
    if (!canonical) throw new RaykitError('invalid_request', 'Series member is unavailable');
    return open(canonical.source, { revision: canonical.revision, expected_instance_uid: canonical.instanceUid,
      expected_sha256: canonical.sha256, expected_size: canonical.byteLength, signal });
  }
}

/** Follow new authorized instances while keeping physical slice ordering independent. */
export class LiveSeries extends EventTarget {
  #following = true;
  #connected = true;
  #seen = 0;
  #shown?: SeriesMember;
  #opening?: AbortController;
  #closed = false;

  constructor(readonly series: ProgressiveSeries, readonly viewport: RaykitViewport) {
    super();
    series.addEventListener('progress', this.#onProgress);
    this.#onProgress();
  }

  get status() {
    const shown = this.viewport.presented;
    return { following: this.#following, connected: this.#connected, unseen: Math.max(0, this.series.progress.available - this.#seen),
      lastImageAgeMs: shown && Math.max(0, performance.now() - shown.time) };
  }

  freeze(): void {
    if (this.#following) this.#seen = this.series.progress.available;
    this.#following = false;
    this.#opening?.abort();
    this.viewport.pause();
    this.#state();
  }

  async show(member: SeriesMember): Promise<void> {
    this.freeze();
    await this.#display(member);
  }

  goLive(): void { this.#following = true; this.#onProgress(); }
  disconnect(): void { this.#connected = false; this.#opening?.abort(); this.#state(); }
  reconnect(): void { this.#connected = true; this.#onProgress(); }

  #onProgress = () => {
    if (this.#closed) return;
    const current = this.series.latest;
    if (this.#following && this.#connected && current && current !== this.#shown) {
      void this.#display(current).catch(error => {
        if (error.code !== 'cancelled') this.dispatchEvent(new CustomEvent('diagnostic', { detail: error }));
      });
    }
    this.#state();
  };

  async #display(member: SeriesMember): Promise<void> {
    if (this.#closed) throw new RaykitError('closed');
    this.#opening?.abort();
    const controller = this.#opening = new AbortController();
    const session = await this.series.open(member, controller.signal);
    try {
      if (controller.signal.aborted || this.#closed) throw new RaykitError('cancelled');
      await this.viewport.attach(session);
      if (controller.signal.aborted || this.#closed) throw new RaykitError('cancelled');
      this.#shown = member;
      if (this.#following) this.#seen = this.series.progress.available;
      this.#state();
    } finally { session.close(); }
  }

  #state(): void { this.dispatchEvent(new CustomEvent('state', { detail: this.status })); }

  close(): void {
    this.#closed = true;
    this.#opening?.abort();
    this.series.removeEventListener('progress', this.#onProgress);
    this.viewport.close();
  }
}
