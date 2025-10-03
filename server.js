// server.js — Render-ready Texas Hold’em Poker Server
// Deps: npm i express socket.io helmet better-sqlite3 pokersolver @solana/web3.js @solana/spl-token

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { Hand } = require('pokersolver');

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;

// Toggle token gate with env var (default true)
const TOKEN_GATE_ENABLED = process.env.TOKEN_GATE_ENABLED === "false" ? false : true;

// Hardcoded defaults (can be overridden by env vars)
const DEVNET_RPC = 'https://api.devnet.solana.com';
const REQUIRED_TOKEN_MINT_STR = process.env.REQUIRED_TOKEN_MINT || 'Cjx3uYo6qzpcYFoB9hGBjBBa5yWbZyCvRfiHY7Zq7xyA';
const REQUIRED_AMOUNT = process.env.REQUIRED_AMOUNT ? parseInt(process.env.REQUIRED_AMOUNT) : 100;

const MAX_SEATS = 6;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const TURN_TIME = 20; // seconds per decision

// ====== Express & Socket.io ======
const app = express();
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== DB (for logging events) ======
const db = new Database(path.join(__dirname, 'poker.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS game_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  event TEXT
);`);
function logEvent(e){ try{ db.prepare('INSERT INTO game_log (event) VALUES (?)').run(e); } catch{} io.emit('message', e); }

// ====== Lazy import Solana packages ======
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
let deck = [];
let community = [];
let pot = 0;
let dealerIndex = -1;
let currentBet = 0;
let roundState = 'waiting';
let turnIndex = null;
let turnTimer = null;

// ====== Helpers ======
// (buildDeck, broadcastPlayers, findFirstEmptySeat, findNextOccupied, timers, buildSidePots, distributeSidePots, etc.)
// 👉 Use the same helpers we already wrote in your local extended server.js version

// ====== Socket.io Logic ======
io.on('connection', (socket) => {
  socket.emit('message', 'Spectating. Connect wallet to sit.');
  // Send initial state
  broadcastPlayers();
  if (community.length) socket.emit('dealCommunity', community);
  socket.emit('updatePot', pot);
  if (turnIndex !== null) socket.emit('turn', { playerId: turnIndex, ms: TURN_TIME*1000 });

  // Wallet connect event
  socket.on('walletConnected', async ({ pubkey }) => {
    try{
      const { web3, spl } = await ensureSolana();
      const conn = new web3.Connection(DEVNET_RPC);
      const owner = new web3.PublicKey(pubkey);
      const mint = new web3.PublicKey(REQUIRED_TOKEN_MINT_STR);
      const ata = await spl.getAssociatedTokenAddress(mint, owner);
      const info = await spl.getAccount(conn, ata).catch(()=>null);
      const balance = info ? Number(info.amount) : 0;

      // Always send back balance
      socket.emit('walletVerified', { pubkey, balance });

      // ✅ Token gate check only if enabled
      if (TOKEN_GATE_ENABLED) {
        if (balance < REQUIRED_AMOUNT){
          socket.emit('walletRejected', { reason: 'Insufficient tokens to sit' });
          return;
        }
      }

      const seatIdx = findFirstEmptySeat();
      if (seatIdx === -1){
        socket.emit('walletRejected', { reason: 'Table full' });
        return;
      }

      seats[seatIdx] = {
        socketId: socket.id,
        pubkey,
        shortKey: '…' + pubkey.slice(-4),
        chips: balance,
        hand: [], folded:false, allIn:false,
        roundContribution:0, totalContribution:0,
        seatIndex: seatIdx
      };

      socket.emit('seatAssigned', { seat: seatIdx, shortKey: seats[seatIdx].shortKey, chips: seats[seatIdx].chips });
      io.emit('message', `${seats[seatIdx].shortKey} sat down.`);
      broadcastPlayers();
    }catch(e){
      console.error(e);
      socket.emit('walletRejected', { reason: 'Validation error' });
    }
  });

  // Game actions: start, bet, call, fold, etc.
  // (Use the same betting logic, side-pot distribution, and showdown handling from your extended version)

  socket.on('disconnect', ()=> {
    const idx = seats.findIndex(p => p && p.socketId===socket.id);
    if (idx!==-1){
      io.emit('message', `${seats[idx].shortKey} left.`);
      seats[idx] = null;
      broadcastPlayers();
    }
  });
});

// ====== Start Server ======
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
