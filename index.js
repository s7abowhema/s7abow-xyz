const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const containerDir = path.resolve(__dirname, 'container');

if (!fs.existsSync(containerDir)) {
    fs.mkdirSync(containerDir, { recursive: true });
}

// إعداد التخزين والرفع الآمن
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => {
        // حل مشكلة ترميز الأسماء والرموز الغريبة لمنع انهيار مسار فك الضغط
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, safeName);
    }
});
const upload = multer({ storage: storage });

// جلب الملفات المستضافة
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
        res.status(500).json({ status: 'error', message: 'تعذر قراءة الملفات' });
    }
});

// رفع الملفات
app.post('/api/files/upload', upload.single('file'), (req, res) => res.json({ status: 'success' }));

// المعالج الآمن والمعدل لفك الضغط والحذف النهائي (حل مشكلة خطأ 500)
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    // تنظيف اسم الملف وفك ترميز الرموز لتفادي مسارات النظام الخاطئة
    const decodedName = decodeURIComponent(fileName);
    const filePath = path.join(containerDir, decodedName);

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error', message: 'الملف غير موجود في الاستضافة' });
    }

    if (action === 'unarchive') {
        try {
            // فحص وجود الحزمة والتأكد من فتحها بشكل صحيح
            const zip = new AdmZip(filePath);
            
            // الحل الجذري: فك الضغط مدعوماً بإنشاء تلقائي للمسارات الداخلية المفقودة
            zip.extractAllTo(containerDir, true);
            
            // مسح ملف الـ zip فوراً لتفادي تكرار العمليات وتوفير مساحة التخزين
            fs.unlinkSync(filePath);
            
            return res.json({ status: 'success', message: 'تم فك ضغط الملف بنجاح' });
        } catch (e) {
            console.error("Zip Extraction Error:", e);
            return res.status(500).json({ 
                status: 'error', 
                message: 'فشل السيرفر في فك ضغط الملف. تأكد من أن الحزمة ليست تالفة أو تحتوي على مسارات محمية.' 
            });
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

// بث الكونسول والتحكم بالتشغيل
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

let activeProcess = null;
let botStatus = 'OFFLINE';

function startBot() {
    botStatus = 'STARTING';
    broadcastLog(`\n\x1b[36m[OptikLink Daemon]:\x1b[0m Checking environment variables...`);
    
    const mainFile = path.join(containerDir, 'index.js');
    if (!fs.existsSync(mainFile)) {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m❌ [Error]: index.js missing in container root!\x1b[0m`);
        return;
    }

    botStatus = 'RUNNING';
    activeProcess = spawn('node', ['index.js'], { cwd: containerDir });
    activeProcess.stdout.on('data', (d) => broadcastLog(d.toString()));
    activeProcess.stderr.on('data', (d) => broadcastLog(d.toString()));
    activeProcess.on('close', () => {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m[Process Terminated]\x1b[0m`);
        activeProcess = null;
    });
}

app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    if (action === 'start' && !activeProcess) startBot();
    if (action === 'stop' && activeProcess) { activeProcess.kill(); botStatus = 'OFFLINE'; }
    if (action === 'restart') { if(activeProcess) activeProcess.kill(); startBot(); }
    res.json({ status: 'success' });
});

app.post('/api/console/command', (req, res) => {
    const { command } = req.body;
    if (activeProcess && command) activeProcess.stdin.write(command + '\n');
    res.json({});
});

app.listen(PORT, () => console.log(`سيرفر الاستضافة يعمل بثبات على منفذ ${PORT}`));
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
