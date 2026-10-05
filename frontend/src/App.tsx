import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_BASE =
  import.meta.env.VITE_API_URL ||
  window.location.origin;

const socket = io(API_BASE);
type Phase = "lobby" | "phrase" | "drawing1" | "guessing1" | "drawing2" | "guessing2" | "results" | "voting" | "voting-results";
type Tool = "pen" | "eraser";
type Task = { kind: "text"; prompt: string; theme?: string } | { kind: "drawing"; prompt: string } | { kind: "guess"; image: string };
type ResultEntry = { type: "text" | "image"; label: string; value: string };
type Results = { chainNumber: number; totalChains: number; entries: ResultEntry[]; canRevealMore: boolean; canNextChain: boolean; allRevealed: boolean; isLastChain: boolean };
type VoteOption = { id: string; image?: string; prompt?: string; text?: string; label?: string; original?: string; final?: string };
type VotingData = { categories: Record<string, string>; options: Record<string, VoteOption[]> };
type VotingResult = { category: string; label: string; winners: { optionId: string; votes: number; authors: string[] }[] };

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const textRef = useRef("");
  const sentRef = useRef(false);
  const autoRef = useRef(false);

  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [players, setPlayers] = useState<string[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [task, setTask] = useState<Task | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [submitters, setSubmitters] = useState<string[]>([]);
  const [complete, setComplete] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [votingData, setVotingData] = useState<VotingData | null>(null);
  const [ballot, setBallot] = useState<Record<string, string>>({});
  const [votingResults, setVotingResults] = useState<VotingResult[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#172033");
  const [size, setSize] = useState(5);
  const [connected, setConnected] = useState(socket.connected);
  const [theme, setTheme] = useState("Free");
  const themes = ["Free", "Animals", "Movies", "Technology", "Office", "PMI", "Data", "Absurd"];

  useEffect(() => {
    const onPlayers = (value: string[]) => setPlayers(value);
    const onPhase = ({ phase, deadline, task }: { phase: Phase; deadline: number; task?: Task }) => {
      sentRef.current = false; autoRef.current = false; textRef.current = "";
      setPhase(phase); setDeadline(deadline); setTask(task || null); if (task?.kind === "text" && task.theme) setTheme(task.theme); setText(""); setSent(false); setSubmitters([]); setComplete(false);
    };
    const onProgress = ({ submittedPlayers, complete }: { submittedPlayers: string[]; complete: boolean }) => {
      setSubmitters(submittedPlayers); setComplete(complete);
    };
    const onResults = (payload: Results) => { setDeadline(null); setPhase("results"); setResults(payload); };
    socket.on("players-updated", onPlayers);
    socket.on("theme-updated", setTheme);
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("phase-started", onPhase);
    socket.on("phase-progress", onProgress);
    socket.on("results-updated", onResults);
    socket.on("voting-started", (payload: VotingData & { host?: boolean }) => {
      setPhase("voting"); setDeadline(null); setSubmitters([]); setComplete(false); setSent(false); setBallot({});
      setVotingData(payload.host ? null : payload);
    });
    socket.on("voting-progress", ({ submittedPlayers, complete }: { submittedPlayers: string[]; complete: boolean }) => {
      setSubmitters(submittedPlayers); setComplete(complete);
    });
    socket.on("voting-results", ({ results }: { results: VotingResult[] }) => {
      setPhase("voting-results"); setVotingResults(results);
    });
    return () => {
      socket.off("players-updated", onPlayers); socket.off("theme-updated", setTheme); socket.off("connect"); socket.off("disconnect"); socket.off("phase-started", onPhase);
      socket.off("phase-progress", onProgress); socket.off("results-updated", onResults);
      socket.off("voting-started"); socket.off("voting-progress"); socket.off("voting-results");
    };
  }, []);

  useEffect(() => {
    const label = phase === "lobby" ? "Lobby" : phase.replace("drawing", "Drawing ").replace("guessing", "Guess ").replace("phrase", "Phrase").replace("results", "Results");
    document.title = `${isHost ? "HOST" : playerName || "Player"} | ${label} | Data Doodle`;
  }, [phase, isHost, playerName]);

  useEffect(() => {
    if (!task || task.kind !== "drawing" || isHost) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round"; context.lineJoin = "round";
  }, [task, isHost]);

  const post = async (path: string, body: object) => {
    const response = await fetch(`${API_BASE}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unexpected error");
    return data;
  };

  const submitCurrent = async (automatic = false) => {
    if (sentRef.current || isHost || phase === "lobby" || phase === "results") return;
    const payload: Record<string, string> = { roomCode, playerName: playerName.trim() };
    if (task?.kind === "drawing") {
      const image = canvasRef.current?.toDataURL("image/png");
      if (!image) return;
      payload.image = image;
    } else {
      const fallback = phase.startsWith("guessing") ? "No guess submitted (time expired)" : "No phrase submitted (time expired)";
      payload.text = textRef.current.trim() || fallback;
      if (!automatic && !textRef.current.trim()) return alert("Please enter a response");
    }
    await post("submit-phase", payload);
    sentRef.current = true; setSent(true);
  };

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0 && !isHost && !autoRef.current) {
        autoRef.current = true;
        void submitCurrent(true).catch((error) => alert(error.message));
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline, isHost, phase, roomCode, playerName, task]);

  const register = (code: string, name: string, role: "host" | "player") => socket.emit("register-client", { roomCode: code, playerName: name, role });
  const createRoom = async () => {
    const name = playerName.trim(); if (!name) return alert("Enter your name");
    const response = await fetch(`${API_BASE}/room?host=${encodeURIComponent(name)}`);
    const data = await response.json(); if (!response.ok) return alert(data.message);
    setRoomCode(data.roomCode); setPlayers([]); setIsHost(true); register(data.roomCode, name, "host");
  };
  const joinRoom = async () => {
    const name = playerName.trim(); const code = joinCode.trim().toUpperCase();
    if (!name || !code) return alert("Enter name and room code");
    try {
      const data = await post("join-room", { roomCode: code, playerName: name });
      setRoomCode(code); setPlayers(data.room.players); setTheme(data.room.theme || "Free"); setIsHost(false); register(code, name, "player");
    } catch (error) { alert((error as Error).message); }
  };
  const hostAction = async (path: string, extra = {}) => {
    try { await post(path, { roomCode, playerName: playerName.trim(), ...extra }); }
    catch (error) { alert((error as Error).message); }
  };

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  };
  const startStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const context = canvas?.getContext("2d"); if (!canvas || !context || sent) return;
    canvas.setPointerCapture(event.pointerId); const point = canvasPoint(event); drawingRef.current = true; context.beginPath(); context.moveTo(point.x, point.y);
  };
  const drawStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = canvasRef.current?.getContext("2d"); if (!context || !drawingRef.current || sent) return;
    const point = canvasPoint(event); context.strokeStyle = tool === "eraser" ? "#fff" : color;
    context.lineWidth = tool === "eraser" ? Math.max(size * 2, 18) : size; context.lineTo(point.x, point.y); context.stroke();
  };
  const stopStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
    drawingRef.current = false;
  };
  const clearCanvas = () => {
    const canvas = canvasRef.current; const context = canvas?.getContext("2d"); if (!canvas || !context) return;
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  };

  const submitVotes = async () => {
    if (!votingData) return;
    const required = Object.keys(votingData.categories);
    if (required.some((category) => !ballot[category])) return alert("Please select one option in every category");
    try {
      await post("submit-vote", { roomCode, playerName: playerName.trim(), ballot });
      setSent(true);
    } catch (error) { alert((error as Error).message); }
  };
  const phaseLabel: Record<string, string> = { phrase: "PHRASE", drawing1: "DRAWING 1", guessing1: "GUESS 1", drawing2: "DRAWING 2", guessing2: "FINAL GUESS", results: "RESULTS", voting: "VOTING", "voting-results": "VOTING RESULTS" };
  const avatars = ["🦊", "🐼", "🐙", "🦁", "🦉", "🐸", "🐯", "🐨", "🦄", "🐧"];
  const colors = ["#5b4bdb", "#10b981", "#f97316", "#ec4899", "#0ea5e9", "#8b5cf6", "#14b8a6", "#ef4444"];
  const identityFor = (name: string) => {
    const hash = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return { avatar: avatars[hash % avatars.length], color: colors[hash % colors.length] };
  };
  const identity = isHost ? { avatar: "🎮", color: "#344054" } : identityFor(playerName || "Player");
  const setRoomTheme = async (value: string) => {
    setTheme(value);
    try { await post("set-theme", { roomCode, playerName: playerName.trim(), theme: value }); }
    catch (error) { alert((error as Error).message); }
  };
  const header = roomCode ? <div className="identity-bar" style={{ borderColor: identity.color }}>
    <span>{identity.avatar} <strong>{isHost ? `HOST · ${playerName}` : playerName}</strong></span>
    <span>{phase === "lobby" ? "LOBBY" : phaseLabel[phase]}</span>
    <span>Room {roomCode}</span>
  </div> : null;
  const footer = roomCode ? <div className="diagnostic-bar"><span>v0.5</span><span>{connected ? "🟢 Connected" : "🟠 Reconnecting"}</span><span>{identity.avatar} {playerName}</span></div> : null;
  const progress = <div className="progress-wrap"><div className="progress-track"><div className="progress-fill" style={{ width: `${players.length ? (submitters.length / players.length) * 100 : 0}%` }} /></div><strong>{submitters.length} / {players.length}</strong></div>;
  const page = (content: React.ReactNode) => <>{header}{content}{footer}</>;

  const timer = <div className={`countdown ${seconds <= 5 ? "urgent" : ""}`}>⏱️ {seconds}s</div>;

  if (phase === "voting-results") return page(
    <div className="container results-container">
      <div className="phase-badge">VOTING RESULTS</div><h1>🏆 Voting Results</h1>
      <div className="voting-results-grid">{votingResults.map((result) => (
        <div className="result-card" key={result.category}><h3>{result.label}</h3>
          {result.winners.length ? result.winners.map((winner, index) => <p className="result-text" key={`${winner.optionId}-${index}`}>{winner.authors.join(", ")} · {winner.votes} vote{winner.votes === 1 ? "" : "s"}</p>) : <p>No votes</p>}
        </div>
      ))}</div>
    </div>
  );
  if (phase === "voting") return page(
    <div className="container results-container">
      <div className="phase-badge">VOTING</div><h1>🗳️ Vote for your favourites</h1>
      {isHost ? <><p>Waiting for players to submit their votes.</p>{progress}<button className="secondary-button" onClick={() => hostAction("close-voting")}>Close voting now</button></>
      : sent ? <><h2>✅ Vote submitted</h2>{progress}<p>Waiting for the other players...</p></>
      : votingData ? <><div className="voting-grid">{Object.entries(votingData.categories).map(([category, label]) => (
        <section className="vote-category" key={category}><h2>{label}</h2><div className="vote-options">
          {votingData.options[category].map((option) => <button type="button" key={option.id} className={`vote-option ${ballot[category] === option.id ? "selected" : ""}`} onClick={() => setBallot({ ...ballot, [category]: option.id })}>
            {option.image && <img src={option.image} alt="Voting option" />}
            {option.prompt && <small>Prompt: {option.prompt}</small>}
            {option.text && <strong>{option.text}</strong>}
            {option.original && <><strong>{option.label}</strong><small>{option.original} → {option.final}</small></>}
          </button>)}
        </div></section>
      ))}</div><button className="create-button" onClick={() => void submitVotes()}>Submit votes</button></> : <p>Loading ballot...</p>}
    </div>
  );
  if (phase === "results" && results) return page(
    <div className="container results-container">
      <div className="phase-badge">RESULTS</div><h1>🎉 Chain {results.chainNumber} of {results.totalChains}</h1>
      <div className="results-flow">{results.entries.map((entry, index) => (
        <div className="result-card" key={`${entry.label}-${index}`}><h3>{entry.label}</h3>
          {entry.type === "image" ? <img src={entry.value} alt={entry.label} /> : <p className="result-text">{entry.value}</p>}
        </div>
      ))}</div>
      {isHost && <div className="result-actions">
        <button className="secondary-button" onClick={() => hostAction("results-action", { action: "previous-chain" })}>Previous chain</button>
        {results.canRevealMore ? <button className="create-button" onClick={() => hostAction("results-action", { action: "reveal" })}>Reveal next</button>
          : results.canNextChain ? <button className="create-button" onClick={() => hostAction("results-action", { action: "next-chain" })}>Next chain</button>
          : <button className="create-button" onClick={() => hostAction("start-voting")}>Start voting</button>}
      </div>}
    </div>
  );

  if (phase !== "lobby" && isHost) return page(
    <div className="container game-container"><div className="phase-badge">HOST · {phaseLabel[phase]}</div><h1>🎮 Game Control</h1>{timer}
      <p>Room {roomCode}</p><ul>{players.map((player) => { const id = identityFor(player); return <li key={player}><span className="avatar-dot" style={{ background: id.color }}>{id.avatar}</span>{submitters.includes(player) ? "✅" : "⏳"} {player}</li>; })}</ul>
      <h2>{submitters.length} / {players.length}</h2>{progress}<p>responses received</p>
      {complete && <button className="create-button" onClick={() => hostAction("next-phase")}>{phase === "guessing2" ? "Show results" : "Next phase"}</button>}
    </div>
  );

  if (phase !== "lobby") return page(
    <div className={`container ${task?.kind === "drawing" ? "drawing-container" : "game-container"}`}>
      <div className="phase-badge">{phaseLabel[phase]}</div><h1>{task?.kind === "drawing" ? "🎨 Draw" : task?.kind === "guess" ? "🔍 Guess" : "✍️ Write"}</h1>{timer}
      {!sent ? <>
        {task?.kind === "drawing" && <><p>Draw this phrase:</p><h2>{task.prompt}</h2>
          <div className="drawing-toolbar"><div className="tool-group">
            <button className={`tool-button ${tool === "pen" ? "active" : ""}`} onClick={() => setTool("pen")}>✏️ Pen</button>
            <button className={`tool-button ${tool === "eraser" ? "active" : ""}`} onClick={() => setTool("eraser")}>🧽 Eraser</button></div>
            <label className="toolbar-control">Color <input type="color" value={color} disabled={tool === "eraser"} onChange={(e) => setColor(e.target.value)} /></label>
            <label className="toolbar-control size-control">Brush size <input type="range" min="2" max="24" value={size} onChange={(e) => setSize(Number(e.target.value))} /><strong>{size}px</strong></label>
          </div>
          <canvas ref={canvasRef} width={900} height={520} className={`drawing-canvas ${tool === "eraser" ? "eraser-cursor" : ""}`}
            onPointerDown={startStroke} onPointerMove={drawStroke} onPointerUp={stopStroke} onPointerCancel={stopStroke} onPointerLeave={stopStroke} />
          <div className="drawing-actions"><button className="secondary-button" onClick={clearCanvas}>🗑️ Clear canvas</button><button className="create-button" onClick={() => void submitCurrent()}>Submit drawing</button></div></>}
        {task?.kind === "guess" && <><p>What does this drawing represent?</p><img className="guess-image" src={task.image} alt="Drawing to guess" />
          <input className="input-room" value={text} placeholder="Write your guess" onChange={(e) => { textRef.current = e.target.value; setText(e.target.value); }} />
          <br /><br /><button className="create-button" onClick={() => void submitCurrent()}>Submit guess</button></>}
        {task?.kind === "text" && <><p>{task.prompt}</p><input className="input-room" value={text} onChange={(e) => { textRef.current = e.target.value; setText(e.target.value); }} />
          <div className="text-actions single-action"><button className="create-button" onClick={() => void submitCurrent()}>Submit phrase</button></div></>}
      </> : <><h2>✅ Submitted</h2>{progress}<p>Waiting for the other players...</p></>}
    </div>
  );

  return page(
    <div className="container"><div className="title">✏️ Data Doodle</div>
      <input className="input-room" placeholder="Your name" value={playerName} onChange={(e) => setPlayerName(e.target.value)} /><br /><br />
      <button className="create-button" onClick={createRoom}>Create room as host</button><hr />
      <input className="input-room" placeholder="Room code" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
      <button className="join-button" onClick={joinRoom}>Join as player</button>
      {roomCode && <><hr /><h2>Room {roomCode}</h2><h3>Players</h3>{players.length ? <ul>{players.map((p) => { const id = identityFor(p); return <li key={p}><span className="avatar-dot" style={{ background: id.color }}>{id.avatar}</span>✅ {p}</li>; })}</ul> : <p>Waiting for players...</p>}
        {isHost && <><label className="theme-picker">Theme<select value={theme} onChange={(e) => void setRoomTheme(e.target.value)}>{themes.map((value) => <option key={value}>{value}</option>)}</select></label><button className="create-button" onClick={() => hostAction("start-game")}>Start Game</button></>}</>}
    </div>
  );
}

export default App;
