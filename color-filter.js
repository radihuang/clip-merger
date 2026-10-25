/* 調色濾鏡：2D canvas 畫好的畫面交給 WebGL 套一個 4×5 色彩矩陣。

   不用 ctx.filter：iOS Safari 到 27.x 都要手動開實驗功能「Canvas Filters」才有，
   預設環境下設了會被靜默忽略——桌面 Chrome 測起來正常，手機成品卻沒有濾鏡。
   也不用 getImageData 逐像素算：1080×1920 每格兩百萬像素，在手機上太慢。

   矩陣為列優先，每列是輸出的 R G B A，五欄依序乘輸入的 r g b a 再加常數偏移，
   數值在 0–1 尺度，作用在 sRGB 編碼值上（與 CSS filter 的做法相同）。 */

const I = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/* a ∘ b：先套 b 再套 a */
export function mul(a, b) {
  const out = new Array(20);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let v = c === 4 ? a[r * 5 + 4] : 0;
      for (let k = 0; k < 4; k++) v += a[r * 5 + k] * b[k * 5 + c];
      out[r * 5 + c] = v;
    }
  }
  return out;
}

/* 係數取自 Filter Effects 規格的 saturate 與 sepia */
function saturate(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function channels([r, g, b], [or, og, ob] = [0, 0, 0]) {
  return [
    r, 0, 0, 0, or,
    0, g, 0, 0, og,
    0, 0, b, 0, ob,
    0, 0, 0, 1, 0,
  ];
}

const contrast = c => channels([c, c, c], [0.5 * (1 - c), 0.5 * (1 - c), 0.5 * (1 - c)]);

/* 把黑位抬到 v，白位不動 */
const lift = v => channels([1 - v, 1 - v, 1 - v], [v, v, v]);

export const FILTERS = {
  none:  { label: "原色", m: I },
  mono:  { label: "黑白", m: saturate(0) },
  sepia: { label: "復古", m: [
    0.393, 0.769, 0.189, 0, 0,
    0.349, 0.686, 0.168, 0, 0,
    0.272, 0.534, 0.131, 0, 0,
    0, 0, 0, 1, 0,
  ] },
  warm:  { label: "暖色", m: channels([1.08, 1.0, 0.86], [0.02, 0.01, 0]) },
  cool:  { label: "冷色", m: channels([0.9, 1.0, 1.08], [0, 0.01, 0.03]) },
  vivid: { label: "鮮豔", m: mul(contrast(1.1), saturate(1.4)) },
  faded: { label: "褪色", m: mul(lift(0.08), mul(contrast(0.85), saturate(0.75))) },
};

/* JS 端的參考實作，給測試拿來跟 GPU 輸出比對。rgb 為 0–255 */
export function applyMatrix(m, [r, g, b]) {
  const x = [r / 255, g / 255, b / 255, 1];
  const out = [];
  for (let row = 0; row < 3; row++) {
    let v = m[row * 5 + 4];
    for (let k = 0; k < 4; k++) v += m[row * 5 + k] * x[k];
    out.push(Math.round(Math.min(1, Math.max(0, v)) * 255));
  }
  return out;
}

const VS = `
attribute vec2 p;
varying vec2 uv;
void main() {
  // canvas 第 0 列上傳後落在 t=0，而畫面頂端是 clip y=+1，所以 y 要反過來
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
varying vec2 uv;
uniform sampler2D img;
uniform mat4 m;
uniform vec4 o;
uniform float keep;
void main() {
  vec4 c = texture2D(img, uv);
  vec4 r = m * c + o;
  // 淡出在濾鏡之後才收黑，否則「褪色」抬起的黑位會讓結尾收不到全黑
  gl_FragColor = vec4(clamp(r.rgb, 0.0, 1.0) * keep, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("濾鏡 shader 編譯失敗：" + gl.getShaderInfoLog(s));
  }
  return s;
}

export function createFilterRenderer(width, height, { preserveDrawingBuffer = true } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer,
  });
  if (!gl) throw new Error("這個瀏覽器無法建立 WebGL，濾鏡不可用");

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("濾鏡 shader 連結失敗：" + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  /* 來源與輸出同尺寸，NEAREST 才能一對一取樣；非 2 的次方材質在 WebGL1 必須 CLAMP */
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  const uM = gl.getUniformLocation(prog, "m");
  const uO = gl.getUniformLocation(prog, "o");
  const uKeep = gl.getUniformLocation(prog, "keep");
  gl.uniform1i(gl.getUniformLocation(prog, "img"), 0);
  gl.viewport(0, 0, width, height);

  /* fade 為 0–1，1 表示全黑 */
  function render(src, key, fade = 0) {
    const m = (FILTERS[key] ?? FILTERS.none).m;
    /* WebGL1 的 uniformMatrix4fv 只收欄優先，transpose 必須是 false */
    const colMajor = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) colMajor[c * 4 + r] = m[r * 5 + c];
    gl.uniformMatrix4fv(uM, false, colMajor);
    gl.uniform4f(uO, m[4], m[9], m[14], m[19]);
    gl.uniform1f(uKeep, 1 - fade);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return canvas;
  }

  return { canvas, gl, render };
}
