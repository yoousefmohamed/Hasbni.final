'use strict';
const ReportService = {
  getDashboardStats() {
    const d=window.db; if(!d) return {};
    const sales=d.sales||[]; const purch=d.purchases||[];
    const today=new Date().toDateString();
    return {
      totalSales:sales.reduce((a,s)=>a+parseFloat(s.total||0),0),
      totalPurchases:purch.reduce((a,p)=>a+parseFloat(p.total||0),0),
      totalProfit:sales.reduce((a,s)=>a+parseFloat(s.profit||0),0),
      treasuryBal:TreasuryService.getBalance(),
      todaySales:sales.filter(s=>new Date(s.ts||s.date).toDateString()===today).reduce((a,s)=>a+parseFloat(s.total||0),0),
      productCount:(d.products||[]).length,
      salesCount:sales.length,
      lowStockCount:InventoryService.getLowStock().length,
    };
  },
  getWeeklySales() {
    const d=window.db; if(!d) return [];
    const days=[];
    for(let i=6;i>=0;i--){const dt=new Date();dt.setDate(dt.getDate()-i);const k=dt.toDateString();const total=(d.sales||[]).filter(s=>new Date(s.ts||s.date).toDateString()===k).reduce((a,s)=>a+parseFloat(s.total||0),0);days.push({date:dt.toLocaleDateString('ar-EG',{weekday:'short'}),total});}
    return days;
  },
  getTopProducts(limit=5) {
    const d=window.db; if(!d) return [];
    const map={};
    (d.sales||[]).forEach(s=>{(s.items||[]).forEach(item=>{if(!map[item.name])map[item.name]={name:item.name,qty:0,total:0};map[item.name].qty+=parseFloat(item.qty||0);map[item.name].total+=parseFloat(item.subtotal||0);});});
    return Object.values(map).sort((a,b)=>b.total-a.total).slice(0,limit);
  },
};
window.ReportService = ReportService;
