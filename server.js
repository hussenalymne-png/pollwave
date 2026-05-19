const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'galaxus2024';
const DATA_FILE = path.join(__dirname, 'data', 'games.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// Ensure directories exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) &&
                allowed.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only image files allowed'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load / Save games
function loadGames() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading games:', e);
  }
  return {};
}

function saveGames(games) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(games, null, 2));
  } catch (e) {
    console.error('Error saving games:', e);
  }
}

let games = loadGames();

// Helper: generate room code
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── REST API ────────────────────────────────────────────────────────────────

// Upload image
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Create room
app.post('/api/create-room', (req, res) => {
  const { password, quizName } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  let code;
  do { code = generateCode(); } while (games[code]);

  games[code] = {
    code,
    quizName: quizName || 'PollWave Quiz',
    state: 'waiting',
    players: {},
    questions: [],
    currentQuestion: -1,
    createdAt: new Date().toISOString()
  };
  saveGames(games);
  res.json({ code, quizName: games[code].quizName });
});

// Rejoin room (admin)
app.post('/api/rejoin-room', (req, res) => {
  const { password, code } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const room = games[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    quizName: room.quizName || 'PollWave Quiz',
    state: room.state,
    questions: room.questions,
    playerCount: Object.keys(room.players).length
  });
});

// Get room info
app.get('/api/room/:code', (req, res) => {
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    quizName: room.quizName || 'PollWave Quiz',
    state: room.state,
    playerCount: Object.keys(room.players).filter(p => p !== '__presenter__').length,
    currentQuestion: room.currentQuestion,
    totalQuestions: room.questions.length
  });
});

// Update quiz name
app.post('/api/room/:code/quiz-name', (req, res) => {
  const { password, quizName } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.quizName = quizName || 'PollWave Quiz';
  saveGames(games);
  io.to(room.code).emit('quizNameUpdated', { quizName: room.quizName });
  res.json({ success: true, quizName: room.quizName });
});

// Get questions
app.get('/api/room/:code/questions', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ questions: room.questions });
});

// Save questions
app.post('/api/room/:code/questions', (req, res) => {
  const { password, questions } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.questions = questions || [];
  saveGames(games);
  res.json({ success: true, count: room.questions.length });
});

// Delete room
app.delete('/api/room/:code', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const code = req.params.code?.toUpperCase();
  if (!games[code]) return res.status(404).json({ error: 'Room not found' });
  delete games[code];
  saveGames(games);
  res.json({ success: true });
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

function startQuestionTimer(code) {
  const room = games[code];
  if (!room) return;

  const question = room.questions[room.currentQuestion];
  if (!question) return;

  const maxTime = question.time || 30;
  let timeLeft = maxTime;

  if (room.timer) clearInterval(room.timer);

  // Emit question to all clients
  io.to(code).emit('newQuestion', {
    index: room.currentQuestion,
    total: room.questions.length,
    question: question.question,
    options: question.options,
    image: question.image || null,
    imagePosition: question.imagePosition || 'right',
    imageSize: question.imageSize || 'medium',
    imageFit: question.imageFit || 'cover',
    time: maxTime
  });

  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timerUpdate', { timeLeft, maxTime });

    if (timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      endQuestion(code);
    }
  }, 1000);
}

function endQuestion(code) {
  const room = games[code];
  if (!room) return;

  const question = room.questions[room.currentQuestion];
  const correctAnswer = question.correctAnswer;

  // Build answer stats
  const answerCounts = {};
  question.options.forEach((_, i) => answerCounts[i] = 0);

  let answeredPlayers = [];
  Object.entries(room.players).forEach(([name, player]) => {
    if (name === '__presenter__') return;
    if (player.currentAnswer !== undefined && player.currentAnswer !== null) {
      answerCounts[player.currentAnswer] = (answerCounts[player.currentAnswer] || 0) + 1;
      answeredPlayers.push({
        name,
        answer: player.currentAnswer,
        correct: player.currentAnswer === correctAnswer,
        score: player.score
      });
    }
  });

  // Leaderboard
  const leaderboard = Object.entries(room.players)
    .filter(([name]) => name !== '__presenter__')
    .map(([name, p]) => ({ name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  io.to(code).emit('questionEnd', {
    correctAnswer,
    answerCounts,
    leaderboard,
    answeredPlayers
  });

  // Reset current answers
  Object.keys(room.players).forEach(name => {
    if (name !== '__presenter__') {
      room.players[name].currentAnswer = null;
      room.players[name].hasAnswered = false;
    }
  });

  saveGames(games);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // ── Join Room ──────────────────────────────────────────────────────────────
  function handleJoin(data) {
    const { code, name } = data;
    const roomCode = code?.toUpperCase();
    const room = games[roomCode];

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = name;

    if (name === '__presenter__') {
      // Presenter joins — no scoring
      room.players[name] = { socketId: socket.id, score: 0, isPresenter: true };
      socket.emit('joinedRoom', {
        code: roomCode,
        quizName: room.quizName || 'PollWave Quiz',
        state: room.state,
        isPresenter: true
      });
    } else {
      // Regular player
      if (!room.players[name]) {
        room.players[name] = { score: 0, currentAnswer: null, hasAnswered: false };
      }
      room.players[name].socketId = socket.id;

      const playerCount = Object.keys(room.players).filter(p => p !== '__presenter__').length;

      socket.emit('joinedRoom', {
        code: roomCode,
        quizName: room.quizName || 'PollWave Quiz',
        state: room.state,
        playerCount
      });

      io.to(roomCode).emit('playerJoined', {
        name,
        playerCount
      });
    }

    saveGames(games);
  }

  socket.on('joinRoom', handleJoin);
  socket.on('joinGame', handleJoin);

  // ── Start Game ─────────────────────────────────────────────────────────────
  socket.on('startGame', (data) => {
    const { code, password } = data;
    const roomCode = code?.toUpperCase();
    if (password !== ADMIN_PASSWORD) {
      socket.emit('error', { message: 'Invalid password' });
      return;
    }
    const room = games[roomCode];
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }
    if (room.questions.length === 0) {
      socket.emit('error', { message: 'No questions added' });
      return;
    }

    room.state = 'playing';
    room.currentQuestion = 0;

    // Reset all scores
    Object.keys(room.players).forEach(name => {
      if (name !== '__presenter__') {
        room.players[name].score = 0;
        room.players[name].currentAnswer = null;
        room.players[name].hasAnswered = false;
      }
    });

    saveGames(games);
    io.to(roomCode).emit('gameStarted', { quizName: room.quizName });
    startQuestionTimer(roomCode);
  });

  // ── Next Question ──────────────────────────────────────────────────────────
  socket.on('nextQuestion', (data) => {
    const { code, password } = data;
    const roomCode = code?.toUpperCase();
    const room = games[roomCode];
    if (!room) return;

    // Allow admin password OR presenter
    const isAdmin = password === ADMIN_PASSWORD;
    const isPresenter = socket.playerName === '__presenter__';
    if (!isAdmin && !isPresenter) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }

    if (room.timer) { clearInterval(room.timer); room.timer = null; }

    room.currentQuestion++;

    if (room.currentQuestion >= room.questions.length) {
      // Game over
      room.state = 'finished';
      const finalLeaderboard = Object.entries(room.players)
        .filter(([name]) => name !== '__presenter__')
        .map(([name, p]) => ({ name, score: p.score }))
        .sort((a, b) => b.score - a.score);

      saveGames(games);
      io.to(roomCode).emit('gameFinished', { leaderboard: finalLeaderboard });
    } else {
      saveGames(games);
      startQuestionTimer(roomCode);
    }
  });

  // ── Submit Answer ──────────────────────────────────────────────────────────
  socket.on('submitAnswer', (data) => {
    const { code, answer, timeLeft } = data;
    const roomCode = code?.toUpperCase();
    const room = games[roomCode];
    if (!room || room.state !== 'playing') return;

    const playerName = socket.playerName;
    if (!playerName || playerName === '__presenter__') return;

    const player = room.players[playerName];
    if (!player || player.hasAnswered) return;

    const question = room.questions[room.currentQuestion];
    const maxTime = question.time || 30;

    player.hasAnswered = true;
    player.currentAnswer = answer;

    // Score calculation
    if (answer === question.correctAnswer) {
      const points = Math.max(100, Math.floor(200 * (timeLeft / maxTime)));
      player.score += points;
    }

    // Answer distribution
    const answerCounts = {};
    question.options.forEach((_, i) => answerCounts[i] = 0);
    Object.values(room.players).forEach(p => {
      if (p.currentAnswer !== null && p.currentAnswer !== undefined) {
        answerCounts[p.currentAnswer] = (answerCounts[p.currentAnswer] || 0) + 1;
      }
    });

    const totalPlayers = Object.keys(room.players).filter(n => n !== '__presenter__').length;
    const answeredCount = Object.values(room.players).filter(
      p => p.hasAnswered && p !== room.players['__presenter__']
    ).length;

    io.to(roomCode).emit('answerUpdate', { answerCounts, answeredCount, totalPlayers });
    socket.emit('answerConfirmed', {
      correct: answer === question.correctAnswer,
      score: player.score
    });

    saveGames(games);

    // Auto-advance if all answered
    if (answeredCount >= totalPlayers && totalPlayers > 0) {
      if (room.timer) { clearInterval(room.timer); room.timer = null; }
      setTimeout(() => endQuestion(roomCode), 500);
    }
  });

  // ── End Game ───────────────────────────────────────────────────────────────
  socket.on('endGame', (data) => {
    const { code, password } = data;
    const roomCode = code?.toUpperCase();
    if (password !== ADMIN_PASSWORD) return;
    const room = games[roomCode];
    if (!room) return;

    if (room.timer) { clearInterval(room.timer); room.timer = null; }

    room.state = 'finished';
    const finalLeaderboard = Object.entries(room.players)
      .filter(([name]) => name !== '__presenter__')
      .map(([name, p]) => ({ name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    saveGames(games);
    io.to(roomCode).emit('gameFinished', { leaderboard: finalLeaderboard });
  });

  // ── Reset Game ─────────────────────────────────────────────────────────────
  socket.on('resetGame', (data) => {
    const { code, password } = data;
    const roomCode = code?.toUpperCase();
    if (password !== ADMIN_PASSWORD) return;
    const room = games[roomCode];
    if (!room) return;

    if (room.timer) { clearInterval(room.timer); room.timer = null; }

    room.state = 'waiting';
    room.currentQuestion = -1;
    Object.keys(room.players).forEach(name => {
      if (name !== '__presenter__') {
        room.players[name].score = 0;
        room.players[name].currentAnswer = null;
        room.players[name].hasAnswered = false;
      }
    });

    saveGames(games);
    io.to(roomCode).emit('gameReset', { quizName: room.quizName });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomCode, playerName } = socket;
    if (!roomCode || !playerName || playerName === '__presenter__') return;

    const room = games[roomCode];
    if (!room) return;

    const playerCount = Object.keys(room.players).filter(p => p !== '__presenter__').length;
    io.to(roomCode).emit('playerLeft', { name: playerName, playerCount });
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ PollWave running on port ${PORT}`);
});
