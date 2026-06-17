@echo off
chcp 65001 > nul
title تثبيت حاسبني Pro
echo.
echo  ══════════════════════════════════════
echo    حاسبني Pro — نظام ERP المتكامل
echo  ══════════════════════════════════════
echo.

where node > nul 2>&1
if errorlevel 1 (
    echo  Node.js غير مثبت!
    echo  يرجى تحميل وتثبيت Node.js من: https://nodejs.org
    echo  اختر النسخة LTS ثم أعد تشغيل هذا الملف
    pause
    exit /b 1
)

echo  Node.js موجود...
echo  جاري تثبيت المكتبات...
call npm install
if errorlevel 1 (
    echo  فشل التثبيت - جرب تشغيل npm install يدوياً
    pause
    exit /b 1
)
echo.
echo  تم التثبيت بنجاح!
echo  جاري تشغيل البرنامج...
call npm start
