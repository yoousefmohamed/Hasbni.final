@echo off
chcp 65001 > nul
title حاسبني Pro — نظام ERP المتكامل

if not exist "node_modules\electron" (
    echo جاري تثبيت المكتبات...
    call npm install --prefer-offline 2>nul
    if errorlevel 1 (
        call npm install
    )
)

echo جاري تشغيل البرنامج...
call npm start
