const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── SETUP ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ROOM_CODE = 'X3PL2U';

// Uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let questions = [];
let players = {};        // socketId -> { name, score, answered }
let adminTokens = new Set();
let gameState = {
    status: 'waiting',   // waiting | getready | question | result | leaderboard | ended
    currentQuestion: -1,
    timer: null,
    pausedAt: null,
    answerCounts: [],    // count per answer option
    answeredThisRound: 0
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getLeaderboard() {
    return Object.values(players)
        .sort((a, b) => b.score - a.score)
        .map(p => ({ name: p.name, score: p.score }));
}

function getStats() {
    return {
        playerCount: Object.keys(players).length,
        currentQuestion: gameState.currentQuestion,
        totalQuestions: questions.length,
        answersThisRound: gameState.answeredThisRound,
        leaderboard: getLeaderboard(),
        currentAnswerDist: gameState.answerCounts,
        questionAnswers: questions[gameState.currentQuestion]?.answers || [],
        status: gameState.status
    };
}

function broadcastStats() {
    io.emit('statsUpdate', getStats());
    io.emit('gameStatus', { status: gameState.status });
}

function clearTimer() {
    if (gameState.timer) {
        clearTimeout(gameState.timer);
        clearInterval(gameState.timer);
        gameState.timer = null;
    }
}

// ─── GAME FLOW ────────────────────────────────────────────────────────────────
function startGetReady(count = 3) {
    gameState.status = 'getready';
    io.emit('getReady', { count });
    broadcastStats();

    let c = count;
    const interval = setInterval(() => {
        c--;
        if (c <= 0) {
            clearInterval(interval);
            startQuestion();
        }
    }, 1000);
    gameState.timer = interval;
}

function startQuestion() {
    const idx = gameState.currentQuestion;
    if (idx >= questions.length) {
        endGame();
        return;
    }

    const q = questions[idx];
    gameState.status = 'question';
    gameState.answeredThisRound = 0;
    gameState.answerCounts = new Array(q.answers.length).fill(0);

    // Reset answered flag for all players
    Object.values(players).forEach(p => p.answered = false);

    const timeLimit = q.timeLimit || 20;

    io.emit('question', {
        index: idx,
        total: questions.length,
        question: q.question,
        answers: q.answers,
        image: q.image || null,
        timeLimit
    });
    broadcastStats();

    // Auto-advance after time limit
    gameState.timer = setTimeout(() => {
        revealResults();
    }, timeLimit * 1000);
}

function revealResults() {
    clearTimer();
    gameState.status = 'result';

    const q = questions[gameState.currentQuestion];
    io.emit('roundEnd', {
        correctIndex: q.correctIndex,
        answerCounts: gameState.answerCounts
    });
    broadcastStats();

    // Show leaderboard after 5 seconds
    gameState.timer = setTimeout(() => {
        showLeaderboard();
    }, 5000);
}

function showLeaderboard() {
    clearTimer();
    gameState.status = 'leaderboard';

    io.emit('leaderboard', { players: getLeaderboard() });
    broadcastStats();

    // Move to next question after 5 seconds
    gameState.timer = setTimeout(() => {
        gameState.currentQuestion++;
        if (gameState.currentQuestion >= questions.length) {
            endGame();
        } else {
            startGetReady(3);
        }
    }, 5000);
}

function endGame() {
    clearTimer();
    gameState.status = 'ended';
    io.emit('gameOver', { players: getLeaderboard() });
    broadcastStats();
}

function resetGame() {
    clearTimer();
    gameState = {
        status: 'waiting',
        currentQuestion: -1,
        timer: null,
        pausedAt: null,
        answerCounts: [],
        answeredThisRound: 0
    };
    Object.values(players).forEach(p => {
        p.score = 0;
        p.answered = false;
    });
    broadcastStats();
}

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (adminTokens.has(token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        adminTokens.add(token);
        res.json({ success: true, token });
    } else {
        res.json({ success: false });
    }
});

app.get('/admin/questions', requireAdmin, (req, res) => {
    res.json(questions);
});

app.post('/admin/questions', requireAdmin, upload.single('image'), (req, res) => {
    try {
        const { question, answers, correctIndex, timeLimit } = req.body;
        const parsedAnswers = JSON.parse(answers);
        const q = {
            question,
            answers: parsedAnswers,
            correctIndex: parseInt(correctIndex),
            timeLimit: parseInt(timeLimit) || 20,
            image: req.file ? `/uploads/${req.file.filename}` : null
        };
        questions.push(q);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.delete('/admin/questions/:index', requireAdmin, (req, res) => {
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < questions.length) {
        questions.splice(idx, 1);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Invalid index' });
    }
});

app.get('/admin/stats', requireAdmin, (req, res) => {
    res.json(getStats());
});

app.post('/admin/start', requireAdmin, (req, res) => {
    if (questions.length === 0) {
        return res.json({ success: false, error: 'Keine Fragen vorhanden' });
    }
    gameState.currentQuestion = 0;
    startGetReady(3);
    res.json({ success: true });
});

app.post('/admin/pause', requireAdmin, (req, res) => {
    clearTimer();
    gameState.pausedAt = Date.now();
    io.emit('gamePaused');
    res.json({ success: true });
});

app.post('/admin/resume', requireAdmin, (req, res) => {
    gameState.pausedAt = null;
    io.emit('gameResumed');
    if (gameState.status === 'question') {
        startQuestion();
    }
    res.json({ success: true });
});

app.post('/admin/next', requireAdmin, (req, res) => {
    clearTimer();
    gameState.currentQuestion++;
    if (gameState.currentQuestion >= questions.length) {
        endGame();
    } else {
        startGetReady(3);
    }
    res.json({ success: true });
});

app.post('/admin/end', requireAdmin, (req, res) => {
    endGame();
    res.json({ success: true });
});

app.post('/admin/reset', requireAdmin, (req, res) => {
    resetGame();
    res.json({ success: true });
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('adminJoin', ({ token }) => {
        if (adminTokens.has(token)) {
            socket.join('admins');
            socket.emit('statsUpdate', getStats());
            socket.emit('gameStatus', { status: gameState.status });
        }
    });

    socket.on('join', ({ name, room }) => {
        if (room !== ROOM_CODE) {
            socket.emit('error', 'Falscher Raumcode!');
            return;
        }
        if (!name || name.trim().length === 0) {
            socket.emit('error', 'Bitte gib einen Namen ein!');
            return;
        }

        // Check for duplicate names
        const duplicate = Object.values(players).find(
            p => p.name.toLowerCase() === name.trim().toLowerCase()
        );
        if (duplicate) {
            socket.emit('error', 'Dieser Name ist bereits vergeben!');
            return;
        }

        players[socket.id] = {
            name: name.trim(),
            score: 0,
            answered: false,
            socketId: socket.id
        };

        socket.emit('joined', { name: name.trim() });
        broadcastStats();

        // If game is running, send current state
        if (gameState.status === 'question' && gameState.currentQuestion >= 0) {
            const q = questions[gameState.currentQuestion];
            socket.emit('question', {
                index: gameState.currentQuestion,
                total: questions.length,
                question: q.question,
                answers: q.answers,
                image: q.image || null,
                timeLimit: q.timeLimit || 20
            });
        }
    });

    socket.on('answer', ({ answerIndex, timeElapsed }) => {
        const player = players[socket.id];
        if (!player || player.answered) return;
        if (gameState.status !== 'question') return;

        const q = questions[gameState.currentQuestion];
        if (!q) return;

        player.answered = true;
        gameState.answeredThisRound++;

        if (answerIndex >= 0 && answerIndex < gameState.answerCounts.length) {
            gameState.answerCounts[answerIndex]++;
        }

        const correct = answerIndex === q.correctIndex;
        let points = 0;

        if (correct) {
            const timeLimit = q.timeLimit || 20;
            const timeFraction = Math.max(0, 1 - (timeElapsed / timeLimit));
            points = Math.round(200 + 800 * timeFraction);
            player.score += points;
        }

        socket.emit('answerResult', {
            correct,
            points,
            correctIndex: q.correctIndex,
            totalScore: player.score
        });

        broadcastStats();

        // Auto-reveal if all players answered
        const totalPlayers = Object.keys(players).length;
        if (gameState.answeredThisRound >= totalPlayers && totalPlayers > 0) {
            clearTimer();
            setTimeout(revealResults, 1000);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        broadcastStats();
        console.log('Disconnected:', socket.id);
    });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
http.listen(PORT, () => {
    console.log(`✅ PollWave läuft auf Port ${PORT}`);
});
