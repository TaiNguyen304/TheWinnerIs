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
  3: { duration: 13, loopDuration: 3.25, sound: "Judge_Vote.mp3", name: "Hiệu ứng 3 (Judge Vote - 13s)" },
  4: { duration: 5, loopDuration: 1.25, sound: "Result.mp3", name: "Hiệu ứng 4 (Result - 5s)" },
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
              effect: effectNum,
              action: "start",
              duration: config.duration,
              loopDuration: config.loopDuration || 0,
              soundTrack: config.sound,
              serverStartTime: serverNow,
              timestamp: serverNow,
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
            effect: null,
            action: "stop",
            duration: 0,
            loopDuration: 0,
            soundTrack: "",
            serverStartTime: serverNow,
            timestamp: serverNow,
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
            effect: null,
            action: "reset",
            mode: data.mode || "white",
            duration: 0,
            loopDuration: 0,
            soundTrack: "",
            serverStartTime: serverNow,
            timestamp: serverNow,
          };
          broadcast({
            type: "RESET",
            state: currentState,
            serverTime: serverNow,
            clientsCount: clients.size,
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
      effect: null,
      action: "reset",
      mode: req.body.mode || "white",
      duration: 0,
      loopDuration: 0,
      soundTrack: "",
      serverStartTime: serverNow,
      timestamp: serverNow,
    };

    broadcast({
      type: "RESET",
      state: currentState,
      serverTime: serverNow,
      clientsCount: clients.size,
    });

    res.json({ success: true, state: currentState, serverTime: serverNow });
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
