(async function(){
  const params = new URLSearchParams(location.search);
  const tokenFromUrl = params.get('token');
  const roomFromUrl = params.get('room');

  const startBtn = document.getElementById('start');
  const openBtn = document.getElementById('openUrl');
  const genQrBtn = document.getElementById('genQr');
  const joinUrlInput = document.getElementById('joinUrl');
  const roomSelect = document.getElementById('room');
  const status = document.getElementById('status');
  const localDiv = document.getElementById('local');
  const peerList = document.getElementById('peerList');

  let localStream = null;
  let socket = null;
  const pcs = new Map(); // peerId -> RTCPeerConnection

  function log(s){ console.log(s); status.textContent = s; }

  genQrBtn.onclick = async () => {
    const room = roomSelect.value;
    const res = await fetch(`/qr?room=${encodeURIComponent(room)}`);
    if (!res.ok) {
      alert('QR error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  openBtn.onclick = () => {
    const url = joinUrlInput.value.trim();
    if (!url) return alert('paste a URL');
    window.open(url, '_blank');
  };

  startBtn.onclick = async () => {
    const paramsLocal = new URLSearchParams(location.search);
    const token = paramsLocal.get('token');
    const room = paramsLocal.get('room');
    if (!token || !room) {
      alert('Open the page with ?room=room1&token=... (scan QR or paste URL)');
      return;
    }
    await start(token, room);
  };

  async function start(token, room) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localDiv.textContent = 'Local audio active';
    } catch (err) {
      alert('Microphone access required');
      return;
    }
    socket = io({ query: { token, room } });
    socket.on('connect_error', (e) => { log('connect_error'); });
    socket.on('error', (msg) => { alert('Server error: '+msg); });
    socket.on('kicked', ({ by }) => { alert('You were kicked'); socket.disconnect(); cleanupAll(); });
    socket.on('peers', (peers) => {
      log('connected, peers: ' + peers.length);
      peers.forEach(p => createOffer(p.id));
    });
    socket.on('peer-joined', ({ id, admin }) => {
      addPeerToList(id, admin);
      // if new peer arrives, create offer to them
      createOffer(id);
    });
    socket.on('peer-left', ({ id }) => {
      removePeer(id);
    });
    socket.on('signal', async ({ from, data }) => {
      if (!pcs.has(from)) await preparePeer(from, false);
      const pc = pcs.get(from);
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn(e); }
      }
    });
  }

  function addPeerToList(id, admin) {
    const li = document.createElement('li');
    li.id = 'peer-'+id;
    li.textContent = id + (admin ? ' (admin)' : '');
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Kick';
    kickBtn.onclick = () => {
      if (confirm('Kick '+id+'?')) socket.emit('kick', { targetId: id });
    };
    li.appendChild(kickBtn);
    peerList.appendChild(li);
  }

  function removePeer(id) {
    const el = document.getElementById('peer-'+id);
    if (el) el.remove();
    const pc = pcs.get(id);
    if (pc) { pc.close(); pcs.delete(id); }
  }

  function cleanupAll() {
    for (const [id, pc] of pcs) { pc.close(); }
    pcs.clear();
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    localDiv.textContent = 'stopped';
    peerList.innerHTML = '';
  }

  async function preparePeer(peerId, makeOffer = true) {
    if (pcs.has(peerId)) return pcs.get(peerId);
    const pc = new RTCPeerConnection();
    // add local audio
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('signal', { to: peerId, data: { candidate: ev.candidate } });
    };
    pc.ontrack = (ev) => {
      let aud = document.getElementById('audio-'+peerId);
      if (!aud) {
        aud = document.createElement('audio');
        aud.id = 'audio-'+peerId;
        aud.autoplay = true;
        aud.controls = false;
        const li = document.getElementById('peer-'+peerId);
        if (li) li.appendChild(aud);
      }
      aud.srcObject = ev.streams[0];
    };
    pcs.set(peerId, pc);
    return pc;
  }

  async function createOffer(peerId) {
    await preparePeer(peerId);
    const pc = pcs.get(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
    addPeerToList(peerId, false);
  }

  // If opened with token+room auto-start
  if (tokenFromUrl && roomFromUrl) {
    // small delay so UI loads
    setTimeout(() => start(tokenFromUrl, roomFromUrl), 200);
  }
})();
