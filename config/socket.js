const WebSocket = require('ws');

const initWebSocket = (server) => {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    ws.on('message', (message) => {
      console.log(`Received: ${message}`);
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });

    ws.on('close', () => console.log('Client disconnected'));
  });

  return wss;
};

module.exports = initWebSocket;