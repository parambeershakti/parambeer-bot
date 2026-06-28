const axios = require('axios');
const crypto = require('crypto');

const TELEGRAM_TOKEN = '8919424772:AAG2EUSwEComTQ2-9hAP6lUfKhQ7eu-PUcA';
const CHAT_ID = '354226332';
const SERVER = 'https://lightgray-llama-157082.hostingersite.com';

let state = {
  step: 'menu',
  apiKeys: { coindcx: { key: '', secret: '' }, delta: { key: '', secret: '' }, mudrex: { key: '', secret: '' } },
  trade: { exchange: '', pair: '', side: '', quantity: 0, leverage: 10 },
  countdown: 0,
  timer: null,
  totalProfit: 0,
  totalTrades: 0,
  openPosition: null,
  lastOrder: null,
  lastClose: null
};

// ══════════════════════════════
// TELEGRAM
// ══════════════════════════════
async function send(text, keyboard = null) {
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, body, { timeout: 10000 });
  } catch (e) { console.log('Send error:', e.message); }
}

function fmt(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

const MAIN_MENU = [
  ['📊 Funding Scan', '⚡ Trade Setup'],
  ['🕐 Timer Trade', '📈 Manual Order'],
  ['💰 Profit/Loss', '⚙️ API Settings'],
  ['🤖 Bot Status', '❓ Help']
];

// ══════════════════════════════
// SCAN
// ══════════════════════════════
async function doScan(exchange) {
  await send(`⏳ <b>${exchange.toUpperCase()}</b> scan हो रही है...`);
  try {
    const r = await axios.get(`${SERVER}/scan?ex=${exchange}`, { timeout: 15000 });
    const results = r.data.results?.slice(0, 10) || [];
    if (!results.length) { await send('❌ कोई data नहीं मिला।', MAIN_MENU); return; }

    let msg = `📊 <b>${exchange.toUpperCase()} — Top 10 Funding Rates</b>\n\n`;
    results.forEach((r, i) => {
      const rate = (r.funding_rate * 100).toFixed(4);
      const sign = r.funding_rate > 0 ? '🟢' : '🔴';
      const action = r.funding_rate > 0 ? '→ BUY करो' : '→ SELL करो';
      msg += `${i + 1}. ${sign} <b>${r.symbol}</b> ${rate}% ${action}\n`;
    });
    msg += `\n💡 Positive = BUY | Negative = SELL`;
    await send(msg, MAIN_MENU);
  } catch (e) {
    await send(`❌ Scan error: ${e.message}`, MAIN_MENU);
  }
}

// ══════════════════════════════
// ORDER
// ══════════════════════════════
async function placeOrder(exchange, apiKey, apiSecret, pair, side, quantity, leverage) {
  try {
    const r = await axios.post(`${SERVER}/order/place`, {
      exchange, apiKey, apiSecret, pair, side,
      quantity: parseFloat(quantity), leverage: parseInt(leverage)
    }, { timeout: 15000 });
    return r.data;
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

async function closeOrder(exchange, apiKey, apiSecret, pair, side, quantity, leverage) {
  try {
    const r = await axios.post(`${SERVER}/order/close`, {
      exchange, apiKey, apiSecret, pair, side,
      quantity: parseFloat(quantity), leverage: parseInt(leverage)
    }, { timeout: 15000 });
    return r.data;
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

// ══════════════════════════════
// TIMER TRADE — 1 sec pehle order, 1 sec baad close
// ══════════════════════════════
async function startTimer(secs) {
  const { exchange, pair, side, quantity, leverage } = state.trade;
  const apiKey = state.apiKeys[exchange]?.key;
  const apiSecret = state.apiKeys[exchange]?.secret;

  await send(
    `🚀 <b>Timer Trade शुरू!</b>\n\n` +
    `Exchange: <b>${exchange.toUpperCase()}</b>\n` +
    `Pair: <b>${pair}</b>\n` +
    `Side: <b>${side.toUpperCase()}</b>\n` +
    `Quantity: <b>${quantity}</b>\n` +
    `Leverage: <b>${leverage}x</b>\n` +
    `⏰ Countdown: <b>${fmt(secs)}</b>\n\n` +
    `⚡ 1 second पहले ORDER लगेगा\n` +
    `✅ Funding settle होते ही 1 sec बाद CLOSE`
  );

  let remaining = secs;
  let orderPlaced = false;

  if (state.timer) clearInterval(state.timer);

  state.timer = setInterval(async () => {
    remaining--;

    // 1 second पहले — ORDER
    if (remaining === 1 && !orderPlaced) {
      orderPlaced = true;
      await send(`⚡ <b>ORDER लग रहा है!</b>\n${side.toUpperCase()} | ${pair}`);
      const result = await placeOrder(exchange, apiKey, apiSecret, pair, side, quantity, leverage);
      if (result.success) {
        state.openPosition = { exchange, pair, side, quantity, leverage, orderId: result.orderId };
        state.lastOrder = new Date().toLocaleTimeString('hi-IN');
        state.totalTrades++;
        await send(`✅ <b>Order Placed!</b>\nID: <code>${result.orderId}</code>\n${side.toUpperCase()} ${quantity} ${pair}`);
      } else {
        await send(`❌ <b>Order Failed!</b>\n${result.error}`, MAIN_MENU);
        clearInterval(state.timer);
        state.step = 'menu';
        return;
      }
    }

    // 0 seconds — FUNDING SETTLED
    if (remaining <= 0) {
      clearInterval(state.timer);
      state.step = 'menu';
      await send(`💰 <b>Funding Settle!</b>\n1 second में CLOSE हो रहा है...`);

      setTimeout(async () => {
        if (state.openPosition) {
          const closeSide = state.openPosition.side === 'buy' ? 'sell' : 'buy';
          const closeResult = await closeOrder(
            state.openPosition.exchange, apiKey, apiSecret,
            state.openPosition.pair, state.openPosition.side,
            state.openPosition.quantity, state.openPosition.leverage
          );
          if (closeResult.success) {
            state.lastClose = new Date().toLocaleTimeString('hi-IN');
            state.openPosition = null;
            await send(
              `✅ <b>Position Closed!</b>\nID: <code>${closeResult.orderId}</code>\n\n` +
              `🎯 Trade Complete!\n💰 Total Trades: ${state.totalTrades}`,
              MAIN_MENU
            );
          } else {
            await send(`❌ <b>Close Failed!</b>\n${closeResult.error}\n\n⚠️ Manual close करो!`, MAIN_MENU);
          }
        }
      }, 1000);

      return;
    }

    // हर 1 घंटे पर update
    if (remaining > 0 && remaining % 3600 === 0) {
      await send(`⏱ <b>Update:</b> ${fmt(remaining)} बाकी है...`);
    }
    // 5 min पर update
    if (remaining > 0 && remaining <= 300 && remaining % 60 === 0) {
      await send(`⏱ ${fmt(remaining)} बाकी...`);
    }
    // 30 sec पर update
    if (remaining <= 30 && remaining > 0 && remaining % 10 === 0) {
      await send(`⚡ <b>${remaining} seconds</b> बाकी!`);
    }

  }, 1000);
}

// ══════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════
async function handle(text) {
  text = (text || '').trim();

  // ── MAIN MENU ──
  if (['/start', '🏠 Home', '❌ Cancel', '⬅️ Back'].includes(text)) {
    state.step = 'menu';
    await send(
      `🚀 <b>Param Beer Shakti Trading Bot</b>\n\n` +
      `📊 Scan — Funding rates देखो\n` +
      `⚡ Trade Setup — Exchange & coin select करो\n` +
      `🕐 Timer — Time डालो, auto order लगेगा\n` +
      `📈 Manual — खुद order लगाओ\n` +
      `💰 Profit — अपना P&L देखो\n` +
      `⚙️ Settings — API Keys डालो`,
      MAIN_MENU
    );
    return;
  }

  // ── SCAN ──
  if (text === '📊 Funding Scan') {
    state.step = 'scan';
    await send('📊 Exchange चुनो:', [['⚡ CoinDCX', '💎 Delta', '🟠 Mudrex'], ['🌐 All Exchanges', '⬅️ Back']]);
    return;
  }
  if (state.step === 'scan') {
    const ex = { '⚡ CoinDCX': 'coindcx', '💎 Delta': 'delta', '🟠 Mudrex': 'mudrex', '🌐 All Exchanges': 'all' }[text];
    if (ex) { state.step = 'menu'; await doScan(ex); return; }
  }

  // ── TRADE SETUP ──
  if (text === '⚡ Trade Setup') {
    state.step = 'setup_exchange';
    await send('🏦 Exchange चुनो:', [['⚡ CoinDCX', '💎 Delta', '🟠 Mudrex'], ['⬅️ Back']]);
    return;
  }
  if (state.step === 'setup_exchange') {
    const ex = { '⚡ CoinDCX': 'coindcx', '💎 Delta': 'delta', '🟠 Mudrex': 'mudrex' }[text];
    if (ex) {
      state.trade.exchange = ex;
      state.step = 'setup_pair';
      await send(`📈 <b>Pair</b> डालो:\nExample: <code>B-BTC_USDT</code>`);
      return;
    }
  }
  if (state.step === 'setup_pair') {
    state.trade.pair = text.toUpperCase();
    state.step = 'setup_side';
    await send('📊 Side चुनो:', [['🟢 BUY (Long)', '🔴 SELL (Short)'], ['⬅️ Back']]);
    return;
  }
  if (state.step === 'setup_side') {
    if (text === '🟢 BUY (Long)') state.trade.side = 'buy';
    else if (text === '🔴 SELL (Short)') state.trade.side = 'sell';
    else { await send('BUY या SELL चुनो!'); return; }
    state.step = 'setup_qty';
    await send(`💰 <b>Quantity</b> डालो:\nExample: <code>0.001</code>`);
    return;
  }
  if (state.step === 'setup_qty') {
    state.trade.quantity = parseFloat(text);
    state.step = 'setup_lev';
    await send(`⚖️ <b>Leverage</b> डालो:\nExample: <code>10</code>`, [['5', '10', '20'], ['50', '100', '⬅️ Back']]);
    return;
  }
  if (state.step === 'setup_lev') {
    state.trade.leverage = parseInt(text);
    state.step = 'menu';
    await send(
      `✅ <b>Trade Setup Complete!</b>\n\n` +
      `Exchange: <b>${state.trade.exchange.toUpperCase()}</b>\n` +
      `Pair: <b>${state.trade.pair}</b>\n` +
      `Side: <b>${state.trade.side.toUpperCase()}</b>\n` +
      `Quantity: <b>${state.trade.quantity}</b>\n` +
      `Leverage: <b>${state.trade.leverage}x</b>\n\n` +
      `अब <b>🕐 Timer Trade</b> या <b>📈 Manual Order</b> use करो!`,
      MAIN_MENU
    );
    return;
  }

  // ── TIMER TRADE ──
  if (text === '🕐 Timer Trade') {
    if (!state.trade.pair) {
      await send('⚠️ पहले <b>⚡ Trade Setup</b> करो!', MAIN_MENU);
      return;
    }
    state.step = 'timer_input';
    await send(
      `⏰ <b>Funding Time डालो</b>\n\n` +
      `CoinDCX/Delta app में funding countdown देखो\n` +
      `Format: <code>घंटे:मिनट:सेकंड</code>\n\n` +
      `Examples:\n` +
      `<code>7:45:30</code> = 7 घंटे 45 मिनट\n` +
      `<code>0:30:00</code> = 30 मिनट\n` +
      `<code>0:05:20</code> = 5 मिनट 20 सेकंड`
    );
    return;
  }
  if (state.step === 'timer_input') {
    const parts = text.split(':');
    if (parts.length !== 3) { await send('❌ Format गलत!\nExample: <code>2:15:30</code>'); return; }
    const secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    if (isNaN(secs) || secs <= 0) { await send('❌ Time गलत!'); return; }

    state.step = 'timer_confirm';
    state.countdown = secs;
    await send(
      `✅ <b>Confirm करो:</b>\n\n` +
      `Exchange: <b>${state.trade.exchange?.toUpperCase()}</b>\n` +
      `Pair: <b>${state.trade.pair}</b>\n` +
      `Side: <b>${state.trade.side?.toUpperCase()}</b>\n` +
      `Quantity: <b>${state.trade.quantity}</b>\n` +
      `Leverage: <b>${state.trade.leverage}x</b>\n` +
      `⏰ Countdown: <b>${fmt(secs)}</b>\n\n` +
      `⚡ 1 second पहले ORDER\n✅ Settle होते ही CLOSE`,
      [['✅ START करो!', '❌ Cancel']]
    );
    return;
  }
  if (state.step === 'timer_confirm') {
    if (text === '✅ START करो!') {
      state.step = 'running';
      await startTimer(state.countdown);
    } else {
      state.step = 'menu';
      await send('❌ Cancel हो गया।', MAIN_MENU);
    }
    return;
  }

  // ── MANUAL ORDER ──
  if (text === '📈 Manual Order') {
    if (!state.trade.pair) {
      await send('⚠️ पहले <b>⚡ Trade Setup</b> करो!', MAIN_MENU);
      return;
    }
    const apiKey = state.apiKeys[state.trade.exchange]?.key;
    const apiSecret = state.apiKeys[state.trade.exchange]?.secret;
    if (!apiKey) {
      await send('⚠️ पहले <b>⚙️ API Settings</b> में keys डालो!', MAIN_MENU);
      return;
    }
    await send(`⚡ <b>Manual Order लग रहा है...</b>\n${state.trade.side?.toUpperCase()} | ${state.trade.pair}`);
    const result = await placeOrder(state.trade.exchange, apiKey, apiSecret, state.trade.pair, state.trade.side, state.trade.quantity, state.trade.leverage);
    if (result.success) {
      state.openPosition = { ...state.trade, orderId: result.orderId };
      state.totalTrades++;
      state.lastOrder = new Date().toLocaleTimeString('hi-IN');
      await send(`✅ <b>Order Placed!</b>\nID: <code>${result.orderId}</code>`, MAIN_MENU);
    } else {
      await send(`❌ <b>Failed:</b> ${result.error}`, MAIN_MENU);
    }
    return;
  }

  // ── PROFIT/LOSS ──
  if (text === '💰 Profit/Loss') {
    await send(
      `💰 <b>Profit / Loss Report</b>\n\n` +
      `Total Trades: <b>${state.totalTrades}</b>\n` +
      `Open Position: <b>${state.openPosition ? state.openPosition.pair : 'None'}</b>\n` +
      `Last Order: <b>${state.lastOrder || '---'}</b>\n` +
      `Last Close: <b>${state.lastClose || '---'}</b>`,
      MAIN_MENU
    );
    return;
  }

  // ── API SETTINGS ──
  if (text === '⚙️ API Settings') {
    state.step = 'api_exchange';
    await send('🔑 किस exchange की API डालनी है?', [['⚡ CoinDCX', '💎 Delta', '🟠 Mudrex'], ['⬅️ Back']]);
    return;
  }
  if (state.step === 'api_exchange') {
    const ex = { '⚡ CoinDCX': 'coindcx', '💎 Delta': 'delta', '🟠 Mudrex': 'mudrex' }[text];
    if (ex) {
      state.step = 'api_key';
      state.apiExchange = ex;
      await send(`🔑 <b>${ex.toUpperCase()} API Key</b> डालो:`);
      return;
    }
  }
  if (state.step === 'api_key') {
    state.apiKeys[state.apiExchange].key = text;
    state.step = 'api_secret';
    await send(`🔐 <b>${state.apiExchange.toUpperCase()} API Secret</b> डालो:`);
    return;
  }
  if (state.step === 'api_secret') {
    state.apiKeys[state.apiExchange].secret = text;
    state.step = 'menu';
    await send(`✅ <b>${state.apiExchange.toUpperCase()} API Save!</b>\n\nAb trade कर सकते हो!`, MAIN_MENU);
    return;
  }

  // ── BOT STATUS ──
  if (text === '🤖 Bot Status') {
    await send(
      `🤖 <b>Bot Status</b>\n\n` +
      `Status: ${state.step === 'running' ? '🟢 Running' : '⚫ Idle'}\n` +
      `Exchange: <b>${state.trade.exchange?.toUpperCase() || '---'}</b>\n` +
      `Pair: <b>${state.trade.pair || '---'}</b>\n` +
      `Side: <b>${state.trade.side?.toUpperCase() || '---'}</b>\n` +
      `Open Position: <b>${state.openPosition ? '✅ Yes' : '❌ No'}</b>\n` +
      `Total Trades: <b>${state.totalTrades}</b>`,
      MAIN_MENU
    );
    return;
  }

  // ── HELP ──
  if (text === '❓ Help') {
    await send(
      `❓ <b>Help Guide</b>\n\n` +
      `<b>Step 1:</b> ⚙️ API Settings में keys डालो\n` +
      `<b>Step 2:</b> ⚡ Trade Setup में exchange, pair, side, quantity डालो\n` +
      `<b>Step 3:</b> 📊 Scan करो — best coin ढूंढो\n` +
      `<b>Step 4:</b> 🕐 Timer Trade — funding time डालो\n` +
      `<b>Step 5:</b> ✅ START — Bot खुद order लगाएगा!\n\n` +
      `⚡ 1 second पहले ORDER\n✅ Funding settle होते ही CLOSE\n📱 हर step पर notification`,
      MAIN_MENU
    );
    return;
  }

  // Default
  if (state.step === 'menu' || !state.step) {
    await send('👆 नीचे menu से option चुनो!', MAIN_MENU);
  }
}

// ══════════════════════════════
// POLLING
// ══════════════════════════════
let offset = 0;
async function poll() {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`, {
      params: { offset, timeout: 30 }, timeout: 35000
    });
    for (const u of (r.data.result || [])) {
      offset = u.update_id + 1;
      if (u.message?.text) handle(u.message.text).catch(console.error);
    }
  } catch (e) { console.log('Poll:', e.message); }
  setTimeout(poll, 500);
}

console.log('🚀 Param Beer Shakti Telegram Bot Live!');
send('🟢 <b>Bot Online!</b>\n\n/start दबाओ!');
poll();
