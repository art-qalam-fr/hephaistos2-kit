@echo off
rem n8n-auth-proxy : proxy auth n8n (:5680) + exec whitelist /x-run pour les workflows.
rem Lance par la tache planifiee hphe-n8n-proxy au logon.
cd /d "%~dp0..\.."
rem Cible configurable via N8N_TARGET (defaut localhost ; utiliser l'IP LAN si un
rem tunnel ssh -L 5678 capture 127.0.0.1:5678 et detournerait le proxy).
if not defined N8N_TARGET set "N8N_TARGET=http://127.0.0.1:5678"
rem Node : PATH d'abord, sinon NVM_HOME (nvm4w) — pas de chemin machine en dur.
set "NODE_EXE=node"
if defined NVM_HOME if exist "%NVM_HOME%\nodejs\node.exe" set "NODE_EXE=%NVM_HOME%\nodejs\node.exe"
start "" /min "%NODE_EXE%" "%~dp0n8n-auth-proxy.mjs"
