'use strict';
/* TreasuryService — مرتبط بالـ db عبر window */
const TreasuryService = {
  getBalance() {
    const d = window.db;
    if (!d) return 0;
    const inc = (d.treasury||[]).filter(t=>t.type==='إيراد').reduce((a,t)=>a+parseFloat(t.amount||0),0);
    const exp = (d.treasury||[]).filter(t=>t.type==='مصروف').reduce((a,t)=>a+parseFloat(t.amount||0),0);
    const wd  = (d.treasury||[]).filter(t=>t.type==='سحب').reduce((a,t)=>a+parseFloat(t.amount||0),0);
    return inc - exp - wd;
  },
};
window.TreasuryService = TreasuryService;
