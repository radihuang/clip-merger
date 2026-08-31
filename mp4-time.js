/**
 * MP4／MOV 拍攝時間解析器
 *
 * 不依賴任何函式庫。mediabunny 的 getMetadataTags().date 只讀
 * com.apple.quicktime.creationdate 與 iTunes 風格的 ©day，
 * 標準 MP4 的 mvhd 檔頭時間它刻意跳過，而 Android 錄的影片通常只有 mvhd，
 * 所以這裡自己走完整的 box 解析。
 *
 * 這是活的實作；probe.html 內嵌的是 P0 當下的凍結快照，兩者不同步。
 */

/* 1904-01-01 到 1970-01-01 的秒數，ISO/IEC 14496-12 的時間基準 */
const MAC_EPOCH = 2082844800;

export const TIERS = {
  1: { label: "QuickTime 原生拍攝時間", note: "含時區，最可信" },
  2: { label: "MP4 檔頭時間 mvhd", note: "無時區標記，可能有時差" },
  3: { label: "從檔名推測", note: "非中繼資料，僅供參考" },
  4: { label: "檔案修改時間", note: "不是拍攝時間，排序不可靠" },
};

const str4 = (dv, o) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const fx16 = (dv, o) => dv.getInt32(o) / 65536;

function boxesIn(dv, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const name = str4(dv, off + 4);
    let head = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(dv.getBigUint64(off + 8));
      head = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < head || off + size > end) break;
    out.push({ name, body: off + head, end: off + size });
    off += size;
  }
  return out;
}

const pick = (list, name) => list.find(b => b.name === name) || null;

/** moov 在手機錄影檔中通常位於檔尾，逐個 box 標頭跳躍定位，不載入 mdat */
async function locateMoov(file) {
  let off = 0, guard = 0;
  while (off < file.size && guard++ < 1024) {
    const buf = await file.slice(off, off + 16).arrayBuffer();
    if (buf.byteLength < 8) return null;
    const dv = new DataView(buf);
    let size = dv.getUint32(0);
    const name = str4(dv, 4);
    if (size === 1) {
      if (buf.byteLength < 16) return null;
      size = Number(dv.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - off;
    }
    if (size < 8) return null;
    if (name === "moov") return { start: off, size };
    off += size;
  }
  return null;
}

function readDataBox(dv, start, end) {
  const d = pick(boxesIn(dv, start, end), "data");
  if (!d || d.end - d.body < 8) return null;
  const type = dv.getUint32(d.body);
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + d.body + 8, d.end - d.body - 8);
  if (type === 1) return new TextDecoder().decode(bytes);
  if (type === 2) return new TextDecoder("utf-16be").decode(bytes);
  return `<${bytes.length} bytes, type ${type}>`;
}

/* meta 有兩種排版：QuickTime 版沒有 version/flags，ISO 版有，讀 4 bytes 判斷 */
function parseMeta(dv, box, tags) {
  if (box.end - box.body < 4) return;
  const word = dv.getUint32(box.body);
  const kids = boxesIn(dv, word !== 0 ? box.body : box.body + 4, box.end);

  const keys = new Map();
  const keysBox = pick(kids, "keys");
  if (keysBox) {
    let p = keysBox.body + 4;
    const n = dv.getUint32(p);
    p += 4;
    for (let i = 0; i < n && p + 8 <= keysBox.end; i++) {
      const size = dv.getUint32(p);
      if (size < 8 || p + size > keysBox.end) break;
      const kb = new Uint8Array(dv.buffer, dv.byteOffset + p + 8, size - 8);
      keys.set(i + 1, new TextDecoder().decode(kb));
      p += size;
    }
  }

  const ilst = pick(kids, "ilst");
  if (!ilst) return;
  for (const item of boxesIn(dv, ilst.body, ilst.end)) {
    let key = item.name;
    const asNum = (key.charCodeAt(0) << 24) + (key.charCodeAt(1) << 16) +
                  (key.charCodeAt(2) << 8) + key.charCodeAt(3);
    if (keys.has(asNum)) key = keys.get(asNum);
    const val = readDataBox(dv, item.body, item.end);
    if (val !== null && !(key in tags)) tags[key] = val;
  }
}

function parseTrak(dv, trak) {
  const kids = boxesIn(dv, trak.body, trak.end);
  const t = { kind: null, codec: null, w: 0, h: 0, cw: 0, ch: 0, rotation: 0, fps: null };

  const tkhd = pick(kids, "tkhd");
  if (tkhd) {
    const ver = dv.getUint8(tkhd.body);
    let p = tkhd.body + 4 + (ver === 1 ? 32 : 20);
    p += 16; /* reserved x2, layer, alternate_group, volume, reserved */
    const a = fx16(dv, p), b = fx16(dv, p + 4);
    p += 36; /* 9 個矩陣值 */
    t.w = Math.round(fx16(dv, p));
    t.h = Math.round(fx16(dv, p + 4));
    const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    t.rotation = ((deg % 360) + 360) % 360;
  }

  const mdia = pick(kids, "mdia");
  if (!mdia) return t;
  const mk = boxesIn(dv, mdia.body, mdia.end);

  const hdlr = pick(mk, "hdlr");
  if (hdlr) {
    const h = str4(dv, hdlr.body + 8);
    t.kind = h === "vide" ? "video" : h === "soun" ? "audio" : h;
  }

  let mdScale = 0, mdDur = 0;
  const mdhd = pick(mk, "mdhd");
  if (mdhd) {
    const ver = dv.getUint8(mdhd.body);
    if (ver === 1) {
      mdScale = dv.getUint32(mdhd.body + 20);
      mdDur = Number(dv.getBigUint64(mdhd.body + 24));
    } else {
      mdScale = dv.getUint32(mdhd.body + 12);
      mdDur = dv.getUint32(mdhd.body + 16);
    }
  }

  const minf = pick(mk, "minf");
  const stbl = minf ? pick(boxesIn(dv, minf.body, minf.end), "stbl") : null;
  if (stbl) {
    const sk = boxesIn(dv, stbl.body, stbl.end);
    const stsd = pick(sk, "stsd");
    if (stsd) {
      const entry = boxesIn(dv, stsd.body + 8, stsd.end)[0];
      if (entry) {
        t.codec = entry.name;
        /* VisualSampleEntry 前置：reserved(6)+dataRefIdx(2)+preDefined(2)+reserved(2)+preDefined(12) = 24 */
        if (t.kind === "video" && entry.end - entry.body >= 28) {
          t.cw = dv.getUint16(entry.body + 24);
          t.ch = dv.getUint16(entry.body + 26);
        }
      }
    }
    const stsz = pick(sk, "stsz");
    if (stsz && mdScale && mdDur) {
      const count = dv.getUint32(stsz.body + 8);
      const secs = mdDur / mdScale;
      if (secs > 0) t.fps = count / secs;
    }
  }
  return t;
}

function parseMoov(buffer) {
  const dv = new DataView(buffer);
  const moov = pick(boxesIn(dv, 0, buffer.byteLength), "moov");
  if (!moov) return null;

  const kids = boxesIn(dv, moov.body, moov.end);
  const res = { mvhdDate: null, duration: null, tags: {}, video: null, audio: null };

  const mvhd = pick(kids, "mvhd");
  if (mvhd) {
    const ver = dv.getUint8(mvhd.body);
    let p = mvhd.body + 4, created, scale, d;
    if (ver === 1) {
      created = Number(dv.getBigUint64(p)); p += 16;
      scale = dv.getUint32(p); p += 4;
      d = Number(dv.getBigUint64(p));
    } else {
      created = dv.getUint32(p); p += 8;
      scale = dv.getUint32(p); p += 4;
      d = dv.getUint32(p);
    }
    if (created > MAC_EPOCH) res.mvhdDate = new Date((created - MAC_EPOCH) * 1000);
    if (scale > 0 && d > 0) res.duration = d / scale;
  }

  const meta = pick(kids, "meta");
  if (meta) parseMeta(dv, meta, res.tags);

  const udta = pick(kids, "udta");
  if (udta) {
    const uk = boxesIn(dv, udta.body, udta.end);
    const um = pick(uk, "meta");
    if (um) parseMeta(dv, um, res.tags);
    /* QuickTime udta 也可能直接掛 ©day：[u16 長度][u16 語言][文字] */
    for (const bx of uk) {
      if (bx.name.charCodeAt(0) === 0xA9 && bx.end - bx.body > 4 && !(bx.name in res.tags)) {
        const len = dv.getUint16(bx.body);
        if (len > 0 && bx.body + 4 + len <= bx.end) {
          const tb = new Uint8Array(dv.buffer, dv.byteOffset + bx.body + 4, len);
          res.tags[bx.name] = new TextDecoder().decode(tb);
        }
      }
    }
  }

  for (const k of kids) {
    if (k.name !== "trak") continue;
    const t = parseTrak(dv, k);
    if (t.kind === "video" && !res.video) res.video = t;
    else if (t.kind === "audio" && !res.audio) res.audio = t;
  }
  return res;
}

function dateFromName(name) {
  const m = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_.T ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return null;
  const d = new Date(Y, Mo - 1, D, H, Mi, S);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 讀出一支影片的拍攝時間與規格。
 * 回傳 { file, name, size, date, tier, rawStamp, tags, meta, error }
 */
export async function inspectFile(file) {
  const r = {
    file, name: file.name, size: file.size,
    date: null, tier: 4, rawStamp: null, tags: {}, meta: null, error: null,
  };

  try {
    const loc = await locateMoov(file);
    if (loc) {
      const buf = await file.slice(loc.start, loc.start + loc.size).arrayBuffer();
      r.meta = parseMoov(buf);
      if (r.meta) r.tags = r.meta.tags;
      else r.error = "moov 檔頭讀到了但解析不出內容";
    } else {
      r.error = "找不到 moov 檔頭，可能不是 MP4／MOV 格式";
    }
  } catch (e) {
    r.error = "解析失敗：" + e.message;
  }

  const qt = r.tags["com.apple.quicktime.creationdate"] || r.tags["©day"] || r.tags["date"];
  if (qt) {
    const d = new Date(qt);
    if (!isNaN(d.getTime())) { r.date = d; r.tier = 1; r.rawStamp = qt; }
  }
  if (!r.date && r.meta?.mvhdDate) { r.date = r.meta.mvhdDate; r.tier = 2; }
  if (!r.date) {
    const d = dateFromName(file.name);
    if (d) { r.date = d; r.tier = 3; }
  }
  if (!r.date) { r.date = new Date(file.lastModified); r.tier = 4; }

  return r;
}
