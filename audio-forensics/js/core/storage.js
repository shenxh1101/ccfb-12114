// IndexedDB 持久层：证据元数据、保管链、分析结果全部只存本机浏览器。
// Blob 可选保存（默认保存，便于复检；提供删除入口）。
const DB_NAME = 'audio-forensics-db';
const DB_VERSION = 1;
const STORES = { evidence: 'evidence', chains: 'chains', analyses: 'analyses' };

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.evidence)) db.createObjectStore(STORES.evidence, { keyPath: 'evidenceId' });
      if (!db.objectStoreNames.contains(STORES.chains)) db.createObjectStore(STORES.chains, { keyPath: 'evidenceId' });
      if (!db.objectStoreNames.contains(STORES.analyses)) db.createObjectStore(STORES.analyses, { keyPath: 'analysisId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbPut(store, value) {
  const db = await openDB();
  try { await reqPromise(tx(db, store, 'readwrite').put(value)); } finally { db.close(); }
}

export async function idbGet(store, key) {
  const db = await openDB();
  try { return await reqPromise(tx(db, store).get(key)); } finally { db.close(); }
}

export async function idbGetAll(store) {
  const db = await openDB();
  try { return await reqPromise(tx(db, store).getAll()); } finally { db.close(); }
}

export async function idbDelete(store, key) {
  const db = await openDB();
  try { await reqPromise(tx(db, store, 'readwrite').delete(key)); } finally { db.close(); }
}

export { STORES };
