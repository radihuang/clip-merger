/*
 * history.js — 合併紀錄的儲存層（IndexedDB）
 *
 * 只存「做過什麼」的中繼資料與縮圖，不存成品影片：
 * 實測一筆四段的紀錄約 7 KB（縮圖每張約 2 KB），就算被 iOS 清掉損失也小。
 *
 * iOS 的清除政策（2026-09-08 查證 WebKit 官方說明）：某個來源連續 7 天
 * 沒有使用者互動，它的 script 建立的資料會被整包刪除，不是刪一部分。
 * navigator.storage.persist() 可以申請豁免，WebKit 依「是不是主畫面
 * App」等啟發式決定，不保證核准 —— 所以這裡只是盡量申請，不當成保證。
 */

const DB_NAME = "clip-merger";
const DB_VER = 1;
const STORE = "merges";

let dbPromise = null;

/* IndexedDB 在無痕模式／關閉網站資料時會直接不存在或開啟就拋錯。
   這裡不吞掉錯誤，讓呼叫端拿到原因去顯示。 */
function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      reject(new Error("這個瀏覽器沒有提供 IndexedDB（無痕模式常會關閉）"));
      return;
    }

    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      reject(new Error("開啟本機資料庫被拒絕：" + (e?.message || e)));
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("開啟本機資料庫失敗"));
    req.onblocked = () => reject(new Error("本機資料庫被其他分頁佔住，請關掉這個網站的其他分頁再試"));
  });

  // 開失敗就把快取清掉，下次還能重試
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const os = tx.objectStore(STORE);
    let out;
    try {
      out = fn(os);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    tx.onerror = () => reject(tx.error || new Error("資料庫操作失敗"));
    tx.onabort = () => reject(tx.error || new Error("資料庫操作被中止（可能是空間不足）"));
  }));
}

/* 盡量讓資料免於被清除。回傳是否核准；不支援就回 null 代表無從得知。 */
export async function requestPersist() {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/* 只查詢目前狀態，不發出申請。回傳 true／false；瀏覽器沒有這個介面時回 null。 */
export async function persistStatus() {
  if (!navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

export function addRecord(rec) {
  return run("readwrite", os => os.add(rec));
}

/* 新到舊 */
export async function listRecords() {
  const rows = await run("readonly", os => os.getAll());
  return (rows || []).sort((a, b) => b.at - a.at);
}

export function deleteRecord(id) {
  return run("readwrite", os => os.delete(id));
}

export function clearAll() {
  return run("readwrite", os => os.clear());
}

export function countRecords() {
  return run("readonly", os => os.count());
}

/*
 * 把一次合併整理成一筆紀錄。抽成純函式是為了能餵假資料驗證，
 * 不必真的跑一次編碼。不碰 DOM、不碰 IndexedDB。
 */
export function buildRecord({ clips, settings, outBytes, outSeconds, outW, outH, at }) {
  return {
    at: at ?? Date.now(),
    outBytes,
    outSeconds,
    outW,
    outH,
    settings: {
      perClipSeconds: settings.perClipSeconds,
      fit: settings.fit,
      keepAudio: !!settings.keepAudio,
      fadeOut: !!settings.fadeOut,
      globalEffect: settings.globalEffect,
      globalFilter: settings.globalFilter ?? "none",
    },
    clips: clips.map(c => ({
      name: c.name,
      kind: c.kind,
      tier: c.tier ?? 4,
      date: c.date instanceof Date ? c.date.getTime() : (c.date ?? null),
      seconds: c.seconds,
      // 照片沒單獨指定時是跟隨全域設定，存進紀錄時要解析成實際用的那一個
      effect: c.kind === "photo" ? (c.effect ?? settings.globalEffect) : null,
      // 濾鏡影片與照片都有，同樣解析成實際套用的那一個
      filter: c.filter ?? settings.globalFilter ?? "none",
      hasAudio: !!c.hasAudio,
      thumb: c.thumb || null,
    })),
  };
}
