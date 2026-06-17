const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// ===== منع نسختين من البرنامج =====
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }

let mainWindow;
let tray;

// ===== تسريع بدء التشغيل =====
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'حاسبني Pro — نظام ERP المتكامل',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0f1117',
    show: false,
    frame: true,
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:hassibni',
      webSecurity: false,
      enableBlinkFeatures: 'CSSContainerQueries',
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck',
    }
  });

  mainWindow.loadFile('index.html');

  // إظهار سلس بدون وميض — أسرع بكثير
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    if (process.argv.includes('--fullscreen') || process.argv.includes('--maximized')) {
      mainWindow.maximize();
    }
  });

  // فتح روابط خارجية في المتصفح، والسماح بنوافذ الطباعة/المعاينة الداخلية (فواتير الجملة والمشتريات والتقارير)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // نوافذ المعاينة والطباعة الداخلية (تُفتح عبر window.open('', '_blank') ثم تتم كتابة الفاتورة داخلها)
    if (!url || url === 'about:blank' || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('file://')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          title: 'معاينة وطباعة',
          backgroundColor: '#ffffff',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
          }
        }
      };
    }
    // أي رابط خارجي (http/https) يُفتح في المتصفح الافتراضي
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // System tray
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
      tray = new Tray(icon);
      tray.setToolTip('حاسبني L99');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '🖥️ فتح البرنامج', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { label: '💰 نقطة البيع', click: () => { mainWindow?.show(); mainWindow?.webContents.executeJavaScript("navigate('pos')"); } },
        { type: 'separator' },
        { label: '❌ إنهاء', click: () => app.quit() }
      ]));
      tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
    }
  } catch(e) {}

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== قائمة التطبيق =====
function buildMenu() {
  const template = [
    {
      label: 'البرنامج',
      submenu: [
        { label: '🔄 تحديث', accelerator: 'F5', click: () => mainWindow?.webContents.reload() },
        { label: '⛶ ملء الشاشة / تكبير', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { label: '🔲 تكبير النافذة', accelerator: 'CmdOrCtrl+M', click: () => mainWindow?.isMaximized() ? mainWindow.restore() : mainWindow?.maximize() },
        { label: '🔍 تكبير', accelerator: 'CmdOrCtrl+Equal', click: () => { const z = mainWindow?.webContents.getZoomFactor(); mainWindow?.webContents.setZoomFactor(Math.min(z + 0.1, 2)); } },
        { label: '🔍 تصغير', accelerator: 'CmdOrCtrl+-', click: () => { const z = mainWindow?.webContents.getZoomFactor(); mainWindow?.webContents.setZoomFactor(Math.max(z - 0.1, 0.5)); } },
        { label: '↺ الحجم الطبيعي', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.setZoomFactor(1) },
        { type: 'separator' },
        { label: '🛠 أدوات المطور', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '❌ إنهاء البرنامج', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: 'نقطة البيع',
      submenu: [
        { label: '🛒 فتح نقطة البيع', accelerator: 'F2', click: () => mainWindow?.webContents.executeJavaScript("navigate('pos')") },
        { label: '💾 حفظ الفاتورة', accelerator: 'F9', click: () => mainWindow?.webContents.executeJavaScript('completeSale()') },
        { label: '🗑️ مسح السلة', accelerator: 'F10', click: () => mainWindow?.webContents.executeJavaScript('clearCart()') },
        { label: '👁️ معاينة الفاتورة', accelerator: 'CmdOrCtrl+P', click: () => mainWindow?.webContents.executeJavaScript('previewInvoice()') },
        { label: '⌨️ لوحة الأرقام', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.executeJavaScript("openNumpad('paid','')") },
      ]
    },
    {
      label: 'نسخ احتياطي',
      submenu: [
        {
          label: '💾 تصدير البيانات',
          accelerator: 'CmdOrCtrl+S',
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow, {
              title: 'حفظ نسخة احتياطية',
              defaultPath: `hassibni_backup_${new Date().toISOString().split('T')[0]}.json`,
              filters: [{ name: 'JSON Backup', extensions: ['json'] }]
            });
            if (!result.canceled) mainWindow.webContents.send('export-data', result.filePath);
          }
        },
        {
          label: '📂 استيراد البيانات',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'اختر ملف النسخة الاحتياطية',
              filters: [{ name: 'JSON Backup', extensions: ['json'] }],
              properties: ['openFile']
            });
            if (!result.canceled && result.filePaths[0]) {
              const data = fs.readFileSync(result.filePaths[0], 'utf8');
              mainWindow.webContents.send('import-data', data);
            }
          }
        }
      ]
    },
    {
      label: 'مساعدة',
      submenu: [
        {
          label: 'اختصارات لوحة المفاتيح',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'الاختصارات',
            message: 'اختصارات حاسبني L99',
            detail: [
              'F2        — نقطة البيع',
              'F3        — بحث عن منتج',
              'F9        — حفظ الفاتورة',
              'F10       — مسح السلة',
              'F5        — تحديث',
              'F11       — ملء الشاشة',
              'F12       — أدوات المطور',
              'Ctrl+P    — معاينة الفاتورة',
              'Ctrl+K    — لوحة الأرقام',
              'Ctrl+M    — تكبير النافذة',
              'Ctrl+S    — تصدير البيانات',
              'Ctrl+O    — استيراد البيانات',
              '+/-       — زيادة/تقليل كمية آخر منتج',
              'Esc       — إغلاق النوافذ',
            ].join('\n'),
            buttons: ['حسناً']
          })
        },
        { type: 'separator' },
        {
          label: 'عن البرنامج',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'حاسبني L99',
            message: 'حاسبني L99 — نظام المحاسبة المتكامل',
            detail: 'الإصدار 11.0 L99\n\nنظام محاسبة متكامل للمتاجر\nيدعم: نقطة البيع • المخزون • الفواتير\nالعملاء • الموردون • التقارير • AI\nحفظ سريع بـ IndexedDB • طباعة فورية\n\n© 2025 حاسبني',
            buttons: ['حسناً']
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ===== IPC: حفظ ملف =====
ipcMain.on('save-file', (event, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, data, 'utf8');
    event.reply('save-file-done', { success: true });
  } catch(e) {
    event.reply('save-file-done', { success: false, error: e.message });
  }
});

// ===== تشغيل =====
app.whenReady().then(() => {
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
