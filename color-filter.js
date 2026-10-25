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

/* 係數取自 Filter Effects 規格的 saturate */
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
  /* 仿 iPhone 攝影風格 Amber，Tone -73／Color 41／Film 10／Grain／白平衡陰天。
     Apple 沒有公開這些滑桿的算法，而且它會分區處理（膚色、天空各自保護），
     這裡只能用一個全畫面的線性矩陣近似，數值是對著測試色塊調出來的，不是換算。
     套用順序同拍攝流程：白平衡 → Tone → Color → 琥珀底色 → Film */
  porto: {
    label: "葡萄牙暖黃",
    m: mul(channels([0.97, 0.97, 0.97]),                       // Film 10：高光稍收
       mul(channels([1.03, 1.0, 0.92], [0.015, 0.008, 0]),     // 琥珀底色
       mul(saturate(1.16),                                     // Color 41
       mul(mul(contrast(0.92), lift(0.09)),                     // Tone -73：抬暗部、壓對比
           channels([1.03, 1.0, 0.95])))))                     // 白平衡陰天
    ,
    grain: 0.035,
  },
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

/* 雜湊要 highp：像素座標到 1920，mediump 只有 10 位尾數，顆粒會排成條紋。
   不用常見的 fract(sin(...))，sin 在行動 GPU 上大引數的精度更差 */
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D img;
uniform mat4 m;
uniform vec4 o;
uniform float keep;
uniform float grain;
uniform float seed;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 c = texture2D(img, uv);
  vec3 r = clamp((m * c + o).rgb, 0.0, 1.0);
  // 顆粒只加亮度、三通道同值，不會帶出彩色雜點；每格換 seed 才像底片而不是髒鏡頭
  float n = hash12(gl_FragCoord.xy + seed * vec2(37.0, 17.0)) - 0.5;
  r = clamp(r + n * 2.0 * grain, 0.0, 1.0);
  // 淡出在濾鏡之後才收黑，否則「褪色」抬起的黑位會讓結尾收不到全黑
  gl_FragColor = vec4(r * keep, 1.0);
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
  const uGrain = gl.getUniformLocation(prog, "grain");
  const uSeed = gl.getUniformLocation(prog, "seed");
  gl.uniform1i(gl.getUniformLocation(prog, "img"), 0);
  gl.viewport(0, 0, width, height);

  /* fade 為 0–1，1 表示全黑；frame 決定顆粒圖樣，同一格同一個值才能重現；
     grain: false 只給測試用，拿掉顆粒才能跟 applyMatrix 逐點比對 */
  function render(src, key, { fade = 0, frame = 0, grain = true } = {}) {
    const f = FILTERS[key] ?? FILTERS.none;
    const m = f.m;
    gl.uniform1f(uGrain, grain ? (f.grain ?? 0) : 0);
    gl.uniform1f(uSeed, frame % 1000);
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
