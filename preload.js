const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');

// نجسّر بين الـ renderer و main process بأمان
contextBridge.exposeInMainWorld('electronAPI', {
  // تصدير البيانات
  onExportData: (callback) => {
    ipcRenderer.on('export-data', (event, filePath) => callback(filePath));
  },
  // استيراد البيانات
  onImportData: (callback) => {
    ipcRenderer.on('import-data', (event, data) => callback(data));
  },
  // حفظ ملف
  saveFile: (filePath, data) => {
    ipcRenderer.send('save-file', { filePath, data });
  },
  onSaveFileDone: (callback) => {
    ipcRenderer.on('save-file-done', (event, result) => callback(result));
  },
  // معلومات
  isElectron: true,
  platform: process.platform
});
