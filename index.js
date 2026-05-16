const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const containerDir = path.join(__dirname, 'container');

// إنشاء مجلد الحاوية الافتراضي إذا لم يكن موجوداً
if (!fs.existsSync(containerDir)) fs.mkdirSync(containerDir);

let botProcess = null;

// إعداد الرفع للمجلد الحاوي
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// جلب قائمة الملفات الحالية داخل المجلد /home/container
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(containerDir).map(file => {
            const stats = fs.statSync(path.join(containerDir, file));
            return {
                name: file,
                size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
                time: stats.mtime.toLocaleString('en-US', { hour12: true })
            };
        });
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'تعذر قراءة الملفات' });
    }
});

// رفع ملف جديد
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success', message: 'تم رفع الملف بنجاح!' });
});

// إجراءات الملفات (فك ضغط أو حذف)
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(containerDir, true);
            return res.json({ status: 'success', message: 'تم فك ضغط الملف بنجاح.' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'فشل فك الضغط.' });
        }
    }

    if (action === 'delete') {
        fs.unlinkSync(filePath);
        return res.json({ status: 'success', message: 'تم حذف الملف بنجاح.' });
    }
    res.status(400).json({ status: 'error', message: 'إجراء غير معروف' });
});

// التحكم في الـ Console (START, STOP, RESTART)
app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    const mainBotFile = path.join(containerDir, 'index.js');

    if (action === 'start') {
        if (botProcess) return res.json({ status: 'info', output: 'السيرفر يعمل بالفعل.' });
        if (!fs.existsSync(mainBotFile)) return res.json({ status: 'error', output: 'خطأ: لم يتم العثور على ملف index.js في المجلد الأساسي بعد فك الضغط!' });

        botProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'Server marked as online...\n[OptikLink]>> جاري تحميل حزم الـ Plugins والاتصال بويندوز السيرفر...' });
    }

    if (action === 'stop') {
        if (botProcess) {
            botProcess.kill();
            botProcess = null;
            return res.json({ status: 'success', output: 'Server marked as offline...' });
        }
        return res.json({ status: 'info', output: 'السيرفر مغلق بالفعل.' });
    }

    if (action === 'restart') {
        if (botProcess) botProcess.kill();
        botProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'جاري إعادة تشغيل الحاوية...\nServer marked as online.' });
    }
});

app.listen(PORT, () => console.log(`سيرفر Optiklink يعمل على منفذ ${PORT}`));
