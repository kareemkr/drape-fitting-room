// The live mesh moves every pose update. The product texture stays on the GPU
// until the user picks another garment. Both UVs and camera points start at the top left.
const vertexSource = `
  attribute vec2 target;
  attribute vec2 source;
  uniform vec2 frame;
  varying vec2 uv;
  void main() {
    vec2 position = target / frame;
    gl_Position = vec4(position.x * 2.0 - 1.0, 1.0 - position.y * 2.0, 0.0, 1.0);
    uv = source;
  }
`;

const fragmentSource = `
  precision mediump float;
  uniform sampler2D fabric;
  varying vec2 uv;
  void main() { gl_FragColor = texture2D(fabric, uv); }
`;

function attachShader(gl, program, type, code) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a fabric shader.");
  try {
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  } finally {
    gl.deleteShader(shader);
  }
}

export function createTexturePainter() {
  if (typeof document === "undefined") return null;
  const surface = document.createElement("canvas");
  let gl, program, vertexBuffer, indexBuffer, texture;
  let closed = false;
  let previousTexture = null;
  let previousFaces = null;
  let vertices = new Float32Array(0);
  let indices = new Uint16Array(0);
  let frame;
  let textureLimit;
  function dispose() {
    if (closed) return;
    closed = true;
    previousTexture = null;
    previousFaces = null;
    if (gl && !gl.isContextLost()) {
      if (texture) gl.deleteTexture(texture);
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      if (program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    surface.width = surface.height = 1;
  }
  try {
    gl = surface.getContext("webgl", {
      alpha: true,
      failIfMajorPerformanceCaveat: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      antialias: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    program = gl.createProgram();
    if (!program) throw new Error("No fabric shader program.");
    attachShader(gl, program, gl.VERTEX_SHADER, vertexSource);
    attachShader(gl, program, gl.FRAGMENT_SHADER, fragmentSource);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Could not link the fabric shaders.");
    gl.useProgram(program);
    vertexBuffer = gl.createBuffer();
    indexBuffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!vertexBuffer || !indexBuffer || !texture)
      throw new Error("No fabric texture buffers.");
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    const target = gl.getAttribLocation(program, "target");
    const source = gl.getAttribLocation(program, "source");
    gl.enableVertexAttribArray(target);
    gl.enableVertexAttribArray(source);
    gl.vertexAttribPointer(target, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(source, 2, gl.FLOAT, false, 16, 8);
    frame = gl.getUniformLocation(program, "frame");
    gl.uniform1i(gl.getUniformLocation(program, "fabric"), 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  } catch {
    dispose();
    return null;
  }

  function draw(ctx, fabric, mesh) {
    if (closed || gl.isContextLost()) return false;
    const { width, height } = ctx.canvas;
    const points = mesh.vertices;
    const faces = mesh.triangles;
    if (
      !width ||
      !height ||
      !points.length ||
      !faces.length ||
      points.length > 65535
    )
      return false;
    try {
      if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform2f(frame, width, height);
      if (previousTexture !== fabric) {
        if (Math.max(fabric.width, fabric.height) > textureLimit) return false;
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          fabric,
        );
        if (gl.getError() !== gl.NO_ERROR) return false;
        previousTexture = fabric;
      }
      if (vertices.length !== points.length * 4) {
        vertices = new Float32Array(points.length * 4);
        gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
      }
      for (let i = 0; i < points.length; i++) {
        const { s, t } = points[i];
        vertices[i * 4] = t.x;
        vertices[i * 4 + 1] = t.y;
        vertices[i * 4 + 2] = s.x;
        vertices[i * 4 + 3] = s.y;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
      if (previousFaces !== faces) {
        let dirty = indices.length !== faces.length * 3;
        if (dirty) indices = new Uint16Array(faces.length * 3);
        let offset = 0;
        for (const face of faces) {
          for (const index of face) {
            if (indices[offset] !== index) dirty = true;
            indices[offset++] = index;
          }
        }
        if (dirty)
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        previousFaces = faces;
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
      ctx.drawImage(surface, 0, 0, width, height);
      return true;
    } catch {
      // A failed upload or a lost graphics device can still use the Canvas2D path.
      return false;
    }
  }

  return { draw, dispose };
}
