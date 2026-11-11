import { createLiveDesk } from './live-desk.mjs';
import { CATEGORIES, AUDIENCE_BRACKETS, REGIONS, DEFAULT_FILTERS, filterBenchmarks, findBenchmark, compareOffer, formatCurrency as money, benchmarksToCSV } from './data.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 'arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>',
 'arrow-right':'<path d="M4 12h15m-6-6 6 6-6 6"/>',
 'plus':'<path d="M12 5v14M5 12h14"/>',
 'check':'<path d="m5 12 4 4L19 6"/>',
 'close':'<path d="m6 6 12 12M6 18 18 6"/>',
 'lock':'<rect x="5.5" y="10" width="13" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
 'shield':'<path d="m12 2 8 3v6c0 5-8 10-8 10S4 16 4 11V5l8-3Z"/><path d="m8 11 3 3 5-6"/>',
 'eye-off':'<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9 5.4c1-.3 2-.4 3-.4 7 0 10 7 10 7s-1.1 2.5-3.5 4.5M6 6.5C3.4 8.3 2 12 2 12s3 7 10 7c2 0 3.6-.5 5-1.3"/>',
 'receipt':'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
 'users':'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v2"/>',
 'info':'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7v.5"/>',
 'reset':'<path d="M3 9a9 9 0 1 1 0 6M3 3v6h6"/>',
 'search':'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 'download':'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
 'bookmark':'<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
 'trash':'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
 'menu':'<path d="M4 8h16M4 16h16"/>',
 'asterisk':'<path d="M12 2v20M2 12h20M5 5l14 14M5 19 14-14"/>',
 'x':'<path d="m4 3 12 18h4L8 3H4Z"/><path d="M20 3 4 21"/>',
 'youtube':'<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3V9Z"/>',
 'newsletter':'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
 'instagram':'<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const hydrateIcons = (root = document) => $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const categoryIcons = ['x','youtube','newsletter','instagram'];
const categoryLabels = ['X post / thread','YouTube integration','Newsletter placement','Instagram reel'];
const storageKey = 'rate-radar-comparisons-v2';
let stored = {};
try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Private mode and corrupt storage fall back to a clean session. */ }
let state = {
  filters: { ...DEFAULT_FILTERS },
  comparisons: Array.isArray(stored.comparisons) ? stored.comparisons.filter(c=>c && typeof c.id === 'string' && Number.isFinite(c.amount)).slice(0,100) : [],
  offer: null,
  query: '',
};
if (stored.filters && CATEGORIES.includes(stored.filters.category) && AUDIENCE_BRACKETS.includes(stored.filters.audience) && REGIONS.includes(stored.filters.region)) state.filters = {...stored.filters};
const params = new URLSearchParams(location.search);
for (const [key, values] of Object.entries({category:CATEGORIES,audience:AUDIENCE_BRACKETS,region:REGIONS})) if (values.includes(params.get(key))) state.filters[key] = params.get(key);
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500); }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify({filters:state.filters, comparisons:state.comparisons})); return true; } catch { toast('Browser storage is unavailable. Your changes last for this visit.'); return false; } }
function syncStudioDot() { $('.studio-dot').hidden = !(desk.receiptCount + state.comparisons.length); }
const options = (values, selected) => values.map(value=>`<option value="${escape(value)}" ${value===selected?'selected':''}>${escape(value)}</option>`).join('');
$('#audience-filter').innerHTML = options(AUDIENCE_BRACKETS, state.filters.audience);
$('#region-filter').innerHTML = options(REGIONS, state.filters.region);

function renderDistribution(benchmark) {
  const values = [10,14,20,28,38,51,65,80,96,111,122,129,132,130,124,114,101,86,70,54,39,28,19,13,9,6,4,3];
  const width=600, chartBottom=135, barWidth=15, gap=6, start=9;
  const bars=values.map((height,i)=>`<rect x="${start+i*(barWidth+gap)}" y="${chartBottom-height*.78}" width="${barWidth}" height="${height*.78}" rx="2" fill="${i>=6&&i<=19?'#bdcf82':'#e5ebd5'}"/>`).join('');
  let marker = '';
  if (state.offer) {
    const pct = state.offer.percentile;
    const x = Math.max(16,Math.min(584,16+(pct/100)*568));
    const lx = Math.max(53,Math.min(547,x));
    marker = `<line x1="${x}" x2="${x}" y1="34" y2="135" stroke="#414b2e" stroke-width="1.5" stroke-dasharray="3 3"/><rect x="${lx-49}" y="9" width="98" height="24" rx="4" fill="#24271f"/><text x="${lx}" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#f6f6ee">Your offer ${money(state.offer.amount)}</text><circle cx="${x}" cy="135" r="4" fill="#24271f"/>`;
  }
  $('#distribution').innerHTML = `<svg viewBox="0 0 ${width} 158" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="600" y1="135" y2="135" stroke="#d9dfca"/>${bars}${marker}<text x="9" y="154" font-size="9" font-family="Arial,sans-serif" fill="#62704f">Lower rates</text><text x="300" y="154" text-anchor="middle" font-size="8" letter-spacing="1" font-family="Arial,sans-serif" fill="#62704f">ILLUSTRATIVE DISTRIBUTION</text><text x="593" y="154" text-anchor="end" font-size="9" font-family="Arial,sans-serif" fill="#62704f">Higher rates</text></svg>`;
  $('#distribution').setAttribute('aria-label', `Illustrative distribution. The middle half of this synthetic cohort ranges from ${money(benchmark.p25)} to ${money(benchmark.p75)} with a median of ${money(benchmark.median)}.${state.offer?` Your offer is at the modeled ${state.offer.percentile}th percentile.`:''}`);
}

function marketRows() {
  return filterBenchmarks({ audience:state.filters.audience, region:state.filters.region }).filter(row=>row.category.toLowerCase().includes(state.query.toLowerCase()));
}
function renderTable() {
  const rows=marketRows();
  $('#market-rows').innerHTML=rows.map(row=>`<tr><td><div class="format-cell"><span class="platform-icon">${icon(categoryIcons[CATEGORIES.indexOf(row.category)])}</span><div><strong>${escape(row.category)}</strong><small>${escape(row.audience)} ${escape(row.audienceMetric)}</small></div></div></td><td>${money(row.p25)} – ${money(row.p75)}</td><td>${money(row.median)}</td><td>${row.sampleSize}</td><td><button class="icon-button" data-action="select-category" data-category="${escape(row.category)}" aria-label="Explore ${escape(row.category)}">${icon('arrow-up-right')}</button></td></tr>`).join('');
  $('#market-empty').hidden = !!rows.length;
}
function render() {
  const focusedCategory = document.activeElement?.closest('.category-tab')?.dataset.category;
  const benchmark=findBenchmark(state.filters);
  $('#category-tabs').innerHTML=CATEGORIES.map((category,i)=>`<button class="category-tab" aria-pressed="${state.filters.category===category}" data-action="category" data-category="${escape(category)}">${icon(categoryIcons[i])}${categoryLabels[i]}</button>`).join('');
  $('#audience-filter').value=state.filters.audience;
  $('#region-filter').value=state.filters.region;
  $('#cohort-eyebrow').textContent=`${state.filters.category.toUpperCase()} · ${state.filters.region.toUpperCase()}`;
  $('#median-value').textContent=money(benchmark.median);
  $('#sample-count').textContent=`${benchmark.sampleSize} sample receipts`;
  $('#p25-value').textContent=money(benchmark.p25);
  $('#p75-value').textContent=money(benchmark.p75);
  $('#stat-median').textContent=money(benchmark.median);
  if (state.offer) { state.offer=compareOffer(state.offer.amount,benchmark); renderOffer(); }
  renderDistribution(benchmark);
  renderTable();
  if(focusedCategory) $$('.category-tab').find(el=>el.dataset.category===focusedCategory)?.focus({preventScroll:true});
}
function setFilter(key,value) { state.filters[key]=value; persist(); const url=new URL(location.href); for(const [k,v] of Object.entries(state.filters))url.searchParams.set(k,v); history.replaceState(null,'',url); render(); }
$('#audience-filter').addEventListener('change',e=>setFilter('audience',e.target.value));
$('#region-filter').addEventListener('change',e=>setFilter('region',e.target.value));
$('#market-search').addEventListener('input',e=>{state.query=e.target.value;renderTable();});
$('#offer-form').addEventListener('submit',e=>{
  e.preventDefault();
  const result=compareOffer($('#offer-amount').value,findBenchmark(state.filters));
  if (!result.valid || result.amount>10000000) { $('#offer-error').textContent=result.message||'Enter an offer below $10,000,000.'; $('#offer-error').hidden=false;return; }
  $('#offer-error').hidden=true;state.offer=result;renderOffer();renderDistribution(findBenchmark(state.filters));
});
$('#offer-amount').addEventListener('input',()=>{
  $('#offer-error').hidden=true;
  // Clear a stale result while the amount is being edited.
  if(state.offer){state.offer=null;$('#offer-result').hidden=true;renderDistribution(findBenchmark(state.filters));}
});
function renderOffer() {
  const result=state.offer;
  const titles={below:'Room to negotiate.',within:'In good company.',above:'A strong starting point.'};
  $('#offer-result').hidden=false;
  $('#offer-result').innerHTML=`<span class="result-label">${result.medianDeltaPercent===0?'At the sample median':`${Math.abs(result.medianDeltaPercent)}% ${result.relation} the sample median`}</span><h4>${titles[result.status]}</h4><p>${escape(result.explanation)} The middle half of this sample is ${money(result.typicalRange[0])}–${money(result.typicalRange[1])}.</p><button class="text-button" data-action="save-comparison">${icon('bookmark')} Save comparison</button>`;
}
const dialog=$('#app-dialog');
let dialogTrigger=null;
let dialogTriggerAction=null;
function openDialog(title,eyebrow,content,wide=false){
  if(!dialog.open){dialogTrigger=document.activeElement;dialogTriggerAction=dialogTrigger?.closest('[data-action]')?.dataset.action||null;}
  dialog.style.width=wide?'min(650px, calc(100% - 32px))':'';
  $('#dialog-content').innerHTML=`<div class="dialog-head"><div><p class="eyebrow">${eyebrow}</p><h2 id="dialog-title">${title}</h2></div><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${content}</div>`;
  if(!dialog.open)dialog.showModal();
  dialog.scrollTop=0;
  const heading=$('#dialog-title');heading.tabIndex=-1;heading.focus({preventScroll:true});
}
function closeDialog(){dialog.close();}
dialog.addEventListener('close',()=>{if(dialogTrigger?.isConnected)dialogTrigger.focus({preventScroll:true});else if(dialogTriggerAction)$$('[data-action]').find(el=>el.dataset.action===dialogTriggerAction&&el.getClientRects().length)?.focus({preventScroll:true});});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
function methodology(){
 openDialog('Clarity, without oversharing.','PRIVACY & METHODOLOGY',`<div class="methodology-lead"><p><strong>Real deal workflow. Devnet payments.</strong> Your workspace stores agreed terms and verifies settlement through Solana Rings. Devnet tokens have no monetary value.</p></div><details open><summary>Who can see my deal?</summary><p>The two linked wallets can access the deal through their signed-in workspace. Your terms and amounts are also processed by this application’s server. Onchain privacy does not hide them from this service.</p></details><details><summary>What does Rings keep private?</summary><p>Rings encrypts private-transfer assets, amounts, and balances. Sender and recipient wallet addresses remain public. Deposits and withdrawals reveal their asset and amount.</p><p>Settlement verification shares a transaction-scoped viewing key with the server. It can reveal other outputs in that transaction. Your full wallet viewing key and spending keys stay in your browser. Mainnet is not enabled.</p><p><a href="https://www.helius.dev/docs/privacy/concepts/encryption" target="_blank" rel="noopener noreferrer">Helius privacy guarantees ↗</a></p></details><details><summary>When is a deal paid?</summary><p>Both parties first sign the same version of the terms. A payment is marked paid only after the backend verifies its finalized transaction and checks the recipient, asset, amount, and payment intent.</p></details><details><summary>Are the rate benchmarks real?</summary><p>No. All rates, counts, and distributions in the Rate index are fictional sample data. Your payment receipts do not enter that index. Private aggregation and anonymous contributions are not implemented.</p></details><details><summary>What stays on my device?</summary><p>Sample offer comparisons and rate filters are saved in this browser. Real deals, signed approvals, and verified settlement records live in the authenticated backend. Wallet secrets are not saved by this application.</p><p>The interface loads fonts from Google Fonts.</p></details>`,true);
}

let studioView='receipts';
function renderStudio(view=studioView){
 studioView=view;
 const isReceipts=view==='receipts';
 const comparisons=state.comparisons;
 const content=isReceipts?desk.receiptsMarkup():comparisons.length?comparisons.map(item=>`<div class="studio-item"><span class="receipt-icon">${icon('bookmark')}</span><div><strong>${escape(item.category)} · ${money(item.amount)}</strong><small>${escape(item.audience)} · ${escape(item.region)} · Sample comparison</small></div><button class="icon-button" data-action="remove-comparison" data-id="${escape(item.id)}" aria-label="Delete saved comparison">${icon('trash')}</button></div>`).join(''):`<div class="studio-empty"><span>${icon('bookmark')}</span><h3>Your next offer, in context.</h3><p>Saved sample comparisons appear here.</p><button class="button dark" data-action="go-explore">Explore sample rates ${icon('arrow-up-right')}</button></div>`;
 $('#studio-page').innerHTML=`<div class="dashboard-intro"><div><p class="eyebrow">YOUR PRIVATE RECORD · DEVNET</p><h1 id="studio-title">The <span class="serif">paperwork.</span></h1></div><div class="desk-meta"><span>VERIFIED SETTLEMENTS</span><p>Real records. Clear status.</p></div></div><div class="studio-surface"><div class="studio-tabs" role="tablist" aria-label="Studio views"><button role="tab" id="receipts-tab" aria-controls="studio-panel" tabindex="${isReceipts?'0':'-1'}" aria-selected="${isReceipts}" data-action="studio-receipts">Receipts <span>${desk.receiptCount}</span></button><button role="tab" id="comparisons-tab" aria-controls="studio-panel" tabindex="${!isReceipts?'0':'-1'}" aria-selected="${!isReceipts}" data-action="studio-comparisons">Sample offers <span>${comparisons.length}</span></button></div><div role="tabpanel" id="studio-panel" aria-labelledby="${isReceipts?'receipts-tab':'comparisons-tab'}">${content}</div><div class="studio-bottom"><p>${isReceipts?'Only backend-verified settlements appear here.':'Fictional benchmark comparisons saved on this device.'}</p>${!isReceipts&&comparisons.length?'<button data-action="clear-comparisons">Clear sample offers</button>':''}</div></div>`;
}
function openStudio(view=studioView){
 studioView=view;
 if(dialog.open)closeDialog();
 if(location.hash!=='#studio')location.hash='studio';
 else {renderStudio();$('.studio-tabs [aria-selected="true"]')?.focus({preventScroll:true});}
}
function saveComparison(){
 if(!state.offer)return;
 const duplicate=state.comparisons.some(c=>c.amount===state.offer.amount&&c.category===state.filters.category&&c.audience===state.filters.audience&&c.region===state.filters.region);
 if(duplicate){toast('This comparison is already saved.');return;}
 state.comparisons.unshift({id:crypto.randomUUID(),...state.filters,amount:state.offer.amount,median:findBenchmark(state.filters).median,createdAt:new Date().toISOString(),synthetic:true});state.comparisons=state.comparisons.slice(0,100);const saved=persist();syncStudioDot();toast(saved?'Sample comparison saved on this device.':'Comparison available for this visit.');
}
function exportBenchmarks(){
 const csv=benchmarksToCSV(marketRows());const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='rate-radar-sample-benchmarks.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('Sample benchmarks exported.');
}
document.addEventListener('click',e=>{
 const target=e.target.closest('[data-action]');if(!target)return;
 const action=target.dataset.action;
 if(desk.handle(action,target))return;
 if(action==='category'||action==='select-category'){setFilter('category',target.dataset.category);if(action==='select-category')$('.benchmark-grid').scrollIntoView({block:'center'});}
 else if(action==='reset'){state.filters={...DEFAULT_FILTERS};state.query='';$('#market-search').value='';const url=new URL(location.href);for(const key of ['category','audience','region'])url.searchParams.delete(key);history.replaceState(null,'',url);persist();render();toast('Filters reset.');}
 else if(action==='methodology')methodology();
 else if(action==='close')closeDialog();
 else if(action==='studio')openStudio();
 else if(action==='studio-receipts')openStudio('receipts');
 else if(action==='studio-comparisons')openStudio('comparisons');
 else if(action==='save-comparison')saveComparison();
 else if(action==='export')exportBenchmarks();
 else if(action==='remove-comparison'){state.comparisons=state.comparisons.filter(i=>i.id!==target.dataset.id);persist();syncStudioDot();renderStudio();toast('Sample comparison removed.');}
 else if(action==='clear-comparisons')openDialog('Clear sample offers?','ON THIS DEVICE',`<p>This removes saved sample comparisons. Your real deals and receipts stay in your workspace.</p><div class="dialog-actions"><button class="button outline" data-action="close">Keep offers</button><button class="button dark" data-action="confirm-clear-comparisons">Clear sample offers ${icon('trash')}</button></div>`);
 else if(action==='confirm-clear-comparisons'){state.comparisons=[];persist();syncStudioDot();openStudio('comparisons');toast('Sample offers cleared.');}
 else if(action==='go-explore'){if(dialog.open)closeDialog();location.hash='explore';}
 else if(action==='go-deals'){if(dialog.open)closeDialog();location.hash='deals';}
 else if(action==='menu')openDialog('Workspace.','DEVNET',`<nav class="menu-links" aria-label="Mobile navigation"><a href="#deals" data-action="close">Deal desk ↗</a><a href="#explore" data-action="close">Sample rate index ↗</a><button data-action="studio">Receipts ↗</button><button data-action="connect-wallet">Wallet ↗</button><button data-action="methodology">Privacy & methodology ↗</button></nav>`);
});
document.addEventListener('keydown',e=>{if(e.target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();openStudio(studioView==='receipts'?'comparisons':'receipts');$('.studio-tabs [aria-selected="true"]')?.focus();}});
const desk=createLiveDesk({icon,escape,openDialog,closeDialog,toast,categories:CATEGORIES,onChange:()=>{syncStudioDot();if(location.hash==='#studio')renderStudio();}});
function showRoute(){
 const route=location.hash==='#studio'?'studio':location.hash==='#explore'?'index':'deals';
 $('#deals-page').hidden=route!=='deals';$('#index-page').hidden=route!=='index';$('#studio-page').hidden=route!=='studio';
 $$('[data-nav]').forEach(a=>{if(a.dataset.nav===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 if(route==='deals')desk.render();else if(route==='studio')renderStudio();else render();
 window.scrollTo(0,0);
}
window.addEventListener('hashchange',showRoute);
hydrateIcons();render();showRoute();desk.init();
