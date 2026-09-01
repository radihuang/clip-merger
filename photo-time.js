/**
 * 照片拍攝時間解析（EXIF）
 *
 * 目前只解析 JPEG 的 APP1／TIFF 結構。HEIC 雖然也是 ISOBMFF 容器，
 * 但 EXIF 藏在 meta → iinf／iloc 的 item 結構裡，是另一條完全不同的路徑；
 * 手邊沒有 HEIC 樣本可驗證，暫不實作，讀不到時會照四層規則降級。
 *
 * 與 mp4-time.js 共用同一套 tier 語意，讓照片與影片能一起排序。
 */

/* tier 編號與 mp4-time.js 對齊，但照片的來源名稱不同，另給一組標籤 */
export const PHOTO_TIERS = {
  1: { label: "EXIF 拍攝時間", note: "相機寫入，最可信" },
  3: { label: "從檔名推測", note: "非中繼資料，僅供參考" },
  4: { label: "檔案修改時間", note: "不是拍攝時間，排序不可靠" },
};

const TAG = {
  ORIENTATION: 0x0112,
  DATETIME: 0x0132,
  EXIF_IFD: 0x8769,
  DATETIME_ORIGINAL: 0x9003,
  OFFSET_TIME_ORIGINAL: 0x9011,
};

/* EXIF 位於檔案前段，讀這麼多就夠，不必把整張照片載進記憶體 */
const HEAD_BYTES = 512 * 1024;

/** 在 JPEG 的 segment 串裡找出 APP1 內 TIFF 區段的起點 */
function findTiff(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null; // SOI
  let p = 2;
  while (p + 4 <= dv.byteLength) {
    if (dv.getUint8(p) !== 0xFF) return null;
    const marker = dv.getUint8(p + 1);
    if (marker === 0xDA || marker === 0xD9) return null; // 到了 SOS／EOI 就沒有中繼資料了
    const len = dv.getUint16(p + 2); // 長度含自身兩位元組
    if (len < 2) return null;
    if (marker === 0xE1 && p + 10 <= dv.byteLength) {
      const id = String.fromCharCode(
        dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6),
        dv.getUint8(p + 7), dv.getUint8(p + 8), dv.getUint8(p + 9));
      if (id === "Exif\0\0") return p + 10;
    }
    p += 2 + len;
  }
  return null;
}

/** 讀一個 IFD，把 want 裡指定的 tag 收進 out */
function readIFD(dv, tiff, ifdOff, le, want, out) {
  if (tiff + ifdOff + 2 > dv.byteLength) return;
  const n = dv.getUint16(tiff + ifdOff, le);
  for (let i = 0; i < n; i++) {
    const e = tiff + ifdOff + 2 + i * 12; // 每個 entry 固定 12 bytes
    if (e + 12 > dv.byteLength) return;
    const tag = dv.getUint16(e, le);
    if (!want.has(tag)) continue;
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);

    if (type === 2) { // ASCII：超過 4 bytes 就存在別處，欄位裡放的是位移
      const at = count > 4 ? tiff + dv.getUint32(e + 8, le) : e + 8;
      if (at + count > dv.byteLength) continue;
      let s = "";
      for (let k = 0; k < count; k++) {
        const c = dv.getUint8(at + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      out[tag] = s;
    } else if (type === 3) {
      out[tag] = dv.getUint16(e + 8, le);
    } else if (type === 4) {
      out[tag] = dv.getUint32(e + 8, le);
    }
  }
}

/** 從已讀入的位元組解析 EXIF；回傳 null 表示沒有可用的 EXIF */
export function parseExif(buffer) {
  const dv = new DataView(buffer);
  const tiff = findTiff(dv);
  if (tiff === null || tiff + 8 > dv.byteLength) return null;

  const bo = dv.getUint16(tiff);
  if (bo !== 0x4949 && bo !== 0x4D4D) return null;
  const le = bo === 0x4949; // "II" = little endian
  if (dv.getUint16(tiff + 2, le) !== 42) return null;

  const out = {};
  readIFD(dv, tiff, dv.getUint32(tiff + 4, le), le,
    new Set([TAG.DATETIME, TAG.ORIENTATION, TAG.EXIF_IFD]), out);

  // DateTimeOriginal 在 Exif SubIFD，得先從 IFD0 拿到指標才進得去
  if (out[TAG.EXIF_IFD]) {
    readIFD(dv, tiff, out[TAG.EXIF_IFD], le,
      new Set([TAG.DATETIME_ORIGINAL, TAG.OFFSET_TIME_ORIGINAL]), out);
  }

  const raw = out[TAG.DATETIME_ORIGINAL] || out[TAG.DATETIME] || null;
  const tz = out[TAG.OFFSET_TIME_ORIGINAL] || null;
  let date = null;
  if (raw) {
    // "YYYY:MM:DD HH:MM:SS" 的前兩個冒號要換成減號，Date 才吃得下
    const iso = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T");
    const d = new Date(tz ? iso + tz : iso);
    if (!isNaN(d.getTime())) date = d;
  }

  return {
    date, raw, tz,
    fromOriginal: !!out[TAG.DATETIME_ORIGINAL],
    orientation: out[TAG.ORIENTATION] ?? null,
  };
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
 * 讀出一張照片的拍攝時間與尺寸。
 * tier 與 mp4-time.js 對齊：1 = EXIF 原生、3 = 檔名、4 = 檔案時間。
 */
export async function inspectPhoto(file) {
  const r = {
    kind: "photo",
    file, name: file.name, size: file.size,
    date: null, tier: 4, rawStamp: null, exif: null, error: null,
    width: 0, height: 0,
  };

  try {
    const head = await file.slice(0, Math.min(HEAD_BYTES, file.size)).arrayBuffer();
    r.exif = parseExif(head);
  } catch (e) {
    r.error = "EXIF 解析失敗：" + e.message;
  }

  if (r.exif?.date) {
    r.date = r.exif.date;
    r.tier = 1;
    r.rawStamp = r.exif.raw;
  } else {
    const d = dateFromName(file.name);
    if (d) { r.date = d; r.tier = 3; }
    else { r.date = new Date(file.lastModified); r.tier = 4; }
  }

  /* 尺寸得靠實際解碼才準；順便驗證這個瀏覽器解不解得開這張圖 */
  try {
    const bmp = await createImageBitmap(file);
    r.width = bmp.width;
    r.height = bmp.height;
    bmp.close();
  } catch (e) {
    r.error = "這個瀏覽器無法解碼這張圖片（HEIC 在 Safari 以外多半不支援）";
  }

  return r;
}
