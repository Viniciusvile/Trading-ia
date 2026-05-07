
import fetch from 'node-fetch';

async function checkMarket() {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const intervals = ['4h', '15m'];
    
    for (const symbol of symbols) {
        console.log(`\n=== Analyzing ${symbol} ===`);
        for (const interval of intervals) {
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=10`;
            try {
                const res = await fetch(url);
                const data = await res.json();
                
                console.log(`\nLast 10 candles (${interval}):`);
                console.table(data.map(k => ({
                    time: new Date(k[0]).toLocaleString('pt-BR'),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    change: ((parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1]) * 100).toFixed(2) + '%'
                })));
                
                // Calculate some simple trend indicators
                const closes = data.map(k => parseFloat(k[4]));
                const last = closes[closes.length - 1];
                const prev = closes[closes.length - 2];
                const trend = last > prev ? 'UP' : 'DOWN';
                console.log(`Current ${interval} Trend: ${trend} (${last > prev ? '+' : ''}${((last-prev)/prev*100).toFixed(2)}%)`);
            } catch (e) {
                console.error(`Error fetching ${symbol} ${interval}:`, e.message);
            }
        }
    }
}

checkMarket();
