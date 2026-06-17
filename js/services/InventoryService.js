'use strict';
const InventoryService = {
  getLowStock() {
    const d=window.db; if(!d) return [];
    const min=parseFloat(d.settings?.lowStock||5);
    return (d.products||[]).filter(p=>parseFloat(p.qty||0)<=min);
  },
  getStockValue() {
    const d=window.db; if(!d) return 0;
    return (d.products||[]).reduce((s,p)=>s+parseFloat(p.qty||0)*parseFloat(p.cost||p.price||0),0);
  },
};
window.InventoryService = InventoryService;
