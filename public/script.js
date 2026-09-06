const socket = io("/");
const videoGrid = document.getElementById("video-grid");
const myVideo = document.createElement("video");
const usersCounter = document.getElementById("users-counter");
const participantsGrid = document.getElementById("participants-grid");
myVideo.muted = true;

// --- GLOBAL VARIABLES (Accessible by Android WebView) ---
var myVideoStream; // MUST be var or let in global scope
var unreadMessageCount = 0;
var sendAudio = new Audio("/assets/send.wav");
var receiveAudio = new Audio("/assets/receive.wav");
sendAudio.preload = "auto";
receiveAudio.preload = "auto";

const params = new URLSearchParams(window.location.search);
const user = params.get("userName") || "Guest";

// UI Setup: chat window flex
const mainRight = document.querySelector(".main__right");
if (mainRight) {
  mainRight.style.display = "flex";
  mainRight.style.flex = "1";
}

// Map tracking connected participants: userId -> { name, isMuted, analyser, element }
const participantsMap = new Map();

// --- AUDIO CONTEXT FOR ACTIVE SPEAKER DETECTION ---
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Global user interaction triggers to unlock AudioContext on Mobile/WebView
["touchstart", "touchend", "click", "keydown", "mousedown"].forEach(evt => {
  document.addEventListener(evt, () => {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }, { passive: true });
});

// --- GLOBAL FUNCTIONS (Called by Android App) ---
function toggleAudio(b) {
  if (!myVideoStream) return;
  const audioTrack = myVideoStream.getAudioTracks()[0];
  if (audioTrack) {
    const enabled = (b === "true" || b === true);
    audioTrack.enabled = enabled;
    console.log(`Audio ${enabled ? 'Enabled' : 'Disabled (Muted)'}`);
    
    // Notify server of mute status change
    if (typeof socket !== "undefined" && socket.connected) {
      socket.emit("user-toggle-audio", !enabled);
    }
    
    // Update local card UI
    if (window.myPeerId) {
      updateParticipantMuteUI(window.myPeerId, !enabled);
    }
  }
}

function checkMatch(userMessage) {
  let inputMessage = userMessage.toLowerCase();
  let result = inputMessage.match(/(asshole|fuck|shit|bitch|cunt|wanker|dickhead|bollocks|...)*/g);
  return result != null ? 1 : 0;
}

// --- PARTICIPANT CARD UI HELPERS ---
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function createOrUpdateParticipantCard(userId, displayName, isSelf = false) {
  if (!participantsGrid) return;
  
  let card = document.getElementById(`participant-card-${userId}`);
  if (!card) {
    card = document.createElement("div");
    card.id = `participant-card-${userId}`;
    card.className = "participant-card";

    const initials = getInitials(displayName);
    const selfLabel = isSelf ? " (You)" : "";

    card.innerHTML = `
      <div class="participant-avatar-wrapper">
        <span>${initials}</span>
        <div class="mute-badge" id="mute-badge-${userId}" style="display: none;">🔇</div>
      </div>
      <div class="participant-name" title="${displayName}${selfLabel}">${displayName}${selfLabel}</div>
      <div class="speaking-waves">
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
        <div class="wave-bar"></div>
      </div>
    `;

    participantsGrid.appendChild(card);
  }

  // Update participants map entry
  if (!participantsMap.has(userId)) {
    participantsMap.set(userId, { name: displayName, isMuted: false });
  } else {
    const existing = participantsMap.get(userId);
    existing.name = displayName;
  }
  
  updateParticipantsCounter();
}

function removeParticipantCard(userId) {
  const card = document.getElementById(`participant-card-${userId}`);
  if (card) card.remove();
  
  if (participantsMap.has(userId)) {
    const info = participantsMap.get(userId);
    if (info.analyserInterval) clearInterval(info.analyserInterval);
    participantsMap.delete(userId);
  }

  updateParticipantsCounter();
}

function setParticipantSpeakingUI(userId, isSpeaking, dynamicHeights = null) {
  const card = document.getElementById(`participant-card-${userId}`);
  if (!card) return;
  if (isSpeaking) {
    card.classList.add("speaking");
  } else {
    card.classList.remove("speaking");
  }

  // Dynamically update wave bar heights if frequency data is provided
  if (dynamicHeights && Array.isArray(dynamicHeights)) {
    const waveBars = card.querySelectorAll(".wave-bar");
    waveBars.forEach((bar, idx) => {
      if (dynamicHeights[idx] !== undefined) {
        bar.style.height = `${dynamicHeights[idx]}px`;
      }
    });
  }
}

function updateParticipantMuteUI(userId, isMuted) {
  const badge = document.getElementById(`mute-badge-${userId}`);
  if (badge) {
    badge.style.display = isMuted ? "flex" : "none";
  }
  if (participantsMap.has(userId)) {
    participantsMap.get(userId).isMuted = isMuted;
  }
  if (isMuted) {
    setParticipantSpeakingUI(userId, false);
  }
}

function updateParticipantsCounter() {
  if (usersCounter) {
    usersCounter.innerText = participantsMap.size;
  }
}

// --- SETUP AUDIO VOLUME ANALYZER (RMS) ---
function attachStreamAnalyzer(userId, stream) {
  try {
    const ctx = getAudioContext();
    if (!ctx || ctx.state === "closed") return;

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) return;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const pData = participantsMap.get(userId) || {};
    if (pData.analyserInterval) clearInterval(pData.analyserInterval);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const interval = setInterval(() => {
      if (pData.isMuted) {
        setParticipantSpeakingUI(userId, false);
        return;
      }

      try {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        let maxVal = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
          if (dataArray[i] > maxVal) maxVal = dataArray[i];
        }
        const average = sum / bufferLength;

        // Ultra-sensitive threshold check for speech (average > 2 or peak > 10)
        const isSpeaking = average > 2 || maxVal > 10;

        // Calculate dynamic wave bar heights for 4 equalizer bars
        const heights = [
          Math.max(4, Math.min(16, (dataArray[0] || 0) / 10)),
          Math.max(4, Math.min(16, (dataArray[2] || 0) / 8)),
          Math.max(4, Math.min(16, (dataArray[4] || 0) / 8)),
          Math.max(4, Math.min(16, (dataArray[6] || 0) / 10))
        ];

        setParticipantSpeakingUI(userId, isSpeaking, isSpeaking ? heights : null);
      } catch (e) {
        // Handle stream end
      }
    }, 100);

    pData.analyserInterval = interval;
    participantsMap.set(userId, pData);
  } catch (e) {
    console.warn(`Audio analyser skipped for user ${userId}:`, e);
  }
}

// --- MAIN LOGIC ---
(async function () {
  console.log("Initializing WebRTC App with Voice Optimization...");

  let iceServers = [];
  try {
    const res = await fetch("/api/turn-credentials");
    const data = await res.json();
    iceServers = data.iceServers;
    console.log(`TURN Loaded: ${iceServers.length} servers`);
  } catch (e) {
    console.warn("TURN Fetch failed, using default STUN");
    iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];
  }

  const isSecure = location.protocol === 'https:';
  const peerPort = location.port ? parseInt(location.port) : (isSecure ? 443 : 80);

  const peer = new Peer(undefined, {
    path: "/peerjs",
    host: "/",
    port: peerPort,
    secure: isSecure,
    config: { 
      iceServers: iceServers,
      iceCandidatePoolSize: 10 
    }
  });

  window.myPeerId = null;

  // --- GLOBAL CALL HANDLER ---
  peer.on("call", (call) => {
    console.log(`Incoming call from: ${call.peer}`);
    
    if (!myVideoStream) {
      console.warn("MediaStream not ready for incoming call. Waiting...");
      const checkStream = setInterval(() => {
        if (myVideoStream) {
          clearInterval(checkStream);
          call.answer(myVideoStream);
          handleCallStream(call);
        }
      }, 100);
      return;
    }

    call.answer(myVideoStream);
    handleCallStream(call);
  });

  function handleCallStream(call) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    
    call.on("stream", (userVideoStream) => {
      console.log("Connected to stream from: " + call.peer);
      addVideoStream(audio, userVideoStream);
      
      const remoteName = participantsMap.get(call.peer)?.name || "Participant";
      createOrUpdateParticipantCard(call.peer, remoteName, false);
      attachStreamAnalyzer(call.peer, userVideoStream);
    });

    call.on("close", () => {
      console.log(`Call closed with ${call.peer}. Cleaning up.`);
      audio.remove();
      removeParticipantCard(call.peer);
    });

    call.on("error", (err) => {
      console.error(`Call Error with ${call.peer}:`, err);
      audio.remove();
      removeParticipantCard(call.peer);
    });
  }

  peer.on("open", (id) => {
    console.log(`Peer OPEN ID: ${id}`);
    window.myPeerId = id;
    createOrUpdateParticipantCard(id, user, true);
    checkReadyToJoin();
  });

  // --- AUDIO ONLY STREAM WITH BROADEST COMPATIBILITY ---
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  function initLocalStream(constraints) {
    return navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
      .catch((err) => {
        console.warn("Standard constraints failed, trying basic audio:true fallback", err);
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      });
  }

  initLocalStream(audioConstraints)
    .then((stream) => {
      myVideoStream = stream;

      // Attach analyzer to local stream for active speaker indicator
      if (window.myPeerId) {
        attachStreamAnalyzer(window.myPeerId, stream);
      }

      // Socket Listeners for participant tracking
      socket.on("existing-users", (existingUsers) => {
        console.log("Existing users in room:", existingUsers);
        Object.keys(existingUsers).forEach((uid) => {
          createOrUpdateParticipantCard(uid, existingUsers[uid], false);
        });
      });

      socket.on("user-connected", (userId, userName) => {
        console.log(`New user detected: ${userId} (${userName})`);
        createOrUpdateParticipantCard(userId, userName || "Participant", false);
        setTimeout(() => connectToNewUser(userId, stream), 500);
      });

      socket.on("user-audio-changed", (userId, isMuted) => {
        console.log(`User ${userId} audio changed. Muted: ${isMuted}`);
        updateParticipantMuteUI(userId, isMuted);
      });

      socket.on("user-disconnected", (userId) => {
        console.log(`User ${userId} disconnected.`);
        removeParticipantCard(userId);
      });

      checkReadyToJoin();
    })
    .catch((err) => {
      console.error(`Mic Error: ${err.message}`);
      alert("Microphone access failed: " + err.message);
    });

  function checkReadyToJoin() {
    if (window.myPeerId && myVideoStream) {
      console.log(`Ready state achieved. Joining room ${ROOM_ID}`);
      setTimeout(() => {
        socket.emit("join-room", ROOM_ID, window.myPeerId, user);
      }, 500);
    }
  }

  function connectToNewUser(userId, stream) {
    console.log(`Calling ${userId}...`);
    const call = peer.call(userId, stream);
    
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");

    call.on("stream", (userVideoStream) => {
      console.log(`Handshake successful with ${userId}`);
      addVideoStream(audio, userVideoStream);
      
      const remoteName = participantsMap.get(userId)?.name || "Participant";
      createOrUpdateParticipantCard(userId, remoteName, false);
      attachStreamAnalyzer(userId, userVideoStream);
    });

    call.on("close", () => {
      console.log(`Connection closed with ${userId}`);
      audio.remove();
      removeParticipantCard(userId);
    });

    call.on("error", (err) => {
      console.error(`Link failure with ${userId}:`, err);
      audio.remove();
      removeParticipantCard(userId);
    });
  }

  // --- AUDIO ELEMENT PLAY & UNMUTE OVERLAY HANDLER ---
  function addVideoStream(element, stream) {
    element.srcObject = stream;
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.volume = 1.0;

    if (element.tagName === "AUDIO") {
      document.body.append(element); 
    } else {
      if (videoGrid) videoGrid.append(element);
    }

    const tryPlay = () => {
      const playPromise = element.play();
      if (playPromise) {
        playPromise.catch(e => {
          console.warn("Autoplay blocked on mobile. Showing UNMUTE overlay.", e);
          if (document.getElementById("unmute-overlay")) return;
          
          const btn = document.createElement("div");
          btn.id = "unmute-overlay";
          btn.innerHTML = "🔊 <b>TAP TO UNMUTE AUDIO</b>";
          btn.style.cssText = "position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:9999; padding:14px 28px; background:#2f80ec; color:white; border-radius:30px; cursor:pointer; font-family:sans-serif; box-shadow:0 4px 15px rgba(0,0,0,0.4); font-size:1rem; font-weight:bold;";
          document.body.appendChild(btn);
          
          btn.onclick = () => { 
            getAudioContext();
            element.play();
            document.querySelectorAll('audio, video').forEach(el => el.play().catch(console.error));
            btn.remove(); 
          };
        });
      }
    };

    // Play immediately AND attach listeners for metadata/canplay
    tryPlay();
    element.onloadedmetadata = tryPlay;
    element.oncanplay = tryPlay;
  }
  
  // --- CHAT FUNCTIONALITY ---
  const text = document.querySelector("#chat_message");
  const send = document.getElementById("send");
  const messages = document.querySelector(".messages");
  
  let replyToMessage = null;
  
  if (send) {
    send.addEventListener("mousedown", (e) => e.preventDefault());
    send.addEventListener("touchstart", (e) => {
      e.preventDefault();
      sendMessage();
    }, { passive: false });

    send.addEventListener("click", (e) => {
      e.preventDefault();
      sendMessage();
    });
  }

  if (text) {
    text.addEventListener("keydown", (e) => { 
      if (e.key === "Enter" && text.value.trim().length > 0) sendMessage(); 
    });
  }
  
  function sendMessage() {
    if (!text) return;
    const message = text.value.trim();
    if (!message) return;
    
    const timestamp = new Date().toLocaleString();
    socket.emit("message", message, timestamp, replyToMessage);
    
    text.value = "";
    replyToMessage = null;
    try { sendAudio.play(); } catch(e){}
  }

  socket.on("createMessage", (message, userName, timestamp, replyText = null) => {
    if (!messages) return;
    const bubble = document.createElement("div");
    bubble.classList.add("message");
    bubble.classList.add(userName === user ? "self" : "other");
  
    bubble.innerHTML = `
      <div class="message-bubble">
        <span class="username">${userName}</span>
        ${replyText ? `<div class="replied-message">${replyText}</div>` : ""}
        <span class="message-text">${message}</span>
        <span class="timestamp">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    `;
  
    messages.appendChild(bubble);
    scrollToBottom();
    
    if (userName !== user) {
      try { receiveAudio.play(); } catch(e){}
    }
  });
  
  function scrollToBottom() {
    const chatWindow = document.querySelector(".main__chat_window");
    if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
  }
  
  socket.on("broadcast", (number) => {
    if (usersCounter) usersCounter.innerHTML = number;
  });

})();
