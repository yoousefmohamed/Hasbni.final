/**
 * =============================================
 * حاسبني — أدوات مساعدة (Utils)
 * =============================================
 */

const Utils = {

    /**
     * توليد رقم فاتورة فريد
     */
    generateInvoiceNumber(prefix = 'INV') {
        const now = new Date();
        const date = now.toISOString().slice(0,10).replace(/-/g,'');
        const rand = Math.floor(Math.random() * 9000) + 1000;
        return `${prefix}-${date}-${rand}`;
    },

    /**
     * تنسيق المبلغ المالي
     */
    formatMoney(amount, currency = 'ج.م') {
        return `${parseFloat(amount || 0).toFixed(2)} ${currency}`;
    },

    /**
     * تنسيق التاريخ بالعربي
     */
    formatDate(date, options = {}) {
        const d = date ? new Date(date) : new Date();
        return d.toLocaleDateString('ar-EG', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            ...options
        });
    },

    /**
     * تنسيق الوقت
     */
    formatTime(date) {
        const d = date ? new Date(date) : new Date();
        return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    },

    /**
     * حساب الربح
     */
    calcProfit(sellPrice, buyPrice, qty = 1) {
        return (sellPrice - buyPrice) * qty;
    },

    /**
     * حساب نسبة الربح
     */
    calcProfitPercent(sellPrice, buyPrice) {
        if (!buyPrice) return 0;
        return ((sellPrice - buyPrice) / buyPrice) * 100;
    },

    /**
     * تقريب للأعداد العشرية
     */
    round(num, decimals = 2) {
        return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
    },

    /**
     * التحقق من صحة رقم الهاتف
     */
    isValidPhone(phone) {
        return /^[0-9+\-\s]{7,15}$/.test(phone);
    },

    /**
     * البحث في نص (يدعم العربي)
     */
    searchMatch(text, query) {
        if (!text || !query) return false;
        return text.toLowerCase().includes(query.toLowerCase());
    },

    /**
     * نسخ نص إلى الحافظة
     */
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    },

    /**
     * تأخير (Promise-based)
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * تجميع مصفوفة بحقل معين
     */
    groupBy(arr, key) {
        return arr.reduce((groups, item) => {
            const group = item[key];
            groups[group] = groups[group] || [];
            groups[group].push(item);
            return groups;
        }, {});
    },

    /**
     * مجموع حقل في مصفوفة
     */
    sumBy(arr, key) {
        return arr.reduce((sum, item) => sum + (parseFloat(item[key]) || 0), 0);
    },

    /**
     * إظهار إشعار Toast
     */
    toast(message, type = 'success', duration = 3000) {
        const colors = {
            success: '#00d88a',
            error: '#f87171',
            warning: '#fbbf24',
            info: '#4a9eff',
        };
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            background: ${colors[type] || colors.info}; color: #000;
            padding: 12px 24px; border-radius: 12px; font-weight: 700;
            z-index: 99999; font-family: Cairo, sans-serif; font-size: 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            animation: slideUp 0.3s ease;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    },

    /**
     * تأكيد قبل الحذف
     */
    confirm(message) {
        return window.confirm(message);
    },

    /**
     * تصدير بيانات كـ JSON
     */
    exportJSON(data, filename = 'export') {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * تصدير بيانات كـ CSV
     */
    exportCSV(data, headers, filename = 'export') {
        const rows = [headers.join(',')];
        data.forEach(row => {
            rows.push(headers.map(h => `"${row[h] || ''}"`).join(','));
        });
        const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    },
};

if (typeof module !== 'undefined') {
    module.exports = Utils;
} else {
    window.Utils = Utils;
}
