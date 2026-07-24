import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const HORIZONS = [15, 60, 240, 720, 1440, 4320] as const;
const GENERAL_ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const RSS = [
  ['coindesk-rss', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['cointelegraph-rss', 'https://cointelegraph.com/rss'],
  ['decrypt-rss', 'https://decrypt.co/feed'],
] as const;
const ASSETS: Array<[string, string[]]> = [
  ['BTCUSDT',['bitcoin',' btc ']],['ETHUSDT',['ethereum','ether',' eth ']],['BNBUSDT',['binance coin',' bnb ']],
  ['SOLUSDT',['solana',' sol ']],['XRPUSDT',['ripple',' xrp ']],['ADAUSDT',['cardano',' ada ']],
  ['DOGEUSDT',['dogecoin',' doge ']],['AVAXUSDT',['avalanche',' avax ']],['LINKUSDT',['chainlink']],
  ['LTCUSDT',['litecoin']],['TRXUSDT',['tron']],['DOTUSDT',['polkadot']],['ATOMUSDT',['cosmos atom','cosmos network']],
  ['NEARUSDT',['near protocol']],['FILUSDT',['filecoin']],['APTUSDT',['aptos']],['ARBUSDT',['arbitrum']],
  ['OPUSDT',['optimism network','optimism token']],['INJUSDT',['injective']],['ETCUSDT',['ethereum classic']],
  ['XLMUSDT',['stellar',' xlm ']],['UNIUSDT',['uniswap']],['AAVEUSDT',['aave']],['ALGOUSDT',['algorand']],
  ['VETUSDT',['vechain']],['ICPUSDT',['internet computer',' icp ']],['RUNEUSDT',['thorchain',' rune ']],
  ['SUIUSDT',['sui network',' sui ']],['SEIUSDT',['sei network',' sei ']],['TIAUSDT',['celestia',' tia ']],
];
const CATEGORIES: Array<[string,string[]]> = [
  ['seguranca',['hack','hacked','exploit','breach','stolen','attack','vulnerability','drain','theft']],
  ['regulacao',['sec','regulator','regulation','lawsuit','court','ban','legal','legislation','compliance','cftc']],
  ['macroeconomia',['federal reserve','fed ','interest rate','inflation','cpi','jobs report','recession','tariff','treasury','central bank']],
  ['exchange',['binance','coinbase','kraken','exchange','listing','delisting','withdrawal','deposit']],
  ['stablecoin',['stablecoin','usdt','tether','usdc','depeg','peg']],
  ['institucional',['etf','institutional','blackrock','fidelity','fund','treasury purchase','reserve asset','adoption']],
  ['rede',['mainnet','testnet','upgrade','fork','outage','network halt','validator','protocol update']],
  ['projeto',['token','airdrop','partnership','launch','roadmap','governance']],
];
const POSITIVE = ['approve','approval','approved','adoption','launch','partnership','record inflow','buy','purchase','upgrade successful','settlement'];
const NEGATIVE = ['reject','rejected','ban','lawsuit','hack','exploit','breach','stolen','outage','delist','liquidation','crash','fraud','investigation'];
const CRYPTO = ['bitcoin','btc','cryptocurrency','crypto','ethereum','ether','blockchain','stablecoin','usdt','usdc','binance','coinbase','solana','ripple','xrp','cardano','dogecoin','avalanche','chainlink','litecoin','tron','polkadot','etf','token','defi','web3'];

type Article = { provider:string; url:string; title:string; publishedAt:string; domain:string|null; country:string|null; language:string|null; raw:Record<string,unknown> };
type Provider = { provider:string; status:'ok'|'rate_limited'|'failed'; received:number; error:string|null; articles:Article[] };
type Candle = { closeTime:number; open:number; close:number; volume:number };

const reply = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const sleep = (ms:number) => new Promise((resolve)=>setTimeout(resolve,ms));
const normalize = (s:string) => (' '+s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9$]+/g,' ')+' ').replace(/\s+/g,' ');
const hash = async (s:string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map((x)=>x.toString(16).padStart(2,'0')).join('');
const domain = (url:string) => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return null; } };
const xml = (s:string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).trim();
function tag(block:string,names:string[]) { for (const name of names) { const e=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); const m=block.match(new RegExp(`<${e}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${e}>`,'i')); if(m) return xml(m[1]); } return null; }
function classify(title:string) {
  const text=normalize(title); const scores=CATEGORIES.map(([category,terms])=>({category,hits:terms.filter((t)=>text.includes(t))})).sort((a,b)=>b.hits.length-a.hits.length);
  const pos=POSITIVE.filter((t)=>text.includes(t)); const neg=NEGATIVE.filter((t)=>text.includes(t)); const assets=ASSETS.filter(([,aliases])=>aliases.some((a)=>text.includes(a))).map(([s])=>s);
  const category=scores[0].hits.length?scores[0].category:'outros'; const direction=pos.length>neg.length?'positiva':neg.length>pos.length?'negativa':'incerta';
  const evidence=[...new Set([...scores[0].hits,...pos,...neg])]; const market=['crypto market','cryptocurrency','digital asset','bitcoin'].some((t)=>text.includes(t));
  return {category,direction,assets,scope:assets.length===1&&!market?'ativo':assets.length?'misto':'mercado',confidence:Math.min(95,40+scores[0].hits.length*10+Math.abs(pos.length-neg.length)*10+Math.min(assets.length,3)*5),keywords:evidence,reason:evidence.length?'Termos detectados: '+evidence.join(', '):'Sem evidência direcional forte; mantida como hipótese incerta.'};
}
async function fetchResponse(url:string|URL,timeout=20000,accept='application/json, application/rss+xml, application/xml, text/xml') {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  try { return await fetch(url,{signal:controller.signal,headers:{Accept:accept,'User-Agent':'VigIA-Market-News/1.1 (+https://vigia.bigcorps.com.br)'}}); } finally { clearTimeout(timer); }
}
function gdeltDate(d:Date) { const p=(n:number)=>String(n).padStart(2,'0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; }
function parseGdeltDate(v:unknown) { if(typeof v!=='string')return null; const direct=Date.parse(v); if(Number.isFinite(direct))return new Date(direct).toISOString(); const m=v.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/); return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])).toISOString():null; }
async function fetchGdelt(from:Date,to:Date):Promise<Provider> {
  const provider='gdelt-doc-2'; const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  u.searchParams.set('query','(bitcoin OR cryptocurrency OR ethereum OR blockchain OR stablecoin OR binance OR coinbase OR solana OR ripple OR "crypto ETF")'); u.searchParams.set('mode','ArtList'); u.searchParams.set('format','json'); u.searchParams.set('maxrecords','100'); u.searchParams.set('sort','DateDesc'); u.searchParams.set('startdatetime',gdeltDate(from)); u.searchParams.set('enddatetime',gdeltDate(to));
  let error='falha desconhecida';
  for(let attempt=0;attempt<2;attempt++){ if(attempt)await sleep(error.includes('429')?6500:1500); try{ const r=await fetchResponse(u,25000,'application/json'); if(!r.ok){error=`GDELT HTTP ${r.status}: ${(await r.text()).slice(0,160)}`; if(r.status!==429&&r.status<500)break; continue;} const data=await r.json() as {articles?:Record<string,unknown>[]}; const articles=(data.articles??[]).flatMap((a)=>{const url=typeof a.url==='string'?a.url:''; const title=typeof a.title==='string'?xml(a.title).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():''; const publishedAt=parseGdeltDate(a.seendate); return url&&title&&publishedAt?[{provider,url,title,publishedAt,domain:typeof a.domain==='string'?a.domain:domain(url),country:typeof a.sourcecountry==='string'?a.sourcecountry:null,language:typeof a.language==='string'?a.language:null,raw:a}]:[]}); return {provider,status:'ok',received:articles.length,error:null,articles}; }catch(e){error=e instanceof Error?`${e.name}: ${e.message}`:String(e);} }
  return {provider,status:error.includes('429')?'rate_limited':'failed',received:0,error,articles:[]};
}
async function fetchRss(provider:string,url:string,from:Date,to:Date):Promise<Provider> {
  try{ const r=await fetchResponse(url,18000,'application/rss+xml, application/xml, text/xml'); if(!r.ok)return{provider,status:r.status===429?'rate_limited':'failed',received:0,error:`RSS HTTP ${r.status}`,articles:[]}; const body=await r.text(); const lower=from.getTime()-900000,upper=to.getTime()+300000;
    const articles=[...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0,80).flatMap((m)=>{const b=m[1]; const title=xml(tag(b,['title'])??'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); const link=tag(b,['link'])??tag(b,['guid'])??''; const ds=tag(b,['pubDate','dc:date','published','updated']); const ts=ds?Date.parse(ds):NaN; const n=normalize(title); if(!title||!link||!Number.isFinite(ts)||ts<lower||ts>upper||!CRYPTO.some((t)=>n.includes(t)))return[]; return[{provider,url:link,title,publishedAt:new Date(ts).toISOString(),domain:domain(link),country:null,language:'English',raw:{feed:url,title,link,published:ds}}]}); return{provider,status:'ok',received:articles.length,error:null,articles};
  }catch(e){return{provider,status:'failed',received:0,error:e instanceof Error?`${e.name}: ${e.message}`:String(e),articles:[]};}
}
async function candles(symbol:string,interval:string,start:number,end:number):Promise<Candle[]> {
  const u=new URL('/api/v3/klines','https://data-api.binance.vision'); u.searchParams.set('symbol',symbol);u.searchParams.set('interval',interval);u.searchParams.set('startTime',String(start));u.searchParams.set('endTime',String(end));u.searchParams.set('limit','1000');
  const r=await fetchResponse(u,20000,'application/json'); if(!r.ok)throw new Error(`Binance HTTP ${r.status} para ${symbol}`); const rows=await r.json() as unknown[][]; return rows.flatMap((x)=>Array.isArray(x)&&x.length>=7?[{open:Number(x[1]),close:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[6])}]:[]);
}
function stdev(v:number[]){if(v.length<2)return 0;const a=v.reduce((x,y)=>x+y,0)/v.length;return Math.sqrt(v.reduce((s,x)=>s+(x-a)**2,0)/(v.length-1));}
async function reaction(symbol:string,benchmark:string,published:number,horizon:number){
  const setup=horizon<=60?['1m',60000] as const:horizon<=720?['5m',300000] as const:['15m',900000] as const;const due=published+horizon*60000,span=horizon*60000,start=published-span-setup[1]*2,end=due+setup[1]*2;
  const [a,b]=await Promise.all([candles(symbol,setup[0],start,end),candles(benchmark,setup[0],start,end)]);
  const calc=(cs:Candle[])=>{const after=cs.filter((c)=>c.closeTime>=published&&c.closeTime<=due),before=cs.filter((c)=>c.closeTime<published&&c.closeTime>=published-span);if(after.length<2)throw new Error(`candles insuficientes para ${symbol}/${horizon}`);const first=after[0].open,last=after.at(-1)!.close,avb=before.length?before.reduce((s,c)=>s+c.volume,0)/before.length:null,ava=after.reduce((s,c)=>s+c.volume,0)/after.length;const rets=(x:Candle[])=>x.slice(1).map((c,i)=>Math.log(c.close/x[i].close));const vb=stdev(rets(before)),va=stdev(rets(after));return{first,last,ret:first>0?(last/first-1)*100:null,volume:avb&&avb>0?ava/avb:null,vol:vb>0?va/vb:null};};const active=calc(a),base=calc(b);return{active,base,excess:active.ret!==null&&base.ret!==null?active.ret-base.ret:null};
}

Deno.serve(async(req)=>{
  const secret=Deno.env.get('CRON_SECRET'); if(!secret||req.headers.get('x-cron-secret')!==secret)return reply({ok:false,error:'não autorizado'},401);
  const su=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); if(!su||!key)return reply({ok:false,error:'Supabase não configurado'},500);
  const db=createClient(su,key,{auth:{persistSession:false,autoRefreshToken:false}}); await db.rpc('abandon_stale_validation_news_runs');
  const started=await db.from('market_news_runs').insert({tipo:'coleta_e_reacoes',status:'executando'}).select('id').maybeSingle(); if(started.error||!started.data)return reply({ok:false,error:started.error?.message??'run concorrente'},409);
  const runId=started.data.id;let received=0,created=0,repeated=0,articleFailures=0;
  try{
    const now=new Date(),from=new Date(now.getTime()-10800000);const providers=await Promise.all([fetchGdelt(from,now),...RSS.map(([p,u])=>fetchRss(p,u,from,now))]);received=providers.reduce((s,p)=>s+p.received,0);const providersOk=providers.filter((p)=>p.status==='ok').length;
    const old=await db.from('market_news_events').select('id,cluster_key,publicado_em,direcao_esperada').gte('publicado_em',new Date(now.getTime()-259200000).toISOString());if(old.error)throw new Error(old.error.message);const clusters=new Map((old.data??[]).map((e:any)=>[e.cluster_key,e]));
    const articles=new Map<string,Article>();for(const p of providers)for(const a of p.articles)articles.set(`${a.provider}|${a.url}`,a);
    for(const a of articles.values()){try{const providerKey=await hash(a.url),clusterKey=await hash(normalize(a.title));const exact=await db.from('market_news_events').select('id').eq('provider',a.provider).eq('provider_key',providerKey).maybeSingle();if(exact.error)throw new Error(exact.error.message);if(exact.data||clusters.has(clusterKey)){repeated++;continue;}const c=classify(a.title);const ins=await db.from('market_news_events').insert({provider:a.provider,provider_key:providerKey,cluster_key:clusterKey,titulo:a.title,url:a.url,dominio_fonte:a.domain,pais_fonte:a.country,idioma:a.language,publicado_em:a.publishedAt,categoria:c.category,direcao_esperada:c.direction,confianca_pct:c.confidence,novidade:'nova',escopo:c.scope,motivo_classificacao:c.reason,palavras_chave:c.keywords,raw_payload:a.raw}).select('id,cluster_key,publicado_em,direcao_esperada').maybeSingle();if(ins.error||!ins.data)throw new Error(ins.error?.message??'evento não criado');clusters.set(clusterKey,ins.data);const assets=[...new Set(c.assets.length?c.assets.slice(0,8):GENERAL_ASSETS)];const links=await db.from('market_news_asset_links').insert(assets.map((s)=>({event_id:ins.data.id,simbolo:s,relevancia_pct:c.assets.includes(s)?80:50,tipo_relacao:c.assets.includes(s)?'mencionado':'mercado_geral',motivo:c.reason})));if(links.error)throw new Error(links.error.message);const rr=await db.from('market_news_reactions').insert(assets.flatMap((s)=>HORIZONS.map((h)=>({event_id:ins.data.id,simbolo:s,horizonte_minutos:h,devido_em:new Date(new Date(a.publishedAt).getTime()+h*60000).toISOString(),status:'pendente'}))));if(rr.error)throw new Error(rr.error.message);created++;}catch(e){articleFailures++;console.error('evento',e);}}
    const dueQ=await db.from('market_news_reactions').select('event_id,simbolo,horizonte_minutos,devido_em,tentativas').in('status',['pendente','falhou']).lte('devido_em',now.toISOString()).lt('tentativas',5).order('devido_em',{ascending:true}).limit(60);if(dueQ.error)throw new Error(dueQ.error.message);const due=dueQ.data??[],ids=[...new Set(due.map((x:any)=>x.event_id))];const evQ=ids.length?await db.from('market_news_events').select('id,publicado_em,direcao_esperada').in('id',ids):{data:[],error:null};if(evQ.error)throw new Error(evQ.error.message);const events=new Map((evQ.data??[]).map((e:any)=>[e.id,e]));let processed=0,reactionFailures=0;const reactionErrors:string[]=[];
    for(const x of due as any[]){const e:any=events.get(x.event_id);if(!e){reactionFailures++;continue;}try{const benchmark=x.simbolo==='BTCUSDT'?'ETHUSDT':'BTCUSDT',m=await reaction(x.simbolo,benchmark,new Date(e.publicado_em).getTime(),+x.horizonte_minutos),abs=Math.abs(m.excess??0),impact=abs<.25?'irrelevante':abs<.75?'baixo':abs<2?'medio':'alto',confirmed=e.direcao_esperada==='positiva'?m.excess!==null&&m.excess>.25:e.direcao_esperada==='negativa'?m.excess!==null&&m.excess<-.25:null;const up=await db.from('market_news_reactions').update({status:'concluido',processado_em:new Date().toISOString(),preco_inicio:m.active.first,preco_fim:m.active.last,retorno_ativo_pct:m.active.ret,benchmark_simbolo:benchmark,benchmark_preco_inicio:m.base.first,benchmark_preco_fim:m.base.last,retorno_benchmark_pct:m.base.ret,retorno_excesso_pct:m.excess,volume_ratio:m.active.volume,volatilidade_ratio:m.active.vol,direcao_confirmada:confirmed,impacto:impact,erro:null,tentativas:+x.tentativas+1}).eq('event_id',x.event_id).eq('simbolo',x.simbolo).eq('horizonte_minutos',x.horizonte_minutos);if(up.error)throw new Error(up.error.message);processed++;}catch(err){reactionFailures++;const msg=err instanceof Error?`${err.name}: ${err.message}`:String(err);reactionErrors.push(`${x.simbolo}/${x.horizonte_minutos}: ${msg}`);await db.from('market_news_reactions').update({status:'falhou',erro:msg.slice(0,500),tentativas:+x.tentativas+1}).eq('event_id',x.event_id).eq('simbolo',x.simbolo).eq('horizonte_minutos',x.horizonte_minutos);}}
    const failures=(providers.length-providersOk)+articleFailures+reactionFailures,noSuccess=providersOk===0&&processed===0&&due.length===0,status=noSuccess?'falhou':failures?'concluido_com_falhas':'concluido';const details={version:'market-news-v1.1.1',windowHours:3,providers:Object.fromEntries(providers.map((p)=>[p.provider,{status:p.status,received:p.received,error:p.error}])),providersOk,providersTotal:providers.length,uniqueArticles:articles.size,articleFailures,dueReactions:due.length,reactionErrors:reactionErrors.slice(0,20)};
    await db.from('market_news_runs').update({status,finalizado_em:new Date().toISOString(),artigos_recebidos:received,eventos_novos:created,eventos_repetidos:repeated,reacoes_processadas:processed,falhas:failures,detalhes:details,erro:noSuccess?'Nenhum provedor respondeu e não havia reações pendentes.':null}).eq('id',runId);
    return reply({ok:!noSuccess,run_id:runId,status,received,created,repeated,processed,failures,providers:details.providers},noSuccess?502:200);
  }catch(e){const msg=e instanceof Error?`${e.name}: ${e.message}`:String(e);await db.from('market_news_runs').update({status:'falhou',finalizado_em:new Date().toISOString(),artigos_recebidos:received,eventos_novos:created,eventos_repetidos:repeated,reacoes_processadas:0,falhas:articleFailures+1,erro:msg.slice(0,1000),detalhes:{version:'market-news-v1.1.1',articleFailures}}).eq('id',runId);return reply({ok:false,run_id:runId,error:msg},500);}
});
