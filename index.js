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
// تحديد المسار الرئيسي الحقيقي للحاوية لضمان عدم تداخل المسارات
const containerDir = path.resolve(__dirname, 'container');

if (!fs.existsSync(containerDir)) {
    fs.mkdirSync(containerDir, { recursive: true });
}

let activeProcess = null;
let botStatus = 'OFFLINE';

// إعداد رفع الملفات مع معالجة الأسماء لمنع الأخطاء في أنظمة التشغيل
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, containerDir);
    },
    filename: (req, file, cb) => {
        // حماية الاسم من الرموز الغريبة التي قد تفسد مسار الملف
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, safeName);
    }
});
const upload = multer({ storage: storage });

// 1. نظام جلب وقراءة واستضافة الملفات الحقيقي
app.get('/api/files', (req, res) => {
    try {
        if (!fs.existsSync(containerDir)) return res.json({ status: 'success', files: [] });
        
        // قراءة المجلد بشكل عميق وجلب البيانات الحقيقية من القرص
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

        // ترتيب المجلدات أولاً ثم الملفات لسهولة التصفح
        files.sort((a, b) => b.isFolder - a.isFolder);
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'فشل في قراءة قرص استضافة الملفات' });
    }
});

// 2. استقبال وحفظ الملفات المرفوعة مباشرة في الحاوية
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'لم يتم رفع أي ملف' });
    res.json({ status: 'success' });
});

// 3. المعالج الذكي لفك الضغط العميق والحذف النهائي بدون تعليق
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error', message: 'الملف غير موجود في مسار الاستضافة الرئيسي' });
    }

    // حل مشكلة فك الضغط التالف أو المتداخل
    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            
            // فك الضغط مباشرة في المسار الرئيسي المعتمد `containerDir` مع تفعيل خاصية overwrite
            zip.extractAllTo(containerDir, true);
            
            // حذف ملف الـ zip الأصلي فوراً لتوفير مساحة الاستضافة وتجنب اللخبطة
            fs.unlinkSync(filePath);
            
            return res.json({ status: 'success', message: 'تم فك الضغط وإعادة تنظيم الحاوية بنجاح' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'حزمة المجلد المضغوط تالفة أو غير مدعومة' });
        }
    }

    // حل مشكلة الحذف النهائي للمجلدات والملفات المعلقة
    if (action === 'delete') {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                // حذف المجلد وكل ما يحتويه بشكل عميق وقسري
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return res.json({ status: 'success', message: 'تم الحذف من القرص بنجاح' });
        } catch (err) {
            return res.status(500).json({ status: 'error', message: 'فشل في إتمام عملية الحذف' });
        }
    }
});

// نظام البث المستمر للكونسول (SSE)
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

// تشغيل البوت مع فحص ذكي لملفات الاستضافة قبل الإقلاع
function startBot() {
    botStatus = 'STARTING';
    broadcastLog(`\n\x1b[36m[System Daemon]:\x1b[0m Checking container file health deployment...`);
    
    const mainBotFile = path.join(containerDir, 'index.js');
    
    // التحقق الصارم من وجود ملف البوت في الاستضافة
    if (!fs.existsSync(mainBotFile)) {
        botStatus = 'OFFLINE';
        broadcastLog(`\n\x1b[31m❌ [خطأ في الاستضافة]: لم يتم العثور على ملف index.js في المجلد الرئيسي للحاوية!\x1b[0m`);
        broadcastLog(`\n\x1b[33m💡 نصيحة شادو: تأكد أن ملفات البوت ليست بداخل مجلد فرعي آخر بعد فك الضغط.\x1b[0m`);
        return;
    }

    setTimeout(() => {
        botStatus = 'RUNNING';
        broadcastLog(`\n\x1b[32m[System Daemon]:\x1b[0m Launching process pipeline...\n`);
        
        activeProcess = spawn('node', ['index.js'], { cwd: containerDir });

        activeProcess.stdout.on('data', (data) => broadcastLog(data.toString()));
        activeProcess.stderr.on('data', (data) => broadcastLog(data.toString()));

        activeProcess.on('close', () => {
            botStatus = 'OFFLINE';
            broadcastLog(`\n\x1b[31m[System Daemon]: Server process terminated (OFFLINE).\x1b[0m`);
            activeProcess = null;
        });
    }, 1000);
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

app.listen(PORT, () => console.log(`نظام استضافة الملفات المستقر يعمل الآن على منفذ ${PORT}`));
