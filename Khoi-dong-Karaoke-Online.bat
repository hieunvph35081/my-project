@echo off
title Khoi dong Karaoke Manager
cd /d "%~dp0"

echo [1/2] Dang khoi dong may chu Karaoke Manager...
start "Karaoke Server (Giu mo cua so nay)" cmd /k "npm start"

timeout /t 2 /nobreak >nul

echo [2/2] Dang tao duong link Online qua Cloudflare (HTTP/2)...
start "Link Online Cloudflare (Copy link .trycloudflare.com)" cmd /k "cloudflared tunnel --protocol http2 --url http://localhost:3000"

timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/quan-ly"
