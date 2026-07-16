const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static web assets from the "public" folder
app.use(express.static("public"));

// In-memory state store for active room sessions
const rooms = {};

// Helper: Initialize state for a new room
function createGameState() {
    return {
        discardPile: [],
        players: [], // Array of socket IDs tracking join order
        scores: {},  // Tracks points per socket ID
        activeTurnIndex: 0,
        status: "waiting", // "waiting" | "playing" | "finished"
        winner: null
    };
}

// Helper: Filter state to send only necessary info to clients
function getPublicState(room) {
    return {
        status: room.status,
        activePlayer: room.players[room.activeTurnIndex] || null,
        playerCount: room.players.length,
        discardPile: room.discardPile,
        scores: room.scores,
        winner: room.winner
    };
}

io.on("connection", (socket) => {
    console.log("A player connected:", socket.id);

    // Step 15-17: Handle room joining & state isolation
    socket.on("joinRoom", (roomCode) => {
        socket.join(roomCode);
        
        // Attach roomCode to socket object for easy lookup on disconnect
        socket.currentRoom = roomCode;

        if (!rooms[roomCode]) {
            rooms[roomCode] = createGameState();
        }

        const room = rooms[roomCode];

        if (!room.players.includes(socket.id)) {
            room.players.push(socket.id);
            room.scores[socket.id] = 0;
        }

        // Start game session when 2 players connect
        if (room.players.length >= 2 && room.status === "waiting") {
            room.status = "playing";
        }

        // Broadcast updated state to room members
        io.to(roomCode).emit("gameStateUpdate", getPublicState(room));
    });

    // Step 18-24: Validate moves, manage turn order, and evaluate win condition
    socket.on("playCard", (data) => {
        const { roomCode, card } = data;
        const room = rooms[roomCode];

        if (!room || room.status !== "playing") {
            socket.emit("moveRejected", "Game is not active!");
            return;
        }

        // Enforce strict turn order
        const activePlayerId = room.players[room.activeTurnIndex];
        if (socket.id !== activePlayerId) {
            socket.emit("moveRejected", "It is not your turn!");
            return;
        }

        // Accept move and update server state
        room.discardPile.push({ playedBy: socket.id, card: card });
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

        // Evaluate Victory Condition (First to 3 points wins)
        if (room.scores[socket.id] >= 3) {
            room.status = "finished";
            room.winner = socket.id;

            console.log(`🏆 Game Over in room ${roomCode}! Winner: ${socket.id}`);

            io.to(roomCode).emit("gameStateUpdate", getPublicState(room));
            io.to(roomCode).emit("gameOver", { winnerId: socket.id });
            return;
        }

        // Rotate turn to next player
        room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
        io.to(roomCode).emit("gameStateUpdate", getPublicState(room));
    });

    // Step 25: Handle player disconnections & room cleanup
    socket.on("disconnect", () => {
        console.log("A player disconnected:", socket.id);

        const roomCode = socket.currentRoom;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];

        // Remove player from active room state
        room.players = room.players.filter(id => id !== socket.id);
        delete room.scores[socket.id];

        // Notify remaining room members
        io.to(roomCode).emit("playerDisconnected", {
            disconnectedPlayerId: socket.id
        });

        // Pause match if player count drops below 2
        if (room.players.length < 2 && room.status === "playing") {
            room.status = "waiting";
            room.activeTurnIndex = 0;
            io.to(roomCode).emit("gameStateUpdate", getPublicState(room));
        }

        // Delete empty rooms from server memory
        if (room.players.length === 0) {
            delete rooms[roomCode];
            console.log(`Room ${roomCode} emptied and deleted from server memory.`);
        }
    });
});

// Step 26: Dynamic port binding for Cloud Hosts (Render/Railway/Heroku)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ChromaClash server running on port ${PORT}`);
});