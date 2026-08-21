import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình 4 hiệu ứng sân khấu
const EFFECT_CONFIGS = {
  1: { duration: 26, sound: "Opening.mp3", name: "Hiệu ứng 1 (Opening - 26s)" },
  2: { duration: 40, sound: "Contestant.mp3", name: "Hiệu ứng 2 (Contestant - 40s)" },
  3: { duration: 13, loopDuration: 1.0, sound: "Judge_Vote.mp3", name: "Hiệu ứng 3 (Judge Vote - 13s, Lặp 1s)" },
  4: { duration: 7, loopDuration: 1.0, sound: "Result.mp3", name: "Hiệu ứng 4 (Result - 7s, Lặp 1s)" },
};

// Hàm random ngẫu nhiên vị trí các đèn xanh (CHON) cho chế độ nhập chay điểm
function generateRandomNormalVotes(score) {
  const allSeats = Array.from({ length: 101 }, (_, i) => i + 1);
  for (let i = allSeats.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allSeats[i], allSeats[j]] = [allSeats[j], allSeats[i]];
  }
  const votes = {};
  const clampedScore = Math.min(Math.max(score, 0), 101);
  for (let i = 0; i < clampedScore; i++) {
    votes[allSeats[i]] = "CHON";
  }
  return votes;
}

// Hàm random ngẫu nhiên vị trí các ô Hồng và Xanh cho chế độ nhập chay tỉ số đối đầu
function generateRandomVersusVotes(pinkCount, blueCount) {
  const allSeats = Array.from({ length: 101 }, (_, i) => i + 1);
  for (let i = allSeats.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allSeats[i], allSeats[j]] = [allSeats[j], allSeats[i]];
  }
  const votes = {};
  const clampedPink = Math.min(Math.max(pinkCount, 0), 101);
  const clampedBlue = Math.min(Math.max(blueCount, 0), 101 - clampedPink);
  for (let i = 0; i < clampedPink && i < allSeats.length; i++) {
    votes[allSeats[i]] = "HONG";
  }
  for (let i = clampedPink; i < clampedPink + clampedBlue && i < allSeats.length; i++) {
    votes[allSeats[i]] = "XANH";
  }
  return votes;
}

// Tạo mã phòng ngẫu nhiên 6 chữ số
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// MULTI-ROOM STORE: Quản lý độc lập từng phòng chơi
const rooms = new Map();

function createDefaultRoomState(roomCode) {
  const serverNow = Date.now();
  return {
    roomCode: roomCode,
    effect: null,
    action: "reset",
    duration: 0,
    loopDuration: 0,
    soundTrack: "",
    serverStartTime: 0,
    timestamp: serverNow,
    voting: {
      roomId: roomCode,
      mode: "LOCKED",
      votes: {},
      connectedJudges: {},
    },
    audienceScore: {
      pink: 0,
      blue: 0,
    },
    manualScores: {
      normal: "",
      versusPink: "",
      versusBlue: "",
    },
    stageDisplay: {
      type: "IDLE",
      payload: {},
      timestamp: serverNow,
    },
  };
}

function getOrCreateRoom(roomCode) {
  const code = (roomCode || "101101").toString().trim();
  if (!rooms.has(code)) {
    rooms.set(code, createDefaultRoomState(code));
    console.log(`[MultiRoom] Khởi tạo phòng mới: ${code}`);
  }
  return rooms.get(code);
}

// Khởi tạo phòng mặc định 101101
getOrCreateRoom("101101");

function findHtmlFile(pageName) {
  const cleanName = pageName.replace(/\.html$/i, "");
  const candidates = [
    path.join(__dirname, "dist", `${cleanName}.html`),
    path.join(__dirname, `${cleanName}.html`),
    path.join(__dirname, "dist", `${cleanName.toLowerCase()}.html`),
    path.join(__dirname, `${cleanName.toLowerCase()}.html`),
    path.join(__dirname, "dist", `${cleanName.charAt(0).toUpperCase() + cleanName.slice(1)}.html`),
    path.join(__dirname, `${cleanName.charAt(0).toUpperCase() + cleanName.slice(1)}.html`),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);

  app.use(express.json());

  // CORS headers
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  const publicDir = path.join(__dirname, "public");
  const audioDir = path.join(publicDir, "audio");
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  app.use(express.static(publicDir));
  app.use("/audio", express.static(audioDir));

  // Thiết lập WebSocket Server với Heartbeat định kỳ để chống ngắt kết nối trên Render
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();

  const broadcastToRoom = (roomId, data) => {
    const targetRoomId = (roomId || "101101").toString().trim();
    const payload = JSON.stringify({ ...data, roomId: targetRoomId });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN && client.roomId === targetRoomId) {
        client.send(payload);
      }
    }
  };

  const broadcastAll = (data) => {
    const payload = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  // Heartbeat ping mỗi 20 giây để giữ kết nối trên Render / Cloudflare
  setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "HEARTBEAT", serverTime: now, clientsCount: clients.size }));
      }
    }
  }, 20000);

  wss.on("connection", (ws, req) => {
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    clients.add(ws);

    // Lấy roomId từ URL query nếu có (ví dụ: /ws?roomid=123456)
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const queryRoomId = urlObj.searchParams.get("roomid") || urlObj.searchParams.get("roomId") || "101101";
    ws.roomId = queryRoomId.toString().trim();

    console.log(`[WS] Máy khách mới kết nối từ: ${clientIp} (Phòng: ${ws.roomId}, Tổng online: ${clients.size})`);

    const room = getOrCreateRoom(ws.roomId);

    // Gửi ngay trạng thái hiện tại của phòng này
    ws.send(
      JSON.stringify({
        type: "STATE_SYNC",
        roomId: ws.roomId,
        state: room,
        serverTime: Date.now(),
        clientsCount: clients.size,
      })
    );

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        // Giao thức NTP thu nhỏ: Đồng bộ giờ chính xác mili-giây
        if (data.type === "TIME_SYNC") {
          ws.send(
            JSON.stringify({
              type: "TIME_SYNC_RESPONSE",
              clientPingTime: data.clientPingTime,
              serverTime: Date.now(),
            })
          );
          return;
        }

        // Lệnh tham gia phòng hoặc đổi phòng
        if (data.type === "JOIN_ROOM") {
          const targetRoom = (data.roomId || "101101").toString().trim();
          ws.roomId = targetRoom;
          const r = getOrCreateRoom(targetRoom);
          console.log(`[WS] Máy khách tham gia phòng: ${targetRoom}`);
          ws.send(
            JSON.stringify({
              type: "STATE_SYNC",
              roomId: targetRoom,
              state: r,
              serverTime: Date.now(),
              clientsCount: clients.size,
            })
          );
          return;
        }

        const roomId = (data.roomId || ws.roomId || "101101").toString().trim();
        ws.roomId = roomId;
        const roomState = getOrCreateRoom(roomId);

        if (data.type === "TRIGGER_EFFECT") {
          const effectNum = Number(data.effect);
          const config = EFFECT_CONFIGS[effectNum];
          if (config) {
            const serverNow = Date.now();
            roomState.effect = effectNum;
            roomState.action = "start";
            roomState.duration = config.duration;
            roomState.loopDuration = config.loopDuration || 0;
            roomState.soundTrack = config.sound;
            roomState.serverStartTime = serverNow;
            roomState.timestamp = serverNow;
            roomState.stageDisplay = { type: "EFFECT", effect: effectNum, timestamp: serverNow };

            console.log(`[Server] KÍCH HOẠT HIỆU ỨNG ${effectNum} (Phòng ${roomId})`);
            broadcastToRoom(roomId, {
              type: "EFFECT_TRIGGERED",
              state: roomState,
              serverTime: serverNow,
              clientsCount: clients.size,
            });
          }
        } else if (data.type === "STOP_EFFECT") {
          const serverNow = Date.now();
          roomState.effect = null;
          roomState.action = "stop";
          roomState.duration = 0;
          roomState.loopDuration = 0;
          roomState.soundTrack = "";
          roomState.serverStartTime = serverNow;
          roomState.timestamp = serverNow;
          roomState.stageDisplay = { type: "IDLE", timestamp: serverNow };

          console.log(`[Server] DỪNG HIỆU ỨNG (Phòng ${roomId})`);
          broadcastToRoom(roomId, {
            type: "EFFECT_STOPPED",
            state: roomState,
            serverTime: serverNow,
            clientsCount: clients.size,
          });
        } else if (data.type === "RESET") {
          const serverNow = Date.now();
          roomState.effect = null;
          roomState.action = "reset";
          roomState.mode = data.mode || "white";
          roomState.duration = 0;
          roomState.loopDuration = 0;
          roomState.soundTrack = "";
          roomState.serverStartTime = serverNow;
          roomState.timestamp = serverNow;
          roomState.stageDisplay = { type: "IDLE", mode: data.mode || "white", timestamp: serverNow };

          broadcastToRoom(roomId, {
            type: "RESET",
            state: roomState,
            serverTime: serverNow,
            clientsCount: clients.size,
          });
        } else if (data.type === "CREATE_ROOM") {
          const newRoomCode = generateRoomCode();
          const newRoom = getOrCreateRoom(newRoomCode);
          ws.roomId = newRoomCode;
          console.log(`[Room] Tạo mã phòng mới: ${newRoomCode}`);
          ws.send(
            JSON.stringify({
              type: "ROOM_CREATED",
              roomCode: newRoomCode,
              state: newRoom,
              serverTime: Date.now(),
            })
          );
        } else if (data.type === "SET_VOTING_MODE") {
          const newMode = data.mode;
          roomState.voting.mode = newMode;
          if (data.resetVotes) {
            roomState.voting.votes = {};
          }
          console.log(`[Voting] Chuyển chế độ bình chọn (Phòng ${roomId}): ${newMode}`);
          broadcastToRoom(roomId, {
            type: "VOTING_MODE_CHANGED",
            mode: newMode,
            voting: roomState.voting,
            serverTime: Date.now(),
          });
        } else if (data.type === "CAST_VOTE") {
          const { seatId, vote } = data;
          const seatNum = Number(seatId);
          if (seatNum >= 1 && seatNum <= 101) {
            roomState.voting.votes[seatNum] = vote;
            console.log(`[Vote] Ghế #${seatNum} đã chọn: ${vote} (Phòng ${roomId})`);
            broadcastToRoom(roomId, {
              type: "VOTE_CAST",
              seatId: seatNum,
              vote,
              voting: roomState.voting,
              serverTime: Date.now(),
            });
          }
        } else if (data.type === "SHOW_NORMAL_RESULT") {
          const serverNow = Date.now();
          let chonCount = 0;
          Object.values(roomState.voting.votes).forEach((v) => {
            if (v === "CHON") chonCount++;
          });

          let votesToUse = { ...roomState.voting.votes };
          let finalScore = chonCount;

          if (data.normalScore !== undefined && data.normalScore !== null && data.normalScore !== "") {
            finalScore = Number(data.normalScore);
            votesToUse = data.votes || generateRandomNormalVotes(finalScore);
          }

          roomState.stageDisplay = {
            type: "NORMAL_RESULT",
            votes: votesToUse,
            totalScore: finalScore,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "SHOW_NORMAL_RESULT",
            payload: roomState.stageDisplay,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_VERSUS_RESULT") {
          const serverNow = Date.now();
          let pinkCount = 0;
          let blueCount = 0;
          Object.values(roomState.voting.votes).forEach((v) => {
            if (v === "HONG") pinkCount++;
            if (v === "XANH") blueCount++;
          });

          // Lấy điểm ban giám khảo (judgePink & judgeBlue)
          let judgePink = pinkCount;
          let judgeBlue = blueCount;
          if (data.judgePinkScore !== undefined && data.judgePinkScore !== null && data.judgePinkScore !== "") {
            judgePink = Number(data.judgePinkScore);
          } else if (data.pinkScore !== undefined && data.pinkScore !== null && data.pinkScore !== "") {
            judgePink = Number(data.pinkScore);
          }

          if (data.judgeBlueScore !== undefined && data.judgeBlueScore !== null && data.judgeBlueScore !== "") {
            judgeBlue = Number(data.judgeBlueScore);
          } else if (data.blueScore !== undefined && data.blueScore !== null && data.blueScore !== "") {
            judgeBlue = Number(data.blueScore);
          }

          let votesToUse = { ...roomState.voting.votes };
          if (data.votes) {
            votesToUse = data.votes;
          } else if (judgePink !== pinkCount || judgeBlue !== blueCount) {
            votesToUse = generateRandomVersusVotes(judgePink, judgeBlue);
          }

          // Lấy điểm khán giả (Chỉ cộng đúng 1 lần - không nhân 2)
          const audPink = (roomState.audienceScore && typeof roomState.audienceScore.pink === "number") ? roomState.audienceScore.pink : (data.audiencePinkScore !== undefined ? Number(data.audiencePinkScore) : 0);
          const audBlue = (roomState.audienceScore && typeof roomState.audienceScore.blue === "number") ? roomState.audienceScore.blue : (data.audienceBlueScore !== undefined ? Number(data.audienceBlueScore) : 0);

          // Nếu client đã tính sẵn finalScore (data.pinkScore khi có kèm data.judgePinkScore) thì ưu tiên dùng
          let finalPinkScore = judgePink;
          let finalBlueScore = judgeBlue;
          if (audPink !== 0 || audBlue !== 0) {
            finalPinkScore = Math.round((judgePink + audPink) * 10) / 10;
            finalBlueScore = Math.round((judgeBlue + audBlue) * 10) / 10;
          }

          roomState.stageDisplay = {
            type: "VERSUS_RESULT",
            votes: votesToUse,
            judgePinkScore: judgePink,
            judgeBlueScore: judgeBlue,
            audiencePinkScore: audPink,
            audienceBlueScore: audBlue,
            pinkScore: finalPinkScore,
            blueScore: finalBlueScore,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "SHOW_VERSUS_RESULT",
            payload: roomState.stageDisplay,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_SPECIFIC_JUDGES") {
          const serverNow = Date.now();
          const newJudgeIds = Array.isArray(data.judgeIds) ? data.judgeIds : [];
          
          let combinedJudgeIds = [];
          if (roomState.stageDisplay && roomState.stageDisplay.type === "SPECIFIC_JUDGES" && Array.isArray(roomState.stageDisplay.judgeIds)) {
            const existingSet = new Set(roomState.stageDisplay.judgeIds.map(Number));
            newJudgeIds.forEach(id => existingSet.add(Number(id)));
            combinedJudgeIds = Array.from(existingSet);
          } else {
            combinedJudgeIds = Array.from(new Set(newJudgeIds.map(Number)));
          }

          let votesToUse = data.votes && Object.keys(data.votes).length > 0 ? { ...data.votes } : { ...roomState.voting.votes };
          if (Object.keys(votesToUse).length === 0) {
            if (roomState.manualScores.normal !== "") {
              votesToUse = generateRandomNormalVotes(Number(roomState.manualScores.normal) || 0);
            } else if (roomState.manualScores.versusPink !== "" || roomState.manualScores.versusBlue !== "") {
              votesToUse = generateRandomVersusVotes(
                Number(roomState.manualScores.versusPink) || 0,
                Number(roomState.manualScores.versusBlue) || 0
              );
            }
            roomState.voting.votes = { ...votesToUse };
          }

          roomState.stageDisplay = {
            type: "SPECIFIC_JUDGES",
            judgeIds: combinedJudgeIds,
            votes: votesToUse,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "SHOW_SPECIFIC_JUDGES",
            payload: roomState.stageDisplay,
            serverTime: serverNow,
          });
        } else if (data.type === "RESET_SCORE") {
          const serverNow = Date.now();
          Object.keys(roomState.voting.votes).forEach((k) => {
            if (roomState.voting.votes[k] === "CHON" || roomState.voting.votes[k] === "KHONG_CHON") {
              delete roomState.voting.votes[k];
            }
          });
          roomState.manualScores.normal = "";
          roomState.stageDisplay = {
            type: "IDLE",
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "RESET_SCORE",
            voting: roomState.voting,
            manualScores: roomState.manualScores,
            serverTime: serverNow,
          });
        } else if (data.type === "RESET_REFERENCE_SCORE") {
          const serverNow = Date.now();
          Object.keys(roomState.voting.votes).forEach((k) => {
            if (roomState.voting.votes[k] === "HONG" || roomState.voting.votes[k] === "XANH") {
              delete roomState.voting.votes[k];
            }
          });
          roomState.manualScores.versusPink = "";
          roomState.manualScores.versusBlue = "";
          roomState.stageDisplay = {
            type: "IDLE",
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "RESET_REFERENCE_SCORE",
            voting: roomState.voting,
            manualScores: roomState.manualScores,
            serverTime: serverNow,
          });
        } else if (data.type === "UPDATE_MANUAL_SCORES") {
          if (data.normal !== undefined) roomState.manualScores.normal = data.normal;
          if (data.versusPink !== undefined) roomState.manualScores.versusPink = data.versusPink;
          if (data.versusBlue !== undefined) roomState.manualScores.versusBlue = data.versusBlue;

          if (data.votes && Object.keys(data.votes).length > 0) {
            roomState.voting.votes = { ...data.votes };
          } else if (data.normal !== undefined && data.normal !== "") {
            roomState.voting.votes = generateRandomNormalVotes(Number(data.normal) || 0);
          } else if ((data.versusPink !== undefined && data.versusPink !== "") || (data.versusBlue !== undefined && data.versusBlue !== "")) {
            roomState.voting.votes = generateRandomVersusVotes(
              Number(roomState.manualScores.versusPink) || 0,
              Number(roomState.manualScores.versusBlue) || 0
            );
          }

          broadcastToRoom(roomId, {
            type: "MANUAL_SCORES_UPDATED",
            manualScores: roomState.manualScores,
            voting: roomState.voting,
            serverTime: Date.now(),
          });
        } else if (data.type === "RESET_AUDIENCE_SCORE") {
          roomState.audienceScore = { pink: 0, blue: 0 };
          const serverNow = Date.now();
          roomState.stageDisplay = {
            type: "IDLE",
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "RESET_AUDIENCE_SCORE",
            audienceScore: roomState.audienceScore,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_REFERENCE_SCORE") {
          const serverNow = Date.now();
          let pinkCount = 0;
          let blueCount = 0;

          if (data.pink !== undefined && data.pink !== "") {
            pinkCount = Number(data.pink) || 0;
          } else if (data.scoreA !== undefined && data.scoreA !== "") {
            pinkCount = Number(data.scoreA) || 0;
          } else if (roomState.manualScores.versusPink !== "") {
            pinkCount = Number(roomState.manualScores.versusPink) || 0;
          } else {
            Object.values(roomState.voting.votes).forEach((v) => {
              if (v === "HONG") pinkCount++;
            });
          }

          if (data.blue !== undefined && data.blue !== "") {
            blueCount = Number(data.blue) || 0;
          } else if (data.scoreB !== undefined && data.scoreB !== "") {
            blueCount = Number(data.scoreB) || 0;
          } else if (roomState.manualScores.versusBlue !== "") {
            blueCount = Number(roomState.manualScores.versusBlue) || 0;
          } else {
            Object.values(roomState.voting.votes).forEach((v) => {
              if (v === "XANH") blueCount++;
            });
          }

          roomState.stageDisplay = {
            type: "REFERENCE_SCORE",
            scoreA: pinkCount,
            scoreB: blueCount,
            pink: pinkCount,
            blue: blueCount,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "SHOW_REFERENCE_SCORE",
            payload: roomState.stageDisplay,
            serverTime: serverNow,
          });
        } else if (data.type === "SET_AUDIENCE_SCORE") {
          const pink = Math.round((Number(data.pink) || 0) * 10) / 10;
          const blue = Math.round((Number(data.blue) || 0) * 10) / 10;
          const sum = Math.round((pink + blue) * 10) / 10;
          if (sum === 100 || sum === 0) {
            roomState.audienceScore = { pink, blue };
            broadcastToRoom(roomId, {
              type: "AUDIENCE_SCORE_UPDATED",
              audienceScore: roomState.audienceScore,
              serverTime: Date.now(),
            });
          }
        } else if (data.type === "SHOW_AUDIENCE_SCORE") {
          const serverNow = Date.now();
          roomState.stageDisplay = {
            type: "AUDIENCE_SCORE",
            pink: roomState.audienceScore.pink,
            blue: roomState.audienceScore.blue,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "SHOW_AUDIENCE_SCORE",
            payload: roomState.stageDisplay,
            serverTime: serverNow,
          });
        } else if (data.type === "CLEAR_STAGE_DISPLAY") {
          const serverNow = Date.now();
          roomState.stageDisplay = {
            type: "IDLE",
            timestamp: serverNow,
          };
          broadcastToRoom(roomId, {
            type: "CLEAR_STAGE_DISPLAY",
            serverTime: serverNow,
          });
        }
      } catch (err) {
        console.error("[WS] Lỗi parse message:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[WS] Máy khách ngắt kết nối. (Còn lại: ${clients.size} máy)`);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  const getReqRoomId = (req) => {
    return (req.body?.roomId || req.query?.roomid || req.query?.roomId || req.headers["x-room-id"] || "101101").toString().trim();
  };

  // REST API: Lấy trạng thái hiện tại của phòng
  app.get("/api/state", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    res.json({
      roomId,
      state: roomState,
      clientsCount: clients.size,
      serverTime: Date.now(),
      effects: EFFECT_CONFIGS,
    });
  });

  // REST API: Ping thời gian mili-giây
  app.get("/api/time", (req, res) => {
    res.json({
      clientPingTime: req.query.t || Date.now(),
      serverTime: Date.now(),
    });
  });

  // REST API: Kích hoạt hiệu ứng (1, 2, 3, 4)
  app.post("/api/trigger", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const effectNum = Number(req.body.effect);
    const config = EFFECT_CONFIGS[effectNum];
    if (!config) {
      return res.status(400).json({ error: "Số hiệu ứng không hợp lệ" });
    }

    const serverNow = Date.now();
    roomState.effect = effectNum;
    roomState.action = "start";
    roomState.duration = config.duration;
    roomState.loopDuration = config.loopDuration || 0;
    roomState.soundTrack = config.sound;
    roomState.serverStartTime = serverNow;
    roomState.timestamp = serverNow;

    broadcastToRoom(roomId, {
      type: "EFFECT_TRIGGERED",
      state: roomState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: roomState, serverTime: serverNow });
  });

  // REST API: Dừng hiệu ứng
  app.post("/api/stop", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    roomState.effect = null;
    roomState.action = "stop";
    roomState.duration = 0;
    roomState.loopDuration = 0;
    roomState.soundTrack = "";
    roomState.serverStartTime = serverNow;
    roomState.timestamp = serverNow;

    broadcastToRoom(roomId, {
      type: "EFFECT_STOPPED",
      state: roomState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: roomState, serverTime: serverNow });
  });

  // REST API: Đặt lại trạng thái
  app.post("/api/reset", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    roomState.effect = null;
    roomState.action = "reset";
    roomState.mode = req.body.mode || "white";
    roomState.duration = 0;
    roomState.loopDuration = 0;
    roomState.soundTrack = "";
    roomState.serverStartTime = serverNow;
    roomState.timestamp = serverNow;
    roomState.stageDisplay = { type: "IDLE", mode: req.body.mode || "white", timestamp: serverNow };

    broadcastToRoom(roomId, {
      type: "RESET",
      state: roomState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: roomState, serverTime: serverNow });
  });

  // REST API: Tạo mã phòng mới (6 chữ số)
  app.post("/api/room/create", (_req, res) => {
    const newRoomCode = generateRoomCode();
    const newRoom = getOrCreateRoom(newRoomCode);
    console.log(`[Room REST] Tạo mã phòng mới: ${newRoomCode}`);
    res.json({ success: true, roomCode: newRoomCode, state: newRoom });
  });

  // REST API: Kiểm tra mã phòng và đăng nhập Judge
  app.post("/api/room/verify", (req, res) => {
    const { roomId, seatId } = req.body;
    const seatNum = Number(seatId);
    const cleanRoom = (roomId || "").toString().trim();
    if (!cleanRoom || cleanRoom.length < 4) {
      return res.status(400).json({ success: false, error: "Mã phòng không hợp lệ!" });
    }
    const roomState = getOrCreateRoom(cleanRoom);
    if (!seatNum || seatNum < 1 || seatNum > 101) {
      return res.status(400).json({ success: false, error: "Vị trí không hợp lệ (Phải từ 1 đến 101)!" });
    }
    res.json({
      success: true,
      roomCode: cleanRoom,
      seatId: seatNum,
      votingMode: roomState.voting.mode,
      currentVote: roomState.voting.votes[seatNum] || null,
    });
  });

  // REST API: Đặt chế độ bình chọn (NORMAL | VERSUS | LOCKED)
  app.post("/api/voting/mode", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const { mode, resetVotes } = req.body;
    if (!["NORMAL", "VERSUS", "LOCKED"].includes(mode)) {
      return res.status(400).json({ error: "Chế độ bình chọn không hợp lệ" });
    }
    roomState.voting.mode = mode;
    if (resetVotes) {
      roomState.voting.votes = {};
    }
    broadcastToRoom(roomId, {
      type: "VOTING_MODE_CHANGED",
      mode,
      voting: roomState.voting,
      serverTime: Date.now(),
    });
    res.json({ success: true, mode, voting: roomState.voting });
  });

  // REST API: Gửi bình chọn từ Judge
  app.post("/api/voting/vote", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const { seatId, vote } = req.body;
    const seatNum = Number(seatId);
    if (seatNum < 1 || seatNum > 101) {
      return res.status(400).json({ error: "Vị trí không hợp lệ" });
    }
    if (roomState.voting.mode === "LOCKED") {
      return res.status(400).json({ error: "Bình chọn đang bị khóa" });
    }
    roomState.voting.votes[seatNum] = vote;
    broadcastToRoom(roomId, {
      type: "VOTE_CAST",
      seatId: seatNum,
      vote,
      voting: roomState.voting,
      serverTime: Date.now(),
    });
    res.json({ success: true, seatId: seatNum, vote, voting: roomState.voting });
  });

  // REST API: Hiện kết quả Thường trên Index
  app.post("/api/display/normal", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    let chonCount = 0;
    Object.values(roomState.voting.votes).forEach((v) => {
      if (v === "CHON") chonCount++;
    });

    let finalScore = chonCount;
    let votesToUse = { ...roomState.voting.votes };
    if (req.body && req.body.normalScore !== undefined && req.body.normalScore !== null && req.body.normalScore !== "") {
      finalScore = Number(req.body.normalScore);
      votesToUse = req.body.votes || generateRandomNormalVotes(finalScore);
    }

    roomState.stageDisplay = {
      type: "NORMAL_RESULT",
      votes: votesToUse,
      totalScore: finalScore,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "SHOW_NORMAL_RESULT",
      payload: roomState.stageDisplay,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: roomState.stageDisplay });
  });

  // REST API: Hiện kết quả Đối đầu trên Index
  app.post("/api/display/versus", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    let pinkCount = 0;
    let blueCount = 0;
    Object.values(roomState.voting.votes).forEach((v) => {
      if (v === "HONG") pinkCount++;
      if (v === "XANH") blueCount++;
    });

    let judgePink = pinkCount;
    let judgeBlue = blueCount;
    if (req.body && req.body.judgePinkScore !== undefined && req.body.judgePinkScore !== null && req.body.judgePinkScore !== "") {
      judgePink = Number(req.body.judgePinkScore);
    } else if (req.body && req.body.pinkScore !== undefined && req.body.pinkScore !== null && req.body.pinkScore !== "") {
      judgePink = Number(req.body.pinkScore);
    }

    if (req.body && req.body.judgeBlueScore !== undefined && req.body.judgeBlueScore !== null && req.body.judgeBlueScore !== "") {
      judgeBlue = Number(req.body.judgeBlueScore);
    } else if (req.body && req.body.blueScore !== undefined && req.body.blueScore !== null && req.body.blueScore !== "") {
      judgeBlue = Number(req.body.blueScore);
    }

    let votesToUse = { ...roomState.voting.votes };
    if (req.body && req.body.votes) {
      votesToUse = req.body.votes;
    } else if (judgePink !== pinkCount || judgeBlue !== blueCount) {
      votesToUse = generateRandomVersusVotes(judgePink, judgeBlue);
    }

    const audPink = (roomState.audienceScore && typeof roomState.audienceScore.pink === "number") ? roomState.audienceScore.pink : (req.body && req.body.audiencePinkScore !== undefined ? Number(req.body.audiencePinkScore) : 0);
    const audBlue = (roomState.audienceScore && typeof roomState.audienceScore.blue === "number") ? roomState.audienceScore.blue : (req.body && req.body.audienceBlueScore !== undefined ? Number(req.body.audienceBlueScore) : 0);

    let finalPinkScore = judgePink;
    let finalBlueScore = judgeBlue;
    if (audPink !== 0 || audBlue !== 0) {
      finalPinkScore = Math.round((judgePink + audPink) * 10) / 10;
      finalBlueScore = Math.round((judgeBlue + audBlue) * 10) / 10;
    }

    roomState.stageDisplay = {
      type: "VERSUS_RESULT",
      votes: votesToUse,
      judgePinkScore: judgePink,
      judgeBlueScore: judgeBlue,
      audiencePinkScore: audPink,
      audienceBlueScore: audBlue,
      pinkScore: finalPinkScore,
      blueScore: finalBlueScore,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "SHOW_VERSUS_RESULT",
      payload: roomState.stageDisplay,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: roomState.stageDisplay });
  });

  // REST API: Hiện sự bình chọn của giám khảo bất kỳ
  app.post("/api/display/specific-judges", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    const newJudgeIds = Array.isArray(req.body.judgeIds) ? req.body.judgeIds : [];
    
    let combinedJudgeIds = [];
    if (roomState.stageDisplay && roomState.stageDisplay.type === "SPECIFIC_JUDGES" && Array.isArray(roomState.stageDisplay.judgeIds)) {
      const existingSet = new Set(roomState.stageDisplay.judgeIds.map(Number));
      newJudgeIds.forEach(id => existingSet.add(Number(id)));
      combinedJudgeIds = Array.from(existingSet);
    } else {
      combinedJudgeIds = Array.from(new Set(newJudgeIds.map(Number)));
    }

    let votesToUse = req.body.votes && Object.keys(req.body.votes).length > 0 ? { ...req.body.votes } : { ...roomState.voting.votes };
    if (Object.keys(votesToUse).length === 0) {
      if (roomState.manualScores.normal !== "") {
        votesToUse = generateRandomNormalVotes(Number(roomState.manualScores.normal) || 0);
      } else if (roomState.manualScores.versusPink !== "" || roomState.manualScores.versusBlue !== "") {
        votesToUse = generateRandomVersusVotes(
          Number(roomState.manualScores.versusPink) || 0,
          Number(roomState.manualScores.versusBlue) || 0
        );
      }
      roomState.voting.votes = { ...votesToUse };
    }

    roomState.stageDisplay = {
      type: "SPECIFIC_JUDGES",
      judgeIds: combinedJudgeIds,
      votes: votesToUse,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "SHOW_SPECIFIC_JUDGES",
      payload: roomState.stageDisplay,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: roomState.stageDisplay });
  });

  // REST API: Reset điểm Thường (xóa vote CHON & KHONG_CHON)
  app.post("/api/display/reset-score", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    Object.keys(roomState.voting.votes).forEach((k) => {
      if (roomState.voting.votes[k] === "CHON" || roomState.voting.votes[k] === "KHONG_CHON") {
        delete roomState.voting.votes[k];
      }
    });
    roomState.manualScores.normal = "";
    roomState.stageDisplay = {
      type: "IDLE",
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "RESET_SCORE",
      voting: roomState.voting,
      manualScores: roomState.manualScores,
      serverTime: serverNow,
    });
    res.json({ success: true, voting: roomState.voting, manualScores: roomState.manualScores });
  });

  // REST API: Reset tỉ số Tham khảo / Đối đầu (xóa vote HONG & XANH)
  app.post("/api/display/reset-ref-score", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    Object.keys(roomState.voting.votes).forEach((k) => {
      if (roomState.voting.votes[k] === "HONG" || roomState.voting.votes[k] === "XANH") {
        delete roomState.voting.votes[k];
      }
    });
    roomState.manualScores.versusPink = "";
    roomState.manualScores.versusBlue = "";
    roomState.stageDisplay = {
      type: "IDLE",
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "RESET_REFERENCE_SCORE",
      voting: roomState.voting,
      manualScores: roomState.manualScores,
      serverTime: serverNow,
    });
    res.json({ success: true, voting: roomState.voting, manualScores: roomState.manualScores });
  });

  // REST API: Cập nhật điểm nhập chay tự động
  app.post("/api/scores/manual", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    if (req.body) {
      if (req.body.normal !== undefined) roomState.manualScores.normal = req.body.normal;
      if (req.body.versusPink !== undefined) roomState.manualScores.versusPink = req.body.versusPink;
      if (req.body.versusBlue !== undefined) roomState.manualScores.versusBlue = req.body.versusBlue;

      if (req.body.votes && Object.keys(req.body.votes).length > 0) {
        roomState.voting.votes = { ...req.body.votes };
      } else if (req.body.normal !== undefined && req.body.normal !== "") {
        roomState.voting.votes = generateRandomNormalVotes(Number(req.body.normal) || 0);
      } else if ((req.body.versusPink !== undefined && req.body.versusPink !== "") || (req.body.versusBlue !== undefined && req.body.versusBlue !== "")) {
        roomState.voting.votes = generateRandomVersusVotes(
          Number(roomState.manualScores.versusPink) || 0,
          Number(roomState.manualScores.versusBlue) || 0
        );
      }
    }
    broadcastToRoom(roomId, {
      type: "MANUAL_SCORES_UPDATED",
      manualScores: roomState.manualScores,
      voting: roomState.voting,
      serverTime: Date.now(),
    });
    res.json({ success: true, manualScores: roomState.manualScores, voting: roomState.voting });
  });

  // REST API: Reset tỉ số Khán giả
  app.post("/api/display/reset-audience-score", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    roomState.audienceScore = { pink: 0, blue: 0 };
    roomState.stageDisplay = {
      type: "IDLE",
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "RESET_AUDIENCE_SCORE",
      audienceScore: roomState.audienceScore,
      serverTime: serverNow,
    });
    res.json({ success: true, audienceScore: roomState.audienceScore });
  });

  // REST API: Hiện tỉ số tham khảo trên Index
  app.post("/api/display/reference", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    let pinkCount = 0;
    let blueCount = 0;

    if (req.body && req.body.pink !== undefined && req.body.pink !== "") {
      pinkCount = Number(req.body.pink) || 0;
    } else if (req.body && req.body.scoreA !== undefined && req.body.scoreA !== "") {
      pinkCount = Number(req.body.scoreA) || 0;
    } else if (roomState.manualScores.versusPink !== "") {
      pinkCount = Number(roomState.manualScores.versusPink) || 0;
    } else {
      Object.values(roomState.voting.votes).forEach((v) => {
        if (v === "HONG") pinkCount++;
      });
    }

    if (req.body && req.body.blue !== undefined && req.body.blue !== "") {
      blueCount = Number(req.body.blue) || 0;
    } else if (req.body && req.body.scoreB !== undefined && req.body.scoreB !== "") {
      blueCount = Number(req.body.scoreB) || 0;
    } else if (roomState.manualScores.versusBlue !== "") {
      blueCount = Number(roomState.manualScores.versusBlue) || 0;
    } else {
      Object.values(roomState.voting.votes).forEach((v) => {
        if (v === "XANH") blueCount++;
      });
    }

    roomState.stageDisplay = {
      type: "REFERENCE_SCORE",
      scoreA: pinkCount,
      scoreB: blueCount,
      pink: pinkCount,
      blue: blueCount,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "SHOW_REFERENCE_SCORE",
      payload: roomState.stageDisplay,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: roomState.stageDisplay });
  });

  // REST API: Lưu tỉ số khán giả
  app.post("/api/audience/set", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const { pink, blue } = req.body;
    const pinkVal = Math.round((Number(pink) || 0) * 10) / 10;
    const blueVal = Math.round((Number(blue) || 0) * 10) / 10;
    const sum = Math.round((pinkVal + blueVal) * 10) / 10;

    if (sum !== 100 && sum !== 0) {
      return res.status(400).json({
        success: false,
        error: `Tổng tỉ số khán giả Hồng (${pinkVal}) + Xanh (${blueVal}) = ${sum}. Bắt buộc tổng phải bằng 100 hoặc 0!`
      });
    }

    roomState.audienceScore = {
      pink: pinkVal,
      blue: blueVal,
    };
    broadcastToRoom(roomId, {
      type: "AUDIENCE_SCORE_UPDATED",
      audienceScore: roomState.audienceScore,
      serverTime: Date.now(),
    });
    res.json({ success: true, audienceScore: roomState.audienceScore });
  });

  // REST API: Hiện tỉ số khán giả trên Index
  app.post("/api/display/audience", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    roomState.stageDisplay = {
      type: "AUDIENCE_SCORE",
      pink: roomState.audienceScore.pink,
      blue: roomState.audienceScore.blue,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "SHOW_AUDIENCE_SCORE",
      payload: roomState.stageDisplay,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: roomState.stageDisplay });
  });

  // REST API: Xóa / Ẩn hiển thị kết quả
  app.post("/api/display/clear", (req, res) => {
    const roomId = getReqRoomId(req);
    const roomState = getOrCreateRoom(roomId);
    const serverNow = Date.now();
    roomState.stageDisplay = {
      type: "IDLE",
      timestamp: serverNow,
    };
    broadcastToRoom(roomId, {
      type: "CLEAR_STAGE_DISPLAY",
      serverTime: serverNow,
    });
    res.json({ success: true });
  });

  // Server-Sent Events (SSE) fallback
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({ type: "STATE_SYNC", state: currentState, serverTime: Date.now(), clientsCount: clients.size });

    const interval = setInterval(() => {
      sendEvent({ type: "HEARTBEAT", serverTime: Date.now(), clientsCount: clients.size });
    }, 15000);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  // Định tuyến linh hoạt cho các file HTML
  app.get(["/", "/index", "/index.html"], (_req, res) => {
    const filePath = findHtmlFile("index");
    if (filePath) return res.sendFile(filePath);
    res.status(404).send("Không tìm thấy file index.html");
  });

  app.get(["/controller", "/controller.html", "/Controller", "/Controller.html"], (_req, res) => {
    const filePath = findHtmlFile("Controller");
    if (filePath) return res.sendFile(filePath);
    res.status(404).send("Không tìm thấy file Controller.html");
  });

  app.get(["/judge", "/judge.html", "/Judge", "/Judge.html"], (_req, res) => {
    const filePath = findHtmlFile("Judge");
    if (filePath) return res.sendFile(filePath);
    res.status(404).send("Không tìm thấy file Judge.html");
  });

  app.get("/:filename", (req, res, next) => {
    const filename = req.params.filename;
    if (filename.startsWith("api") || filename.startsWith("ws") || filename.startsWith("audio")) {
      return next();
    }
    const filePath = findHtmlFile(filename);
    if (filePath) return res.sendFile(filePath);
    next();
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "mpa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`=======================================================`);
    console.log(`🌍 [Stage 101 Server] ĐỒNG BỘ TOÀN CẦU (NTP Clock Sync)`);
    console.log(`🚀 Port: ${PORT}`);
    console.log(`🖥️ Sân Khấu:   http://localhost:${PORT}/index.html`);
    console.log(`🎛️ Điều Khiển: http://localhost:${PORT}/Controller.html`);
    console.log(`🌐 Render:     https://thewinneris.onrender.com`);
    console.log(`=======================================================`);
  });
}

startServer().catch((err) => {
  console.error("Lỗi khởi động server:", err);
});
