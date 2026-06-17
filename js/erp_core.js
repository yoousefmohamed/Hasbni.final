/* =====================================================================
   HASSIBNI — ERP CORE  v1.0
   ✅ نظام فواتير محسّن: إجمالي / خصم / صافي / مدفوع / متبقي / حالة
   ✅ ربط تلقائي: فواتير ↔ أرصدة ↔ ديون ↔ خزنة
   ✅ لوحة مالية احترافية مع مؤشرات لحظية
   ✅ كشف حساب موسّع (عملاء + موردين) مع تصدير PDF/Excel
   ✅ نظام سداد محدّث مع تتبع كامل
   ✅ سجل حركات مالية شامل
   ✅ إشعارات ذكية: ديون / تأخر / حد ائتمان / سيولة
   ✅ تقارير ديناميكية: يومي / أسبوعي / شهري / سنوي
   ✅ لوحة تحكم مالية مع رسوم بيانية تفاعلية
   ===================================================================== */

'use strict';

/* ══════════════════════════════════════════════════════════════
   § 1  تهيئة قاعدة البيانات
══════════════════════════════════════════════════════════════ */
function erpUpgradeDB() {
  let ch = false;
  if (!db.financialMovements)  { db.financialMovements = [];  ch = true; }
  if (!db.smartAlerts)         { db.smartAlerts = [];         ch = true; }
  if (!db.bankBalance)         { db.bankBalance = 0;          ch = true; }

  // ترقية الفواتير الموجودة لإضافة حقول المدفوع/المتبقي
  (db.sales || []).forEach(s => {
    if (s.paidAmount === undefined) {
      s.paidAmount  = s.payment === 'آجل' ? 0 : (s.total || 0);
      s.remaining   = s.payment === 'آجل' ? (s.total || 0) : 0;
      s.payStatus   = s.payment === 'آجل' ? 'unpaid' : 'paid';
      ch = true;
    }
  });
  (db.purchases || []).forEach(p => {
    if (p.paidAmount === undefined) {
      p.paidAmount  = p.payment === 'آجل' ? 0 : (p.total || 0);
      p.remaining   = p.payment === 'آجل' ? (p.total || 0) : 0;
      p.payStatus   = p.payment === 'آجل' ? 'unpaid' : 'paid';
      ch = true;
    }
  });

  if (ch) saveDB();
}

/* ══════════════════════════════════════════════════════════════
   § 2  مساعدات عامة
══════════════════════════════════════════════════════════════ */
const erpFmt  = n => parseFloat(n || 0).toFixed(2);
const erpCurr = n => erpFmt(n) + ' ' + (db.settings?.currency || 'ج.م');
const erpDate = d => d ? new Date(d).toLocaleDateString('ar-EG') : '—';

function erpPayStatusLabel(status) {
  const map = {
    paid:    { text: 'مدفوعة بالكامل',   color: 'var(--accent-green)',  icon: '✅' },
    partial: { text: 'مدفوعة جزئياً',    color: 'var(--accent-orange)', icon: '⚡' },
    unpaid:  { text: 'غير مدفوعة',       color: 'var(--accent-red)',    icon: '❌' }
  };
  return map[status] || map.unpaid;
}

function calcPayStatus(total, paid) {
  const t = parseFloat(total || 0);
  const p = parseFloat(paid  || 0);
  if (p <= 0)   return 'unpaid';
  if (p >= t)   return 'paid';
  return 'partial';
}

/* ══════════════════════════════════════════════════════════════
   § 3  سجل الحركات المالية الشامل
══════════════════════════════════════════════════════════════ */
function erpLogMovement({ category, type, entityId, entityName, entityType, amount, ref, notes }) {
  if (!db.financialMovements) db.financialMovements = [];
  db.financialMovements.push({
    id:         uid(),
    category,       // sale | purchase | payment | return | expense | treasury | settlement
    type,           // credit | debit
    entityId:   entityId   || '',
    entityName: entityName || '',
    entityType: entityType || '',
    amount:     +amount,
    ref:        ref    || '',
    notes:      notes  || '',
    userId:     (typeof currentUser !== 'undefined' ? currentUser?.name : null) || '—',
    ts:         new Date().toISOString(),
    date:       new Date().toLocaleDateString('ar-EG')
  });
}

/* ══════════════════════════════════════════════════════════════
   § 4  حساب الفاتورة مع المدفوع والمتبقي
══════════════════════════════════════════════════════════════ */
function erpCalcInvoiceAmounts(subtotal, discVal, discType, taxRate, paidInput, payment) {
  const sub       = parseFloat(subtotal || 0);
  const dv        = parseFloat(discVal  || 0);
  const disc      = discType === 'percent' ? (sub * dv / 100) : Math.min(dv, sub);
  const afterDisc = sub - disc;
  const tax       = afterDisc * (parseFloat(taxRate || 0) / 100);
  const total     = afterDisc + tax;
  const paid      = payment === 'آجل' ? parseFloat(paidInput || 0) : total;
  const remaining = Math.max(0, total - paid);
  const status    = calcPayStatus(total, paid);
  return { sub, disc, afterDisc, tax, total, paid, remaining, status };
}

/* ══════════════════════════════════════════════════════════════
   § 5  تحديث نافذة POS — حقول المدفوع والمتبقي والحالة
══════════════════════════════════════════════════════════════ */
function erpUpdatePosRemaining() {
  const payEl   = document.getElementById('pos-payment-select');
  const payment = payEl?.value || 'نقدي';
  const paidEl  = document.getElementById('pos-paid-amount');
  const paid    = parseFloat(paidEl?.value || 0) || 0;

  // حساب الإجمالي من السلة — استخدام calcCart() مباشرةً لضمان الدقة
  const total = (typeof calcCart === 'function') ? (calcCart().total || 0) : 
    parseFloat(document.getElementById('pos-total')?.textContent?.replace(/[^\d.]/g, '') || 0) || 0;

  const isCredit  = payment === 'آجل';
  const remaining = Math.max(0, total - (isCredit ? paid : total));
  const status    = calcPayStatus(total, isCredit ? paid : total);
  const st        = erpPayStatusLabel(status);

  // شريط الآجل المحسّن
  const statusStrip = document.getElementById('pos-erp-status-strip');
  const changeRow   = document.getElementById('pos-change-row');

  if (isCredit) {
    if (changeRow)   changeRow.style.display = 'none';
    if (statusStrip) statusStrip.style.display = 'flex';
    _setERP('pos-remaining-amount', erpFmt(remaining) + ' جنيه');
    _setERP('pos-paid-now-disp',    erpFmt(paid)      + ' جنيه');
    const badge = document.getElementById('pos-pay-status-badge');
    if (badge) {
      badge.textContent = `${st.icon} ${st.text}`;
      badge.style.color = st.color || '';
    }
  } else {
    if (changeRow)   changeRow.style.display = '';
    if (statusStrip) statusStrip.style.display = 'none';
  }

  // منع إتمام البيع إذا الدفع نقدي والمبلغ غير كافٍ
  const saveBtn = document.getElementById('pos-save-btn-erp');
  if (saveBtn && payment === 'نقدي' && paid > 0 && paid < total) {
    saveBtn.style.opacity = '0.5';
  } else if (saveBtn) {
    saveBtn.style.opacity = '';
  }
  // إظهار / إخفاء حقل أيام الأجل للبيع
  const posCdw = document.getElementById('pos-credit-days-wrap');
  if (posCdw) posCdw.style.display = isCredit ? '' : 'none';
  if (isCredit) updatePosDueDateDisplay();
}

function erpUpdatePurRemaining() {
  const payment = document.getElementById('pur-payment-select')?.value || 'نقدي';
  const paid    = parseFloat(document.getElementById('pur-paid-amount')?.value || 0) || 0;
  const total   = parseFloat(document.getElementById('pur-total')?.textContent?.replace(/[^\d.]/g, '') || 0) || 0;
  const remaining = Math.max(0, total - (payment === 'آجل' ? paid : total));
  const status    = calcPayStatus(total, payment === 'آجل' ? paid : total);
  const st        = erpPayStatusLabel(status);
  _setERP('pur-remaining-amount', erpFmt(remaining));
  _setERP('pur-pay-status-badge', `${st.icon} ${st.text}`, 'color', st.color);
  // إظهار / إخفاء حقل أيام الأجل
  const cdw = document.getElementById('pur-credit-days-wrap');
  if (cdw) cdw.style.display = payment === 'آجل' ? '' : 'none';
}

function erpUpdateWsRemaining() {
  const payment = document.getElementById('ws-payment-select')?.value || 'نقدي';
  const paid    = parseFloat(document.getElementById('ws-paid-amount')?.value || 0) || 0;
  const total   = parseFloat(document.getElementById('ws-total')?.textContent?.replace(/[^\d.]/g, '') || 0) || 0;
  const remaining = Math.max(0, total - (payment === 'آجل' ? paid : total));
  const status    = calcPayStatus(total, payment === 'آجل' ? paid : total);
  const st        = erpPayStatusLabel(status);
  _setERP('ws-remaining-amount', erpFmt(remaining));
  _setERP('ws-pay-status-badge', `${st.icon} ${st.text}`, 'color', st.color);
}

function _setERP(id, text, prop, val) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = text;
  if (prop && val) e.style[prop] = val;
}

/* ══════════════════════════════════════════════════════════════
   § 6  حقن حقول المدفوع/المتبقي/الحالة في الفواتير
══════════════════════════════════════════════════════════════ */
function erpInjectInvoiceFields() {
  _injectFields('pos', 'pos-payment-select', 'pos-paid-amount', erpUpdatePosRemaining);
  _injectFields('pur', 'pur-payment-select', 'pur-paid-amount', erpUpdatePurRemaining);
  _injectFields('ws',  'ws-payment-select',  'ws-paid-amount',  erpUpdateWsRemaining);

  // ربط أحداث تحديث الحالة عند تغيير طريقة الدفع
  ['pos-payment-select','pur-payment-select','ws-payment-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const prefix = id.split('-')[0];
      if (prefix === 'pos') erpUpdatePosRemaining();
      else if (prefix === 'pur') erpUpdatePurRemaining();
      else if (prefix === 'ws') erpUpdateWsRemaining();
    });
  });
}

function _injectFields(prefix, paySelectId, paidId, updateFn) {
  const payEl = document.getElementById(paySelectId);
  if (!payEl) return;

  // حقل المبلغ المدفوع — إذا لم يكن موجوداً لـ PUR
  if (prefix === 'pur') {
    const notesEl = document.getElementById('pur-notes');
    if (notesEl && !document.getElementById('pur-paid-amount')) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px';
      wrap.innerHTML = `
        <input type="number" id="pur-paid-amount" class="psb-paid-input"
          placeholder="المدفوع (اختياري)" min="0" step="0.01"
          style="width:130px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text-main);font-size:0.9rem"
          oninput="erpUpdatePurRemaining()">`;
      notesEl.parentNode.insertBefore(wrap, notesEl);
    }
  }

  // إضافة عرض المتبقي والحالة
  const paidEl = document.getElementById(paidId);
  if (!paidEl) return;

  const parentSection = paidEl.closest('.psb-payment') || paidEl.parentNode?.parentNode;
  if (!parentSection || document.getElementById(`${prefix}-remaining-amount`)) return;

  const strip = document.createElement('div');
  strip.id = `${prefix}-erp-status-strip`;
  strip.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg-input);border-radius:8px;margin-top:4px;font-size:0.82rem;border:1px solid var(--border)';
  strip.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center">
      <span style="color:var(--text-muted)">المتبقي:</span>
      <span id="${prefix}-remaining-amount" style="font-weight:800;color:var(--accent-red)">0.00</span>
    </div>
    <span id="${prefix}-pay-status-badge" style="font-weight:700;font-size:0.8rem">—</span>`;

  paidEl.parentNode.insertAdjacentElement('afterend', strip);

  // ربط أحداث
  paidEl.addEventListener('input', updateFn);
  payEl.addEventListener('change', updateFn);
}

/* ══════════════════════════════════════════════════════════════
   § 7  Patch فواتير البيع — حفظ المدفوع/المتبقي والحالة
══════════════════════════════════════════════════════════════ */
function erpPatchSaleCheckout() {
  const _orig = window.completeSale;
  if (!_orig || window._erpSalePatched) return;
  window._erpSalePatched = true;

  window.completeSale = function() {
    const payment  = document.getElementById('pos-payment-select')?.value || 'نقدي';
    const paidInp  = parseFloat(document.getElementById('pos-paid-amount')?.value || 0) || 0;
    const total    = _getPosTotal();
    const paid     = payment === 'آجل' ? paidInp : total;
    const remaining = Math.max(0, total - paid);
    const status   = calcPayStatus(total, paid);

    _orig.apply(this, arguments);

    // تحديث آخر فاتورة محفوظة
    const last = (db.sales || []).slice(-1)[0];
    if (last) {
      last.paidAmount = paid;
      last.remaining  = remaining;
      last.payStatus  = status;

      // ملاحظة: تسجيل الدفعة المقدمة وخصم المبلغ من رصيد العميل تم بالفعل
      // داخل completeSale الأصلية في app.js — لا يتم تكرار ذلك هنا لتجنب
      // خصم المبلغ مرتين من رصيد العميل (وتكرار حركة الخزنة).

      // تسجيل حركة مالية (للتقارير فقط — لا تؤثر على الأرصدة)
      erpLogMovement({
        category: 'sale', type: 'debit',
        entityId: last.customerId, entityName: last.customerName, entityType: 'customer',
        amount: total, ref: last.id, notes: `فاتورة بيع — ${erpPayStatusLabel(status).text}`
      });
      if (paid > 0 && paid < total) {
        erpLogMovement({ category: 'payment', type: 'credit', entityId: last.customerId, entityName: last.customerName, entityType: 'customer', amount: paid, ref: last.id, notes: 'دفعة مقدمة' });
      }

      saveDB();
    }
    erpRefreshFinancialDashboard();
    erpCheckAlerts();
  };
}

/* ══════════════════════════════════════════════════════════════
   § 8  Patch فواتير الشراء
══════════════════════════════════════════════════════════════ */
function erpPatchPurchase() {
  const _orig = window.completePurchase;
  if (!_orig || window._erpPurPatched) return;
  window._erpPurPatched = true;

  window.completePurchase = function() {
    const payment  = document.getElementById('pur-payment-select')?.value || 'نقدي';
    const paidInp  = parseFloat(document.getElementById('pur-paid-amount')?.value || 0) || 0;
    const total    = _getPurTotal();
    const paid     = payment === 'آجل' ? paidInp : total;
    const remaining = Math.max(0, total - paid);
    const status   = calcPayStatus(total, paid);

    _orig.apply(this, arguments);

    const last = (db.purchases || []).slice(-1)[0];
    if (last) {
      last.paidAmount = paid;
      last.remaining  = remaining;
      last.payStatus  = status;

      // ملاحظة: تسجيل الدفعة المقدمة وخصم المبلغ من رصيد المورد تم بالفعل
      // داخل completePurchase الأصلية في app.js — لا يتم تكرار ذلك هنا.

      erpLogMovement({
        category: 'purchase', type: 'credit',
        entityId: last.supplierId, entityName: last.supplierName, entityType: 'supplier',
        amount: total, ref: last.invNum, notes: `فاتورة شراء — ${erpPayStatusLabel(status).text}`
      });
      if (paid > 0 && paid < total) {
        erpLogMovement({ category: 'payment', type: 'debit', entityId: last.supplierId, entityName: last.supplierName, entityType: 'supplier', amount: paid, ref: last.invNum, notes: 'دفعة مقدمة' });
      }

      saveDB();
    }
    erpRefreshFinancialDashboard();
    erpCheckAlerts();
  };
}

/* ══════════════════════════════════════════════════════════════
   § 9  Patch فواتير الجملة
══════════════════════════════════════════════════════════════ */
function erpPatchWholesale() {
  const _orig = window.completeWholesale;
  if (!_orig || window._erpWsPatched) return;
  window._erpWsPatched = true;

  window.completeWholesale = function() {
    const payment  = document.getElementById('ws-payment-select')?.value || 'نقدي';
    const paidInp  = parseFloat(document.getElementById('ws-paid-amount')?.value || 0) || 0;
    const total    = _getWsTotal();
    const paid     = payment === 'آجل' ? paidInp : total;
    const remaining = Math.max(0, total - paid);
    const status   = calcPayStatus(total, paid);

    _orig.apply(this, arguments);

    const last = (db.sales || []).filter(s => s.type === 'wholesale').slice(-1)[0];
    if (last) {
      last.paidAmount = paid;
      last.remaining  = remaining;
      last.payStatus  = status;

      // ملاحظة: تسجيل الدفعة المقدمة وخصم المبلغ من رصيد العميل (إن وُجد) تم
      // بالفعل داخل completeWholesale الأصلية — لا يتم تكرار ذلك هنا.

      erpLogMovement({
        category: 'sale', type: 'debit',
        entityId: last.customerId, entityName: last.customerName, entityType: 'customer',
        amount: total, ref: last.invNum || last.id, notes: `فاتورة جملة — ${erpPayStatusLabel(status).text}`
      });
      if (paid > 0 && paid < total) {
        erpLogMovement({ category: 'payment', type: 'credit', entityId: last.customerId, entityName: last.customerName, entityType: 'customer', amount: paid, ref: last.invNum || last.id, notes: 'دفعة مقدمة' });
      }

      saveDB();
    }
    erpRefreshFinancialDashboard();
    erpCheckAlerts();
  };
}

function _getPosTotal() {
  return parseFloat(document.querySelector('#pos-cart-items ~ * #pos-grand-total, [id="pos-grand-total"]')?.textContent?.replace(/[^\d.]/g,'') || 0) ||
         parseFloat(document.getElementById('pos-total')?.textContent?.replace(/[^\d.]/g,'') || 0) || 0;
}
function _getPurTotal() {
  return parseFloat(document.getElementById('pur-total')?.textContent?.replace(/[^\d.]/g,'') || 0) || 0;
}
function _getWsTotal() {
  return parseFloat(document.getElementById('ws-total')?.textContent?.replace(/[^\d.]/g,'') || 0) || 0;
}

/* ══════════════════════════════════════════════════════════════
   § 10  حقن البيانات في طباعة الفاتورة
══════════════════════════════════════════════════════════════ */
function erpBuildInvoiceSummaryHTML(sale) {
  const st = erpPayStatusLabel(sale.payStatus || calcPayStatus(sale.total, sale.paidAmount));
  return `
    <div style="border-top:2px solid #eee;margin-top:12px;padding-top:12px">
      <table style="width:100%;font-size:0.9rem">
        <tr><td>المجموع الفرعي:</td><td style="text-align:left;font-weight:700">${erpCurr(sale.subtotal)}</td></tr>
        ${(sale.discount||0)>0?`<tr><td>الخصم:</td><td style="text-align:left;color:#e53e3e">- ${erpCurr(sale.discount)}</td></tr>`:''}
        ${(sale.tax||0)>0?`<tr><td>الضريبة:</td><td style="text-align:left">${erpCurr(sale.tax)}</td></tr>`:''}
        <tr style="font-size:1.1rem;font-weight:900;border-top:1px solid #eee">
          <td>الإجمالي النهائي:</td><td style="text-align:left;color:#2d6a4f">${erpCurr(sale.total)}</td>
        </tr>
        <tr><td>المدفوع:</td><td style="text-align:left;color:green;font-weight:700">${erpCurr(sale.paidAmount||0)}</td></tr>
        <tr><td>المتبقي:</td><td style="text-align:left;color:${(sale.remaining||0)>0?'#e53e3e':'green'};font-weight:700">${erpCurr(sale.remaining||0)}</td></tr>
      </table>
      <div style="text-align:center;margin-top:10px;padding:6px;border-radius:6px;background:${st.color}22;color:${st.color};font-weight:700;font-size:0.95rem">
        ${st.icon} ${st.text}
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   § 11  لوحة التحكم المالية الاحترافية
══════════════════════════════════════════════════════════════ */
function erpGetFinancialSummary() {
  const sales     = db.sales     || [];
  const purchases = db.purchases || [];
  const payments  = db.payments  || [];
  const expenses  = db.expenses  || [];
  const treasury  = db.treasury  || [];
  const customers = db.customers || [];
  const suppliers = db.suppliers || [];
  const settlements = db.settlements || [];

  const today      = new Date().toDateString();
  const thisMonth  = new Date().toISOString().slice(0, 7);
  const thisYear   = new Date().getFullYear().toString();
  const lastMonth  = new Date(new Date().setMonth(new Date().getMonth()-1)).toISOString().slice(0,7);

  // مبيعات
  const todaySales   = sales.filter(s => new Date(s.ts||s.date).toDateString()===today).reduce((a,s)=>a+(s.total||0),0);
  const monthSales   = sales.filter(s=>(s.ts||s.date||'').slice(0,7)===thisMonth).reduce((a,s)=>a+(s.total||0),0);
  const lastMonthSales = sales.filter(s=>(s.ts||s.date||'').slice(0,7)===lastMonth).reduce((a,s)=>a+(s.total||0),0);
  const yearSales    = sales.filter(s=>(s.ts||s.date||'').startsWith(thisYear)).reduce((a,s)=>a+(s.total||0),0);
  const totalSales   = sales.reduce((a,s)=>a+(s.total||0),0);

  // مشتريات
  const monthPurchases = purchases.filter(p=>(p.ts||p.date||'').slice(0,7)===thisMonth).reduce((a,p)=>a+(p.total||0),0);
  const totalPurchases = purchases.reduce((a,p)=>a+(p.total||0),0);

  // ديون
  const custDebt = customers.reduce((a,c)=>a+Math.max(0,c.balance||0),0);
  const supDebt  = suppliers.reduce((a,s)=>a+Math.max(0,s.balance||0),0);

  // أرباح
  const cogs     = sales.reduce((a,s)=>a+((s.items||[]).reduce((b,i)=>b+(i.cost||0)*(i.qty||1),0)),0);
  const totalExp = expenses.reduce((a,e)=>a+(e.amount||0),0);
  const grossProfit = totalSales - cogs;
  const netProfit   = grossProfit - totalExp;

  // خزنة
  const cashIn  = treasury.filter(t=>t.type==='إيراد').reduce((a,t)=>a+(t.amount||0),0);
  const cashOut = treasury.filter(t=>t.type==='مصروف').reduce((a,t)=>a+(t.amount||0),0);
  const cashWithdrawals = treasury.filter(t=>t.type==='سحب').reduce((a,t)=>a+(t.amount||0),0);
  const cashBal = cashIn - cashOut - cashWithdrawals;

  // تسديدات اليوم
  const todayPaid = payments.filter(p=>new Date(p.ts||p.date).toDateString()===today).reduce((a,p)=>a+(p.amount||0),0);

  // فواتير معلقة
  const pendingSales = sales.filter(s=>s.payStatus==='unpaid'||s.payStatus==='partial').length;
  const pendingPurch = purchases.filter(p=>p.payStatus==='unpaid'||p.payStatus==='partial').length;

  // نمو المبيعات
  const salesGrowth = lastMonthSales > 0 ? ((monthSales - lastMonthSales) / lastMonthSales * 100) : 0;

  return {
    todaySales, monthSales, lastMonthSales, yearSales, totalSales,
    monthPurchases, totalPurchases,
    custDebt, supDebt,
    grossProfit, netProfit, totalExp,
    cashBal, cashWithdrawals, bankBalance: db.bankBalance || 0,
    todayPaid, pendingSales, pendingPurch,
    salesGrowth,
    netLiquidity: cashBal + (db.bankBalance||0) - supDebt,
    totalCustomers: customers.length,
    debtorCount: customers.filter(c=>(c.balance||0)>0).length
  };
}

function erpRefreshFinancialDashboard() {
  const s = erpGetFinancialSummary();

  // بطاقات الداشبورد المالية
  _erpTxt('erp-today-sales',      erpCurr(s.todaySales));
  _erpTxt('erp-month-sales',      erpCurr(s.monthSales));
  _erpTxt('erp-year-sales',       erpCurr(s.yearSales));
  _erpTxt('erp-month-purchases',  erpCurr(s.monthPurchases));
  _erpTxt('erp-cust-debt',        erpCurr(s.custDebt));
  _erpTxt('erp-sup-debt',         erpCurr(s.supDebt));
  _erpTxt('erp-gross-profit',     erpCurr(s.grossProfit));
  _erpTxt('erp-net-profit',       erpCurr(s.netProfit));
  _erpTxt('erp-cash-balance',     erpCurr(s.cashBal));
  _erpTxt('erp-bank-balance',     erpCurr(s.bankBalance));
  _erpTxt('erp-net-liquidity',    erpCurr(s.netLiquidity));
  _erpTxt('erp-today-collected',  erpCurr(s.todayPaid));
  _erpTxt('erp-pending-sales',    s.pendingSales + ' فاتورة');
  _erpTxt('erp-pending-purch',    s.pendingPurch + ' فاتورة');

  // نمو المبيعات
  const grEl = document.getElementById('erp-sales-growth');
  if (grEl) {
    const sign = s.salesGrowth >= 0 ? '▲' : '▼';
    grEl.textContent = `${sign} ${Math.abs(s.salesGrowth).toFixed(1)}%`;
    grEl.style.color = s.salesGrowth >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }

  // رسم الأعمدة الشهرية
  erpRenderMonthlySalesChart();
  erpRenderDebtPieChart();
}

function _erpTxt(id, val) { const e = document.getElementById(id); if(e) e.textContent = val; }

/* ══════════════════════════════════════════════════════════════
   § 12  رسم بياني: المبيعات الشهرية (SVG)
══════════════════════════════════════════════════════════════ */
function erpRenderMonthlySalesChart() {
  const el = document.getElementById('erp-monthly-chart');
  if (!el) return;

  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('ar-EG', { month: 'short' });
    const total = (db.sales||[]).filter(s=>(s.ts||s.date||'').slice(0,7)===key).reduce((a,s)=>a+(s.total||0),0);
    const purch = (db.purchases||[]).filter(p=>(p.ts||p.date||'').slice(0,7)===key).reduce((a,p)=>a+(p.total||0),0);
    months.push({ label, total, purch });
  }

  const maxVal = Math.max(...months.map(m => Math.max(m.total, m.purch)), 1);
  const W = 780, H = 200, PAD = 40, barW = 20, gap = (W - PAD*2) / 12;

  const bars = months.map((m, i) => {
    const x    = PAD + i * gap;
    const sh   = (m.total / maxVal) * (H - 30);
    const ph   = (m.purch / maxVal) * (H - 30);
    return `
      <rect x="${x}"          y="${H - sh}" width="${barW}" height="${sh}" fill="var(--accent-green)" rx="3" opacity="0.85"/>
      <rect x="${x+barW+2}"   y="${H - ph}" width="${barW}" height="${ph}" fill="var(--accent-orange)" rx="3" opacity="0.85"/>
      <text x="${x+barW}"     y="${H + 14}" text-anchor="middle" fill="var(--text-muted)" font-size="9">${m.label}</text>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H+30}" style="width:100%;height:180px">
      <line x1="${PAD}" y1="0" x2="${PAD}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
      <line x1="${PAD}" y1="${H}" x2="${W-10}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
      ${bars}
      <rect x="${W-120}" y="5"  width="12" height="12" fill="var(--accent-green)"  rx="2"/>
      <text x="${W-104}" y="15" fill="var(--text-muted)" font-size="11">مبيعات</text>
      <rect x="${W-60}"  y="5"  width="12" height="12" fill="var(--accent-orange)" rx="2"/>
      <text x="${W-44}"  y="15" fill="var(--text-muted)" font-size="11">مشتريات</text>
    </svg>`;
}

/* ══════════════════════════════════════════════════════════════
   § 13  رسم بياني: توزيع الديون (SVG دائري)
══════════════════════════════════════════════════════════════ */
function erpRenderDebtPieChart() {
  const el = document.getElementById('erp-debt-chart');
  if (!el) return;
  const s = erpGetFinancialSummary();
  const total = s.custDebt + s.supDebt + 0.01;
  const custAngle = (s.custDebt / total) * 360;

  const polarToCart = (cx,cy,r,angle) => {
    const rad = (angle - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const cx=80, cy=80, r=65;
  const p1 = polarToCart(cx,cy,r,0);
  const p2 = polarToCart(cx,cy,r,custAngle);
  const large = custAngle > 180 ? 1 : 0;

  el.innerHTML = `
    <svg viewBox="0 0 220 160" style="width:100%;height:130px">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--accent-orange)" opacity="0.8"/>
      <path d="M${cx},${cy} L${p1.x},${p1.y} A${r},${r} 0 ${large},1 ${p2.x},${p2.y} Z"
            fill="var(--accent-red)" opacity="0.85"/>
      <circle cx="${cx}" cy="${cy}" r="${r*0.5}" fill="var(--bg-card)"/>
      <text x="${cx}" y="${cy+5}" text-anchor="middle" fill="var(--text-main)" font-size="11" font-weight="700">ديون</text>
      <rect x="155" y="30"  width="12" height="12" fill="var(--accent-red)"    rx="2"/>
      <text x="170" y="40"  fill="var(--text-muted)" font-size="10">عملاء</text>
      <text x="170" y="52"  fill="var(--accent-red)" font-size="10" font-weight="700">${erpCurr(s.custDebt)}</text>
      <rect x="155" y="65"  width="12" height="12" fill="var(--accent-orange)" rx="2"/>
      <text x="170" y="75"  fill="var(--text-muted)" font-size="10">موردين</text>
      <text x="170" y="87"  fill="var(--accent-orange)" font-size="10" font-weight="700">${erpCurr(s.supDebt)}</text>
      <rect x="155" y="100" width="12" height="12" fill="var(--accent-green)"  rx="2"/>
      <text x="170" y="110" fill="var(--text-muted)" font-size="10">سيولة صافية</text>
      <text x="170" y="122" fill="var(--accent-green)" font-size="10" font-weight="700">${erpCurr(s.netLiquidity)}</text>
    </svg>`;
}

/* ══════════════════════════════════════════════════════════════
   § 14  الإشعارات الذكية
══════════════════════════════════════════════════════════════ */
function erpCheckAlerts() {
  const alerts = [];
  const s      = erpGetFinancialSummary();
  const settings = db.settings || {};
  const maxDebt  = parseFloat(settings.maxCustomerDebt  || 0);
  const minLiq   = parseFloat(settings.minLiquidity     || 0);
  const creditLim = parseFloat(settings.defaultCreditLimit || 0);

  // 1. سيولة منخفضة
  if (minLiq > 0 && s.cashBal < minLiq) {
    alerts.push({ type: 'danger', icon: '🚨', title: 'سيولة نقدية منخفضة', msg: `رصيد الخزنة ${erpCurr(s.cashBal)} أقل من الحد الأدنى ${erpCurr(minLiq)}` });
  }

  // 2. إجمالي ديون العملاء مرتفعة
  if (maxDebt > 0 && s.custDebt > maxDebt) {
    alerts.push({ type: 'warning', icon: '⚠️', title: 'ديون العملاء مرتفعة', msg: `إجمالي الديون ${erpCurr(s.custDebt)} تجاوز الحد ${erpCurr(maxDebt)}` });
  }

  // 3. تجاوز حد الائتمان
  if (creditLim > 0) {
    (db.customers||[]).forEach(c => {
      const limit = c.creditLimit || creditLim;
      if ((c.balance||0) > limit) {
        alerts.push({ type: 'warning', icon: '💳', title: 'تجاوز حد الائتمان', msg: `${c.name}: ${erpCurr(c.balance)} تجاوز الحد ${erpCurr(limit)}` });
      }
    });
  }

  // 4. فواتير معلقة قديمة (أكثر من 30 يوم)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  (db.sales||[]).filter(s => (s.payStatus==='unpaid'||s.payStatus==='partial') && new Date(s.ts||s.date).getTime() < thirtyDaysAgo).forEach(s => {
    alerts.push({ type: 'warning', icon: '📅', title: 'فاتورة متأخرة', msg: `فاتورة ${s.id||s.invNum} — ${s.customerName} (${erpCurr(s.remaining||0)} متبقي)` });
  });

  // 5. مستحقات موردين مرتفعة
  (db.suppliers||[]).filter(s=>(s.balance||0)>10000).forEach(s => {
    alerts.push({ type: 'info', icon: '🏭', title: 'مستحقات مورد', msg: `${s.name}: ${erpCurr(s.balance)} مستحق السداد` });
  });

  // حفظ وعرض
  db.smartAlerts = alerts;

  // تحديث شارة الشريط الجانبي
  const badge = document.getElementById('erp-alerts-count');
  if (badge) {
    badge.style.display = alerts.length ? 'flex' : 'none';
    badge.textContent = alerts.length > 9 ? '9+' : alerts.length;
  }

  const el = document.getElementById('erp-smart-alerts');
  if (!el) return;

  if (!alerts.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--accent-green);padding:12px">✅ لا توجد تنبيهات — كل شيء على ما يرام</div>`;
    return;
  }

  const colorMap = { danger: 'var(--accent-red)', warning: 'var(--accent-orange)', info: 'var(--accent-blue)' };
  el.innerHTML = alerts.slice(0, 8).map(a => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-radius:8px;margin-bottom:6px;background:${colorMap[a.type]}15;border-right:3px solid ${colorMap[a.type]}">
      <span style="font-size:1.1rem">${a.icon}</span>
      <div>
        <div style="font-weight:700;font-size:0.82rem;color:${colorMap[a.type]}">${a.title}</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${a.msg}</div>
      </div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 15  كشف حساب موسّع مع تصدير
══════════════════════════════════════════════════════════════ */
function erpOpenEnhancedStatement(entityType, entityId) {
  erpUpgradeDB();
  const list   = entityType === 'customer' ? (db.customers||[]) : (db.suppliers||[]);
  const entity = list.find(x => x.id === entityId);
  if (!entity) return;

  const movements = _buildEntityMovements(entityType, entityId);

  // إحصائيات
  const totalDebit  = movements.reduce((a,m)=>a+m.debit,  0);
  const totalCredit = movements.reduce((a,m)=>a+m.credit, 0);
  const balance     = entity.balance || 0;

  // أحدث معاملة / أحدث سداد
  const lastTxn = movements.length ? movements[movements.length-1] : null;
  const lastPay = [...movements].reverse().find(m => m.type==='تسديد' || m.type==='دفع' || m.type==='تسوية');

  const stLabel = entityType === 'customer'
    ? (balance > 0 ? 'مدين' : balance < 0 ? 'دائن' : 'سوي')
    : (balance > 0 ? 'علينا' : balance < 0 ? 'لنا' : 'سوي');
  const stColor = balance > 0 ? 'var(--accent-red)' : balance < 0 ? 'var(--accent-green)' : 'var(--text-muted)';

  let running = 0;
  const rows = movements.map((m, i) => {
    running += m.debit - m.credit;
    const rc = running > 0 ? 'var(--accent-red)' : running < 0 ? 'var(--accent-green)' : 'var(--text-muted)';
    return `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td style="font-size:0.78rem">${m.date}</td>
      <td style="font-size:0.8rem">${m.type}</td>
      <td style="font-size:0.75rem;color:var(--text-muted)">${m.ref||'—'}</td>
      <td style="color:var(--accent-red);font-weight:700">${m.debit>0?erpCurr(m.debit):'—'}</td>
      <td style="color:var(--accent-green);font-weight:700">${m.credit>0?erpCurr(m.credit):'—'}</td>
      <td style="color:${rc};font-weight:800">${erpCurr(Math.abs(running))} ${running>0?'د':running<0?'ج':'✓'}</td>
      <td style="font-size:0.75rem;color:var(--text-muted);max-width:120px;white-space:normal">${m.notes||'—'}</td>
    </tr>`;
  }).join('');

  const storeName = db.settings?.storeName || 'المتجر';
  const html = `
    <div style="padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:16px;border-bottom:2px solid var(--border)">
        <div>
          <div style="font-size:1.2rem;font-weight:800">${storeName}</div>
          <div style="color:var(--text-muted);font-size:0.85rem">كشف حساب — ${entity.name}</div>
          <div style="color:var(--text-muted);font-size:0.78rem">${entity.phone||''}</div>
        </div>
        <div style="text-align:left">
          <div style="font-size:0.75rem;color:var(--text-muted)">تاريخ الكشف</div>
          <div style="font-weight:700">${new Date().toLocaleDateString('ar-EG')}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">الرصيد الحالي</div>
          <div style="font-size:1.3rem;font-weight:900;color:${stColor}">${erpCurr(balance)} (${stLabel})</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px">
        ${_statCard('إجمالي المديونية',   erpCurr(totalDebit),  'var(--accent-red)')}
        ${_statCard('إجمالي التسديدات',   erpCurr(totalCredit), 'var(--accent-green)')}
        ${_statCard('الرصيد الصافي',      erpCurr(balance),     stColor)}
        ${_statCard('عدد الحركات',        movements.length,      'var(--accent-blue)')}
        ${_statCard('آخر معاملة',         lastTxn?.date||'—',   'var(--text-muted)')}
        ${_statCard('آخر سداد',           lastPay?.date||'—',   'var(--accent-green)')}
      </div>

      ${movements.length ? `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>#</th><th>التاريخ</th><th>البيان</th><th>المرجع</th>
            <th style="color:var(--accent-red)">مدين</th>
            <th style="color:var(--accent-green)">دائن</th>
            <th>الرصيد</th><th>ملاحظات</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="background:var(--bg3);font-weight:800">
            <td colspan="4" style="text-align:center">الإجماليات</td>
            <td style="color:var(--accent-red)">${erpCurr(totalDebit)}</td>
            <td style="color:var(--accent-green)">${erpCurr(totalCredit)}</td>
            <td colspan="2" style="color:${stColor}">${erpCurr(balance)} ${stLabel}</td>
          </tr></tfoot>
        </table>
      </div>` : `<div class="empty-state"><p>لا توجد حركات مسجّلة</p></div>`}

      <div style="display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="erpPrintStatement('${entityType}','${entityId}')">
          <i class="fa fa-print"></i> طباعة
        </button>
        <button class="btn btn-ghost btn-sm" onclick="erpExportStatementPDF('${entityType}','${entityId}')">
          <i class="fa fa-file-pdf"></i> تصدير PDF
        </button>
        <button class="btn btn-ghost btn-sm" onclick="erpExportStatementExcel('${entityType}','${entityId}')">
          <i class="fa fa-file-excel"></i> تصدير Excel
        </button>
        ${balance > 0 ? `
        <button class="btn btn-success btn-sm" onclick="closeModal('modal-bal-statement');${entityType==='customer'?`openPayCustomerModal('${entityId}')`:`openPaySupplierModal('${entityId}')`}">
          <i class="fa fa-money-bill"></i> ${entityType==='customer'?'تسجيل تسديد':'دفع المستحق'}
        </button>` : ''}
      </div>
    </div>`;

  const titleEl = document.getElementById('bal-stmt-title');
  if (titleEl) titleEl.textContent = `📄 كشف حساب — ${entity.name}`;
  const contentEl = document.getElementById('bal-stmt-content');
  if (contentEl) contentEl.innerHTML = html;
  openModal('modal-bal-statement');
}

function _statCard(label, val, color) {
  return `<div style="background:var(--bg3);border-radius:8px;padding:10px 12px">
    <div style="font-size:0.72rem;color:var(--text-muted)">${label}</div>
    <div style="font-weight:800;color:${color};margin-top:2px">${val}</div>
  </div>`;
}

function _buildEntityMovements(entityType, entityId) {
  const movements = [
    ...(db.sales||[]).filter(s => s.customerId===entityId && s.payment==='آجل')
      .map(s => ({ ts:s.ts||s.date, date:erpDate(s.ts||s.date), type:'بيع آجل', ref:s.id||s.invNum, debit:s.total, credit:0, notes:`فاتورة — مدفوع: ${erpCurr(s.paidAmount||0)}` })),
    ...(db.purchases||[]).filter(p => p.supplierId===entityId && p.payment==='آجل')
      .map(p => ({ ts:p.ts||p.date, date:erpDate(p.ts||p.date), type:'شراء آجل', ref:p.invNum||p.id, debit:p.total, credit:0, notes:`فاتورة — مدفوع: ${erpCurr(p.paidAmount||0)}` })),
    ...(db.payments||[]).filter(p => p.entityId===entityId)
      .map(p => ({ ts:p.ts, date:p.date||'—', type:entityType==='customer'?'تسديد':'دفع', ref:p.id, debit:0, credit:p.amount, notes:p.method?`${p.method}${p.note?` — ${p.note}`:''}`:p.note||'—' })),
    ...(db.debts||[]).filter(d => d.entityId===entityId)
      .map(d => ({ ts:d.ts, date:d.date||'—', type:'دين يدوي', ref:d.id, debit:d.amount, credit:0, notes:d.desc||'—' })),
    ...(db.settlements||[]).filter(s => s.entityId===entityId)
      .map(s => {
        let debit=0, credit=0;
        if (entityType==='customer') { if(s.moveType==='debit') debit=s.amount; else credit=s.amount; }
        else { if(s.moveType==='credit') debit=s.amount; else credit=s.amount; }
        return { ts:s.ts, date:s.date||'—', type:'تسوية', ref:s.id, debit, credit, notes:s.notes||'—' };
      })
  ].sort((a,b) => new Date(a.ts||0)-new Date(b.ts||0));
  return movements;
}

/* ══════════════════════════════════════════════════════════════
   § 16  تصدير كشف الحساب PDF
══════════════════════════════════════════════════════════════ */
function erpExportStatementPDF(entityType, entityId) {
  const list = entityType==='customer'?(db.customers||[]):(db.suppliers||[]);
  const entity = list.find(x=>x.id===entityId);
  if (!entity) return;
  const movements = _buildEntityMovements(entityType, entityId);
  const balance   = entity.balance||0;
  const stColor   = balance>0?'#e53e3e':balance<0?'#38a169':'#718096';
  const stLabel   = entityType==='customer'?(balance>0?'مدين':'سوي'):(balance>0?'علينا':'سوي');

  let running=0;
  const rows = movements.map((m,i) => {
    running += m.debit - m.credit;
    return `<tr>
      <td>${i+1}</td><td>${m.date}</td><td>${m.type}</td><td>${m.ref||'—'}</td>
      <td style="color:#e53e3e">${m.debit>0?erpFmt(m.debit):'—'}</td>
      <td style="color:#38a169">${m.credit>0?erpFmt(m.credit):'—'}</td>
      <td style="color:${running>0?'#e53e3e':running<0?'#38a169':'#718096'};font-weight:700">${erpFmt(Math.abs(running))}</td>
      <td>${m.notes||'—'}</td>
    </tr>`;
  }).join('');

  const win = window.open('','_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
    <title>كشف حساب — ${entity.name}</title>
    <style>
      body{font-family:Tahoma,Arial,sans-serif;direction:rtl;padding:20px;font-size:12px}
      h2{text-align:center;color:#2d3748;margin-bottom:4px}
      .header{display:flex;justify-content:space-between;background:#f7fafc;padding:12px;border-radius:8px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center}
      th{background:#edf2f7;font-weight:700;color:#2d3748}
      .stats{display:flex;gap:10px;margin-bottom:16px}
      .stat{flex:1;background:#f7fafc;padding:10px;border-radius:6px;text-align:center}
      .stat-val{font-size:1.1rem;font-weight:800;margin-top:4px}
      .bal{font-size:1.3rem;font-weight:900;color:${stColor}}
      tfoot tr{background:#edf2f7;font-weight:700}
    </style></head><body>
    <h2>📄 كشف حساب</h2>
    <div class="header">
      <div><strong>${db.settings?.storeName||'المتجر'}</strong><br><span style="color:#718096">${entity.name} — ${entity.phone||''}</span></div>
      <div style="text-align:left"><span style="color:#718096">تاريخ الكشف: </span><strong>${new Date().toLocaleDateString('ar-EG')}</strong><br>
        <span class="bal">${erpFmt(balance)} (${stLabel})</span>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div>إجمالي المديونية</div><div class="stat-val" style="color:#e53e3e">${erpFmt(movements.reduce((a,m)=>a+m.debit,0))}</div></div>
      <div class="stat"><div>إجمالي التسديدات</div><div class="stat-val" style="color:#38a169">${erpFmt(movements.reduce((a,m)=>a+m.credit,0))}</div></div>
      <div class="stat"><div>الرصيد</div><div class="stat-val" style="color:${stColor}">${erpFmt(balance)}</div></div>
      <div class="stat"><div>عدد الحركات</div><div class="stat-val">${movements.length}</div></div>
    </div>
    <table>
      <thead><tr><th>#</th><th>التاريخ</th><th>البيان</th><th>المرجع</th><th>مدين</th><th>دائن</th><th>الرصيد</th><th>ملاحظات</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="8" style="text-align:center">لا توجد حركات</td></tr>'}</tbody>
      <tfoot><tr><td colspan="4" style="text-align:center">الإجمالي</td>
        <td style="color:#e53e3e">${erpFmt(movements.reduce((a,m)=>a+m.debit,0))}</td>
        <td style="color:#38a169">${erpFmt(movements.reduce((a,m)=>a+m.credit,0))}</td>
        <td colspan="2" style="color:${stColor}">${erpFmt(balance)} ${stLabel}</td>
      </tr></tfoot>
    </table>
    <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),1200);}<\/script>
    </body></html>`);
  win.document.close();
}

/* ══════════════════════════════════════════════════════════════
   § 17  تصدير كشف الحساب Excel (CSV)
══════════════════════════════════════════════════════════════ */
function erpExportStatementExcel(entityType, entityId) {
  const list = entityType==='customer'?(db.customers||[]):(db.suppliers||[]);
  const entity = list.find(x=>x.id===entityId);
  if (!entity) return;
  const movements = _buildEntityMovements(entityType, entityId);

  let running=0;
  const rows = movements.map((m,i) => {
    running += m.debit - m.credit;
    return [i+1, m.date, m.type, m.ref||'', erpFmt(m.debit), erpFmt(m.credit), erpFmt(running), m.notes||''].join(',');
  });

  const header = '#,التاريخ,البيان,المرجع,مدين,دائن,الرصيد,ملاحظات';
  const csv    = '\uFEFF' + [
    `كشف حساب — ${entity.name}`,
    `تاريخ الكشف: ${new Date().toLocaleDateString('ar-EG')}`,
    `الرصيد الحالي: ${erpFmt(entity.balance||0)}`,
    '',
    header,
    ...rows
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `كشف-حساب-${entity.name}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════════════
   § 18  سجل الحركات المالية الشامل — عرض
══════════════════════════════════════════════════════════════ */
function erpRenderFinancialLog() {
  const el = document.getElementById('erp-fin-log-tbody');
  if (!el) return;

  const filter = document.getElementById('erp-log-filter')?.value || '';
  const search = (document.getElementById('erp-log-search')?.value||'').toLowerCase();
  const dFrom  = document.getElementById('erp-log-from')?.value || '';
  const dTo    = document.getElementById('erp-log-to')?.value   || '';

  let rows = [...(db.financialMovements||[])].sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  if (filter) rows = rows.filter(r=>r.category===filter);
  if (dFrom)  rows = rows.filter(r=>(r.ts||'').slice(0,10)>=dFrom);
  if (dTo)    rows = rows.filter(r=>(r.ts||'').slice(0,10)<=dTo);
  if (search) rows = rows.filter(r=>(r.entityName||'').toLowerCase().includes(search)||(r.notes||'').toLowerCase().includes(search)||(r.ref||'').toLowerCase().includes(search));

  if (!rows.length) {
    el.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">لا توجد حركات</td></tr>';
    return;
  }

  const catMap = { sale:'مبيعات', purchase:'مشتريات', payment:'تسديد', return:'مرتجع', expense:'مصروف', treasury:'خزنة', settlement:'تسوية', withdrawal:'سحب نقدي' };
  el.innerHTML = rows.slice(0,200).map((m,i) => `<tr>
    <td style="color:var(--text-muted)">${i+1}</td>
    <td><span style="background:var(--accent-blue)15;color:var(--accent-blue);padding:2px 7px;border-radius:12px;font-size:0.75rem">${catMap[m.category]||m.category}</span></td>
    <td style="font-weight:600">${m.entityName||'—'}</td>
    <td><span style="color:${m.type==='debit'?'var(--accent-red)':'var(--accent-green)'}">
      ${m.type==='debit'?'↑ مدين':'↓ دائن'}</span></td>
    <td style="font-weight:700">${erpCurr(m.amount)}</td>
    <td style="font-size:0.78rem">${m.date||erpDate(m.ts)}</td>
    <td style="font-size:0.75rem;color:var(--text-muted)">${m.userId||'—'}</td>
    <td style="font-size:0.75rem;color:var(--text-muted)">${m.notes||m.ref||'—'}</td>
  </tr>`).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 19  تقارير ديناميكية موسّعة
══════════════════════════════════════════════════════════════ */
function erpRenderExtendedReports() {
  const period = document.getElementById('erp-report-period')?.value || 'month';
  const now    = new Date();
  let fromDate, toDate = now;

  switch(period) {
    case 'today':  fromDate = new Date(now.toDateString()); break;
    case 'week':   fromDate = new Date(now - 7*86400000);   break;
    case 'month':  fromDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'year':   fromDate = new Date(now.getFullYear(), 0, 1); break;
    default:       fromDate = new Date(0);
  }

  const inRange = ts => { const d = new Date(ts||0); return d >= fromDate && d <= toDate; };

  const sales     = (db.sales||[]).filter(s=>inRange(s.ts||s.date));
  const purchases = (db.purchases||[]).filter(p=>inRange(p.ts||p.date));
  const payments  = (db.payments||[]).filter(p=>inRange(p.ts));
  const expenses  = (db.expenses||[]).filter(e=>inRange(e.ts||e.date));

  const totalSales    = sales.reduce((a,s)=>a+(s.total||0),0);
  const totalPurch    = purchases.reduce((a,p)=>a+(p.total||0),0);
  const totalPaid     = payments.filter(p=>p.type==='customer').reduce((a,p)=>a+(p.amount||0),0);
  const totalSupPaid  = payments.filter(p=>p.type==='supplier').reduce((a,p)=>a+(p.amount||0),0);
  const totalExp      = expenses.reduce((a,e)=>a+(e.amount||0),0);
  const cogs          = sales.reduce((a,s)=>a+((s.items||[]).reduce((b,i)=>b+(i.cost||0)*(i.qty||1),0)),0);
  const grossP        = totalSales - cogs;
  const netP          = grossP - totalExp;

  // ديون العملاء المدينون مرتبة
  const debtors = [...(db.customers||[])].filter(c=>(c.balance||0)>0).sort((a,b)=>(b.balance||0)-(a.balance||0));
  const creditors = [...(db.suppliers||[])].filter(s=>(s.balance||0)>0).sort((a,b)=>(b.balance||0)-(a.balance||0));

  // ملخص للعرض
  _erpTxt('erp-rep-sales',        erpCurr(totalSales));
  _erpTxt('erp-rep-purchases',    erpCurr(totalPurch));
  _erpTxt('erp-rep-collected',    erpCurr(totalPaid));
  _erpTxt('erp-rep-sup-paid',     erpCurr(totalSupPaid));
  _erpTxt('erp-rep-expenses',     erpCurr(totalExp));
  _erpTxt('erp-rep-gross',        erpCurr(grossP));
  _erpTxt('erp-rep-net',          erpCurr(netP));
  _erpTxt('erp-rep-margin',       grossP>0?(grossP/totalSales*100).toFixed(1)+'%':'0%');

  // جدول كبار المدينين
  const debtEl = document.getElementById('erp-rep-debtors-tbody');
  if (debtEl) {
    debtEl.innerHTML = debtors.slice(0,10).map((c,i) => {
      const lastSale = [...(db.sales||[])].filter(s=>s.customerId===c.id&&s.payment==='آجل').sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
      const daysSince = lastSale ? Math.floor((Date.now()-new Date(lastSale.ts||lastSale.date))/86400000) : 0;
      return `<tr>
        <td>${i+1}</td>
        <td style="font-weight:600">${c.name}</td>
        <td>${c.phone||'—'}</td>
        <td style="color:var(--accent-red);font-weight:700">${erpCurr(c.balance)}</td>
        <td>${lastSale?erpDate(lastSale.ts||lastSale.date):'—'}</td>
        <td style="color:${daysSince>30?'var(--accent-red)':'var(--text-muted)'}">${daysSince?daysSince+' يوم':'—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="erpOpenEnhancedStatement('customer','${c.id}')"><i class="fa fa-file-invoice"></i></button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center">لا يوجد مدينون</td></tr>';
  }

  // جدول موردين مستحقين
  const credEl = document.getElementById('erp-rep-creditors-tbody');
  if (credEl) {
    credEl.innerHTML = creditors.slice(0,10).map((s,i) => {
      const lastPurch = [...(db.purchases||[])].filter(p=>p.supplierId===s.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
      return `<tr>
        <td>${i+1}</td>
        <td style="font-weight:600">${s.name}</td>
        <td>${s.phone||'—'}</td>
        <td style="color:var(--accent-orange);font-weight:700">${erpCurr(s.balance)}</td>
        <td>${lastPurch?erpDate(lastPurch.ts||lastPurch.date):'—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="erpOpenEnhancedStatement('supplier','${s.id}')"><i class="fa fa-file-invoice"></i></button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center">لا توجد مستحقات</td></tr>';
  }

  // التدفقات النقدية اليومية (7 أيام)
  erpRenderCashFlowChart(fromDate, toDate);
}

function erpRenderCashFlowChart(fromDate, toDate) {
  const el = document.getElementById('erp-cashflow-chart');
  if (!el) return;

  // تجميع يومي
  const days = [];
  const cur = new Date(fromDate);
  while (cur <= toDate && days.length < 30) {
    const ds = cur.toDateString();
    const salesAmt = (db.sales||[]).filter(s=>new Date(s.ts||s.date).toDateString()===ds&&s.payment!=='آجل').reduce((a,s)=>a+(s.total||0),0);
    const purchAmt = (db.purchases||[]).filter(p=>new Date(p.ts||p.date).toDateString()===ds&&p.payment!=='آجل').reduce((a,p)=>a+(p.total||0),0);
    const payIn    = (db.payments||[]).filter(p=>new Date(p.ts).toDateString()===ds&&p.type==='customer').reduce((a,p)=>a+(p.amount||0),0);
    const payOut   = (db.payments||[]).filter(p=>new Date(p.ts).toDateString()===ds&&p.type==='supplier').reduce((a,p)=>a+(p.amount||0),0);
    days.push({ label: cur.toLocaleDateString('ar-EG',{day:'numeric',month:'short'}), inflow: salesAmt+payIn, outflow: purchAmt+payOut });
    cur.setDate(cur.getDate()+1);
  }

  if (!days.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">لا توجد بيانات</div>'; return; }

  const maxVal = Math.max(...days.map(d=>Math.max(d.inflow,d.outflow)),1);
  const W=760, H=160, PAD=30, barW=Math.min(16, (W-PAD*2)/days.length/2-2);
  const gap = (W-PAD*2)/days.length;

  const bars = days.map((d,i) => {
    const x  = PAD + i*gap;
    const ih = (d.inflow/maxVal)*(H-20);
    const oh = (d.outflow/maxVal)*(H-20);
    return `
      <rect x="${x}"        y="${H-ih}" width="${barW}" height="${ih}" fill="var(--accent-green)" rx="2" opacity="0.8"/>
      <rect x="${x+barW+1}" y="${H-oh}" width="${barW}" height="${oh}" fill="var(--accent-red)"   rx="2" opacity="0.8"/>
      ${days.length<=14?`<text x="${x+barW}" y="${H+14}" text-anchor="middle" fill="var(--text-muted)" font-size="8">${d.label}</text>`:''}`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H+20}" style="width:100%;height:160px">
      <line x1="${PAD}" y1="${H}" x2="${W-10}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
      ${bars}
      <rect x="${W-120}" y="5"  width="10" height="10" fill="var(--accent-green)" rx="1"/>
      <text x="${W-107}" y="13" fill="var(--text-muted)" font-size="10">تدفقات داخلة</text>
      <rect x="${W-120}" y="20" width="10" height="10" fill="var(--accent-red)"   rx="1"/>
      <text x="${W-107}" y="28" fill="var(--text-muted)" font-size="10">تدفقات خارجة</text>
    </svg>`;
}

/* ══════════════════════════════════════════════════════════════
   § 20  حقن صفحة لوحة التحكم المالية في DOM
══════════════════════════════════════════════════════════════ */
function erpInjectFinancialDashboardPage() {
  if (document.getElementById('page-financial')) return;

  const html = `
  <div class="page" id="page-financial" style="display:none">
    <div class="page-header">
      <div>
        <div class="page-title"><div class="title-icon">💹</div> لوحة التحكم المالية</div>
        <div class="page-subtitle">نظرة شاملة لحظية على الوضع المالي</div>
      </div>
      <div class="btn-group">
        <select id="erp-report-period" class="form-select" style="width:140px" onchange="erpRenderExtendedReports()">
          <option value="today">اليوم</option>
          <option value="week">هذا الأسبوع</option>
          <option value="month" selected>هذا الشهر</option>
          <option value="year">هذا العام</option>
          <option value="all">كل الوقت</option>
        </select>
        <button class="btn btn-ghost" onclick="erpRefreshFinancialDashboard();erpRenderExtendedReports()">
          <i class="fa fa-sync"></i> تحديث
        </button>
      </div>
    </div>

    <!-- بطاقات الإحصاء الرئيسية -->
    <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-label">مبيعات اليوم</div>
        <div class="stat-value green" id="erp-today-sales">0.00</div>
        <div style="font-size:0.72rem;color:var(--text-muted)" id="erp-sales-growth">—</div>
        <div class="stat-icon">📈</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">مبيعات الشهر</div>
        <div class="stat-value blue" id="erp-month-sales">0.00</div>
        <div class="stat-icon">📅</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">مشتريات الشهر</div>
        <div class="stat-value orange" id="erp-month-purchases">0.00</div>
        <div class="stat-icon">🛒</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">رصيد الخزنة</div>
        <div class="stat-value purple" id="erp-cash-balance">0.00</div>
        <div class="stat-icon">💵</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">رصيد البنك</div>
        <div class="stat-value" id="erp-bank-balance">0.00</div>
        <div class="stat-icon">🏦</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">ديون العملاء</div>
        <div class="stat-value red" id="erp-cust-debt">0.00</div>
        <div class="stat-icon">👥</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">مستحقات الموردين</div>
        <div class="stat-value orange" id="erp-sup-debt">0.00</div>
        <div class="stat-icon">🏭</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">صافي الربح الإجمالي</div>
        <div class="stat-value green" id="erp-gross-profit">0.00</div>
        <div class="stat-icon">💰</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">صافي الربح النهائي</div>
        <div class="stat-value green" id="erp-net-profit">0.00</div>
        <div class="stat-icon">✅</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">صافي السيولة</div>
        <div class="stat-value" id="erp-net-liquidity">0.00</div>
        <div class="stat-icon">💧</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">تحصيلات اليوم</div>
        <div class="stat-value blue" id="erp-today-collected">0.00</div>
        <div class="stat-icon">💳</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">فواتير معلقة</div>
        <div class="stat-value red" id="erp-pending-sales">0</div>
        <div class="stat-icon">⏳</div>
      </div>
    </div>

    <!-- رسوم بيانية -->
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">📊 المبيعات والمشتريات (12 شهر)</div>
        </div>
        <div id="erp-monthly-chart"></div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">🥧 توزيع الديون</div>
        </div>
        <div id="erp-debt-chart"></div>
      </div>
    </div>

    <!-- تقارير الفترة المختارة -->
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">💹 ملخص الفترة</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px">
          ${[
            ['إجمالي المبيعات','erp-rep-sales','var(--accent-green)'],
            ['إجمالي المشتريات','erp-rep-purchases','var(--accent-orange)'],
            ['تحصيلات العملاء','erp-rep-collected','var(--accent-blue)'],
            ['مدفوعات الموردين','erp-rep-sup-paid','var(--accent-purple)'],
            ['إجمالي المصروفات','erp-rep-expenses','var(--accent-red)'],
            ['إجمالي الربح','erp-rep-gross','var(--accent-green)'],
            ['صافي الربح','erp-rep-net','var(--accent-green)'],
            ['هامش الربح %','erp-rep-margin','var(--accent-blue)']
          ].map(([label,id,color])=>`
            <div style="background:var(--bg3);border-radius:8px;padding:10px">
              <div style="font-size:0.72rem;color:var(--text-muted)">${label}</div>
              <div id="${id}" style="font-weight:800;color:${color};margin-top:2px">—</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">📉 التدفقات النقدية اليومية</div>
        </div>
        <div id="erp-cashflow-chart"></div>
      </div>
    </div>

    <!-- جداول التقارير -->
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">🔴 كبار المدينين</div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>#</th><th>العميل</th><th>الهاتف</th><th style="color:var(--accent-red)">المديونية</th><th>آخر فاتورة</th><th>منذ</th><th>كشف</th></tr></thead>
            <tbody id="erp-rep-debtors-tbody"></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <div class="card-title">🟠 مستحقات الموردين</div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>#</th><th>المورد</th><th>الهاتف</th><th style="color:var(--accent-orange)">المستحق</th><th>آخر فاتورة</th><th>كشف</th></tr></thead>
            <tbody id="erp-rep-creditors-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- التنبيهات الذكية -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header-row">
        <div class="card-title">🔔 التنبيهات الذكية</div>
        <button class="btn btn-ghost btn-sm" onclick="erpCheckAlerts()"><i class="fa fa-sync"></i> تحديث</button>
      </div>
      <div id="erp-smart-alerts"><div style="text-align:center;color:var(--text-muted);padding:12px">جارٍ التحقق...</div></div>
    </div>

    <!-- سجل الحركات المالية -->
    <div class="card">
      <div class="card-header-row">
        <div class="card-title">📋 سجل الحركات المالية الشامل</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="erp-log-filter" class="form-select" style="width:140px" onchange="erpRenderFinancialLog()">
            <option value="">كل الحركات</option>
            <option value="sale">مبيعات</option>
            <option value="purchase">مشتريات</option>
            <option value="payment">تسديدات</option>
            <option value="expense">مصروفات</option>
            <option value="treasury">خزنة</option>
            <option value="withdrawal">سحب نقدي</option>
            <option value="settlement">تسويات</option>
          </select>
          <input type="date" id="erp-log-from" class="form-control" style="width:140px" onchange="erpRenderFinancialLog()">
          <input type="date" id="erp-log-to"   class="form-control" style="width:140px" onchange="erpRenderFinancialLog()">
          <div class="search-box" style="width:200px">
            <i class="fa fa-search search-icon"></i>
            <input type="text" id="erp-log-search" class="form-control" placeholder="بحث..." oninput="erpRenderFinancialLog()">
          </div>
          <button class="btn btn-ghost btn-sm" onclick="erpExportFinancialLog()"><i class="fa fa-download"></i> Excel</button>
        </div>
      </div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>#</th><th>الفئة</th><th>الجهة</th><th>النوع</th><th>المبلغ</th><th>التاريخ</th><th>المستخدم</th><th>ملاحظات</th></tr></thead>
          <tbody id="erp-fin-log-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  // حقن قبل نهاية body
  document.body.insertAdjacentHTML('beforeend', html);
}

/* ══════════════════════════════════════════════════════════════
   § 21  تصدير سجل الحركات Excel
══════════════════════════════════════════════════════════════ */
function erpExportFinancialLog() {
  const rows = (db.financialMovements||[]).map((m,i) => [
    i+1, m.category||'', m.entityName||'', m.type||'', erpFmt(m.amount), m.date||erpDate(m.ts), m.userId||'', (m.notes||m.ref||'').replace(/,/g,' ')
  ].join(','));
  const csv = '\uFEFF' + ['#,الفئة,الجهة,النوع,المبلغ,التاريخ,المستخدم,ملاحظات', ...rows].join('\n');
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=`سجل-الحركات-المالية-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════════════
   § 22  ربط التنقل للوحة المالية
══════════════════════════════════════════════════════════════ */
function erpRegisterNavigation() {
  const _origNav = window.navigate;
  if (!_origNav || window._erpNavPatched) return;
  window._erpNavPatched = true;

  window.navigate = function(page) {
    _origNav.apply(this, arguments);
    if (page === 'financial') {
      setTimeout(() => {
        erpUpgradeDB();
        erpRefreshFinancialDashboard();
        erpRenderExtendedReports();
        erpCheckAlerts();
        erpRenderFinancialLog();
      }, 80);
    }
    // تحديث الداشبورد الرئيسي عند الزيارة
    if (page === 'home') {
      setTimeout(() => erpCheckAlerts(), 200);
    }
  };
}

/* ══════════════════════════════════════════════════════════════
   § 23  إضافة زر "لوحة مالية" في الشريط الجانبي
══════════════════════════════════════════════════════════════ */
function erpInjectNavButton() {
  if (document.getElementById('nav-financial-btn')) return;

  // إيجاد زر التقارير في الشريط الجانبي
  const navItems = document.querySelectorAll('.nav-item, .sidebar-item, [onclick*="navigate(\'reports\')"]');
  if (!navItems.length) return;

  const reportsBtn = [...navItems].find(el => el.textContent.includes('تقارير') || el.getAttribute('onclick')?.includes('reports'));
  if (!reportsBtn) return;

  const btn = document.createElement('div');
  btn.id = 'nav-financial-btn';
  btn.className = reportsBtn.className;
  btn.setAttribute('onclick', "navigate('financial')");
  btn.innerHTML = reportsBtn.innerHTML
    .replace(/تقارير/g, 'لوحة مالية')
    .replace(/📈|fa-chart-bar|fa-bar-chart/g, match =>
      match.startsWith('📈') ? '💹' : match.includes('fa-') ? 'fa fa-coins' : match
    );
  if (!btn.textContent.includes('مالية')) {
    btn.innerHTML = `<i class="fa fa-coins" style="font-size:1.2rem"></i><span>لوحة مالية</span>`;
  }
  btn.style.cssText = reportsBtn.style.cssText;

  reportsBtn.parentNode.insertBefore(btn, reportsBtn.nextSibling);
}

/* ══════════════════════════════════════════════════════════════
   § 24  Patch openBalStatement لاستخدام النسخة المحسّنة
══════════════════════════════════════════════════════════════ */
function erpPatchStatements() {
  if (window._erpStmtPatched) return;
  window._erpStmtPatched = true;
  // استبدال الدالة الأصلية بالنسخة المحسّنة التي تعرض المدفوع/المتبقي/التسويات
  window.openBalStatement = erpOpenEnhancedStatement;
  // Override printStatement في balances.js أيضاً
  window.printStatement = function(entityType, entityId) {
    erpExportStatementPDF(entityType, entityId);
  };
}

/* ══════════════════════════════════════════════════════════════
   § 25  Patch Alerts الرئيسية (renderAlerts في app.js)
══════════════════════════════════════════════════════════════ */
function erpPatchMainAlerts() {
  const _origAlerts = window.renderAlerts;
  if (!_origAlerts || window._erpAlertsPatched) return;
  window._erpAlertsPatched = true;
  window.renderAlerts = function() {
    _origAlerts.apply(this, arguments);
    // إضافة تنبيهات ERP للتنبيهات الرئيسية في الداشبورد
    setTimeout(erpCheckAlerts, 100);
  };
}

/* ══════════════════════════════════════════════════════════════
   § 26  تحديث حالة الفاتورة عند سداد من صفحة الأرصدة
══════════════════════════════════════════════════════════════ */
function erpSyncPaymentToInvoice(entityType, entityId, paidAmount) {
  // عند سداد عميل: تحديث الفواتير الأقدم أولاً
  const invoices = entityType === 'customer'
    ? (db.sales||[]).filter(s=>s.customerId===entityId&&(s.payStatus==='unpaid'||s.payStatus==='partial'))
    : (db.purchases||[]).filter(p=>p.supplierId===entityId&&(p.payStatus==='unpaid'||p.payStatus==='partial'));

  invoices.sort((a,b)=>new Date(a.ts||a.date)-new Date(b.ts||b.date));

  let remaining = paidAmount;
  invoices.forEach(inv => {
    if (remaining <= 0) return;
    const toApply = Math.min(remaining, inv.remaining||0);
    inv.paidAmount = (inv.paidAmount||0) + toApply;
    inv.remaining  = Math.max(0, (inv.remaining||0) - toApply);
    inv.payStatus  = calcPayStatus(inv.total, inv.paidAmount);
    remaining -= toApply;
  });

  erpLogMovement({
    category: 'payment',
    type: 'credit',
    entityId, entityName: '', entityType,
    amount: paidAmount,
    ref: '',
    notes: entityType==='customer' ? 'تسديد عميل' : 'دفع مورد'
  });
}

function erpPatchPaymentFunctions() {
  const _origCust = window.confirmCustomerPayment;
  if (_origCust && !window._erpCustPayPatched) {
    window._erpCustPayPatched = true;
    window.confirmCustomerPayment = function() {
      const entityId = document.getElementById('pay-customer-id')?.value || '';
      const amount   = parseFloat(document.getElementById('pay-customer-amount')?.value || 0);
      _origCust.apply(this, arguments);
      if (entityId && amount > 0) {
        erpSyncPaymentToInvoice('customer', entityId, amount);
        saveDB();
        erpRefreshFinancialDashboard();
        erpCheckAlerts();
      }
    };
  }

  const _origSup = window.confirmSupplierPayment;
  if (_origSup && !window._erpSupPayPatched) {
    window._erpSupPayPatched = true;
    window.confirmSupplierPayment = function() {
      const entityId = document.getElementById('pay-supplier-id')?.value || '';
      const amount   = parseFloat(document.getElementById('pay-supplier-amount')?.value || 0);
      _origSup.apply(this, arguments);
      if (entityId && amount > 0) {
        erpSyncPaymentToInvoice('supplier', entityId, amount);
        saveDB();
        erpRefreshFinancialDashboard();
        erpCheckAlerts();
      }
    };
  }
}

/* ══════════════════════════════════════════════════════════════
   § 27  تهيئة كاملة
══════════════════════════════════════════════════════════════ */
function erpInit() {
  erpUpgradeDB();
  erpInjectFinancialDashboardPage();
  setTimeout(() => {
    erpPatchStatements();
    erpPatchMainAlerts();
    erpPatchSaleCheckout();
    erpPatchPurchase();
    erpPatchWholesale();
    erpPatchPaymentFunctions();
    erpInjectInvoiceFields();
    erpRefreshFinancialDashboard();
    erpCheckAlerts();
    console.log('✅ ERP Core initialized');
  }, 900);

  // ربط calcChange الأصلي مع erpUpdatePosRemaining
  const _origCalcChange = window.calcChange;
  if (_origCalcChange && !window._erpCalcPatched) {
    window._erpCalcPatched = true;
    window.calcChange = function() {
      if (_origCalcChange) _origCalcChange.apply(this, arguments);
      erpUpdatePosRemaining();
    };
  }
  // ربط calcWholesaleChange مع erpUpdateWsRemaining
  const _origCalcWs = window.calcWholesaleChange;
  if (_origCalcWs && !window._erpCalcWsPatched) {
    window._erpCalcWsPatched = true;
    window.calcWholesaleChange = function() {
      if (_origCalcWs) _origCalcWs.apply(this, arguments);
      erpUpdateWsRemaining();
    };
  }

  // تحديث دوري كل 3 دقائق
  setInterval(() => {
    erpRefreshFinancialDashboard();
    erpCheckAlerts();
  }, 3 * 60 * 1000);
}

/* ══════════════════════════════════════════════════════════════
   § 28  تعريض الدوال عالمياً
══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   § 29  تعديل رصيد البنك
══════════════════════════════════════════════════════════════ */
function erpEditBankBalance() {
  const cur = db.bankBalance || 0;
  const val = prompt('رصيد البنك الحالي: ' + cur.toFixed(2) + '\nأدخل الرصيد الجديد:', cur.toFixed(2));
  if (val === null) return;
  const newVal = parseFloat(val) || 0;
  db.bankBalance = newVal;
  saveDB();
  const el = document.getElementById('treasury-bank-balance');
  if (el) el.textContent = erpCurr(newVal);
  const nlEl = document.getElementById('treasury-net-liquidity');
  if (nlEl) {
    const income  = (db.treasury||[]).filter(t=>t.type==='إيراد').reduce((a,t)=>a+(t.amount||0),0);
    const expense = (db.treasury||[]).filter(t=>t.type==='مصروف').reduce((a,t)=>a+(t.amount||0),0);
    nlEl.textContent = erpCurr(income - expense + newVal);
  }
  erpRefreshFinancialDashboard();
  if (typeof showToast === 'function') showToast('تم تحديث رصيد البنك ✅', 'success');
}

document.addEventListener('DOMContentLoaded', () => setTimeout(erpInit, 1000));

Object.assign(window, {
  erpInit,
  erpRefreshFinancialDashboard,
  erpRenderExtendedReports,
  erpRenderFinancialLog,
  erpCheckAlerts,
  erpOpenEnhancedStatement,
  erpExportStatementPDF,
  erpExportStatementExcel,
  erpExportFinancialLog,
  erpBuildInvoiceSummaryHTML,
  erpUpdatePosRemaining,
  erpUpdatePurRemaining,
  erpUpdateWsRemaining,
  erpGetFinancialSummary,
  erpSyncPaymentToInvoice,
  erpEditBankBalance
});
