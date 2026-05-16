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

let activeProcess = null;

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

// استقبال ورفع الملفات
app.post('/api/files/upload', upload.single('file'), (req, res) => {
    res.json({ status: 'success' });
});

// معالج الأوامر والعمليات الصارم (فك الضغط والحذف)
app.post('/api/files/action', (req, res) => {
    const { action, fileName } = req.body;
    const filePath = path.join(containerDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ status: 'error', message: 'الملف غير موجود على السيرفر' });
    }

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            // فك الضغط مباشرة في المجلد الرئيسي للحاوية وتجاوز أي فولدر داخلي مكرر
            zip.extractAllTo(containerDir, true);
            
            // حذف ملف الـ zip تلقائياً بعد فك الضغط لتوفير المساحة ومنع التكرار
            fs.unlinkSync(filePath);
            
            return res.json({ status: 'success', message: 'تم فك الضغط بنجاح وتنظيف الحاوية.' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'حزمة الملفات تالفة أو غير مدعومة' });
        }
    }

    if (action === 'delete') {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return res.json({ status: 'success', message: 'تم الحذف النهائي.' });
        } catch (err) {
            return res.status(500).json({ status: 'error', message: 'فشل حذف الملف.' });
        }
    }
});

// تنفيذ أوامر الكونسول النصية
app.post('/api/console/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.json({ output: '' });

    exec(command, { cwd: containerDir }, (error, stdout, stderr) => {
        let output = stdout || stderr || '';
        if (error && !stderr) {
            output = `خطأ: ${error.message}`;
        }
        res.json({ output: output || 'تم تنفيذ الأمر بنجاح.' });
    });
});

// التحكم في البوت
app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    const mainBotFile = path.join(containerDir, 'index.js');

    if (action === 'start') {
        if (activeProcess) return res.json({ status: 'info', output: 'البوت يعمل بالفعل حالياً.' });
        
        // فحص ذكي للملف الرئيسي قبل التشغيل
        if (!fs.existsSync(mainBotFile)) {
            return res.json({ status: 'error', output: '❌ خطأ: لم يتم العثور على ملف التشغيل الرئيسي index.js في المجلد الرئيسي للحاوية!\nتأكد أن الملف ليس داخل مجلد فرعي بعد فك الضغط.' });
        }

        activeProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: '🟢 Server marked as online...\n[OptikLink]>> جاري فحص ملفات التشغيل وتفعيل البوت حياً...' });
    }

    if (action === 'stop') {
        if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
            return res.json({ status: 'success', output: '🔴 Server marked as offline...' });
        }
        return res.json({ status: 'info', output: 'الحاوية متوقفة بالفعل.' });
    }

    if (action === 'restart') {
        if (activeProcess) activeProcess.kill();
        if (!fs.existsSync(mainBotFile)) {
            return res.json({ status: 'error', output: '❌ خطأ: ملف index.js مفقود، لا يمكن إعادة التشغيل.' });
        }
        activeProcess = exec(`node index.js`, { cwd: containerDir });
        return res.json({ status: 'success', output: '🔄 جاري عمل إعادة تشغيل شاملة للملفات...\n🟢 Server marked as online.' });
    }
});

app.listen(PORT, () => console.log(`المنصة تعمل بكفاءة على المنفذ ${PORT}`));
