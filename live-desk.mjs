const $ = selector => document.querySelector(selector);
const short = value => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : 'Not connected';
const money = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(Number(value || 0));
const day = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)) : '—';
const statusNames = {draft:'Draft',awaiting_approval:'Awaiting approval',ready:'Ready to pay',payment_pending:'Verifying',paid:'Paid'};
const stateClass = status => status === 'paid' ? 'paid' : ['ready','payment_pending'].includes(status) ? 'ready' : 'draft';

export function createLiveDesk({icon,escape:esc,openDialog,closeDialog,toast,categories,onChange}) {
  let config = null, deals = [], receipts = [], selectedId = null, filter = 'all', showVolume = false;
  let loading = true, loadError = '', busy = false, ringsWallet = null, connectedAddress = null, unlocked = false, registered = false, balances = null, walletVersion1 = null, pendingRegistration = null;
  const attempts = new Map();
  const keys = new Map();
  const selected = () => deals.find(deal => deal.id === selectedId);
  const address = () => config?.wallet || null;
  const canDraft = () => Boolean(config?.authenticated && address() && config?.draftsEnabled !== false);
  const network = () => config?.network || 'devnet';
  const symbol = () => config?.symbol || 'USDC';
  const explorer = signature => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(network())}`;
  const notify = () => {render();onChange?.();};

  async function api(path, {method='GET',body,headers={}}={}) {
    const response = await fetch(path,{method,credentials:'same-origin',headers:{Accept:'application/json',...(body !== undefined?{'Content-Type':'application/json'}:{}),...headers},...(body !== undefined?{body:JSON.stringify(body)}:{})});
    let data;try {data=await response.json();} catch {throw new Error('The workspace server is unavailable. Please retry.');}
    if(!response.ok) {const error=new Error(data?.error?.message || 'The request could not be completed.');error.code=data?.error?.code;error.status=response.status;throw error;}
    return data;
  }
  function dialogError(error) {
    const message = error?.message || 'Something went wrong. Please retry.';
    const slot=$('#live-error');
    if(slot){slot.textContent=message;slot.hidden=false;}else toast(message);
  }
  async function run(task,target) {
    if(busy)return;
    busy=true;
    if(target){target.disabled=true;target.setAttribute('aria-busy','true');}
    try {await task();}catch(error){dialogError(error);}finally{busy=false;if(target?.isConnected){target.disabled=false;target.removeAttribute('aria-busy');}renderHeader();}
  }
  async function loadWorkspace() {
    config=await api('/api/config');
    if(config.authenticated&&config.wallet){const [d,r]=await Promise.all([api('/api/deals'),api('/api/receipts')]);deals=d.deals||[];receipts=r.receipts||[];}else{deals=[];receipts=[];}
    loading=false;loadError='';notify();
  }
  async function init(){try{await loadWorkspace();}catch(error){loading=false;loadError=error.message;notify();}}
  function renderHeader(){
    const button=$('#wallet-button');
    if(button){button.textContent=address()?short(address()):'Connect wallet';button.title=address()||'Connect and verify your Solana wallet';button.disabled=busy||loading;}
    const badge=$('.network-badge');if(badge)badge.innerHTML=`<span></span> ${esc(network()==='devnet'?'Devnet':network())}`;
    document.querySelectorAll('.header-actions [data-action="new-deal"]').forEach(button=>{button.disabled=loading;});
  }
  function workspaceNotice(){
    if(loading)return `<div class="workspace-notice" role="status"><span class="receipt-icon">${icon('lock')}</span><div><strong>Opening your workspace.</strong><p>Loading authenticated deal records.</p></div></div>`;
    if(loadError)return `<div class="workspace-notice"><span class="receipt-icon">${icon('info')}</span><div><strong>Workspace unavailable.</strong><p>${esc(loadError)}</p></div><button class="text-button" data-action="refresh-workspace">Retry ${icon('reset')}</button></div>`;
    if(!config?.authenticated)return `<div class="workspace-notice"><span class="receipt-icon">${icon('lock')}</span><div><strong>Sign in to your workspace.</strong><p>Deals are available only to their authenticated participants.</p></div><button class="text-button" data-action="refresh-workspace">Refresh session ${icon('reset')}</button></div>`;
    if(!address())return `<div class="workspace-notice"><span class="receipt-icon">${icon('shield')}</span><div><strong>Your wallet is your signature.</strong><p>Connect a Solana wallet to create and agree deals.</p></div><button class="button dark" data-action="connect-wallet">Connect wallet ${icon('arrow-up-right')}</button></div>`;
    if(!config.paymentsEnabled)return `<div class="workspace-notice setup-notice"><span class="receipt-icon">${icon('info')}</span><div><strong>Payments awaiting setup.</strong><p>You can draft and agree terms while this workspace is configured.</p></div><button class="text-button" data-action="workspace-status">Setup status ${icon('arrow-up-right')}</button></div>`;
    return '';
  }
  function render(){
    renderHeader();
    const focused=document.activeElement?.closest('[data-action]');
    const focusAction=focused?.dataset.action,focusId=focused?.dataset.id,focusFilter=focused?.dataset.filter;
    const active=deals.filter(d=>d.status!=='paid').length,ready=deals.filter(d=>d.status==='ready').length;
    const visible=deals.filter(d=>filter==='all'||(filter==='active'?d.status!=='paid':d.status==='paid'));
    if(!visible.some(d=>d.id===selectedId))selectedId=visible[0]?.id;
    const deal=selected();
    $('#deals-page').innerHTML=`<div class="dashboard-intro"><div><p class="eyebrow">THE CREATOR DEAL DESK · ${esc(network().toUpperCase())}</p><h1 id="deals-title">Private <span class="serif">deals.</span></h1></div><div class="desk-meta"><span>YOUR WORKSPACE</span><p>${address()?esc(short(address())):'Your terms. Your business.'}</p></div></div>${workspaceNotice()}<div class="desk-summary"><div><span>On your desk</span><strong>${String(active).padStart(2,'0')}</strong><small>Active deals</small></div><div><span>Agreed value <button class="value-toggle" data-action="toggle-volume" aria-label="${showVolume?'Hide':'Show'} agreed deal value">${icon(showVolume?'eye-off':'lock')}</button></span><strong>${showVolume?money(deals.filter(d=>['ready','payment_pending','paid'].includes(d.status)).reduce((n,d)=>n+Number(d.amount),0)):'•••••'}</strong><small>${esc(symbol())} · ${esc(network())}</small></div><div><span>Next up</span><strong>${String(ready).padStart(2,'0')}</strong><small>Ready to pay</small></div></div><div class="deal-workspace"><section class="deal-list-panel" aria-label="Deals"><div class="deal-list-heading"><h2>On your desk.</h2><div class="deal-filters" role="group" aria-label="Filter deals">${[['all','All'],['active','Active'],['paid','Paid']].map(([key,label])=>`<button data-action="deal-filter" data-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</div></div><div class="deal-list">${visible.length?visible.map(d=>`<button class="deal-row" data-action="select-deal" data-id="${esc(d.id)}" aria-pressed="${d.id===selectedId}"><span class="deal-avatar">${d.role==='brand'?'CR':'BR'}</span><span class="deal-row-content"><strong>${esc(d.title)}</strong><span>${d.role==='brand'?'Creator':'Brand'} · ${esc(short(d.role==='brand'?d.creatorWallet:d.brandWallet))}</span></span><span class="deal-row-meta"><span class="status-tag ${stateClass(d.status)}">${esc(statusNames[d.status]||d.status)}</span><small>${day(d.deadline)}</small></span>${icon('arrow-up-right')}</button>`).join(''):'<div class="empty-state">No deals here yet.</div>'}</div><button class="new-deal-row" data-action="new-deal">${icon('plus')} Start a new deal</button><div class="list-bottom"><span>${String(deals.length).padStart(2,'0')} DEALS</span><button class="text-button" data-action="refresh-workspace">Refresh ${icon('reset')}</button></div></section>${deal?detail(deal):`<article class="deal-detail detail-empty"><span class="receipt-icon">${icon('receipt')}</span><h2>A clean slate.</h2><p>${address()?'Agree the work. Keep the terms in one place.':'Your real deals will appear here.'}</p><button class="button dark" data-action="${address()?'new-deal':'connect-wallet'}">${address()?'Create a deal':'Connect wallet'} ${icon('arrow-up-right')}</button></article>`}</div><div class="desk-bottom"><article class="rings-note"><span class="rings-note-icon">${icon('shield')}</span><div><h3>Private onchain.</h3><p>Rings hides transfer amounts. Wallet addresses stay public.</p><button class="text-button" data-action="methodology">Privacy details ${icon('arrow-up-right')}</button></div></article><a class="benchmark-link" href="#explore"><span class="eyebrow">BEFORE YOUR NEXT DEAL</span><h3>Get a second <span class="serif">opinion.</span></h3><span>Explore sample rates ${icon('arrow-up-right')}</span></a></div><p class="table-note">${esc(network())} · Test tokens only · Deal terms are shared with participants and this service</p>`;
    if(focusAction&&['select-deal','deal-filter','toggle-volume'].includes(focusAction))Array.from($('#deals-page').querySelectorAll(`[data-action="${focusAction}"]`)).find(el=>(!focusId||el.dataset.id===focusId)&&(!focusFilter||el.dataset.filter===focusFilter))?.focus({preventScroll:true});
  }
  function detail(d){
    const stage=d.status==='paid'?2:['ready','payment_pending'].includes(d.status)?1:0;
    const approval=(d.approvals||[]).some(a=>a.wallet===address());
    const label=d.status==='paid'?'View receipt':d.status==='payment_pending'?'Check settlement':stage===1?(d.role==='brand'?'Review payment':'View agreed terms'):approval?'Waiting for counterparty':'Review & accept';
    return `<article class="deal-detail"><button class="detail-mobile-back text-button" data-action="back-to-deals">← All deals</button><div class="detail-top"><span class="eyebrow">${esc(d.id.slice(0,12))} / PRIVATE TERMS</span><button class="icon-button" data-action="export-deal" aria-label="Export selected deal">${icon('download')}</button></div><div class="detail-brand"><span class="deal-avatar">${d.role==='brand'?'CR':'BR'}</span><span title="${esc(d.role==='brand'?d.creatorWallet:d.brandWallet)}">${esc(short(d.role==='brand'?d.creatorWallet:d.brandWallet))}</span></div><h2>${esc(d.title)}</h2><div class="detail-amount"><strong>${money(d.amount)}</strong><span>${esc(symbol())}</span>${icon('lock')}</div><dl class="detail-facts"><div><dt>Due date</dt><dd>${day(d.deadline)}</dd></div><div><dt>Deliverable</dt><dd>${esc(d.category)}</dd></div><div><dt>Usage</dt><dd>${esc(d.usage)}</dd></div><div><dt>Status</dt><dd>${esc(statusNames[d.status]||d.status)}</dd></div></dl><ol class="deal-timeline" aria-label="Deal progress">${['Draft','Agreed','Paid'].map((label,i)=>`<li class="${i<stage?'completed':i===stage?'current':''}"><span>${i<stage?icon('check'):i+1}</span><strong>${label}</strong></li>`).join('')}</ol><button class="button dark" data-action="review-deal">${label} ${icon('arrow-up-right')}</button><small class="detail-note">${stage===2?'Finalized payment verified by the server.':`${(d.approvals||[]).length} of 2 approvals · Version ${d.version}`}</small></article>`;
  }
  function statusDialog(){
    const missing=Array.isArray(config?.missingConfiguration)?config.missingConfiguration:[];
    openDialog('Workspace status.','DEVNET',`<div class="local-receipt"><div><span>Session</span><strong>${config?.authenticated?'Authenticated':'Sign-in required'}</strong></div><div><span>Linked wallet</span><strong>${esc(short(address()))}</strong></div><div><span>Payments</span><strong>${config?.paymentsEnabled?'Available':'Awaiting setup'}</strong></div></div>${missing.length?`<p>Server configuration needed: ${missing.map(esc).join(', ')}. A workspace administrator can finish this setup.</p>`:'<p>Devnet tokens are for testing. Both parties must accept terms before payment.</p>'}<p id="live-error" class="field-error" hidden></p><div class="dialog-actions"><button class="button outline" data-action="refresh-workspace">Refresh status ${icon('reset')}</button><button class="button dark" data-action="close">Done</button></div>`);
  }
  async function ensureWallet(){
    if(!ringsWallet){const {createRingsWallet,detectWalletProvider}=await import('./rings-client.mjs');const provider=detectWalletProvider();if(!provider)throw new Error('Open this workspace in a browser with a Solana Wallet Standard wallet. Rings payments require transaction version 1 support.');ringsWallet=createRingsWallet({provider,rpcProxy:'/api/rpc',network:network()});}
    if(!connectedAddress){const result=await ringsWallet.connect();connectedAddress=result.address;walletVersion1=result.version1Supported;}
    return ringsWallet;
  }
  async function connect(){
    if(!config){await loadWorkspace();}
    if(!config.authenticated){statusDialog();return;}
    if(address()&&connectedAddress===address()){walletDialog();return;}
    const wallet=await ensureWallet();
    const challenge=await api('/api/wallet/challenge',{method:'POST',body:{wallet:connectedAddress}});
    const signature=await wallet.signMessage(challenge.message);
    await api('/api/wallet/verify',{method:'POST',body:{challengeId:challenge.challengeId,signature}});
    await loadWorkspace();walletDialog();
  }
  function walletDialog(){
    const balance=balances?.privateBalances?.find(b=>b.mint===config?.mint)?.amountAtomic;
    const formatted=!unlocked?'Unlock to view':money(Number(balance||0)/10**(config?.decimals||6));
    openDialog('Your private wallet.','SOLANA DEVNET',`<div class="local-receipt"><div><span>Wallet</span><strong class="wallet-address">${esc(address()||connectedAddress||'Not connected')}</strong></div><div><span>Rings account</span><strong>${unlocked?(registered?'Registered':pendingRegistration?'Registration pending':'Not registered'):'Locked'}</strong></div><div><span>Private ${esc(symbol())}</span><strong>${formatted}</strong></div></div><p>Private balances are decrypted on this device. Deposits are visible onchain.</p>${!unlocked?'<p>Unlocking asks you to sign a privacy-key derivation message. That signature stays in this browser. Keep it private.</p>':''}${walletVersion1===false?'<div class="disclosure-box"><p>This wallet can sign deal terms. Rings payments require a wallet supporting Solana version 1 transactions.</p></div>':''}${!config?.paymentsEnabled?'<div class="disclosure-box"><p>Payments and funding are awaiting server setup.</p></div>':unlocked&&registered&&walletVersion1!==false?`<form id="deposit-form"><div class="form-grid"><label class="full">Deposit test ${esc(symbol())}<input name="amount" type="number" min="0.000001" max="10000000" step="0.000001" inputmode="decimal" placeholder="10.00" required /></label></div><button class="button dark wallet-deposit" type="submit">Review deposit ${icon('arrow-right')}</button></form>`:''}<p id="live-error" class="field-error" hidden></p><div class="dialog-actions"><button class="button outline" data-action="disconnect-wallet">Disconnect</button>${!unlocked?'<button class="button dark" data-action="unlock-wallet" '+(!config?.paymentsEnabled?'disabled':'')+'>Unlock Rings</button>':!registered&&!pendingRegistration?'<button class="button dark" data-action="register-wallet" '+(walletVersion1===false?'disabled':'')+'>Create Rings account</button>':'<button class="button dark" data-action="refresh-balance">Refresh balance</button>'}</div>`);
    $('#deposit-form')?.addEventListener('submit',event=>{event.preventDefault();const amount=String(new FormData(event.target).get('amount'));reviewDeposit(amount);});
  }
  async function unlock(){const wallet=await ensureWallet();if(connectedAddress!==address())throw new Error('Connect the wallet linked to this workspace first.');const result=await wallet.unlock();unlocked=true;registered=Boolean(result.registered);if(registered)balances=await wallet.getBalances();walletDialog();}
  async function register(){if(!unlocked)await unlock();if(!unlocked)return;const result=await ringsWallet.register();pendingRegistration=result.status==='pending'?result.signature:null;try{balances=await ringsWallet.getBalances();registered=Boolean(balances.registered);if(registered)pendingRegistration=null;}catch{registered=false;}walletDialog();toast(registered?'Rings account registered on devnet.':'Registration submitted. Refresh after confirmation.');}
  function atomicAmount(value){const text=String(value).trim();const decimals=config?.decimals||6;if(!/^\d+(\.\d+)?$/.test(text))throw new Error('Enter a valid amount.');const [whole,fraction='']=text.split('.');if(fraction.length>decimals)throw new Error(`Use at most ${decimals} decimal places.`);const atomic=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));if(atomic<=0n)throw new Error('Enter an amount greater than zero.');return atomic.toString();}
  let depositDraft=null;
  function reviewDeposit(amount){try{depositDraft={mint:config.mint,amountAtomic:atomicAmount(amount)};openDialog('Move funds into Rings.','DEVNET DEPOSIT',`<div class="local-receipt"><div><span>Amount</span><strong>${esc(amount)} ${esc(symbol())}</strong></div><div><span>Network</span><strong>Solana devnet</strong></div></div><p>This deposit moves test tokens from your public wallet into your private Rings balance. Its amount and asset are public onchain. Your wallet may request account registration and network fees.</p><p id="live-error" class="field-error" hidden></p><div class="dialog-actions"><button class="button outline" data-action="wallet-details">Back</button><button class="button dark" data-action="confirm-deposit">Deposit test tokens ${icon('arrow-up-right')}</button></div>`);}catch(error){dialogError(error);}}
  async function deposit(){if(!depositDraft||!config?.paymentsEnabled)return;const result=await ringsWallet.deposit(depositDraft);depositDraft=null;try{balances=await ringsWallet.getBalances();}catch{balances=null;}walletDialog();toast(result.status==='confirmed'?'Deposit confirmed on devnet.':'Deposit submitted. Refresh after confirmation.');if(result.signature)$('#live-error')?.insertAdjacentHTML('beforebegin',`<p><a href="${explorer(result.signature)}" target="_blank" rel="noopener noreferrer">View deposit transaction ↗</a></p>`);}

  function newDeal(){
    if(!canDraft()){if(config?.authenticated&&!address())connectPrompt();else statusDialog();return;}
    const deadline=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    openDialog('Start with the terms.','NEW DEAL · DEVNET',`<form id="deal-form"><div class="form-grid"><label class="full">Project<input name="title" placeholder="e.g. The launch edit" maxlength="80" required /></label><label>Your role<select name="role"><option value="brand">Brand · paying</option><option value="creator">Creator · receiving</option></select></label><label>Amount · test ${esc(symbol())}<input name="amount" type="number" min="0.000001" max="10000000" step="0.000001" inputmode="decimal" placeholder="1,250" required /></label><label class="full">Counterparty wallet<input name="counterparty" class="wallet-address" placeholder="Solana wallet address" autocomplete="off" spellcheck="false" minlength="32" maxlength="44" pattern="[1-9A-HJ-NP-Za-km-z]{32,44}" required /></label><label>Deliverable<select name="category">${categories.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><label>Due date<input name="deadline" type="date" value="${deadline}" required /></label><label class="full">Usage<select name="usage"><option>Organic only</option><option>30-day paid usage</option><option>90-day paid usage</option></select></label><label class="full">Additional terms <span class="optional-label">Optional</span><textarea name="notes" rows="3" maxlength="2000" placeholder="Deliverables, timing, and any other agreed terms"></textarea></label></div><p class="form-note">Both wallets must sign the same terms before payment. Your draft is stored on the workspace server.</p><p id="live-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button outline" data-action="close">Cancel</button><button type="submit" class="button dark">Create draft ${icon('arrow-right')}</button></div></form>`);
    $('#deal-form').addEventListener('submit',event=>{
      event.preventDefault();const f=new FormData(event.target);const counterparty=String(f.get('counterparty')).trim();const role=f.get('role');const amount=String(f.get('amount'));
      run(async()=>{atomicAmount(amount);if(counterparty===address())throw new Error('Choose a different wallet for the counterparty.');const {deal}=await api('/api/deals',{method:'POST',body:{title:String(f.get('title')).trim(),brandWallet:role==='brand'?address():counterparty,creatorWallet:role==='creator'?address():counterparty,amount,category:f.get('category'),usage:f.get('usage'),deadline:f.get('deadline'),notes:String(f.get('notes')||'').trim()}});selectedId=deal.id;filter='all';await loadWorkspace();closeDialog();location.hash='deals';toast('Draft saved. Both parties can now review it.');},event.submitter);
    });
  }
  function connectPrompt(){openDialog('Sign in with your wallet.','YOUR WORKSPACE',`<p>Connect your Solana wallet and sign a one-time message to link it to this authenticated workspace. This does not authorize a payment.</p><p id="live-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" data-action="close">Back</button><button class="button dark" data-action="connect-wallet">Connect wallet ${icon('arrow-up-right')}</button></div>`);}
  function termsMarkup(d){return `<div class="local-receipt"><div><span>Project</span><strong>${esc(d.title)}</strong></div><div><span>Brand · payer</span><strong class="wallet-address">${esc(d.brandWallet)}</strong></div><div><span>Creator · recipient</span><strong class="wallet-address">${esc(d.creatorWallet)}</strong></div><div><span>Amount</span><strong>${money(d.amount)} test ${esc(symbol())}</strong></div><div><span>Deliverable</span><strong>${esc(d.category)}</strong></div><div><span>Due date</span><strong>${day(d.deadline)}</strong></div><div><span>Usage</span><strong>${esc(d.usage)}</strong></div>${d.notes?`<div><span>Additional terms</span><strong class="terms-notes">${esc(d.notes)}</strong></div>`:''}</div>`;}
  async function review(){
    let d=selected();if(!d)return;
    const response=await api(`/api/deals/${encodeURIComponent(d.id)}`);d=response.deal;deals=deals.map(item=>item.id===d.id?d:item);notify();
    if(d.status==='paid'){const receipt=receipts.find(r=>r.dealId===d.id);if(receipt)showReceipt(receipt);else{await loadWorkspace();const updated=receipts.find(r=>r.dealId===d.id);if(updated)showReceipt(updated);else throw new Error('The settlement record is still loading. Refresh in a moment.');}return;}
    if(d.status==='payment_pending'||d.paymentIntent?.txSignature){await checkSettlement(d.paymentIntentId||d.paymentIntent?.id);return;}
    if(d.status==='ready'){
      const payer=d.role==='brand';
      openDialog(payer?'A private payment.':'The terms are agreed.','AGREED · DEVNET',`${termsMarkup(d)}<div class="disclosure-box private"><h3>${icon('lock')} Confidential onchain</h3><p>Wallet addresses remain public. Verification shares a transaction-scoped viewing key with this service, including any other outputs in that transaction.</p></div>${!config.paymentsEnabled?'<p class="form-note">Payments are disabled until the workspace administrator completes server setup.</p>':!payer?'<p class="form-note">The linked brand wallet can make this payment. Your receipt will appear after verification.</p>':'<p class="form-note">This sends test USDC through Rings on Solana devnet. Check the recipient and amount before continuing.</p>'}<p id="live-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" data-action="close">Back</button>${payer?`<button class="button dark" data-action="pay-deal" ${!config.paymentsEnabled?'disabled':''}>Pay with Rings ${icon('arrow-up-right')}</button>`:'<button class="button dark" data-action="refresh-workspace">Refresh status</button>'}</div>`);
      return;
    }
    const approved=(d.approvals||[]).some(a=>a.wallet===address());
    openDialog('Review the deal.','TERMS · VERSION '+esc(d.version),`${termsMarkup(d)}<p>${approved?'You have accepted these terms. The counterparty must accept the same version before payment.':'Accepting asks your wallet to sign these exact terms. The server records each party’s signature separately.'}</p><div class="approval-state">${[d.brandWallet,d.creatorWallet].map((wallet,i)=>`<span>${icon((d.approvals||[]).some(a=>a.wallet===wallet)?'check':'lock')} ${i===0?'Brand':'Creator'} · ${(d.approvals||[]).some(a=>a.wallet===wallet)?'Accepted':'Pending'}</span>`).join('')}</div><p id="live-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" data-action="close">Back</button><button class="button dark" data-action="${approved?'refresh-workspace':'approve-deal'}">${approved?'Refresh status':'Accept & sign'} ${icon(approved?'reset':'check')}</button></div>`);
  }
  async function approve(){
    const d=selected();if(!d)return;const wallet=await ensureWallet();if(connectedAddress!==address())throw new Error('Connect the wallet linked to this workspace before signing.');
    const challenge=await api(`/api/deals/${encodeURIComponent(d.id)}/approval-challenge`,{method:'POST',body:{}});
    const signature=await wallet.signMessage(challenge.message);
    await api(`/api/deals/${encodeURIComponent(d.id)}/approve`,{method:'POST',body:{challengeId:challenge.challengeId,signature}});
    await loadWorkspace();await review();toast('Your acceptance is recorded.');
  }
  function paymentProgress(intent,message){
    openDialog('Confirming settlement.','SOLANA DEVNET',`<div class="success-mark">${icon('shield')}</div><p>${esc(message)}</p><div class="local-receipt"><div><span>Amount</span><strong>${money(intent.amount)} test ${esc(symbol())}</strong></div><div><span>Status</span><strong>${esc(intent.status==='verified'?'Verified':intent.status==='failed'?'Needs review':'Verification pending')}</strong></div></div>${intent.txSignature?`<p><a href="${explorer(intent.txSignature)}" target="_blank" rel="noopener noreferrer">View finalized transaction status ↗</a></p>`:''}<p id="live-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" data-action="close">Close</button><button class="button dark" data-action="check-settlement" data-intent="${esc(intent.id)}">Check settlement ${icon('reset')}</button></div>`);
  }
  async function pay(){
    const d=selected();if(!d||d.role!=='brand'||d.status!=='ready')throw new Error('Only the agreed payer can send this payment.');
    if(!config.paymentsEnabled)throw new Error('Payments are awaiting server setup.');
    const wallet=await ensureWallet();if(walletVersion1===false)throw new Error('This wallet cannot sign Solana version 1 transactions. Connect a compatible wallet to pay with Rings.');if(connectedAddress!==d.brandWallet)throw new Error('Connect the brand wallet shown in these terms.');if(!unlocked||!registered){walletDialog();return;}
    if(!keys.has(d.id))keys.set(d.id,crypto.randomUUID());
    const {intent}=await api(`/api/deals/${encodeURIComponent(d.id)}/payment-intents`,{method:'POST',body:{},headers:{'Idempotency-Key':keys.get(d.id)}});
    if(intent.txSignature||intent.status==='verified'){await checkSettlement(intent.id);return;}
    if(attempts.has(intent.id)){await submitAttempt(intent,attempts.get(intent.id));return;}
    let attemptStarted=false;
    try{
      balances=await wallet.getBalances();
      const available=balances.privateBalances.find(b=>b.mint===intent.mint)?.amountAtomic||'0';
      if(BigInt(available)<BigInt(intent.amountAtomic))throw new Error('Your private balance is too low. Deposit test USDC from Wallet first.');
      const slot=$('#live-error');if(slot){slot.hidden=false;slot.textContent='Confirm the devnet payment in your wallet. Keep this window open until verification completes.';}
      attemptStarted=true;
      let durableSubmission=null;
      await wallet.payIntent(intent,{beforeBroadcast:async prepared=>{
        // The server must retain this exact signed transaction and its disclosure
        // before either side broadcasts it. A reload can then relay only these bytes.
        attempts.set(intent.id,prepared);
        durableSubmission=await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/submit`,{method:'POST',body:submissionBody(prepared)});
      }});
      attempts.delete(intent.id);
      if(durableSubmission?.receipt){await loadWorkspace();showReceipt(durableSubmission.receipt);toast('Finalized payment verified.');}
      else{paymentProgress(durableSubmission?.intent||intent,'Your signed transfer is saved. The server is checking finality and the agreed payment.');await loadWorkspace();await checkSettlement(intent.id);}
    }catch(error){
      if(attempts.has(intent.id))throw new Error('Submission could not finish. Review this deal again to check its saved transaction. Retrying uses the same signed bytes; it does not create another payment.');
      if(attemptStarted)throw new Error(`${error.message} No new payment is sent automatically. Reopen the deal to check settlement before retrying.`);
      throw error;
    }
  }
  function submissionBody(result){return {txSignature:result.txSignature,eventIndex:result.eventIndex,outputIndex:result.outputIndex,transactionViewingKey:result.transactionViewingKey,signedTransaction:result.signedTransaction};}
  async function submitAttempt(intent,result){
    const submitted=await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/submit`,{method:'POST',body:submissionBody(result)});
    attempts.delete(intent.id);
    if(submitted.receipt){await loadWorkspace();showReceipt(submitted.receipt);toast('Finalized payment verified.');return;}
    paymentProgress(submitted.intent,'Your transfer was submitted. The server is checking finality and the agreed payment.');
    await loadWorkspace();
    await checkSettlement(intent.id);
  }
  async function checkSettlement(id){
    if(!id){const d=selected();id=d?.paymentIntentId||d?.paymentIntent?.id;}
    if(!id)throw new Error('No submitted payment was found for this deal.');
    const result=await api(`/api/payment-intents/${encodeURIComponent(id)}`);
    await loadWorkspace();
    if(result.receipt){showReceipt(result.receipt);return;}
    paymentProgress(result.intent,result.intent.reason||'Settlement is not verified yet. Check again after the transaction finalizes. A new payment will not be sent.');
  }
  function showReceipt(receipt){
    const deal=deals.find(d=>d.id===receipt.dealId);
    openDialog('The work, on record.','VERIFIED PAYMENT · '+esc((receipt.network||network()).toUpperCase()),`<div class="success-mark">${icon('check')}</div><div class="local-receipt"><div><span>Project</span><strong>${esc(deal?.title||receipt.dealId)}</strong></div><div><span>Amount</span><strong>${money(receipt.amount)} ${esc(symbol())}</strong></div><div><span>Payer</span><strong class="wallet-address">${esc(receipt.payerWallet)}</strong></div><div><span>Recipient</span><strong class="wallet-address">${esc(receipt.recipientWallet)}</strong></div><div><span>Verified</span><strong>${day(receipt.verifiedAt)}</strong></div><div><span>Transaction</span><strong><a href="${explorer(receipt.txSignature)}" target="_blank" rel="noopener noreferrer">${esc(short(receipt.txSignature))} ↗</a></strong></div></div><p>The server verified this finalized payment against the agreed terms. This records payment, not delivery of the work.</p><div class="dialog-actions"><button class="button outline" data-action="export-receipt" data-id="${esc(receipt.id)}">Export receipt ${icon('download')}</button><button class="button dark" data-action="studio">View receipts ${icon('arrow-right')}</button></div>`);
  }
  function receiptsMarkup(){
    if(!config?.authenticated||!address())return `<div class="studio-empty"><span>${icon('lock')}</span><h3>Your records stay with you.</h3><p>Connect your verified wallet to load your payment receipts.</p><button class="button dark" data-action="connect-wallet">Connect wallet ${icon('arrow-up-right')}</button></div>`;
    if(!receipts.length)return `<div class="studio-empty"><span>${icon('receipt')}</span><h3>A clean slate.</h3><p>Finalized, server-verified payments appear here.</p><button class="button dark" data-action="go-deals">Open deal desk ${icon('arrow-up-right')}</button></div>`;
    return receipts.map(receipt=>{const deal=deals.find(d=>d.id===receipt.dealId);return `<div class="studio-item"><span class="receipt-icon">${icon('check')}</span><div><strong>${esc(deal?.title||receipt.dealId)} · ${money(receipt.amount)} ${esc(symbol())}</strong><small>Verified ${esc(receipt.network)} payment · ${day(receipt.verifiedAt)}</small></div><button class="icon-button" data-action="view-receipt" data-id="${esc(receipt.id)}" aria-label="View verified receipt">${icon('arrow-up-right')}</button></div>`;}).join('');
  }
  function download(value,name){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
  const actions=new Set(['connect-wallet','wallet-details','disconnect-wallet','unlock-wallet','register-wallet','refresh-balance','confirm-deposit','workspace-status','refresh-workspace','select-deal','back-to-deals','deal-filter','toggle-volume','new-deal','review-deal','approve-deal','pay-deal','check-settlement','view-receipt','export-deal','export-receipt']);
  function handle(action,target){
    if(!actions.has(action))return false;
    if(action==='select-deal'){selectedId=target.dataset.id;render();if(matchMedia('(max-width:760px)').matches){$('.deal-detail').scrollIntoView({block:'start'});const title=$('.deal-detail h2');title.tabIndex=-1;title.focus({preventScroll:true});}}
    else if(action==='back-to-deals'){$('.deal-list-panel').scrollIntoView({block:'start'});$('.deal-row[aria-pressed="true"]')?.focus({preventScroll:true});}
    else if(action==='deal-filter'){filter=target.dataset.filter;render();}
    else if(action==='toggle-volume'){showVolume=!showVolume;render();}
    else if(action==='new-deal')newDeal();
    else if(action==='workspace-status')statusDialog();
    else if(action==='wallet-details')walletDialog();
    else if(action==='view-receipt'){const receipt=receipts.find(r=>r.id===target.dataset.id);if(receipt)showReceipt(receipt);}
    else if(action==='export-deal'){const d=selected();if(d){download(d,`${d.id}-deal.json`);toast('Deal record exported.');}}
    else if(action==='export-receipt'){const receipt=receipts.find(r=>r.id===target.dataset.id);if(receipt)download(receipt,`${receipt.id}-receipt.json`);}
    else run(async()=>{
      if(action==='connect-wallet')await connect();
      else if(action==='disconnect-wallet'){await ringsWallet?.disconnect();ringsWallet=null;connectedAddress=null;unlocked=false;registered=false;balances=null;walletVersion1=null;pendingRegistration=null;closeDialog();toast('Wallet disconnected from this browser. Your account link remains.');}
      else if(action==='unlock-wallet')await unlock();
      else if(action==='register-wallet')await register();
      else if(action==='refresh-balance'){balances=await ringsWallet.getBalances();registered=Boolean(balances.registered);if(registered)pendingRegistration=null;walletDialog();}
      else if(action==='confirm-deposit')await deposit();
      else if(action==='refresh-workspace'){await loadWorkspace();if($('#app-dialog').open)closeDialog();toast('Workspace refreshed.');}
      else if(action==='review-deal')await review();
      else if(action==='approve-deal')await approve();
      else if(action==='pay-deal')await pay();
      else if(action==='check-settlement')await checkSettlement(target.dataset.intent);
    },target);
    return true;
  }
  return {init,render,handle,receiptsMarkup,get receiptCount(){return receipts.length;}};
}
