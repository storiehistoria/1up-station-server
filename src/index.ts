import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import cors from "cors";
import http from "http";
import { LobbyRoom } from "./rooms/LobbyRoom";

const port = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const httpServer = http.createServer(app);

const server = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

server.define("lobby", LobbyRoom);

server.listen(port).then(() => {
  console.log(`1UP Station server listening on port ${port}`);
});
