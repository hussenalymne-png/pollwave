const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

// Uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.json());

// Game State
let gameState = {
    status: 'waiting',
    players: {},
    questions: [],
    currentQuestion: 0,
    timer: null,
    timeLeft: 0,
    answers: {}
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Falsches Passwort' });
    }
});

app.post('/admin/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
    res.json({ url: '/uploads/' + req.file.filename });
});

app.get('/admin/state', (req, res) => {
    res.json({
        status: gameState.status,
        playerCount: Object.keys(gameState.players).length,
        questions: gameState.questions,
        currentQuestion: gameState.currentQuestion,
        answers: gameState.answers
    });
});

// Socket.io
io.on('connection', (socket) => {
    console.log('Verbunden:', socket.id);

    // Spieler tritt bei
    socket.on('join', (data) => {
        const { name, roomCode } = data;
        if (roomCode !== 'X3PL2U') {
            socket.emit('joinError', { message: 'Falscher Raumcode!' });
            return;
        }
        if (gameState.status !== 'waiting') {
            socket.emit('joinError', { message: 'Spiel läuft bereits!' });
            return;
        }
        gameState.players[socket.id] = {
            name: name,
            score: 0,
            answers: []
        };
        socket.emit('joinSuccess', { name: name });
        io.emit('playerCount', { count: Object.keys(gameState.players).length });
        console.log(`${name} ist beigetreten`);
    });

    // Admin: Spiel starten
    socket.on('adminStart', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        if (gameState.questions.length === 0) {
            socket.emit('adminError', { message: 'Keine Fragen vorhanden!' });
            return;
        }
        gameState.status = 'getready';
        gameState.currentQuestion = 0;
        gameState.answers = {};
        
        // Reset scores
        Object.keys(gameState.players).forEach(id => {
            gameState.players[id].score = 0;
        });

        io.emit('getReady', { countdown: 3 });
        
        let countdown = 3;
        const readyTimer = setInterval(() => {
            countdown--;
            if (countdown <= 0) {
                clearInterval(readyTimer);
                startQuestion();
            } else {
                io.emit('getReady', { countdown });
            }
        }, 1000);
    });

    // Admin: Nächste Frage
    socket.on('adminNext', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        gameState.currentQuestion++;
        if (gameState.currentQuestion >= gameState.questions.length) {
            endGame();
        } else {
            gameState.status = 'getready';
            io.emit('getReady', { countdown: 3 });
            let countdown = 3;
            const readyTimer = setInterval(() => {
                countdown--;
                if (countdown <= 0) {
                    clearInterval(readyTimer);
                    startQuestion();
                } else {
                    io.emit('getReady', { countdown });
                }
            }, 1000);
        }
    });

    // Admin: Pause
    socket.on('adminPause', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        if (gameState.timer) {
            clearInterval(gameState.timer);
            gameState.timer = null;
        }
        gameState.status = 'paused';
        io.emit('gamePaused');
    });

    // Admin: Fortsetzen
    socket.on('adminResume', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        gameState.status = 'question';
        resumeTimer();
        io.emit('gameResumed');
    });

    // Admin: Reset
    socket.on('adminReset', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        if (gameState.timer) clearInterval(gameState.timer);
        gameState = {
            status: 'waiting',
            players: {},
            questions: gameState.questions,
            currentQuestion: 0,
            timer: null,
            timeLeft: 0,
            answers: {}
        };
        io.emit('gameReset');
    });

    // Admin: Fragen speichern
    socket.on('adminSaveQuestions', (data) => {
        if (data.password !== ADMIN_PASSWORD) return;
        gameState.questions = data.questions;
        socket.emit('questionsSaved', { count: data.questions.length });
    });

    // Spieler antwortet
    socket.on('answer', (data) => {
        if (gameState.status !== 'question') return;
        const player = gameState.players[socket.id];
        if (!player) return;
        
        const qIndex = gameState.currentQuestion;
        if (!gameState.answers[qIndex]) gameState.answers[qIndex] = {};
        if (gameState.answers[qIndex][socket.id]) return; // bereits geantwortet

        const question = gameState.questions[qIndex];
        const isCorrect = data.answer === question.correct;
        const timeBonus = Math.floor((gameState.timeLeft / question.time) * 800);
        const points = isCorrect ? 200 + timeBonus : 0;

        gameState.answers[qIndex][socket.id] = {
            answer: data.answer,
            correct: isCorrect,
            points: points
        };

        if (isCorrect) player.score += points;

        socket.emit('answerResult', {
            correct: isCorrect,
            points: points,
            totalScore: player.score
        });

        // Stats an Admin
        const answerDist = {};
        Object.values(gameState.answers[qIndex]).forEach(a => {
            answerDist[a.answer] = (answerDist[a.answer] || 0) + 1;
        });
        io.emit('answerStats', {
            total: Object.keys(gameState.answers[qIndex]).length,
            distribution: answerDist
        });
    });

    // Trennung
    socket.on('disconnect', () => {
        if (gameState.players[socket.id]) {
            console.log(`${gameState.players[socket.id].name} hat getrennt`);
            delete gameState.players[socket.id];
            io.emit('playerCount', { count: Object.keys(gameState.players).length });
        }
    });
});

function startQuestion() {
    const question = gameState.questions[gameState.currentQuestion];
    gameState.status = 'question';
    gameState.timeLeft = question.time || 20;

    io.emit('question', {
        index: gameState.currentQuestion,
        total: gameState.questions.length,
        text: question.text,
        image: question.image || null,
        options: question.options,
        time: gameState.timeLeft
    });

    gameState.timer = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timerUpdate', { timeLeft: gameState.timeLeft });

        if (gameState.timeLeft <= 0) {
            clearInterval(gameState.timer);
            gameState.timer = null;
            showResults();
        }
    }, 1000);
}

function resumeTimer() {
    gameState.timer = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timerUpdate', { timeLeft: gameState.timeLeft });

        if (gameState.timeLeft <= 0) {
            clearInterval(gameState.timer);
            gameState.timer = null;
            showResults();
        }
    }, 1000);
}

function showResults() {
    gameState.status = 'result';
    const question = gameState.questions[gameState.currentQuestion];
    const qAnswers = gameState.answers[gameState.currentQuestion] || {};
    
    const answerDist = {};
    question.options.forEach((_, i) => answerDist[i] = 0);
    Object.values(qAnswers).forEach(a => {
        answerDist[a.answer] = (answerDist[a.answer] || 0) + 1;
    });

    io.emit('showResult', {
        correct: question.correct,
        explanation: question.explanation || '',
        distribution: answerDist,
        correctText: question.options[question.correct]
    });

    setTimeout(() => {
        showLeaderboard();
    }, 5000);
}

function showLeaderboard() {
    gameState.status = 'leaderboard';
    const leaderboard = Object.values(gameState.players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

    io.emit('showLeaderboard', { leaderboard });

    setTimeout(() => {
        gameState.currentQuestion++;
        if (gameState.currentQuestion >= gameState.questions.length) {
            endGame();
        } else {
            io.emit('getReady', { countdown: 3 });
            let countdown = 3;
            const readyTimer = setInterval(() => {
                countdown--;
                if (countdown <= 0) {
                    clearInterval(readyTimer);
                    startQuestion();
                } else {
                    io.emit('getReady', { countdown });
                }
            }, 1000);
        }
    }, 5000);
}

function endGame() {
    gameState.status = 'ended';
    const finalLeaderboard = Object.values(gameState.players)
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

    io.emit('gameEnded', { leaderboard: finalLeaderboard });
}

server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
});
