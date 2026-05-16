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
let botStatus = 'OFFLINE'; // OFFLINE, STARTING, ONLINE

// إعداد رفع الملفات
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// جلب قائمة الملفات
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
        res.status(500).json({ status: 'error', message: 'تعذر قراءة ملفات الحاوية' });
    }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success' });
});

app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(containerDir, true);
            fs.unlinkSync(filePath);
            return res.json({ status: 'success', message: 'تم فك الضغط بنجاح.' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'الملف تالف' });
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

// نظام بث مخرجات الكونسول لحظة بلحظة (Server-Sent Events) لتقليد اللوحة الأصلية
let logClients = [];
app.get('/api/console/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    logClients.push(res);
    req.on('close', () => {
        logClients = logClients.filter(client => client !== res);
    });
});

function broadcastLog(message) {
    logClients.forEach(client => client.write(`data: ${JSON.stringify({ log: message, status: botStatus })}\n\n`));
}

// تشغيل البوت بمحاكاة كاملة لـ OptikLink الذكية
function startBotHardware() {
    botStatus = 'STARTING';
    broadcastLog(`\n\x1b[36m««[OptikLink]»»\x1b[0m Checking server disk space usage...\n\x1b[36m««[OptikLink]»»\x1b[0m Ensuring file permissions are set correctly...\n\x1b[36m««[OptikLink]»»\x1b[0m Server marked as starting...`);

    const mainBotFile = path.join(containerDir, 'index.js');
    if (!fs.existsSync(mainBotFile)) {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m❌ [خطأ في تشغيل الحاوية]: ملف التشغيل الرئيسي index.js غير موجود بالخارج!\x1b[0m`);
        return;
    }

    // محاكاة تنصيب الـ Packages التلقائية مثل لوحة OptikLink الفصيلية
    broadcastLog(`\n\x1b[33m[OptikLink Hardware]>> Running auto npm install check...\x1b[0m`);
    
    // تشغيل عملية node عبر spawn لتوفير البث المباشر للسطور (Stream Logs)
    activeProcess = spawn('node', ['index.js'], { cwd: containerDir });
    botStatus = 'ONLINE';

    activeProcess.stdout.on('data', (data) => {
        broadcastLog(data.toString());
    });

    activeProcess.stderr.on('data', (data) => {
        broadcastLog(data.toString());
    });

    activeProcess.on('close', (code) => {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m««[OptikLink]»» Server marked as offline...\x1b[0m`);
        activeProcess = null;
    });
}

// أزرار التحكم اللحظية
app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;

    if (action === 'start') {
        if (activeProcess) return res.json({ status: 'info' });
        startBotHardware();
        return res.json({ status: 'success' });
    }
    if (action === 'stop') {
        if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
            botStatus = 'OFFLINE';
            broadcastLog(`\n\x1b[31m««[OptikLink]»» Server marked as offline...\x1b[0m`);
        }
        return res.json({ status: 'success' });
    }
    if (action === 'restart') {
        if (activeProcess) {
            activeProcess.kill();
        }
        startBotHardware();
        return res.json({ status: 'success' });
    }
});

// تنفيذ أوامر الكونسول من الـ Input السفلي
app.post('/api/console/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.json({ output: '' });

    if (activeProcess) {
        activeProcess.stdin.write(command + '\n');
        return res.json({ output: '' });
    } else {
        exec(command, { cwd: containerDir }, (error, stdout, stderr) => {
            let output = stdout || stderr || 'تم تنفيذ الأمر بنجاح.';
            broadcastLog(`\n${output}`);
        });
        res.json({ output: '' });
    }
});

app.listen(PORT, () => console.log(`المنصة تعمل بمحاكاة OptikLink على منفذ ${PORT}`));
         
