const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const containerDir = path.resolve(__dirname, 'container');

if (!fs.existsSync(containerDir)) {
    fs.mkdirSync(containerDir, { recursive: true });
}

let activeProcess = null;
let botStatus = 'OFFLINE';

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, containerDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^\w.\-]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({ storage: storage });

app.get('/api/files', (req, res) => {
    try {
        if (!fs.existsSync(containerDir)) return res.json({ status: 'success', files: [] });

        const files = fs.readdirSync(containerDir).map(file => {
            const filePath = path.join(containerDir, file);
            const stats = fs.statSync(filePath);
            const isDir = stats.isDirectory();

            return {
                name: file + (isDir ? '/' : ''),
                isFolder: isDir,
                size: isDir ? '-' : (stats.size / (1024 * 1024)).toFixed(2) + " MB",
                time: stats.mtime.toLocaleString('en-US', { hour12: false })
            };
        });

        files.sort((a, b) => b.isFolder - a.isFolder);
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'فشل قراءة الملفات' });
    }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error' });
    res.json({ status: 'success' });
});

app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!filePath.startsWith(containerDir)) {
        return res.status(403).json({ status: 'error' });
    }

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error' });
    }

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(containerDir, true);
            fs.unlinkSync(filePath);
            return res.json({ status: 'success' });
        } catch {
            return res.status(500).json({ status: 'error' });
        }
    }

    if (action === 'delete') {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return res.json({ status: 'success' });
        } catch {
            return res.status(500).json({ status: 'error' });
        }
    }
});

let logClients = [];

app.get('/api/console/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    logClients.push(res);

    req.on('close', () => {
        logClients = logClients.filter(c => c !== res);
        res.end();
    });
});

function broadcastLog(msg) {
    logClients.forEach(c => c.write(`data: ${JSON.stringify({ log: msg, status: botStatus })}\n\n`));
}

function startBot() {
    if (activeProcess) return;

    botStatus = 'STARTING';
    broadcastLog("Starting bot...");

    const possibleFiles = ['index.js', 'main.js', 'app.js'];

    let mainBotFile = null;

    for (let file of possibleFiles) {
        const full = path.join(containerDir, file);
        if (fs.existsSync(full)) {
            mainBotFile = file;
            break;
        }
    }

    if (!mainBotFile) {
        botStatus = 'OFFLINE';
        broadcastLog("❌ No bot file found");
        return;
    }

    exec('npm install', { cwd: containerDir }, () => {
        activeProcess = spawn('node', [mainBotFile], { cwd: containerDir });

        botStatus = 'RUNNING';

        activeProcess.stdout.on('data', d => broadcastLog(d.toString()));
        activeProcess.stderr.on('data', d => broadcastLog(d.toString()));

        activeProcess.on('error', (err) => {
            broadcastLog(`❌ ${err.message}`);
        });

        activeProcess.on('close', () => {
            botStatus = 'OFFLINE';
            broadcastLog("Bot stopped");
            activeProcess = null;
        });
    });
}

app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;

    if (action === 'start') startBot();

    if (action === 'stop' && activeProcess) {
        activeProcess.kill();
        botStatus = 'OFFLINE';
    }

    if (action === 'restart') {
        if (activeProcess) activeProcess.kill();
        startBot();
    }

    res.json({ status: 'success' });
});

app.post('/api/console/command', (req, res) => {
    const { command } = req.body;

    if (!command) return res.json({});

    if (activeProcess) {
        activeProcess.stdin.write(command + '\n');
    } else {
        exec(command, { cwd: containerDir }, (err, stdout, stderr) => {
            broadcastLog(stdout || stderr);
        });
    }

    res.json({});
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
