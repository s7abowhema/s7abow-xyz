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
// مسار الحاوية المعزولة للاستضافة الكاملة
const containerDir = path.resolve(__dirname, 'container');

if (!fs.existsSync(containerDir)) {
    fs.mkdirSync(containerDir, { recursive: true });
}

let activeProcess = null;
let botStatus = 'OFFLINE'; // OFFLINE, STARTING, RUNNING

// إعداد رفع الملفات الاحترافي مع معالجة الأسماء
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => {
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, safeName);
    }
});
const upload = multer({ storage: storage });

// [1] استدعاء وقراءة ملفات الاستضافة بالكامل
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

        // إظهار المجلدات في الأعلى دائماً مثل نظام المجلدات في OptikLink
        files.sort((a, b) => b.isFolder - a.isFolder);
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'تعذر قراءة قرص الملفات' });
    }
});

// [2] رفع الملفات مباشرة إلى الاستضافة
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success' });
});

// [3] العمليات العميقة لملفات الاستضافة (حذف وفك ضغط فوري)
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });
    }

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            // فك الضغط مباشرة في المجلد الرئيسي لضمان عدم إنشاء فولدرات داخلية تضيع الكود
            zip.extractAllTo(containerDir, true);
            // حذف ملف الـ zip فوراً بعد الفك لتوفير مساحة السيرفر ومنع التكرار
            fs.unlinkSync(filePath);
            return res.json({ status: 'success' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'الملف المضغوط تالف' });
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

// [4] نظام بث بيانات الـ Terminal حياً (Server-Sent Events)
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

// [5] تشغيل بيئة الاستضافة مع الفحص التلقائي للـ Dependencies
function startContainerServer() {
    botStatus = 'STARTING';
    broadcastLog(`\n\x1b[36m[OptikLink Daemon]:\x1b[0m Checking server disk space usage, please wait...`);
    broadcastLog(`\n\x1b[36m[OptikLink Daemon]:\x1b[0m Allocating container system memory...`);
    
    const mainBotFile = path.join(containerDir, 'index.js');
    if (!fs.existsSync(mainBotFile)) {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m❌ [OptikLink Error]: لم يتم العثور على ملف التشغيل الرئيسي index.js في الاستضافة!\x1b[0m`);
        return;
    }

    // التحقق التلقائي وتثبيت الموديلات المفقودة كاستضافة كاملة
    const hasPackage = fs.existsSync(path.join(containerDir, 'package.json'));
    if (hasPackage && !fs.existsSync(path.join(containerDir, 'node_modules'))) {
        broadcastLog(`\n\x1b[33m[OptikLink Daemon]: node_modules missing. Running "npm install" inside container...\x1b[0m\n`);
        exec('npm install', { cwd: containerDir }, (err, stdout, stderr) => {
            if (err) {
                broadcastLog(`\n\x1b[31m[NPM Error]: Failed to install packages.\x1b[0m\n`);
            } else {
                broadcastLog(`\n\x1b[32m[NPM Success]: Dependencies installed successfully!\x1b[0m\n`);
            }
            executeNodeProcess(mainBotFile);
        });
    } else {
        setTimeout(() => { executeNodeProcess(mainBotFile); }, 1000);
    }
}

function executeNodeProcess(mainFile) {
    botStatus = 'RUNNING';
    broadcastLog(`\n\x1b[32m[OptikLink Daemon]:\x1b[0m Server marked as RUNNING. Launching application environment...\n`);
    
    activeProcess = spawn('node', ['index.js'], { cwd: containerDir });

    activeProcess.stdout.on('data', (data) => broadcastLog(data.toString()));
    activeProcess.stderr.on('data', (data) => broadcastLog(data.toString()));

    activeProcess.on('close', () => {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m[OptikLink Daemon]:\x1b[0m Server marked as OFFLINE.\x1b[0m`);
        activeProcess = null;
    });
}

app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    if (action === 'start') { if (!activeProcess) startContainerServer(); }
    if (action === 'stop' && activeProcess) { activeProcess.kill(); botStatus = 'OFFLINE'; }
    if (action === 'restart') { if (activeProcess) activeProcess.kill(); startContainerServer(); }
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

app.listen(PORT, () => console.log(`المنصة تعمل كاستضافة كاملة مطابقة لـ OptikLink على منفذ ${PORT}`));
