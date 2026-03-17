import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LobbyRoom } from "./rooms/LobbyRoom";

const port = Number(process.env.PORT) || 2567;

const transport = new WebSocketTransport();

const server = new Server({
  transport,
  express: (app) => {
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });
  },
});

server.define("lobby", LobbyRoom);

server.listen(port).then(() => {
  console.log(`1UP Station server listening on port ${port}`);
});
