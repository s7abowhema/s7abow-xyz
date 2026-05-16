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
const containerDir = path.join(__dirname, 'container');

if (!fs.existsSync(containerDir)) fs.mkdirSync(containerDir);

let activeProcess = null;
let botStatus = 'OFFLINE'; // OFFLINE, STARTING, RUNNING

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// جلب الملفات
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
        res.status(500).json({ status: 'error' });
    }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => res.json({ status: 'success' }));

app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(containerDir, true);
            fs.unlinkSync(filePath); // مسح فوري لعدم تقل السيرفر
            return res.json({ status: 'success' });
        } catch (e) {
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
        } catch (err) {
            return res.status(500).json({ status: 'error' });
        }
    }
});

// بث حي للكونسول
let logClients = [];
app.get('/api/console/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    logClients.push(res);
    req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

function broadcastLog(msg) {
    logClients.forEach(c => c.write(`data: ${JSON.stringify({ log: msg, status: botStatus })}\n\n`));
}

function startBot() {
    botStatus = 'STARTING';
    broadcastLog(`\n\x1b[36m[Pterodactyl Daemon]:\x1b[0m Checking server disk space usage, please wait...`);
    broadcastLog(`\n\x1b[36m[Pterodactyl Daemon]:\x1b[0m Fetching dynamic build configuration...`);
    
    const mainBotFile = path.join(containerDir, 'index.js');
    if (!fs.existsSync(mainBotFile)) {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m❌ [OptikLink Error]: index.js not found in root directory!\x1b[0m`);
        return;
    }

    setTimeout(() => {
        botStatus = 'RUNNING';
        broadcastLog(`\n\x1b[32m[Pterodactyl Daemon]:\x1b[0m Server marked as RUNNING. Starting execution pipeline...\n`);
        
        activeProcess = spawn('node', ['index.js'], { cwd: containerDir });

        activeProcess.stdout.on('data', (data) => broadcastLog(data.toString()));
        activeProcess.stderr.on('data', (data) => broadcastLog(data.toString()));

        activeProcess.on('close', () => {
            botStatus = 'OFFLINE';
            broadcastLog(`\n\x1b[31m[Pterodactyl Daemon]:\x1b[0m Server marked as OFFLINE.\x1b[0m`);
            activeProcess = null;
        });
    }, 1500);
}

app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    if (action === 'start') { if (!activeProcess) startBot(); }
    if (action === 'stop' && activeProcess) { activeProcess.kill(); botStatus = 'OFFLINE'; }
    if (action === 'restart') { if (activeProcess) activeProcess.kill(); startBot(); }
    res.json({ status: 'success' });
});

app.post('/api/console/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.json({});
    if (activeProcess) {
        activeProcess.stdin.write(command + '\n');
    } else {
        exec(command, { cwd: containerDir }, (err, stdout, stderr) => {
            broadcastLog(`\n$ ${command}\n${stdout || stderr || ''}`);
        });
    }
    res.json({});
});

app.listen(PORT, () => console.log(`لوحة المضاهاة تعمل بالكامل على منفذ ${PORT}`));
                                              
