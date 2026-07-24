export type NewsCategory =
  | 'regulacao'
  | 'macroeconomia'
  | 'seguranca'
  | 'exchange'
  | 'stablecoin'
  | 'rede'
  | 'institucional'
  | 'projeto'
  | 'mercado'
  | 'mineracao'
  | 'pagamentos'
  | 'outros';

export type NewsDirection = 'positiva' | 'negativa' | 'incerta';
export type NewsRelevance = 'relevante' | 'ambigua' | 'irrelevante';

export interface NewsClassification {
  category: NewsCategory;
  direction: NewsDirection;
  confidencePct: number;
  scope: 'mercado' | 'ativo' | 'misto';
  assets: string[];
  primaryAsset: string | null;
  keywords: string[];
  reason: string;
  relevance: NewsRelevance;
  relevancePct: number;
  relevanceReason: string;
  eligibleForReaction: boolean;
  generalMarket: boolean;
}

const ASSETS: Array<[string, string[]]> = [
  ['BTCUSDT', ['bitcoin', ' btc ']],
  ['ETHUSDT', ['ethereum', 'ether', ' eth ']],
  ['BNBUSDT', ['binance coin', ' bnb ']],
  ['SOLUSDT', ['solana', ' sol ']],
  ['XRPUSDT', ['ripple', ' xrp ']],
  ['ADAUSDT', ['cardano', ' ada ']],
  ['DOGEUSDT', ['dogecoin', ' doge ']],
  ['AVAXUSDT', ['avalanche', ' avax ']],
  ['LINKUSDT', ['chainlink']],
  ['LTCUSDT', ['litecoin']],
  ['TRXUSDT', ['tron', ' trx ']],
  ['DOTUSDT', ['polkadot']],
  ['ATOMUSDT', ['cosmos atom', 'cosmos network']],
  ['NEARUSDT', ['near protocol']],
  ['FILUSDT', ['filecoin']],
  ['APTUSDT', ['aptos']],
  ['ARBUSDT', ['arbitrum']],
  ['OPUSDT', ['optimism network', 'optimism token']],
  ['INJUSDT', ['injective']],
  ['ETCUSDT', ['ethereum classic']],
  ['XLMUSDT', ['stellar', ' xlm ']],
  ['UNIUSDT', ['uniswap']],
  ['AAVEUSDT', ['aave']],
  ['ALGOUSDT', ['algorand']],
  ['VETUSDT', ['vechain']],
  ['ICPUSDT', ['internet computer', ' icp ']],
  ['RUNEUSDT', ['thorchain', ' rune ']],
  ['SUIUSDT', ['sui network', ' sui ']],
  ['SEIUSDT', ['sei network', ' sei ']],
  ['TIAUSDT', ['celestia', ' tia ']],
];

const CATEGORY_KEYWORDS: Array<[NewsCategory, string[]]> = [
  ['seguranca', [
    'hack', 'hacked', 'exploit', 'breach', 'stolen funds', 'cyberattack',
    'vulnerability', 'drained', 'wallet drain', 'private key', 'security incident',
  ]],
  ['regulacao', [
    ' sec ', 'securities and exchange commission', ' cftc ', 'mica', 'regulator',
    'regulation', 'regulatory', 'lawsuit', 'court ruling', 'legislation', 'compliance',
    'enforcement action', 'charges against', 'crypto bill', 'senate bill', 'congress',
    'legal framework', 'licensing rule',
  ]],
  ['macroeconomia', [
    'federal reserve', ' fed ', 'interest rate', 'rate cut', 'rate hike', 'inflation',
    ' cpi ', ' pce ', 'jobs report', 'nonfarm payroll', 'recession', 'tariff',
    'treasury yield', 'central bank', 'dollar index', 'liquidity', 'money supply',
  ]],
  ['exchange', [
    'binance', 'coinbase', 'kraken', 'crypto exchange', 'listing', 'delisting',
    'withdrawal halt', 'deposit halt', 'proof of reserves', 'exchange reserve',
    'bankruptcy filing', 'insolvency', 'trading outage',
  ]],
  ['stablecoin', [
    'stablecoin', ' usdt ', 'tether', ' usdc ', 'circle internet', 'depeg',
    'loses peg', 'reserve attestation', 'stablecoin supply',
  ]],
  ['institucional', [
    'bitcoin etf', 'ethereum etf', 'spot etf', 'institutional', 'blackrock',
    'fidelity', 'grayscale', 'strategy buys', 'treasury purchase', 'reserve asset',
    'fund inflow', 'fund outflow', 'corporate treasury', 'sovereign fund',
  ]],
  ['rede', [
    'mainnet', 'testnet', 'network upgrade', 'hard fork', 'soft fork', 'network outage',
    'network halt', 'validator', 'protocol upgrade', 'consensus bug', 'block production',
    'gas fees', 'layer 2', 'bridge upgrade',
  ]],
  ['mineracao', [
    'bitcoin mining', 'crypto mining', 'miner revenue', 'hashrate', 'hash rate',
    'mining difficulty', 'mining pool', 'block reward', 'halving',
  ]],
  ['pagamentos', [
    'crypto payment', 'bitcoin payment', 'accepts bitcoin', 'payment network',
    'merchant adoption', 'payment processor', 'card settlement', 'remittance',
  ]],
  ['mercado', [
    'price surge', 'price rally', 'price plunge', 'price drop', 'price falls',
    'price jumps', 'all time high', 'record high', 'sell off', 'selloff',
    'liquidations', 'market crash', 'market rally', 'volatility spike',
    'open interest', 'funding rate', 'trading volume', 'bull market', 'bear market',
  ]],
  ['projeto', [
    'airdrop', 'partnership', 'token launch', 'protocol launch', 'roadmap',
    'governance proposal', 'token unlock', 'main product launch', 'ecosystem fund',
  ]],
];

const POSITIVE = [
  'approve', 'approval', 'approved', 'adoption', 'adopts', 'launches', 'launched',
  'partnership', 'record inflow', 'buys bitcoin', 'purchase', 'upgrade successful',
  'settlement reached', 'lawsuit dismissed', 'legalizes', 'wins case', 'surges',
  'rallies', 'record high', 'all time high', 'expands support', 'restores withdrawals',
];

const NEGATIVE = [
  'reject', 'rejected', 'ban', 'banned', 'lawsuit', 'charges', 'charged',
  'investigation', 'investigated', 'hack', 'hacked', 'exploit', 'breach',
  'stolen funds', 'outage', 'delist', 'delisted', 'liquidation', 'liquidations',
  'crash', 'plunge', 'plunges', 'fraud', 'bankruptcy', 'insolvency', 'outflow',
  'sell off', 'selloff', 'halts withdrawals', 'withdrawal halt', 'depeg',
];

const STRONG_CRYPTO = [
  'bitcoin', 'cryptocurrency', 'crypto market', 'digital asset', 'ethereum',
  'blockchain', 'stablecoin', 'defi', 'web3', 'tokenized asset', 'crypto exchange',
  'bitcoin etf', 'ethereum etf', 'on chain', 'onchain', 'layer 2', 'smart contract',
];

const MARKET_TERMS = [
  'price', 'market', 'trading', 'liquidity', 'volume', 'volatility', 'inflow',
  'outflow', 'liquidation', 'open interest', 'funding rate', 'reserve', 'treasury',
];

const INCIDENTAL_NOISE = [
  'ransom note', 'ransom demand', 'kidnapping', 'kidnapped', 'murder', 'missing person',
  'romance scam', 'puppy scam', 'lost cryptocurrency', 'lost crypto', 'victim lost',
  'paid ransom', 'demanded bitcoin', 'demanded crypto', 'hotel restaurant',
  'music this week', 'football', 'basketball', 'baseball', 'tennis open', 'nba title',
  'weather forecast', 'school update', 'classic hits', 'lanternfly', 'taco bell',
  'food recall', 'lottery winner', 'celebrity gossip',
];

const SPECIALIZED_DOMAINS = [
  'coindesk.com', 'cointelegraph.com', 'decrypt.co', 'theblock.co',
  'cryptoslate.com', 'bitcoinmagazine.com', 'blockworks.co', 'dlnews.com',
  'coinmarketcap.com', 'coinbase.com', 'binance.com', 'kraken.com',
];

export function normalizeNewsText(value: string): string {
  return (` ${value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9$]+/g, ' ')} `)
    .replace(/\s+/g, ' ');
}

function matchedTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function isSpecializedDomain(domain: string | null | undefined): boolean {
  const clean = (domain ?? '').toLowerCase().replace(/^www\./, '');
  return SPECIALIZED_DOMAINS.some((item) => clean === item || clean.endsWith(`.${item}`));
}

function assetMatches(text: string): Array<{ symbol: string; position: number; aliases: string[] }> {
  return ASSETS.flatMap(([symbol, aliases]) => {
    const positions = aliases
      .map((alias) => ({ alias, position: text.indexOf(alias) }))
      .filter((item) => item.position >= 0)
      .sort((a, b) => a.position - b.position);
    return positions.length > 0
      ? [{ symbol, position: positions[0].position, aliases: positions.map((item) => item.alias) }]
      : [];
  }).sort((a, b) => a.position - b.position);
}

export function classifyNews(
  title: string,
  summary = '',
  sourceDomain: string | null = null,
): NewsClassification {
  const text = normalizeNewsText(`${title} ${summary}`);
  const titleText = normalizeNewsText(title);
  const sourceSpecialized = isSpecializedDomain(sourceDomain);
  const assetsFound = assetMatches(text);
  const assets = assetsFound.map((item) => item.symbol);
  const primaryAsset = assetsFound[0]?.symbol ?? null;

  const categoryScores = CATEGORY_KEYWORDS
    .map(([category, terms]) => ({ category, hits: matchedTerms(text, terms) }))
    .sort((a, b) => b.hits.length - a.hits.length);
  const topCategory = categoryScores[0];
  const category: NewsCategory = topCategory.hits.length > 0 ? topCategory.category : 'outros';

  const positiveHits = matchedTerms(text, POSITIVE);
  const negativeHits = matchedTerms(text, NEGATIVE);
  const direction: NewsDirection = positiveHits.length > negativeHits.length
    ? 'positiva'
    : negativeHits.length > positiveHits.length
      ? 'negativa'
      : 'incerta';

  const strongCryptoHits = matchedTerms(text, STRONG_CRYPTO);
  const titleCryptoHits = matchedTerms(titleText, STRONG_CRYPTO);
  const marketHits = matchedTerms(text, MARKET_TERMS);
  const noiseHits = matchedTerms(text, INCIDENTAL_NOISE);

  let relevanceScore = 0;
  const relevanceEvidence: string[] = [];

  if (sourceSpecialized) {
    relevanceScore += 25;
    relevanceEvidence.push('fonte especializada');
  }
  if (assets.length > 0) {
    relevanceScore += 30;
    relevanceEvidence.push(`ativo explícito: ${assets.slice(0, 3).join(', ')}`);
  }
  if (strongCryptoHits.length > 0) {
    relevanceScore += Math.min(25, 15 + strongCryptoHits.length * 5);
    relevanceEvidence.push(`tema cripto: ${strongCryptoHits.slice(0, 3).join(', ')}`);
  }
  if (titleCryptoHits.length > 0) relevanceScore += 5;
  if (category !== 'outros') {
    relevanceScore += 15;
    relevanceEvidence.push(`categoria: ${category}`);
  }
  if (marketHits.length > 0) relevanceScore += Math.min(10, marketHits.length * 3);
  if (direction !== 'incerta') relevanceScore += 5;

  if (noiseHits.length > 0) {
    relevanceScore -= Math.min(75, 40 + (noiseHits.length - 1) * 15);
    relevanceEvidence.push(`menção incidental: ${noiseHits.slice(0, 3).join(', ')}`);
  }
  if (!sourceSpecialized && assets.length === 0 && strongCryptoHits.length === 0) {
    relevanceScore = Math.min(relevanceScore, 25);
  }
  if (category === 'outros' && direction === 'incerta') relevanceScore -= 10;

  relevanceScore = Math.max(0, Math.min(100, relevanceScore));
  const relevance: NewsRelevance = relevanceScore >= 65
    ? 'relevante'
    : relevanceScore >= 45
      ? 'ambigua'
      : 'irrelevante';

  const generalMarket = relevance === 'relevante'
    && assets.length === 0
    && strongCryptoHits.length > 0
    && (sourceSpecialized || relevanceScore >= 75);

  const scope: NewsClassification['scope'] = assets.length === 1 && !generalMarket
    ? 'ativo'
    : assets.length > 1
      ? 'misto'
      : 'mercado';

  let confidencePct = 35
    + Math.min(30, topCategory.hits.length * 10)
    + Math.min(20, Math.abs(positiveHits.length - negativeHits.length) * 10)
    + Math.min(15, assets.length * 5);
  if (relevance === 'irrelevante') confidencePct = Math.min(confidencePct, 45);
  if (relevance === 'ambigua') confidencePct = Math.min(confidencePct, 65);
  confidencePct = Math.max(20, Math.min(95, confidencePct));

  const keywords = [...new Set([
    ...topCategory.hits,
    ...positiveHits,
    ...negativeHits,
    ...strongCryptoHits,
    ...noiseHits,
  ])];

  const eligibleForReaction = relevance === 'relevante'
    && confidencePct >= 55
    && (assets.length > 0 || generalMarket);

  const reason = keywords.length > 0
    ? `Termos detectados: ${keywords.slice(0, 10).join(', ')}.`
    : 'Sem evidência suficiente para categoria ou direção forte.';

  const relevanceReason = relevanceEvidence.length > 0
    ? `${relevanceEvidence.join('; ')}. Pontuação ${relevanceScore}/100.`
    : `Sem evidência material de relação com o mercado cripto. Pontuação ${relevanceScore}/100.`;

  return {
    category,
    direction,
    confidencePct,
    scope,
    assets,
    primaryAsset,
    keywords,
    reason,
    relevance,
    relevancePct: relevanceScore,
    relevanceReason,
    eligibleForReaction,
    generalMarket,
  };
}
