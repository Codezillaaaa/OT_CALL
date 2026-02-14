const socket = io("/");
const videoGrid = document.getElementById("video-grid");
const myVideo = document.createElement("video");
const usersCounter = document.getElementById("users-counter");
myVideo.muted = true;

let unreadMessageCount = 0;
let sendAudio = new Audio("/assets/send.wav");
let receiveAudio = new Audio("/assets/receive.wav");
sendAudio.preload = "auto";
receiveAudio.preload = "auto";

const params = new URLSearchParams(window.location.search);
const user = params.get("userName");

document.querySelector(".main__right").style.display = "flex";
document.querySelector(".main__right").style.flex = "1";
document.querySelector(".main__left").style.display = "none";

// PeerJS setup
// PeerJS setup
// PeerJS setup
const peer = new Peer(undefined, {
  path: "/peerjs",
  host: "/",
  port: 443,
  secure: true,
  config: {
    iceServers: [
      // STUN (Google + Mozilla)
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stun.services.mozilla.com" },

      // Metered STUN
      {
        urls: "stun:stun.relay.metered.ca:80",
      },

      // Metered TURN
 {
        urls: "turn:global.relay.metered.ca:80",
        username: "679dbcc2f9266a12c72824c6",
        credential: "0VCj1/664MrXISqZ",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "679dbcc2f9266a12c72824c6",
        credential: "0VCj1/664MrXISqZ",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "679dbcc2f9266a12c72824c6",
        credential: "0VCj1/664MrXISqZ",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "679dbcc2f9266a12c72824c6",
        credential: "0VCj1/664MrXISqZ",
      },
    ],
  },
});



let myVideoStream;

// High-end audio constraints
const audioConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 1
  },
  video: false
};

navigator.mediaDevices.getUserMedia(audioConstraints)
  .then((stream) => {
    myVideoStream = stream;
    addVideoStream(myVideo, stream);

    peer.on("call", (call) => {
      call.answer(stream);
      const video = document.createElement("video");
      call.on("stream", (userVideoStream) => {
        addVideoStream(video, userVideoStream);
      });
    });

    socket.on("user-connected", (userId) => {
      connectToNewUser(userId, stream);
    });
  });

const connectToNewUser = (userId, stream) => {
  const call = peer.call(userId, stream);
  const video = document.createElement("video");
  call.on("stream", (userVideoStream) => {
    addVideoStream(video, userVideoStream);
  });
  call.on("close", () => {
    removeVideoStream(video);
  });
};

const removeVideoStream = (video) => {
  video.srcObject = null;
  video.remove();
};

peer.on("open", (id) => {
  socket.emit("join-room", ROOM_ID, id, user);
});

const addVideoStream = (video, stream) => {
  video.srcObject = stream;
  video.addEventListener("loadedmetadata", () => {
    video.play();
    video.width = 240;
    video.height = 180;
    videoGrid.append(video);
  });
};

// Chat functionality
let text = document.querySelector("#chat_message");
let send = document.getElementById("send");
let messages = document.querySelector(".messages");

let replyToMessage = null;

send.addEventListener("click", () => {
  const message = text.value.trim();
  if (!message) return;
  const timestamp = new Date().toLocaleString();
  socket.emit("message", message, timestamp, replyToMessage);
  text.value = "";
  text.placeholder = "Type a message...";
  replyToMessage = null;
  try {
    sendAudio.play();
  } catch (e) {
    console.warn("Send tone blocked:", e);
  }
});

text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && text.value.length !== 0) {
    const message = text.value;
    const timestamp = new Date().toLocaleString();
    socket.emit("message", message, timestamp, replyToMessage);
    text.value = "";
    text.placeholder = "Type a message...";
    replyToMessage = null;
  }
});

socket.on("broadcast", (number) => {
  usersCounter.innerHTML = number;
});

socket.on("createMessage", (message, userName, timestamp, replyText = null) => {
  const bubble = document.createElement("div");
  bubble.classList.add("message");
  bubble.classList.add(userName === user ? "self" : "other");

  bubble.innerHTML = `
    <div class="message-bubble">
      <span class="username">${userName}</span>
      ${replyText ? `<div class="replied-message">${replyText}</div>` : ""}
      <span class="message-text">${message}</span>
      <span class="timestamp">${formatDate(new Date())}</span>
    </div>
  `;

  messages.appendChild(bubble);
  const chatWindow = document.querySelector(".main__chat_window");
  requestAnimationFrame(() => {
    chatWindow.scrollTop = chatWindow.scrollHeight;
  });
  if (userName !== user) {
    try { receiveAudio.play(); } catch (e) { console.warn("Receive tone blocked:", e); }
  } else {
    try { send.play(); } catch (e) { console.warn("Send tone blocked:", e); }
  }
});

function scrollToBottom() {
  setTimeout(() => {
    messages.scrollTop = messages.scrollHeight;
  }, 100);
}

function showUnreadMessageCount() {
  let unreadCountBubble = document.getElementById("unread-count-bubble");
  let goToBottomArrow = document.getElementById("go-to-bottom-arrow");

  if (!unreadCountBubble) {
    unreadCountBubble = document.createElement("div");
    unreadCountBubble.id = "unread-count-bubble";
    unreadCountBubble.classList.add("unread-count-bubble");
    document.body.appendChild(unreadCountBubble);

    unreadCountBubble.addEventListener("click", () => {
      unreadMessageCount = 0;
      unreadCountBubble.remove();
      scrollToBottom();
    });
  }

  unreadCountBubble.innerHTML = unreadMessageCount;

  if (!goToBottomArrow) {
    goToBottomArrow = document.createElement("div");
    goToBottomArrow.id = "go-to-bottom-arrow";
    goToBottomArrow.classList.add("go-to-bottom-arrow");
    document.body.appendChild(goToBottomArrow);

    goToBottomArrow.addEventListener("click", () => {
      unreadMessageCount = 0;
      goToBottomArrow.remove();
      scrollToBottom();
    });
  }

  goToBottomArrow.style.display = "block";
  unreadCountBubble.style.display = "block";
}

function formatDate(date) {
  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  };
  const currentDate = new Date();

  return currentDate.toDateString() === date.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })
    : date.toLocaleDateString("en-GB", options);
}

function isUserAtBottom() {
  return messages.scrollHeight - messages.scrollTop === messages.clientHeight;
}

messages.addEventListener("scroll", () => {
  if (isUserAtBottom()) {
    unreadMessageCount = 0;
    document.getElementById("unread-count-bubble")?.remove();
    document.getElementById("go-to-bottom-arrow")?.remove();
  }
});

function toggleAudio(b) {
  if (b === "true") {
    myVideoStream.getAudioTracks()[0].enabled = true;
  } else {
    myVideoStream.getAudioTracks()[0].enabled = false;
  }
}

function checkMatch(userMessage) {
  let inputMessage = userMessage.toLowerCase();
  let result = inputMessage.match(/(asshole|fuck|shit|bitch|cunt|wanker|dickhead|bollocks|...)*/g);
  console.log(result);
  return result != null ? 1 : 0;
}
