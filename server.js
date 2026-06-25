const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'Param Beer Shakti Bot ✅', time: new Date().toISOString() });
});

// ══════════════════════════════════════════
// FUNDING RATE — REAL DATA
// ══════════════════════════════════════════
app.get('/funding', async (req, res) => {
  const { pair } = req.query;
  if(!pair) return res.status(400).json({ success: false, error: 'pair required' });

  let price = null;
  let fundingRate = null;
  let countdown = null;

  // Step 1: Get price from public ticker
  try {
    const r = await fetch('https://public.coindcx.com/exchange/ticker', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    const t = d.find(x => x.market === pair);
    if(t) price = t.last_price;
  } catch(e) {}

  // Step 2: Get real funding rate from CoinDCX futures
  try {
    const r = await fetch(`https://api.coindcx.com/exchange/v1/derivatives/funding_rate?pair=${pair}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if(r.ok) {
      const d = await r.json();
      console.log(`Funding API response for ${pair}:`, JSON.stringify(d));
      if(d.funding_rate !== undefined && d.funding_rate !== null) {
        fundingRate = parseFloat(d.funding_rate);
      }
      if(d.next_funding_time) {
        const ms = new Date(d.next_funding_time).getTime() - Date.now();
        if(ms > 0) countdown = Math.floor(ms / 1000);
      }
    }
  } catch(e) {
    console.log('Funding rate API error:', e.message);
  }

  // Step 3: Try futures market ticker
  if(fundingRate === null) {
    try {
      const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/tickers', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if(r.ok) {
        const d = await r.json();
        console.log('Futures tickers sample:', JSON.stringify(d.slice ? d.slice(0,2) : d));
        const ticker = Array.isArray(d) ? d.find(t => t.symbol === pair || t.market === pair) : null;
        if(ticker) {
          if(ticker.funding_rate !== undefined) fundingRate = parseFloat(ticker.funding_rate);
          if(ticker.next_funding_time) {
            const ms = new Date(ticker.next_funding_time).getTime() - Date.now();
            if(ms > 0) countdown = Math.floor(ms / 1000);
          }
        }
      }
    } catch(e) {
      console.log('Futures tickers error:', e.message);
    }
  }

  // Step 4: Try market details
  if(fundingRate === null) {
    try {
      const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if(r.ok) {
        const d = await r.json();
        const m = d.find(x => x.symbol === pair);
        if(m) {
          console.log(`Market details for ${pair}:`, JSON.stringify(m));
          for(const f of ['funding_rate','current_funding_rate','last_funding_rate']) {
            if(m[f] !== undefined && m[f] !== null) {
              fundingRate = parseFloat(m[f]);
              break;
            }
          }
        }
      }
    } catch(e) {}
  }

  // Fallback countdown
  if(!countdown) {
    const now = new Date();
    const utcSecs = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
    const cycles = [0, 8*3600, 16*3600, 24*3600];
    let secsLeft = 0;
    for(let c of cycles) { if(c > utcSecs) { secsLeft = c - utcSecs; break; } }
    if(secsLeft === 0) secsLeft = 24*3600 - utcSecs;
    countdown = secsLeft;
  }

  res.json({
    success: true,
    price,
    funding_rate: fundingRate,
    countdown_seconds: countdown,
    note: fundingRate === null ? 'funding_rate not available from API' : 'live'
  });
});

// ══════════════════════════════════════════
// ALL FUNDING RATES — SCANNER
// ══════════════════════════════════════════
app.get('/scan', async (req, res) => {
  try {
    let results = [];

    // Try to get all funding rates at once
    try {
      const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/tickers', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if(r.ok) {
        const d = await r.json();
        console.log('Scan tickers count:', d.length, 'Sample:', JSON.stringify(d[0]));
        if(Array.isArray(d)) {
          results = d
            .filter(t => (t.symbol || t.market || '').includes('USDT'))
            .map(t => ({
              symbol: (t.symbol || t.market || '').replace('B-','').replace('_USDT',''),
              pair: t.symbol || t.market,
              funding_rate: t.funding_rate !== undefined ? parseFloat(t.funding_rate) : null,
              price: t.last_price || t.mark_price || null,
              next_funding_time: t.next_funding_time || null
            }))
            .filter(t => t.funding_rate !== null && t.symbol);
        }
      }
    } catch(e) {
      console.log('Scan error:', e.message);
    }

    // Try markets details for funding rates
    if(results.length === 0) {
      try {
        const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details', {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if(r.ok) {
          const d = await r.json();
          const futures = d.filter(m => m.symbol && m.symbol.startsWith('B-') && m.symbol.endsWith('_USDT') && m.status === 'active');
          console.log('Markets count:', futures.length, 'Sample:', JSON.stringify(futures[0]));
          results = futures.map(m => ({
            symbol: m.base_currency_short_name || m.symbol.replace('B-','').replace('_USDT',''),
            pair: m.symbol,
            funding_rate: m.funding_rate !== undefined ? parseFloat(m.funding_rate) :
                         m.current_funding_rate !== undefined ? parseFloat(m.current_funding_rate) : null,
            price: m.last_price || null
          })).filter(t => t.funding_rate !== null);
        }
      } catch(e) {}
    }

    res.json({ success: true, count: results.length, results });
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
    const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('hex');
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
    const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('hex');
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
// COINS LIST
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
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
