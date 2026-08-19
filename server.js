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

// Tạo mã phòng ngẫu nhiên 6 chữ số
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

let currentRoomCode = "101101"; // Mặc định 6 chữ số

// Trạng thái bình chọn của Ban Giám Khảo (1 - 101)
// Mode: 'LOCKED' | 'NORMAL' (Chọn / Không chọn) | 'VERSUS' (Màu xanh / Màu hồng)
let votingState = {
  roomId: currentRoomCode,
  mode: "LOCKED", // 'LOCKED' | 'NORMAL' | 'VERSUS'
  votes: {}, // { [seatId]: 'CHON' | 'KHONG_CHON' | 'XANH' | 'HONG' }
  connectedJudges: {}, // { [seatId]: { name, connectedAt } }
};

// Tỉ số khán giả nhập vào
let audienceScore = {
  pink: 0,
  blue: 0,
};

// Trạng thái hiển thị đặc biệt trên index.html
// type: 'IDLE' | 'NORMAL_RESULT' | 'VERSUS_RESULT' | 'REFERENCE_SCORE' | 'AUDIENCE_SCORE'
let stageDisplayState = {
  type: "IDLE",
  payload: {},
  timestamp: Date.now(),
};

// Trạng thái chuẩn từ Server làm chuẩn cho tất cả máy khách trên thế giới
let currentState = {
  effect: null,
  action: "reset",
  duration: 0,
  loopDuration: 0,
  soundTrack: "",
  serverStartTime: 0, // Thời gian server chuẩn (timestamp UTC)
  timestamp: Date.now(),
  roomCode: currentRoomCode,
  voting: votingState,
  audienceScore,
  stageDisplay: stageDisplayState,
};

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

  const broadcast = (data) => {
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
    console.log(`[WS] Máy khách mới kết nối từ: ${clientIp} (Tổng máy đang online: ${clients.size})`);

    // Gửi ngay trạng thái hiện tại và thời gian server chuẩn
    ws.send(
      JSON.stringify({
        type: "STATE_SYNC",
        state: currentState,
        serverTime: Date.now(),
        clientsCount: clients.size,
      })
    );

    broadcast({ type: "CLIENTS_COUNT", count: clients.size });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        // Giao thức NTP thu nhỏ: Đồng bộ giờ chính xác mili-giây giữa các châu lục
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

        if (data.type === "TRIGGER_EFFECT") {
          const effectNum = Number(data.effect);
          const config = EFFECT_CONFIGS[effectNum];
          if (config) {
            const serverNow = Date.now();
            currentState = {
              ...currentState,
              effect: effectNum,
              action: "start",
              duration: config.duration,
              loopDuration: config.loopDuration || 0,
              soundTrack: config.sound,
              serverStartTime: serverNow,
              timestamp: serverNow,
              stageDisplay: { type: "EFFECT", effect: effectNum, timestamp: serverNow },
            };
            console.log(`[Server] KÍCH HOẠT HIỆU ỨNG ${effectNum} -> Đồng bộ tới ${clients.size} máy`);
            broadcast({
              type: "EFFECT_TRIGGERED",
              state: currentState,
              serverTime: serverNow,
              clientsCount: clients.size,
            });
          }
        } else if (data.type === "STOP_EFFECT") {
          const serverNow = Date.now();
          currentState = {
            ...currentState,
            effect: null,
            action: "stop",
            duration: 0,
            loopDuration: 0,
            soundTrack: "",
            serverStartTime: serverNow,
            timestamp: serverNow,
            stageDisplay: { type: "IDLE", timestamp: serverNow },
          };
          console.log(`[Server] DỪNG HIỆU ỨNG -> Đồng bộ tới ${clients.size} máy`);
          broadcast({
            type: "EFFECT_STOPPED",
            state: currentState,
            serverTime: serverNow,
            clientsCount: clients.size,
          });
        } else if (data.type === "RESET") {
          const serverNow = Date.now();
          currentState = {
            ...currentState,
            effect: null,
            action: "reset",
            mode: data.mode || "white",
            duration: 0,
            loopDuration: 0,
            soundTrack: "",
            serverStartTime: serverNow,
            timestamp: serverNow,
            stageDisplay: { type: "IDLE", mode: data.mode || "white", timestamp: serverNow },
          };
          broadcast({
            type: "RESET",
            state: currentState,
            serverTime: serverNow,
            clientsCount: clients.size,
          });
        } else if (data.type === "CREATE_ROOM") {
          currentRoomCode = generateRoomCode();
          votingState = {
            roomId: currentRoomCode,
            mode: "LOCKED",
            votes: {},
            connectedJudges: {},
          };
          currentState.roomCode = currentRoomCode;
          currentState.voting = votingState;
          console.log(`[Room] Tạo mã phòng mới: ${currentRoomCode}`);
          broadcast({
            type: "ROOM_UPDATED",
            roomCode: currentRoomCode,
            voting: votingState,
            serverTime: Date.now(),
          });
        } else if (data.type === "SET_VOTING_MODE") {
          const newMode = data.mode; // 'NORMAL' | 'VERSUS' | 'LOCKED'
          votingState.mode = newMode;
          // Nếu chuyển chế độ mới, có thể reset lượt vote trước đó nếu yêu cầu
          if (data.resetVotes) {
            votingState.votes = {};
          }
          currentState.voting = votingState;
          console.log(`[Voting] Chuyển chế độ bình chọn: ${newMode}`);
          broadcast({
            type: "VOTING_MODE_CHANGED",
            mode: newMode,
            voting: votingState,
            serverTime: Date.now(),
          });
        } else if (data.type === "CAST_VOTE") {
          const { roomId, seatId, vote } = data;
          if (roomId === currentRoomCode && seatId >= 1 && seatId <= 101) {
            votingState.votes[seatId] = vote;
            currentState.voting = votingState;
            console.log(`[Vote] Ghế #${seatId} đã chọn: ${vote} (Phòng ${roomId})`);
            broadcast({
              type: "VOTE_CAST",
              seatId,
              vote,
              voting: votingState,
              serverTime: Date.now(),
            });
          }
        } else if (data.type === "SHOW_NORMAL_RESULT") {
          const serverNow = Date.now();
          let chonCount = 0;
          Object.values(votingState.votes).forEach((v) => {
            if (v === "CHON") chonCount++;
          });
          stageDisplayState = {
            type: "NORMAL_RESULT",
            votes: { ...votingState.votes },
            totalScore: chonCount,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "SHOW_NORMAL_RESULT",
            payload: stageDisplayState,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_VERSUS_RESULT") {
          const serverNow = Date.now();
          let pinkCount = 0;
          let blueCount = 0;
          Object.values(votingState.votes).forEach((v) => {
            if (v === "HONG") pinkCount++;
            if (v === "XANH") blueCount++;
          });
          const pinkScore = (data.pinkScore !== undefined && data.pinkScore !== null && data.pinkScore !== "")
            ? Number(data.pinkScore)
            : pinkCount;
          const blueScore = (data.blueScore !== undefined && data.blueScore !== null && data.blueScore !== "")
            ? Number(data.blueScore)
            : blueCount;

          stageDisplayState = {
            type: "VERSUS_RESULT",
            votes: { ...votingState.votes },
            pinkScore,
            blueScore,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "SHOW_VERSUS_RESULT",
            payload: stageDisplayState,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_SPECIFIC_JUDGES") {
          const serverNow = Date.now();
          const judgeIds = Array.isArray(data.judgeIds) ? data.judgeIds : [];
          stageDisplayState = {
            type: "SPECIFIC_JUDGES",
            judgeIds,
            votes: { ...votingState.votes },
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "SHOW_SPECIFIC_JUDGES",
            payload: stageDisplayState,
            serverTime: serverNow,
          });
        } else if (data.type === "RESET_SCORE") {
          const serverNow = Date.now();
          stageDisplayState = {
            type: "IDLE",
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "RESET_SCORE",
            serverTime: serverNow,
          });
        } else if (data.type === "RESET_REFERENCE_SCORE") {
          const serverNow = Date.now();
          stageDisplayState = {
            type: "IDLE",
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "RESET_REFERENCE_SCORE",
            serverTime: serverNow,
          });
        } else if (data.type === "RESET_AUDIENCE_SCORE") {
          audienceScore = { pink: 0, blue: 0 };
          currentState.audienceScore = audienceScore;
          const serverNow = Date.now();
          stageDisplayState = {
            type: "IDLE",
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "RESET_AUDIENCE_SCORE",
            audienceScore,
            serverTime: serverNow,
          });
        } else if (data.type === "SHOW_REFERENCE_SCORE") {
          const serverNow = Date.now();
          let pinkCount = 0;
          let blueCount = 0;
          Object.values(votingState.votes).forEach((v) => {
            if (v === "HONG") pinkCount++;
            if (v === "XANH") blueCount++;
          });
          stageDisplayState = {
            type: "REFERENCE_SCORE",
            scoreA: pinkCount,
            scoreB: blueCount,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "SHOW_REFERENCE_SCORE",
            payload: stageDisplayState,
            serverTime: serverNow,
          });
        } else if (data.type === "SET_AUDIENCE_SCORE") {
          audienceScore = {
            pink: Number(data.pink) || 0,
            blue: Number(data.blue) || 0,
          };
          currentState.audienceScore = audienceScore;
          broadcast({
            type: "AUDIENCE_SCORE_UPDATED",
            audienceScore,
            serverTime: Date.now(),
          });
        } else if (data.type === "SHOW_AUDIENCE_SCORE") {
          const serverNow = Date.now();
          stageDisplayState = {
            type: "AUDIENCE_SCORE",
            pink: audienceScore.pink,
            blue: audienceScore.blue,
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
            type: "SHOW_AUDIENCE_SCORE",
            payload: stageDisplayState,
            serverTime: serverNow,
          });
        } else if (data.type === "CLEAR_STAGE_DISPLAY") {
          const serverNow = Date.now();
          stageDisplayState = {
            type: "IDLE",
            timestamp: serverNow,
          };
          currentState.stageDisplay = stageDisplayState;
          broadcast({
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
      broadcast({ type: "CLIENTS_COUNT", count: clients.size });
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  // REST API: Lấy trạng thái hiện tại (kèm serverTime để bù độ lệch múi giờ của client)
  app.get("/api/state", (_req, res) => {
    res.json({
      state: currentState,
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
    const effectNum = Number(req.body.effect);
    const config = EFFECT_CONFIGS[effectNum];
    if (!config) {
      return res.status(400).json({ error: "Số hiệu ứng không hợp lệ" });
    }

    const serverNow = Date.now();
    currentState = {
      effect: effectNum,
      action: "start",
      duration: config.duration,
      loopDuration: config.loopDuration || 0,
      soundTrack: config.sound,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };

    broadcast({
      type: "EFFECT_TRIGGERED",
      state: currentState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: currentState, serverTime: serverNow });
  });

  // REST API: Dừng hiệu ứng
  app.post("/api/stop", (_req, res) => {
    const serverNow = Date.now();
    currentState = {
      effect: null,
      action: "stop",
      duration: 0,
      loopDuration: 0,
      soundTrack: "",
      serverStartTime: serverNow,
      timestamp: serverNow,
    };

    broadcast({
      type: "EFFECT_STOPPED",
      state: currentState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: currentState, serverTime: serverNow });
  });

  // REST API: Đặt lại trạng thái
  app.post("/api/reset", (req, res) => {
    const serverNow = Date.now();
    currentState = {
      ...currentState,
      effect: null,
      action: "reset",
      mode: req.body.mode || "white",
      duration: 0,
      loopDuration: 0,
      soundTrack: "",
      serverStartTime: serverNow,
      timestamp: serverNow,
      stageDisplay: { type: "IDLE", mode: req.body.mode || "white", timestamp: serverNow },
    };

    broadcast({
      type: "RESET",
      state: currentState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: currentState, serverTime: serverNow });
  });

  // REST API: Tạo mã phòng mới (6 chữ số)
  app.post("/api/room/create", (_req, res) => {
    currentRoomCode = generateRoomCode();
    votingState = {
      roomId: currentRoomCode,
      mode: "LOCKED",
      votes: {},
      connectedJudges: {},
    };
    currentState.roomCode = currentRoomCode;
    currentState.voting = votingState;
    console.log(`[Room REST] Tạo mã phòng mới: ${currentRoomCode}`);
    broadcast({
      type: "ROOM_UPDATED",
      roomCode: currentRoomCode,
      voting: votingState,
      serverTime: Date.now(),
    });
    res.json({ success: true, roomCode: currentRoomCode, voting: votingState });
  });

  // REST API: Kiểm tra mã phòng và đăng nhập Judge
  app.post("/api/room/verify", (req, res) => {
    const { roomId, seatId } = req.body;
    const seatNum = Number(seatId);
    if (!roomId || roomId.toString() !== currentRoomCode.toString()) {
      return res.status(400).json({ success: false, error: "Mã phòng không chính xác!" });
    }
    if (!seatNum || seatNum < 1 || seatNum > 101) {
      return res.status(400).json({ success: false, error: "Vị trí không hợp lệ (Phải từ 1 đến 101)!" });
    }
    res.json({
      success: true,
      roomCode: currentRoomCode,
      seatId: seatNum,
      votingMode: votingState.mode,
      currentVote: votingState.votes[seatNum] || null,
    });
  });

  // REST API: Đặt chế độ bình chọn (NORMAL | VERSUS | LOCKED)
  app.post("/api/voting/mode", (req, res) => {
    const { mode, resetVotes } = req.body;
    if (!["NORMAL", "VERSUS", "LOCKED"].includes(mode)) {
      return res.status(400).json({ error: "Chế độ bình chọn không hợp lệ" });
    }
    votingState.mode = mode;
    if (resetVotes) {
      votingState.votes = {};
    }
    currentState.voting = votingState;
    broadcast({
      type: "VOTING_MODE_CHANGED",
      mode,
      voting: votingState,
      serverTime: Date.now(),
    });
    res.json({ success: true, mode, voting: votingState });
  });

  // REST API: Gửi bình chọn từ Judge
  app.post("/api/voting/vote", (req, res) => {
    const { roomId, seatId, vote } = req.body;
    const seatNum = Number(seatId);
    if (roomId !== currentRoomCode) {
      return res.status(400).json({ error: "Sai mã phòng" });
    }
    if (seatNum < 1 || seatNum > 101) {
      return res.status(400).json({ error: "Vị trí không hợp lệ" });
    }
    if (votingState.mode === "LOCKED") {
      return res.status(400).json({ error: "Bình chọn đang bị khóa" });
    }
    votingState.votes[seatNum] = vote;
    currentState.voting = votingState;
    broadcast({
      type: "VOTE_CAST",
      seatId: seatNum,
      vote,
      voting: votingState,
      serverTime: Date.now(),
    });
    res.json({ success: true, seatId: seatNum, vote, voting: votingState });
  });

  // REST API: Hiện kết quả Thường trên Index
  app.post("/api/display/normal", (_req, res) => {
    const serverNow = Date.now();
    let chonCount = 0;
    Object.values(votingState.votes).forEach((v) => {
      if (v === "CHON") chonCount++;
    });
    stageDisplayState = {
      type: "NORMAL_RESULT",
      votes: { ...votingState.votes },
      totalScore: chonCount,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    currentState.stageDisplay = stageDisplayState;
    broadcast({
      type: "SHOW_NORMAL_RESULT",
      payload: stageDisplayState,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: stageDisplayState });
  });

  // REST API: Hiện kết quả Đối đầu trên Index
  app.post("/api/display/versus", (_req, res) => {
    const serverNow = Date.now();
    let pinkCount = 0;
    let blueCount = 0;
    Object.values(votingState.votes).forEach((v) => {
      if (v === "HONG") pinkCount++;
      if (v === "XANH") blueCount++;
    });
    stageDisplayState = {
      type: "VERSUS_RESULT",
      votes: { ...votingState.votes },
      pinkScore: pinkCount,
      blueScore: blueCount,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    currentState.stageDisplay = stageDisplayState;
    broadcast({
      type: "SHOW_VERSUS_RESULT",
      payload: stageDisplayState,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: stageDisplayState });
  });

  // REST API: Hiện tỉ số tham khảo trên Index
  app.post("/api/display/reference", (_req, res) => {
    const serverNow = Date.now();
    let pinkCount = 0;
    let blueCount = 0;
    Object.values(votingState.votes).forEach((v) => {
      if (v === "HONG") pinkCount++;
      if (v === "XANH") blueCount++;
    });
    stageDisplayState = {
      type: "REFERENCE_SCORE",
      scoreA: pinkCount,
      scoreB: blueCount,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    currentState.stageDisplay = stageDisplayState;
    broadcast({
      type: "SHOW_REFERENCE_SCORE",
      payload: stageDisplayState,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: stageDisplayState });
  });

  // REST API: Lưu tỉ số khán giả
  app.post("/api/audience/set", (req, res) => {
    const { pink, blue } = req.body;
    audienceScore = {
      pink: Number(pink) || 0,
      blue: Number(blue) || 0,
    };
    currentState.audienceScore = audienceScore;
    broadcast({
      type: "AUDIENCE_SCORE_UPDATED",
      audienceScore,
      serverTime: Date.now(),
    });
    res.json({ success: true, audienceScore });
  });

  // REST API: Hiện tỉ số khán giả trên Index
  app.post("/api/display/audience", (_req, res) => {
    const serverNow = Date.now();
    stageDisplayState = {
      type: "AUDIENCE_SCORE",
      pink: audienceScore.pink,
      blue: audienceScore.blue,
      serverStartTime: serverNow,
      timestamp: serverNow,
    };
    currentState.stageDisplay = stageDisplayState;
    broadcast({
      type: "SHOW_AUDIENCE_SCORE",
      payload: stageDisplayState,
      serverTime: serverNow,
    });
    res.json({ success: true, stageDisplay: stageDisplayState });
  });

  // REST API: Xóa / Ẩn hiển thị kết quả
  app.post("/api/display/clear", (_req, res) => {
    const serverNow = Date.now();
    stageDisplayState = {
      type: "IDLE",
      timestamp: serverNow,
    };
    currentState.stageDisplay = stageDisplayState;
    broadcast({
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
