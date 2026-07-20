/**
 * lib/opportunities/status.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Apresentação e regras de estado da Central de Oportunidades.
 *
 * Responsabilidades:
 * - Traduzir os estados do banco para textos claros da interface.
 * - Classificar cards por seção, prioridade e urgência.
 * - Determinar quais ações podem ser oferecidas ao usuário.
 * - Normalizar estados de oportunidades, resultados, decisões e ordens.
 *
 * Regras importantes:
 * - O servidor e as RPCs continuam sendo a fonte de verdade.
 * - As funções deste arquivo servem para interface e validações preventivas.
 * - Nenhuma função aqui executa ordens ou altera dados no Supabase.
 */

import type {
  ExecutionEnvironment,
  OpportunityDecisionValue,
  OpportunityEntryDecision,
  OpportunityEventActor,
  OpportunityExitDecision,
  OpportunityLifecycleStatus,
  OpportunityOutcome,
  OpportunityOutcomeMode,
  OpportunityOutcomeStatus,
  OpportunitySeverity,
  OpportunitySourceType,
  OpportunityType,
  OrderStatus,
  TradeOpportunity,
} from './types';

// ---------------------------------------------------------------------------
// Tipos de apresentação
// ---------------------------------------------------------------------------

export type StatusTone =
  | 'neutral'
  | 'info'
  | 'positive'
  | 'warning'
  | 'danger'
  | 'critical'
  | 'muted';

export type OpportunitySection =
  | 'pending'
  | 'positions'
  | 'exits'
  | 'history'
  | 'attention';

export type OpportunityCountdownState =
  | 'not_applicable'
  | 'active'
  | 'urgent'
  | 'expired';

export type OutcomeResultClass =
  | 'tracking'
  | 'win'
  | 'loss'
  | 'neutral'
  | 'invalid'
  | 'error';

export interface StatusPresentation<TValue extends string = string> {
  value: TValue;
  label: string;
  shortLabel: string;
  description: string;
  tone: StatusTone;
  sortOrder: number;
}

export interface LifecyclePresentation
  extends StatusPresentation<OpportunityLifecycleStatus> {
  section: OpportunitySection;
  terminal: boolean;
  processing: boolean;
}

export interface CountdownInfo {
  state: OpportunityCountdownState;
  expiresAt: string | null;
  remainingMs: number | null;
  remainingSeconds: number | null;
  label: string;
}

export interface OpportunityActionAvailability {
  canMarkSeen: boolean;
  canBeginReview: boolean;
  canAcceptEntry: boolean;
  canRejectEntry: boolean;
  canReviewExit: boolean;
  canKeepPosition: boolean;
  canConfirmExit: boolean;
  reason: string | null;
}

export interface OpportunityCardState {
  effectiveStatus: OpportunityLifecycleStatus;
  section: OpportunitySection;
  tone: StatusTone;
  label: string;
  priority: number;
  isExpired: boolean;
  isUnread: boolean;
  isProcessing: boolean;
  isTerminal: boolean;
  countdown: CountdownInfo;
  actions: OpportunityActionAvailability;
}

// ---------------------------------------------------------------------------
// Metadados do ciclo principal
// ---------------------------------------------------------------------------

export const LIFECYCLE_PRESENTATION = {
  pending: {
    value: 'pending',
    label: 'Pendente',
    shortLabel: 'Pendente',
    description: 'A oportunidade está disponível e aguarda sua análise.',
    tone: 'info',
    sortOrder: 10,
    section: 'pending',
    terminal: false,
    processing: false,
  },
  under_review: {
    value: 'under_review',
    label: 'Em revisão',
    shortLabel: 'Revisando',
    description: 'A oportunidade foi aberta e está sendo revisada.',
    tone: 'warning',
    sortOrder: 20,
    section: 'pending',
    terminal: false,
    processing: false,
  },
  revalidating: {
    value: 'revalidating',
    label: 'Revalidando mercado',
    shortLabel: 'Revalidando',
    description:
      'A decisão foi aceita e o servidor está conferindo preço, validade e limites.',
    tone: 'warning',
    sortOrder: 30,
    section: 'pending',
    terminal: false,
    processing: true,
  },
  invalidated: {
    value: 'invalidated',
    label: 'Invalidada',
    shortLabel: 'Invalidada',
    description:
      'As condições deixaram de ser válidas antes da abertura da posição.',
    tone: 'muted',
    sortOrder: 80,
    section: 'history',
    terminal: true,
    processing: false,
  },
  expired: {
    value: 'expired',
    label: 'Expirada',
    shortLabel: 'Expirada',
    description: 'O prazo para revisar ou aceitar a oportunidade terminou.',
    tone: 'muted',
    sortOrder: 90,
    section: 'history',
    terminal: true,
    processing: false,
  },
  rejected: {
    value: 'rejected',
    label: 'Recusada',
    shortLabel: 'Recusada',
    description: 'A entrada foi recusada pelo usuário.',
    tone: 'neutral',
    sortOrder: 70,
    section: 'history',
    terminal: true,
    processing: false,
  },
  opening: {
    value: 'opening',
    label: 'Abrindo posição',
    shortLabel: 'Abrindo',
    description:
      'A ordem de entrada está sendo enviada ou aguardando confirmação.',
    tone: 'warning',
    sortOrder: 40,
    section: 'positions',
    terminal: false,
    processing: true,
  },
  open: {
    value: 'open',
    label: 'Posição aberta',
    shortLabel: 'Aberta',
    description: 'A posição está aberta e sendo acompanhada pelo VigIA.',
    tone: 'positive',
    sortOrder: 50,
    section: 'positions',
    terminal: false,
    processing: false,
  },
  exit_pending: {
    value: 'exit_pending',
    label: 'Saída pendente',
    shortLabel: 'Revisar saída',
    description:
      'Uma condição de saída foi identificada e aguarda sua decisão.',
    tone: 'danger',
    sortOrder: 5,
    section: 'exits',
    terminal: false,
    processing: false,
  },
  closing: {
    value: 'closing',
    label: 'Encerrando posição',
    shortLabel: 'Encerrando',
    description:
      'O VigIA está cancelando proteções e confirmando o encerramento.',
    tone: 'warning',
    sortOrder: 6,
    section: 'exits',
    terminal: false,
    processing: true,
  },
  closed: {
    value: 'closed',
    label: 'Encerrada',
    shortLabel: 'Encerrada',
    description: 'A oportunidade foi concluída e possui resultado final.',
    tone: 'neutral',
    sortOrder: 60,
    section: 'history',
    terminal: true,
    processing: false,
  },
  error: {
    value: 'error',
    label: 'Requer atenção',
    shortLabel: 'Erro',
    description:
      'O fluxo encontrou um erro e precisa de verificação antes de continuar.',
    tone: 'critical',
    sortOrder: 0,
    section: 'attention',
    terminal: false,
    processing: false,
  },
} as const satisfies Record<
  OpportunityLifecycleStatus,
  LifecyclePresentation
>;

// ---------------------------------------------------------------------------
// Outros metadados exibidos na interface
// ---------------------------------------------------------------------------

export const ENTRY_DECISION_PRESENTATION = {
  pending: {
    value: 'pending',
    label: 'Aguardando decisão',
    shortLabel: 'Pendente',
    description: 'A entrada ainda não foi aceita nem recusada.',
    tone: 'info',
    sortOrder: 10,
  },
  accepted: {
    value: 'accepted',
    label: 'Entrada aceita',
    shortLabel: 'Aceita',
    description: 'A entrada foi aceita e seguirá para revalidação.',
    tone: 'positive',
    sortOrder: 20,
  },
  rejected: {
    value: 'rejected',
    label: 'Entrada recusada',
    shortLabel: 'Recusada',
    description: 'A entrada foi recusada pelo usuário.',
    tone: 'neutral',
    sortOrder: 30,
  },
  expired: {
    value: 'expired',
    label: 'Decisão expirada',
    shortLabel: 'Expirada',
    description: 'O prazo terminou antes de uma decisão válida.',
    tone: 'muted',
    sortOrder: 40,
  },
  not_applicable: {
    value: 'not_applicable',
    label: 'Não aplicável',
    shortLabel: 'N/A',
    description: 'Esta oportunidade não possui decisão de entrada.',
    tone: 'muted',
    sortOrder: 50,
  },
} as const satisfies Record<
  OpportunityEntryDecision,
  StatusPresentation<OpportunityEntryDecision>
>;

export const EXIT_DECISION_PRESENTATION = {
  pending: {
    value: 'pending',
    label: 'Aguardando decisão de saída',
    shortLabel: 'Pendente',
    description: 'A recomendação de saída ainda aguarda uma decisão.',
    tone: 'danger',
    sortOrder: 10,
  },
  accepted: {
    value: 'accepted',
    label: 'Saída aceita',
    shortLabel: 'Aceita',
    description: 'A saída foi aceita e seguirá para revalidação.',
    tone: 'positive',
    sortOrder: 20,
  },
  kept: {
    value: 'kept',
    label: 'Posição mantida',
    shortLabel: 'Mantida',
    description: 'O usuário decidiu manter a posição aberta.',
    tone: 'warning',
    sortOrder: 30,
  },
  automatic: {
    value: 'automatic',
    label: 'Saída automática',
    shortLabel: 'Automática',
    description: 'A posição foi encerrada por uma regra automática autorizada.',
    tone: 'info',
    sortOrder: 40,
  },
  not_applicable: {
    value: 'not_applicable',
    label: 'Não aplicável',
    shortLabel: 'N/A',
    description: 'Esta oportunidade não possui decisão de saída.',
    tone: 'muted',
    sortOrder: 50,
  },
} as const satisfies Record<
  OpportunityExitDecision,
  StatusPresentation<OpportunityExitDecision>
>;

export const OUTCOME_STATUS_PRESENTATION = {
  tracking: {
    value: 'tracking',
    label: 'Em acompanhamento',
    shortLabel: 'Acompanhando',
    description: 'O resultado ainda está sendo acompanhado.',
    tone: 'info',
    sortOrder: 10,
  },
  target_hit: {
    value: 'target_hit',
    label: 'Alvo atingido',
    shortLabel: 'Alvo',
    description: 'O preço atingiu o alvo antes do stop.',
    tone: 'positive',
    sortOrder: 20,
  },
  stop_hit: {
    value: 'stop_hit',
    label: 'Stop atingido',
    shortLabel: 'Stop',
    description: 'O preço atingiu o stop antes do alvo.',
    tone: 'danger',
    sortOrder: 30,
  },
  manual_exit: {
    value: 'manual_exit',
    label: 'Saída antecipada',
    shortLabel: 'Saída',
    description: 'A posição foi encerrada antes do stop ou do alvo.',
    tone: 'warning',
    sortOrder: 40,
  },
  expired: {
    value: 'expired',
    label: 'Não ativada',
    shortLabel: 'Expirada',
    description: 'A oportunidade expirou antes de uma entrada válida.',
    tone: 'muted',
    sortOrder: 50,
  },
  invalidated: {
    value: 'invalidated',
    label: 'Invalidada',
    shortLabel: 'Invalidada',
    description: 'A hipótese técnica deixou de ser válida.',
    tone: 'muted',
    sortOrder: 60,
  },
  ambiguous: {
    value: 'ambiguous',
    label: 'Resultado ambíguo',
    shortLabel: 'Ambíguo',
    description:
      'Os dados disponíveis não permitem determinar se stop ou alvo ocorreu primeiro.',
    tone: 'warning',
    sortOrder: 70,
  },
  cancelled: {
    value: 'cancelled',
    label: 'Cancelada',
    shortLabel: 'Cancelada',
    description: 'O acompanhamento foi cancelado sem resultado operacional.',
    tone: 'neutral',
    sortOrder: 80,
  },
  error: {
    value: 'error',
    label: 'Erro de apuração',
    shortLabel: 'Erro',
    description: 'O resultado não pôde ser apurado corretamente.',
    tone: 'critical',
    sortOrder: 90,
  },
} as const satisfies Record<
  OpportunityOutcomeStatus,
  StatusPresentation<OpportunityOutcomeStatus>
>;

export const ORDER_STATUS_PRESENTATION = {
  pendente: {
    value: 'pendente',
    label: 'Ordem pendente',
    shortLabel: 'Pendente',
    description: 'A solicitação foi criada, mas ainda não foi enviada.',
    tone: 'warning',
    sortOrder: 10,
  },
  entrada_enviada: {
    value: 'entrada_enviada',
    label: 'Entrada enviada',
    shortLabel: 'Enviada',
    description: 'A ordem de entrada foi enviada à Binance.',
    tone: 'warning',
    sortOrder: 20,
  },
  entrada_executada: {
    value: 'entrada_executada',
    label: 'Entrada executada',
    shortLabel: 'Executada',
    description: 'A compra foi executada e a proteção está sendo preparada.',
    tone: 'info',
    sortOrder: 30,
  },
  protecao_pendente: {
    value: 'protecao_pendente',
    label: 'Proteção pendente',
    shortLabel: 'Protegendo',
    description: 'A OCO ainda está sendo criada ou confirmada.',
    tone: 'warning',
    sortOrder: 40,
  },
  oco_ativa: {
    value: 'oco_ativa',
    label: 'OCO ativa',
    shortLabel: 'Protegida',
    description: 'Stop e alvo estão ativos na Binance.',
    tone: 'positive',
    sortOrder: 50,
  },
  entrada_sem_protecao: {
    value: 'entrada_sem_protecao',
    label: 'Entrada sem proteção',
    shortLabel: 'Sem proteção',
    description: 'A posição foi aberta, mas a OCO não está confirmada.',
    tone: 'critical',
    sortOrder: 0,
  },
  alvo_executado: {
    value: 'alvo_executado',
    label: 'Alvo executado',
    shortLabel: 'Alvo',
    description: 'A Binance executou o alvo da posição.',
    tone: 'positive',
    sortOrder: 60,
  },
  stop_executado: {
    value: 'stop_executado',
    label: 'Stop executado',
    shortLabel: 'Stop',
    description: 'A Binance executou o stop da posição.',
    tone: 'danger',
    sortOrder: 70,
  },
  cancelada: {
    value: 'cancelada',
    label: 'Ordem cancelada',
    shortLabel: 'Cancelada',
    description: 'A ordem foi cancelada.',
    tone: 'neutral',
    sortOrder: 80,
  },
  erro_pre_entrada: {
    value: 'erro_pre_entrada',
    label: 'Entrada bloqueada',
    shortLabel: 'Bloqueada',
    description: 'Uma validação impediu a ordem antes da entrada.',
    tone: 'danger',
    sortOrder: 90,
  },
  erro: {
    value: 'erro',
    label: 'Erro na ordem',
    shortLabel: 'Erro',
    description: 'A execução encontrou um erro que requer verificação.',
    tone: 'critical',
    sortOrder: 100,
  },
} as const satisfies Record<OrderStatus, StatusPresentation<OrderStatus>>;

export const SOURCE_TYPE_LABELS = {
  daytrade_setup: 'Day Trade',
  alert_event: 'Alerta',
  analysis_scenario: 'Análise',
  position_exit: 'Saída de posição',
  manual_test: 'Teste manual',
} as const satisfies Record<OpportunitySourceType, string>;

export const OPPORTUNITY_TYPE_LABELS = {
  entry: 'Entrada',
  exit: 'Saída',
} as const satisfies Record<OpportunityType, string>;

export const EXECUTION_ENVIRONMENT_LABELS = {
  none: 'Somente acompanhamento',
  testnet: 'Binance Testnet',
  real: 'Binance real',
} as const satisfies Record<ExecutionEnvironment, string>;

export const OUTCOME_MODE_LABELS = {
  theoretical: 'Resultado teórico',
  executed: 'Resultado executado',
} as const satisfies Record<OpportunityOutcomeMode, string>;

export const SEVERITY_PRESENTATION = {
  normal: {
    value: 'normal',
    label: 'Normal',
    shortLabel: 'Normal',
    description: 'Oportunidade sem urgência extraordinária.',
    tone: 'info',
    sortOrder: 30,
  },
  high: {
    value: 'high',
    label: 'Prioridade alta',
    shortLabel: 'Alta',
    description: 'A oportunidade requer atenção mais rápida.',
    tone: 'warning',
    sortOrder: 20,
  },
  critical: {
    value: 'critical',
    label: 'Crítica',
    shortLabel: 'Crítica',
    description: 'A situação exige atenção imediata.',
    tone: 'critical',
    sortOrder: 10,
  },
} as const satisfies Record<
  OpportunitySeverity,
  StatusPresentation<OpportunitySeverity>
>;

export const EVENT_ACTOR_LABELS = {
  system: 'Sistema',
  user: 'Usuário',
  edge_function: 'Automação',
  exchange: 'Binance',
} as const satisfies Record<OpportunityEventActor, string>;

export const DECISION_VALUE_LABELS = {
  accepted: 'Aceita',
  rejected: 'Recusada',
  kept: 'Posição mantida',
  automatic: 'Automática',
} as const satisfies Record<OpportunityDecisionValue, string>;

const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  opportunity_created: 'Oportunidade criada',
  opportunity_seen: 'Card visualizado',
  review_started: 'Revisão iniciada',
  opportunity_expired: 'Oportunidade expirada',
  opportunity_invalidated: 'Oportunidade invalidada',
  entry_accepted: 'Entrada aceita',
  entry_rejected: 'Entrada recusada',
  entry_revalidation_started: 'Revalidação iniciada',
  entry_revalidation_passed: 'Revalidação aprovada',
  entry_revalidation_failed: 'Revalidação bloqueada',
  order_created: 'Ordem criada',
  order_sent: 'Ordem enviada',
  entry_filled: 'Entrada executada',
  protection_pending: 'Proteção pendente',
  protection_created: 'Proteção OCO criada',
  protection_failed: 'Falha na proteção',
  exit_opportunity_created: 'Saída identificada',
  exit_accepted: 'Saída aceita',
  position_kept: 'Posição mantida',
  exit_started: 'Encerramento iniciado',
  exit_completed: 'Encerramento concluído',
  target_hit: 'Alvo atingido',
  stop_hit: 'Stop atingido',
  outcome_resolved: 'Resultado apurado',
  email_sent: 'E-mail enviado',
  email_failed: 'Falha no envio do e-mail',
  error: 'Erro registrado',
};

// ---------------------------------------------------------------------------
// Utilitários de data e validade
// ---------------------------------------------------------------------------

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolveNow(now: Date | number = Date.now()): number {
  return now instanceof Date ? now.getTime() : now;
}

export function isOpportunityExpired(
  opportunity: Pick<TradeOpportunity, 'opportunity_type' | 'expires_at'>,
  now: Date | number = Date.now(),
): boolean {
  if (opportunity.opportunity_type !== 'entry') {
    return false;
  }

  const expiresAt = toTimestamp(opportunity.expires_at);
  return expiresAt !== null && expiresAt <= resolveNow(now);
}

export function getOpportunityCountdown(
  opportunity: Pick<TradeOpportunity, 'opportunity_type' | 'expires_at'>,
  now: Date | number = Date.now(),
  urgentThresholdMs = 60_000,
): CountdownInfo {
  if (opportunity.opportunity_type !== 'entry' || !opportunity.expires_at) {
    return {
      state: 'not_applicable',
      expiresAt: opportunity.expires_at,
      remainingMs: null,
      remainingSeconds: null,
      label: 'Sem prazo de entrada',
    };
  }

  const expiresAt = toTimestamp(opportunity.expires_at);

  if (expiresAt === null) {
    return {
      state: 'not_applicable',
      expiresAt: opportunity.expires_at,
      remainingMs: null,
      remainingSeconds: null,
      label: 'Prazo indisponível',
    };
  }

  const remainingMs = expiresAt - resolveNow(now);
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

  if (remainingMs <= 0) {
    return {
      state: 'expired',
      expiresAt: opportunity.expires_at,
      remainingMs: 0,
      remainingSeconds: 0,
      label: 'Prazo encerrado',
    };
  }

  if (remainingMs <= urgentThresholdMs) {
    return {
      state: 'urgent',
      expiresAt: opportunity.expires_at,
      remainingMs,
      remainingSeconds,
      label: `Expira em ${formatCompactDuration(remainingMs)}`,
    };
  }

  return {
    state: 'active',
    expiresAt: opportunity.expires_at,
    remainingMs,
    remainingSeconds,
    label: `Válida por ${formatCompactDuration(remainingMs)}`,
  };
}

export function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}min`;
}

// ---------------------------------------------------------------------------
// Classificação do card
// ---------------------------------------------------------------------------

export function getEffectiveLifecycleStatus(
  opportunity: Pick<
    TradeOpportunity,
    'opportunity_type' | 'lifecycle_status' | 'expires_at'
  >,
  now: Date | number = Date.now(),
): OpportunityLifecycleStatus {
  if (
    (opportunity.lifecycle_status === 'pending' ||
      opportunity.lifecycle_status === 'under_review') &&
    isOpportunityExpired(opportunity, now)
  ) {
    return 'expired';
  }

  return opportunity.lifecycle_status;
}

export function getOpportunitySection(
  opportunity: Pick<
    TradeOpportunity,
    'opportunity_type' | 'lifecycle_status' | 'expires_at'
  >,
  now: Date | number = Date.now(),
): OpportunitySection {
  return LIFECYCLE_PRESENTATION[
    getEffectiveLifecycleStatus(opportunity, now)
  ].section;
}

export function isTerminalLifecycleStatus(
  status: OpportunityLifecycleStatus,
): boolean {
  return LIFECYCLE_PRESENTATION[status].terminal;
}

export function isProcessingLifecycleStatus(
  status: OpportunityLifecycleStatus,
): boolean {
  return LIFECYCLE_PRESENTATION[status].processing;
}

export function isOpenPositionStatus(
  status: OpportunityLifecycleStatus,
): boolean {
  return status === 'opening' || status === 'open';
}

export function isExitFlowStatus(
  status: OpportunityLifecycleStatus,
): boolean {
  return status === 'exit_pending' || status === 'closing';
}

export function isUnreadOpportunity(
  opportunity: Pick<TradeOpportunity, 'seen_at'>,
): boolean {
  return opportunity.seen_at === null;
}

// ---------------------------------------------------------------------------
// Ações permitidas na interface
// ---------------------------------------------------------------------------

export function getOpportunityActionAvailability(
  opportunity: Pick<
    TradeOpportunity,
    | 'opportunity_type'
    | 'lifecycle_status'
    | 'entry_decision'
    | 'exit_decision'
    | 'expires_at'
    | 'seen_at'
  >,
  now: Date | number = Date.now(),
): OpportunityActionAvailability {
  const effectiveStatus = getEffectiveLifecycleStatus(opportunity, now);
  const expired = effectiveStatus === 'expired';
  const entryPending =
    opportunity.opportunity_type === 'entry' &&
    opportunity.entry_decision === 'pending';
  const exitPending =
    opportunity.opportunity_type === 'exit' &&
    opportunity.exit_decision === 'pending';

  const canBeginReview =
    !expired &&
    (effectiveStatus === 'pending' || effectiveStatus === 'under_review');

  const canAcceptEntry = canBeginReview && entryPending;
  const canRejectEntry = canBeginReview && entryPending;

  const canReviewExit =
    exitPending &&
    (effectiveStatus === 'exit_pending' ||
      effectiveStatus === 'under_review');

  const canKeepPosition = canReviewExit;
  const canConfirmExit = canReviewExit;

  let reason: string | null = null;

  if (expired) {
    reason = 'O prazo da oportunidade terminou.';
  } else if (effectiveStatus === 'revalidating') {
    reason = 'A oportunidade já está sendo revalidada.';
  } else if (effectiveStatus === 'opening') {
    reason = 'A ordem de entrada já está sendo processada.';
  } else if (effectiveStatus === 'open') {
    reason = 'A posição já está aberta.';
  } else if (effectiveStatus === 'closing') {
    reason = 'O encerramento da posição já está sendo processado.';
  } else if (isTerminalLifecycleStatus(effectiveStatus)) {
    reason = 'A oportunidade já foi encerrada.';
  } else if (effectiveStatus === 'error') {
    reason = 'O fluxo precisa ser verificado antes de uma nova ação.';
  }

  return {
    canMarkSeen: opportunity.seen_at === null,
    canBeginReview,
    canAcceptEntry,
    canRejectEntry,
    canReviewExit,
    canKeepPosition,
    canConfirmExit,
    reason,
  };
}

export function getOpportunityCardState(
  opportunity: TradeOpportunity,
  now: Date | number = Date.now(),
): OpportunityCardState {
  const effectiveStatus = getEffectiveLifecycleStatus(opportunity, now);
  const presentation = LIFECYCLE_PRESENTATION[effectiveStatus];
  const countdown = getOpportunityCountdown(opportunity, now);
  const actions = getOpportunityActionAvailability(opportunity, now);
  const isUnread = isUnreadOpportunity(opportunity);

  return {
    effectiveStatus,
    section: presentation.section,
    tone:
      countdown.state === 'urgent' && presentation.section === 'pending'
        ? 'danger'
        : presentation.tone,
    label: presentation.label,
    priority: getOpportunityPriority(opportunity, now),
    isExpired: effectiveStatus === 'expired',
    isUnread,
    isProcessing: presentation.processing,
    isTerminal: presentation.terminal,
    countdown,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Priorização e ordenação
// ---------------------------------------------------------------------------

const SECTION_PRIORITY: Readonly<Record<OpportunitySection, number>> = {
  attention: 0,
  exits: 100,
  pending: 200,
  positions: 300,
  history: 400,
};

const SEVERITY_PRIORITY: Readonly<Record<OpportunitySeverity, number>> = {
  critical: 0,
  high: 10,
  normal: 20,
};

export function getOpportunityPriority(
  opportunity: Pick<
    TradeOpportunity,
    | 'opportunity_type'
    | 'lifecycle_status'
    | 'expires_at'
    | 'severity'
    | 'seen_at'
    | 'detected_at'
  >,
  now: Date | number = Date.now(),
): number {
  const effectiveStatus = getEffectiveLifecycleStatus(opportunity, now);
  const presentation = LIFECYCLE_PRESENTATION[effectiveStatus];
  const countdown = getOpportunityCountdown(opportunity, now);

  let priority =
    SECTION_PRIORITY[presentation.section] +
    SEVERITY_PRIORITY[opportunity.severity] +
    presentation.sortOrder;

  if (opportunity.seen_at === null) {
    priority -= 5;
  }

  if (countdown.state === 'urgent') {
    priority -= 15;
  }

  const detectedAt = toTimestamp(opportunity.detected_at);
  if (detectedAt !== null) {
    const ageMinutes = Math.max(
      0,
      Math.floor((resolveNow(now) - detectedAt) / 60_000),
    );

    // Mantém o peso temporal limitado para não ultrapassar a prioridade
    // semântica da seção.
    priority += Math.min(ageMinutes, 30) / 100;
  }

  return priority;
}

export function compareOpportunitiesForDashboard(
  left: TradeOpportunity,
  right: TradeOpportunity,
  now: Date | number = Date.now(),
): number {
  const priorityDifference =
    getOpportunityPriority(left, now) - getOpportunityPriority(right, now);

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return (
    (toTimestamp(right.detected_at) ?? 0) -
    (toTimestamp(left.detected_at) ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Classificação de resultados
// ---------------------------------------------------------------------------

export function isResolvedOutcomeStatus(
  status: OpportunityOutcomeStatus,
): boolean {
  return status !== 'tracking';
}

export function classifyOutcomeResult(
  outcome: Pick<OpportunityOutcome, 'status' | 'result_r'>,
): OutcomeResultClass {
  if (outcome.status === 'tracking') {
    return 'tracking';
  }

  if (outcome.status === 'error') {
    return 'error';
  }

  if (
    outcome.status === 'expired' ||
    outcome.status === 'invalidated' ||
    outcome.status === 'ambiguous' ||
    outcome.status === 'cancelled'
  ) {
    return 'invalid';
  }

  if (outcome.status === 'target_hit') {
    return 'win';
  }

  if (outcome.status === 'stop_hit') {
    return 'loss';
  }

  if (outcome.result_r === null || !Number.isFinite(outcome.result_r)) {
    return 'neutral';
  }

  if (outcome.result_r > 0) {
    return 'win';
  }

  if (outcome.result_r < 0) {
    return 'loss';
  }

  return 'neutral';
}

export function getOutcomeResultLabel(
  outcome: Pick<OpportunityOutcome, 'status' | 'result_r'>,
): string {
  const resultClass = classifyOutcomeResult(outcome);

  switch (resultClass) {
    case 'tracking':
      return 'Em acompanhamento';
    case 'win':
      return 'Positivo';
    case 'loss':
      return 'Negativo';
    case 'neutral':
      return 'Neutro';
    case 'invalid':
      return 'Sem resultado conclusivo';
    case 'error':
      return 'Erro na apuração';
  }
}

export function getOutcomeTone(
  outcome: Pick<OpportunityOutcome, 'status' | 'result_r'>,
): StatusTone {
  const resultClass = classifyOutcomeResult(outcome);

  switch (resultClass) {
    case 'win':
      return 'positive';
    case 'loss':
      return 'danger';
    case 'tracking':
      return 'info';
    case 'error':
      return 'critical';
    case 'neutral':
      return 'neutral';
    case 'invalid':
      return 'muted';
  }
}

// ---------------------------------------------------------------------------
// Labels auxiliares
// ---------------------------------------------------------------------------

export function getLifecyclePresentation(
  status: OpportunityLifecycleStatus,
): LifecyclePresentation {
  return LIFECYCLE_PRESENTATION[status];
}

export function getEntryDecisionPresentation(
  decision: OpportunityEntryDecision,
): StatusPresentation<OpportunityEntryDecision> {
  return ENTRY_DECISION_PRESENTATION[decision];
}

export function getExitDecisionPresentation(
  decision: OpportunityExitDecision,
): StatusPresentation<OpportunityExitDecision> {
  return EXIT_DECISION_PRESENTATION[decision];
}

export function getOutcomeStatusPresentation(
  status: OpportunityOutcomeStatus,
): StatusPresentation<OpportunityOutcomeStatus> {
  return OUTCOME_STATUS_PRESENTATION[status];
}

export function getOrderStatusPresentation(
  status: OrderStatus,
): StatusPresentation<OrderStatus> {
  return ORDER_STATUS_PRESENTATION[status];
}

export function getOpportunitySourceLabel(
  sourceType: OpportunitySourceType,
): string {
  return SOURCE_TYPE_LABELS[sourceType];
}

export function getOpportunityTypeLabel(
  opportunityType: OpportunityType,
): string {
  return OPPORTUNITY_TYPE_LABELS[opportunityType];
}

export function getExecutionEnvironmentLabel(
  environment: ExecutionEnvironment,
): string {
  return EXECUTION_ENVIRONMENT_LABELS[environment];
}

export function getOutcomeModeLabel(mode: OpportunityOutcomeMode): string {
  return OUTCOME_MODE_LABELS[mode];
}

export function getEventTypeLabel(eventType: string): string {
  const knownLabel = EVENT_TYPE_LABELS[eventType];

  if (knownLabel) {
    return knownLabel;
  }

  return eventType
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}