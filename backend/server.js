const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));
const DIST_PATH = path.join(__dirname,"dist");
console.log("DIST_PATH =", DIST_PATH);
console.log("INDEX_HTML =", path.join(DIST_PATH, "index.html"));
app.use(express.static(DIST_PATH));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "http://localhost:5173" } });
const rooms = {};
const AVATARS = ["🦊", "🐼", "🐙", "🦁", "🦉", "🐸", "🐯", "🐨", "🦄", "🐧", "🐵", "🐬"];
const PLAYER_COLORS = ["#5b4bdb", "#10b981", "#f97316", "#ec4899", "#0ea5e9", "#8b5cf6", "#14b8a6", "#ef4444"];
const THEMES = ["Free", "Animals", "Movies", "Technology", "Office", "PMI", "Data", "Absurd"];

const DURATIONS = { phrase: 40, drawing1: 60, guessing1: 40, drawing2: 60, guessing2: 40 };
const PHASE_ORDER = ["phrase", "drawing1", "guessing1", "drawing2", "guessing2", "results"];
const VOTE_CATEGORIES = { bestDrawing: "Best Drawing", bestGuess: "Best Guess", bestChain: "Best Chain", mostAccurate: "Most Accurate Drawing", biggestTwist: "Biggest Twist" };
const codeOf = (value) => String(value || "").trim().toUpperCase();
const nameOf = (value) => String(value || "").trim();

function newRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function playerForChain(players, chainIndex, offset) {
  return players[(chainIndex + offset) % players.length];
}

function participantProfile(room, name, index) {
  return {
    name,
    avatar: AVATARS[index % AVATARS.length],
    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
  };
}

function publicPlayers(room) {
  return room.players.map((name) => room.playerProfiles[name]);
}

function buildChains(players) {
  const chains = {};
  players.forEach((starter, index) => {
    chains[starter] = {
      id: `chain-${index + 1}`,
      starter,
      originalPhrase: null,
      drawing1: null,
      guessing1: null,
      drawing2: null,
      guessing2: null,
      contributors: {
        phrase: starter,
        drawing1: playerForChain(players, index, 1),
        guessing1: playerForChain(players, index, 2),
        drawing2: playerForChain(players, index, 3),
        guessing2: playerForChain(players, index, 4),
      },
    };
  });
  return chains;
}

function roomSockets(code) {
  return io.sockets.adapter.rooms.get(code) || new Set();
}

function emitToRole(code, role, event, payload) {
  for (const socketId of roomSockets(code)) {
    const client = io.sockets.sockets.get(socketId);
    if (client?.data.role === role) client.emit(event, payload);
  }
}

function emitToPlayer(code, playerName, event, payload) {
  for (const socketId of roomSockets(code)) {
    const client = io.sockets.sockets.get(socketId);
    if (client?.data.role === "player" && client.data.playerName === playerName) {
      client.emit(event, payload);
    }
  }
}

function assignmentFor(room, playerName, phase) {
  return Object.values(room.chains).find((chain) => chain.contributors[phase] === playerName);
}

function phaseEntryKey(phase) {
  return phase === "phrase" ? "originalPhrase" : phase;
}

function submittedPlayers(room, phase) {
  const entryKey = phaseEntryKey(phase);
  return room.players.filter((player) => {
    const chain = assignmentFor(room, player, phase);
    return Boolean(chain?.[entryKey]);
  });
}

function emitProgress(code, room) {
  const submitted = submittedPlayers(room, room.state);
  io.to(code).emit("phase-progress", {
    phase: room.state,
    submittedPlayers: submitted,
    total: room.players.length,
    complete: submitted.length === room.players.length,
  });
}

function finalizeMissingSubmissions(code, room, phase) {
  if (room.state !== phase) return;
  const entryKey = phaseEntryKey(phase);
  const blankPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFhQGAWjR9WQAAAABJRU5ErkJggg==";

  for (const player of room.players) {
    const chain = assignmentFor(room, player, phase);
    if (!chain || chain[entryKey]) continue;

    if (["phrase", "guessing1", "guessing2"].includes(phase)) {
      const text = phase === "phrase"
        ? "No phrase submitted (time expired)"
        : "No guess submitted (time expired)";
      chain[entryKey] = { author: player, text, automatic: true };
    } else {
      chain[entryKey] = { author: player, image: blankPng, automatic: true };
    }
  }

  emitProgress(code, room);
}

function startTimedPhase(code, room, phase) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.state = phase;
  room.phaseDeadline = Date.now() + DURATIONS[phase] * 1000;
  room.phaseTimer = setTimeout(() => {
    finalizeMissingSubmissions(code, room, phase);
  }, DURATIONS[phase] * 1000 + 100);
  emitToRole(code, "host", "phase-started", { phase, deadline: room.phaseDeadline });

  for (const player of room.players) {
    const chain = assignmentFor(room, player, phase);
    let task;
    if (phase === "phrase") task = { kind: "text", prompt: "Write a funny phrase", theme: room.theme };
    if (phase === "drawing1") task = { kind: "drawing", prompt: chain.originalPhrase.text };
    if (phase === "guessing1") task = { kind: "guess", image: chain.drawing1.image };
    if (phase === "drawing2") task = { kind: "drawing", prompt: chain.guessing1.text };
    if (phase === "guessing2") task = { kind: "guess", image: chain.drawing2.image };
    emitToPlayer(code, player, "phase-started", { phase, deadline: room.phaseDeadline, task });
  }
  emitProgress(code, room);
}

function resultsPayload(room) {
  const chainKeys = room.players;
  const key = chainKeys[room.results.chainIndex];
  const chain = room.chains[key];
  const entries = [
    { type: "text", label: "Original Phrase", value: chain.originalPhrase.text },
    { type: "image", label: "Drawing 1", value: chain.drawing1.image },
    { type: "text", label: "Guess 1", value: chain.guessing1.text },
    { type: "image", label: "Drawing 2", value: chain.drawing2.image },
    { type: "text", label: "Final Guess", value: chain.guessing2.text },
  ];
  return {
    chainNumber: room.results.chainIndex + 1,
    totalChains: chainKeys.length,
    revealCount: room.results.revealCount,
    entries: entries.slice(0, room.results.revealCount),
    canRevealMore: room.results.revealCount < entries.length,
    canNextChain: room.results.chainIndex < chainKeys.length - 1,
    allRevealed: room.results.revealCount >= entries.length,
    isLastChain: room.results.chainIndex >= chainKeys.length - 1,
  };
}

function chainContributors(chain) {
  return [...new Set(Object.values(chain.contributors))];
}
function voteCatalogue(room) {
  const catalogue = {};
  for (const chain of Object.values(room.chains)) {
    catalogue[`drawing1:${chain.id}`] = { type: "drawing", owner: chain.drawing1.author, chain, image: chain.drawing1.image, prompt: chain.originalPhrase.text };
    catalogue[`drawing2:${chain.id}`] = { type: "drawing", owner: chain.drawing2.author, chain, image: chain.drawing2.image, prompt: chain.guessing1.text };
    catalogue[`guessing1:${chain.id}`] = { type: "guess", owner: chain.guessing1.author, chain, text: chain.guessing1.text };
    catalogue[`guessing2:${chain.id}`] = { type: "guess", owner: chain.guessing2.author, chain, text: chain.guessing2.text };
    catalogue[`chain:${chain.id}`] = { type: "chain", chain };
  }
  return catalogue;
}
function ballotFor(room, playerName) {
  const catalogue = voteCatalogue(room);
  const drawings = Object.entries(catalogue).filter(([, item]) => item.type === "drawing" && item.owner !== playerName).map(([id, item]) => ({ id, image: item.image, prompt: item.prompt }));
  const guesses = Object.entries(catalogue).filter(([, item]) => item.type === "guess" && item.owner !== playerName).map(([id, item]) => ({ id, text: item.text }));
  // With exactly five players, every full chain contains all players. To keep chain voting possible,
  // the player may vote on any chain except the one started by that player.
  const chains = Object.entries(catalogue).filter(([, item]) => item.type === "chain" && item.chain.starter !== playerName).map(([id, item], index) => ({ id, label: `Chain ${index + 1}`, original: item.chain.originalPhrase.text, final: item.chain.guessing2.text }));
  return { categories: VOTE_CATEGORIES, options: { bestDrawing: drawings, bestGuess: guesses, bestChain: chains, mostAccurate: drawings, biggestTwist: chains } };
}
function votingWinners(room) {
  const catalogue = voteCatalogue(room);
  const counts = Object.fromEntries(Object.keys(VOTE_CATEGORIES).map((key) => [key, {}]));
  for (const ballot of Object.values(room.voting.votes)) {
    for (const [category, optionId] of Object.entries(ballot)) counts[category][optionId] = (counts[category][optionId] || 0) + 1;
  }
  return Object.entries(counts).map(([category, options]) => {
    const maximum = Math.max(0, ...Object.values(options));
    const winners = Object.keys(options).filter((id) => options[id] === maximum).map((id) => {
      const item = catalogue[id];
      return { optionId: id, votes: maximum, authors: item.type === "chain" ? chainContributors(item.chain) : [item.owner] };
    });
    return { category, label: VOTE_CATEGORIES[category], winners };
  });
}
function finishVoting(code, room) {
  room.state = "voting-results";
  room.voting.results = votingWinners(room);
  io.to(code).emit("voting-results", { results: room.voting.results });
}
io.on("connection", (socket) => {
  socket.on("register-client", ({ roomCode, playerName, role }) => {
    const code = codeOf(roomCode);
    if (!code) return;
    socket.join(code);
    socket.data = { roomCode: code, playerName: nameOf(playerName), role };
  });
});

app.get("/", (_req, res) => {
  res.status(200).send("RAILWAY TEST OK");
});


app.get("/room", (req, res) => {
  const host = nameOf(req.query.host);
  if (!host) return res.status(400).json({ success: false, message: "Host name is required" });
  const code = newRoomCode();
  rooms[code] = { host, state: "lobby", theme: "Free", players: [], playerProfiles: {}, chains: {}, phaseDeadline: null, phaseTimer: null, results: null, voting: null };
  return res.json({ success: true, roomCode: code, profile: { name: host, avatar: "🎮", color: "#344054" }, themes: THEMES });
});

app.post("/join-room", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const player = nameOf(req.body.playerName);
  const room = rooms[code];
  if (!room) return res.status(404).json({ success: false, message: "Room not found" });
  if (room.state !== "lobby") return res.status(409).json({ success: false, message: "The game has already started" });
  if (!player) return res.status(400).json({ success: false, message: "Player name is required" });
  if (player.toLowerCase() === room.host.toLowerCase()) return res.status(409).json({ success: false, message: "That name belongs to the host" });
  if (!room.players.some((name) => name.toLowerCase() === player.toLowerCase())) {
    room.players.push(player);
    room.playerProfiles[player] = participantProfile(room, player, room.players.length - 1);
  }
  io.to(code).emit("players-updated", room.players);
  return res.json({ success: true, room: { players: room.players, theme: room.theme } });
});

app.post("/set-theme", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room) return res.status(404).json({ success: false, message: "Room not found" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can change the theme" });
  if (room.state !== "lobby") return res.status(409).json({ success: false, message: "The theme can only be changed in the lobby" });
  const theme = String(req.body.theme || "Free");
  if (!THEMES.includes(theme)) return res.status(400).json({ success: false, message: "Invalid theme" });
  room.theme = theme;
  io.to(code).emit("theme-updated", theme);
  return res.json({ success: true, theme });
});

app.post("/start-game", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room) return res.status(404).json({ success: false, message: "Room not found" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can start" });
  if (room.players.length < 5) return res.status(400).json({ success: false, message: "At least five players are required" });
  room.chains = buildChains(room.players);
  startTimedPhase(code, room, "phrase");
  return res.json({ success: true });
});

app.post("/submit-phase", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const player = nameOf(req.body.playerName);
  const room = rooms[code];
  if (!room) return res.status(404).json({ success: false, message: "Room not found" });
  if (!room.players.includes(player)) return res.status(403).json({ success: false, message: "Unauthorized player" });
  if (!PHASE_ORDER.includes(room.state) || room.state === "results") return res.status(409).json({ success: false, message: "Invalid phase" });
  const chain = assignmentFor(room, player, room.state);
  if (!chain) return res.status(500).json({ success: false, message: "Player assignment not found" });

  if (["phrase", "guessing1", "guessing2"].includes(room.state)) {
    const text = String(req.body.text || "").trim() || "No response submitted (time expired)";
    chain[room.state === "phrase" ? "originalPhrase" : room.state] = { author: player, text };
  } else {
    const image = String(req.body.image || "");
    if (!image.startsWith("data:image/png;base64,")) return res.status(400).json({ success: false, message: "Invalid PNG" });
    if (image.length > 7000000) return res.status(413).json({ success: false, message: "Drawing is too large" });
    chain[room.state] = { author: player, image };
  }

  emitProgress(code, room);
  return res.json({ success: true });
});

app.post("/next-phase", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room) return res.status(404).json({ success: false, message: "Room not found" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can advance" });
  const submitted = submittedPlayers(room, room.state);
  if (submitted.length !== room.players.length) return res.status(409).json({ success: false, message: "Some players are still missing" });
  const currentIndex = PHASE_ORDER.indexOf(room.state);
  const next = PHASE_ORDER[currentIndex + 1];
  if (next === "results") {
    if (room.phaseTimer) clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
    room.state = "results";
    room.phaseDeadline = null;
    room.results = { chainIndex: 0, revealCount: 1 };
    io.to(code).emit("results-updated", resultsPayload(room));
  } else {
    startTimedPhase(code, room, next);
  }
  return res.json({ success: true });
});

app.post("/results-action", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room || room.state !== "results") return res.status(409).json({ success: false, message: "Results phase is not active" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can control the results" });
  const action = req.body.action;
  if (action === "reveal" && room.results.revealCount < 5) room.results.revealCount += 1;
  if (action === "next-chain" && room.results.chainIndex < room.players.length - 1) {
    room.results.chainIndex += 1;
    room.results.revealCount = 1;
  }
  if (action === "previous-chain" && room.results.chainIndex > 0) {
    room.results.chainIndex -= 1;
    room.results.revealCount = 1;
  }
  io.to(code).emit("results-updated", resultsPayload(room));
  return res.json({ success: true });
});

app.post("/start-voting", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room || room.state !== "results") return res.status(409).json({ success: false, message: "Results phase is not active" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can start voting" });
  room.state = "voting";
  room.voting = { votes: {}, results: null };
  emitToRole(code, "host", "voting-started", { host: true, total: room.players.length });
  for (const player of room.players) emitToPlayer(code, player, "voting-started", ballotFor(room, player));
  io.to(code).emit("voting-progress", { submittedPlayers: [], total: room.players.length, complete: false });
  return res.json({ success: true });
});
app.post("/submit-vote", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const player = nameOf(req.body.playerName);
  const room = rooms[code];
  if (!room || room.state !== "voting") return res.status(409).json({ success: false, message: "Voting is not active" });
  if (!room.players.includes(player)) return res.status(403).json({ success: false, message: "Unauthorized player" });
  if (room.voting.votes[player]) return res.status(409).json({ success: false, message: "Vote already submitted" });
  const ballot = req.body.ballot || {};
  const eligible = ballotFor(room, player).options;
  for (const category of Object.keys(VOTE_CATEGORIES)) {
    if (!eligible[category].some((option) => option.id === ballot[category])) return res.status(400).json({ success: false, message: `Invalid selection for ${VOTE_CATEGORIES[category]}` });
  }
  room.voting.votes[player] = ballot;
  const submittedPlayers = Object.keys(room.voting.votes);
  const complete = submittedPlayers.length === room.players.length;
  io.to(code).emit("voting-progress", { submittedPlayers, total: room.players.length, complete });
  if (complete) finishVoting(code, room);
  return res.json({ success: true });
});
app.post("/close-voting", (req, res) => {
  const code = codeOf(req.body.roomCode);
  const room = rooms[code];
  if (!room || room.state !== "voting") return res.status(409).json({ success: false, message: "Voting is not active" });
  if (room.host !== nameOf(req.body.playerName)) return res.status(403).json({ success: false, message: "Only the host can close voting" });
  if (!Object.keys(room.voting.votes).length) return res.status(409).json({ success: false, message: "No votes have been submitted" });
  finishVoting(code, room);
  return res.json({ success: true });
});
app.get("/rooms", (_req, res) => {
  const safe = {};
  for (const [code, room] of Object.entries(rooms)) {
    safe[code] = { host: room.host, state: room.state, theme: room.theme, players: room.players, phaseDeadline: room.phaseDeadline };
  }
  res.json(safe);
});

app.use((req, res, next) => {
  if (
    req.path.startsWith("/socket.io") ||
    req.path.startsWith("/room") ||
    req.path.startsWith("/join-room") ||
    req.path.startsWith("/set-theme") ||
    req.path.startsWith("/start-game") ||
    req.path.startsWith("/submit-phase") ||
    req.path.startsWith("/next-phase") ||
    req.path.startsWith("/results-action") ||
    req.path.startsWith("/start-voting") ||
    req.path.startsWith("/submit-vote") ||
    req.path.startsWith("/close-voting") ||
    req.path.startsWith("/rooms")
  ) {
    return next();
  }

  return res.sendFile(
    path.join(
      DIST_PATH,
      "index.html"
    )
  );
});

server.listen(PORT,"0.0.0.0",() => {console.log(`Server running on port ${PORT}`);});
