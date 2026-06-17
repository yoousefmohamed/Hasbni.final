/* =====================================================================
   HASSIBNI — وحدة الأرصدة والحسابات  v2.0
   ✅ ربط كامل: مبيعات / مشتريات / جملة
   ✅ إضافة ديون يدوية / فتح حسابات
   ✅ كشوف حساب مفصّلة قابلة للطباعة
   ✅ تسديد جزئي أو كامل مع تتبع تاريخي
   ✅ حذف / تعديل المدفوعات
   ✅ إحصائيات متقدمة وتصفية ذكية
   ===================================================================== */

'use strict';

/* ══════════════════════════════════════════════════════════════
   § 1  ترقية قاعدة البيانات
══════════════════════════════════════════════════════════════ */
function upgradeBalancesDB() {
  let ch = false;
  if (!db.balanceMovements) { db.balanceMovements = []; ch = true; }
  if (!db.payments)         { db.payments = [];         ch = true; }
  if (!db.debts)            { db.debts = [];            ch = true; }
  (db.customers || []).forEach(c => { if (c.balance === undefined) { c.balance = 0; ch = true; } });
  (db.suppliers || []).forEach(s => { if (s.balance === undefined) { s.balance = 0; ch = true; } });

  // ── ترحيل: إنشاء ديون مفقودة للفواتير الآجلة القديمة ──
  // يضمن أن كل فاتورة شراء آجلة لها سجل مقابل في db.debts
  const existingDebtRefs = new Set((db.debts || []).map(d => d.invoiceRef).filter(Boolean));
  (db.purchases || []).forEach(p => {
    if (p.payment !== 'آجل') return;
    const remaining = p.remaining ?? (p.total - (p.paidAmount || 0));
    if (!remaining || remaining <= 0) return;
    if (p.id && existingDebtRefs.has(p.id)) return; // سبق تسجيله
    const sup = (db.suppliers || []).find(s => s.id === p.supplierId);
    if (!sup) return;
    const debtId = uid();
    db.debts.unshift({
      id: debtId,
      entityId: sup.id,
      entityName: sup.name,
      entityType: 'supplier',
      amount: remaining,
      paid: 0,
      status: 'open',
      desc: `فاتورة شراء ${p.invNum || p.id}`,
      date: p.date || todayAR(),
      dueDate: p.dueDate || '',
      notes: `ترحيل تلقائي — فاتورة ${p.invNum || p.id}`,
      ts: p.ts || new Date().toISOString(),
      invoiceRef: p.id,
      invoiceNum: p.invNum || p.id
    });
    p.debtId = debtId;
    ch = true;
  });

  if (ch) saveDB();
}

/* ══════════════════════════════════════════════════════════════
   § 2  مساعدات
══════════════════════════════════════════════════════════════ */
const todayISO = () => new Date().toISOString().split('T')[0];
const todayAR  = () => new Date().toLocaleDateString('ar-EG');
const parseAmt = id => parseFloat(document.getElementById(id)?.value || 0);
const getVal   = id => document.getElementById(id)?.value || '';
const setVal   = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
const setTxt   = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
const setHTML  = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
const show     = id => { const e = document.getElementById(id); if (e) e.style.display = ''; };
const hide     = id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; };

function mkBadge(label, color) {
  const map = { red:'var(--accent-red)', green:'var(--accent-green)', orange:'var(--accent-orange)',
                blue:'var(--accent-blue)', purple:'var(--accent-purple)', gray:'var(--text-muted)' };
  const c = map[color] || color;
  return `<span style="background:${c}22;color:${c};padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:700">${label}</span>`;
}

/* ══════════════════════════════════════════════════════════════
   § 3  تسجيل حركة رصيد
══════════════════════════════════════════════════════════════ */
function addBalanceMovement({ type, entityId, entityName, entityType, amount, invoiceNum, notes, runningBal }) {
  if (!db.balanceMovements) db.balanceMovements = [];
  db.balanceMovements.push({
    id: uid(), type, entityId, entityName, entityType,
    amount: +amount,
    invoiceNum: invoiceNum || '',
    notes: notes || '',
    runningBal: runningBal ?? null,
    userId: (typeof currentUser !== 'undefined' ? currentUser?.name : null) || '—',
    ts: new Date().toISOString(),
    date: todayAR()
  });
}

/* ══════════════════════════════════════════════════════════════
   § 4  Hooks — ربط الفواتير تلقائياً
══════════════════════════════════════════════════════════════ */
// ملاحظة: تم نقل منطق تحديث رصيد المورد وتسجيل الديون إلى completePurchase في app.js
// لتفادي التكرار والتضاعف في الأرصدة

(function patchSale() {
  const _orig = window.checkoutPOS;
  if (!_orig) return;
  window.checkoutPOS = function () {
    const payment = document.getElementById('pos-payment-select')?.value || 'نقدي';
    const custId  = document.getElementById('pos-customer-select')?.value || '';
    const cust    = custId ? (db.customers || []).find(c => c.id === custId) : null;
    _orig.apply(this, arguments);
    if (payment === 'آجل' && cust) {
      const last = (db.sales || []).filter(s => s.customerId === custId).slice(-1)[0];
      if (last) {
        addBalanceMovement({ type:'sale_credit', entityId:cust.id, entityName:cust.name,
          entityType:'customer', amount:last.total, invoiceNum:last.id, notes:'فاتورة بيع آجلة' });
        saveDB();
      }
    }
  };
})();

(function patchWholesale() {
  const _orig = window.completeWholesale;
  if (!_orig) return;
  window.completeWholesale = function () {
    const payment = document.getElementById('ws-payment-select')?.value || 'نقدي';
    const custId  = document.getElementById('ws-customer-select')?.value || '';
    const cust    = custId ? (db.customers || []).find(c => c.id === custId) : null;
    _orig.apply(this, arguments);
    if (payment === 'آجل' && cust) {
      const last = (db.sales || []).filter(s => s.type === 'wholesale' && s.customerId === custId).slice(-1)[0];
      if (last) {
        addBalanceMovement({ type:'sale_credit', entityId:cust.id, entityName:cust.name,
          entityType:'customer', amount:last.total, invoiceNum:last.invNum||last.id, notes:'فاتورة جملة آجلة' });
        saveDB();
      }
    }
  };
})();

/* ══════════════════════════════════════════════════════════════
   § 5  حالة الصفحة
══════════════════════════════════════════════════════════════ */
let _balTab = 'customers';

function switchBalTab(tab) {
  _balTab = tab;
  const TABS = ['customers','suppliers','debts','payments','movements','settlements'];
  TABS.forEach(t => {
    const btn  = document.getElementById('balt-' + t);
    const pane = document.getElementById('bal-tab-' + t);
    if (btn)  btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'customers')  renderBalCustomers();
  else if (tab === 'suppliers') renderBalSuppliers();
  else if (tab === 'debts')     renderBalDebts();
  else if (tab === 'payments')  renderBalPayments();
  else if (tab === 'movements')    renderBalMovements();
  else if (tab === 'settlements')  renderBalSettlements();
}

/* ══════════════════════════════════════════════════════════════
   § 6  renderBalancesPage — نقطة الدخول
══════════════════════════════════════════════════════════════ */
function renderBalancesPage() {
  upgradeBalancesDB();
  _renderBalStats();
  switchBalTab(_balTab);
}

/* ══════════════════════════════════════════════════════════════
   § 7  الإحصائيات العلوية
══════════════════════════════════════════════════════════════ */
function _renderBalStats() {
  const custs = db.customers || [];
  const sups  = db.suppliers || [];
  const sales = db.sales     || [];
  const purs  = db.purchases || [];
  const pays  = db.payments  || [];

  const custDebt = custs.reduce((s, c) => s + Math.max(0, c.balance || 0), 0);
  const supDebt  = sups.reduce((s, sv) => s + Math.max(0, sv.balance || 0), 0);
  const custDebtCount = custs.filter(c => (c.balance || 0) > 0).length;
  const supDebtCount  = sups.filter(s => (s.balance || 0) > 0).length;

  const salesCr    = sales.filter(x => x.payment === 'آجل').reduce((s, x) => s + (x.total||0), 0);
  const salesCrCnt = sales.filter(x => x.payment === 'آجل').length;
  const purCr      = purs.filter(x => x.payment === 'آجل').reduce((s, x) => s + (x.total||0), 0);
  const purCrCnt   = purs.filter(x => x.payment === 'آجل').length;

  const todayStr = todayAR();
  const todayPays    = pays.filter(p => p.date === todayStr);
  const todayPayAmt  = todayPays.reduce((s, p) => s + (p.amount||0), 0);
  const todayPayCnt  = todayPays.length;

  // الشهر الحالي
  const mo = new Date().getMonth(), yr = new Date().getFullYear();
  const monthCollected = pays.filter(p => p.type==='customer' && new Date(p.ts).getMonth()===mo && new Date(p.ts).getFullYear()===yr)
                              .reduce((s,p) => s+(p.amount||0), 0);
  const monthPaid      = pays.filter(p => p.type==='supplier' && new Date(p.ts).getMonth()===mo && new Date(p.ts).getFullYear()===yr)
                              .reduce((s,p) => s+(p.amount||0), 0);

  setTxt('bal-cust-debt',       fmtCurr(custDebt));
  setTxt('bal-cust-count',      custDebtCount + ' عميل مدين');
  setTxt('bal-sup-debt',        fmtCurr(supDebt));
  setTxt('bal-sup-count',       supDebtCount + ' مورد');
  setTxt('bal-sales-credit',    fmtCurr(salesCr));
  setTxt('bal-sales-inv-count', salesCrCnt + ' فاتورة');
  setTxt('bal-pur-credit',      fmtCurr(purCr));
  setTxt('bal-pur-inv-count',   purCrCnt + ' فاتورة');
  setTxt('bal-today-payments',  fmtCurr(todayPayAmt));
  setTxt('bal-today-pay-count', todayPayCnt + ' عملية');
  setTxt('bal-net-collected',   fmtCurr(monthCollected));
  setTxt('bal-net-paid',        fmtCurr(monthPaid));

  const net   = custDebt - supDebt;
  const netEl = document.getElementById('bal-net-amount');
  const dscEl = document.getElementById('bal-net-desc');
  const crdEl = document.getElementById('bal-net-card');
  if (netEl) { netEl.textContent = fmtCurr(Math.abs(net)); netEl.style.color = net>=0 ? 'var(--accent-green)' : 'var(--accent-red)'; }
  if (dscEl)  dscEl.textContent = net >= 0 ? '⬆️ المركز المالي لصالح المتجر' : '⬇️ المركز المالي على المتجر';
  if (crdEl)  crdEl.style.borderRightColor = net>=0 ? 'var(--accent-green)' : 'var(--accent-red)';
}

/* ══════════════════════════════════════════════════════════════
   § 8  تبويب العملاء
══════════════════════════════════════════════════════════════ */
function renderBalCustomers() {
  const q      = (getVal('bal-cust-search')).toLowerCase();
  const filter = getVal('bal-cust-filter');

  // خريطة مبيعات
  const salesMap = {}, paidMap = {}, lastMap = {};
  (db.sales || []).forEach(s => {
    if (!s.customerId) return;
    salesMap[s.customerId] = (salesMap[s.customerId] || 0) + (s.total||0);
    const d = s.ts || s.date || '';
    if (!lastMap[s.customerId] || d > lastMap[s.customerId]) lastMap[s.customerId] = d;
  });
  (db.payments || []).filter(p => p.type==='customer').forEach(p => {
    paidMap[p.entityId] = (paidMap[p.entityId] || 0) + (p.amount||0);
  });

  let list = (db.customers || []).filter(c => {
    if (q && !c.name.toLowerCase().includes(q) && !(c.phone||'').includes(q)) return false;
    const bal = c.balance || 0;
    if (filter === 'debt' && bal <= 0) return false;
    if (filter === 'settled' && bal > 0) return false;
    if (filter === 'overdue') {
      // مدين منذ أكثر من 30 يوم
      const last = lastMap[c.id];
      if (!last || bal <= 0) return false;
      const diff = (Date.now() - new Date(last)) / 86400000;
      if (diff < 30) return false;
    }
    return true;
  }).sort((a, b) => (b.balance||0) - (a.balance||0));

  const tbody = document.getElementById('bal-cust-tbody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="9" class="empty-state"><p>لا يوجد عملاء</p></td></tr>`; return; }

  tbody.innerHTML = list.map((c, i) => {
    const bal   = c.balance || 0;
    const total = salesMap[c.id] || 0;
    const paid  = paidMap[c.id]  || 0;
    const last  = lastMap[c.id]  ? new Date(lastMap[c.id]).toLocaleDateString('ar-EG') : '—';
    const overdue = bal > 0 && lastMap[c.id] && (Date.now()-new Date(lastMap[c.id]))/86400000 > 30;
    const statusBadge = bal <= 0
      ? mkBadge('سوي','green')
      : overdue ? mkBadge('متأخر','red') : mkBadge('مدين','orange');

    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td><strong>${c.name}</strong><div style="font-size:0.75rem;color:var(--text-muted)">${c.phone||''}</div></td>
      <td>${c.phone||'—'}</td>
      <td style="color:var(--accent-blue)">${fmtCurr(total)}</td>
      <td style="color:var(--accent-green)">${fmtCurr(paid)}</td>
      <td><strong style="color:${bal>0?'var(--accent-red)':'var(--accent-green)'}">${fmtCurr(bal)}</strong></td>
      <td style="font-size:0.8rem">${last}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="btn-group">
          ${bal>0 ? `<button class="btn btn-success btn-sm" onclick="openPayCustomerModal('${c.id}')"><i class="fa fa-money-bill"></i> تسديد</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openBalStatement('customer','${c.id}')" title="كشف حساب"><i class="fa fa-file-invoice"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="openAddDebtModal('customer','${c.id}')" title="إضافة دين"><i class="fa fa-plus"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 9  تبويب الموردين
══════════════════════════════════════════════════════════════ */
function renderBalSuppliers() {
  const q      = (getVal('bal-sup-search')).toLowerCase();
  const filter = getVal('bal-sup-filter');

  const purMap = {}, paidMap = {}, lastMap = {};
  (db.purchases || []).forEach(p => {
    if (!p.supplierId) return;
    purMap[p.supplierId] = (purMap[p.supplierId]||0) + (p.total||0);
    const d = p.ts || p.date || '';
    if (!lastMap[p.supplierId] || d > lastMap[p.supplierId]) lastMap[p.supplierId] = d;
  });
  (db.payments || []).filter(p => p.type==='supplier').forEach(p => {
    paidMap[p.entityId] = (paidMap[p.entityId]||0) + (p.amount||0);
  });

  let list = (db.suppliers || []).filter(s => {
    if (q && !s.name.toLowerCase().includes(q) && !(s.phone||'').includes(q)) return false;
    const bal = s.balance || 0;
    if (filter==='debt' && bal<=0) return false;
    if (filter==='settled' && bal>0) return false;
    return true;
  }).sort((a,b) => (b.balance||0)-(a.balance||0));

  const tbody = document.getElementById('bal-sup-tbody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="9" class="empty-state"><p>لا يوجد موردون</p></td></tr>`; return; }

  tbody.innerHTML = list.map((s, i) => {
    const bal   = s.balance || 0;
    const total = purMap[s.id] || 0;
    const paid  = paidMap[s.id] || 0;
    const last  = lastMap[s.id] ? new Date(lastMap[s.id]).toLocaleDateString('ar-EG') : '—';
    const statusBadge = bal <= 0 ? mkBadge('سوي','green') : mkBadge('مستحق','orange');

    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td><strong>${s.name}</strong><div style="font-size:0.75rem;color:var(--text-muted)">${s.phone||''}</div></td>
      <td>${s.phone||'—'}</td>
      <td style="color:var(--accent-blue)">${fmtCurr(total)}</td>
      <td style="color:var(--accent-green)">${fmtCurr(paid)}</td>
      <td><strong style="color:${bal>0?'var(--accent-orange)':'var(--accent-green)'}">${fmtCurr(bal)}</strong></td>
      <td style="font-size:0.8rem">${last}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="btn-group">
          ${bal>0 ? `<button class="btn btn-warning btn-sm" onclick="openPaySupplierModal('${s.id}')"><i class="fa fa-money-bill"></i> دفع</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openBalStatement('supplier','${s.id}')" title="كشف حساب"><i class="fa fa-file-invoice"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="openAddDebtModal('supplier','${s.id}')" title="إضافة دين"><i class="fa fa-plus"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 10  تبويب الديون المفتوحة
══════════════════════════════════════════════════════════════ */
function renderBalDebts() {
  const q      = (getVal('bal-debt-search')).toLowerCase();
  const filter = getVal('bal-debt-filter');

  let list = (db.debts || []).filter(d => {
    if (q) {
      const name = d.entityName || '';
      if (!name.toLowerCase().includes(q) && !(d.desc||'').toLowerCase().includes(q)) return false;
    }
    if (filter === 'customer' && d.entityType !== 'customer') return false;
    if (filter === 'supplier' && d.entityType !== 'supplier') return false;
    if (filter === 'open'   && d.status === 'closed') return false;
    if (filter === 'closed' && d.status !== 'closed') return false;
    return true;
  }).sort((a,b) => new Date(b.ts||0) - new Date(a.ts||0));

  const tbody = document.getElementById('bal-debt-tbody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty-state"><p>لا توجد ديون مسجّلة</p></td></tr>`; return; }

  tbody.innerHTML = list.map((d, i) => {
    const remaining = Math.max(0, d.amount - (d.paid||0));
    const closed    = d.status === 'closed' || remaining <= 0;
    const overdue   = !closed && d.dueDate && new Date(d.dueDate) < new Date();
    const typeBadge = d.entityType==='customer' ? mkBadge('عميل','blue') : mkBadge('مورد','purple');
    const stBadge   = closed ? mkBadge('مسدَّد','green') : overdue ? mkBadge('متأخر','red') : mkBadge('مفتوح','orange');

    return `<tr style="${closed?'opacity:0.6':''}">
      <td style="color:var(--text-muted)">${i+1}</td>
      <td><strong>${d.entityName||'—'}</strong></td>
      <td>${typeBadge}</td>
      <td style="color:var(--accent-blue)">${fmtCurr(d.amount)}</td>
      <td style="color:var(--accent-green)">${fmtCurr(d.paid||0)}</td>
      <td><strong style="color:${remaining>0?'var(--accent-red)':'var(--accent-green)'}">${fmtCurr(remaining)}</strong></td>
      <td style="font-size:0.82rem;color:var(--text-muted)">${d.desc||'—'}</td>
      <td style="font-size:0.8rem">${d.date||'—'}${d.dueDate?`<br><span style="font-size:0.72rem;color:${overdue?'var(--accent-red)':'var(--text-muted)'}">يستحق: ${d.dueDate}</span>`:''}</td>
      <td>${stBadge}</td>
      <td>
        <div class="btn-group">
          ${!closed ? `<button class="btn btn-success btn-sm" onclick="openPayDebtModal('${d.id}')"><i class="fa fa-money-bill"></i> تسديد</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="deleteDebt('${d.id}')" title="حذف"><i class="fa fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 11  تبويب التسديدات
══════════════════════════════════════════════════════════════ */
function renderBalPayments() {
  const q       = (getVal('bal-pay-search')).toLowerCase();
  const filter  = getVal('bal-pay-filter');
  const dateFrom= getVal('bal-pay-date-from');
  const dateTo  = getVal('bal-pay-date-to');

  let list = (db.payments || []).filter(p => {
    if (q && !(p.entityName||p.name||'').toLowerCase().includes(q) && !(p.invoiceRef||'').includes(q)) return false;
    if (filter && p.type !== filter) return false;
    if (dateFrom && p.ts && p.ts < dateFrom) return false;
    if (dateTo   && p.ts && p.ts.split('T')[0] > dateTo) return false;
    return true;
  }).sort((a,b) => new Date(b.ts||0)-new Date(a.ts||0));

  // ملخص مصغّر
  const totalIn  = list.filter(p=>p.type==='customer').reduce((s,p)=>s+(p.amount||0),0);
  const totalOut = list.filter(p=>p.type==='supplier').reduce((s,p)=>s+(p.amount||0),0);
  setHTML('bal-pay-summary', `
    <div style="background:var(--accent-green)18;border-radius:8px;padding:8px 14px">
      <div style="font-size:0.75rem;color:var(--text-muted)">إجمالي التحصيل</div>
      <div style="font-weight:800;color:var(--accent-green)">${fmtCurr(totalIn)}</div>
    </div>
    <div style="background:var(--accent-orange)18;border-radius:8px;padding:8px 14px">
      <div style="font-size:0.75rem;color:var(--text-muted)">إجمالي المدفوع</div>
      <div style="font-weight:800;color:var(--accent-orange)">${fmtCurr(totalOut)}</div>
    </div>
    <div style="background:var(--accent-blue)18;border-radius:8px;padding:8px 14px">
      <div style="font-size:0.75rem;color:var(--text-muted)">صافي الحركة</div>
      <div style="font-weight:800;color:var(--accent-blue)">${fmtCurr(totalIn-totalOut)}</div>
    </div>
    <div style="color:var(--text-muted);font-size:0.8rem;align-self:center">${list.length} عملية</div>
  `);

  const tbody = document.getElementById('bal-pay-tbody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty-state"><p>لا توجد مدفوعات</p></td></tr>`; return; }

  tbody.innerHTML = list.map((p, i) => {
    const isCust = p.type === 'customer';
    const typeBadge = isCust ? mkBadge('تحصيل','green') : mkBadge('دفع','orange');
    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td>${typeBadge}</td>
      <td><strong>${p.entityName||p.name||'—'}</strong></td>
      <td><strong style="color:${isCust?'var(--accent-green)':'var(--accent-orange)'}">${fmtCurr(p.amount)}</strong></td>
      <td>${p.method||p.notes||'نقدي'}</td>
      <td style="font-size:0.8rem">${p.date||'—'}</td>
      <td style="font-size:0.8rem;color:var(--text-muted)">${p.userId||p.by||'—'}</td>
      <td style="font-size:0.78rem">${p.invoiceRef||p.invoiceNum||'—'}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${p.note||p.notes||'—'}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="deletePayment('${p.id}')" title="حذف"><i class="fa fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 12  تبويب حركة الحسابات
══════════════════════════════════════════════════════════════ */
function renderBalMovements() {
  const filter = getVal('bal-mov-filter');
  const q      = (getVal('bal-mov-search')||'').toLowerCase();

  let list = (db.balanceMovements || []).filter(m => {
    if (filter && m.type !== filter) return false;
    if (q && !(m.entityName||'').toLowerCase().includes(q) && !(m.invoiceNum||'').includes(q)) return false;
    return true;
  }).sort((a,b) => new Date(b.ts||0)-new Date(a.ts||0));

  const LABELS = {
    sale_credit:'📦 بيع آجل', purchase_credit:'🛒 شراء آجل',
    customer_payment:'💰 تسديد عميل', supplier_payment:'💸 دفع مورد',
    manual_debt:'📌 دين يدوي', manual_payment:'✅ تسديد يدوي'
  };
  const DEBIT_TYPES  = ['sale_credit','purchase_credit','manual_debt'];

  const tbody = document.getElementById('bal-mov-tbody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="9" class="empty-state"><p>لا توجد حركات</p></td></tr>`; return; }

  tbody.innerHTML = list.map((m, i) => {
    const isDebit = DEBIT_TYPES.includes(m.type);
    const label   = LABELS[m.type] || m.type;
    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td style="font-size:0.82rem">${label}</td>
      <td><strong>${m.entityName||'—'}</strong></td>
      <td style="color:var(--accent-red);font-weight:700">${isDebit ? fmtCurr(m.amount) : '—'}</td>
      <td style="color:var(--accent-green);font-weight:700">${!isDebit ? fmtCurr(m.amount) : '—'}</td>
      <td style="color:var(--text-muted)">${m.runningBal !== null && m.runningBal !== undefined ? fmtCurr(m.runningBal) : '—'}</td>
      <td><span style="font-size:0.75rem;color:var(--accent-blue)">${m.invoiceNum||'—'}</span></td>
      <td style="font-size:0.78rem">${m.date||'—'}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${m.userId||'—'}</td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 13  موديل إضافة دين يدوي
══════════════════════════════════════════════════════════════ */
function openAddDebtModal(entityType, entityId) {
  upgradeBalancesDB();
  // ملء قائمة العملاء/الموردين
  _fillDebtEntitySelect(entityType || 'customer');
  if (entityType) {
    document.querySelectorAll('input[name="debt-entity-type"]').forEach(r => r.checked = r.value === entityType);
  }
  if (entityId) setVal('debt-entity-select', entityId);
  setVal('debt-amount', '');
  setVal('debt-desc', '');
  setVal('debt-date', todayISO());
  setVal('debt-due-date', '');
  setVal('debt-notes', '');
  openModal('modal-add-debt');
}

function onDebtTypeChange() {
  const type = document.querySelector('input[name="debt-entity-type"]:checked')?.value || 'customer';
  _fillDebtEntitySelect(type);
}

function _fillDebtEntitySelect(type) {
  const sel = document.getElementById('debt-entity-select');
  if (!sel) return;
  const list = type === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  sel.innerHTML = `<option value="">— اختر —</option>` +
    list.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
}

function confirmAddDebt() {
  const entityType = document.querySelector('input[name="debt-entity-type"]:checked')?.value || 'customer';
  const entityId   = getVal('debt-entity-select');
  const amount     = parseAmt('debt-amount');
  const desc       = getVal('debt-desc');
  const date       = getVal('debt-date') || todayISO();
  const dueDate    = getVal('debt-due-date');
  const notes      = getVal('debt-notes');

  if (!entityId) { showToast('اختر العميل أو المورد', 'warning'); return; }
  if (!amount || amount <= 0) { showToast('أدخل مبلغاً صحيحاً', 'warning'); return; }

  const list   = entityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const entity = list.find(x => x.id === entityId);
  if (!entity) return;

  // تحديث الرصيد
  entity.balance = (entity.balance || 0) + amount;

  // إضافة دين في جدول الديون
  if (!db.debts) db.debts = [];
  const debtId = uid();
  db.debts.unshift({
    id: debtId, entityId, entityName: entity.name, entityType,
    amount, paid: 0, status: 'open',
    desc: desc || 'دين يدوي',
    date: new Date(date).toLocaleDateString('ar-EG'),
    dueDate: dueDate ? new Date(dueDate).toLocaleDateString('ar-EG') : '',
    notes, ts: new Date(date).toISOString()
  });

  // تسجيل حركة
  addBalanceMovement({
    type: 'manual_debt', entityId, entityName: entity.name, entityType,
    amount, invoiceNum: debtId, notes: desc || 'دين يدوي',
    runningBal: entity.balance
  });

  addLog('دين', `إضافة دين على ${entity.name} — ${fmtCurr(amount)}`, 'دين');
  saveDB();
  closeModal('modal-add-debt');
  showToast(`✅ تم تسجيل دين ${fmtCurr(amount)} على ${entity.name}`);
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 14  موديل تسديد عميل
══════════════════════════════════════════════════════════════ */
function openPayCustomerModal(cid) {
  const c = (db.customers||[]).find(x => x.id === cid);
  if (!c) return;
  setVal('pay-customer-id', cid);
  setTxt('pay-customer-name-disp', c.name);
  setTxt('pay-customer-phone-disp', c.phone || '—');
  setTxt('pay-customer-balance', fmtCurr(c.balance || 0));
  setVal('pay-customer-amount', '');
  setVal('pay-customer-method', 'نقدي');
  setVal('pay-customer-date', todayISO());
  setVal('pay-customer-note', '');
  openModal('modal-pay-customer');
}

function payCustomerFull() {
  const cid = getVal('pay-customer-id');
  const c   = (db.customers||[]).find(x => x.id === cid);
  if (c) setVal('pay-customer-amount', (c.balance||0).toFixed(2));
}

function confirmCustomerPayment() {
  const cid    = getVal('pay-customer-id');
  const amount = parseAmt('pay-customer-amount');
  const method = getVal('pay-customer-method') || 'نقدي';
  const date   = getVal('pay-customer-date')   || todayISO();
  const note   = getVal('pay-customer-note');

  if (!cid || amount <= 0) { showToast('أدخل مبلغاً صحيحاً', 'warning'); return; }
  const cust = (db.customers||[]).find(x => x.id === cid);
  if (!cust) return;

  const prevBal = cust.balance || 0;
  cust.balance  = Math.max(0, prevBal - amount);

  if (!db.payments) db.payments = [];
  const payId = uid();
  db.payments.unshift({
    id: payId, type:'customer', entityType:'customer', entityId:cid,
    entityName:cust.name, name:cust.name, amount,
    method, note, notes: note,
    date: new Date(date).toLocaleDateString('ar-EG'),
    ts: new Date(date).toISOString(),
    by: (typeof currentUser!=='undefined'?currentUser?.name:null)||'—',
    userId:(typeof currentUser!=='undefined'?currentUser?.name:null)||'—'
  });
  // Save to customerPayments for statement view
  if (!db.customerPayments) db.customerPayments = [];
  db.customerPayments.unshift({ id: payId, customerId: cid, amount, method, date: new Date(date).toLocaleDateString('ar-EG'), ts: new Date(date).toISOString(), note });

  addBalanceMovement({
    type:'customer_payment', entityId:cid, entityName:cust.name, entityType:'customer',
    amount, invoiceNum:payId, notes:`تسديد — ${method}`,
    runningBal: cust.balance
  });

  // تحديث الديون المرتبطة
  _applyPaymentToDebts(cid, 'customer', amount);

  if (!db.treasury) db.treasury = [];
  db.treasury.push({ id:uid(), type:'إيراد', desc:`تسديد من عميل: ${cust.name}`, amount,
    date:new Date(date).toLocaleDateString('ar-EG'), ts:new Date(date).toISOString() });

  addLog('تسديد', `تسديد من عميل: ${cust.name} — ${fmtCurr(amount)}`, 'تسديد');
  saveDB();
  closeModal('modal-pay-customer');
  showToast(`✅ تم تسجيل تسديد ${fmtCurr(amount)} من ${cust.name}`);
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 15  موديل دفع للمورد
══════════════════════════════════════════════════════════════ */
function openPaySupplierModal(sid) {
  const s = (db.suppliers||[]).find(x => x.id === sid);
  if (!s) return;
  setVal('pay-supplier-id', sid);
  setTxt('pay-supplier-name-disp', s.name);
  setTxt('pay-supplier-phone-disp', s.phone || '—');
  setTxt('pay-supplier-balance', fmtCurr(s.balance || 0));
  setVal('pay-supplier-amount', '');
  setVal('pay-supplier-method', 'نقدي');
  setVal('pay-supplier-date', todayISO());
  setVal('pay-supplier-note', '');
  openModal('modal-pay-supplier');
}

function paySupplierFull() {
  const sid = getVal('pay-supplier-id');
  const s   = (db.suppliers||[]).find(x => x.id === sid);
  if (s) setVal('pay-supplier-amount', (s.balance||0).toFixed(2));
}

function confirmSupplierPayment() {
  const sid    = getVal('pay-supplier-id');
  const amount = parseAmt('pay-supplier-amount');
  const method = getVal('pay-supplier-method') || 'نقدي';
  const date   = getVal('pay-supplier-date')   || todayISO();
  const note   = getVal('pay-supplier-note');

  if (!sid || amount <= 0) { showToast('أدخل مبلغاً صحيحاً', 'warning'); return; }
  const sup = (db.suppliers||[]).find(x => x.id === sid);
  if (!sup) return;

  const prevBal = sup.balance || 0;
  sup.balance   = Math.max(0, prevBal - amount);

  if (!db.payments) db.payments = [];
  const payId = uid();
  db.payments.unshift({
    id:payId, type:'supplier', entityType:'supplier', entityId:sid,
    entityName:sup.name, name:sup.name, amount,
    method, note, notes:note,
    date:new Date(date).toLocaleDateString('ar-EG'),
    ts:new Date(date).toISOString(),
    by:(typeof currentUser!=='undefined'?currentUser?.name:null)||'—',
    userId:(typeof currentUser!=='undefined'?currentUser?.name:null)||'—'
  });
  // Save to supplierPayments for statement view
  if (!db.supplierPayments) db.supplierPayments = [];
  db.supplierPayments.unshift({ id: payId, supplierId: sid, amount, method, date: new Date(date).toLocaleDateString('ar-EG'), ts: new Date(date).toISOString(), note });

  addBalanceMovement({
    type:'supplier_payment', entityId:sid, entityName:sup.name, entityType:'supplier',
    amount, invoiceNum:payId, notes:`دفع — ${method}`,
    runningBal: sup.balance
  });

  _applyPaymentToDebts(sid, 'supplier', amount);

  if (!db.treasury) db.treasury = [];
  db.treasury.push({ id:uid(), type:'مصروف', desc:`دفع لمورد: ${sup.name}`, amount,
    date:new Date(date).toLocaleDateString('ar-EG'), ts:new Date(date).toISOString() });

  addLog('دفع', `دفع لمورد: ${sup.name} — ${fmtCurr(amount)}`, 'دفع');
  saveDB();
  closeModal('modal-pay-supplier');
  showToast(`✅ تم تسجيل دفع ${fmtCurr(amount)} لـ ${sup.name}`);
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 16  موديل تسديد دين محدد
══════════════════════════════════════════════════════════════ */
function openPayDebtModal(debtId) {
  const d = (db.debts||[]).find(x => x.id === debtId);
  if (!d) return;
  const remaining = Math.max(0, d.amount - (d.paid||0));
  setVal('pay-debt-id', debtId);
  setTxt('pay-debt-entity-name', d.entityName);
  setTxt('pay-debt-desc-disp',   d.desc || '—');
  setTxt('pay-debt-orig',        fmtCurr(d.amount));
  setTxt('pay-debt-remaining',   fmtCurr(remaining));
  setVal('pay-debt-amount', '');
  setVal('pay-debt-method', 'نقدي');
  setVal('pay-debt-date', todayISO());
  setVal('pay-debt-note', '');
  openModal('modal-pay-debt');
}

function payDebtFull() {
  const d = (db.debts||[]).find(x => x.id === getVal('pay-debt-id'));
  if (d) setVal('pay-debt-amount', Math.max(0, d.amount-(d.paid||0)).toFixed(2));
}

function confirmDebtPayment() {
  const debtId = getVal('pay-debt-id');
  const amount = parseAmt('pay-debt-amount');
  const method = getVal('pay-debt-method') || 'نقدي';
  const date   = getVal('pay-debt-date')   || todayISO();
  const note   = getVal('pay-debt-note');

  if (!debtId || amount <= 0) { showToast('أدخل مبلغاً صحيحاً', 'warning'); return; }

  const debt = (db.debts||[]).find(x => x.id === debtId);
  if (!debt) return;

  const remaining = Math.max(0, debt.amount - (debt.paid||0));
  const paying    = Math.min(amount, remaining);

  debt.paid   = (debt.paid||0) + paying;
  if (debt.paid >= debt.amount) debt.status = 'closed';

  // تحديث رصيد الكيان
  const list   = debt.entityType==='customer' ? (db.customers||[]) : (db.suppliers||[]);
  const entity = list.find(x => x.id === debt.entityId);
  if (entity) entity.balance = Math.max(0, (entity.balance||0) - paying);

  // تسجيل دفعة
  if (!db.payments) db.payments = [];
  const payId = uid();
  db.payments.unshift({
    id:payId, type:debt.entityType, entityType:debt.entityType,
    entityId:debt.entityId, entityName:debt.entityName, name:debt.entityName,
    amount:paying, method, note, notes:note,
    invoiceRef: debtId,
    date:new Date(date).toLocaleDateString('ar-EG'),
    ts:new Date(date).toISOString(),
    by:(typeof currentUser!=='undefined'?currentUser?.name:null)||'—',
    userId:(typeof currentUser!=='undefined'?currentUser?.name:null)||'—'
  });

  addBalanceMovement({
    type: debt.entityType==='customer' ? 'customer_payment' : 'supplier_payment',
    entityId:debt.entityId, entityName:debt.entityName, entityType:debt.entityType,
    amount:paying, invoiceNum:debtId, notes:`تسديد دين: ${debt.desc||''} — ${method}`,
    runningBal: entity ? entity.balance : null
  });

  if (!db.treasury) db.treasury = [];
  if (debt.entityType==='customer') {
    db.treasury.push({ id:uid(), type:'إيراد', desc:`تسديد دين من: ${debt.entityName}`, amount:paying,
      date:new Date(date).toLocaleDateString('ar-EG'), ts:new Date(date).toISOString() });
  } else {
    db.treasury.push({ id:uid(), type:'مصروف', desc:`دفع دين لـ: ${debt.entityName}`, amount:paying,
      date:new Date(date).toLocaleDateString('ar-EG'), ts:new Date(date).toISOString() });
  }

  addLog('تسديد', `تسديد دين ${debt.entityName} — ${fmtCurr(paying)}`, 'تسديد');
  saveDB();
  closeModal('modal-pay-debt');
  showToast(`✅ تم تسجيل ${fmtCurr(paying)}${debt.status==='closed' ? ' — الدين مسدَّد بالكامل 🎉' : ''}`);
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 17  تطبيق الدفعة على أقدم الديون
══════════════════════════════════════════════════════════════ */
function _applyPaymentToDebts(entityId, entityType, amount) {
  const openDebts = (db.debts||[])
    .filter(d => d.entityId===entityId && d.entityType===entityType && d.status!=='closed')
    .sort((a,b) => new Date(a.ts||0)-new Date(b.ts||0));
  let rem = amount;
  for (const d of openDebts) {
    if (rem <= 0) break;
    const need = Math.max(0, d.amount-(d.paid||0));
    const pay  = Math.min(rem, need);
    d.paid  = (d.paid||0) + pay;
    if (d.paid >= d.amount) d.status = 'closed';
    rem -= pay;
  }
}

/* ══════════════════════════════════════════════════════════════
   § 18  حذف دفعة
══════════════════════════════════════════════════════════════ */
function deletePayment(payId) {
  if (!confirm('هل تريد حذف هذه الدفعة؟ سيتم عكس الرصيد.')) return;
  const idx = (db.payments||[]).findIndex(p => p.id === payId);
  if (idx < 0) return;
  const p = db.payments[idx];

  // عكس الرصيد
  if (p.type === 'customer') {
    const c = (db.customers||[]).find(x => x.id === p.entityId);
    if (c) c.balance = (c.balance||0) + p.amount;
  } else if (p.type === 'supplier') {
    const s = (db.suppliers||[]).find(x => x.id === p.entityId);
    if (s) s.balance = (s.balance||0) + p.amount;
  }

  // عكس الدين إن وجد
  if (p.invoiceRef) {
    const d = (db.debts||[]).find(x => x.id === p.invoiceRef);
    if (d) { d.paid = Math.max(0, (d.paid||0) - p.amount); d.status = 'open'; }
  }

  db.payments.splice(idx, 1);

  // عكس الخزنة
  if (!db.treasury) db.treasury = [];
  const tIdx = db.treasury.findIndex(t => t.desc && t.desc.includes(p.entityName) && Math.abs(t.amount-p.amount)<0.01);
  if (tIdx >= 0) db.treasury.splice(tIdx, 1);

  addLog('حذف', `حذف دفعة ${p.entityName} — ${fmtCurr(p.amount)}`, 'حذف');
  saveDB();
  showToast('تم حذف الدفعة وعكس الرصيد', 'warning');
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 19  حذف دين
══════════════════════════════════════════════════════════════ */
function deleteDebt(debtId) {
  if (!confirm('هل تريد حذف هذا الدين؟')) return;
  const idx = (db.debts||[]).findIndex(d => d.id === debtId);
  if (idx < 0) return;
  const d = db.debts[idx];

  // عكس الرصيد (المتبقي فقط)
  const remaining = Math.max(0, d.amount-(d.paid||0));
  if (remaining > 0) {
    const list   = d.entityType==='customer' ? (db.customers||[]) : (db.suppliers||[]);
    const entity = list.find(x => x.id === d.entityId);
    if (entity) entity.balance = Math.max(0, (entity.balance||0) - remaining);
  }

  db.debts.splice(idx, 1);
  addLog('حذف', `حذف دين ${d.entityName} — ${fmtCurr(d.amount)}`, 'حذف');
  saveDB();
  showToast('تم حذف الدين', 'warning');
  renderBalancesPage();
}

/* ══════════════════════════════════════════════════════════════
   § 20  كشف حساب
══════════════════════════════════════════════════════════════ */
function openBalStatement(entityType, entityId) {
  upgradeBalancesDB();
  const list   = entityType==='customer' ? (db.customers||[]) : (db.suppliers||[]);
  const entity = list.find(x => x.id === entityId);
  if (!entity) return;

  setTxt('bal-stmt-title', `📄 كشف حساب — ${entity.name}`);

  // جمع الحركات
  const movements = [
    ...(db.sales||[]).filter(s => s.customerId===entityId && s.payment==='آجل')
      .map(s => ({ ts:s.ts||s.date, date:s.date||new Date(s.ts).toLocaleDateString('ar-EG'),
        type:'بيع آجل', ref:s.id, debit:s.total, credit:0, notes:`فاتورة رقم ${s.id}` })),
    ...(db.purchases||[]).filter(p => p.supplierId===entityId && p.payment==='آجل')
      .map(p => ({ ts:p.ts||p.date, date:p.date||new Date(p.ts).toLocaleDateString('ar-EG'),
        type:'شراء آجل', ref:p.id, debit:p.total, credit:0, notes:`فاتورة رقم ${p.id}` })),
    ...(db.payments||[]).filter(p => p.entityId===entityId)
      .map(p => ({ ts:p.ts||p.date, date:p.date||'—',
        type: entityType==='customer'?'تسديد':'دفع', ref:p.id, debit:0, credit:p.amount,
        notes: p.method ? `${p.method}${p.note?` — ${p.note}`:''}` : (p.note||'—') })),
    ...(db.debts||[]).filter(d => d.entityId===entityId)
      .map(d => ({ ts:d.ts, date:d.date||'—',
        type:'دين يدوي', ref:d.id, debit:d.amount, credit:0, notes:d.desc||'—' })),
    ...(db.settlements||[]).filter(s => s.entityId===entityId)
      .map(s => {
        let debit = 0, credit = 0;
        if (entityType==='customer') { if (s.moveType==='debit') debit=s.amount; else credit=s.amount; }
        else                         { if (s.moveType==='credit') debit=s.amount; else credit=s.amount; }
        return { ts:s.ts, date:s.date||'—', type:'تسوية', ref:s.id, debit, credit, notes:s.notes||'—' };
      })
  ].sort((a,b) => new Date(a.ts||0)-new Date(b.ts||0));

  // احسب الرصيد المتراكم
  let running = 0;
  const rows = movements.map((m, i) => {
    running += m.debit - m.credit;
    const color = running > 0 ? 'var(--accent-red)' : running < 0 ? 'var(--accent-green)' : 'var(--text-muted)';
    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td style="font-size:0.8rem">${m.date}</td>
      <td style="font-size:0.82rem">${m.type}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${m.ref||'—'}</td>
      <td style="color:var(--accent-red);font-weight:700">${m.debit>0?fmtCurr(m.debit):'—'}</td>
      <td style="color:var(--accent-green);font-weight:700">${m.credit>0?fmtCurr(m.credit):'—'}</td>
      <td style="color:${color};font-weight:800">${fmtCurr(Math.abs(running))} ${running>0?'(مدين)':running<0?'(دائن)':'(سوي)'}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${m.notes||'—'}</td>
    </tr>`;
  });

  const storeName  = db.settings?.storeName || 'المتجر';
  const finalBal   = entity.balance || 0;
  const stColor    = finalBal > 0 ? 'var(--accent-red)' : 'var(--accent-green)';
  const stLabel    = finalBal > 0 ? (entityType==='customer'?'مدين':'علينا') : 'سوي';
  const totalDebit = movements.reduce((s,m) => s+m.debit, 0);
  const totalCred  = movements.reduce((s,m) => s+m.credit, 0);

  setHTML('bal-stmt-content', `
    <div style="padding:20px">
      <!-- رأس الكشف -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid var(--border)">
        <div>
          <div style="font-size:1.2rem;font-weight:800">${storeName}</div>
          <div style="color:var(--text-muted);font-size:0.85rem">كشف حساب — ${entity.name}</div>
          <div style="color:var(--text-muted);font-size:0.78rem;margin-top:2px">${entity.phone||''}</div>
        </div>
        <div style="text-align:left">
          <div style="font-size:0.78rem;color:var(--text-muted)">تاريخ الكشف</div>
          <div style="font-weight:700">${todayAR()}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:6px">الرصيد الحالي</div>
          <div style="font-size:1.3rem;font-weight:900;color:${stColor}">${fmtCurr(finalBal)} (${stLabel})</div>
        </div>
      </div>

      <!-- ملخص سريع -->
      <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        <div style="background:var(--accent-red)15;border-radius:8px;padding:10px 16px;flex:1;min-width:120px">
          <div style="font-size:0.75rem;color:var(--text-muted)">إجمالي الديون</div>
          <div style="font-weight:800;color:var(--accent-red)">${fmtCurr(totalDebit)}</div>
        </div>
        <div style="background:var(--accent-green)15;border-radius:8px;padding:10px 16px;flex:1;min-width:120px">
          <div style="font-size:0.75rem;color:var(--text-muted)">إجمالي التسديدات</div>
          <div style="font-weight:800;color:var(--accent-green)">${fmtCurr(totalCred)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:8px;padding:10px 16px;flex:1;min-width:120px">
          <div style="font-size:0.75rem;color:var(--text-muted)">صافي الرصيد</div>
          <div style="font-weight:800;color:${stColor}">${fmtCurr(finalBal)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:8px;padding:10px 16px;flex:1;min-width:80px">
          <div style="font-size:0.75rem;color:var(--text-muted)">عدد الحركات</div>
          <div style="font-weight:800">${movements.length}</div>
        </div>
      </div>

      <!-- جدول الحركات -->
      ${movements.length ? `
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>#</th><th>التاريخ</th><th>البيان</th><th>المرجع</th>
            <th style="color:var(--accent-red)">مدين</th>
            <th style="color:var(--accent-green)">دائن</th>
            <th>الرصيد</th><th>ملاحظات</th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
          <tfoot><tr style="background:var(--bg3);font-weight:800">
            <td colspan="4" style="text-align:center">الإجماليات</td>
            <td style="color:var(--accent-red)">${fmtCurr(totalDebit)}</td>
            <td style="color:var(--accent-green)">${fmtCurr(totalCred)}</td>
            <td colspan="2" style="color:${stColor}">${fmtCurr(finalBal)} ${stLabel}</td>
          </tr></tfoot>
        </table>
      </div>` : `<div class="empty-state"><p>لا توجد حركات مسجّلة لهذا الحساب</p></div>`}

      <!-- زر تسديد سريع -->
      ${finalBal > 0 ? `
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);text-align:center">
        <button class="btn btn-success" onclick="closeModal('modal-bal-statement');${entityType==='customer'?`openPayCustomerModal('${entityId}')`:`openPaySupplierModal('${entityId}')`}">
          <i class="fa fa-money-bill"></i> ${entityType==='customer'?'تسجيل تسديد':'دفع المستحق'}
        </button>
      </div>` : ''}
    </div>
  `);

  openModal('modal-bal-statement');
}

/* ══════════════════════════════════════════════════════════════
   § 21  طباعة كشف الحساب
══════════════════════════════════════════════════════════════ */
function printStatement() {
  const content = document.getElementById('bal-stmt-content');
  if (!content) return;
  const title   = document.getElementById('bal-stmt-title')?.textContent || 'كشف حساب';
  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html dir="rtl"><head>
    <meta charset="UTF-8"><title>${title}</title>
    <style>
      * { box-sizing:border-box; font-family:'Cairo',Tahoma,sans-serif; }
      body { padding:20px; background:#fff; color:#1a1a2e; direction:rtl; }
      table { width:100%; border-collapse:collapse; font-size:13px; }
      th,td { border:1px solid #ddd; padding:7px 10px; text-align:right; }
      th { background:#f0f4ff; font-weight:700; }
      @media print { @page { size:A4; margin:15mm; } }
    </style>
  </head><body>
    <h2 style="text-align:center;margin-bottom:20px">${title}</h2>
    ${content.innerHTML}
    <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),1000);}<\/script>
  </body></html>`);
  win.document.close();
}

/* ══════════════════════════════════════════════════════════════
   § 22  طباعة تقرير الأرصدة الكامل
══════════════════════════════════════════════════════════════ */
function printBalancesReport() {
  const custDebt  = (db.customers||[]).reduce((s,c) => s+Math.max(0,c.balance||0), 0);
  const supDebt   = (db.suppliers||[]).reduce((s,sv) => s+Math.max(0,sv.balance||0), 0);
  const debtors   = (db.customers||[]).filter(c=>(c.balance||0)>0).map(c=>`<tr><td>${c.name}</td><td>${c.phone||'—'}</td><td style="color:red;font-weight:700">${fmtCurr(c.balance)}</td></tr>`).join('');
  const creditors = (db.suppliers||[]).filter(s=>(s.balance||0)>0).map(s=>`<tr><td>${s.name}</td><td>${s.phone||'—'}</td><td style="color:orange;font-weight:700">${fmtCurr(s.balance)}</td></tr>`).join('');
  const store     = db.settings?.storeName || 'المتجر';

  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html dir="rtl"><head>
    <meta charset="UTF-8"><title>تقرير الأرصدة</title>
    <style>*{font-family:'Cairo',Tahoma,sans-serif;box-sizing:border-box} body{padding:24px;color:#1a1a2e} table{width:100%;border-collapse:collapse;margin-bottom:20px} th,td{border:1px solid #ddd;padding:8px 12px;text-align:right} th{background:#f0f4ff;font-weight:800} h2,h3{margin:16px 0 8px}</style>
  </head><body>
    <div style="text-align:center;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:20px">
      <h2>${store} — تقرير الأرصدة والحسابات</h2>
      <div>تاريخ الطباعة: ${todayAR()}</div>
    </div>
    <div style="display:flex;gap:20px;margin-bottom:20px">
      <div style="background:#ffe5e5;padding:12px 20px;border-radius:8px;flex:1;text-align:center"><div>إجمالي مديونية العملاء</div><div style="font-size:1.4rem;font-weight:900;color:red">${fmtCurr(custDebt)}</div></div>
      <div style="background:#fff3e0;padding:12px 20px;border-radius:8px;flex:1;text-align:center"><div>إجمالي مستحقات الموردين</div><div style="font-size:1.4rem;font-weight:900;color:orange">${fmtCurr(supDebt)}</div></div>
      <div style="background:#e8f5e9;padding:12px 20px;border-radius:8px;flex:1;text-align:center"><div>صافي المركز المالي</div><div style="font-size:1.4rem;font-weight:900;color:${custDebt>=supDebt?'green':'red'}">${fmtCurr(Math.abs(custDebt-supDebt))}</div></div>
    </div>
    <h3>👥 العملاء المدينون</h3>
    <table><thead><tr><th>الاسم</th><th>الهاتف</th><th>المستحق</th></tr></thead><tbody>${debtors||'<tr><td colspan="3" style="text-align:center">لا يوجد</td></tr>'}</tbody></table>
    <h3>🏭 الموردون المستحقون</h3>
    <table><thead><tr><th>الاسم</th><th>الهاتف</th><th>المستحق</th></tr></thead><tbody>${creditors||'<tr><td colspan="3" style="text-align:center">لا يوجد</td></tr>'}</tbody></table>
    <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),1000);}<\/script>
  </body></html>`);
  win.document.close();
}


/* ══════════════════════════════════════════════════════════════
   § 26  نظام التسويات — customer & supplier settlements
══════════════════════════════════════════════════════════════ */

// ── ترقية قاعدة البيانات
function upgradeSettlementsDB() {
  if (!db.settlements) { db.settlements = []; saveDB(); }
}

// ── حالة المودال
let _setEntityType = 'customer';
let _setMoveType   = 'credit';

function setSettlementEntityType(type) {
  _setEntityType = type;
  const isCust = type === 'customer';
  document.getElementById('set-type-cust-btn').className = 'btn btn-sm' + (isCust  ? ' btn-primary' : ' btn-ghost');
  document.getElementById('set-type-sup-btn').className  = 'btn btn-sm' + (!isCust ? ' btn-primary' : ' btn-ghost');
  // rebuild entity select
  const sel = document.getElementById('settlement-entity-select');
  const list = isCust ? (db.customers||[]) : (db.suppliers||[]);
  sel.innerHTML = '<option value="">-- اختر --</option>' +
    list.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
  document.getElementById('settlement-current-balance').textContent = '';
  updateSettlementHint();
  updateSettlementPreview();
}

function setSettlementMoveType(type) {
  _setMoveType = type;
  document.getElementById('set-move-credit-btn').className = 'btn btn-sm' + (type==='credit' ? ' btn-success' : ' btn-ghost');
  document.getElementById('set-move-debit-btn').className  = 'btn btn-sm' + (type==='debit'  ? ' btn-danger'  : ' btn-ghost');
  updateSettlementHint();
  updateSettlementPreview();
}

function updateSettlementHint() {
  const el = document.getElementById('settlement-move-hint');
  if (!el) return;
  if (_setEntityType === 'customer') {
    el.textContent = _setMoveType === 'credit'
      ? '✅ دائن: يُخفِّض مديونية العميل (خصم أو إعفاء من جزء الدين)'
      : '➕ مدين: يزيد الرصيد المستحق على العميل';
  } else {
    el.textContent = _setMoveType === 'debit'
      ? '✅ مدين: يُخفِّض المبلغ المستحق للمورد (خصم من المورد)'
      : '➕ دائن: يزيد المبلغ المستحق للمورد';
  }
}

function onSettlementEntityChange() {
  const id   = document.getElementById('settlement-entity-select')?.value;
  const list = _setEntityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const ent  = list.find(x => x.id === id);
  const el   = document.getElementById('settlement-current-balance');
  if (ent && el) {
    el.textContent = `الرصيد الحالي: ${fmtCurr(ent.balance || 0)}`;
  } else if (el) {
    el.textContent = '';
  }
  updateSettlementPreview();
}

function updateSettlementPreview() {
  const prev = document.getElementById('settlement-preview');
  if (!prev) return;
  const id     = document.getElementById('settlement-entity-select')?.value;
  const amount = parseFloat(document.getElementById('settlement-amount')?.value || 0);
  if (!id || !amount) { prev.style.display = 'none'; return; }
  const list = _setEntityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const ent  = list.find(x => x.id === id);
  if (!ent) { prev.style.display = 'none'; return; }

  const before = ent.balance || 0;
  let after;
  if (_setEntityType === 'customer') {
    after = _setMoveType === 'credit' ? before - amount : before + amount;
  } else {
    after = _setMoveType === 'debit' ? before - amount : before + amount;
  }

  const color = after > 0 ? 'var(--accent-red)' : after < 0 ? 'var(--accent-green)' : 'var(--text-muted)';
  document.getElementById('set-prev-before').textContent = fmtCurr(before);
  document.getElementById('set-prev-amount').textContent = (_setMoveType==='credit'?'− ':'+ ') + fmtCurr(amount);
  document.getElementById('set-prev-after').style.color  = color;
  document.getElementById('set-prev-after').textContent  = fmtCurr(after);
  prev.style.display = '';
}

// ── فتح مودال التسوية
function openSettlementModal(editId) {
  upgradeSettlementsDB();
  const editEl = document.getElementById('settlement-edit-id');
  if (editEl) editEl.value = editId || '';

  const title = document.getElementById('settlement-modal-title');
  if (title) title.textContent = editId ? '✏️ تعديل التسوية' : '🤝 تسوية جديدة';

  // default date = today
  const dateEl = document.getElementById('settlement-date');
  if (dateEl) dateEl.value = todayISO();

  if (editId) {
    const s = (db.settlements||[]).find(x => x.id === editId);
    if (s) {
      _setEntityType = s.entityType;
      _setMoveType   = s.moveType;
      if (dateEl) dateEl.value = s.date || todayISO();
      document.getElementById('settlement-amount').value = s.amount;
      document.getElementById('settlement-notes').value  = s.notes || '';
    }
  } else {
    _setEntityType = 'customer';
    _setMoveType   = 'credit';
    document.getElementById('settlement-amount').value = '';
    document.getElementById('settlement-notes').value  = '';
  }

  setSettlementEntityType(_setEntityType);
  setSettlementMoveType(_setMoveType);

  if (editId) {
    const s = (db.settlements||[]).find(x => x.id === editId);
    if (s) {
      document.getElementById('settlement-entity-select').value = s.entityId;
      onSettlementEntityChange();
    }
  }

  // wire amount input for live preview
  const amtEl = document.getElementById('settlement-amount');
  if (amtEl) amtEl.oninput = updateSettlementPreview;

  openModal('modal-settlement');
}

// ── تأكيد التسوية
function confirmSettlement() {
  upgradeSettlementsDB();
  const editId   = document.getElementById('settlement-edit-id')?.value || '';
  const entityId = document.getElementById('settlement-entity-select')?.value;
  const date     = document.getElementById('settlement-date')?.value || todayISO();
  const amount   = parseFloat(document.getElementById('settlement-amount')?.value || 0);
  const notes    = document.getElementById('settlement-notes')?.value?.trim() || '';

  if (!entityId)    { alert('يرجى اختيار العميل أو المورد'); return; }
  if (!amount || amount <= 0) { alert('يرجى إدخال قيمة صحيحة للتسوية'); return; }
  if (!notes)       { alert('يرجى إدخال سبب أو ملاحظة للتسوية'); return; }

  const list = _setEntityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const ent  = list.find(x => x.id === entityId);
  if (!ent) return;

  // إذا كان تعديلاً — عكس التأثير القديم أولاً
  if (editId) {
    const old = (db.settlements||[]).find(x => x.id === editId);
    if (old) {
      const oldEnt = (_setEntityType==='customer'?(db.customers||[]):(db.suppliers||[])).find(x=>x.id===old.entityId);
      if (oldEnt) {
        // reverse old effect
        if (old.entityType==='customer') {
          oldEnt.balance += (old.moveType==='credit' ? old.amount : -old.amount);
        } else {
          oldEnt.balance += (old.moveType==='debit' ? old.amount : -old.amount);
        }
      }
      db.settlements = db.settlements.filter(x => x.id !== editId);
    }
  }

  // تطبيق التأثير على الرصيد
  const before = ent.balance || 0;
  let after;
  if (_setEntityType === 'customer') {
    after = _setMoveType === 'credit' ? before - amount : before + amount;
  } else {
    after = _setMoveType === 'debit' ? before - amount : before + amount;
  }
  ent.balance = after;

  // تسجيل التسوية
  const rec = {
    id: editId || uid(),
    entityType : _setEntityType,
    entityId,
    entityName : ent.name,
    moveType   : _setMoveType,
    amount,
    date,
    notes,
    balBefore  : before,
    balAfter   : after,
    userId     : (typeof currentUser !== 'undefined' ? currentUser?.name : null) || '—',
    ts         : new Date().toISOString()
  };
  db.settlements.push(rec);

  // تسجيل في حركة الحسابات
  addBalanceMovement({
    type       : _setEntityType === 'customer' ? 'customer_settlement' : 'supplier_settlement',
    entityId,
    entityName : ent.name,
    entityType : _setEntityType,
    amount,
    invoiceNum : rec.id,
    notes      : `تسوية: ${notes}`,
    runningBal : after
  });

  saveDB();
  closeModal('modal-settlement');
  renderBalSettlements();
  _renderBalStats();
  if (typeof showToast === 'function') showToast('تم تسجيل التسوية بنجاح', 'success');
}

// ── حذف تسوية
function deleteSettlement(id) {
  if (!confirm('هل تريد حذف هذه التسوية؟ سيتم عكس تأثيرها على الرصيد.')) return;
  upgradeSettlementsDB();
  const s = (db.settlements||[]).find(x => x.id === id);
  if (!s) return;

  const list = s.entityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const ent  = list.find(x => x.id === s.entityId);
  if (ent) {
    // reverse effect
    if (s.entityType === 'customer') {
      ent.balance += (s.moveType === 'credit' ? s.amount : -s.amount);
    } else {
      ent.balance += (s.moveType === 'debit' ? s.amount : -s.amount);
    }
  }

  db.settlements    = db.settlements.filter(x => x.id !== id);
  db.balanceMovements = (db.balanceMovements||[]).filter(x => x.invoiceNum !== id);
  saveDB();
  renderBalSettlements();
  _renderBalStats();
  if (typeof showToast === 'function') showToast('تم حذف التسوية وعكس تأثيرها', 'info');
}

// ── عرض جدول التسويات
function renderBalSettlements() {
  upgradeSettlementsDB();
  const typeFilter = document.getElementById('bal-set-type-filter')?.value || '';
  const moveFilter = document.getElementById('bal-set-move-filter')?.value || '';
  const dateFrom   = document.getElementById('bal-set-date-from')?.value  || '';
  const dateTo     = document.getElementById('bal-set-date-to')?.value    || '';
  const search     = (document.getElementById('bal-set-search')?.value||'').trim().toLowerCase();

  let rows = [...(db.settlements||[])].sort((a,b) => new Date(b.ts||0)-new Date(a.ts||0));

  if (typeFilter) rows = rows.filter(r => r.entityType === typeFilter);
  if (moveFilter) rows = rows.filter(r => r.moveType   === moveFilter);
  if (dateFrom)   rows = rows.filter(r => r.date >= dateFrom);
  if (dateTo)     rows = rows.filter(r => r.date <= dateTo);
  if (search)     rows = rows.filter(r =>
    (r.entityName||'').toLowerCase().includes(search) ||
    (r.notes||'').toLowerCase().includes(search)
  );

  // summary stats
  const custCredit = (db.settlements||[]).filter(s=>s.entityType==='customer'&&s.moveType==='credit').reduce((a,s)=>a+s.amount,0);
  const custDebit  = (db.settlements||[]).filter(s=>s.entityType==='customer'&&s.moveType==='debit' ).reduce((a,s)=>a+s.amount,0);
  const supDebit   = (db.settlements||[]).filter(s=>s.entityType==='supplier'&&s.moveType==='debit' ).reduce((a,s)=>a+s.amount,0);
  const supCredit  = (db.settlements||[]).filter(s=>s.entityType==='supplier'&&s.moveType==='credit').reduce((a,s)=>a+s.amount,0);

  const summary = document.getElementById('bal-set-summary');
  if (summary) summary.innerHTML = `
    <div style="background:var(--accent-green)15;border-radius:8px;padding:10px 16px;flex:1;min-width:130px">
      <div style="font-size:0.72rem;color:var(--text-muted)">خصومات للعملاء (دائن)</div>
      <div style="font-weight:800;color:var(--accent-green)">${fmtCurr(custCredit)}</div>
    </div>
    <div style="background:var(--accent-red)15;border-radius:8px;padding:10px 16px;flex:1;min-width:130px">
      <div style="font-size:0.72rem;color:var(--text-muted)">إضافة لعملاء (مدين)</div>
      <div style="font-weight:800;color:var(--accent-red)">${fmtCurr(custDebit)}</div>
    </div>
    <div style="background:var(--accent-blue)15;border-radius:8px;padding:10px 16px;flex:1;min-width:130px">
      <div style="font-size:0.72rem;color:var(--text-muted)">خصومات من الموردين (مدين)</div>
      <div style="font-weight:800;color:var(--accent-blue)">${fmtCurr(supDebit)}</div>
    </div>
    <div style="background:var(--accent-orange)15;border-radius:8px;padding:10px 16px;flex:1;min-width:130px">
      <div style="font-size:0.72rem;color:var(--text-muted)">إضافة للموردين (دائن)</div>
      <div style="font-weight:800;color:var(--accent-orange)">${fmtCurr(supCredit)}</div>
    </div>
    <div style="background:var(--bg3);border-radius:8px;padding:10px 16px;flex:1;min-width:80px">
      <div style="font-size:0.72rem;color:var(--text-muted)">عدد التسويات</div>
      <div style="font-weight:800">${(db.settlements||[]).length}</div>
    </div>`;

  const tbody = document.getElementById('bal-set-tbody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center" style="color:var(--text-muted)">لا توجد تسويات</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((s, i) => {
    const isCust   = s.entityType === 'customer';
    const isCredit = s.moveType   === 'credit';
    const typeLabel = isCust ? mkBadge('عميل','blue') : mkBadge('مورد','orange');
    const moveLabel = isCredit
      ? `<span style="color:var(--accent-green);font-weight:700">دائن ↓</span>`
      : `<span style="color:var(--accent-red);font-weight:700">مدين ↑</span>`;
    const debitAmt  = (!isCust && isCredit) || (isCust && !isCredit) ? fmtCurr(s.amount) : '—';
    const creditAmt = (isCust && isCredit) || (!isCust && !isCredit) ? fmtCurr(s.amount) : '—';
    // From the requirement:
    // customer credit → reduces debt (credit col), customer debit → increases (debit col)
    // supplier debit → reduces supplier payable (credit col conceptually), supplier credit → increases
    const displayDebit  = isCust && !isCredit ? fmtCurr(s.amount) : (!isCust && isCredit ? fmtCurr(s.amount) : '—');
    const displayCredit = isCust && isCredit  ? fmtCurr(s.amount) : (!isCust && !isCredit ? fmtCurr(s.amount) : '—');
    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td>${typeLabel}</td>
      <td style="font-weight:600">${s.entityName||'—'}</td>
      <td>${moveLabel}</td>
      <td style="color:var(--accent-red);font-weight:700">${displayDebit}</td>
      <td style="color:var(--accent-green);font-weight:700">${displayCredit}</td>
      <td style="font-size:0.82rem">${s.date||'—'}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${s.userId||'—'}</td>
      <td style="font-size:0.78rem;color:var(--text-muted);max-width:160px;white-space:normal">${s.notes||'—'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="openSettlementModal('${s.id}')" title="تعديل"><i class="fa fa-edit"></i></button>
          <button class="btn btn-ghost btn-sm" style="color:var(--accent-red)" onclick="deleteSettlement('${s.id}')" title="حذف"><i class="fa fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 27  إضافة التسويات لكشف الحساب
══════════════════════════════════════════════════════════════ */
// patch openBalStatement to include settlements
(function patchStatementWithSettlements() {
  const _orig = window.openBalStatement;
  if (!_orig) return;
  window.openBalStatement = function(entityType, entityId) {
    // temporarily add settlements to db.balanceMovements view
    // they are already added via addBalanceMovement, so original function will pick them up
    _orig.apply(this, arguments);
    // also inject settlement rows into movements array if needed
    // (already handled via addBalanceMovement calls in confirmSettlement)
  };
})();

/* ══════════════════════════════════════════════════════════════
   § 23  ربط نظام التنقل
══════════════════════════════════════════════════════════════ */
(function registerNav() {
  const _orig = window.navigate;
  if (!_orig) return;
  window.navigate = function(page) {
    _orig.apply(this, arguments);
    if (page === 'balances') setTimeout(() => renderBalancesPage(), 60);
  };
  if (window.PERMISSIONS && !window.PERMISSIONS.balances) {
    window.PERMISSIONS.balances = { admin:true, manager:true, cashier:false, store:false, accountant:true };
  }
})();

/* ══════════════════════════════════════════════════════════════
   § 24  تهيئة عند التحميل
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { upgradeBalancesDB(); upgradeSettlementsDB(); }, 700); });

/* ══════════════════════════════════════════════════════════════
   § 25  تعريض الدوال عالمياً
══════════════════════════════════════════════════════════════ */
Object.assign(window, {
  renderBalancesPage, switchBalTab,
  renderBalCustomers, renderBalSuppliers, renderBalDebts,
  renderBalPayments, renderBalMovements,
  openAddDebtModal, onDebtTypeChange, confirmAddDebt,
  openPayCustomerModal, payCustomerFull, confirmCustomerPayment,
  openPaySupplierModal, paySupplierFull, confirmSupplierPayment,
  openPayDebtModal, payDebtFull, confirmDebtPayment,
  deletePayment, deleteDebt,
  openBalStatement, printStatement, printBalancesReport,
  addBalanceMovement,
  openSettlementModal, confirmSettlement, deleteSettlement,
  setSettlementEntityType, setSettlementMoveType,
  onSettlementEntityChange, updateSettlementPreview,
  renderBalSettlements
});
