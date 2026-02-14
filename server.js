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

app.get("/", (req, res) => {
  res.redirect(`/${uuidv4()}`);
});

app.get("/:room", (req, res) => {
  res.render("room", { roomId: req.params.room });
});

io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userId, userName) => {
    socket.join(roomId);
    socket.to(roomId).broadcast.emit("user-connected", userId);
    socket.on("message", (message) => {
      var isDirty = profanity.isMessageDirty(message);
      if (isDirty) {
        message = "<span style='color: red;'>🚨 Using bad word may ban your account permanantly</span>";
      }
      io.to(roomId).emit("createMessage", message, userName);
    });
  });
});

server.listen(process.env.PORT || 3000);
