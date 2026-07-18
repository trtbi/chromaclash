const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));
const rooms = {};
const COLORS = [
    { key: "red", label: "Red" },
    { key: "orange", label: "Orange" },
    { key: "yellow", label: "Yellow" },
    { key: "green", label: "Green" },
    { key: "pink", label: "Pink" },
    { key: "white", label: "White" },
    { key: "black", label: "Black" },
    { key: "teal", label: "Teal" }
];
function buildDeck() {
    const deck = [];
    COLORS.forEach((c) => {
        for (let n = 0; n <= 9; n++) {
            deck.push({ id: `${c.key}-${n}`, color: c.key, num: n });
        }
    });
    return shuffle(deck);
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
function createGameState(roomCode) {
    return {
        roomCode,
        status: "waiting", // 'waiting' | 'playing' | 'finished'
        draw: buildDeck(),
        discard: [],
        players: [], // { id, name, hand: [], score, usedSwapLastTurn, usedPickupLastTurn }
        spectators: [], // { id, name } -> Handles extra joins gracefully[cite: 2]
        participatingCount: 0, // Records active structural count at the start of the match
        activeTurnIndex: 0,
        phase: "turn-start",
        challenge: null,
        swap: null,
        reveal: null,
        winner: null,
        log: ["Room created. Waiting for up to 4 players..."],
        chat: [], // Dynamic chat room state history clearing on game cycles
        lastSnapshot: null // Holds a copy of state right before the most recent action, for undo
    };
}
function pushLog(room, msg) {
    // Newest entries go to the front so the client can display log[0] as most recent
    room.log.unshift(msg);
    if (room.log.length > 50) room.log.pop();
}
function snapshotRoom(room) {
    // Deep-clones everything an action could change, so a single undo step can restore it
    room.lastSnapshot = JSON.parse(
        JSON.stringify({
            status: room.status,
            draw: room.draw,
            discard: room.discard,
            players: room.players,
            activeTurnIndex: room.activeTurnIndex,
            phase: room.phase,
            challenge: room.challenge,
            swap: room.swap,
            reveal: room.reveal,
            winner: room.winner,
            log: room.log
        })
    );
}
function getPublicStateForPlayer(room, playerId) {
    const activePlayer = room.players[room.activeTurnIndex]
        ? room.players[room.activeTurnIndex].id
        : null;
    const mePlayer = room.players.find((p) => p.id === playerId);
    return {
        status: room.status,
        playerCount: room.players.length,
        roomCode: room.roomCode,
        players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            handCount: p.hand.length,
            score: p.score,
            usedSwapLastTurn: p.usedSwapLastTurn,
            usedPickupLastTurn: p.usedPickupLastTurn
        })),
        spectators: room.spectators,
        me: mePlayer
            ? {
                  id: mePlayer.id,
                  name: mePlayer.name,
                  hand: mePlayer.hand,
                  score: mePlayer.score
              }
            : null,
        activePlayer,
        phase: room.phase,
        drawCount: room.draw.length,
        discardCount: room.discard.length,
        challenge: room.challenge,
        swap: room.swap,
        reveal: room.reveal,
        winner: room.winner,
        log: room.log,
        chat: room.chat
    };
}
function broadcastState(room) {
    // Broadcast updates targeting active players[cite: 2]
    room.players.forEach((p) => {
        const playerSocket = io.sockets.sockets.get(p.id);
        if (playerSocket) {
            playerSocket.emit(
                "gameStateUpdate",
                getPublicStateForPlayer(room, p.id)
            );
        }
    });
    // Broadcast match flow transparently to spectators[cite: 2]
    room.spectators.forEach((s) => {
        const specSocket = io.sockets.sockets.get(s.id);
        if (specSocket) {
            specSocket.emit(
                "gameStateUpdate",
                getPublicStateForPlayer(room, s.id)
            );
        }
    });
}
function startTurn(room) {
    if (room.draw.length === 0) {
        endGame(room);
        return;
    }
    const player = room.players[room.activeTurnIndex];
    const card = room.draw.pop();
    player.hand.push(card);
    pushLog(
        room,
        `${player.name} drew a card. (${room.draw.length} left in pile)`
    );
    room.phase = "choose-action";
    broadcastState(room);
}
function finishTurn(room, actionTaken) {
    const activePlayer = room.players[room.activeTurnIndex];
    if(activePlayer) {
        activePlayer.usedSwapLastTurn = actionTaken === "swap";
        activePlayer.usedPickupLastTurn = actionTaken === "pickup";
    }
    room.swap = null;
    room.challenge = null;
    if (room.draw.length === 0) {
        endGame(room);
        return;
    }
    room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
    room.phase = "turn-start";
    startTurn(room);
}
function refillIfEmpty(room, player) {
    if (player.hand.length === 0 && room.draw.length >= 10) {
        const n = Math.min(5, room.draw.length);
        for (let i = 0; i < n; i++) player.hand.push(room.draw.pop());
        pushLog(room, `${player.name}'s hand hit zero — draws 5 fresh cards!`);
    }
}
function endGame(room) {
    room.status = "finished";
    room.phase = "gameover";
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    room.winner = sorted[0] ? sorted[0].id : null;
    pushLog(
        room,
        `Game Over! Winner: ${sorted[0] ? sorted[0].name : "Nobody"}`
    );
    broadcastState(room);
    io.to(room.roomCode).emit("gameOver", { winnerId: room.winner });
}
function resolveChallenge(room) {
    const ch = room.challenge;
    const challenger = room.players.find((p) => p.id === ch.challengerId);
    const target = room.players.find((p) => p.id === ch.targetId);
    let winner = null;
    if (!challenger || !target) return;

    if (ch.type === "color") {
        if (ch.targetCards.length === 0) {
            winner = "challenger";
        } else {
            const cCard = ch.challengerCards[0];
            const tCard = ch.targetCards[0];
            const cMatch = cCard.color === ch.value;
            const tMatch = tCard.color === ch.value;
            if (cMatch && !tMatch) winner = "challenger";
            else if (tMatch && !cMatch) winner = "target";
            else if (cCard.num === tCard.num) winner = "challenger";
            else winner = cCard.num > tCard.num ? "challenger" : "target";
        }
    } else {
        const cCount = ch.challengerCards.length;
        const tCount = ch.targetCards.length;
        if (cCount > tCount) winner = "challenger";
        else if (tCount > cCount) winner = "target";
        else winner = null; 
    }
    let scoreGain = 0;
    let challengerPenalized = false;
    if (ch.type === "color") {
        if (winner) {
            scoreGain =
                ch.challengerCards.reduce((s, c) => s + c.num, 0) +
                ch.targetCards.reduce((s, c) => s + c.num, 0);
            if (winner === "challenger") challenger.score += scoreGain;
            else target.score += scoreGain;
        }
    } else {
        if (winner === "challenger") {
            scoreGain = 15;
            challenger.score += 15;
        } else if (winner === "target") {
            scoreGain = 15;
            target.score += 15;
            challenger.score -= 15;
            challengerPenalized = true;
        } else {
            challenger.score -= 15;
            challengerPenalized = true;
        }
    }
    const cIds = new Set(ch.challengerCards.map((c) => c.id));
    const tIds = new Set(ch.targetCards.map((c) => c.id));
    challenger.hand = challenger.hand.filter((c) => !cIds.has(c.id));
    target.hand = target.hand.filter((c) => !tIds.has(c.id));
    room.discard.push(...ch.challengerCards, ...ch.targetCards);
    refillIfEmpty(room, challenger);
    refillIfEmpty(room, target);
    const winnerName =
        winner === "challenger"
            ? challenger.name
            : winner === "target"
            ? target.name
            : null;
    if (winner) {
        pushLog(room, `${winnerName} won the duel! +${scoreGain} pts.`);
    } else {
        pushLog(room, "It's a tie — no points awarded.");
    }
    if (challengerPenalized) {
        pushLog(
            room,
            `${challenger.name} loses 15 pts for the failed number call.`
        );
    }
    room.reveal = {
        challengerId: ch.challengerId,
        targetId: ch.targetId,
        challengerCards: ch.challengerCards,
        targetCards: ch.targetCards,
        winner,
        scoreGain,
        challengerPenalized
    };
    room.phase = "reveal";
    broadcastState(room);
}
io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);
    socket.on("joinRoom", (data) => {
        const roomCode = typeof data === 'object' ? data.roomCode : data;
        const customName = typeof data === 'object' ? data.name : null;
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        if (!rooms[roomCode]) {
            rooms[roomCode] = createGameState(roomCode);
        }
        const room = rooms[roomCode];
        
        const playerNum = room.players.length + room.spectators.length + 1;
        const playerName = (customName && customName.trim().length > 0) ? customName.trim() : `Player ${playerNum}`;

        // Spectator Isolation Rule logic
        if (room.status !== "waiting") {
            room.spectators.push({ id: socket.id, name: playerName });
            pushLog(room, `${playerName} joined as a spectator.`);
            broadcastState(room);
            return;
        }

        // 4-Player Room Limit Check
        if (!room.players.some((p) => p.id === socket.id)) {
            if (room.players.length >= 4) {
                room.spectators.push({ id: socket.id, name: playerName });
                pushLog(room, `${playerName} filled room limits — joining as a spectator.`);
            } else {
                const initialHand = [];
                for (let i = 0; i < 10; i++) {
                    if (room.draw.length > 0) initialHand.push(room.draw.pop());
                }
                room.players.push({
                    id: socket.id,
                    name: playerName,
                    hand: initialHand,
                    score: 0,
                    usedSwapLastTurn: false,
                    usedPickupLastTurn: false
                });
                pushLog(room, `${playerName} joined the room.`);
            }
        }
        broadcastState(room);
    });

    socket.on("startGame", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== "waiting") return;
        
        // Ensure host initialization safety guard check
        if (room.players.length >= 2) {
            room.status = "playing";
            room.participatingCount = room.players.length; // Explicitly mark absolute participating volume
            room.chat = []; // Reset player chat box contents completely right before the game begins
            pushLog(room, `Match started manually with ${room.participatingCount} active players!`);
            startTurn(room);
        }
    });

    socket.on("sendChat", (data) => {
        const { roomCode, text } = data;
        const room = rooms[roomCode];
        if (!room || !text.trim()) return;
        
        let senderName = "Unknown";
        const p = room.players.find(x => x.id === socket.id);
        const s = room.spectators.find(x => x.id === socket.id);
        if (p) senderName = p.name;
        else if (s) senderName = s.name + " (Spec)";

        room.chat.push({ user: senderName, text: text.trim() });
        if (room.chat.length > 40) room.chat.shift();
        broadcastState(room);
    });

    socket.on("chooseAction", (data) => {
        const { roomCode, actionType } = data;
        const room = rooms[roomCode];
        if (!room || room.status !== "playing") return;
        const activePlayer = room.players[room.activeTurnIndex];
        if (socket.id !== activePlayer.id) {
            socket.emit("moveRejected", "Not your turn!");
            return;
        }
        snapshotRoom(room);
        if (actionType === "challenge") {
            room.challenge = { challengerId: socket.id };
            room.phase = "choose-target";
        } else if (actionType === "swap") {
            room.swap = { initiatorId: socket.id };
            room.phase = "swap-choose-target";
        }
        broadcastState(room);
    });
    socket.on("chooseTarget", (data) => {
        const { roomCode, targetId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        room.challenge.targetId = targetId;
        room.phase = "choose-type";
        broadcastState(room);
    });
    socket.on("chooseChallengeType", (data) => {
        const { roomCode, challengeType } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        room.challenge.type = challengeType;
        room.phase = "choose-value";
        broadcastState(room);
    });
    socket.on("chooseChallengeValue", (data) => {
        const { roomCode, value } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        const ch = room.challenge;
        ch.value = value;
        if (ch.type === "number") {
            const me = room.players.find((p) => p.id === socket.id);
            ch.challengerCards = me.hand.filter((c) => c.num === value);
        } else {
            ch.challengerCards = [];
        }
        room.phase = "choose-card";
        broadcastState(room);
    });
    socket.on("selectCard", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        room.challenge.selectedCardId = cardId;
        broadcastState(room);
    });
    socket.on("lockInChallenge", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        const ch = room.challenge;
        const challenger = room.players.find((p) => p.id === ch.challengerId);
        const target = room.players.find((p) => p.id === ch.targetId);
        if (ch.type === "color") {
            const card = challenger.hand.find(
                (c) => c.id === ch.selectedCardId
            );
            ch.challengerCards = [card];
        }
        pushLog(
            room,
            `${challenger.name} challenged ${target.name} — calling ${
                ch.type === "color"
                    ? `${ch.value.toUpperCase()} as trump color.`
                    : `Number ${ch.value} as trump.`
            }`
        );
        if (target.hand.length === 0) {
            ch.targetCards = [];
            resolveChallenge(room);
            return;
        }
        if (ch.type === "color") {
            room.phase = "awaiting-human-defense";
        } else {
            ch.targetCards = target.hand.filter(
                (c) => c.num === ch.value
            );
            if (ch.targetCards.length !== ch.challengerCards.length) {
                pushLog(room, `${target.name} lacks matching cards to stand up to the challenge baseline! Auto-resolving match.`);
            }
            room.phase = "revealing";
            broadcastState(room);
            setTimeout(() => resolveChallenge(room), 600);
            return;
        }
        broadcastState(room);
    });
    socket.on("defendCard", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        const ch = room.challenge;
        const target = room.players.find((p) => p.id === ch.targetId);
        const card = target.hand.find((c) => c.id === cardId);
        ch.targetCards = [card];
        room.phase = "revealing";
        broadcastState(room);
        setTimeout(() => resolveChallenge(room), 600);
    });
    socket.on("lockInDefense", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;
        snapshotRoom(room);
        const ch = room.challenge;
        if (ch.type === "number" && ch.targetCards.length !== ch.challengerCards.length) {
            socket.emit("moveRejected", `Mandatory Mechanic Violation: You must match the exact count (${ch.challengerCards.length} cards) played by your challenger!`);
            return;
        }
        room.phase = "revealing";
        broadcastState(room);
        setTimeout(() => resolveChallenge(room), 600);
    });
    socket.on("swapChooseTarget", (data) => {
        const { roomCode, targetId } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;
        snapshotRoom(room);
        room.swap.targetId = targetId;
        room.phase = "swap-choose-card";
        broadcastState(room);
    });
    socket.on("swapSelectCard", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;
        snapshotRoom(room);
        room.swap.myCardId = cardId;
        broadcastState(room);
    });
    socket.on("swapLockIn", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;
        snapshotRoom(room);
        const sw = room.swap;
        const me = room.players.find((p) => p.id === sw.initiatorId);
        const target = room.players.find((p) => p.id === sw.targetId);
        const myCard = me.hand.find((c) => c.id === sw.myCardId);
        if (target.hand.length === 0) {
            pushLog(room, `${me.name} tried to swap, but target had no cards!`);
            finishTurn(room, "swap");
            return;
        }
        const theirCard =
            target.hand[Math.floor(Math.random() * target.hand.length)];
        me.hand = me.hand.filter((c) => c.id !== myCard.id);
        target.hand = target.hand.filter((c) => c.id !== theirCard.id);
        me.hand.push(theirCard);
        target.hand.push(myCard);
        pushLog(room, `${me.name} swapped a card with ${target.name}.`);
        finishTurn(room, "swap");
    });
    socket.on("pickUp", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;
        snapshotRoom(room);
        const me = room.players.find((p) => p.id === socket.id);
        if (room.draw.length > 0) {
            const card = room.draw.pop();
            me.hand.push(card);
            pushLog(
                room,
                `${me.name} picked up an extra card. (${room.draw.length} left in pile)`
            );
        }
        finishTurn(room, "pickup");
    });
    socket.on("continueAfterReveal", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;
        snapshotRoom(room);
        room.reveal = null;
        finishTurn(room, "challenge");
    });
    socket.on("undoLastAction", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;
        if (!room.lastSnapshot) {
            socket.emit("moveRejected", "Nothing to undo yet.");
            return;
        }
        const snap = room.lastSnapshot;
        room.status = snap.status;
        room.draw = snap.draw;
        room.discard = snap.discard;
        room.players = snap.players;
        room.activeTurnIndex = snap.activeTurnIndex;
        room.phase = snap.phase;
        room.challenge = snap.challenge;
        room.swap = snap.swap;
        room.reveal = snap.reveal;
        room.winner = snap.winner;
        room.log = snap.log;
        room.lastSnapshot = null;
        pushLog(room, "Last action was undone.");
        broadcastState(room);
    });
    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
        const roomCode = socket.currentRoom;
        if (!roomCode || !rooms[roomCode]) return;
        const room = rooms[roomCode];
        
        const leavingPlayer = room.players.find((p) => p.id === socket.id);
        const leavingSpec = room.spectators.find((s) => s.id === socket.id);
        
        if (leavingPlayer) {
            const leavingName = leavingPlayer.name;
            room.players = room.players.filter((p) => p.id !== socket.id);
            io.to(roomCode).emit("playerDisconnected", { disconnectedPlayerId: socket.id, name: leavingName });
            
            if (room.players.length < 2 && room.status === "playing") {
                room.status = "waiting";
                room.phase = "turn-start";
                pushLog(room, `Player ${leavingName} left. Pausing match until someone replaces them or game restarts...`);
            }
        } else if (leavingSpec) {
            room.spectators = room.spectators.filter((s) => s.id !== socket.id);
        }

        if (room.players.length === 0 && room.spectators.length === 0) {
            delete rooms[roomCode];
            console.log(`Room ${roomCode} deleted.`);
        } else {
            broadcastState(room);
        }
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ChromaClash server running on port ${PORT}`);
});