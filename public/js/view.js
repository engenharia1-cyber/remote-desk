// Remote viewer. Shows the other computer's screen and, when that side allows it, sends a
// pointer the other person sees on their preview. It never controls the other machine.
(() => {
  const $ = id => document.getElementById(id);
  const ACCESS_LABEL = { view: 'Somente ver', point: 'Ver + apontar' };
  const ERRORS = {
    offline: 'ID não encontrado ou computador offline.',
    busy: 'Esse computador já está em uma sessão.',
    badcode: 'Código de confirmação incorreto.',
    locked: 'Muitas tentativas erradas. Peça o código novo e tente em 30 segundos.',
  };

  const form = $('connect-form');
  const peerId = $('peer-id');
  const peerCode = $('peer-code');
  const myName = $('my-name');
  const cancelBtn = $('cancel-btn');
  const stage = $('stage');
  const remote = $('remote');
  const pointToggle = $('point-toggle');

  let config = null;
  let signaling = null;
  let pendingId = null;
  let session = null; // { id, peer, channel, access }
  let pointing = true;

  const panel = RD.createPanel(() => session?.channel ?? null);

  // ---------- lobby ----------
  function lobbyStatus(text, isError = false) {
    const el = $('lobby-status');
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function setBusy(busy) {
    for (const el of [peerId, peerCode, myName, $('connect-btn')]) el.disabled = busy;
    cancelBtn.hidden = !busy;
  }

  function closeSignaling() {
    signaling?.close();
    signaling = null;
  }

  function failLobby(text, isError = true) {
    closeSignaling();
    setBusy(false);
    peerCode.value = '';
    lobbyStatus(text, isError);
    peerCode.focus();
  }

  peerId.addEventListener('input', () => {
    peerId.value = RD.formatId(peerId.value.replace(/\D/g, '').slice(0, 9));
  });
  peerCode.addEventListener('input', () => {
    peerCode.value = peerCode.value.replace(/\D/g, '').slice(0, 6);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (signaling || session) return;
    const id = peerId.value.replace(/\D/g, '');
    const code = peerCode.value;
    const name = myName.value.trim();
    if (id.length !== 9) return lobbyStatus('O ID tem 9 dígitos.', true);
    if (code.length !== 6) return lobbyStatus('O código de confirmação tem 6 dígitos.', true);
    try {
      localStorage.setItem('rd.name', name);
    } catch {}

    setBusy(true);
    lobbyStatus('Conectando ao servidor…');
    try {
      config ??= await RD.loadConfig();
    } catch {
      return failLobby('Servidor indisponível.');
    }
    pendingId = id;
    signaling = RD.openSignaling(onSignal, () => {
      signaling = null;
      // Once the session is up, media flows peer-to-peer and survives losing the server.
      if (!session) failLobby('Sem conexão com o servidor.');
    });
    try {
      await signaling.ready;
    } catch {
      return;
    }
    signaling.send({ type: 'connect', id, code, name });
    lobbyStatus('Aguardando a outra pessoa aceitar…');
  });

  cancelBtn.addEventListener('click', () => failLobby('Pedido cancelado.', false));

  async function onSignal(msg) {
    switch (msg.type) {
      case 'error':
        failLobby(ERRORS[msg.reason] ?? 'Não foi possível conectar.');
        break;
      case 'rejected':
        failLobby('A outra pessoa recusou o pedido.');
        break;
      case 'accepted':
        startSession();
        break;
      case 'signal':
        if (session) await session.peer.handleSignal(msg.data);
        break;
      case 'hangup':
        endSession('A outra pessoa encerrou a sessão.', false);
        break;
    }
  }

  // ---------- session ----------
  function startSession() {
    const s = { id: pendingId, peer: null, channel: null, access: 'view' };
    s.peer = RD.createPeer(config.iceServers, signaling, state => {
      if (session !== s) return;
      if (state === 'connected') $('session-title').textContent = `Conectado a ${RD.formatId(s.id)}`;
      else if (state === 'disconnected') $('session-title').textContent = 'Conexão instável…';
      else if (state === 'failed') endSession('A conexão falhou. Em redes muito restritas pode ser preciso um servidor TURN.');
    });
    s.peer.pc.ontrack = e => {
      remote.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    s.peer.pc.ondatachannel = e => {
      if (session !== s) return;
      s.channel = RD.createChannel(e.channel, {
        onOpen: () => session === s && panel.setEnabled(true),
        onClose: () => session === s && endSession('A sessão foi encerrada.', false),
        onMessage: msg => session === s && onPeerMessage(msg),
        onTransfer: ev => panel.transfer(ev),
      });
    };
    session = s;

    $('lobby').hidden = true;
    $('session').hidden = false;
    $('session-title').textContent = 'Conectando…';
    $('stage-msg').hidden = false;
    $('resolution').textContent = '';
    setAccess('view');
    document.title = `● ${RD.formatId(s.id)} · RemoteDesk`;
  }

  function endSession(reason, notify = true) {
    const s = session;
    if (!s) return;
    session = null;
    if (notify) signaling?.send({ type: 'hangup' });
    closeSignaling();
    s.peer.pc.close();
    remote.srcObject = null;
    panel.setEnabled(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('session').hidden = true;
    $('lobby').hidden = false;
    document.title = 'Acessar computador · RemoteDesk';
    failLobby(reason, false);
  }

  function onPeerMessage(msg) {
    switch (msg.t) {
      case 'access':
        if (ACCESS_LABEL[msg.level]) setAccess(msg.level);
        break;
      case 'chat':
        if (typeof msg.text === 'string') panel.chat('Outro computador', msg.text);
        break;
    }
  }

  function setAccess(level) {
    session.access = level;
    const badge = $('access-badge');
    badge.textContent = ACCESS_LABEL[level];
    badge.dataset.level = level;
    pointToggle.disabled = level !== 'point';
    pointToggle.title = level === 'point' ? '' : 'A outra pessoa definiu acesso somente para ver';
    updatePointing();
  }

  remote.addEventListener('resize', showResolution);
  remote.addEventListener('loadedmetadata', showResolution);
  function showResolution() {
    if (!remote.videoWidth) return;
    $('stage-msg').hidden = true;
    $('resolution').textContent = `${remote.videoWidth}×${remote.videoHeight}`;
  }

  // ---------- pointer ----------
  let pendingPtr = null;
  let ptrFrame = 0;
  let ptrVisible = false;

  function canPoint() {
    return Boolean(session?.channel && session.access === 'point' && pointing);
  }

  function updatePointing() {
    const on = canPoint();
    stage.classList.toggle('pointing', on);
    pointToggle.setAttribute('aria-pressed', String(pointing && session?.access === 'point'));
    if (!on) hidePointer();
  }

  function normalize(e) {
    const rect = RD.videoContentRect(remote);
    if (!rect) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  function hidePointer() {
    if (!ptrVisible) return;
    ptrVisible = false;
    session?.channel?.send({ t: 'ptr', x: null, y: null });
  }

  stage.addEventListener('pointermove', e => {
    if (!canPoint()) return;
    pendingPtr = normalize(e);
    if (ptrFrame) return;
    // One pointer update per frame is plenty and keeps the channel free for files.
    ptrFrame = requestAnimationFrame(() => {
      ptrFrame = 0;
      if (!pendingPtr) return hidePointer();
      ptrVisible = true;
      session?.channel?.send({ t: 'ptr', ...pendingPtr });
    });
  });
  stage.addEventListener('pointerleave', hidePointer);
  stage.addEventListener('click', e => {
    const p = canPoint() && normalize(e);
    if (p) session.channel.send({ t: 'ping', ...p });
  });

  pointToggle.addEventListener('click', () => {
    pointing = !pointing;
    updatePointing();
  });

  // ---------- toolbar ----------
  $('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    $('fullscreen').textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
  $('panel-toggle').addEventListener('click', () => {
    const panelEl = $('panel');
    panelEl.hidden = !panelEl.hidden;
    $('panel-toggle').setAttribute('aria-pressed', String(!panelEl.hidden));
  });
  $('hangup').addEventListener('click', () => endSession('Você encerrou a sessão.'));

  // ---------- start ----------
  try {
    myName.value = localStorage.getItem('rd.name') ?? '';
  } catch {}

  // The main screen opens this page as view.html#id=...&code=...; a shared link carries only ?id=.
  const fromHash = new URLSearchParams(location.hash.slice(1));
  const fromQuery = new URLSearchParams(location.search);
  const startId = (fromHash.get('id') ?? fromQuery.get('id') ?? '').replace(/\D/g, '').slice(0, 9);
  const startCode = (fromHash.get('code') ?? '').replace(/\D/g, '').slice(0, 6);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  peerId.value = RD.formatId(startId);
  peerCode.value = startCode;
  if (startId.length === 9 && startCode.length === 6) form.requestSubmit();
  else (startId ? peerCode : peerId).focus();
})();
