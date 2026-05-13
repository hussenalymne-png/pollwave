const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ FIX 1: uploads/ Ordner automatisch erstellen
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Multer-Konfiguration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => 
    cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Max 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (ext) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt!'));
  }
});

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ✅ FIX 4: Explizite /admin Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Spielzustand pro Raum
const games = new Map();

function getGame(code) {
  if (!games.has(code)) {
    games.set(code, {
      code,
      state: 'waiting',
      questions: [],
      currentQuestion: -1,
      participants: [],
      answers: {},
      timerInterval: null,
      timeLeft: 0,
      maxTime: 0,
    });
  }
  return games.get(code);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) 
      code += chars[Math.floor(Math.random() * chars.length)];
  } while (games.has(code));
  return code;
}

// ✅ Hilfsfunktion: Antwort-Statistiken berechnen
function getAnswerStats(game) {
  const q = game.questions[game.currentQuestion];
  if (!q) return null;

  const stats = q.options.map((opt, i) => ({
    option: opt,
    count: 0,
    percentage: 0,
    isCorrect: i === q.correct
  }));

  let totalAnswers = 0;
  Object.values(game.answers).forEach(a => {
    if (a.answer >= 0 && a.answer < stats.length) {
      stats[a.answer].count++;
      totalAnswers++;
    }
  });

  // Prozentsätze berechnen
  if (totalAnswers > 0) {
    stats.forEach(s => {
      s.percentage = Math.round((s.count / totalAnswers) * 100);
    });
  }

  return {
    stats,
    totalAnswers,
    totalPlayers: game.participants.length,
    correctCount: Object.values(game.answers)
      .filter(a => a.correct).length
  };
}

// ✅ Hilfsfunktion: Leaderboard
function getLeaderboard(game) {
  return game.participants
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Top 10
}

// ✅ Hilfsfunktion: Timer stoppen
function clearTimer(game) {
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }
}

// ✅ Hilfsfunktion: Frage starten
function startQuestion(room) {
  const game = getGame(room);
  if (!game) return;
  const q = game.questions[game.currentQuestion];
  if (!q) return;

  game.answers = {};
  game.maxTime = 20;
  game.timeLeft = game.maxTime;

  const questionData = {
    index: game.currentQuestion,
    total: game.questions.length,
    question: q.question,
    options: q.options,
    image: q.image,
    time: game.maxTime
  };

  io.to(room).emit('questionStarted', questionData);
  io.to(room).emit('leaderboardUpdate', getLeaderboard(game));

  // Timer starten
  clearTimer(game);
  game.timerInterval = setInterval(() => {
    game.timeLeft--;
    io.to(room).emit('timerUpdate', { time: game.timeLeft });

    // ✅ FIX 3: Live Antwort-Stats alle Sekunde an Admin
    const answerStats = getAnswerStats(game);
    if (answerStats) {
      io.to(room).emit('answerStats', answerStats);
    }

    if (game.timeLeft <= 0) {
      clearTimer(game);
      endQuestion(room);
    }
  }, 1000);
}

// ✅ Hilfsfunktion: Frage beenden
function endQuestion(room) {
  const game = getGame(room);
  if (!game) return;
  const q = game.questions[game.currentQuestion];
  if (!q) return;

  // Nicht-Antworter als falsch markieren
  game.participants.forEach(p => {
    if (!game.answers[p.id]) {
      game.answers[p.id] = { answer: -1, correct: false, points: 0 };
    }
  });

  const finalStats = getAnswerStats(game);
  io.to(room).emit('questionEnded', { 
    correct: q.correct,
    stats: finalStats
  });
  io.to(room).emit('leaderboardUpdate', getLeaderboard(game));

  // Nach 3 Sekunden nächste Frage oder Ende
  setTimeout(() => {
    const game = getGame(room); // Neu holen (sicher)
    if (!game || game.state !== 'playing') return;
    const next = game.currentQuestion + 1;
    if (next >= game.questions.length) {
      endGame(room);
    } else {
      game.currentQuestion = next;
      startQuestion(room);
    }
  }, 3000);
}

// ✅ Hilfsfunktion: Spiel beenden
function endGame(room) {
  const game = getGame(room);
  if (!game) return;
  clearTimer(game);
  game.state = 'finished';
  io.to(room).emit('gameFinished', getLeaderboard(game));
}

// ✅ Hilfsfunktion: Frage an einzelnen Socket senden
function sendQuestionToSocket(socket, game) {
  const q = game.questions[game.currentQuestion];
  if (!q) return;
  socket.emit('questionStarted', {
    index: game.currentQuestion,
    total: game.questions.length,
    question: q.question,
    options: q.options,
    image: q.image,
    time: game.timeLeft
  });
}

// ---------- Socket-Ereignisse ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = '';

  // === Admin Login ===
  socket.on('adminLogin', (data, cb) => {
    const { code } = data;
    if (!code) {
      // Neuen Raum erstellen
      const newCode = generateRoomCode();
      const game = getGame(newCode);
      game.state = 'waiting';
      socket.join(newCode);
      socket.adminRoom = newCode;
      currentRoom = newCode;
      cb({ 
        success: true, 
        code: newCode, 
        state: game.state, 
        questions: game.questions 
      });
    } else {
      // Bestehendem Raum beitreten
      const upperCode = code.toUpperCase();
      const game = getGame(upperCode);
      socket.join(upperCode);
      socket.adminRoom = upperCode;
      currentRoom = upperCode;
      cb({ 
        success: true, 
        code: upperCode, 
        state: game.state, 
        questions: game.questions,
        participants: game.participants.length
      });
    }
  });

  // Admin: Frage hinzufügen
  socket.on('addQuestion', (data, cb) => {
    if (!socket.adminRoom) return cb({ success: false, error: 'Kein Admin' });
    const game = getGame(currentRoom);
    if (!game) return cb({ success: false, error: 'Kein Raum' });

    const { question, options, correct, image } = data;
    if (!question || !options || options.length < 2 || correct === undefined) {
      return cb({ success: false, error: 'Ungültige Daten' });
    }
    game.questions.push({ 
      question, 
      options, 
      correct, 
      image: image || null 
    });
    cb({ success: true, questions: game.questions });
    io.to(currentRoom).emit('questionsUpdated', game.questions);
  });

  // Admin: Frage löschen
  socket.on('deleteQuestion', (index, cb) => {
    if (!socket.adminRoom) return cb({ success: false });
    const game = getGame(currentRoom);
    if (!game) return cb({ success: false });
    if (index < 0 || index >= game.questions.length) 
      return cb({ success: false });

    game.questions.splice(index, 1);
    cb({ success: true, questions: game.questions });
    io.to(currentRoom).emit('questionsUpdated', game.questions);
  });

  // Admin: Spiel starten
  socket.on('startGame', (cb) => {
    if (!socket.adminRoom) return cb({ success: false });
    const game = getGame(currentRoom);
    if (!game || game.questions.length === 0) 
      return cb({ success: false, error: 'Keine Fragen vorhanden' });
    if (game.state !== 'waiting') 
      return cb({ success: false, error: 'Spiel läuft bereits' });

    game.state = 'playing';
    game.currentQuestion = 0;
    // Alle Punkte zurücksetzen
    game.participants.forEach(p => p.score = 0);
    startQuestion(currentRoom);
    cb({ success: true });
  });

  // Admin: Nächste Frage
  socket.on('nextQuestion', (cb) => {
    if (!socket.adminRoom) return cb({ success: false });
    const game = getGame(currentRoom);
    if (!game || game.state !== 'playing') return cb({ success: false });

    clearTimer(game);
    const next = game.currentQuestion + 1;
    if (next >= game.questions.length) {
      endGame(currentRoom);
      return cb({ success: true, message: 'Spiel beendet' });
    }
    game.currentQuestion = next;
    startQuestion(currentRoom);
    cb({ success: true });
  });

  // ✅ FIX 5: Admin: Spiel zurücksetzen
  socket.on('resetGame', (cb) => {
    if (!socket.adminRoom) return cb({ success: false });
    const game = getGame(currentRoom);
    if (!game) return cb({ success: false });

    clearTimer(game);
    game.state = 'waiting';
    game.currentQuestion = -1;
    game.answers = {};
    game.timeLeft = 0;
    // Punkte zurücksetzen
    game.participants.forEach(p => p.score = 0);

    io.to(currentRoom).emit('gameReset');
    cb({ success: true });
  });

  // === Spieler: Beitreten ===
  socket.on('joinGame', (data, cb) => {
    const { name, code } = data;
    if (!name || !code) 
      return cb({ success: false, error: 'Name und Code erforderlich' });

    const upperCode = code.toUpperCase().trim();
    const game = getGame(upperCode);

    if (game.state === 'finished') 
      return cb({ success: false, error: 'Spiel bereits beendet' });
    if (game.participants.find(p => p.name === name)) 
      return cb({ success: false, error: 'Name bereits vergeben' });
    if (game.participants.length >= 50) 
      return cb({ success: false, error: 'Raum ist voll (max. 50)' });

    socket.join(upperCode);
    currentRoom = upperCode;
    playerName = name;
    game.participants.push({ id: socket.id, name, score: 0 });

    cb({ success: true, state: game.state });
    io.to(upperCode).emit('participantJoined', { 
      count: game.participants.length,
      name: name 
    });

    // Falls Spiel schon läuft → aktuelle Frage senden
    if (game.state === 'playing') {
      sendQuestionToSocket(socket, game);
    }
  });

  // === Spieler: Antwort einreichen ===
  socket.on('submitAnswer', (data, cb) => {
    const game = getGame(currentRoom);
    if (!game || game.state !== 'playing') 
      return cb({ success: false, error: 'Kein aktives Spiel' });
    if (data.questionIndex !== game.currentQuestion) 
      return cb({ success: false, error: 'Falsche Frage' });
    if (game.answers[socket.id]) 
      return cb({ success: false, error: 'Bereits geantwortet' });

    const q = game.questions[game.currentQuestion];
    const correct = (data.answer === q.correct);

    // ✅ FIX 2: Server-seitige timeLeft (nicht vom Client!)
    const timeLeft = game.timeLeft;
    const points = correct 
      ? Math.max(100, Math.floor(200 * (timeLeft / game.maxTime))) 
      : 0;

    game.answers[socket.id] = { 
      answer: data.answer, 
      correct, 
      points 
    };

    const participant = game.participants.find(p => p.id === socket.id);
    if (participant) participant.score += points;

    cb({ success: true, correct, points });

    // ✅ Live Stats an Admin senden
    const answerStats = getAnswerStats(game);
    if (answerStats) {
      io.to(currentRoom).emit('answerStats', answerStats);
    }

    // Alle haben geantwortet → vorzeitig beenden
    const answeredCount = Object.keys(game.answers).length;
    if (answeredCount >= game.participants.length) {
      clearTimer(game);
      endQuestion(currentRoom);
    }
  });

  // === Disconnect ===
  socket.on('disconnect', () => {
    if (currentRoom) {
      const game = getGame(currentRoom);
      if (game) {
        // Spieler entfernen
        game.participants = game.participants.filter(
          p => p.id !== socket.id
        );
        delete game.answers[socket.id];

        io.to(currentRoom).emit('participantJoined', { 
          count: game.participants.length 
        });

        // Wenn alle weg → Raum pausieren
        if (game.participants.length === 0 && game.state === 'playing') {
          clearTimer(game);
          game.state = 'waiting';
          game.currentQuestion = -1;
          io.to(currentRoom).emit('gameReset');
        }
      }
    }
  });
});

// Upload-Route
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  res.json({ 
    success: true, 
    url: '/uploads/' + req.file.filename 
  });
});

// Upload Fehler-Handler
app.use((err, req, res, next) => {
  if (err.message === 'Nur Bilder erlaubt!') {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => 
  console.log(`✅ PollWave Server läuft auf Port ${PORT}`)
);
