import { SAMPLE_DEALS, validDeal, createDealDesk } from './deals.mjs';
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
const storageKey = 'rate-radar-studio-v1';
let stored = {};
try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Private mode and corrupt storage fall back to a clean session. */ }
let state = {
  filters: { ...DEFAULT_FILTERS },
  deals: Array.isArray(stored.deals) ? stored.deals.filter(validDeal).slice(0,100) : structuredClone(SAMPLE_DEALS),
  receipts: Array.isArray(stored.receipts) ? stored.receipts.filter(r=>r && typeof r.id === 'string' && Number.isFinite(r.amount)).slice(0,100) : [],
  comparisons: Array.isArray(stored.comparisons) ? stored.comparisons.filter(c=>c && typeof c.id === 'string' && Number.isFinite(c.amount)).slice(0,100) : [],
  offer: null,
  query: '',
};
if (stored.filters && CATEGORIES.includes(stored.filters.category) && AUDIENCE_BRACKETS.includes(stored.filters.audience) && REGIONS.includes(stored.filters.region)) state.filters = {...stored.filters};
const params = new URLSearchParams(location.search);
for (const [key, values] of Object.entries({category:CATEGORIES,audience:AUDIENCE_BRACKETS,region:REGIONS})) if (values.includes(params.get(key))) state.filters[key] = params.get(key);
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500); }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify({filters:state.filters, receipts:state.receipts, comparisons:state.comparisons, deals:state.deals})); return true; } catch { toast('Browser storage is unavailable. Your changes last for this visit.'); return false; } }
function syncStudioDot() { $('.studio-dot').hidden = !(state.receipts.length + state.comparisons.length); }
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
 openDialog('Clarity, without oversharing.','PRIVACY & METHODOLOGY',`<div class="methodology-lead"><p><strong>This is an interactive product preview.</strong> Every market rate, receipt count, and distribution is fictional. No payment has been verified, and no funds can move through this site.</p></div><details open><summary>What would make these benchmarks different?</summary><p>The proposed product uses settled confidential payments as evidence, instead of asking people to self-report a rate. Participants would prove facts about their payments without sending individual amounts to the benchmark operator.</p></details><details><summary>How does this preview calculate comparisons?</summary><p>Choose a format, audience bracket, and creator market. The median is the midpoint of a fictional cohort; the typical range is its 25th–75th percentile. Offer percentiles are approximated between summary quantiles. The chart is a conceptual illustration, not a measured histogram.</p><p>All deals assume one organic deliverable without paid usage or exclusivity. They are not quotes or observed market rates.</p></details><details><summary>What stays private with Solana Rings?</summary><p>Rings encrypts transfer assets, amounts, and balances within the default ring. Sender and recipient wallet addresses remain public. Deposits and withdrawals reveal their asset and amount.</p><p>Anonymous benchmark contributions, private aggregation, and proofs that bind a contribution to a settled payment require additional engineering. They are not provided by this preview.</p><p><a href="https://www.helius.dev/docs/privacy/concepts/encryption" target="_blank" rel="noopener noreferrer">Read Helius’s privacy guarantees ↗</a></p></details><details><summary>How would fake or identifiable data be handled?</summary><p>A payment proves that funds moved, not that a job was genuine. A production system needs independent-counterparty checks, jointly signed work context, duplicate prevention, minimum cohort sizes, batched publication, and protections against inferring a single person’s payment.</p></details><details><summary>What does this site save?</summary><p>Deal drafts (including counterparty names, terms and amounts), filters, saved comparisons, and demo receipts stay in this browser’s local storage. Nothing is sent to a payment or benchmark server. Use fictional information. Clear receipts and saved offers in the Receipts screen, or reset the entire workspace below.</p><p>The interface loads fonts from Google Fonts. Your browser contacts that service for the font files.</p><button class="text-button" data-action="reset-workspace">Reset entire demo workspace ↗</button></details>`,true);
}

let contribution={};
let contributeStep=1;
function stepTrack(step){return `<div class="step-track" aria-label="Step ${step} of 3">${[1,2,3].map(n=>`<span class="${n<=step?'active':''}"></span>`).join('')}</div>`;}
function startContribution(){contribution={category:state.filters.category,audience:state.filters.audience,region:state.filters.region,amount:findBenchmark(state.filters).median};contributeStep=1;renderContribution();}
function renderContribution(){
 if(contributeStep===1){
  openDialog('Add a receipt.','CONTRIBUTE / 01',`${stepTrack(1)}<p class="dialog-intro">Choose a sample payment to try the contribution flow.</p><label class="receipt-choice"><input type="radio" name="sample-payment" checked /><span class="receipt-icon">${icon('receipt')}</span><div><strong>Sample sponsorship payment</strong><small>${money(contribution.amount)} USDC · Fictional receipt</small></div><span>${icon('check')}</span></label><div class="disclosure-box"><h3>${icon('info')} A safe space to explore</h3><p>Local demo only. No wallet, verification, or market submission.</p></div><div class="dialog-actions"><button class="button dark" data-action="contribute-next">Add work context ${icon('arrow-right')}</button></div>`);
 } else if(contributeStep===2){
  openDialog('Add work context.','CONTRIBUTE / 02',`${stepTrack(2)}<p class="dialog-intro">Help compare like with like. Use fictional details for this preview.</p><form id="context-form"><div class="form-grid"><label>Deliverable<select name="category">${options(CATEGORIES,contribution.category)}</select></label><label>Audience size<select name="audience">${options(AUDIENCE_BRACKETS,contribution.audience)}</select></label><label>Creator market<select name="region">${options(REGIONS,contribution.region)}</select></label><label>Sample payment · USD<input name="amount" type="number" min="1" max="10000000" step="0.01" inputmode="decimal" value="${contribution.amount}" required /></label><label class="full">Usage rights<select name="usage"><option>Organic placement only</option></select><span class="field-hint">This first cohort excludes paid usage and exclusivity so comparisons stay meaningful.</span></label></div><div class="dialog-actions"><button type="button" class="button outline" data-action="contribute-back">Back</button><button class="button dark" type="submit">Preview contribution ${icon('arrow-right')}</button></div></form>`);
  $('#context-form').addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target);const amount=Number(f.get('amount'));if(!Number.isFinite(amount)||amount<=0||amount>10000000)return;contribution={...contribution,category:f.get('category'),audience:f.get('audience'),region:f.get('region'),amount};contributeStep=3;renderContribution();});
 } else {
  openDialog('Review disclosure.','CONTRIBUTE / 03',`${stepTrack(3)}<p class="dialog-intro">Preview the disclosure. This demo stays on your device.</p><div class="disclosure-box"><h3>${icon('users')} Proposed aggregate context</h3><ul><li>${escape(contribution.category)}</li><li>${escape(contribution.audience)} audience · ${escape(contribution.region)}</li><li>Organic placement, no paid usage or exclusivity</li></ul></div><div class="disclosure-box private"><h3>${icon('lock')} Kept out of published benchmarks</h3><ul><li>Your individual payment amount</li><li>Your name and contract details</li><li>Your client’s identity and negotiated terms</li></ul></div><p style="font-size:10px;margin-top:13px">Default-ring wallet addresses remain public onchain. A live product would need additional safeguards to make benchmark submissions unlinkable.</p><label class="consent-label"><input type="checkbox" id="receipt-consent" />I understand this saves a fictional receipt in this browser. No payment proof is created or submitted.</label><div class="dialog-actions"><button class="button outline" data-action="contribute-back">Back</button><button class="button dark" data-action="confirm-contribution" id="confirm-contribution" disabled>Save demo receipt ${icon('check')}</button></div>`);
  $('#receipt-consent').addEventListener('change',e=>$('#confirm-contribution').disabled=!e.target.checked);
 }
}
function confirmContribution(){
 if(!$('#receipt-consent')?.checked)return;
 const id=crypto.randomUUID();
 const receipt={...contribution,id,createdAt:new Date().toISOString(),synthetic:true};
 state.receipts.unshift(receipt);state.receipts=state.receipts.slice(0,100);const saved=persist();syncStudioDot();
 openDialog('Receipt saved.','DEMO RECEIPT SAVED',`<div class="success-view"><div class="success-mark">${icon('check')}</div><h3>Saved on this device.</h3><p>Your sample contribution is ${saved?'saved in My studio on this device':'available in My studio for this visit'}. It has not been sent to a network or added to real benchmarks.</p><div class="local-receipt"><div><span>Receipt</span><strong>RR–${id.slice(0,8).toUpperCase()}</strong></div><div><span>Deliverable</span><strong>${escape(receipt.category)}</strong></div><div><span>Sample amount</span><strong>${money(receipt.amount)}</strong></div><div><span>Status</span><strong>Demo · not cryptographically verified</strong></div></div><button class="button dark" data-action="studio">Open my studio ${icon('arrow-right')}</button></div>`);
}

let studioView='receipts';
function renderStudio(view=studioView){
 studioView=view;
 const isReceipts=view==='receipts';const items=isReceipts?state.receipts:state.comparisons;
 const content=items.length?items.map(item=>`<div class="studio-item"><span class="receipt-icon">${icon(isReceipts?'receipt':'bookmark')}</span><div><strong>${escape(item.category)} · ${money(item.amount)}</strong><small>${escape(item.audience)} · ${escape(item.region)} · ${isReceipts?'Demo receipt':'Sample comparison'}</small></div><button class="icon-button" data-action="remove-item" data-id="${escape(item.id)}" aria-label="Delete ${escape(item.category)} ${isReceipts?'receipt':'comparison'}">${icon('trash')}</button></div>`).join(''):`<div class="studio-empty"><span>${icon(isReceipts?'receipt':'bookmark')}</span><h3>${isReceipts?'A clean slate.':'Your next offer, in context.'}</h3><p>${isReceipts?'Demo receipts from your deals appear here.':'Saved rate comparisons appear here.'}</p><button class="button dark" data-action="${isReceipts?'contribute':'go-explore'}">${isReceipts?'Try sample receipt':'Explore rates'} ${icon('arrow-up-right')}</button></div>`;
 $('#studio-page').innerHTML=`<div class="dashboard-intro"><div><p class="eyebrow">YOUR PRIVATE RECORD</p><h1 id="studio-title">The <span class="serif">paperwork.</span></h1></div><div class="desk-meta"><span>ON THIS DEVICE</span><p>Receipts & saved comparisons.</p></div></div><div class="studio-surface"><div class="studio-tabs" role="tablist" aria-label="Studio views"><button role="tab" id="receipts-tab" aria-controls="studio-panel" tabindex="${isReceipts?'0':'-1'}" aria-selected="${isReceipts}" data-action="studio-receipts">Receipts <span>${state.receipts.length}</span></button><button role="tab" id="comparisons-tab" aria-controls="studio-panel" tabindex="${!isReceipts?'0':'-1'}" aria-selected="${!isReceipts}" data-action="studio-comparisons">Saved offers <span>${state.comparisons.length}</span></button></div><div role="tabpanel" id="studio-panel" aria-labelledby="${isReceipts?'receipts-tab':'comparisons-tab'}">${content}</div><div class="studio-bottom"><p>Local demo records. No onchain proofs.</p>${state.receipts.length+state.comparisons.length?'<button data-action="clear-studio">Clear these records</button>':''}</div></div>`;
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
 if(duplicate){toast('This comparison is already in My studio.');return;}
 state.comparisons.unshift({id:crypto.randomUUID(),...state.filters,amount:state.offer.amount,median:findBenchmark(state.filters).median,createdAt:new Date().toISOString(),synthetic:true});state.comparisons=state.comparisons.slice(0,100);const saved=persist();syncStudioDot();toast(saved?'Comparison saved to My studio on this device.':'Comparison available in My studio for this visit.');
}
function exportBenchmarks(){
 const csv=benchmarksToCSV(marketRows());const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='rate-radar-sample-benchmarks.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('Sample benchmarks exported. Every row is labeled synthetic.');
}
document.addEventListener('click',e=>{
 const target=e.target.closest('[data-action]');if(!target)return;
 const action=target.dataset.action;
 if(desk.handle(action,target))return;
 if(action==='category'||action==='select-category'){setFilter('category',target.dataset.category);if(action==='select-category')$('.benchmark-grid').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});}
 else if(action==='reset'){state.filters={...DEFAULT_FILTERS};state.query='';$('#market-search').value='';const url=new URL(location.href);for(const key of ['category','audience','region'])url.searchParams.delete(key);history.replaceState(null,'',url);persist();render();toast('Filters reset.');}
 else if(action==='methodology')methodology();
 else if(action==='close')closeDialog();
 else if(action==='contribute')startContribution();
 else if(action==='contribute-next'){contributeStep++;renderContribution();}
 else if(action==='contribute-back'){contributeStep--;renderContribution();}
 else if(action==='confirm-contribution')confirmContribution();
 else if(action==='studio')openStudio();
 else if(action==='studio-receipts')openStudio('receipts');
 else if(action==='studio-comparisons')openStudio('comparisons');
 else if(action==='save-comparison')saveComparison();
 else if(action==='export')exportBenchmarks();
 else if(action==='remove-item'){const key=studioView==='receipts'?'receipts':'comparisons';state[key]=state[key].filter(i=>i.id!==target.dataset.id);const saved=persist();syncStudioDot();openStudio();toast(saved?'Record removed.':'Removed for this visit. Browser storage could not be updated.');}
 else if(action==='clear-studio')openDialog('Clear your studio?','LOCAL DATA',`<p>This removes receipts and saved offers. Your deals stay on the desk.</p><div class="dialog-actions"><button class="button outline" data-action="studio">Keep my data</button><button class="button dark" data-action="confirm-clear">Clear records ${icon('trash')}</button></div>`);
 else if(action==='reset-workspace')openDialog('Start fresh?','RESET WORKSPACE',`<p>Delete your local drafts, receipts, saved offers and filters. The four fictional sample deals will be restored.</p><div class="dialog-actions"><button class="button outline" data-action="close">Keep workspace</button><button class="button dark" data-action="confirm-reset-workspace">Reset workspace ${icon('reset')}</button></div>`);
 else if(action==='confirm-reset-workspace'){state.deals=structuredClone(SAMPLE_DEALS);state.receipts=[];state.comparisons=[];state.filters={...DEFAULT_FILTERS};state.offer=null;state.query='';$('#market-search').value='';$('#offer-amount').value='';$('#offer-result').hidden=true;const url=new URL(location.href);url.search='';url.hash='deals';history.replaceState(null,'',url);const saved=persist();closeDialog();syncStudioDot();showRoute();toast(saved?'Local data cleared. Sample workspace restored.':'Workspace reset for this visit. Browser storage could not be updated.');}
 else if(action==='confirm-clear'){state.receipts=[];state.comparisons=[];const saved=persist();syncStudioDot();openStudio();toast(saved?'Records cleared.':'Cleared for this visit. Browser storage could not be updated.');}
 else if(action==='go-explore'){if(dialog.open)closeDialog();location.hash='explore';}
 else if(action==='menu')openDialog('Workspace.','EXPLORE',`<nav class="menu-links" aria-label="Mobile navigation"><a href="#deals" data-action="close">Deal desk ↗</a><a href="#explore" data-action="close">Rate index ↗</a><button data-action="studio">Receipts ↗</button><button data-action="methodology">Privacy & methodology ↗</button></nav>`);
});
// Arrow-key navigation for the two studio tabs follows the native tab convention.
document.addEventListener('keydown',e=>{if(e.target.getAttribute('role')==='tab'&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();openStudio(studioView==='receipts'?'comparisons':'receipts');$('.studio-tabs [aria-selected="true"]').focus();}});
const desk=createDealDesk({state,icon,escape,openDialog,toast,persist,categories:CATEGORIES,onReceipt:receipt=>{state.receipts.unshift(receipt);state.receipts=state.receipts.slice(0,100);syncStudioDot();}});
function showRoute(){
 const route=location.hash==='#studio'?'studio':location.hash==='#explore'?'index':'deals';
 $('#deals-page').hidden=route!=='deals';$('#index-page').hidden=route!=='index';$('#studio-page').hidden=route!=='studio';
 $$('[data-nav]').forEach(a=>{if(a.dataset.nav===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 if(route==='deals')desk.render();else if(route==='studio')renderStudio();else render();
 window.scrollTo(0,0);
}
window.addEventListener('hashchange',showRoute);
hydrateIcons();render();syncStudioDot();showRoute();
