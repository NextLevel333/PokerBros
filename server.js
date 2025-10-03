// server.js — Render-ready Poker Server with auto-seat + disconnect toggle
// Deps: express, socket.io, helmet, pokersolver, @solana/web3.js, @solana/spl-token

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const TOKEN_GATE_ENABLED = process.env.TOKEN_GATE_ENABLED === "false" ? false : true;
const DEVNET_RPC = 'https://api.devnet.solana.com';
const REQUIRED_TOKEN_MINT_STR = process.env.REQUIRED_TOKEN_MINT || 'Cjx3uYo6qzpcYFoB9hGBjBBa5yWbZyCvRfiHY7Zq7xyA';
const REQUIRED_AMOUNT = process.env.REQUIRED_AMOUNT ? parseInt(process.env.REQUIRED_AMOUNT) : 100;

const MAX_SEATS = 6;

// ====== Express & Socket.io ======
const app = express();
app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== Logging Helper ======
function logEvent(e){
  console.log(`[GAME LOG] ${e}`);
  io.emit('message', e);
}

// ====== Lazy import Solana ======
let sol = null;
async function ensureSolana(){
  if (sol) return sol;
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  sol = { web3, spl };
  return sol;
}

// ====== Game State ======
let seats = new Array(MAX_SEATS).fill(null);
let community = [];
let pot = 0;

// ====== Helpers ======
function findFirstEmptySeat(){
  return seats.findIndex(p => p === null);
}
function broadcastPlayers(){
  io.emit('playersUpdate', seats.map(p => p ? {
    pubkey: p.pubkey,
    shortKey: p.shortKey,
    chips: p.chips,
    seatIndex: p.seatIndex
  } : null));
}

// ====== Socket.io Logic ======
io.on('connection', (socket) => {
  socket.emit('message', 'Spectating. Connect wallet to sit.');
  broadcastPlayers();
  socket.emit('updatePot', pot);

  // Handle wallet connect
  socket.on('walletConnected', async ({ pubkey }) => {
    try {
      const { web3, spl } = await ensureSolana();
      const conn = new web3.Connection(DEVNET_RPC);
      const owner = new web3.PublicKey(pubkey);
      const mint = new web3.PublicKey(REQUIRED_TOKEN_MINT_STR);
      const ata = await spl.getAssociatedTokenAddress(mint, owner);
      const info = await spl.getAccount(conn, ata).catch(()=>null);
      const balance = info ? Number(info.amount) : 0;

      socket.emit('walletVerified', { pubkey, balance });

      if (TOKEN_GATE_ENABLED && balance < REQUIRED_AMOUNT) {
        socket.emit('walletRejected', { reason: 'Insufficient tokens to sit' });
        return;
      }

      const seatIdx = findFirstEmptySeat();
      if (seatIdx === -1) {
        socket.emit('walletRejected', { reason: 'Table full' });
        return;
      }

      seats[seatIdx] = {
        socketId: socket.id,
        pubkey,
        shortKey: '…' + pubkey.slice(-4),
        chips: balance,
        seatIndex: seatIdx
      };

      socket.emit('seatAssigned', { seat: seatIdx, shortKey: seats[seatIdx].shortKey, chips: seats[seatIdx].chips });
      logEvent(`${seats[seatIdx].shortKey} sat down.`);
      broadcastPlayers();
    } catch (e) {
      console.error(e);
      socket.emit('walletRejected', { reason: 'Validation error' });
    }
  });

  // ====== Disconnect / Free Seat ======
  socket.on('disconnect', () => {
    const idx = seats.findIndex(p => p && p.socketId === socket.id);
    if (idx !== -1) {
      logEvent(`${seats[idx].shortKey} disconnected.`);
      seats[idx] = null;
      broadcastPlayers();
    }
  });
});

// ====== Start Server ======
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
