const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

let quizState = {
  questions: [],
  currentQuestion: -1,
  isActive: false,
  participants: {},
  questionTimer: null,
  isPaused: false,
  timeLeft: 30,
  questionDuration: 30
};

// ==================== HTML PAGES ====================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { 
  font-family: 'Segoe UI', sans-serif; 
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  min-height: 100vh; color: white; display: flex; align-items: center; justify-content: center;
}
.container { text-align: center; padding: 20px; max-width: 500px; width: 100%; }
.logo { font-size: 3em; font-weight: 900; background: linear-gradient(45deg, #e94560, #0f3460, #533483);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 10px; }
.subtitle { color: #a0aec0; margin-bottom: 40px; font-size: 1.1em; }
.card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px);
  border-radius: 20px; padding: 40px; border: 1px solid rgba(255,255,255,0.1); }
input { width: 100%; padding: 15px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.1); color: white; font-size: 1.1em; margin-bottom: 15px;
  text-align: center; letter-spacing: 3px; text-transform: uppercase; outline: none; }
input::placeholder { color: rgba(255,255,255,0.4); letter-spacing: 1px; text-transform: none; }
input:focus { border-color: #e94560; }
.btn { width: 100%; padding: 15px; border-radius: 12px; border: none; 
  background: linear-gradient(45deg, #e94560, #533483); color: white;
  font-size: 1.1em; font-weight: 700; cursor: pointer; transition: all 0.3s; }
.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(233,69,96,0.4); }
.name-input { letter-spacing: 0 !important; text-transform: none !important; }

/* Waiting Screen */
#waitingScreen { display: none; }
.pulse { animation: pulse 2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.participant-count { font-size: 3em; font-weight: 900; color: #e94560; }

/* Get Ready */
#getReadyScreen { display: none; position: fixed; inset: 0; 
  background: linear-gradient(135deg, #1a1a2e, #0f3460);
  z-index: 1000; align-items: center; justify-content: center; flex-direction: column; }
.countdown-number { font-size: 15em; font-weight: 900; color: #e94560; 
  animation: countAnim 1s ease-in-out; }
@keyframes countAnim { 0% { transform: scale(1.5); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }

/* Question Screen */
#questionScreen { display: none; }
.timer-circle { width: 80px; height: 80px; border-radius: 50%; 
  background: conic-gradient(#e94560 0deg, rgba(255,255,255,0.1) 0deg);
  display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;
  font-size: 1.5em; font-weight: 900; transition: background 0.1s; }
.timer-circle.urgent { animation: timerPulse 0.5s infinite; }
@keyframes timerPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.1); } }
.question-text { font-size: 1.4em; font-weight: 700; margin-bottom: 25px; 
  background: rgba(255,255,255,0.05); padding: 20px; border-radius: 15px; }
.question-img { max-width: 100%; border-radius: 15px; margin-bottom: 20px; max-height: 200px; object-fit: cover; }
.options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.option-btn { padding: 18px; border-radius: 15px; border: none; font-size: 1em; 
  font-weight: 600; cursor: pointer; transition: all 0.2s; color: white; }
.option-btn:nth-child(1) { background: linear-gradient(135deg, #e74c3c, #c0392b); }
.option-btn:nth-child(2) { background: linear-gradient(135deg, #3498db, #2980b9); }
.option-btn:nth-child(3) { background: linear-gradient(135deg, #f39c12, #e67e22); }
.option-btn:nth-child(4) { background: linear-gradient(135deg, #27ae60, #229954); }
.option-btn:hover:not(:disabled) { transform: scale(1.05); }
.option-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.option-btn.correct { animation: correctPulse 0.5s; box-shadow: 0 0 30px #27ae60; }
.option-btn.wrong { animation: shake 0.5s; }
@keyframes correctPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.1); } }
@keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-10px); } 75% { transform: translateX(10px); } }
.progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); 
  border-radius: 3px; margin-bottom: 20px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #e94560, #533483); 
  transition: width 0.3s; }

/* Points popup */
.points-popup { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 4em; font-weight: 900; color: #27ae60; z-index: 999;
  animation: pointsAnim 1.5s forwards; pointer-events: none; }
@keyframes pointsAnim { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  50% { opacity: 1; transform: translate(-50%, -80%) scale(1.2); }
  100% { opacity: 0; transform: translate(-50%, -120%) scale(1); } }

/* Results */
#resultsScreen { display: none; }
.score-display { font-size: 4em; font-weight: 900; color: #e94560; }
.score-label { color: #a0aec0; margin-bottom: 20px; }

/* Leaderboard */
#leaderboardScreen { display: none; }
.leaderboard-item { display: flex; align-items: center; padding: 15px; 
  background: rgba(255,255,255,0.05); border-radius: 12px; margin-bottom: 10px; }
.rank { font-size: 1.5em; margin-right: 15px; }
.lb-name { flex: 1; font-weight: 600; }
.lb-score { color: #e94560; font-weight: 700; font-size: 1.2em; }
</style>
</head>
<body>
<div class="container">

  <!-- Join Screen -->
  <div id="joinScreen">
    <div class="logo">PollWave</div>
    <div class="subtitle">Live Quiz Platform</div>
    <div class="card">
      <h2 style="margin-bottom:25px">🎮 Spiel beitreten</h2>
      <input type="text" id="roomCode" placeholder="Raum-Code eingeben" maxlength="6">
      <input type="text" id="playerName" class="name-input" placeholder="Dein Name" maxlength="20">
      <button class="btn" onclick="joinGame()">Beitreten →</button>
    </div>
  </div>

  <!-- Waiting Screen -->
  <div id="waitingScreen">
    <div class="logo">PollWave</div>
    <div class="card">
      <div style="font-size:3em;margin-bottom:15px">⏳</div>
      <h2 class="pulse">Warte auf den Start...</h2>
      <p style="color:#a0aec0;margin-top:10px" id="waitingInfo">Du bist verbunden!</p>
      <div style="margin-top:20px">
        <div class="participant-count" id="participantCount">1</div>
        <div style="color:#a0aec0">Teilnehmer bereit</div>
      </div>
    </div>
  </div>

  <!-- Get Ready Screen -->
  <div id="getReadyScreen" style="display:none;position:fixed;inset:0;background:linear-gradient(135deg,#1a1a2e,#0f3460);z-index:1000;display:none;align-items:center;justify-content:center;flex-direction:column;">
    <div style="color:#a0aec0;font-size:1.5em;margin-bottom:20px">Mach dich bereit!</div>
    <div class="countdown-number" id="getReadyNumber">3</div>
    <div style="color:#a0aec0;margin-top:20px">Das Quiz beginnt gleich...</div>
  </div>

  <!-- Question Screen -->
  <div id="questionScreen">
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
      <span id="questionCounter" style="color:#a0aec0">Frage 1/5</span>
      <span id="playerScore" style="color:#e94560;font-weight:700">0 Punkte</span>
    </div>
    <div class="timer-circle" id="timerCircle">
      <span id="timerText">30</span>
    </div>
    <img id="questionImg" class="question-img" style="display:none" src="" alt="Frage Bild">
    <div class="question-text" id="questionText">Frage lädt...</div>
    <div class="options-grid" id="optionsGrid"></div>
  </div>

  <!-- Results Screen -->
  <div id="resultsScreen">
    <div class="card">
      <div id="resultEmoji" style="font-size:3em;margin-bottom:15px">🤔</div>
      <h2 id="resultTitle">Ergebnis</h2>
      <div class="score-display" id="pointsEarned">+0</div>
      <div class="score-label">Punkte verdient</div>
      <div style="margin-top:20px;padding:15px;background:rgba(255,255,255,0.05);border-radius:12px">
        <div style="color:#a0aec0">Gesamtpunkte</div>
        <div style="font-size:2em;font-weight:700" id="totalScore">0</div>
      </div>
      <p style="color:#a0aec0;margin-top:15px" class="pulse">Nächste Frage kommt...</p>
    </div>
  </div>

  <!-- Leaderboard Screen -->
  <div id="leaderboardScreen">
    <div class="logo">🏆 Ergebnis</div>
    <div class="card" style="margin-top:20px">
      <div id="leaderboardList"></div>
    </div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
let myName = '';
let myScore = 0;
let answered = false;
let currentTimeLeft = 30;
let timerInterval = null;
let audioCtx = null;
let bgMusicInterval = null;

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ====== BACKGROUND MUSIC ======
function startBackgroundMusic() {
  stopBackgroundMusic();
  let beat = 0;
  const ctx = getAudioContext();
  
  function playBeat() {
    const notes = [261, 329, 392, 329, 261, 329, 392, 523];
    const note = notes[beat % notes.length];
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.frequency.value = note;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    
    beat++;
  }
  
  playBeat();
  bgMusicInterval = setInterval(playBeat, 400);
}

function stopBackgroundMusic() {
  if (bgMusicInterval) {
    clearInterval(bgMusicInterval);
    bgMusicInterval = null;
  }
}

function playSound(type) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'correct') {
      osc.frequency.value = 523;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } else if (type === 'wrong') {
      osc.frequency.value = 150;
      osc.type = 'sawtooth';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
    } else if (type === 'countdown') {
      osc.frequency.value = 440;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } else if (type === 'start') {
      osc.frequency.value = 659;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.start(); osc.stop(ctx.currentTime + 0.8);
    }
  } catch(e) {}
}

function showScreen(id) {
  ['joinScreen','waitingScreen','getReadyScreen','questionScreen','resultsScreen','leaderboardScreen']
    .forEach(s => {
      const el = document.getElementById(s);
      if (el) el.style.display = 'none';
    });
  const target = document.getElementById(id);
  if (target) target.style.display = id === 'getReadyScreen' ? 'flex' : 'block';
}

function joinGame() {
  const code = document.getElementById('roomCode').value.trim().toUpperCase();
  const name = document.getElementById('playerName').value.trim();
  if (!code || !name) { alert('Bitte Code und Name eingeben!'); return; }
  myName = name;
  socket.emit('joinRoom', { roomCode: code, playerName: name });
}

socket.on('joinSuccess', () => {
  showScreen('waitingScreen');
});

socket.on('joinError', (msg) => {
  alert(msg);
});

socket.on('participantCount', (count) => {
  const el = document.getElementById('participantCount');
  if (el) el.textContent = count;
});

socket.on('getReady', () => {
  showScreen('getReadyScreen');
  playSound('start');
  let count = 3;
  document.getElementById('getReadyNumber').textContent = count;
  const interval = setInterval(() => {
    count--;
    playSound('countdown');
    if (count <= 0) {
      clearInterval(interval);
      return;
    }
    document.getElementById('getReadyNumber').textContent = count;
  }, 1000);
});

socket.on('newQuestion', (data) => {
  answered = false;
  currentTimeLeft = data.timeLimit || 30;
  stopBackgroundMusic();
  showScreen('questionScreen');
  
  // Start background music
  startBackgroundMusic();

  // Progress bar
  const total = data.totalQuestions || 1;
  const current = data.questionIndex + 1;
  document.getElementById('progressFill').style.width = ((current / total) * 100) + '%';
  document.getElementById('questionCounter').textContent = 'Frage ' + current + '/' + total;
  document.getElementById('playerScore').textContent = myScore + ' Punkte';

  // Question image
  const imgEl = document.getElementById('questionImg');
  if (data.image) {
    imgEl.src = data.image;
    imgEl.style.display = 'block';
  } else {
    imgEl.style.display = 'none';
  }

  document.getElementById('questionText').textContent = data.question;

  // Options
  const grid = document.getElementById('optionsGrid');
  grid.innerHTML = '';
  data.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.onclick = () => submitAnswer(i, btn);
    grid.appendChild(btn);
  });

  // Timer
  clearInterval(timerInterval);
  updateTimerCircle(currentTimeLeft, data.timeLimit || 30);
  
  timerInterval = setInterval(() => {
    currentTimeLeft--;
    updateTimerCircle(currentTimeLeft, data.timeLimit || 30);
    
    if (currentTimeLeft <= 5 && currentTimeLeft > 0) {
      playSound('countdown');
    }
    
    if (currentTimeLeft <= 0) {
      clearInterval(timerInterval);
      stopBackgroundMusic();
    }
  }, 1000);
});

function updateTimerCircle(timeLeft, total) {
  const circle = document.getElementById('timerCircle');
  const text = document.getElementById('timerText');
  const pct = (timeLeft / total) * 360;
  const color = timeLeft <= 5 ? '#ff0000' : '#e94560';
  circle.style.background = 'conic-gradient(' + color + ' ' + pct + 'deg, rgba(255,255,255,0.1) ' + pct + 'deg)';
  text.textContent = timeLeft;
  if (timeLeft <= 5) {
    circle.classList.add('urgent');
  } else {
    circle.classList.remove('urgent');
  }
}

function submitAnswer(index, btn) {
  if (answered) return;
  answered = true;
  clearInterval(timerInterval);
  stopBackgroundMusic();
  
  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach(b => b.disabled = true);
  
  socket.emit('submitAnswer', { answerIndex: index, timeLeft: currentTimeLeft });
}

socket.on('answerResult', (data) => {
  const buttons = document.querySelectorAll('.option-btn');
  
  if (data.correct) {
    playSound('correct');
    buttons[data.correctIndex]?.classList.add('correct');
    myScore += data.points;
    
    // Points popup
    const popup = document.createElement('div');
    popup.className = 'points-popup';
    popup.textContent = '+' + data.points;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 1500);
    
    document.getElementById('pointsEarned').textContent = '+' + data.points;
    document.getElementById('resultEmoji').textContent = '✅';
    document.getElementById('resultTitle').textContent = 'Richtig!';
  } else {
    playSound('wrong');
    if (answered) buttons.forEach((b, i) => { if (i === data.correctIndex) b.style.opacity = '1'; });
    document.getElementById('pointsEarned').textContent = '+0';
    document.getElementById('resultEmoji').textContent = '❌';
    document.getElementById('resultTitle').textContent = 'Falsch!';
  }
  
  document.getElementById('totalScore').textContent = myScore;
  
  setTimeout(() => showScreen('resultsScreen'), 800);
});

socket.on('timeUp', (data) => {
  clearInterval(timerInterval);
  stopBackgroundMusic();
  if (!answered) {
    answered = true;
    document.getElementById('pointsEarned').textContent = '+0';
    document.getElementById('resultEmoji').textContent = '⏰';
    document.getElementById('resultTitle').textContent = 'Zeit abgelaufen!';
    document.getElementById('totalScore').textContent = myScore;
    setTimeout(() => showScreen('resultsScreen'), 500);
  }
});

socket.on('showLeaderboard', (data) => {
  stopBackgroundMusic();
  showScreen('leaderboardScreen');
  const list = document.getElementById('leaderboardList');
  list.innerHTML = '';
  const medals = ['🥇','🥈','🥉'];
  data.leaderboard.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'leaderboard-item';
    item.innerHTML = '<span class="rank">' + (medals[i] || (i+1)+'.' ) + '</span>' +
      '<span class="lb-name">' + p.name + '</span>' +
      '<span class="lb-score">' + p.score + ' Pts</span>';
    list.appendChild(item);
  });
});

socket.on('quizEnd', () => {
  stopBackgroundMusic();
});
</script>
</body>
</html>`);
});

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave Admin</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: white; }
.header { background: linear-gradient(135deg, #e94560, #533483); padding: 20px 30px;
  display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 1.8em; }
.main { padding: 30px; max-width: 1200px; margin: 0 auto; }
.card { background: #1a1a2e; border-radius: 15px; padding: 25px; margin-bottom: 20px;
  border: 1px solid rgba(255,255,255,0.1); }
.card h2 { margin-bottom: 20px; color: #e94560; }
input, textarea, select { width: 100%; padding: 12px; border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.05);
  color: white; font-size: 1em; margin-bottom: 12px; outline: none; }
input:focus, textarea:focus { border-color: #e94560; }
.btn { padding: 12px 25px; border-radius: 10px; border: none; cursor: pointer;
  font-size: 1em; font-weight: 600; transition: all 0.2s; margin-right: 10px; margin-bottom: 10px; }
.btn-primary { background: linear-gradient(45deg, #e94560, #533483); color: white; }
.btn-success { background: linear-gradient(45deg, #27ae60, #229954); color: white; }
.btn-warning { background: linear-gradient(45deg, #f39c12, #e67e22); color: white; }
.btn-danger { background: linear-gradient(45deg, #e74c3c, #c0392b); color: white; }
.btn:hover { transform: translateY(-2px); opacity: 0.9; }
.options-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.question-item { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px;
  margin-bottom: 15px; border-left: 4px solid #e94560; position: relative; }
.question-item h3 { margin-bottom: 10px; }
.delete-btn { position: absolute; top: 15px; right: 15px; background: #e74c3c;
  border: none; color: white; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
.stat-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; text-align: center; }
.stat-number { font-size: 2.5em; font-weight: 900; color: #e94560; }
.stat-label { color: #a0aec0; font-size: 0.9em; }
.room-code { font-size: 3em; font-weight: 900; color: #e94560; letter-spacing: 8px; 
  text-align: center; padding: 20px; background: rgba(233,69,96,0.1); border-radius: 12px; }
#qrCode { text-align: center; margin-top: 15px; }
.login-screen { display: flex; align-items: center; justify-content: center; 
  min-height: 100vh; }
.login-card { background: #1a1a2e; border-radius: 20px; padding: 40px; 
  width: 100%; max-width: 400px; text-align: center; }
.correct-badge { background: #27ae60; color: white; padding: 2px 8px; 
  border-radius: 6px; font-size: 0.8em; margin-left: 5px; }
.timer-setting { display: flex; align-items: center; gap: 10px; margin-bottom: 15px; }
.timer-setting label { color: #a0aec0; white-space: nowrap; }
.timer-setting input { margin-bottom: 0; width: 80px; text-align: center; }
</style>
</head>
<body>

<div id="loginScreen" class="login-screen">
  <div class="login-card">
    <div style="font-size:3em;margin-bottom:15px">🔐</div>
    <h2 style="margin-bottom:25px">Admin Login</h2>
    <input type="password" id="adminPassword" placeholder="Passwort" 
      onkeypress="if(event.key==='Enter')checkPassword()">
    <button class="btn btn-primary" style="width:100%" onclick="checkPassword()">Einloggen</button>
  </div>
</div>

<div id="adminPanel" style="display:none">
  <div class="header">
    <h1>🎮 PollWave Admin</h1>
    <div id="headerStats" style="color:rgba(255,255,255,0.8)">Bereit</div>
  </div>
  
  <div class="main">
    
    <!-- Room Info -->
    <div class="card">
      <h2>📡 Raum-Info</h2>
      <div class="room-code" id="roomCodeDisplay">X3PL2U</div>
      <div id="qrCode"></div>
      <div style="text-align:center;margin-top:15px;color:#a0aec0">
        Teilnehmer-Link: <strong id="participantLink"></strong>
      </div>
    </div>

    <!-- Stats -->
    <div class="card">
      <h2>📊 Live Stats</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-number" id="statParticipants">0</div>
          <div class="stat-label">Teilnehmer</div>
        </div>
        <div class="stat-card">
          <div class="stat-number" id="statAnswered">0/0</div>
          <div class="stat-label">Beantwortet</div>
        </div>
        <div class="stat-card">
          <div class="stat-number" id="statQuestion">-</div>
          <div class="stat-label">Aktuelle Frage</div>
        </div>
        <div class="stat-card">
          <div class="stat-number" id="statTimeLeft">-</div>
          <div class="stat-label">Zeit übrig</div>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <div class="card">
      <h2>🎛️ Steuerung</h2>
      <button class="btn btn-success" onclick="startQuiz()" id="startBtn">▶ Quiz Starten</button>
      <button class="btn btn-warning" onclick="pauseQuiz()" id="pauseBtn">⏸ Pause</button>
      <button class="btn btn-primary" onclick="nextQuestion()" id="nextBtn">⏭ Nächste Frage</button>
      <button class="btn btn-danger" onclick="resetQuiz()">🔄 Reset</button>
    </div>

    <!-- Add Question -->
    <div class="card">
      <h2>➕ Frage hinzufügen</h2>
      
      <div class="timer-setting">
        <label>⏱️ Timer (Sekunden):</label>
        <input type="number" id="questionTimer" value="30" min="5" max="120">
      </div>
      
      <textarea id="questionText" placeholder="Frage eingeben..." rows="3"></textarea>
      
      <div style="margin-bottom:12px">
        <label style="color:#a0aec0;display:block;margin-bottom:8px">📸 Bild (optional):</label>
        <input type="file" id="questionImage" accept="image/*" style="color:#a0aec0">
      </div>
      
      <div class="options-row">
        <input type="text" id="opt0" placeholder="Option A">
        <input type="text" id="opt1" placeholder="Option B">
        <input type="text" id="opt2" placeholder="Option C">
        <input type="text" id="opt3" placeholder="Option D">
      </div>
      
      <div style="margin-bottom:15px">
        <label style="color:#a0aec0;display:block;margin-bottom:8px">✅ Richtige Antwort:</label>
        <select id="correctAnswer">
          <option value="0">Option A</option>
          <option value="1">Option B</option>
          <option value="2">Option C</option>
          <option value="3">Option D</option>
        </select>
      </div>
      
      <button class="btn btn-primary" onclick="addQuestion()">➕ Frage hinzufügen</button>
    </div>

    <!-- Question List -->
    <div class="card">
      <h2>📋 Fragen (<span id="questionCount">0</span>)</h2>
      <div id="questionList"></div>
    </div>

  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
let questions = [];
let isLoggedIn = false;

function checkPassword() {
  const pwd = document.getElementById('adminPassword').value;
  if (pwd === 'admin123') {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    isLoggedIn = true;
    init();
  } else {
    alert('Falsches Passwort!');
  }
}

function init() {
  const link = window.location.origin;
  document.getElementById('participantLink').textContent = link;
  
  // QR Code
  fetch('/qr?url=' + encodeURIComponent(link))
    .then(r => r.text())
    .then(svg => document.getElementById('qrCode').innerHTML = svg);
    
  socket.emit('adminConnect', { password: 'admin123' });
}

socket.on('statsUpdate', (data) => {
  document.getElementById('statParticipants').textContent = data.participants || 0;
  document.getElementById('statAnswered').textContent = (data.answered || 0) + '/' + (data.participants || 0);
  document.getElementById('statQuestion').textContent = data.currentQuestion >= 0 ? (data.currentQuestion + 1) : '-';
  document.getElementById('statTimeLeft').textContent = data.timeLeft >= 0 ? data.timeLeft + 's' : '-';
  document.getElementById('headerStats').textContent = (data.participants || 0) + ' Teilnehmer online';
});

function addQuestion() {
  const text = document.getElementById('questionText').value.trim();
  const opts = [
    document.getElementById('opt0').value.trim(),
    document.getElementById('opt1').value.trim(),
    document.getElementById('opt2').value.trim(),
    document.getElementById('opt3').value.trim()
  ];
  const correct = parseInt(document.getElementById('correctAnswer').value);
  const timer = parseInt(document.getElementById('questionTimer').value) || 30;
  
  if (!text || opts.some(o => !o)) {
    alert('Bitte Frage und alle Optionen ausfüllen!');
    return;
  }
  
  const imageFile = document.getElementById('questionImage').files[0];
  
  if (imageFile) {
    const formData = new FormData();
    formData.append('image', imageFile);
    fetch('/upload', { method: 'POST', body: formData })
      .then(r => r.json())
      .then(data => {
        questions.push({ text, options: opts, correct, image: data.url, timeLimit: timer });
        renderQuestions();
        clearQuestionForm();
      });
  } else {
    questions.push({ text, options: opts, correct, image: null, timeLimit: timer });
    renderQuestions();
    clearQuestionForm();
  }
}

function clearQuestionForm() {
  document.getElementById('questionText').value = '';
  document.getElementById('opt0').value = '';
  document.getElementById('opt1').value = '';
  document.getElementById('opt2').value = '';
  document.getElementById('opt3').value = '';
  document.getElementById('questionImage').value = '';
  document.getElementById('questionTimer').value = '30';
  document.getElementById('correctAnswer').value = '0';
}

function renderQuestions() {
  document.getElementById('questionCount').textContent = questions.length;
  const list = document.getElementById('questionList');
  list.innerHTML = '';
  questions.forEach((q, i) => {
    const div = document.createElement('div');
    div.className = 'question-item';
    div.innerHTML = '<h3>Frage ' + (i+1) + ': ' + q.text + 
      ' <span style="color:#a0aec0;font-size:0.8em">(⏱️ ' + (q.timeLimit || 30) + 's)</span></h3>' +
      (q.image ? '<img src="' + q.image + '" style="max-height:80px;border-radius:8px;margin-bottom:8px">' : '') +
      q.options.map((o, j) => '<span style="display:inline-block;margin:3px;padding:5px 10px;background:rgba(255,255,255,0.05);border-radius:6px">' + 
        o + (j === q.correct ? '<span class="correct-badge">✓</span>' : '') + '</span>').join('') +
      '<button class="delete-btn" onclick="deleteQuestion(' + i + ')">🗑️</button>';
    list.appendChild(div);
  });
}

function deleteQuestion(i) {
  questions.splice(i, 1);
  renderQuestions();
}

function startQuiz() {
  if (questions.length === 0) { alert('Füge erst Fragen hinzu!'); return; }
  socket.emit('startQuiz', { questions, password: 'admin123' });
}

function pauseQuiz() {
  socket.emit('pauseQuiz', { password: 'admin123' });
}

function nextQuestion() {
  socket.emit('nextQuestion', { password: 'admin123' });
}

function resetQuiz() {
  if (confirm('Quiz wirklich zurücksetzen?')) {
    socket.emit('resetQuiz', { password: 'admin123' });
    questions = [];
    renderQuestions();
  }
}

document.getElementById('adminPassword').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') checkPassword();
});
</script>
</body>
</html>`);
});

app.get('/qr', async (req, res) => {
  const url = req.query.url || 'https://pollwave-4kda.onrender.com';
  const svg = await QRCode.toString(url, { type: 'svg', width: 200 });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    if (roomCode !== 'X3PL2U') {
      socket.emit('joinError', 'Falscher Raum-Code!');
      return;
    }
    if (quizState.isActive) {
      socket.emit('joinError', 'Quiz läuft bereits!');
      return;
    }
    quizState.participants[socket.id] = { name: playerName, score: 0, answered: false };
    socket.join('quiz');
    socket.emit('joinSuccess');
    
    const count = Object.keys(quizState.participants).length;
    io.to('quiz').emit('participantCount', count);
    broadcastStats();
  });

  socket.on('adminConnect', ({ password }) => {
    if (password === 'admin123') {
      socket.join('admin');
      broadcastStats();
    }
  });

  socket.on('startQuiz', ({ questions, password }) => {
    if (password !== 'admin123') return;
    quizState.questions = questions;
    quizState.currentQuestion = -1;
    quizState.isActive = true;
    quizState.isPaused = false;
    
    // Get Ready countdown
    io.to('quiz').emit('getReady');
    
    setTimeout(() => {
      nextQuestion();
    }, 3000);
  });

  socket.on('pauseQuiz', ({ password }) => {
    if (password !== 'admin123') return;
    quizState.isPaused = !quizState.isPaused;
    if (quizState.isPaused) {
      clearInterval(quizState.questionTimer);
    } else {
      startTimer();
    }
  });

  socket.on('nextQuestion', ({ password }) => {
    if (password !== 'admin123') return;
    clearInterval(quizState.questionTimer);
    nextQuestion();
  });

  socket.on('resetQuiz', ({ password }) => {
    if (password !== 'admin123') return;
    clearInterval(quizState.questionTimer);
    quizState = {
      questions: [], currentQuestion: -1, isActive: false,
      participants: {}, questionTimer: null, isPaused: false,
      timeLeft: 30, questionDuration: 30
    };
    broadcastStats();
  });

  socket.on('submitAnswer', ({ answerIndex, timeLeft }) => {
    const participant = quizState.participants[socket.id];
    if (!participant || participant.answered) return;
    
    const q = quizState.questions[quizState.currentQuestion];
    if (!q) return;
    
    participant.answered = true;
    const correct = answerIndex === q.correct;
    const duration = q.timeLimit || 30;
    const points = correct ? Math.round(100 * (timeLeft / duration)) + 50 : 0;
    
    if (correct) participant.score += points;
    
    socket.emit('answerResult', { 
      correct, 
      points, 
      correctIndex: q.correct 
    });
    
    broadcastStats();
  });

  socket.on('disconnect', () => {
    delete quizState.participants[socket.id];
    const count = Object.keys(quizState.participants).length;
    io.to('quiz').emit('participantCount', count);
    broadcastStats();
  });
});

function nextQuestion() {
  quizState.currentQuestion++;
  
  if (quizState.currentQuestion >= quizState.questions.length) {
    endQuiz();
    return;
  }

  // Reset answered status
  Object.values(quizState.participants).forEach(p => p.answered = false);

  const q = quizState.questions[quizState.currentQuestion];
  quizState.timeLeft = q.timeLimit || 30;
  quizState.questionDuration = q.timeLimit || 30;

  io.to('quiz').emit('newQuestion', {
    question: q.text,
    options: q.options,
    image: q.image || null,
    timeLimit: q.timeLimit || 30,
    questionIndex: quizState.currentQuestion,
    totalQuestions: quizState.questions.length
  });

  broadcastStats();
  startTimer();
}

function startTimer() {
  clearInterval(quizState.questionTimer);
  quizState.questionTimer = setInterval(() => {
    if (quizState.isPaused) return;
    quizState.timeLeft--;
    broadcastStats();
    
    if (quizState.timeLeft <= 0) {
      clearInterval(quizState.questionTimer);
      io.to('quiz').emit('timeUp', { correctIndex: quizState.questions[quizState.currentQuestion]?.correct });
      
      setTimeout(() => {
        nextQuestion();
      }, 3000);
    }
  }, 1000);
}

function endQuiz() {
  quizState.isActive = false;
  clearInterval(quizState.questionTimer);
  
  const leaderboard = Object.values(quizState.participants)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ name: p.name, score: p.score }));
  
  io.to('quiz').emit('showLeaderboard', { leaderboard });
  io.to('quiz').emit('quizEnd');
  broadcastStats();
}

function broadcastStats() {
  const participants = Object.values(quizState.participants);
  const answered = participants.filter(p => p.answered).length;
  
  io.to('admin').emit('statsUpdate', {
    participants: participants.length,
    answered,
    currentQuestion: quizState.currentQuestion,
    timeLeft: quizState.timeLeft
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('PollWave läuft auf Port ' + PORT);
});
