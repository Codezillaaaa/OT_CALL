const socket = io("/");
const videoGrid = document.getElementById("video-grid");
const myVideo = document.createElement("video");
const usersCounter = document.getElementById("users-counter");
myVideo.muted = true;

// --- GLOBAL VARIABLES (Accessible by Android WebView) ---
var myVideoStream; // MUST be var or let in global scope
var unreadMessageCount = 0;
var sendAudio = new Audio("/assets/send.wav");
var receiveAudio = new Audio("/assets/receive.wav");
sendAudio.preload = "auto";
receiveAudio.preload = "auto";

const params = new URLSearchParams(window.location.search);
const user = params.get("userName");

// UI Setup
document.querySelector(".main__right").style.display = "flex";
document.querySelector(".main__right").style.flex = "1";
document.querySelector(".main__left").style.display = "none";

// --- GLOBAL FUNCTIONS (Called by Android App) ---
function toggleAudio(b) {
  if (!myVideoStream) return;
  const audioTrack = myVideoStream.getAudioTracks()[0];
  if (audioTrack) {
    if (b === "true") {
      audioTrack.enabled = true;
      console.log("Audio Enabled");
    } else {
      audioTrack.enabled = false;
      console.log("Audio Disabled (Muted)");
    }
  }
}

function checkMatch(userMessage) {
  let inputMessage = userMessage.toLowerCase();
  let result = inputMessage.match(/(asshole|fuck|shit|bitch|cunt|wanker|dickhead|bollocks|...)*/g);
  return result != null ? 1 : 0;
}

// --- MAIN LOGIC ---
(async function () {
  console.log("Initializing App...");

  let iceServers = [];
  try {
    const res = await fetch("/api/turn-credentials");
    const data = await res.json();
    iceServers = data.iceServers;
    console.log(`TURN loaded: ${iceServers.length} servers`);
  } catch (e) {
    console.warn("TURN Fetch failed, using default STUN");
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  }

  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const isSecure = location.protocol === 'https:';
  const peerPort = location.port ? parseInt(location.port) : (isSecure ? 443 : 80);

  const peer = new Peer(undefined, {
    path: "/peerjs",
    host: "/",
    port: peerPort,
    secure: isSecure,
    config: { iceServers: iceServers }
  });

  let myPeerId = null;

  // --- GLOBAL CALL HANDLER ---
  peer.on("call", (call) => {
    console.log(`Incoming call from: ${call.peer}`);
    call.answer(myVideoStream); 

    const audio = document.createElement("audio");
    audio.autoplay = true; 
    audio.controls = false; 
    
    call.on("stream", (userVideoStream) => {
      addVideoStream(audio, userVideoStream);
    });
    
    call.on("error", (err) => console.error(`Call Error: ${err}`));
  });

  peer.on("open", (id) => {
    console.log(`Peer OPEN ID: ${id}`);
    myPeerId = id;
    joinRoom();
  });

  // --- AUDIO ONLY STREAM ---
  // Simple constraints for maximum compatibility
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then((stream) => {
      myVideoStream = stream; // Assign to global variable
      
      // We don't need to add our own audio to the grid (it's mute anyway)
      // addVideoStream(myVideo, stream); 

      socket.on("user-connected", (userId) => {
        console.log(`User connected: ${userId}`);
        connectToNewUser(userId, stream);
      });

      joinRoom();
    })
    .catch((err) => {
      console.error(`Mic Error: ${err.message}`);
      alert("Microphone failed: " + err.message);
    });

  function joinRoom() {
    if (myPeerId && myVideoStream) {
      console.log(`Ready to join room ${ROOM_ID}`);
      socket.emit("join-room", ROOM_ID, myPeerId, user);
    }
  }

  function connectToNewUser(userId, stream) {
    console.log(`Calling ${userId}...`);
    const call = peer.call(userId, stream);
    
    const audio = document.createElement("audio");
    audio.autoplay = true;

    call.on("stream", (userVideoStream) => {
      console.log(`Got stream from ${userId}`);
      addVideoStream(audio, userVideoStream);
    });
    call.on("close", () => audio.remove());
  }

  // --- VIDEO/AUDIO ELEMENT HANDLER ---
  function addVideoStream(element, stream) {
    element.srcObject = stream;
    element.addEventListener("loadedmetadata", () => {
      const playPromise = element.play();
      if (playPromise) {
          playPromise.catch(e => {
            console.warn("Autoplay blocked. Showing UNMUTE button.");
            // Avoid duplicate buttons
            if (document.getElementById("unmute-overlay")) return;
            
            const btn = document.createElement("div");
            btn.id = "unmute-overlay";
            btn.innerHTML = "🔇 <b>TAP TO UNMUTE AUDIO</b>";
            btn.style.cssText = "position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:9999; padding:15px 30px; background:#f6484a; color:white; border-radius:30px; cursor:pointer; font-family:sans-serif; box-shadow:0 4px 15px rgba(0,0,0,0.3); animation: pulse 2s infinite;";
            document.body.appendChild(btn);
            
            btn.onclick = () => { 
                element.play();
                // Try to play other elements too if any
                document.querySelectorAll('audio, video').forEach(el => el.play().catch(console.error));
                btn.remove(); 
            };
          });
      }
      if (element.tagName === "AUDIO") {
          document.body.append(element); 
      } else {
          videoGrid.append(element);
      }
    });
  }
  
  // --- CHAT FUNCTIONALITY ---
  const text = document.querySelector("#chat_message");
  const send = document.getElementById("send");
  const messages = document.querySelector(".messages");
  
  let replyToMessage = null;
  
  send.addEventListener("click", sendMessage);
  text.addEventListener("keydown", (e) => { 
      if (e.key === "Enter" && text.value.trim().length > 0) sendMessage(); 
  });
  
  function sendMessage() {
      const message = text.value.trim();
      if (!message) return;
      
      const timestamp = new Date().toLocaleString();
      socket.emit("message", message, timestamp, replyToMessage);
      
      text.value = "";
      replyToMessage = null;
      try { sendAudio.play(); } catch(e){}
  }

  socket.on("createMessage", (message, userName, timestamp, replyText = null) => {
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
  
  // Chat Utilities
  function scrollToBottom() {
      const chatWindow = document.querySelector(".main__chat_window");
      if(chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
  }
  
  socket.on("broadcast", (number) => {
    if(usersCounter) usersCounter.innerHTML = number;
  });

})();
