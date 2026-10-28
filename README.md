# RemoteDesk

Acesso remoto 100% no navegador: tela ao vivo, ponteiro remoto, chat e troca de arquivos. Nada é instalado em nenhum dos computadores.

**Abrir o app:** https://engenharia1-cyber.github.io/remote-desk/

## Como funciona

- Ao abrir o app, o computador já recebe um **ID de 9 dígitos** e um **código de confirmação de 6 dígitos**. O ID nunca se repete: um novo é gerado toda vez que o app abre e ao fim de cada sessão.
- Quem vai acessar digita o ID e o código em **Acessar outro computador**. A sessão abre numa nova aba.
- O computador acessado vê o pedido com o nome de quem pediu, aceita ou recusa, e escolhe qual tela, janela ou aba vai mostrar.
- O código só vale **uma vez**: muda depois de cada pedido aceito ou quando você clica em ↻.
- **Nível de acesso** (menu, pode mudar durante a sessão):
  - **Somente ver**: a outra pessoa só vê a tela.
  - **Ver + apontar**: a outra pessoa também move um ponteiro e marca cliques, que aparecem na prévia de quem compartilha.
- Vídeo, chat e arquivos trafegam **direto entre os navegadores** (WebRTC). Para um navegador encontrar o outro, o app usa o serviço público e gratuito do [PeerJS](https://peerjs.com/). Esse serviço é de terceiros e não tem garantia de disponibilidade.

> Mouse e teclado do computador acessado continuam sempre com a pessoa que está nele. Navegadores não deixam um site controlar o sistema operacional.

## Segurança

- O código e o nome de quem acessa vão só pelo canal criptografado entre os navegadores. O serviço de conexão (PeerJS) nunca vê o código.
- As tentativas de código têm limite de ritmo (5 seguidas, depois 1 a cada 2 s). Erros vindos de fora não trocam nem bloqueiam o seu código. Se houver muitos erros no último minuto, o app avisa e sugere gerar um código novo.
- Mesmo com o código certo, nada é mostrado sem o seu clique em **Aceitar** e a escolha da tela.
- Conexões que não se identificam em 10 s são fechadas.
- O app não funciona dentro de outro site (iframe), o que impede montagens para enganar o clique.
- A página usa uma política de segurança de conteúdo (CSP) restrita e o PeerJS é carregado com verificação de integridade (SRI).
- Arquivos recebidos sempre são baixados, nunca abertos dentro do site. Só abra o que vier de alguém em quem você confia.

Limites conhecidos, próprios de usar um serviço de conexão público:

- Os IDs são de quem chegar primeiro. Como o ID muda a cada abertura e a cada sessão, um ID antigo não leva mais ao seu computador. Se alguém ocupar um ID que você já descartou, quem tentar usar esse ID antigo cai nessa pessoa. Por isso, ao acessar, confira se a tela é mesmo a esperada.
- Quem souber um ID consegue descobrir se ele está online enquanto ele estiver em uso.
- A disponibilidade depende do serviço público do PeerJS.

## Rodando localmente

O app é estático. Sirva a pasta `public/` com qualquer servidor HTTP:

```bash
npx serve public
```

A captura de tela só funciona em **HTTPS** ou em `localhost`.

## Publicação

Cada push na `main` publica `public/` no GitHub Pages pelo workflow `.github/workflows/pages.yml`.

## Estrutura

```
public/index.html    tela principal: seu ID/código, nível de acesso, conectar a outro
public/view.html     sessão remota (quem acessa)
public/js/common.js  protocolo do canal de dados, IDs no broker, painel de chat/arquivos
public/js/app.js     lado que compartilha: código, consentimento, captura, ponteiro remoto
public/js/view.js    lado que acessa: vídeo, ponteiro, tela cheia
```

Limite por arquivo: 512 MB (o arquivo recebido fica em memória até ser baixado).
