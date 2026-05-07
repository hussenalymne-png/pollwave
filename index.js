const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let poll = {
  question: 'Was ist dein Lieblingsessen?',
  options: ['Pizza', 'Burger', 'Sushi', 'Pasta'],
  votes: [0, 0, 0, 0],
  timer: 60,
  active: false
};

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<title>PollWave</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/socket.io/socket.io.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: #1a1a2e; color: white; min-height: 100vh; }
.container { max-width: 800px; margin: 0 auto; padding: 20px; }
h1 { text-align: center; color: #e94560; font-size: 2.5em; margin-bottom: 10px; }
.question { text-align: center; font-size: 1.5em; margin: 20px 0; color: #a8dadc; }
.options { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
.option-btn { background: #16213e; border: 2px solid #e94560; color: white; padding: 20px; font-size: 1.2em; border-radius: 10px; cursor: pointer; transition: all 0.3s; }
.option-btn:hover { background: #e94560; transform: scale(1.05); }
.results { margin: 20px 0; }
.result-bar { margin: 10px 0; }
.result-label { display: flex; justify-content: space-between; margin-bottom: 5px; }
.bar { height: 30px; background: #16213e; border-radius: 15px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, #e94560, #a8dadc); transition: width 0.5s; border-radius: 15px; }
.timer { text-align: center; font-size: 3em; color: #e94560; margin: 20px 0; }
.admin-panel { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
input, textarea { width: 100%; padding: 10px; margin: 5px 0; background: #0f3460; border: 1px solid #e94560; color: white; border-radius: 5px; font-size: 1em; }
button { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 1em; margin: 5px; }
button:hover { background: #c73652; }
.qr { text-align: center; margin: 20px 0; }
.qr img { border: 3px solid #e94560; border-radius: 10px; }
.voters { text-align: center; color: #a8dadc; margin: 10px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>🌊 PollWave</h1>
  <div class="voters">👥 <span id="voters">0</span> Teilnehmer</div>
  
  <div id="admin-panel" class="admin-panel" style="display:none">
    <h3>⚙️ Admin Panel</h3>
    <input id="new-question" placeholder="Frage eingeben..." value="Was ist dein Lieblingsessen?">
    <input id="opt1" placeholder="Option 1" value="Pizza">
    <input id="opt2" placeholder="Option 2" value="Burger">
    <input id="opt3" placeholder="Option 3" value="Sushi">
    <input id="opt4" placeholder="Option 4" value="Pasta">
    <input id="timer-input" type="number" placeholder="Timer (Sekunden)" value="60">
    <br>
    <button onclick="updatePoll()">✅ Poll aktualisieren</button>
    <button onclick="startTimer()">▶️ Timer starten</button>
    <button onclick="resetVotes()">🔄 Votes zurücksetzen</button>
  </div>

  <div class="question" id="question">Lade...</div>
  <div class="timer" id="timer">⏱️ 60</div>
  
  <div class="options" id="options"></div>
  <div class="results" id="results"></div>
  
  <div class="qr">
    <p>📱 Scan zum Abstimmen:</p>
    <img id="qr-img" src="/qr" alt="QR Code" width="200">
  </div>
  
  <button onclick="toggleAdmin()" style="width:100%">🔧 Admin</button>
</div>

<script>
const socket = io();
let isAdmin = false;
let voted = false;

socket.on('poll-update', (data) => {
  document.getElementById('question').textContent = data.question;
  document.getElementById('timer').textContent = '⏱️ ' + data.timer;
  
  const total = data.votes.reduce((a,b) => a+b, 0);
  
  const optDiv = document.getElementById('options');
  optDiv.innerHTML = '';
  data.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.onclick = () => vote(i);
    optDiv.appendChild(btn);
  });
  
  const resDiv = document.getElementById('results');
  resDiv.innerHTML = '<h3>📊 Ergebnisse:</h3>';
  data.options.forEach((opt, i) => {
    const pct = total > 0 ? Math.round(data.votes[i]/total*100) : 0;
    resDiv.innerHTML += \`
      <div class="result-bar">
        <div class="result-label"><span>\${opt}</span><span>\${data.votes[i]} (\${pct}%)</span></div>
        <div class="bar"><div class="bar-fill" style="width:\${pct}%"></div></div>
      </div>\`;
  });
});

socket.on('voters-update', (count) => {
  document.getElementById('voters').textContent = count;
});

socket.on('timer-tick', (time) => {
  document.getElementById('timer').textContent = '⏱️ ' + time;
  if(time <= 10) document.getElementById('timer').style.color = '#ff0000';
  else document.getElementById('timer').style.color = '#e94560';
});

function vote(index) {
  if(voted) return alert('Du hast bereits abgestimmt!');
  socket.emit('vote', index);
  voted = true;
}

function toggleAdmin() {
  const pw = prompt('Admin Passwort:');
  if(pw === 'admin123') {
    isAdmin = true;
    document.getElementById('admin-panel').style.display = 'block';
    alert('Admin Modus aktiviert!');
  } else {
    alert('Falsches Passwort!');
  }
}

function updatePoll() {
  socket.emit('update-poll', {
    question: document.getElementById('new-question').value,
    options: [
      document.getElementById('opt1').value,
      document.getElementById('opt2').value,
      document.getElementById('opt3').value,
      document.getElementById('opt4').value
    ],
    timer: parseInt(document.getElementById('timer-input').value)
  });
}

function startTimer() {
  socket.emit('start-timer');
}

function resetVotes() {
  socket.emit('reset-votes');
}
</script>
</body>
</html>`);
});

app.get('/qr', async (req, res) => {
  const url = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const qr = await QRCode.toBuffer(url);
  res.set('Content-Type', 'image/png');
  res.send(qr);
});

let timerInterval = null;

io.on('connection', (socket) => {
  const count = io.engine.clientsCount;
  io.emit('voters-update', count);
  socket.emit('poll-update', poll);

  socket.on('vote', (index) => {
    if(index >= 0 && index < poll.votes.length) {
      poll.votes[index]++;
      io.emit('poll-update', poll);
    }
  });

  socket.on('update-poll', (data) => {
    poll.question = data.question;
    poll.options = data.options;
    poll.votes = new Array(data.options.length).fill(0);
    poll.timer = data.timer;
    io.emit('poll-update', poll);
  });

  socket.on('start-timer', () => {
    if(timerInterval) clearInterval(timerInterval);
    let time = poll.timer;
    poll.active = true;
    timerInterval = setInterval(() => {
      time--;
      io.emit('timer-tick', time);
      if(time <= 0) {
        clearInterval(timerInterval);
        poll.active = false;
      }
    }, 1000);
  });

  socket.on('reset-votes', () => {
    poll.votes = new Array(poll.options.length).fill(0);
    io.emit('poll-update', poll);
  });

  socket.on('disconnect', () => {
    const count = io.engine.clientsCount;
    io.emit('voters-update', count);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('PollWave läuft auf Port ' + PORT);
});
