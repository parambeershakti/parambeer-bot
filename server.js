const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
// SIGN REQUEST
// ══════════════════════════════════════════
function signRequest(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'Param Beer Shakti Bot Server Running ✅', time: new Date().toISOString() });
});

// ══════════════════════════════════════════
// FUNDING RATE + COUNTDOWN
// ══════════════════════════════════════════
app.get('/funding', async (req, res) => {
  const { pair } = req.query;
  try {
    // Price
    const tickerRes = await fetch('https://public.coindcx.com/exchange/ticker');
    const tickers = await tickerRes.json();
    const ticker = tickers.find(t => t.market === pair);

    // Funding Rate
    const frRes = await fetch(`https://api.coindcx.com/exchange/v1/derivatives/funding_rate?pair=${pair}`);
    let fundingData = {};
    if(frRes.ok) fundingData = await frRes.json();

    // Countdown calculate
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const utcS = now.getUTCSeconds();
    const totalSecs = utcH * 3600 + utcM * 60 + utcS;
    const cycles = [0, 8*3600, 16*3600, 24*3600];
    let secsLeft = 0;
    for(let c of cycles) {
      if(c > totalSecs) { secsLeft = c - totalSecs; break; }
    }
    if(secsLeft === 0) secsLeft = 24*3600 - totalSecs;

    // Exact time from API if available
    if(fundingData.next_funding_time) {
      const ms = new Date(fundingData.next_funding_time).getTime() - Date.now();
      if(ms > 0) secsLeft = Math.floor(ms/1000);
    }

    res.json({
      success: true,
      price: ticker ? ticker.last_price : null,
      funding_rate: fundingData.funding_rate || 0.0091,
      countdown_seconds: secsLeft,
      next_funding_time: fundingData.next_funding_time || null
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// PLACE ORDER
// ══════════════════════════════════════════
app.post('/order/place', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  if(!apiKey || !apiSecret || !pair || !side || !quantity) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }
  try {
    const timestamp = Date.now();
    const body = JSON.stringify({ market: pair, order_type: 'market_order', side, quantity, leverage: leverage || 1, timestamp });
    const signature = signRequest(body, apiSecret);
    const response = await fetch('https://api.coindcx.com/exchange/v1/derivatives/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body
    });
    const data = await response.json();
    if(response.ok) {
      res.json({ success: true, orderId: data.id, price: data.price_per_unit, data });
    } else {
      res.json({ success: false, error: data.message || 'Order failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// CLOSE ORDER
// ══════════════════════════════════════════
app.post('/order/close', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  try {
    const timestamp = Date.now();
    const body = JSON.stringify({ market: pair, order_type: 'market_order', side: closeSide, quantity, leverage: leverage || 1, timestamp });
    const signature = signRequest(body, apiSecret);
    const response = await fetch('https://api.coindcx.com/exchange/v1/derivatives/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature },
      body
    });
    const data = await response.json();
    if(response.ok) {
      res.json({ success: true, orderId: data.id, data });
    } else {
      res.json({ success: false, error: data.message || 'Close failed', data });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// COIN LIST
// ══════════════════════════════════════════
app.get('/coins', async (req, res) => {
  try {
    const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details');
    const data = await r.json();
    const coins = data
      .filter(m => m.symbol && m.symbol.startsWith('B-') && m.symbol.endsWith('_USDT') && m.status === 'active')
      .map(m => ({
        symbol: m.base_currency_short_name || m.symbol.replace('B-','').replace('_USDT',''),
        name: m.base_currency_name || '',
        pair: m.symbol,
        max_leverage: m.max_leverage || m.leverage || null
      }));
    res.json({ success: true, coins });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Param Beer Shakti Bot Server running on port ${PORT}`));
