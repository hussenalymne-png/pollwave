'use strict';

const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*' } });

const PORT           = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'galaxus2024';
const DATA_FILE      = path.join(__dirname, 'data', 'games.json');
const UPLOADS_DIR    = path.join(__dirname, 'public', 'uploads');

[path.join(__dirname, 'data'), UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname).toLowerCase()));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let games = {};

function saveData() {
  const out = {};
  for (const [code, g] of Object.entries(games)) {
    out[code] = {
      code, quizName: g.quizName, adminPassword: g.adminPassword,
      status: g.status, questions: g.questions,
      currentQuestion: g.currentQuestion, timePerQuestion: g.timePerQuestion,
      players: g.players, answers: g.answers
    };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [code, g] of Object.entries(raw)) {
      games[code] = { ...g, timer: null, _endingQuestion: false, _questionEnded: false };
      if (games[code].status === 'playing') games[code].status = 'waiting';
    }
  } catch (e) { console.error('loadData error:', e.message); }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (games[code]);
  return code;
}

function calcScore(timeLeft, maxTime) {
  return Math.max(100, Math.floor(200 * (timeLeft / maxTime)));
}

function getActivePlayers(game) {
  return game.players.filter(p => p.name !== '__presenter__' && p.active !== false);
}

function buildLeaderboard(game) {
  return getActivePlayers(game)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
}

function endQuestion(code) {
  const game = games[code];
  if (!game || game._questionEnded) return;
  game._questionEnded  = true;
  game._endingQuestion = false;
  clearInterval(game.timer);
  game.timer = null;

  const q       = game.questions[game.currentQuestion];
  const answers = game.answers[game.currentQuestion] || {};

  const answerCounts = {};
  q.options.forEach((_, i) => { answerCounts[i] = 0; });
  Object.values(answers).forEach(a => {
    if (answerCounts[a.answer] !== undefined) answerCounts[a.answer]++;
  });

  io.to(code).emit('questionEnd', {
    correctAnswer: q.correctAnswer,
    answerCounts,
    leaderboard: buildLeaderboard(game)
  });
  saveData();
}

function advanceGame(code) {
  const game = games[code];
  if (!game) return;

  game.currentQuestion++;

  if (game.currentQuestion >= game.questions.length) {
    game.status = 'finished';
    io.to(code).emit('gameEnd', { leaderboard: buildLeaderboard(game) });
    saveData();
    return;
  }

  game._endingQuestion = false;
  game._questionEnded  = false;

  const q       = game.questions[game.currentQuestion];
  const maxTime = q.time || game.timePerQuestion || 30;

  game.timerStart = Date.now();

  io.to(code).emit('newQuestion', {
    index: game.currentQuestion, total: game.questions.length,
    question: q.question, options: q.options,
    image: q.image || null, imagePosition: q.imagePosition || 'top',
    time: maxTime
  });

  let timeLeft = maxTime;
  game.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timerUpdate', { timeLeft, maxTime });
    if (timeLeft <= 0) {
      clearInterval(game.timer);
      game.timer = null;
      endQuestion(code);
    }
  }, 1000);
}

// REST
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/api/rooms', (req, res) => {
  const { quizName, adminPassword, timePerQuestion, questions } = req.body;
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });
  const code = generateCode();
  games[code] = {
    code, quizName: quizName || 'PollWave Quiz',
    adminPassword, status: 'waiting',
    questions: questions || [], currentQuestion: -1,
    timePerQuestion: timePerQuestion || 30,
    players: [], answers: {},
    timer: null, _endingQuestion: false, _questionEnded: false
  };
  saveData();
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const game = games[req.params.code.toUpperCase()];
  if (!game) return res.status(404).json({ error: 'Not found' });
  res.json({
    code: game.code, quizName: game.quizName, status: game.status,
    questions: game.questions, currentQuestion: game.currentQuestion,
    timePerQuestion: game.timePerQuestion,
    playerCount: getActivePlayers(game).length
  });
});

app.post('/api/rooms/:code/rejoin', (req, res) => {
  const { adminPassword } = req.body;
  const game = games[req.params.code.toUpperCase()];
  if (!game) return res.status(404).json({ error: 'Not found' });
  if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Wrong password' });
  res.json({
    code: game.code, quizName: game.quizName, status: game.status,
    questions: game.questions, currentQuestion: game.currentQuestion,
    timePerQuestion: game.timePerQuestion,
    playerCount: getActivePlayers(game).length
  });
});

app.put('/api/rooms/:code/name', (req, res) => {
  const { adminPassword, quizName } = req.body;
  const game = games[req.params.code.toUpperCase()];
  if (!game) return res.status(404).json({ error: 'Not found' });
  if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Wrong password' });
  game.quizName = quizName;
  saveData();
  res.json({ ok: true });
});

app.put('/api/rooms/:code/questions', (req, res) => {
  const { adminPassword, questions, timePerQuestion } = req.body;
  const game = games[req.params.code.toUpperCase()];
  if (!game) return res.status(404).json({ error: 'Not found' });
  if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Wrong password' });
  if (questions)       game.questions       = questions;
  if (timePerQuestion) game.timePerQuestion = timePerQuestion;
  saveData();
  res.json({ ok: true });
});

app.delete('/api/rooms/:code', (req, res) => {
  const { adminPassword } = req.body;
  const code = req.params.code.toUpperCase();
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Not found' });
  if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Wrong password' });
  clearInterval(game.timer);
  delete games[code];
  saveData();
  res.json({ ok: true });
});

// Sockets
io.on('connection', socket => {

  socket.on('joinGame', ({ code, name }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game) { socket.emit('error', { message: 'Room not found' }); return; }

    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    const isPresenter = name === '__presenter__';
    if (!isPresenter) {
      const existing = game.players.find(p => p.name === name);
      if (existing) { existing.active = true; existing.socketId = socket.id; }
      else game.players.push({ name, score: 0, active: true, socketId: socket.id });
      saveData();
      io.to(code).emit('playerUpdate', { count: getActivePlayers(game).length });
    }

    socket.emit('roomJoined', {
      code, quizName: game.quizName, status: game.status,
      currentQuestion: game.currentQuestion,
      playerCount: getActivePlayers(game).length
    });
  });

  socket.on('startGame', ({ code, adminPassword }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game) return socket.emit('error', { message: 'Not found' });
    if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
      return socket.emit('error', { message: 'Wrong password' });
    if (game.status !== 'waiting')  return socket.emit('error', { message: 'Already started' });
    if (!game.questions.length)     return socket.emit('error', { message: 'No questions' });

    game.status = 'playing';
    game.currentQuestion = -1;
    game.answers = {};
    game._endingQuestion = false;
    game._questionEnded  = false;

    io.to(code).emit('gameStarted', { quizName: game.quizName });
    saveData();
    setTimeout(() => advanceGame(code), 1000);
  });

  socket.on('submitAnswer', ({ code, answer }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game || game.status !== 'playing') return;
    const name = socket.data.name;
    if (!name || name === '__presenter__') return;

    const qi = game.currentQuestion;
    if (!game.answers[qi]) game.answers[qi] = {};
    if (game.answers[qi][name]) return;

    const q       = game.questions[qi];
    const maxTime = q.time || game.timePerQuestion || 30;
    const elapsed = Math.floor((Date.now() - (game.timerStart || Date.now())) / 1000);
    const timeLeft= Math.max(0, maxTime - elapsed);
    const correct = answer === q.correctAnswer;
    const points  = correct ? calcScore(timeLeft, maxTime) : 0;

    game.answers[qi][name] = { answer, correct, points };
    const player = game.players.find(p => p.name === name);
    if (player && correct) player.score += points;

    socket.emit('answerResult', { correct, points, score: player ? player.score : 0 });
    saveData();

    const activePlayers = getActivePlayers(game);
    const answered      = Object.keys(game.answers[qi]).length;
    if (answered >= activePlayers.length && !game._endingQuestion) {
      game._endingQuestion = true;
      clearInterval(game.timer);
      game.timer = null;
      setTimeout(() => {
        endQuestion(code);
        setTimeout(() => advanceGame(code), 1500);
      }, 500);
    }
  });

  socket.on('nextQuestion', ({ code, adminPassword }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game) return socket.emit('error', { message: 'Not found' });
    if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
      return socket.emit('error', { message: 'Wrong password' });
    if (!game._questionEnded) endQuestion(code);
    setTimeout(() => advanceGame(code), 500);
  });

  socket.on('endGame', ({ code, adminPassword }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game) return socket.emit('error', { message: 'Not found' });
    if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
      return socket.emit('error', { message: 'Wrong password' });
    clearInterval(game.timer);
    game.timer  = null;
    game.status = 'finished';
    io.to(code).emit('gameEnd', { leaderboard: buildLeaderboard(game) });
    saveData();
  });

  socket.on('resetGame', ({ code, adminPassword }) => {
    code = (code || '').toUpperCase();
    const game = games[code];
    if (!game) return socket.emit('error', { message: 'Not found' });
    if (adminPassword !== game.adminPassword && adminPassword !== ADMIN_PASSWORD)
      return socket.emit('error', { message: 'Wrong password' });
    clearInterval(game.timer);
    game.timer = null;
    game.status = 'waiting';
    game.currentQuestion = -1;
    game.answers = {};
    game._endingQuestion = false;
    game._questionEnded  = false;
    game.players.forEach(p => { p.score = 0; });
    io.to(code).emit('gameReset');
    saveData();
  });

  socket.on('disconnect', () => {
    const { code, name } = socket.data;
    if (!code || !name) return;
    const game = games[code];
    if (!game) return;
    const player = game.players.find(p => p.name === name);
    if (player) player.active = false;
    io.to(code).emit('playerUpdate', { count: getActivePlayers(game).length });
    saveData();
  });
});

loadData();
server.listen(PORT, () => console.log(`PollWave on port ${PORT}`));
