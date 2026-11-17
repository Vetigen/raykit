import { collect } from './session.js';
import { RaykitError } from './types.js';
import type { Reader } from './types.js';

type RequestHeaders = (signal: AbortSignal) => HeadersInit | Promise<HeadersInit>;
export interface DicomwebInstance { studyUid: string; seriesUid: string; instanceUid: string; sopClassUid: string }

function uid(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value)) {
    throw new RaykitError('invalid_request', 'DICOMweb UID');
  }
  return value;
}

export class Dicomweb {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #headers?: RequestHeaders;

  constructor(base: string | URL, options: { headers?: RequestHeaders; fetch?: typeof fetch } = {}) {
    this.#base = new URL(base);
    if (!['http:', 'https:'].includes(this.#base.protocol) || this.#base.username || this.#base.password || this.#base.search || this.#base.hash) {
      throw new RaykitError('invalid_request', 'DICOMweb base URL');
    }
    if (!this.#base.pathname.endsWith('/')) this.#base.pathname += '/';
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#headers = options.headers;
  }

  async listInstances(study: string, series: string, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<DicomwebInstance[]> {
    study = uid(study); series = uid(series);
    const { limit = 100, offset = 0, signal = new AbortController().signal } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new RaykitError('invalid_request', 'QIDO pagination');
    }
    const url = new URL(`studies/${study}/series/${series}/instances`, this.#base);
    url.searchParams.set('limit', String(limit)); url.searchParams.set('offset', String(offset));
    url.searchParams.append('includefield', '00080016');
    const response = await this.#get(url, 'application/dicom+json', signal);
    if (response.status === 204) return [];
    if (!response.body || !/^application\/dicom\+json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new RaykitError('io', 'Expected DICOM JSON');
    }
    // Only UIDs are returned to the caller. The response can include additional tags.
    const bytes = await collect(response.body, 4 * 1024 * 1024, signal);
    let json: unknown;
    try { json = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new RaykitError('invalid_dicom', 'QIDO response JSON'); }
    if (!Array.isArray(json) || json.length > limit) throw new RaykitError('limit', 'QIDO result count');
    return json.map(row => {
      const get = (key: string) => uid(row?.[key]?.vr === 'UI' ? row[key].Value?.[0] : undefined);
      if (get('0020000D') !== study || get('0020000E') !== series) throw new RaykitError('integrity', 'QIDO instance belongs to a different series');
      return { studyUid: study, seriesUid: series, instanceUid: get('00080018'), sopClassUid: get('00080016') };
    });
  }

  instance(study: string, series: string, instance: string): Reader {
    const url = new URL(`studies/${uid(study)}/series/${uid(series)}/instances/${uid(instance)}`, this.#base);
    return { expected: { expected_study_uid: study, expected_series_uid: series, expected_instance_uid: instance }, read: async (signal, maxBytes) => {
      const response = await this.#get(url, 'multipart/related; type="application/dicom"; transfer-syntax=*, application/dicom', signal);
      if (!response.body) throw new RaykitError('io', 'WADO instance is empty');
      const content = response.headers.get('content-type') ?? '';
      if (/^application\/dicom(?:\s*;|$)/i.test(content)) return response.body;
      const boundary = /^multipart\/related\s*;/i.test(content)
        ? /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(content) : null;
      const token = boundary?.[1] ?? boundary?.[2];
      if (!token || token.length > 70 || !/^[\x20-\x7e]+$/.test(token)) {
        throw new RaykitError('io', 'Expected a WADO DICOM multipart response');
      }
      const data = new Uint8Array(await collect(response.body, maxBytes + 16 * 1024, signal));
      return multipart(data, token, maxBytes);
    } };
  }

  async #get(url: URL, accept: string, signal: AbortSignal): Promise<Response> {
    let response;
    try {
      const headers = new Headers(await this.#headers?.(signal));
      headers.set('accept', accept);
      response = await this.#fetch(url, { method: 'GET', headers, signal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
    } catch {
      if (signal.aborted) throw new RaykitError('cancelled');
      throw new RaykitError('io', 'DICOMweb request failed');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new RaykitError('io', response.status === 401 || response.status === 403 ? 'DICOMweb access denied' : `DICOMweb HTTP ${response.status}`);
    }
    return response;
  }
}

function multipart(data: Uint8Array<ArrayBuffer>, token: string, limit: number): Uint8Array<ArrayBuffer> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const starts = (start: number, pattern: Uint8Array) => pattern.every((v, i) => data[start + i] === v);
  const opening = encode(`--${token}\r\n`), closing = encode(`\r\n--${token}--`), endHeaders = encode('\r\n\r\n');
  if (!starts(0, opening)) throw new RaykitError('invalid_dicom', 'WADO opening delimiter');
  let from = opening.length;
  const maxHeader = Math.min(data.length - endHeaders.length, from + 16 * 1024);
  for (; from <= maxHeader && !starts(from, endHeaders); from++) { /* bounded header scan */ }
  if (from > maxHeader) throw new RaykitError('invalid_dicom', 'WADO part headers');
  const header = new TextDecoder().decode(data.subarray(opening.length, from));
  if (!/(^|\r\n)content-type:\s*application\/dicom(?:\s*;[^\r\n]*)?(?:\r\n|$)/i.test(header)) {
    throw new RaykitError('invalid_dicom', 'WADO part content type');
  }
  from += endHeaders.length;
  const end = data.length - closing.length - (data.at(-2) === 13 && data.at(-1) === 10 ? 2 : 0);
  if (end < from || !starts(end, closing)) throw new RaykitError('invalid_dicom', 'WADO closing delimiter');
  if (end - from > limit) throw new RaykitError('limit', 'WADO instance bytes');
  const extra = encode(`\r\n--${token}`);
  for (let i = from; i < end; i++) if (data[i] === 13 && starts(i, extra)) throw new RaykitError('unsupported', 'Multiple WADO parts for one instance');
  return data.subarray(from, end);
}
