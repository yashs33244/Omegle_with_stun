import { Socket } from "socket.io";
import http from "http";

import express from 'express';
import { Server } from 'socket.io';
import { UserManager } from "./managers/UserManger";

const app = express();

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// CORS middleware for REST endpoints
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const userManager = new UserManager();

io.on('connection', (socket: Socket) => {
  console.log(`User connected: ${socket.id}`);

  userManager.addUser("randomName", socket);

  socket.on("disconnect", (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    userManager.removeUser(socket.id);
  });

  // Handle manual home navigation (when user clicks home button)
  socket.on("leave-room", () => {
    console.log(`User ${socket.id} manually left room`);
    userManager.removeUser(socket.id);
    userManager.addUser("randomName", socket); // Re-add to lobby
  });
});

const PORT = process.env.PORT || 3004;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Frontend should connect to: http://localhost:${PORT}`);
  console.log(`Health check available at: http://localhost:${PORT}/health`);
});