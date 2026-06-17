// =========================================================
// ======= PERFORMANCE & DATA LAYER ========================
// =========================================================
// DB_KEY, saveDB, loadDB, IDB engine — defined in db_engine.js

/* ---- Cache layer ---- */
const _cache = {};
function invalidateCache(...keys) { keys.forEach(k => delete _cache[k]); }

/* ---- RAF-batched DOM update ---- */
let _rafPending = false;
const _rafQueue = new Set();
function scheduleRender(fn) {
  _rafQueue.add(fn);
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafQueue.forEach(f => f());
      _rafQueue.clear();
      _rafPending = false;
    });
  }
}

// getDefaultDB moved to db_engine.js v4

let db = (() => { const d = loadDB(); return mergeDB(d); })();
window.db = db; // expose for services
let currentUser = null;
let cart = [];
let selectedLoginUserId = null;
let suspendedCarts = [];

// =========================================================
// ======= PERMISSIONS =====================================
// =========================================================
const ROLE_LABELS = { admin: 'Admin', manager: 'مدير', cashier: 'كاشير', store: 'مخزن', accountant: 'محاسب' };
const ROLE_CLASSES = { admin: 'role-admin', manager: 'role-manager', cashier: 'role-cashier', store: 'role-store', accountant: 'role-accountant' };

const PERMISSIONS = {
  pos:        { admin: true, manager: true, cashier: true, store: false, accountant: false },
  products:   { admin: true, manager: true, cashier: true, store: true, accountant: false },
  purchases:  { admin: true, manager: true, cashier: true, store: true, accountant: true },
  suppliers:  { admin: true, manager: true, cashier: true, store: true, accountant: true },
  sales:      { admin: true, manager: true, cashier: true, store: false, accountant: true },
  customers:  { admin: true, manager: true, cashier: true, store: false, accountant: true },
  returns:    { admin: true, manager: true, cashier: true, store: false, accountant: false },
  treasury:   { admin: true, manager: false, cashier: false, store: false, accountant: true },
  expenses:   { admin: true, manager: false, cashier: true, store: false, accountant: true },
  reports:    { admin: true, manager: true, cashier: true, store: true, accountant: true },
  users:      { admin: true, manager: false, cashier: false, store: false, accountant: false },
  employees:  { admin: true, manager: true, cashier: false, store: false, accountant: false },
  logs:       { admin: true, manager: true, cashier: false, store: false, accountant: false },
  settings:   { admin: true, manager: false, cashier: false, store: false, accountant: false },
  'delete':   { admin: true, manager: false, cashier: false, store: false, accountant: false },
  wholesale:  { admin: true, manager: true, cashier: true, store: false, accountant: false },
  expiry:     { admin: true, manager: true, cashier: false, store: true, accountant: false },
  production: { admin: true, manager: true, cashier: false, store: true, accountant: false },
  balances:   { admin: true, manager: true, cashier: false, store: false, accountant: true },
};

function can(action) {
  if (!currentUser) return false;
  const p = PERMISSIONS[action];
  if (!p) return currentUser.role === 'admin';
  return !!p[currentUser.role];
}

// =========================================================
// ======= LOGIN ===========================================
// =========================================================
function renderLoginUsers() {
  const grid = document.getElementById('login-users-grid');
  grid.innerHTML = db.users.filter(u => u.status === 'active').map(u => `
    <div class="login-user-btn" onclick="selectLoginUser('${u.id}')">
      <div class="user-icon">${u.icon || '👤'}</div>
      <div class="user-name">${u.name}</div>
      <div class="user-role">${ROLE_LABELS[u.role] || u.role}</div>
    </div>
  `).join('');
}

function selectLoginUser(uid) {
  selectedLoginUserId = uid;
  const u = db.users.find(x => x.id === uid);
  document.getElementById('login-selected-name').textContent = u.name;
  document.querySelectorAll('.login-user-btn').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  document.getElementById('login-pass-section').classList.add('visible');
  document.getElementById('login-password').value = '';
  document.getElementById('login-password').focus();
}

function cancelLogin() {
  selectedLoginUserId = null;
  document.getElementById('login-pass-section').classList.remove('visible');
  document.querySelectorAll('.login-user-btn').forEach(b => b.classList.remove('selected'));
}

function doLogin() {
  if (!selectedLoginUserId) { showToast('اختر مستخدمًا أولاً', 'warning'); return; }
  const u = db.users.find(x => x.id === selectedLoginUserId);
  const pass = document.getElementById('login-password').value;
  if (pass !== u.password) { showToast('كلمة المرور غير صحيحة', 'error'); return; }
  currentUser = u;
  u.lastLogin = new Date().toISOString();
  saveDB();
  addLog('دخول', `تسجيل دخول: ${u.name}`, 'دخول');
  startApp();
}

function logoutUser() {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  addLog('دخول', `تسجيل خروج: ${currentUser.name}`, 'دخول');
  currentUser = null;
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('navbar').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('main-content').style.display = 'none';
  cancelLogin();
  renderLoginUsers();
}

function startApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('navbar').style.display = 'flex';
  document.getElementById('sidebar').style.display = 'block';
  document.getElementById('main-content').style.display = 'block';
  applyPermissionsToUI();
  updateNavUser();
  navigate('home');
  startClock();
  // تحميل IDB للحصول على أحدث بيانات
  loadDBAsync().then(freshDB => {
    if (freshDB) {
      const cu = currentUser;
      db = mergeDB(freshDB);
      window.db = db;
      currentUser = cu;
      _prodIdx.rebuild();
      if (typeof upgradePartnersDB === 'function') upgradePartnersDB();
      renderDashboard();
    }
  }).catch(() => {});
  setTimeout(() => { if (typeof upgradeDatabase === 'function') upgradeDatabase(); }, 500);
  setTimeout(() => { if (typeof checkExpiryAlerts === 'function') checkExpiryAlerts(); }, 800);
  setInterval(() => { if (typeof checkExpiryAlerts === 'function') checkExpiryAlerts(); }, 3600000);
}

function applyPermissionsToUI() {
  // Hide sidebar items based on role
  document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
    const page = item.dataset.page;
    if (PERMISSIONS[page] && !can(page)) {
      item.style.display = 'none';
    } else {
      item.style.display = '';
    }
  });
}

function updateNavUser() {
  if (!currentUser) return;
  document.getElementById('nav-user-name').textContent = currentUser.name;
  document.getElementById('nav-user-icon').textContent = currentUser.icon || '👤';
  const rb = document.getElementById('nav-user-role-badge');
  rb.textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
  rb.className = 'role-badge ' + (ROLE_CLASSES[currentUser.role] || '');
  document.getElementById('store-name-badge').textContent = db.settings.storeName || 'متجري';
  document.getElementById('store-name-badge').textContent = db.settings.storeName;
}

// =========================================================
// ======= NAVIGATION ======================================
// =========================================================
function navigate(page) {
  if (page !== 'home' && PERMISSIONS[page] && !can(page)) {
    showToast('ليس لديك صلاحية للوصول لهذا القسم', 'error');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  const si = document.querySelector(`.sidebar-item[data-page="${page}"]`);
  if (si) si.classList.add('active');

  const renders = {
    home: renderDashboard, pos: renderPos, products: renderProductsPage,
    wholesale: renderWholesale, expiry: renderExpiryPage,
    sales: renderSalesPage, purchases: renderPurchasesPage, customers: renderCustomersPage,
    suppliers: renderSuppliersPage, employees: renderEmployeesPage, treasury: renderTreasuryPage,
    expenses: renderExpensesPage, reports: renderReportsPage, returns: renderReturnsPage,
    users: renderUsersPage, logs: renderLogsPage, settings: renderSettingsPage,
    'user-profile': renderUserProfile,
    'daily-session': renderDailySession,
    production: () => { if (typeof renderProductionPage === 'function') renderProductionPage(); },
    balances:   () => { if (typeof renderBalancesPage   === 'function') renderBalancesPage();   },
    partners:   () => { if (typeof renderPartnersPage   === 'function') renderPartnersPage();   },
  };
  if (renders[page]) renders[page]();

  // Focus helpers
  if (page === 'pos') setTimeout(() => { const s = document.getElementById('pos-search'); if (s) s.focus(); }, 100);
  if (page === 'wholesale') setTimeout(() => { const s = document.getElementById('ws-search'); if (s) s.focus(); }, 100);
}

document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.page));
});

// =========================================================
// ======= CLOCK ===========================================
// =========================================================
function startClock() {
  function tick() {
    const now = new Date();
    const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const navDT = document.getElementById('nav-datetime');
    if(navDT) navDT.textContent = now.toLocaleDateString('ar-EG', opts);
    const navClock = document.getElementById('nav-clock');
    if(navClock) navClock.textContent = now.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const navDate = document.getElementById('nav-date');
    if(navDate) navDate.textContent = now.toLocaleDateString('ar-EG',{weekday:'short',year:'numeric',month:'short',day:'numeric'});
  }
  tick();
  setInterval(tick, 30000);
}

// =========================================================
// ======= TOAST ===========================================
// =========================================================
function showToast(msg, type = 'success') {
  const icons = { success: '✅', error: '❌', warning: '⚠️' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// =========================================================
// ======= MODALS ==========================================
// =========================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

// =========================================================
// ======= LOGS ============================================
// =========================================================
function addLog(type, desc, category = 'other') {
  const now = new Date();
  db.logs.unshift({
    id: 'L' + Date.now(),
    type, desc, category,
    user: currentUser ? currentUser.name : 'النظام',
    userId: currentUser ? currentUser.id : null,
    date: now.toLocaleDateString('ar-EG'),
    time: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
    ts: now.toISOString()
  });
  if (!db.logs) db.logs = []; if (db.logs.length > 500) db.logs = db.logs.slice(0, 500);
  saveDB();
}

// =========================================================
// ======= HELPERS =========================================
// =========================================================
const fmt = (n) => parseFloat(n || 0).toFixed(2);
const curr = () => db.settings.currency || 'جنيه';
const fmtCurr = (n) => fmt(n) + ' ' + curr();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ar-EG');
}

// =========================================================
// ======= DASHBOARD =======================================
// =========================================================
function renderDashboard() {
  const today = new Date().toDateString();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const sales = db.sales || [];
  const returns = db.returns || [];

  const todaySales = sales.filter(s => new Date(s.ts || s.date).toDateString() === today).reduce((a, s) => a + (s.total || 0), 0);
  const monthSales = sales.filter(s => (s.ts || s.date || '').startsWith(thisMonth)).reduce((a, s) => a + (s.total || 0), 0);
  const totalRevenue = sales.reduce((a, s) => a + (s.total || 0), 0);
  const totalCOGS = sales.reduce((a, s) => a + ((s.items || []).reduce((b, i) => b + (i.cost || 0) * (i.qty || 1), 0)), 0);
  const totalExpenses = (db.expenses || []).reduce((a, e) => a + (e.amount || 0), 0);
  const totalReturns = returns.reduce((a, r) => a + (r.amount || 0), 0);
  const netProfit = totalRevenue - totalCOGS - totalExpenses - totalReturns;

  const income = (db.treasury || []).filter(t => t.type === 'إيراد').reduce((a, t) => a + (t.amount || 0), 0);
  const expense = (db.treasury || []).filter(t => t.type === 'مصروف').reduce((a, t) => a + (t.amount || 0), 0);
  const withdrawals = (db.treasury || []).filter(t => t.type === 'سحب').reduce((a, t) => a + (t.amount || 0), 0);
  const balance = income - expense - withdrawals;

  const lowStockThreshold = db.settings.lowStock || 5;
  const lowStock = (db.products || []).filter(p => p.qty <= lowStockThreshold).length;

  el('dash-today-sales').textContent = fmtCurr(todaySales);
  el('dash-month-sales').textContent = fmtCurr(monthSales);
  el('dash-total-revenue').textContent = fmtCurr(totalRevenue);
  el('dash-net-profit').textContent = fmtCurr(netProfit);
  el('dash-treasury').textContent = fmtCurr(balance);
  el('dash-orders').textContent = sales.length;
  el('dash-customers').textContent = (db.customers || []).length;
  el('dash-products').textContent = (db.products || []).length;
  el('dash-low-stock').textContent = lowStock;

  // إخفاء إحصائيات الشهر والخزنة من الكاشير
  const isCashier = currentUser && currentUser.role === 'cashier';
  const monthCard = document.getElementById('stat-card-month');
  const treasuryCard = document.getElementById('stat-card-treasury');
  const netProfitCard = document.getElementById('stat-card-netprofit');
  const totalRevenueCard = document.getElementById('stat-card-revenue');
  if (monthCard) monthCard.style.display = isCashier ? 'none' : '';
  if (treasuryCard) treasuryCard.style.display = isCashier ? 'none' : '';
  if (netProfitCard) netProfitCard.style.display = isCashier ? 'none' : '';
  if (totalRevenueCard) totalRevenueCard.style.display = isCashier ? 'none' : '';

  // Greeting
  const h = new Date().getHours();
  const greet = h < 12 ? 'صباح الخير' : h < 17 ? 'مساء الخير' : 'مساء النور';
  el('home-greeting').textContent = `${greet}، ${currentUser?.name || ''} 👋`;

  // Weekly chart
  renderWeeklyChart();

  // Top products
  renderDashTopProducts();

  // Alerts
  renderAlerts();

  // Recent sales
  const tbody = el('recent-sales-table');
  const recent = [...sales].reverse().slice(0, 6);
  tbody.innerHTML = recent.length ? recent.map(s => `
    <tr>
      <td><span class="badge badge-blue">${s.id}</span></td>
      <td>${s.customerName || 'نقدي'}</td>
      <td>${s.date || ''}</td>
      <td style="color:var(--accent-green);font-weight:700">${fmtCurr(s.total)}</td>
      <td><span class="badge badge-green">مكتمل</span></td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="empty-state"><p>لا توجد مبيعات</p></td></tr>';

  el('sidebar-returns-count').textContent = (db.returns || []).length;
}

function el(id) { return document.getElementById(id); }

// =========================================================
// ======= KEYBOARD SHORTCUTS ==============================
// =========================================================
document.addEventListener('keydown', function(e) {
  if (!currentUser) return;
  // F2 → نقطة البيع
  if (e.key === 'F2') { e.preventDefault(); navigate('pos'); }
  // F3 → البحث في نقطة البيع
  if (e.key === 'F3') {
    e.preventDefault();
    const s = el('pos-search');
    if (s) { navigate('pos'); setTimeout(() => s.focus(), 100); }
  }
  // Escape → إغلاق Modal + Dropdown
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    closeDropdown();
  }
  // F9 → حفظ الفاتورة مباشرة
  if (e.key === 'F9') { e.preventDefault(); completeSale(); }
  // F10 → مسح السلة
  if (e.key === 'F10') { e.preventDefault(); if (cart.length && confirm('مسح السلة؟')) clearCart(); }
  // Ctrl+P → طباعة
  if (e.ctrlKey && e.key === 'p') { e.preventDefault(); if (cart.length) posHeatPrint(); }
  // + أو = → زيادة كمية آخر منتج في السلة
  if ((e.key === '+' || e.key === '=') && !e.target.matches('input,textarea')) {
    const last = cart[cart.length - 1];
    if (last) { changeQty(last.productId, 1); }
  }
  // - → تقليل كمية آخر منتج
  if (e.key === '-' && !e.target.matches('input,textarea')) {
    const last = cart[cart.length - 1];
    if (last) { changeQty(last.productId, -1); }
  }
});


function renderWeeklyChart() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({ label: d.toLocaleDateString('ar-EG', { weekday: 'short' }), dateStr: d.toDateString(), total: 0 });
  }
  (db.sales || []).forEach(s => {
    const ds = new Date(s.ts || s.date).toDateString();
    const d = days.find(x => x.dateStr === ds);
    if (d) d.total += s.total || 0;
  });
  const max = Math.max(...days.map(d => d.total), 1);
  el('weekly-chart').innerHTML = `
    <div class="chart-bars">
      ${days.map(d => `
        <div class="chart-bar-wrap">
          <div class="chart-bar-val">${d.total > 0 ? fmt(d.total) : ''}</div>
          <div class="chart-bar" style="height:${Math.max((d.total / max) * 100, 2)}%"></div>
          <div class="chart-bar-label">${d.label}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderDashTopProducts() {
  const productSales = {};
  (db.sales || []).forEach(s => {
    (s.items || []).forEach(item => {
      if (!productSales[item.productId]) productSales[item.productId] = { name: item.name, qty: 0 };
      productSales[item.productId].qty += item.qty || 1;
    });
  });
  const sorted = Object.values(productSales).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const max = sorted[0]?.qty || 1;
  el('top-products-list').innerHTML = sorted.length ? sorted.map((p, i) => `
    <div class="top-product-item">
      <div class="top-product-rank">${i + 1}</div>
      <div style="flex:1">
        <div style="font-size:0.84rem;font-weight:700;margin-bottom:4px">${p.name}</div>
        <div class="top-product-bar"><div class="top-product-bar-fill" style="width:${(p.qty / max) * 100}%"></div></div>
      </div>
      <div style="font-size:0.82rem;font-weight:700;color:var(--accent-green)">${p.qty} ${curr()}</div>
    </div>
  `).join('') : '<div class="empty-state"><div class="empty-icon">📦</div><p>لا توجد بيانات</p></div>';
}

function renderAlerts() {
  const alerts = [];
  const threshold = db.settings.lowStock || 5;
  (db.products || []).filter(p => p.qty <= threshold).forEach(p => {
    alerts.push({ type: p.qty === 0 ? 'danger' : 'warning', msg: `${p.name}: كمية ${p.qty === 0 ? 'نفدت' : 'منخفضة'} (${p.qty} ${p.unit || 'قطعة'})` });
  });
  (db.customers || []).filter(c => (c.balance || 0) > 0).forEach(c => {
    alerts.push({ type: 'warning', msg: `${c.name}: دين ${fmtCurr(c.balance)}` });
  });
  el('dashboard-alerts').innerHTML = alerts.length ? alerts.slice(0, 6).map(a => `
    <div class="alert-item ${a.type}"><i class="fa fa-${a.type === 'danger' ? 'circle-exclamation' : 'triangle-exclamation'}"></i> ${a.msg}</div>
  `).join('') : '<div class="empty-state"><div class="empty-icon">✅</div><p>لا توجد تنبيهات</p></div>';
}

// =========================================================
// ======= POS =============================================
// =========================================================











function renderPos() {
  updatePosInvoiceMeta();
  renderPosProducts();
  scheduleRender(renderCart);
  renderTopProducts();
}

/* ---- Fast product grid using DocumentFragment ---- */
const _renderPosProductsFast = debounce(function() {
  const q = (el('pos-search')?.value || '').trim().toLowerCase();
  const cat = el('pos-cat-filter')?.value || 'all';
  const grid = el('pos-products-grid');
  if (!grid) return;

  // Re-populate categories only once per session (cached)
  const catSel = el('pos-cat-filter');
  if (catSel && !_cache.catOptions) {
    const curVal = catSel.value;
    catSel.innerHTML = '<option value="all">كل الفئات</option>' +
      (db.categories || []).map(c => `<option value="${c}" ${c===curVal?'selected':''}>${c}</option>`).join('');
    _cache.catOptions = true;
  }

  const prods = (db.products || []).filter(p => {
    const matchQ = !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q);
    const matchC = cat === 'all' || p.category === cat;
    return matchQ && matchC;
  });

  if (!prods.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted);font-size:0.8rem">لا توجد منتجات</div>`;
    return;
  }

  // DocumentFragment for zero reflow while building
  const frag = document.createDocumentFragment();
  prods.forEach(p => {
    const div = document.createElement('div');
    div.className = 'product-card-sm' + (p.qty <= 0 ? ' out-of-stock' : '');
    div.onclick = () => addToCart(p.id);
    div.innerHTML = `
      <div class="pcsm-img">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.style.display='none'">` : (p.qty <= 0 ? '❌' : '📦')}
      </div>
      <div class="pcsm-name">${p.name}</div>
      <div class="pcsm-price">${fmtCurr(p.price)}</div>`;
    frag.appendChild(div);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
}, 80);

function renderPosProducts() { _renderPosProductsFast(); }

/* ---- Top Products with sales cache ---- */
function _buildTopSalesMap() {
  if (_cache.topSalesMap) return _cache.topSalesMap;
  const map = {};
  (db.sales || []).forEach(s => {
    (s.items || []).forEach(i => {
      map[i.productId] = (map[i.productId] || 0) + (i.qty || 1);
    });
  });
  _cache.topSalesMap = map;
  return map;
}

function renderTopProducts() {
  const container = el('pos-top-products');
  if (!container) return;
  const salesMap = _buildTopSalesMap();
  const sorted = Object.entries(salesMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!sorted.length) {
    container.innerHTML = `<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:0.78rem">لا توجد مبيعات بعد</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  sorted.forEach(([pid, cnt]) => {
    const p = (db.products || []).find(x => x.id === pid);
    if (!p) return;
    const row = document.createElement('div');
    row.className = 'ptpc-row';
    row.onclick = () => addToCart(p.id);
    row.innerHTML = `
      <div class="ptpc-row-img">
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.parentElement.textContent='📦'">` : '📦'}
      </div>
      <div class="ptpc-row-name">${p.name}</div>
      <div class="ptpc-row-count">${cnt}</div>`;
    frag.appendChild(row);
  });
  container.innerHTML = '';
  container.appendChild(frag);
}

// تحديث رقم الفاتورة والتاريخ
function updatePosInvoiceMeta() {
  const nextNum = 'INV-' + String((db.sales || []).length + 1).padStart(4, '0');
  if (el('pos-inv-number')) el('pos-inv-number').textContent = nextNum;
  if (el('pos-inv-datetime')) {
    const now = new Date();
    el('pos-inv-datetime').textContent = now.toLocaleDateString('ar-EG') + ' — ' + now.toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit'});
  }
  if (el('pos-inv-cashier')) el('pos-inv-cashier').textContent = currentUser?.name || '—';
  // العملاء
  const custSel = el('pos-customer-select');
  if (custSel) {
    const curVal = custSel.value;
    custSel.innerHTML = '<option value="">👤 عميل نقدي</option>' +
      (db.customers || []).map(c => `<option value="${c.id}" ${c.id===curVal?'selected':''}>${c.name}</option>`).join('');
  }
}

// حساب الباقي
function calcChange() {
  const { total } = calcCart();
  const paid = parseFloat(el('pos-paid-amount')?.value || 0) || 0;
  const change = paid - total;
  if (el('pos-change-display')) {
    el('pos-change-display').textContent = change >= 0 ? fmt(change) : '—';
    el('pos-change-display').style.color = change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }
}

function posBarcodeScan() {
  const val = (el('pos-barcode-input')?.value || '').trim();
  if (val.length < 3) return;
  const p = (db.products || []).find(x => x.barcode === val);
  if (p) { addToCart(p.id); el('pos-barcode-input').value = ''; }
}

// ===== بحث سريع مع قائمة منسدلة =====
function showProductDropdown() {
  const q = (el('pos-search')?.value || '').trim().toLowerCase();
  const dropdown = el('pos-search-dropdown');
  if (!dropdown) return;
  if (!q) { dropdown.classList.remove('open'); return; }

  const results = (db.products || []).filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.barcode || '').includes(q) ||
    (p.category || '').toLowerCase().includes(q)
  ).slice(0, 8);

  if (!results.length) {
    dropdown.innerHTML = `<div class="psd-empty">لا توجد نتائج لـ "${q}"</div>`;
  } else {
    dropdown.innerHTML = results.map(p => `
      <div class="psd-row" onclick="addToCart('${p.id}'); closeDropdown()">
        <div class="psd-img">
          ${p.image ? `<img src="${p.image}" alt="${p.name}" onerror="this.parentElement.textContent='📦'">` : '📦'}
        </div>
        <div class="psd-info">
          <div class="psd-name">${p.name}</div>
          <div class="psd-cat">${p.category || ''}</div>
        </div>
        <div>
          <div class="psd-price">${fmtCurr(p.price)}</div>
          <div class="psd-stock">مخزون: ${p.qty || 0}</div>
        </div>
      </div>`).join('');
  }
  dropdown.classList.add('open');
}

function closeDropdown() {
  const d = el('pos-search-dropdown');
  if (d) { d.classList.remove('open'); }
  const s = el('pos-search');
  if (s) s.value = '';
  renderPosProducts();
}

// إغلاق الدروبداون عند النقر خارجه
document.addEventListener('click', function(e) {
  if (!e.target.closest('.pos-product-search-wrap')) closeDropdown();
});



function addToCart(pid) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;
  const existing = cart.find(x => x.productId === pid);
  if (existing) {
    if (existing.qty >= p.qty) { showToast('الكمية المتاحة: ' + p.qty, 'warning'); return; }
    existing.qty++;
    existing.subtotal = existing.qty * existing.price;
  } else {
    cart.push({
      productId: pid, name: p.name,
      price: parseFloat(p.price), cost: parseFloat(p.cost || 0),
      qty: 1, subtotal: parseFloat(p.price),
      unit: p.unit, discount: p.discount || 0,
      itemDiscount: 0, itemNote: '',
      image: p.image || '',
      barcode: p.barcode || ''
    });
  }
  renderCart();
  // Auto-refocus barcode input for fast scanning
  setTimeout(() => { const b = el('pos-barcode-input'); if (b && document.activeElement !== el('pos-search')) b.focus(); }, 50);
}

function changeQty(pid, delta) {
  const item = cart.find(x => x.productId === pid);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  const p = db.products.find(x => x.id === pid);
  if (p && item.qty > p.qty) { item.qty = p.qty; showToast('الكمية المتاحة: ' + p.qty, 'warning'); }
  recalcItemSubtotal(item);
  renderCart();
}

function recalcItemSubtotal(item) {
  const disc = parseFloat(item.itemDiscount || 0);
  const priceAfterDisc = item.price * (1 - disc / 100);
  item.subtotal = item.qty * priceAfterDisc;
}

function updateItemPrice(pid, val) {
  const item = cart.find(x => x.productId === pid);
  if (!item) return;
  item.price = parseFloat(val) || 0;
  recalcItemSubtotal(item);
  renderCart();
}

function updateItemDiscount(pid, val) {
  const item = cart.find(x => x.productId === pid);
  if (!item) return;
  item.itemDiscount = Math.min(100, Math.max(0, parseFloat(val) || 0));
  recalcItemSubtotal(item);
  renderCart();
}

function updateItemNote(pid, val) {
  const item = cart.find(x => x.productId === pid);
  if (!item) return;
  item.itemNote = val;
}

function removeFromCart(pid) {
  cart = cart.filter(x => x.productId !== pid);
  renderCart();
}

function clearCart() { cart = []; renderCart(); }

// ===== تعليق السلة =====
function suspendCart() {
  if (!cart.length) { showToast('السلة فارغة', 'warning'); return; }
  const name = prompt('اسم للسلة المعلقة (اختياري):', 'طلب ' + (suspendedCarts.length + 1));
  if (name === null) return; // cancelled
  suspendedCarts.push({
    id: Date.now(),
    name: name || ('طلب ' + (suspendedCarts.length + 1)),
    cart: JSON.parse(JSON.stringify(cart)),
    customerId: el('pos-customer-select')?.value || '',
    orderType: el('pos-order-type')?.value || 'استلام',
    payment: el('pos-payment-select')?.value || 'نقدي',
    notes: el('pos-notes')?.value || '',
    discount: el('pos-discount-input')?.value || 0,
    discountType: el('pos-discount-type')?.value || 'percent',
    time: new Date().toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' })
  });
  cart = [];
  if (el('pos-discount-input')) el('pos-discount-input').value = '';
  if (el('pos-notes')) el('pos-notes').value = '';
  renderCart();
  showToast('تم تعليق السلة ✅');
  updateSuspendedBadge();
}

function updateSuspendedBadge() {
  const badge = el('suspended-count-badge');
  if (badge) {
    badge.style.display = suspendedCarts.length > 0 ? 'flex' : 'none';
    badge.textContent = suspendedCarts.length;
  }
}

function openSuspendedList() {
  const content = el('suspended-list-content');
  if (!suspendedCarts.length) {
    content.innerHTML = '<div class="empty-state"><div class="empty-icon">🛒</div><p>لا توجد سلال معلقة</p></div>';
  } else {
    content.innerHTML = suspendedCarts.map(s => `
      <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <strong>${s.name}</strong>
            <span style="font-size:0.75rem;color:var(--text-muted);margin-right:8px">${s.time}</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary btn-sm" onclick="restoreSuspended(${s.id})"><i class="fa fa-rotate-right"></i> استعادة</button>
            <button class="btn btn-danger btn-sm" onclick="deleteSuspended(${s.id})"><i class="fa fa-trash"></i></button>
          </div>
        </div>
        <div style="font-size:0.8rem;color:var(--text-muted)">
          ${s.cart.map(i => i.name + ' ×' + i.qty).join(' | ')}
        </div>
        <div style="font-size:0.8rem;color:var(--accent-green);margin-top:4px;font-weight:700">
          ${fmtCurr(s.cart.reduce((a,i)=>a+i.subtotal,0))}
        </div>
      </div>
    `).join('');
  }
  openModal('suspended-modal');
}

function restoreSuspended(id) {
  const s = suspendedCarts.find(x => x.id === id);
  if (!s) return;
  if (cart.length && !confirm('السلة الحالية ستُفقد. هل تريد المتابعة؟')) return;
  cart = JSON.parse(JSON.stringify(s.cart));
  if (el('pos-customer-select')) el('pos-customer-select').value = s.customerId || '';
  if (el('pos-order-type')) el('pos-order-type').value = s.orderType || 'استلام';
  if (el('pos-payment-select')) el('pos-payment-select').value = s.payment || 'نقدي';
  if (el('pos-notes')) el('pos-notes').value = s.notes || '';
  if (el('pos-discount-input')) el('pos-discount-input').value = s.discount || 0;
  if (el('pos-discount-type')) el('pos-discount-type').value = s.discountType || 'percent';
  suspendedCarts = suspendedCarts.filter(x => x.id !== id);
  closeModal('suspended-modal');
  renderCart();
  showToast('تم استعادة السلة ✅');
}

function deleteSuspended(id) {
  suspendedCarts = suspendedCarts.filter(x => x.id !== id);
  openSuspendedList();
  updateSuspendedBadge();
}

function calcCart() {
  let sub = cart.reduce((a, i) => a + i.subtotal, 0);
  const discVal = parseFloat(el('pos-discount-input')?.value || 0) || 0;
  const discType = el('pos-discount-type')?.value || 'percent';
  const disc = discType === 'percent' ? (sub * discVal / 100) : discVal;
  const taxRate = parseFloat(db.settings.tax || 0);
  const afterDisc = sub - disc;
  const tax = afterDisc * taxRate / 100;
  const total = afterDisc + tax;
  return { sub, disc, tax, total };
}

function renderCart() {
  const { sub, disc, tax, total } = calcCart();
  const container = el('pos-cart-items');

  if (!cart.length) {
    container.innerHTML = `
      <div class="pit-empty">
        <div class="pit-empty-icon">🛒</div>
        <div class="pit-empty-text">السلة فارغة — أضف منتجات من اللوحة اليمنى</div>
      </div>`;
  } else {
    // DocumentFragment — zero reflow during construction
    const frag = document.createDocumentFragment();
    cart.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'pit-row';
      row.dataset.pid = item.productId;
      row.innerHTML = `
        <div class="pit-row-num">${idx + 1}</div>
        <div class="pit-row-img"><div class="pit-row-img-inner">
          ${item.image ? `<img src="${item.image}" alt="${item.name}" loading="lazy" onerror="this.style.display='none'">` : '📦'}
        </div></div>
        <div class="pit-row-name">${item.name}
          ${item.itemDiscount > 0 ? `<div style="font-size:0.68rem;color:#fbbf24;font-weight:600">خصم ${item.itemDiscount}%</div>` : ''}
        </div>
        <div class="pit-row-bar">${item.barcode || '—'}</div>
        <div class="pit-row-price">
          <input type="number" value="${item.price}" min="0" step="0.01"
            onchange="updateItemPrice('${item.productId}',this.value)" title="تعديل السعر">
        </div>
        <div class="pit-row-qty">
          <button class="pit-qty-btn" onclick="changeQty('${item.productId}',-1)">−</button>
          <div class="pit-qty-val">${item.qty}</div>
          <button class="pit-qty-btn" onclick="changeQty('${item.productId}',1)">+</button>
        </div>
        <div class="pit-row-unit">${item.unit || 'حبة'}</div>
        <div class="pit-row-total">${fmtCurr(item.subtotal)}</div>
        <div class="pit-row-del">
          <button class="pit-del-btn" onclick="removeFromCart('${item.productId}')" title="حذف">
            <i class="fa fa-trash"></i>
          </button>
        </div>`;
      frag.appendChild(row);
    });
    container.innerHTML = '';
    container.appendChild(frag);
    // Scroll to last added item
    container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Update totals (batch text updates)
  const currSym = curr();
  const updates = [
    ['pos-subtotal',      fmt(sub)  + ' ' + currSym],
    ['pos-discount-show', fmt(disc) + ' ' + currSym],
    ['pos-tax',           fmt(tax)  + ' ' + currSym],
    ['pos-total',         fmt(total)+ ' ' + currSym],
    ['pos-items-count',   cart.reduce((a,i)=>a+i.qty,0)],
    ['sidebar-cart-count',cart.length],
  ];
  updates.forEach(([id, val]) => { const e = el(id); if (e) e.textContent = val; });
  calcChange();
  updateSuspendedBadge();
}


// ===== أزرار الفاتورة الجديدة =====
function posHeatPrint() {
  if (!cart.length) { showToast('السلة فارغة', 'warning'); return; }
  const sale = _buildTempSale();
  printInvoice(sale);
}

function posPrintPDF() {
  if (!cart.length) { showToast('السلة فارغة', 'warning'); return; }
  const sale = _buildTempSale();
  exportSalePDF(sale);
}

function posSendWhatsApp() {
  if (!cart.length) { showToast('السلة فارغة', 'warning'); return; }
  const { total } = calcCart();
  const st = db.settings;
  const items = cart.map(i => `• ${i.name} × ${i.qty} = ${fmtCurr(i.subtotal)}`).join('\n');
  const custId = el('pos-customer-select')?.value || '';
  const cust = db.customers.find(c => c.id === custId);
  const phone = cust?.phone || '';
  const invNum = 'INV-' + String((db.sales || []).length + 1).padStart(4, '0');
  const msg = encodeURIComponent(
    `🧾 *فاتورة ${invNum}*\n` +
    `🏪 ${st.storeName || 'المتجر'}\n` +
    `━━━━━━━━━━━━━━\n` +
    items + '\n' +
    `━━━━━━━━━━━━━━\n` +
    `💰 *الإجمالي: ${fmtCurr(total)}*\n` +
    `📅 ${new Date().toLocaleDateString('ar-EG')}`
  );
  const url = phone ? `https://wa.me/${phone.replace(/\D/g,'')}?text=${msg}` : `https://wa.me/?text=${msg}`;
  window.open(url, '_blank');
}

// بناء كائن فاتورة مؤقتة للطباعة قبل الحفظ
function _buildTempSale() {
  const { sub, disc, tax, total } = calcCart();
  const custId = el('pos-customer-select')?.value || '';
  const cust = db.customers.find(c => c.id === custId);
  return {
    id: 'INV-' + String((db.sales || []).length + 1).padStart(4, '0'),
    date: new Date().toLocaleDateString('ar-EG'),
    ts: new Date().toISOString(),
    customerName: cust ? cust.name : 'عميل نقدي',
    items: cart.map(i => ({ ...i })),
    subtotal: sub, discount: disc, tax, total,
    payment: el('pos-payment-select')?.value || 'نقدي',
    orderType: el('pos-order-type')?.value || 'استلام',
    notes: el('pos-notes')?.value || '',
    cashier: currentUser?.name || ''
  };
}

function completeSale() {
  if (!cart.length) { showToast('السلة فارغة', 'warning'); return; }
  // ===== التحقق من الجلسة اليومية =====
  if (!db.sessions) db.sessions = [];
  let activeSession = db.sessions.find(s => s.status === 'open');
  // Auto-create session if none exists (admin convenience)
  if (!activeSession) {
    const now = new Date();
    activeSession = {
      id: 'S-' + Date.now(), status: 'open',
      openTime: now.toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit'}),
      openDate: now.toLocaleDateString('ar-EG'),
      openTs: now.toISOString(),
      openedBy: currentUser?.name || '—',
    };
    db.sessions.push(activeSession);
    updateNavSessionBadge?.();
  }
  const { sub, disc, tax, total } = calcCart();
  const custId = el('pos-customer-select')?.value || '';
  const cust = db.customers.find(c => c.id === custId);
  const payment = el('pos-payment-select')?.value || 'نقدي';
  const orderType = el('pos-order-type')?.value || 'استلام';
  const notes = el('pos-notes')?.value || '';
  const creditDays = payment === 'آجل' ? (parseInt(el('pos-credit-days')?.value || 0) || 0) : 0;

  // رقم فاتورة فريد يعتمد على timestamp لتفادي التكرار
  const invSeq = String((db.sales || []).length + 1).padStart(4, '0');
  const sale = {
    id: 'INV-' + invSeq,
    date: new Date().toLocaleDateString('ar-EG'),
    ts: new Date().toISOString(),
    customerId: custId,
    customerName: cust ? cust.name : 'عميل نقدي',
    items: cart.map(i => ({ ...i })),
    subtotal: sub, discount: disc, tax, total,
    payment, orderType, notes,
    creditDays,
    dueDate: creditDays > 0 ? (() => { const d = new Date(); d.setDate(d.getDate() + creditDays); return d.toLocaleDateString('ar-EG'); })() : null,
    cashier: currentUser?.name || '',
    cashierId: currentUser?.id || ''
  };

  // Deduct stock instantly
  cart.forEach(item => {
    const p = db.products.find(x => x.id === item.productId);
    if (p) p.qty = Math.max(0, p.qty - item.qty);
  });

  // Update customer balance if credit
  if (cust && payment === 'آجل') {
    cust.balance = (cust.balance || 0) + total;
  }

  // Treasury
  if (payment !== 'آجل') {
    db.treasury.push({ id: uid(), type: 'إيراد', desc: 'مبيعات فاتورة ' + sale.id, amount: total, date: sale.date, ts: sale.ts, ref: sale.id });
  }

  // ── المدفوع والمتبقي وحالة الفاتورة ──
  const salePaidInput = parseFloat(el('pos-paid-amount')?.value || 0) || 0;
  const salePaid      = payment === 'آجل' ? salePaidInput : total;
  const saleRemaining = Math.max(0, total - salePaid);
  sale.paidAmount     = salePaid;
  sale.remaining      = saleRemaining;
  sale.payStatus      = saleRemaining <= 0 ? 'paid' : (salePaid > 0 ? 'partial' : 'unpaid');

  // إذا دفع جزئياً مع آجل — تسجيل الجزء المدفوع في الخزنة وتخفيض الرصيد
  if (payment === 'آجل' && salePaid > 0 && saleRemaining > 0) {
    db.treasury.push({ id: uid(), type: 'إيراد', desc: 'دفعة مقدمة ' + sale.id, amount: salePaid, date: sale.date, ts: sale.ts, ref: sale.id });
    if (cust) cust.balance = Math.max(0, (cust.balance || 0) - salePaid);
  }

  db.sales.push(sale);

  // ── تسجيل حركة رصيد العميل إن كان الدفع آجل ──
  if (cust && payment === 'آجل') {
    if (!db.balanceMovements) db.balanceMovements = [];
    if (typeof addBalanceMovement === 'function') {
      addBalanceMovement({ type: 'sale_credit', entityId: cust.id, entityName: cust.name, entityType: 'customer', amount: total, invoiceNum: sale.id, notes: 'فاتورة بيع آجلة' });
    }
  }

  addLog('بيع', `فاتورة مبيعات ${sale.id} - ${fmtCurr(total)}`, 'بيع');
  
  // حفظ فوري بدون تأخير
  saveDBNow();
  invalidateCache('topSalesMap');
  
  // مسح السلة فوراً لتسريع الاستجابة
  cart = [];
  renderCart();
  if (el('pos-discount-input')) el('pos-discount-input').value = '';
  if (el('pos-notes')) el('pos-notes').value = '';
  if (el('pos-paid-amount')) el('pos-paid-amount').value = '';
  if (el('pos-credit-days')) el('pos-credit-days').value = '';
  const posCdw = document.getElementById('pos-credit-days-wrap');
  if (posCdw) posCdw.style.display = 'none';
  const posDuD = document.getElementById('pos-due-date-display');
  if (posDuD) posDuD.textContent = '';
  updatePosInvoiceMeta();
  scheduleRender(renderTopProducts);
  
  showToast(`✅ تم حفظ الفاتورة ${sale.id} — ${fmtCurr(total)}`, 'success');
  if(window.EventBus){EventBus.emit('sale:completed',sale);EventBus.emit('treasury:changed');}
  if (typeof erpRefreshFinancialDashboard === 'function') setTimeout(erpRefreshFinancialDashboard, 300);
  if (typeof erpCheckAlerts === 'function') setTimeout(erpCheckAlerts, 500);
  
  // طباعة بدون تأخير
  setTimeout(() => printInvoice(sale), 50);
}

// =========================================================
// ======= PRODUCTS ========================================
// =========================================================
function renderProductsPage() {
  const q = (el('products-search')?.value || '').toLowerCase();
  const cat = el('products-cat-filter')?.value || '';
  const catSel = el('products-cat-filter');
  if (catSel) catSel.innerHTML = '<option value="">كل الفئات</option>' + (db.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
  const prods = (db.products || []).filter(p => {
    const mq = !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q);
    const mc = !cat || p.category === cat;
    return mq && mc;
  });
  const threshold = db.settings.lowStock || 5;
  el('products-count').textContent = (db.products || []).length;
  el('products-low-count').textContent = (db.products || []).filter(p => p.qty <= threshold).length;
  el('products-total-value').textContent = fmtCurr(db.products.reduce((a, p) => a + (p.qty * (p.cost || p.price)), 0));
  el('products-tbody').innerHTML = prods.length ? prods.map(p => `
    <tr>
      <td><code style="font-size:0.75rem;color:var(--text-muted)">${p.barcode || '—'}</code></td>
      <td><strong>${p.name}</strong></td>
      <td>${p.category || '—'}</td>
      <td style="color:var(--accent-green);font-weight:700">${fmtCurr(p.price)}</td>
      <td style="color:var(--text-muted)">${fmtCurr(p.cost || 0)}</td>
      <td style="color:var(--accent-purple);font-weight:700">${p.wholesalePrice ? fmtCurr(p.wholesalePrice) + `<span style="font-size:0.65rem;color:var(--text-muted)"> (من ${p.wholesaleMin||10})</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span class="${p.qty <= threshold ? 'badge badge-red' : 'badge badge-green'}">${p.qty}</span></td>
      <td>${p.unit || '—'}</td>
      <td>${p.discount || 0}%</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="editProduct('${p.id}')"><i class="fa fa-pen"></i></button>
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="10" class="empty-state"><p>لا توجد منتجات</p></td></tr>';
}

function newProduct() {
  el('product-modal-title').textContent = 'إضافة منتج جديد';
  el('product-form-id').value = '';
  el('product-form-name').value = '';
  el('product-form-barcode').value = 'BC-' + Date.now().toString().slice(-6);
  el('product-form-price').value = '';
  el('product-form-cost').value = '';
  el('product-form-qty').value = '';
  el('product-form-discount').value = '';
  el('product-form-minstock').value = '5';
  el('product-form-image').value = '';
  if (el('product-form-wholesale')) el('product-form-wholesale').value = '';
  if (el('product-form-wholesale-min')) el('product-form-wholesale-min').value = '10';
  if (el('product-form-expiry')) { el('product-form-expiry').value = ''; }
  const prev = el('product-img-preview');
  if (prev) { prev.src = ''; prev.style.display = 'none'; }
  const ph = el('product-img-placeholder');
  if (ph) ph.style.display = 'flex';
  const fileInput = el('product-form-image-file');
  if (fileInput) fileInput.value = '';
  const catSel = el('product-form-category');
  catSel.innerHTML = (db.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
  openModal('product-modal');
}

function editProduct(pid) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;
  el('product-modal-title').textContent = 'تعديل المنتج';
  el('product-form-id').value = pid;
  el('product-form-name').value = p.name;
  el('product-form-barcode').value = p.barcode || '';
  el('product-form-price').value = p.price;
  el('product-form-cost').value = p.cost || '';
  el('product-form-qty').value = p.qty;
  el('product-form-discount').value = p.discount || 0;
  el('product-form-minstock').value = p.minStock || 5;
  el('product-form-image').value = p.image || '';
  if (el('product-form-wholesale')) el('product-form-wholesale').value = p.wholesalePrice || '';
  if (el('product-form-wholesale-min')) el('product-form-wholesale-min').value = p.wholesaleMin || 10;
  if (el('product-form-expiry')) { el('product-form-expiry').value = p.expiry || ''; _updateExpiryHint(p.expiry || ''); }
  const prev = el('product-img-preview');
  const ph = el('product-img-placeholder');
  if (p.image && prev) {
    prev.src = p.image; prev.style.display = 'block';
    if (ph) ph.style.display = 'none';
  } else {
    if (prev) { prev.src = ''; prev.style.display = 'none'; }
    if (ph) ph.style.display = 'flex';
  }
  const fileInput = el('product-form-image-file');
  if (fileInput) fileInput.value = '';
  const catSel = el('product-form-category');
  catSel.innerHTML = (db.categories || []).map(c => `<option value="${c}" ${p.category === c ? 'selected' : ''}>${c}</option>`).join('');
  openModal('product-modal');
}

function saveProduct() {
  const id = el('product-form-id').value;
  const name = el('product-form-name').value.trim();
  if (!name) { showToast('أدخل اسم المنتج', 'warning'); return; }
  const wholesaleVal = el('product-form-wholesale')?.value;
  const expiryVal   = el('product-form-expiry')?.value || '';
  const prod = {
    name,
    barcode:       el('product-form-barcode').value.trim() || 'BC-' + Date.now(),
    price:         parseFloat(el('product-form-price').value) || 0,
    cost:          parseFloat(el('product-form-cost').value) || 0,
    qty:           parseFloat(el('product-form-qty').value) || 0,
    category:      el('product-form-category').value,
    unit:          el('product-form-unit').value,
    discount:      parseFloat(el('product-form-discount').value) || 0,
    minStock:      parseFloat(el('product-form-minstock').value) || 5,
    image:         el('product-form-image').value || '',
    wholesalePrice: wholesaleVal ? parseFloat(wholesaleVal) : null,
    wholesaleMin:  parseInt(el('product-form-wholesale-min')?.value || 10) || 10,
    expiry:        expiryVal,
  };
  if (id) {
    const i = db.products.findIndex(x => x.id === id);
    if (i > -1) { db.products[i] = { ...db.products[i], ...prod }; addLog('تعديل', `تعديل منتج: ${name}`, 'تعديل'); }
  } else {
    db.products.push({ id: uid(), ...prod });
    addLog('تعديل', `إضافة منتج: ${name}`, 'تعديل');
  }
  invalidateCache('catOptions', 'topSalesMap', 'wsTopMap', 'expiryData');
  saveDB();
  closeModal('product-modal');
  renderProductsPage();
  checkExpiryAlerts();
  if(window.EventBus)EventBus.emit('inventory:changed');
  showToast('تم حفظ المنتج');
}

function previewProductImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('حجم الصورة يجب أن يكون أقل من 2MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    el('product-form-image').value = dataUrl;
    const prev = el('product-img-preview');
    const ph = el('product-img-placeholder');
    if (prev) { prev.src = dataUrl; prev.style.display = 'block'; }
    if (ph) ph.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function clearProductImage() {
  el('product-form-image').value = '';
  const prev = el('product-img-preview');
  const ph = el('product-img-placeholder');
  if (prev) { prev.src = ''; prev.style.display = 'none'; }
  if (ph) ph.style.display = 'flex';
  const fileInput = el('product-form-image-file');
  if (fileInput) fileInput.value = '';
}

function deleteProduct(pid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('هل تريد حذف هذا المنتج؟')) return;
  const p = db.products.find(x => x.id === pid);
  db.products = db.products.filter(x => x.id !== pid);
  addLog('حذف', `حذف منتج: ${p?.name || pid}`, 'حذف');
  saveDB();
  renderProductsPage();
  showToast('تم الحذف');
}

// =========================================================
// ======= SALES ===========================================
// =========================================================
function renderSalesPage() {
  const q = (el('sales-search')?.value || '').toLowerCase();
  const pf = el('sales-payment-filter')?.value || '';
  const sales = [...(db.sales || [])].reverse().filter(s => {
    const mq = !q || (s.id || '').toLowerCase().includes(q) || (s.customerName || '').toLowerCase().includes(q);
    const mp = !pf || s.payment === pf;
    return mq && mp;
  });
  const returns = db.returns || [];
  el('sales-total-count').textContent = db.sales.length;
  el('sales-total-amount').textContent = fmtCurr(db.sales.reduce((a, s) => a + (s.total || 0), 0));
  el('sales-total-returns').textContent = fmtCurr(returns.reduce((a, r) => a + (r.amount || 0), 0));
  el('sales-tbody').innerHTML = sales.length ? sales.map(s => {
    const payStatus = s.payStatus || (s.payment === 'آجل' ? 'unpaid' : 'paid');
    const stColors = { paid: 'var(--accent-green)', partial: 'var(--accent-orange)', unpaid: 'var(--accent-red)' };
    const stLabels = { paid: '✅ مكتمل', partial: '⚡ جزئي', unpaid: '❌ غير مدفوع' };
    const remaining = s.remaining !== undefined ? s.remaining : (payStatus === 'unpaid' ? s.total : 0);
    const paidAmt   = s.paidAmount !== undefined ? s.paidAmount : (payStatus === 'paid' ? s.total : 0);
    return `<tr>
      <td><span class="badge badge-blue">${s.id}</span></td>
      <td>${s.date || ''}</td>
      <td>${s.customerName || 'نقدي'}</td>
      <td style="color:var(--text-muted);font-size:0.78rem">${(s.items || []).map(i => i.name).join(', ').slice(0, 35)}...</td>
      <td style="color:var(--accent-green);font-weight:700">${fmtCurr(s.total)}</td>
      <td style="font-size:0.78rem">
        <div style="color:var(--text-muted)">مدفوع: <span style="color:var(--accent-green);font-weight:700">${fmtCurr(paidAmt)}</span></div>
        ${remaining > 0 ? `<div style="color:var(--text-muted)">متبقي: <span style="color:var(--accent-red);font-weight:700">${fmtCurr(remaining)}</span></div>` : ''}
      </td>
      <td><span style="font-size:0.75rem;font-weight:700;color:${stColors[payStatus]||'var(--text-muted)'}">${stLabels[payStatus]||'—'}</span></td>
      <td>
        <span class="badge badge-${s.payment === 'آجل' ? 'orange' : 'green'}">${s.payment}</span>
        ${s.dueDate && s.payment === 'آجل' ? `<div style="font-size:0.73rem;color:var(--accent-orange);margin-top:2px">📅 ${s.dueDate}</div>` : ''}
      </td>
      <td style="color:var(--text-muted);font-size:0.78rem">${s.cashier || '—'}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="viewSale('${s.id}')"><i class="fa fa-eye"></i></button>
          <button class="btn btn-warning btn-sm" onclick="quickReturn('${s.id}')" title="مرتجع"><i class="fa fa-rotate-left"></i></button>
          ${s.payment === 'آجل' && remaining > 0 && s.customerId ? `<button class="btn btn-success btn-sm" onclick="openPayCustomerModal('${s.customerId}')" title="سداد"><i class="fa fa-money-bill"></i></button>` : ''}
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteSale('${s.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty-state"><p>لا توجد فواتير</p></td></tr>';
}

function viewSale(sid) {
  const s = db.sales.find(x => x.id === sid);
  if (!s) return;
  el('view-sale-content').innerHTML = `
    <div style="padding:8px 0">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:1.1rem;font-weight:900">${db.settings.storeName}</div>
          <div style="font-size:0.8rem;color:var(--text-muted)">${db.settings.address || ''}</div>
        </div>
        <div style="text-align:left">
          <div style="font-size:1rem;font-weight:700;color:var(--accent-blue)">${s.id}</div>
          <div style="font-size:0.8rem;color:var(--text-muted)">${s.date}</div>
        </div>
      </div>
      <div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:16px">
        <div style="font-size:0.82rem;color:var(--text-muted)">العميل: <strong style="color:var(--text)">${s.customerName || 'نقدي'}</strong></div>
        <div style="font-size:0.82rem;color:var(--text-muted)">الدفع: <strong style="color:var(--text)">${s.payment}</strong></div>
        ${s.creditDays > 0 ? `<div style="font-size:0.82rem;color:var(--text-muted)">الأجل: <strong style="color:var(--accent-orange)">${s.creditDays} يوم</strong></div>` : ''}
        ${s.dueDate ? `<div style="font-size:0.82rem;color:var(--text-muted)">تاريخ الاستحقاق: <strong style="color:var(--accent-orange)">📅 ${s.dueDate}</strong></div>` : ''}
        <div style="font-size:0.82rem;color:var(--text-muted)">الكاشير: <strong style="color:var(--text)">${s.cashier || '—'}</strong></div>
      </div>
      <table style="margin-bottom:16px">
        <thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
        <tbody>${(s.items || []).map(i => `<tr><td>${i.name}</td><td>${i.qty}</td><td>${fmtCurr(i.price)}</td><td>${fmtCurr(i.subtotal)}</td></tr>`).join('')}</tbody>
      </table>
      <div style="background:var(--bg3);border-radius:10px;padding:14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.85rem"><span>المجموع الفرعي</span><span>${fmtCurr(s.subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.85rem;color:var(--accent-red)"><span>الخصم</span><span>- ${fmtCurr(s.discount)}</span></div>
        ${(s.tax||0)>0?`<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.85rem"><span>الضريبة</span><span>${fmtCurr(s.tax)}</span></div>`:''}
        <div style="display:flex;justify-content:space-between;font-size:1.05rem;font-weight:900;border-top:1px solid var(--border);padding-top:10px;margin-top:6px"><span>الإجمالي النهائي</span><span style="color:var(--accent-green)">${fmtCurr(s.total)}</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.9rem"><span>المدفوع</span><span style="color:var(--accent-green);font-weight:700">${fmtCurr(s.paidAmount||0)}</span></div>
        ${(s.remaining||0)>0?`<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:0.9rem"><span>المتبقي</span><span style="color:var(--accent-red);font-weight:700">${fmtCurr(s.remaining)}</span></div>`:''}
        <div style="margin-top:10px;padding:8px;border-radius:8px;text-align:center;background:${(()=>{const ps=s.payStatus||(s.payment==='آجل'?'unpaid':'paid');return ps==='paid'?'#38a16922':ps==='partial'?'#f9731622':'#e53e3e22'})()};font-weight:800;font-size:0.9rem;color:${(()=>{const ps=s.payStatus||(s.payment==='آجل'?'unpaid':'paid');return ps==='paid'?'#38a169':ps==='partial'?'#f97316':'#e53e3e'})()}">
          ${(()=>{const ps=s.payStatus||(s.payment==='آجل'?'unpaid':'paid');return ps==='paid'?'✅ مدفوعة بالكامل':ps==='partial'?'⚡ مدفوعة جزئياً':'❌ غير مدفوعة'})()}
        </div>
      </div>
      ${s.notes ? `<div style="margin-top:10px;font-size:0.8rem;color:var(--text-muted)">ملاحظات: ${s.notes}</div>` : ''}
      <div class="btn-group" style="margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="printInvoice(db.sales.find(x=>x.id==='${s.id}'))"><i class="fa fa-print"></i> طباعة</button>
        <button class="btn btn-blue" onclick="exportSalePDF(db.sales.find(x=>x.id==='${s.id}'))"><i class="fa fa-file-pdf"></i> تصدير PDF</button>
        <button class="btn btn-warning" onclick="closeModal('view-sale-modal');quickReturn('${s.id}')"><i class="fa fa-rotate-left"></i> مرتجع</button>
        ${s.payment==='آجل'&&(s.remaining||0)>0&&s.customerId?`<button class="btn btn-success" onclick="closeModal('view-sale-modal');openPayCustomerModal('${s.customerId}')"><i class="fa fa-money-bill"></i> سداد</button>`:''}
      </div>
    </div>
  `;
  openModal('view-sale-modal');
}

function deleteSale(sid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('هل تريد حذف هذه الفاتورة؟')) return;
  const s = db.sales.find(x => x.id === sid);
  db.sales = db.sales.filter(x => x.id !== sid);
  addLog('حذف', `حذف فاتورة: ${sid}`, 'حذف');
  saveDB();
  renderSalesPage();
  showToast('تم الحذف');
}

function _buildInvoiceHTML(sale, forPDF) {
  const st = db.settings;
  const cur = st.currency || 'جنيه';
  const now = new Date(sale.ts || Date.now());
  const dateStr = sale.date || now.toLocaleDateString('ar-EG');
  const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cashier = sale.cashier || sale.user || (currentUser ? currentUser.name : '—');
  const customer = sale.customerName || 'عميل نقدي';
  const payment = sale.payment || 'نقدي';
  const orderType = sale.orderType || 'استلام';
  const storeName = st.storeName || 'حاسبني';
  const address = st.address || '';
  const phone = st.contact || '';
  const notes = sale.notes || st.invoiceNotes || 'شكراً لتعاملكم معنا';
  const subtotal = parseFloat(sale.subtotal) || 0;
  const discount = parseFloat(sale.discount) || 0;
  const tax = parseFloat(sale.tax) || 0;
  const total = parseFloat(sale.total) || 0;
  const paperW = parseInt(st.paperWidth || 80);
  const nameSize = parseInt(st.storeNameSize || 22);
  const dataSize = parseInt(st.dataTextSize || 12);
  const storeLogo = st.storeLogo || '';

  // Pixel width: 72mm≈272px, 76mm≈287px, 80mm≈302px
  const pxMap = {72: 272, 76: 287, 80: 302};
  const pxW = pxMap[paperW] || 302;

  const logoHTML = storeLogo
    ? `<img src="${storeLogo}" style="max-width:80px;max-height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto;object-fit:contain">`
    : `<div style="font-size:${nameSize}px;font-weight:900;letter-spacing:1px;margin-bottom:2px">${storeName}</div>`;

  const itemsRows = (sale.items || []).map(i => {
    const price = parseFloat(i.price) || 0;
    const qty = parseInt(i.qty) || 1;
    const sub = parseFloat(i.subtotal) || (price * qty);
    const noteRow = i.itemNote ? `<tr><td colspan="4" style="font-size:${dataSize-1}px;color:#555;padding:0 6px 4px;font-style:italic">↳ ${i.itemNote}</td></tr>` : '';
    const discRow = (i.itemDiscount && i.itemDiscount > 0) ? `<tr><td colspan="4" style="font-size:${dataSize-1}px;color:#c00;padding:0 6px 2px">خصم ${i.itemDiscount}%</td></tr>` : '';
    return `<tr>
      <td style="padding:5px 6px;max-width:90px;word-break:break-word;font-size:${dataSize}px">${i.name || ''}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${qty}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${price.toFixed(2)}</td>
      <td style="text-align:left;padding:5px 6px;font-weight:700;font-size:${dataSize}px">${sub.toFixed(2)}</td>
    </tr>${discRow}${noteRow}`;
  }).join('');

  const printBtn = forPDF ? '' : `<div style="display:flex;gap:6px;margin-top:14px;display:none" class="no-print">
    <button onclick="window.print()" style="flex:1;padding:8px;background:#000;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:'Cairo',sans-serif;font-size:13px;font-weight:700">🖨️ طباعة</button>
  </div>`;

  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>فاتورة ${sale.id}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Cairo','Courier New',monospace;background:#e0e0e0;display:flex;flex-direction:column;align-items:center;padding:20px;color:#000}
.receipt{background:#fff;width:${pxW}px;padding:0;color:#000!important;box-shadow:0 2px 20px rgba(0,0,0,.25);position:relative}
.receipt *{color:#000!important}
/* شريط تزيين حراري - الأعلى */
.perf-top,.perf-bottom{height:8px;width:100%;background:repeating-linear-gradient(90deg,#fff 0,#fff 6px,#d0d0d0 6px,#d0d0d0 8px);display:block}
.receipt-inner{padding:14px 12px}
.header{text-align:center;padding-bottom:10px;margin-bottom:10px}
.store-sub{font-size:${dataSize}px;line-height:1.7;font-weight:700;text-align:center}
.divider-dashed{border:none;border-top:1px dashed #555;margin:8px 0}
.divider-solid{border:none;border-top:2px solid #000;margin:8px 0}
.meta-row{display:flex;justify-content:space-between;align-items:center;font-size:${dataSize}px;line-height:2}
.meta-row .lbl{font-weight:700}
.meta-row .val{font-weight:900;font-size:${dataSize+1}px}
.badge-box{display:inline-block;border:1.5px solid #000;border-radius:4px;padding:2px 12px;font-size:${dataSize}px;font-weight:900;margin:4px 3px}
table{width:100%;border-collapse:collapse;margin:8px 0}
thead tr{border-bottom:2px solid #000;border-top:2px solid #000}
th{font-size:${dataSize}px;font-weight:900;padding:6px 5px;text-align:right;background:#f5f5f5}
th:last-child{text-align:left}
th:nth-child(2),th:nth-child(3){text-align:center}
tbody tr{border-bottom:1px solid #aaa}
tbody tr:last-child{border-bottom:2px solid #000}
td{vertical-align:top}
.totals-row{display:flex;justify-content:space-between;font-size:${dataSize}px;font-weight:700;padding:4px 0;border-bottom:1px dotted #ccc}
.grand-row{display:flex;justify-content:space-between;font-size:${dataSize+2}px;font-weight:900;border-top:2px solid #000;border-bottom:2px solid #000;padding:8px 0;margin-top:6px}
.payment-row{font-size:${dataSize}px;text-align:center;margin-top:8px;font-weight:700}
.footer{text-align:center;margin-top:10px;border-top:1px dashed #555;padding-top:10px;font-size:${dataSize}px;line-height:2}
.footer .thanks{font-size:${dataSize+2}px;font-weight:900}
@media print{
  @page{size:${paperW}mm auto;margin:0}
  body{background:none;padding:0}
  .receipt{box-shadow:none;width:100%}
  .no-print{display:none!important}
}
</style></head>
<body><div class="receipt">
<div class="perf-top"></div>
<div class="receipt-inner">
  <div class="header">
    ${logoHTML}
    ${storeLogo ? `<div style="font-size:${nameSize}px;font-weight:900;margin-bottom:2px">${storeName}</div>` : ''}
    ${address ? `<div class="store-sub">${address}</div>` : ''}
    ${phone ? `<div class="store-sub">${phone}</div>` : ''}
    <hr class="divider-dashed" style="margin-top:8px">
    <div style="font-size:${dataSize+2}px;font-weight:900;text-align:center">فاتورة بيع</div>
  </div>
  <div style="margin-bottom:8px;border-bottom:1px dashed #555;padding-bottom:8px">
    <div class="meta-row"><span class="lbl">رقم الفاتورة:</span><span class="val">${sale.id}</span></div>
    <div class="meta-row"><span class="lbl">التاريخ:</span><span class="val">${dateStr}</span></div>
    <div class="meta-row"><span class="lbl">الوقت:</span><span class="val">${timeStr}</span></div>
    <div class="meta-row"><span class="lbl">الكاشير:</span><span class="val">${cashier}</span></div>
    ${customer !== 'عميل نقدي' ? `<div class="meta-row"><span class="lbl">العميل:</span><span class="val">${customer}</span></div>` : ''}
  </div>
  <table>
    <thead><tr>
      <th>الصنف</th>
      <th style="text-align:center">الكمية</th>
      <th style="text-align:center">السعر</th>
      <th style="text-align:left">الإجمالي</th>
    </tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div style="margin-top:6px">
    <div class="totals-row"><span>المجموع الفرعي</span><span>${subtotal.toFixed(2)}</span></div>
    ${discount > 0 ? `<div class="totals-row" style="color:#c00"><span>خصم</span><span>- ${discount.toFixed(2)}</span></div>` : ''}
    ${tax > 0 ? `<div class="totals-row"><span>ضريبة (${st.tax || 0}%)</span><span>${tax.toFixed(2)}</span></div>` : ''}
    ${discount === 0 ? `<div class="totals-row"><span>خصم</span><span>0.00</span></div>` : ''}
    ${tax === 0 ? `<div class="totals-row"><span>ضريبة (0%)</span><span>0.00</span></div>` : ''}
  </div>
  <div class="grand-row">
    <span>الإجمالي</span>
    <span>${total.toFixed(2)} ${cur}</span>
  </div>
  <div class="payment-row">طريقة الدفع: ${payment}</div>
  ${sale.creditDays > 0 ? `<div class="payment-row" style="color:#c07000">الأجل: ${sale.creditDays} يوم — الاستحقاق: ${sale.dueDate}</div>` : ''}
  <div style="text-align:center;margin:6px 0"><span class="badge-box">${orderType}</span></div>
  <hr class="divider-dashed">
  <div class="footer">
    <div class="thanks">${notes}</div>
    ${phone ? `<div style="margin-top:4px;font-weight:700">${phone}</div>` : ''}
    <div style="font-size:${dataSize-1}px;margin-top:4px;color:#555">الفاتورة صادرة إلكترونياً ولا تحتاج إلى توقيع</div>
  </div>
</div>
<div class="perf-bottom"></div>
</div>
${printBtn}
<script>window.onload=function(){setTimeout(()=>window.print(),400)}<\/script>
</body></html>`;
}

/* ========= FAST INVOICE PRINT — iframe approach (instant, no popup) ========= */
let _printFrame = null;
function _ensurePrintFrame() {
  if (_printFrame && document.contains(_printFrame)) return _printFrame;
  _printFrame = document.createElement('iframe');
  _printFrame.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0;opacity:0';
  _printFrame.id = 'hassibni-print-frame';
  document.body.appendChild(_printFrame);
  return _printFrame;
}

// ========= طباعة عامة موحّدة (تُستخدم لكل الفواتير والتقارير) =========
// تطبع أي HTML مباشرة عبر iframe مخفي (الأسرع والأكثر موثوقية داخل Electron)
// مع نظام احتياطي تلقائي في حال فشلت الطريقة الأولى
function _printDocument(html) {
  try {
    const frame = _ensurePrintFrame();
    const fdoc = frame.contentWindow.document;
    fdoc.open();
    fdoc.write(html);
    fdoc.close();
    frame.contentWindow.onload = null;
    setTimeout(() => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch(e) { _printFallback(html); }
    }, 150);
  } catch(e) {
    _printFallback(html);
  }
}

// فتح أي مستند HTML في نافذة معاينة (بدون طباعة فورية) — لزر "معاينة"
function _openPreviewWindow(html) {
  try {
    const w = window.open('', '_blank', 'width=460,height=720');
    if (w) { w.document.write(html); w.document.close(); return; }
  } catch (e) { /* تجاهل والانتقال للاحتياطي */ }
  // احتياطي: إن تعذّر فتح نافذة، نعرض الفاتورة داخل الصفحة الحالية
  _printInvoiceFallback_v2_inner(html);
}

function printInvoice(sale) {
  _printDocument(_buildInvoiceHTML(sale, false));
}

function _printFallback(html) {
  const w = window.open('', '_blank', 'width=420,height=700');
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 300); return; }
  _printInvoiceFallback_v2_inner(html);
}

function _printInvoiceFallback_v2(sale) {
  const html = _buildInvoiceHTML(sale, false);
  _printInvoiceFallback_v2_inner(html);
}

function _printInvoiceFallback_v2_inner(html) {
  let area = document.getElementById('print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'print-area';
    area.style.cssText = 'position:fixed;top:0;left:0;width:100%;z-index:99999;background:#fff';
    document.body.appendChild(area);
  }
  area.innerHTML = `<div style="display:flex;justify-content:center;padding:20px">${html}</div>`;
  window.print();
  setTimeout(() => { area.innerHTML = ''; }, 2000);
}

function exportSalePDF(sale) {
  const html = _buildInvoiceHTML(sale, true);
  const w = window.open('', '_blank', 'width=420,height=700');
  if (w) {
    w.document.write(html.replace('<script>', `<script>
window.onload = function() {
  window.print();
  setTimeout(() => window.close(), 2000);
};
`));
    w.document.close();
  }
}

// طباعة احتياطية في حالة حظر النوافذ
function _printInvoiceFallback(data) {
  const st = db.settings;
  const cur = data.currency || 'جنيه';
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl">
  <head><meta charset="UTF-8"><title>فاتورة ${data.invoice_number}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Cairo',monospace;background:#f0f0f0;padding:20px;display:flex;justify-content:center}
    .receipt{background:#fff;width:300px;padding:14px;font-size:12px;color:#000;box-shadow:0 2px 10px rgba(0,0,0,.15)}
    .header{text-align:center;border-bottom:1px dashed #333;padding-bottom:8px;margin-bottom:8px}
    .store-name{font-size:20px;font-weight:900}
    .store-sub{font-size:10px;color:#555;line-height:1.7}
    .meta{border-bottom:1px dashed #333;padding-bottom:8px;margin-bottom:6px}
    .row{display:flex;justify-content:space-between;font-size:11px;line-height:2}
    table{width:100%;border-collapse:collapse;margin:8px 0}
    thead tr{border-bottom:2px solid #000}
    th,td{font-size:11px;padding:4px 3px;text-align:right}
    th:last-child,td:last-child{text-align:left;font-weight:700}
    th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:center}
    tbody tr{border-bottom:1px dotted #ccc}
    .divider{border:none;border-top:2px solid #000;margin:6px 0}
    .total-row{display:flex;justify-content:space-between;font-size:11.5px;padding:3px 0}
    .grand{font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:8px;margin-top:4px}
    .footer{text-align:center;margin-top:10px;font-size:11px;color:#555;line-height:1.8}
    .badge{display:inline-block;border:1px solid #000;border-radius:4px;padding:1px 10px;font-size:11px;font-weight:700;margin:4px 2px}
    @media print{body{background:none;padding:0}.receipt{box-shadow:none;width:100%}}
  </style></head>
  <body><div class="receipt">
    <div class="header">
      <div class="store-name">${data.store.name}</div>
      ${data.store.address ? `<div class="store-sub">${data.store.address}</div>` : ''}
      ${data.store.phone ? `<div class="store-sub">📞 ${data.store.phone}</div>` : ''}
    </div>
    <div class="meta">
      <div class="row"><span>رقم الطلب:</span><span><b>${data.invoice_number}</b></span></div>
      <div class="row"><span>التاريخ:</span><span>${data.date}</span></div>
      <div class="row"><span>الكاشير:</span><span>${data.cashier}</span></div>
      ${data.customer !== 'نقدي' ? `<div class="row"><span>العميل:</span><span>${data.customer}</span></div>` : ''}
    </div>
    <div style="text-align:center;margin:4px 0">
      <span class="badge">${data.payment}</span>
      <span class="badge">${data.orderType}</span>
    </div>
    <hr class="divider">
    <table>
      <thead><tr><th>الصنف</th><th>ك</th><th>سعر</th><th>البسا</th></tr></thead>
      <tbody>
        ${(data.items||[]).map(i=>`<tr>
          <td>${i.name}</td>
          <td>${i.qty}</td>
          <td>${(+i.price).toFixed(2)}</td>
          <td>${(+(i.subtotal)||(+i.price)*(+i.qty)).toFixed(2)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <hr class="divider">
    <div class="total-row"><span>المجموع الفرعي</span><span>${(+data.subtotal).toFixed(2)} ${cur}</span></div>
    ${data.discount>0?`<div class="total-row" style="color:#c00"><span>الخصم</span><span>- ${(+data.discount).toFixed(2)} ${cur}</span></div>`:''}
    ${data.tax>0?`<div class="total-row"><span>الضريبة</span><span>${(+data.tax).toFixed(2)} ${cur}</span></div>`:''}
    <div class="total-row grand"><span>الإجمالي:</span><span>${(+data.total).toFixed(2)} ${cur}</span></div>
    <div style="border-top:1px dashed #999;margin:8px 0"></div>
    <div class="footer">
      <div style="font-size:13px;font-weight:700;color:#000">${data.invoiceNotes}</div>
      <div style="font-size:9px;color:#aaa;margin-top:4px">Powered by حاسبني</div>
    </div>
  </div>
  <script>window.print();<\/script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=380,height=650');
  if (w) { w.document.write(html); w.document.close(); }
}

// =========================================================
// ======= RETURNS (NEW) ===================================
// =========================================================
function renderReturnsPage() {
  const returns = db.returns || [];
  el('ret-count').textContent = returns.length;
  el('ret-total').textContent = fmtCurr(returns.reduce((a, r) => a + (r.amount || 0), 0));
  el('ret-stock-updates').textContent = returns.length;
  el('returns-tbody').innerHTML = returns.length ? [...returns].reverse().map(r => `
    <tr>
      <td><span class="badge badge-red">RET-${r.id}</span></td>
      <td><span class="badge badge-blue">${r.invoiceId || '—'}</span></td>
      <td>${r.date || ''}</td>
      <td>${r.customerName || '—'}</td>
      <td>${r.productName || '—'}</td>
      <td>${r.qty}</td>
      <td style="color:var(--accent-red);font-weight:700">${fmtCurr(r.amount)}</td>
      <td><span class="badge badge-orange">${r.reason || '—'}</span></td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${r.user || '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="printReturnInvoice('${r.id}')"><i class="fa fa-print"></i></button></td>
    </tr>
  `).join('') : '<tr><td colspan="10" class="empty-state"><p>لا توجد مرتجعات</p></td></tr>';

  const purRets = db.purchaseReturns || [];
  el('purchase-returns-tbody').innerHTML = purRets.length ? [...purRets].reverse().map(r => `
    <tr>
      <td><span class="badge badge-orange">PRET-${r.id}</span></td>
      <td>${r.date || ''}</td>
      <td>${r.supplierName || '—'}</td>
      <td>${r.productName || '—'}</td>
      <td>${r.qty}</td>
      <td style="color:var(--accent-orange);font-weight:700">${fmtCurr(r.amount)}</td>
      <td><span class="badge badge-orange">${r.reason || '—'}</span></td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${r.user || '—'}</td>
    </tr>
  `).join('') : '<tr><td colspan="8" class="empty-state"><p>لا توجد مرتجعات مشتريات</p></td></tr>';
}

function switchReturnTab(tab) {
  el('return-tab-sales').style.display = tab === 'sales' ? '' : 'none';
  el('return-tab-purchases').style.display = tab === 'purchases' ? '' : 'none';
  document.querySelectorAll('#page-returns .tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'sales') || (i === 1 && tab === 'purchases'));
  });
}

function openNewReturnModal() {
  el('return-invoice-id').value = '';
  el('return-invoice-details').style.display = 'none';
  openModal('return-modal');
}

function quickReturn(sid) {
  el('return-invoice-id').value = sid;
  openModal('return-modal');
  lookupReturnInvoice();
}

let returnInvoiceRef = null;

function lookupReturnInvoice() {
  const sid = el('return-invoice-id').value.trim();
  const sale = db.sales.find(s => s.id === sid || s.id.includes(sid));
  if (!sale) { showToast('لم يتم العثور على الفاتورة', 'error'); return; }
  returnInvoiceRef = sale;
  el('return-invoice-id').value = sale.id;
  el('return-invoice-info').innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.85rem">
      <div><span style="color:var(--text-muted)">العميل:</span> <strong>${sale.customerName || 'نقدي'}</strong></div>
      <div><span style="color:var(--text-muted)">التاريخ:</span> <strong>${sale.date}</strong></div>
      <div><span style="color:var(--text-muted)">الإجمالي:</span> <strong style="color:var(--accent-green)">${fmtCurr(sale.total)}</strong></div>
      <div><span style="color:var(--text-muted)">الدفع:</span> <strong>${sale.payment}</strong></div>
    </div>
  `;
  const prodSel = el('return-product-select');
  prodSel.innerHTML = (sale.items || []).map(i => `<option value="${i.productId}" data-price="${i.price}" data-qty="${i.qty}">${i.name} (مشتراة: ${i.qty})</option>`).join('');
  el('return-invoice-details').style.display = '';
  calcReturnAmount();
}

function calcReturnAmount() {
  const sel = el('return-product-select');
  if (!sel || !sel.options[sel.selectedIndex]) return;
  const price = parseFloat(sel.options[sel.selectedIndex].dataset.price) || 0;
  const qty = parseInt(el('return-qty').value) || 1;
  const amount = price * qty;
  el('return-amount-display').textContent = fmtCurr(amount);
}

function confirmReturn() {
  if (!returnInvoiceRef) { showToast('اختر فاتورة أولاً', 'warning'); return; }
  const sel = el('return-product-select');
  const opt = sel.options[sel.selectedIndex];
  const pid = opt.value;
  const price = parseFloat(opt.dataset.price) || 0;
  const maxQty = parseInt(opt.dataset.qty) || 1;
  const qty = parseInt(el('return-qty').value) || 1;
  if (qty > maxQty) { showToast(`الحد الأقصى للإرجاع: ${maxQty}`, 'warning'); return; }
  const reason = el('return-reason').value;
  const refundType = el('return-refund-type').value;
  const notes = el('return-notes').value;
  const amount = price * qty;

  // Restore stock
  const prod = db.products.find(x => x.id === pid);
  if (prod) prod.qty += qty;

  // Deduct from treasury if cash refund
  if (refundType === 'نقدي') {
    db.treasury.push({ id: uid(), type: 'مصروف', desc: 'مرتجع مبيعات - ' + returnInvoiceRef.id, amount, date: new Date().toLocaleDateString('ar-EG'), ts: new Date().toISOString() });
  }

  const ret = {
    id: Date.now().toString(36),
    invoiceId: returnInvoiceRef.id,
    customerId: returnInvoiceRef.customerId,
    customerName: returnInvoiceRef.customerName,
    productId: pid,
    productName: opt.text.split(' (')[0],
    qty, amount, reason, refundType, notes,
    date: new Date().toLocaleDateString('ar-EG'),
    ts: new Date().toISOString(),
    user: currentUser?.name || ''
  };

  if (!db.returns) db.returns = [];
  db.returns.push(ret);
  addLog('مرتجع', `مرتجع مبيعات ${returnInvoiceRef.id} - ${ret.productName} - ${fmtCurr(amount)}`, 'مرتجع');
  saveDB();
  closeModal('return-modal');
  showToast('تم تسجيل المرتجع وتحديث المخزون ✅');
  renderReturnsPage();
}

function openPurchaseReturnModal() {
  const supSel = el('pret-supplier');
  supSel.innerHTML = (db.suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  const prodSel = el('pret-product');
  prodSel.innerHTML = (db.products || []).map(p => `<option value="${p.id}" data-cost="${p.cost || 0}">${p.name}</option>`).join('');
  openModal('purchase-return-modal');
}

function calcPurchaseReturnAmount() {
  const sel = el('pret-product');
  const cost = parseFloat(sel.options[sel.selectedIndex]?.dataset.cost) || 0;
  const qty = parseInt(el('pret-qty').value) || 1;
  const amount = cost * qty;
  el('pret-amount').value = amount;
  el('pret-amount-display').textContent = '(' + fmtCurr(amount) + ')';
}

function confirmPurchaseReturn() {
  const supSel = el('pret-supplier');
  const prodSel = el('pret-product');
  const qty = parseInt(el('pret-qty').value) || 1;
  const amount = parseFloat(el('pret-amount').value) || 0;
  const reason = el('pret-reason').value;
  const pid = prodSel.value;

  // Deduct stock
  const prod = db.products.find(x => x.id === pid);
  if (prod) prod.qty = Math.max(0, prod.qty - qty);

  // Reduce supplier balance if applicable
  const sup = db.suppliers.find(x => x.id === supSel.value);

  const ret = {
    id: Date.now().toString(36),
    supplierId: supSel.value,
    supplierName: sup ? sup.name : '',
    productId: pid,
    productName: prodSel.options[prodSel.selectedIndex]?.text || '',
    qty, amount, reason,
    date: new Date().toLocaleDateString('ar-EG'),
    ts: new Date().toISOString(),
    user: currentUser?.name || ''
  };

  if (!db.purchaseReturns) db.purchaseReturns = [];
  db.purchaseReturns.push(ret);
  addLog('مرتجع', `مرتجع مشتريات - ${ret.productName} - ${fmtCurr(amount)}`, 'مرتجع');
  saveDB();
  closeModal('purchase-return-modal');
  showToast('تم تسجيل مرتجع المشتريات ✅');
  renderReturnsPage();
}

function printReturnInvoice(rid) {
  const r = (db.returns || []).find(x => x.id === rid);
  if (!r) return;
  const st = db.settings;
  const html = `
    <div style="font-family:'Cairo',sans-serif;padding:20px;font-size:13px;color:#000;max-width:380px;margin:0 auto">
      <div style="text-align:center;margin-bottom:12px">
        <div style="font-size:18px;font-weight:900">${st.storeName || 'المتجر'}</div>
        <div style="color:#c00;font-weight:700;font-size:14px;margin-top:6px">⚠️ إشعار مرتجع</div>
      </div>
      <hr style="border:1px dashed #999;margin:10px 0">
      <div style="margin-bottom:5px">رقم المرتجع: <b>RET-${r.id}</b></div>
      <div style="margin-bottom:5px">فاتورة أصلية: <b>${r.invoiceId || '—'}</b></div>
      <div style="margin-bottom:5px">العميل: <b>${r.customerName || '—'}</b></div>
      <div style="margin-bottom:5px">المنتج: <b>${r.productName}</b></div>
      <div style="margin-bottom:5px">الكمية: <b>${r.qty}</b></div>
      <div style="margin-bottom:5px">السبب: ${r.reason || '—'}</div>
      <div style="margin-bottom:5px">التاريخ: ${r.date}</div>
      <hr style="border:1px dashed #999;margin:10px 0">
      <div style="font-size:15px;font-weight:900;display:flex;justify-content:space-between">
        <span>المبلغ المسترد:</span><span style="color:#c00">${fmt(r.amount)} ${st.currency || 'جنيه'}</span>
      </div>
      <hr style="border:1px dashed #999;margin:10px 0">
      <div style="text-align:center;font-size:11px;color:#555">تم المرتجع بواسطة: ${r.user || '—'}</div>
    </div>
  `;
  let printArea = document.getElementById('print-area');
  if (!printArea) {
    printArea = document.createElement('div');
    printArea.id = 'print-area';
    document.body.appendChild(printArea);
  }
  printArea.innerHTML = html;
  window.print();
  setTimeout(() => { printArea.innerHTML = ''; }, 1000);
}

// =========================================================
// ======= PURCHASES POS — نظام فاتورة الشراء الكامل ======
// =========================================================

let purCart = []; // سلة الشراء

// --- تبويبات صفحة المشتريات ---
function switchPurchaseTab(tab) {
  el('pur-pos-panel').style.display   = tab === 'pos'  ? 'flex' : 'none';
  el('pur-list-panel').style.display  = tab === 'list' ? 'flex' : 'none';
  el('pur-tab-pos').classList.toggle('active',  tab === 'pos');
  el('pur-tab-list').classList.toggle('active', tab === 'list');
  if (tab === 'list') renderPurchasesList();
}

// --- تهيئة صفحة المشتريات ---
function renderPurchasesPage() {
  // ملء قائمة الموردين
  const supSel = el('pur-supplier-select');
  if (supSel) {
    const cur = supSel.value;
    supSel.innerHTML = '<option value="">🏭 مورد نقدي</option>' +
      (db.suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    supSel.value = cur;
  }

  // ملء فلتر الفئات
  const catSel = el('pur-cat-filter');
  if (catSel) {
    const cats = [...new Set((db.products || []).map(p => p.category).filter(Boolean))];
    catSel.innerHTML = '<option value="all">كل الفئات</option>' +
      cats.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  // تحديث بيانات الفاتورة
  const now = new Date();
  const dtEl = el('pur-inv-datetime');
  if (dtEl) dtEl.textContent = now.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });

  const numEl = el('pur-inv-number');
  if (numEl) {
    const count = (db.purchases || []).length + 1;
    numEl.textContent = 'PO-' + String(count).padStart(4, '0');
  }

  const cashierEl = el('pur-inv-cashier');
  if (cashierEl && db.currentUser) cashierEl.textContent = db.currentUser.name || '—';

  // تحديث شبكة المنتجات
  renderPurProductsGrid();
  renderPurTopProducts();
  renderPurchaseCart();
}

// --- شبكة المنتجات الصغيرة ---
function renderPurProductsGrid() {
  const grid = el('pur-products-grid');
  if (!grid) return;
  const q = (el('pur-search')?.value || '').toLowerCase();
  const cat = el('pur-cat-filter')?.value || 'all';
  let prods = (db.products || []).filter(p => {
    const matchQ = !q || p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q);
    const matchC = cat === 'all' || p.category === cat;
    return matchQ && matchC;
  });
  if (!prods.length) { grid.innerHTML = '<div class="psd-empty">لا توجد منتجات</div>'; return; }
  grid.innerHTML = prods.map(p => `
    <div class="pos-product-card-sm" onclick="addToPurchaseCart('${p.id}')">
      <div class="ppcs-img">${p.image ? `<img src="${p.image}">` : (p.emoji || '📦')}</div>
      <div class="ppcs-name">${p.name}</div>
      <div class="ppcs-price" style="color:var(--accent-orange)">${fmtCurr(p.cost || 0)}</div>
      <div class="ppcs-stock" style="font-size:0.7rem;color:var(--text-muted)">مخزون: ${p.qty || 0}</div>
    </div>
  `).join('');
}

// --- قائمة بحث منسدلة ---
function showPurchaseDropdown() {
  const q = (el('pur-search')?.value || '').trim().toLowerCase();
  const cat = el('pur-cat-filter')?.value || 'all';
  const dd = el('pur-search-dropdown');
  if (!dd) return;
  renderPurProductsGrid();
  if (!q) { dd.classList.remove('open'); return; }
  let prods = (db.products || []).filter(p => {
    const matchQ = p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q);
    const matchC = cat === 'all' || p.category === cat;
    return matchQ && matchC;
  }).slice(0, 8);
  if (!prods.length) {
    dd.innerHTML = '<div class="psd-empty">لا توجد نتائج</div>';
    dd.classList.add('open');
    return;
  }
  dd.innerHTML = prods.map(p => `
    <div class="psd-row" onclick="addToPurchaseCart('${p.id}');el('pur-search').value='';el('pur-search-dropdown').classList.remove('open');renderPurProductsGrid()">
      <div class="psd-img">${p.image ? `<img src="${p.image}">` : (p.emoji || '📦')}</div>
      <div class="psd-info">
        <div class="psd-name">${p.name}</div>
        <div class="psd-cat">${p.category || ''} | باركود: ${p.barcode || '—'}</div>
      </div>
      <div>
        <div class="psd-price">${fmtCurr(p.cost || 0)}</div>
        <div class="psd-stock">مخزون: ${p.qty || 0}</div>
      </div>
    </div>
  `).join('');
  dd.classList.add('open');
}

// --- مسح بالباركود ---
function purBarcodeScan() {
  const val = (el('pur-barcode-input')?.value || '').trim();
  if (!val) return;
  const prod = (db.products || []).find(p => (p.barcode || '') === val);
  if (prod) {
    addToPurchaseCart(prod.id);
    setTimeout(() => { if(el('pur-barcode-input')) el('pur-barcode-input').value = ''; }, 300);
  }
}

// --- إضافة منتج للسلة ---
function addToPurchaseCart(productId) {
  const prod = (db.products || []).find(p => p.id === productId);
  if (!prod) return;
  const existing = purCart.find(x => x.productId === productId);
  if (existing) {
    existing.qty++;
  } else {
    purCart.push({
      productId: prod.id,
      name: prod.name,
      barcode: prod.barcode || '',
      unit: prod.unit || 'قطعة',
      cost: prod.cost || 0,
      image: prod.image || '',
      emoji: prod.emoji || '',
      qty: 1
    });
  }
  renderPurchaseCart();
  renderPurTopProducts();
}

// --- تغيير الكمية ---
function changePurQty(productId, delta) {
  const item = purCart.find(x => x.productId === productId);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  renderPurchaseCart();
}

// --- تغيير سعر الشراء مباشرة ---
function changePurCost(productId, val) {
  const item = purCart.find(x => x.productId === productId);
  if (item) { item.cost = parseFloat(val) || 0; renderPurchaseCart(); }
}

// --- حذف من السلة ---
function removePurItem(productId) {
  purCart = purCart.filter(x => x.productId !== productId);
  renderPurchaseCart();
  renderPurTopProducts();
}

// --- رسم السلة ---
function renderPurchaseCart() {
  const container = el('pur-cart-items');
  if (!container) return;
  if (!purCart.length) {
    container.innerHTML = '<div class="empty-state" style="padding:40px"><div class="empty-icon">🛒</div><p>ابحث عن منتج لإضافته إلى سلة المشتريات</p></div>';
    el('pur-subtotal').textContent = '0.00';
    el('pur-discount-show').textContent = '0.00';
    el('pur-tax').textContent = '0.00';
    el('pur-total').textContent = '0.00';
    return;
  }

  container.innerHTML = purCart.map((item, i) => `
    <div class="pos-cart-row">
      <div class="pit-col pit-col-num">${i + 1}</div>
      <div class="pit-col pit-col-img">
        <div class="pos-item-img">${item.image ? `<img src="${item.image}">` : (item.emoji || '📦')}</div>
      </div>
      <div class="pit-col pit-col-name" style="font-weight:700">${item.name}</div>
      <div class="pit-col pit-col-bar" style="font-size:0.75rem;color:var(--text-muted)">${item.barcode || '—'}</div>
      <div class="pit-col pit-col-price">
        <input type="number" value="${item.cost.toFixed(2)}" min="0" step="0.01"
          class="pit-price-input"
          style="width:80px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:3px 6px;background:var(--bg3);color:var(--text);font-size:0.85rem"
          onchange="changePurCost('${item.productId}', this.value)">
      </div>
      <div class="pit-col pit-col-qty">
        <div class="pit-qty-ctrl">
          <button class="pit-qty-btn" onclick="changePurQty('${item.productId}', 1)">+</button>
          <span class="pit-qty-num">${item.qty}</span>
          <button class="pit-qty-btn" onclick="changePurQty('${item.productId}', -1)">−</button>
        </div>
      </div>
      <div class="pit-col pit-col-unit" style="font-size:0.8rem;color:var(--text-muted)">${item.unit}</div>
      <div class="pit-col pit-col-total" style="color:var(--accent-orange);font-weight:800">${fmtCurr(item.cost * item.qty)}</div>
      <div class="pit-col pit-col-del">
        <button class="pit-del-btn" onclick="removePurItem('${item.productId}')"><i class="fa fa-trash"></i></button>
      </div>
    </div>
  `).join('');

  // حساب المجاميع
  const sub = purCart.reduce((s, x) => s + x.cost * x.qty, 0);
  const discVal = el('pur-discount-input')?.value || 0;
  const discType = el('pur-discount-type')?.value || 'percent';
  let discAmt = discType === 'percent' ? sub * (parseFloat(discVal) || 0) / 100 : (parseFloat(discVal) || 0);
  discAmt = Math.min(discAmt, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - discAmt;
  const taxAmt = afterDisc * taxRate;
  const grand = afterDisc + taxAmt;

  el('pur-subtotal').textContent = sub.toFixed(2);
  el('pur-discount-show').textContent = discAmt.toFixed(2);
  el('pur-tax').textContent = taxAmt.toFixed(2);
  el('pur-total').textContent = grand.toFixed(2);
}

// --- أكثر المنتجات شراءً ---
function renderPurTopProducts() {
  const tEl = el('pur-top-products');
  if (!tEl) return;
  if (!purCart.length) { tEl.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:6px">لا توجد مشتريات بعد</div>'; return; }
  const sorted = [...purCart].sort((a, b) => b.qty - a.qty).slice(0, 5);
  tEl.innerHTML = sorted.map(item => `
    <div class="ptpc-item" onclick="addToPurchaseCart('${item.productId}')">
      <div class="ptpc-item-img">${item.image ? `<img src="${item.image}" style="width:100%;height:100%;object-fit:cover;border-radius:5px">` : (item.emoji || '📦')}</div>
      <div class="ptpc-item-info">
        <div class="ptpc-item-name">${item.name}</div>
        <div class="ptpc-item-price" style="color:var(--accent-orange)">${fmtCurr(item.cost)}</div>
      </div>
      <span style="font-size:0.72rem;padding:2px 7px;border-radius:10px;background:rgba(251,146,60,0.15);color:var(--accent-orange);font-weight:700">×${item.qty}</span>
    </div>
  `).join('');
}

// --- مسح السلة ---
function clearPurchaseCart() {
  purCart = [];
  if (el('pur-discount-input')) el('pur-discount-input').value = '';
  if (el('pur-notes')) el('pur-notes').value = '';
  if (el('pur-search')) el('pur-search').value = '';
  if (el('pur-credit-days')) el('pur-credit-days').value = '';
  const cdw = document.getElementById('pur-credit-days-wrap');
  if (cdw) cdw.style.display = 'none';
  renderPurchaseCart();
  renderPurTopProducts();
  renderPurProductsGrid();
}

// --- حفظ فاتورة الشراء ---
function completePurchase() {
  if (!purCart.length) { showToast('السلة فارغة!', 'warning'); return; }

  const supplierId = el('pur-supplier-select')?.value || '';
  const sup = supplierId ? (db.suppliers || []).find(s => s.id === supplierId) : null;
  const payment = el('pur-payment-select')?.value || 'نقدي';
  const notes = el('pur-notes')?.value || '';
  const orderType = el('pur-order-type')?.value || 'استلام';
  const creditDays = payment === 'آجل' ? (parseInt(el('pur-credit-days')?.value || 0) || 0) : 0;

  const sub = purCart.reduce((s, x) => s + x.cost * x.qty, 0);
  const discVal = parseFloat(el('pur-discount-input')?.value || 0);
  const discType = el('pur-discount-type')?.value || 'percent';
  let discAmt = discType === 'percent' ? sub * discVal / 100 : discVal;
  discAmt = Math.min(discAmt, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - discAmt;
  const taxAmt = afterDisc * taxRate;
  const grand = afterDisc + taxAmt;

  const now = new Date();
  const count = (db.purchases || []).length + 1;
  const invNum = 'PO-' + String(count).padStart(4, '0');

  // تحديث المخزون وأسعار التكلفة
  purCart.forEach(item => {
    const prod = (db.products || []).find(p => p.id === item.productId);
    if (prod) {
      prod.qty = (prod.qty || 0) + item.qty;
      prod.cost = item.cost; // تحديث سعر الشراء الأخير
    }
  });

  // تسجيل في الخزنة إن نقدي
  if (payment === 'نقدي') {
    db.treasury.push({
      id: uid(), type: 'مصروف',
      desc: `فاتورة شراء ${invNum}`,
      amount: grand,
      date: now.toLocaleDateString('ar-EG'),
      ts: now.toISOString()
    });
  }

  const purchase = {
    id: uid(),
    invNum,
    date: now.toLocaleDateString('ar-EG'),
    ts: now.toISOString(),
    supplierId,
    supplierName: sup?.name || 'مورد نقدي',
    items: purCart.map(x => ({ ...x })),
    // للتوافق مع الكود القديم
    productId: purCart[0]?.productId || '',
    productName: purCart.length === 1 ? purCart[0].name : `${purCart.length} منتجات`,
    qty: purCart.reduce((s, x) => s + x.qty, 0),
    cost: purCart[0]?.cost || 0,
    subtotal: sub,
    discount: discAmt,
    tax: taxAmt,
    total: grand,
    payment,
    notes,
    orderType,
    creditDays,
    dueDate: creditDays > 0 ? (() => { const d = new Date(); d.setDate(d.getDate() + creditDays); return d.toLocaleDateString('ar-EG'); })() : null,
    cashier: db.currentUser?.name || '—'
  };

  // ── المدفوع والمتبقي وحالة الفاتورة ──
  const purPaidInput  = parseFloat(el('pur-paid-amount')?.value || 0) || 0;
  // المدفوع لا يمكن أن يتجاوز إجمالي الفاتورة
  const purPaid       = payment === 'آجل' ? Math.min(purPaidInput, grand) : grand;
  const purRemaining  = Math.max(0, grand - purPaid);
  purchase.paidAmount = purPaid;
  purchase.remaining  = purRemaining;
  purchase.payStatus  = purRemaining <= 0 ? 'paid' : (purPaid > 0 ? 'partial' : 'unpaid');

  // ── تحديث رصيد المورد: يُضاف فقط المبلغ "المتبقي" غير المدفوع ──
  // (وليس إجمالي الفاتورة كاملاً) — هذا هو المبلغ الذي يصبح ديناً على المنشأة للمورد
  if (payment === 'آجل' && sup && purRemaining > 0) {
    sup.balance = (sup.balance || 0) + purRemaining;
  }

  // إن وُجدت دفعة مقدمة (جزئية أو كاملة) مع آجل → تُسجَّل في الخزنة كمصروف فعلي
  if (payment === 'آجل' && purPaid > 0) {
    db.treasury.push({ id: uid(), type: 'مصروف', desc: `دفعة مقدمة فاتورة شراء ${invNum} — ${sup?.name || 'مورد نقدي'}`, amount: purPaid, date: now.toLocaleDateString('ar-EG'), ts: now.toISOString() });
  }

  if (!db.purchases) db.purchases = [];
  db.purchases.push(purchase);
  addLog('شراء', `فاتورة شراء ${invNum} - ${sup?.name || 'نقدي'} - ${fmtCurr(grand)}`, 'شراء');

  // ── تسجيل حركة رصيد المورد في كشف الحساب وإنشاء دين مرتبط ──
  if (payment === 'آجل' && sup && purRemaining > 0) {
    if (!db.balanceMovements) db.balanceMovements = [];
    if (typeof addBalanceMovement === 'function') {
      // المتبقي فقط هو ما يُحسب ديناً على المنشأة لصالح المورد
      addBalanceMovement({
        type: 'purchase_credit', entityId: sup.id, entityName: sup.name, entityType: 'supplier',
        amount: purRemaining, invoiceNum: invNum,
        notes: purPaid > 0
          ? `فاتورة شراء آجلة (إجمالي ${fmtCurr(grand)} — مدفوع مقدماً ${fmtCurr(purPaid)})`
          : 'فاتورة شراء آجلة',
        runningBal: sup.balance
      });
      // إن دُفع جزء من الفاتورة فوراً، نسجل حركة دفع مقابلة لتوضيح ذلك في كشف الحساب
      if (purPaid > 0) {
        addBalanceMovement({
          type: 'supplier_payment', entityId: sup.id, entityName: sup.name, entityType: 'supplier',
          amount: purPaid, invoiceNum: invNum,
          notes: `دفعة مقدمة عند الشراء — فاتورة ${invNum}`,
          runningBal: sup.balance
        });
      }
    }

    // ── إنشاء سجل دين في db.debts مرتبط بالفاتورة ──
    // هذا يجعل الدين يظهر في صفحة الأرصدة (تبويب الديون) وصفحة الموردين
    if (!db.debts) db.debts = [];
    const debtId = uid();
    const dueDate = purchase.dueDate || (creditDays > 0
      ? (() => { const d = new Date(); d.setDate(d.getDate() + creditDays); return d.toLocaleDateString('ar-EG'); })()
      : null);
    db.debts.unshift({
      id: debtId,
      entityId: sup.id,
      entityName: sup.name,
      entityType: 'supplier',
      amount: purRemaining,
      paid: 0,
      status: 'open',
      desc: `فاتورة شراء ${invNum}`,
      date: now.toLocaleDateString('ar-EG'),
      dueDate: dueDate || '',
      notes: purPaid > 0
        ? `إجمالي الفاتورة ${fmtCurr(grand)} — مدفوع مقدماً ${fmtCurr(purPaid)}`
        : `فاتورة شراء آجلة — أيام الأجل: ${creditDays}`,
      ts: now.toISOString(),
      invoiceRef: purchase.id,  // ربط الدين بالفاتورة
      invoiceNum: invNum
    });
    // ربط الفاتورة بمعرف الدين لاحقاً
    purchase.debtId = debtId;
  } else if (payment === 'آجل' && sup) {
    // تسجيل حركة دفع مقدمة فقط (الفاتورة مسددة كاملاً مقدماً)
    if (typeof addBalanceMovement === 'function') {
      addBalanceMovement({
        type: 'supplier_payment', entityId: sup.id, entityName: sup.name, entityType: 'supplier',
        amount: purPaid, invoiceNum: invNum,
        notes: `دفعة كاملة عند الشراء — فاتورة ${invNum}`,
        runningBal: sup.balance || 0
      });
    }
  }

  saveDB();

  showToast(`✅ تم حفظ فاتورة الشراء ${invNum}`);
  if (typeof erpRefreshFinancialDashboard === 'function') setTimeout(erpRefreshFinancialDashboard, 300);
  if (typeof erpCheckAlerts === 'function') setTimeout(erpCheckAlerts, 500);

  // طباعة الفاتورة تلقائياً (مع تفاصيل المدفوع/المتبقي/الحالة)
  setTimeout(() => purchasePrintPDF(purchase), 80);

  clearPurchaseCart();

  // تحديث رقم الفاتورة
  const nextCount = (db.purchases || []).length + 1;
  const numEl = el('pur-inv-number');
  if (numEl) numEl.textContent = 'PO-' + String(nextCount).padStart(4, '0');
}

// --- بناء HTML فاتورة الشراء (بنفس تصميم فاتورة المبيعات الحرارية) ---
function _buildPurchaseInvoiceHTML(purchase, forPDF) {
  const st = db.settings || {};
  const cur = st.currency || 'جنيه';
  const now = new Date(purchase.ts || Date.now());
  const dateStr = purchase.date || now.toLocaleDateString('ar-EG');
  const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cashier = purchase.cashier || (currentUser ? currentUser.name : '—');
  const suppName = purchase.supplierName || 'مورد نقدي';
  const paymentMethod = purchase.payment || 'نقدي';
  const storeName = st.storeName || 'حاسبني';
  const address = st.address || '';
  const phone = st.contact || '';
  const sub = parseFloat(purchase.subtotal) || 0;
  const discAmt = parseFloat(purchase.discount) || 0;
  const taxAmt = parseFloat(purchase.tax) || 0;
  const grand = parseFloat(purchase.total) || 0;
  const paidAmount = purchase.paidAmount ?? grand;
  const remaining = purchase.remaining ?? 0;
  const payStatus = purchase.payStatus || (remaining > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'paid');
  const items = purchase.items || [];
  const invNum = purchase.invNum || 'PO-????';
  const paperW = parseInt(st.paperWidth || 80);
  const nameSize = parseInt(st.storeNameSize || 22);
  const dataSize = parseInt(st.dataTextSize || 12);
  const storeLogo = st.storeLogo || '';

  const pxMap = {72: 272, 76: 287, 80: 302};
  const pxW = pxMap[paperW] || 302;

  const logoHTML = storeLogo
    ? `<img src="${storeLogo}" style="max-width:80px;max-height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto;object-fit:contain">`
    : `<div style="font-size:${nameSize}px;font-weight:900;letter-spacing:1px;margin-bottom:2px">${storeName}</div>`;

  const itemsRows = items.map(i => {
    const cost = parseFloat(i.cost) || 0;
    const qty = parseFloat(i.qty) || 0;
    const subT = cost * qty;
    return `<tr>
      <td style="padding:5px 6px;max-width:90px;word-break:break-word;font-size:${dataSize}px">${i.name || ''}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${qty}${i.unit ? ' ' + i.unit : ''}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${cost.toFixed(2)}</td>
      <td style="text-align:left;padding:5px 6px;font-weight:700;font-size:${dataSize}px">${subT.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const statusMap = {
    paid:    { text: '✅ مدفوعة بالكامل', color: '#16a34a' },
    partial: { text: '⚡ مدفوعة جزئياً',   color: '#d97706' },
    unpaid:  { text: '❌ غير مدفوعة',     color: '#dc2626' }
  };
  const stt = statusMap[payStatus] || statusMap.unpaid;

  const printBtn = forPDF ? '' : `<div class="no-print" style="display:none"></div>`;

  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>فاتورة شراء ${invNum}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Cairo','Courier New',monospace;background:#e0e0e0;display:flex;flex-direction:column;align-items:center;padding:20px;color:#000}
.receipt{background:#fff;width:${pxW}px;padding:0;color:#000!important;box-shadow:0 2px 20px rgba(0,0,0,.25);position:relative}
.receipt *{color:#000!important}
.perf-top,.perf-bottom{height:8px;width:100%;background:repeating-linear-gradient(90deg,#fff 0,#fff 6px,#d0d0d0 6px,#d0d0d0 8px);display:block}
.receipt-inner{padding:14px 12px}
.header{text-align:center;padding-bottom:10px;margin-bottom:10px}
.store-sub{font-size:${dataSize}px;line-height:1.7;font-weight:700;text-align:center}
.divider-dashed{border:none;border-top:1px dashed #555;margin:8px 0}
.meta-row{display:flex;justify-content:space-between;align-items:center;font-size:${dataSize}px;line-height:2}
.meta-row .lbl{font-weight:700}
.meta-row .val{font-weight:900;font-size:${dataSize+1}px}
.badge-box{display:inline-block;border:1.5px solid #000;border-radius:4px;padding:2px 12px;font-size:${dataSize}px;font-weight:900;margin:4px 3px}
table{width:100%;border-collapse:collapse;margin:8px 0}
thead tr{border-bottom:2px solid #000;border-top:2px solid #000}
th{font-size:${dataSize}px;font-weight:900;padding:6px 5px;text-align:right;background:#f5f5f5}
th:last-child{text-align:left}
th:nth-child(2),th:nth-child(3){text-align:center}
tbody tr{border-bottom:1px solid #aaa}
tbody tr:last-child{border-bottom:2px solid #000}
.totals-row{display:flex;justify-content:space-between;font-size:${dataSize}px;font-weight:700;padding:4px 0;border-bottom:1px dotted #ccc}
.grand-row{display:flex;justify-content:space-between;font-size:${dataSize+2}px;font-weight:900;border-top:2px solid #000;border-bottom:2px solid #000;padding:8px 0;margin-top:6px;color:#1a56db}
.status-row{font-size:${dataSize+1}px;text-align:center;margin-top:8px;font-weight:900}
.payment-row{font-size:${dataSize}px;text-align:center;margin-top:6px;font-weight:700}
.footer{text-align:center;margin-top:10px;border-top:1px dashed #555;padding-top:10px;font-size:${dataSize}px;line-height:2}
@media print{
  @page{size:${paperW}mm auto;margin:0}
  body{background:none;padding:0}
  .receipt{box-shadow:none;width:100%}
  .no-print{display:none!important}
}
</style></head>
<body><div class="receipt">
<div class="perf-top"></div>
<div class="receipt-inner">
  <div class="header">
    ${logoHTML}
    ${storeLogo ? `<div style="font-size:${nameSize}px;font-weight:900;margin-bottom:2px">${storeName}</div>` : ''}
    ${address ? `<div class="store-sub">${address}</div>` : ''}
    ${phone ? `<div class="store-sub">${phone}</div>` : ''}
    <hr class="divider-dashed" style="margin-top:8px">
    <div style="font-size:${dataSize+2}px;font-weight:900;text-align:center;color:#1a56db">🧾 فاتورة شراء (مشتريات)</div>
  </div>
  <div style="margin-bottom:8px;border-bottom:1px dashed #555;padding-bottom:8px">
    <div class="meta-row"><span class="lbl">رقم الفاتورة:</span><span class="val">${invNum}</span></div>
    <div class="meta-row"><span class="lbl">التاريخ:</span><span class="val">${dateStr}</span></div>
    <div class="meta-row"><span class="lbl">الوقت:</span><span class="val">${timeStr}</span></div>
    <div class="meta-row"><span class="lbl">المورد:</span><span class="val">${suppName}</span></div>
    <div class="meta-row"><span class="lbl">بواسطة:</span><span class="val">${cashier}</span></div>
  </div>
  <table>
    <thead><tr>
      <th>المنتج</th>
      <th style="text-align:center">الكمية</th>
      <th style="text-align:center">سعر الشراء</th>
      <th style="text-align:left">الإجمالي</th>
    </tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div style="margin-top:6px">
    <div class="totals-row"><span>المجموع الفرعي</span><span>${sub.toFixed(2)}</span></div>
    ${discAmt > 0 ? `<div class="totals-row" style="color:#c00"><span>خصم</span><span>- ${discAmt.toFixed(2)}</span></div>` : ''}
    ${taxAmt > 0 ? `<div class="totals-row"><span>ضريبة (${st.tax || 0}%)</span><span>${taxAmt.toFixed(2)}</span></div>` : ''}
  </div>
  <div class="grand-row">
    <span>الإجمالي</span>
    <span>${grand.toFixed(2)} ${cur}</span>
  </div>
  <div class="payment-row">طريقة الدفع: ${paymentMethod}</div>
  <div class="totals-row" style="color:#16a34a;margin-top:6px"><span>المدفوع</span><span>${paidAmount.toFixed(2)}</span></div>
  ${remaining > 0 ? `<div class="totals-row" style="color:#dc2626"><span>المتبقي (دين للمورد)</span><span>${remaining.toFixed(2)}</span></div>` : ''}
  ${purchase.dueDate ? `<div class="payment-row" style="color:#c07000">تاريخ الاستحقاق: ${purchase.dueDate}</div>` : ''}
  <div class="status-row" style="color:${stt.color}">${stt.text}</div>
  <hr class="divider-dashed">
  <div class="footer">
    <div style="font-size:${dataSize-1}px;color:#555">الفاتورة صادرة إلكترونياً ولا تحتاج إلى توقيع</div>
  </div>
</div>
<div class="perf-bottom"></div>
</div>
${printBtn}
${forPDF ? '' : `<script>window.onload=function(){setTimeout(()=>window.print(),400)}<\/script>`}
</body></html>`;
}

// --- تصدير / طباعة فاتورة الشراء ---
// يقبل اختيارياً كائن فاتورة شراء محفوظة (يحتوي على المدفوع/المتبقي/الحالة)
// إن لم يُمرَّر، يُنشئ معاينة من السلة الحالية (للفواتير غير المحفوظة)
function _buildPurchaseObjFromCart() {
  if (!purCart.length) return null;
  const items = purCart;
  const sub = purCart.reduce((s, x) => s + x.cost * x.qty, 0);
  const discVal = parseFloat(el('pur-discount-input')?.value || 0) || 0;
  const discType = el('pur-discount-type')?.value || 'percent';
  let discAmt = discType === 'percent' ? sub * discVal / 100 : discVal;
  discAmt = Math.min(discAmt, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - discAmt;
  const taxAmt = afterDisc * taxRate;
  const grand = afterDisc + taxAmt;
  const suppName = el('pur-supplier-select')?.options[el('pur-supplier-select').selectedIndex]?.text || 'مورد نقدي';
  const invNum = el('pur-inv-number')?.textContent || 'PO-????';
  const paymentMethod = el('pur-payment-select')?.value || 'نقدي';
  const paidAmount = paymentMethod === 'آجل' ? (parseFloat(el('pur-paid-amount')?.value || 0) || 0) : grand;
  const remaining = Math.max(0, grand - paidAmount);
  return {
    items, subtotal: sub, discount: discAmt, tax: taxAmt, total: grand,
    supplierName: suppName, invNum, payment: paymentMethod,
    paidAmount, remaining, payStatus: remaining <= 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid'),
    date: new Date().toLocaleDateString('ar-EG'), ts: new Date().toISOString()
  };
}

function purchasePrintPDF(purchaseObj) {
  const purchase = purchaseObj || _buildPurchaseObjFromCart();
  if (!purchase) { showToast('السلة فارغة', 'warning'); return; }
  _printDocument(_buildPurchaseInvoiceHTML(purchase, false));
}

function exportPurchasePDF(purchaseObj) {
  const purchase = purchaseObj || _buildPurchaseObjFromCart();
  if (!purchase) { showToast('السلة فارغة', 'warning'); return; }
  const html = _buildPurchaseInvoiceHTML(purchase, true);
  _openPreviewWindow(html.replace('<script>', `<script>
window.onload = function() {
  window.print();
};
`));
}

// --- قائمة الفواتير ---
function renderPurchasesList() {
  const purchases = db.purchases || [];
  const q = (el('pur-list-search')?.value || '').toLowerCase();
  const pf = el('pur-list-payment-filter')?.value || '';
  const filtered = purchases.filter(p => {
    const matchQ = !q || (p.supplierName || '').includes(q) || (p.productName || '').includes(q) || (p.invNum || '').includes(q);
    const matchP = !pf || p.payment === pf;
    return matchQ && matchP;
  });

  // إحصائيات
  const total = purchases.reduce((s, p) => s + (p.total || 0), 0);
  const credit = purchases.filter(p => p.payment === 'آجل').reduce((s, p) => s + (p.total || 0), 0);
  if (el('pur-list-count')) el('pur-list-count').textContent = purchases.length;
  if (el('pur-list-total')) el('pur-list-total').textContent = fmtCurr(total);
  if (el('pur-list-credit')) el('pur-list-credit').textContent = fmtCurr(credit);

  el('purchases-tbody').innerHTML = [...filtered].reverse().map(p => {
    const itemCount = p.items ? p.items.length : 1;
    const itemsLabel = p.items ? p.items.map(i => i.name).join('، ').substring(0, 40) + (p.items.length > 2 ? '...' : '') : (p.productName || '—');
    const purStatus = p.payStatus || (p.payment === 'آجل' ? 'unpaid' : 'paid');
    const psColors  = { paid: 'var(--accent-green)', partial: 'var(--accent-orange)', unpaid: 'var(--accent-red)' };
    const psLabels  = { paid: '✅ مكتمل', partial: '⚡ جزئي', unpaid: '❌ غير مدفوع' };
    const purRemain = p.remaining !== undefined ? p.remaining : (purStatus === 'unpaid' ? p.total : 0);
    const purPaid   = p.paidAmount !== undefined ? p.paidAmount : (purStatus === 'paid' ? p.total : 0);
    return `
    <tr>
      <td><span class="badge badge-blue">${p.invNum || 'PO-' + (p.id?.slice(-4) || '—')}</span></td>
      <td>${p.date || ''}</td>
      <td style="font-weight:600">${p.supplierName || '—'}</td>
      <td style="font-size:0.8rem;color:var(--text-muted)">${itemsLabel}</td>
      <td style="color:var(--accent-orange);font-weight:700">${fmtCurr(p.total)}</td>
      <td style="font-size:0.78rem">
        <div style="color:var(--text-muted)">مدفوع: <span style="color:var(--accent-green);font-weight:700">${fmtCurr(purPaid)}</span></div>
        ${purRemain > 0 ? `<div style="color:var(--text-muted)">متبقي: <span style="color:var(--accent-red);font-weight:700">${fmtCurr(purRemain)}</span></div>` : ''}
      </td>
      <td><span style="font-size:0.75rem;font-weight:700;color:${psColors[purStatus]||'var(--text-muted)'}">${psLabels[purStatus]||'—'}</span></td>
      <td>
        <span class="badge badge-${p.payment === 'آجل' ? 'orange' : 'green'}">${p.payment}</span>
        ${p.dueDate && p.payment === 'آجل' ? `<div style="font-size:0.73rem;color:var(--accent-orange);margin-top:2px">📅 ${p.dueDate}</div>` : ''}
        ${p.creditDays > 0 ? `<div style="font-size:0.72rem;color:var(--text-muted)">${p.creditDays} يوم</div>` : ''}
      </td>
      <td style="font-size:0.8rem">${p.cashier || '—'}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-primary btn-sm" onclick='purchasePrintPDF(db.purchases.find(x=>x.id===${JSON.stringify(p.id)}))' title="طباعة الفاتورة"><i class="fa fa-print"></i></button>
          ${p.payment === 'آجل' && purRemain > 0 && p.supplierId ? `<button class="btn btn-success btn-sm" onclick="openPaySupplierModal('${p.supplierId}')" title="دفع"><i class="fa fa-money-bill"></i></button>` : ''}
          ${p.supplierId ? `<button class="btn btn-ghost btn-sm" onclick="erpOpenEnhancedStatement('supplier','${p.supplierId}')" title="كشف"><i class="fa fa-file-invoice"></i></button>` : ''}
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deletePurchase('${p.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="empty-state"><p>لا توجد فواتير مشتريات</p></td></tr>';
}

// --- حذف فاتورة شراء ---
function deletePurchase(pid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('حذف فاتورة الشراء؟')) return;
  db.purchases = (db.purchases || []).filter(x => x.id !== pid);
  addLog('حذف', `حذف فاتورة شراء`, 'حذف');
  saveDB();
  renderPurchasesList();
}

// --- التوافق مع الكود القديم ---
function savePurchase() { completePurchase(); }

// =========================================================
// ======= CUSTOMERS =======================================
// =========================================================
function renderCustomersPage() {
  const q     = (el('customers-search')?.value || '').toLowerCase();
  const sort  = el('customers-sort')?.value || 'name';
  const custs = (db.customers || []).filter(c =>
    !q || c.name.toLowerCase().includes(q) || (c.phone||'').includes(q) || (c.email||'').includes(q)
  );
  const totalDebt     = custs.reduce((a,c) => a + (c.balance||0), 0);
  const withDebt      = custs.filter(c => (c.balance||0) > 0).length;
  const totalSalesAmt = custs.reduce((a,c) => a + (db.sales||[]).filter(s=>s.customerId===c.id).reduce((b,s)=>b+(s.total||0),0), 0);

  if (el('customers-count'))       el('customers-count').textContent       = custs.length;
  if (el('customers-debt'))        el('customers-debt').textContent        = fmtCurr(totalDebt);
  if (el('customers-with-debt'))   el('customers-with-debt').textContent   = withDebt;
  if (el('customers-total-sales')) el('customers-total-sales').textContent = fmtCurr(totalSalesAmt);

  const sorted = [...custs].sort((a,b) => {
    if (sort === 'debt_desc')  return (b.balance||0) - (a.balance||0);
    if (sort === 'sales_desc') {
      const sa=(db.sales||[]).filter(s=>s.customerId===a.id).reduce((x,s)=>x+s.total,0);
      const sb=(db.sales||[]).filter(s=>s.customerId===b.id).reduce((x,s)=>x+s.total,0);
      return sb-sa;
    }
    return a.name.localeCompare(b.name,'ar');
  });

  const tbody = el('customers-tbody');
  if (!tbody) return;
  tbody.innerHTML = sorted.length ? sorted.map(c => {
    const totalPurchases = (db.sales||[]).filter(s=>s.customerId===c.id).reduce((a,s)=>a+(s.total||0),0);
    const invoiceCount   = (db.sales||[]).filter(s=>s.customerId===c.id).length;
    const bal            = c.balance || 0;
    const lastSale       = [...(db.sales||[])].filter(s=>s.customerId===c.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
    return `<tr>
      <td><div style="font-weight:700">${c.name}</div>${c.address?`<div style="font-size:0.75rem;color:var(--text-muted)">${c.address}</div>`:''}</td>
      <td>${c.phone||'—'}</td>
      <td>${c.email||'—'}</td>
      <td style="color:var(--accent-blue);font-weight:600">${fmtCurr(totalPurchases)}</td>
      <td style="color:var(--text-muted)">${invoiceCount}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${lastSale?lastSale.date:'—'}</td>
      <td>${bal>0?`<span class="badge badge-red">مديون: ${fmtCurr(bal)}</span>`:'<span class="badge badge-green">لا دين</span>'}</td>
      <td>
        <div class="btn-group" style="gap:4px">
          <button class="btn btn-blue btn-sm" onclick="viewCustomerStatement('${c.id}')" title="كشف حساب"><i class="fa fa-file-invoice"></i></button>
          ${bal>0?`<button class="btn btn-success btn-sm" onclick="openPayCustomerModal('${c.id}')" title="سداد"><i class="fa fa-money-bill"></i></button>`:''}
          <button class="btn btn-ghost btn-sm" onclick="editCustomer('${c.id}')" title="تعديل"><i class="fa fa-pen"></i></button>
          ${can('delete')?`<button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" title="حذف"><i class="fa fa-trash"></i></button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty-state"><p>لا يوجد عملاء</p></td></tr>';
}

function saveCustomer() {
  const id = el('customer-form-id').value;
  const name = el('customer-form-name').value.trim();
  if (!name) { showToast('أدخل اسم العميل', 'warning'); return; }
  const data = { name, phone: el('customer-form-phone')?.value||'', email: el('customer-form-email')?.value||'', address: el('customer-form-address')?.value||'', notes: el('customer-form-notes')?.value||'' };
  if (id) {
    const i = db.customers.findIndex(x => x.id === id);
    if (i > -1) db.customers[i] = { ...db.customers[i], ...data };
  } else {
    db.customers.push({ id: uid(), ...data, balance: 0 });
  }
  saveDB();
  closeModal('customer-modal');
  renderCustomersPage();
  showToast('تم حفظ العميل');
}

function editCustomer(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  el('customer-modal-title').textContent = 'تعديل العميل';
  el('customer-form-id').value = cid;
  el('customer-form-name').value = c.name;
  el('customer-form-phone').value = c.phone || '';
  el('customer-form-email').value = c.email || '';
  el('customer-form-address').value = c.address || '';
  el('customer-form-notes').value = c.notes || '';
  openModal('customer-modal');
}

function deleteCustomer(cid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('حذف العميل؟')) return;
  const c = db.customers.find(x => x.id === cid);
  db.customers = db.customers.filter(x => x.id !== cid);
  addLog('حذف', `حذف عميل: ${c?.name}`, 'حذف');
  saveDB();
  renderCustomersPage();
}

function viewCustomerStatement(cid) {
  const c = (db.customers || []).find(x => x.id === cid);
  if (!c) return;
  const sales    = (db.sales || []).filter(s => s.customerId === cid).sort((a,b) => new Date(b.ts)-new Date(a.ts));
  const payments = (db.customerPayments || []).filter(p => p.customerId === cid).sort((a,b) => new Date(b.ts)-new Date(a.ts));
  const totalSales    = sales.reduce((a, s) => a + (s.total || 0), 0);
  const totalPaid     = payments.reduce((a, p) => a + (p.amount || 0), 0);
  const creditSales   = sales.filter(s => s.payment === 'آجل').reduce((a, s) => a + (s.total || 0), 0);
  const bal           = c.balance || 0;

  const salesRows = sales.map(s => {
    const ps = s.payStatus || (s.payment === 'آجل' ? 'unpaid' : 'paid');
    const statusBadge = ps === 'paid' ? '<span class="badge badge-green">مدفوع</span>'
                      : ps === 'partial' ? '<span class="badge badge-orange">جزئي</span>'
                      : '<span class="badge badge-red">آجل</span>';
    return `<tr>
      <td><span class="badge badge-blue">${s.id}</span></td>
      <td>${s.date}</td>
      <td style="color:var(--accent-green);font-weight:700">${fmtCurr(s.total)}</td>
      <td>${s.payment}</td>
      <td>${statusBadge}</td>
      <td>${s.dueDate ? '📅 ' + s.dueDate : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="closeModal('customer-statement-modal');viewSale('${s.id}')"><i class="fa fa-eye"></i></button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-state"><p>لا توجد فواتير</p></td></tr>';

  const payRows = payments.map(p => `<tr>
    <td style="color:var(--accent-green);font-weight:700">+${fmtCurr(p.amount)}</td>
    <td>${p.method || '—'}</td>
    <td>${p.date || '—'}</td>
    <td>${p.note || '—'}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="empty-state"><p>لا توجد مدفوعات</p></td></tr>';

  const cont = el('customer-statement-content');
  if (!cont) return;
  cont.innerHTML = `
    <div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:1.2rem;font-weight:900">${c.name}</div>
        <div style="font-size:0.82rem;color:var(--text-muted)">${[c.phone,c.email,c.address].filter(Boolean).join(' | ') || '—'}</div>
      </div>
      ${bal > 0 ? `<button class="btn btn-success btn-sm" onclick="closeModal('customer-statement-modal');openPayCustomerModal('${c.id}')"><i class="fa fa-money-bill"></i> تسجيل سداد</button>` : ''}
    </div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      <div class="stat-card"><div class="stat-label">عدد الفواتير</div><div class="stat-value">${sales.length}</div></div>
      <div class="stat-card"><div class="stat-label">إجمالي المشتريات</div><div class="stat-value" style="color:var(--accent-blue)">${fmtCurr(totalSales)}</div></div>
      <div class="stat-card"><div class="stat-label">إجمالي المدفوع</div><div class="stat-value" style="color:var(--accent-green)">${fmtCurr(totalPaid)}</div></div>
      <div class="stat-card"><div class="stat-label">الرصيد المستحق</div><div class="stat-value" style="color:${bal>0?'var(--accent-red)':'var(--accent-green)'}">${fmtCurr(bal)}</div></div>
    </div>
    <div style="font-weight:700;margin-bottom:6px">📋 الفواتير</div>
    <div class="table-wrapper" style="margin-bottom:16px">
      <table>
        <thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>المبلغ</th><th>الدفع</th><th>الحالة</th><th>الاستحقاق</th><th></th></tr></thead>
        <tbody>${salesRows}</tbody>
      </table>
    </div>
    <div style="font-weight:700;margin-bottom:6px">💳 المدفوعات المسجلة</div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>المبلغ</th><th>طريقة الدفع</th><th>التاريخ</th><th>ملاحظات</th></tr></thead>
        <tbody>${payRows}</tbody>
      </table>
    </div>`;
  openModal('customer-statement-modal');
}

// =========================================================
// ======= SUPPLIERS =======================================
// =========================================================
function renderSuppliersPage() {
  const q = (el('suppliers-search')?.value || '').toLowerCase();
  const suppliers = (db.suppliers || []).filter(s =>
    !q || s.name.toLowerCase().includes(q) || (s.phone||'').includes(q)
  );

  const totalDebt    = suppliers.reduce((a,s) => a+(s.balance||0), 0);
  const withDebt     = suppliers.filter(s => (s.balance||0) > 0).length;
  const totalBought  = suppliers.reduce((a,s) => a+(db.purchases||[]).filter(p=>p.supplierId===s.id).reduce((b,p)=>b+(p.total||0),0), 0);

  if (el('suppliers-count'))       el('suppliers-count').textContent       = suppliers.length;
  if (el('suppliers-debt'))        el('suppliers-debt').textContent        = fmtCurr(totalDebt);
  if (el('suppliers-with-debt'))   el('suppliers-with-debt').textContent   = withDebt;
  if (el('suppliers-total-bought')) el('suppliers-total-bought').textContent = fmtCurr(totalBought);

  const tbody = el('suppliers-tbody');
  if (!tbody) return;
  tbody.innerHTML = suppliers.length ? suppliers.map(s => {
    const totalPurchases = (db.purchases||[]).filter(p=>p.supplierId===s.id).reduce((a,p)=>a+(p.total||0),0);
    const purCount       = (db.purchases||[]).filter(p=>p.supplierId===s.id).length;
    const bal            = s.balance || 0;
    const lastPur        = [...(db.purchases||[])].filter(p=>p.supplierId===s.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];

    // ── حساب الديون المفتوحة والمتأخرة من db.debts ──
    const openDebts   = (db.debts||[]).filter(d => d.entityId===s.id && d.entityType==='supplier' && d.status!=='closed' && (d.amount-(d.paid||0))>0);
    const overdueDebts= openDebts.filter(d => d.dueDate && new Date(d.dueDate.replace(/\//g,'-').split('-').reverse().join('-')) < new Date());
    const openCount   = openDebts.length;
    const overdueCount= overdueDebts.length;

    // شارة الدين مع مؤشر التأخر
    let debtBadge = '';
    if (bal > 0) {
      if (overdueCount > 0) {
        debtBadge = `<span class="badge badge-red" title="${overdueCount} فاتورة متأخرة">⚠️ متأخر: ${fmtCurr(bal)}</span>`;
      } else {
        debtBadge = `<span class="badge badge-orange">مستحق: ${fmtCurr(bal)}</span>`;
      }
      if (openCount > 1) debtBadge += `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">${openCount} فاتورة مفتوحة</div>`;
    } else {
      debtBadge = '<span class="badge badge-green">لا دين</span>';
    }

    return `<tr>
      <td><div style="font-weight:700">${s.name}</div>${s.address?`<div style="font-size:0.75rem;color:var(--text-muted)">${s.address}</div>`:''}</td>
      <td>${s.phone||'—'}</td>
      <td>${s.email||'—'}</td>
      <td style="color:var(--accent-blue);font-weight:600">${fmtCurr(totalPurchases)}</td>
      <td style="color:var(--text-muted)">${purCount}</td>
      <td style="font-size:0.78rem;color:var(--text-muted)">${lastPur?lastPur.date:'—'}</td>
      <td>${debtBadge}</td>
      <td>
        <div class="btn-group" style="gap:4px">
          <button class="btn btn-blue btn-sm" onclick="viewSupplierStatement('${s.id}')" title="كشف حساب"><i class="fa fa-file-invoice"></i></button>
          ${bal>0?`<button class="btn btn-success btn-sm" onclick="openPaySupplierModal('${s.id}')" title="دفع دين"><i class="fa fa-money-bill"></i></button>`:''}
          ${bal>0?`<button class="btn btn-ghost btn-sm" onclick="navigateToSupplierDebts('${s.id}')" title="عرض الديون في الأرصدة"><i class="fa fa-list"></i></button>`:''}
          <button class="btn btn-ghost btn-sm" onclick="editSupplier('${s.id}')" title="تعديل"><i class="fa fa-pen"></i></button>
          ${can('delete')?`<button class="btn btn-danger btn-sm" onclick="deleteSupplier('${s.id}')" title="حذف"><i class="fa fa-trash"></i></button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty-state"><p>لا يوجد موردون</p></td></tr>';
}

// ── التنقل السريع من صفحة الموردين إلى ديونه في صفحة الأرصدة ──
function navigateToSupplierDebts(supplierId) {
  // انتقل لصفحة الأرصدة وافتح تبويب الديون مع فلترة هذا المورد
  if (typeof navigateTo === 'function') navigateTo('balances');
  else if (typeof renderBalancesPage === 'function') {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const balPage = document.getElementById('page-balances');
    if (balPage) balPage.style.display = '';
    renderBalancesPage();
  }
  setTimeout(() => {
    if (typeof switchBalTab === 'function') switchBalTab('debts');
    // فلترة بالمورد في حقل البحث
    const searchEl = document.getElementById('bal-debt-search');
    const sup = (db.suppliers||[]).find(s=>s.id===supplierId);
    if (searchEl && sup) {
      searchEl.value = sup.name;
      searchEl.dispatchEvent(new Event('input'));
    }
    // فلترة نوع المورد
    const filterEl = document.getElementById('bal-debt-filter');
    if (filterEl) {
      filterEl.value = 'supplier';
      filterEl.dispatchEvent(new Event('change'));
    }
    if (typeof renderBalDebts === 'function') renderBalDebts();
  }, 150);
}

function viewSupplierStatement(sid) {
  const s = (db.suppliers||[]).find(x=>x.id===sid);
  if (!s) return;
  const purchases  = (db.purchases||[]).filter(p=>p.supplierId===sid).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const payments   = (db.supplierPayments||[]).filter(p=>p.supplierId===sid).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const totalBought= purchases.reduce((a,p)=>a+(p.total||0),0);
  const totalPaid  = payments.reduce((a,p)=>a+(p.amount||0),0);
  const bal        = s.balance || 0;

  const purRows = purchases.map(p=>`<tr>
    <td><span class="badge badge-blue">${p.id||'—'}</span></td>
    <td>${p.date||'—'}</td>
    <td style="font-weight:700;color:var(--accent-orange)">${fmtCurr(p.total||0)}</td>
    <td>${p.payment||'—'}</td>
    <td>${p.creditDays>0?`${p.creditDays} يوم`:'—'}</td>
    <td>${p.dueDate?'📅 '+p.dueDate:'—'}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty-state"><p>لا توجد مشتريات</p></td></tr>';

  const payRows = payments.map(p=>`<tr>
    <td style="color:var(--accent-green);font-weight:700">+${fmtCurr(p.amount)}</td>
    <td>${p.method||'—'}</td>
    <td>${p.date||'—'}</td>
    <td>${p.note||'—'}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="empty-state"><p>لا توجد مدفوعات</p></td></tr>';

  const cont = el('supplier-statement-content') || el('customer-statement-content');
  if (!cont) { showToast('لا يمكن عرض الكشف', 'error'); return; }
  cont.innerHTML = `
    <div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:1.2rem;font-weight:900">${s.name}</div>
        <div style="font-size:0.82rem;color:var(--text-muted)">${[s.phone,s.email,s.address].filter(Boolean).join(' | ')||'—'}</div>
      </div>
      ${bal>0?`<button class="btn btn-success btn-sm" onclick="openPaySupplierModal('${s.id}')"><i class="fa fa-money-bill"></i> تسجيل دفعة</button>`:''}
    </div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      <div class="stat-card"><div class="stat-label">عدد الفواتير</div><div class="stat-value">${purchases.length}</div></div>
      <div class="stat-card"><div class="stat-label">إجمالي المشتريات</div><div class="stat-value" style="color:var(--accent-orange)">${fmtCurr(totalBought)}</div></div>
      <div class="stat-card"><div class="stat-label">إجمالي المدفوع</div><div class="stat-value" style="color:var(--accent-green)">${fmtCurr(totalPaid)}</div></div>
      <div class="stat-card"><div class="stat-label">المستحق</div><div class="stat-value" style="color:${bal>0?'var(--accent-red)':'var(--accent-green)'}">${fmtCurr(bal)}</div></div>
    </div>
    <div style="font-weight:700;margin-bottom:6px">📋 فواتير الشراء</div>
    <div class="table-wrapper" style="margin-bottom:16px">
      <table><thead><tr><th>رقم</th><th>التاريخ</th><th>المبلغ</th><th>الدفع</th><th>الأجل</th><th>الاستحقاق</th></tr></thead><tbody>${purRows}</tbody></table>
    </div>
    <div style="font-weight:700;margin-bottom:6px">💳 الدفعات المسجلة</div>
    <div class="table-wrapper">
      <table><thead><tr><th>المبلغ</th><th>الطريقة</th><th>التاريخ</th><th>ملاحظات</th></tr></thead><tbody>${payRows}</tbody></table>
    </div>`;
  // Reuse customer-statement-modal or supplier-statement-modal
  const modalId = el('supplier-statement-modal') ? 'supplier-statement-modal' : 'customer-statement-modal';
  openModal(modalId);
}

function saveSupplier() {
  const id = el('supplier-form-id').value;
  const name = el('supplier-form-name').value.trim();
  if (!name) { showToast('أدخل اسم المورد', 'warning'); return; }
  const data = { name, phone: el('supplier-form-phone')?.value||'', email: el('supplier-form-email')?.value||'', address: el('supplier-form-address')?.value||'' };
  if (id) {
    const i = db.suppliers.findIndex(x => x.id === id);
    if (i > -1) db.suppliers[i] = { ...db.suppliers[i], ...data };
  } else {
    db.suppliers.push({ id: uid(), ...data, balance: 0 });
  }
  saveDB();
  closeModal('supplier-modal');
  renderSuppliersPage();
  showToast('تم حفظ المورد');
}

function editSupplier(sid) {
  const s = db.suppliers.find(x => x.id === sid);
  if (!s) return;
  el('supplier-modal-title').textContent = 'تعديل المورد';
  el('supplier-form-id').value = sid;
  el('supplier-form-name').value = s.name;
  el('supplier-form-phone').value = s.phone || '';
  el('supplier-form-email').value = s.email || '';
  if (el('supplier-form-address')) el('supplier-form-address').value = s.address || '';
  openModal('supplier-modal');
}

function deleteSupplier(sid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('حذف المورد؟')) return;
  db.suppliers = db.suppliers.filter(x => x.id !== sid);
  saveDB();
  renderSuppliersPage();
}

// =========================================================
// ======= EMPLOYEES =======================================
// =========================================================
function renderEmployeesPage() {
  el('employees-count').textContent = (db.employees || []).length;
  el('employees-salaries').textContent = fmtCurr((db.employees || []).reduce((a, e) => a + (e.salary || 0), 0));
  el('employees-tbody').innerHTML = (db.employees || []).map(e => `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td>${e.role || '—'}</td>
      <td>${e.phone || '—'}</td>
      <td>${fmtCurr(e.salary || 0)}</td>
      <td>${e.startDate || '—'}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="editEmployee('${e.id}')"><i class="fa fa-pen"></i></button>
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteEmployee('${e.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty-state"><p>لا يوجد موظفون</p></td></tr>';
}

function saveEmployee() {
  const id = el('employee-form-id').value;
  const name = el('employee-form-name').value.trim();
  if (!name) { showToast('أدخل اسم الموظف', 'warning'); return; }
  const data = { name, role: el('employee-form-role').value, phone: el('employee-form-phone').value, salary: parseFloat(el('employee-form-salary').value) || 0, startDate: el('employee-form-start').value };
  if (id) {
    const i = db.employees.findIndex(x => x.id === id);
    if (i > -1) db.employees[i] = { ...db.employees[i], ...data };
  } else {
    db.employees.push({ id: uid(), ...data });
  }
  saveDB();
  closeModal('employee-modal');
  renderEmployeesPage();
  showToast('تم حفظ الموظف');
}

function editEmployee(eid) {
  const e = db.employees.find(x => x.id === eid);
  if (!e) return;
  el('employee-modal-title').textContent = 'تعديل موظف';
  el('employee-form-id').value = eid;
  el('employee-form-name').value = e.name;
  el('employee-form-role').value = e.role || '';
  el('employee-form-phone').value = e.phone || '';
  el('employee-form-salary').value = e.salary || '';
  el('employee-form-start').value = e.startDate || '';
  openModal('employee-modal');
}

function deleteEmployee(eid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('حذف الموظف؟')) return;
  db.employees = db.employees.filter(x => x.id !== eid);
  saveDB();
  renderEmployeesPage();
}

// =========================================================
// ======= TREASURY ========================================
// =========================================================
function renderTreasuryPage() {
  const income      = (db.treasury || []).filter(t => t.type === 'إيراد').reduce((a, t) => a + t.amount, 0);
  const expense     = (db.treasury || []).filter(t => t.type === 'مصروف').reduce((a, t) => a + t.amount, 0);
  const withdrawals = (db.treasury || []).filter(t => t.type === 'سحب').reduce((a, t) => a + t.amount, 0);
  const cashBal = income - expense - withdrawals;
  el('treasury-income').textContent = fmtCurr(income);
  el('treasury-expense').textContent = fmtCurr(expense);
  el('treasury-balance').textContent = fmtCurr(cashBal);
  if (el('treasury-withdrawals')) el('treasury-withdrawals').textContent = fmtCurr(withdrawals);
  if (el('treasury-bank-balance'))  el('treasury-bank-balance').textContent  = fmtCurr(db.bankBalance || 0);
  if (el('treasury-net-liquidity')) el('treasury-net-liquidity').textContent = fmtCurr(cashBal + (db.bankBalance || 0));
  const f = el('treasury-filter')?.value || 'all';
  const rows = [...(db.treasury || [])].reverse().filter(t => f === 'all' || t.type === f);
  el('treasury-tbody').innerHTML = rows.map(t => {
    const badgeColor = t.type === 'إيراد' ? 'green' : (t.type === 'سحب' ? 'orange' : 'red');
    const textColor  = t.type === 'إيراد' ? 'var(--accent-green)' : (t.type === 'سحب' ? 'var(--accent-orange)' : 'var(--accent-red)');
    return `
    <tr>
      <td><span class="badge badge-${badgeColor}">${t.type}</span></td>
      <td>${t.desc || '—'}</td>
      <td style="color:${textColor};font-weight:700">${fmtCurr(t.amount)}</td>
      <td>${t.date || '—'}</td>
      <td>${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteTreasury('${t.id}')"><i class="fa fa-trash"></i></button>` : ''}</td>
    </tr>
  `;}).join('') || '<tr><td colspan="5" class="empty-state"><p>لا توجد معاملات</p></td></tr>';
  // set today's date
  if (!el('treasury-date').value) el('treasury-date').value = new Date().toISOString().split('T')[0];
}

function saveTreasury() {
  const type = el('treasury-type').value;
  const desc = el('treasury-desc').value.trim();
  const amount = parseFloat(el('treasury-amount').value) || 0;
  const date = el('treasury-date').value || new Date().toLocaleDateString('ar-EG');
  if (!desc || !amount) { showToast('أكمل البيانات', 'warning'); return; }

  // تحقق من توافر السيولة الكافية في حالة السحب أو المصروف
  if (type === 'سحب' || type === 'مصروف') {
    const income      = (db.treasury || []).filter(t => t.type === 'إيراد').reduce((a, t) => a + t.amount, 0);
    const expense     = (db.treasury || []).filter(t => t.type === 'مصروف').reduce((a, t) => a + t.amount, 0);
    const withdrawals = (db.treasury || []).filter(t => t.type === 'سحب').reduce((a, t) => a + t.amount, 0);
    const cashBal     = income - expense - withdrawals;
    if (amount > cashBal) {
      showToast(`⚠️ رصيد الخزنة الحالي (${fmtCurr(cashBal)}) لا يكفي لهذه العملية`, 'warning');
      return;
    }
  }

  db.treasury.push({ id: uid(), type, desc, amount, date, ts: new Date().toISOString() });
  if (typeof erpLogMovement === 'function') {
    erpLogMovement({
      category: type === 'سحب' ? 'withdrawal' : 'treasury',
      type: type === 'إيراد' ? 'credit' : 'debit',
      entityName: desc, amount, notes: desc
    });
  }
  saveDB();
  renderTreasuryPage();
  if (typeof erpRefreshFinancialDashboard === 'function') setTimeout(erpRefreshFinancialDashboard, 200);
  el('treasury-desc').value = '';
  el('treasury-amount').value = '';
  showToast(type === 'سحب' ? '✅ تم تسجيل السحب من الخزنة' : 'تم تسجيل المعاملة');
}

function deleteTreasury(tid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  db.treasury = db.treasury.filter(x => x.id !== tid);
  saveDB();
  renderTreasuryPage();
}

// =========================================================
// ======= EXPENSES (ENHANCED) =============================
// =========================================================

const EXPENSE_CATEGORY_COLORS = {
  'إيجار': 'badge-blue', 'فواتير': 'badge-orange', 'رواتب': 'badge-green',
  'صيانة': 'badge-red', 'تسويق': 'badge-purple', 'نقل وشحن': 'badge-blue',
  'مشتريات بضائع': 'badge-orange', 'ضيافة': 'badge-green', 'أخرى': 'badge-gray'
};

function renderExpensesPage() {
  if (!db.expenses) db.expenses = [];
  if (el('expense-date') && !el('expense-date').value) el('expense-date').value = new Date().toISOString().split('T')[0];

  const all = db.expenses || [];
  const now = new Date();
  const todayStr = now.toLocaleDateString('ar-EG');
  const curMonth = now.getMonth(), curYear = now.getFullYear();

  // إحصائيات عامة
  const total = all.reduce((a, e) => a + (e.amount || 0), 0);
  const monthTotal = all.filter(e => {
    const d = new Date(e.ts || e.date);
    return !isNaN(d) && d.getMonth() === curMonth && d.getFullYear() === curYear;
  }).reduce((a, e) => a + (e.amount || 0), 0);
  const todayTotal = all.filter(e => (e.date === todayStr)).reduce((a, e) => a + (e.amount || 0), 0);

  if (el('expenses-total'))       el('expenses-total').textContent = fmtCurr(total);
  if (el('expenses-month-total')) el('expenses-month-total').textContent = fmtCurr(monthTotal);
  if (el('expenses-today-total')) el('expenses-today-total').textContent = fmtCurr(todayTotal);
  if (el('expenses-count'))       el('expenses-count').textContent = all.length;

  // التوزيع حسب التصنيف
  const byCategory = {};
  all.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0); });
  const catContainer = el('expenses-by-category');
  if (catContainer) {
    const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    catContainer.innerHTML = entries.length ? entries.map(([cat, amt]) => {
      const pct = total > 0 ? ((amt / total) * 100).toFixed(1) : 0;
      const badge = EXPENSE_CATEGORY_COLORS[cat] || 'badge-gray';
      return `
        <div style="background:var(--bg-input);border-radius:10px;padding:10px 16px;min-width:140px;flex:1">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span class="badge ${badge}">${cat}</span>
            <span style="font-size:0.75rem;color:var(--text-muted)">${pct}%</span>
          </div>
          <div style="font-weight:700;color:var(--accent-red)">${fmtCurr(amt)}</div>
        </div>`;
    }).join('') : '<p style="color:var(--text-muted)">لا توجد بيانات</p>';
  }

  // الفلاتر
  const searchQ  = (el('expense-search')?.value || '').toLowerCase().trim();
  const filterCat = el('expense-filter-category')?.value || '';
  const fromDate  = el('expense-filter-from')?.value || '';
  const toDate    = el('expense-filter-to')?.value || '';

  let filtered = [...all];
  if (searchQ)  filtered = filtered.filter(e => (e.desc || '').toLowerCase().includes(searchQ));
  if (filterCat) filtered = filtered.filter(e => e.category === filterCat);
  if (fromDate)  filtered = filtered.filter(e => (e.ts || '').slice(0, 10) >= fromDate || (e.date && new Date(e.date) >= new Date(fromDate)));
  if (toDate)    filtered = filtered.filter(e => (e.ts || '').slice(0, 10) <= toDate || (e.date && new Date(e.date) <= new Date(toDate)));

  el('expenses-tbody').innerHTML = [...filtered].reverse().map(e => {
    const badge = EXPENSE_CATEGORY_COLORS[e.category] || 'badge-gray';
    return `
    <tr>
      <td><span class="badge ${badge}">${e.category}</span></td>
      <td>${e.desc || '—'}</td>
      <td style="color:var(--accent-red);font-weight:700">${fmtCurr(e.amount)}</td>
      <td>${e.date || '—'}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="editExpense('${e.id}')" title="تعديل"><i class="fa fa-edit"></i></button>
          ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')" title="حذف"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="5" class="empty-state"><p>لا توجد مصروفات مطابقة</p></td></tr>';
}

function clearExpenseFilters() {
  if (el('expense-search')) el('expense-search').value = '';
  if (el('expense-filter-category')) el('expense-filter-category').value = '';
  if (el('expense-filter-from')) el('expense-filter-from').value = '';
  if (el('expense-filter-to')) el('expense-filter-to').value = '';
  renderExpensesPage();
}

function saveExpense() {
  const editId = el('expense-edit-id')?.value || '';
  const category = el('expense-category').value;
  const desc = el('expense-desc').value.trim();
  const amount = parseFloat(el('expense-amount').value) || 0;
  const dateInput = el('expense-date').value;
  const date = dateInput ? new Date(dateInput).toLocaleDateString('ar-EG') : new Date().toLocaleDateString('ar-EG');
  if (!desc || !amount) { showToast('أكمل البيانات', 'warning'); return; }

  if (!db.expenses) db.expenses = [];

  if (editId) {
    // تعديل مصروف موجود — تحديث سجل الخزنة المرتبط أيضاً
    const exp = db.expenses.find(x => x.id === editId);
    if (exp) {
      // تعديل قيد الخزنة القديم المرتبط (لو موجود)
      const oldTreasuryDesc = `${exp.category}: ${exp.desc}`;
      const tEntry = (db.treasury || []).find(t => t.type === 'مصروف' && t.desc === oldTreasuryDesc && Math.abs((t.amount||0) - (exp.amount||0)) < 0.001);
      if (tEntry) {
        tEntry.desc = `${category}: ${desc}`;
        tEntry.amount = amount;
        tEntry.date = date;
      }
      exp.category = category;
      exp.desc = desc;
      exp.amount = amount;
      exp.date = date;
    }
    showToast('تم تعديل المصروف ✅');
    cancelEditExpense();
  } else {
    const exp = { id: uid(), category, desc, amount, date, ts: new Date().toISOString() };
    db.expenses.push(exp);
    if (!db.treasury) db.treasury = [];
    db.treasury.push({ id: uid(), type: 'مصروف', desc: `${category}: ${desc}`, amount, date, ts: new Date().toISOString() });
    showToast('تم تسجيل المصروف ✅');
    el('expense-desc').value = '';
    el('expense-amount').value = '';
  }

  saveDB();
  renderExpensesPage();
  if (typeof erpRefreshFinancialDashboard === 'function') erpRefreshFinancialDashboard();
}

function editExpense(eid) {
  const exp = (db.expenses || []).find(x => x.id === eid);
  if (!exp) return;
  el('expense-edit-id').value = exp.id;
  el('expense-category').value = exp.category;
  el('expense-desc').value = exp.desc;
  el('expense-amount').value = exp.amount;
  // تحويل التاريخ العربي إلى صيغة input[type=date]
  try {
    const parts = exp.date.split(/[\/\-]/);
    if (parts.length === 3) {
      // افتراض الصيغة dd/mm/yyyy
      const [d, m, y] = parts;
      el('expense-date').value = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  } catch (e) {}
  el('expense-form-title').textContent = '✏️ تعديل المصروف';
  el('expense-save-btn').textContent = '💾 حفظ التعديل';
  el('expense-cancel-btn').style.display = '';
  el('expense-category').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditExpense() {
  el('expense-edit-id').value = '';
  el('expense-desc').value = '';
  el('expense-amount').value = '';
  el('expense-date').value = new Date().toISOString().split('T')[0];
  el('expense-form-title').textContent = '➕ إضافة مصروف جديد';
  el('expense-save-btn').textContent = '💾 تسجيل المصروف';
  el('expense-cancel-btn').style.display = 'none';
}

function deleteExpense(eid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (!confirm('حذف هذا المصروف؟')) return;
  const exp = (db.expenses || []).find(x => x.id === eid);
  if (exp) {
    // حذف قيد الخزنة المرتبط أيضاً
    const treasuryDesc = `${exp.category}: ${exp.desc}`;
    db.treasury = (db.treasury || []).filter(t => !(t.type === 'مصروف' && t.desc === treasuryDesc && Math.abs((t.amount||0) - (exp.amount||0)) < 0.001));
  }
  db.expenses = db.expenses.filter(x => x.id !== eid);
  saveDB();
  renderExpensesPage();
  if (typeof erpRefreshFinancialDashboard === 'function') erpRefreshFinancialDashboard();
  showToast('تم حذف المصروف');
}

// --- تصدير تقرير المصروفات PDF ---
function exportExpensesPDF() {
  const all = db.expenses || [];
  if (!all.length) { showToast('لا توجد مصروفات لتصديرها', 'warning'); return; }

  const searchQ  = (el('expense-search')?.value || '').toLowerCase().trim();
  const filterCat = el('expense-filter-category')?.value || '';
  const fromDate  = el('expense-filter-from')?.value || '';
  const toDate    = el('expense-filter-to')?.value || '';

  let filtered = [...all];
  if (searchQ)  filtered = filtered.filter(e => (e.desc || '').toLowerCase().includes(searchQ));
  if (filterCat) filtered = filtered.filter(e => e.category === filterCat);
  if (fromDate)  filtered = filtered.filter(e => (e.ts || '').slice(0, 10) >= fromDate);
  if (toDate)    filtered = filtered.filter(e => (e.ts || '').slice(0, 10) <= toDate);

  const total = filtered.reduce((a, e) => a + (e.amount || 0), 0);

  const byCategory = {};
  filtered.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0); });
  const catRows = Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([cat, amt]) => `
    <tr><td>${cat}</td><td>${fmtCurr(amt)}</td><td>${total>0?((amt/total)*100).toFixed(1):0}%</td></tr>
  `).join('');

  const rows = [...filtered].reverse().map((e, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${e.category}</td>
      <td>${e.desc || '—'}</td>
      <td>${fmtCurr(e.amount)}</td>
      <td>${e.date || '—'}</td>
    </tr>
  `).join('');

  const periodLabel = (fromDate || toDate) ? `من ${fromDate || '...'} إلى ${toDate || '...'}` : 'كل الفترات';

  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
    <title>تقرير المصروفات</title>
    <style>body{font-family:Tahoma,sans-serif;direction:rtl;padding:20px;color:#1f2937}
    h2{text-align:center;color:#dc2626;margin-bottom:4px}
    .meta{text-align:center;color:#6b7280;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{border:1px solid #ddd;padding:7px;text-align:center}th{background:#f3f4f6}
    .total{font-size:1.2rem;font-weight:bold;text-align:left;margin-top:14px;color:#dc2626}
    .section-title{margin-top:24px;font-weight:800;color:#1a56db}
    </style></head>
    <body>
    <h2>🧾 تقرير المصروفات</h2>
    <div class="meta">${periodLabel} | تاريخ التقرير: ${new Date().toLocaleDateString('ar-EG')}</div>
    <div class="section-title">التوزيع حسب التصنيف</div>
    <table><thead><tr><th>التصنيف</th><th>الإجمالي</th><th>النسبة</th></tr></thead>
    <tbody>${catRows}</tbody></table>
    <div class="section-title">سجل المصروفات (${filtered.length} عملية)</div>
    <table><thead><tr><th>#</th><th>التصنيف</th><th>الوصف</th><th>المبلغ</th><th>التاريخ</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="total">الإجمالي الكلي: ${fmtCurr(total)}</div>
    <script>window.onload=function(){setTimeout(()=>window.print(),350)}<\/script>
    </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// =========================================================
// ======= REPORTS (ENHANCED) ==============================
// =========================================================
function renderReportsPage() {
  const period = el('report-period')?.value || 'month';
  const isCashier = currentUser && currentUser.role === 'cashier';
  const isStore = currentUser && currentUser.role === 'store';
  const restrictedRole = isCashier || isStore;

  // إخفاء تقارير الشهر والخزنة من الكاشير والمخزن
  const monthlySection = document.getElementById('monthly-report-section');
  const treasurySection = document.getElementById('treasury-report-section');
  if (monthlySection) monthlySection.style.display = restrictedRole ? 'none' : '';
  if (treasurySection) treasurySection.style.display = restrictedRole ? 'none' : '';

  // تغيير الفترة الافتراضية للكاشير/المخزن إلى اليوم فقط
  const periodSelect = el('report-period');
  if (periodSelect && restrictedRole) {
    // إخفاء خيارات الشهر والكل
    Array.from(periodSelect.options).forEach(opt => {
      if (opt.value === 'month' || opt.value === 'all') {
        opt.disabled = true;
        opt.style.display = 'none';
      }
    });
    if (periodSelect.value === 'month' || periodSelect.value === 'all') {
      periodSelect.value = 'today';
    }
  }

  const activePeriod = (restrictedRole && (period === 'month' || period === 'all')) ? 'today' : period;
  const sales = filterByPeriod(db.sales || [], activePeriod);
  const expenses = filterByPeriod(db.expenses || [], activePeriod);
  const returns = filterByPeriod(db.returns || [], activePeriod);

  const revenue = sales.reduce((a, s) => a + (s.total || 0), 0);
  const cogs = sales.reduce((a, s) => a + ((s.items || []).reduce((b, i) => b + (i.cost || 0) * (i.qty || 1), 0)), 0);
  const expTotal = expenses.reduce((a, e) => a + (e.amount || 0), 0);
  const retTotal = returns.reduce((a, r) => a + (r.amount || 0), 0);
  const profit = revenue - cogs - expTotal - retTotal;
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;

  el('report-revenue').textContent = fmtCurr(revenue);
  el('report-cost').textContent = fmtCurr(cogs);
  el('report-expenses').textContent = fmtCurr(expTotal);
  el('report-profit').textContent = fmtCurr(profit);
  el('report-margin').textContent = margin + '%';
  el('report-returns').textContent = fmtCurr(retTotal);

  // Monthly breakdown
  const monthMap = {};
  (db.sales || []).forEach(s => {
    const m = (s.ts || s.date || '').slice(0, 7);
    if (!m) return;
    if (!monthMap[m]) monthMap[m] = { revenue: 0, cogs: 0, sessions: 0, invoices: 0 };
    monthMap[m].revenue += s.total || 0;
    monthMap[m].cogs += (s.items || []).reduce((b, i) => b + (i.cost || 0) * (i.qty || 1), 0);
    monthMap[m].invoices++;
  });
  // إضافة بيانات الجلسات المغلقة
  (db.monthlySessionReports || []).forEach(sr => {
    const m = sr.monthKey || (sr.date || '').slice(0, 7);
    if (!m) return;
    if (!monthMap[m]) monthMap[m] = { revenue: 0, cogs: 0, sessions: 0, invoices: 0 };
    monthMap[m].sessions = (monthMap[m].sessions || 0) + 1;
  });
  const months = Object.keys(monthMap).sort().reverse().slice(0, 12);
  el('monthly-report-tbody').innerHTML = months.map(m => {
    const d = monthMap[m];
    const p = d.revenue - d.cogs;
    return `<tr>
      <td>${m}</td>
      <td style="color:var(--accent-green)">${fmtCurr(d.revenue)}</td>
      <td style="color:var(--accent-orange)">${fmtCurr(d.cogs)}</td>
      <td style="color:${p >= 0 ? 'var(--accent-purple)' : 'var(--accent-red)'};">${fmtCurr(p)}</td>
      <td style="color:var(--text-muted)">${d.sessions || 0} جلسة / ${d.invoices || 0} فاتورة</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state"><p>لا توجد بيانات</p></td></tr>';

  // Top customers
  const custMap = {};
  sales.forEach(s => {
    if (!s.customerId) return;
    if (!custMap[s.customerId]) custMap[s.customerId] = { name: s.customerName, count: 0, total: 0 };
    custMap[s.customerId].count++;
    custMap[s.customerId].total += s.total || 0;
  });
  const topCusts = Object.values(custMap).sort((a, b) => b.total - a.total).slice(0, 8);
  el('top-customers-tbody').innerHTML = topCusts.map(c => `
    <tr><td>${c.name}</td><td>${c.count}</td><td style="color:var(--accent-green);font-weight:700">${fmtCurr(c.total)}</td></tr>
  `).join('') || '<tr><td colspan="3" class="empty-state"><p>لا توجد بيانات</p></td></tr>';

  // Products report
  const prodMap = {};
  sales.forEach(s => {
    (s.items || []).forEach(i => {
      if (!prodMap[i.productId]) prodMap[i.productId] = { name: i.name, qty: 0, revenue: 0, cogs: 0 };
      prodMap[i.productId].qty += i.qty || 1;
      prodMap[i.productId].revenue += i.subtotal || 0;
      prodMap[i.productId].cogs += (i.cost || 0) * (i.qty || 1);
    });
  });
  const topProds = Object.values(prodMap).sort((a, b) => b.qty - a.qty);
  el('top-products-report-tbody').innerHTML = topProds.slice(0, 10).map(p => {
    const profit = p.revenue - p.cogs;
    const margin = p.revenue > 0 ? ((profit / p.revenue) * 100).toFixed(0) : 0;
    return `<tr>
      <td><strong>${p.name}</strong></td>
      <td>${p.qty}</td>
      <td style="color:var(--accent-green)">${fmtCurr(p.revenue)}</td>
      <td style="color:${profit >= 0 ? 'var(--accent-purple)' : 'var(--accent-red)'}">${fmtCurr(profit)}</td>
      <td><span class="badge badge-${parseInt(margin) >= 20 ? 'green' : parseInt(margin) >= 10 ? 'orange' : 'red'}">${margin}%</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state"><p>لا توجد بيانات</p></td></tr>';

  el('low-sales-products-tbody').innerHTML = topProds.slice().reverse().slice(0, 8).map(p => `
    <tr><td>${p.name}</td><td>${p.qty}</td><td>${(db.products.find(x => x.name === p.name) || {}).qty || '—'}</td></tr>
  `).join('') || '<tr><td colspan="3" class="empty-state"><p>لا توجد بيانات</p></td></tr>';

  // Customers report
  const custAll = (db.customers || []).map(c => {
    const cs = db.sales.filter(s => s.customerId === c.id);
    return { ...c, invoiceCount: cs.length, totalPurchases: cs.reduce((a, s) => a + s.total, 0) };
  }).sort((a, b) => b.totalPurchases - a.totalPurchases);
  el('customers-report-tbody').innerHTML = custAll.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td>${c.phone || '—'}</td>
      <td>${c.invoiceCount}</td>
      <td style="color:var(--accent-green)">${fmtCurr(c.totalPurchases)}</td>
      <td><span class="badge badge-${(c.balance || 0) > 0 ? 'red' : 'green'}">${fmtCurr(c.balance || 0)}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty-state"><p>لا يوجد عملاء</p></td></tr>';

  // Stock report
  const threshold = db.settings.lowStock || 5;
  const lowProds = (db.products || []).filter(p => p.qty <= threshold);
  el('stock-total-products').textContent = db.products.length;
  el('stock-low-products').textContent = lowProds.length;
  el('stock-total-value').textContent = fmtCurr(db.products.reduce((a, p) => a + (p.qty * (p.cost || p.price)), 0));
  el('low-stock-report-tbody').innerHTML = lowProds.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td><span class="badge badge-${p.qty === 0 ? 'red' : 'orange'}">${p.qty}</span></td>
      <td>${p.minStock || threshold}</td>
      <td>${p.qty === 0 ? '<span class="badge badge-red">نفد</span>' : '<span class="badge badge-orange">منخفض</span>'}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--accent-green)">✅ كل المنتجات متوفرة بكميات كافية</td></tr>';
}

function filterByPeriod(arr, period) {
  const now = new Date();
  return arr.filter(item => {
    const d = new Date(item.ts || item.date);
    if (period === 'today') return d.toDateString() === now.toDateString();
    if (period === 'week') { const s = new Date(now); s.setDate(s.getDate() - 7); return d >= s; }
    if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === 'year') return d.getFullYear() === now.getFullYear();
    return true;
  });
}

function switchReportTab(tab) {
  ['overview', 'products', 'customers', 'stock'].forEach(t => {
    el(`report-tab-${t}`).style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#page-reports .tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['overview','products','customers','stock'][i] === tab);
  });
}

// =========================================================
// ======= USERS (NEW) =====================================
// =========================================================
function renderUsersPage() {
  // Permissions table
  const pages = ['pos', 'products', 'purchases', 'suppliers', 'sales', 'customers', 'returns', 'treasury', 'expenses', 'reports', 'delete'];
  const pageLabels = { pos: 'نقطة البيع', products: 'المنتجات', purchases: 'الشراء', suppliers: 'الموردون', sales: 'الفواتير', customers: 'العملاء', returns: 'المرتجعات', treasury: 'الخزنة', expenses: 'المصروفات', reports: 'التقارير', delete: 'الحذف' };
  const roles = ['admin', 'manager', 'cashier', 'store', 'accountant'];
  el('permissions-table-tbody').innerHTML = pages.map(p => `
    <tr>
      <td><strong>${pageLabels[p] || p}</strong></td>
      ${roles.map(r => {
        const allowed = PERMISSIONS[p]?.[r];
        return `<td style="text-align:center"><span style="font-size:1rem">${allowed ? '✅' : '❌'}</span></td>`;
      }).join('')}
    </tr>
  `).join('');

  // Users table
  el('users-tbody').innerHTML = (db.users || []).map(u => `
    <tr>
      <td><span style="margin-left:6px">${u.icon || '👤'}</span> <strong>${u.name}</strong></td>
      <td><code style="color:var(--text-muted)">${u.username}</code></td>
      <td><span class="role-badge ${ROLE_CLASSES[u.role] || ''}">${ROLE_LABELS[u.role] || u.role}</span></td>
      <td style="color:var(--text-muted);font-size:0.78rem">${u.lastLogin ? new Date(u.lastLogin).toLocaleDateString('ar-EG') : 'لم يسجل دخول'}</td>
      <td><span class="badge badge-${u.status === 'active' ? 'green' : 'red'}">${u.status === 'active' ? 'نشط' : 'موقوف'}</span></td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="editUser('${u.id}')"><i class="fa fa-pen"></i></button>
          ${u.id !== currentUser?.id && can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty-state"><p>لا يوجد مستخدمون</p></td></tr>';

  // Update logs filter
  const luf = el('logs-user-filter');
  if (luf) {
    luf.innerHTML = '<option value="">كل المستخدمين</option>' + (db.users || []).map(u => `<option value="${u.name}">${u.name}</option>`).join('');
  }
}

function openUserModal() {
  el('user-modal-title').textContent = 'إضافة مستخدم جديد';
  el('user-form-id').value = '';
  el('user-form-name').value = '';
  el('user-form-username').value = '';
  el('user-form-password').value = '';
  el('user-form-role').value = 'cashier';
  el('user-form-status').value = 'active';
  openModal('user-modal');
}

function editUser(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  el('user-modal-title').textContent = 'تعديل مستخدم';
  el('user-form-id').value = uid;
  el('user-form-name').value = u.name;
  el('user-form-username').value = u.username;
  el('user-form-password').value = u.password;
  el('user-form-role').value = u.role;
  el('user-form-status').value = u.status;
  openModal('user-modal');
}

function saveUser() {
  const id = el('user-form-id').value;
  const name = el('user-form-name').value.trim();
  const username = el('user-form-username').value.trim();
  const password = el('user-form-password').value;
  if (!name || !username || !password) { showToast('أكمل جميع الحقول المطلوبة', 'warning'); return; }
  if (!id && db.users.find(u => u.username === username)) { showToast('اسم الدخول موجود مسبقًا', 'error'); return; }
  const data = { name, username, password, role: el('user-form-role').value, icon: el('user-form-icon').value, status: el('user-form-status').value };
  if (id) {
    const i = db.users.findIndex(x => x.id === id);
    if (i > -1) db.users[i] = { ...db.users[i], ...data };
    addLog('تعديل', `تعديل مستخدم: ${name}`, 'user');
  } else {
    db.users.push({ id: 'u' + Date.now(), ...data, lastLogin: null });
    addLog('تعديل', `إضافة مستخدم: ${name}`, 'user');
  }
  saveDB();
  closeModal('user-modal');
  renderUsersPage();
  showToast('تم حفظ المستخدم');
}

function deleteUser(uid) {
  if (!can('delete')) { showToast('لا تملك صلاحية الحذف', 'error'); return; }
  if (uid === currentUser?.id) { showToast('لا يمكن حذف المستخدم الحالي', 'error'); return; }
  if (!confirm('حذف المستخدم؟')) return;
  const u = db.users.find(x => x.id === uid);
  db.users = db.users.filter(x => x.id !== uid);
  addLog('حذف', `حذف مستخدم: ${u?.name}`, 'حذف');
  saveDB();
  renderUsersPage();
}

// =========================================================
// ======= USER PROFILE =====================================
// =========================================================
function renderUserProfile() {
  if (!currentUser) return;
  const u = currentUser;
  const content = document.getElementById('user-profile-content');
  if (!content) return;
  content.innerHTML = `
    <div style="max-width:500px;margin:0 auto">
      <div class="card" style="padding:24px;text-align:center;margin-bottom:16px">
        <div style="font-size:3rem;margin-bottom:12px">${u.icon || '👤'}</div>
        <div style="font-size:1.4rem;font-weight:700;color:var(--text);margin-bottom:4px">${u.name}</div>
        <div class="role-badge ${ROLE_CLASSES[u.role] || ''}" style="display:inline-block">${ROLE_LABELS[u.role] || u.role}</div>
        <div style="margin-top:12px;color:var(--text-muted);font-size:0.85rem">اسم المستخدم: <strong>${u.username}</strong></div>
        ${u.lastLogin ? `<div style="color:var(--text-faint);font-size:0.8rem;margin-top:4px">آخر دخول: ${new Date(u.lastLogin).toLocaleString('ar-EG')}</div>` : ''}
      </div>
      <div class="card" style="padding:20px">
        <div style="font-weight:700;margin-bottom:14px;color:var(--text)">🔒 تغيير كلمة المرور</div>
        <input type="password" id="profile-current-pass" class="form-control" placeholder="كلمة المرور الحالية" style="margin-bottom:10px">
        <input type="password" id="profile-new-pass" class="form-control" placeholder="كلمة المرور الجديدة" style="margin-bottom:10px">
        <input type="password" id="profile-confirm-pass" class="form-control" placeholder="تأكيد كلمة المرور الجديدة" style="margin-bottom:14px">
        <button class="btn btn-primary btn-block" onclick="changeProfilePassword()">
          <i class="fa fa-lock"></i> تغيير كلمة المرور
        </button>
      </div>
    </div>
  `;
}

function changeProfilePassword() {
  const current = document.getElementById('profile-current-pass').value;
  const newPass = document.getElementById('profile-new-pass').value;
  const confirm = document.getElementById('profile-confirm-pass').value;
  if (current !== currentUser.password) { showToast('كلمة المرور الحالية غير صحيحة', 'error'); return; }
  if (!newPass || newPass.length < 4) { showToast('كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل', 'warning'); return; }
  if (newPass !== confirm) { showToast('كلمتا المرور غير متطابقتين', 'error'); return; }
  const u = db.users.find(x => x.id === currentUser.id);
  if (u) { u.password = newPass; currentUser.password = newPass; saveDB(); }
  showToast('تم تغيير كلمة المرور بنجاح', 'success');
  document.getElementById('profile-current-pass').value = '';
  document.getElementById('profile-new-pass').value = '';
  document.getElementById('profile-confirm-pass').value = '';
}

// =========================================================
// ======= THEME TOGGLE ====================================
// =========================================================
function initTheme() {
  const saved = localStorage.getItem('hassibni_theme') || 'dark';
  applyTheme(saved);
}
function applyTheme(theme) {
  document.body.classList.toggle('light-theme', theme === 'light');
  localStorage.setItem('hassibni_theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.innerHTML = theme === 'light' ? '🌙 داكن' : '☀️ فاتح';
}
function toggleTheme() {
  const isLight = document.body.classList.contains('light-theme');
  applyTheme(isLight ? 'dark' : 'light');
}

// ======= LOGS ============================================
// =========================================================
function renderLogsPage() {
  const tf = el('logs-type-filter')?.value || '';
  const uf = el('logs-user-filter')?.value || '';
  const logs = (db.logs || []).filter(l => {
    const mt = !tf || l.category === tf || l.type === tf;
    const mu = !uf || l.user === uf;
    return mt && mu;
  });
  const logColors = { بيع: 'sale', شراء: 'purchase', مرتجع: 'return', user: 'user', حذف: 'delete', تعديل: 'edit', دخول: 'user' };
  el('logs-tbody').innerHTML = logs.length ? logs.slice(0, 100).map(l => {
    const dotClass = logColors[l.category] || logColors[l.type] || 'other';
    return `<tr>
      <td><span class="badge badge-${l.category === 'بيع' ? 'green' : l.category === 'مرتجع' ? 'red' : l.category === 'حذف' ? 'orange' : 'blue'}">${l.type || l.category}</span></td>
      <td>${l.desc || '—'}</td>
      <td><span style="color:var(--accent-purple)">${l.user || '—'}</span></td>
      <td>${l.date || '—'}</td>
      <td>${l.time || '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-state"><p>لا توجد سجلات</p></td></tr>';
}

// =========================================================
// ======= SETTINGS ========================================
// =========================================================
function renderSettingsPage() {
  const s = db.settings;
  el('setting-store-name').value = s.storeName || '';
  el('setting-address').value = s.address || '';
  el('setting-contact').value = s.contact || '';
  el('setting-email').value = s.email || '';
  el('setting-tax').value = s.tax || 0;
  el('setting-currency').value = s.currency || 'جنيه';
  el('setting-low-stock').value = s.lowStock || 5;
  if (el('setting-credit-limit'))   el('setting-credit-limit').value   = s.defaultCreditLimit || 0;
  if (el('setting-max-debt'))       el('setting-max-debt').value       = s.maxCustomerDebt || 0;
  if (el('setting-min-liquidity'))  el('setting-min-liquidity').value  = s.minLiquidity || 0;
  el('setting-inv-notes').value = s.invoiceNotes || '';
  // إعدادات الفاتورة الحرارية
  if (el('setting-paper-width')) el('setting-paper-width').value = s.paperWidth || '80';
  if (el('setting-store-name-size')) {
    el('setting-store-name-size').value = s.storeNameSize || 22;
    el('store-name-size-val').textContent = s.storeNameSize || 22;
  }
  if (el('setting-data-text-size')) {
    el('setting-data-text-size').value = s.dataTextSize || 12;
    el('data-text-size-val').textContent = s.dataTextSize || 12;
  }
  // اللوجو
  if (s.storeLogo) {
    el('logo-preview-img').src = s.storeLogo;
    el('logo-preview-img').style.display = 'block';
    el('logo-placeholder-text').style.display = 'none';
    if (el('logo-delete-btn')) el('logo-delete-btn').style.display = 'inline-flex';
    updateNavLogo(s.storeLogo, s.storeName);
  }
  // مفتاح API
  const apiKeyField = el('setting-api-key');
  if (apiKeyField) {
    apiKeyField.value = s.anthropicApiKey || '';
    apiKeyField.placeholder = s.anthropicApiKey ? '••••••••••••••••••••' : 'sk-ant-...';
  }
}

function saveSettings() {
  if (!can('settings')) { showToast('لا تملك صلاحية تعديل الإعدادات', 'error'); return; }
  const apiKeyInput = el('setting-api-key');
  const newApiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
  db.settings = {
    ...db.settings,
    storeName: el('setting-store-name').value,
    address: el('setting-address').value,
    contact: el('setting-contact').value,
    email: el('setting-email').value,
    tax: parseFloat(el('setting-tax').value) || 0,
    currency: el('setting-currency').value,
    lowStock: parseInt(el('setting-low-stock').value) || 5,
    defaultCreditLimit: parseFloat(el('setting-credit-limit')?.value || 0) || 0,
    maxCustomerDebt:    parseFloat(el('setting-max-debt')?.value    || 0) || 0,
    minLiquidity:       parseFloat(el('setting-min-liquidity')?.value || 0) || 0,
    invoiceNotes: el('setting-inv-notes').value,
    paperWidth: el('setting-paper-width')?.value || '80',
    storeNameSize: parseInt(el('setting-store-name-size')?.value || 22),
    dataTextSize: parseInt(el('setting-data-text-size')?.value || 12),
    anthropicApiKey: newApiKey || (db.settings.anthropicApiKey || '')
    // storeLogo يُحفظ بشكل منفصل عبر uploadStoreLogo
  };
  saveDB();
  document.getElementById('store-name-badge').textContent = db.settings.storeName;
  showToast('تم حفظ الإعدادات ✅', 'success');
  if (newApiKey) showToast('تم حفظ مفتاح API ✅', 'success');
}

// ===== إدارة اللوجو =====
function uploadStoreLogo(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('حجم الصورة يجب أن يكون أقل من 2MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    db.settings.storeLogo = dataUrl;
    saveDB();
    // معاينة
    el('logo-preview-img').src = dataUrl;
    el('logo-preview-img').style.display = 'block';
    el('logo-placeholder-text').style.display = 'none';
    if (el('logo-delete-btn')) el('logo-delete-btn').style.display = 'inline-flex';
    updateNavLogo(dataUrl, db.settings.storeName);
    showToast('تم رفع اللوجو بنجاح ✅');
  };
  reader.readAsDataURL(file);
}

function deleteStoreLogo() {
  db.settings.storeLogo = '';
  saveDB();
  el('logo-preview-img').src = '';
  el('logo-preview-img').style.display = 'none';
  el('logo-placeholder-text').style.display = 'block';
  if (el('logo-delete-btn')) el('logo-delete-btn').style.display = 'none';
  updateNavLogo('', db.settings.storeName);
  showToast('تم حذف اللوجو');
}

function updateNavLogo(logoUrl, storeName) {
  const brandIcon = el('nav-brand-icon');
  if (!brandIcon) return;
  if (logoUrl) {
    brandIcon.innerHTML = `<img src="${logoUrl}" style="width:28px;height:28px;object-fit:contain;border-radius:4px">`;
  } else {
    const initial = (storeName || 'ح').charAt(0);
    brandIcon.innerHTML = initial;
    brandIcon.textContent = '💰';
  }
}

function exportAllData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hasibni_backup_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  showToast('تم تصدير البيانات');
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (confirm('هل تريد استيراد البيانات؟ سيتم استبدال البيانات الحالية.')) {
        db = imported;
        saveDB();
        showToast('تم استيراد البيانات بنجاح');
        renderDashboard();
      }
    } catch(err) { showToast('ملف غير صالح', 'error'); }
  };
  reader.readAsText(file);
}

function exportReportCSV() {
  const rows = [['رقم الفاتورة','التاريخ','العميل','الإجمالي','طريقة الدفع','الكاشير']];
  (db.sales || []).forEach(s => rows.push([s.id, s.date, s.customerName || 'نقدي', s.total, s.payment, s.cashier || '']));
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sales_report.csv';
  a.click();
}



// =========================================================
// ======= تصدير المنتجات (Export Products) ================
// =========================================================
function exportProductsCSV() {
  const prods = db.products || [];
  if (!prods.length) { showToast('لا توجد منتجات للتصدير', 'warning'); return; }
  const rows = [['الباركود','اسم المنتج','الفئة','سعر البيع','سعر الشراء','الكمية','الوحدة','الخصم%','الحد الأدنى للمخزون']];
  prods.forEach(p => rows.push([
    p.barcode || '',
    p.name,
    p.category || '',
    p.price,
    p.cost || 0,
    p.qty,
    p.unit || 'قطعة',
    p.discount || 0,
    p.minStock || 5
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `products_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast(`تم تصدير ${prods.length} منتج بنجاح ✅`);
  addLog('تصدير', `تصدير ${prods.length} منتج إلى CSV`, 'عرض');
}

// =========================================================
// ======= تصدير العملاء (Export Customers) ================
// =========================================================
function exportCustomersCSV() {
  const custs = db.customers || [];
  if (!custs.length) { showToast('لا يوجد عملاء للتصدير', 'warning'); return; }
  const rows = [['الاسم','الهاتف','البريد الإلكتروني','العنوان','إجمالي المشتريات','الرصيد المستحق','نقاط الولاء','تاريخ الإضافة']];
  custs.forEach(c => {
    const totalPurchases = (db.sales || []).filter(s => s.customerId === c.id).reduce((a, s) => a + (s.total || 0), 0);
    rows.push([
      c.name,
      c.phone || '',
      c.email || '',
      c.address || '',
      totalPurchases.toFixed(2),
      (c.balance || 0).toFixed(2),
      c.loyaltyPoints || 0,
      c.createdAt || ''
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `customers_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast(`تم تصدير ${custs.length} عميل بنجاح ✅`);
  addLog('تصدير', `تصدير ${custs.length} عميل إلى CSV`, 'عرض');
}

// =========================================================
// ======= إدارة الجلسة اليومية (Daily Session) ===========
// =========================================================
function renderDailySession() {
  if (!db.sessions) db.sessions = [];
  const activeSession = db.sessions.find(s => s.status === 'open');
  const sessionBadge = document.getElementById('sidebar-session-badge');

  if (activeSession) {
    // جلسة مفتوحة
    el('session-open-panel').style.display = 'block';
    el('session-closed-panel').style.display = 'none';
    el('session-status-subtitle').textContent = '🟢 الجلسة مفتوحة منذ ' + activeSession.openTime;
    if (sessionBadge) { sessionBadge.textContent = 'مفتوح'; sessionBadge.style.background = 'var(--accent-green)'; }

    el('session-open-time').textContent = activeSession.openTime;

    // حساب مبيعات الجلسة
    const sessionSales = (db.sales || []).filter(s => s.ts >= activeSession.openTs);
    const totalAmount = sessionSales.reduce((a, s) => a + (s.total || 0), 0);
    const totalProfit = sessionSales.reduce((a, s) => a + (s.profit || 0), 0);
    el('session-sales-amount').textContent = fmtCurr(totalAmount);
    el('session-invoice-count').textContent = sessionSales.length;
    el('session-profit').textContent = fmtCurr(totalProfit);

    el('session-sales-tbody').innerHTML = sessionSales.length
      ? [...sessionSales].reverse().map(s => `<tr>
          <td><strong>${s.id}</strong></td>
          <td>${new Date(s.ts).toLocaleTimeString('ar-EG')}</td>
          <td>${s.customerName || 'نقدي'}</td>
          <td style="color:var(--accent-green);font-weight:700">${fmtCurr(s.total)}</td>
          <td>${s.payment || '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty-state"><p>لا توجد مبيعات في هذه الجلسة بعد</p></td></tr>';
  } else {
    // جلسة مغلقة
    el('session-open-panel').style.display = 'none';
    el('session-closed-panel').style.display = 'block';
    el('session-status-subtitle').textContent = '🔴 اليوم مغلق - افتح الجلسة لبدء العمل';
    if (sessionBadge) { sessionBadge.textContent = 'مغلق'; sessionBadge.style.background = 'var(--accent-red)'; }

    // عرض سجل الجلسات
    const closedSessions = [...(db.sessions || [])].filter(s => s.status === 'closed').reverse();
    el('sessions-history-tbody').innerHTML = closedSessions.length
      ? closedSessions.map(s => `<tr>
          <td>${s.date}</td>
          <td>${s.openTime}</td>
          <td>${s.closeTime || '—'}</td>
          <td style="color:var(--accent-green)">${fmtCurr(s.totalSales || 0)}</td>
          <td style="color:var(--accent-blue)">${fmtCurr(s.totalProfit || 0)}</td>
          <td>${s.invoiceCount || 0}</td>
          <td>${s.openedBy || '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty-state"><p>لا توجد جلسات سابقة</p></td></tr>';
  }
}

function openSession() {
  if (!db.sessions) db.sessions = [];
  const active = db.sessions.find(s => s.status === 'open');
  if (active) { showToast('يوجد جلسة مفتوحة بالفعل', 'warning'); return; }

  const openingCash = parseFloat(el('session-opening-cash')?.value || 0);
  const notes = el('session-open-notes')?.value || '';

  // تأكيد قبل الفتح
  if (!confirm(`هل تريد فتح اليوم؟\nرصيد الخزنة الافتتاحي: ${fmtCurr(openingCash)}`)) return;

  const now = new Date();
  const session = {
    id: 'SES-' + Date.now(),
    date: now.toLocaleDateString('ar-EG'),
    openTime: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    openTs: now.toISOString(),
    openingCash,
    notes,
    openedBy: currentUser?.name || 'غير معروف',
    status: 'open',
    totalSales: 0,
    totalProfit: 0,
    invoiceCount: 0
  };
  db.sessions.push(session);
  saveDB();
  addLog('فتح', `فتح جلسة يومية - رصيد افتتاحي: ${fmtCurr(openingCash)} - بواسطة: ${session.openedBy}`, 'إضافة');
  showToast('✅ تم فتح الجلسة اليومية بنجاح - ' + session.openTime, 'success');
  renderDailySession();
  updateNavSessionBadge();
}

function closeSession() {
  if (!db.sessions) db.sessions = [];
  const active = db.sessions.find(s => s.status === 'open');
  if (!active) { showToast('لا توجد جلسة مفتوحة', 'warning'); return; }

  const sessionSales = (db.sales || []).filter(s => s.ts >= active.openTs);
  const totalSales = sessionSales.reduce((a, s) => a + (s.total || 0), 0);
  const totalProfit = sessionSales.reduce((a, s) => a + (s.profit || 0), 0);
  const totalCash = sessionSales.filter(s => s.payment === 'نقدي').reduce((a, s) => a + (s.total || 0), 0);
  const totalCard = sessionSales.filter(s => s.payment === 'بطاقة').reduce((a, s) => a + (s.total || 0), 0);

  // تأكيد مع ملخص
  const confirmMsg = `هل تريد غلق اليوم وطباعة التقرير؟\n\n` +
    `📋 عدد الفواتير: ${sessionSales.length}\n` +
    `💵 إجمالي المبيعات: ${fmtCurr(totalSales)}\n` +
    `  • نقدي: ${fmtCurr(totalCash)}\n` +
    `  • بطاقة: ${fmtCurr(totalCard)}\n` +
    `💰 صافي الربح: ${fmtCurr(totalProfit)}\n\n` +
    `هذا الإجراء لا يمكن التراجع عنه.`;

  if (!confirm(confirmMsg)) return;

  const now = new Date();
  active.status = 'closed';
  active.closeTime = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  active.closeTs = now.toISOString();
  active.closedBy = currentUser?.name || 'غير معروف';
  active.totalSales = totalSales;
  active.totalProfit = totalProfit;
  active.invoiceCount = sessionSales.length;
  active.totalCash = totalCash;
  active.totalCard = totalCard;

  // ===== حفظ الجلسة في تقارير الشهر =====
  if (!db.monthlySessionReports) db.monthlySessionReports = [];
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
  db.monthlySessionReports.push({
    id: active.id,
    date: active.date,
    monthKey,
    openTime: active.openTime,
    closeTime: active.closeTime,
    openedBy: active.openedBy,
    closedBy: active.closedBy,
    totalSales,
    totalProfit,
    totalCash,
    totalCard,
    invoiceCount: sessionSales.length,
    openingCash: active.openingCash || 0
  });

  saveDB();
  addLog('غلق', `غلق جلسة يومية - مبيعات: ${fmtCurr(totalSales)} - فواتير: ${sessionSales.length} - بواسطة: ${active.closedBy}`, 'تعديل');

  // طباعة تقرير الجلسة
  printSessionReport(active, sessionSales);
  showToast('✅ تم غلق الجلسة اليومية وطباعة التقرير');

  // تحديث badge
  const badge = document.getElementById('sidebar-session-badge');
  if (badge) { badge.textContent = 'مغلق'; badge.style.background = 'var(--accent-red)'; }

  renderDailySession();
  updateNavSessionBadge();
}

function printSessionReport(session, sales) {
  const st = db.settings;
  const cur = st.currency || 'جنيه';
  const totalCash = sales.filter(s => s.payment === 'نقدي').reduce((a, s) => a + (s.total || 0), 0);
  const totalCard = sales.filter(s => s.payment === 'بطاقة').reduce((a, s) => a + (s.total || 0), 0);
  const totalDeferred = sales.filter(s => s.payment === 'آجل').reduce((a, s) => a + (s.total || 0), 0);
  const expectedCash = (session.openingCash || 0) + totalCash;

  const w = window.open('', '_blank', 'width=420,height=750');
  if (!w) { showToast('يرجى السماح بالنوافذ المنبثقة للطباعة', 'warning'); return; }
  w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl">
  <head><meta charset="UTF-8"><title>تقرير غلق اليوم</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Cairo',monospace;background:#f5f5f5;padding:20px;display:flex;justify-content:center}
    .receipt{background:#fff;width:300px;padding:14px 16px;font-size:12px;color:#000;box-shadow:0 2px 12px rgba(0,0,0,.15)}
    .receipt::before,.receipt::after{content:'';display:block;height:7px;background:repeating-linear-gradient(90deg,#fff 0,#fff 5px,#e5e5e5 5px,#e5e5e5 7px);margin:0 -16px}
    .receipt::before{margin-bottom:14px}
    .receipt::after{margin-top:14px}
    .header{text-align:center;border-bottom:1px dashed #333;padding-bottom:10px;margin-bottom:10px}
    .store-name{font-size:20px;font-weight:900}
    .store-sub{font-size:10px;color:#555;line-height:1.7}
    .title{text-align:center;font-size:14px;font-weight:900;background:#000;color:#fff;padding:5px;margin:8px 0;border-radius:4px}
    .row{display:flex;justify-content:space-between;font-size:11.5px;line-height:2.1;border-bottom:1px dotted #eee}
    .row:last-child{border-bottom:none}
    .section{margin:8px 0;border:1px solid #eee;border-radius:4px;padding:6px 8px}
    .section-title{font-size:11px;font-weight:900;color:#555;margin-bottom:4px;border-bottom:1px dashed #ccc;padding-bottom:3px}
    .highlight{font-size:14px;font-weight:900;color:#16a34a;border-top:2px solid #000;margin-top:6px;padding-top:8px;display:flex;justify-content:space-between}
    .profit{font-size:13px;font-weight:900;color:#2563eb;display:flex;justify-content:space-between;margin-top:4px}
    .dashed{border:none;border-top:1px dashed #999;margin:8px 0}
    table{width:100%;border-collapse:collapse;font-size:10.5px;margin-top:4px}
    thead tr{border-bottom:2px solid #000}
    th{padding:3px 4px;text-align:right;font-size:10px}
    td{padding:3px 4px;border-bottom:1px dotted #ddd;text-align:right}
    td:last-child{font-weight:700}
    .footer{text-align:center;font-size:10px;color:#888;margin-top:10px;line-height:1.8}
    @media print{body{background:none;padding:0}.receipt{box-shadow:none;width:100%}}
  </style></head>
  <body><div class="receipt">
    <div class="header">
      <div class="store-name">${st.storeName || 'حاسبني'}</div>
      ${st.address ? `<div class="store-sub">${st.address}</div>` : ''}
      ${st.contact ? `<div class="store-sub">📞 ${st.contact}</div>` : ''}
    </div>
    <div class="title">📋 تقرير غلق اليوم</div>

    <div class="section">
      <div class="section-title">⏱️ معلومات الجلسة</div>
      <div class="row"><span>التاريخ</span><span><b>${session.date}</b></span></div>
      <div class="row"><span>وقت الفتح</span><span>${session.openTime}</span></div>
      <div class="row"><span>وقت الغلق</span><span>${session.closeTime}</span></div>
      <div class="row"><span>فتح بواسطة</span><span>${session.openedBy}</span></div>
      <div class="row"><span>غلق بواسطة</span><span>${session.closedBy}</span></div>
    </div>

    <div class="section">
      <div class="section-title">📊 ملخص المبيعات</div>
      <div class="row"><span>عدد الفواتير</span><span><b>${sales.length}</b></span></div>
      <div class="row"><span>نقدي</span><span>${totalCash.toFixed(2)} ${cur}</span></div>
      <div class="row"><span>بطاقة</span><span>${totalCard.toFixed(2)} ${cur}</span></div>
      <div class="row"><span>آجل</span><span>${totalDeferred.toFixed(2)} ${cur}</span></div>
      <div class="highlight"><span>💵 إجمالي المبيعات</span><span>${session.totalSales.toFixed(2)} ${cur}</span></div>
      <div class="profit"><span>💰 صافي الربح</span><span>${session.totalProfit.toFixed(2)} ${cur}</span></div>
    </div>

    <div class="section">
      <div class="section-title">💵 تسوية الخزنة</div>
      <div class="row"><span>رصيد افتتاحي</span><span>${(session.openingCash || 0).toFixed(2)} ${cur}</span></div>
      <div class="row"><span>+ مبيعات نقدي</span><span>${totalCash.toFixed(2)} ${cur}</span></div>
      <div class="row" style="font-weight:900"><span>= الإجمالي المتوقع</span><span>${expectedCash.toFixed(2)} ${cur}</span></div>
    </div>

    ${sales.length ? `
    <hr class="dashed">
    <div style="font-size:10px;font-weight:900;margin-bottom:4px">تفاصيل الفواتير:</div>
    <table>
      <thead><tr><th>الفاتورة</th><th>العميل</th><th>المبلغ</th><th>الدفع</th></tr></thead>
      <tbody>${sales.map(s => `<tr>
        <td>${s.id}</td>
        <td>${s.customerName || 'نقدي'}</td>
        <td>${(s.total||0).toFixed(2)}</td>
        <td>${s.payment||''}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div style="text-align:center;color:#999;font-size:11px;padding:8px">لا توجد مبيعات في هذه الجلسة</div>'}

    <hr class="dashed">
    <div class="footer">
      تم الطباعة: ${new Date().toLocaleString('ar-EG')}<br>
      Powered by حاسبني
    </div>
  </div>
  <script>window.print();<\/script>
  </body></html>`);
  w.document.close();
}

// =========================================================
// ======= المساعد الذكي (AI Bot) ==========================
// =========================================================
let aiBotVisible = false;

function toggleAIBot() {
  aiBotVisible = !aiBotVisible;
  const panel = document.getElementById('ai-bot-panel');
  const fab = document.getElementById('ai-bot-fab');
  if (aiBotVisible) {
    panel.style.display = 'flex';
    if (fab) fab.style.display = 'none';
    document.getElementById('ai-user-input').focus();
  } else {
    panel.style.display = 'none';
    if (fab) fab.style.display = 'flex';
  }
}

function askAI(question) {
  el('ai-user-input').value = question;
  sendAIMessage();
}

function getSystemContext() {
  const today = new Date().toLocaleDateString('ar-EG');
  const sales = db.sales || [];
  const todaySales = sales.filter(s => s.date === today);
  const totalRevenue = sales.reduce((a, s) => a + (s.total || 0), 0);
  const totalProfit = sales.reduce((a, s) => a + (s.profit || 0), 0);
  const lowStockProducts = (db.products || []).filter(p => p.qty <= (db.settings.lowStock || 5));
  const topCustomers = [...(db.customers || [])].sort((a, b) => {
    const aSales = sales.filter(s => s.customerId === a.id).reduce((x, s) => x + s.total, 0);
    const bSales = sales.filter(s => s.customerId === b.id).reduce((x, s) => x + s.total, 0);
    return bSales - aSales;
  }).slice(0, 5);

  // Top products
  const productSales = {};
  sales.forEach(s => (s.items || []).forEach(item => {
    productSales[item.productId] = (productSales[item.productId] || 0) + item.qty;
  }));
  const topProducts = (db.products || []).map(p => ({ ...p, soldQty: productSales[p.id] || 0 }))
    .sort((a, b) => b.soldQty - a.soldQty).slice(0, 5);

  return `أنت مساعد محاسبي ذكي لنظام "حاسبني". إليك بيانات المتجر الحالية:

اسم المتجر: ${db.settings.storeName || 'متجري'}
العملة: ${db.settings.currency || 'جنيه'}
اليوم: ${today}

إحصائيات اليوم:
- مبيعات اليوم: ${todaySales.reduce((a, s) => a + s.total, 0).toFixed(2)} ${db.settings.currency || 'جنيه'}
- فواتير اليوم: ${todaySales.length}

إحصائيات عامة:
- إجمالي المنتجات: ${(db.products || []).length}
- إجمالي العملاء: ${(db.customers || []).length}
- إجمالي الفواتير: ${sales.length}
- إجمالي الإيرادات: ${totalRevenue.toFixed(2)} ${db.settings.currency || 'جنيه'}
- إجمالي الأرباح: ${totalProfit.toFixed(2)} ${db.settings.currency || 'جنيه'}
- منتجات منخفضة المخزون: ${lowStockProducts.length} منتج ${lowStockProducts.slice(0,3).map(p => p.name).join('، ')}

أفضل العملاء: ${topCustomers.slice(0,3).map(c => c.name).join('، ')}
أكثر المنتجات مبيعاً: ${topProducts.slice(0,3).map(p => p.name + ' (' + p.soldQty + ')').join('، ')}

أجب بالعربية بشكل واضح ومفيد ومختصر. استخدم الأرقام والإحصائيات المتاحة. لا تتجاوز 200 كلمة في ردك.`;
}

async function sendAIMessage() {
  const input = el('ai-user-input');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  const container = el('ai-chat-messages');

  // رسالة المستخدم
  const userDiv = document.createElement('div');
  userDiv.className = 'ai-msg user';
  userDiv.innerHTML = `<div class="ai-bubble">${msg}</div>`;
  container.appendChild(userDiv);
  container.scrollTop = container.scrollHeight;

  // مؤشر الكتابة
  const typingDiv = document.createElement('div');
  typingDiv.className = 'ai-msg bot';
  typingDiv.innerHTML = '<div class="ai-bubble ai-typing"><span></span><span></span><span></span></div>';
  container.appendChild(typingDiv);
  container.scrollTop = container.scrollHeight;

  // التحقق من وجود مفتاح API - البوت يعمل بدون مفتاح تلقائياً
  const apiKey = (db.settings && db.settings.anthropicApiKey) ? db.settings.anthropicApiKey.trim() : 'internal';
  
  try {
    const systemContext = getSystemContext();
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (apiKey && apiKey !== 'internal') {
      headers['x-api-key'] = apiKey;
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemContext,
        messages: [{ role: 'user', content: msg }]
      })
    });

    const data = await response.json();

    if (data.error) {
      typingDiv.remove();
      const errDiv = document.createElement('div');
      errDiv.className = 'ai-msg bot';
      const errMsg = data.error.type === 'authentication_error'
        ? '❌ مفتاح API غير صحيح. تحقق منه في الإعدادات.'
        : `❌ خطأ: ${data.error.message || 'حدث خطأ غير متوقع'}`;
      errDiv.innerHTML = `<div class="ai-bubble" style="color:var(--accent-red)">${errMsg}</div>`;
      container.appendChild(errDiv);
      container.scrollTop = container.scrollHeight;
      return;
    }

    const reply = data.content?.map(b => b.text || '').join('') || 'عذراً، لم أتمكن من توليد رد. حاول مرة أخرى.';

    typingDiv.remove();
    const botDiv = document.createElement('div');
    botDiv.className = 'ai-msg bot';
    botDiv.innerHTML = `<div class="ai-bubble">${reply.replace(/\n/g, '<br>')}</div>`;
    container.appendChild(botDiv);
  } catch (err) {
    typingDiv.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'ai-msg bot';
    errDiv.innerHTML = '<div class="ai-bubble" style="color:var(--accent-red)">❌ تعذّر الاتصال بالمساعد. تأكد من الاتصال بالإنترنت ومن صحة مفتاح API.</div>';
    container.appendChild(errDiv);
  }
  container.scrollTop = container.scrollHeight;
}


function resetAllData() {
  if (!can('settings')) { showToast('لا تملك صلاحية إعادة الضبط', 'error'); return; }
  if (!confirm('⚠️ هل أنت متأكد؟ سيتم حذف كل البيانات نهائيًا!')) return;
  if (!confirm('تأكيد أخير: حذف كل البيانات؟')) return;
  db = getDefaultDB();
  saveDB();
  showToast('تم إعادة الضبط');
  navigate('home');
}

// =========================================================
// ======= INIT ============================================
// =========================================================
renderLoginUsers();
initTheme();

// ===== إخفاء شاشة التحميل بعد 1.4 ثانية =====
setTimeout(() => {
  const splash = el('app-splash');
  if (splash) {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 400);
  }
}, 1400);

// ===== تحسين الأداء: lazy load الصور =====
if ('IntersectionObserver' in window) {
  const imgObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) { img.src = img.dataset.src; imgObserver.unobserve(img); }
      }
    });
  });
  window._imgObserver = imgObserver;
}

// تحميل اللوجو عند بدء التشغيل
if (db.settings && db.settings.storeLogo) {
  updateNavLogo(db.settings.storeLogo, db.settings.storeName);
}
// تحديث مؤشر الجلسة
function updateNavSessionBadge() {
  if (!db.sessions) return;
  const active = db.sessions.find(s => s.status === 'open');
  const ind = document.getElementById('nav-session-indicator');
  const badge = document.getElementById('sidebar-session-badge');
  if (ind) {
    if (active) {
      ind.textContent = '🟢 مفتوح';
      ind.style.background = 'rgba(22,163,74,0.15)';
      ind.style.color = '#16a34a';
    } else {
      ind.textContent = '🔴 مغلق';
      ind.style.background = 'rgba(239,68,68,0.15)';
      ind.style.color = '#ef4444';
    }
  }
  if (badge) {
    if (active) { badge.textContent = 'مفتوح'; badge.style.background = 'var(--accent-green)'; }
    else { badge.textContent = 'مغلق'; badge.style.background = 'var(--accent-red)'; }
  }
}
// Set today's date for inputs
document.addEventListener('DOMContentLoaded', () => {
  const today = new Date().toISOString().split('T')[0];
  ['treasury-date', 'expense-date'].forEach(id => {
    const el2 = document.getElementById(id);
    if (el2 && !el2.value) el2.value = today;
  });
});

// =========================================================
// ======= ELECTRON INTEGRATION ============================
// =========================================================
if (window.electronAPI) {
  // تصدير البيانات عند طلب القائمة
  window.electronAPI.onExportData((filePath) => {
    try {
      const data = localStorage.getItem(DB_KEY) || '{}';
      window.electronAPI.saveFile(filePath, data);
      showToast('تم تصدير البيانات بنجاح ✅', 'success');
    } catch(e) {
      showToast('خطأ في التصدير: ' + e.message, 'error');
    }
  });

  // استيراد البيانات
  window.electronAPI.onImportData((data) => {
    try {
      const parsed = JSON.parse(data);
      if (!confirm('سيتم استبدال جميع البيانات الحالية. هل تريد المتابعة؟')) return;
      localStorage.setItem(DB_KEY, JSON.stringify(parsed));
      db = loadDB();
      showToast('تم استيراد البيانات بنجاح ✅ — سيتم تحديث الصفحة', 'success');
      setTimeout(() => location.reload(), 1500);
    } catch(e) {
      showToast('ملف غير صالح: ' + e.message, 'error');
    }
  });

  // تأكيد حفظ الملف
  window.electronAPI.onSaveFileDone && window.electronAPI.onSaveFileDone((result) => {
    if (result.success) showToast('تم حفظ الملف ✅', 'success');
    else showToast('خطأ في الحفظ: ' + result.error, 'error');
  });
}

// نسخ احتياطي تلقائي كل 30 دقيقة
setInterval(() => {
  saveDBNow();
  console.log('[حاسبني] حفظ تلقائي:', new Date().toLocaleTimeString('ar-EG'));
}, 30 * 60 * 1000);


// =========================================================
// ======= FAST NUMPAD FOR POS ============================
// =========================================================
let _numpadTarget = null; // 'qty' | 'paid' | 'discount'
let _numpadValue = '';

function openNumpad(target, currentVal) {
  _numpadTarget = target;
  _numpadValue = String(currentVal || '');
  const modal = document.getElementById('numpad-modal');
  if (!modal) { _buildNumpadModal(); }
  document.getElementById('numpad-display').textContent = _numpadValue || '0';
  const titles = { qty: 'إدخال الكمية', paid: 'المبلغ المدفوع', discount: 'نسبة الخصم %' };
  document.getElementById('numpad-title').textContent = titles[target] || 'إدخال';
  document.getElementById('numpad-modal').style.display = 'flex';
}

function closeNumpad() {
  const modal = document.getElementById('numpad-modal');
  if (modal) modal.style.display = 'none';
}

function numpadKey(k) {
  if (k === 'C') { _numpadValue = ''; }
  else if (k === '⌫') { _numpadValue = _numpadValue.slice(0, -1); }
  else if (k === '.' && _numpadValue.includes('.')) { return; }
  else { _numpadValue += k; }
  document.getElementById('numpad-display').textContent = _numpadValue || '0';
}

function numpadConfirm() {
  const val = parseFloat(_numpadValue) || 0;
  if (_numpadTarget === 'paid') {
    const inp = document.getElementById('pos-paid-amount');
    if (inp) { inp.value = val; calcChange(); }
  } else if (_numpadTarget === 'discount') {
    const inp = document.getElementById('pos-discount-input');
    if (inp) { inp.value = val; }
    renderCart();
  } else if (_numpadTarget === 'qty' && cart.length) {
    // تطبيق على آخر منتج في السلة
    const last = cart[cart.length - 1];
    if (val > 0) { last.qty = Math.floor(val); recalcItemSubtotal(last); renderCart(); }
  }
  closeNumpad();
}

function _buildNumpadModal() {
  const div = document.createElement('div');
  div.id = 'numpad-modal';
  div.style.cssText = `
    display:none;position:fixed;inset:0;z-index:10000;
    background:rgba(0,0,0,0.7);align-items:center;justify-content:center;
  `;
  div.innerHTML = `
  <div style="background:var(--card);border-radius:20px;padding:24px;width:300px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div id="numpad-title" style="font-weight:900;font-size:1.1rem;color:var(--accent-blue)">إدخال</div>
      <button onclick="closeNumpad()" style="background:none;border:none;color:var(--text-muted);font-size:1.4rem;cursor:pointer">✕</button>
    </div>
    <div id="numpad-display" style="
      background:var(--bg3);border-radius:12px;padding:14px 18px;
      font-size:2rem;font-weight:900;text-align:left;margin-bottom:16px;
      color:var(--accent-green);letter-spacing:2px;min-height:64px;
    ">0</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
      ${['7','8','9','4','5','6','1','2','3','.',0,'⌫'].map(k=>`
        <button onclick="numpadKey('${k}')" style="
          background:var(--bg3);border:1px solid var(--border);border-radius:10px;
          padding:16px;font-size:1.3rem;font-weight:700;color:var(--text);
          cursor:pointer;transition:background 0.1s;
        " onmousedown="this.style.background='var(--accent-blue)'" onmouseup="this.style.background='var(--bg3)'">${k}</button>
      `).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <button onclick="numpadKey('C')" style="
        background:rgba(239,68,68,0.15);border:1px solid var(--accent-red);
        border-radius:10px;padding:14px;font-size:1rem;font-weight:700;
        color:var(--accent-red);cursor:pointer
      ">مسح</button>
      <button onclick="numpadConfirm()" style="
        background:var(--accent-green);border:none;border-radius:10px;
        padding:14px;font-size:1rem;font-weight:900;color:#000;cursor:pointer
      ">✓ تأكيد</button>
    </div>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => { if (e.target === div) closeNumpad(); });
}

// إنشاء الـ numpad عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', _buildNumpadModal);

// =========================================================
// ======= QUICK INVOICE PREVIEW (before print) ===========
// =========================================================
function previewInvoice(sale) {
  const saleData = sale || _buildTempSale();
  const html = _buildInvoiceHTML(saleData, false);
  let overlay = document.getElementById('inv-preview-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'inv-preview-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.8);
      display:flex;align-items:center;justify-content:center;
    `;
    overlay.innerHTML = `
      <div style="background:var(--card);border-radius:16px;max-width:500px;width:95vw;max-height:90vh;overflow:hidden;display:flex;flex-direction:column">
        <div style="padding:14px 18px;background:var(--bg3);display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:900;color:var(--accent-blue)">معاينة الفاتورة</div>
          <div style="display:flex;gap:8px">
            <button id="inv-preview-print" style="background:var(--accent-green);border:none;border-radius:8px;padding:8px 18px;font-weight:700;color:#000;cursor:pointer;font-family:Cairo,sans-serif">🖨️ طباعة</button>
            <button onclick="document.getElementById('inv-preview-overlay').style.display='none'" style="background:rgba(239,68,68,0.2);border:1px solid var(--accent-red);border-radius:8px;padding:8px 14px;color:var(--accent-red);cursor:pointer;font-family:Cairo,sans-serif">✕ إغلاق</button>
          </div>
        </div>
        <div id="inv-preview-body" style="overflow-y:auto;padding:20px;display:flex;justify-content:center"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
  }
  overlay.style.display = 'flex';
  document.getElementById('inv-preview-body').innerHTML = html;
  document.getElementById('inv-preview-print').onclick = () => {
    printInvoice(saleData);
    overlay.style.display = 'none';
  };
}

// =========================================================
// ======= BARCODE SCANNER BEEP ============================
// =========================================================
function _beep(freq = 880, dur = 80) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur/1000);
    osc.start(); osc.stop(ctx.currentTime + dur/1000);
  } catch(e) {}
}

// =========================================================
// ======= KEYBOARD SHORTCUT: NUMPAD KEYS ==================
// =========================================================
document.addEventListener('keydown', function(e) {
  // Numpad Enter = complete sale when on POS page
  if (e.key === 'NumpadEnter' || (e.key === 'Enter' && e.ctrlKey)) {
    if (document.getElementById('page-pos')?.style?.display !== 'none') {
      e.preventDefault();
      completeSale();
    }
  }
  // Numpad keys open numpad for paid amount
  if (/^Numpad\d$/.test(e.code) && !e.ctrlKey && !e.altKey) {
    const activePage = document.getElementById('page-pos');
    if (activePage && activePage.style.display !== 'none') {
      const digit = e.key;
      const inp = document.getElementById('pos-paid-amount');
      if (inp && document.activeElement !== inp) {
        inp.focus();
      }
    }
  }
});

// =========================================================
// ======= SALE RECEIPT SHARE VIA CLIPBOARD ================
// =========================================================
function copyInvoiceText(sale) {
  const lines = [
    `🧾 فاتورة ${sale.id}`,
    `📅 ${sale.date}`,
    `👤 ${sale.customerName || 'نقدي'}`,
    `💳 ${sale.payment}`,
    '─────────────',
    ...(sale.items||[]).map(i => `  ${i.name}  ×${i.qty}  = ${(+i.subtotal||+i.price*i.qty).toFixed(2)}`),
    '─────────────',
    sale.discount > 0 ? `  خصم: - ${(+sale.discount).toFixed(2)}` : '',
    sale.tax > 0 ? `  ضريبة: ${(+sale.tax).toFixed(2)}` : '',
    `💰 الإجمالي: ${(+sale.total).toFixed(2)} ${db.settings?.currency || 'جنيه'}`,
    '',
    db.settings?.invoiceNotes || 'شكرًا لتعاملكم معنا'
  ].filter(Boolean).join('\n');
  
  navigator.clipboard?.writeText(lines)
    .then(() => showToast('تم نسخ الفاتورة للحافظة ✅'))
    .catch(() => showToast('تعذر النسخ', 'error'));
}

// =========================================================
// ======= AUTO-FOCUS POS SEARCH ON PAGE LOAD ==============
// =========================================================
const _origNavigate = navigate;
// Patch navigate to auto-focus POS search
// [pos focus — integrated into navigate()]


// =========================================================
// ======= WHOLESALE POS — نقطة بيع الجملة ================
// =========================================================

let wsCart = []; // سلة الجملة
let wsSuspended = []; // طلبات معلقة

// ---- تهيئة الصفحة ----
function renderWholesale() {
  updateWholesaleMeta();
  renderWholesaleProducts();
  renderWholesaleCart();
  renderWsTopProducts();
  // ملء الفئات
  const catSel = el('ws-cat-filter');
  if (catSel) {
    catSel.innerHTML = '<option value="all">كل الفئات</option>' +
      (db.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
  }
  // ملء العملاء
  const custSel = el('ws-customer-select');
  if (custSel) {
    const cur = custSel.value;
    custSel.innerHTML = '<option value="">🏢 عميل جملة نقدي</option>' +
      (db.customers || []).map(c => `<option value="${c.id}" ${c.id===cur?'selected':''}>${c.name}</option>`).join('');
    custSel.value = cur;
  }
}

function updateWholesaleMeta() {
  const now = new Date();
  if (el('ws-inv-datetime')) el('ws-inv-datetime').textContent =
    now.toLocaleDateString('ar-EG') + ' — ' + now.toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit'});
  if (el('ws-inv-cashier')) el('ws-inv-cashier').textContent = currentUser?.name || '—';
  const count = (db.sales || []).filter(s => s.type === 'wholesale').length + 1;
  if (el('ws-inv-number')) el('ws-inv-number').textContent = 'WS-' + String(count).padStart(4, '0');
}

// ---- شبكة المنتجات بأسعار الجملة ----
const _renderWsProductsFast = debounce(function() {
  const q = (el('ws-search')?.value || '').trim().toLowerCase();
  const cat = el('ws-cat-filter')?.value || 'all';
  const grid = el('ws-products-grid');
  if (!grid) return;
  const prods = (db.products || []).filter(p => {
    const matchQ = !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q);
    const matchC = cat === 'all' || p.category === cat;
    return matchQ && matchC;
  });
  if (!prods.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted);font-size:0.8rem">لا توجد منتجات</div>'; return; }
  const frag = document.createDocumentFragment();
  prods.forEach(p => {
    const wsPrice = p.wholesalePrice || p.price;
    const div = document.createElement('div');
    div.className = 'product-card-sm ws-card' + (p.qty <= 0 ? ' out-of-stock' : '');
    div.onclick = () => addToWholesaleCart(p.id);
    div.innerHTML = `
      <div class="pcsm-img">${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.style.display='none'">` : (p.qty <= 0 ? '❌' : '📦')}</div>
      <div class="pcsm-name">${p.name}</div>
      <div class="pcsm-price" style="color:var(--accent-purple)">${fmtCurr(wsPrice)}</div>
      ${p.wholesaleMin ? `<div style="font-size:0.62rem;color:var(--text-muted);padding-bottom:3px">جملة من ${p.wholesaleMin}</div>` : ''}`;
    frag.appendChild(div);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
}, 80);

function renderWholesaleProducts() { _renderWsProductsFast(); }

// ---- أعلى مبيعات الجملة ----
function renderWsTopProducts() {
  const container = el('ws-top-products');
  if (!container) return;
  if (!_cache.wsTopMap) {
    const map = {};
    (db.sales || []).filter(s => s.type === 'wholesale').forEach(s => {
      (s.items || []).forEach(i => { map[i.productId] = (map[i.productId] || 0) + (i.qty || 1); });
    });
    _cache.wsTopMap = map;
  }
  const sorted = Object.entries(_cache.wsTopMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!sorted.length) { container.innerHTML = '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:0.78rem">لا توجد مبيعات جملة بعد</div>'; return; }
  const frag = document.createDocumentFragment();
  sorted.forEach(([pid, cnt]) => {
    const p = (db.products || []).find(x => x.id === pid);
    if (!p) return;
    const row = document.createElement('div');
    row.className = 'ptpc-row';
    row.style.borderRight = '3px solid var(--accent-purple)';
    row.onclick = () => addToWholesaleCart(p.id);
    row.innerHTML = `<div class="ptpc-row-img">${p.image ? `<img src="${p.image}" loading="lazy">` : '📦'}</div>
      <div class="ptpc-row-name">${p.name}</div>
      <div class="ptpc-row-count" style="color:var(--accent-purple)">${cnt}</div>`;
    frag.appendChild(row);
  });
  container.innerHTML = '';
  container.appendChild(frag);
}

// ---- بحث منسدل ----
function showWholesaleDropdown() {
  const q = (el('ws-search')?.value || '').trim().toLowerCase();
  const dd = el('ws-search-dropdown');
  if (!dd) return;
  renderWholesaleProducts();
  if (!q) { dd.classList.remove('open'); return; }
  const results = (db.products || []).filter(p =>
    p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q)
  ).slice(0, 8);
  if (!results.length) { dd.innerHTML = '<div class="psd-empty">لا توجد نتائج</div>'; dd.classList.add('open'); return; }
  dd.innerHTML = results.map(p => {
    const wsPrice = p.wholesalePrice || p.price;
    return `<div class="psd-row" onclick="addToWholesaleCart('${p.id}');el('ws-search').value='';el('ws-search-dropdown').classList.remove('open');renderWholesaleProducts()">
      <div class="psd-img">${p.image ? `<img src="${p.image}" onerror="this.parentElement.textContent='📦'">` : '📦'}</div>
      <div class="psd-info">
        <div class="psd-name">${p.name}</div>
        <div class="psd-cat">${p.category || ''} | باركود: ${p.barcode || '—'}</div>
      </div>
      <div>
        <div class="psd-price" style="color:var(--accent-purple)">${fmtCurr(wsPrice)} <span style="font-size:0.7rem;color:var(--text-muted);text-decoration:line-through">${fmtCurr(p.price)}</span></div>
        <div class="psd-stock">مخزون: ${p.qty || 0}</div>
      </div>
    </div>`;
  }).join('');
  dd.classList.add('open');
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#ws-search-dropdown') && !e.target.closest('#ws-search'))
    if (el('ws-search-dropdown')) el('ws-search-dropdown').classList.remove('open');
});

// ---- باركود ----
function wsBarcodeScan() {
  const val = (el('ws-barcode-input')?.value || '').trim();
  if (val.length < 3) return;
  const p = (db.products || []).find(x => x.barcode === val);
  if (p) { addToWholesaleCart(p.id); setTimeout(() => { if (el('ws-barcode-input')) el('ws-barcode-input').value = ''; }, 300); }
}

// ---- الحصول على سعر الجملة للمنتج ----
function getWholesalePrice(p, qty = 1) {
  if (p.wholesalePrice && qty >= (p.wholesaleMin || 10)) return p.wholesalePrice;
  return p.price;
}

// ---- إضافة للسلة ----
function addToWholesaleCart(pid) {
  const p = (db.products || []).find(x => x.id === pid);
  if (!p) return;
  const existing = wsCart.find(x => x.productId === pid);
  if (existing) {
    existing.qty++;
    existing.price = getWholesalePrice(p, existing.qty);
    existing.isWholesalePrice = p.wholesalePrice && existing.qty >= (p.wholesaleMin || 10);
    existing.subtotal = existing.qty * existing.price;
  } else {
    const wsPrice = getWholesalePrice(p, 1);
    wsCart.push({
      productId: pid, name: p.name,
      retailPrice: parseFloat(p.price),
      price: wsPrice,
      cost: parseFloat(p.cost || 0),
      qty: 1, subtotal: wsPrice,
      unit: p.unit || 'قطعة',
      discount: p.discount || 0,
      image: p.image || '',
      barcode: p.barcode || '',
      wholesalePrice: p.wholesalePrice || null,
      wholesaleMin: p.wholesaleMin || 10,
      isWholesalePrice: false
    });
  }
  renderWholesaleCart();
}

// ---- تغيير الكمية وإعادة حساب السعر ----
function changeWsQty(pid, delta) {
  const item = wsCart.find(x => x.productId === pid);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  const p = (db.products || []).find(x => x.id === pid);
  if (p && item.qty > p.qty) { item.qty = p.qty; showToast('الكمية المتاحة: ' + p.qty, 'warning'); }
  if (p) {
    item.price = getWholesalePrice(p, item.qty);
    item.isWholesalePrice = !!(p.wholesalePrice && item.qty >= (p.wholesaleMin || 10));
  }
  item.subtotal = item.qty * item.price;
  renderWholesaleCart();
}

function removeWsItem(pid) {
  wsCart = wsCart.filter(x => x.productId !== pid);
  renderWholesaleCart();
}

function clearWholesaleCart() {
  wsCart = [];
  if (el('ws-discount-input')) el('ws-discount-input').value = '';
  if (el('ws-notes')) el('ws-notes').value = '';
  if (el('ws-paid-amount')) el('ws-paid-amount').value = '';
  renderWholesaleCart();
}

// ---- رسم السلة ----
function renderWholesaleCart() {
  const container = el('ws-cart-items');
  if (!container) return;
  if (!wsCart.length) {
    container.innerHTML = '<div class="empty-state" style="padding:40px"><div class="empty-icon">📦</div><p>ابحث عن منتج لإضافته لفاتورة الجملة</p></div>';
    ['ws-saving','ws-subtotal','ws-discount-show','ws-tax','ws-total'].forEach(id => { if(el(id)) el(id).textContent = '0.00'; });
    return;
  }
  container.innerHTML = wsCart.map((item, i) => `
    <div class="pos-cart-row" style="grid-template-columns:32px 40px 1fr 110px 85px 85px 90px 60px 90px 36px">
      <div class="pit-col pit-col-num">${i + 1}</div>
      <div class="pit-col pit-col-img"><div class="pos-item-img">${item.image ? `<img src="${item.image}">` : '📦'}</div></div>
      <div class="pit-col pit-col-name" style="font-weight:700">${item.name}
        ${item.isWholesalePrice ? '<span style="font-size:0.65rem;background:rgba(139,92,246,0.15);color:var(--accent-purple);border-radius:4px;padding:1px 5px;margin-right:4px">💼جملة</span>' : ''}
      </div>
      <div class="pit-col pit-col-bar" style="font-size:0.75rem;color:var(--text-muted)">${item.barcode || '—'}</div>
      <div class="pit-col" style="width:85px;text-align:center;flex-shrink:0;font-size:0.78rem;color:var(--text-muted);text-decoration:line-through">${fmtCurr(item.retailPrice)}</div>
      <div class="pit-col pit-col-price" style="width:85px">
        <span style="color:var(--accent-purple);font-weight:700;font-size:0.88rem">${fmtCurr(item.price)}</span>
      </div>
      <div class="pit-col pit-col-qty">
        <div class="pit-qty-ctrl">
          <button class="pit-qty-btn" style="border-color:var(--accent-purple)" onclick="changeWsQty('${item.productId}',1)">+</button>
          <span class="pit-qty-num">${item.qty}</span>
          <button class="pit-qty-btn" onclick="changeWsQty('${item.productId}',-1)">−</button>
        </div>
        ${item.wholesaleMin && !item.isWholesalePrice ? `<div style="font-size:0.62rem;color:var(--accent-orange);text-align:center">الجملة من ${item.wholesaleMin}</div>` : ''}
      </div>
      <div class="pit-col pit-col-unit" style="font-size:0.8rem;color:var(--text-muted)">${item.unit}</div>
      <div class="pit-col pit-col-total" style="color:var(--accent-purple);font-weight:800">${fmtCurr(item.subtotal)}</div>
      <div class="pit-col pit-col-del"><button class="pit-del-btn" onclick="removeWsItem('${item.productId}')"><i class="fa fa-trash"></i></button></div>
    </div>
  `).join('');

  // حساب المجاميع
  const sub = wsCart.reduce((a, x) => a + x.subtotal, 0);
  const retailTotal = wsCart.reduce((a, x) => a + x.retailPrice * x.qty, 0);
  const saving = retailTotal - sub;
  const discVal = parseFloat(el('ws-discount-input')?.value || 0) || 0;
  const discType = el('ws-discount-type')?.value || 'percent';
  let disc = discType === 'percent' ? (sub * discVal / 100) : discVal;
  disc = Math.min(disc, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - disc;
  const tax = afterDisc * taxRate;
  const total = afterDisc + tax;

  if (el('ws-saving')) el('ws-saving').textContent = saving.toFixed(2);
  if (el('ws-subtotal')) el('ws-subtotal').textContent = sub.toFixed(2);
  if (el('ws-discount-show')) el('ws-discount-show').textContent = disc.toFixed(2);
  if (el('ws-tax')) el('ws-tax').textContent = tax.toFixed(2);
  if (el('ws-total')) el('ws-total').textContent = total.toFixed(2);
  calcWholesaleChange();
}

function calcWholesaleChange() {
  const total = parseFloat(el('ws-total')?.textContent || 0) || 0;
  const paid = parseFloat(el('ws-paid-amount')?.value || 0) || 0;
  const change = paid - total;
  if (el('ws-change-display')) {
    el('ws-change-display').textContent = change >= 0 ? fmt(change) : '—';
    el('ws-change-display').style.color = change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }
}

// ---- تعليق الطلب ----
function suspendWholesaleCart() {
  if (!wsCart.length) { showToast('السلة فارغة', 'warning'); return; }
  const name = prompt('اسم للطلب المعلق:', 'طلب جملة ' + (wsSuspended.length + 1));
  if (name === null) return;
  wsSuspended.push({ id: Date.now(), name: name || 'طلب جملة ' + (wsSuspended.length + 1), cart: JSON.parse(JSON.stringify(wsCart)), time: new Date().toLocaleTimeString('ar-EG', {hour:'2-digit',minute:'2-digit'}) });
  wsCart = [];
  renderWholesaleCart();
  showToast('تم تعليق الطلب ✅');
}

// ---- إتمام البيع ----
function completeWholesale() {
  if (!wsCart.length) { showToast('السلة فارغة!', 'warning'); return; }

  const customerId = el('ws-customer-select')?.value || '';
  const cust = customerId ? (db.customers || []).find(c => c.id === customerId) : null;
  const payment = el('ws-payment-select')?.value || 'نقدي';
  const notes = el('ws-notes')?.value || '';
  const orderType = el('ws-order-type')?.value || 'جملة';

  const sub = wsCart.reduce((a, x) => a + x.subtotal, 0);
  const discVal = parseFloat(el('ws-discount-input')?.value || 0) || 0;
  const discType = el('ws-discount-type')?.value || 'percent';
  let disc = discType === 'percent' ? (sub * discVal / 100) : discVal;
  disc = Math.min(disc, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - disc;
  const tax = afterDisc * taxRate;
  const total = afterDisc + tax;

  const count = (db.sales || []).filter(s => s.type === 'wholesale').length + 1;
  const invNum = 'WS-' + String(count).padStart(4, '0');
  const now = new Date();

  // خصم المخزون
  wsCart.forEach(item => {
    const p = (db.products || []).find(x => x.id === item.productId);
    if (p) p.qty = Math.max(0, (p.qty || 0) - item.qty);
  });

  // الخزنة
  if (payment !== 'آجل') {
    db.treasury.push({ id: uid(), type: 'إيراد', desc: `بيع جملة ${invNum}`, amount: total, date: now.toLocaleDateString('ar-EG'), ts: now.toISOString() });
  } else if (cust) {
    cust.balance = (cust.balance || 0) + total;
    // ── تسجيل حركة رصيد العميل (جملة آجل) ──
    if (!db.balanceMovements) db.balanceMovements = [];
    if (typeof addBalanceMovement === 'function') {
      addBalanceMovement({ type: 'sale_credit', entityId: cust.id, entityName: cust.name, entityType: 'customer', amount: total, invoiceNum: invNum, notes: 'فاتورة جملة آجلة' });
    }
  }

  // تحديث إجمالي مشتريات العميل
  if (cust) cust.totalPurchases = (cust.totalPurchases || 0) + total;

  const sale = {
    id: uid(), invNum, type: 'wholesale',
    date: now.toLocaleDateString('ar-EG'), ts: now.toISOString(),
    customerId, customerName: cust?.name || 'عميل جملة نقدي',
    items: wsCart.map(x => ({ ...x })),
    subtotal: sub, discount: disc, tax, total,
    payment, notes, orderType,
    cashier: currentUser?.name || '—',
    invType: 'wholesale'
  };
  // ── المدفوع والمتبقي وحالة فاتورة الجملة ──
  const wsPaidInput   = parseFloat(el('ws-paid-amount')?.value || 0) || 0;
  const wsPaid        = payment === 'آجل' ? wsPaidInput : total;
  const wsRemaining   = Math.max(0, total - wsPaid);
  sale.paidAmount     = wsPaid;
  sale.remaining      = wsRemaining;
  sale.payStatus      = wsRemaining <= 0 ? 'paid' : (wsPaid > 0 ? 'partial' : 'unpaid');

  if (payment === 'آجل' && wsPaid > 0 && wsRemaining > 0) {
    db.treasury.push({ id: uid(), type: 'إيراد', desc: 'دفعة مقدمة جملة ' + invNum, amount: wsPaid, date: now.toLocaleDateString('ar-EG'), ts: now.toISOString() });
    if (cust) cust.balance = Math.max(0, (cust.balance || 0) - wsPaid);
  }

  if (!db.sales) db.sales = [];
  db.sales.push(sale);
  addLog('بيع', `فاتورة جملة ${invNum} — ${cust?.name || 'نقدي'} — ${fmtCurr(total)}`, 'بيع');
  invalidateCache('topSalesMap', 'wsTopMap');
  saveDB();
  if (typeof erpRefreshFinancialDashboard === 'function') setTimeout(erpRefreshFinancialDashboard, 300);
  showToast(`✅ تم حفظ فاتورة الجملة ${invNum}`);
  clearWholesaleCart();
  updateWholesaleMeta();
  // طباعة فاتورة الجملة تلقائياً بعد الحفظ (نفس سلوك نقطة البيع بالتجزئة)
  setTimeout(() => printWholesaleInvoice(sale), 50);
}

// ---- بناء HTML فاتورة الجملة (نفس تصميم فاتورة المبيعات الحرارية بطابع الجملة) ----
function _buildWholesaleInvoiceHTML(sale, forPDF) {
  const st = db.settings || {};
  const cur = st.currency || 'جنيه';
  const now = new Date(sale.ts || Date.now());
  const dateStr = sale.date || now.toLocaleDateString('ar-EG');
  const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cashier = sale.cashier || (currentUser ? currentUser.name : '—');
  const customer = sale.customerName || 'عميل جملة نقدي';
  const payment = sale.payment || 'نقدي';
  const orderType = sale.orderType || 'جملة';
  const storeName = st.storeName || 'حاسبني';
  const address = st.address || '';
  const phone = st.contact || '';
  const notes = sale.notes || st.invoiceNotes || 'شكراً لتعاملكم معنا';
  const subtotal = parseFloat(sale.subtotal) || 0;
  const discount = parseFloat(sale.discount) || 0;
  const tax = parseFloat(sale.tax) || 0;
  const total = parseFloat(sale.total) || 0;
  const paidAmount = sale.paidAmount ?? total;
  const remaining = sale.remaining ?? 0;
  const payStatus = sale.payStatus || (remaining > 0 ? (paidAmount > 0 ? 'partial' : 'unpaid') : 'paid');
  const items = sale.items || [];
  const paperW = parseInt(st.paperWidth || 80);
  const nameSize = parseInt(st.storeNameSize || 22);
  const dataSize = parseInt(st.dataTextSize || 12);
  const storeLogo = st.storeLogo || '';

  const pxMap = {72: 272, 76: 287, 80: 302};
  const pxW = pxMap[paperW] || 302;

  const logoHTML = storeLogo
    ? `<img src="${storeLogo}" style="max-width:80px;max-height:60px;margin-bottom:6px;display:block;margin-left:auto;margin-right:auto;object-fit:contain">`
    : `<div style="font-size:${nameSize}px;font-weight:900;letter-spacing:1px;margin-bottom:2px">${storeName}</div>`;

  let totalSaving = 0;
  const itemsRows = items.map(i => {
    const price = parseFloat(i.price) || 0;
    const qty = parseFloat(i.qty) || 0;
    const sub = parseFloat(i.subtotal) || (price * qty);
    if (i.retailPrice) totalSaving += (parseFloat(i.retailPrice) - price) * qty;
    return `<tr>
      <td style="padding:5px 6px;max-width:90px;word-break:break-word;font-size:${dataSize}px">${i.name || ''}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${qty}${i.unit ? ' ' + i.unit : ''}</td>
      <td style="text-align:center;padding:5px 4px;font-size:${dataSize}px">${price.toFixed(2)}</td>
      <td style="text-align:left;padding:5px 6px;font-weight:700;font-size:${dataSize}px">${sub.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const statusMap = {
    paid:    { text: '✅ مدفوعة بالكامل', color: '#16a34a' },
    partial: { text: '⚡ مدفوعة جزئياً',   color: '#d97706' },
    unpaid:  { text: '❌ غير مدفوعة',     color: '#dc2626' }
  };
  const stt = statusMap[payStatus] || statusMap.paid;

  const invNum = sale.invNum || sale.id || 'WS-????';

  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>فاتورة جملة ${invNum}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Cairo','Courier New',monospace;background:#e0e0e0;display:flex;flex-direction:column;align-items:center;padding:20px;color:#000}
.receipt{background:#fff;width:${pxW}px;padding:0;color:#000!important;box-shadow:0 2px 20px rgba(0,0,0,.25);position:relative}
.receipt *{color:#000!important}
.perf-top,.perf-bottom{height:8px;width:100%;background:repeating-linear-gradient(90deg,#fff 0,#fff 6px,#d0d0d0 6px,#d0d0d0 8px);display:block}
.receipt-inner{padding:14px 12px}
.header{text-align:center;padding-bottom:10px;margin-bottom:10px}
.store-sub{font-size:${dataSize}px;line-height:1.7;font-weight:700;text-align:center}
.divider-dashed{border:none;border-top:1px dashed #555;margin:8px 0}
.meta-row{display:flex;justify-content:space-between;align-items:center;font-size:${dataSize}px;line-height:2}
.meta-row .lbl{font-weight:700}
.meta-row .val{font-weight:900;font-size:${dataSize+1}px}
.badge-box{display:inline-block;border:1.5px solid #7c3aed;color:#7c3aed!important;border-radius:4px;padding:2px 12px;font-size:${dataSize}px;font-weight:900;margin:4px 3px}
table{width:100%;border-collapse:collapse;margin:8px 0}
thead tr{border-bottom:2px solid #000;border-top:2px solid #000}
th{font-size:${dataSize}px;font-weight:900;padding:6px 5px;text-align:right;background:#f5f3ff}
th:last-child{text-align:left}
th:nth-child(2),th:nth-child(3){text-align:center}
tbody tr{border-bottom:1px solid #aaa}
tbody tr:last-child{border-bottom:2px solid #000}
.totals-row{display:flex;justify-content:space-between;font-size:${dataSize}px;font-weight:700;padding:4px 0;border-bottom:1px dotted #ccc}
.grand-row{display:flex;justify-content:space-between;font-size:${dataSize+2}px;font-weight:900;border-top:2px solid #000;border-bottom:2px solid #000;padding:8px 0;margin-top:6px;color:#7c3aed}
.status-row{font-size:${dataSize+1}px;text-align:center;margin-top:8px;font-weight:900}
.payment-row{font-size:${dataSize}px;text-align:center;margin-top:6px;font-weight:700}
.footer{text-align:center;margin-top:10px;border-top:1px dashed #555;padding-top:10px;font-size:${dataSize}px;line-height:2}
.footer .thanks{font-size:${dataSize+2}px;font-weight:900}
@media print{
  @page{size:${paperW}mm auto;margin:0}
  body{background:none;padding:0}
  .receipt{box-shadow:none;width:100%}
  .no-print{display:none!important}
}
</style></head>
<body><div class="receipt">
<div class="perf-top"></div>
<div class="receipt-inner">
  <div class="header">
    ${logoHTML}
    ${storeLogo ? `<div style="font-size:${nameSize}px;font-weight:900;margin-bottom:2px">${storeName}</div>` : ''}
    ${address ? `<div class="store-sub">${address}</div>` : ''}
    ${phone ? `<div class="store-sub">${phone}</div>` : ''}
    <hr class="divider-dashed" style="margin-top:8px">
    <div style="font-size:${dataSize+2}px;font-weight:900;text-align:center;color:#7c3aed">💼 فاتورة بيع جملة</div>
  </div>
  <div style="margin-bottom:8px;border-bottom:1px dashed #555;padding-bottom:8px">
    <div class="meta-row"><span class="lbl">رقم الفاتورة:</span><span class="val">${invNum}</span></div>
    <div class="meta-row"><span class="lbl">التاريخ:</span><span class="val">${dateStr}</span></div>
    <div class="meta-row"><span class="lbl">الوقت:</span><span class="val">${timeStr}</span></div>
    <div class="meta-row"><span class="lbl">البائع:</span><span class="val">${cashier}</span></div>
    <div class="meta-row"><span class="lbl">العميل:</span><span class="val">${customer}</span></div>
  </div>
  <table>
    <thead><tr>
      <th>المنتج</th>
      <th style="text-align:center">الكمية</th>
      <th style="text-align:center">سعر الجملة</th>
      <th style="text-align:left">الإجمالي</th>
    </tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div style="margin-top:6px">
    <div class="totals-row"><span>المجموع الفرعي</span><span>${subtotal.toFixed(2)}</span></div>
    ${discount > 0 ? `<div class="totals-row" style="color:#c00"><span>خصم</span><span>- ${discount.toFixed(2)}</span></div>` : ''}
    ${tax > 0 ? `<div class="totals-row"><span>ضريبة (${st.tax || 0}%)</span><span>${tax.toFixed(2)}</span></div>` : ''}
    ${totalSaving > 0 ? `<div class="totals-row" style="color:#16a34a"><span>وفّرت (عن سعر التجزئة)</span><span>${totalSaving.toFixed(2)}</span></div>` : ''}
  </div>
  <div class="grand-row">
    <span>الإجمالي</span>
    <span>${total.toFixed(2)} ${cur}</span>
  </div>
  <div class="payment-row">طريقة الدفع: ${payment}</div>
  <div class="totals-row" style="color:#16a34a;margin-top:6px"><span>المدفوع</span><span>${paidAmount.toFixed(2)}</span></div>
  ${remaining > 0 ? `<div class="totals-row" style="color:#dc2626"><span>المتبقي</span><span>${remaining.toFixed(2)}</span></div>` : ''}
  <div class="status-row" style="color:${stt.color}">${stt.text}</div>
  <div style="text-align:center;margin:6px 0"><span class="badge-box">${orderType}</span></div>
  <hr class="divider-dashed">
  <div class="footer">
    <div class="thanks">${notes}</div>
    ${phone ? `<div style="margin-top:4px;font-weight:700">${phone}</div>` : ''}
    <div style="font-size:${dataSize-1}px;margin-top:4px;color:#555">الفاتورة صادرة إلكترونياً ولا تحتاج إلى توقيع</div>
  </div>
</div>
<div class="perf-bottom"></div>
</div>
${forPDF ? '' : `<script>window.onload=function(){setTimeout(()=>window.print(),400)}<\/script>`}
</body></html>`;
}

// يبني كائن فاتورة جملة "مؤقت" من السلة الحالية (قبل الحفظ) — للمعاينة والطباعة المسبقة
function _buildWholesaleObjFromCart() {
  if (!wsCart.length) return null;
  const sub = wsCart.reduce((a, x) => a + x.subtotal, 0);
  const discVal = parseFloat(el('ws-discount-input')?.value || 0) || 0;
  const discType = el('ws-discount-type')?.value || 'percent';
  let disc = discType === 'percent' ? (sub * discVal / 100) : discVal;
  disc = Math.min(disc, sub);
  const taxRate = parseFloat(db.settings?.tax || 0) / 100;
  const afterDisc = sub - disc;
  const tax = afterDisc * taxRate;
  const total = afterDisc + tax;
  const payment = el('ws-payment-select')?.value || 'نقدي';
  const custName = el('ws-customer-select')?.options[el('ws-customer-select').selectedIndex]?.text || 'عميل جملة نقدي';
  const wsPaidInput = parseFloat(el('ws-paid-amount')?.value || 0) || 0;
  const paidAmount = payment === 'آجل' ? wsPaidInput : total;
  const remaining = Math.max(0, total - paidAmount);
  return {
    invNum: el('ws-inv-number')?.textContent || 'WS-????',
    date: new Date().toLocaleDateString('ar-EG'), ts: new Date().toISOString(),
    customerName: custName, items: wsCart.map(x => ({ ...x })),
    subtotal: sub, discount: disc, tax, total,
    payment, notes: el('ws-notes')?.value || '', orderType: el('ws-order-type')?.value || 'جملة',
    cashier: currentUser?.name || '—',
    paidAmount, remaining, payStatus: remaining <= 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid')
  };
}

// طباعة فاتورة جملة محفوظة (تُستدعى تلقائياً بعد الحفظ، أو من قوائم الفواتير لإعادة الطباعة)
function printWholesaleInvoice(sale) {
  _printDocument(_buildWholesaleInvoiceHTML(sale, false));
}

// ---- معاينة الفاتورة (قبل الحفظ) ----
function previewWholesaleInvoice() {
  const sale = _buildWholesaleObjFromCart();
  if (!sale) { showToast('السلة فارغة', 'warning'); return; }
  _openPreviewWindow(_buildWholesaleInvoiceHTML(sale, true));
}

function wholesalePrintPDF() {
  const sale = _buildWholesaleObjFromCart();
  if (!sale) { showToast('السلة فارغة', 'warning'); return; }
  _printDocument(_buildWholesaleInvoiceHTML(sale, false));
}

function wholesaleSendWhatsApp() {
  if (!wsCart.length) { showToast('السلة فارغة', 'warning'); return; }
  const total = parseFloat(el('ws-total')?.textContent || 0);
  const custName = el('ws-customer-select')?.options[el('ws-customer-select').selectedIndex]?.text || 'عميل';
  const invNum = el('ws-inv-number')?.textContent || 'WS-????';
  const lines = wsCart.map(i => `• ${i.name} × ${i.qty} = ${fmtCurr(i.subtotal)}`).join('\n');
  const msg = encodeURIComponent(`💼 فاتورة جملة ${invNum}\nالعميل: ${custName}\n\n${lines}\n\n📌 الإجمالي: ${fmtCurr(total)}\n\n${db.settings?.storeName || ''}`);
  window.open(`https://wa.me/?text=${msg}`, '_blank');
}

// =========================================================
// ======= DATABASE UPGRADE — تطوير قاعدة البيانات =========
// =========================================================

// تحديث قاعدة البيانات لدعم المنتجات الأكثر وضيف الجديدة
function upgradeDatabase() {
  let changed = false;

  // 1. تحديث كل منتج ليدعم حقول الجملة
  (db.products || []).forEach(p => {
    if (p.wholesalePrice === undefined) { p.wholesalePrice = null; changed = true; }
    if (p.wholesaleMin === undefined)   { p.wholesaleMin = 10; changed = true; }
    if (p.tags === undefined)           { p.tags = []; changed = true; }
    if (p.sku === undefined)            { p.sku = ''; changed = true; }
    if (p.weight === undefined)         { p.weight = 0; changed = true; }
    if (p.expiry === undefined)         { p.expiry = ''; changed = true; }
    if (p.supplier === undefined)       { p.supplier = ''; changed = true; }
    if (p.location === undefined)       { p.location = ''; changed = true; }
  });

  // 2. تحديث الفواتير لدعم نوع البيع
  (db.sales || []).forEach(s => {
    if (s.type === undefined) { s.type = 'retail'; changed = true; }
    if (s.invNum === undefined) { s.invNum = 'INV-' + (s.id?.slice(-4) || '0000'); changed = true; }
  });

  // 3. إضافة جدول طلبات الجملة إن لم يكن موجوداً
  if (!db.wholesaleOrders) { db.wholesaleOrders = []; changed = true; }

  // 4. إضافة جدول فئات المنتجات الموسّع
  if (!db.categoryDetails) { db.categoryDetails = {}; changed = true; }

  // 5. إضافة حقول إضافية للعملاء
  (db.customers || []).forEach(c => {
    if (c.type === undefined) { c.type = 'retail'; changed = true; }
    if (c.totalPurchases === undefined) { c.totalPurchases = 0; changed = true; }
    if (c.wholesaleDiscount === undefined) { c.wholesaleDiscount = 0; changed = true; }
  });

  // 6. تعديل الإعدادات لدعم خصم الجملة الافتراضي
  if (db.settings.wholesaleDefaultDiscount === undefined) {
    db.settings.wholesaleDefaultDiscount = 0;
    changed = true;
  }
  if (db.settings.wholesaleMinQty === undefined) {
    db.settings.wholesaleMinQty = 10;
    changed = true;
  }

  // 7. إضافة جداول الأرصدة
  if (!db.balanceMovements) { db.balanceMovements = []; changed = true; }
  if (!db.payments) { db.payments = []; changed = true; }

  // 8. تنظيف الكاش بعد الترقية
  if (changed) {
    Object.keys(_cache).forEach(k => delete _cache[k]);
    saveDB();
    console.log('✅ Database upgraded successfully');
  }
}

// ترقية قاعدة البيانات تُنفّذ في startApp()

// =========================================================
// ======= NAVIGATION PATCH — إضافة wholesale ============
// =========================================================
// [wholesale focus — integrated into navigate()]


// =========================================================
// ===== نظام إدارة تواريخ انتهاء الصلاحية ==============
// =========================================================

/* --- حساب عدد الأيام المتبقية --- */
function daysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).setHours(0,0,0,0) - new Date().setHours(0,0,0,0)) / 86400000);
}

/* --- تصنيف حالة الصلاحية --- */
function getExpiryStatus(dateStr) {
  const d = daysUntilExpiry(dateStr);
  if (d === null)  return { key: 'none',    label: '—',                color: 'var(--text-muted)', bg: 'transparent',           icon: '' };
  if (d < 0)       return { key: 'expired', label: 'منتهي الصلاحية',   color: '#fff',              bg: '#dc2626',               icon: '⛔' };
  if (d <= 7)      return { key: 'week',    label: `${d} أيام`,         color: '#fff',              bg: '#ef4444',               icon: '🔴' };
  if (d <= 30)     return { key: 'month',   label: `${d} يوماً`,        color: '#fff',              bg: '#f97316',               icon: '🟠' };
  if (d <= 90)     return { key: '3months', label: `${d} يوماً`,        color: '#854d0e',           bg: '#fef08a',               icon: '🟡' };
  return           { key: 'safe',           label: `${d} يوماً`,        color: '#166534',           bg: '#bbf7d0',               icon: '✅' };
}

/* --- فحص وعرض شريط التحذير العلوي --- */
function checkExpiryAlerts() {
  const products = db.products || [];
  const today    = new Date().setHours(0,0,0,0);
  const month30  = today + 30 * 86400000;

  const expired  = products.filter(p => p.expiry && new Date(p.expiry).setHours(0,0,0,0) < today);
  const soon     = products.filter(p => p.expiry && new Date(p.expiry).setHours(0,0,0,0) >= today && new Date(p.expiry).setHours(0,0,0,0) <= month30);

  const bar  = el('expiry-alert-bar');
  const txt  = el('expiry-alert-text');
  const badge = el('sidebar-expiry-count');

  const total = expired.length + soon.length;

  if (total === 0) {
    if (bar) bar.style.display = 'none';
    if (badge) badge.style.display = 'none';
    return;
  }

  let msg = '';
  if (expired.length > 0) msg += ` ${expired.length} منتج منتهي الصلاحية`;
  if (soon.length > 0)    msg += (expired.length ? ' | ' : '') + ` ${soon.length} منتج ينتهي خلال 30 يوماً`;

  if (bar) { bar.style.display = 'flex'; bar.style.alignItems = 'center'; bar.style.justifyContent = 'center'; }
  if (txt) txt.textContent = msg;
  if (badge) { badge.textContent = total; badge.style.display = ''; }
}

/* --- صفحة إدارة الصلاحيات الكاملة --- */
function renderExpiryPage() {
  const products = db.products || [];
  const q      = (el('expiry-search')?.value || '').toLowerCase();
  const status = el('expiry-status-filter')?.value || 'all';
  const cat    = el('expiry-cat-filter')?.value || '';
  const today  = new Date().setHours(0,0,0,0);

  // ملء فلتر الفئات
  const catSel = el('expiry-cat-filter');
  if (catSel && !catSel.dataset.filled) {
    catSel.innerHTML = '<option value="">كل الفئات</option>' +
      (db.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
    catSel.dataset.filled = '1';
  }

  // حساب الإحصائيات
  let nExpired = 0, nWeek = 0, nMonth = 0, nSafe = 0;
  products.forEach(p => {
    if (!p.expiry) return;
    const s = getExpiryStatus(p.expiry);
    if (s.key === 'expired') nExpired++;
    else if (s.key === 'week') nWeek++;
    else if (s.key === 'month') nMonth++;
    else if (s.key === 'safe' || s.key === '3months') nSafe++;
  });
  if (el('exp-count-expired')) el('exp-count-expired').textContent = nExpired;
  if (el('exp-count-week'))    el('exp-count-week').textContent    = nWeek;
  if (el('exp-count-month'))   el('exp-count-month').textContent   = nMonth;
  if (el('exp-count-safe'))    el('exp-count-safe').textContent    = nSafe;

  // فلترة
  let filtered = products.filter(p => {
    const matchQ   = !q || p.name.toLowerCase().includes(q) || (p.barcode||'').includes(q);
    const matchCat = !cat || p.category === cat;
    if (!matchQ || !matchCat) return false;
    if (status === 'all') return true;
    if (status === 'none') return !p.expiry;
    const s = getExpiryStatus(p.expiry);
    return s.key === status;
  });

  // ترتيب: المنتهية أولاً ثم الأقرب للانتهاء
  filtered.sort((a, b) => {
    const da = a.expiry ? new Date(a.expiry).getTime() : 9e15;
    const db2 = b.expiry ? new Date(b.expiry).getTime() : 9e15;
    return da - db2;
  });

  const tbody = el('expiry-tbody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><p>لا توجد منتجات مطابقة</p></td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((p, i) => {
    const s     = getExpiryStatus(p.expiry);
    const days  = daysUntilExpiry(p.expiry);
    const daysLabel = days === null ? '—' : (days < 0 ? `منذ ${Math.abs(days)} يوم` : `${days} يوم`);
    const dateLabel = p.expiry ? new Date(p.expiry).toLocaleDateString('ar-EG') : '—';

    return `<tr style="${s.key === 'expired' ? 'background:rgba(220,38,38,0.06)' : s.key === 'week' ? 'background:rgba(249,115,22,0.06)' : ''}">
      <td>${i + 1}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          ${p.image ? `<img src="${p.image}" style="width:28px;height:28px;border-radius:6px;object-fit:cover">` : '<span style="font-size:1.2rem">📦</span>'}
          <strong>${p.name}</strong>
        </div>
      </td>
      <td><code style="font-size:0.75rem;color:var(--text-muted)">${p.barcode || '—'}</code></td>
      <td>${p.category || '—'}</td>
      <td><span class="badge ${p.qty <= (p.minStock||5) ? 'badge-red' : 'badge-green'}">${p.qty} ${p.unit||''}</span></td>
      <td style="font-weight:600">${dateLabel}</td>
      <td style="font-weight:700">${daysLabel}</td>
      <td><span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:0.78rem;font-weight:700;background:${s.bg};color:${s.color}">${s.icon} ${s.label}</span></td>
      <td>
        <div class="btn-group">
          <button class="btn btn-ghost btn-sm" onclick="editProduct('${p.id}')" title="تعديل"><i class="fa fa-pen"></i></button>
          <button class="btn btn-warning btn-sm" onclick="quickUpdateExpiry('${p.id}')" title="تحديث التاريخ"><i class="fa fa-calendar-pen"></i></button>
          ${s.key === 'expired' ? `<button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')" title="حذف"><i class="fa fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* --- تحديث تاريخ الانتهاء بسرعة --- */
function quickUpdateExpiry(pid) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;
  const val = prompt(`تحديث تاريخ انتهاء صلاحية: ${p.name}\nالتاريخ الحالي: ${p.expiry || 'لم يُحدد'}\n\nأدخل التاريخ (YYYY-MM-DD):`, p.expiry || '');
  if (val === null) return;
  p.expiry = val.trim();
  saveDB();
  invalidateCache('expiryData');
  checkExpiryAlerts();
  renderExpiryPage();
  showToast(`✅ تم تحديث تاريخ انتهاء "${p.name}"`);
}

/* --- حذف المنتجات المنتهية --- */
function removeExpiredProducts() {
  const today   = new Date().setHours(0,0,0,0);
  const expired = (db.products || []).filter(p => p.expiry && new Date(p.expiry).setHours(0,0,0,0) < today);
  if (!expired.length) { showToast('لا توجد منتجات منتهية الصلاحية', 'info'); return; }
  if (!confirm(`هل تريد حذف ${expired.length} منتج منتهي الصلاحية؟\n\n${expired.map(p=>p.name).join('\n')}`)) return;
  expired.forEach(p => {
    db.products = db.products.filter(x => x.id !== p.id);
    addLog('حذف', `حذف منتج منتهي الصلاحية: ${p.name}`, 'حذف');
  });
  saveDB();
  invalidateCache('expiryData');
  checkExpiryAlerts();
  renderExpiryPage();
  showToast(`🗑️ تم حذف ${expired.length} منتج منتهي الصلاحية`);
}

/* --- تصدير CSV للصلاحيات --- */
function exportExpiryCSV() {
  const products = (db.products || []).filter(p => p.expiry);
  if (!products.length) { showToast('لا توجد منتجات بتواريخ صلاحية', 'warning'); return; }
  const rows = [['المنتج','الباركود','الفئة','الكمية','تاريخ الانتهاء','الأيام المتبقية','الحالة']];
  products.forEach(p => {
    const s = getExpiryStatus(p.expiry);
    const d = daysUntilExpiry(p.expiry);
    rows.push([p.name, p.barcode||'', p.category||'', p.qty, p.expiry, d===null?'':d, s.label]);
  });
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv);
  link.download = `expiry_report_${new Date().toLocaleDateString('ar-EG').replace(/\//g,'_')}.csv`;
  link.click();
}

/* --- طباعة تقرير الصلاحيات --- */
function printExpiryReport() {
  const products = (db.products || []).filter(p => p.expiry).sort((a,b) => new Date(a.expiry)-new Date(b.expiry));
  const rows = products.map((p,i) => {
    const s = getExpiryStatus(p.expiry);
    const d = daysUntilExpiry(p.expiry);
    const dLabel = d < 0 ? `منذ ${Math.abs(d)} يوم` : `${d} يوم`;
    return `<tr style="${s.key==='expired'?'background:#fef2f2':s.key==='week'?'background:#fff7ed':''}">
      <td>${i+1}</td><td><strong>${p.name}</strong></td><td>${p.barcode||'—'}</td>
      <td>${p.qty} ${p.unit||''}</td><td>${new Date(p.expiry).toLocaleDateString('ar-EG')}</td>
      <td>${dLabel}</td><td>${s.icon} ${s.label}</td>
    </tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
  <title>تقرير تواريخ الانتهاء</title>
  <style>body{font-family:Tahoma,sans-serif;direction:rtl;padding:20px}
  h2{text-align:center;color:#ea580c}table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border:1px solid #ddd;padding:7px;text-align:center;font-size:0.85rem}th{background:#fff7ed;color:#9a3412}
  .footer{margin-top:12px;text-align:left;font-size:0.8rem;color:#666}</style></head>
  <body><h2>📅 تقرير تواريخ انتهاء الصلاحية</h2>
  <p>المتجر: <strong>${db.settings?.storeName||'—'}</strong> | التاريخ: <strong>${new Date().toLocaleDateString('ar-EG')}</strong></p>
  <table><thead><tr><th>#</th><th>المنتج</th><th>الباركود</th><th>الكمية</th><th>تاريخ الانتهاء</th><th>الأيام المتبقية</th><th>الحالة</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="footer">إجمالي: ${products.length} منتج</div>
  <script>window.print();window.onafterprint=()=>window.close()<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

/* --- عرض شارة الصلاحية في جدول المنتجات الرئيسي --- */
function _expiryBadge(p) {
  if (!p.expiry) return '';
  const s = getExpiryStatus(p.expiry);
  if (s.key === 'safe' || s.key === 'none') return '';
  return `<span style="display:inline-block;padding:1px 6px;border-radius:10px;font-size:0.65rem;font-weight:700;background:${s.bg};color:${s.color};margin-right:4px" title="تاريخ الانتهاء: ${p.expiry}">${s.icon}</span>`;
}

/* --- تحذير في POS إذا كان المنتج ينتهي قريباً --- */
function _warnExpiryInPOS(p) {
  if (!p.expiry) return;
  const s = getExpiryStatus(p.expiry);
  if (s.key === 'expired') {
    showToast(`⛔ تحذير: "${p.name}" منتهي الصلاحية!`, 'error');
  } else if (s.key === 'week' || s.key === 'month') {
    showToast(`🟠 تنبيه: "${p.name}" ينتهي خلال ${daysUntilExpiry(p.expiry)} يوم`, 'warning');
  }
}

// =========================================================
// ===== تطوير قاعدة البيانات — Virtual Scroll ============
// =========================================================

/* نظام عرض افتراضي للجداول الكبيرة (1000+ منتج) */
const VirtualTable = {
  ROW_H: 52,
  BUFFER: 8,
  _instances: {},

  mount(tbodyId, items, renderRowFn, opts = {}) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const wrapper = tbody.closest('.table-wrapper') || tbody.parentElement;
    wrapper.style.overflowY = 'auto';
    wrapper.style.maxHeight = opts.maxHeight || '65vh';

    this._instances[tbodyId] = { items, renderRowFn, wrapper, tbody };
    this._render(tbodyId);
    wrapper.onscroll = debounce(() => this._render(tbodyId), 16);
  },

  update(tbodyId, items) {
    const inst = this._instances[tbodyId];
    if (!inst) return;
    inst.items = items;
    inst.wrapper.scrollTop = 0;
    this._render(tbodyId);
  },

  _render(tbodyId) {
    const inst = this._instances[tbodyId];
    if (!inst) return;
    const { items, renderRowFn, wrapper, tbody } = inst;
    const scrollTop = wrapper.scrollTop;
    const viewH     = wrapper.clientHeight || 500;
    const start     = Math.max(0, Math.floor(scrollTop / this.ROW_H) - this.BUFFER);
    const end       = Math.min(items.length, Math.ceil((scrollTop + viewH) / this.ROW_H) + this.BUFFER);

    const topSpacer = document.createElement('tr');
    topSpacer.style.height = (start * this.ROW_H) + 'px';
    const botSpacer = document.createElement('tr');
    botSpacer.style.height = (Math.max(0, items.length - end) * this.ROW_H) + 'px';

    const frag = document.createDocumentFragment();
    frag.appendChild(topSpacer);
    items.slice(start, end).forEach((item, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = renderRowFn(item, start + i);
      frag.appendChild(tr);
    });
    frag.appendChild(botSpacer);
    tbody.innerHTML = '';
    tbody.appendChild(frag);
  }
};

window.VirtualTable = VirtualTable;

/* --- تحديث renderProductsPage باستخدام VirtualTable --- */
const _origRenderProductsPage = renderProductsPage;
renderProductsPage = function() {
  const q   = (el('products-search')?.value || '').toLowerCase();
  const cat = el('products-cat-filter')?.value || '';
  const catSel = el('products-cat-filter');
  if (catSel) catSel.innerHTML = '<option value="">كل الفئات</option>' + (db.categories || []).map(c => `<option value="${c}">${c}</option>`).join('');
  
  const prods     = (db.products || []).filter(p => {
    const mq = !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q);
    const mc = !cat || p.category === cat;
    return mq && mc;
  });
  const threshold = db.settings.lowStock || 5;
  if (el('products-count'))      el('products-count').textContent      = db.products.length;
  if (el('products-low-count'))  el('products-low-count').textContent  = db.products.filter(p => p.qty <= threshold).length;
  if (el('products-total-value'))el('products-total-value').textContent= fmtCurr(db.products.reduce((a, p) => a + (p.qty * (p.cost || p.price)), 0));

  const renderRow = (p) => `
    <td><code style="font-size:0.75rem;color:var(--text-muted)">${p.barcode || '—'}</code></td>
    <td><strong>${p.name}</strong>${_expiryBadge(p)}</td>
    <td>${p.category || '—'}</td>
    <td style="color:var(--accent-green);font-weight:700">${fmtCurr(p.price)}</td>
    <td style="color:var(--text-muted)">${fmtCurr(p.cost || 0)}</td>
    <td style="color:var(--accent-purple);font-weight:700">${p.wholesalePrice ? fmtCurr(p.wholesalePrice) + `<span style="font-size:0.65rem;color:var(--text-muted)"> (من ${p.wholesaleMin||10})</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
    <td><span class="${p.qty <= threshold ? 'badge badge-red' : 'badge badge-green'}">${p.qty}</span></td>
    <td>${p.unit || '—'}</td>
    <td>${p.discount || 0}%</td>
    <td>
      <div class="btn-group">
        <button class="btn btn-ghost btn-sm" onclick="editProduct('${p.id}')"><i class="fa fa-pen"></i></button>
        ${can('delete') ? `<button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')"><i class="fa fa-trash"></i></button>` : ''}
      </div>
    </td>`;

  // استخدام VirtualTable للمنتجات الكثيرة
  if (prods.length > 50) {
    VirtualTable.mount('products-tbody', prods, renderRow);
  } else {
    el('products-tbody').innerHTML = prods.length
      ? prods.map(p => `<tr>${renderRow(p)}</tr>`).join('')
      : '<tr><td colspan="10" class="empty-state"><p>لا توجد منتجات</p></td></tr>';
  }
};

/* --- تفعيل تحذير الصلاحية عند الإضافة للسلة --- */
const _origAddToCart = addToCart;
addToCart = function(pid) {
  const p = (db.products||[]).find(x => x.id === pid);
  if (p) _warnExpiryInPOS(p);
  return _origAddToCart(pid);
};

const _origAddToPurchaseCart = addToPurchaseCart;
addToPurchaseCart = function(pid) {
  return _origAddToPurchaseCart(pid);
};

// [expiry — integrated into navigate()]

// [checkExpiryAlerts integrated into startApp()]

/* --- إضافة hint تفاعلي على حقل التاريخ --- */
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('product-form-expiry');
  if (inp) inp.addEventListener('change', () => _updateExpiryHint(inp.value));
});

// DB_ENGINE v3 removed — superseded by db_engine.js v4

/* --- تشغيل المزامنة --- */
setTimeout(() => DB_ENGINE.sync(), 1200);

/* saveDB عبر db_engine.js يتعامل مع المنتجات بشكل صحيح */

// =========================================================
// ===== أيقونة البرنامج — تحديث brand icon ==============
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  // استبدال emoji في brand icon بالأيقونة الحقيقية
  const brandIcon = document.getElementById('nav-brand-icon');
  if (brandIcon) {
    brandIcon.innerHTML = '';
    brandIcon.style.background  = 'none';
    brandIcon.style.borderRadius = '10px';
    brandIcon.style.overflow     = 'hidden';
    brandIcon.style.width        = '36px';
    brandIcon.style.height       = '36px';
    brandIcon.style.flexShrink   = '0';
    const img = document.createElement('img');
    img.src    = 'assets/icon.png';
    img.style.width  = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.onerror = () => { brandIcon.textContent = '💰'; };
    brandIcon.appendChild(img);
  }

  // أيقونة شاشة تسجيل الدخول
  const loginLogo = document.getElementById('login-logo');
  if (loginLogo) {
    loginLogo.style.background  = 'none';
    loginLogo.style.padding     = '0';
    loginLogo.innerHTML = `<img src="assets/icon.png" style="width:100%;height:100%;object-fit:cover;border-radius:22px" onerror="this.parentElement.innerHTML='💰'">`;
  }
});

