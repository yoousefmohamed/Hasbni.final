/**
 * =============================================
 * حاسبني — إعدادات النظام الافتراضية
 * =============================================
 */

const DEFAULT_SETTINGS = {
    // معلومات المتجر
    store: {
        name: 'متجري',
        address: 'العنوان',
        phone: '01000000000',
        email: '',
        tax_number: '',
        logo: '',
        currency: 'ج.م',
        currency_code: 'EGP',
    },

    // إعدادات الفواتير
    invoices: {
        show_logo: true,
        show_qr: true,
        show_barcode: false,
        footer_text: 'شكرًا لتعاملكم معنا ❤️',
        paper_size: '80mm', // '80mm' | '58mm' | 'A4'
        auto_print: false,
        tax_percent: 0,
    },

    // إعدادات المخزون
    inventory: {
        low_stock_alert: true,
        low_stock_threshold: 5,
        expiry_alert_days: 30,
        allow_negative_stock: false,
    },

    // إعدادات POS
    pos: {
        barcode_scanner: true,
        auto_focus_search: true,
        save_cart_on_exit: true,
        default_payment: 'cash',
        keyboard_shortcuts: true,
    },

    // إعدادات العملاء
    customers: {
        loyalty_enabled: false,
        points_per_pound: 1,
        points_value: 0.01, // قيمة النقطة بالجنيه
        credit_enabled: false,
    },

    // الإشعارات
    notifications: {
        low_stock: true,
        daily_summary: false,
        telegram_bot_token: '',
        telegram_chat_id: '',
        whatsapp_enabled: false,
    },

    // الواجهة
    ui: {
        theme: 'dark', // 'dark' | 'light'
        language: 'ar',
        date_format: 'DD/MM/YYYY',
        sidebar_collapsed: false,
    },

    // النسخ الاحتياطي
    backup: {
        auto_backup: false,
        backup_interval: 'daily', // 'daily' | 'weekly'
        cloud_backup: false,
    },
};

/**
 * مدير الإعدادات
 */
class SettingsManager {
    constructor() {
        this.settings = this.load();
    }

    load() {
        try {
            const saved = localStorage.getItem('hassibni_settings');
            if (saved) {
                return this.deepMerge(DEFAULT_SETTINGS, JSON.parse(saved));
            }
        } catch (e) {}
        return { ...DEFAULT_SETTINGS };
    }

    save() {
        localStorage.setItem('hassibni_settings', JSON.stringify(this.settings));
    }

    get(path) {
        return path.split('.').reduce((obj, key) => obj?.[key], this.settings);
    }

    set(path, value) {
        const keys = path.split('.');
        let obj = this.settings;
        for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]] = obj[keys[i]] || {};
        }
        obj[keys[keys.length - 1]] = value;
        this.save();
    }

    reset() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.save();
    }

    deepMerge(target, source) {
        const result = { ...target };
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = this.deepMerge(target[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }
}

if (typeof module !== 'undefined') {
    module.exports = { DEFAULT_SETTINGS, SettingsManager };
} else {
    window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
    window.SettingsManager = SettingsManager;
    window.appSettings = new SettingsManager();
}
