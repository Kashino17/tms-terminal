#!/bin/bash
echo "=== TMS Terminal Test ==="
echo ""

# 1. Health Check
echo "1) Health Check..."
HEALTH=$(curl -s http://100.125.192.44:8767/health 2>&1)
if echo "$HEALTH" | grep -q '"ok"'; then
  echo "   OK: $HEALTH"
else
  echo "   FEHLER: Server nicht erreichbar!"
  echo "   Starte zuerst den Server: node dist/server/src/index.js"
  exit 1
fi

# 2. Login
echo "2) Login..."
RESPONSE=$(curl -s -X POST http://100.125.192.44:8767/auth/login \
  -H "Content-Type: application/json" \
  --data-raw '{"password":"Pars123!"}')

TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "   FEHLER: Login fehlgeschlagen: $RESPONSE"
  exit 1
fi
echo "   OK: Token erhalten"

# 3. WebSocket + Terminal Test
echo "3) WebSocket + Terminal..."
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://100.125.192.44:8767?token=$TOKEN');

ws.on('open', () => {
  console.log('   OK: WebSocket verbunden');
  ws.send(JSON.stringify({ type: 'terminal:create', payload: { cols: 80, rows: 24 } }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'terminal:created') {
    console.log('   OK: Terminal erstellt (Session: ' + msg.sessionId.slice(0,8) + '...)');
    ws.send(JSON.stringify({ type: 'terminal:input', sessionId: msg.sessionId, payload: { data: 'echo TMS_TEST_OK\r' } }));
  }
  if (msg.type === 'terminal:output' && msg.payload.data.includes('TMS_TEST_OK')) {
    console.log('   OK: Befehl ausgefuehrt!');
    console.log('');
    console.log('=== ALLES FUNKTIONIERT! Du kannst die APK installieren. ===');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('   FEHLER:', e.message); process.exit(1); });
setTimeout(() => { console.log('   FEHLER: Timeout'); process.exit(1); }, 5000);
"
