const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Multer-Konfiguration für Bild-Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.static('public'));   // Statische Dateien (Spieler-Client)
app.use('/uploads', express.static('uploads'));

// Spielzustand pro Raum
const games = new Map();

function getGame(code) {
  if (!games.has(code)) {
    games.set(code, {
      code,
      state: 'waiting',      // waiting, playing, finished
      questions: [],
      currentQuestion: -1,
      participants: [],
      answers: {},           // { socketId: { name, score, answer, timeLeft } }
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
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (games.has(code));
  return code;
}

// ---------- Socket-Ereignisse ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = '';

  // === Admin ===
  socket.on('adminLogin', (data, cb) => {
    const { code } = data;
    if (!code) {
      const newCode = generateRoomCode();
      const game = getGame(newCode);
      game.state = 'waiting';
      socket.join(newCode);
      socket.adminRoom = newCode;
      currentRoom = newCode;
      cb({ success: true, code: newCode, state: game.state, questions: game.questions });
    } else {
      const game = getGame(code);
      socket.join(code);
      socket.adminRoom = code;
      currentRoom = code;
      cb({ success: true, code, state: game.state, questions: game.questions });
    }
  });

  // Admin: Frage hinzufügen
  socket.on('addQuestion', (data, cb) => {
    const game = getGame(currentRoom);
    if (!game || !socket.adminRoom) return cb({ success: false, error: 'Kein Raum' });
    const { question, options, correct, image } = data;
    if (!question || !options || options.length < 2 || correct === undefined) {
      return cb({ success: false, error: 'Ungültige Daten' });
    }
    game.questions.push({ question, options, correct, image: image || null });
    cb({ success: true, questions: game.questions });
    io.to(currentRoom).emit('questionsUpdated', game.questions);
  });

  // Admin: Frage löschen
  socket.on('deleteQuestion', (index, cb) => {
    const game = getGame(currentRoom);
    if (!game) return cb({ success: false });
    if (index < 0 || index >= game.questions.length) return cb({ success: false });
    game.questions.splice(index, 1);
    cb({ success: true, questions: game.questions });
    io.to(currentRoom).emit('questionsUpdated', game.questions);
  });

  // Admin: Spiel starten
  socket.on('startGame', (cb) => {
    const game = getGame(currentRoom);
    if (!game || game.questions.length === 0) return cb({ success: false, error: 'Keine Fragen' });
    if (game.state !== 'waiting') return cb({ success: false, error: 'Spiel läuft bereits' });
    game.state = 'playing';
    game.currentQuestion = 0;
    startQuestion(currentRoom);
    cb({ success: true });
  });

  // Admin: Manuelle nächste Frage (optional)
  socket.on('nextQuestion', (cb) => {
    const game = getGame(currentRoom);
    if (!game || game.state !== 'playing') return cb({ success: false });
    clearTimer(game);
    const next = game.currentQuestion + 1;
    if (next >= game.questions.length) {
      endGame(currentRoom);
      return cb({ success: false, error: 'Keine weiteren Fragen' });
    }
    game.currentQuestion = next;
    startQuestion(currentRoom);
    cb({ success: true });
  });

  // === Spieler ===
  socket.on('joinGame', (data, cb) => {
    const { name, code } = data;
    if (!name || !code) return cb({ success: false, error: 'Name und Code erforderlich' });
    const game = getGame(code);
    if (game.state === 'finished') return cb({ success: false, error: 'Spiel bereits beendet' });
    const existing = game.participants.find(p => p.name === name);
    if (existing) return cb({ success: false, error: 'Name bereits vergeben' });
    if (game.participants.length >= 50) return cb({ success: false, error: 'Raum voll' });

    socket.join(code);
    currentRoom = code;
    playerName = name;
    game.participants.push({ id: socket.id, name, score: 0 });
    cb({ success: true });

    io.to(code).emit('participantJoined', { count: game.participants.length });
    if (game.state === 'playing' && game.questions.length > 0) {
      // Neue Frage direkt senden (falls schon gestartet)
      sendQuestionToSocket(socket, game);
    }
  });

  // Spieler: Antwort einreichen
  socket.on('submitAnswer', (data, cb) => {
    const game = getGame(currentRoom);
    if (!game || game.state !== 'playing') return cb({ success: false, error: 'Kein aktives Spiel' });
    const qIndex = data.questionIndex;
    if (qIndex !== game.currentQuestion) return cb({ success: false, error: 'Frage nicht aktuell' });
    if (game.answers[socket.id]) return cb({ success: false, error: 'Bereits geantwortet' });

    const q = game.questions[qIndex];
    const correct = (data.answer === q.correct);
    const timeLeft = data.timeLeft || 0;
    const points = correct ? Math.max(100, Math.floor(200 * (timeLeft / game.maxTime))) : 0; // Beispiel-Punkte
    game.answers[socket.id] = { answer: data.answer, correct, points };

    const participant = game.participants.find(p => p.id === socket.id);
    if (participant) participant.score += points;

    cb({ success: true, correct, points });

    // Prüfen, ob alle geantwortet haben
    const totalPlayers = game.participants.length;
    const answeredCount = Object.keys(game.answers).length;
    if (answeredCount === totalPlayers) {
      // Vorzeitig beenden (Timer stoppen, Ergebnis senden)
      clearTimer(game);
      endQuestion(currentRoom);
    }
  });

  // === Allgemeine Helper ===
  function startQuestion(room) {
    const game = getGame(room);
    if (!game) return;
    const q = game.questions[game.currentQuestion];
    if (!q) return;

    game.answers = {};
    game.maxTime = 20; // Sekunden pro Frage
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
    if (game.timerInterval) clearInterval(game.timerInterval);
    game.timerInterval = setInterval(() => {
      game.timeLeft--;
      io.to(room).emit('timerUpdate', { time: game.timeLeft });
      if (game.timeLeft <= 0) {
        clearTimer(game);
        endQuestion(room);
      }
    }, 1000);
  }

  function endQuestion(room) {
    const game = getGame(room);
    if (!game) return;
    const q = game.questions[game.currentQuestion];
    if (!q) return;

    // Antworten auswerten (falls noch nicht alle da sind – die fehlenden gelten als falsch)
    game.participants.forEach(p => {
      if (!game.answers[p.id]) {
        game.answers[p.id] = { answer: -1, correct: false, points: 0 };
      }
    });

    // Ergebnis an alle senden
    io.to(room).emit('questionEnded', { correct: q.correct });

    // Nach 3 Sekunden automatisch nächste Frage oder Ende
    setTimeout(() => {
      const next = game.currentQuestion + 1;
      if (next >= game.questions.length) {
        endGame(room);
      } else {
        game.currentQuestion = next;
        startQuestion(room);
      }
    }, 3000);
  }

  function endGame(room) {
    const game = getGame(room);
    if (!game) return;
    clearTimer(game);
    game.state = 'finished';
    io.to(room).emit('gameFinished', getLeaderboard(game));
  }

  function clearTimer(game) {
    if (game.timerInterval) {
      clearInterval(game.timerInterval);
      game.timerInterval = null;
    }
  }

  function getLeaderboard(game) {
    return game.participants
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  function sendQuestionToSocket(socket, game) {
    const q = game.questions[game.currentQuestion];
    if (!q) return;
    const questionData = {
      index: game.currentQuestion,
      total: game.questions.length,
      question: q.question,
      options: q.options,
      image: q.image,
      time: game.timeLeft
    };
    socket.emit('questionStarted', questionData);
  }

  socket.on('disconnect', () => {
    if (currentRoom) {
      const game = getGame(currentRoom);
      if (game) {
        game.participants = game.participants.filter(p => p.id !== socket.id);
        delete game.answers[socket.id];
        io.to(currentRoom).emit('participantJoined', { count: game.participants.length });
        if (game.participants.length === 0 && game.state === 'playing') {
          // Raum zurücksetzen, wenn alle Spieler weg sind
          clearTimer(game);
          game.state = 'waiting';
          io.to(currentRoom).emit('gameReset');
        }
      }
    }
  });
});

// Upload-Route für Bilder
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  res.json({ success: true, url: '/uploads/' + req.file.filename });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
