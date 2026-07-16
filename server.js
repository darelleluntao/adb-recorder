const express = require('express');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 4545;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`adb-recorder listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
