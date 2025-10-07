// === Poker Server: Token Gate + Full Gameplay (NLHE) + Timers + Side Pots ===
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

const PORT = process.env.PORT || 3000;

// ====== TABLE CONFIG ======
const MAX_SEATS = 10;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const TURN_TIME_MS = 30000;       // per action, auto-fold on timeout
const COUNTDOWN_SECONDS = 3;     // pre-hand countdown

// ====== TOKEN GATE CONFIG (Devnet) ======
const TOKEN_GATE_ENABLED = false;
const DEVNET_RPC = 'https://api.devnet.solana.com';
const REQUIRED_TOKEN_MINT_STR = 'DsSMod73mQ51zW1FqXFrrXsZ3nCXAZnrZdyMMpAHSJQk';
const REQUIRED_AMOUNT = 100; // UI units (post-decimals)

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
let seats = new Array(MAX_SEATS).fill(null); // { socketId, pubkey, shortKey, chips, seatIndex, flags..., holeCards:[] }
let deck = [];
let board = [];
let dealerIdx = null;
let smallBlindIdx = null;
let bigBlindIdx = null;

let pots = [];           // [{amount, eligibles:Set<idx>}]
let gameActive = false;
let countdownInProgress = false;

let street = null;       // 'preflop'|'flop'|'turn'|'river'|'showdown'
let currentToActIdx = null;
let currentBet = 0;      // highest committedThisStreet among active players
let lastRaiseSize = 0;   // last raise size on this street (for min-raise rule)
let actionTimer = null;

// ====== HELPERS ======
function findFirstEmptySeat(){ return seats.findIndex(p => p===null); }
function seatedIdxList(){ return seats.map((p,i)=>p? i : -1).filter(i=>i>=0); }
function inHandIdxList(){ return seats.map((p,i)=>p&&p.inHand&&!p.folded? i:-1).filter(i=>i>=0); }
function activeIdxList(){ return seats.map((p,i)=>p&&p.inHand&&!p.folded&&!p.allIn? i:-1).filter(i=>i>=0); }

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
    if (p && p.inHand && !p.folded && !p.allIn) return idx;
  }
  return null;
}

function broadcastPlayers(){
  io.emit('playersUpdate', seats.map(p=>p?{
    pubkey:p.pubkey,
    shortKey:p.shortKey,
    chips:Math.max(0, Math.floor(p.chips)),
    seatIndex:p.seatIndex
  }:null));
  if (seats.every(p=>p===null)){
    resetTable();
    io.emit('gameWaiting');
    logEvent('Table empty. Game reset.');
  }
}

function resetTable(){
  deck=[]; board=[]; pots=[];
  gameActive=false; countdownInProgress=false;
  street=null; currentToActIdx=null; currentBet=0; lastRaiseSize=0;
  clearTurnTimer();
  seats.forEach(p=>{ if(p){ p.inHand=false; p.folded=false; p.allIn=false; p.holeCards=[]; p.totalCommitted=0; p.committedThisStreet=0; }});
  io.emit('updatePot', 0);
}

function createDeck(){
  const suits = ['s','h','d','c']; // for pokersolver
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

function convertToClientCards(hole){
  // client expects ♥♦♣♠; we store s/h/d/c
  const map = { s:'♠', h:'♥', d:'♦', c:'♣' };
  return hole.map(c => c[0] + map[c[1]]);
}
function solverCardsFor(seatIdx){
  const p = seats[seatIdx];
  return p.holeCards.concat(board).map(c => c[0] + c[1]); // 'As','Td'
}

function clearTurnTimer(){
  if (actionTimer){ clearTimeout(actionTimer); actionTimer=null; }
}
function startTurnTimer(seatIdx){
  clearTurnTimer();
  io.emit('turn', { playerId: seatIdx, ms: TURN_TIME_MS });
  actionTimer = setTimeout(()=>{
    // auto-fold
    handleAction(seatIdx, { type: 'fold' }, true);
  }, TURN_TIME_MS + 200);
}

function postToPots(seatIdx, amount){
  // Simple pot builder: everything goes to main pot; side pots are created on showdown using totalCommitted caps.
  const last = pots[pots.length-1];
  if (!last){
    pots.push({ amount: amount, eligibles: new Set(inHandIdxList()) });
  } else {
    last.amount += amount;
  }
  io.emit('updatePot', pots.reduce((a,p)=>a+p.amount,0));
}

// Build side pots properly from players' total commitments
function buildSidePotsFromTotals(){
  const players = inHandIdxList().map(i => ({ i, committed: seats[i].totalCommitted }));
  if (players.length === 0) return [];

  // Unique ascending commitment levels
  const levels = [...new Set(players.map(p=>p.committed))].sort((a,b)=>a-b).filter(x=>x>0);
  if (levels.length === 0) return [];

  const potsOut = [];
  let prev = 0;

  for (const level of levels){
    const eligibles = players.filter(p => p.committed >= level).map(p=>p.i);
    const contributors = players.filter(p => p.committed >= level);
    const delta = level - prev;
    const amount = contributors.reduce((sum, p) => sum + delta, 0);
    potsOut.push({ amount, eligibles: new Set(eligibles) });
    prev = level;
  }
  return potsOut;
}

function allButOneAlive(){
  const alive = inHandIdxList();
  return alive.length === 1 ? alive[0] : null;
}

// ====== HAND FLOW ======
function startHand(){
  // Require at least 2 seated
  const seated = seatedIdxList();
  if (seated.length < 2){ io.emit('message','Need at least 2 players'); return; }

  // New deck & board
  deck = shuffle(createDeck());
  board = [];
  pots = [];
  street = null;
  currentToActIdx = null;
  currentBet = 0;
  lastRaiseSize = 0;

  // Rotate dealer
  if (dealerIdx === null){
    dealerIdx = seated[0];
  } else {
    dealerIdx = nextSeat(dealerIdx);
  }
  smallBlindIdx = nextSeat(dealerIdx);
  bigBlindIdx = nextSeat(smallBlindIdx);

  // Reset players for new hand
  seated.forEach(i=>{
    const p = seats[i];
    p.inHand = true; p.folded = false; p.allIn = false;
    p.holeCards = [];
    p.totalCommitted = 0;
    p.committedThisStreet = 0;
  });

  io.emit('dealer', { dealer: dealerIdx, small: smallBlindIdx, big: bigBlindIdx });

  // Post blinds
  postBlind(smallBlindIdx, SMALL_BLIND);
  postBlind(bigBlindIdx, BIG_BLIND);
  currentBet = Math.max(seats[smallBlindIdx].committedThisStreet, seats[bigBlindIdx].committedThisStreet);
  lastRaiseSize = BIG_BLIND; // base for min-raise preflop

  // Deal hole cards (private + hidden to others)
  seated.forEach(i=>{
    const p = seats[i];
    p.holeCards = [ deck.pop(), deck.pop() ];
    io.to(p.socketId).emit('dealPrivate', convertToClientCards(p.holeCards));
  });
  // tell everyone else to show backs for each seated player (client will draw backs)
  seated.forEach(i=>{
    seated.forEach(j=>{
      if (i===j) return;
      io.to(seats[j].socketId).emit('dealHidden', { playerId: i });
    });
  });

  gameActive = true;
  io.emit('gameStarted');
  logEvent(`Hand started. Dealer ${seats[dealerIdx].shortKey}, SB ${seats[smallBlindIdx].shortKey}, BB ${seats[bigBlindIdx].shortKey}`);

  beginBettingRound('preflop');
}

function postBlind(idx, amount){
  const p = seats[idx];
  if (!p || !p.inHand || p.folded) return;
  const pay = Math.min(p.chips, amount);
  p.chips -= pay;
  p.committedThisStreet += pay;
  p.totalCommitted += pay;
  if (p.chips === 0) p.allIn = true;
  postToPots(idx, pay);
  io.emit('actionBroadcast', { type: (idx===smallBlindIdx?'postSB':'postBB'), seat: idx, amount: pay });
}

function beginBettingRound(kind){
  street = kind;
  // reset per-street
  inHandIdxList().forEach(i=>{
    seats[i].actedThisStreet = false;
    seats[i].committedThisStreet = 0; // reset per-street commitments
  });

  // Re-apply blinds as committedThisStreet for preflop
  seats[smallBlindIdx] && (seats[smallBlindIdx].committedThisStreet = Math.min(SMALL_BLIND, seats[smallBlindIdx].totalCommitted));
  seats[bigBlindIdx] && (seats[bigBlindIdx].committedThisStreet = Math.min(BIG_BLIND, seats[bigBlindIdx].totalCommitted));

  // currentBet is max committedThisStreet among active
  currentBet = inHandIdxList().reduce((m,i)=>Math.max(m, seats[i].committedThisStreet), 0);
  lastRaiseSize = (street==='preflop') ? BIG_BLIND : 0;

  io.emit('bettingRound', { street, currentBet });

  // first to act: preflop = left of BB; else left of dealer
  currentToActIdx = (street==='preflop') ? nextActive(bigBlindIdx) : nextActive(dealerIdx);

  // If no one can act (everyone all-in), fast-forward to next streets
  if (currentToActIdx === null) return advanceStreet();
  promptAction();
}

function promptAction(){
  // Skip folded/all-in
  let safety=0;
  while (safety++ < MAX_SEATS){
    const p = seats[currentToActIdx];
    if (p && p.inHand && !p.folded && !p.allIn) break;
    currentToActIdx = nextActive(currentToActIdx);
    if (currentToActIdx === null) break;
  }
  if (currentToActIdx === null) return advanceStreet();

  startTurnTimer(currentToActIdx);
}

function everyoneActedAndMatched(){
  const active = activeIdxList();
  if (active.length <= 1) return true;
  // All active have acted and all active have committed == currentBet
  return active.every(i => seats[i].actedThisStreet) &&
         active.every(i => seats[i].committedThisStreet === currentBet);
}

function advanceStreet(){
  clearTurnTimer();

  // If only one alive, award immediately
  const lone = allButOneAlive();
  if (lone !== null){
    // Pay entire pot to the last player
    const total = pots.reduce((a,p)=>a+p.amount, 0);
    seats[lone].chips += total;
    io.emit('updatePot', 0);
    io.emit('message', `Pot awarded to ${seats[lone].shortKey}`);
    return endHand();
  }

  if (street === 'preflop'){
    // Flop (burn 1, deal 3)
    deck.pop();
    board.push(deck.pop(), deck.pop(), deck.pop());
    io.emit('dealCommunity', convertToClientCards(board));
    beginBettingRound('flop');
  } else if (street === 'flop'){
    // Turn (burn 1, deal 1)
    deck.pop();
    board.push(deck.pop());
    io.emit('dealCommunity', convertToClientCards(board));
    beginBettingRound('turn');
  } else if (street === 'turn'){
    // River (burn 1, deal 1)
    deck.pop();
    board.push(deck.pop());
    io.emit('dealCommunity', convertToClientCards(board));
    beginBettingRound('river');
  } else if (street === 'river'){
    return showdown();
  } else {
    // If we came here with nobody able to act (everyone all-in pre), just complete board then showdown
    while (board.length < 5){
      if (board.length===0) deck.pop(); // burn before flop
      board.push(deck.pop());
      io.emit('dealCommunity', convertToClientCards(board));
    }
    return showdown();
  }
}

function showdown(){
  street = 'showdown';
  clearTurnTimer();

  // Reveal all in-hand players
  inHandIdxList().forEach(i=>{
    io.emit('reveal', { playerId: i, hand: convertToClientCards(seats[i].holeCards) });
  });

  // Build side pots using totalCommitted
  const sidePots = buildSidePotsFromTotals();
  if (sidePots.length === 0){
    // If something odd, fallback to single pot
    const sum = pots.reduce((a,p)=>a+p.amount,0);
    sidePots.push({ amount: sum, eligibles: new Set(inHandIdxList()) });
  }

  // Resolve each pot
  sidePots.forEach(potObj=>{
    const contenders = [...potObj.eligibles].filter(i => seats[i] && seats[i].inHand && !seats[i].folded);
    if (contenders.length === 0 || potObj.amount <= 0) return;

    const solved = contenders.map(i => ({ i, hand: Hand.solve(solverCardsFor(i)) }));
    const winners = Hand.winners(solved.map(s=>s.hand));
    const winnerIdxs = solved.filter(s => winners.includes(s.hand)).map(s=>s.i);

    const share = Math.floor(potObj.amount / winnerIdxs.length);
    winnerIdxs.forEach(i => { seats[i].chips += share; });

    io.emit('message', `Winners (${share} each): ${winnerIdxs.map(i=>seats[i].shortKey).join(', ')}`);
  });

  io.emit('updatePot', 0);
  endHand();
}

function endHand(){
  gameActive = false;
  // Clear hand flags
  seats.forEach(p=>{
    if (!p) return;
    p.inHand=false; p.folded=false; p.allIn=false;
    p.holeCards=[]; p.committedThisStreet=0; p.totalCommitted=0;
  });
  pots = [];
  board = [];
  io.emit('gameWaiting');
  logEvent('Hand ended. Ready for next hand.');
}

// ====== ACTIONS ======
function handleAction(idx, action, isTimeout=false){
  const p = seats[idx];
  if (!p || !p.inHand || p.folded || p.allIn) return;
  if (idx !== currentToActIdx && !isTimeout) return; // not your turn

  clearTurnTimer();

  const toCall = Math.max(0, currentBet - p.committedThisStreet);

  if (action.type === 'fold'){
    p.folded = true;
    io.emit('actionBroadcast', { type:'fold', seat: idx });
  }
  else if (action.type === 'check'){
    if (toCall > 0){ // illegal
      return promptAction();
    }
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'check', seat: idx });
  }
  else if (action.type === 'call'){
    if (toCall <= 0){
      p.actedThisStreet = true;
      io.emit('actionBroadcast', { type:'check', seat: idx });
    } else {
      const pay = Math.min(p.chips, toCall);
      p.chips -= pay;
      p.committedThisStreet += pay;
      p.totalCommitted += pay;
      if (p.chips === 0) p.allIn = true;
      postToPots(idx, pay);
      p.actedThisStreet = true;
      io.emit('actionBroadcast', { type:'call', seat: idx, amount: pay });
    }
  }
  else if (action.type === 'bet'){
    if (currentBet > 0) return promptAction(); // can't "bet" when a bet exists; must raise
    const want = Number(action.amount||0);
    const minBet = BIG_BLIND;
    const betAmt = Math.max(minBet, want);
    const pay = Math.min(p.chips, betAmt);
    if (pay <= 0) return promptAction();
    p.chips -= pay;
    p.committedThisStreet += pay;
    p.totalCommitted += pay;
    currentBet = p.committedThisStreet;
    lastRaiseSize = currentBet; // opening bet size
    if (p.chips === 0) p.allIn = true;
    postToPots(idx, pay);
    // reset others' acted flags – new aggression
    inHandIdxList().forEach(i=>seats[i].actedThisStreet=false);
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'bet', seat: idx, amount: pay });
  }
  else if (action.type === 'raise'){
    if (toCall <= 0) return promptAction();
    const want = Number(action.amount||0); // total you want to have in pot this street
    // Minimum raise: currentBet + lastRaiseSize
    const minTotal = currentBet + Math.max(lastRaiseSize, BIG_BLIND);
    const target = Math.max(minTotal, want);
    const need = target - p.committedThisStreet;
    const pay = Math.min(p.chips, need);
    if (pay <= 0) return promptAction();
    p.chips -= pay;
    p.committedThisStreet += pay;
    p.totalCommitted += pay;
    lastRaiseSize = target - currentBet;  // new raise size
    currentBet = target;
    if (p.chips === 0) p.allIn = true;
    postToPots(idx, pay);
    // reset others' acted flags – new aggression
    inHandIdxList().forEach(i=>seats[i].actedThisStreet=false);
    p.actedThisStreet = true;
    io.emit('actionBroadcast', { type:'raise', seat: idx, amount: pay });
  }

  // If only one player remains
  const lone = allButOneAlive();
  if (lone !== null){
    const total = pots.reduce((a,p)=>a+p.amount,0);
    seats[lone].chips += total;
    io.emit('updatePot', 0);
    io.emit('message', `Pot awarded to ${seats[lone].shortKey}`);
    return endHand();
  }

  // If round finished, move street
  if (everyoneActedAndMatched()){
    return advanceStreet();
  }

  // Next to act
  currentToActIdx = nextActive(idx);
  if (currentToActIdx === null) return advanceStreet();
  promptAction();
}

// ====== SOCKETS ======
io.on('connection', socket=>{
  socket.emit('message','Spectating. Connect wallet to sit.');
  broadcastPlayers();
  io.emit('updatePot', pots.reduce((a,p)=>a+p.amount,0));

  // Wallet connect / token gate
  socket.on('walletConnected', async ({ pubkey })=>{
    try{
      // Prevent duplicate wallet
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
      const uiBal = rawBal / Math.pow(10, decimals);

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
        chips: Math.floor(uiBal),   // treat balance as play chips
        seatIndex: seatIdx,
        inHand: false,
        folded: false,
        allIn: false,
        holeCards: [],
        totalCommitted: 0,
        committedThisStreet: 0,
        actedThisStreet: false
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
    const seatedCount = seatedIdxList().length;
    if (seatedCount < 2){ socket.emit('message','Need at least 2 players to start'); return; }
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
