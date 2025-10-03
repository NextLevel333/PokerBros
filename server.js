// === Poker Server with Countdown and Balance Fix ===
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

const PORT = process.env.PORT || 3000;
const TOKEN_GATE_ENABLED = true;
const DEVNET_RPC = 'https://api.devnet.solana.com';
const REQUIRED_TOKEN_MINT_STR = 'DsSMod73mQ51zW1FqXFrrXsZ3nCXAZnrZdyMMpAHSJQk';
const REQUIRED_AMOUNT = 100;
const MAX_SEATS = 6;

const app = express();
app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let sol = null;
async function ensureSolana(){
  if (sol) return sol;
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  sol = { web3, spl };
  return sol;
}

function logEvent(e){ console.log("[GAME]", e); io.emit('message', e); }

let seats = new Array(MAX_SEATS).fill(null);
let pot = 0;
let gameActive = false;

function findFirstEmptySeat(){ return seats.findIndex(p => p===null); }
function broadcastPlayers(){
  io.emit('playersUpdate', seats.map(p=>p?{pubkey:p.pubkey,shortKey:p.shortKey,chips:p.chips,seatIndex:p.seatIndex}:null));
  if (seats.every(p=>p===null)){ gameActive=false; io.emit('gameWaiting'); logEvent("Table empty. Game reset."); }
}

function startHand(){
  if (gameActive) return;
  const active = seats.filter(Boolean);
  if (active.length<2){ io.emit('message','Need at least 2 players to start'); return; }
  gameActive = true;
  io.emit('gameStarted');
  logEvent("Hand starting with "+active.length+" players.");
  pot=0; io.emit('updatePot',pot);
  // TODO: dealing logic here
}
function endHand(){ gameActive=false; io.emit('gameWaiting'); logEvent("Hand ended. Ready for next hand."); }

io.on('connection', socket=>{
  socket.emit('message','Spectating. Connect wallet to sit.');
  broadcastPlayers(); io.emit('updatePot',pot);

  socket.on('walletConnected', async ({ pubkey })=>{
    try{
      const { web3, spl } = await ensureSolana();
      const conn = new web3.Connection(DEVNET_RPC);
      const owner = new web3.PublicKey(pubkey);
      const mint = new web3.PublicKey(REQUIRED_TOKEN_MINT_STR);
      const mintInfo = await spl.getMint(conn,mint);
      const decimals = mintInfo.decimals||0;
      const ata = await spl.getAssociatedTokenAddress(mint,owner);
      const info = await spl.getAccount(conn,ata).catch(()=>null);
      let rawBal=info?Number(info.amount):0;
      let uiBal=rawBal/Math.pow(10,decimals);
      socket.emit('walletVerified',{pubkey,balance:uiBal});
      if (TOKEN_GATE_ENABLED && uiBal<REQUIRED_AMOUNT){ socket.emit('walletRejected',{reason:'Insufficient tokens to sit'}); return; }
      const seatIdx=findFirstEmptySeat();
      if (seatIdx===-1){ socket.emit('walletRejected',{reason:'Table full'}); return; }
      seats[seatIdx]={socketId:socket.id,pubkey,shortKey:'…'+pubkey.slice(-4),chips:uiBal,seatIndex:seatIdx};
      socket.emit('seatAssigned',{seat:seatIdx,shortKey:seats[seatIdx].shortKey,chips:uiBal});
      logEvent(seats[seatIdx].shortKey+" sat down."); broadcastPlayers();
    }catch(e){ console.error(e); socket.emit('walletRejected',{reason:'Validation error'}); }
  });

  socket.on('startGame', ()=>{
    const active=seats.filter(Boolean).length;
    if (active<2){ socket.emit('message','Need at least 2 players to start'); return; }
    let countdown=10;
    io.emit('countdownStart',{seconds:countdown});
    const timer=setInterval(()=>{
      countdown--;
      if (countdown>0){ io.emit('countdownTick',{seconds:countdown}); }
      else { clearInterval(timer); io.emit('gameStarted'); logEvent('Match starting now!'); startHand(); }
    },1000);
  });

  socket.on('leaveTable', ()=>{
    const idx=seats.findIndex(p=>p&&p.socketId===socket.id);
    if(idx!==-1){ logEvent(seats[idx].shortKey+" left."); seats[idx]=null; broadcastPlayers(); }
  });
  socket.on('disconnect', ()=>{
    const idx=seats.findIndex(p=>p&&p.socketId===socket.id);
    if(idx!==-1){ logEvent(seats[idx].shortKey+" disconnected."); seats[idx]=null; broadcastPlayers(); }
  });
});

server.listen(PORT,()=>console.log("Poker server running on port",PORT));
