class WsHub {
  constructor() {
    this.subscribers = new Map();
  }

  subscribe(sessionName, ws) {
    if (!this.subscribers.has(sessionName)) this.subscribers.set(sessionName, new Set());
    this.subscribers.get(sessionName).add(ws);
  }

  unsubscribe(sessionName, ws) {
    this.subscribers.get(sessionName)?.delete(ws);
  }

  broadcast(sessionName, message) {
    const sockets = this.subscribers.get(sessionName);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

module.exports = { WsHub };
