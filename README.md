# G-VIS WhatsApp Microservice (Baileys + Render)

Microserviço WhatsApp autônomo baseado no **Baileys**, projetado para rodar no **Render** (plano Free) em **Modo Oculto** (presença `unavailable`), despachando relatórios automáticos de testes de performance do G-VIS para o grupo **Teste do G-VIS** ou número direto.

---

## 🚀 Como Subir para o GitHub e Deploy no Render

### 1. Criar Repositório no GitHub
1. Acesse [github.com/new](https://github.com/new).
2. Nomeie o repositório (ex: `gvis-whatsapp-service`).
3. Deixe público ou privado.
4. No terminal dentro desta pasta (`c:\IA Leve\gvis-whatsapp-service`), execute:
   ```bash
   git init
   git add .
   git commit -m "feat: microserviço Baileys WhatsApp para G-VIS"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/gvis-whatsapp-service.git
   git push -u origin main
   ```

### 2. Criar Web Service no Render
1. Acesse o [dashboard.render.com](https://dashboard.render.com).
2. Clique em **New +** > **Web Service**.
3. Selecione o repositório `gvis-whatsapp-service` do GitHub.
4. Configurações:
   - **Name**: `gvis-whatsapp` (ou outro nome desejado)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Clique em **Create Web Service**.

### 3. Conectar o WhatsApp (Número 81971015818)
1. Assim que o deploy finalizar, acesse a URL gerada pelo Render (ex: `https://gvis-whatsapp.onrender.com/qr`).
2. Abra o WhatsApp no celular do número **81971015818**.
3. Vá em **Aparelhos Conectados** > **Conectar um aparelho**.
4. Aponte a câmera para o QR Code na tela.
5. Pronto! O bot se conectará em **Modo Oculto** (`unavailable`) automaticamente.

---

## 📡 Endpoints da API

- **`GET /qr`** ou **`GET /`**: Exibe interface gráfica para escanear o QR Code de autenticação.
- **`GET /status`**: Retorna se o WhatsApp está conectado, uptime e se localizou o grupo `Teste do G-VIS`.
- **`GET /groups`**: Lista todos os grupos conectados e seus respectivos JIDs (`...@g.us`).
- **`GET /set-offline`**: Força o status de presença para offline/oculto (`unavailable`).
- **`GET /ping`**: Endpoint ultraleve de keep-alive para evitar o sleep de 15 minutos do Render Free.
- **`POST /send-message`**: Envia mensagem exclusivamente para o grupo **Teste do G-VIS**.
  - Body JSON:
    ```json
    {
      "message": "Mensagem a ser enviada para o grupo..."
    }
    ```
