const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const lobbies = new Map();

function generateId() {
    return crypto.randomBytes(4).toString('hex');
}

function broadcastToLobby(lobbyId, message, exclude = null) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    for (const [client] of lobby.players.entries()) {
        if (client !== exclude) {
            client.send(JSON.stringify(message));
        }
    }
}

function broadcastLobbyUpdate(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    
    const playersList = [];
    for (const [, info] of lobby.players.entries()) {
        playersList.push({ name: info.name, x: info.x, y: info.y, dir: info.dir, alive: info.alive, color: info.color || 'blue' });
    }
    
    for (const [client] of lobby.players.entries()) {
        client.send(JSON.stringify({
            type: 'lobby_update',
            players: playersList,
            isHost: client === lobby.host
        }));
    }
}

function resetLobbyToLobbyState(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    
    lobby.gameStarted = false;
    lobby.meetingActive = false;
    
    for (const [, info] of lobby.players.entries()) {
        info.isImpostor = false;
        info.alive = true;
        info.x = 499;
        info.y = 353;
        info.dir = 'right';
        info.bodyX = null;
        info.bodyY = null;
        info.color = info.color || 'blue';
    }
    
    const playersList = [];
    for (const [, info] of lobby.players.entries()) {
        playersList.push({ name: info.name, x: info.x, y: info.y, dir: info.dir, alive: info.alive, color: info.color });
    }
    
    for (const [client] of lobby.players.entries()) {
        client.send(JSON.stringify({
            type: 'return_to_lobby',
            players: playersList,
            isHost: client === lobby.host
        }));
    }
}

function getImpostorCount(playerCount) {
    if (playerCount >= 13) return 3;
    if (playerCount >= 8) return 2;
    return 1;
}

function checkWinCondition(lobby, lobbyId) {
    let aliveCrew = 0;
    let aliveImpostors = 0;
    
    for (const [, info] of lobby.players.entries()) {
        if (info.alive) {
            if (info.isImpostor) aliveImpostors++;
            else aliveCrew++;
        }
    }
    
    if (aliveImpostors === 0) {
        broadcastToLobby(lobbyId, { type: 'game_over', winner: 'crew' });
        setTimeout(() => resetLobbyToLobbyState(lobbyId), 3000);
        return true;
    } else if (aliveImpostors >= aliveCrew) {
        broadcastToLobby(lobbyId, { type: 'game_over', winner: 'impostors' });
        setTimeout(() => resetLobbyToLobbyState(lobbyId), 3000);
        return true;
    }
    return false;
}

wss.on('connection', (ws) => {
    let currentLobbyId = null;
    
    ws.on('message', (rawMessage) => {
        const data = JSON.parse(rawMessage);
        
        if (data.type === 'get_lobbies') {
            const list = [];
            for (const [id, lobby] of lobbies.entries()) {
                if (!lobby.gameStarted) {
                    list.push({
                        id: id,
                        playersCount: lobby.players.size,
                        host: lobby.hostName
                    });
                }
            }
            ws.send(JSON.stringify({ type: 'lobbies_list', lobbies: list }));
        }
        
        else if (data.type === 'create_lobby') {
            const lobbyId = generateId();
            currentLobbyId = lobbyId;
            
            lobbies.set(lobbyId, {
                id: lobbyId,
                players: new Map(),
                gameStarted: false,
                meetingActive: false,
                host: ws,
                hostName: data.name,
                mapType: data.mapType || 'skeld'
            });
            
            lobbies.get(lobbyId).players.set(ws, {
                name: data.name,
                x: 499, y: 353,
                isImpostor: false,
                alive: true,
                dir: 'right',
                bodyX: null,
                bodyY: null,
                color: 'blue'
            });
            
            ws.send(JSON.stringify({
                type: 'lobby_joined',
                lobbyId: lobbyId,
                isHost: true,
                mapType: data.mapType || 'skeld'
            }));
            
            broadcastLobbyUpdate(lobbyId);
        }
        
        else if (data.type === 'join_lobby') {
            const lobbyId = data.lobbyId;
            const lobby = lobbies.get(lobbyId);
            if (lobby && !lobby.gameStarted) {
                if (lobby.players.size >= 15) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Лобби заполнено (максимум 15 игроков)' }));
                    return;
                }
                lobby.players.set(ws, {
                    name: data.name,
                    x: 499, y: 353,
                    isImpostor: false,
                    alive: true,
                    dir: 'right',
                    bodyX: null,
                    bodyY: null,
                    color: 'blue'
                });
                currentLobbyId = lobbyId;
                
                ws.send(JSON.stringify({
                    type: 'lobby_joined',
                    lobbyId: lobbyId,
                    isHost: false,
                    mapType: lobby.mapType
                }));
                
                broadcastLobbyUpdate(lobbyId);
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Лобби не существует' }));
            }
        }
        
        else if (data.type === 'change_color') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby) {
                const playerInfo = lobby.players.get(ws);
                if (playerInfo) {
                    playerInfo.color = data.color;
                    broadcastLobbyUpdate(currentLobbyId);
                }
            }
        }
        
        else if (data.type === 'start_game') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && lobby.host === ws && !lobby.gameStarted) {
                const playerCount = lobby.players.size;
                if (playerCount < 3) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Нужно минимум 3 игрока' }));
                    return;
                }
                
                lobby.gameStarted = true;
                
                const playersArray = Array.from(lobby.players.keys());
                const impostorCount = getImpostorCount(playerCount);
                const impostors = new Set();
                while (impostors.size < impostorCount) {
                    const randomIndex = Math.floor(Math.random() * playersArray.length);
                    impostors.add(playersArray[randomIndex]);
                }
                
                for (const [client, info] of lobby.players.entries()) {
                    info.isImpostor = impostors.has(client);
                    info.x = 2280;
                    info.y = 547;
                    info.alive = true;
                    info.dir = 'right';
                    info.bodyX = null;
                    info.bodyY = null;
                }
                
                for (const [client, info] of lobby.players.entries()) {
                    const playersList = [];
                    for (const [otherClient, otherInfo] of lobby.players.entries()) {
                        playersList.push({
                            name: otherInfo.name,
                            x: otherInfo.x,
                            y: otherInfo.y,
                            isImpostor: otherInfo.isImpostor,
                            dir: otherInfo.dir || 'right',
                            alive: otherInfo.alive,
                            color: otherInfo.color || 'blue'
                        });
                    }
                    client.send(JSON.stringify({
                        type: 'game_start',
                        isImpostor: info.isImpostor,
                        speed: 2.5,
                        players: playersList
                    }));
                }
            }
        }
        
        else if (data.type === 'update_position') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && !lobby.meetingActive) {
                const playerInfo = lobby.players.get(ws);
                if (playerInfo && playerInfo.alive) {
                    playerInfo.x = data.x;
                    playerInfo.y = data.y;
                    playerInfo.dir = data.dir || 'right';
                    
                    const playersList = [];
                    for (const [client, info] of lobby.players.entries()) {
                        playersList.push({
                            name: info.name,
                            x: info.x,
                            y: info.y,
                            isImpostor: info.isImpostor,
                            alive: info.alive,
                            dir: info.dir || 'right',
                            bodyX: info.bodyX,
                            bodyY: info.bodyY,
                            color: info.color || 'blue'
                        });
                    }
                    broadcastToLobby(currentLobbyId, {
                        type: lobby.gameStarted ? 'players_update' : 'lobby_update',
                        players: playersList
                    }, ws);
                }
            }
        }
        
        else if (data.type === 'kill') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && lobby.gameStarted && !lobby.meetingActive) {
                const killer = lobby.players.get(ws);
                if (killer && killer.isImpostor && killer.alive) {
                    let closest = null;
                    let closestDist = 80;
                    
                    for (const [client, info] of lobby.players.entries()) {
                        if (client !== ws && info.alive && !info.isImpostor) {
                            const dx = killer.x - info.x;
                            const dy = killer.y - info.y;
                            const dist = Math.sqrt(dx*dx + dy*dy);
                            if (dist < closestDist) {
                                closestDist = dist;
                                closest = { client, info };
                            }
                        }
                    }
                    
                    if (closest) {
                        closest.info.alive = false;
                        closest.info.bodyX = closest.info.x;
                        closest.info.bodyY = closest.info.y;
                        
                        const playersList = [];
                        for (const [client, info] of lobby.players.entries()) {
                            playersList.push({
                                name: info.name,
                                x: info.x,
                                y: info.y,
                                isImpostor: info.isImpostor,
                                alive: info.alive,
                                dir: info.dir || 'right',
                                bodyX: info.bodyX,
                                bodyY: info.bodyY,
                                color: info.color || 'blue'
                            });
                        }
                        broadcastToLobby(currentLobbyId, {
                            type: 'players_update',
                            players: playersList
                        });
                        
                        checkWinCondition(lobby, currentLobbyId);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Нет цели рядом' }));
                    }
                }
            }
        }
        
        else if (data.type === 'report') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && lobby.gameStarted && !lobby.meetingActive) {
                const reporter = lobby.players.get(ws);
                if (reporter && reporter.alive) {
                    let hasBody = false;
                    let bodyClient = null;
                    for (const [client, info] of lobby.players.entries()) {
                        if (!info.alive && info.bodyX && info.bodyY) {
                            const dx = reporter.x - info.bodyX;
                            const dy = reporter.y - info.bodyY;
                            const dist = Math.sqrt(dx*dx + dy*dy);
                            if (dist < 50) {
                                hasBody = true;
                                bodyClient = client;
                                break;
                            }
                        }
                    }
                    if (hasBody && bodyClient) {
                        const bodyInfo = lobby.players.get(bodyClient);
                        if (bodyInfo) {
                            bodyInfo.bodyX = null;
                            bodyInfo.bodyY = null;
                        }
                        
                        lobby.meetingActive = true;
                        lobby.votes = {};
                        const alivePlayers = [];
                        for (const [client, info] of lobby.players.entries()) {
                            if (info.alive) {
                                alivePlayers.push(info.name);
                            }
                        }
                        broadcastToLobby(currentLobbyId, {
                            type: 'meeting_start',
                            reporter: reporter.name,
                            players: alivePlayers,
                            time: 30
                        });
                        
                        setTimeout(() => {
                            if (lobby.meetingActive) {
                                const voteCount = {};
                                for (const target of Object.values(lobby.votes)) {
                                    voteCount[target] = (voteCount[target] || 0) + 1;
                                }
                                let ejected = null;
                                let maxVotes = 0;
                                for (const [target, count] of Object.entries(voteCount)) {
                                    if (count > maxVotes && target !== 'skip') {
                                        maxVotes = count;
                                        ejected = target;
                                    }
                                }
                                if (ejected) {
                                    for (const [client, info] of lobby.players.entries()) {
                                        if (info.name === ejected) {
                                            broadcastToLobby(currentLobbyId, { type: 'player_ejected', name: ejected });
                                            info.alive = false;
                                            info.isImpostor = false;
                                            break;
                                        }
                                    }
                                    checkWinCondition(lobby, currentLobbyId);
                                }
                                lobby.meetingActive = false;
                                lobby.votes = {};
                                broadcastToLobby(currentLobbyId, { type: 'meeting_ended', result: ejected ? `${ejected} был кикнут` : 'Никто не был кикнут' });
                            }
                        }, 30000);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Рядом нет трупа' }));
                    }
                }
            }
        }
        
        else if (data.type === 'vote') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && lobby.meetingActive) {
                const voter = lobby.players.get(ws);
                if (voter && !lobby.votes[voter.name]) {
                    lobby.votes[voter.name] = data.target;
                    broadcastToLobby(currentLobbyId, {
                        type: 'vote_update',
                        votes: Object.keys(lobby.votes).length,
                        total: lobby.players.size
                    });
                }
            }
        }
        
        else if (data.type === 'skip_vote') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && lobby.meetingActive) {
                const voter = lobby.players.get(ws);
                if (voter && !lobby.votes[voter.name]) {
                    lobby.votes[voter.name] = 'skip';
                    broadcastToLobby(currentLobbyId, {
                        type: 'vote_update',
                        votes: Object.keys(lobby.votes).length,
                        total: lobby.players.size
                    });
                }
            }
        }
        
        else if (data.type === 'chat_message') {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby && !lobby.gameStarted) {
                broadcastToLobby(currentLobbyId, {
                    type: 'chat_message',
                    sender: lobby.players.get(ws)?.name,
                    message: data.message
                });
            }
        }
        
        else if (data.type === 'leave_lobby') {
            if (currentLobbyId && lobbies.has(currentLobbyId)) {
                const lobby = lobbies.get(currentLobbyId);
                lobby.players.delete(ws);
                
                if (lobby.players.size === 0) {
                    lobbies.delete(currentLobbyId);
                } else {
                    if (lobby.host === ws) {
                        const newHost = lobby.players.keys().next().value;
                        lobby.host = newHost;
                        lobby.hostName = lobby.players.get(newHost).name;
                        newHost.send(JSON.stringify({ type: 'you_are_host' }));
                    }
                    broadcastLobbyUpdate(currentLobbyId);
                }
            }
            currentLobbyId = null;
        }
    });
    
    ws.on('close', () => {
        if (currentLobbyId && lobbies.has(currentLobbyId)) {
            const lobby = lobbies.get(currentLobbyId);
            lobby.players.delete(ws);
            
            if (lobby.players.size === 0) {
                lobbies.delete(currentLobbyId);
            } else {
                if (lobby.host === ws) {
                    const newHost = lobby.players.keys().next().value;
                    lobby.host = newHost;
                    lobby.hostName = lobby.players.get(newHost).name;
                    newHost.send(JSON.stringify({ type: 'you_are_host' }));
                }
                broadcastLobbyUpdate(currentLobbyId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
    console.log(`🚀 Сервер запущен на всех интерфейсах`);
    console.log(`📍 Radmin IP: 26.167.126.232:${PORT}`);
    console.log(`📍 Локально: http://localhost:${PORT}`);
    console.log(`📊 Предатели: 3-7 → 1, 8-12 → 2, 13-15 → 3`);
    console.log(`⚡ Скорость всех игроков: 2.5`);
    console.log(`🎨 Выбор цвета: голубой (по умолчанию) или красный`);
});
