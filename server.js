const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ══════════════════════════════════════════
// BOT STATE — Server Memory
// ══════════════════════════════════════════
let botState = {
  running: false,
  apiKey: '',
  apiSecret: '',
  pair: '',
  side: '',
  quantity: 0,
  leverage: 1,
  exchange: 'coindcx',
  openPosition: null,
  totalProfit: 0,
  totalTrades: 0,
  lastLog: [],
  countdown: 0,
  fundingRate: 0,
  timer: null,
  orderPlacedThisCycle: false
};

function addLog(msg, type='info') {
  const entry = { time: new Date().toLocaleTimeString('hi-IN'), msg, type };
  botState.lastLog.unshift(entry);
  if(botState.lastLog.length > 50) botState.lastLog.pop();
  console.log(`[${type}] ${msg}`);
}

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ 
    status: '✅ Param Beer Shakti Server Live!',
    botRunning: botState.running,
    time: new Date().toISOString()
  });
});

// ══════════════════════════════════════════
// BOT STATUS — Browser poll karega
// ══════════════════════════════════════════
app.get('/bot/status', (req, res) => {
  res.json({
    running: botState.running,
    pair: botState.pair,
    side: botState.side,
    exchange: botState.exchange,
    countdown: botState.countdown,
    fundingRate: botState.fundingRate,
    openPosition: botState.openPosition,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    lastLog: botState.lastLog.slice(0, 20)
  });
});

// ══════════════════════════════════════════
// BOT START
// ══════════════════════════════════════════
app.post('/bot/start', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage, exchange } = req.body;
  
  if(!apiKey || !apiSecret || !pair || !side || !quantity) {
    return res.json({ success: false, error: 'Missing fields' });
  }
  
  if(botState.running) {
    return res.json({ success: false, error: 'Bot already running!' });
  }

  botState.apiKey = apiKey;
  botState.apiSecret = apiSecret;
  botState.pair = pair;
  botState.side = side;
  botState.quantity = quantity;
  botState.leverage = leverage || 1;
  botState.exchange = exchange || 'coindcx';
  botState.running = true;
  botState.orderPlacedThisCycle = false;

  addLog(`🟢 Server Bot Started! ${pair} | ${side.toUpperCase()} | ${exchange}`, 'info');
  
  // Start the countdown loop
  startBotLoop();
  
  res.json({ success: true, message: 'Bot started on server! Browser बंद करो — server चलाएगा!' });
});

// ══════════════════════════════════════════
// BOT STOP
// ══════════════════════════════════════════
app.post('/bot/stop', (req, res) => {
  botState.running = false;
  if(botState.timer) { clearInterval(botState.timer); botState.timer = null; }
  addLog('⏹ Bot Stopped', 'info');
  res.json({ success: true, message: 'Bot stopped' });
});

// ══════════════════════════════════════════
// FUNDING TIME FETCH — Coin specific
// ══════════════════════════════════════════
async function fetchFundingCountdown(pair) {
  console.log(`Fetching funding time for pair: ${pair}`);

  // Method 1: CoinDCX exact funding API
  try {
    const r = await fetch(`https://api.coindcx.com/exchange/v1/derivatives/funding_rate?pair=${pair}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if(r.ok) {
      const d = await r.json();
      console.log('Funding API response:', JSON.stringify(d));
      if(d.funding_rate !== undefined) botState.fundingRate = parseFloat(d.funding_rate);
      if(d.next_funding_time) {
        const ms = new Date(d.next_funding_time).getTime() - Date.now();
        if(ms > 0) {
          console.log(`✅ Live countdown from API: ${Math.floor(ms/1000)} seconds`);
          return Math.floor(ms / 1000);
        }
      }
    }
  } catch(e) { console.log('Method 1 failed:', e.message); }

  // Method 2: Futures tickers
  try {
    const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/tickers', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if(r.ok) {
      const d = await r.json();
      const ticker = Array.isArray(d) ? d.find(t => t.symbol === pair || t.market === pair) : null;
      console.log('Ticker found:', JSON.stringify(ticker));
      if(ticker) {
        if(ticker.funding_rate) botState.fundingRate = parseFloat(ticker.funding_rate);
        if(ticker.next_funding_time) {
          const ms = new Date(ticker.next_funding_time).getTime() - Date.now();
          if(ms > 0) {
            console.log(`✅ Live countdown from ticker: ${Math.floor(ms/1000)} seconds`);
            return Math.floor(ms / 1000);
          }
        }
      }
    }
  } catch(e) { console.log('Method 2 failed:', e.message); }

  // Method 3: Public ticker
  try {
    const r = await fetch('https://public.coindcx.com/exchange/ticker');
    if(r.ok) {
      const d = await r.json();
      const t = d.find(x => x.market === pair);
      if(t && t.next_funding_time) {
        const ms = new Date(t.next_funding_time).getTime() - Date.now();
        if(ms > 0) return Math.floor(ms/1000);
      }
    }
  } catch(e) {}

  // Fallback: UTC 8-hour cycle
  console.log('Using UTC 8-hour fallback');
  const now = new Date();
  const s = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
  const cycles = [0, 8*3600, 16*3600, 24*3600];
  let left = 0;
  for(let c of cycles) { if(c > s) { left = c - s; break; } }
  if(left === 0) left = 24*3600 - s;
  console.log(`Fallback countdown: ${left} seconds`);
  return left;
}

// ══════════════════════════════════════════
// PLACE ORDER
// ══════════════════════════════════════════
async function placeOrder(side) {
  const { apiKey, apiSecret, pair, quantity, leverage } = botState;
  try {
    const timestamp = Date.now();
    const body = JSON.stringify({ market: pair, order_type: 'market_order', side, quantity, leverage, timestamp });
    const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('hex');
    const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body
    });
    const data = await r.json();
    if(r.ok) return { success: true, orderId: data.id };
    else return { success: false, error: data.message || 'Order failed' };
  } catch(e) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════
// BOT LOOP — Server पर चलेगा
// ══════════════════════════════════════════
async function startBotLoop() {
  if(botState.timer) clearInterval(botState.timer);

  // First fetch countdown
  botState.countdown = await fetchFundingCountdown(botState.pair);
  addLog(`⏱ Countdown: ${Math.floor(botState.countdown/3600)}h ${Math.floor((botState.countdown%3600)/60)}m`, 'info');

  botState.timer = setInterval(async () => {
    if(!botState.running) { clearInterval(botState.timer); return; }

    botState.countdown--;

    // ⚡ 1 SECOND बचा → ORDER PLACE
    if(botState.countdown === 1 && !botState.orderPlacedThisCycle) {
      botState.orderPlacedThisCycle = true;
      addLog(`⚡ 1 second! ${botState.side.toUpperCase()} order place हो रहा है...`, 'buy');
      
      const result = await placeOrder(botState.side);
      
      if(result.success) {
        botState.openPosition = { side: botState.side, quantity: botState.quantity, orderId: result.orderId, time: Date.now() };
        botState.totalTrades++;
        addLog(`✅ Order Placed! ID: ${result.orderId} | ${botState.pair}`, 'buy');
      } else {
        addLog(`❌ Order Failed: ${result.error}`, 'info');
        botState.orderPlacedThisCycle = false;
      }
    }

    // 🔄 FUNDING SETTLE → NEW CYCLE → CLOSE
    if(botState.countdown <= 0) {
      botState.orderPlacedThisCycle = false;
      addLog('💰 Funding Settled! 1 second बाद close होगा...', 'info');
      
      // Refetch countdown for new cycle
      setTimeout(async () => {
        botState.countdown = await fetchFundingCountdown(botState.pair);
        
        // Close position
        if(botState.openPosition) {
          const closeSide = botState.openPosition.side === 'buy' ? 'sell' : 'buy';
          const closeResult = await placeOrder(closeSide);
          
          if(closeResult.success) {
            const earned = botState.quantity * Math.abs(botState.fundingRate) * 84;
            botState.totalProfit += earned;
            addLog(`✅ Position Closed! ~₹${earned.toFixed(2)} funding collected`, 'sell');
            botState.openPosition = null;
          } else {
            addLog(`❌ Close Failed: ${closeResult.error} — CoinDCX पर manually close करें!`, 'info');
          }
        }
      }, 1000);
    }

    // Refresh countdown every 5 minutes from API
    if(botState.countdown % 300 === 0 && botState.countdown > 60) {
      fetchFundingCountdown(botState.pair).then(c => { botState.countdown = c; });
    }

  }, 1000);
}

// ══════════════════════════════════════════
// SCAN
// ══════════════════════════════════════════
app.get('/scan', async (req, res) => {
  const ex = req.query.ex || 'coindcx';
  let results = [];
  
  try {
    if(ex === 'delta') {
      const r = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures');
      if(r.ok) {
        const d = await r.json();
        if(d.success && d.result) {
          results = d.result
            .filter(t => t.funding_rate !== undefined && t.funding_rate !== null)
            .map(t => ({ symbol: t.underlying_asset_symbol || '', pair: t.symbol, funding_rate: parseFloat(t.funding_rate), price: t.mark_price }))
            .filter(t => t.symbol && Math.abs(t.funding_rate) > 0);
        }
      }
    } else {
      const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/tickers');
      if(r.ok) {
        const d = await r.json();
        if(Array.isArray(d)) {
          results = d.filter(t => t.funding_rate !== undefined && t.funding_rate !== null)
            .map(t => ({ symbol: (t.symbol||'').replace('B-','').replace('_USDT',''), pair: t.symbol, funding_rate: parseFloat(t.funding_rate) }))
            .filter(t => t.symbol && Math.abs(t.funding_rate) > 0);
        }
      }
    }
  } catch(e) {}

  res.json({ success: true, exchange: ex, count: results.length, results });
});

// ══════════════════════════════════════════
// MANUAL ORDER (Browser से)
// ══════════════════════════════════════════
app.post('/order/place', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  try {
    const timestamp = Date.now();
    const body = JSON.stringify({ market: pair, order_type: 'market_order', side, quantity, leverage: leverage||1, timestamp });
    const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('hex');
    const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body
    });
    const data = await r.json();
    if(r.ok) res.json({ success: true, orderId: data.id, data });
    else res.json({ success: false, error: data.message||'Order failed', data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/order/close', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  try {
    const timestamp = Date.now();
    const body = JSON.stringify({ market: pair, order_type: 'market_order', side: closeSide, quantity, leverage: leverage||1, timestamp });
    const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('hex');
    const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body
    });
    const data = await r.json();
    if(r.ok) res.json({ success: true, orderId: data.id, data });
    else res.json({ success: false, error: data.message||'Close failed', data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/coins', async (req, res) => {
  try {
    const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details');
    const data = await r.json();
    const coins = data.filter(m => m.symbol?.startsWith('B-') && m.symbol?.endsWith('_USDT') && m.status==='active')
      .map(m => ({ symbol: m.base_currency_short_name||m.symbol.replace('B-','').replace('_USDT',''), name: m.base_currency_name||'', pair: m.symbol, max_leverage: m.max_leverage||m.leverage||null }));
    res.json({ success: true, coins });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Param Beer Shakti Server running on port ${PORT}`));
