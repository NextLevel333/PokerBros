// client.js — Phantom connect + Disconnect + Countdown + Gameplay UI

const socket = io({ transports: ['websocket'] });

let mySeat = null;
let currentBet = 0;
let isMyTurn = false;
let betMode = null;
let myPubkey = null;

const statusEl = document.getElementById('walletStatus');
const connectBtn = document.getElementById('connectWallet');
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownText = document.getElementById('countdownText');

// === Utility for short numbers ===
function formatShort(num){
  if (num >= 1_000_000) return (num/1_000_000).toFixed(2).replace(/\.00$/,'')+'m';
  if (num >= 1_000) return (num/1_000).toFixed(2).replace(/\.00$/,'')+'k';
  return String(num);
}

// === Connect / Disconnect Wallet ===
connectBtn.addEventListener('click', async () => {
  if (myPubkey) {
    // Disconnect
    socket.emit('leaveTable');
    mySeat = null;
    myPubkey = null;
    statusEl.innerText = 'Not connected';
    connectBtn.innerText = 'Connect Wallet';
    return;
  }

  // Connect
  if (window.solana && window.solana.isPhantom) {
    try {
      const resp = await window.solana.connect({ onlyIfTrusted: false });
      myPubkey = resp.publicKey.toString();
      const short = myPubkey.slice(0,4)+'...'+myPubkey.slice(-4);
      statusEl.innerText = 'Connected: ' + short;
      connectBtn.innerText = 'Disconnect';
      socket.emit('walletConnected', { pubkey: myPubkey });
    } catch (e) {
      statusEl.innerText = 'Wallet connection cancelled';
    }
  } else {
    alert('Phantom wallet not found. Please install Phantom.');
  }
});

// === Player seats ===
socket.on('seatAssigned', data => {
  mySeat = data.seat;
  const seatEl = document.getElementById('player'+mySeat);
  seatEl && seatEl.classList.add('me');
});

socket.on('playersUpdate', players => {
  players.forEach((p, idx) => {
    const nameEl = document.querySelector('#player'+idx+' .player-name');
    const chipsEl = document.getElementById('chips'+idx);
    if (!nameEl || !chipsEl) return;
    if (!p) { 
      nameEl.innerText='(…----)'; 
      chipsEl.innerText='0'; 
      return; 
    }
    nameEl.innerText = p.shortKey || '(…----)';
    chipsEl.innerText = formatShort(p.chips || 0);
  });
});

// === Wallet verify/reject ===
socket.on('walletVerified', ({ pubkey, balance }) => {
  if (myPubkey && pubkey === myPubkey){
    const short = pubkey.slice(0,4)+'...'+pubkey.slice(-4);
    statusEl.innerText = `Connected: ${short} | Balance: ${formatShort(balance)}`;
    if (balance >= 100){
      connectBtn.innerText = 'Disconnect';
    } else {
      connectBtn.innerText = 'Connect Wallet';
    }
  }
});
socket.on('walletRejected', ({ reason }) => {
  statusEl.innerText = `Wallet rejected: ${reason}`;
  connectBtn.innerText = 'Connect Wallet';
});

// === Game events ===
socket.on('dealPrivate', hand => { if (mySeat!==null) renderPlayerCards(mySeat, hand); });
socket.on('dealHidden', ({ playerId }) => { if (playerId !== mySeat) renderHiddenCards(playerId); });
socket.on('reveal', ({ playerId, hand }) => renderPlayerCards(playerId, hand));
socket.on('dealCommunity', cards => renderCommunity(cards));
socket.on('updatePot', p => { document.getElementById('pot').innerText = 'Pot: ' + formatShort(p); });
socket.on('bettingRound', data => { currentBet = data.currentBet; updateControls(); });
socket.on('gameStarted', () => { 
  document.getElementById('startBtn').classList.add('hidden'); 
  countdownOverlay.classList.add('hidden'); 
});
socket.on('gameWaiting', () => { document.getElementById('startBtn').classList.remove('hidden'); });
socket.on('message', msg => { /* optional log */ });

// === Dealer / Turn ===
socket.on('dealer', ({ dealer, small, big }) => {
  clearDealerHighlights();
  badge(dealer, 'D'); badge(small, 'SB'); badge(big, 'BB');
});
socket.on('turn', ({ playerId, ms }) => {
  isMyTurn = (playerId === mySeat);
  indicateTurn(playerId);
  startProgressBar(playerId, ms || 0);
  updateControls();
});
socket.on('turnTimer', ({ ms }) => { if (ms<=0) stopProgressBar(); });

socket.on('actionBroadcast', ({ type, seat, amount }) => {
  if (amount && amount>0) animateChipToPot(seat);
});

// === Countdown Overlay ===
socket.on('countdownStart', ({ seconds }) => {
  countdownOverlay.classList.remove('hidden');
  countdownText.innerText = "Match starts in " + seconds;
});
socket.on('countdownTick', ({ seconds }) => {
  if (seconds > 0){
    countdownText.innerText = "Match starts in " + seconds;
  } else {
    countdownOverlay.classList.add('hidden');
  }
});

// === Buttons ===
document.getElementById('startBtn').addEventListener('click', ()=> socket.emit('startGame'));
document.getElementById('checkBtn').addEventListener('click', ()=> socket.emit('action', { type:'check' }));
document.getElementById('callBtn').addEventListener('click', ()=> socket.emit('action', { type:'call' }));
document.getElementById('foldBtn').addEventListener('click', ()=> socket.emit('action', { type:'fold' }));

const betControls = document.getElementById('betControls');
const betSlider = document.getElementById('betSlider');
const betAmount = document.getElementById('betAmount');
const confirmBet = document.getElementById('confirmBet');
const cancelBet = document.getElementById('cancelBet');

document.getElementById('betBtn').addEventListener('click', () => {
  betMode='bet'; betSlider.min=10; betSlider.value=10; betAmount.innerText=formatShort(10); betControls.classList.remove('hidden');
});
document.getElementById('raiseBtn').addEventListener('click', () => {
  betMode='raise'; const minR=Math.max(currentBet+10,10); betSlider.min=minR; betSlider.value=minR; betAmount.innerText=formatShort(minR); betControls.classList.remove('hidden');
});
betSlider.addEventListener('input', ()=> betAmount.innerText = formatShort(parseInt(betSlider.value,10)));
confirmBet.addEventListener('click', ()=>{
  const amount=parseInt(betSlider.value,10);
  if (betMode==='bet') socket.emit('action', { type:'bet', amount });
  else if (betMode==='raise') socket.emit('action', { type:'raise', amount });
  betControls.classList.add('hidden');
});
cancelBet.addEventListener('click', ()=> betControls.classList.add('hidden'));

// === Controls ===
function hideAll(){ ['checkBtn','betBtn','callBtn','raiseBtn','foldBtn'].forEach(id=>document.getElementById(id).classList.add('hidden')); }
function show(...ids){ ids.forEach(id=>document.getElementById(id).classList.remove('hidden')); }
function updateControls(){
  hideAll(); if(!isMyTurn) return;
  if(currentBet===0) show('checkBtn','betBtn','foldBtn'); else show('callBtn','raiseBtn','foldBtn');
}

// === Cards (SVG) ===
function createCardSVG(card){
  // detect if rank has two chars (10)
  const suit = card.slice(-1);
  const rank = card.slice(0, card.length - 1);
  const color=(suit==='♥'||suit==='♦')?'#d22':'#111';
  const div=document.createElement('div');
  div.innerHTML=`<svg class="card" viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" rx="16" ry="16" fill="white" stroke="#222" stroke-width="6"/>
    <text x="20" y="52" font-size="46" fill="${color}" font-weight="700">${rank}</text>
    <text x="20" y="110" font-size="46" fill="${color}">${suit}</text>
    <text x="180" y="260" font-size="46" fill="${color}" font-weight="700" text-anchor="end" transform="rotate(180 180 260)">${rank}</text>
    <text x="180" y="200" font-size="46" fill="${color}" text-anchor="end" transform="rotate(180 180 200)">${suit}</text>
  </svg>`;
  return div.firstChild;
}
function createCardBackSVG(){
  const d=document.createElement('div');
  d.innerHTML=`
    <svg class="card back" viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="solanaGradient" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#9945FF"/>
          <stop offset="50%" stop-color="#19FB9B"/>
          <stop offset="100%" stop-color="#00FFD1"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" rx="16" ry="16" fill="url(#solanaGradient)" />
      <rect x="12" y="12" width="176" height="276" rx="14" ry="14" stroke="#0b0b0b" stroke-width="6" fill="none" opacity="0.4"/>
    </svg>
  `;
  return d.firstChild;
}

function renderPlayerCards(playerId,cards){ const c=document.getElementById('cards'+playerId); if(!c) return; c.innerHTML=''; cards.forEach(card=>{ const el=createCardSVG(card); el.classList.add('deal-anim'); c.appendChild(el); }); }
function renderHiddenCards(playerId){ const c=document.getElementById('cards'+playerId); if(!c) return; c.innerHTML=''; c.appendChild(createCardBackSVG()); c.appendChild(createCardBackSVG()); }
function renderCommunity(cards){ const c=document.getElementById('community'); c.innerHTML=''; cards.forEach(card=>{ const el=createCardSVG(card); el.classList.add('deal-anim'); c.appendChild(el); }); }

// === Dealer / Turn UI ===
function clearDealerHighlights(){
  for(let i=0;i<6;i++){
    const el=document.getElementById('player'+i);
    if(el){ el.classList.remove('toAct'); const old=el.querySelector('.dealer-badge'); if(old) old.remove(); stopBar(i); }
  }
}
function badge(idx,text){ const el=document.getElementById('player'+idx); if(!el) return; const b=document.createElement('div'); b.className='dealer-badge'; b.innerText=text; el.appendChild(b); }
function indicateTurn(idx){
  for(let i=0;i<6;i++){ const el=document.getElementById('player'+i); if(el) el.classList.remove('toAct'); }
  const el=document.getElementById('player'+idx); if(el) el.classList.add('toAct');
}

// === Progress bar countdown ===
let barRAF = null;
let barEnd = 0;
let barSeat = null;

function ensureBar(seatIdx){
  const seat = document.getElementById('player'+seatIdx);
  if(!seat) return null;
  let wrap = seat.querySelector('.timerbar');
  if(!wrap){
    wrap = document.createElement('div');
    wrap.className = 'timerbar';
    wrap.innerHTML = `<div class="fill"></div>`;
    seat.appendChild(wrap);
  }
  return wrap.querySelector('.fill');
}
function startProgressBar(seatIdx, ms){
  stopProgressBar();
  const fill = ensureBar(seatIdx);
  if(!fill) return;
  barSeat = seatIdx;
  barEnd = Date.now() + (ms||0);
  function step(){
    const left = Math.max(0, barEnd - Date.now());
    const pct = ms ? (1 - left/(ms)) : 0;
    fill.style.width = Math.min(100, Math.max(0, pct*100)) + '%';
    if (left <= 0){ stopProgressBar(); return; }
    barRAF = requestAnimationFrame(step);
  }
  step();
}
function stopProgressBar(){
  if (barRAF) cancelAnimationFrame(barRAF);
  barRAF = null; barEnd = 0;
  if (barSeat !== null) stopBar(barSeat);
  barSeat = null;
}
function stopBar(seatIdx){
  const seat = document.getElementById('player'+seatIdx);
  if(!seat) return;
  const wrap = seat.querySelector('.timerbar');
  if (wrap) { wrap.remove(); }
}

// === Chip animation ===
function animateChipToPot(fromSeatIdx){
  const seatEl=document.getElementById('player'+fromSeatIdx);
  const potEl=document.getElementById('pot');
  if(!seatEl||!potEl) return;
  const chip=document.createElement('div');
  chip.style.position='fixed'; chip.style.width='28px'; chip.style.height='28px';
  chip.style.borderRadius='50%'; chip.style.background='radial-gradient(circle at 30% 20%, #ffea99, #d6a800)';
  chip.style.boxShadow='0 4px 10px rgba(0,0,0,.5)'; chip.style.zIndex='1000';
  document.body.appendChild(chip);
  const s=seatEl.getBoundingClientRect(); const p=potEl.getBoundingClientRect();
  chip.style.left=(s.left+s.width/2-14)+'px'; chip.style.top=(s.top+s.height/2-14)+'px';
  chip.style.transition='left 600ms cubic-bezier(.2,.8,.2,1), top 600ms cubic-bezier(.2,.8,.2,1), transform 600ms';
  requestAnimationFrame(()=>{
    chip.style.left=(p.left+p.width/2-14)+'px'; chip.style.top=(p.top+p.height/2-14)+'px'; chip.style.transform='scale(.6)';
  });
  setTimeout(()=> chip.remove(), 800);
}
