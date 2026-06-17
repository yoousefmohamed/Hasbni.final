-- =============================================
-- حاسبني — هيكل قاعدة البيانات الاحترافي
-- =============================================

-- جدول الفئات
CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول الموردين
CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول المنتجات
CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    barcode TEXT UNIQUE,
    sell_price REAL NOT NULL DEFAULT 0,
    buy_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    minimum_stock INTEGER DEFAULT 5,
    category_id INTEGER REFERENCES categories(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    expiry_date DATE,
    unit TEXT DEFAULT 'قطعة',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول العملاء
CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    balance REAL DEFAULT 0,
    credit_limit REAL DEFAULT 0,
    loyalty_points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول المستخدمين
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    permissions TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول فواتير البيع
CREATE TABLE sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER REFERENCES customers(id),
    user_id INTEGER REFERENCES users(id),
    payment_method TEXT DEFAULT 'cash',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    profit REAL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول بنود فواتير البيع
CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL,
    cost REAL NOT NULL,
    discount REAL DEFAULT 0,
    profit REAL NOT NULL DEFAULT 0
);

-- جدول فواتير الشراء
CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    user_id INTEGER REFERENCES users(id),
    payment_method TEXT DEFAULT 'cash',
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول بنود فواتير الشراء
CREATE TABLE purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL
);

-- جدول المرتجعات
CREATE TABLE returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_type TEXT NOT NULL, -- 'sale' or 'purchase'
    reference_id INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id),
    total REAL NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول معاملات الخزنة
CREATE TABLE treasury_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, -- 'in' or 'out'
    amount REAL NOT NULL,
    reference_type TEXT, -- 'sale', 'purchase', 'return', 'manual'
    reference_id INTEGER,
    description TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول حركة المخزون
CREATE TABLE inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    type TEXT NOT NULL, -- 'sale', 'purchase', 'return', 'adjustment'
    qty_before INTEGER,
    qty_change INTEGER NOT NULL,
    qty_after INTEGER,
    reference_type TEXT,
    reference_id INTEGER,
    user_id INTEGER REFERENCES users(id),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول سجل النشاط
CREATE TABLE activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول إعدادات النظام
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- جدول التسويات (عملاء وموردين)
CREATE TABLE settlements (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('customer','supplier')),
    entity_id TEXT NOT NULL,
    entity_name TEXT,
    move_type TEXT NOT NULL CHECK(move_type IN ('debit','credit')),
    amount REAL NOT NULL CHECK(amount > 0),
    date TEXT NOT NULL,
    notes TEXT,
    bal_before REAL,
    bal_after REAL,
    user_id TEXT,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP
);
