import './redactSignalLogs.js';
import startApp from './startApp.js';

// سجّل معالجات الأخطاء قبل بدء التطبيق
// Baileys يُطلق أخطاء غير متوقعة أحياناً — لا نُنهي العملية بسببها
process.on('uncaughtException', (error) => {
    console.error('[uncaughtException] non-fatal, continuing:', error?.message ?? error);
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] non-fatal, continuing:', reason?.message ?? reason);
});

// بدء الخادم
startApp();
