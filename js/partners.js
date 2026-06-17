/* =====================================================================
   HASSIBNI — وحدة حسابات الشركاء  v3.0  (Smart Treasury Edition)
   ✅ السحب يتم من الخزنة مباشرة — لا قيد على رصيد الشريك
   ✅ التحقق فقط من رصيد الخزنة قبل السحب (الذكي)
   ✅ تحذير ذكي بدون إيقاف: رصيد الشريك سالب = سحب سلفة
   ✅ سجل تدقيق (Audit Log) لكل عملية
   ✅ حركات موحدة مسجلة في db.treasury تلقائياً
   ✅ معاينة حية للرصيد قبل التنفيذ
   ✅ تقارير PDF متكاملة
   ✅ بحث + تصفية + ترقيم صفحات
   ✅ تصنيف نوع السحب (سلفة / توزيع أرباح / مصروف شريك)
   ===================================================================== */

'use strict';

/* ══════════════════════════════════════════════════════════════
   § 1  تهيئة قاعدة البيانات
══════════════════════════════════════════════════════════════ */
function upgradePartnersDB() {
  let ch = false;
  if (!db.partners)            { db.partners = [];            ch = true; }
  if (!db.partnerTransactions) { db.partnerTransactions = []; ch = true; }
  if (!db.partnerAuditLog)     { db.partnerAuditLog = [];     ch = true; }
  if (ch) saveDB();
}

/* ══════════════════════════════════════════════════════════════
   § 2  مساعدات
══════════════════════════════════════════════════════════════ */
const ptFmt  = v => parseFloat(v || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ptUID  = () => 'pt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const ptNow  = () => new Date().toISOString();
const ptCur  = () => (typeof db !== 'undefined' && db.settings?.currency) ? db.settings.currency : 'ر.س';
const ptUser = () => (typeof currentUser !== 'undefined' && currentUser?.name) ? currentUser.name : '—';

/* ─── حساب رصيد الخزنة الصافي من db.treasury ─── */
function getTreasuryBalance() {
  const list = db.treasury || [];
  const income      = list.filter(t => t.type === 'إيراد').reduce((a, t) => a + (t.amount || 0), 0);
  const expense     = list.filter(t => t.type === 'مصروف').reduce((a, t) => a + (t.amount || 0), 0);
  const withdrawals = list.filter(t => t.type === 'سحب').reduce((a, t) => a + (t.amount || 0), 0);
  return income - expense - withdrawals;
}

/* ─── توليد كود شريك تلقائي ─── */
function generatePartnerCode() {
  const nums = (db.partners || []).map(p => parseInt((p.code || '').replace('SH', '')) || 0);
  return 'SH' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0');
}

/* ─── رصيد الشريك (صافي إيداعاته - سحوباته) ─── */
function getPartnerBalance(partnerId) {
  return (db.partnerTransactions || [])
    .filter(t => t.partnerId === partnerId)
    .reduce((sum, t) => t.type === 'deposit' ? sum + t.amount : sum - t.amount, 0);
}

/* ─── إحصائيات شامل للشريك ─── */
function getPartnerStats(partnerId) {
  const txs         = (db.partnerTransactions || []).filter(t => t.partnerId === partnerId);
  const deposits    = txs.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0);
  const withdrawals = txs.filter(t => t.type === 'withdraw').reduce((s, t) => s + t.amount, 0);
  const last        = [...txs].sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  return { balance: deposits - withdrawals, deposits, withdrawals, count: txs.length, lastTx: last?.ts || null };
}

/* ─── إعادة حساب الأرصدة التراكمية ─── */
function recalcPartnerBalances(partnerId) {
  const txs = (db.partnerTransactions || [])
    .filter(t => t.partnerId === partnerId)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  let running = 0;
  txs.forEach(t => {
    running = t.type === 'deposit' ? running + t.amount : running - t.amount;
    t.balanceAfter = running;
  });
  saveDB();
}

/* ─── سجل التدقيق ─── */
function ptAudit(action, entity, data = {}) {
  if (!db.partnerAuditLog) db.partnerAuditLog = [];
  db.partnerAuditLog.push({ id: ptUID(), ts: ptNow(), user: ptUser(), action, entity, ...data });
}

/* ─── تسجيل حركة الخزنة ─── */
function ptPushTreasury(type, desc, amount, partnerName, txId, category) {
  if (!db.treasury) db.treasury = [];
  const entry = {
    id:          (typeof uid === 'function') ? uid() : ptUID(),
    type,
    desc,
    amount,
    date:        new Date().toLocaleDateString('ar-EG'),
    ts:          ptNow(),
    source:      'partners',
    partnerName,
    partnerTxId: txId,
    category:    category || ''
  };
  db.treasury.push(entry);
  return entry.id;
}

/* ══════════════════════════════════════════════════════════════
   § 3  الرندر الرئيسي
══════════════════════════════════════════════════════════════ */
let _currentPartnerId = null;
let _ptPage = 1;
const PT_PAGE_SIZE = 15;

function renderPartnersPage() {
  upgradePartnersDB();
  renderPartnersStats();
  renderPartnersList();
  _currentPartnerId = null;
  const detail = document.getElementById('partner-detail-section');
  if (detail) detail.style.display = 'none';
}

function renderPartnersStats() {
  const txs              = db.partnerTransactions || [];
  const totalDeposits    = txs.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0);
  const totalWithdrawals = txs.filter(t => t.type === 'withdraw').reduce((s, t) => s + t.amount, 0);
  const treasuryBal      = getTreasuryBalance();
  const lastTx           = [...txs].sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  const cur              = ptCur();

  const s = id => document.getElementById(id);
  if (s('pt-treasury-balance'))  s('pt-treasury-balance').textContent  = ptFmt(treasuryBal) + ' ' + cur;
  if (s('pt-total-balance'))     s('pt-total-balance').textContent     = ptFmt(totalDeposits - totalWithdrawals) + ' ' + cur;
  if (s('pt-total-deposits'))    s('pt-total-deposits').textContent    = ptFmt(totalDeposits) + ' ' + cur;
  if (s('pt-total-withdrawals')) s('pt-total-withdrawals').textContent = ptFmt(totalWithdrawals) + ' ' + cur;
  if (s('pt-partners-count'))    s('pt-partners-count').textContent    = (db.partners || []).length;
  if (s('pt-tx-count'))          s('pt-tx-count').textContent          = txs.length;
  if (s('pt-last-tx-time'))      s('pt-last-tx-time').textContent      = lastTx ? new Date(lastTx.ts).toLocaleDateString('ar-EG') : '—';

  const treasuryCard = s('pt-treasury-balance');
  if (treasuryCard) {
    treasuryCard.style.color = treasuryBal > 0 ? 'var(--accent-green)' : treasuryBal < 0 ? 'var(--accent-red)' : 'var(--text-muted)';
  }
}

function renderPartnersList() {
  const q       = (document.getElementById('partners-search')?.value || '').toLowerCase();
  const partners = (db.partners || []).filter(p =>
    !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || (p.phone || '').includes(q)
  );
  const cur   = ptCur();
  const tbody = document.getElementById('partners-tbody');
  if (!tbody) return;

  if (!partners.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted)">لا يوجد شركاء — أضف شريكاً جديداً</td></tr>`;
    return;
  }

  tbody.innerHTML = partners.map(p => {
    const stats    = getPartnerStats(p.id);
    const lastDate = stats.lastTx ? new Date(stats.lastTx).toLocaleDateString('ar-EG') : '—';
    const balColor = stats.balance >= 0 ? 'var(--accent-green)' : 'var(--accent-orange)';
    const balNote  = stats.balance < 0 ? ' (سلفة)' : '';
    return `<tr>
      <td><span style="background:var(--accent-blue)22;color:var(--accent-blue);padding:2px 8px;border-radius:20px;font-size:0.8rem;font-weight:700">${p.code}</span></td>
      <td style="font-weight:600">${p.name}</td>
      <td>${p.phone || '—'}</td>
      <td style="font-weight:800;color:${balColor}">${ptFmt(stats.balance)} ${cur}${balNote}</td>
      <td style="color:var(--accent-green)">${ptFmt(stats.deposits)} ${cur}</td>
      <td style="color:var(--accent-red)">${ptFmt(stats.withdrawals)} ${cur}</td>
      <td style="color:var(--text-muted)">${stats.count}</td>
      <td style="color:var(--text-muted);font-size:0.82rem">${lastDate}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="openPartnerDetail('${p.id}')" title="كشف الحساب"><i class="fa fa-eye"></i></button>
          <button class="btn btn-success btn-sm" onclick="openPartnerTransactionModal('deposit','${p.id}')" title="إيداع"><i class="fa fa-arrow-down"></i></button>
          <button class="btn btn-danger btn-sm" onclick="openPartnerTransactionModal('withdraw','${p.id}')" title="سحب من الخزنة"><i class="fa fa-arrow-up"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="openEditPartnerModal('${p.id}')" title="تعديل"><i class="fa fa-pen"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="deletePartner('${p.id}')" style="color:var(--accent-red)" title="حذف"><i class="fa fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   § 4  تفاصيل الشريك
══════════════════════════════════════════════════════════════ */
function openPartnerDetail(partnerId) {
  _currentPartnerId = partnerId;
  _ptPage = 1;
  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) return;
  const stats = getPartnerStats(partnerId);
  const cur   = ptCur();

  document.getElementById('pd-partner-name').textContent = p.name;
  document.getElementById('pd-partner-code').textContent = p.code + (p.phone ? ' | ' + p.phone : '');
  document.getElementById('pd-balance').textContent           = ptFmt(stats.balance) + ' ' + cur + (stats.balance < 0 ? ' (سلفة)' : '');
  document.getElementById('pd-total-deposits').textContent    = ptFmt(stats.deposits) + ' ' + cur;
  document.getElementById('pd-total-withdrawals').textContent = ptFmt(stats.withdrawals) + ' ' + cur;
  document.getElementById('pd-tx-count').textContent          = stats.count;
  document.getElementById('pd-last-tx').textContent           = stats.lastTx ? new Date(stats.lastTx).toLocaleDateString('ar-EG') : '—';

  const balEl = document.getElementById('pd-balance');
  if (balEl) balEl.style.color = stats.balance >= 0 ? 'var(--accent-green)' : 'var(--accent-orange)';

  const detailSection = document.getElementById('partner-detail-section');
  if (detailSection) {
    detailSection.style.display = '';
    detailSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  renderPartnerTransactions();
}

function closePartnerDetail() {
  _currentPartnerId = null;
  const d = document.getElementById('partner-detail-section');
  if (d) d.style.display = 'none';
}

function renderPartnerTransactions() {
  if (!_currentPartnerId) return;
  const typeFilter = document.getElementById('pd-type-filter')?.value  || '';
  const fromDate   = document.getElementById('pd-date-from')?.value    || '';
  const toDate     = document.getElementById('pd-date-to')?.value      || '';
  const notesQ     = (document.getElementById('pd-notes-search')?.value || '').toLowerCase();

  let txs = (db.partnerTransactions || [])
    .filter(t => t.partnerId === _currentPartnerId)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  if (typeFilter) txs = txs.filter(t => t.type === typeFilter);
  if (fromDate)   txs = txs.filter(t => t.ts >= fromDate);
  if (toDate)     txs = txs.filter(t => t.ts <= toDate + 'T23:59:59');
  if (notesQ)     txs = txs.filter(t => (t.notes || '').toLowerCase().includes(notesQ));

  const pages   = Math.ceil(txs.length / PT_PAGE_SIZE) || 1;
  if (_ptPage > pages) _ptPage = pages;
  const start   = (_ptPage - 1) * PT_PAGE_SIZE;
  const pageTxs = txs.slice(start, start + PT_PAGE_SIZE);
  const cur     = ptCur();

  const tbody = document.getElementById('pd-tx-tbody');
  if (!tbody) return;

  const categoryLabel = { advance: '💳 سلفة', profit: '📊 أرباح', expense: '🧾 مصروف', deposit_capital: '🏦 رأس مال', '' : '' };

  tbody.innerHTML = pageTxs.length ? pageTxs.map((t, i) => {
    const isDep    = t.type === 'deposit';
    const typeHtml = isDep
      ? `<span style="background:var(--accent-green)22;color:var(--accent-green);padding:2px 10px;border-radius:20px;font-size:0.8rem;font-weight:700">💰 إيداع</span>`
      : `<span style="background:var(--accent-red)22;color:var(--accent-red);padding:2px 10px;border-radius:20px;font-size:0.8rem;font-weight:700">💸 سحب</span>`;
    const balColor = (t.balanceAfter || 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-orange)';
    const catLabel = categoryLabel[t.category || ''] || '';
    return `<tr>
      <td style="color:var(--text-muted)">${start + i + 1}</td>
      <td>${typeHtml}${catLabel ? `<br><small style="color:var(--text-muted)">${catLabel}</small>` : ''}</td>
      <td style="font-weight:700;color:${isDep ? 'var(--accent-green)' : 'var(--accent-red)'}">
        ${isDep ? '+' : '-'}${ptFmt(t.amount)} ${cur}
      </td>
      <td style="font-weight:600;color:${balColor}">${ptFmt(t.balanceAfter || 0)} ${cur}</td>
      <td style="color:var(--text-muted);font-size:0.82rem">${t.userId || '—'}</td>
      <td style="color:var(--text-muted);font-size:0.82rem">${new Date(t.ts).toLocaleString('ar-EG')}</td>
      <td style="font-size:0.85rem">${t.notes || '—'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="openEditPartnerTx('${t.id}')" title="تعديل"><i class="fa fa-pen"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="deletePartnerTx('${t.id}')" style="color:var(--accent-red)" title="حذف"><i class="fa fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد معاملات</td></tr>`;

  const pag = document.getElementById('pd-pagination');
  if (pag) {
    if (pages <= 1) { pag.innerHTML = ''; return; }
    let btns = '';
    for (let pg = 1; pg <= pages; pg++) {
      btns += `<button class="btn btn-sm ${pg === _ptPage ? 'btn-primary' : 'btn-ghost'}" onclick="_ptPage=${pg};renderPartnerTransactions()">${pg}</button>`;
    }
    pag.innerHTML = btns;
  }
}

function clearPartnerFilters() {
  ['pd-type-filter', 'pd-date-from', 'pd-date-to', 'pd-notes-search'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.value = '';
  });
  _ptPage = 1;
  renderPartnerTransactions();
}

/* ══════════════════════════════════════════════════════════════
   § 5  إضافة / تعديل شريك
══════════════════════════════════════════════════════════════ */
function openAddPartnerModal() {
  document.getElementById('partner-edit-id').value     = '';
  document.getElementById('partner-name-input').value  = '';
  document.getElementById('partner-phone-input').value = '';
  document.getElementById('partner-notes-input').value = '';
  document.getElementById('partner-modal-title').textContent = 'إضافة شريك جديد';
  openModal('partner-modal');
  setTimeout(() => document.getElementById('partner-name-input')?.focus(), 100);
}

function openEditPartnerModal(partnerId) {
  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) return;
  document.getElementById('partner-edit-id').value     = p.id;
  document.getElementById('partner-name-input').value  = p.name;
  document.getElementById('partner-phone-input').value = p.phone || '';
  document.getElementById('partner-notes-input').value = p.notes || '';
  document.getElementById('partner-modal-title').textContent = 'تعديل بيانات الشريك';
  openModal('partner-modal');
}

function savePartner() {
  const name   = document.getElementById('partner-name-input')?.value?.trim();
  if (!name) { showToast('يرجى إدخال اسم الشريك', 'warning'); return; }
  const editId = document.getElementById('partner-edit-id')?.value;
  if (!db.partners) db.partners = [];

  if (editId) {
    const p = db.partners.find(x => x.id === editId);
    if (p) {
      const old = { name: p.name, phone: p.phone, notes: p.notes };
      p.name  = name;
      p.phone = document.getElementById('partner-phone-input')?.value?.trim() || '';
      p.notes = document.getElementById('partner-notes-input')?.value?.trim() || '';
      ptAudit('UPDATE_PARTNER', 'partner', { partnerId: editId, partnerName: name, before: old, after: { name: p.name, phone: p.phone } });
      showToast('✅ تم تحديث بيانات الشريك');
    }
  } else {
    const newP = {
      id: ptUID(), code: generatePartnerCode(), name,
      phone:     document.getElementById('partner-phone-input')?.value?.trim() || '',
      notes:     document.getElementById('partner-notes-input')?.value?.trim() || '',
      createdAt: ptNow()
    };
    db.partners.push(newP);
    ptAudit('ADD_PARTNER', 'partner', { partnerId: newP.id, partnerName: name, code: newP.code });
    showToast('✅ تم إضافة الشريك — الكود: ' + newP.code);
  }
  saveDB();
  closeModal('partner-modal');
  renderPartnersPage();
}

function deletePartner(partnerId) {
  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) return;
  if (!confirm(`هل تريد حذف الشريك "${p.name}" وجميع معاملاته؟\n⚠️ لن يتم التراجع عن حركات الخزنة المرتبطة به.`)) return;
  ptAudit('DELETE_PARTNER', 'partner', { partnerId, partnerName: p.name });
  db.partners            = db.partners.filter(x => x.id !== partnerId);
  db.partnerTransactions = (db.partnerTransactions || []).filter(t => t.partnerId !== partnerId);
  saveDB();
  showToast('تم حذف الشريك');
  renderPartnersPage();
}

/* ══════════════════════════════════════════════════════════════
   § 6  المعاملات — السحب الذكي من الخزنة
   ✅ السحب يتم من الخزنة مباشرة بدون قيد رصيد الشريك
   ✅ التحقق فقط: هل رصيد الخزنة يكفي؟
   ✅ إذا رصيد الشريك سالب بعد السحب → يُعرض كـ"سلفة" فقط
══════════════════════════════════════════════════════════════ */
function openPartnerTransactionModal(type = 'deposit', partnerId = null) {
  const pid = partnerId || _currentPartnerId;
  if (!pid) { showToast('يرجى اختيار شريك أولاً', 'warning'); return; }
  const p = (db.partners || []).find(x => x.id === pid);
  if (!p) return;

  document.getElementById('partner-tx-edit-id').value    = '';
  document.getElementById('partner-tx-partner-id').value = pid;
  document.getElementById('partner-tx-type').value       = type;
  document.getElementById('partner-tx-amount').value     = '';
  document.getElementById('partner-tx-notes').value      = '';

  // تصنيف السحب
  const catWrap = document.getElementById('partner-tx-category-wrap');
  const catSel  = document.getElementById('partner-tx-category');
  if (catWrap) catWrap.style.display = type === 'withdraw' ? '' : 'none';
  if (catSel)  catSel.value = '';

  document.getElementById('partner-tx-modal-title').textContent =
    (type === 'deposit' ? '💰 إيداع لدى: ' : '💸 سحب من الخزنة لـ: ') + p.name;

  _updateTxPreview(pid);
  openModal('partner-tx-modal');
  setTimeout(() => document.getElementById('partner-tx-amount')?.focus(), 100);

  document.getElementById('partner-tx-amount').oninput = () => _updateTxPreview(pid);
  document.getElementById('partner-tx-type').onchange  = () => {
    const t2 = document.getElementById('partner-tx-type')?.value;
    if (catWrap) catWrap.style.display = t2 === 'withdraw' ? '' : 'none';
    _updateTxPreview(pid);
  };
}

/* ─── معاينة حية ذكية ─── */
function _updateTxPreview(partnerId) {
  const preview = document.getElementById('partner-tx-balance-preview');
  if (!preview) return;

  const cur          = ptCur();
  const partnerBal   = getPartnerBalance(partnerId);
  const treasuryBal  = getTreasuryBalance();
  const amount       = parseFloat(document.getElementById('partner-tx-amount')?.value || 0) || 0;
  const type         = document.getElementById('partner-tx-type')?.value || 'deposit';
  const partnerAfter  = type === 'deposit' ? partnerBal + amount : partnerBal - amount;
  const treasuryAfter = type === 'deposit' ? treasuryBal + amount : treasuryBal - amount;

  preview.style.display = amount > 0 ? '' : 'none';

  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  const clr = (id, val) => { const e = document.getElementById(id); if (e) e.style.color = val >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'; };

  set('ptbp-partner-cur',    ptFmt(partnerBal)   + ' ' + cur);
  set('ptbp-partner-after',  ptFmt(partnerAfter) + ' ' + cur + (partnerAfter < 0 ? ' (سلفة)' : ''));
  set('ptbp-treasury-cur',   ptFmt(treasuryBal)  + ' ' + cur);
  set('ptbp-treasury-after', ptFmt(treasuryAfter)+ ' ' + cur);

  clr('ptbp-partner-after',  partnerAfter);
  clr('ptbp-treasury-after', treasuryAfter);

  const warn = document.getElementById('ptbp-warning');
  if (warn) {
    if (type === 'withdraw' && amount > 0) {
      if (treasuryBal < amount) {
        // الخطر الوحيد: الخزنة لا تكفي
        warn.style.display = '';
        warn.style.color   = 'var(--accent-red)';
        warn.textContent   = `🚫 رصيد الخزنة (${ptFmt(treasuryBal)} ${cur}) غير كافٍ — لا يمكن تنفيذ السحب`;
      } else if (partnerAfter < 0) {
        // تحذير فقط: الشريك سيكون في سلفة — لكن العملية مسموح بها
        warn.style.display = '';
        warn.style.color   = 'var(--accent-orange)';
        warn.textContent   = `⚠️ تنبيه: رصيد الشريك سيصبح (${ptFmt(partnerAfter)} ${cur}) — سيُسجل كسلفة`;
      } else {
        warn.style.display = 'none';
        warn.textContent   = '';
      }
    } else {
      warn.style.display = 'none';
      warn.textContent   = '';
    }
  }
}

/* ─── حفظ المعاملة ─── */
function savePartnerTransaction() {
  const partnerId = document.getElementById('partner-tx-partner-id')?.value;
  const editId    = document.getElementById('partner-tx-edit-id')?.value;
  const type      = document.getElementById('partner-tx-type')?.value || 'deposit';
  const amount    = parseFloat(document.getElementById('partner-tx-amount')?.value || 0);
  const notes     = document.getElementById('partner-tx-notes')?.value?.trim() || '';
  const category  = document.getElementById('partner-tx-category')?.value || '';

  if (!partnerId) { showToast('خطأ: لا يوجد شريك محدد', 'error'); return; }
  if (!amount || amount <= 0) { showToast('يرجى إدخال مبلغ صحيح أكبر من صفر', 'warning'); return; }

  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) { showToast('الشريك غير موجود', 'error'); return; }

  /* ══ التحقق الذكي: فقط رصيد الخزنة يمنع السحب ══ */
  if (type === 'withdraw') {
    const treasuryBal = getTreasuryBalance();
    if (amount > treasuryBal) {
      showToast(
        `🚫 رصيد الخزنة الحالي (${ptFmt(treasuryBal)} ${ptCur()}) لا يكفي لهذا السحب.\nيرجى إيداع مبالغ أولاً.`,
        'error'
      );
      return;
    }
    // ملاحظة: لا نتحقق من رصيد الشريك — السحب من الخزنة مباشرة
    // إذا أصبح رصيد الشريك سالباً يُعامل كسلفة
  }

  if (!db.partnerTransactions) db.partnerTransactions = [];

  if (editId) {
    /* ── تعديل معاملة موجودة ── */
    const tx = db.partnerTransactions.find(t => t.id === editId);
    if (!tx) return;
    const before = { type: tx.type, amount: tx.amount, notes: tx.notes };

    if (tx.treasuryId) {
      db.treasury = (db.treasury || []).filter(t => t.id !== tx.treasuryId);
    }
    tx.type      = type;
    tx.amount    = amount;
    tx.notes     = notes;
    tx.category  = category;
    tx.editedAt  = ptNow();
    tx.editedBy  = ptUser();

    const treasuryType = type === 'deposit' ? 'إيراد' : 'مصروف';
    const treasuryDesc = _buildTreasuryDesc(type, p, category);
    tx.treasuryId = ptPushTreasury(treasuryType, treasuryDesc, amount, p.name, tx.id, category);

    recalcPartnerBalances(partnerId);
    ptAudit('EDIT_TX', 'transaction', { partnerId, partnerName: p.name, txId: editId, before, after: { type, amount, notes, category } });
    showToast('✅ تم تحديث المعاملة');

  } else {
    /* ── إضافة معاملة جديدة ── */
    const partnerBal = getPartnerBalance(partnerId);
    const balAfter   = type === 'deposit' ? partnerBal + amount : partnerBal - amount;
    const txId       = ptUID();

    const treasuryType = type === 'deposit' ? 'إيراد' : 'مصروف';
    const treasuryDesc = _buildTreasuryDesc(type, p, category);
    const treasuryId   = ptPushTreasury(treasuryType, treasuryDesc, amount, p.name, txId, category);

    db.partnerTransactions.push({
      id:           txId,
      partnerId,
      type,
      amount,
      notes,
      category,
      balanceAfter: balAfter,
      userId:       ptUser(),
      ts:           ptNow(),
      date:         new Date().toLocaleDateString('ar-EG'),
      treasuryId,
      isSalaf:      type === 'withdraw' && balAfter < 0  // علامة السلفة
    });

    ptAudit('ADD_TX', 'transaction', {
      partnerId, partnerName: p.name, type, amount, notes, category,
      balanceAfter: balAfter,
      isSalaf: type === 'withdraw' && balAfter < 0
    });

    saveDB();

    const msg = type === 'deposit'
      ? `✅ تم تسجيل الإيداع وإضافته للخزنة`
      : balAfter < 0
        ? `✅ تم سحب ${ptFmt(amount)} ${ptCur()} من الخزنة — رصيد الشريك: ${ptFmt(balAfter)} (سلفة)`
        : `✅ تم سحب ${ptFmt(amount)} ${ptCur()} من الخزنة بنجاح`;

    showToast(msg, type === 'withdraw' && balAfter < 0 ? 'warning' : 'success');
  }

  closeModal('partner-tx-modal');
  renderPartnersStats();
  renderPartnersList();
  if (typeof renderTreasuryPage === 'function') setTimeout(renderTreasuryPage, 150);
  if (_currentPartnerId === partnerId) openPartnerDetail(partnerId);
}

/* ─── بناء وصف الخزنة ─── */
function _buildTreasuryDesc(type, partner, category) {
  const catLabels = { advance: 'سلفة', profit: 'توزيع أرباح', expense: 'مصروف شريك', deposit_capital: 'رأس مال' };
  const catPart = category ? ` (${catLabels[category] || category})` : '';
  return type === 'deposit'
    ? `إيداع شريك — ${partner.name} (${partner.code})${catPart}`
    : `سحب شريك — ${partner.name} (${partner.code})${catPart}`;
}

function openEditPartnerTx(txId) {
  const tx = (db.partnerTransactions || []).find(t => t.id === txId);
  if (!tx) return;
  const p  = (db.partners || []).find(x => x.id === tx.partnerId);
  if (!p)  return;

  document.getElementById('partner-tx-edit-id').value    = tx.id;
  document.getElementById('partner-tx-partner-id').value = tx.partnerId;
  document.getElementById('partner-tx-type').value       = tx.type;
  document.getElementById('partner-tx-amount').value     = tx.amount;
  document.getElementById('partner-tx-notes').value      = tx.notes || '';

  const catWrap = document.getElementById('partner-tx-category-wrap');
  const catSel  = document.getElementById('partner-tx-category');
  if (catWrap) catWrap.style.display = tx.type === 'withdraw' ? '' : 'none';
  if (catSel)  catSel.value = tx.category || '';

  document.getElementById('partner-tx-modal-title').textContent = 'تعديل معاملة — ' + p.name;
  _updateTxPreview(tx.partnerId);
  openModal('partner-tx-modal');

  document.getElementById('partner-tx-amount').oninput = () => _updateTxPreview(tx.partnerId);
  document.getElementById('partner-tx-type').onchange  = () => {
    const t2 = document.getElementById('partner-tx-type')?.value;
    if (catWrap) catWrap.style.display = t2 === 'withdraw' ? '' : 'none';
    _updateTxPreview(tx.partnerId);
  };
}

function deletePartnerTx(txId) {
  const tx = (db.partnerTransactions || []).find(t => t.id === txId);
  if (!tx) return;
  const p = (db.partners || []).find(x => x.id === tx.partnerId);
  if (!confirm(`هل تريد حذف هذه المعاملة؟\n⚠️ سيتم عكس أثرها على الخزنة أيضاً.`)) return;

  if (tx.treasuryId) {
    db.treasury = (db.treasury || []).filter(t => t.id !== tx.treasuryId);
  }
  db.partnerTransactions = db.partnerTransactions.filter(t => t.id !== txId);

  ptAudit('DELETE_TX', 'transaction', {
    partnerId: tx.partnerId, partnerName: p?.name || '—',
    txId, type: tx.type, amount: tx.amount
  });
  recalcPartnerBalances(tx.partnerId);

  showToast('تم حذف المعاملة وعكس أثرها على الخزنة');
  renderPartnersStats();
  renderPartnersList();
  if (typeof renderTreasuryPage === 'function') setTimeout(renderTreasuryPage, 150);
  if (_currentPartnerId === tx.partnerId) openPartnerDetail(tx.partnerId);
}

/* ══════════════════════════════════════════════════════════════
   § 7  سجل التدقيق
══════════════════════════════════════════════════════════════ */
function renderAuditLog() {
  const logs  = [...(db.partnerAuditLog || [])].reverse().slice(0, 200);
  const tbody = document.getElementById('pt-audit-tbody');
  if (!tbody) return;

  const actionLabels = {
    ADD_PARTNER: 'إضافة شريك', UPDATE_PARTNER: 'تعديل شريك', DELETE_PARTNER: 'حذف شريك',
    ADD_TX: 'إضافة معاملة', EDIT_TX: 'تعديل معاملة', DELETE_TX: 'حذف معاملة'
  };
  const actionColors = {
    ADD_PARTNER: 'var(--accent-green)', UPDATE_PARTNER: 'var(--accent-blue)', DELETE_PARTNER: 'var(--accent-red)',
    ADD_TX: 'var(--accent-green)', EDIT_TX: 'var(--accent-orange)', DELETE_TX: 'var(--accent-red)'
  };

  tbody.innerHTML = logs.length ? logs.map((l, i) => `<tr>
    <td style="color:var(--text-muted)">${i + 1}</td>
    <td><span style="background:${actionColors[l.action]}22;color:${actionColors[l.action]};padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:700">${actionLabels[l.action] || l.action}</span></td>
    <td>${l.partnerName || '—'}</td>
    <td style="color:var(--text-muted);font-size:0.82rem">${l.user}</td>
    <td style="color:var(--text-muted);font-size:0.82rem">${new Date(l.ts).toLocaleString('ar-EG')}</td>
    <td style="font-size:0.82rem">${l.amount ? ptFmt(l.amount) + ' ' + ptCur() : '—'}</td>
    <td style="font-size:0.78rem;color:var(--accent-orange)">${l.isSalaf ? '⚠️ سلفة' : ''}</td>
  </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">لا يوجد سجل تدقيق</td></tr>`;
}

/* ══════════════════════════════════════════════════════════════
   § 8  التقارير PDF
══════════════════════════════════════════════════════════════ */
const _pdfStyles = `
  body{font-family:'Segoe UI',Tahoma,sans-serif;padding:20px;font-size:13px;direction:rtl;color:#111}
  h1{font-size:1.4rem;margin-bottom:4px;color:#1a1a2e}
  h2{font-size:1.1rem;margin:12px 0 4px;color:#333}
  .info{display:flex;gap:20px;flex-wrap:wrap;background:#f5f7fa;padding:12px 16px;border-radius:8px;margin-bottom:16px;border:1px solid #e0e0e0}
  .info div{display:flex;flex-direction:column;min-width:100px}
  .info span{font-size:0.75rem;color:#666}
  .info strong{font-size:0.95rem}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th,td{border:1px solid #ddd;padding:7px 10px;text-align:center}
  th{background:#f0f3f7;font-weight:700}
  tr:nth-child(even){background:#fafbfc}
  .badge{padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:700}
  .salaf{background:#fff3cd;color:#856404;padding:2px 6px;border-radius:4px;font-size:0.75rem}
  .footer{margin-top:12px;color:#999;font-size:0.8rem;text-align:center;border-top:1px solid #eee;padding-top:10px}
  @media print{@page{margin:1cm}}
`;

function exportPartnerReport() {
  if (!_currentPartnerId) return;
  const p = (db.partners || []).find(x => x.id === _currentPartnerId);
  if (!p) return;
  const stats = getPartnerStats(_currentPartnerId);
  const cur   = ptCur();
  const txs   = (db.partnerTransactions || []).filter(t => t.partnerId === _currentPartnerId)
                  .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const rows = txs.map((t, i) => `<tr>
    <td>${i + 1}</td>
    <td><span class="badge" style="background:${t.type === 'deposit' ? '#d4edda' : '#f8d7da'};color:${t.type === 'deposit' ? 'green' : 'red'}">${t.type === 'deposit' ? 'إيداع' : 'سحب'}</span></td>
    <td style="color:${t.type === 'deposit' ? 'green' : 'red'};font-weight:700">${t.type === 'deposit' ? '+' : '-'}${ptFmt(t.amount)}</td>
    <td style="color:${(t.balanceAfter || 0) >= 0 ? 'green' : 'orange'};font-weight:700">${ptFmt(t.balanceAfter || 0)}${t.isSalaf ? ' <span class="salaf">سلفة</span>' : ''}</td>
    <td>${t.userId || '—'}</td>
    <td>${new Date(t.ts).toLocaleString('ar-EG')}</td>
    <td>${t.notes || '—'}</td>
  </tr>`).join('');

  _printReport(`كشف حساب — ${p.name}`, `
    <h1>كشف حساب الشريك — ${p.name}</h1>
    <div class="info">
      <div><span>الكود</span><strong>${p.code}</strong></div>
      <div><span>الهاتف</span><strong>${p.phone || '—'}</strong></div>
      <div><span>الرصيد الحالي</span><strong style="color:${stats.balance >= 0 ? 'green' : 'orange'}">${ptFmt(stats.balance)} ${cur}${stats.balance < 0 ? ' (سلفة)' : ''}</strong></div>
      <div><span>إجمالي الإيداعات</span><strong style="color:#1565c0">${ptFmt(stats.deposits)} ${cur}</strong></div>
      <div><span>إجمالي السحوبات</span><strong style="color:red">${ptFmt(stats.withdrawals)} ${cur}</strong></div>
      <div><span>عدد المعاملات</span><strong>${stats.count}</strong></div>
      <div><span>تاريخ الطباعة</span><strong>${new Date().toLocaleDateString('ar-EG')}</strong></div>
    </div>
    <table><thead><tr><th>#</th><th>النوع</th><th>المبلغ</th><th>الرصيد بعد</th><th>بواسطة</th><th>التاريخ</th><th>الملاحظات</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">لا توجد معاملات</td></tr>'}</tbody></table>`);
}

function exportAllPartnersReport() {
  const partners = db.partners || [];
  if (!partners.length) { showToast('لا يوجد شركاء', 'warning'); return; }
  const cur      = ptCur();
  const txs      = db.partnerTransactions || [];
  const totalDep = txs.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0);
  const totalWit = txs.filter(t => t.type === 'withdraw').reduce((s, t) => s + t.amount, 0);
  const tBal     = getTreasuryBalance();

  const rows = partners.map((p, i) => {
    const st = getPartnerStats(p.id);
    return `<tr><td>${i + 1}</td><td>${p.code}</td><td>${p.name}</td><td>${p.phone || '—'}</td>
      <td style="color:${st.balance >= 0 ? 'green' : 'orange'};font-weight:700">${ptFmt(st.balance)} ${cur}${st.balance < 0 ? ' <span class="salaf">سلفة</span>' : ''}</td>
      <td style="color:#1565c0">${ptFmt(st.deposits)} ${cur}</td>
      <td style="color:red">${ptFmt(st.withdrawals)} ${cur}</td>
      <td>${st.count}</td></tr>`;
  }).join('');

  _printReport('تقرير جميع الشركاء', `
    <h1>تقرير حسابات جميع الشركاء</h1>
    <div class="info">
      <div><span>عدد الشركاء</span><strong>${partners.length}</strong></div>
      <div><span>رصيد الخزنة الحالي</span><strong style="color:green">${ptFmt(tBal)} ${cur}</strong></div>
      <div><span>إجمالي الأرصدة</span><strong style="color:green">${ptFmt(totalDep - totalWit)} ${cur}</strong></div>
      <div><span>إجمالي الإيداعات</span><strong style="color:#1565c0">${ptFmt(totalDep)} ${cur}</strong></div>
      <div><span>إجمالي السحوبات</span><strong style="color:red">${ptFmt(totalWit)} ${cur}</strong></div>
      <div><span>تاريخ التقرير</span><strong>${new Date().toLocaleDateString('ar-EG')}</strong></div>
    </div>
    <table><thead><tr><th>#</th><th>الكود</th><th>الاسم</th><th>الهاتف</th><th>الرصيد</th><th>إيداعات</th><th>سحوبات</th><th>معاملات</th></tr></thead>
    <tbody>${rows}</tbody></table>`);
}

function exportTreasuryMovementsReport() {
  const txs      = (db.treasury || []).filter(t => t.source === 'partners').sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const cur      = ptCur();
  const totalIn  = txs.filter(t => t.type === 'إيراد').reduce((s, t) => s + t.amount, 0);
  const totalOut = txs.filter(t => t.type === 'مصروف').reduce((s, t) => s + t.amount, 0);

  const rows = txs.map((t, i) => `<tr>
    <td>${i + 1}</td>
    <td><span class="badge" style="background:${t.type === 'إيراد' ? '#d4edda' : '#f8d7da'};color:${t.type === 'إيراد' ? 'green' : 'red'}">${t.type}</span></td>
    <td style="font-weight:700;color:${t.type === 'إيراد' ? 'green' : 'red'}">${ptFmt(t.amount)} ${cur}</td>
    <td>${t.partnerName || '—'}</td>
    <td>${t.desc || '—'}</td>
    <td>${new Date(t.ts).toLocaleString('ar-EG')}</td>
  </tr>`).join('');

  _printReport('تقرير حركة الخزنة — الشركاء', `
    <h1>تقرير حركة الخزنة — الشركاء</h1>
    <div class="info">
      <div><span>رصيد الخزنة الحالي</span><strong style="color:green">${ptFmt(getTreasuryBalance())} ${cur}</strong></div>
      <div><span>إجمالي الوارد (إيداعات)</span><strong style="color:#1565c0">${ptFmt(totalIn)} ${cur}</strong></div>
      <div><span>إجمالي الصادر (سحوبات)</span><strong style="color:red">${ptFmt(totalOut)} ${cur}</strong></div>
      <div><span>عدد الحركات</span><strong>${txs.length}</strong></div>
    </div>
    <table><thead><tr><th>#</th><th>النوع</th><th>المبلغ</th><th>الشريك</th><th>البيان</th><th>التاريخ</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6">لا توجد حركات</td></tr>'}</tbody></table>`);
}

function exportDepositsReport() {
  const txs   = (db.partnerTransactions || []).filter(t => t.type === 'deposit').sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const cur   = ptCur();
  const total = txs.reduce((s, t) => s + t.amount, 0);

  const rows = txs.map((t, i) => {
    const p = (db.partners || []).find(x => x.id === t.partnerId);
    return `<tr><td>${i + 1}</td><td>${p?.code || '—'}</td><td>${p?.name || '—'}</td>
    <td style="color:green;font-weight:700">+${ptFmt(t.amount)} ${cur}</td>
    <td>${t.userId || '—'}</td><td>${new Date(t.ts).toLocaleString('ar-EG')}</td><td>${t.notes || '—'}</td></tr>`;
  }).join('');

  _printReport('تقرير الإيداعات', `
    <h1>تقرير إيداعات الشركاء</h1>
    <div class="info">
      <div><span>إجمالي الإيداعات</span><strong style="color:green">${ptFmt(total)} ${cur}</strong></div>
      <div><span>عدد الإيداعات</span><strong>${txs.length}</strong></div>
      <div><span>تاريخ التقرير</span><strong>${new Date().toLocaleDateString('ar-EG')}</strong></div>
    </div>
    <table><thead><tr><th>#</th><th>الكود</th><th>الشريك</th><th>المبلغ</th><th>بواسطة</th><th>التاريخ</th><th>ملاحظات</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">لا توجد إيداعات</td></tr>'}</tbody></table>`);
}

function exportWithdrawalsReport() {
  const txs   = (db.partnerTransactions || []).filter(t => t.type === 'withdraw').sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const cur   = ptCur();
  const total = txs.reduce((s, t) => s + t.amount, 0);

  const rows = txs.map((t, i) => {
    const p = (db.partners || []).find(x => x.id === t.partnerId);
    return `<tr><td>${i + 1}</td><td>${p?.code || '—'}</td><td>${p?.name || '—'}</td>
    <td style="color:red;font-weight:700">-${ptFmt(t.amount)} ${cur}</td>
    <td>${t.isSalaf ? '<span class="salaf">سلفة</span>' : '—'}</td>
    <td>${t.userId || '—'}</td><td>${new Date(t.ts).toLocaleString('ar-EG')}</td><td>${t.notes || '—'}</td></tr>`;
  }).join('');

  _printReport('تقرير السحوبات', `
    <h1>تقرير سحوبات الشركاء</h1>
    <div class="info">
      <div><span>إجمالي السحوبات</span><strong style="color:red">${ptFmt(total)} ${cur}</strong></div>
      <div><span>عدد السحوبات</span><strong>${txs.length}</strong></div>
      <div><span>تاريخ التقرير</span><strong>${new Date().toLocaleDateString('ar-EG')}</strong></div>
    </div>
    <table><thead><tr><th>#</th><th>الكود</th><th>الشريك</th><th>المبلغ</th><th>نوع السحب</th><th>بواسطة</th><th>التاريخ</th><th>ملاحظات</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8">لا توجد سحوبات</td></tr>'}</tbody></table>`);
}

function _printReport(title, body) {
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${title}</title>
    <style>${_pdfStyles}</style></head><body>${body}
    <div class="footer">تم إنشاؤه تلقائياً من نظام حسيبني — ${new Date().toLocaleString('ar-EG')}</div>
    <script>window.onload=function(){setTimeout(()=>window.print(),400)}<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

/* ══════════════════════════════════════════════════════════════
   § 9  نظام الأجل
══════════════════════════════════════════════════════════════ */
function updatePosDueDateDisplay() {
  const days    = parseInt(document.getElementById('pos-credit-days')?.value || 0) || 0;
  const display = document.getElementById('pos-due-date-display');
  if (!display) return;
  if (days > 0) {
    const d = new Date(); d.setDate(d.getDate() + days);
    display.textContent = '📅 تاريخ الاستحقاق: ' + d.toLocaleDateString('ar-EG');
  } else {
    display.textContent = '';
  }
}

/* ══════════════════════════════════════════════════════════════
   § 10  Bootstrap
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  upgradePartnersDB();

  const posCreditDays = document.getElementById('pos-credit-days');
  if (posCreditDays) posCreditDays.addEventListener('input', updatePosDueDateDisplay);

  const purPaySel = document.getElementById('pur-payment-select');
  if (purPaySel) purPaySel.addEventListener('change', () => {
    const cdw = document.getElementById('pur-credit-days-wrap');
    if (cdw) cdw.style.display = purPaySel.value === 'آجل' ? '' : 'none';
  });

  const posPaySel = document.getElementById('pos-payment-select');
  if (posPaySel) posPaySel.addEventListener('change', () => {
    if (posPaySel.value === 'آجل') {
      const el = document.getElementById('pos-credit-days');
      if (el && !el.value) {
        const last = (db.purchases || []).filter(p => p.payment === 'آجل' && p.creditDays > 0)
                                         .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
        if (last?.creditDays) {
          el.value = last.creditDays;
          updatePosDueDateDisplay();
          showToast(`💡 تم تطبيق أجل ${last.creditDays} يوم من آخر فاتورة شراء`, 'info');
        }
      }
    }
  });
});
