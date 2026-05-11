const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

// Uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

// Game state
let gameState = {
  status: 'waiting',
  currentQuestion: 0,
  questionStartTime: null,
  questionTimer: null,
  players: {},
  questions: [
    {
      id: 1,
      text: "Was ist die Hauptstadt von Deutschland?",
      options: ["Berlin", "München", "Hamburg", "Frankfurt"],
      correct: 0,
      time: 20,
      image: null
    },
    {
      id: 2,
      text: "Wieviel ist 7 x 8?",
      options: ["54", "56", "58", "60"],
      correct: 1,
      time: 15,
      image: null
    }
  ],
  answers: {}
};

function calculateScore(timeLeft, totalTime) {
  const timeBonus = Math.round((timeLeft / totalTime) * 800);
  return 200 + timeBonus;
}

function getLeaderboard() {
  return Object.values(gameState.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function getAnswerDistribution() {
  const q = gameState.questions[gameState.currentQuestion];
  if (!q) return [];
  const dist = q.options.map((opt, i) => ({
    option: opt,
    count: 0,
    correct: i === q.correct
  }));
  const answers = gameState.answers[gameState.currentQuestion] || {};
  Object.values(answers).forEach(a => {
    if (dist[a.answer]) dist[a.answer].count++;
  });
  return dist;
}

function startQuestionTimer() {
  const q = gameState.questions[gameState.currentQuestion];
  if (!q) return;
  
  gameState.questionStartTime = Date.now();
  gameState.status = 'question';
  
  let timeLeft = q.time;
  
  if (gameState.questionTimer) clearInterval(gameState.questionTimer);
  
  gameState.questionTimer = setInterval(() => {
    timeLeft--;
    io.emit('timerUpdate', { timeLeft, totalTime: q.time });
    
    if (timeLeft <= 0) {
      clearInterval(gameState.questionTimer);
      showResults();
    }
  }, 1000);
  
  io.emit('question', {
    questionNumber: gameState.currentQuestion + 1,
    totalQuestions: gameState.questions.length,
    text: q.text,
    options: q.options,
    time: q.time,
    image: q.image
  });
}

function showResults() {
  gameState.status = 'result';
  const q = gameState.questions[gameState.currentQuestion];
  const dist = getAnswerDistribution();
  
  io.emit('showResult', {
    correctAnswer: q.correct,
    correctText: q.options[q.correct],
    distribution: dist,
    leaderboard: getLeaderboard()
  });
  
  setTimeout(() => {
    if (gameState.currentQuestion < gameState.questions.length - 1) {
      io.emit('showLeaderboard', { leaderboard: getLeaderboard() });
      gameState.status = 'leaderboard';
      setTimeout(() => nextQuestion(), 5000);
    } else {
      gameState.status = 'ended';
      io.emit('gameEnded', { leaderboard: getLeaderboard() });
    }
  }, 5000);
}

function nextQuestion() {
  gameState.currentQuestion++;
  if (gameState.currentQuestion >= gameState.questions.length) {
    gameState.status = 'ended';
    io.emit('gameEnded', { leaderboard: getLeaderboard() });
    return;
  }
  
  gameState.status = 'getready';
  io.emit('getReady', { 
    questionNumber: gameState.currentQuestion + 1,
    totalQuestions: gameState.questions.length
  });
  
  setTimeout(() => startQuestionTimer(), 3000);
}

// Socket.io
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  
  // Send current state to new connection
  socket.emit('currentState', {
    status: gameState.status,
    playerCount: Object.keys(gameState.players).length
  });

  // Join game
  socket.on('join', (data) => {
    const name = data.name?.trim();
    if (!name) return socket.emit('joinError', { message: 'Name erforderlich' });
    
    const nameTaken = Object.values(gameState.players).some(p => p.name.toLowerCase() === name.toLowerCase());
    if (nameTaken) return socket.emit('joinError', { message: 'Name bereits vergeben' });
    
    gameState.players[socket.id] = {
      name,
      score: 0,
      answers: 0
    };
    
    socket.emit('joinSuccess', { name });
    io.emit('playerCount', { count: Object.keys(gameState.players).length });
    io.to('admin').emit('playerList', { players: Object.values(gameState.players) });
    
    console.log(`${name} joined. Total: ${Object.keys(gameState.players).length}`);
  });

  // Submit answer
  socket.on('submitAnswer', (data) => {
    const player = gameState.players[socket.id];
    if (!player || gameState.status !== 'question') return;
    
    const qIndex = gameState.currentQuestion;
    if (!gameState.answers[qIndex]) gameState.answers[qIndex] = {};
    if (gameState.answers[qIndex][socket.id]) return; // Already answered
    
    const q = gameState.questions[qIndex];
    const timeLeft = Math.max(0, q.time - Math.round((Date.now() - gameState.questionStartTime) / 1000));
    const correct = data.answer === q.correct;
    
    gameState.answers[qIndex][socket.id] = {
      answer: data.answer,
      correct,
      timeLeft
    };
    
    if (correct) {
      player.score += calculateScore(timeLeft, q.time);
    }
    player.answers++;
    
    socket.emit('answerResult', {
      correct,
      correctAnswer: q.correct,
      score: player.score
    });
    
    const totalAnswers = Object.keys(gameState.answers[qIndex]).length;
    const totalPlayers = Object.keys(gameState.players).length;
    io.to('admin').emit('answerStats', { answered: totalAnswers, total: totalPlayers });
  });

  // Admin join
  socket.on('adminJoin', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      socket.join('admin');
      socket.emit('adminJoined', {
        questions: gameState.questions,
        players: Object.values(gameState.players),
        status: gameState.status
      });
    } else {
      socket.emit('adminError', { message: 'Falsches Passwort' });
    }
  });

  // Admin controls
  socket.on('startGame', () => {
    if (!socket.rooms.has('admin')) return;
    gameState.status = 'getready';
    gameState.currentQuestion = 0;
    gameState.answers = {};
    Object.values(gameState.players).forEach(p => { p.score = 0; p.answers = 0; });
    
    io.emit('getReady', { 
      questionNumber: 1,
      totalQuestions: gameState.questions.length
    });
    setTimeout(() => startQuestionTimer(), 3000);
  });

  socket.on('pauseGame', () => {
    if (!socket.rooms.has('admin')) return;
    if (gameState.questionTimer) clearInterval(gameState.questionTimer);
    gameState.status = 'paused';
    io.emit('gamePaused');
  });

  socket.on('nextQuestion', () => {
    if (!socket.rooms.has('admin')) return;
    if (gameState.questionTimer) clearInterval(gameState.questionTimer);
    nextQuestion();
  });

  socket.on('resetGame', () => {
    if (!socket.rooms.has('admin')) return;
    if (gameState.questionTimer) clearInterval(gameState.questionTimer);
    gameState.status = 'waiting';
    gameState.currentQuestion = 0;
    gameState.answers = {};
    gameState.players = {};
    io.emit('gameReset');
    io.emit('playerCount', { count: 0 });
  });

  // Admin: Add question
  socket.on('addQuestion', (data) => {
    if (!socket.rooms.has('admin')) return;
    const newQ = {
      id: Date.now(),
      text: data.text,
      options: data.options,
      correct: data.correct,
      time: data.time || 20,
      image: data.image || null
    };
    gameState.questions.push(newQ);
    socket.emit('questionsUpdated', { questions: gameState.questions });
  });

  socket.on('deleteQuestion', (data) => {
    if (!socket.rooms.has('admin')) return;
    gameState.questions = gameState.questions.filter(q => q.id !== data.id);
    socket.emit('questionsUpdated', { questions: gameState.questions });
  });

  socket.on('updateQuestion', (data) => {
    if (!socket.rooms.has('admin')) return;
    const index = gameState.questions.findIndex(q => q.id === data.id);
    if (index !== -1) gameState.questions[index] = { ...gameState.questions[index], ...data };
    socket.emit('questionsUpdated', { questions: gameState.questions });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (gameState.players[socket.id]) {
      console.log(`${gameState.players[socket.id].name} left`);
      delete gameState.players[socket.id];
      io.emit('playerCount', { count: Object.keys(gameState.players).length });
    }
  });
});

// Upload endpoint
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

server.listen(PORT, () => {
  console.log(`PollWave running on port ${PORT}`);
});
