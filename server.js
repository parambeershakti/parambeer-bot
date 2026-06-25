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
  res.json({ status: 'Param Beer Shakti Multi-Exchange Bot ✅', time: new Date().toISOString() });
});

// ══════════════════════════════════════════
// COINDCX — FUNDING + SCAN
// ══════════════════════════════════════════
app.get('/funding', async (req, res) => {
  const { pair } = req.query;
  let price = null, fundingRate = null, countdown = null;

  try {
    const r = await fetch('https://public.coindcx.com/exchange/ticker');
    const d = await r.json();
    const t = d.find(x => x.market === pair);
    if(t) price = t.last_price;
  } catch(e) {}

  try {
    const r = await fetch(`https://api.coindcx.com/exchange/v1/derivatives/funding_rate?pair=${pair}`);
    if(r.ok) {
      const d = await r.json();
      if(d.funding_rate !== undefined) fundingRate = parseFloat(d.funding_rate);
      if(d.next_funding_time) {
        const ms = new Date(d.next_funding_time).getTime() - Date.now();
        if(ms > 0) countdown = Math.floor(ms / 1000);
      }
    }
  } catch(e) {}

  if(!countdown) {
    const now = new Date();
    const s = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
    const c = [0, 8*3600, 16*3600, 24*3600];
    let left = 0;
    for(let x of c) { if(x > s) { left = x - s; break; } }
    if(left === 0) left = 24*3600 - s;
    countdown = left;
  }

  res.json({ success: true, price, funding_rate: fundingRate, countdown_seconds: countdown });
});

app.get('/scan', async (req, res) => {
  const ex = req.query.ex || 'coindcx';

  if(ex === 'delta') {
    return await scanDelta(res);
  }
  if(ex === 'mudrex') {
    return await scanMudrex(res);
  }

  // CoinDCX scan
  let results = [];
  try {
    const r = await fetch('https://api.coindcx.com/exchange/v1/derivatives/tickers');
    if(r.ok) {
      const d = await r.json();
      if(Array.isArray(d) && d.length > 0) {
        results = d.filter(t => (t.symbol||t.market||'').includes('USDT') && t.funding_rate !== undefined && t.funding_rate !== null)
          .map(t => ({ symbol: (t.symbol||t.market||'').replace('B-','').replace('_USDT',''), pair: t.symbol||t.market, funding_rate: parseFloat(t.funding_rate) }));
      }
    }
  } catch(e) {}

  if(results.length === 0) {
    try {
      const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details');
      const d = await r.json();
      results = d.filter(m => m.symbol?.startsWith('B-') && m.symbol?.endsWith('_USDT') && m.status==='active' && m.funding_rate !== undefined)
        .map(m => ({ symbol: m.base_currency_short_name || m.symbol.replace('B-','').replace('_USDT',''), pair: m.symbol, funding_rate: parseFloat(m.funding_rate||0) }))
        .filter(m => m.funding_rate !== 0);
    } catch(e) {}
  }

  res.json({ success: true, exchange: 'coindcx', count: results.length, results });
});

// ══════════════════════════════════════════
// DELTA EXCHANGE — SCAN (REAL API)
// ══════════════════════════════════════════
async function scanDelta(res) {
  try {
    // Delta India — Get all perpetual futures tickers with funding rate
    const r = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures', {
      headers: { 'Accept': 'application/json' }
    });
    if(r.ok) {
      const d = await r.json();
      if(d.success && d.result) {
        const results = d.result
          .filter(t => t.funding_rate !== undefined && t.funding_rate !== null && t.contract_type === 'perpetual_futures')
          .map(t => ({
            symbol: t.underlying_asset_symbol || t.symbol?.replace('USDT','') || '',
            pair: t.symbol,
            product_id: t.product_id,
            funding_rate: parseFloat(t.funding_rate),
            price: t.mark_price || t.close || null
          }))
          .filter(t => t.symbol && Math.abs(t.funding_rate) > 0);

        return res.json({ success: true, exchange: 'delta', count: results.length, results });
      }
    }
    return res.json({ success: false, exchange: 'delta', error: 'No data from Delta API' });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ══════════════════════════════════════════
// COINDCX — PLACE ORDER
// ══════════════════════════════════════════
app.post('/order/place', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  if(!apiKey||!apiSecret||!pair||!side||!quantity) return res.status(400).json({ success: false, error: 'Missing fields' });
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
  const closeSide = req.body.side === 'buy' ? 'sell' : 'buy';
  req.body.side = closeSide;
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
    else res.json({ success: false, error: data.message||'Close failed', data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════
// DELTA EXCHANGE — PLACE ORDER (REAL API)
// ══════════════════════════════════════════
function deltaSign(secret, method, timestamp, path, body='') {
  const msg = method + timestamp + path + body;
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

app.post('/order/place/delta', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage, product_id } = req.body;
  if(!apiKey||!apiSecret) return res.status(400).json({ success: false, error: 'Missing API keys' });
  try {
    // Get product_id if not provided
    let pid = product_id;
    if(!pid) {
      const tr = await fetch(`https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures`);
      const td = await tr.json();
      const ticker = td.result?.find(t => t.symbol === pair || t.underlying_asset_symbol === pair?.replace('B-','').replace('_USDT',''));
      if(!ticker) return res.json({ success: false, error: `Product not found for ${pair}` });
      pid = ticker.product_id;
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const path = '/v2/orders';
    const bodyObj = { product_id: pid, size: Math.floor(quantity), side: side === 'buy' ? 'buy' : 'sell', order_type: 'market_order', leverage: String(leverage||1) };
    const bodyStr = JSON.stringify(bodyObj);
    const signature = deltaSign(apiSecret, 'POST', timestamp, path, bodyStr);

    const r = await fetch(`https://api.india.delta.exchange${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey, 'timestamp': timestamp, 'signature': signature },
      body: bodyStr
    });
    const data = await r.json();
    if(data.success) res.json({ success: true, orderId: data.result?.id, data });
    else res.json({ success: false, error: data.error?.message || data.error || 'Delta order failed', data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/order/close/delta', async (req, res) => {
  req.body.side = req.body.side === 'buy' ? 'sell' : 'buy';
  // Forward to place
  const r = await fetch(`http://localhost:${process.env.PORT||3000}/order/place/delta`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(req.body)
  });
  res.json(await r.json());
});

// ══════════════════════════════════════════
// COINS LIST
// ══════════════════════════════════════════
app.get('/coins', async (req, res) => {
  try {
    const r = await fetch('https://api.coindcx.com/exchange/v1/markets_details');
    const data = await r.json();
    const coins = data.filter(m => m.symbol?.startsWith('B-') && m.symbol?.endsWith('_USDT') && m.status==='active')
      .map(m => ({ symbol: m.base_currency_short_name||m.symbol.replace('B-','').replace('_USDT',''), name: m.base_currency_name||'', pair: m.symbol, max_leverage: m.max_leverage||m.leverage||null }));
    res.json({ success: true, coins });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});


// ══════════════════════════════════════════
// MUDREX — SCAN (REAL API)
// ══════════════════════════════════════════
async function scanMudrex(res) {
  try {
    // Mudrex public funding rate endpoint
    const r = await fetch('https://trade.mudrex.com/fapi/v1/premiumIndex', {
      headers: { 'Accept': 'application/json' }
    });
    if(r.ok) {
      const d = await r.json();
      if(Array.isArray(d)) {
        const results = d
          .filter(t => t.symbol && t.lastFundingRate !== undefined)
          .map(t => ({
            symbol: t.symbol.replace('USDT','').replace('BUSD',''),
            pair: t.symbol,
            funding_rate: parseFloat(t.lastFundingRate),
            price: t.markPrice || null,
            next_funding_time: t.nextFundingTime || null
          }))
          .filter(t => t.symbol && Math.abs(t.funding_rate) > 0);
        return res.json({ success: true, exchange: 'mudrex', count: results.length, results });
      }
    }
    return res.json({ success: false, exchange: 'mudrex', error: 'No data from Mudrex API' });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ══════════════════════════════════════════
// MUDREX — PLACE ORDER (REAL API)
// ══════════════════════════════════════════
app.post('/order/place/mudrex', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  if(!apiKey||!apiSecret) return res.status(400).json({ success: false, error: 'Missing API keys' });
  try {
    // Mudrex uses X-Authentication header with API secret
    // First set leverage
    await fetch('https://trade.mudrex.com/fapi/v1/leverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Authentication': apiSecret },
      body: JSON.stringify({ symbol: pair, leverage: leverage||10 })
    });

    // Place market order
    const bodyObj = {
      symbol: pair,
      side: side.toUpperCase(), // BUY or SELL
      type: 'MARKET',
      quantity: String(quantity)
    };
    const r = await fetch('https://trade.mudrex.com/fapi/v1/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Authentication': apiSecret },
      body: JSON.stringify(bodyObj)
    });
    const data = await r.json();
    if(r.ok && (data.orderId || data.order_id)) {
      res.json({ success: true, orderId: data.orderId||data.order_id, data });
    } else {
      res.json({ success: false, error: data.msg || data.message || 'Mudrex order failed', data });
    }
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/order/close/mudrex', async (req, res) => {
  req.body.side = req.body.side === 'buy' ? 'sell' : 'buy';
  const r = await fetch(`http://localhost:${process.env.PORT||3000}/order/place/mudrex`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(req.body)
  });
  res.json(await r.json());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Multi-Exchange Server running on port ${PORT}`));
