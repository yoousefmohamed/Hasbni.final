/* =====================================================================
   HASSIBNI — وحدة الإنتاج v2
   مدمجة بالكامل مع حاسبني — تعتمد على db, el, uid, fmtCurr, saveDB,
   showToast, openModal, closeModal, addLog, can, currentUser
   ===================================================================== */
'use strict';

/* ──────────────────────────────────────────────────────────────
   1. ترقية قاعدة البيانات (تأمين الحقول المطلوبة)
   ────────────────────────────────────────────────────────────── */
function upgradeProductionDB() {
  if (!db) return;
  let changed = false;
  if (!db.rawMaterials)      { db.rawMaterials = [];     changed = true; }
  if (!db.productionOrders)  { db.productionOrders = []; changed = true; }
  if (!db.rawMovements)      { db.rawMovements = [];      changed = true; }
  if (db.productionSeq == null){ db.productionSeq = 1;   changed = true; }
  if (changed) saveDB();
}

/* ──────────────────────────────────────────────────────────────
   2. حالة الوحدة
   ────────────────────────────────────────────────────────────── */
let _prodTab        = 'prod-orders';
let _editingOrderId = null;
let _bomRows        = [];

const _statusLabel = {
  pending:'قيد الانتظار', in_progress:'قيد التنفيذ',
  done:'مكتمل', cancelled:'ملغي'
};
const _statusBadge = {
  pending:'badge-orange', in_progress:'badge-blue',
  done:'badge-green',     cancelled:'badge-red'
};
const _priorityLabel = { high:'🔴 عالية', medium:'🟡 متوسطة', low:'🟢 منخفضة' };
const _priorityBadge = { high:'badge-red', medium:'badge-orange', low:'badge-green' };

/* ──────────────────────────────────────────────────────────────
   3. نقطة الدخول الرئيسية
   ────────────────────────────────────────────────────────────── */
function renderProductionPage() {
  upgradeProductionDB();
  _renderProdKPIs();
  switchProdTab(_prodTab);
}

function _renderProdKPIs() {
  const o = db.productionOrders || [];
  const raw = db.rawMaterials || [];
  const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  set('prod-kpi-total', o.length);
  set('prod-kpi-done',  o.filter(x => x.status === 'done').length);
  set('prod-kpi-prog',  o.filter(x => x.status === 'in_progress').length);
  set('prod-kpi-pend',  o.filter(x => x.status === 'pending').length);
  set('prod-kpi-low',   raw.filter(m => (m.stock || 0) <= (m.minStock || 0)).length);
}

/* ──────────────────────────────────────────────────────────────
   4. تبويبات
   ────────────────────────────────────────────────────────────── */
function switchProdTab(tab) {
  _prodTab = tab;
  ['prod-orders','prod-raw','prod-reports'].forEach(t => {
    const btn  = el('prodtab-' + t);
    const pane = el('prodpanel-' + t);
    if (btn)  btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = (t === tab) ? '' : 'none';
  });
  if (tab === 'prod-orders')  renderProdOrders();
  if (tab === 'prod-raw')     renderRawMaterials();
  if (tab === 'prod-reports') renderProdReports();
}

/* ──────────────────────────────────────────────────────────────
   5. جدول أوامر الإنتاج
   ────────────────────────────────────────────────────────────── */
function renderProdOrders() {
  const q  = (el('prod-order-search')?.value || '').toLowerCase();
  const sf = el('prod-status-filter')?.value   || '';
  const pf = el('prod-priority-filter')?.value || '';

  let list = (db.productionOrders || []).filter(o => {
    const prod = (db.products || []).find(p => p.id === o.productId);
    return (!q  || o.id.toLowerCase().includes(q) || (prod?.name || '').toLowerCase().includes(q))
        && (!sf || o.status   === sf)
        && (!pf || o.priority === pf);
  }).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  const badge = el('prodtab-badge-orders');
  if (badge) badge.textContent = list.length;

  const tbody = el('prod-orders-tbody');
  if (!tbody) return;

  tbody.innerHTML = list.length ? list.map(o => {
    const prod  = (db.products || []).find(p => p.id === o.productId);
    const sb    = _statusBadge[o.status]    || 'badge-blue';
    const pb    = _priorityBadge[o.priority]|| 'badge-orange';
    const pct   = o.status === 'done' ? 100 : o.status === 'in_progress' ? 50 : 0;
    const pclr  = pct === 100 ? 'var(--accent-green)' : pct > 0 ? 'var(--accent-blue)' : 'var(--bg3)';
    const isActive = o.status !== 'done' && o.status !== 'cancelled';
    return `<tr>
      <td><strong style="color:var(--accent-blue)">${o.id}</strong></td>
      <td>${prod ? prod.name : '<em style="color:var(--text-muted)">غير محدد</em>'}</td>
      <td>${o.qty} ${prod?.unit || 'قطعة'}</td>
      <td>${o.startDate || '—'}</td>
      <td>${o.endDate || '—'}</td>
      <td><span class="badge ${sb}">${_statusLabel[o.status] || o.status}</span></td>
      <td><span class="badge ${pb}">${_priorityLabel[o.priority] || '—'}</span></td>
      <td>
        <div style="width:80px">
          <div style="height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${pclr};border-radius:3px;transition:width .4s"></div>
          </div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">${pct}%</div>
        </div>
      </td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="viewProdOrder('${o.id}')"><i class="fa fa-eye"></i></button>
          ${o.status === 'pending'     ? `<button class="btn btn-blue btn-sm" onclick="startProdOrder('${o.id}')"><i class="fa fa-play"></i> بدء</button>` : ''}
          ${o.status === 'in_progress' ? `<button class="btn btn-success btn-sm" onclick="completeProdOrder('${o.id}')"><i class="fa fa-check"></i> إكمال</button>` : ''}
          ${isActive ? `<button class="btn btn-ghost btn-sm" onclick="openProdOrderModal('${o.id}')"><i class="fa fa-pen"></i></button>` : ''}
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteProdOrder('${o.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="empty-state"><p>لا توجد أوامر إنتاج</p></td></tr>`;

  const info = el('prod-pg-info');
  if (info) info.textContent = `${list.length} أمر`;
}

/* ──────────────────────────────────────────────────────────────
   6. موديل أمر الإنتاج (جديد / تعديل)
   ────────────────────────────────────────────────────────────── */
function openProdOrderModal(oid) {
  upgradeProductionDB();
  _editingOrderId = oid || null;
  _bomRows = [];

  const titleEl = el('prod-order-modal-title');
  if (titleEl) titleEl.textContent = oid ? 'تعديل أمر الإنتاج' : 'أمر إنتاج جديد';

  // قائمة المنتجات من db
  const prodSel = el('prod-o-product');
  if (prodSel) {
    prodSel.innerHTML = '<option value="">— اختر المنتج النهائي —</option>'
      + (db.products || []).map(p =>
          `<option value="${p.id}">${p.name} (مخزون: ${p.qty || 0} ${p.unit || ''})</option>`
        ).join('');
  }

  const today = new Date().toISOString().split('T')[0];
  const week  = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];

  if (oid) {
    const o = (db.productionOrders || []).find(x => x.id === oid);
    if (!o) return;
    if (prodSel) prodSel.value              = o.productId || '';
    if (el('prod-o-qty'))      el('prod-o-qty').value      = o.qty;
    if (el('prod-o-start'))    el('prod-o-start').value    = o.startDate || today;
    if (el('prod-o-end'))      el('prod-o-end').value      = o.endDate   || week;
    if (el('prod-o-priority')) el('prod-o-priority').value = o.priority  || 'medium';
    if (el('prod-o-notes'))    el('prod-o-notes').value    = o.notes     || '';
    _bomRows = (o.bom || []).map(b => ({ ...b, _id: uid() }));
  } else {
    if (prodSel) prodSel.value = '';
    if (el('prod-o-qty'))      el('prod-o-qty').value      = '';
    if (el('prod-o-start'))    el('prod-o-start').value    = today;
    if (el('prod-o-end'))      el('prod-o-end').value      = week;
    if (el('prod-o-priority')) el('prod-o-priority').value = 'medium';
    if (el('prod-o-notes'))    el('prod-o-notes').value    = '';
  }

  _renderBomList();
  openModal('modal-prod-order');
}

/* ──────────────────────────────────────────────────────────────
   7. BOM (قائمة المواد المطلوبة)
   ────────────────────────────────────────────────────────────── */
function _renderBomList() {
  const container = el('prod-bom-list');
  const emptyMsg  = el('prod-bom-empty');
  const sumDiv    = el('prod-bom-summary');
  if (!container) return;

  if (!_bomRows.length) {
    container.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = '';
    if (sumDiv)   sumDiv.style.display   = 'none';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  const mats  = db.rawMaterials || [];
  let totalCost = 0;

  container.innerHTML = _bomRows.map((r, i) => {
    const m     = mats.find(x => x.code === r.matCode);
    const avail = m ? (m.stock || 0) : 0;
    const need  = r.qty || 1;
    const cost  = m ? (m.cost || 0) * need : 0;
    totalCost  += cost;
    const pct   = m?.minStock ? Math.min(100, Math.round(avail / m.minStock * 100)) : 100;
    const clr   = pct >= 80 ? 'var(--accent-green)' : pct >= 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
    const opts  = mats.map(mx =>
      `<option value="${mx.code}" ${mx.code === r.matCode ? 'selected' : ''}>${mx.name} (${mx.stock || 0} ${mx.unit || ''})</option>`
    ).join('');

    return `<div class="bom-item-row">
      <span class="bom-num">${i + 1}</span>
      <select class="bom-mat-sel" onchange="onBomMatChange('${r._id}',this.value)">
        <option value="">اختر المادة...</option>${opts}
      </select>
      <input type="number" class="bom-qty-inp" min="0.01" step="0.01" value="${need}"
        onchange="onBomQtyChange('${r._id}',this.value)" placeholder="الكمية">
      <div class="bom-stock-info">
        <div class="bom-stock-row">
          <span class="bom-stock-label">متوفر:</span>
          <span class="bom-stock-val">${avail} ${m?.unit || ''}</span>
        </div>
        <div style="height:4px;background:var(--bg3);border-radius:3px;overflow:hidden;margin-top:3px">
          <div style="width:${pct}%;height:100%;background:${clr};border-radius:3px"></div>
        </div>
      </div>
      <button class="bom-remove-btn" onclick="removeBomRow('${r._id}')"><i class="fa fa-times"></i></button>
    </div>`;
  }).join('');

  if (sumDiv) {
    sumDiv.style.display = '';
    const qty   = parseFloat(el('prod-o-qty')?.value || 0) || 0;
    const labor = qty * 5;
    const total = totalCost + labor;
    const s = (id, v) => { const e = el(id); if (e) e.textContent = fmtCurr(v); };
    s('prod-sum-mat',   totalCost);
    s('prod-sum-labor', labor);
    s('prod-sum-total', total);
  }
}

function addBomRow() {
  _bomRows.push({ _id: uid(), matCode: '', qty: 1 });
  _renderBomList();
}

function removeBomRow(rid) {
  _bomRows = _bomRows.filter(r => r._id !== rid);
  _renderBomList();
}

function onBomMatChange(rid, code) {
  const r = _bomRows.find(x => x._id === rid);
  if (r) { r.matCode = code; _renderBomList(); }
}

function onBomQtyChange(rid, qty) {
  const r = _bomRows.find(x => x._id === rid);
  if (r) { r.qty = parseFloat(qty) || 1; _renderBomList(); }
}

/* ──────────────────────────────────────────────────────────────
   8. حفظ أمر الإنتاج
   ────────────────────────────────────────────────────────────── */
function saveProdOrder() {
  const productId = el('prod-o-product')?.value  || '';
  const qty       = parseFloat(el('prod-o-qty')?.value || 0);
  const startDate = el('prod-o-start')?.value    || '';
  const endDate   = el('prod-o-end')?.value      || '';
  const priority  = el('prod-o-priority')?.value || 'medium';
  const notes     = el('prod-o-notes')?.value    || '';

  if (!productId)    { showToast('يرجى اختيار المنتج النهائي', 'warning'); return; }
  if (!qty || qty<1) { showToast('يرجى إدخال كمية صحيحة', 'warning');     return; }
  if (!startDate || !endDate) { showToast('يرجى تحديد تواريخ البدء والانتهاء', 'warning'); return; }

  const bom = _bomRows.filter(r => r.matCode).map(r => ({ matCode: r.matCode, qty: r.qty }));

  if (_editingOrderId) {
    const idx = (db.productionOrders || []).findIndex(x => x.id === _editingOrderId);
    if (idx > -1) {
      db.productionOrders[idx] = { ...db.productionOrders[idx], productId, qty, startDate, endDate, priority, notes, bom };
      showToast('✅ تم تحديث أمر الإنتاج');
    }
  } else {
    const seq = db.productionSeq || 1;
    db.productionSeq = seq + 1;
    const newOrder = {
      id: 'MO-' + String(seq).padStart(4, '0'),
      productId, qty, startDate, endDate, priority, notes, bom,
      status: 'pending',
      ts:   new Date().toISOString(),
      date: new Date().toLocaleDateString('ar-EG'),
      createdBy: currentUser?.name || '—'
    };
    if (!db.productionOrders) db.productionOrders = [];
    db.productionOrders.push(newOrder);
    if (typeof addLog === 'function') addLog('إنتاج', 'أمر إنتاج جديد: ' + newOrder.id, 'إنتاج');
    showToast('✅ تم إنشاء أمر الإنتاج ' + newOrder.id);
  }

  saveDB();
  closeModal('modal-prod-order');
  renderProductionPage();
}

/* ──────────────────────────────────────────────────────────────
   9. بدء التنفيذ — ينقص مخزون الخامات
   ────────────────────────────────────────────────────────────── */
function startProdOrder(oid) {
  const o = (db.productionOrders || []).find(x => x.id === oid);
  if (!o) return;

  const missing = [];
  (o.bom || []).forEach(b => {
    const m = (db.rawMaterials || []).find(x => x.code === b.matCode);
    if (!m || (m.stock || 0) < b.qty) {
      missing.push((m?.name || b.matCode) + ': متوفر ' + (m?.stock || 0) + ' / مطلوب ' + b.qty);
    }
  });

  if (missing.length) {
    const go = confirm('⚠️ مواد خام غير كافية:\n' + missing.join('\n') + '\n\nهل تريد إنشاء طلبات شراء للمواد الناقصة والمتابعة؟');
    if (!go) return;
    _createPurchaseRequestsForOrder(o);
  }

  // خصم المواد
  (o.bom || []).forEach(b => {
    const m = (db.rawMaterials || []).find(x => x.code === b.matCode);
    if (m) {
      const before = m.stock || 0;
      m.stock = Math.max(0, before - b.qty);
      if (!db.rawMovements) db.rawMovements = [];
      db.rawMovements.push({
        id: uid(), matCode: b.matCode, matName: m.name,
        type: 'consume', qty: -b.qty,
        stockBefore: before, stockAfter: m.stock,
        orderId: oid,
        date: new Date().toLocaleDateString('ar-EG'),
        ts:   new Date().toISOString(),
        by:   currentUser?.name || '—'
      });
    }
  });

  o.status    = 'in_progress';
  o.startedAt = new Date().toISOString();
  if (typeof addLog === 'function') addLog('إنتاج', 'بدء تنفيذ: ' + oid, 'إنتاج');
  saveDB();
  showToast('✅ تم بدء تنفيذ ' + oid);
  renderProductionPage();
}

/* ──────────────────────────────────────────────────────────────
   10. إكمال الأمر — يُضيف للمخزون
   ────────────────────────────────────────────────────────────── */
function completeProdOrder(oid) {
  const o = (db.productionOrders || []).find(x => x.id === oid);
  if (!o) return;

  if (!confirm('هل تريد إكمال أمر الإنتاج ' + oid + '؟\nسيُضاف ' + o.qty + ' وحدة للمخزون.')) return;

  const prod = (db.products || []).find(p => p.id === o.productId);
  if (prod) {
    prod.qty = (prod.qty || 0) + o.qty;
    if (!db.rawMovements) db.rawMovements = [];
    db.rawMovements.push({
      id: uid(), matCode: o.productId, matName: prod.name,
      type: 'produce', qty: o.qty,
      orderId: oid,
      date: new Date().toLocaleDateString('ar-EG'),
      ts:   new Date().toISOString(),
      by:   currentUser?.name || '—'
    });
    _prodIdx?.update && _prodIdx.update(prod);
  }

  o.status      = 'done';
  o.completedAt = new Date().toISOString();
  if (typeof addLog === 'function') addLog('إنتاج', 'اكتمال: ' + oid + ' — ' + o.qty + ' وحدة', 'إنتاج');
  saveDB();
  showToast('✅ تم إكمال الأمر ' + oid + ' — تم إضافة ' + o.qty + ' للمخزون');
  renderProductionPage();
}

/* ──────────────────────────────────────────────────────────────
   11. عرض تفاصيل أمر
   ────────────────────────────────────────────────────────────── */
function viewProdOrder(oid) {
  const o = (db.productionOrders || []).find(x => x.id === oid);
  if (!o) return;
  const prod = (db.products || []).find(p => p.id === o.productId);

  const bomHTML = (o.bom || []).map(b => {
    const m    = (db.rawMaterials || []).find(x => x.code === b.matCode);
    const cost = m ? fmtCurr((m.cost || 0) * b.qty) : '—';
    const ok   = (m?.stock || 0) >= b.qty;
    return `<tr>
      <td>${m?.name || b.matCode}</td>
      <td>${b.qty} ${m?.unit || ''}</td>
      <td style="color:var(--accent-blue)">${cost}</td>
      <td><span class="badge ${ok ? 'badge-green' : 'badge-red'}">${ok ? 'متوفر' : 'غير كافٍ'}</span></td>
    </tr>`;
  }).join('');

  const content = el('prod-details-content');
  if (!content) return;

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div class="det-cell"><div class="det-lbl">رقم الأمر</div><div class="det-val" style="color:var(--accent-blue)">${o.id}</div></div>
      <div class="det-cell"><div class="det-lbl">المنتج النهائي</div><div class="det-val">${prod?.name || '—'}</div></div>
      <div class="det-cell"><div class="det-lbl">الكمية</div><div class="det-val">${o.qty} ${prod?.unit || 'قطعة'}</div></div>
      <div class="det-cell"><div class="det-lbl">الأولوية</div><div class="det-val">${_priorityLabel[o.priority] || '—'}</div></div>
      <div class="det-cell"><div class="det-lbl">تاريخ البدء</div><div class="det-val">${o.startDate || '—'}</div></div>
      <div class="det-cell"><div class="det-lbl">تاريخ الانتهاء</div><div class="det-val">${o.endDate || '—'}</div></div>
      <div class="det-cell" style="grid-column:span 2">
        <div class="det-lbl">الحالة</div>
        <div class="det-val"><span class="badge ${_statusBadge[o.status] || 'badge-blue'}">${_statusLabel[o.status] || o.status}</span></div>
      </div>
      ${o.notes ? `<div class="det-cell" style="grid-column:span 2"><div class="det-lbl">ملاحظات</div><div class="det-val">${o.notes}</div></div>` : ''}
    </div>
    ${bomHTML ? `
    <div style="margin-top:8px">
      <div style="font-size:0.82rem;font-weight:700;color:var(--text-muted);margin-bottom:8px">🧪 الخامات المطلوبة</div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>المادة</th><th>الكمية</th><th>التكلفة</th><th>الحالة</th></tr></thead>
          <tbody>${bomHTML}</tbody>
        </table>
      </div>
    </div>` : '<p style="color:var(--text-muted);text-align:center;padding:12px;font-size:0.85rem">لا توجد خامات مرتبطة</p>'}
  `;

  // أزرار الإجراءات
  const btnStart    = el('prod-btn-start');
  const btnComplete = el('prod-btn-complete');
  const btnCancel   = el('prod-btn-cancel');
  if (btnStart)    { btnStart.style.display    = o.status === 'pending'     ? '' : 'none'; btnStart.onclick    = () => { closeModal('modal-prod-details'); startProdOrder(oid); }; }
  if (btnComplete) { btnComplete.style.display = o.status === 'in_progress' ? '' : 'none'; btnComplete.onclick = () => { closeModal('modal-prod-details'); completeProdOrder(oid); }; }
  if (btnCancel)   { btnCancel.style.display   = (o.status !== 'done' && o.status !== 'cancelled') ? '' : 'none'; btnCancel.onclick = () => { if (confirm('إلغاء هذا الأمر؟')) { o.status = 'cancelled'; saveDB(); closeModal('modal-prod-details'); showToast('تم إلغاء الأمر'); renderProductionPage(); } }; }

  openModal('modal-prod-details');
}

function deleteProdOrder(oid) {
  if (!confirm('حذف أمر الإنتاج ' + oid + ' نهائياً؟')) return;
  db.productionOrders = (db.productionOrders || []).filter(x => x.id !== oid);
  saveDB();
  showToast('تم الحذف');
  renderProductionPage();
}

/* ──────────────────────────────────────────────────────────────
   12. إنشاء فاتورة شراء للخامات الناقصة ← ربط بنقطة الشراء
   ────────────────────────────────────────────────────────────── */
function _createPurchaseRequestsForOrder(order) {
  if (!db.purchases) db.purchases = [];
  const count  = db.purchases.length + 1;
  const invNum = 'PO-PROD-' + String(count).padStart(4, '0');
  const items  = [];
  let total    = 0;

  (order.bom || []).forEach(b => {
    const m = (db.rawMaterials || []).find(x => x.code === b.matCode);
    if (!m) return;
    const deficit = Math.max(0, b.qty - (m.stock || 0));
    if (deficit <= 0) return;
    items.push({ productName: m.name, rawCode: m.code, qty: deficit, cost: m.cost || 0, unit: m.unit || '' });
    total += deficit * (m.cost || 0);
  });

  if (!items.length) return;

  const firstMat   = (db.rawMaterials || []).find(m => m.code === order.bom?.[0]?.matCode);
  const supplierId = firstMat?.supplierId || '';
  const sup        = (db.suppliers || []).find(s => s.id === supplierId);

  db.purchases.push({
    id: uid(), invNum,
    date: new Date().toLocaleDateString('ar-EG'), ts: new Date().toISOString(),
    supplierId, supplierName: sup?.name || 'مورد الإنتاج',
    items, subtotal: total, discount: 0, tax: 0, total,
    payment: 'آجل', paymentType: 'credit', paidAmount: 0, remaining: total,
    orderType: 'شراء خامات إنتاج',
    notes: 'خامات لأمر إنتاج: ' + order.id,
    cashier: currentUser?.name || '—',
    linkedOrderId: order.id
  });

  if (sup && total > 0) {
    sup.balance = (sup.balance || 0) + total;
    if (typeof addBalanceMovement === 'function') {
      addBalanceMovement({ type:'purchase_credit', entityId:sup.id, entityName:sup.name, entityType:'supplier', amount:total, invoiceNum:invNum, notes:'خامات لأمر إنتاج ' + order.id });
    }
  }

  if (typeof addLog === 'function') addLog('شراء', 'فاتورة شراء خامات ' + invNum, 'شراء');
  saveDB();
  showToast('📋 تم إنشاء طلب شراء ' + invNum + ' للخامات الناقصة');
}

/* ──────────────────────────────────────────────────────────────
   13. طلب شراء يدوي لمادة خام
   ────────────────────────────────────────────────────────────── */
function orderRawMaterial(code) {
  const m = (db.rawMaterials || []).find(x => x.code === code);
  if (!m) return;

  const qtyStr = prompt(
    'طلب: ' + m.name + '\nالمخزون الحالي: ' + (m.stock || 0) + ' ' + (m.unit || '') +
    '\nالحد الأدنى: ' + (m.minStock || 0) + ' ' + (m.unit || '') +
    '\n\nأدخل الكمية المطلوبة:',
    String(m.minStock || 10)
  );
  if (!qtyStr) return;
  const qty = parseFloat(qtyStr);
  if (!qty || qty <= 0) { showToast('كمية غير صحيحة', 'warning'); return; }

  if (!db.purchases) db.purchases = [];
  const count  = db.purchases.length + 1;
  const invNum = 'PO-RAW-' + String(count).padStart(4, '0');
  const total  = qty * (m.cost || 0);
  const sup    = (db.suppliers || []).find(s => s.id === m.supplierId);

  db.purchases.push({
    id: uid(), invNum,
    date: new Date().toLocaleDateString('ar-EG'), ts: new Date().toISOString(),
    supplierId: m.supplierId || '', supplierName: sup?.name || m.supplierName || 'مورد',
    items: [{ productName: m.name, rawCode: code, qty, cost: m.cost || 0, unit: m.unit || '' }],
    subtotal: total, discount: 0, tax: 0, total,
    payment: 'آجل', paymentType: 'credit', paidAmount: 0, remaining: total,
    orderType: 'شراء مواد خام',
    notes: 'طلب مادة خام: ' + m.name,
    cashier: currentUser?.name || '—'
  });

  if (sup && total > 0) {
    sup.balance = (sup.balance || 0) + total;
    if (typeof addBalanceMovement === 'function') {
      addBalanceMovement({ type:'purchase_credit', entityId:sup.id, entityName:sup.name, entityType:'supplier', amount:total, invoiceNum:invNum, notes:'شراء مواد خام: ' + m.name });
    }
  }

  if (typeof addLog === 'function') addLog('شراء', 'طلب مادة خام ' + invNum + ': ' + m.name + ' × ' + qty, 'شراء');
  saveDB();
  showToast('✅ تم إنشاء طلب الشراء ' + invNum);
}

/* ──────────────────────────────────────────────────────────────
   14. استلام مادة خام (ربط من فاتورة الشراء)
   ────────────────────────────────────────────────────────────── */
function receiveRawMaterial(code, qty, purchaseInvNum) {
  const m = (db.rawMaterials || []).find(x => x.code === code);
  if (!m || !qty || qty <= 0) return;
  const before = m.stock || 0;
  m.stock = before + qty;
  if (!db.rawMovements) db.rawMovements = [];
  db.rawMovements.push({
    id: uid(), matCode: code, matName: m.name,
    type: 'receive', qty,
    stockBefore: before, stockAfter: m.stock,
    purchaseInv: purchaseInvNum || '',
    date: new Date().toLocaleDateString('ar-EG'),
    ts:   new Date().toISOString(),
    by:   currentUser?.name || '—'
  });
  saveDB();
  showToast('✅ تم استلام ' + qty + ' ' + (m.unit || '') + ' من ' + m.name);
  if (_prodTab === 'prod-raw') renderRawMaterials();
}

/* ──────────────────────────────────────────────────────────────
   15. جدول المواد الخام
   ────────────────────────────────────────────────────────────── */
function renderRawMaterials() {
  const q = (el('raw-search')?.value || '').toLowerCase();
  const list = (db.rawMaterials || []).filter(m =>
    !q || m.name.toLowerCase().includes(q) || m.code.toLowerCase().includes(q)
  );

  const badge = el('prodtab-badge-raw');
  if (badge) badge.textContent = list.length;

  const tbody = el('raw-tbody');
  if (!tbody) return;

  tbody.innerHTML = list.length ? list.map(m => {
    const low   = (m.stock || 0) <= (m.minStock || 0);
    const sup   = (db.suppliers || []).find(s => s.id === m.supplierId);
    const pct   = m.minStock ? Math.min(100, Math.round((m.stock || 0) / m.minStock * 100)) : 100;
    const barClr = pct >= 80 ? 'var(--accent-green)' : pct >= 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
    return `<tr>
      <td><strong style="color:var(--accent-blue)">${m.code}</strong></td>
      <td><strong>${m.name}</strong></td>
      <td>${m.unit || '—'}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="badge ${low ? 'badge-red' : 'badge-green'}">${m.stock || 0}</span>
          <div style="width:60px;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${barClr};border-radius:3px"></div>
          </div>
        </div>
      </td>
      <td>${m.minStock || 0}</td>
      <td style="color:var(--accent-blue)">${fmtCurr(m.cost || 0)}</td>
      <td>${sup?.name || m.supplierName || '—'}</td>
      <td><span class="badge ${low ? 'badge-red' : 'badge-green'}">${low ? '⚠️ منخفض' : '✅ متوفر'}</span></td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="openRawModal('${m.code}')"><i class="fa fa-pen"></i></button>
          <button class="btn btn-blue btn-sm" onclick="orderRawMaterial('${m.code}')"><i class="fa fa-cart-plus"></i> طلب</button>
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteRawMaterial('${m.code}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="empty-state"><p>لا توجد مواد خام مضافة</p></td></tr>`;
}

/* ──────────────────────────────────────────────────────────────
   16. موديل المواد الخام
   ────────────────────────────────────────────────────────────── */
function openRawModal(code) {
  upgradeProductionDB();
  const m = code ? (db.rawMaterials || []).find(x => x.code === code) : null;

  const titleEl = el('raw-modal-title');
  if (titleEl) titleEl.textContent = code ? 'تعديل مادة خام' : 'مادة خام جديدة';

  const codeEl = el('raw-code');
  if (codeEl) { codeEl.value = m?.code || ''; codeEl.readOnly = !!code; }
  if (el('raw-name'))     el('raw-name').value     = m?.name     || '';
  if (el('raw-unit'))     el('raw-unit').value     = m?.unit     || 'كجم';
  if (el('raw-stock'))    el('raw-stock').value    = m?.stock    ?? 0;
  if (el('raw-minstock')) el('raw-minstock').value = m?.minStock ?? 0;
  if (el('raw-cost'))     el('raw-cost').value     = m?.cost     ?? 0;
  if (el('raw-notes'))    el('raw-notes').value    = m?.notes    || '';

  const supSel = el('raw-supplier');
  if (supSel) {
    supSel.innerHTML = '<option value="">— بدون مورد —</option>'
      + (db.suppliers || []).map(s =>
          `<option value="${s.id}" ${s.id === m?.supplierId ? 'selected' : ''}>${s.name}</option>`
        ).join('');
  }

  openModal('modal-raw-material');
}

function saveRawMaterial() {
  const code = (el('raw-code')?.value || '').trim();
  const name = (el('raw-name')?.value || '').trim();
  if (!code || !name) { showToast('يرجى إدخال الكود والاسم', 'warning'); return; }

  if (!db.rawMaterials) db.rawMaterials = [];

  const obj = {
    code, name,
    unit:       el('raw-unit')?.value     || 'كجم',
    stock:      parseFloat(el('raw-stock')?.value    || 0),
    minStock:   parseFloat(el('raw-minstock')?.value || 0),
    cost:       parseFloat(el('raw-cost')?.value     || 0),
    supplierId: el('raw-supplier')?.value || '',
    supplierName: (db.suppliers || []).find(s => s.id === el('raw-supplier')?.value)?.name || '',
    notes: el('raw-notes')?.value || ''
  };

  const idx = db.rawMaterials.findIndex(x => x.code === code);
  if (idx >= 0) db.rawMaterials[idx] = { ...db.rawMaterials[idx], ...obj };
  else db.rawMaterials.push(obj);

  saveDB();
  closeModal('modal-raw-material');
  showToast('✅ تم حفظ المادة الخام: ' + name);
  renderProductionPage();
}

function deleteRawMaterial(code) {
  if (!confirm('حذف هذه المادة الخام نهائياً؟')) return;
  db.rawMaterials = (db.rawMaterials || []).filter(x => x.code !== code);
  saveDB();
  showToast('تم الحذف');
  renderProductionPage();
}

/* ──────────────────────────────────────────────────────────────
   17. تقارير الإنتاج
   ────────────────────────────────────────────────────────────── */
function renderProdReports() {
  const orders = db.productionOrders || [];
  const done   = orders.filter(x => x.status === 'done');

  const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  set('rep-prod-total', orders.length);
  set('rep-prod-done',  done.length);
  set('rep-prod-prog',  orders.filter(x => x.status === 'in_progress').length);
  set('rep-prod-pend',  orders.filter(x => x.status === 'pending').length);

  let totalCost = 0;
  done.forEach(o => {
    (o.bom || []).forEach(b => {
      const m = (db.rawMaterials || []).find(x => x.code === b.matCode);
      if (m) totalCost += (m.cost || 0) * b.qty;
    });
  });
  const costEl = el('rep-prod-cost');
  if (costEl) costEl.textContent = fmtCurr(totalCost);

  const tbody = el('rep-prod-tbody');
  if (!tbody) return;

  tbody.innerHTML = orders.length ? orders.map(o => {
    const prod = (db.products || []).find(p => p.id === o.productId);
    const pct  = o.status === 'done' ? 100 : o.status === 'in_progress' ? 50 : 0;
    const pclr = pct === 100 ? 'var(--accent-green)' : pct > 0 ? 'var(--accent-blue)' : 'var(--bg3)';
    return `<tr>
      <td><strong>${o.id}</strong></td>
      <td>${prod?.name || '—'}</td>
      <td>${o.qty}</td>
      <td><span class="badge ${_statusBadge[o.status] || 'badge-blue'}">${_statusLabel[o.status] || o.status}</span></td>
      <td><span class="badge ${_priorityBadge[o.priority] || 'badge-orange'}">${_priorityLabel[o.priority] || '—'}</span></td>
      <td>${o.startDate || '—'}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="height:5px;width:70px;background:var(--bg3);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${pclr};border-radius:3px"></div>
          </div>
          <span style="font-size:0.7rem;color:var(--text-muted)">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-state"><p>لا توجد بيانات</p></td></tr>`;
}

/* ──────────────────────────────────────────────────────────────
   18. تعريض عالمي
   ────────────────────────────────────────────────────────────── */
window.renderProductionPage   = renderProductionPage;
window.switchProdTab          = switchProdTab;
window.openProdOrderModal     = openProdOrderModal;
window.saveProdOrder          = saveProdOrder;
window.startProdOrder         = startProdOrder;
window.completeProdOrder      = completeProdOrder;
window.viewProdOrder          = viewProdOrder;
window.deleteProdOrder        = deleteProdOrder;
window.addBomRow              = addBomRow;
window.removeBomRow           = removeBomRow;
window.onBomMatChange         = onBomMatChange;
window.onBomQtyChange         = onBomQtyChange;
window.renderProdOrders       = renderProdOrders;
window.renderRawMaterials     = renderRawMaterials;
window.openRawModal           = openRawModal;
window.saveRawMaterial        = saveRawMaterial;
window.deleteRawMaterial      = deleteRawMaterial;
window.orderRawMaterial       = orderRawMaterial;
window.receiveRawMaterial     = receiveRawMaterial;
window.renderProdReports      = renderProdReports;
window.upgradeProductionDB    = upgradeProductionDB;
