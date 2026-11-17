import type { Buffer } from 'node:buffer';

export type Json = Record<string, unknown>;
export type Path = string | URL;
export interface OpenOptions {
  expected_sha256?: string;
  expected_size?: number;
  expected_instance_uid?: string;
  expected_series_uid?: string;
  expected_study_uid?: string;
  limits?: Record<string, number>;
}
export interface RenderOptions {
  window?: { center: number; width: number; function?: 'linear' | 'linear_exact' | 'sigmoid' };
  voi?: { kind: 'window' | 'lut'; index: number };
  palette?: 'gray' | 'hot';
  invert?: boolean;
}
export interface Inspection extends Json {
  frames: number;
  instance_uid: string;
  series_uid: string | null;
  content_sha256: string;
  verification: 'full_source';
}
export class RaykitError extends Error {
  readonly code: string;
  readonly detail?: string;
}
export class RaykitSession {
  private constructor();
  readonly inspection: Inspection;
  request(command: Json): Promise<{ metadata: Json; bytes: Buffer }>;
  frameInfo(index: number): Promise<Json>;
  sample(index: number, x: number, y: number): Promise<Json>;
  preview(index: number, options?: RenderOptions): Promise<Json & { pixels: Buffer; encoding: 'rgba8' }>;
  frameIndex(): Promise<{ sha256: string; bytes: Buffer }>;
  frameProof(index: number, revision: string): Promise<{ root_sha256: string; revision: string; frame: number; frames: number; source: Json; bytes: Buffer }>;
  verifyMeasurement(record: Json): Promise<Json>;
  close(): Promise<void>;
}
export function open(path: Path, options?: OpenOptions): Promise<RaykitSession>;
export function inspect(path: Path, options?: OpenOptions): Promise<Inspection>;
