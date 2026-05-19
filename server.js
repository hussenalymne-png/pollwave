const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'galaxus2024';
const DATA_FILE = path.join(__dirname, 'data', 'games.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// ── Ensure directories exist ──────────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Multer setup ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ── Load / Save games ─────────────────────────────────────────────────────────
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
    const clean = {};
    for (const [code, room] of Object.entries(games)) {
      const { timer, ...rest } = room;
      clean[code] = rest;
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2));
  } catch (e) {
    console.error('Error saving games:', e);
  }
}

let games = loadGames();

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calcScore(timeLeft, maxTime) {
  return Math.max(100, Math.floor(200 * (timeLeft / maxTime)));
}

function getLeaderboard(room) {
  return Object.entries(room.players)
    .filter(([name]) => name !== '__presenter__')
    .map(([name, p]) => ({ name, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);
}

function getAnswerCounts(room, qIndex) {
  const question = room.questions[qIndex];
  if (!question) return [];
  return (question.options || []).map((_, i) =>
    Object.values(room.players).filter(p =>
      p.lastAnswerQuestion === qIndex && p.lastAnswer === i
    ).length
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ══════════════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/rooms → create room
app.post('/api/rooms', (req, res) => {
  const { password, quizName } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  let code;
  do { code = generateCode(); } while (games[code]);

  games[code] = {
    code,
    quizName:        quizName || 'PollWave Quiz',
    state:           'waiting',
    players:         {},
    questions:       [],
    currentQuestion: -1,
    createdAt:       new Date().toISOString()
  };
  saveGames(games);
  console.log(`[ROOM] Created: ${code}`);
  res.json({ code, quizName: games[code].quizName });
});

// POST /api/rooms/:code/rejoin → admin rejoin
app.post('/api/rooms/:code/rejoin', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });

  const players = getLeaderboard(room);

  res.json({
    code:            room.code,
    quizName:        room.quizName || 'PollWave Quiz',
    state:           room.state,
    questions:       room.questions || [],
    currentQuestion: room.currentQuestion,
    players
  });
});

// PUT /api/rooms/:code/name → update quiz name
app.put('/api/rooms/:code/name', (req, res) => {
  const { password, quizName } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });

  room.quizName = quizName || 'PollWave Quiz';
  saveGames(games);
  io.to(room.code).emit('quizNameUpdated', { quizName: room.quizName });
  res.json({ success: true, quizName: room.quizName });
});

// PUT /api/rooms/:code/questions → save questions
app.put('/api/rooms/:code/questions', (req, res) => {
  const { password, questions } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });

  room.questions = questions || [];
  saveGames(games);
  res.json({ success: true, count: room.questions.length });
});

// GET /api/rooms/:code → room info (public)
app.get('/api/rooms/:code', (req, res) => {
  const room = games[req.params.code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });
  res.json({
    code:      room.code,
    quizName:  room.quizName,
    state:     room.state,
    players:   Object.keys(room.players).filter(n => n !== '__presenter__').length,
    questions: room.questions?.length || 0
  });
});

// DELETE /api/rooms/:code → delete room
app.delete('/api/rooms/:code', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const code = req.params.code?.toUpperCase();
  if (!games[code]) return res.status(404).json({ error: 'Raum nicht gefunden' });

  if (games[code].timer) clearInterval(games[code].timer);
  delete games[code];
  saveGames(games);
  res.json({ success: true });
});

// ── Legacy routes ─────────────────────────────────────────────────────────────
app.post('/api/create-room', (req, res) => {
  req.url = '/api/rooms';
  app.handle(req, res);
});
app.post('/api/rejoin-room', (req, res) => {
  const { code } = req.body;
  req.params = { code };
  req.url = `/api/rooms/${code}/rejoin`;
  app.handle(req, res);
});

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/present', (req, res) => res.sendFile(path.join(__dirname, 'public', 'present.html')));

// ══════════════════════════════════════════════════════════════════════════════
// Question Timer Logic
// ══════════════════════════════════════════════════════════════════════════════
function startQuestionTimer(roomCode) {
  const room = games[roomCode];
  if (!room) return;

  // Clear any existing timer
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  const qIndex   = room.currentQuestion;
  const question = room.questions[qIndex];
  if (!question) return;

  const maxTime  = question.time || 30;
  let   timeLeft = maxTime;

  // Reset per-question answer tracking
  room.questionAnswers = {};

  const questionData = {
    index:         qIndex,
    total:         room.questions.length,
    question:      question.question,
    options:       question.options,
    time:          maxTime,
    image:         question.image         || null,
    imagePosition: question.imagePosition || 'right',
    imageSize:     question.imageSize     || 'medium',
    imageFit:      question.imageFit      || 'cover'
  };

  io.to(roomCode).emit('newQuestion', questionData);
  console.log(`[Q] Room ${roomCode} → Q${qIndex + 1}/${room.questions.length}: "${question.question}"`);

  room.timer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft, maxTime });

    if (timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      endQuestion(roomCode);
    }
  }, 1000);
}

// ── End Question ──────────────────────────────────────────────────────────────
function endQuestion(roomCode) {
  const room = games[roomCode];
  if (!room) return;

  // Guard: don't end twice
  if (room._endingQuestion) return;
  room._endingQuestion = true;

  const qIndex      = room.currentQuestion;
  const question    = room.questions[qIndex];
  const answerCounts = getAnswerCounts(room, qIndex);
  const leaderboard  = getLeaderboard(room);

  console.log(`[END Q] Room ${roomCode} Q${qIndex + 1} — leaderboard:`, leaderboard);

  io.to(roomCode).emit('questionEnd', {
    correctAnswer: question.correctAnswer,
    answerCounts,
    leaderboard,        // ← always 'leaderboard' key
    question:  question.question,
    options:   question.options
  });

  saveGames(games);

  // Reset guard after a short delay
  setTimeout(() => {
    if (games[roomCode]) games[roomCode]._endingQuestion = false;
  }, 2000);
}

// ── Advance to next question or finish ────────────────────────────────────────
function advanceGame(roomCode) {
  const room = games[roomCode];
  if (!room) return;

  room.currentQuestion++;

  if (room.currentQuestion >= room.questions.length) {
    // ── Quiz finished ──
    room.state = 'finished';
    const finalLeaderboard = getLeaderboard(room);
    saveGames(games);

    console.log(`[FINISH] Room ${roomCode} — final leaderboard:`, finalLeaderboard);
    io.to(roomCode).emit('gameFinished', { leaderboard: finalLeaderboard });
  } else {
    // ── Next question ──
    saveGames(games);
    startQuestionTimer(roomCode);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Socket.IO
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // ── Join Room ─────────────────────────────────────────────────────────────
  function handleJoin({ code, name }) {
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];

    if (!room) {
      socket.emit('error', { message: 'Raum nicht gefunden' });
      return;
    }
    if (!name?.trim()) {
      socket.emit('error', { message: 'Name erforderlich' });
      return;
    }

    socket.join(roomCode);
    socket.roomCode   = roomCode;
    socket.playerName = name;

    const isPresenter = name === '__presenter__';

    if (isPresenter) {
      room.players['__presenter__'] = { score: 0, isPresenter: true };
    } else {
      if (!room.players[name]) {
        room.players[name] = {
          score:              0,
          answers:            [],
          lastAnswer:         null,
          lastAnswerQuestion: -1
        };
      }
    }

    saveGames(games);

    const playerCount = Object.keys(room.players).filter(n => n !== '__presenter__').length;

    socket.emit('joinedRoom', {
      code:      roomCode,
      quizName:  room.quizName,
      state:     room.state,
      players:   playerCount,
      questions: room.questions?.length || 0,
      currentQuestion: room.currentQuestion
    });

    if (!isPresenter) {
      io.to(roomCode).emit('playerJoined', { name, playerCount });
      console.log(`[JOIN] ${name} → ${roomCode} (${playerCount} players)`);
    } else {
      console.log(`[JOIN] Presenter → ${roomCode}`);
    }

    // Late-join: send current question if game is in progress
    if (room.state === 'playing' && room.currentQuestion >= 0) {
      const question = room.questions[room.currentQuestion];
      if (question) {
        socket.emit('newQuestion', {
          index:         room.currentQuestion,
          total:         room.questions.length,
          question:      question.question,
          options:       question.options,
          time:          question.time || 30,
          image:         question.image         || null,
          imagePosition: question.imagePosition || 'right',
          imageSize:     question.imageSize     || 'medium',
          imageFit:      question.imageFit      || 'cover'
        });
      }
    }
  }

  socket.on('joinRoom', handleJoin);
  socket.on('joinGame', handleJoin);

  // ── Start Game ────────────────────────────────────────────────────────────
  socket.on('startGame', ({ code, password }) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];
    if (!room) return;
    if (room.state === 'playing') return; // already running
    if (!room.questions?.length) {
      socket.emit('error', { message: 'Keine Fragen vorhanden' });
      return;
    }

    room.state           = 'playing';
    room.currentQuestion = 0;
    room._endingQuestion = false;

    // Reset all player scores & answers
    for (const name of Object.keys(room.players)) {
      room.players[name].score              = 0;
      room.players[name].answers            = [];
      room.players[name].lastAnswer         = null;
      room.players[name].lastAnswerQuestion = -1;
    }

    saveGames(games);
    io.to(roomCode).emit('gameStarted', {
      quizName:       room.quizName,
      totalQuestions: room.questions.length
    });
    startQuestionTimer(roomCode);
  });

  // ── Next Question (admin / presenter) ─────────────────────────────────────
  function handleNextQuestion({ code, password }) {
    if (password !== ADMIN_PASSWORD) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];
    if (!room || room.state !== 'playing') return;

    console.log(`[NEXT Q] Room ${roomCode} — requested by ${socket.playerName || socket.id}`);

    // Stop timer if still running
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    // Emit questionEnd with current results, then advance
    endQuestion(roomCode);

    setTimeout(() => {
      advanceGame(roomCode);
    }, 1500);
  }

  socket.on('nextQuestion',      handleNextQuestion);
  socket.on('adminNextQuestion', handleNextQuestion);

  // ── Submit Answer ─────────────────────────────────────────────────────────
  socket.on('submitAnswer', ({ code, answer, timeLeft }) => {
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];
    if (!room || room.state !== 'playing') return;

    const name   = socket.playerName;
    const player = room.players[name];
    if (!player || name === '__presenter__') return;

    const qIndex = room.currentQuestion;
    // Prevent double-answering the same question
    if (player.lastAnswerQuestion === qIndex) return;

    const question = room.questions[qIndex];
    if (!question) return;

    const isCorrect = answer === question.correctAnswer;
    const points    = isCorrect ? calcScore(timeLeft || 0, question.time || 30) : 0;

    player.lastAnswer         = answer;
    player.lastAnswerQuestion = qIndex;
    player.score             += points;
    player.answers.push({ question: qIndex, answer, correct: isCorrect, points });

    saveGames(games);

    // Send result to answering player
    socket.emit('answerResult', {
      correct: isCorrect,
      points,
      score: player.score
    });

    // Broadcast live answer counts to all in room
    const answerCounts = getAnswerCounts(room, qIndex);
    io.to(roomCode).emit('answerUpdate', { answerCounts });

    console.log(`[ANSWER] ${name} in ${roomCode}: option ${answer} — ${isCorrect ? '✓' : '✗'} +${points}`);

    // Auto-advance when ALL active players have answered
    const activePlayers = Object.entries(room.players)
      .filter(([n]) => n !== '__presenter__');
    const allAnswered = activePlayers.length > 0 &&
      activePlayers.every(([, p]) => p.lastAnswerQuestion === qIndex);

    if (allAnswered) {
      console.log(`[AUTO-ADVANCE] All ${activePlayers.length} players answered in ${roomCode}`);
      setTimeout(() => {
        if (!room.timer) return; // timer already stopped (manual advance)
        clearInterval(room.timer);
        room.timer = null;
        endQuestion(roomCode);
        setTimeout(() => advanceGame(roomCode), 1500);
      }, 500);
    }
  });

  // ── End Game ──────────────────────────────────────────────────────────────
  socket.on('endGame', ({ code, password }) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];
    if (!room) return;

    if (room.timer) { clearInterval(room.timer); room.timer = null; }

    room.state = 'finished';
    const finalLeaderboard = getLeaderboard(room);
    saveGames(games);

    console.log(`[END GAME] Room ${roomCode} — leaderboard:`, finalLeaderboard);
    io.to(roomCode).emit('gameFinished', { leaderboard: finalLeaderboard });
  });

  // ── Reset Game ────────────────────────────────────────────────────────────
  socket.on('resetGame', ({ code, password }) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    const roomCode = code?.toUpperCase();
    const room     = games[roomCode];
    if (!room) return;

    if (room.timer) { clearInterval(room.timer); room.timer = null; }

    room.state           = 'waiting';
    room.currentQuestion = -1;
    room.questionAnswers = {};
    room._endingQuestion = false;

    for (const name of Object.keys(room.players)) {
      room.players[name].score              = 0;
      room.players[name].answers            = [];
      room.players[name].lastAnswer         = null;
      room.players[name].lastAnswerQuestion = -1;
    }

    saveGames(games);
    io.to(roomCode).emit('gameReset', { message: 'Game reset' });
    console.log(`[RESET] Room ${roomCode}`);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomCode, playerName } = socket;
    if (!roomCode || !playerName) return;

    const room = games[roomCode];
    if (!room) return;

    if (playerName !== '__presenter__' && room.players[playerName]) {
      delete room.players[playerName];
      saveGames(games);
    }

    const playerCount = Object.keys(room.players)
      .filter(n => n !== '__presenter__').length;

    io.to(roomCode).emit('playerLeft', { name: playerName, playerCount });
    console.log(`[LEAVE] ${playerName} ← ${roomCode} (${playerCount} players)`);
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ PollWave running on port ${PORT}`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
  console.log(`   Presenter: http://localhost:${PORT}/present`);
});
