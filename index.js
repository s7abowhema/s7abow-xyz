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
let botProcess = null; // لتخزين عملية البوت المشغل

// إعداد مكتبة Multer لاستقبال ملفات الـ Zip
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'bot-files.zip');
    }
});
const upload = multer({ storage: storage });

// الصفحة الرئيسية للموقع
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. نقطة النهاية لرفع ملفات البوت وفك ضغطها
app.post('/api/upload-bot', upload.single('botZip'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'الرجاء اختيار ملف Zip لرفعه.' });
    }

    try {
        const zipPath = req.file.path;
        const targetDir = path.join(__dirname, 'user_bot');

        // تنظيف المجلد القديم إن وجد
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
        fs.mkdirSync(targetDir);

        // فك ضغط ملف البوت
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(targetDir, true);

        // حذف ملف الـ zip المضغوط بعد فكه لتوفير المساحة
        fs.unlinkSync(zipPath);

        res.json({ status: 'success', message: 'تم رفع ملفات البوت وفك ضغطها بنجاح في السيرفر!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء فك ضغط الملف.' });
    }
});

// 2. نقطة النهاية للتحكم في تشغيل البوت المرفوع
app.post('/api/bot-control', (req, res) => {
    const { action } = req.body;
    const botMainFile = path.join(__dirname, 'user_bot', 'index.js'); // يفترض أن الملف الرئيسي اسمه index.js داخل الـ zip

    if (action === 'start') {
        if (botProcess) {
            return res.json({ status: 'info', message: 'البوت يعمل بالفعل حالياً.' });
        }

        if (!fs.existsSync(botMainFile)) {
            return res.status(400).json({ status: 'error', message: 'لم يتم العثور على ملف index.js رئيسي داخل البوت المرفوع.' });
        }

        // تشغيل البوت الفعلي المرفوع من قبل المستخدم
        botProcess = exec(`node ${botMainFile}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`خطأ البوت: ${error}`);
                botProcess = null;
                return;
            }
        });

        return res.json({ status: 'success', message: 'تم تشغيل البوت المرفوع بنجاح على الاستضافة!' });
    }

    if (action === 'stop') {
        if (botProcess) {
            botProcess.kill();
            botProcess = null;
            return res.json({ status: 'success', message: 'تم إيقاف تشغيل البوت بنجاح.' });
        }
        return res.json({ status: 'info', message: 'البوت متوقف بالفعل.' });
    }

    res.status(400).json({ status: 'error', message: 'أمر غير معروف.' });
});

app.listen(PORT, () => {
    console.log(`موقع الاستضافة يعمل الآن على المنفذ: ${PORT}`);
});
