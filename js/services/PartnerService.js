'use strict';
const PartnerService = {
  getBalance(partnerId) {
    const d=window.db; if(!d) return 0;
    return (d.partnerTransactions||[]).filter(t=>t.partnerId===partnerId)
      .reduce((s,t)=>t.type==='deposit'?s+t.amount:s-t.amount,0);
  },
};
window.PartnerService = PartnerService;
