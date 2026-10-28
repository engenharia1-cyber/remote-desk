// Remote viewer. Shows the other computer's screen and, when that side allows it, sends a
// pointer the other person sees on their preview. It never controls the other machine.
(() => {
  const $ = id => document.getElementById(id);
  const ACCESS_LABEL = { view: 'Somente ver', point: 'Ver + apontar' };
  const ERRORS = {
    offline: 'ID não encontrado ou computador offline.',
    busy: 'Esse computador já está em uma sessão.',
    badcode: 'Código de confirmação incorreto.',
    slow: 'Muitas tentativas agora. Aguarde alguns segundos e tente de novo.',
    rejected: 'A outra pessoa recusou o pedido.',
  };
  const CONNECT_TIMEOUT_MS = 20_000;
  const IDLE_TITLE = document.title;
  if (RD.framed) return;

  const form = $('connect-form');
  const peerId = $('peer-id');
  const peerCode = $('peer-code');
  const myName = $('my-name');
  const cancelBtn = $('cancel-btn');
  const stage = $('stage');
  const remote = $('remote');
  const pointToggle = $('point-toggle');
  const openMaximized = $('open-maximized');

  // One attempt owns its broker peer from "Conectar" until the session ends; finish() destroys it.
  let attempt = null; // { id, peer, conn, channel, call, accepted, access }
  let pointing = true;

  const panel = RD.createPanel(() => (attempt?.accepted ? attempt.channel : null));

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

  peerId.addEventListener('input', () => {
    peerId.value = RD.formatId(peerId.value.replace(/\D/g, '').slice(0, 9));
  });
  peerCode.addEventListener('input', () => {
    peerCode.value = peerCode.value.replace(/\D/g, '').slice(0, 6);
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (attempt) return;
    const id = peerId.value.replace(/\D/g, '');
    const code = peerCode.value;
    const name = myName.value.trim();
    if (id.length !== 9) return lobbyStatus('O ID tem 9 dígitos.', true);
    if (code.length !== 6) return lobbyStatus('O código de confirmação tem 6 dígitos.', true);
    if (typeof Peer !== 'function') return lobbyStatus('Não foi possível carregar o app. Recarregue a página.', true);
    try {
      localStorage.setItem('rd.name', name);
    } catch {}
    setBusy(true);
    lobbyStatus('Conectando…');
    connect(id, code, name);
  });

  cancelBtn.addEventListener('click', () => finish('Pedido cancelado.'));

  function connect(id, code, name) {
    const a = { id, peer: new Peer({ debug: 0 }), conn: null, channel: null, call: null, accepted: false, access: 'view' };
    attempt = a;
    const hostPeer = RD.peerIdFor(id);

    a.peer.on('open', () => {
      if (attempt !== a) return;
      // No metadata: the code and name go only over the encrypted channel once it opens.
      a.conn = a.peer.connect(hostPeer, { serialization: 'raw', reliable: true });
      a.conn.on('open', () => {
        if (attempt !== a) return;
        a.channel = RD.createChannel(a.conn.dataChannel, {
          onClose: () => attempt === a && finish(a.accepted ? 'A outra pessoa encerrou a sessão.' : 'A conexão foi encerrada.', !a.accepted),
          onMessage: msg => attempt === a && onPeerMessage(a, msg),
          onTransfer: ev => {
            if (!a.accepted) return;
            panel.transfer(ev);
            if (ev.dir === 'in' && ev.status === 'done') markUnread();
          },
        });
        a.channel.send({ t: 'auth', code, name });
        lobbyStatus('Aguardando a outra pessoa aceitar…');
      });
    });

    // The screen arrives as a media call from the computer we asked; anything else is refused.
    a.peer.on('call', call => {
      if (attempt !== a || call.peer !== hostPeer || a.call) return call.close();
      a.call = call;
      call.answer();
      call.on('stream', stream => {
        remote.srcObject = stream;
      });
      call.on('close', () => attempt === a && finish('A outra pessoa encerrou a sessão.'));
      call.peerConnection?.addEventListener('connectionstatechange', () => {
        if (attempt !== a) return;
        const state = call.peerConnection.connectionState;
        if (state === 'connected') $('session-title').textContent = `Conectado a ${RD.formatId(a.id)}`;
        else if (state === 'disconnected') $('session-title').textContent = 'Conexão instável…';
        else if (state === 'failed') finish('A conexão falhou. Verifique a internet dos dois lados.', true);
      });
    });

    a.peer.on('error', err => {
      if (attempt !== a) return;
      if (err.type === 'peer-unavailable') finish(ERRORS.offline, true);
      else if (!a.accepted) finish('Sem conexão com o serviço de conexão. Tente de novo.', true);
    });

    setTimeout(() => {
      if (attempt === a && !a.channel) finish('O outro computador não respondeu.', true);
    }, CONNECT_TIMEOUT_MS);
  }

  function onPeerMessage(a, msg) {
    switch (msg.t) {
      case 'denied':
        finish(ERRORS[msg.reason] ?? 'Não foi possível conectar.', true);
        break;
      case 'accepted':
        if (!a.accepted) showSession(a);
        break;
      case 'access':
        if (ACCESS_LABEL[msg.level]) setAccess(msg.level);
        break;
      case 'chat':
        if (a.accepted && typeof msg.text === 'string') {
          panel.chat('Outro computador', msg.text);
          markUnread();
        }
        break;
    }
  }

  // ---------- session ----------
  function showSession(a) {
    a.accepted = true;
    $('lobby').hidden = true;
    $('session').hidden = false;
    $('session-title').textContent = 'Conectando…';
    $('stage-msg').hidden = false;
    $('resolution').textContent = '';
    setAccess(a.access);
    panel.setEnabled(true);
    setMaximized(openMaximized.checked);
    document.title = `● ${RD.formatId(a.id)} · RemoteDesk`;
  }

  function finish(reason, isError = false) {
    const a = attempt;
    if (!a) return;
    attempt = null;
    a.peer.destroy();
    remote.srcObject = null;
    panel.setEnabled(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setMaximized(false);
    $('session').hidden = true;
    $('lobby').hidden = false;
    document.title = IDLE_TITLE;
    setBusy(false);
    peerCode.value = '';
    lobbyStatus(reason, isError);
    peerCode.focus();
  }

  function setAccess(level) {
    attempt.access = level;
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
    return Boolean(attempt?.accepted && attempt.access === 'point' && pointing);
  }

  function updatePointing() {
    const on = canPoint();
    stage.classList.toggle('pointing', on);
    pointToggle.setAttribute('aria-pressed', String(pointing && attempt?.access === 'point'));
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
    attempt?.channel?.send({ t: 'ptr', x: null, y: null });
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
      attempt?.channel?.send({ t: 'ptr', ...pendingPtr });
    });
  });
  stage.addEventListener('pointerleave', hidePointer);
  stage.addEventListener('click', e => {
    const p = canPoint() && normalize(e);
    if (p) attempt.channel.send({ t: 'ping', ...p });
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
  $('panel-toggle').addEventListener('click', () => setPanelVisible($('panel').hidden));
  $('maximize').addEventListener('click', () => setMaximized(!document.body.classList.contains('maximized')));

  // Maximized hides the page header and the side panel so the remote screen fills the window.
  // True fullscreen (whole monitor) stays on its own button: browsers only allow it from a click.
  function setMaximized(on) {
    document.body.classList.toggle('maximized', on);
    setPanelVisible(!on);
    $('maximize').textContent = on ? 'Restaurar' : 'Maximizar';
    $('maximize').setAttribute('aria-pressed', String(on));
  }

  function setPanelVisible(visible) {
    $('panel').hidden = !visible;
    $('panel-toggle').setAttribute('aria-pressed', String(visible));
    if (visible) $('panel-toggle').classList.remove('has-unread');
  }

  function markUnread() {
    if ($('panel').hidden) $('panel-toggle').classList.add('has-unread');
  }
  $('hangup').addEventListener('click', () => finish('Você encerrou a sessão.'));

  // ---------- start ----------
  try {
    myName.value = localStorage.getItem('rd.name') ?? '';
  } catch {}
  openMaximized.checked = RD.getMaximizedPref();
  openMaximized.addEventListener('change', () => RD.setMaximizedPref(openMaximized.checked));

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
