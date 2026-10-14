// Trip film: photos that move like a 3D scene. A small depth model (Depth Anything V2, run in the browser by
// transformers.js, so the photos stay on the device) guesses how far each pixel is; while the photo is on screen
// the camera drifts a little and near things slide more than far ones (parallax), drawn by a tiny WebGL shader.
// The model (about 27 MB) is downloaded once from Hugging Face and then cached by the browser.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL = 'onnx-community/depth-anything-v2-small';
const DEPTH_SIZE = 384;   // the depth map is small and soft: edges tear less when it moves

let estimator = null;

async function getEstimator() {
  if (!estimator) {
    estimator = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      return pipeline('depth-estimation', MODEL, { dtype: 'q8', device: 'wasm' });
    })();
    estimator.catch(() => { estimator = null; });   // let a later try start over
  }
  return estimator;
}

// A grayscale canvas, white = near. null when the model can't run here.
export async function estimateDepth(source) {
  const run = await getEstimator();
  const s = DEPTH_SIZE / Math.max(source.width, source.height);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(source.width * s));
  small.height = Math.max(1, Math.round(source.height * s));
  small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);
  const { depth } = await run(small.toDataURL('image/jpeg', 0.9));
  const raw = depth.toCanvas();
  // Normalise to the full range and soften, so the parallax bends instead of cutting at object edges
  const out = document.createElement('canvas');
  out.width = small.width;
  out.height = small.height;
  const g = out.getContext('2d');
  g.filter = 'blur(4px)';
  g.drawImage(raw, 0, 0, out.width, out.height);
  const data = g.getImageData(0, 0, out.width, out.height);
  let lo = 255, hi = 0;
  for (let i = 0; i < data.data.length; i += 4) { lo = Math.min(lo, data.data[i]); hi = Math.max(hi, data.data[i]); }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = (data.data[i] - lo) * k;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  return out;
}

// ---------- Drawing ----------
const VERT = `
attribute vec2 pos;
varying vec2 vUv;
void main() { vUv = pos * 0.5 + 0.5; vUv.y = 1.0 - vUv.y; gl_Position = vec4(pos, 0.0, 1.0); }`;

// Offset each pixel by its depth (a few steps so near and far parts don't smear into each other)
const FRAG = `
precision mediump float;
uniform sampler2D img;
uniform sampler2D dep;
uniform vec2 offset;
uniform float zoom;
uniform float focus;
varying vec2 vUv;
void main() {
  vec2 uv = (vUv - 0.5) / zoom + 0.5;
  vec2 p = uv;
  for (int i = 0; i < 5; i++) {
    float d = texture2D(dep, p).r;
    p = uv + offset * (d - focus);
  }
  gl_FragColor = texture2D(img, clamp(p, 0.001, 0.999));
}`;

export class Parallax {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(['img', 'dep', 'offset', 'zoom', 'focus'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    gl.uniform1i(this.u.img, 0);
    gl.uniform1i(this.u.dep, 1);
    this.textures = new WeakMap();   // photo -> [image texture, depth texture]
  }

  texture(source) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return t;
  }

  // The photo p (with p.img and p.depth) at progress e (0..1) of its time on screen, w x h pixels
  render(p, e, w, h) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    let tex = this.textures.get(p);
    if (!tex) { tex = [this.texture(p.img), this.texture(p.depth)]; this.textures.set(p, tex); }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[0]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[1]);
    const m = p.parallax;
    gl.uniform2f(this.u.offset, m.dx0 + (m.dx1 - m.dx0) * e, m.dy0 + (m.dy1 - m.dy0) * e);
    gl.uniform1f(this.u.zoom, 1.07);    // a margin, so the shifted edges stay out of the frame
    gl.uniform1f(this.u.focus, 0.45);   // what sits at this depth stays still; nearer slides one way, farther the other
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

// A drift for one photo: mostly sideways or mostly up, small enough to look like a slow camera move
export function randomParallax() {
  const side = Math.random() < 0.65;
  const a = 0.03 * (Math.random() < 0.5 ? 1 : -1);
  return side ? { dx0: -a, dx1: a, dy0: 0.006, dy1: -0.006 } : { dx0: 0.008, dx1: -0.008, dy0: -a * 0.8, dy1: a * 0.8 };
}
