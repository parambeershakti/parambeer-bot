const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ══════════════════════════════════════════
// FUNDING CACHE
// ══════════════════════════════════════════
let fundingData = {};

// ══════════════════════════════════════════
// BOT STATE — supports arbitrage across exchanges
// ══════════════════════════════════════════
let botState = {
  running: false,
  mode: 'single',          // 'single' | 'arbitrage'
  // Single mode
  exchange: 'coindcx',
  apiKey: '',
  apiSecret: '',
  pair: '',
  side: '',
  quantity: 0,
  leverage: 1,
  // Arbitrage mode — buy on longEx, sell on shortEx
  longEx: '',              // exchange to go LONG (positive funding → receive)
  shortEx: '',             // exchange to go SHORT (negative funding → receive)
  longApiKey: '',
  longApiSecret: '',
  shortApiKey: '',
  shortApiSecret: '',
  longPair: '',
  shortPair: '',
  arbQuantity: 0,
  arbLeverage: 1,
  // Common
  openPosition: null,
  totalProfit: 0,
  totalTrades: 0,
  lastLog: [],
  countdown: 0,
  fundingRate: 0,
  timer: null,
  orderPlacedThisCycle: false
};

function addLog(msg, type = 'info') {
  const entry = { time: new Date().toLocaleTimeString('hi-IN'), msg, type };
  botState.lastLog.unshift(entry);
  if (botState.lastLog.length > 100) botState.lastLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function formatTime(secs) {
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: '✅ Param Beer Shakti Server Live!',
    botRunning: botState.running,
    mode: botState.mode,
    fundingPairs: Object.keys(fundingData).length,
    time: new Date().toISOString()
  });
});

app.get('/bot/status', (req, res) => {
  res.json({
    running: botState.running,
    mode: botState.mode,
    exchange: botState.exchange,
    pair: botState.pair,
    side: botState.side,
    countdown: botState.countdown,
    fundingRate: botState.fundingRate,
    openPosition: botState.openPosition,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    lastLog: botState.lastLog.slice(0, 20)
  });
});

// ══════════════════════════════════════════
// BOT START — Single Exchange Mode
// ══════════════════════════════════════════
app.post('/bot/start', async (req, res) => {
  const { apiKey, apiSecret, pair, side, quantity, leverage, exchange } = req.body;
  if (!apiKey || !apiSecret || !pair || !side || !quantity) {
    return res.json({ success: false, error: 'Missing fields' });
  }
  if (botState.running) return res.json({ success: false, error: 'Bot already running!' });

  botState.mode = 'single';
  botState.apiKey = apiKey;
  botState.apiSecret = apiSecret;
  botState.pair = pair;
  botState.side = side;
  botState.quantity = parseFloat(quantity);
  botState.leverage = parseInt(leverage) || 1;
  botState.exchange = exchange || 'coindcx';
  botState.running = true;
  botState.orderPlacedThisCycle = false;

  addLog(`🟢 Single Bot Started! [${botState.exchange.toUpperCase()}] ${pair} | ${side.toUpperCase()}`, 'info');
  startBotLoop();
  res.json({ success: true, message: 'Bot started!' });
});

// ══════════════════════════════════════════
// BOT START — Arbitrage Mode (2 exchanges)
// ══════════════════════════════════════════
app.post('/bot/arb/start', async (req, res) => {
  const {
    longEx, longApiKey, longApiSecret, longPair,
    shortEx, shortApiKey, shortApiSecret, shortPair,
    quantity, leverage
  } = req.body;

  if (!longEx || !longApiKey || !longApiSecret || !longPair ||
      !shortEx || !shortApiKey || !shortApiSecret || !shortPair || !quantity) {
    return res.json({ success: false, error: 'Missing arbitrage fields' });
  }
  if (botState.running) return res.json({ success: false, error: 'Bot already running!' });

  botState.mode = 'arbitrage';
  botState.longEx = longEx;
  botState.longApiKey = longApiKey;
  botState.longApiSecret = longApiSecret;
  botState.longPair = longPair;
  botState.shortEx = shortEx;
  botState.shortApiKey = shortApiKey;
  botState.shortApiSecret = shortApiSecret;
  botState.shortPair = shortPair;
  botState.arbQuantity = parseFloat(quantity);
  botState.arbLeverage = parseInt(leverage) || 1;
  botState.running = true;
  botState.orderPlacedThisCycle = false;

  // Use longPair for countdown reference
  botState.pair = longPair;
  botState.exchange = longEx;

  addLog(`🟢 ARB Bot Started! LONG [${longEx.toUpperCase()}] ${longPair} | SHORT [${shortEx.toUpperCase()}] ${shortPair}`, 'info');
  startBotLoop();
  res.json({ success: true, message: 'Arbitrage bot started!' });
});

app.post('/bot/stop', (req, res) => {
  botState.running = false;
  if (botState.timer) { clearInterval(botState.timer); botState.timer = null; }
  addLog('⏹ Bot Stopped', 'info');
  res.json({ success: true });
});

// ══════════════════════════════════════════
// FUNDING COUNTDOWN HELPERS
// ══════════════════════════════════════════
function getISTCountdown() {
  const now = new Date();
  const utcSecs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const istSecs = (utcSecs + 19800) % 86400;
  const cycles = [0, 8 * 3600, 16 * 3600, 24 * 3600];
  let left = 0;
  for (let c of cycles) {
    if (c > istSecs) { left = c - istSecs; break; }
  }
  if (left === 0) left = 86400 - istSecs;
  return left;
}

// Delta Exchange: funding every 8h at 00:00, 08:00, 16:00 UTC
function getDeltaUTCCountdown() {
  const now = new Date();
  const utcSecs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const cycles = [0, 8 * 3600, 16 * 3600, 24 * 3600];
  let left = 0;
  for (let c of cycles) {
    if (c > utcSecs) { left = c - utcSecs; break; }
  }
  if (left === 0) left = 86400 - utcSecs;
  return left;
}

async function fetchFundingCountdown(pair, exchange = 'coindcx') {
  try {
    if (exchange === 'coindcx') {
      const response = await axios.get(
        `https://api.coindcx.com/exchange/v1/derivatives/funding_rate?pair=${pair}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://coindcx.com' }, timeout: 8000 }
      );
      const d = response.data;
      if (d.funding_rate !== undefined) botState.fundingRate = parseFloat(d.funding_rate);
      if (d.next_funding_time) {
        const nft = d.next_funding_time;
        let ms;
        if (String(nft).length === 13) ms = parseInt(nft) - Date.now();
        else if (String(nft).length === 10) ms = parseInt(nft) * 1000 - Date.now();
        else ms = new Date(nft).getTime() - Date.now();
        if (ms > 0 && ms < 9 * 3600 * 1000) return Math.floor(ms / 1000);
      }
      return getISTCountdown();

    } else if (exchange === 'delta') {
      const response = await axios.get(
        `https://api.india.delta.exchange/v2/tickers/${pair}`,
        { timeout: 8000 }
      );
      const d = response.data?.result;
      if (d) {
        if (d.funding_rate !== undefined) botState.fundingRate = parseFloat(d.funding_rate);
        if (d.next_funding_realization) {
          const ms = new Date(d.next_funding_realization).getTime() - Date.now();
          if (ms > 0 && ms < 9 * 3600 * 1000) return Math.floor(ms / 1000);
        }
      }
      return getDeltaUTCCountdown();

    } else if (exchange === 'mudrex') {
      // Mudrex funding: every 8h at 00:00, 08:00, 16:00 UTC
      const response = await axios.get(
        `https://api.mudrex.com/api/v1/futures/funding_rate?symbol=${pair}`,
        { timeout: 8000 }
      );
      const d = response.data;
      if (d.next_funding_time) {
        const ms = parseInt(d.next_funding_time) - Date.now();
        if (ms > 0 && ms < 9 * 3600 * 1000) return Math.floor(ms / 1000);
      }
      if (d.funding_rate !== undefined) botState.fundingRate = parseFloat(d.funding_rate);
      return getDeltaUTCCountdown();
    }
  } catch (e) {
    console.log(`fetchFundingCountdown [${exchange}] error:`, e.message);
  }

  // Universal fallback
  return getISTCountdown();
}

// ══════════════════════════════════════════
// FUNDING TIME API ENDPOINT
// ══════════════════════════════════════════
app.get('/funding/time', async (req, res) => {
  const { pair, ex } = req.query;
  if (!pair) return res.json({ success: false, error: 'pair required' });
  const exchange = ex || 'coindcx';
  const cacheKey = `${exchange}:${pair}`;

  const cached = fundingData[cacheKey];
  if (cached && (Date.now() - cached.updatedAt) < 60000) {
    const elapsed = Math.floor((Date.now() - cached.updatedAt) / 1000);
    const secs = Math.max(0, cached.countdown - elapsed);
    return res.json({ success: true, pair, exchange, countdown: secs, funding_rate: cached.rate || 0, source: 'cache', display: formatTime(secs) });
  }

  const secs = await fetchFundingCountdown(pair, exchange);
  fundingData[cacheKey] = { countdown: secs, rate: botState.fundingRate, updatedAt: Date.now() };
  res.json({ success: true, pair, exchange, countdown: secs, funding_rate: botState.fundingRate, source: 'fresh', display: formatTime(secs) });
});

// ══════════════════════════════════════════
// ══════════════════════════════════════════
//   EXCHANGE ORDER FUNCTIONS
// ══════════════════════════════════════════
// ══════════════════════════════════════════

// ─── CoinDCX ───────────────────────────────
async function orderCoinDCX({ apiKey, apiSecret, pair, side, quantity, leverage }) {
  const timestamp = Date.now();
  const bodyObj = { market: pair, order_type: 'market_order', side, quantity, leverage, timestamp };
  const bodyStr = JSON.stringify(bodyObj);
  const signature = crypto.createHmac('sha256', apiSecret).update(bodyStr).digest('hex');
  const response = await axios.post(
    'https://api.coindcx.com/exchange/v1/derivatives/orders',
    bodyObj,
    { headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signature }, timeout: 10000 }
  );
  return { success: true, orderId: response.data.id, data: response.data };
}

// ─── Delta Exchange ────────────────────────
// Delta uses product_id (integer), not symbol string for orders.
// We first resolve symbol → product_id, then place order.
const deltaProductCache = {};
async function getDeltaProductId(symbol) {
  if (deltaProductCache[symbol]) return deltaProductCache[symbol];
  const r = await axios.get('https://api.india.delta.exchange/v2/products?contract_types=perpetual_futures', { timeout: 8000 });
  const products = r.data?.result || [];
  const found = products.find(p => p.symbol === symbol);
  if (found) { deltaProductCache[symbol] = found.id; return found.id; }
  throw new Error(`Delta product_id not found for symbol: ${symbol}`);
}

async function orderDelta({ apiKey, apiSecret, pair, side, quantity, leverage }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = 'POST';
  const path = '/v2/orders';
  const productId = await getDeltaProductId(pair);

  const bodyObj = {
    product_id: productId,
    order_type: 'market_order',
    side: side.toLowerCase(),   // 'buy' | 'sell'
    size: parseInt(quantity),
    leverage: String(leverage)
  };
  const bodyStr = JSON.stringify(bodyObj);

  // Delta signature: method + timestamp + path + body
  const sigPayload = method + timestamp + path + bodyStr;
  const signature = crypto.createHmac('sha256', apiSecret).update(sigPayload).digest('hex');

  const response = await axios.post(
    `https://api.india.delta.exchange${path}`,
    bodyObj,
    {
      headers: {
        'api-key': apiKey,
        'timestamp': String(timestamp),
        'signature': signature,
        'Content-Type': 'application/json',
        'User-Agent': 'parambeer-bot/1.0'
      },
      timeout: 10000
    }
  );
  const d = response.data;
  if (d.success) return { success: true, orderId: d.result?.id, data: d.result };
  throw new Error(d.error?.message || 'Delta order failed');
}

// ─── Mudrex ───────────────────────────────
async function orderMudrex({ apiKey, apiSecret, pair, side, quantity, leverage }) {
  const timestamp = Date.now();
  const bodyObj = {
    symbol: pair,
    side: side.toUpperCase(),   // 'BUY' | 'SELL'
    order_type: 'MARKET',
    quantity: parseFloat(quantity),
    leverage: parseInt(leverage),
    timestamp
  };
  const bodyStr = JSON.stringify(bodyObj);
  const signature = crypto.createHmac('sha256', apiSecret).update(bodyStr).digest('hex');

  const response = await axios.post(
    'https://api.mudrex.com/api/v1/futures/order',
    bodyObj,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-MUDREX-ACCESS-KEY': apiKey,
        'X-MUDREX-SIGNATURE': signature,
        'X-MUDREX-TIMESTAMP': String(timestamp)
      },
      timeout: 10000
    }
  );
  const d = response.data;
  if (d.success || d.order_id) return { success: true, orderId: d.order_id || d.id, data: d };
  throw new Error(d.message || 'Mudrex order failed');
}

// ─── Universal Order Router ────────────────
async function placeExchangeOrder(exchange, params) {
  try {
    let result;
    if (exchange === 'coindcx') result = await orderCoinDCX(params);
    else if (exchange === 'delta') result = await orderDelta(params);
    else if (exchange === 'mudrex') result = await orderMudrex(params);
    else throw new Error(`Unknown exchange: ${exchange}`);
    return result;
  } catch (e) {
    const errMsg = e.response?.data?.message || e.response?.data?.error?.message || e.message;
    console.log(`[${exchange}] order error:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// Shortcut for single-mode bot
async function placeOrder(side) {
  return placeExchangeOrder(botState.exchange, {
    apiKey: botState.apiKey,
    apiSecret: botState.apiSecret,
    pair: botState.pair,
    side,
    quantity: botState.quantity,
    leverage: botState.leverage
  });
}

// ══════════════════════════════════════════
// BOT MAIN LOOP
// ══════════════════════════════════════════
async function startBotLoop() {
  if (botState.timer) clearInterval(botState.timer);
  botState.countdown = await fetchFundingCountdown(botState.pair, botState.exchange);
  addLog(`⏱ Countdown: ${formatTime(botState.countdown)}`, 'info');

  botState.timer = setInterval(async () => {
    if (!botState.running) { clearInterval(botState.timer); return; }
    botState.countdown--;

    // Place order 1 second before funding
    if (botState.countdown === 1 && !botState.orderPlacedThisCycle) {
      botState.orderPlacedThisCycle = true;

      if (botState.mode === 'single') {
        addLog(`⚡ Placing ORDER: ${botState.side.toUpperCase()} on ${botState.exchange.toUpperCase()}`, 'buy');
        const result = await placeOrder(botState.side);
        if (result.success) {
          botState.openPosition = { side: botState.side, quantity: botState.quantity, orderId: result.orderId, time: Date.now() };
          botState.totalTrades++;
          addLog(`✅ Order Placed! ID: ${result.orderId}`, 'buy');
        } else {
          addLog(`❌ Order Failed: ${result.error}`, 'info');
          botState.orderPlacedThisCycle = false;
        }

      } else if (botState.mode === 'arbitrage') {
        addLog(`⚡ ARB: LONG [${botState.longEx.toUpperCase()}] + SHORT [${botState.shortEx.toUpperCase()}]`, 'buy');
        // Place both legs simultaneously
        const [longResult, shortResult] = await Promise.all([
          placeExchangeOrder(botState.longEx, {
            apiKey: botState.longApiKey, apiSecret: botState.longApiSecret,
            pair: botState.longPair, side: 'buy',
            quantity: botState.arbQuantity, leverage: botState.arbLeverage
          }),
          placeExchangeOrder(botState.shortEx, {
            apiKey: botState.shortApiKey, apiSecret: botState.shortApiSecret,
            pair: botState.shortPair, side: 'sell',
            quantity: botState.arbQuantity, leverage: botState.arbLeverage
          })
        ]);

        if (longResult.success && shortResult.success) {
          botState.openPosition = {
            longOrderId: longResult.orderId,
            shortOrderId: shortResult.orderId,
            quantity: botState.arbQuantity,
            time: Date.now()
          };
          botState.totalTrades++;
          addLog(`✅ ARB Legs Placed! LONG: ${longResult.orderId} | SHORT: ${shortResult.orderId}`, 'buy');
        } else {
          if (!longResult.success) addLog(`❌ LONG Failed [${botState.longEx}]: ${longResult.error}`, 'info');
          if (!shortResult.success) addLog(`❌ SHORT Failed [${botState.shortEx}]: ${shortResult.error}`, 'info');
          botState.orderPlacedThisCycle = false;
        }
      }
    }

    // Funding settled
    if (botState.countdown <= 0) {
      botState.orderPlacedThisCycle = false;
      addLog('💰 Funding Settled!', 'info');

      setTimeout(async () => {
        if (botState.openPosition) {
          if (botState.mode === 'single') {
            const closeSide = botState.openPosition.side === 'buy' ? 'sell' : 'buy';
            addLog(`🔄 Closing: ${closeSide.toUpperCase()} on ${botState.exchange.toUpperCase()}`, 'sell');
            const r = await placeOrder(closeSide);
            if (r.success) {
              const earned = botState.quantity * Math.abs(botState.fundingRate) * 84;
              botState.totalProfit += earned;
              addLog(`✅ Closed! ~₹${earned.toFixed(2)} earned`, 'sell');
              botState.openPosition = null;
            } else {
              addLog(`❌ Close Failed: ${r.error}`, 'info');
            }

          } else if (botState.mode === 'arbitrage') {
            addLog(`🔄 Closing ARB legs...`, 'sell');
            const [closeLong, closeShort] = await Promise.all([
              placeExchangeOrder(botState.longEx, {
                apiKey: botState.longApiKey, apiSecret: botState.longApiSecret,
                pair: botState.longPair, side: 'sell',
                quantity: botState.arbQuantity, leverage: botState.arbLeverage
              }),
              placeExchangeOrder(botState.shortEx, {
                apiKey: botState.shortApiKey, apiSecret: botState.shortApiSecret,
                pair: botState.shortPair, side: 'buy',
                quantity: botState.arbQuantity, leverage: botState.arbLeverage
              })
            ]);

            if (closeLong.success && closeShort.success) {
              const earned = botState.arbQuantity * Math.abs(botState.fundingRate) * 2 * 84;
              botState.totalProfit += earned;
              addLog(`✅ ARB Closed! ~₹${earned.toFixed(2)} earned`, 'sell');
              botState.openPosition = null;
            } else {
              if (!closeLong.success) addLog(`❌ Close LONG Failed [${botState.longEx}]: ${closeLong.error}`, 'info');
              if (!closeShort.success) addLog(`❌ Close SHORT Failed [${botState.shortEx}]: ${closeShort.error}`, 'info');
            }
          }
        }

        botState.countdown = await fetchFundingCountdown(botState.pair, botState.exchange);
        addLog(`⏱ Next cycle: ${formatTime(botState.countdown)}`, 'info');
      }, 2000);
    }

    // हर 5 मिनट drift correction
    if (botState.countdown > 60 && botState.countdown % 300 === 0) {
      fetchFundingCountdown(botState.pair, botState.exchange).then(c => {
        botState.countdown = c;
        addLog(`🔄 Synced: ${formatTime(c)}`, 'info');
      });
    }
  }, 1000);
}

// ══════════════════════════════════════════
// SCAN — All 3 Exchanges
// ══════════════════════════════════════════
app.get('/scan', async (req, res) => {
  const ex = req.query.ex || 'coindcx';
  let results = [];
  try {
    if (ex === 'coindcx') {
      const r = await axios.get('https://api.coindcx.com/exchange/v1/derivatives/tickers',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://coindcx.com' }, timeout: 10000 });
      if (Array.isArray(r.data)) {
        results = r.data
          .filter(t => t.funding_rate != null)
          .map(t => ({
            symbol: (t.symbol || '').replace('B-', '').replace('_USDT', ''),
            pair: t.symbol,
            funding_rate: parseFloat(t.funding_rate),
            next_funding_time: t.next_funding_time || null,
            price: t.mark_price || t.last_price || null,
            exchange: 'coindcx'
          }))
          .filter(t => t.symbol && Math.abs(t.funding_rate) > 0)
          .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));
      }

    } else if (ex === 'delta') {
      const r = await axios.get('https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures', { timeout: 10000 });
      if (r.data?.success && r.data?.result) {
        results = r.data.result
          .filter(t => t.funding_rate != null)
          .map(t => ({
            symbol: t.underlying_asset_symbol || t.symbol,
            pair: t.symbol,
            funding_rate: parseFloat(t.funding_rate),
            next_funding_time: t.next_funding_realization || null,
            price: t.mark_price || null,
            exchange: 'delta'
          }))
          .filter(t => t.symbol && Math.abs(t.funding_rate) > 0)
          .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));
      }

    } else if (ex === 'mudrex') {
      const r = await axios.get('https://api.mudrex.com/api/v1/futures/tickers', { timeout: 10000 });
      const data = r.data?.data || r.data?.tickers || r.data || [];
      if (Array.isArray(data)) {
        results = data
          .filter(t => t.funding_rate != null)
          .map(t => ({
            symbol: (t.symbol || '').replace('USDT', '').replace('-', '').replace('_', ''),
            pair: t.symbol,
            funding_rate: parseFloat(t.funding_rate),
            next_funding_time: t.next_funding_time || null,
            price: t.mark_price || t.last_price || null,
            exchange: 'mudrex'
          }))
          .filter(t => t.symbol && Math.abs(t.funding_rate) > 0)
          .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));
      }

    } else if (ex === 'all') {
      // Scan all 3 simultaneously — useful for cross-exchange arbitrage opportunities
      const [cdcx, delta, mudrex] = await Promise.allSettled([
        axios.get('https://api.coindcx.com/exchange/v1/derivatives/tickers',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://coindcx.com' }, timeout: 10000 }),
        axios.get('https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures', { timeout: 10000 }),
        axios.get('https://api.mudrex.com/api/v1/futures/tickers', { timeout: 10000 })
      ]);

      let all = [];
      if (cdcx.status === 'fulfilled' && Array.isArray(cdcx.value.data)) {
        cdcx.value.data.filter(t => t.funding_rate != null).forEach(t => {
          all.push({
            symbol: (t.symbol || '').replace('B-', '').replace('_USDT', ''),
            pair: t.symbol, funding_rate: parseFloat(t.funding_rate),
            price: t.mark_price || null, exchange: 'coindcx'
          });
        });
      }
      if (delta.status === 'fulfilled' && delta.value.data?.result) {
        delta.value.data.result.filter(t => t.funding_rate != null).forEach(t => {
          all.push({
            symbol: t.underlying_asset_symbol || t.symbol,
            pair: t.symbol, funding_rate: parseFloat(t.funding_rate),
            price: t.mark_price || null, exchange: 'delta'
          });
        });
      }
      const mData = mudrex.status === 'fulfilled' ? (mudrex.value.data?.data || mudrex.value.data?.tickers || mudrex.value.data || []) : [];
      if (Array.isArray(mData)) {
        mData.filter(t => t.funding_rate != null).forEach(t => {
          all.push({
            symbol: (t.symbol || '').replace('USDT', '').replace(/[-_]/g, ''),
            pair: t.symbol, funding_rate: parseFloat(t.funding_rate),
            price: t.mark_price || null, exchange: 'mudrex'
          });
        });
      }

      // Find arbitrage opportunities: same symbol, opposite funding rates across exchanges
      const bySymbol = {};
      all.filter(t => t.symbol && Math.abs(t.funding_rate) > 0).forEach(t => {
        if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
        bySymbol[t.symbol].push(t);
      });
      const arbOpps = [];
      Object.entries(bySymbol).forEach(([sym, entries]) => {
        if (entries.length >= 2) {
          const maxRate = entries.reduce((a, b) => Math.abs(a.funding_rate) >= Math.abs(b.funding_rate) ? a : b);
          const minRate = entries.reduce((a, b) => Math.abs(a.funding_rate) <= Math.abs(b.funding_rate) ? a : b);
          const spread = Math.abs(maxRate.funding_rate - minRate.funding_rate);
          if (spread > 0.0001) {
            arbOpps.push({ symbol: sym, spread, longOn: minRate.exchange, shortOn: maxRate.exchange, entries });
          }
        }
      });

      return res.json({
        success: true, exchange: 'all',
        count: all.length,
        results: all.sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate)),
        arbitrage_opportunities: arbOpps.sort((a, b) => b.spread - a.spread)
      });
    }
  } catch (e) {
    console.log('Scan error:', e.message);
  }
  res.json({ success: true, exchange: ex, count: results.length, results });
});

// ══════════════════════════════════════════
// MANUAL ORDER — All 3 Exchanges
// ══════════════════════════════════════════
app.post('/order/place', async (req, res) => {
  const { exchange, apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  if (!exchange || !apiKey || !apiSecret || !pair || !side || !quantity) {
    return res.json({ success: false, error: 'Missing required fields (exchange, apiKey, apiSecret, pair, side, quantity)' });
  }
  const result = await placeExchangeOrder(exchange, {
    apiKey, apiSecret, pair, side,
    quantity: parseFloat(quantity),
    leverage: parseInt(leverage) || 1
  });
  res.json(result);
});

app.post('/order/close', async (req, res) => {
  const { exchange, apiKey, apiSecret, pair, side, quantity, leverage } = req.body;
  if (!exchange || !apiKey || !apiSecret || !pair || !side || !quantity) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  const result = await placeExchangeOrder(exchange, {
    apiKey, apiSecret, pair, side: closeSide,
    quantity: parseFloat(quantity),
    leverage: parseInt(leverage) || 1
  });
  res.json(result);
});

// ══════════════════════════════════════════
// COINS LIST — per exchange
// ══════════════════════════════════════════
app.get('/coins', async (req, res) => {
  const ex = req.query.ex || 'coindcx';
  try {
    if (ex === 'coindcx') {
      const r = await axios.get('https://api.coindcx.com/exchange/v1/markets_details', { timeout: 10000 });
      const coins = r.data
        .filter(m => m.symbol?.startsWith('B-') && m.symbol?.endsWith('_USDT') && m.status === 'active')
        .map(m => ({
          symbol: m.base_currency_short_name || m.symbol.replace('B-', '').replace('_USDT', ''),
          name: m.base_currency_name || '',
          pair: m.symbol,
          max_leverage: m.max_leverage || null,
          exchange: 'coindcx'
        }));
      return res.json({ success: true, exchange: ex, count: coins.length, coins });

    } else if (ex === 'delta') {
      const r = await axios.get('https://api.india.delta.exchange/v2/products?contract_types=perpetual_futures', { timeout: 10000 });
      const coins = (r.data?.result || []).map(p => ({
        symbol: p.underlying_asset?.symbol || p.symbol,
        name: p.description || '',
        pair: p.symbol,
        product_id: p.id,
        max_leverage: p.max_leverage || null,
        exchange: 'delta'
      }));
      return res.json({ success: true, exchange: ex, count: coins.length, coins });

    } else if (ex === 'mudrex') {
      const r = await axios.get('https://api.mudrex.com/api/v1/futures/instruments', { timeout: 10000 });
      const data = r.data?.data || r.data?.instruments || r.data || [];
      const coins = (Array.isArray(data) ? data : []).map(p => ({
        symbol: (p.symbol || '').replace('USDT', '').replace(/[-_]/g, ''),
        name: p.name || p.symbol || '',
        pair: p.symbol,
        max_leverage: p.max_leverage || null,
        exchange: 'mudrex'
      }));
      return res.json({ success: true, exchange: ex, count: coins.length, coins });
    }

    res.json({ success: false, error: 'Unknown exchange. Use: coindcx | delta | mudrex' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Param Beer Shakti Bot Server running on port ${PORT}`);
  console.log(`📡 Exchanges: CoinDCX | Delta Exchange | Mudrex`);
  console.log(`🚀 Health: http://localhost:${PORT}/`);
});
