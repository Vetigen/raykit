import { open } from '@raykit/web';

const shaders = `
struct Params { size: vec4<u32>, originX: vec4<f32>, axisYWindow: vec4<f32>, flags: vec4<i32>, padding: vec4<i32> }
@group(0) @binding(0) var<storage, read> pixels: array<i32>;
@group(0) @binding(1) var<uniform> p: Params;
@vertex fn vertex(@builtin(vertex_index) id: u32) -> @builtin(position) vec4<f32> {
  return vec4(vec2(f32((id << 1u) & 2u), f32(id & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
fn raw(c: vec2<i32>) -> i32 { return pixels[u32(c.y) * p.size.x + u32(c.x)]; }
fn isPadding(v: i32) -> bool { return p.flags.w != 0 && v >= p.padding.x && v <= p.padding.y; }
fn texel(c: vec2<i32>, fallback: f32) -> f32 {
  let v = raw(c);
  return select(f32(v), fallback, isPadding(v));
}
@fragment fn pixel(@builtin(position) screen: vec4<f32>) -> @location(0) vec4<f32> {
  let d = screen.xy - p.originX.xy;
  let a = p.originX.zw;
  let b = p.axisYWindow.xy;
  let det = a.x * b.y - a.y * b.x;
  let c = vec2(d.x * b.y - d.y * b.x, a.x * d.y - a.y * d.x) / det;
  if (any(c < vec2(-0.5)) || any(c >= vec2<f32>(p.size.xy) - 0.5)) { return vec4(0.0, 0.0, 0.0, 1.0); }
  let last = vec2<i32>(p.size.xy) - 1;
  let s = clamp(c, vec2(0.0), vec2<f32>(last));
  let i = vec2<i32>(floor(s));
  let j = min(i + 1, last);
  let f = fract(s);
  let nearest = raw(vec2<i32>(floor(s + 0.5)));
  if (isPadding(nearest)) { return vec4(0.0, 0.0, 0.0, 1.0); }
  let base = f32(nearest);
  let value = mix(mix(texel(i, base), texel(vec2(j.x, i.y), base), f.x), mix(texel(vec2(i.x, j.y), base), texel(j, base), f.x), f.y);
  let delta = (value - p.axisYWindow.z) * select(1.0, -1.0, p.flags.y != 0);
  let width = p.axisYWindow.w;
  var level: f32;
  if (p.flags.x == 2) { level = 1.0 / (1.0 + exp(-4.0 * delta / width)); }
  else if (width == 0.0) { level = select(0.0, 1.0, delta > 0.0); }
  else { level = clamp(delta / width + 0.5, 0.0, 1.0); }
  level = select(level, 1.0 - level, p.flags.z != 0);
  return vec4(level, level, level, 1.0);
}`;

class Candidate {
  constructor(device, canvas, frame) {
    this.device = device;
    this.canvas = canvas;
    this.frame = frame;
    const shader = device.createShaderModule({ code: shaders });
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context = canvas.getContext('webgpu');
    this.context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vertex' },
      fragment: { module: shader, entryPoint: 'pixel', targets: [{ format }] } });
    this.storage = device.createBuffer({ size: frame.pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.storage, 0, frame.pixels);
    this.bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.storage } }, { binding: 1, resource: { buffer: this.uniforms } },
    ] });
  }

  async draw(transform, window, capture = false) {
    const { display, format } = this.frame;
    const mode = window.function === 'sigmoid' ? 2 : window.function === 'linear_exact' ? 1 : 0;
    const center = (window.center - (mode === 0 ? 0.5 : 0) - display.modality.intercept) / display.modality.slope;
    const width = (window.width - (mode === 0 ? 1 : 0)) / Math.abs(display.modality.slope);
    const box = new ArrayBuffer(80);
    new Uint32Array(box, 0, 4).set([format.columns, format.rows, 0, 0]);
    new Float32Array(box, 16, 8).set([transform.origin.x, transform.origin.y, ...transform.x_axis, ...transform.y_axis, center, width]);
    new Int32Array(box, 48, 8).set([mode, + (display.modality.slope < 0), +display.inverse, +!!display.padding, ...(display.padding ?? [0, 0]), 0, 0]);
    const { device } = this;
    device.queue.writeBuffer(this.uniforms, 0, box);
    const texture = this.context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind); pass.draw(3); pass.end();
    let buffer;
    const stride = Math.ceil(this.canvas.width * 4 / 256) * 256;
    if (capture) {
      buffer = device.createBuffer({ size: stride * this.canvas.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [this.canvas.width, this.canvas.height]);
    }
    device.queue.submit([encoder.finish()]);
    if (!buffer) return;
    await buffer.mapAsync(GPUMapMode.READ);
    try {
      const padded = new Uint8Array(buffer.getMappedRange());
      const result = new Uint8Array(this.canvas.width * this.canvas.height * 4);
      for (let row = 0; row < this.canvas.height; row++) result.set(padded.subarray(row * stride, row * stride + this.canvas.width * 4), row * this.canvas.width * 4);
      return result;
    } finally { buffer.unmap(); buffer.destroy(); }
  }

  close() { this.storage.destroy(); this.uniforms.destroy(); this.context.unconfigure(); }
}

export async function create(host, file, count) {
  if (count !== 1) throw new Error('WebGPU candidate implements signed monochrome only');
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const session = await open(file);
  let engine;
  try {
    const frame = await session.readFrame(0, { output: 'stored' });
    const canvas = document.createElement('canvas');
    canvas.width = host.clientWidth; canvas.height = host.clientHeight;
    host.append(canvas);
    engine = new Candidate(device, canvas, frame);
    const view = { viewport: [canvas.width, canvas.height], pan: [0, 0], zoom: 1, quarter_turns: 0 };
    let window = frame.display.voi.window ?? frame.display.automatic_window;
    let mapping = (await session.transform(0, view)).transform;
    const present = async () => {
      await new Promise(requestAnimationFrame);
      await engine.draw(mapping, window);
    };
    await present();
    const verify = async () => {
      const exact = { center: -3180, width: 2, function: 'linear_exact' };
      const probe = document.createElement('canvas'); probe.width = frame.format.columns; probe.height = frame.format.rows;
      const probeRenderer = new Candidate(device, probe, frame);
      try {
        const gpu = await probeRenderer.draw({ origin: { x: 0.5, y: 0.5 }, x_axis: [1, 0], y_axis: [0, 1] }, exact, true);
        const cpu = await session.render(0, { window: exact });
        let grayError = 0;
        for (let i = 0; i < gpu.length; i++) grayError = Math.max(grayError, Math.abs(gpu[i] - cpu[i]));
        if (grayError > 1) throw new Error(`WebGPU gray error ${grayError}`);
        const large = document.createElement('canvas');
        large.width = probe.width * 2; large.height = probe.height * 2;
        const interpolator = new Candidate(device, large, frame);
        try {
          const window = { center: -3120, width: 140, function: 'linear_exact' };
          const rgba = await interpolator.draw({ origin: { x: 1, y: 1 }, x_axis: [2, 0], y_axis: [0, 2] }, window, true);
          const interpolation = [10, 21, 39].map(x => {
            const raw = -2000 + (x + 0.25) * 40 + 10.25 * 6;
            const expected = Math.round((1 - Math.max(0, Math.min(1, (2 * raw - 100 - window.center) / window.width + 0.5))) * 255);
            const actual = rgba[(21 * large.width + 2 * x + 1) * 4];
            if (Math.abs(expected - actual) > 1) throw new Error(`WebGPU interpolation ${actual} differs from ${expected}`);
            return { expected, actual };
          });
          return { gray_error: grayError, interpolation };
        } finally { interpolator.close(); }
      } finally { probeRenderer.close(); }
    };
    return {
      name: 'RayKit WebGPU candidate', count,
      seek() { return present(); },
      async sample(index, row, col) { return (await session.sample(index, col, row)).stored; },
      window(center, width) { window = { center, width }; return present(); },
      async panZoom(x, y, zoom) { mapping = (await session.transform(0, { ...view, pan: [x, y], zoom })).transform; await present(); },
      async metrics() { return { ...(await verify()), adapter: adapter.info?.description ?? '', ...(await session.stats()) }; },
      close() { engine.close(); session.close(); device.destroy(); host.replaceChildren(); },
    };
  } catch (error) { engine?.close(); session.close(); device.destroy(); throw error; }
}
