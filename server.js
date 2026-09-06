const express = require("express");
const app = express();
var profanity = require("profanity-hindi");
const server = require("http").Server(app);
const { v4: uuidv4 } = require("uuid");
app.set("view engine", "ejs");
const crypto = require('crypto');
require('dotenv').config();
const io = require("socket.io")(server, {
  cors: {
    origin: '*'
  }
});
const { ExpressPeerServer } = require("peer");
const peerServer = ExpressPeerServer(server, {
  debug: true,
});

app.use("/peerjs", peerServer);
app.use(express.static("public"));

// --- Dynamic TURN Credentials ---
app.get("/api/turn-credentials", (req, res) => {
  try {
    const secret = process.env.COTURN_SECRET;
    const host = process.env.COTURN_HOST;
    const turnPort = process.env.COTURN_PORT || 3478;

    if (host && secret) {
      const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
      const username = `${expiry}:opentalk`;
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      return res.json({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: `turn:${host}:${turnPort}?transport=udp`, username, credential },
          { urls: `turn:${host}:${turnPort}?transport=tcp`, username, credential }
        ]
      });
    }
    res.json({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.redirect(`/${uuidv4()}`);
});

app.get("/:room", (req, res) => {
  res.render("room", { roomId: req.params.room });
});

// Track room participants: roomId -> Map(userId -> userName)
const roomUsers = new Map();

io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userId, userName) => {
    socket.join(roomId);

    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Map());
    }
    const usersInRoom = roomUsers.get(roomId);
    const finalName = userName || "Guest";
    usersInRoom.set(userId, finalName);
    socket.userId = userId;
    socket.roomId = roomId;

    // Send existing users in room to the newly joined peer
    const existingUsers = {};
    usersInRoom.forEach((name, uid) => {
      if (uid !== userId) existingUsers[uid] = name;
    });
    socket.emit("existing-users", existingUsers);

    // Broadcast new user connection with both userId and userName
    socket.to(roomId).broadcast.emit("user-connected", userId, finalName);

    // Relay mute/unmute visual status changes across room participants
    socket.on("user-toggle-audio", (isMuted) => {
      socket.to(roomId).broadcast.emit("user-audio-changed", userId, isMuted);
    });

    socket.on("disconnect", () => {
      if (socket.roomId && roomUsers.has(socket.roomId)) {
        const uMap = roomUsers.get(socket.roomId);
        uMap.delete(socket.userId);
        if (uMap.size === 0) {
          roomUsers.delete(socket.roomId);
        }
      }
      socket.to(roomId).broadcast.emit("user-disconnected", userId);
    });

    // SENIOR DEV FIX: Accept timestamp and replyToMessage parameters
    socket.on("message", (message, timestamp, replyToMessage) => {
      // SENIOR DEV FIX: Prevent DoS crash from object-injection (if hacker sends object payload instead of string)
      if (typeof message !== "string") return;

      var isDirty = false;
      try {
        isDirty = profanity.isMessageDirty(message);
      } catch (e) {
        // Fallback silently if profanity module throws
      }

      if (isDirty) {
        message = "<span style='color: red;'>🚨 Using bad word may ban your account permanantly</span>";
      }

      // Emit full payload out so the Android WebView can show the reply bubble
      io.to(roomId).emit("createMessage", message, userName, timestamp, replyToMessage);
    });
  });
});

server.listen(process.env.PORT || 3000);
