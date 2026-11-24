/**
 * Executor Nativo de Performance do G-VIS no Node.js
 * Executa sem bloqueios através do Cloudflare Worker brasileiro
 * Escala Oficial:
 *   0 a 5s:    🟢 BOM
 *   6 a 10s:   🟡 ACEITÁVEL
 *   11 a 30s:  🟠 LENTO
 *   > 30s:     🔴 CRÍTICO
 */

const net = require('net');

const WORKER_BASE = 'https://green-scene-3f46.softvalle-coordenacao02.workers.dev';
const IDS_VALIDOS = [15, 20, 25, 30, 35, 40, 50, 100];

const FTP_HOST = 'ftpupload.net';
const FTP_USER = 'if0_43514854';
const FTP_PASS = 'hTfTtRGoeqAO5W';

function classificarTempo(ms) {
    if (ms <= 5000) return { label: "🟢 BOM", badge: "badge-bom", class: "badge-success", status: "bom" };
    if (ms <= 10000) return { label: "🟡 ACEITÁVEL", badge: "badge-aceitavel", class: "badge-aceitavel", status: "aceitavel" };
    if (ms <= 30000) return { label: "🟠 LENTO", badge: "badge-lento", class: "badge-lento", status: "lento" };
    return { label: "🔴 CRÍTICO", badge: "badge-critico", class: "badge-danger", status: "critico" };
}

function ftpUpload(host, user, pass, remotePath, content) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port: 21 });
        let buffer = '';
        let step = 0;
        let dataSocket = null;

        const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error('FTP timeout de 15s'));
        }, 15000);

        client.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\r\n');
            buffer = lines.pop();

            for (const line of lines) {
                const code = parseInt(line.substring(0, 3));
                if (code === 220 && step === 0) {
                    step = 1;
                    client.write(`USER ${user}\r\n`);
                } else if (code === 331 && step === 1) {
                    step = 2;
                    client.write(`PASS ${pass}\r\n`);
                } else if (code === 230 && step === 2) {
                    step = 3;
                    client.write('TYPE I\r\n');
                } else if (code === 200 && step === 3) {
                    step = 4;
                    client.write('PASV\r\n');
                } else if (code === 227 && step === 4) {
                    const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
                    if (!m) {
                        clearTimeout(timeout);
                        return reject(new Error('Falha no PASV: ' + line));
                    }
                    const dataHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
                    const dataPort = (parseInt(m[5]) << 8) + parseInt(m[6]);
                    
                    dataSocket = net.createConnection({ host: dataHost, port: dataPort });
                    step = 5;
                    client.write(`STOR ${remotePath}\r\n`);
                } else if (code === 150 && step === 5) {
                    dataSocket.write(content, () => {
                        dataSocket.end();
                    });
                } else if (code === 226 && step === 5) {
                    step = 6;
                    client.write('QUIT\r\n');
                    clearTimeout(timeout);
                    resolve(true);
                }
            }
        });

        client.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function formatarMensagemWhatsApp(dados) {
    const dtInicio = dados.data_hora_inicio || '-';
    const dtFim = dados.data_hora_fim || '-';
    const duracao = dados.tempo_total_execucao_segundos || 0;

    const latMedia = dados.latencia?.media || 0;
    const loginTempo = dados.login?.tempo_total_ms || 0;
    const vazao = dados.carga?.requisicoes_por_segundo || 0;
    const erros = dados.carga?.erros || 0;

    const clsLat = classificarTempo(latMedia).label;
    const clsLogin = classificarTempo(loginTempo).label;

    const linhas = [
        "⚡ *G-VIS — MONITORAMENTO AUTOMÁTICO DE PERFORMANCE*",
        "━━━━━━━━━━━━━━━━━━━━━━━━━",
        `📅 *Início:* ${dtInicio}`,
        `🏁 *Fim:* ${dtFim}`,
        `⏱️ *Duração do Teste:* ${duracao.toFixed(1)}s`,
        "━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📊 *LATÊNCIA DAS ETAPAS:*",
        `• *Latência Login (GET):* ${latMedia}ms (${clsLat})`,
        `• *Fluxo de Login (POST):* ${(loginTempo / 1000).toFixed(2)}s (${clsLogin})`
    ];

    let procSorteadoStr = "-";
    let piorClassif = "🟢 BOM";
    let etapaGargalo = "Nenhum gargalo identificado";

    const paginas = dados.paginas_internas?.paginas || [];
    for (const p of paginas) {
        const nome = p.nome || 'Página';
        const ms = p.media_ms || 0;
        const seg = (ms / 1000).toFixed(2);
        const cls = classificarTempo(ms).label;

        if (nome.includes('Tela de Processo')) {
            const m = nome.match(/id=(\d+)/);
            if (m) procSorteadoStr = `#${m[1]}`;
        }

        linhas.push(`• *${nome}:* ${seg}s (${cls})`);

        if (cls.includes('🔴')) {
            piorClassif = "🔴 CRÍTICO";
            etapaGargalo = `${nome} (${seg}s)`;
        } else if (cls.includes('🟠') && !piorClassif.includes('🔴')) {
            piorClassif = "🟠 LENTO";
            etapaGargalo = `${nome} (${seg}s)`;
        } else if (cls.includes('🟡') && piorClassif === "🟢 BOM") {
            piorClassif = "🟡 ACEITÁVEL";
        }
    }

    linhas.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
    linhas.push("🚀 *TESTE DE VAZÃO SOB CARGA:*");
    linhas.push(`• *Vazão:* ${vazao.toFixed(1)} req/s | *Erros:* ${erros}`);
    if (procSorteadoStr !== "-") {
        linhas.push(`• *Processo Sorteado:* ${procSorteadoStr}`);
    }

    linhas.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
    linhas.push(`🚦 *Classificação Geral:* ${piorClassif}`);
    if (piorClassif.includes('🔴') || piorClassif.includes('🟠')) {
        linhas.push(`⚠️ *Ponto de Atenção:* ${etapaGargalo}`);
    } else {
        linhas.push("✅ *Desempenho Geral:* Estável dentro dos parâmetros aceitáveis.");
    }

    linhas.push("\n🌐 *Painel Online:* https://testegvisa.freedev.app");
    return linhas.join("\n");
}

async function executarTestePerformance() {
    const tInicioGlobal = Date.now();
    const dataInicioStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`[Teste G-VIS] 🚀 Iniciando bateria de testes em ${dataInicioStr}...`);

    let cookies = {};
    function parseCookies(resp) {
        const setCookieHeaders = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie')];
        for (const hdr of setCookieHeaders) {
            if (!hdr) continue;
            const parts = hdr.split(';');
            const first = parts[0];
            const eq = first.indexOf('=');
            if (eq > 0) {
                const k = first.substring(0, eq).trim();
                const v = first.substring(eq + 1).trim();
                cookies[k] = v;
            }
        }
    }
    function getCookieHeader() {
        return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // 1. Latência GET
    const temposGet = [];
    for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const resp = await fetch(`${WORKER_BASE}/login.seam`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });
        temposGet.push(Date.now() - t0);
        parseCookies(resp);
    }
    temposGet.sort((a, b) => a - b);
    const latencia = {
        media: Math.round(temposGet.reduce((a, b) => a + b, 0) / temposGet.length),
        minimo: temposGet[0],
        maximo: temposGet[temposGet.length - 1],
        p95: temposGet[temposGet.length - 1],
        amostras: temposGet.length
    };

    // 2. Autenticação POST
    const respLoginGet = await fetch(`${WORKER_BASE}/login.seam`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': getCookieHeader() }
    });
    parseCookies(respLoginGet);
    const htmlLogin = await respLoginGet.text();
    const vsMatch = htmlLogin.match(/name=["\']javax\.faces\.ViewState["\'][^>]+value=["\']([^"\']+)["\']/i);
    const viewState = vsMatch ? vsMatch[1] : 'j_id1';

    let action = '/login.seam';
    const actMatch = htmlLogin.match(/<form[^>]+id=["\']formLogin["\'][^>]+action=["\']([^"\']+)["\']/i);
    if (actMatch) action = actMatch[1];
    let postUrl = action.startsWith('http') ? action : `${WORKER_BASE}${action}`;
    postUrl = postUrl.replace('https://santoagostinho.g-visa.com.br', WORKER_BASE);

    const postParams = new URLSearchParams({
        'formLogin': 'formLogin',
        'formLogin:login': 'softvalle4',
        'formLogin:password': '123456',
        'formLogin:btn-login': 'Entrar',
        'javax.faces.ViewState': viewState
    });

    const tPost0 = Date.now();
    const respPost = await fetch(postUrl, {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': getCookieHeader(),
            'Referer': `${WORKER_BASE}/login.seam`
        },
        body: postParams.toString(),
        redirect: 'follow'
    });
    const tempoPost = Date.now() - tPost0;
    parseCookies(respPost);
    const authOk = respPost.status === 200;
    const login = {
        sucesso: authOk,
        status_code: respPost.status,
        url_pos_login: respPost.url,
        tempo_get_ms: latencia.media,
        tempo_post_ms: tempoPost,
        tempo_total_ms: latencia.media + tempoPost
    };

    // 3. Dashboard e CID Dinâmico
    const tDash0 = Date.now();
    const respDash = await fetch(`${WORKER_BASE}/modules/dashboard/home.seam`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': getCookieHeader() }
    });
    const tempoDash = Date.now() - tDash0;
    parseCookies(respDash);
    const htmlDash = await respDash.text();
    let cidMatch = htmlDash.match(/cid=(\d+)/i) || htmlDash.match(/conversationPropagation=nested&cid=(\d+)/i);
    let cidDinamico = cidMatch ? cidMatch[1] : '19032';

    // 4. Rotas Internas Críticas
    const procSorteadoId = IDS_VALIDOS[Math.floor(Math.random() * IDS_VALIDOS.length)];
    const urlsCriticas = [
        { nome: "Dashboard Principal", url: `${WORKER_BASE}/modules/dashboard/home.seam` },
        { nome: "Dashboard - Solicitação de Processos", url: `${WORKER_BASE}/modules/dashboard/home-processos-solicitacao.seam?idp=1&cid=${cidDinamico}&idto=1` },
        { nome: "Home Processos (Painel)", url: `${WORKER_BASE}/modules/dashboard/processos/home.seam?idp=1&cid=${cidDinamico}` },
        { nome: `Tela de Processo (id=${procSorteadoId})`, url: `${WORKER_BASE}/modules/processo/processo.seam?id=${procSorteadoId}&cid=${cidDinamico}` }
    ];

    const resultadosPaginas = [];
    for (const item of urlsCriticas) {
        const t0 = Date.now();
        const resp = await fetch(item.url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Cookie': getCookieHeader(),
                'Referer': `${WORKER_BASE}/modules/dashboard/home.seam`
            }
        });
        const elapsed = Date.now() - t0;
        const text = await resp.text();
        const bytes = text.length;
        const cls = classificarTempo(elapsed);
        const hasError = resp.status >= 500 || text.includes('NullPointerException') || text.includes('AuthorizationException');

        resultadosPaginas.push({
            nome: item.nome,
            url: item.url,
            media_ms: elapsed,
            minimo_ms: elapsed,
            maximo_ms: elapsed,
            tamanho_kb: Math.round(bytes / 102.4) / 10,
            status_code: resp.status,
            tem_erro: hasError,
            detalhe_erro: hasError ? 'Erro interno JBoss' : null,
            classificacao: cls.label,
            badge: cls.badge
        });
    }

    // 5. Carga rápida (3 requisições)
    const temposCarga = [];
    const tCarga0 = Date.now();
    for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const resp = await fetch(`${WORKER_BASE}/login.seam`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (resp.status === 200) temposCarga.push(Date.now() - t0);
    }
    const duracaoCarga = (Date.now() - tCarga0) / 1000;
    const rps = duracaoCarga > 0 ? Math.round((3 / duracaoCarga) * 10) / 10 : 3.0;

    const carga = {
        total_requisicoes: 3,
        concorrencia: 3,
        duracao_segundos: Math.round(duracaoCarga * 100) / 100,
        requisicoes_por_segundo: rps,
        erros: 3 - temposCarga.length,
        media_ms: temposCarga.length ? Math.round(temposCarga.reduce((a, b) => a + b, 0) / temposCarga.length) : 300,
        minimo_ms: temposCarga.length ? Math.min(...temposCarga) : 300,
        maximo_ms: temposCarga.length ? Math.max(...temposCarga) : 300,
        p95_ms: temposCarga.length ? Math.max(...temposCarga) : 300
    };

    const tempoTotalGlobal = (Date.now() - tInicioGlobal) / 1000;
    const dataFimStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const resultadoFinal = {
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        data_hora_inicio: dataInicioStr,
        data_hora_fim: dataFimStr,
        tempo_total_execucao_segundos: Math.round(tempoTotalGlobal * 10) / 10,
        usuario: "softvalle4",
        alvo: "https://santoagostinho.g-visa.com.br",
        cid_dinamico: cidDinamico,
        latencia: latencia,
        login: login,
        paginas_internas: {
            paginas: resultadosPaginas,
            media_geral_ms: Math.round(resultadosPaginas.reduce((a, b) => a + b.media_ms, 0) / resultadosPaginas.length),
            processo_sorteado_id: procSorteadoId
        },
        carga: carga
    };

    // Upload automático via FTP para o site testegvisa.freedev.app
    try {
        await ftpUpload(
            FTP_HOST,
            FTP_USER,
            FTP_PASS,
            'htdocs/resultado_performance.json',
            JSON.stringify(resultadoFinal, null, 2)
        );
        console.log('[Upload FTP] ✅ resultado_performance.json atualizado no painel testegvisa.freedev.app!');
    } catch (ftpErr) {
        console.warn('[Upload FTP] Aviso ao atualizar FTP:', ftpErr.message);
    }

    return {
        resultado: resultadoFinal,
        mensagemWhatsApp: formatarMensagemWhatsApp(resultadoFinal)
    };
}

module.exports = {
    executarTestePerformance,
    formatarMensagemWhatsApp,
    classificarTempo
};
