const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const containerDir = path.join(__dirname, 'container');

if (!fs.existsSync(containerDir)) fs.mkdirSync(containerDir);

let activeProcess = null;

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// جلب الملفات بترتيب ثابت وسريع لضمان عدم حدوث تداخل
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
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success' });
});

// إدارة فك الضغط والحذف الحقيقي النهائي
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error', message: 'الملف غير موجود بالفعل على السيرفر' });
    }

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(containerDir, true);
            return res.json({ status: 'success', message: 'تم فك الضغط بنجاح تام.' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'فشل في فك الضغط.' });
        }
    }

    if (action === 'delete') {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return res.json({ status: 'success', message: 'تم الحذف النهائي بنجاح من جذور السيرفر.' });
        } catch (err) {
            return res.status(500).json({ status: 'error', message: 'تعذر مسح الملف.' });
        }
    }
});

// تشغيل الأوامر يدوياً من الكونسول من قبل المستخدم
app.post('/api/console/command', (req, res) => {
    const { command } = req.body;
    
    if (!command) return res.json({ output: '' });

    // تشغيل الأمر المباشر داخل الحاوية وإرجاع المخرجات للواجهة فوراً
    exec(command, { cwd: containerDir }, (error, stdout, stderr) => {
        let output = stdout || stderr || '';
        if (error && !stderr) {
            output = `Error executing command: ${error.message}`;
        }
        res.json({ output: output || 'Command executed with no output.' });
    });
});

// أزرار التحكم السريع (START, RESTART, STOP)
app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    const mainBotFile = path.join(containerDir, 'index.js');

    if (action === 'start') {
        if (activeProcess) return res.json({ status: 'info', output: 'الحاوية قيد العمل بالفعل.' });
        if (!fs.existsSync(mainBotFile)) return res.json({ status: 'error', output: 'خطأ: لم نجد ملف index.js الرئيسي لتشغيله!' });

        activeProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'Server marked as online...\n[OptikLink]>> جاري تشغيل سكريبت البوت حياً الآن...' });
    }

    if (action === 'stop') {
        if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
            return res.json({ status: 'success', output: 'Server marked as offline...' });
        }
        return res.json({ status: 'info', output: 'السيرفر متوقف حالياً.' });
    }

    if (action === 'restart') {
        if (activeProcess) activeProcess.kill();
        activeProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'جاري عمل ريستارت شامل للحاوية...\nServer marked as online.' });
    }
});

app.listen(PORT, () => console.log(`لوحة التحكم المكتملة تعمل على منفذ ${PORT}`));
