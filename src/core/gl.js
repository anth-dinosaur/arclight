// ARCLIGHT — thin WebGL2 helpers. No state machine abstraction, just less boilerplate.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,          // we render to an offscreen HDR target and resolve ourselves
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: true,
  });
  if (!gl) return null;

  // Half-float render targets are the whole point (HDR > 1.0 drives bloom).
  // EXT_color_buffer_float covers RGBA16F on iOS; half_float is the narrower fallback.
  const ext =
    gl.getExtension('EXT_color_buffer_half_float') ||
    gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');   // optional: linear filtering on float
  const hdr = !!ext;

  return { gl, hdr };
}

export function compileShader(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    gl.deleteShader(sh);
    throw new Error(`[${label}] shader compile failed:\n${log}\n${numbered}`);
  }
  return sh;
}

export function createProgram(gl, vsSrc, fsSrc, label = 'program') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label + ':vs');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label + ':fs');
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`[${label}] link failed:\n${log}`);
  }
  // Cache uniform locations up front so the hot loop never calls getUniformLocation.
  const uniforms = Object.create(null);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u: uniforms };
}

/**
 * A colour-only render target. `float` selects RGBA16F (HDR) vs RGBA8.
 * Returns an object with a `resize` that reallocates only when the size changes.
 */
export function createTarget(gl, w, h, { float = true, linear = true } = {}) {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  const t = {
    tex, fbo, w: 0, h: 0, float, linear,
    resize(nw, nh) {
      nw = Math.max(1, nw | 0);
      nh = Math.max(1, nh | 0);
      if (nw === t.w && nh === t.h) return;
      t.w = nw; t.h = nh;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0,
        float ? gl.RGBA16F : gl.RGBA8,
        nw, nh, 0, gl.RGBA,
        float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
        null
      );
      const f = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, t.w, t.h);
    },
    dispose() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); },
  };
  t.resize(w, h);
  return t;
}

/** Fullscreen triangle VAO — one draw, no vertex buffer reads beyond gl_VertexID. */
export function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  return {
    vao,
    draw() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); },
  };
}

export const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  // Oversized triangle covering the viewport; uv derived from clip position.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
