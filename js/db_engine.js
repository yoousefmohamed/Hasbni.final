/* =====================================================================
   HASSIBNI DB ENGINE v4 — النسخة الذكية
   ✅ IndexedDB أولاً + localStorage كـ fallback
   ✅ Product Index (Map) للبحث الفوري O(1)
   ✅ debounce + throttle مدمجان
   ✅ Schema upgrade تلقائي
   ✅ Export / Import كامل
   ===================================================================== */
'use strict';

/* ── Utilities ── */
function debounce(fn, ms = 150) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function throttle(fn, ms = 300) {
  let last = 0;
  return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } };
}

/* ── Constants ── */
const DB_KEY      = 'hasibni_v9';
const IDB_NAME    = 'hassibni_db';
const IDB_VER     = 4;

/* ── IndexedDB ── */
let _idb = null;
function _openIDB() {
  return new Promise((resolve, reject) => {
    if (_idb) { resolve(_idb); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('data'))     db.createObjectStore('data');
      if (!db.objectStoreNames.contains('products')) {
        const ps = db.createObjectStore('products', { keyPath: 'id' });
        ps.createIndex('name', 'name', { unique: false });
        ps.createIndex('barcode', 'barcode', { unique: false });
        ps.createIndex('category', 'category', { unique: false });
      }
      if (!db.objectStoreNames.contains('images'))   db.createObjectStore('images');
    };
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = ()  => reject(req.error);
  });
}

async function _idbPut(store, key, val) {
  try {
    const db = await _openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch(e) { console.warn('IDB put error', e); }
}

async function _idbGet(store, key) {
  try {
    const db = await _openIDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror   = rej;
    });
  } catch(e) { return null; }
}

async function _idbGetAll(store) {
  try {
    const db = await _openIDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = rej;
    });
  } catch(e) { return []; }
}

async function _idbClearAndPutAll(store, items) {
  try {
    const db = await _openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const st = tx.objectStore(store);
      st.clear();
      items.forEach(i => st.put(i));
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch(e) {}
}

/* ── Product Images ── */
async function saveProductImageIDB(pid, data) { await _idbPut('images', pid, data); }
async function getProductImageIDB(pid) { return await _idbGet('images', pid); }

/* ── Slim DB (strip large images for main save) ── */
function _slimDB(dbObj) {
  return {
    ...dbObj,
    products: (dbObj.products || []).map(p => {
      if (!p.image || p.image.length < 800) return p;
      const { image, ...rest } = p;
      return { ...rest, hasImage: true };
    })
  };
}

/* ── Save ── */
let _saveTimer = null;
function saveDB() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 350);
}
function saveDBNow() {
  clearTimeout(_saveTimer);
  _flushSave();
}
async function _flushSave() {
  if (!window.db) return;
  try {
    if (db.products?.length) _idbClearAndPutAll('products', db.products.map(({ image, ...r }) => r));
    const slim     = _slimDB(db);
    const snapshot = JSON.stringify(slim);
    _idbPut('data', DB_KEY, snapshot);
    try {
      if (snapshot.length < 4_000_000) localStorage.setItem(DB_KEY, snapshot);
      else { localStorage.setItem(DB_KEY, JSON.stringify({ ...slim, products: [] })); localStorage.setItem(DB_KEY + '_idb', '1'); }
    } catch(e) {
      try { localStorage.setItem(DB_KEY, JSON.stringify({ ...slim, products: [] })); } catch(e2) {}
    }
  } catch(e) { console.error('saveDB error', e); }
}

/* ── Load ── */
function loadDB() {
  try { const r = localStorage.getItem(DB_KEY); if (r) return mergeDB(JSON.parse(r)); } catch(e) {}
  return getDefaultDB();
}
async function loadDBAsync() {
  try {
    const raw = await _idbGet('data', DB_KEY);
    if (raw) {
      const base  = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const prods = await _idbGetAll('products');
      if (prods?.length) {
        const lsMap = {};
        (base.products || []).forEach(p => { if (p.image) lsMap[p.id] = p.image; });
        base.products = prods.map(p => ({ ...p, image: lsMap[p.id] || '' }));
      }
      return mergeDB(base);
    }
  } catch(e) {}
  return loadDB();
}

/* ── Schema Migrations: mergeDB ensures all keys exist ── */
function mergeDB(saved) {
  const def = getDefaultDB();
  const out  = { ...def, ...saved };
  // Ensure all setting keys exist
  out.settings = { ...def.settings, ...(saved.settings || {}) };
  // Ensure new arrays introduced in v22
  if (!out.customerPayments)  out.customerPayments  = [];
  if (!out.supplierPayments)  out.supplierPayments   = [];
  if (!out.partners)          out.partners           = [];
  if (!out.partnerTransactions) out.partnerTransactions = [];
  if (!out.partnerAuditLog)   out.partnerAuditLog    = [];
  if (!out.balanceMovements)  out.balanceMovements   = [];
  if (!out.payments)          out.payments           = [];
  return out;
}

/* ── Default Schema ── */
function getDefaultDB() {
  return {
    settings: {
      storeName: 'متجري', address: '', contact: '', email: '',
      tax: 0, currency: 'جنيه', lowStock: 5,
      invoiceNotes: 'شكرًا لتعاملكم معنا',
      paperWidth: '80', storeNameSize: 22, dataTextSize: 12, storeLogo: ''
    },
    products: [], sales: [], purchases: [],
    customers: [], suppliers: [], employees: [],
    treasury: [], expenses: [], logs: [], returns: [], purchaseReturns: [],
    customerPayments: [], supplierPayments: [],
    partners: [], partnerTransactions: [], partnerAuditLog: [],
    sessions: [], rawMaterials: [], productionOrders: [], rawMovements: [], productionSeq: 1,
    balanceMovements: [], payments: [], bankBalance: 0,
    users: [
      { id: 'u1', name: 'مدير النظام', username: 'admin',   password: '010999', role: 'admin',    icon: '👑', status: 'active', lastLogin: null },
      { id: 'u2', name: 'كاشير',       username: 'cashier', password: '010666', role: 'cashier',  icon: '💼', status: 'active', lastLogin: null },
      { id: 'u3', name: 'مدير المخزن', username: 'store',   password: '010123', role: 'store',    icon: '📦', status: 'active', lastLogin: null },
    ],
    categories: ['عام', 'مشروبات', 'مواد غذائية', 'إلكترونيات', 'ملابس', 'أدوات منزلية'],
  };
}

/* ── Product Index (O(1) lookup) ── */
const _prodIdx = {
  byId: new Map(), byBarcode: new Map(),
  build(products) {
    this.byId.clear(); this.byBarcode.clear();
    (products || []).forEach(p => {
      this.byId.set(p.id, p);
      if (p.barcode) this.byBarcode.set(String(p.barcode), p);
    });
  },
  rebuild()       { if (window.db) this.build(db.products); },
  get(id)         { return this.byId.get(id); },
  getByBarcode(b) { return this.byBarcode.get(String(b)); },
  search(q, cat)  {
    const ql = (q||'').toLowerCase(), results = [];
    for (const p of this.byId.values()) {
      if ((!q || p.name.toLowerCase().includes(ql) || String(p.barcode||'').includes(q))
        && (!cat || cat === 'all' || p.category === cat)) results.push(p);
    }
    return results;
  },
  add(p)    { this.byId.set(p.id, p); if (p.barcode) this.byBarcode.set(String(p.barcode), p); },
  remove(id){ const p = this.byId.get(id); if (p?.barcode) this.byBarcode.delete(String(p.barcode)); this.byId.delete(id); },
  update(p) { this.remove(p.id); this.add(p); }
};

/* ── Export / Import ── */
function exportDBBackup() {
  const data = JSON.stringify(db, null, 2);
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `hassibni_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  showToast('✅ تم تصدير النسخة الاحتياطية');
}
function importDBBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.settings || !parsed.products) throw new Error('ملف غير صالح');
      if (!confirm('⚠️ سيتم استبدال جميع البيانات الحالية. هل أنت متأكد؟')) return;
      window.db = mergeDB(parsed);
      saveDBNow();
      location.reload();
    } catch(err) { showToast('❌ فشل الاستيراد: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
}

/* ── Globals ── */
window._prodIdx             = _prodIdx;
window.saveDB               = saveDB;
window.saveDBNow            = saveDBNow;
window.loadDB               = loadDB;
window.loadDBAsync          = loadDBAsync;
window.getDefaultDB         = getDefaultDB;
window.mergeDB              = mergeDB;
window.debounce             = debounce;
window.throttle             = throttle;
window.saveProductImageIDB  = saveProductImageIDB;
window.getProductImageIDB   = getProductImageIDB;
window.exportDBBackup       = exportDBBackup;
window.importDBBackup       = importDBBackup;
