import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Envia o histórico de trades para o Gemini analisar e sugerir melhorias.
 */
export async function getAiPerformanceReview(apiKey) {
    const root = process.cwd();
    const logPath = join(root, 'micro-scalper-log.json');
    const rulesPath = join(root, 'rules.json');

    if (!existsSync(logPath)) {
        return "Nenhum histórico de trades encontrado para análise.";
    }

    const tradesLog = JSON.parse(readFileSync(logPath, 'utf8'));
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));

    // Resumir os trades para não estourar o limite de tokens (pegamos os últimos 50 trades)
    const recentTrades = tradesLog.flatMap(session => session.trades).slice(-50);
    
    if (recentTrades.length === 0) {
        return "Ainda não há trades suficientes para uma análise consistente.";
    }

    const prompt = `
Você é um especialista em Trading Algorítmico de Alta Performance.
Analise os trades recentes do meu robô "XRP Turbo Scalper" e sugira melhorias na estratégia.

### Estratégia Atual (rules.json):
${JSON.stringify(rules.micro_scalper, null, 2)}

### Trades Recentes (Últimos ${recentTrades.length}):
${JSON.stringify(recentTrades, null, 2)}

### Sua Tarefa:
1. Avalie a taxa de acerto (Win Rate).
2. Identifique se o Stop Loss ou Take Profit estão muito curtos ou longos.
3. Observe se há padrões de perda em horários específicos ou condições de mercado (ex: Volume Spike alto).
4. Sugira valores específicos para alterar no rules.json (ex: mudar bb_mult de 1.8 para 2.0).

Responda em Português de forma clara e técnica.
    `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        const data = await response.json();
        
        if (data.error) {
            return `Erro da API Gemini: ${data.error.message} (${data.error.status})`;
        }

        if (!data.candidates || data.candidates.length === 0) {
            return "O Gemini não retornou sugestões. Verifique os logs do servidor ou se a cota da API foi atingida.";
        }

        return data.candidates[0].content.parts[0].text;
    } catch (e) {
        return "Erro ao conectar com o Gemini: " + e.message;
    }
}
