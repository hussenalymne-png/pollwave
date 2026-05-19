const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data', 'games.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

let rooms = {};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      rooms = data.rooms || {};
      console.log(`Loaded ${Object.keys(rooms).length} rooms from disk`);
    }
  } catch (e) {
    console.error('Error loading data:', e);
    rooms = {};
  }
}

function saveData() {
  try {
    const dataToSave = { rooms: {} };
    for (const [code, room] of Object.entries(rooms)) {
      dataToSave.rooms[code] = {
        code: room.code,
        quizName: room.quizName || 'PollWave Quiz',
        adminPassword: room.adminPassword,
        questions: room.questions,
        state: room.state,
        currentQuestion: room.currentQuestion,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          score: p.score,
          answers: p.answers
        })),
        createdAt: room.createdAt
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (e) {
    console.error('Error saving data:', e);
  }
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateCode() : code;
}

function calculateScore(timeLeft, maxTime) {
  return Math.max(100, Math.floor(200 * (timeLeft / maxTime)));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/api/rooms', (req, res) => {
  const { password, quizName } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  const code = generateCode();
  rooms[code] = {
    code,
    quizName: quizName || 'PollWave Quiz',
    adminPassword: password,
    questions: [],
    state: 'waiting',
    currentQuestion: -1,
    players: [],
    createdAt: new Date().toISOString()
  };
  saveData();
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    quizName: room.quizName || 'PollWave Quiz',
    state: room.state,
    playerCount: room.players.filter(p => p.name !== '__presenter__').length,
    questionCount: room.questions.length,
    currentQuestion: room.currentQuestion
  });
});

app.put('/api/rooms/:code/questions', (req, res) => {
  const { password, questions } = req.body;
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  room.questions = questions;
  saveData();
  res.json({ success: true });
});

app.put('/api/rooms/:code/name', (req, res) => {
  const { password, quizName } = req.body;
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  room.quizName = quizName || 'PollWave Quiz';
  saveData();
  io.to(req.params.code.toUpperCase()).emit('quizNameUpdated', { quizName: room.quizName });
  res.json({ success: true });
});

app.delete('/api/rooms/:code', (req, res) => {
  const { password } = req.body;
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  delete rooms[req.params.code.toUpperCase()];
  saveData();
  res.json({ success: true });
});

app.post('/api/rooms/:code/rejoin', (req, res) => {
  const { password } = req.body;
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  res.json({
    code: room.code,
    quizName: room.quizName || 'PollWave Quiz',
    state: room.state,
    questions: room.questions,
    currentQuestion: room.currentQuestion,
    players: room.players.filter(p => p.name !== '__presenter__').map(p => ({
      name: p.name,
      score: p.score
    }))
  });
});

function handleNextQuestion(code) {
  const room = rooms[code];
  if (!room) return;

  room.currentQuestion++;

  if (room.currentQuestion >= room.questions.length) {
    room.state = 'finished';
    const finalScores = room.players
      .filter(p => p.name !== '__presenter__')
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

    io.to(code).emit('gameFinished', { players: finalScores });
    saveData();
    return;
  }

  const question = room.questions[room.currentQuestion];
  const maxTime = question.time || 30;
  room.currentAnswers = new Array(question.options.length).fill(0);
  room.questionStartTime = Date.now();
  room.maxTime = maxTime;

  io.to(code).emit('newQuestion', {
    index: room.currentQuestion,
    total: room.questions.length,
    question: question.question,
    options: question.options,
    image: question.image || null,
    time: maxTime
  });

  let timeLeft = maxTime;
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timerUpdate', { timeLeft, maxTime });

    if (timeLeft <= 0) {
      clearInterval(room.timer);
      const correctIndex = question.correctAnswer;
      const stats = room.players
        .filter(p => p.name !== '__presenter__')
        .map(p => ({
          name: p.name,
          answer: p.answers?.[room.currentQuestion],
          score: p.score
        }));

      io.to(code).emit('questionEnd', {
        correctAnswer: correctIndex,
        correctText: question.options[correctIndex],
        stats,
        answerCounts: room.currentAnswers
      });
      saveData();
    }
  }, 1000);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  function handleJoin(data) {
    const { code, name } = data;
    const upperCode = code.toUpperCase();
    const room = rooms[upperCode];

    if (!room) return socket.emit('error', { message: 'Raum nicht gefunden' });
    if (room.players.length >= 50 && name !== '__presenter__') {
      return socket.emit('error', { message: 'Raum ist voll (max. 50 Spieler)' });
    }

    const existingPlayer = room.players.find(p => p.name === name);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
    } else {
      room.players.push({
        id: socket.id,
        name,
        score: 0,
        answers: {}
      });
    }

    socket.join(upperCode);
    socket.roomCode = upperCode;
    socket.playerName = name;

    if (name === '__presenter__') {
      socket.emit('joinedAsPresenter', {
        quizName: room.quizName || 'PollWave Quiz',
        state: room.state,
        playerCount: room.players.filter(p => p.name !== '__presenter__').length
      });
    } else {
      socket.emit('joinedRoom', {
        name,
        quizName: room.quizName || 'PollWave Quiz',
        state: room.state,
        playerCount: room.players.filter(p => p.name !== '__presenter__').length
      });

      io.to(upperCode).emit('playerJoined', {
        name,
        playerCount: room.players.filter(p => p.name !== '__presenter__').length
      });
    }

    saveData();
  }

  socket.on('joinRoom', handleJoin);
  socket.on('joinGame', handleJoin);

  socket.on('startGame', ({ code, password }) => {
    const room = rooms[code];
    if (!room || password !== ADMIN_PASSWORD) return;
    if (room.state !== 'waiting') return;

    room.state = 'playing';
    room.currentQuestion = -1;
    io.to(code).emit('gameStarted', { quizName: room.quizName || 'PollWave Quiz' });
    setTimeout(() => handleNextQuestion(code), 1000);
    saveData();
  });

  socket.on('adminNextQuestion', ({ code, password }) => {
    const room = rooms[code];
    if (!room || password !== ADMIN_PASSWORD) return;
    if (room.timer) clearInterval(room.timer);
    handleNextQuestion(code);
  });

  socket.on('nextQuestion', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.name !== '__presenter__') return;
    if (room.timer) clearInterval(room.timer);
    handleNextQuestion(code);
  });

  socket.on('endGame', ({ code, password }) => {
    const room = rooms[code];
    if (!room || password !== ADMIN_PASSWORD) return;
    if (room.timer) clearInterval(room.timer);

    room.state = 'finished';
    const finalScores = room.players
      .filter(p => p.name !== '__presenter__')
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

    io.to(code).emit('gameFinished', { players: finalScores });
    saveData();
  });

  socket.on('resetGame', ({ code, password }) => {
    const room = rooms[code];
    if (!room || password !== ADMIN_PASSWORD) return;
    if (room.timer) clearInterval(room.timer);

    room.state = 'waiting';
    room.currentQuestion = -1;
    room.players = room.players.filter(p => p.name === '__presenter__');
    room.currentAnswers = [];

    io.to(code).emit('gameReset');
    saveData();
  });

  socket.on('submitAnswer', ({ code, answerIndex }) => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.name === '__presenter__') return;
    if (player.answers?.[room.currentQuestion] !== undefined) return;

    if (!player.answers) player.answers = {};
    player.answers[room.currentQuestion] = answerIndex;

    if (room.currentAnswers) room.currentAnswers[answerIndex]++;

    const question = room.questions[room.currentQuestion];
    if (answerIndex === question.correctAnswer) {
      const timeLeft = Math.max(0, room.maxTime - Math.floor((Date.now() - room.questionStartTime) / 1000));
      player.score += calculateScore(timeLeft, room.maxTime);
    }

    io.to(code).emit('answerUpdate', {
      answerCounts: room.currentAnswers,
      totalAnswers: room.players.filter(p => p.name !== '__presenter__' && p.answers?.[room.currentQuestion] !== undefined).length,
      totalPlayers: room.players.filter(p => p.name !== '__presenter__').length
    });

    socket.emit('answerReceived', {
      answerIndex,
      correct: answerIndex === question.correctAnswer
    });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player && player.name !== '__presenter__') {
      io.to(code).emit('playerLeft', {
        name: player.name,
        playerCount: room.players.filter(p => p.name !== '__presenter__' && p.id !== socket.id).length
      });
    }
  });
});

loadData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PollWave running on port ${PORT}`));
