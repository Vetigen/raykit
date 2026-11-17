import { RaykitError } from './types.js';
import type { Frame, RenderOptions, ViewTransform } from './types.js';

const vertex = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform highp isampler2D monoTx;
uniform int sampleBias;
uniform sampler2D colorTx;
uniform bool mono;
uniform bool ybr;
uniform ivec2 size;
uniform vec2 canvasSize;
uniform vec2 origin;
uniform mat2 basis;
uniform vec2 centerWidth;
uniform int functionId;
uniform bool negativeSlope;
uniform bool inversion;
uniform bool hot;
uniform bool padded;
uniform ivec2 padding;
out vec4 rgba;

bool isPadding(int v) { return padded && v >= padding.x && v <= padding.y; }
float sampleMono(ivec2 pos, float fallback) {
  int value = texelFetch(monoTx, pos, 0).r + sampleBias;
  return isPadding(value) ? fallback : float(value);
}
vec3 sampleColor(ivec2 pos) {
  vec3 p = texelFetch(colorTx, pos, 0).rgb;
  if (!ybr) return p;
  vec2 cc = p.gb - vec2(128.0 / 255.0);
  return clamp(vec3(p.r + 1.402 * cc.y, p.r - 0.344136 * cc.x - 0.714136 * cc.y,
    p.r + 1.772 * cc.x), 0.0, 1.0);
}
void main() {
  vec2 d = vec2(gl_FragCoord.x, canvasSize.y - gl_FragCoord.y) - origin;
  vec2 p = inverse(basis) * d;
  rgba = vec4(0.0, 0.0, 0.0, 1.0);
  if (any(lessThan(p, vec2(-0.5))) || any(greaterThanEqual(p, vec2(size) - 0.5))) return;
  p = clamp(p, vec2(0.0), vec2(size - 1));
  ivec2 a = ivec2(floor(p)), b = min(a + 1, size - 1);
  vec2 k = p - vec2(a);
  if (!mono) {
    rgba.rgb = mix(mix(sampleColor(a), sampleColor(ivec2(b.x, a.y)), k.x),
      mix(sampleColor(ivec2(a.x, b.y)), sampleColor(b), k.x), k.y);
    return;
  }
  int nearest = texelFetch(monoTx, ivec2(floor(p + 0.5)), 0).r + sampleBias;
  if (isPadding(nearest)) return;
  float fallback = float(nearest);
  float v = mix(mix(sampleMono(a, fallback), sampleMono(ivec2(b.x, a.y), fallback), k.x),
    mix(sampleMono(ivec2(a.x, b.y), fallback), sampleMono(b, fallback), k.x), k.y);
  float delta = v - centerWidth.x;
  if (negativeSlope) delta = -delta;
  float level;
  if (functionId == 2) level = 1.0 / (1.0 + exp(-4.0 * delta / centerWidth.y));
  else if (centerWidth.y == 0.0) level = delta > 0.0 ? 1.0 : 0.0;
  else level = clamp(delta / centerWidth.y + 0.5, 0.0, 1.0);
  if (inversion) level = 1.0 - level;
  rgba.rgb = hot ? clamp(level * 3.0 - vec3(0, 1, 2), 0.0, 1.0) : vec3(level);
}`;

function compile(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new RaykitError('gpu_lost', 'Shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new RaykitError('gpu_lost', 'Shader compilation failed');
  }
  return shader;
}

type GpuWindow = { center: number; width: number; fn: number; negative: boolean };
function storedWindow(frame: Frame, options: RenderOptions): GpuWindow | null {
  const display = frame.display;
  if (options.quantitative) return null;
  if (!display) return { center: 0, width: 1, fn: 0, negative: false };
  if (display.modality.kind !== 'linear') return null;
  const choice = options.voi;
  const window = options.window ?? (choice
    ? frame.views?.find(view => view.selection.kind === choice.kind && view.selection.index === choice.index)?.window
    : display.voi.kind === 'window' ? display.voi.window : null);
  if (!window) return null;
  const { slope, intercept } = display.modality;
  const fn = window.function === 'sigmoid' ? 2 : window.function === 'linear_exact' ? 1 : 0;
  const center = (window.center - (fn === 0 ? 0.5 : 0) - intercept) / slope;
  const width = (window.width - (fn === 0 ? 1 : 0)) / Math.abs(slope);
  // Narrow bands near a representable sample can reveal float32 uniform rounding.
  const error = Math.abs(Math.fround(center) - center) + Math.abs(Math.fround(width) - width);
  if (!Number.isFinite(Math.fround(center)) || !Number.isFinite(Math.fround(width)) || width < 0
    || (width === 0 ? error !== 0 : error * 512 > width)) return null;
  return { center, width, fn, negative: slope < 0 };
}

const littleEndian = new Uint8Array(new Int32Array([1]).buffer)[0] === 1;

export class WebGlRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #mono: WebGLTexture;
  readonly #color: WebGLTexture;
  readonly #uniforms = new Map<string, WebGLUniformLocation | null>();
  readonly #textureLimit: number;
  #frame?: Frame;
  #storage?: string;
  uploads = 0;
  uploadBytes = 0;
  textureAllocations = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new RaykitError('gpu_lost', 'WebGL2 context unavailable');
    this.#gl = gl;
    this.#textureLimit = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const program = gl.createProgram();
    const mono = gl.createTexture();
    const color = gl.createTexture();
    if (!program || !mono || !color) throw new RaykitError('gpu_lost', 'Texture or program allocation failed');
    this.#program = program;
    this.#mono = mono;
    this.#color = color;
    const shaders: WebGLShader[] = [];
    try {
      shaders.push(compile(gl, gl.VERTEX_SHADER, vertex));
      shaders.push(compile(gl, gl.FRAGMENT_SHADER, fragment));
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new RaykitError('gpu_lost', 'Shader linking failed');
    } catch (error) {
      this.dispose();
      throw error;
    } finally { for (const shader of shaders) gl.deleteShader(shader); }
    gl.useProgram(program);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [index, texture] of [mono, color].entries()) {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (index === 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, 1, 1, 0, gl.RED_INTEGER, gl.SHORT, new Int16Array([0]));
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    }
    gl.uniform1i(this.#uniform('monoTx'), 0);
    gl.uniform1i(this.#uniform('colorTx'), 1);
  }

  #uniform(name: string): WebGLUniformLocation | null {
    if (!this.#uniforms.has(name)) this.#uniforms.set(name, this.#gl.getUniformLocation(this.#program, name));
    return this.#uniforms.get(name) ?? null;
  }

  get textureBytes(): number {
    if (!this.#frame) return 6;
    const { columns, rows } = this.#frame.format;
    // RGB8 can be stored by drivers in four bytes per pixel.
    return isMono(this.#frame) ? columns * rows * 2 + 4 : columns * rows * 4 + 2;
  }

  clearFrame(): void {
    const frame = this.#frame;
    this.#frame = undefined;
    this.#storage = undefined;
    const gl = this.#gl;
    if (!frame || gl.isContextLost()) return;
    const mono = isMono(frame);
    gl.activeTexture(mono ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mono ? this.#mono : this.#color);
    if (mono) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, 1, 1, 0, gl.RED_INTEGER, gl.SHORT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
  }

  supports(frame: Frame, options: RenderOptions): boolean {
    const { columns, rows, bits_stored } = frame.format;
    return !this.#gl.isContextLost() && columns <= this.#textureLimit && rows <= this.#textureLimit
      && (isMono(frame) ? bits_stored <= 16 : frame.encoding === 'rgb8' || frame.encoding === 'ybr_full8')
      && !!storedWindow(frame, options);
  }

  draw(frame: Frame, view: ViewTransform, viewport: readonly [number, number], options: RenderOptions): boolean {
    const gl = this.#gl;
    if (gl.isContextLost()) throw new RaykitError('gpu_lost');
    const window = storedWindow(frame, options);
    const { columns: w, rows: h } = frame.format;
    const mono = isMono(frame);
    const bias = mono && !frame.format.signed ? 32768 : 0;
    if (!window || !this.supports(frame, options)) return false;
    if (this.#frame !== frame) {
      const storage = [w, h, mono].join(':');
      const reuse = this.#storage === storage;
      if (mono) {
        const view = new DataView(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
        const count = w * h;
        const packed = frame.encoding === 'mono_i16_le';
        if (view.byteLength !== count * (packed ? 2 : 4)) throw new RaykitError('integrity', 'Stored pixel buffer length');
        const data = packed && littleEndian && frame.pixels.byteOffset % 2 === 0
          ? new Int16Array(frame.pixels.buffer, frame.pixels.byteOffset, count)
          : Int16Array.from({ length: count }, (_, i) => packed ? view.getInt16(i * 2, true) : view.getInt32(i * 4, true) - bias);
        gl.activeTexture(gl.TEXTURE0);
        if (reuse) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.SHORT, data);
        else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, w, h, 0, gl.RED_INTEGER, gl.SHORT, data);
          if (this.#frame && !isMono(this.#frame)) {
            gl.activeTexture(gl.TEXTURE1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
          }
        }
        this.uploadBytes += data.byteLength;
      } else {
        if (frame.pixels.byteLength !== w * h * 3) throw new RaykitError('integrity', 'Stored color buffer length');
        gl.activeTexture(gl.TEXTURE1);
        if (reuse) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_BYTE, frame.pixels);
        else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, frame.pixels);
          if (this.#frame && isMono(this.#frame)) {
            gl.activeTexture(gl.TEXTURE0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, 1, 1, 0, gl.RED_INTEGER, gl.SHORT, null);
          }
        }
        this.uploadBytes += frame.pixels.byteLength;
      }
      if (gl.getError() !== gl.NO_ERROR) throw new RaykitError('gpu_lost', 'Texture upload failed');
      this.#frame = frame;
      this.#storage = storage;
      this.uploads++;
      if (!reuse) this.textureAllocations++;
    }
    const sx = this.canvas.width / viewport[0], sy = this.canvas.height / viewport[1];
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.#program);
    gl.uniform1i(this.#uniform('mono'), +mono);
    gl.uniform1i(this.#uniform('sampleBias'), bias);
    gl.uniform1i(this.#uniform('ybr'), +(frame.encoding === 'ybr_full8'));
    gl.uniform2i(this.#uniform('size'), w, h);
    gl.uniform2f(this.#uniform('canvasSize'), this.canvas.width, this.canvas.height);
    gl.uniform2f(this.#uniform('origin'), view.origin.x * sx, view.origin.y * sy);
    gl.uniformMatrix2fv(this.#uniform('basis'), false, [view.x_axis[0] * sx, view.x_axis[1] * sy, view.y_axis[0] * sx, view.y_axis[1] * sy]);
    gl.uniform2f(this.#uniform('centerWidth'), window.center, window.width);
    gl.uniform1i(this.#uniform('functionId'), window.fn);
    gl.uniform1i(this.#uniform('negativeSlope'), +window.negative);
    gl.uniform1i(this.#uniform('inversion'), +(!!frame.display?.inverse !== !!options.invert));
    gl.uniform1i(this.#uniform('hot'), +(options.palette === 'hot'));
    const padding = frame.display?.padding;
    gl.uniform1i(this.#uniform('padded'), +!!padding);
    gl.uniform2i(this.#uniform('padding'), padding?.[0] ?? 0, padding?.[1] ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Reads the current canvas immediately after draw, in WebGL's bottom-up row order. */
  capture(): Uint8Array<ArrayBuffer> {
    const gl = this.#gl;
    const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose(): void {
    this.#gl.deleteProgram(this.#program);
    this.#gl.deleteTexture(this.#mono);
    this.#gl.deleteTexture(this.#color);
    this.#frame = undefined;
  }
}

function isMono(frame: Frame): boolean {
  return frame.encoding === 'mono_i32_le' || frame.encoding === 'mono_i16_le';
}

export class CpuRenderer {
  readonly #image = document.createElement('canvas');

  constructor(readonly canvas: HTMLCanvasElement) {}

  clear(): void { this.#image.width = this.#image.height = 1; }

  setPixels(frame: Frame, pixels: Uint8Array<ArrayBuffer>): void {
    const { columns, rows } = frame.format;
    if (pixels.byteLength !== columns * rows * 4) throw new RaykitError('integrity', 'RGBA pixel buffer length');
    this.#image.width = columns;
    this.#image.height = rows;
    const context = this.#image.getContext('2d', { alpha: false });
    if (!context) throw new RaykitError('gpu_lost', 'Canvas unavailable');
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), columns, rows), 0, 0);
  }

  draw(transform: ViewTransform, viewport: readonly [number, number]): void {
    const canvas = this.canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new RaykitError('gpu_lost', 'Canvas unavailable');
    const sx = canvas.width / viewport[0], sy = canvas.height / viewport[1];
    const { x_axis: a, y_axis: b, origin } = transform;
    context.resetTransform();
    context.fillStyle = 'black';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(a[0] * sx, a[1] * sy, b[0] * sx, b[1] * sy, origin.x * sx, origin.y * sy);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.#image, -0.5, -0.5);
  }
}
