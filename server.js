// server.js — Render-ready Texas Hold’em Poker Server with sqlite3 logging
// Deps: npm i express socket.io helmet sqlite3 pokersolver @solana/web3.js @solana/spl-token

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
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

// ====== DB (sqlite3 for logging) ======
const db = new sqlite3.Database(path.join(__dirname, 'poker.db'), (err) => {
  if (err) console.error('DB error:', err.message);
});
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS game_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    event TEXT
  )`);
});
function logEvent(e){
  db.run("INSERT INTO game_log (event) VALUES (?)", [e], (err) => {
    if (err) console.error('DB log error:', err.message);
  });
  io.emit('message', e);
}

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
// 👉 Here you keep the same helper functions you already had in your extended server.js:
// buildDeck, shuffle, broadcastPlayers, findFirstEmptySeat, findNextOccupied, advanceAfterAction, 
// buildSidePots, distributeSidePots, etc.
// (I didn’t rewrite them here to avoid duplicating all logic, but they plug in the same way.)

// ====== Socket.io Logic ======
io.on('connection', (socket) => {
  socket.emit('message', 'Spectating. Connect wallet to sit.');
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

      socket.emit('walletVerified', { pubkey, balance });

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

  // 👉 Insert your existing betting, action, showdown, and disconnect handling logic here
});

server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
