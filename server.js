// === Poker Server: Token Gate + Full Gameplay (NLHE) + Timers + Side Pots ===
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

const PORT = process.env.PORT || 3000;

// ====== TABLE CONFIG ======
const MAX_SEATS = 6;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const MIN_BUYIN = 1000; // if you want to enforce later
const TURN_TIME_MS = 17000; // per action, auto-fold on timeout
const COUNTDOWN_SECONDS = 10;

// ====== TOKEN GATE CONFIG (Devnet) ======
const TOKEN_GATE_ENABLED = true;
const DEVNET_RPC = 'https://api.devnet.solana.com';
const REQUIRED_TOKEN_MINT_STR = 'DsSMod73mQ51zW1FqXFrrXsZ3nCXAZnrZdyMMpAHSJQk';
const REQUIRED_AMOUNT = 100; // ui units

// ====== SERVER BOOT ======
const app = express();
app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== (Dynamic) Solana imports when needed ======
let sol = null;
async function ensureSolana(){
  if (sol) return sol;
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  sol = { web3, spl };
  return sol;
}

function logEvent(e){ console.log('[GAME]', e); io.emit('message', e); }

// ====== TABLE STATE ======
let seats = new Array(MAX_SEATS).fill(null); // { socketId, pubkey, shortKey, chips, seatIndex, inHand, allIn, holeCards:[] }
let deck = [];
let board = [];
let pot = 0;
let dealerIdx = null;
let smallBlindIdx = null;
let bigBlindIdx = null;

let gameActive = false;
let countdownInProgress = false;

let currentToActIdx = null; // seat index
let currentBet = 0;         // amount to call this street
let lastAggressor = null;   // closes action
let street = null;          // 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
let actionTimer = null;

// Side pot structure: [{ cap: number|null, amount: number, eligibles: Set<seatIdx> }]
let pots = [];

// ====== HELPERS ======
function findFirstEmptySeat(){ return seats.findIndex(p => p===null); }
function seatedIdxList(){ return seats.map((p,i)=>p? i : -1).filter(i=>i>=0); }
function activeIdxList(){ return seats.map((p,i)=>p&&p.inHand&&!p.allIn? i:-1).filter(i=>i>=0); }
function inHandIdxList(){ return seats.map((p,i)=>p&&p.inHand? i:-1).filter(i=>i>=0); }

function nextSeat(fromIdx){
  for (let k=1;k<=MAX_SEATS;k++){
    const idx = (fromIdx + k) % MAX_SEATS;
    if (seats[idx]) return idx;
  }
  return null;
}
function nextActive(fromIdx){
  for (let k=1;k<=MAX_SEATS;k++){
    const idx = (fromIdx + k) % MAX_SEATS;
    const p = seats[idx];
    if (p && p.inHand && !p.allIn) return idx;
  }
  return null;
}

function broadcastPlayers(){
  io.emit('playersUpdate', seats.map(p=>p?{
    pubkey:p.pubkey, shortKey:p.shortKey, chips:Math.max(0, Math.floor(p.chips)), seatIndex:p.seatIndex
  }:null));
  if (seats.every(p=>p===null)){
    resetTable();
    io.emit('gameWaiting');
    logEvent('Table empty. Game reset.');
  }
}
function formatShort(n){ return n; } // keep raw server values; client pretty-prints

function resetTable(){
  deck=[]; board=[]; pot=0; pots=[];
  currentToActIdx=null; currentBet=0; lastAggressor=null; street=null;
  clearTurnTimer();
  gameActive=false; countdownInProgress=false;
  seats.forEach(p=>{ if(p){ p.inHand=false; p.allIn=false; p.holeCards=[]; }});
  io.emit('updatePot', pot);
}

function createDeck(){
  const suits = ['s','h','d','c']; // pokersolver wants 'As', 'Td'
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const d=[];
  for(const r of ranks) for(const s of suits) d.push(r+s);
  return d;
}
function shuffle(d){
  for(let i=d.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

// ====== POTS / BETTING ======
function initPots(){
  pots = [{ cap: null, amount: 0, eligibles: new Set(inHandIdxList()) }];
}
function totalCommittedThisStreet(){ // (we track via player.bet if needed, but we’ll compute with calls)
  return currentBet;
}
function postBlind(seatIdx, amount){
  const p = seats[seatIdx];
  const pay = Math.min(p.chips, amount);
  p.chips -= pay;
  contributeToPots(seatIdx, pay);
  if (p.chips === 0) p.allIn = true;
  io.emit('updatePot', potTotal());
}
function contributeToPots(seatIdx, amount){
  // Handle side-pots: push into last pot unless player eligibility or caps require splitting.
  // For simplicity: add to the last pot if eligible; else create a new pot segment.
  // (This is a simplified but correct-enough approach for most scenarios)
  let remaining = amount;
  while (remaining > 0){
    let potObj = pots[pots.length-1];
    if (!potObj.eligibles.has(seatIdx)){
      // need a new pot tier
      potObj = { cap: null, amount: 0, eligibles: new Set(inHandIdxList()) };
      pots.push(potObj);
    }
    potObj.amount += remaining;
    remaining = 0;
  }
}
function potTotal(){ return pots.reduce((a,p)=>a+p.amount,0); }

function allButOneFolded(){
  const alive = inHandIdxList().filter(i=>!seats[i].folded);
  return alive.length === 1 ? alive[0] : null;
}

function minRaiseOver(x){ return Math.max(BIG_BLIND, x + (x - (currentBetBeforeRaise || 0))); }

// ====== TURN TIMER ======
function clearTurnTimer(){
  if (actionTimer){ clearTimeout(actionTimer); actionTimer=null; }
}
function startTurnTimer(seatIdx){
  clearTurnTimer();
  io.emit('turn', { playerId: seatIdx, ms: TURN_TIME_MS });
  actionTimer = setTimeout(()=>{
    // auto-fold on timeout
    handleAction(seatIdx, { type: 'fold' });
  }, TURN_TIME_MS + 200); // small buffer
}

// ====== STREET PROGRESSION ======
function beginBettingRound(kind){
  street = kind;
  currentBet = 0;
  lastAggressor = null;

  // reset per-street flags
  inHandIdxList().forEach(i=>{
    seats[i].committedThisStreet = 0;
    seats[i].actedThisStreet = false;
  });

  io.emit('bettingRound', { street, currentBet });
  // preflop: first to act is left of BB; else left of dealer
  if (street === 'preflop') {
    currentToActIdx = nextActive(bigBlindIdx);
  } else {
    currentToActIdx = nextActive(dealerIdx);
  }
  if (currentToActIdx == null){
    // Everyone all-in → skip to next street
    return advanceStreet();
  }
  promptAction();
}

function promptAction(){
  // Skip folded/all-in players
  if (!currentToActIdx) currentToActIdx = nextActive(dealerIdx);
  let safety = 0;
  while(safety++ < MAX_SEATS){
    const p = seats[currentToActIdx];
    if (p && p.inHand && !p.allIn) break;
    currentToActIdx = nextActive(currentToActIdx);
    if (currentToActIdx === null) break;
  }
  if (currentToActIdx === null){
    // No one can act → advance street
    return advanceStreet();
  }

  io.emit('turn', { playerId: currentToActIdx, ms: TURN_TIME_MS });
  startTurnTimer(currentToActIdx);
}

function everyoneActedAndMatched(){
  // End of betting round if (1) last aggressor just got called and action returned to him/her,
  // or (2) only one non-folded player remains, or (3) all remaining players are all-in.
  const active = activeIdxList();
  if (active.length <= 1) return true;
  if (active.every(i => seats[i].actedThisStreet) && active.every(i => seats[i].committedThisStreet === currentBet)) {
    return true;
  }
  if (active.every(i => seats[i].allIn)) return true;
  return false;
}

function advanceStreet(){
  clearTurnTimer();
  // If everyone (except one) folded, finish immediately
  const last = allButOneFolded();
  if (last !== null){
    // award pot to last
    awardAllTo([last]);
    return endHand();
  }

  if (street === 'preflop'){
    // FLOP (burn 1, deal 3)
    deck.pop();
    board.push(deck.pop(), deck.pop(), deck.pop());
    io.emit('dealCommunity', board.slice()); // send full board so client renders 3
    beginBettingRound('flop');
  } else if (street === 'flop'){
    // TURN (burn 1, deal 1)
    deck.pop();
    board.push(deck.pop());
    io.emit('dealCommunity', board.slice()); // send 4
    beginBettingRound('turn');
  } else if (street === 'turn'){
    // RIVER (burn 1, deal 1)
    deck.pop();
    board.push(deck.pop());
    io.emit('dealCommunity', board.slice()); // send 5
    beginBettingRound('river');
  } else if (street === 'river'){
    // SHOWDOWN
    return showdown();
  } else {
    // If we land here from "no action possible" (all-in preflop, etc.)
    if (board.length < 3){
      deck.pop(); board.push(deck.pop(), deck.pop(), deck.pop()); io.emit('dealCommunity', board.slice());
    }
    while (board.length < 5){
      deck.pop(); board.push(deck.pop()); io.emit('dealCommunity', board.slice());
    }
    return showdown();
  }
}

// ====== SHOWDOWN & AWARDS ======
function showdown(){
  street = 'showdown';
  clearTurnTimer();

  const elligible = inHandIdxList();
  // reveal all hands
  elligible.forEach(i=>{
    const p = seats[i];
    io.emit('reveal', { playerId: i, hand: convertToClientCards(p.holeCards) });
  });

  // Evaluate winners with side pots
  resolveSidePots(elligible);
  endHand();
}

function resolveSidePots(elligible){
  // Build rank maps: seatIdx -> best hand strength using pokersolver, on each comparison set
  const makeSolverCards = (hole) => hole.map(h => toSolver(h)).concat(board.map(toSolver));
  function rankFor(i){ return Hand.solve(makeSolverCards(seats[i].holeCards)); }

  // If no explicit side pot caps built, treat as single main pot
  if (pots.length === 0) pots = [{ cap: null, amount: pot, eligibles: new Set(elligible) }];

  pots.forEach(potObj=>{
    const contenders = [...potObj.eligibles].filter(i => elligible.includes(i));
    if (contenders.length === 0 || potObj.amount <= 0) return;

    // Pick winners
    const solved = contenders.map(i => ({ i, hand: rankFor(i) }));
    const best = Hand.winners(solved.map(s => s.hand));
    const winnerIdxs = solved.filter(s => best.some(b=>b === s.hand)).map(s => s.i);

    const share = Math.floor(potObj.amount / winnerIdxs.length);
    winnerIdxs.forEach(i => { seats[i].chips += share; });

    io.emit('message', `Winners (${formatShort(share)} each): ${winnerIdxs.map(i=>seats[i].shortKey).join(', ')}`);
  });

  io.emit('updatePot', 0);
}

// If only one player remains (everyone else folded)
function awardAllTo(list){
  const total = potTotal();
  list.forEach(i => seats[i].chips += Math.floor(total / list.length));
  io.emit('updatePot', 0);
  io.emit('message', `Pot awarded to ${list.map(i=>seats[i].shortKey).join(', ')}`);
  pots = [];
}

// ====== CARD CONVERSION (client expects ♥♦♣♠ like earlier; we used s/h/d/c internally) ======
function convertToClientCards(hole){
  return hole.map(c => {
    const r = c[0];
    const s = c[1];
    const suitMap = { s:'♠', h:'♥', d:'♦', c:'♣' };
    return r + suitMap[s];
  });
}
function toSolver(card){ // 'As', 'Td', etc. already in poker format
  return card[0] + card[1];
}

// ====== DEALING START OF HAND ======
function startHand(){
  resetHandFlags();
  const alive = seatedIdxList();
  if (alive.length < 2){ io.emit('message','Need at least 2 players'); return; }

  // New deck
  deck = shuffle(createDeck());
  board = [];
  pots = [];
  pot = 0;
  io.emit('updatePot', pot);

  // Setup dealer → SB → BB
  if (dealerIdx === null){
    dealerIdx = alive[0];
  } else {
    // dealer to next occupied seat
    dealerIdx = nextSeat(dealerIdx);
  }
  smallBlindIdx = nextSeat(dealerIdx);
  bigBlindIdx = nextSeat(smallBlindIdx);

  io.emit('dealer', { dealer: dealerIdx, small: smallBlindIdx, big: bigBlindIdx });

  // Mark players in hand + not all-in
  alive.forEach(i=>{
    const p = seats[i];
    p.inHand = true;
    p.allIn = false;
    p.folded = false;
    p.holeCards = [];
    p.committedThisStreet = 0;
  });

  // Blinds
  initPots();
  postBlind(smallBlindIdx, SMALL_BLIND);
  postBlind(bigBlindIdx, BIG_BLIND);
  currentBet = BIG_BLIND;

  // Deal hole cards
  alive.forEach(i=>{
    const p = seats[i];
    p.holeCards = [ deck.pop(), deck.pop() ];
    // send private to that player
    io.to(p.socketId).emit('dealPrivate', convertToClientCards(p.holeCards));
    // send hidden to others
    alive.forEach(j=>{
      if (i===j) return;
      const q = seats[j];
      io.to(q.socketId).emit('dealHidden', { playerId: i });
    });
  });

  gameActive = true;
  io.emit('gameStarted');
  logEvent(`Hand started. Dealer …${seats[dealerIdx].pubkey.slice(-4)} | SB …${seats[smallBlindIdx].pubkey.slice(-4)} | BB …${seats[bigBlindIdx].pubkey.slice(-4)}`);

  beginBettingRound('preflop');
}

function resetHandFlags(){
  seats.forEach(p=>{
    if (!p) return;
    p.inHand = false; p.allIn = false; p.folded=false; p.holeCards=[];
    p.committedThisStreet = 0;
  });
}

// ====== ACTION HANDLING ======
function legalActionsFor(idx){
  const p = seats[idx];
  if (!p || !p.inHand || p.allIn) return [];

  const toCall = currentBet - p.committedThisStreet;
  const acts = ['fold'];
  if (toCall <= 0){
    acts.push('check');
    acts.push('bet'); // open bet
  } else {
    acts.push('call');
    acts.push('raise');
  }
  return acts;
}

function handleAction(idx, action){
  const p = seats[idx];
  if (!p || idx !== currentToActIdx) return;
  if (!p.inHand || p.allIn) return;

  clearTurnTimer();

  const toCall = Math.max(0, currentBet - p.committedThisStreet);

  if (action.type === 'fold'){
    p.inHand = false;
    io.emit('actionBroadcast', { type:'fold', seat: idx });
  }
  else if (action.type === 'check'){
    if (toCall > 0) return promptAction(); // illegal, ignore
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'check', seat: idx });
  }
  else if (action.type === 'call'){
    if (toCall <= 0) return promptAction(); // nothing to call
    const paid = Math.min(p.chips, toCall);
    p.chips -= paid;
    p.committedThisStreet += paid;
    contributeToPots(idx, paid);
    if (p.chips === 0) p.allIn = true;
    io.emit('updatePot', potTotal());
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'call', seat: idx, amount: paid });
  }
  else if (action.type === 'bet'){
    // open bet when no currentBet
    if (currentBet > 0) return promptAction();
    const amt = Math.max(BIG_BLIND, Number(action.amount||0));
    if (amt <= 0) return promptAction();

    const paid = Math.min(p.chips, amt);
    p.chips -= paid;
    p.committedThisStreet += paid;
    currentBet = p.committedThisStreet;
    lastAggressor = idx;
    contributeToPots(idx, paid);
    if (p.chips === 0) p.allIn = true;
    io.emit('updatePot', potTotal());
    p.actedThisStreet = true;
    // others must act again
    inHandIdxList().forEach(i=>seats[i].actedThisStreet=false);
    io.emit('actionBroadcast', { type:'bet', seat: idx, amount: paid });
  }
  else if (action.type === 'raise'){
    if (toCall <= 0) return promptAction();
    const minRaise = Math.max(currentBet + (currentBet - (p.prevAggBet||0)), currentBet + BIG_BLIND);
    const want = Math.max(Number(action.amount||0), minRaise);
    const need = want - p.committedThisStreet;
    const paid = Math.min(p.chips, need);
    if (paid <= 0) return promptAction();
    p.chips -= paid;
    p.committedThisStreet += paid;
    currentBet = Math.max(currentBet, p.committedThisStreet);
    lastAggressor = idx;
    p.prevAggBet = currentBet;
    contributeToPots(idx, paid);
    if (p.chips === 0) p.allIn = true;
    io.emit('updatePot', potTotal());
    // reset acted for others
    inHandIdxList().forEach(i=>seats[i].actedThisStreet=false);
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'raise', seat: idx, amount: paid });
  }

  // If only one left, award pot
  const lone = allButOneFolded();
  if (lone !== null){ awardAllTo([lone]); return endHand(); }

  // If betting round ended, advance
  if (everyoneActedAndMatched()){
    return advanceStreet();
  }

  // Otherwise pass action
  currentToActIdx = nextActive(idx);
  if (currentToActIdx === null) return advanceStreet();
  promptAction();
}

// ====== SOCKETS ======
io.on('connection', socket=>{
  socket.emit('message','Spectating. Connect wallet to sit.');
  broadcastPlayers(); 
  io.emit('updatePot', potTotal());

  // Wallet connect / token gate
  socket.on('walletConnected', async ({ pubkey })=>{
    try{
      // prevent duplicates
      if (seats.find(p=>p && p.pubkey === pubkey)){
        socket.emit('walletRejected', { reason:'Wallet already seated' });
        return;
      }
      const { web3, spl } = await ensureSolana();
      const conn = new web3.Connection(DEVNET_RPC);
      const owner = new web3.PublicKey(pubkey);
      const mint = new web3.PublicKey(REQUIRED_TOKEN_MINT_STR);
      const mintInfo = await spl.getMint(conn, mint);
      const decimals = mintInfo.decimals || 0;
      const ata = await spl.getAssociatedTokenAddress(mint, owner);
      const info = await spl.getAccount(conn, ata).catch(()=>null);
      const rawBal = info ? Number(info.amount) : 0;
      const uiBal  = rawBal / Math.pow(10, decimals);

      socket.emit('walletVerified', { pubkey, balance: uiBal });
      if (TOKEN_GATE_ENABLED && uiBal < REQUIRED_AMOUNT){
        socket.emit('walletRejected', { reason:'Insufficient tokens to sit' });
        return;
      }

      const seatIdx = findFirstEmptySeat();
      if (seatIdx === -1){ socket.emit('walletRejected',{reason:'Table full'}); return; }

      seats[seatIdx] = {
        socketId: socket.id,
        pubkey,
        shortKey: '…'+pubkey.slice(-4),
        chips: Math.floor(uiBal), // treat token balance as chips for now
        seatIndex: seatIdx,
        inHand: false,
        allIn: false,
        folded: false,
        committedThisStreet: 0,
        holeCards: []
      };
      socket.emit('seatAssigned', { seat: seatIdx, shortKey: seats[seatIdx].shortKey, chips: seats[seatIdx].chips });
      logEvent(seats[seatIdx].shortKey+" sat down."); 
      broadcastPlayers();
    }catch(e){
      console.error(e);
      socket.emit('walletRejected', { reason:'Validation error' });
    }
  });

  // Start with countdown (guarded)
  socket.on('startGame', ()=>{
    const activeCount = seatedIdxList().length;
    if (activeCount < 2){ socket.emit('message','Need at least 2 players to start'); return; }
    if (gameActive || countdownInProgress){ socket.emit('message','Game already starting or in progress'); return; }

    countdownInProgress = true;
    let countdown = COUNTDOWN_SECONDS;
    io.emit('countdownStart', { seconds: countdown });
    logEvent('Countdown starting');

    const t = setInterval(()=>{
      countdown--;
      if (countdown > 0){
        io.emit('countdownTick', { seconds: countdown });
      } else {
        clearInterval(t);
        io.emit('countdownTick', { seconds: 0 });
        countdownInProgress = false;
        startHand();
      }
    }, 1000);
  });

  // Player actions
  socket.on('action', (payload)=>{
    const idx = seats.findIndex(p=>p && p.socketId===socket.id);
    if (idx === -1) return;
    handleAction(idx, payload||{});
  });

  // Leave/disconnect
  socket.on('leaveTable', ()=>{
    const idx = seats.findIndex(p=>p && p.socketId===socket.id);
    if (idx !== -1){
      logEvent(seats[idx].shortKey+' left.');
      seats[idx] = null;
      broadcastPlayers();
    }
  });
  socket.on('disconnect', ()=>{
    const idx = seats.findIndex(p=>p && p.socketId===socket.id);
    if (idx !== -1){
      logEvent(seats[idx].shortKey+' disconnected.');
      seats[idx] = null;
      broadcastPlayers();
    }
  });
});

server.listen(PORT,()=>console.log('Poker server running on port', PORT));
