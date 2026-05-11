const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_PASSWORD = 'admin123';
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

let quizState = {
  questions: [],
  currentQuestion: 0,
  active: false,
  phase: 'waiting',
  participants: {},
  timer: 30,
  timerInterval: null
};

// Admin Login Page
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave Admin</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea, #764ba2); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.box { background: white; padding: 40px; border-radius: 20px; width: 350px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
h1 { color: #667eea; margin-bottom: 10px; font-size: 28px; }
p { color: #666; margin-bottom: 25px; }
input { width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 10px; font-size: 16px; margin-bottom: 15px; }
button { width: 100%; padding: 12px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; }
button:hover { opacity: 0.9; }
</style>
</head>
<body>
<div class="box">
<h1>🌊 PollWave</h1>
<p>Admin Login</p>
<form action="/admin/login" method="POST">
<input type="password" name="password" placeholder="Passwort eingeben..." required>
<button type="submit">Einloggen</button>
</form>
</div>
</body>
</html>`);
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.redirect('/admin/dashboard');
  } else {
    res.redirect('/admin?error=1');
  }
});

// Admin Dashboard
app.get('/admin/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: #f0f2f5; }
.header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
.header h1 { font-size: 24px; }
.container { max-width: 900px; margin: 30px auto; padding: 0 20px; }
.card { background: white; border-radius: 15px; padding: 25px; margin-bottom: 20px; box-shadow: 0 5px 20px rgba(0,0,0,0.08); }
.card h2 { color: #333; margin-bottom: 20px; font-size: 20px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
.stat { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; border-radius: 12px; text-align: center; }
.stat .num { font-size: 32px; font-weight: bold; }
.stat .label { font-size: 13px; opacity: 0.9; }
.question-form { margin-bottom: 15px; }
.question-form input { width: 100%; padding: 10px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; margin-bottom: 8px; }
.options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
.option-wrap { display: flex; align-items: center; gap: 5px; }
.option-wrap input[type=text] { flex: 1; padding: 8px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 13px; }
.option-wrap input[type=radio] { width: 18px; height: 18px; cursor: pointer; }
.option-label { font-size: 12px; color: #666; white-space: nowrap; }
.btn { padding: 12px 25px; border: none; border-radius: 10px; font-size: 15px; cursor: pointer; font-weight: bold; }
.btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); color: white; width: 100%; margin-top: 10px; }
.btn-green { background: #4CAF50; color: white; }
.btn-red { background: #f44336; color: white; }
.btn-blue { background: #2196F3; color: white; }
.controls { display: flex; gap: 10px; flex-wrap: wrap; }
.qr-section { text-align: center; }
.qr-section img { max-width: 200px; border: 3px solid #667eea; border-radius: 10px; margin: 10px; }
.join-link { background: #f5f5f5; padding: 10px; border-radius: 8px; font-family: monospace; font-size: 14px; word-break: break-all; }
.status { padding: 10px 15px; border-radius: 8px; margin-bottom: 15px; font-weight: bold; }
.status.waiting { background: #fff3cd; color: #856404; }
.status.active { background: #d4edda; color: #155724; }
#participants-list { max-height: 300px; overflow-y: auto; }
.participant { display: flex; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
.participant:last-child { border-bottom: none; }
</style>
</head>
<body>
<div class="header">
<h1>🌊 PollWave Admin</h1>
<span id="live-status">⚫ Wartend</span>
</div>
<div class="container">

<div class="stats">
<div class="stat">
<div class="num" id="stat-participants">0</div>
<div class="label">Teilnehmer</div>
</div>
<div class="stat">
<div class="num" id="stat-question">0/0</div>
<div class="label">Frage</div>
</div>
<div class="stat">
<div class="num" id="stat-timer">30</div>
<div class="label">Sekunden</div>
</div>
</div>

<div class="card">
<h2>📱 QR Code & Link</h2>
<div class="qr-section">
<img id="qr-img" src="/qr-image" alt="QR Code">
<div class="join-link">${BASE_URL}/vote</div>
</div>
</div>

<div class="card">
<h2>🎮 Quiz Steuerung</h2>
<div id="quiz-status" class="status waiting">⏸ Quiz wartet auf Start</div>
<div class="controls">
<button class="btn btn-green" onclick="startQuiz()">▶ Quiz Starten</button>
<button class="btn btn-blue" onclick="nextQuestion()">⏭ Nächste Frage</button>
<button class="btn btn-red" onclick="stopQuiz()">⏹ Quiz Stoppen</button>
</div>
</div>

<div class="card">
<h2>👥 Teilnehmer Live</h2>
<div id="participants-list"><p style="color:#999;text-align:center">Noch keine Teilnehmer</p></div>
</div>

<div class="card">
<h2>❓ Fragen eingeben (20 Fragen)</h2>
<form id="questions-form">
${Array.from({length: 20}, (_, i) => `
<div class="question-form">
<strong style="color:#667eea">Frage ${i+1}:</strong>
<input type="text" name="q${i}" placeholder="Frage ${i+1} eingeben...">
<div class="options-grid">
<div class="option-wrap"><input type="radio" name="correct${i}" value="0"><span class="option-label">✓</span><input type="text" name="q${i}o0" placeholder="Option A"></div>
<div class="option-wrap"><input type="radio" name="correct${i}" value="1"><span class="option-label">✓</span><input type="text" name="q${i}o1" placeholder="Option B"></div>
<div class="option-wrap"><input type="radio" name="correct${i}" value="2"><span class="option-label">✓</span><input type="text" name="q${i}o2" placeholder="Option C"></div>
<div class="option-wrap"><input type="radio" name="correct${i}" value="3"><span class="option-label">✓</span><input type="text" name="q${i}o3" placeholder="Option D"></div>
</div>
<small style="color:#999">☝️ Radio-Button = richtige Antwort</small>
</div>`).join('')}
<button type="button" class="btn btn-primary" onclick="saveQuestions()">💾 Fragen Speichern</button>
</form>
</div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();

socket.on('quiz-update', (state) => {
  document.getElementById('stat-participants').textContent = Object.keys(state.participants || {}).length;
  document.getElementById('stat-question').textContent = state.currentQuestion + '/' + state.questions.length;
  document.getElementById('stat-timer').textContent = state.timer || 30;
  
  const statusEl = document.getElementById('quiz-status');
  const liveEl = document.getElementById('live-status');
  
  if (state.active) {
    statusEl.className = 'status active';
    statusEl.textContent = '▶ Quiz läuft - Frage ' + (state.currentQuestion) + ' von ' + state.questions.length;
    liveEl.textContent = '🟢 Live';
  } else {
    statusEl.className = 'status waiting';
    statusEl.textContent = '⏸ Quiz wartet auf Start';
    liveEl.textContent = '⚫ Wartend';
  }
  
  const pList = document.getElementById('participants-list');
  const parts = Object.values(state.participants || {});
  if (parts.length === 0) {
    pList.innerHTML = '<p style="color:#999;text-align:center">Noch keine Teilnehmer</p>';
  } else {
    parts.sort((a,b) => b.score - a.score);
    pList.innerHTML = parts.map((p, i) => 
      '<div class="participant"><span>' + (i+1) + '. ' + p.name + '</span><span><strong>' + p.score + ' Pkt</strong></span></div>'
    ).join('');
  }
});

function saveQuestions() {
  const form = document.getElementById('questions-form');
  const questions = [];
  for (let i = 0; i < 20; i++) {
    const q = form.querySelector('[name=q' + i + ']').value.trim();
    if (!q) continue;
    const opts = [0,1,2,3].map(j => form.querySelector('[name=q' + i + 'o' + j + ']').value.trim());
    const correctEl = form.querySelector('[name=correct' + i + ']:checked');
    const correct = correctEl ? parseInt(correctEl.value) : 0;
    if (opts.some(o => !o)) { alert('Frage ' + (i+1) + ': Alle 4 Optionen ausfüllen!'); return; }
    questions.push({ question: q, options: opts, correct: correct });
  }
  if (questions.length === 0) { alert('Mindestens 1 Frage eingeben!'); return; }
  socket.emit('save-questions', questions);
  alert('✅ ' + questions.length + ' Fragen gespeichert!');
}

function startQuiz() { socket.emit('start-quiz'); }
function nextQuestion() { socket.emit('next-question'); }
function stopQuiz() { if(confirm('Quiz wirklich stoppen?')) socket.emit('stop-quiz'); }
</script>
</body>
</html>`);
});

// QR Code Image
app.get('/qr-image', async (req, res) => {
  try {
    const url = BASE_URL + '/vote';
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    const base64 = qr.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(img);
  } catch (e) {
    res.status(500).send('QR Error');
  }
});

// Vote Page
app.get('/vote', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PollWave - Mitmachen</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea, #764ba2); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.box { background: white; border-radius: 20px; padding: 30px; width: 100%; max-width: 450px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
h1 { color: #667eea; text-align: center; margin-bottom: 5px; }
.subtitle { text-align: center; color: #999; margin-bottom: 25px; font-size: 14px; }
input { width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 10px; font-size: 16px; margin-bottom: 15px; }
.join-btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; font-weight: bold; }
#game-area { display: none; }
.timer-bar { background: #f0f0f0; border-radius: 10px; height: 10px; margin-bottom: 20px; overflow: hidden; }
.timer-fill { height: 100%; background: linear-gradient(135deg, #667eea, #764ba2); transition: width 1s linear; border-radius: 10px; }
.question-text { font-size: 20px; font-weight: bold; color: #333; margin-bottom: 20px; text-align: center; line-height: 1.4; }
.options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.option-btn { padding: 18px 10px; border: 3px solid #e0e0e0; border-radius: 12px; background: white; font-size: 15px; cursor: pointer; transition: all 0.2s; text-align: center; font-weight: bold; }
.option-btn:hover { border-color: #667eea; background: #f0f0ff; }
.option-btn.selected { border-color: #667eea; background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
.option-btn.correct { border-color: #4CAF50; background: #4CAF50; color: white; }
.option-btn.wrong { border-color: #f44336; background: #f44336; color: white; }
.score-display { text-align: center; padding: 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 12px; margin-bottom: 20px; }
.score-display .pts { font-size: 36px; font-weight: bold; }
.waiting-msg { text-align: center; padding: 40px 20px; }
.waiting-msg .emoji { font-size: 60px; margin-bottom: 15px; }
.waiting-msg p { color: #666; font-size: 16px; }
.question-num { text-align: center; color: #999; font-size: 13px; margin-bottom: 10px; }
#leaderboard { display: none; }
.leader-item { display: flex; align-items: center; padding: 12px; border-bottom: 1px solid #f0f0f0; }
.medal { font-size: 24px; margin-right: 12px; min-width: 35px; }
.leader-name { flex: 1; font-weight: bold; }
.leader-score { color: #667eea; font-weight: bold; }
</style>
</head>
<body>
<div class="box">
<div id="join-area">
<h1>🌊 PollWave</h1>
<p class="subtitle">Gib deinen Namen ein und mach mit!</p>
<input type="text" id="name-input" placeholder="Dein Name..." maxlength="20">
<button class="join-btn" onclick="joinQuiz()">🚀 Mitmachen!</button>
</div>

<div id="game-area">
<div id="waiting-screen" class="waiting-msg">
<div class="emoji">⏳</div>
<p>Warte auf den Admin...</p>
<p id="player-name-display" style="color:#667eea;font-weight:bold;margin-top:10px"></p>
</div>

<div id="question-screen" style="display:none">
<div class="score-display">
<div>Punkte: <span class="pts" id="my-score">0</span></div>
</div>
<div class="question-num" id="q-num">Frage 1</div>
<div class="timer-bar"><div class="timer-fill" id="timer-fill"></div></div>
<div class="question-text" id="question-text">Lade...</div>
<div class="options" id="options-container"></div>
</div>

<div id="leaderboard">
<h2 style="text-align:center;color:#667eea;margin-bottom:20px">🏆 Endergebnis</h2>
<div id="leaderboard-list"></div>
</div>
</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
let myName = '';
let myScore = 0;
let answered = false;
let timerInterval;
let currentTimer = 30;

function joinQuiz() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { alert('Bitte Namen eingeben!'); return; }
  myName = name;
  socket.emit('join', { name: name });
  document.getElementById('join-area').style.display = 'none';
  document.getElementById('game-area').style.display = 'block';
  document.getElementById('player-name-display').textContent = 'Hey ' + name + '! 👋';
}

socket.on('question', (data) => {
  answered = false;
  currentTimer = data.timer || 30;
  
  document.getElementById('waiting-screen').style.display = 'none';
  document.getElementById('question-screen').style.display = 'block';
  document.getElementById('leaderboard').style.display = 'none';
  
  document.getElementById('q-num').textContent = 'Frage ' + data.questionNum + ' von ' + data.totalQuestions;
  document.getElementById('question-text').textContent = data.question;
  
  const timerFill = document.getElementById('timer-fill');
  timerFill.style.width = '100%';
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    currentTimer--;
    const pct = (currentTimer / (data.timer || 30)) * 100;
    timerFill.style.width = pct + '%';
    if (currentTimer <= 0) clearInterval(timerInterval);
  }, 1000);
  
  const container = document.getElementById('options-container');
  const letters = ['A', 'B', 'C', 'D'];
  container.innerHTML = data.options.map((opt, i) => 
    '<button class="option-btn" onclick="answer(' + i + ', this)">' + letters[i] + '. ' + opt + '</button>'
  ).join('');
});

function answer(index, btn) {
  if (answered) return;
  answered = true;
  clearInterval(timerInterval);
  document.querySelectorAll('.option-btn').forEach(b => b.style.pointerEvents = 'none');
  btn.classList.add('selected');
  socket.emit('answer', { answerIndex: index, timeLeft: currentTimer });
}

socket.on('answer-result', (data) => {
  const btns = document.querySelectorAll('.option-btn');
  btns.forEach((btn, i) => {
    if (i === data.correct) btn.classList.add('correct');
    else if (i === data.yourAnswer && i !== data.correct) btn.classList.add('wrong');
  });
  if (data.correct === data.yourAnswer) {
    myScore += data.points;
    document.getElementById('my-score').textContent = myScore;
  }
});

socket.on('leaderboard', (data) => {
  clearInterval(timerInterval);
  document.getElementById('question-screen').style.display = 'none';
  document.getElementById('waiting-screen').style.display = 'none';
  document.getElementById('leaderboard').style.display = 'block';
  
  const medals = ['🥇', '🥈', '🥉'];
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = data.map((p, i) => 
    '<div class="leader-item"><div class="medal">' + (medals[i] || (i+1)+'.') + '</div><div class="leader-name">' + p.name + '</div><div class="leader-score">' + p.score + ' Pkt</div></div>'
  ).join('');
});

socket.on('quiz-waiting', () => {
  clearInterval(timerInterval);
  document.getElementById('waiting-screen').style.display = 'block';
  document.getElementById('question-screen').style.display = 'none';
  document.getElementById('leaderboard').style.display = 'none';
});
</script>
</body>
</html>`);
});

// Socket.io Logic
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    quizState.participants[socket.id] = {
      id: socket.id,
      name: data.name,
      score: 0,
      answers: []
    };
    socket.emit('quiz-waiting');
    io.emit('quiz-update', quizState);
  });

  socket.on('save-questions', (questions) => {
    quizState.questions = questions;
    quizState.currentQuestion = 0;
    io.emit('quiz-update', quizState);
  });

  socket.on('start-quiz', () => {
    if (quizState.questions.length === 0) {
      socket.emit('error-msg', 'Keine Fragen gespeichert!');
      return;
    }
    quizState.active = true;
    quizState.currentQuestion = 0;
    quizState.phase = 'question';
    sendQuestion();
  });

  socket.on('next-question', () => {
    if (quizState.currentQuestion >= quizState.questions.length) {
      endQuiz();
    } else {
      sendQuestion();
    }
  });

  socket.on('answer', (data) => {
    const participant = quizState.participants[socket.id];
    if (!participant) return;
    
    const qIndex = quizState.currentQuestion - 1;
    if (qIndex < 0 || qIndex >= quizState.questions.length) return;
    
    const question = quizState.questions[qIndex];
    const isCorrect = data.answerIndex === question.correct;
    const points = isCorrect ? Math.max(50, Math.round(100 * (data.timeLeft / 30))) : 0;
    
    if (isCorrect) participant.score += points;
    
    socket.emit('answer-result', {
      correct: question.correct,
      yourAnswer: data.answerIndex,
      points: points,
      isCorrect: isCorrect
    });
    
    io.emit('quiz-update', quizState);
  });

  socket.on('stop-quiz', () => {
    endQuiz();
  });

  socket.on('disconnect', () => {
    delete quizState.participants[socket.id];
    io.emit('quiz-update', quizState);
  });
});

function sendQuestion() {
  if (quizState.currentQuestion >= quizState.questions.length) {
    endQuiz();
    return;
  }
  
  const q = quizState.questions[quizState.currentQuestion];
  quizState.currentQuestion++;
  quizState.timer = 30;
  
  io.emit('question', {
    question: q.question,
    options: q.options,
    questionNum: quizState.currentQuestion,
    totalQuestions: quizState.questions.length,
    timer: 30
  });
  
  io.emit('quiz-update', quizState);
  
  if (quizState.timerInterval) clearInterval(quizState.timerInterval);
  quizState.timerInterval = setInterval(() => {
    quizState.timer--;
    io.emit('quiz-update', quizState);
    if (quizState.timer <= 0) {
      clearInterval(quizState.timerInterval);
    }
  }, 1000);
}

function endQuiz() {
  quizState.active = false;
  quizState.phase = 'ended';
  if (quizState.timerInterval) clearInterval(quizState.timerInterval);
  
  const sorted = Object.values(quizState.participants)
    .sort((a, b) => b.score - a.score);
  
  io.emit('leaderboard', sorted);
  io.emit('quiz-update', quizState);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('PollWave läuft auf Port ' + PORT);
});
