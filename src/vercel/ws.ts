// The game server as a Vercel Function. Vercel keeps each WebSocket connection
// on the function instance that accepted it, and this module's rooms live in
// that instance's memory. Bundled into api/ws.js by `npm run build:api`.
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { connect } from '../server/connection';
import { Rooms } from '../server/rooms';

const rooms = new Rooms();

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(req.url?.endsWith('/health') ? 'ok' : 'split-screen football game server');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const socket = { send: (d: string) => ws.send(d), isOpen: () => ws.readyState === WebSocket.OPEN };
  const conn = connect(rooms, socket);
  ws.on('message', (raw) => conn.onMessage(raw.toString()));
  ws.on('close', () => conn.onClose());
});

export default server;
