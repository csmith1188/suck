// Start an express server with websockets without socket.io
const express = require('express');
// import express session module
const session = require('express-session');
// import the websockets module
const WebSocket = require('ws');
// import the express-ws module
const expressWs = require('express-ws')
// import sqlite3 database module
const sqlite3 = require('sqlite3').verbose();
// import unique id handler
const { v4: uuidv4 } = require('uuid');
// import local environment variables
require('dotenv').config();
// import webtoken module
const jwt = require('jsonwebtoken');
// make a little shortcut for log()
const { log } = require('console');
// import custome GameCode
const GameCode = require('./GameCode.js');
// import socket.io-client for Formbar Digipog API
const io = require('socket.io-client');

// Load the settings from the environment variables
// To set your own, make a file called ".env",
// and add lines like this: PORT=3000

// The port to run this on
const PORT = process.env.PORT || 3000;
// The URL for the Formbar authentication server
const AUTH_URL = (process.env.FORMBAR_URL || 'http://localhost:420') + '/oauth';
// The URL for this server for the oauth callback
const THIS_URL = process.env.THIS_URL || 'http://localhost:3000/login';
// The secret for the session data
const FB_SECRET = process.env.FB_SECRET || 'secret';
// The Formbar WebSocket URL for Digipog transactions
const FORMBAR_URL = process.env.FORMBAR_URL || 'https://formbeta.yorktechapps.com';
// The API key for Formbar
const FORMBAR_API_KEY = process.env.FORMBAR_API_KEY;

const app = express();

// set the express view engine to ejs
app.set('view engine', 'ejs');

// set express to use public for static files
app.use(express.static(__dirname + '/public'));

// parse JSON bodies for POST requests
app.use(express.json());

// create a session middleware with a secret key
const sessionMiddleware = session({
    secret: FB_SECRET,
    resave: false,
    saveUninitialized: true,
    // Add a store if needed, like Redis for scalability
});
// use the session middleware in express
app.use(sessionMiddleware);

// use the express-ws module to add websockets to express
expressWs(app);

// Connect to Formbar WS API for Digipog transactions
const formbarSocket = io(FORMBAR_URL, {
    extraHeaders: {
        api: FORMBAR_API_KEY
    }
});

// Track which users have paid to play
const paidSessions = new Map();

// Store pending purchase requests
const pendingPurchases = new Map();

// Handle Formbar connection
formbarSocket.on("connect", () => {
    log("Connected to Formbar Digipog API");
});

// Handle transfer responses from Formbar
formbarSocket.on("transferResponse", (response) => {
    log("Transfer Response:", response);
    // Process all pending purchases (since we can't reliably match by ID from response)
    // In practice, there should only be one or a few at a time
    for (const [userId, pending] of pendingPurchases.entries()) {
        // Call the callback with the response
        pending.callback(response);
        // Remove this pending purchase
        pendingPurchases.delete(userId);
        // Only process one response at a time
        break;
    }
});

// Handle Formbar disconnection
formbarSocket.on("disconnect", () => {
    log("Disconnected from Formbar Digipog API");
});

// This function is used to intercept page loads to check if the user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session.user) next()
    else res.redirect('/login')
};

// Define a route handler for the default home page
app.get('/', (req, res) => {
    let user = { name: "", fbid: 0, hasSavedPin: false };
    if (req.session.user) {
        user = req.session.user
        user.top_score = 0;
        user.hasSavedPin = !!req.session.savedPin;
        // get the user from the database
        db.get(`SELECT * FROM users WHERE fb_id = ? ;`, [req.session.user.fbid], (err, row) => {
            if (err) { // if there was an error, log it
                console.error(err.message);
            } else if (row) { // if the user was found, update the user object's score
                user.top_score = row.top_score;
            } else { //if no user was found, insert this user into the database
                db.run(`INSERT INTO users (fb_name, fb_id, top_score) VALUES (?, ?, ?);`, [req.session.user.name, req.session.user.fbid, 0], (err) => {
                    if (err) { // if there was an error, log it
                        console.error(err.message);
                    } else { // if the user was inserted, log it
                        log('Inserted user into database.');
                    }
                });
            }
            // render the home page with the stats we've found
            res.render('info', { numPlayers: clients.length, game: game.stats, user: user, error: req.query.error });

        });
    } else {
        // render the home page without user stats
        res.render('info', { numPlayers: clients.length, game: game.stats, user: user, error: req.query.error });
    };
    // add 1 to the hits_home column in the database
    db.run(`UPDATE general SET hits_home = hits_home + 1 WHERE uid = 1 ;`, (err) => {
        if (err) { // if there was an error, log it
            console.error(err.message);
        } else { // if the update was successful, add to the live count
            game.stats.hits_home++;
        }
    });
});

// game page
app.get('/game', (req, res) => {
    // check if user is logged in
    if (!req.session.user) {
        return res.redirect('/?error=login');
    }

    const userId = req.session.user.fbid;
    
    // check if user has paid
    if (!paidSessions.has(userId) || !paidSessions.get(userId).paid) {
        return res.redirect('/?error=payment');
    }

    // CONSUME the payment - they need to pay again next time
    paidSessions.delete(userId);
    log(`User ${req.session.user.name} consumed their payment to enter the game`);

    // create a blank user object in case there is no session user
    let user = { name: "", fbid: 0 };
    // if there is a session user, set the user object to the session user
    if (req.session.user) user = req.session.user;
    // render the game page with the user object
    res.render('game', { user: user });
    // add 1 to the hits_game column in the database
    db.run(`UPDATE general SET hits_game = hits_game + 1 WHERE uid = 1 ;`, (err) => {
        if (err) { // if there was an error, log it
            console.error(err.message);
        } else { // if the update was successful, add to the live count
            game.stats.hits_game++;
        }
    });
});

// login page
app.get('/login', (req, res) => {
    // if there is a session user
    if (req.query.token) {
        // decode the token and set the session token and user
        let tokenData = jwt.decode(req.query.token);
        req.session.token = tokenData;
        req.session.user = { name: tokenData.displayName, fbid: tokenData.id };
        // redirect to the home page
        res.redirect('/');
    } else {
        // send them to the Formbar login page
        res.redirect(`${AUTH_URL}?redirectURL=${THIS_URL}`);
    };
});

// purchase route - handle Digipog payments for game entry
app.post('/purchase', (req, res) => {
    // check if user is logged in
    if (!req.session.user) {
        return res.json({ success: false, message: "You must be logged in to purchase" });
    }

    let { pin, savePIN, useSaved } = req.body;
    
    // if using saved PIN, get it from session
    if (useSaved && req.session.savedPin) {
        pin = req.session.savedPin;
    }
    
    // validate pin
    if (!pin || typeof pin !== 'number') {
        return res.json({ success: false, message: "Invalid PIN" });
    }

    const userId = req.session.user.fbid;

    // prepare transfer data
    const transferData = {
        from: userId,
        to: 22,
        amount: 25,
        reason: "suck game entry",
        pin: pin,
        pool: true
    };

    // store the request so we can handle the response
    pendingPurchases.set(userId, {
        callback: (response) => {
            if (response.success) {
                // mark user as paid
                paidSessions.set(userId, { paid: true, timestamp: new Date() });
                
                // save PIN if requested
                if (savePIN) {
                    req.session.savedPin = pin;
                }
                
                res.json({ success: true, message: "Payment successful! Redirecting to game..." });
            } else {
                res.json({ success: false, message: response.message || "Payment failed" });
            }
        }
    });

    // emit the transfer request to Formbar
    formbarSocket.emit("transferDigipogs", transferData);
});

// create a new game instance
const game = new GameCode.Game();

// create a client list
var clients = [];

// Run the game loop and send updates every tick interval
setInterval(() => {
    //No need to advance the game if there are no players
    if (clients.length) {

        // update the number of players in the game object
        game.numPlayers = clients.length;

        // update the game state and get list of dead players
        const deadPlayers = game.step();

        // send the update message to each client
        for (const client of clients) {
            // find the blobs that are players
            let players = game.blobs.filter(b => b.type == "player");
            // find the client's blob
            let player = players.find(b => b.id == client.id);
            // create an empty list of nearby blobs
            let nearbyBlobs = [];
            // if the player exists
            if (player) {
                // find nearby blobs by filtering blob list with the player's canSee method
                nearbyBlobs = game.blobs.filter(b => player.canSee(b)).map(b => b.pack());
            }
            //search blobs for number of players
            let numPlayers = players.filter(b => b.type == "player").length;
            // the player with the highest r
            let biggestBlob = players.reduce((a, b) => a.r > b.r ? a : b, { r: 1, name: "Bob Jenkins", fbid: 0 });

            // send the update message to the client
            client.send(JSON.stringify({
                update: {
                    player: player, //Send the player's blob if it exists
                    nearbyBlobs: nearbyBlobs,
                    status: {
                        numPlayers: numPlayers,
                        top_score: biggestBlob.r || 1,
                        top_name: biggestBlob.name || "Bob Jenkins",
                        top_uid: biggestBlob.fbid || 0
                    }
                }
            }));
        }
        // if the game updated the stats, update the database
        if (game.updateDB) {
            db.run(`UPDATE general SET top_score = ?, top_name = ?, top_uid = ? WHERE uid = 1 ;`, [game.stats.top_score, game.stats.top_name, game.stats.top_uid], (err) => {
                game.updateDB = false;
                if (err) {
                    console.error(err.message);
                } else {
                    log('Updated stats in database.');
                }
            });
        }
        
        // handle dead players
        if (deadPlayers && deadPlayers.length > 0) {
            for (const deadPlayerId of deadPlayers) {
                // find the client with this id
                const deadClient = clients.find(c => c.id === deadPlayerId);
                if (deadClient) {
                    // send death message
                    deadClient.send(JSON.stringify({ death: true, message: "You died! Returning to lobby..." }));
                    
                    // remove from paid sessions if they have a user
                    if (deadClient.user) {
                        paidSessions.delete(deadClient.user.fbid);
                        log(`Player ${deadClient.user.name} died and was removed from paid sessions`);
                    }
                }
            }
        }
    }

}, game.tickSpeed); // run the game loop every `tickSpeed` milliseconds

app.ws('/game', (ws, req) => {
    // add a unique id to the ws object
    ws.id = uuidv4();

    // add client to list
    clients.push(ws);

    // send the client their id when they connect
    ws.send(JSON.stringify({ id: ws.id }));
    log(`Client connected, ${new Date()}: ${ws.id}`);
    // add blob to game with ws's id as the blob id
    game.blobs.push(new GameCode.Player(Math.random() * game.gameWidth, Math.random() * game.gameHeight, 20, ws.id, "player"));
    // add the session user to the ws object and update the blob that was jsut created
    if (req.session.user) {
        // give the client a user property
        ws.user = req.session.user;
        // update the blob we just created with the user's name and fbid
        game.blobs[game.blobs.length - 1].name = req.session.user.name;
        game.blobs[game.blobs.length - 1].fbid = req.session.user.fbid;
        // get the user from the database
        db.get(`SELECT * FROM users WHERE fb_id = ? ;`, [req.session.user.fbid], (err, row) => {
            if (err) {
                console.error(err.message);
            } else if (row) {
                console.log("User found: ", row);
                game.blobs[game.blobs.length - 1].top_score = row.top_score;
            }
        });
    }

    ws.on('message', (message) => {
        message = JSON.parse(message);
        if (message.press) {
            // find blob with this ws id
            let player = game.blobs.find(b => b.id == ws.id);
            if (player) {
                player[message.press] = true;
            }
        }


        if (message.release) {
            // find blob with this ws id
            let player = game.blobs.find(b => b.id == ws.id);
            if (player) {
                player[message.release] = false;
            }
        }

        if (message.resize) {
            // find blob with this ws id
            let player = game.blobs.find(b => b.id == ws.id);
            if (player) {
                player.vision = message.resize;
            }
        }

    });

    // listen for disconnects
    ws.on('close', () => {
        log(`Client disconnected, ${new Date()}: ${ws.id}`);
        //remove blob from game by ws's id
        game.blobs = game.blobs.filter(b => b.id !== ws.id);
        //remove client from list
        clients = clients.filter(c => c !== ws);
    });
});

// Start the server on port 3000
app.listen(PORT, () => {
    log(`Server started on http://localhost:${PORT}`);
});

// open the database file
let db = new sqlite3.Database('data/database.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    log('Connected to the database.');
    db.get('SELECT * FROM general', (err, row) => {
        if (err) {
            console.error(err.message);
        } else if (row) {
            log(row);
            // Save the row to the game object
            game.stats = row;
        }
    });
});
