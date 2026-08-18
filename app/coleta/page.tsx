'use client';

/**
 * app/coleta/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Acompanhamento da coleta prospectiva.
 *
 * POR QUE ESTA PÁGINA EXISTE
 *
 * O painel e a tela de teste prospectivo mostram sinais e resultados. Num
 * experimento que produz 1 a 3 sinais por dia e leva meses até n=300, isso
 * significa tela vazia por semanas — ESTANDO TUDO CERTO.
 *
 * Em 16/08/2026 o cron `forward-test-horario` ficou desligado por horas e o
 * sintoma na tela foi exatamente igual ao de um dia calmo: nada aparecendo.
 * Não havia como distinguir "motor parado" de "mercado sem setup".
 *
 * Esta tela separa as três perguntas que estavam misturadas:
 *
 *   1. O motor rodou?          -> vw_saude_coleta
 *   2. Quanto falta para n?    -> vw_portao_estatistico
 *   3. Já bateu algum critério -> vw_portao_estatistico.situacao
 *      de morte?
 *
 * O indicador de saúde é `situacao_motor`, NÃO a chegada de sinais. Run vazio
 * é o estado normal deste experimento.
 *
 * Esta tela NÃO mostra resultado parcial em destaque de propósito. O
 * pré-registro proíbe usar resultado parcial para decidir se continua, e uma
 * curva de R piscando no topo da página é um convite diário a violar isso.
 */

import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabaseClient';

import CabecalhoVigIA, { S } from '../../components/CabecalhoVigIA';

const mono =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

interface SaudeColeta {
  config_versao: string | null;
  ultimo_run: string | null;
  minutos_desde_ultimo_run: number | null;
  pares_esperados: number | null;
  pares_processados: number | null;
  ultima_duracao_ms: number | null;
  falhas_no_ultimo_run: number | null;
  detalhe_falhas: unknown;
  runs_24h: number | null;
  runs_com_falha_24h: number | null;
  sinais_criados_24h: number | null;
  sinais_resolvidos_24h: number | null;
  situacao_motor: string | null;
}

interface Portao {
  config_versao: string | null;
  operacoes_fechadas: number | null;
  amostra_alvo: number | null;
  gatilho_futilidade_n: number | null;
  soma_r: number | null;
  t_observado: number | null;
  t_exigido: number | null;
  fechados_por_dia: number | null;
  dias_estimados_ate_alvo: number | null;
  situacao: string | null;
  detalhe: string | null;
}

const num = (v: number | null | undefined, casas = 2) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      });

const quando = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Verde só quando está tudo certo. Qualquer desvio precisa saltar aos olhos. */
const corSituacaoMotor = (situacao: string | null) =>
  situacao === 'SAUDAVEL'
    ? S.green
    : situacao === 'RODANDO COM FALHAS'
      ? S.yellow
      : S.red;

const corSituacaoPortao = (situacao: string | null) =>
  situacao === 'COLETANDO'
    ? S.blue
    : situacao === 'APROVADO PARA DISCUSSAO'
      ? S.green
      : S.red;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 12,
        padding: 18,
        marginBottom: 16,
      }}
    >
      {children}
    </section>
  );
}

function Metrica({
  rotulo,
  valor,
  cor,
  nota,
}: {
  rotulo: string;
  valor: string;
  cor?: string;
  nota?: string;
}) {
  return (
    <div
      style={{
        background: S.soft,
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: '10px 12px',
        flex: '1 1 140px',
        minWidth: 140,
      }}
    >
      <div style={{ color: S.dim, fontSize: 11, marginBottom: 4 }}>{rotulo}</div>
      <div
        style={{
          fontFamily: mono,
          fontSize: 18,
          fontWeight: 700,
          color: cor ?? S.text,
        }}
      >
        {valor}
      </div>
      {nota && (
        <div style={{ color: S.dim, fontSize: 11, marginTop: 3 }}>{nota}</div>
      )}
    </div>
  );
}

export default function ColetaPage() {
  const supabase = getSupabase();
  const [saude, setSaude] = useState<SaudeColeta | null>(null);
  const [portoes, setPortoes] = useState<Portao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);

  const carregar = useCallback(async () => {
    if (!supabase) {
      setErro('Supabase não configurado.');
      setCarregando(false);
      return;
    }
    const [s, p] = await Promise.all([
      supabase.from('vw_saude_coleta').select('*').maybeSingle(),
      supabase.from('vw_portao_estatistico').select('*'),
    ]);
    if (s.error) setErro(s.error.message);
    else if (p.error) setErro(p.error.message);
    else setErro(null);

    setSaude((s.data ?? null) as SaudeColeta | null);
    setPortoes((p.data ?? []) as Portao[]);
    setAtualizadoEm(new Date());
    setCarregando(false);
  }, [supabase]);

  useEffect(() => {
    void carregar();
    // O cron é horário; recarregar a cada 5 min é folgado e suficiente.
    const timer = setInterval(() => void carregar(), 300_000);
    return () => clearInterval(timer);
  }, [carregar]);

  const falhas = Array.isArray(saude?.detalhe_falhas)
    ? (saude?.detalhe_falhas as unknown[])
    : [];

  return (
    <div style={{ background: S.bg, minHeight: '100vh', color: S.text }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 18px 40px' }}>
        <CabecalhoVigIA
          titulo="Coleta"
          subtitulo="saúde do motor · progresso até a amostra · portão estatístico"
          ativo="/coleta"
          supabase={supabase ?? undefined}
        />

        {erro && (
          <Card>
            <div style={{ color: S.red, fontSize: 13 }}>{erro}</div>
          </Card>
        )}

        {carregando && (
          <Card>
            <div style={{ color: S.dim, fontSize: 13 }}>Carregando…</div>
          </Card>
        )}

        {/* ---------------------------------------------------------------
            1. O motor rodou?
            Esta é a pergunta que a tela antiga não respondia.
        ---------------------------------------------------------------- */}
        {saude && (
          <Card>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 4,
              }}
            >
              <div style={{ fontSize: 17, fontWeight: 750 }}>Motor de coleta</div>
              <div
                style={{
                  fontFamily: mono,
                  fontWeight: 800,
                  fontSize: 13,
                  color: corSituacaoMotor(saude.situacao_motor),
                }}
              >
                {saude.situacao_motor ?? '—'}
              </div>
            </div>
            <div style={{ color: S.dim, fontSize: 12, marginBottom: 14 }}>
              Sinal novo não é indicador de saúde. Com a cesta atual, o normal é
              passar horas sem nenhum. O que precisa estar verde é isto aqui.
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Metrica
                rotulo="Última execução"
                valor={quando(saude.ultimo_run)}
                nota={`há ${saude.minutos_desde_ultimo_run ?? '—'} min`}
                cor={
                  (saude.minutos_desde_ultimo_run ?? 0) > 90 ? S.red : S.text
                }
              />
              <Metrica
                rotulo="Execuções em 24h"
                valor={`${saude.runs_24h ?? '—'} / 24`}
                cor={(saude.runs_24h ?? 0) < 22 ? S.yellow : S.text}
                nota="cron horário"
              />
              <Metrica
                rotulo="Pares processados"
                valor={`${saude.pares_processados ?? '—'} / ${saude.pares_esperados ?? '—'}`}
                cor={
                  saude.pares_processados !== saude.pares_esperados
                    ? S.red
                    : S.text
                }
              />
              <Metrica
                rotulo="Falhas no último run"
                valor={String(saude.falhas_no_ultimo_run ?? '—')}
                cor={(saude.falhas_no_ultimo_run ?? 0) > 0 ? S.red : S.green}
              />
              <Metrica
                rotulo="Config em coleta"
                valor={saude.config_versao ?? '—'}
              />
              <Metrica
                rotulo="Duração"
                valor={`${((saude.ultima_duracao_ms ?? 0) / 1000).toFixed(1)}s`}
                nota="timeout 280s"
              />
            </div>

            {falhas.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  background: S.soft,
                  border: `1px solid ${S.red}`,
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div
                  style={{ color: S.red, fontSize: 12, fontWeight: 700 }}
                >
                  Símbolos com falha — candidatos a poda
                </div>
                <pre
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    color: S.dim,
                    margin: '6px 0 0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {JSON.stringify(falhas, null, 2)}
                </pre>
              </div>
            )}

            <div style={{ color: S.dim, fontSize: 12, marginTop: 12 }}>
              Nas últimas 24h: {saude.sinais_criados_24h ?? 0} sinal(is)
              detectado(s), {saude.sinais_resolvidos_24h ?? 0} resolvido(s).
            </div>
          </Card>
        )}

        {/* ---------------------------------------------------------------
            2 e 3. Progresso e portão estatístico.
        ---------------------------------------------------------------- */}
        {portoes.map((p) => {
          const fechadas = p.operacoes_fechadas ?? 0;
          const alvo = p.amostra_alvo ?? 300;
          const pct = Math.min(100, (fechadas / Math.max(1, alvo)) * 100);
          const pctFutilidade =
            ((p.gatilho_futilidade_n ?? alvo / 2) / Math.max(1, alvo)) * 100;

          return (
            <Card key={p.config_versao ?? 'x'}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 4,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 750 }}>
                  Portão estatístico · {p.config_versao}
                </div>
                <div
                  style={{
                    fontFamily: mono,
                    fontWeight: 800,
                    fontSize: 13,
                    color: corSituacaoPortao(p.situacao),
                  }}
                >
                  {p.situacao ?? '—'}
                </div>
              </div>

              {/* Barra de progresso com a marca do gatilho de futilidade. */}
              <div
                style={{
                  position: 'relative',
                  height: 10,
                  background: S.soft,
                  border: `1px solid ${S.border}`,
                  borderRadius: 999,
                  overflow: 'hidden',
                  margin: '14px 0 6px',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: corSituacaoPortao(p.situacao),
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: `${pctFutilidade}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: S.a,
                  }}
                  title="Gatilho de futilidade"
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: S.dim,
                  fontSize: 11,
                  marginBottom: 14,
                }}
              >
                <span>
                  {fechadas} de {alvo} operações fechadas
                </span>
                <span style={{ color: S.a }}>
                  ▏futilidade em {p.gatilho_futilidade_n ?? '—'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Metrica
                  rotulo="Ritmo observado"
                  valor={`${num(p.fechados_por_dia)}/dia`}
                />
                <Metrica
                  rotulo="Dias até o alvo"
                  valor={
                    p.dias_estimados_ate_alvo === null ||
                    p.dias_estimados_ate_alvo === undefined
                      ? '—'
                      : String(p.dias_estimados_ate_alvo)
                  }
                  nota="ao ritmo atual"
                />
                <Metrica
                  rotulo="t exigido"
                  valor={num(p.t_exigido, 3)}
                  nota="Šidák, carga 196"
                />
              </div>

              {/*
                t observado e soma de R ficam propositalmente em texto miúdo,
                fora dos cartões de destaque. O pré-registro proíbe usar
                resultado parcial para decidir se continua; dar destaque a eles
                é criar a tentação todo dia.
              */}
              <div
                style={{
                  color: S.dim,
                  fontSize: 11,
                  marginTop: 12,
                  fontFamily: mono,
                }}
              >
                parcial (não usar para decidir): soma R {num(p.soma_r)} · t{' '}
                {num(p.t_observado, 3)}
              </div>

              {p.detalhe && (
                <div
                  style={{
                    marginTop: 12,
                    background: S.soft,
                    border: `1px solid ${
                      p.situacao?.startsWith('MORTE') ? S.red : S.border
                    }`,
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 12,
                    color: p.situacao?.startsWith('MORTE') ? S.red : S.dim,
                    lineHeight: 1.5,
                  }}
                >
                  {p.detalhe}
                </div>
              )}
            </Card>
          );
        })}

        {!carregando && portoes.length === 0 && (
          <Card>
            <div style={{ color: S.dim, fontSize: 13 }}>
              Nenhuma configuração com <code>coletar = true</code>. Isso é um
              estado legítimo quando todas as hipóteses foram encerradas — mas
              se não foi intencional, o motor está gastando execução sem gerar
              evidência.
            </div>
          </Card>
        )}

        <div style={{ color: S.dim, fontSize: 11, textAlign: 'center' }}>
          Atualiza sozinho a cada 5 minutos
          {atualizadoEm && ` · última leitura ${quando(atualizadoEm.toISOString())}`}
        </div>
      </div>
    </div>
  );
}
