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

const ADMIN_PASSWORD = 'admin123';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Upload setup
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

let questions = [];
let currentQuestionIndex = 0;
let quizActive = false;
let questionActive = false;
let participants = {};
let questionTimer = null;
let timeLeft = 30;

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.json({ success: false });
  res.json({ success: true, url: '/uploads/' + req.file.filename });
});

app.get('/qrcode', async (req, res) => {
  try {
    const qr = await QRCode.toDataURL(BASE_URL);
    res.json({ qr });
  } catch (e) {
    res.json({ qr: '' });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave</title>
<script src="/socket.io/socket.io.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460); min-height: 100vh; color: white; display: flex; align-items: center; justify-content: center; }
.container { text-align: center; padding: 20px; max-width: 550px; width: 100%; }
h1 { font-size: 2.5em; margin-bottom: 10px; color: #e94560; }
.subtitle { color: #a8b2d8; margin-bottom: 30px; }
input[type="text"] { width: 100%; padding: 15px; border-radius: 10px; border: 2px solid #e94560; background: rgba(255,255,255,0.1); color: white; font-size: 1.1em; margin-bottom: 15px; text-align: center; }
input::placeholder { color: #a8b2d8; }
button { width: 100%; padding: 15px; border-radius: 10px; border: none; background: #e94560; color: white; font-size: 1.1em; cursor: pointer; font-weight: bold; }
button:hover { background: #c73652; }

/* GET READY SCREEN */
#getready-screen {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(135deg, #0f3460, #1a1a2e);
  z-index: 999;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.getready-title {
  font-size: 3em;
  font-weight: bold;
  color: #e94560;
  animation: pulse 0.8s infinite;
  margin-bottom: 20px;
}
.getready-count {
  font-size: 8em;
  font-weight: bold;
  color: white;
  text-shadow: 0 0 30px #e94560;
  animation: countPop 1s ease-in-out;
}
@keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
@keyframes countPop { 0%{transform:scale(1.5);opacity:0} 100%{transform:scale(1);opacity:1} }

/* WAITING */
#waiting { display: none; text-align: center; padding: 30px; }
.waiting-spinner { font-size: 4em; animation: spin 2s linear infinite; display: inline-block; }
@keyframes spin { 100%{transform:rotate(360deg)} }

/* QUESTION */
#question-container { display: none; width: 100%; }
.question-box { background: rgba(255,255,255,0.08); border-radius: 20px; padding: 25px; }
.question-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.question-num { background: #e94560; border-radius: 20px; padding: 5px 15px; font-size: 0.9em; }
.timer-circle {
  width: 70px; height: 70px;
  border-radius: 50%;
  background: conic-gradient(#e94560 0%, rgba(255,255,255,0.1) 0%);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.5em; font-weight: bold;
  position: relative;
  transition: background 0.5s;
}
.timer-circle.urgent { animation: timerPulse 0.5s infinite; }
@keyframes timerPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.1)} }

.question-image { width: 100%; max-height: 200px; object-fit: cover; border-radius: 12px; margin-bottom: 15px; }
.question-text { font-size: 1.2em; margin-bottom: 20px; line-height: 1.5; }
.options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.option-btn {
  padding: 15px 10px; border-radius: 12px; border: none; cursor: pointer;
  font-size: 0.95em; font-weight: bold; transition: all 0.2s;
  position: relative; overflow: hidden;
}
.option-btn:nth-child(1) { background: #e74c3c; color: white; }
.option-btn:nth-child(2) { background: #3498db; color: white; }
.option-btn:nth-child(3) { background: #2ecc71; color: white; }
.option-btn:nth-child(4) { background: #f39c12; color: white; }
.option-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.option-btn.selected { border: 3px solid white; transform: scale(1.05); }
.option-btn:not(:disabled):hover { transform: scale(1.05); }

#result {
  margin-top: 15px; padding: 15px; border-radius: 12px;
  font-size: 1.1em; font-weight: bold; display: none;
  animation: slideIn 0.4s ease;
}
@keyframes slideIn { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
.correct { background: rgba(46,204,113,0.3); border: 2px solid #2ecc71; }
.wrong { background: rgba(231,76,60,0.3); border: 2px solid #e74c3c; }

/* POINTS ANIMATION */
.points-popup {
  position: fixed; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 3em; font-weight: bold; color: #2ecc71;
  animation: pointsAnim 1.5s ease forwards;
  pointer-events: none; z-index: 9999;
  text-shadow: 0 0 20px #2ecc71;
}
@keyframes pointsAnim {
  0%{transform:translate(-50%,-50%) scale(0.5);opacity:1}
  50%{transform:translate(-50%,-80%) scale(1.2);opacity:1}
  100%{transform:translate(-50%,-120%) scale(1);opacity:0}
}

/* LEADERBOARD */
#leaderboard-container { display: none; }
.leaderboard-item {
  background: rgba(255,255,255,0.08); border-radius: 12px;
  padding: 15px; margin-bottom: 10px;
  display: flex; justify-content: space-between; align-items: center;
  animation: slideIn 0.4s ease;
}
.leaderboard-item:nth-child(1) { border-left: 4px solid gold; }
.leaderboard-item:nth-child(2) { border-left: 4px solid silver; }
.leaderboard-item:nth-child(3) { border-left: 4px solid #cd7f32; }

/* PROGRESS BAR */
.progress-bar-container { background: rgba(255,255,255,0.1); border-radius: 10px; height: 8px; margin-bottom: 20px; }
.progress-bar { height: 100%; border-radius: 10px; background: #e94560; transition: width 1s linear; }
</style>
</head>
<body>
<div class="container">
  <!-- JOIN -->
  <div id="join-container">
    <h1>🌊 PollWave</h1>
    <p class="subtitle">Trete dem Quiz bei!</p>
    <input type="text" id="nameInput" placeholder="Dein Name..." maxlength="20">
    <button onclick="joinQuiz()">Beitreten 🚀</button>
  </div>

  <!-- WAITING -->
  <div id="waiting">
    <div class="waiting-spinner">⏳</div>
    <h2 style="margin-top:20px;">Warte auf den Start...</h2>
    <p style="color:#a8b2d8; margin-top:10px;">Das Quiz beginnt gleich!</p>
  </div>

  <!-- QUESTION -->
  <div id="question-container">
    <div class="progress-bar-container">
      <div class="progress-bar" id="progress-bar"></div>
    </div>
    <div class="question-box">
      <div class="question-header">
        <span class="question-num" id="question-num">Frage 1</span>
        <div class="timer-circle" id="timer-circle">30</div>
      </div>
      <img id="question-image" class="question-image" style="display:none;">
      <div class="question-text" id="question-text"></div>
      <div class="options" id="options"></div>
      <div id="result"></div>
    </div>
  </div>

  <!-- LEADERBOARD -->
  <div id="leaderboard-container">
    <h2 style="margin-bottom:20px; font-size:2em;">🏆 Ergebnis</h2>
    <div id="leaderboard-list"></div>
  </div>
</div>

<!-- GET READY SCREEN (fullscreen overlay) -->
<div id="getready-screen">
  <div class="getready-title">GET READY! 🚀</div>
  <div class="getready-count" id="getready-count">3</div>
</div>

<script>
const socket = io();
let myName = '';
let answered = false;
let totalQuestions = 0;

// ===== SOUNDS =====
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
}

function playBeep(freq = 440, duration = 0.15, type = 'sine', vol = 0.3) {
  try {
    initAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + duration);
  } catch(e) {}
}

function playCorrect() {
  playBeep(523, 0.1, 'sine', 0.3);
  setTimeout(() => playBeep(659, 0.1, 'sine', 0.3), 120);
  setTimeout(() => playBeep(784, 0.2, 'sine', 0.3), 240);
}

function playWrong() {
  playBeep(300, 0.15, 'sawtooth', 0.3);
  setTimeout(() => playBeep(200, 0.3, 'sawtooth', 0.3), 160);
}

function playCountdownBeep() {
  playBeep(880, 0.1, 'sine', 0.2);
}

function playStartSound() {
  playBeep(400, 0.1, 'sine', 0.2);
  setTimeout(() => playBeep(500, 0.1, 'sine', 0.2), 120);
  setTimeout(() => playBeep(600, 0.1, 'sine', 0.2), 240);
  setTimeout(() => playBeep(800, 0.3, 'sine', 0.3), 360);
}

// ===== GET READY COUNTDOWN =====
function showGetReady(callback) {
  const screen = document.getElementById('getready-screen');
  const countEl = document.getElementById('getready-count');
  screen.style.display = 'flex';
  let count = 3;
  countEl.textContent = count;
  playCountdownBeep();

  const interval = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(interval);
      countEl.textContent = '🚀';
      playStartSound();
      setTimeout(() => {
        screen.style.display = 'none';
        if (callback) callback();
      }, 600);
    } else {
      countEl.textContent = count;
      playCountdownBeep();
      countEl.style.animation = 'none';
      countEl.offsetHeight;
      countEl.style.animation = 'countPop 1s ease-in-out';
    }
  }, 1000);
}

// ===== JOIN =====
function joinQuiz() {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) { alert('Bitte gib deinen Namen ein!'); return; }
  initAudio();
  myName = name;
  socket.emit('join', { name });
  document.getElementById('join-container').style.display = 'none';
  document.getElementById('waiting').style.display = 'block';
}

// ===== SOCKET EVENTS =====
socket.on('quiz-starting', (data) => {
  totalQuestions = data.totalQuestions || 0;
  document.getElementById('waiting').style.display = 'none';
  showGetReady();
});

socket.on('question', (data) => {
  answered = false;
  totalQuestions = data.total || totalQuestions;

  document.getElementById('waiting').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'none';
  document.getElementById('question-container').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('result').className = '';

  // Progress bar
  const progress = ((data.index - 1) / totalQuestions) * 100;
  document.getElementById('progress-bar').style.width = progress + '%';

  document.getElementById('question-num').textContent = 'Frage ' + data.index + ' / ' + totalQuestions;

  // Timer
  const timerEl = document.getElementById('timer-circle');
  timerEl.textContent = data.timeLeft || 30;
  timerEl.style.color = 'white';
  timerEl.classList.remove('urgent');

  // Image
  const imgEl = document.getElementById('question-image');
  if (data.image) {
    imgEl.src = data.image;
    imgEl.style.display = 'block';
  } else {
    imgEl.style.display = 'none';
  }

  document.getElementById('question-text').textContent = data.question;

  const optionsDiv = document.getElementById('options');
  optionsDiv.innerHTML = '';
  data.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.onclick = () => submitAnswer(i, btn);
    optionsDiv.appendChild(btn);
  });
});

socket.on('timer', (data) => {
  const timerEl = document.getElementById('timer-circle');
  if (!timerEl) return;
  timerEl.textContent = data.timeLeft;

  // Timer circle color
  const pct = (data.timeLeft / 30) * 100;
  const color = data.timeLeft <= 5 ? '#ff0000' : '#e94560';
  timerEl.style.background = 'conic-gradient(' + color + ' ' + pct + '%, rgba(255,255,255,0.1) 0%)';

  if (data.timeLeft <= 5) {
    timerEl.classList.add('urgent');
    timerEl.style.color = '#ff0000';
    playCountdownBeep();
  }
});

socket.on('answer-result', (data) => {
  const result = document.getElementById('result');
  result.style.display = 'block';
  if (data.correct) {
    result.className = 'correct';
    result.textContent = '✅ Richtig!';
    playCorrect();
    showPointsPopup('+' + data.points);
  } else {
    result.className = 'wrong';
    result.textContent = '❌ Falsch! Richtige Antwort: ' + data.correctAnswer;
    playWrong();
  }
  document.querySelectorAll('.option-btn').forEach(btn => btn.disabled = true);
});

socket.on('question-ended', (data) => {
  if (!answered) {
    const result = document.getElementById('result');
    result.style.display = 'block';
    result.className = 'wrong';
    result.textContent = '⏰ Zeit abgelaufen! Richtige Antwort: ' + data.correctAnswer;
    playWrong();
    document.querySelectorAll('.option-btn').forEach(btn => btn.disabled = true);
  }
});

socket.on('leaderboard', (data) => {
  showLeaderboard(data.leaderboard, false);
});

socket.on('quiz-ended', (data) => {
  showLeaderboard(data.leaderboard, true);
});

socket.on('waiting', () => {
  document.getElementById('join-container').style.display = 'none';
  document.getElementById('question-container').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'none';
  document.getElementById('waiting').style.display = 'block';
});

// ===== HELPERS =====
function submitAnswer(index, btn) {
  if (answered) return;
  answered = true;
  initAudio();
  btn.classList.add('selected');
  document.querySelectorAll('.option-btn').forEach(b => b.disabled = true);
  socket.emit('answer', { answerIndex: index });
}

function showPointsPopup(text) {
  const div = document.createElement('div');
  div.className = 'points-popup';
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1500);
}

function showLeaderboard(list, isFinal) {
  document.getElementById('question-container').style.display = 'none';
  document.getElementById('waiting').style.display = 'none';
  document.getElementById('leaderboard-container').style.display = 'block';
  const medals = ['🥇', '🥈', '🥉'];
  const listEl = document.getElementById('leaderboard-list');
  listEl.innerHTML = isFinal ? '<h3 style="margin-bottom:15px; color:#e94560;">🏆 Endrangliste</h3>' : '<h3 style="margin-bottom:15px;">📊 Zwischenstand</h3>';
  list.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'leaderboard-item';
    div.innerHTML = '<span>' + (medals[i] || (i+1)+'.') + ' ' + p.name + '</span><span style="color:#e94560; font-weight:bold;">' + p.score + ' Pkt</span>';
    listEl.appendChild(div);
  });
}

document.getElementById('nameInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinQuiz();
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
<script src="/socket.io/socket.io.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: #1a1a2e; color: white; padding: 20px; }
h1 { color: #e94560; margin-bottom: 20px; text-align: center; font-size: 2em; }
h2 { color: #e94560; margin: 0 0 15px; }
.card { background: rgba(255,255,255,0.05); border-radius: 15px; padding: 20px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.08); }
input[type="text"], input[type="password"], select {
  width: 100%; padding: 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.08); color: white;
  margin-bottom: 10px; font-size: 0.95em;
}
input::placeholder { color: #a8b2d8; }
button { padding: 12px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 0.95em; font-weight: bold; margin: 4px; transition: all 0.2s; }
button:hover { opacity: 0.85; transform: scale(1.02); }
.btn-primary { background: #e94560; color: white; }
.btn-success { background: #2ecc71; color: white; }
.btn-danger { background: #e74c3c; color: white; }
.btn-info { background: #3498db; color: white; }
.btn-warning { background: #f39c12; color: white; }

.question-card {
  background: rgba(255,255,255,0.06); border-radius: 12px;
  padding: 20px; margin-bottom: 20px;
  border-left: 4px solid #e94560;
}
.question-card-header {
  display: flex; justify-content: space-between;
  align-items: center; margin-bottom: 15px;
}
.question-card-header h3 { color: #e94560; font-size: 1.1em; }
.options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.option-row { display: flex; align-items: center; gap: 8px; }
.option-row input[type="text"] { flex: 1; margin: 0; }
.option-row input[type="radio"] { width: 20px; height: 20px; margin: 0; cursor: pointer; accent-color: #2ecc71; flex-shrink: 0; }

/* Image Upload */
.image-upload-area {
  border: 2px dashed rgba(255,255,255,0.3);
  border-radius: 10px; padding: 15px; text-align: center;
  margin-top: 10px; cursor: pointer; transition: all 0.2s;
}
.image-upload-area:hover { border-color: #e94560; }
.image-upload-area input[type="file"] { display: none; }
.preview-img { max-width: 100%; max-height: 150px; border-radius: 8px; margin-top: 10px; object-fit: cover; }

/* Login */
#login-container { max-width: 400px; margin: 100px auto; text-align: center; }
#admin-container { display: none; max-width: 1000px; margin: 0 auto; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
.stat-box { background: rgba(255,255,255,0.08); border-radius: 12px; padding: 15px; text-align: center; }
.stat-number { font-size: 2em; font-weight: bold; color: #e94560; }
.stat-label { color: #a8b2d8; font-size: 0.85em; margin-top: 5px; }

/* Status */
.status-bar {
  border-radius: 10px; padding: 12px 20px; margin-bottom: 20px;
  text-align: center; font-weight: bold; font-size: 1.05em;
  background: rgba(46,204,113,0.15); border: 1px solid #2ecc71;
}
.status-bar.active { background: rgba(233,69,96,0.15); border-color: #e94560; }

/* Participants */
.participant-list { max-height: 220px; overflow-y: auto; }
.participant-item {
  background: rgba(255,255,255,0.05); border-radius: 8px;
  padding: 10px 15px; margin-bottom: 6px;
  display: flex; justify-content: space-between; align-items: center;
}

/* Controls */
.control-btns { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
</head>
<body>
<div id="login-container">
  <h1>🌊 PollWave Admin</h1>
  <div class="card">
    <input type="password" id="passwordInput" placeholder="Admin Passwort...">
    <button class="btn-primary" onclick="login()" style="width:100%; margin-top:5px;">Einloggen 🔐</button>
  </div>
</div>

<div id="admin-container">
  <h1>🌊 PollWave Admin Panel</h1>

  <div id="status-bar" class="status-bar">✅ Bereit - Warte auf Start</div>

  <div class="stats">
    <div class="stat-box"><div class="stat-number" id="stat-participants">0</div><div class="stat-label">Teilnehmer</div></div>
    <div class="stat-box"><div class="stat-number" id="stat-question">-</div><div class="stat-label">Frage</div></div>
    <div class="stat-box"><div class="stat-number" id="stat-timer">-</div><div class="stat-label">Timer</div></div>
    <div class="stat-box"><div class="stat-number" id="stat-answered">-</div><div class="stat-label">Geantwortet</div></div>
  </div>

  <div class="card">
    <h2>🎮 Quiz Steuerung</h2>
    <div class="control-btns">
      <button class="btn-success" id="startBtn" onclick="startQuiz()">▶️ Quiz Starten</button>
      <button class="btn-info" onclick="nextQuestion()">⏭️ Nächste Frage</button>
      <button class="btn-warning" onclick="pauseQuestion()">⏸️ Pause</button>
      <button class="btn-danger" onclick="endQuiz()">⏹️ Beenden</button>
    </div>
  </div>

  <div class="card">
    <h2>👥 Teilnehmer</h2>
    <div class="participant-list" id="participant-list">
      <p style="color:#a8b2d8; text-align:center;">Noch keine Teilnehmer</p>
    </div>
  </div>

  <div class="card">
    <h2>📝 Fragen erstellen</h2>
    <div style="display:flex; gap:10px; margin-bottom:15px;">
      <button class="btn-primary" onclick="saveQuestions()">💾 Speichern</button>
      <button class="btn-info" onclick="addQuestion()">➕ Frage hinzufügen</button>
    </div>
    <div id="questions-container"></div>
  </div>

  <div class="card">
    <h2>📱 QR Code</h2>
    <div style="text-align:center;">
      <img id="qrcode" style="border-radius:10px; background:white; padding:10px; max-width:200px;">
      <p style="margin-top:10px; color:#a8b2d8;">
        Link: <a href="${BASE_URL}" target="_blank" style="color:#e94560;">${BASE_URL}</a>
      </p>
    </div>
  </div>
</div>

<script>
const socket = io();
let questionCount = 0;
let imageUrls = {};

function login() {
  const pw = document.getElementById('passwordInput').value;
  if (pw === 'admin123') {
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('admin-container').style.display = 'block';
    socket.emit('admin-login', { password: pw });
    addQuestion();
    loadQR();
  } else {
    alert('Falsches Passwort!');
  }
}

function loadQR() {
  fetch('/qrcode').then(r => r.json()).then(d => {
    document.getElementById('qrcode').src = d.qr;
  });
}

function addQuestion() {
  const i = questionCount++;
  const container = document.getElementById('questions-container');
  const div = document.createElement('div');
  div.className = 'question-card';
  div.id = 'q-' + i;
  div.innerHTML = \`
    <div class="question-card-header">
      <h3>❓ Frage \${i + 1}</h3>
      <button class="btn-danger" style="padding:6px 12px; font-size:0.85em;" onclick="removeQuestion(\${i})">🗑️ Löschen</button>
    </div>
    <input type="text" id="question-\${i}" placeholder="Frage eingeben...">
    <div class="options-grid">
      \${['A','B','C','D'].map((opt, j) => \`
        <div class="option-row">
          <input type="radio" name="correct-\${i}" value="\${j}" id="radio-\${i}-\${j}" \${j===0?'checked':''}>
          <label for="radio-\${i}-\${j}" style="color:#2ecc71; min-width:25px; cursor:pointer;">\${opt}</label>
          <input type="text" id="option-\${i}-\${j}" placeholder="Option \${opt}...">
        </div>
      \`).join('')}
    </div>
    <div class="image-upload-area" onclick="document.getElementById('img-input-\${i}').click()">
      <input type="file" id="img-input-\${i}" accept="image/*" onchange="uploadImage(\${i}, this)">
      <span id="img-label-\${i}">📸 Bild hinzufügen (optional)</span>
      <img id="img-preview-\${i}" class="preview-img" style="display:none;">
    </div>
  \`;
  container.appendChild(div);
}

function removeQuestion(i) {
  const el = document.getElementById('q-' + i);
  if (el) el.remove();
}

async function uploadImage(i, input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('image', file);
  const label = document.getElementById('img-label-' + i);
  label.textContent = '⏳ Wird hochgeladen...';
  try {
    const res = await fetch('/upload-image', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      imageUrls[i] = data.url;
      label.textContent = '✅ Bild hochgeladen!';
      const preview = document.getElementById('img-preview-' + i);
      preview.src = data.url;
      preview.style.display = 'block';
    } else {
      label.textContent = '❌ Upload fehlgeschlagen';
    }
  } catch(e) {
    label.textContent = '❌ Fehler beim Upload';
  }
}

function saveQuestions() {
  const cards = document.querySelectorAll('.question-card');
  const qs = [];
  cards.forEach((card) => {
    const id = card.id.replace('q-', '');
    const qText = document.getElementById('question-' + id)?.value.trim();
    if (!qText) return;
    const options = [];
    for (let j = 0; j < 4; j++) {
      options.push(document.getElementById('option-' + id + '-' + j)?.value.trim() || '');
    }
    const correctRadio = document.querySelector('input[name="correct-' + id + '"]:checked');
    const correct = correctRadio ? parseInt(correctRadio.value) : 0;
    qs.push({ question: qText, options, correct, image: imageUrls[id] || null });
  });
  if (qs.length === 0) { alert('Bitte mindestens eine Frage eingeben!'); return; }
  socket.emit('set-questions', { questions: qs });
  alert('✅ ' + qs.length + ' Fragen gespeichert!');
}

function startQuiz() { socket.emit('start-quiz'); }
function nextQuestion() { socket.emit('next-question'); }
function pauseQuestion() { socket.emit('pause-question'); }
function endQuiz() { if (confirm('Quiz wirklich beenden?')) socket.emit('end-quiz'); }

socket.on('admin-update', (data) => {
  document.getElementById('stat-participants').textContent = data.participants ?? 0;
  document.getElementById('stat-question').textContent = data.currentQuestion ?? '-';
  document.getElementById('stat-timer').textContent = data.timeLeft ?? '-';
  document.getElementById('stat-answered').textContent = data.answered ?? '-';

  const bar = document.getElementById('status-bar');
  if (data.status) {
    bar.textContent = data.status;
    bar.className = data.quizActive ? 'status-bar active' : 'status-bar';
  }

  if (data.participantList) {
    const list = document.getElementById('participant-list');
    if (data.participantList.length === 0) {
      list.innerHTML = '<p style="color:#a8b2d8; text-align:center;">Noch keine Teilnehmer</p>';
    } else {
      list.innerHTML = '';
      data.participantList.forEach((p, i) => {
        const medals = ['🥇','🥈','🥉'];
        const div = document.createElement('div');
        div.className = 'participant-item';
        div.innerHTML = '<span>' + (medals[i] || (i+1)+'.') + ' ' + p.name + '</span><span style="color:#e94560; font-weight:bold;">' + p.score + ' Pkt</span>';
        list.appendChild(div);
      });
    }
  }
});

socket.on('timer', (data) => {
  document.getElementById('stat-timer').textContent = data.timeLeft;
});

document.getElementById('passwordInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') login();
});
</script>
</body>
</html>`);
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', (data) => {
    const name = (data.name || 'Anonym').trim().slice(0, 20);
    participants[socket.id] = { name, score: 0, answered: false };
    socket.emit('joined', { name });

    if (quizActive && questionActive) {
      socket.emit('question', {
        index: currentQuestionIndex + 1,
        total: questions.length,
        question: questions[currentQuestionIndex].question,
        options: questions[currentQuestionIndex].options,
        image: questions[currentQuestionIndex].image || null,
        timeLeft
      });
    } else {
      socket.emit('waiting');
    }
    broadcastAdminUpdate();
  });

  socket.on('admin-login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      socket.join('admin');
      broadcastAdminUpdate();
    }
  });

  socket.on('set-questions', (data) => {
    questions = data.questions || [];
    console.log('Questions set:', questions.length);
  });

  socket.on('start-quiz', () => {
    if (questions.length === 0) return;
    quizActive = true;
    currentQuestionIndex = 0;
    Object.keys(participants).forEach(id => {
      participants[id].score = 0;
      participants[id].answered = false;
    });
    // Tell everyone quiz is starting (GET READY screen)
    io.emit('quiz-starting', { totalQuestions: questions.length });
    // Wait 4 seconds for GET READY countdown, then start
    setTimeout(() => startQuestion(), 4000);
  });

  socket.on('next-question', () => {
    if (!quizActive) return;
    clearTimer();
    currentQuestionIndex++;
    if (currentQuestionIndex >= questions.length) {
      endQuizFinal();
    } else {
      startQuestion();
    }
  });

  socket.on('pause-question', () => {
    if (questionTimer) {
      clearInterval(questionTimer);
      questionTimer = null;
    }
  });

  socket.on('end-quiz', () => {
    clearTimer();
    endQuizFinal();
  });

  socket.on('answer', (data) => {
    if (!quizActive || !questionActive) return;
    const p = participants[socket.id];
    if (!p || p.answered) return;
    p.answered = true;

    const q = questions[currentQuestionIndex];
    const correct = data.answerIndex === q.correct;
    const points = correct ? Math.round(100 * (timeLeft / 30)) + 50 : 0;
    if (correct) p.score += points;

    socket.emit('answer-result', {
      correct,
      points,
      correctAnswer: q.options[q.correct]
    });

    broadcastAdminUpdate();
  });

  socket.on('disconnect', () => {
    delete participants[socket.id];
    broadcastAdminUpdate();
  });
});

function startQuestion() {
  if (currentQuestionIndex >= questions.length) { endQuizFinal(); return; }
  questionActive = true;
  timeLeft = 30;

  Object.keys(participants).forEach(id => { participants[id].answered = false; });

  const q = questions[currentQuestionIndex];
  io.emit('question', {
    index: currentQuestionIndex + 1,
    total: questions.length,
    question: q.question,
    options: q.options,
    image: q.image || null,
    timeLeft: 30
  });

  broadcastAdminUpdate();

  questionTimer = setInterval(() => {
    timeLeft--;
    io.emit('timer', { timeLeft });

    if (timeLeft <= 0) {
      clearTimer();
      questionActive = false;
      io.emit('question-ended', {
        correctAnswer: questions[currentQuestionIndex].options[questions[currentQuestionIndex].correct]
      });
      broadcastAdminUpdate();

      // Auto-advance nach 3 Sekunden
      setTimeout(() => {
        currentQuestionIndex++;
        if (currentQuestionIndex >= questions.length) {
          endQuizFinal();
        } else {
          startQuestion();
        }
      }, 3000);
    }
  }, 1000);
}

function clearTimer() {
  if (questionTimer) { clearInterval(questionTimer); questionTimer = null; }
}

function endQuizFinal() {
  quizActive = false;
  questionActive = false;
  clearTimer();
  const leaderboard = Object.values(participants)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
  io.emit('quiz-ended', { leaderboard });
  broadcastAdminUpdate();
}

function broadcastAdminUpdate() {
  const list = Object.values(participants).sort((a, b) => b.score - a.score);
  const answered = list.filter(p => p.answered).length;
  io.to('admin').emit('admin-update', {
    participants: list.length,
    participantList: list.map(p => ({ name: p.name, score: p.score })),
    currentQuestion: quizActive ? (currentQuestionIndex + 1) + '/' + questions.length : '-',
    timeLeft,
    answered: quizActive ? answered + '/' + list.length : '-',
    status: quizActive ? '🟢 Quiz läuft - Frage ' + (currentQuestionIndex + 1) : '✅ Bereit',
    quizActive
  });
}

server.listen(PORT, () => {
  console.log('PollWave running on port', PORT);
});
