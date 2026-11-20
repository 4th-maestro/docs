@echo off
cd /d "%~dp0"
start "" http://localhost:8766/digital-twin.html
rem node가 있으면 시뮬레이션 API까지 되는 서버, 없으면 화면만 보는 python 서버
where node >nul 2>nul && (node tools\sim-server.mjs 8766) || (python -m http.server 8766)
