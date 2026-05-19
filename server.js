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

// ===== STORAGE =====
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

app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// ===== PERSISTENCE =====
const DATA_FILE = './data/games.json';

function saveGames() {
    try {
        const dataDir = './data';
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
        const toSave = {};
        Object.entries(games).forEach(([code, game]) => {
            toSave[code] = { ...game, timer: null };
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2));
    } catch (e) {
        console.error('Fehler beim Speichern:', e);
    }
}

function loadGames() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            Object.entries(data).forEach(([code, game]) => {
                games[code] = { ...game, timer: null };
            });
            console.log(`${Object.keys(games).length} Spiele geladen`);
        }
    } catch (e) {
        console.error('Fehler beim Laden:', e);
    }
}

// ===== STATE =====
const games = {};
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
loadGames();

function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ===== HELPER =====
function getAnswerStats(game, question) {
    const stats = {};
    question.options.forEach((_, i) => { stats[i] = 0; });
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

// Sendet playerJoined an Admin UND alle Presenter im Raum
function broadcastPlayerList(game) {
    const players = Object.values(game.players);
    
    // Admin
    io.to(game.adminSocket).emit('playerJoined', { players });
    
    // Alle Sockets im Raum die Presenter sind
    const room = io.sockets.adapter.rooms.get(game.code);
    if (room) {
        room.forEach(socketId => {
            const s = io.sockets.sockets.get(socketId);
            if (s && s.isPresenter) {
                s.emit('playerJoined', { players });
            }
        });
    }
}

// ===== SOCKET =====
io.on('connection', (socket) => {
    console.log('Verbunden:', socket.id);

    // ----- Admin Login -----
    socket.on('adminLogin', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (data.password === ADMIN_PASSWORD) {
            socket.isAdmin = true;
            callback({ success: true });
        } else {
            callback({ success: false, error: 'Falsches Passwort' });
        }
    });

    // ----- Raum erstellen -----
    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.isAdmin) return callback({ success: false, error: 'Nicht autorisiert' });

        const code = generateCode();
        games[code] = {
            code,
            adminSocket: socket.id,
            adminPassword: data.password || ADMIN_PASSWORD,
            players: {},
            questions: [],
            currentQuestion: 0,
            state: 'waiting',
            answers: {},
            defaultTime: data.defaultTime || 20,
            timer: null
        };

        socket.join(code);
        socket.gameCode = code;
        saveGames();
        console.log('Raum erstellt:', code);
        callback({ success: true, code });
    });

    // ----- Admin Rejoin -----
    socket.on('rejoinRoom', (data, callback) => {
        if (typeof callback !== 'function') return;

        const gameCode = (data.code || '').trim().toUpperCase();
        const game = games[gameCode];

        if (!game) return callback({ success: false, error: 'Raum nicht gefunden' });
        if (data.password !== game.adminPassword && data.password !== ADMIN_PASSWORD) {
            return callback({ success: false, error: 'Falsches Passwort' });
        }

        game.adminSocket = socket.id;
        socket.isAdmin = true;
        socket.gameCode = gameCode;
        socket.join(gameCode);

        saveGames();
        callback({
            success: true,
            game: {
                code: game.code,
                state: game.state,
                questions: game.questions,
                players: Object.values(game.players),
                currentQuestion: game.currentQuestion,
                defaultTime: game.defaultTime || 20
            }
        });
    });

    // ----- Frage hinzufügen -----
    socket.on('addQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        const question = {
            id: Date.now(),
            text: data.text,
            options: data.options,
            correct: data.correct,
            image: data.image || null,
            time: data.time || game.defaultTime || 20
        };

        game.questions.push(question);
        saveGames();
        callback({ success: true, question });
    });

    // ----- Frage löschen -----
    socket.on('deleteQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        game.questions = game.questions.filter(q => q.id !== data.id);
        saveGames();
        callback({ success: true });
    });

    // ----- Frage bearbeiten -----
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
            image: data.image || null,
            time: data.time || game.questions[index].time || game.defaultTime || 20
        };

        saveGames();
        callback({ success: true, question: game.questions[index] });
    });

    // ----- Spiel starten -----
    socket.on('startGame', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });
        if (game.questions.length === 0) return callback({ success: false, error: 'Keine Fragen!' });

        game.state = 'playing';
        game.currentQuestion = 0;
        game.answers = {};

        // FIX: gameStarted senden BEVOR die erste Frage kommt
        io.to(game.code).emit('gameStarted');

        sendQuestion(game);
        saveGames();
        callback({ success: true });
    });

    // ----- Nächste Frage -----
    socket.on('nextQuestion', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        if (game.timer) {
            clearInterval(game.timer);
            game.timer = null;
        }

        game.currentQuestion++;

        if (game.currentQuestion >= game.questions.length) {
            game.state = 'finished';
            const leaderboard = getLeaderboard(game);
            io.to(game.code).emit('gameFinished', { leaderboard });
            saveGames();
            callback({ success: true, finished: true });
        } else {
            game.answers = {};
            sendQuestion(game);
            saveGames();
            callback({ success: true, finished: false });
        }
    });

    // ----- Spiel zurücksetzen -----
    socket.on('resetGame', (data, callback) => {
        if (typeof callback !== 'function') return;
        const game = games[socket.gameCode];
        if (!game) return callback({ success: false, error: 'Kein Raum' });

        if (game.timer) {
            clearInterval(game.timer);
            game.timer = null;
        }

        game.state = 'waiting';
        game.currentQuestion = 0;
        game.answers = {};
        Object.values(game.players).forEach(p => { p.score = 0; });

        io.to(game.code).emit('gameReset');
        saveGames();
        callback({ success: true });
    });

    // ----- Raum beitreten (Spieler + Presenter) -----
    // FIX: 'joinRoom' Event hinzugefügt als Alias für Presenter
    socket.on('joinRoom', (data, callback) => {
        const cb = typeof callback === 'function' ? callback : () => {};
        handleJoin(socket, data, cb);
    });

    socket.on('joinGame', (data, callback) => {
        const cb = typeof callback === 'function' ? callback : () => {};
        handleJoin(socket, data, cb);
    });

    // ----- Antwort einreichen -----
    socket.on('submitAnswer', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (socket.isPresenter) {
            return callback({ success: false, error: 'Presenter kann nicht antworten' });
        }

        const game = games[socket.gameCode];
        if (!game || game.state !== 'playing') {
            return callback({ success: false, error: 'Kein aktives Spiel' });
        }

        const player = game.players[socket.id];
        if (!player) return callback({ success: false, error: 'Spieler nicht gefunden' });

        const question = game.questions[game.currentQuestion];
        if (!question) return callback({ success: false, error: 'Keine Frage aktiv' });

        if (game.answers[socket.id]) {
            return callback({ success: false, error: 'Bereits geantwortet' });
        }

        const isCorrect = data.answer === question.correct;
        const timeLeft = data.timeLeft || 0;
        const maxTime = question.time || game.defaultTime || 20;
        const score = isCorrect
            ? Math.max(100, Math.floor(200 * (timeLeft / maxTime)))
            : 0;

        game.answers[socket.id] = {
            answer: data.answer,
            correct: isCorrect,
            score
        };

        if (isCorrect) player.score += score;

        const stats = getAnswerStats(game, question);
        const totalAnswers = Object.keys(game.answers).length;
        const totalPlayers = Object.keys(game.players).length;

        // FIX: answerUpdate an Admin UND gesamten Raum (Presenter sieht Live-Bars)
        io.to(game.adminSocket).emit('answerUpdate', {
            stats,
            totalAnswers,
            totalPlayers
        });

        // An alle Presenter im Raum
        const room = io.sockets.adapter.rooms.get(game.code);
        if (room) {
            room.forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                if (s && s.isPresenter) {
                    s.emit('answerUpdate', { stats, totalAnswers, totalPlayers });
                }
            });
        }

        callback({ success: true, correct: isCorrect, score });
    });

    // ----- Disconnect -----
    socket.on('disconnect', () => {
        if (socket.isPresenter) {
            console.log('Presenter getrennt:', socket.id);
            return;
        }
        if (socket.gameCode && games[socket.gameCode]) {
            const game = games[socket.gameCode];
            if (game.players[socket.id]) {
                const name = game.players[socket.id].name;
                delete game.players[socket.id];
                console.log(`${name} hat Raum ${socket.gameCode} verlassen`);
                broadcastPlayerList(game);
                saveGames();
            }
        }
        console.log('Getrennt:', socket.id);
    });
});

// ===== JOIN HANDLER =====
function handleJoin(socket, data, callback) {
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

    // ----- Presenter -----
    if (name.trim() === '__presenter__') {
        socket.join(gameCode);
        socket.gameCode = gameCode;
        socket.isPresenter = true;

        // Aktuellen State zurückgeben
        callback({
            success: true,
            name: '__presenter__',
            state: game.state,
            playerCount: Object.keys(game.players).length
        });

        // Falls Spiel läuft: aktuelle Frage senden
        if (game.state === 'playing') {
            const question = game.questions[game.currentQuestion];
            if (question) {
                const maxTime = question.time || game.defaultTime || 20;
                socket.emit('gameStarted');
                socket.emit('newQuestion', {
                    index: game.currentQuestion,
                    total: game.questions.length,
                    text: question.text,
                    options: question.options,
                    image: question.image,
                    timeLeft: maxTime,  // Beste Näherung — echter timeLeft wäre im Timer
                    maxTime: maxTime
                });
            }
        }
        return;
    }

    // ----- Normaler Spieler -----
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

    game.players[socket.id] = {
        id: socket.id,
        name: playerName,
        score: 0
    };

    socket.join(gameCode);
    socket.gameCode = gameCode;
    socket.playerName = playerName;

    broadcastPlayerList(game);
    saveGames();

    console.log(`${playerName} ist Raum ${gameCode} beigetreten`);
    callback({ success: true, name: playerName });
}

// ===== SEND QUESTION =====
function sendQuestion(game) {
    const question = game.questions[game.currentQuestion];
    const maxTime = question.time || game.defaultTime || 20;

    io.to(game.code).emit('newQuestion', {
        index: game.currentQuestion,
        total: game.questions.length,
        text: question.text,
        options: question.options,
        image: question.image,
        timeLeft: maxTime,
        maxTime: maxTime
    });

    let timeLeft = maxTime;
    if (game.timer) clearInterval(game.timer);

    game.timer = setInterval(() => {
        timeLeft--;
        io.to(game.code).emit('timerUpdate', { timeLeft, maxTime });

        if (timeLeft <= 0) {
            clearInterval(game.timer);
            game.timer = null;

            const q = game.questions[game.currentQuestion];
            const stats = getAnswerStats(game, q);
            const leaderboard = getLeaderboard(game);
            const totalAnswers = Object.keys(game.answers).length;
            const totalPlayers = Object.keys(game.players).length;

            // FIX: correctIndex statt correct + totalAnswers hinzugefügt
            io.to(game.code).emit('questionEnd', {
                correctIndex: q.correct,   // ← war 'correct', jetzt 'correctIndex'
                stats,
                totalAnswers,
                totalPlayers,
                leaderboard
            });
        }
    }, 1000);
}

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
