// Main screen. It registers this computer as soon as it opens (ID + confirmation code) and owns
// consent for it: approves every request, picks what to capture, and is the authority on the
// access level. Connecting to another computer opens view.html in a new tab so this ID stays up.
(() => {
  const $ = id => document.getElementById(id);
  const ACCESS_LABEL = { view: 'Somente ver', point: 'Ver + apontar' };
  const ACCESS_HINT = {
    view: 'A outra pessoa só vê a tela.',
    point: 'A outra pessoa vê a tela e pode apontar para mostrar onde clicar.',
  };
  const IDLE_TITLE = document.title;

  const conn = $('conn');
  const dialog = $('request');
  const accessSelect = $('access');
  const preview = $('preview');
  const previewWrap = $('preview-wrap');
  const pointer = $('pointer');

  let config = null;
  let signaling = null;
  let hostId = null;
  let request = null; // { from, name, cancelled } while the owner decides or picks a screen
  let session = null; // { name, stream, peer, channel }
  let access = readAccess();
  let toastTimer = 0;

  const panel = RD.createPanel(() => session?.channel ?? null);

  function readAccess() {
    try {
      const saved = localStorage.getItem('rd.access');
      return ACCESS_LABEL[saved] ? saved : 'point';
    } catch {
      return 'point';
    }
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  function setConn(state, text) {
    conn.dataset.state = state;
    conn.textContent = text;
  }

  function setIdentity(id) {
    hostId = id;
    $('host-id').textContent = id ? RD.formatId(id) : '··· ··· ···';
    if (!id) $('host-code').textContent = '······';
    for (const btn of ['copy-id', 'copy-link', 'new-code']) $(btn).disabled = !id;
  }

  function renderAccess() {
    accessSelect.value = access;
    $('access-hint').textContent = ACCESS_HINT[access];
  }

  // ---------- signaling ----------
  function connect() {
    setConn('connecting', 'Conectando…');
    signaling = RD.openSignaling(onSignal, () => {
      signaling = null;
      setConn('offline', 'Sem conexão. Tentando de novo…');
      setIdentity(null);
      dismissRequest();
      setTimeout(connect, 3000);
    });
    signaling.ready.then(() => signaling?.send({ type: 'register' }), () => {});
  }

  async function onSignal(msg) {
    switch (msg.type) {
      case 'registered':
        setConn('online', 'Online');
        setIdentity(msg.id);
        break;
      case 'code':
        $('host-code').textContent = msg.code;
        $('code-warning').hidden = msg.reason !== 'failures';
        $('code-warning').textContent = 'Várias tentativas com código errado. Um código novo foi gerado e novas tentativas ficam bloqueadas por 30 segundos.';
        break;
      case 'request':
        if (session || request) signaling.send({ type: 'reject', to: msg.from });
        else showRequest(msg);
        break;
      case 'cancelled':
        if (request?.from === msg.from) {
          dismissRequest();
          toast('O pedido de acesso foi cancelado.');
        }
        break;
      case 'signal':
        if (session) await session.peer.handleSignal(msg.data);
        break;
      case 'hangup':
        endSession('A outra pessoa saiu da sessão.', false);
        break;
    }
  }

  // ---------- consent ----------
  function showRequest(msg) {
    request = { from: msg.from, name: msg.name, cancelled: false };
    $('req-name').textContent = msg.name;
    $('req-access').textContent = ACCESS_LABEL[access];
    dialog.showModal();
    document.title = 'Pedido de acesso · RemoteDesk';
  }

  function dismissRequest() {
    if (!request) return;
    request.cancelled = true;
    request = null;
    if (dialog.open) dialog.close();
    if (!session) document.title = IDLE_TITLE;
  }

  function rejectRequest() {
    const req = request;
    if (!req) return;
    dismissRequest();
    signaling?.send({ type: 'reject', to: req.from });
  }

  async function acceptRequest() {
    const req = request;
    if (!req) return;
    dialog.close();
    let stream;
    try {
      // Called directly from the click so the browser accepts it as a user gesture.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
    } catch {
      if (!req.cancelled) {
        dismissRequest();
        signaling?.send({ type: 'reject', to: req.from });
        toast('Nenhuma tela foi escolhida, então o pedido foi recusado.');
      }
      return;
    }
    if (req.cancelled || request !== req) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    request = null;
    signaling.send({ type: 'accept', to: req.from });
    startSession(req.name, stream);
  }

  // ---------- session ----------
  function startSession(name, stream) {
    const [track] = stream.getVideoTracks();
    if ('contentHint' in track) track.contentHint = 'detail';

    const s = { name, stream, peer: null, channel: null };
    s.peer = RD.createPeer(config.iceServers, signaling, state => {
      if (session !== s) return;
      if (state === 'connected') setLive(`Compartilhando com ${name}`);
      else if (state === 'disconnected') setLive(`Conexão instável com ${name}…`);
      else if (state === 'failed') endSession('A conexão com a outra pessoa falhou.');
    });
    s.peer.pc.addTrack(track, stream);
    s.channel = RD.createChannel(s.peer.pc.createDataChannel('remotedesk'), {
      onOpen: () => {
        if (session !== s) return;
        s.channel.send({ t: 'access', level: access });
        panel.setEnabled(true);
      },
      onClose: () => session === s && endSession('A sessão foi encerrada.', false),
      onMessage: msg => session === s && onPeerMessage(msg),
      onTransfer: ev => panel.transfer(ev),
    });
    track.onended = () => endSession('Você parou de compartilhar a tela.');
    session = s;

    preview.srcObject = stream;
    $('idle').hidden = true;
    $('live').hidden = false;
    $('pointer-label').textContent = name;
    setLive(`Conectando com ${name}…`);
    document.title = '● Compartilhando · RemoteDesk';
    s.peer.offer().catch(() => endSession('Não foi possível iniciar a conexão.'));
  }

  function setLive(text) {
    $('live-text').textContent = text;
  }

  function endSession(reason, notify = true) {
    const s = session;
    if (!s) return;
    session = null;
    if (notify) signaling?.send({ type: 'hangup' });
    for (const track of s.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    s.peer.pc.close();
    preview.srcObject = null;
    pointer.hidden = true;
    $('live').hidden = true;
    $('idle').hidden = false;
    panel.setEnabled(false);
    document.title = IDLE_TITLE;
    if (reason) toast(reason);
  }

  function onPeerMessage(msg) {
    switch (msg.t) {
      case 'chat':
        if (typeof msg.text === 'string') panel.chat(session.name, msg.text);
        break;
      case 'ptr':
        if (access === 'point') movePointer(msg.x, msg.y);
        break;
      case 'ping':
        if (access === 'point') showPing(msg.x, msg.y);
        break;
    }
  }

  // ---------- remote pointer on the local preview ----------
  function toPreview(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    const rect = RD.videoContentRect(preview);
    if (!rect) return null;
    const box = previewWrap.getBoundingClientRect();
    return { left: rect.left - box.left + x * rect.width, top: rect.top - box.top + y * rect.height };
  }

  function movePointer(x, y) {
    const p = toPreview(x, y);
    pointer.hidden = !p;
    if (!p) return;
    pointer.style.left = `${p.left}px`;
    pointer.style.top = `${p.top}px`;
  }

  function showPing(x, y) {
    const p = toPreview(x, y);
    if (!p) return;
    const ring = document.createElement('div');
    ring.className = 'ping';
    ring.style.left = `${p.left}px`;
    ring.style.top = `${p.top}px`;
    ring.addEventListener('animationend', () => ring.remove());
    previewWrap.append(ring);
  }

  // ---------- controls ----------
  accessSelect.addEventListener('change', () => {
    if (!ACCESS_LABEL[accessSelect.value]) return;
    access = accessSelect.value;
    try {
      localStorage.setItem('rd.access', access);
    } catch {}
    renderAccess();
    if (access !== 'point') pointer.hidden = true;
    if (session) {
      session.channel.send({ t: 'access', level: access });
      toast(`Nível de acesso: ${ACCESS_LABEL[access]}`);
    }
  });

  $('req-accept').addEventListener('click', acceptRequest);
  $('req-reject').addEventListener('click', rejectRequest);
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    rejectRequest();
  });
  $('stop').addEventListener('click', () => endSession('Sessão encerrada.'));
  $('new-code').addEventListener('click', () => signaling?.send({ type: 'newcode' }));
  $('copy-id').addEventListener('click', () => copy(hostId, 'ID copiado.'));
  $('copy-link').addEventListener('click', () => copy(`${location.origin}/view.html?id=${hostId}`, 'Link copiado. O código você passa separado.'));

  const remoteId = $('remote-id');
  const remoteCode = $('remote-code');
  remoteId.addEventListener('input', () => {
    remoteId.value = RD.formatId(remoteId.value.replace(/\D/g, '').slice(0, 9));
  });
  remoteCode.addEventListener('input', () => {
    remoteCode.value = remoteCode.value.replace(/\D/g, '').slice(0, 6);
  });
  $('remote-form').addEventListener('submit', e => {
    e.preventDefault();
    const id = remoteId.value.replace(/\D/g, '');
    const code = remoteCode.value;
    const error = $('remote-error');
    if (id.length !== 9) error.textContent = 'O ID tem 9 dígitos.';
    else if (id === hostId) error.textContent = 'Esse é o ID deste computador.';
    else if (code.length !== 6) error.textContent = 'O código tem 6 dígitos.';
    else {
      // The fragment never reaches the server; view.js reads it and clears it from the address bar.
      error.textContent = '';
      window.open(`/view.html#id=${id}&code=${code}`, '_blank');
      remoteCode.value = '';
    }
  });

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast('Não foi possível copiar.');
    }
  }

  // ---------- start ----------
  renderAccess();
  (async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setConn('offline', 'Indisponível');
      $('idle').querySelector('p').textContent = window.isSecureContext
        ? 'Este navegador não permite compartilhar a tela. Use Chrome, Edge ou Firefox no computador.'
        : 'Para compartilhar a tela, abra este site por HTTPS (ou pelo próprio computador em localhost).';
      return;
    }
    try {
      config = await RD.loadConfig();
    } catch {
      setConn('offline', 'Servidor indisponível');
      return;
    }
    connect();
  })();
})();
