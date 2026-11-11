export const SAMPLE_DEALS = [
  {id:'RR-004',client:'Orbit Labs',initials:'OL',title:'A new perspective',category:'X post / thread',amount:1250,deadline:'2026-11-20',usage:'Organic only',status:'ready',synthetic:true},
  {id:'RR-003',client:'Forma Studio',initials:'FS',title:'The launch edit',category:'YouTube integration',amount:2400,deadline:'2026-11-26',usage:'Organic only',status:'draft',synthetic:true},
  {id:'RR-002',client:'Northstar',initials:'NS',title:'Notes for the curious',category:'Newsletter placement',amount:1500,deadline:'2026-11-14',usage:'Organic only',status:'ready',synthetic:true},
  {id:'RR-001',client:'Fieldwork',initials:'FW',title:'Made for the everyday',category:'Instagram reel',amount:900,deadline:'2026-11-08',usage:'Organic only',status:'paid',synthetic:true},
];
export function validDeal(deal) {
 return deal && typeof deal.id==='string' && typeof deal.client==='string' && typeof deal.title==='string' && ['draft','ready','paid'].includes(deal.status) && Number.isFinite(deal.amount) && deal.amount>0 && deal.amount<=10000000 && typeof deal.deadline==='string' && /^\d{4}-\d{2}-\d{2}$/.test(deal.deadline) && Number.isFinite(Date.parse(deal.deadline+'T12:00:00Z'));
}
export function createDealDesk({state,icon,escape:esc,openDialog,toast,persist,onReceipt,categories}) {
 let selectedId=state.deals[0]?.id, filter='all', showVolume=false;
 const $=selector=>document.querySelector(selector);
 const number=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value);
 const date=value=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(`${value}T12:00:00Z`));
 const selected=()=>state.deals.find(d=>d.id===selectedId);
 const statuses={draft:'Draft',ready:'Ready to pay',paid:'Paid · demo'};
 function render() {
   const focused=document.activeElement?.closest('[data-action]');
   const focusAction=focused?.dataset.action, focusId=focused?.dataset.id, focusFilter=focused?.dataset.filter;
   const active=state.deals.filter(d=>d.status!=='paid').length;
   const ready=state.deals.filter(d=>d.status==='ready').length;
   const visible=state.deals.filter(d=>filter==='all'||(filter==='active'?d.status!=='paid':d.status==='paid'));
   if(!visible.some(d=>d.id===selectedId))selectedId=visible[0]?.id;
   const deal=selected();
   $('#deals-page').innerHTML=`<div class="dashboard-intro"><div><p class="eyebrow">THE CREATOR DEAL DESK</p><h1 id="deals-title">Private <span class="serif">deals.</span></h1></div><div class="desk-meta"><span>DEMO WORKSPACE</span><p>Your terms. Your business.</p></div></div><div class="desk-summary"><div><span>On your desk</span><strong>${String(active).padStart(2,'0')}</strong><small>Active deals</small></div><div><span>Agreed value <button class="value-toggle" data-action="toggle-volume" aria-label="${showVolume?'Hide':'Show'} sample deal value">${icon(showVolume?'eye-off':'lock')}</button></span><strong>${showVolume?`$${number(state.deals.filter(d=>d.status!=='draft').reduce((s,d)=>s+d.amount,0))}`:'$•••••'}</strong><small>Sample USDC</small></div><div><span>Next up</span><strong>${String(ready).padStart(2,'0')}</strong><small>Ready to pay</small></div></div><div class="deal-workspace"><section class="deal-list-panel" aria-label="Deals"><div class="deal-list-heading"><h2>On your desk.</h2><div class="deal-filters" role="group" aria-label="Filter deals">${[['all','All'],['active','Active'],['paid','Paid']].map(([key,label])=>`<button data-action="deal-filter" data-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</div></div><div class="deal-list">${visible.length?visible.map(d=>`<button class="deal-row" data-action="select-deal" data-id="${esc(d.id)}" aria-pressed="${d.id===selectedId}"><span class="deal-avatar">${esc(d.initials||d.client.slice(0,2).toUpperCase())}</span><span class="deal-row-content"><strong>${esc(d.title)}</strong><span>${esc(d.client)}</span></span><span class="deal-row-meta"><span class="status-tag ${d.status}">${statuses[d.status]}</span><small>${date(d.deadline)}</small></span>${icon('arrow-up-right')}</button>`).join(''):'<div class="empty-state">No deals here yet.</div>'}</div><button class="new-deal-row" data-action="new-deal">${icon('plus')} Start a new deal</button><div class="list-bottom"><span>${String(state.deals.length).padStart(2,'0')} DEALS</span><span>${icon('lock')} Local demo workspace</span></div></section>${deal?detail(deal):'<article class="deal-detail detail-empty"><span class="receipt-icon">'+icon('receipt')+'</span><h2>A clean slate.</h2><p>Create a deal to get started.</p></article>'}</div><div class="desk-bottom"><article class="rings-note"><span class="rings-note-icon">${icon('shield')}</span><div><h3>Your price stays private.</h3><p>Rings hides payment amounts. Wallet addresses stay public.</p><button class="text-button" data-action="methodology">Privacy details ${icon('arrow-up-right')}</button></div><span class="rings-watermark" aria-hidden="true">◎</span></article><a class="benchmark-link" href="#explore"><span class="eyebrow">BEFORE YOUR NEXT DEAL</span><h3>Get a second <span class="serif">opinion.</span></h3><span>Explore the rate index ${icon('arrow-up-right')}</span></a></div><p class="table-note">Demo deals · No wallet connected · No funds are sent</p>`;
   if(focusAction&&['select-deal','deal-filter','toggle-volume'].includes(focusAction)) {
    const nodes=[...$('#deals-page').querySelectorAll(`[data-action="${focusAction}"]`)];
    nodes.find(el=>(!focusId||el.dataset.id===focusId)&&(!focusFilter||el.dataset.filter===focusFilter))?.focus({preventScroll:true});
   }
 }
 function detail(d) {
   const stage={draft:0,ready:1,paid:2}[d.status];
   return `<article class="deal-detail"><button class="detail-mobile-back text-button" data-action="back-to-deals">← All deals</button><div class="detail-top"><span class="eyebrow">${esc(d.id)} / PRIVATE TERMS</span><button class="icon-button" data-action="export-deal" aria-label="Export selected demo deal">${icon('download')}</button></div><div class="detail-brand"><span class="deal-avatar">${esc(d.initials||d.client.slice(0,2).toUpperCase())}</span><span>${esc(d.client)}</span></div><h2>${esc(d.title)}</h2><div class="detail-amount"><strong>${number(d.amount)}</strong><span>USDC</span>${icon('lock')}</div><dl class="detail-facts"><div><dt>Due date</dt><dd>${date(d.deadline)}</dd></div><div><dt>Deliverable</dt><dd>${esc(d.category)}</dd></div><div><dt>Usage</dt><dd>${esc(d.usage||'Organic only')}</dd></div><div><dt>Status</dt><dd>${statuses[d.status]}</dd></div></dl><ol class="deal-timeline" aria-label="Deal progress">${['Draft','Agreed','Paid'].map((label,i)=>`<li class="${i<stage?'completed':i===stage?'current':''}"><span>${i<stage?icon('check'):i+1}</span><strong>${label}</strong></li>`).join('')}</ol><button class="button dark" data-action="review-deal">${stage===0?'Review terms':stage===1?'Preview payment':'View demo receipt'} ${icon('arrow-up-right')}</button><small class="detail-note">${stage===2?'Simulated payment. No onchain proof.':'Demo terms · Stored on this device'}</small></article>`;
 }
 function newDeal() {
   const deadline=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
   openDialog('Start with the terms.','NEW DEAL',`<form id="deal-form"><div class="form-grid"><label class="full">Project<input name="title" placeholder="e.g. The launch edit" maxlength="80" required /></label><label>Counterparty<input name="client" placeholder="Brand or creator" maxlength="60" required /></label><label>Amount · USDC<input name="amount" type="number" min="1" max="10000000" step="0.01" inputmode="decimal" placeholder="1,250" required /></label><label>Deliverable<select name="category">${categories.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><label>Due date<input name="deadline" type="date" value="${deadline}" min="${new Date().toISOString().slice(0,10)}" required /></label><label class="full">Usage<select name="usage"><option>Organic only</option><option>30-day paid usage</option><option>90-day paid usage</option></select></label></div><p class="field-hint" style="margin-top:16px">Local draft only. No contract is signed or sent.</p><div class="dialog-actions"><button type="button" class="button outline" data-action="close">Cancel</button><button type="submit" class="button dark">Create draft ${icon('arrow-right')}</button></div></form>`);
   $('#deal-form').addEventListener('submit',e=>{
     e.preventDefault();const f=new FormData(e.target);const title=String(f.get('title')).trim(),client=String(f.get('client')).trim(),amount=Number(f.get('amount'));
     if(!title||!client||!Number.isFinite(amount)||amount<=0||amount>10000000)return;
     const d={id:'RR-'+crypto.randomUUID().slice(0,6).toUpperCase(),title,client,initials:client.split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase(),amount,category:f.get('category'),deadline:f.get('deadline'),usage:f.get('usage'),status:'draft',synthetic:true};
     state.deals.unshift(d);state.deals=state.deals.slice(0,100);selectedId=d.id;filter='all';const saved=persist();$('#app-dialog').close();location.hash='deals';render();toast(saved?'Draft saved on this device.':'Draft available for this visit.');
   });
 }
 function review() {
   const d=selected();if(!d)return;
   const terms=`<div class="local-receipt"><div><span>Counterparty</span><strong>${esc(d.client)}</strong></div><div><span>Project</span><strong>${esc(d.title)}</strong></div><div><span>Amount</span><strong>${number(d.amount)} USDC</strong></div><div><span>Deliverable</span><strong>${esc(d.category)}</strong></div><div><span>Usage</span><strong>${esc(d.usage)}</strong></div></div>`;
   if(d.status==='draft')openDialog('Review the deal.','DRAFT / '+esc(d.id),`${terms}<p>Demo approval changes this local draft to “Ready to pay.” It is not a signature or counterparty consent.</p><div class="dialog-actions"><button class="button outline" data-action="close">Back</button><button class="button dark" data-action="approve-demo-deal">Approve demo terms ${icon('check')}</button></div>`);
   else if(d.status==='ready')openDialog('A private payment.','PAYMENT PREVIEW',`${terms}<div class="disclosure-box private"><h3>${icon('lock')} Amount confidential</h3><p>With Rings, this amount is visible to the sender and recipient. Wallet addresses remain public.</p></div><p style="margin-top:16px">This is a simulation. No wallet is connected and no USDC will move.</p><div class="dialog-actions"><button class="button outline" data-action="close">Back</button><button class="button dark" data-action="simulate-payment">Simulate payment ${icon('arrow-right')}</button></div>`);
   else openDialog('The work, on record.','DEMO RECEIPT / '+esc(d.id),`<div class="success-mark">${icon('receipt')}</div>${terms}<p><strong>Simulated settlement.</strong> No transaction hash, payment proof, or signature exists for this demo receipt.</p><div class="dialog-actions"><button class="button outline" data-action="export-deal">Export record ${icon('download')}</button><button class="button dark" data-action="studio">View receipts ${icon('arrow-right')}</button></div>`);
 }
 function exportDeal(){const d=selected();if(!d)return;const blob=new Blob([JSON.stringify({...d,notice:'Fictional local demo. Not a signed agreement or proof of payment.'},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${d.id}-demo.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('Demo deal exported.');}
 function handle(action,target){
  if(action==='select-deal'){selectedId=target.dataset.id;render();if(matchMedia('(max-width: 760px)').matches){$('.deal-detail').scrollIntoView({block:'start'});const title=$('.deal-detail h2');title.tabIndex=-1;title.focus({preventScroll:true});}}
  else if(action==='back-to-deals'){$('.deal-list-panel').scrollIntoView({block:'start'});document.querySelector('.deal-row[aria-pressed="true"]')?.focus({preventScroll:true});}
  else if(action==='deal-filter'){filter=target.dataset.filter;render();}
  else if(action==='toggle-volume'){showVolume=!showVolume;render();}
  else if(action==='new-deal')newDeal();
  else if(action==='review-deal')review();
  else if(action==='export-deal')exportDeal();
  else if(action==='approve-demo-deal'){const d=selected();if(!d||d.status!=='draft')return true;d.status='ready';const saved=persist();$('#app-dialog').close();render();toast(saved?'Demo terms approved locally.':'Demo terms approved for this visit.');}
  else if(action==='simulate-payment'){
   const d=selected();if(!d||d.status!=='ready')return true;d.status='paid';onReceipt({id:crypto.randomUUID(),dealId:d.id,category:d.category,audience:'50k–100k',region:'Global',amount:d.amount,createdAt:new Date().toISOString(),synthetic:true});persist();filter='all';render();review();
  }else return false;
  return true;
 }
 return {render,handle};
}
