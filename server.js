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
const { executarTestePerformance, formatarMensagemWhatsApp } = require('./testRunner');

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

// ==========================================
// CONFIGURAÇÃO E TRAVA DE SEGURANÇA WHATSAPP
// ==========================================
const OFFICIAL_GROUP_JID = '120363432601138971@g.us';
const OFFICIAL_GROUP_NAME = 'teste do g-vis';

function isOfficialTestGroup(g) {
    if (!g) return false;
    if (g.id === OFFICIAL_GROUP_JID) return true;
    const subj = (g.subject || g.name || '').trim().toLowerCase();
    return subj === OFFICIAL_GROUP_NAME;
}

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
            const targetGroup = groupList.find(isOfficialTestGroup);
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

        const gvisGroup = list.find(isOfficialTestGroup);

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

        // Busca exclusivamente o grupo oficial 'Teste do G-VIS'
        const foundGroup = groupList.find(isOfficialTestGroup);
        if (foundGroup) {
            targetGroupJid = foundGroup.id;
            console.log(`[WhatsApp] ✅ Grupo oficial localizado: ${foundGroup.subject} (${targetGroupJid})`);
        } else if (rawDest === OFFICIAL_GROUP_JID) {
            targetGroupJid = OFFICIAL_GROUP_JID;
        }

        // Regra Estrita e Inviolável de Segurança: APENAS o grupo oficial Teste do G-VIS é permitido
        if (!targetGroupJid || targetGroupJid !== OFFICIAL_GROUP_JID) {
            console.warn(`[WhatsApp] 🛑 BLOQUEIO DE SEGURANÇA: Tentativa de envio para '${rawDest}'. Somente o grupo oficial '${OFFICIAL_GROUP_NAME}' (${OFFICIAL_GROUP_JID}) é permitido.`);
            return res.status(403).json({
                success: false,
                error: `Envio bloqueado por segurança: Mensagens de performance são restritas EXCLUSIVAMENTE ao grupo 'Teste do G-VIS' (JID: ${OFFICIAL_GROUP_JID}). O número não enviará para nenhum outro grupo ou contato.`
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

// ==========================================
// ANTI-SLEEP NATIVO 24/7: AUTO-PING A CADA 20 SEGUNDOS
// Mantém o container do Render permanentemente ativo sem necessidade de cron
// ==========================================
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://gvis-whatsapp.onrender.com';
setInterval(() => {
    fetch(`${RENDER_EXTERNAL_URL}/ping`)
        .then(res => res.json())
        .then(d => {
            // Auto-ping registrado com sucesso a cada 20s
        })
        .catch(() => {});
}, 20000); // Exatos 20 segundos

// ==========================================
// ROTA PARA EXECUÇÃO SOB DEMANDA DO TESTE
// ==========================================
app.get('/executar-teste', async (req, res) => {
    try {
        console.log('[API] 🚀 Requisição recebida para /executar-teste...');
        const { resultado, mensagemWhatsApp } = await executarTestePerformance();

        let waEnviado = false;
        if (sock && isConnected) {
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);
                const foundGroup = groupList.find(isOfficialTestGroup);
                if (foundGroup) {
                    await sock.sendMessage(foundGroup.id, { text: mensagemWhatsApp });
                    await setOfflineMode();
                    waEnviado = true;
                    console.log(`[API] ✅ Relatório enviado exclusivamente para o grupo oficial: ${foundGroup.subject} (${foundGroup.id})`);
                } else {
                    console.warn(`[API] 🛑 Grupo oficial 'Teste do G-VIS' (${OFFICIAL_GROUP_JID}) não encontrado. Nenhuma mensagem enviada.`);
                }
            } catch (errWa) {
                console.error('[API] Falha no envio WhatsApp:', errWa.message);
            }
        }

        return res.json({
            sucesso: true,
            whatsapp_enviado: waEnviado,
            dados: resultado
        });
    } catch (err) {
        console.error('[API] Erro ao executar teste:', err);
        return res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// ==========================================
// AUTOMAÇÃO 100% NUVEM (A CADA 1 HORA)
// ==========================================
const TEST_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
setInterval(async () => {
    console.log('[Automação Nuvem ⏰] Iniciando teste de performance automático horário...');
    try {
        const { resultado, mensagemWhatsApp } = await executarTestePerformance();
        console.log('[Automação Nuvem] ✅ Teste executado e atualizado no painel via FTP!');

        if (sock && isConnected) {
            const groups = await sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);
            const foundGroup = groupList.find(g => 
                g.subject && (
                    g.subject.toLowerCase().includes('teste do g-vis') || 
                    g.subject.toLowerCase().includes('g-vis')
                )
            );
            if (foundGroup) {
                await sock.sendMessage(foundGroup.id, { text: mensagemWhatsApp });
                await setOfflineMode();
                console.log('[Automação Nuvem] 📲 Relatório enviado com sucesso para o grupo Teste do G-VIS!');
            }
        } else {
            console.log('[Automação Nuvem] ℹ️ WhatsApp offline no momento; painel web atualizado.');
        }
    } catch (err) {
        console.error('[Automação Nuvem] Erro no teste automático:', err.message);
    }
}, TEST_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`[Serviço WhatsApp G-VIS] Rodando na porta ${PORT}`);
    console.log(`Acesse http://localhost:${PORT}/qr para parear o WhatsApp`);
});
