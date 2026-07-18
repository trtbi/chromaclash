const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mock Database / Game State Store
let games = {
    "default-game": {
        deck: [],
        discardPile: [],
        playerHand: [],
        logs: ["Game initialized."],
        currentState: {
            activePlayer: "Player 1",
            turnCount: 1,
            hasDrawn: false,
            score: 0
        },
        // Fallback state used to reset prior to the action started
        priorTurnState: null 
    }
};

// Helper to create an 80-card deck with NO wild cards
function create80CardDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let newDeck = [];

    // Build standard cards (13 cards * 4 suits = 52 cards)
    suits.forEach(suit => {
        values.forEach(value => {
            newDeck.push({ suit, value, label: `${value} of ${suit}` });
        });
    });

    // Add exactly 28 more standard cards to hit the 80-card limit requirement safely
    // (e.g., duplicating values 2 through 8 across all 4 suits)
    const extraValues = ['2', '3', '4', '5', '6', '7', '8'];
    suits.forEach(suit => {
        extraValues.forEach(value => {
            newDeck.push({ suit, value, label: `${value} of ${suit} (Copy)` });
        });
    });

    // Shuffle implementation
    for (let i = newDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }

    return newDeck; // Exactly 80 elements, zero wild cards
}

// Initialize the game deck on startup
games["default-game"].deck = create80CardDeck();

// API: Get Current State
app.get('/api/game', (req, res) => {
    res.json(games["default-game"]);
});

// API: Simulate starting an action (Saves snapshot baseline)
app.post('/api/game/start-action', (req, res) => {
    const game = games["default-game"];
    
    // Snapshot state before modification
    game.priorTurnState = JSON.parse(JSON.stringify(game.currentState));
    
    // Simulate an action modifying state
    game.currentState.hasDrawn = true;
    game.currentState.score += 10;
    game.logs.push(`Player performed an action. Score increased to ${game.currentState.score}.`);
    
    res.json(game);
});

// API: Refresh / Reset Turn prior to the action started
app.post('/api/game/reset-turn', (req, res) => {
    const game = games["default-game"];

    if (!game.priorTurnState) {
        return res.status(400).json({ 
            success: false, 
            message: "No action has been taken this turn to reset." 
        });
    }

    // Restore state from snapshot
    game.currentState = JSON.parse(JSON.stringify(game.priorTurnState));
    game.priorTurnState = null; // Clear snapshot until next action
    
    game.logs.push("Player clicked Refresh: Turn reset prior to the action started.");
    
    res.json({ success: true, game });
});

app.listen(PORT, () => {
    console.log(`Server running smoothly on http://localhost:${PORT}`);
});