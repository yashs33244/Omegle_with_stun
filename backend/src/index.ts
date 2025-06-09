import { Socket } from "socket.io";
import http from "http";

import express from 'express';
import { Server } from 'socket.io';
import { UserManager } from "./managers/UserManger";

const app = express();
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

server.listen(3001, () => {
    console.log('Server listening on port 3001');
    console.log('Frontend should connect to: http://localhost:3001');
});