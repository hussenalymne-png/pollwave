const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

// Upload Route
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// Game State
const games = {};
const ADMIN_PASSWORD = 'admin123';

function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Verbunden:', socket.id);

    // Admin Login
    socket.on('adminLogin', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (data.password === ADMIN_PASSWORD) {
            socket.isAdmin = true;
            callback({ success: true });
        } else {
            callback({ success: false, error: 'Falsches Passwort' });
        }
    });

    // Raum erstellen
    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.isAdmin) return callback({ success: false, error: 'Nicht autorisiert' });

        const code = generateCode();
        games[code] = {
            code,
            adminSocket: socket.id,
            players: {},
            questions: [],
            currentQuestion: 0,
            state: 'waiting',
            answers: {}
        };

        socket.join(code);
        socket.gameCode = code;
        console.log('Raum erstellt:', code);
        callback({ success: true, code });
    });

    // Frage hinzufügen
    socket.on('addQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        const question = {
            id: Date.now(),
            text: data.text,
            options: data.options,
            correct: data.correct,
            image: data.image || null
        };

        game.questions.push(question);
        callback({ success: true, question });
    });

    // Frage löschen
    socket.on('deleteQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        game.questions = game.questions.filter(q => q.id !== data.id);
        callback({ success: true });
    });

    // Frage bearbeiten
    socket.on('editQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        const index = game.questions.findIndex(q => q.id === data.id);
        if (index === -1) return callback({ success: false, error: 'Frage nicht gefunden' });

        game.questions[index] = {
            ...game.questions[index],
            text: data.text,
            options: data.options,
            correct: data.correct,
            image: data.image || null
        };

        callback({ success: true, question: game.questions[index] });
    });

    // Spiel starten
    socket.on('startGame', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });
        if (game.questions.length === 0) return callback({ success: false, error: 'Keine Fragen!' });

        game.state = 'playing';
        game.currentQuestion = 0;
        game.answers = {};

        sendQuestion(game);
        callback({ success: true });
    });

    // Nächste Frage
    socket.on('nextQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        game.currentQuestion++;

        if (game.currentQuestion >= game.questions.length) {
            game.state = 'finished';
            const leaderboard = getLeaderboard(game);
            io.to(game.code).emit('gameFinished', { leaderboard });
            callback({ success: true, finished: true });
        } else {
            game.answers = {};
            sendQuestion(game);
            callback({ success: true, finished: false });
        }
    });

    // Spiel zurücksetzen
    socket.on('resetGame', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        game.state = 'waiting';
        game.currentQuestion = 0;
        game.answers = {};
        Object.values(game.players).forEach(p => p.score = 0);

        io.to(game.code).emit('gameReset');
        callback({ success: true });
    });

    // Spiel beitreten
    socket.on('joinGame', (data, callback) => {
        if (typeof callback !== 'function') return;

        const { name, code } = data;

        if (!name || !name.trim()) {
            return callback({ success: false, error: 'Name erforderlich' });
        }

        if (!code || !code.trim()) {
            return callback({ success: false, error: 'Kein Raumcode' });
        }

        const gameCode = code.trim().toUpperCase();
        const game = games[gameCode];

        if (!game) {
            return callback({ success: false, error: 'Raum nicht gefunden' });
        }

        if (game.state === 'finished') {
            return callback({ success: false, error: 'Spiel bereits beendet' });
        }

        if (Object.keys(game.players).length >= 50) {
            return callback({ success: false, error: 'Raum ist voll (max 50)' });
        }

        const playerName = name.trim();
        const nameTaken = Object.values(game.players).some(
            p => p.name.toLowerCase() === playerName.toLowerCase()
        );

        if (nameTaken) {
            return callback({ success: false, error: 'Name bereits vergeben' });
        }

        // Spieler hinzufügen
        game.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0
        };

        socket.join(gameCode);
        socket.gameCode = gameCode;
        socket.playerName = playerName;

        // Admin benachrichtigen
        io.to(game.adminSocket).emit('playerJoined', {
            players: Object.values(game.players)
        });

        console.log(`${playerName} ist Raum ${gameCode} beigetreten`);
        callback({ success: true, name: playerName });
    });

    // Antwort einreichen
    socket.on('submitAnswer', (data, callback) => {
        if (typeof callback !== 'function') return;

        const game = games[socket.gameCode];
        if (!game || game.state !== 'playing') {
            return callback({ success: false, error: 'Kein aktives Spiel' });
        }

        const player = game.players[socket.id];
        if (!player) return callback({ success: false, error: 'Spieler nicht gefunden' });

        const question = game.questions[game.currentQuestion];
        if (!question) return callback({ success: false, error: 'Keine Frage aktiv' });

        // Bereits geantwortet?
        if (game.answers[socket.id]) {
            return callback({ success: false, error: 'Bereits geantwortet' });
        }

        const isCorrect = data.answer === question.correct;
        const timeLeft = data.timeLeft || 0;
        const maxTime = 20;
        const score = isCorrect ? Math.max(100, Math.floor(200 * (timeLeft / maxTime))) : 0;

        game.answers[socket.id] = {
            answer: data.answer,
            correct: isCorrect,
            score
        };

        if (isCorrect) player.score += score;

        // Antwort-Statistiken
        const stats = getAnswerStats(game, question);

        // Admin Update
        io.to(game.adminSocket).emit('answerUpdate', {
            stats,
            totalAnswers: Object.keys(game.answers).length,
            totalPlayers: Object.keys(game.players).length
        });

        callback({ success: true, correct: isCorrect, score });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (socket.gameCode && games[socket.gameCode]) {
            const game = games[socket.gameCode];
            if (game.players[socket.id]) {
                delete game.players[socket.id];
                io.to(game.adminSocket).emit('playerJoined', {
                    players: Object.values(game.players)
                });
            }
        }
        console.log('Getrennt:', socket.id);
    });
});

// Hilfsfunktionen
function sendQuestion(game) {
    const question = game.questions[game.currentQuestion];
    const maxTime = 20;

    const questionData = {
        index: game.currentQuestion,
        total: game.questions.length,
        text: question.text,
        options: question.options,
        image: question.image,
        timeLeft: maxTime
    };

    io.to(game.code).emit('newQuestion', questionData);

    // Timer
    let timeLeft = maxTime;
    if (game.timer) clearInterval(game.timer);

    game.timer = setInterval(() => {
        timeLeft--;
        io.to(game.code).emit('timerUpdate', { timeLeft });

        if (timeLeft <= 0) {
            clearInterval(game.timer);
            game.timer = null;

            const question = game.questions[game.currentQuestion];
            const stats = getAnswerStats(game, question);
            const leaderboard = getLeaderboard(game);

            io.to(game.code).emit('questionEnd', {
                correct: question.correct,
                stats,
                leaderboard
            });
        }
    }, 1000);
}

function getAnswerStats(game, question) {
    const stats = {};
    question.options.forEach((_, i) => stats[i] = 0);

    Object.values(game.answers).forEach(a => {
        if (stats[a.answer] !== undefined) stats[a.answer]++;
    });

    return stats;
}

function getLeaderboard(game) {
    return Object.values(game.players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
