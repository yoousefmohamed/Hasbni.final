'use strict';
const EventBus = {
  _h: {},
  on(e, fn) { if(!this._h[e]) this._h[e]=[]; this._h[e].push(fn); return ()=>this.off(e,fn); },
  off(e, fn) { if(this._h[e]) this._h[e]=this._h[e].filter(h=>h!==fn); },
  emit(e, d) { (this._h[e]||[]).forEach(h=>{ try{h(d);}catch(err){console.error('[EventBus]',e,err);} }); },
  once(e, fn) { const u=this.on(e,(d)=>{u();fn(d);}); }
};
window.EventBus = EventBus;
