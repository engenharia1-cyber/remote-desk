# RemoteDesk

Acesso remoto 100% no navegador: tela ao vivo, ponteiro remoto, chat e troca de arquivos. Nada é instalado no computador acessado.

## Como funciona

- Ao abrir o app, o computador já recebe um **ID de 9 dígitos** e um **código de confirmação de 6 dígitos**.
- Quem vai acessar digita o ID e o código em **Acessar outro computador**. A sessão abre numa nova aba.
- O computador acessado vê o pedido com o nome de quem pediu, aceita ou recusa, e escolhe qual tela, janela ou aba vai mostrar.
- O código só vale **uma vez**. Ele muda depois de cada pedido e também após 5 tentativas erradas, quando novas tentativas ficam bloqueadas por 30 s.
- **Nível de acesso** (menu, pode mudar durante a sessão):
  - **Somente ver**: a outra pessoa só vê a tela.
  - **Ver + apontar**: a outra pessoa também move um ponteiro e marca cliques, que aparecem na prévia de quem compartilha.
- Vídeo, chat e arquivos trafegam **direto entre os navegadores** (WebRTC). O servidor só apresenta um lado ao outro.

> Mouse e teclado do computador acessado continuam sempre com a pessoa que está nele. Navegadores não deixam um site controlar o sistema operacional.

## Rodando

```bash
cd server
npm install
npm start          # http://localhost:8080
```

Abra `http://localhost:8080` em duas abas (ou dois computadores) para testar.

## Usando entre computadores diferentes

O navegador só libera captura de tela em **HTTPS** (ou em `localhost`). Para usar na rede ou na internet:

```bash
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=443 npm start
```

Também funciona atrás de um proxy HTTPS (Caddy, Nginx, Cloudflare Tunnel) apontando para a porta do servidor.

Se os dois lados estiverem em redes muito restritas (NAT simétrico, firewall corporativo), configure um servidor TURN:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.exemplo.com:3478","username":"u","credential":"s"}]' npm start
```

## Estrutura

```
server/server.js     sinalização WebSocket + arquivos estáticos + /config
public/index.html    tela principal: seu ID/código, nível de acesso, conectar a outro
public/view.html     sessão remota (quem acessa)
public/js/common.js  sinalização, WebRTC, protocolo do canal de dados, painel de chat/arquivos
public/js/app.js     lado que compartilha: consentimento, captura, ponteiro remoto
public/js/view.js    lado que acessa: vídeo, ponteiro, tela cheia
```

Limite por arquivo: 512 MB (o arquivo recebido fica em memória até ser baixado).
