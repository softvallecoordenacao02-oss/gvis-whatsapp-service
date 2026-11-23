/**
 * Microserviço WhatsApp Baileys para Notificações do G-VIS
 * Hospedagem: Render (Node.js)
 * Modo Oculto: Presença sempre 'unavailable' para não bloquear notificações no celular
 */

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let sock = null;
let currentQr = null;
let isConnected = false;
let botUser = null;
let lastPresenceUpdate = null;
const startTime = Date.now();

// Logger silencioso para não poluir o terminal
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

/**
 * Força o bot para Modo Oculto (unavailable / offline)
 */
async function setOfflineMode() {
    if (!sock || !isConnected) return;
    try {
        await sock.sendPresenceUpdate('unavailable');
        lastPresenceUpdate = new Date().toISOString();
        console.log(`[Modo Oculto] Presença atualizada para 'unavailable' em ${lastPresenceUpdate}`);
    } catch (err) {
        console.error('[Modo Oculto] Erro ao definir presença:', err.message);
    }
}

/**
 * Inicializa a conexão com o WhatsApp via Baileys
 */
async function connectToWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: state,
            browser: ['G-VIS Monitor', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false // Inicia sem marcar online
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQr = qr;
                isConnected = false;
                console.log('[WhatsApp] Novo QR Code gerado.');
            }

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[WhatsApp] Conexão fechada. Motivo: ${statusCode}. Reconectar: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    console.log('[WhatsApp] Sessão encerrada (logged out). Limpando dados de autenticação...');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQr = null;
                botUser = sock.user ? sock.user.id : 'Conectado';
                console.log(`[WhatsApp] ✅ Conectado com sucesso! Usuário: ${botUser}`);

                // Ativa imediatamente o Modo Oculto
                await setOfflineMode();
            }
        });

    } catch (err) {
        console.error('[WhatsApp] Falha ao inicializar Baileys:', err);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Inicia a conexão
connectToWhatsApp();

// ==========================================
// ROTAS E ENDPOINTS DA API
// ==========================================

/**
 * GET /ping
 * Endpoint leve para manter o Render acordado (Anti-Sleep)
 */
app.get('/ping', (req, res) => {
    res.json({
        pong: true,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /status
 * Status da conexão, usuário conectado e informações
 */
app.get('/status', async (req, res) => {
    let groupsCount = 0;
    let targetGroupFound = false;
    let targetGroupJid = null;

    if (isConnected && sock) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);
            groupsCount = groupList.length;
            const targetGroup = groupList.find(g => 
                g.subject && (
                    g.subject.toLowerCase().includes('teste do g-vis') || 
                    g.subject.toLowerCase().includes('g-vis')
                )
            );
            if (targetGroup) {
                targetGroupFound = true;
                targetGroupJid = targetGroup.id;
            }
        } catch (e) {}
    }

    res.json({
        online: isConnected,
        connected: isConnected,
        user: botUser,
        hasQrCode: !!currentQr,
        targetGroupFound,
        targetGroupJid,
        groupsCount,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        serverTime: new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
        lastPresenceUpdate
    });
});

/**
 * GET /set-offline
 * Força o bot a permanecer em modo invisível / offline
 */
app.get('/set-offline', async (req, res) => {
    await setOfflineMode();
    res.json({
        success: true,
        mode: 'unavailable',
        message: 'Modo Oculto ativado com sucesso.',
        timestamp: lastPresenceUpdate
    });
});

/**
 * GET /groups
 * Lista todos os grupos onde o número está conectado
 */
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp desconectado' });
    }

    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject || 'Sem nome',
            participantsCount: g.participants?.length || 0,
            creation: g.creation
        }));

        const gvisGroup = list.find(g => 
            g.name.toLowerCase().includes('teste do g-vis') || 
            g.name.toLowerCase().includes('g-vis')
        );

        res.json({
            success: true,
            count: list.length,
            targetGroupJid: gvisGroup ? gvisGroup.id : null,
            targetGroupName: gvisGroup ? gvisGroup.name : null,
            groups: list
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /qr e GET /
 * Interface visual amigável para escanear o QR Code
 */
app.get(['/', '/qr'], async (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <title>WhatsApp Conectado - G-VIS Monitor</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                    .card { background: #1e293b; border-radius: 16px; padding: 32px; max-width: 460px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                    .badge { display: inline-block; padding: 6px 14px; border-radius: 9999px; background: rgba(34, 197, 94, 0.2); color: #4ade80; font-weight: bold; margin-bottom: 16px; }
                    h1 { margin: 0 0 12px 0; font-size: 24px; }
                    p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
                    .info { background: #0f172a; border-radius: 8px; padding: 12px; margin-top: 20px; font-family: monospace; font-size: 13px; color: #38bdf8; word-break: break-all; }
                    .btn { display: inline-block; margin-top: 18px; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; }
                </style>
            </head>
            <body>
                <div class="card">
                    <span class="badge">● WhatsApp Conectado</span>
                    <h1>Serviço Baileys Ativo</h1>
                    <p>O número está autenticado e pronto para despachar relatórios automatizados de performance para o grupo <strong>Teste do G-VIS</strong>.</p>
                    <div class="info">ID do Usuário: ${botUser || 'Ativo'}</div>
                    <div style="margin-top: 15px;">
                        <a href="/groups" class="btn">Ver Grupos Conectados</a>
                        <a href="/status" class="btn" style="background: #475569; margin-left: 8px;">Ver Status API</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    }

    if (!currentQr) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="refresh" content="3">
                <title>Iniciando WhatsApp...</title>
                <style>
                    body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
                    .card { text-align: center; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>Gerando QR Code...</h2>
                    <p style="color: #94a3b8;">Aguarde alguns segundos. A página irá atualizar automaticamente.</p>
                </div>
            </body>
            </html>
        `);
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(currentQr, { width: 320, margin: 2 });
        res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="refresh" content="7">
                <title>Conectar WhatsApp - G-VIS Monitor</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                    .card { background: #1e293b; border-radius: 16px; padding: 28px; max-width: 420px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                    h1 { margin: 0 0 10px 0; font-size: 22px; }
                    p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; line-height: 1.4; }
                    .qr-box { background: white; padding: 12px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
                    .qr-box img { display: block; width: 280px; height: 280px; }
                    .steps { text-align: left; background: #0f172a; padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 13px; color: #cbd5e1; }
                    .steps ol { margin: 0; padding-left: 20px; }
                    .steps li { margin-bottom: 6px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Escanear QR Code</h1>
                    <p>Abra o WhatsApp no número <strong>81971015818</strong> e escaneie o código abaixo:</p>
                    <div class="qr-box">
                        <img src="${qrDataUrl}" alt="QR Code WhatsApp">
                    </div>
                    <div class="steps">
                        <ol>
                            <li>No celular, abra o <strong>WhatsApp</strong>.</li>
                            <li>Acesse <strong>Aparelhos conectados</strong> > <strong>Conectar um aparelho</strong>.</li>
                            <li>Aponte a câmera para a tela para parear.</li>
                        </ol>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Erro ao renderizar QR Code: ' + err.message);
    }
});

/**
 * POST /send-message
 * Envia mensagem EXCLUSIVAMENTE para o grupo "Teste do G-VIS"
 */
app.post('/send-message', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp Baileys não está conectado no momento.'
        });
    }

    const { jid, group, message, text } = req.body;
    const rawDest = String(jid || group || 'Teste do G-VIS').trim();
    const messageText = String(message || text || '').trim();

    if (!messageText) {
        return res.status(400).json({ success: false, error: 'Mensagem vazia.' });
    }

    let targetGroupJid = null;

    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);

        // 1. Se já forneceu diretamente o JID do grupo (@g.us)
        if (rawDest.endsWith('@g.us')) {
            targetGroupJid = rawDest;
        } else {
            // 2. Busca pelo nome do grupo oficial 'Teste do G-VIS'
            const foundGroup = groupList.find(g => 
                g.subject && (
                    g.subject.toLowerCase().includes('teste do g-vis') || 
                    g.subject.toLowerCase().includes('g-vis')
                )
            );
            if (foundGroup) {
                targetGroupJid = foundGroup.id;
                console.log(`[WhatsApp] Grupo 'Teste do G-VIS' localizado: ${foundGroup.subject} (${targetGroupJid})`);
            }
        }

        // Regra Estrita: Envio exclusivo para o grupo
        if (!targetGroupJid || !targetGroupJid.endsWith('@g.us')) {
            console.warn("[WhatsApp] Bloqueado: Grupo 'Teste do G-VIS' não encontrado entre os grupos conectados.");
            return res.status(404).json({
                success: false,
                error: "Envio bloqueado: Mensagens de performance são restritas ao grupo 'Teste do G-VIS'. Adicione o número ao grupo no WhatsApp."
            });
        }

        console.log(`[WhatsApp] Enviando mensagem exclusivamente para o grupo ${targetGroupJid}...`);
        const sent = await sock.sendMessage(targetGroupJid, { text: messageText });

        // Força modo oculto logo após enviar para manter o bot invisível
        await setOfflineMode();

        return res.json({
            success: true,
            group: targetGroupJid,
            messageId: sent.key.id,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('[WhatsApp] Falha ao despachar mensagem para o grupo:', err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`[Serviço WhatsApp G-VIS] Rodando na porta ${PORT}`);
    console.log(`Acesse http://localhost:${PORT}/qr para parear o WhatsApp`);
});
