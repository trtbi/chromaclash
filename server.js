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
            deck.push({ id: `${c.key}-${n}`, color: c.key, num: n, wild: false });
        }
    });
    for (let i = 1; i <= 4; i++) {
        deck.push({ id: `wild-${i}`, color: null, num: null, wild: true });
    }
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
        activeTurnIndex: 0,
        phase: "turn-start",
        challenge: null,
        swap: null,
        wildAssign: null,
        reveal: null,
        winner: null,
        log: ["Room created. Waiting for 2 players..."]
    };
}

function pushLog(room, msg) {
    room.log.push(msg);
    if (room.log.length > 50) room.log.shift();
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
        wildAssign: room.wildAssign,
        reveal: room.reveal,
        winner: room.winner,
        log: room.log
    };
}

function broadcastState(room) {
    room.players.forEach((p) => {
        const playerSocket = io.sockets.sockets.get(p.id);
        if (playerSocket) {
            playerSocket.emit(
                "gameStateUpdate",
                getPublicStateForPlayer(room, p.id)
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
    activePlayer.usedSwapLastTurn = actionTaken === "swap";
    activePlayer.usedPickupLastTurn = actionTaken === "pickup";

    room.swap = null;
    room.challenge = null;
    room.wildAssign = null;

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

    socket.on("joinRoom", (roomCode) => {
        socket.join(roomCode);
        socket.currentRoom = roomCode;

        if (!rooms[roomCode]) {
            rooms[roomCode] = createGameState(roomCode);
        }

        const room = rooms[roomCode];

        if (!room.players.some((p) => p.id === socket.id)) {
            const playerNum = room.players.length + 1;
            const initialHand = [];
            for (let i = 0; i < 10; i++) {
                if (room.draw.length > 0) initialHand.push(room.draw.pop());
            }

            room.players.push({
                id: socket.id,
                name: `Player ${playerNum}`,
                hand: initialHand,
                score: 0,
                usedSwapLastTurn: false,
                usedPickupLastTurn: false
            });
            pushLog(room, `Player ${playerNum} joined the room.`);
        }

        if (room.players.length >= 2 && room.status === "waiting") {
            room.status = "playing";
            pushLog(
                room,
                `Table ready with 2 players! Starting match...`
            );
            startTurn(room);
        } else {
            broadcastState(room);
        }
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

        if (actionType === "challenge") {
            const others = room.players.filter((p) => p.id !== socket.id);
            if (others.length === 1) {
                room.challenge = {
                    challengerId: socket.id,
                    targetId: others[0].id
                };
                room.phase = "choose-type";
            } else {
                room.challenge = { challengerId: socket.id };
                room.phase = "choose-target";
            }
        } else if (actionType === "swap") {
            const others = room.players.filter((p) => p.id !== socket.id);
            room.swap = { initiatorId: socket.id };
            if (others.length === 1) {
                room.swap.targetId = others[0].id;
                room.phase = "swap-choose-card";
            } else {
                room.phase = "swap-choose-target";
            }
        }
        broadcastState(room);
    });

    socket.on("chooseTarget", (data) => {
        const { roomCode, targetId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        room.challenge.targetId = targetId;
        room.phase = "choose-type";
        broadcastState(room);
    });

    socket.on("chooseChallengeType", (data) => {
        const { roomCode, challengeType } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        room.challenge.type = challengeType;
        room.phase = "choose-value";
        broadcastState(room);
    });

    socket.on("chooseChallengeValue", (data) => {
        const { roomCode, value } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        const ch = room.challenge;
        ch.value = value;

        if (ch.type === "number") {
            const me = room.players.find((p) => p.id === socket.id);
            ch.challengerCards = me.hand.filter(
                (c) => !c.wild && c.num === value
            );
            ch.pendingWilds = me.hand
                .filter((c) => c.wild)
                .map((c) => c.id);
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

        const me = room.players.find((p) => p.id === socket.id);
        const card = me.hand.find((c) => c.id === cardId);

        if (card && card.wild && card.color == null) {
            room.wildAssign = {
                role: "challenger-card",
                cardId,
                needNumber: true,
                color: null,
                num: null
            };
            room.phase = "assign-wild";
        } else {
            room.challenge.selectedCardId = cardId;
        }
        broadcastState(room);
    });

    socket.on("assignWild", (data) => {
        const { roomCode, cardId, color, num } = data;
        const room = rooms[roomCode];
        if (!room || !room.wildAssign) return;

        const wa = room.wildAssign;
        const ch = room.challenge;

        if (wa.role === "challenger-card") {
            const player = room.players.find((p) => p.id === ch.challengerId);
            const raw = player.hand.find((c) => c.id === cardId);
            ch.selectedCardId = cardId;
            ch.resolvedSelectedCard = {
                ...raw,
                color,
                num: wa.needNumber ? num : ch.value,
                wasWild: true
            };
            room.wildAssign = null;
            room.phase = "choose-card";
        } else if (wa.role === "defense-card") {
            const player = room.players.find((p) => p.id === ch.targetId);
            const raw = player.hand.find((c) => c.id === cardId);
            ch.targetCards = [
                {
                    ...raw,
                    color,
                    num: wa.needNumber ? num : ch.value,
                    wasWild: true
                }
            ];
            room.wildAssign = null;
            room.phase = "revealing";
            broadcastState(room);
            setTimeout(() => resolveChallenge(room), 600);
            return;
        } else if (wa.role === "challenger-number-wild") {
            const player = room.players.find((p) => p.id === ch.challengerId);
            const raw = player.hand.find((c) => c.id === cardId);
            ch.challengerCards.push({
                ...raw,
                color,
                num: ch.value,
                wasWild: true
            });
            ch.pendingWilds = ch.pendingWilds.filter((id) => id !== cardId);
            room.wildAssign = null;
            room.phase = "choose-card";
        } else if (wa.role === "defense-number-wild") {
            const player = room.players.find((p) => p.id === ch.targetId);
            const raw = player.hand.find((c) => c.id === cardId);
            ch.targetCards.push({
                ...raw,
                color,
                num: ch.value,
                wasWild: true
            });
            ch.pendingDefenseWilds = ch.pendingDefenseWilds.filter(
                (id) => id !== cardId
            );
            room.wildAssign = null;
            room.phase = "defense-number-wild-choice";
        }
        broadcastState(room);
    });

    socket.on("includeWild", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        room.wildAssign = {
            role: "challenger-number-wild",
            cardId,
            needNumber: false,
            color: null,
            num: null
        };
        room.phase = "assign-wild";
        broadcastState(room);
    });

    socket.on("lockInChallenge", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        const ch = room.challenge;
        const challenger = room.players.find((p) => p.id === ch.challengerId);
        const target = room.players.find((p) => p.id === ch.targetId);

        if (ch.type === "color") {
            const raw = challenger.hand.find(
                (c) => c.id === ch.selectedCardId
            );
            const card =
                raw && raw.wild ? ch.resolvedSelectedCard : raw;
            ch.challengerCards = [card];
        }

        pushLog(
            room,
            `${challenger.name} challenged ${target.name} — calling ${
                ch.type === "color"
                    ? `${ch.value} as trump color.`
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
            const naturalMatches = target.hand.filter(
                (c) => !c.wild && c.num === ch.value
            );
            const wilds = target.hand.filter((c) => c.wild);
            ch.targetCards = naturalMatches;
            if (wilds.length > 0) {
                ch.pendingDefenseWilds = wilds.map((w) => w.id);
                room.phase = "defense-number-wild-choice";
            } else {
                room.phase = "revealing";
                broadcastState(room);
                setTimeout(() => resolveChallenge(room), 600);
                return;
            }
        }
        broadcastState(room);
    });

    socket.on("defendCard", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        const ch = room.challenge;
        const target = room.players.find((p) => p.id === ch.targetId);
        const card = target.hand.find((c) => c.id === cardId);

        if (card && card.wild && card.color == null) {
            room.wildAssign = {
                role: "defense-card",
                cardId,
                needNumber: true,
                color: null,
                num: null
            };
            room.phase = "assign-wild";
            broadcastState(room);
            return;
        }

        ch.targetCards = [card];
        room.phase = "revealing";
        broadcastState(room);
        setTimeout(() => resolveChallenge(room), 600);
    });

    socket.on("includeDefenseWild", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.challenge) return;

        room.wildAssign = {
            role: "defense-number-wild",
            cardId,
            needNumber: false,
            color: null,
            num: null
        };
        room.phase = "assign-wild";
        broadcastState(room);
    });

    socket.on("lockInDefense", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room) return;

        room.phase = "revealing";
        broadcastState(room);
        setTimeout(() => resolveChallenge(room), 600);
    });

    socket.on("swapChooseTarget", (data) => {
        const { roomCode, targetId } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;

        room.swap.targetId = targetId;
        room.phase = "swap-choose-card";
        broadcastState(room);
    });

    socket.on("swapSelectCard", (data) => {
        const { roomCode, cardId } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;

        room.swap.myCardId = cardId;
        broadcastState(room);
    });

    socket.on("swapLockIn", (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (!room || !room.swap) return;

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

        room.reveal = null;
        finishTurn(room, "challenge");
    });

    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
        const roomCode = socket.currentRoom;
        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];
        room.players = room.players.filter((p) => p.id !== socket.id);

        io.to(roomCode).emit("playerDisconnected", {
            disconnectedPlayerId: socket.id
        });

        if (room.players.length < 2 && room.status === "playing") {
            room.status = "waiting";
            room.phase = "turn-start";
            pushLog(
                room,
                `Player disconnected. Pausing match until another joins...`
            );
        }

        if (room.players.length === 0) {
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