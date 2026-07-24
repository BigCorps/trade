export type NewsCategory = 'regulacao' | 'macroeconomia' | 'seguranca' | 'exchange' | 'stablecoin' | 'rede' | 'institucional' | 'projeto' | 'outros';
export type NewsDirection = 'positiva' | 'negativa' | 'incerta';

export interface NewsClassification {
  category: NewsCategory;
  direction: NewsDirection;
  confidencePct: number;
  scope: 'mercado' | 'ativo' | 'misto';
  assets: string[];
  keywords: string[];
  reason: string;
}

const ASSETS: Array<[string, string[]]> = [
  ['BTCUSDT', ['bitcoin', ' btc ']], ['ETHUSDT', ['ethereum', 'ether', ' eth ']],
  ['BNBUSDT', ['binance coin', ' bnb ']], ['SOLUSDT', ['solana', ' sol ']],
  ['XRPUSDT', ['ripple', ' xrp ']], ['ADAUSDT', ['cardano', ' ada ']],
  ['DOGEUSDT', ['dogecoin', ' doge ']], ['AVAXUSDT', ['avalanche', ' avax ']],
  ['LINKUSDT', ['chainlink']], ['LTCUSDT', ['litecoin']], ['TRXUSDT', ['tron']],
  ['DOTUSDT', ['polkadot']], ['ATOMUSDT', ['cosmos atom', 'cosmos network']],
  ['NEARUSDT', ['near protocol']], ['FILUSDT', ['filecoin']], ['APTUSDT', ['aptos']],
  ['ARBUSDT', ['arbitrum']], ['OPUSDT', ['optimism network', 'optimism token']],
  ['INJUSDT', ['injective']], ['ETCUSDT', ['ethereum classic']], ['XLMUSDT', ['stellar', ' xlm ']],
  ['UNIUSDT', ['uniswap']], ['AAVEUSDT', ['aave']], ['ALGOUSDT', ['algorand']],
  ['VETUSDT', ['vechain']], ['ICPUSDT', ['internet computer', ' icp ']],
  ['RUNEUSDT', ['thorchain', ' rune ']], ['SUIUSDT', ['sui network', ' sui ']],
  ['SEIUSDT', ['sei network', ' sei ']], ['TIAUSDT', ['celestia', ' tia ']],
];

const CATEGORY_KEYWORDS: Array<[NewsCategory, string[]]> = [
  ['seguranca', ['hack', 'hacked', 'exploit', 'breach', 'stolen', 'attack', 'vulnerability', 'drain', 'theft']],
  ['regulacao', ['sec', 'regulator', 'regulation', 'lawsuit', 'court', 'ban', 'legal', 'legislation', 'compliance', 'cftc']],
  ['macroeconomia', ['federal reserve', 'fed ', 'interest rate', 'inflation', 'cpi', 'jobs report', 'recession', 'tariff', 'treasury', 'central bank']],
  ['exchange', ['binance', 'coinbase', 'kraken', 'exchange', 'listing', 'delisting', 'withdrawal', 'deposit']],
  ['stablecoin', ['stablecoin', 'usdt', 'tether', 'usdc', 'depeg', 'peg']],
  ['institucional', ['etf', 'institutional', 'blackrock', 'fidelity', 'fund', 'treasury purchase', 'reserve asset', 'adoption']],
  ['rede', ['mainnet', 'testnet', 'upgrade', 'fork', 'outage', 'network halt', 'validator', 'protocol update']],
  ['projeto', ['token', 'airdrop', 'partnership', 'launch', 'roadmap', 'governance']],
];

const POSITIVE = ['approve', 'approval', 'approved', 'adoption', 'launch', 'partnership', 'record inflow', 'buy', 'purchase', 'upgrade successful', 'settlement'];
const NEGATIVE = ['reject', 'rejected', 'ban', 'lawsuit', 'hack', 'exploit', 'breach', 'stolen', 'outage', 'delist', 'liquidation', 'crash', 'fraud', 'investigation'];

export function normalizeNewsText(value: string): string {
  return (' ' + value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9$]+/g, ' ') + ' ').replace(/\s+/g, ' ');
}

function matches(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

export function classifyNews(title: string): NewsClassification {
  const text = normalizeNewsText(title);
  const categoryScores = CATEGORY_KEYWORDS.map(([category, terms]) => ({ category, hits: matches(text, terms) }));
  categoryScores.sort((a, b) => b.hits.length - a.hits.length);
  const category = categoryScores[0].hits.length > 0 ? categoryScores[0].category : 'outros';
  const categoryHits = categoryScores[0].hits;
  const positiveHits = matches(text, POSITIVE);
  const negativeHits = matches(text, NEGATIVE);
  const direction: NewsDirection = positiveHits.length > negativeHits.length
    ? 'positiva'
    : negativeHits.length > positiveHits.length ? 'negativa' : 'incerta';
  const assets = ASSETS.filter(([, aliases]) => aliases.some((alias) => text.includes(alias))).map(([symbol]) => symbol);
  const marketTerms = matches(text, ['crypto market', 'cryptocurrency', 'digital asset', 'bitcoin']);
  const scope = assets.length === 1 && marketTerms.length === 0 ? 'ativo' : assets.length > 0 ? 'misto' : 'mercado';
  const evidence = [...new Set([...categoryHits, ...positiveHits, ...negativeHits])];
  const confidencePct = Math.min(95, 40 + categoryHits.length * 10 + Math.abs(positiveHits.length - negativeHits.length) * 10 + Math.min(assets.length, 3) * 5);
  return {
    category,
    direction,
    confidencePct,
    scope,
    assets,
    keywords: evidence,
    reason: evidence.length > 0 ? 'Termos detectados: ' + evidence.join(', ') : 'Sem evidência direcional forte; mantida como hipótese incerta.',
  };
}
