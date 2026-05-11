@echo off
setlocal
echo ======================================================
echo   🚀 DEPLOY MICRO-SCALPER - ORACLE CLOUD
echo ======================================================
echo.

:: 1. Git Push
echo [1/2] Enviando alteracoes para GitHub...
git add .
git commit -m "Auto-deploy update"
git push
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Erro ao enviar para o GitHub. Verifique sua conexao ou conflitos.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ------------------------------------------------------
echo.

:: 2. SSH Update
echo [2/2] Atualizando servidor remoto via SSH...
ssh -i "C:\Users\vinic\Downloads\ssh-key-2026-05-06.key" -o StrictHostKeyChecking=accept-new ubuntu@137.131.141.14 "cd ~/trading && git pull && pm2 restart all"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Erro ao conectar ou reiniciar o servidor Oracle.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ======================================================
echo   ✅ DEPLOY CONCLUIDO COM SUCESSO!
echo   Lembre-se de dar Ctrl+F5 no seu navegador.
echo ======================================================
echo.
pause
