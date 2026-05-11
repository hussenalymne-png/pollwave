const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Storage für Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Static Files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Game State
let gameState = {
  questions: [],
  currentQuestion: -1,
  state: 'waiting',
  participants: {},
  answers: {},
  timer: null,
  adminPassword: 'admin123'
};

const ROOM_CODE = 'X3PL2U';

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.get('/qr', async (req, res) => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const qr = await QRCode.toDataURL(url);
    res.json({ qr });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Admin Login
  socket.on('adminLogin', (password, cb) => {
    if (password === gameState.adminPassword) {
      socket.isAdmin = true;
      cb({ success: true });
    } else {
      cb({ success: false });
    }
  });

  // Get State
  socket.on('getState', (cb) => {
    cb({
      questions: gameState.questions,
      currentQuestion: gameState.currentQuestion,
      participants: Object.keys(gameState.participants).length,
      state: gameState.state
    });
  });

  // Join Game
  socket.on('joinGame', (data, cb) => {
    const { name, code } = data;
    if (code !== ROOM_CODE) {
      return cb({ success: false, error: 'Falscher Code!' });
    }
    gameState.participants[socket.id] = {
      name,
      score: 0,
      answers: []
    };
    socket.playerName = name;
    io.emit('participantJoined', {
      count: Object.keys(gameState.participants).length
    });
    cb({ success: true, name });
    console.log(`${name} joined`);
  });

  // Add Question
  socket.on('addQuestion', (question, cb) => {
    if (gameState.questions.length >= 20) {
      return cb({ success: false, error: 'Max 20 Fragen!' });
    }
    gameState.questions.push(question);
    cb({ success: true, questions: gameState.questions });
  });

  // Delete Question
  socket.on('deleteQuestion', (index, cb) => {
    gameState.questions.splice(index, 1);
    cb({ success: true, questions: gameState.questions });
  });

  // Start Game
  socket.on('startGame', (cb) => {
    if (gameState.questions.length === 0) {
      return cb({ success: false, error: 'Keine Fragen!' });
    }
    gameState.currentQuestion = 0;
    gameState.state = 'playing';
    startQuestion(0);
    cb({ success: true, currentQuestion: 0 });
  });

  // Next Question
  socket.on('nextQuestion', (cb) => {
    const next = gameState.currentQuestion + 1;
    if (next >= gameState.questions.length) {
      gameState.state = 'finished';
      clearTimer();
      sendLeaderboard();
      return cb({ success: true, finished: true });
    }
    gameState.currentQuestion = next;
    startQuestion(next);
    cb({ success: true, currentQuestion: next, finished: false });
  });

  // Pause Game
  socket.on('pauseGame', (cb) => {
    if (gameState.state === 'playing') {
      gameState.state = 'paused';
      clearTimer();
    } else {
      gameState.state = 'playing';
    }
    cb({ state: gameState.state });
  });

  // Reset Game
  socket.on('resetGame', (cb) => {
    clearTimer();
    Object.keys(gameState.participants).forEach(id => {
      if (gameState.participants[id]) {
        gameState.participants[id].score = 0;
        gameState.participants[id].answers = [];
      }
    });
    gameState.currentQuestion = -1;
    gameState.state = 'waiting';
    gameState.answers = {};
    io.emit('gameReset');
    cb({ success: true, questions: gameState.questions });
  });

  // Submit Answer
  socket.on('submitAnswer', (data, cb) => {
    const { questionIndex, answer, timeLeft } = data;
    if (questionIndex !== gameState.currentQuestion) {
      return cb({ success: false });
    }
    if (!gameState.answers[questionIndex]) {
      gameState.answers[questionIndex] = [0,0,0,0];
    }
    if (gameState.answers[questionIndex][answer] !== undefined) {
      gameState.answers[questionIndex][answer]++;
    }

    const q = gameState.questions[questionIndex];
    let points = 0;
    if (answer === q.correct) {
      points = 200 + Math.round((timeLeft / q.time) * 800);
    }

    if (gameState.participants[socket.id]) {
      gameState.participants[socket.id].score += points;
    }

    io.emit('answerSubmitted', {
      counts: gameState.answers[questionIndex]
    });

    sendLeaderboard();
    cb({ success: true, correct: answer === q.correct, points });
  });

  // Change Password
  socket.on('changePassword', (pw, cb) => {
    if (socket.isAdmin) {
      gameState.adminPassword = pw;
      cb({ success: true });
    } else {
      cb({ success: false });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.playerName) {
      delete gameState.participants[socket.id];
      io.emit('participantJoined', {
        count: Object.keys(gameState.participants).length
      });
    }
  });
});

function startQuestion(index) {
  const q = gameState.questions[index];
  if (!q) return;
  gameState.answers[index] = [0,0,0,0];

  io.emit('questionStarted', {
    index,
    question: q.text,
    options: q.options,
    time: q.time,
    image: q.image || null,
    total: gameState.questions.length
  });

  let timeLeft = q.time;
  clearTimer();

  gameState.timer = setInterval(() => {
    timeLeft--;
    io.emit('timerUpdate', { time: timeLeft });
    if (timeLeft <= 0) {
      clearTimer();
      io.emit('questionEnded', {
        correct: q.correct,
        counts: gameState.answers[index]
      });
      sendLeaderboard();
    }
  }, 1000);
}

function clearTimer() {
  if (gameState.timer) {
    clearInterval(gameState.timer);
    gameState.timer = null;
  }
}

function sendLeaderboard() {
  const lb = Object.values(gameState.participants)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
  io.emit('leaderboardUpdate', { leaderboard: lb });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PollWave running on port ${PORT}`);
});
