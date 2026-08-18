import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình các hiệu ứng theo yêu cầu
const EFFECT_CONFIGS = {
  1: { duration: 26, sound: "Opening.mp3", name: "Hiệu ứng 1 (Opening - 26s)" },
  2: { duration: 40, sound: "Contestant.mp3", name: "Hiệu ứng 2 (Contestant - 40s)" },
  3: { duration: 13, loopDuration: 3.25, sound: "Judge_Vote.mp3", name: "Hiệu ứng 3 (Judge Vote - 13s)" },
  4: { duration: 5, loopDuration: 1.25, sound: "Result.mp3", name: "Hiệu ứng 4 (Result - 5s)" },
};

let currentState = {
  effect: null,
  action: "reset",
  duration: 0,
  soundTrack: "",
  startTime: 0,
  timestamp: Date.now(),
};

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);

  app.use(express.json());

  // Thư mục chứa tài nguyên tĩnh và âm thanh
  const publicDir = path.join(__dirname, "public");
  const audioDir = path.join(publicDir, "audio");
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  app.use(express.static(publicDir));
  app.use("/audio", express.static(audioDir));

  // Thiết lập WebSocket Server
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

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Gửi trạng thái hiện tại và số lượng thiết bị kết nối
    ws.send(JSON.stringify({ type: "STATE_SYNC", state: currentState, clientsCount: clients.size }));
    broadcast({ type: "CLIENTS_COUNT", count: clients.size });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "TRIGGER_EFFECT") {
          const effectNum = Number(data.effect);
          const config = EFFECT_CONFIGS[effectNum];
          if (config) {
            currentState = {
              effect: effectNum,
              action: "start",
              duration: config.duration,
              loopDuration: config.loopDuration,
              soundTrack: config.sound,
              startTime: Date.now(),
              timestamp: Date.now(),
            };
            broadcast({ type: "EFFECT_TRIGGERED", state: currentState });
          }
        } else if (data.type === "STOP_EFFECT") {
          currentState = {
            effect: null,
            action: "stop",
            duration: 0,
            soundTrack: "",
            startTime: Date.now(),
            timestamp: Date.now(),
          };
          broadcast({ type: "EFFECT_STOPPED", state: currentState });
        } else if (data.type === "RESET") {
          currentState = {
            effect: null,
            action: "reset",
            duration: 0,
            soundTrack: "",
            startTime: Date.now(),
            timestamp: Date.now(),
          };
          broadcast({ type: "RESET", state: currentState });
        } else if (data.type === "PING") {
          ws.send(JSON.stringify({ type: "PONG", time: Date.now() }));
        }
      } catch (err) {
        console.error("[WS] Lỗi xử lý message:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      broadcast({ type: "CLIENTS_COUNT", count: clients.size });
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  // REST API: Lấy trạng thái hiện tại
  app.get("/api/state", (_req, res) => {
    res.json({
      state: currentState,
      clientsCount: clients.size,
      serverTime: Date.now(),
      effects: EFFECT_CONFIGS,
    });
  });

  // REST API: Kích hoạt hiệu ứng (1, 2, 3, 4)
  app.post("/api/trigger", (req, res) => {
    const effectNum = Number(req.body.effect);
    const config = EFFECT_CONFIGS[effectNum];
    if (!config) {
      return res.status(400).json({ error: "Số hiệu ứng không hợp lệ (chọn 1, 2, 3 hoặc 4)" });
    }

    currentState = {
      effect: effectNum,
      action: "start",
      duration: config.duration,
      loopDuration: config.loopDuration,
      soundTrack: config.sound,
      startTime: Date.now(),
      timestamp: Date.now(),
    };

    broadcast({ type: "EFFECT_TRIGGERED", state: currentState });
    res.json({ success: true, state: currentState });
  });

  // REST API: Dừng hiệu ứng
  app.post("/api/stop", (_req, res) => {
    currentState = {
      effect: null,
      action: "stop",
      duration: 0,
      soundTrack: "",
      startTime: Date.now(),
      timestamp: Date.now(),
    };
    broadcast({ type: "EFFECT_STOPPED", state: currentState });
    res.json({ success: true, state: currentState });
  });

  // REST API: Đặt lại trạng thái
  app.post("/api/reset", (_req, res) => {
    currentState = {
      effect: null,
      action: "reset",
      duration: 0,
      soundTrack: "",
      startTime: Date.now(),
      timestamp: Date.now(),
    };
    broadcast({ type: "RESET", state: currentState });
    res.json({ success: true, state: currentState });
  });

  // Server-Sent Events (SSE) stream fallback
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({ type: "STATE_SYNC", state: currentState });

    const interval = setInterval(() => {
      sendEvent({ type: "HEARTBEAT", time: Date.now() });
    }, 15000);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  // Route phục vụ Controller.html
  app.get(["/controller", "/Controller.html"], (_req, res) => {
    const isProd = process.env.NODE_ENV === "production";
    const filePath = isProd
      ? path.join(__dirname, "dist", "Controller.html")
      : path.join(__dirname, "Controller.html");
    res.sendFile(filePath);
  });

  // Tích hợp Vite middleware ở chế độ phát triển hoặc phục vụ file tĩnh ở chế độ production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "mpa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[NodeJS JavaScript Server] Stage 101 chạy tại: http://0.0.0.0:${PORT}`);
    console.log(`[Màn Hình Sân Khấu]: http://localhost:${PORT}/index.html`);
    console.log(`[Bảng Điều Khiển]:  http://localhost:${PORT}/Controller.html`);
  });
}

startServer().catch((err) => {
  console.error("Khởi động server thất bại:", err);
});
