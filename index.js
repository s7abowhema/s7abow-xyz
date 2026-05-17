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
const baseDataFile = path.resolve(__dirname, 'servers_db.json');

// قاعدة بيانات وهمية لتخزين السيرفرات المنشأة
let db = { servers: [], users: [] };
if (fs.existsSync(baseDataFile)) {
    db = JSON.parse(fs.readFileSync(baseDataFile, 'utf8'));
} else {
    fs.writeFileSync(baseDataFile, JSON.stringify(db, null, 2));
}

function saveDB() {
    fs.writeFileSync(baseDataFile, JSON.stringify(db, null, 2));
}

// إعداد رفع الملفات مع ديناميكية تحديد السيرفر المستهدف
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { serverId } = req.query;
        const targetDir = path.resolve(__dirname, 'servers', serverId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, safeName);
    }
});
const upload = multer({ storage: storage });

// تتبع العمليات المشغلة لكل سيرفر بشكل منفصل
let runningProcesses = {};
let serverStatuses = {};

// [1] إنشاء سيرفر جديد (تخصيص الموارد والمنافذ)
app.post('/api/admin/create-server', (req, res) => {
    const { name, memory, cpu, disk, port } = req.body;
    const id = 'srv_' + Math.random().toString(36).substr(2, 9);
    
    const newServer = { id, name, memory, cpu, disk, port, createdAt: new Date().toISOString() };
    db.servers.push(newServer);
    saveDB();

    // إنشاء مجلد معزول خاص بالسيرفر فوراً على القرص
    const srvDir = path.resolve(__dirname, 'servers', id);
    if (!fs.existsSync(srvDir)) fs.mkdirSync(srvDir, { recursive: true });

    res.json({ status: 'success', server: newServer });
});

// [2] جلب جميع السيرفرات المنشأة في اللوحة
app.get('/api/servers', (req, res) => {
    const list = db.servers.map(s => ({
        ...s,
        status: serverStatuses[s.id] || 'OFFLINE'
    }));
    res.json({ status: 'success', servers: list });
});

// [3] إدارة واستكشاف ملفات سيرفر معين
app.get('/api/files', (req, res) => {
    const { serverId } = req.query;
    const srvDir = path.resolve(__dirname, 'servers', serverId);
    
    if (!fs.existsSync(srvDir)) fs.mkdirSync(srvDir, { recursive: true });

    try {
        const files = fs.readdirSync(srvDir).map(file => {
            const filePath = path.join(srvDir, file);
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
        res.status(500).json({ status: 'error', message: 'فشل تصفح ملفات هذا السيرفر' });
    }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => res.json({ status: 'success' }));

// [4] فك الضغط الآمن والحذف داخل حاوية السيرفر المحددة
app.post('/api/files/action', (req, res) => {
    const { action, fileName, serverId } = req.body;
    const srvDir = path.resolve(__dirname, 'servers', serverId);
    const filePath = path.join(srvDir, decodeURIComponent(fileName));

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(srvDir, true); // فك التداخل مباشرة في المجلد الرئيسي للسيرفر
            fs.unlinkSync(filePath); // مسح ملف الـ ZIP تلقائياً لتوفر المساحة
            return res.json({ status: 'success' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'حزمة الـ ZIP تالفة' });
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

// [5] كونسول البث الحي المستقل لكل سيرفر (SSE)
let logClients = [];
app.get('/api/console/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    logClients.push({ res, serverId: req.query.serverId });
    
    // إرسال الحالة الحالية فوراً عند الاتصال
    const currentStatus = serverStatuses[req.query.serverId] || 'OFFLINE';
    res.write(`data: ${JSON.stringify({ status: currentStatus })}\n\n`);

    req.on('close', () => { logClients = logClients.filter(c => c.res !== res); });
});

function emitLog(serverId, msg) {
    logClients.forEach(c => {
        if (c.serverId === serverId) {
            c.res.write(`data: ${JSON.stringify({ log: msg, status: serverStatuses[serverId] })}\n\n`);
        }
    });
}

// دالة العثور الديناميكي على ملف التشغيل (سواء كان index.js أو أي رمز . آخر)
function findRunnableScript(srvDir) {
    if (!fs.existsSync(srvDir)) return null;
    const files = fs.readdirSync(srvDir);
    const jsFiles = files.filter(f => f.endsWith('.js') && !fs.statSync(path.join(srvDir, f)).isDirectory());
    if (jsFiles.length === 0) return null;
    return jsFiles.find(f => f === 'index.js') || jsFiles[0];
}

// [6] تشغيل وإيقاف السيرفرات بشكل مستقل تماماً
app.post('/api/bot/control', (req, res) => {
    const { action, serverId } = req.body;
    const srvDir = path.resolve(__dirname, 'servers', serverId);

    if (action === 'start' && !runningProcesses[serverId]) {
        serverStatuses[serverId] = 'STARTING';
        emitLog(serverId, `\n\x1b[36m[OptikLink Daemon]:\x1b[0m Booting up isolated environment...`);

        const script = findRunnableScript(srvDir);
        if (!script) {
            serverStatuses[serverId] = 'OFFLINE';
            emitLog(serverId, `\n\x1b[31m❌ [Error]: لم يتم العثور على أي ملف تشغيل بصيغة .js في هذا السيرفر.\x1b[0m`);
            return res.json({ status: 'success' });
        }

        serverStatuses[serverId] = 'RUNNING';
        emitLog(serverId, `\n\x1b[32m[OptikLink]: Executing [node ${script}] on assigned port...\x1b[0m\n`);

        const proc = spawn('node', [script], { cwd: srvDir });
        runningProcesses[serverId] = proc;

        proc.stdout.on('data', (d) => emitLog(serverId, d.toString()));
        proc.stderr.on('data', (d) => emitLog(serverId, d.toString()));
        
        proc.on('close', () => {
            serverStatuses[serverId] = 'OFFLINE';
            emitLog(serverId, `\n\x1b[31m[System]: Server execution stopped.\x1b[0m`);
            delete runningProcesses[serverId];
        });
    }

    if (action === 'stop' && runningProcesses[serverId]) {
        runningProcesses[serverId].kill();
        serverStatuses[serverId] = 'OFFLINE';
        emitLog(serverId, `\n\x1b[31m[System]: Server killed manually.\x1b[0m`);
        delete runningProcesses[serverId];
    }

    res.json({ status: 'success' });
});

app.listen(PORT, () => console.log(`لوحة الاستضافة الكاملة تعمل على المنفذ ${PORT}`));
