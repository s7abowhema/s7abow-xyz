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

if (!fs.existsSync(containerDir)) fs.mkdirSync(containerDir);

let botProcess = null;

// إعداد الرفع المباشر
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, containerDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// جلب قائمة الملفات والمجلدات بشكل سريع ودقيق
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
                time: stats.mtime.toLocaleString('en-US', { hour12: true })
            };
        });
        // ترتيب المجلدات أولاً ثم الملفات لسهولة التصفح كـ Optiklink
        files.sort((a, b) => b.isFolder - a.isFolder);
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'تعذر قراءة الملفات' });
    }
});

// رفع الملفات
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success', message: 'تم الرفع بنجاح!' });
});

// تنفيذ الفك الفوري والحذف السريع
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            // فك الضغط الفوري المتزامن
            zip.extractAllTo(containerDir, true);
            
            return res.json({ status: 'success', message: 'تم فك الضغط الفوري بنجاح، تم تحديث شجرة الملفات!' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'فشل فك ضغط الحزمة التالفة' });
        }
    }

    if (action === 'delete') {
        if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        return res.json({ status: 'success', message: 'تم الحذف فوراً.' });
    }
    res.status(400).json({ status: 'error', message: 'أمر غير مدعوم' });
});

// معالج الكونسول
app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    const mainBotFile = path.join(containerDir, 'index.js');

    if (action === 'start') {
        if (botProcess) return res.json({ status: 'info', output: 'الحاوية تعمل بالفعل.' });
        if (!fs.existsSync(mainBotFile)) return res.json({ status: 'error', output: 'خطأ: لم يتم العثور على ملف index.js الرئيسي داخل الحاوية!' });

        botProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'Server marked as online...\n[OptikLink]>> جاري تشغيل سكريبت البوت وفحص الـ Handler...' });
    }

    if (action === 'stop') {
        if (botProcess) {
            botProcess.kill();
            botProcess = null;
            return res.json({ status: 'success', output: 'Server marked as offline...' });
        }
        return res.json({ status: 'info', output: 'الحاوية متوقفة بالفعل.' });
    }

    if (action === 'restart') {
        if (botProcess) botProcess.kill();
        botProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: 'جاري إعادة تشغيل الحاوية فوراً...\nServer marked as online.' });
    }
});

app.listen(PORT, () => console.log(`المنصة السريعة تعمل على المنفذ ${PORT}`));
