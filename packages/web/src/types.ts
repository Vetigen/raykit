export type Pair = readonly [number, number];
export type Triple = readonly [number, number, number];
export type PixelPoint = Readonly<{ x: number; y: number }>;
export type ScreenPoint = Readonly<{ x: number; y: number }>;

export type ErrorCode = 'invalid_dicom' | 'integrity' | 'unsupported' | 'limit' | 'decode'
  | 'geometry' | 'invalid_request' | 'closed' | 'cancelled' | 'internal' | 'gpu_lost' | 'io';

export class RaykitError extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RaykitError';
  }
}

export interface Limits {
  source_bytes: number;
  inflated_bytes: number;
  frame_pixels: number;
  frames: number;
  elements: number;
  fragments: number;
  cache_bytes: number;
  cache_frames: number;
}

export type SourceBytes = Blob | ArrayBuffer | Uint8Array<ArrayBufferLike>;
export interface Reader {
  read(signal: AbortSignal, maxBytes: number): Promise<SourceBytes | ReadableStream<Uint8Array>>;
  readonly expected?: Readonly<{ expected_instance_uid: string; expected_study_uid: string; expected_series_uid: string }>;
}
export interface FrameIndex {
  bytes: Uint8Array<ArrayBufferLike>;
  /** Pin retained from a validated open or obtained from an authenticated publisher. */
  sha256: string;
}
export type RangeSource = { kind: 'blob'; blob: Blob }
  | { kind: 'http'; url: string; etag: string; headers?: Record<string, string> };
export interface IndexedSource { readonly frameIndex: FrameIndex; readonly range: RangeSource }
export type Source = SourceBytes | Reader | IndexedSource;

export interface OpenOptions {
  /** Opt in to preparing an independent JPEG frame while Web Crypto checks the source. */
  prepare_first_frame?: boolean;
  limits?: Partial<Limits>;
  expected_sha256?: string;
  expected_size?: number;
  expected_instance_uid?: string;
  expected_study_uid?: string;
  expected_series_uid?: string;
  revision?: string;
  signal?: AbortSignal;
  workerFactory?: () => Worker;
}

export interface PixelFormat {
  rows: number;
  columns: number;
  bits_allocated: number;
  bits_stored: number;
  high_bit: number;
  signed: boolean;
  photometric: 'monochrome1' | 'monochrome2' | 'rgb' | 'ybr_full' | 'ybr_full422';
  planar: boolean;
}

export type ProjectionCalibration = 'fiducial' | 'geometry' | 'corrected_spacing';
export type Metric = { kind: 'pixel' } | { kind: 'detector_aspect'; ratio_yx: number }
  | { kind: 'patient_plane'; spacing_xy: Pair } | { kind: 'projection'; spacing_xy: Pair; method: ProjectionCalibration }
  | { kind: 'ultrasound_region'; spacing_xy: Pair; index: number };
export interface UltrasoundRegion {
  bounds: readonly [number, number, number, number];
  delta_xy: Pair;
  units_xy: Pair;
  spatial_format: number;
}
export interface Geometry {
  calibration: { kind: 'none' } | Extract<Metric, { kind: 'patient_plane' | 'projection' }>
    | { kind: 'ultrasound'; regions: UltrasoundRegion[] };
  detector_spacing_xy: Pair | null;
  display_spacing_xy: Pair;
  patient_plane: { origin: Triple; column_axis: Triple; row_axis: Triple; spacing_xy: Pair } | null;
  anatomy: 'biped' | 'unknown' | { quadruped: string };
  increasing_column: string[] | null;
  increasing_row: string[] | null;
}

export interface Inspection {
  verification: 'full_source' | 'pinned_frame_index';
  sop_class_uid: string;
  instance_uid: string;
  study_uid: string | null;
  series_uid: string | null;
  content_sha256: string;
  transfer_syntax: string;
  object: 'projection' | 'ultrasound' | 'ct' | 'enhanced_ct' | 'mr' | 'enhanced_mr' | 'pdf'
    | 'structured_report' | 'segmentation' | 'presentation_state' | 'other';
  frames: number;
  pixel_format: PixelFormat | null;
  frame_durations_ms: number[] | null;
  initial_geometry: Geometry | null;
  capabilities: {
    frame_access: boolean;
    physical_measurement: boolean;
    patient_coordinates: boolean;
    volume_candidate: boolean;
    dependent_video: boolean;
    host_document: boolean;
    frame_limitation: string | null;
  };
}

export interface SourceReference {
  sop_class_uid: string;
  instance_uid: string;
  content_sha256: string;
  frame_of_reference_uid: string | null;
  frame: number;
}
export interface WindowLevel {
  center: number;
  width: number;
  function?: 'linear' | 'linear_exact' | 'sigmoid';
}
export interface RenderOptions { window?: WindowLevel | null; invert?: boolean; palette?: 'gray' | 'hot' }
export interface Lut { first: number; bits: number; values: number[] }
export interface Display {
  modality: { kind: 'linear'; slope: number; intercept: number } | { kind: 'lut'; table: Lut };
  voi: { kind: 'window'; window: WindowLevel } | { kind: 'lut'; table: Lut };
  automatic_window: WindowLevel;
  inverse: boolean;
  padding: Pair | null;
}
export interface Frame {
  source: SourceReference;
  format: PixelFormat;
  geometry: Geometry;
  display: Display | null;
  encoding: 'rgba8' | 'mono_i32_le' | 'rgb8' | 'ybr_full8';
  pixels: Uint8Array<ArrayBuffer>;
  requestId: number;
  workerReadMs: number;
}
export type Sample = { kind: 'monochrome'; stored: number; modality: number; padding: boolean }
  | { kind: 'color'; space: 'rgb' | 'ybr_full'; values: Triple };

export interface View { viewport: Pair; pan: Pair; zoom: number; quarter_turns: number }
export interface ViewTransform { origin: ScreenPoint; x_axis: Pair; y_axis: Pair }
export interface MappedPoint { transform: ViewTransform; pixel: PixelPoint | null; patient: Triple | null }
export interface Method {
  id: string;
  version: number;
  name: string;
  landmarks: string[];
}
export interface MeasurementRequest {
  id: string;
  method: string;
  version: number;
  points: PixelPoint[];
  parameters?: Record<string, string | number | boolean> | null;
}
export interface Measurement {
  source: SourceReference;
  coordinate_system: 'source_pixel_centers';
  input: MeasurementRequest;
  calibration: Metric;
  values: { name: string; value: number; unit: 'millimeter' | 'pixel' | 'degree' | 'vertebra' | 'ratio' }[];
}

export interface Stats {
  session: {
    source_bytes: number;
    resident_dataset_bytes: number;
    dataset_elements: number;
    frame_index_bytes: number;
    cached_pixel_bytes: number;
    cached_frames: number;
    peak_cached_pixel_bytes: number;
    decoded_frames: number;
    fragment_copy_bytes: number;
    produced_pixel_bytes: number;
  };
  output_copy_bytes: number;
  peak_output_bytes: number;
  active_pixel_bytes_upper_bound: number;
  retained_dataset_bytes: number;
  rendered_frames: number;
  rendered_frame_bytes: number;
  plane_cache_bytes: number;
  plane_work_bytes: number;
  planes_computed: number;
  plane_cache_hits: number;
  volume: { slice_cache_limit_bytes: number; slice_cache_bytes: number; peak_slice_cache_bytes: number;
    decoded_slices: number; slice_cache_hits: number } | null;
  wasm_linear_memory_bytes: number;
  wasm_input_copy_bytes: number;
  wasm_output_copy_bytes: number;
  indexed_range_read_bytes: number;
  indexed_full_fallback_bytes: number;
  range_requests: number;
}
export interface EngineCapabilities { abi: 1; limits: Limits; methods: Method[] }

export interface Acquisition {
  sop_class_uid: string;
  series_uid: string;
  frame_of_reference_uid: string;
  stack: string | null;
  temporal_position: string | null;
  echo: string | null;
  phase: string | null;
  dimensions: { tag: Pair; value: number }[];
}
export interface VolumeCandidates {
  revision: number;
  candidates: { acquisition: Acquisition; frames: number; available: boolean; limitation: { code: ErrorCode; detail?: string } | null }[];
}
export type PatientPlane = NonNullable<Geometry['patient_plane']>;
export interface Volume {
  acquisition: Acquisition;
  frames: SourceReference[];
  plane: PatientPlane;
  dimensions: Triple;
  voxel_bytes: number;
  slice_step_mm: Triple;
  center: Triple;
}
export type SliceOrientation = { kind: 'axial' | 'coronal' | 'sagittal' }
  | { kind: 'oblique'; axes: readonly [number, number, number, number, number, number] };
export type Slab = { kind: 'single' } | { kind: 'average' | 'maximum'; thickness_mm: number };
export interface SliceRequest { center: Triple; orientation: SliceOrientation; dimensions: Pair; spacing_xy: Pair; slab: Slab }
export interface SliceOptions { sampling?: 'trilinear' | 'nearest'; invert?: boolean; palette?: 'gray' | 'hot' }
export interface SliceImage { plane: PatientPlane; dimensions: Pair; encoding: 'rgba8' | 'modality_f32_le'; pixels: Uint8Array<ArrayBuffer> }
export interface SrOptions { instance_uid: string; series_uid: string; tracking_uid: string; observer_name: string; content_date: string; content_time: string }
export interface SegmentationOverlay { source: SourceReference; segment: number; dimensions: Pair; mask: Uint8Array<ArrayBuffer> }
export interface Presentation { source: SourceReference; quarter_turns: number; inverse: boolean; window: WindowLevel | null }
