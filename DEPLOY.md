# Guia de Deploy — Micro-Scalper Dashboard

Este documento contém as instruções para atualizar o servidor Oracle Cloud com as mudanças locais.

## 🚀 Fluxo de Atualização

Sempre que você (ou eu) fizer uma alteração no código e quiser que ela apareça no painel online, siga estes passos:

### 1. Enviar para o GitHub
No terminal local, envie as alterações:
```bash
git add .
git commit -m "Minha atualização"
git push
```

### 2. Sincronizar e Reiniciar o Servidor
Execute o comando SSH para que o servidor baixe o código e reinicie o serviço:
```bash
ssh -i "C:\Users\vinic\Downloads\ssh-key-2026-05-06.key" ubuntu@137.131.141.14 "cd ~/trading && git pull && pm2 restart all"
```

---

## ℹ️ Informações de Conexão
- **IP do Servidor:** `137.131.141.14`
- **Usuário:** `ubuntu`
- **Caminho da Chave SSH:** `C:\Users\vinic\Downloads\ssh-key-2026-05-06.key`
- **Diretório do Projeto no Servidor:** `~/trading`

## 🛠️ Script de Automação
Criei um arquivo chamado `deploy_server.bat` na raiz do projeto. Basta dar um clique duplo nele para fazer o processo completo (Git Push + SSH Update) de uma vez.
