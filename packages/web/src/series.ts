import { RaykitError } from './types.js';
import type { Source } from './types.js';
import type { RaykitViewport } from './viewport.js';

export interface SeriesMember {
  instanceUid: string;
  revision: string;
  source: Source;
  sha256?: string;
  byteLength?: number;
  preview?: Blob;
}
export interface SeriesDelta { sequence: number; manifestRevision: string; expected?: number; members: readonly SeriesMember[] }

export class ProgressiveSeries extends EventTarget {
  readonly #members = new Map<string, SeriesMember>();
  #sequence = -1;
  #expected?: number;

  constructor(readonly pinnedManifestRevision?: string) { super(); }

  get progress() { return { available: this.#members.size, expected: this.#expected }; }
  get members(): readonly SeriesMember[] { return Array.from(this.#members.values()); }

  append(delta: SeriesDelta): number {
    if (this.pinnedManifestRevision && delta.manifestRevision !== this.pinnedManifestRevision) {
      throw new RaykitError('integrity', 'Series manifest revision');
    }
    if (!Number.isSafeInteger(delta.sequence) || delta.sequence < 0 || delta.members.length > 4096) throw new RaykitError('invalid_request', 'Series delta');
    if (delta.sequence <= this.#sequence) return 0;
    const expected = delta.expected ?? this.#expected;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > 4096)) {
      throw new RaykitError('invalid_request', 'Series member count');
    }
    const additions = new Map<string, SeriesMember>();
    for (const member of delta.members) {
      if (!member.instanceUid || !member.revision) throw new RaykitError('invalid_request', 'Series instance identity');
      if (this.pinnedManifestRevision && (!member.sha256 || member.byteLength === undefined)) {
        throw new RaykitError('integrity', 'Pinned series requires exact original bytes');
      }
      const key = JSON.stringify([member.instanceUid, member.revision]);
      const old = this.#members.get(key) ?? additions.get(key);
      if (old) {
        if (old.sha256 !== member.sha256 || old.byteLength !== member.byteLength) throw new RaykitError('integrity', 'Series member changed in place');
        continue;
      }
      additions.set(key, Object.freeze({ ...member }));
    }
    const total = this.#members.size + additions.size;
    if (total > 4096 || (expected !== undefined && total > expected)) throw new RaykitError('limit', 'Series member count');
    this.#expected = expected;
    this.#sequence = delta.sequence;
    for (const [key, member] of additions) this.#members.set(key, member);
    this.dispatchEvent(new CustomEvent('progress', { detail: this.progress }));
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
}
