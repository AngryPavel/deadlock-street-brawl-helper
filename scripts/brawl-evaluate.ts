// Reproducible structural audit and optional human-reviewed card-ranking evaluation. No weight fitting.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrawlAnalytics, BrawlConfig, BrawlInput, DraftAdvice, DraftState } from '../src/brawl/types';
import type { Ability, Hero, Item } from '../src/types';

type Split = 'training' | 'holdout';
type CheckName =
  | 'permutation-invariance'
  | 'no-reroll'
  | 'last-choice-hold-zero'
  | 'current-score-consistency'
  | 'owned-duplicate-penalty';
export interface EvaluationCase {
  id: string;
  split: Split;
  provenance: 'audit-regression' | 'expert-review';
  description: string;
  hero: string;
  round: number;
  choice: number;
  rerollsRemaining: number | null;
  owned: string[];
  enemies: string[];
  sets: { item: string; enhanced?: boolean; rare?: boolean }[][];
  catalogRestriction?: string[];
  checks: CheckName[];
  observation?: {
    source: 'synthetic-regression' | 'match-observation';
    /** Null for structural scenarios: they are not historical match observations. */
    unixTimestamp: number | null;
    matchId: number | null;
    patchId: string | null;
  };
  /** Enter only an independently supplied human review, never generate labels from engine output. */
  expertReview?: {
    reviewStatus: 'pending' | 'reviewed';
    author: string;
    explanation: string;
    expertAcceptedIds: number[];
  };
}

export interface EvaluationDataset {
  version: 1;
  description: string;
  cases: EvaluationCase[];
}

interface CheckResult {
  name: CheckName;
  status: 'passed' | 'failed' | 'not-applicable';
  explanation: string;
}

interface CaseResult {
  id: string;
  split: Split;
  provenance: EvaluationCase['provenance'];
  topItemId: number | null;
  topEnhanced: boolean;
  reroll: null | { set: number; gain: number; holdValue: number; currentBest: number; expectedBest: number };
  checks: CheckResult[];
  expertReviewStatus: 'reviewed' | 'unreviewed';
  expertAccepted: boolean | null;
}

export interface EvaluationReport {
  version: 1;
  generatedAt: string;
  datasetHash: string;
  snapshotHash: string;
  engineLabel: string;
  cases: CaseResult[];
  summaries: Record<Split, ReturnType<typeof summarize>>;
  limitations: string[];
  leakage?: {
    splitSeparation: 'passed';
    cases: { id: string; status: 'passed' | 'failed' | 'unverified' | 'not-applicable'; explanation: string }[];
  };
  evidenceWindows?: {
    heroId: number;
    patchId: string | null;
    minUnixTimestamp: number | null;
    maxUnixTimestamp: number | null;
    maxMatchId: number | null;
  }[];
  comparison?: ReturnType<typeof compareReports>;
}

type Advisor = (input: BrawlInput, state: DraftState) => DraftAdvice;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8;
const checks = new Set<CheckName>([
  'permutation-invariance',
  'no-reroll',
  'last-choice-hold-zero',
  'current-score-consistency',
  'owned-duplicate-penalty',
]);

export function parseEvaluationDataset(value: unknown): EvaluationDataset {
  if (!value || typeof value !== 'object') throw new Error('Evaluation dataset must be an object');
  const dataset = value as EvaluationDataset;
  if (
    dataset.version !== 1 ||
    typeof dataset.description !== 'string' ||
    !Array.isArray(dataset.cases) ||
    !dataset.cases.length
  )
    throw new Error('Evaluation dataset must be version 1 with at least one case');
  const ids = new Set<string>();
  for (const row of dataset.cases) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      !['training', 'holdout'].includes(row.split) ||
      !['audit-regression', 'expert-review'].includes(row.provenance) ||
      typeof row.description !== 'string' ||
      !row.description ||
      typeof row.hero !== 'string' ||
      !Number.isInteger(row.round) ||
      row.round < 1 ||
      row.round > 5 ||
      !Number.isInteger(row.choice) ||
      row.choice < 1 ||
      row.choice > 3 ||
      !(
        row.rerollsRemaining === null ||
        (Number.isInteger(row.rerollsRemaining) && row.rerollsRemaining >= 0 && row.rerollsRemaining <= 10)
      ) ||
      !Array.isArray(row.owned) ||
      !row.owned.every((s) => typeof s === 'string') ||
      !Array.isArray(row.enemies) ||
      !row.enemies.every((s) => typeof s === 'string') ||
      !Array.isArray(row.sets) ||
      row.sets.length !== 3 ||
      !row.sets.every(
        (set) =>
          Array.isArray(set) &&
          (set.length === 0 || set.length === 3) &&
          set.every(
            (card) =>
              card &&
              typeof card.item === 'string' &&
              (card.enhanced === undefined || typeof card.enhanced === 'boolean') &&
              (card.rare === undefined || typeof card.rare === 'boolean'),
          ),
      ) ||
      row.sets[row.choice - 1].length !== 3 ||
      !Array.isArray(row.checks) ||
      !row.checks.every((check) => checks.has(check)) ||
      (row.catalogRestriction !== undefined &&
        (!Array.isArray(row.catalogRestriction) || !row.catalogRestriction.every((s) => typeof s === 'string')))
    )
      throw new Error(`Invalid evaluation case: ${row?.id ?? '(missing id)'}`);
    if (
      row.expertReview &&
      (!['pending', 'reviewed'].includes(row.expertReview.reviewStatus) ||
        typeof row.expertReview.author !== 'string' ||
        typeof row.expertReview.explanation !== 'string' ||
        !Array.isArray(row.expertReview.expertAcceptedIds) ||
        !row.expertReview.expertAcceptedIds.every(Number.isInteger))
    )
      throw new Error(`Invalid expert review: ${row.id}`);
    const observation = row.observation;
    if (
      observation &&
      (!['synthetic-regression', 'match-observation'].includes(observation.source) ||
        !(
          observation.unixTimestamp === null ||
          (Number.isSafeInteger(observation.unixTimestamp) && observation.unixTimestamp > 0)
        ) ||
        !(observation.matchId === null || (Number.isSafeInteger(observation.matchId) && observation.matchId > 0)) ||
        !(observation.patchId === null || typeof observation.patchId === 'string') ||
        (observation.source === 'match-observation' &&
          (observation.unixTimestamp === null || observation.matchId === null)) ||
        (observation.source === 'synthetic-regression' &&
          (observation.unixTimestamp !== null || observation.matchId !== null)))
    )
      throw new Error(`Invalid observation metadata: ${row.id}`);
    ids.add(row.id);
  }
  validateSplitSeparation(dataset);
  return dataset;
}

/** Order of cards is not a new validation example; whole cards keep their flags. */
export function validateSplitSeparation(dataset: EvaluationDataset): void {
  const seen = new Map<string, Split>();
  for (const row of dataset.cases) {
    const identity = JSON.stringify({
      hero: row.hero,
      round: row.round,
      choice: row.choice,
      rerollsRemaining: row.rerollsRemaining,
      owned: [...row.owned].sort(),
      enemies: [...row.enemies].sort(),
      sets: row.sets.map((set) =>
        set
          .map((card) => ({ item: card.item, enhanced: !!card.enhanced, rare: !!card.rare }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
      catalogRestriction: row.catalogRestriction ? [...row.catalogRestriction].sort() : null,
    });
    for (const key of [identity, ...(row.observation?.matchId ? [`match:${row.observation.matchId}`] : [])]) {
      if (seen.has(key) && seen.get(key) !== row.split) throw new Error(`Training/holdout leakage: ${row.id}`);
      seen.set(key, row.split);
    }
  }
}

export function checkObservationLeakage(
  row: EvaluationCase,
  analytics: BrawlAnalytics,
): NonNullable<EvaluationReport['leakage']>['cases'][number] {
  const observation = row.observation;
  if (observation?.source === 'synthetic-regression')
    return {
      id: row.id,
      status: 'not-applicable',
      explanation:
        'Structural scenario has no observed match or timestamp; it cannot establish temporal generalization.',
    };
  if (!observation || !analytics.stats_window)
    return {
      id: row.id,
      status: 'unverified',
      explanation: 'Observation metadata or exact analytics window is missing; temporal leakage cannot be ruled out.',
    };
  const window = analytics.stats_window;
  if (
    observation.unixTimestamp! <= window.max_unix_timestamp ||
    (window.max_match_id !== undefined && observation.matchId! <= window.max_match_id)
  )
    return {
      id: row.id,
      status: 'failed',
      explanation:
        'Observation is not strictly after the analytics time/match cutoff; its outcome may be inside the scoring evidence.',
    };
  if (window.max_match_id === undefined)
    return {
      id: row.id,
      status: 'unverified',
      explanation:
        'Time cutoff is earlier, but analytics has no match-ID cutoff for an independent match overlap check.',
    };
  return {
    id: row.id,
    status: 'passed',
    explanation: 'Observed match is strictly later than both recorded analytics time and match-ID cutoffs.',
  };
}

export function hasExpertReview(row: EvaluationCase): boolean {
  const review = row.expertReview;
  return !!(
    review?.reviewStatus === 'reviewed' &&
    review.author.trim() &&
    review.explanation.trim() &&
    review.expertAcceptedIds.length
  );
}

function summarize(rows: CaseResult[]) {
  const reviewed = rows.filter((row) => row.expertReviewStatus === 'reviewed');
  const structural = rows.flatMap((row) => row.checks);
  return {
    cases: rows.length,
    checksPassed: structural.filter((check) => check.status === 'passed').length,
    checksFailed: structural.filter((check) => check.status === 'failed').length,
    checksNotApplicable: structural.filter((check) => check.status === 'not-applicable').length,
    expertReviewed: reviewed.length,
    unreviewed: rows.length - reviewed.length,
    expertAgreement: reviewed.length ? reviewed.filter((row) => row.expertAccepted).length / reviewed.length : null,
  };
}

function samePrediction(a: CaseResult, b: CaseResult): boolean {
  if (a.topItemId !== b.topItemId || a.topEnhanced !== b.topEnhanced || a.reroll?.set !== b.reroll?.set) return false;
  if (!a.reroll || !b.reroll) return a.reroll === b.reroll;
  return (['gain', 'holdValue', 'currentBest', 'expectedBest'] as const).every((key) =>
    close(a.reroll![key], b.reroll![key]),
  );
}

export function compareReports(current: EvaluationReport, baseline: EvaluationReport) {
  if (
    baseline.version !== 1 ||
    baseline.datasetHash !== current.datasetHash ||
    baseline.snapshotHash !== current.snapshotHash
  )
    throw new Error('Baseline comparison requires the same dataset and data snapshot hashes');
  const before = new Map(baseline.cases.map((row) => [row.id, row]));
  if (current.cases.some((row) => !before.has(row.id)))
    throw new Error('Baseline is missing selected evaluation cases');
  return {
    baselineEngine: baseline.engineLabel,
    changedCaseIds: current.cases.filter((row) => !samePrediction(row, before.get(row.id)!)).map((row) => row.id),
    structuralChanges: current.cases.flatMap((row) =>
      row.checks.flatMap((check) => {
        const previous = before.get(row.id)!.checks.find((candidate) => candidate.name === check.name);
        return previous && previous.status !== check.status
          ? [{ id: row.id, check: check.name, before: previous.status, after: check.status }]
          : [];
      }),
    ),
    expertComparison: (['training', 'holdout'] as const).map((split) => {
      const rows = current.cases.filter(
        (row) =>
          row.split === split &&
          row.expertReviewStatus === 'reviewed' &&
          before.get(row.id)!.expertReviewStatus === 'reviewed',
      );
      return {
        split,
        reviewedCases: rows.length,
        beforeAgreement: rows.length
          ? rows.filter((row) => before.get(row.id)!.expertAccepted).length / rows.length
          : null,
        afterAgreement: rows.length ? rows.filter((row) => row.expertAccepted).length / rows.length : null,
      };
    }),
  };
}

function prediction(row: EvaluationCase, state: DraftState, advice: DraftAdvice): CaseResult {
  const pickIndex = state.sets.slice(0, row.choice - 1).filter((set) => set.length > 0).length;
  const top = advice.picks[pickIndex];
  const r = advice.reroll;
  const reviewed = hasExpertReview(row);
  return {
    id: row.id,
    split: row.split,
    provenance: row.provenance,
    topItemId: top?.item.id ?? null,
    topEnhanced: top?.enhanced ?? false,
    reroll: r
      ? { set: r.set, gain: r.gain, holdValue: r.holdValue, currentBest: r.currentBest, expectedBest: r.expectedBest }
      : null,
    checks: [],
    expertReviewStatus: reviewed ? 'reviewed' : 'unreviewed',
    expertAccepted: reviewed ? row.expertReview!.expertAcceptedIds.includes(top?.item.id ?? -1) : null,
  };
}

/** Check rules are stated in the dataset before executing either engine. They never supply a best-item label. */
export function evaluateCase(row: EvaluationCase, input: BrawlInput, state: DraftState, advise: Advisor): CaseResult {
  if (
    hasExpertReview(row) &&
    row.expertReview!.expertAcceptedIds.some((id) => !state.sets[row.choice - 1].some((offer) => offer.itemId === id))
  )
    throw new Error(`Expert label includes an item absent from the current offer: ${row.id}`);
  const advice = advise(input, state);
  const result = prediction(row, state, advice);
  for (const check of row.checks) {
    let passed = false;
    let explanation = '';
    if (check === 'no-reroll') {
      passed = advice.reroll === null;
      explanation = 'The specified token or singleton-pool control permits no beneficial reroll.';
    } else if (check === 'permutation-invariance') {
      const cards = state.sets[row.choice - 1];
      const permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      passed = permutations.every((order) => {
        const variant = {
          ...state,
          sets: state.sets.map((set, i) => (i === row.choice - 1 ? order.map((index) => cards[index]) : set)),
        };
        return samePrediction(result, prediction(row, variant, advise(input, variant)));
      });
      explanation = 'All six whole-card permutations preserve the recommendation and reroll values.';
    } else if (check === 'owned-duplicate-penalty') {
      const duplicates = advice.sets[row.choice - 1].filter((offer) => state.owned.includes(offer.item.id));
      passed = duplicates.length > 0 && duplicates.every((offer) => offer.parts.dup < 0);
      explanation = 'Every offered owned duplicate receives a negative duplicate term.';
    } else if (!advice.reroll) {
      result.checks.push({
        name: check,
        status: 'not-applicable',
        explanation: 'The engine returned no reroll advice to inspect; this is not counted as a passed check.',
      });
      continue;
    } else if (check === 'last-choice-hold-zero') {
      passed = advice.reroll.set === 2 && close(advice.reroll.holdValue, 0);
      explanation = 'A final-choice recommendation reserves no value for later choices.';
    } else if (check === 'current-score-consistency') {
      passed = close(
        advice.reroll.currentBest,
        Math.max(...advice.sets[advice.reroll.set].map((offer) => offer.score)),
      );
      explanation = 'The current-best value equals the displayed full score, including owned and enemy terms.';
    }
    result.checks.push({ name: check, status: passed ? 'passed' : 'failed', explanation });
  }
  return result;
}

export async function runEvaluation(
  args: string[],
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const options = new Map<string, string>();
  let requireExpert = false;
  let requireNoLeakage = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--require-expert-reviewed') {
      requireExpert = true;
      continue;
    }
    if (args[i] === '--require-no-leakage') {
      requireNoLeakage = true;
      continue;
    }
    if (
      !['--dataset', '--output', '--baseline-report', '--engine-module', '--engine-label', '--split'].includes(
        args[i],
      ) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error(`Unknown or incomplete argument ${args[i]}`);
    options.set(args[i], args[++i]);
  }
  const selectedSplit = options.get('--split') ?? 'all';
  if (!['training', 'holdout', 'all'].includes(selectedSplit))
    throw new Error('--split must be training, holdout or all');
  const datasetText = await readFile(
    path.resolve(repoRoot, options.get('--dataset') ?? 'evaluation/scenarios.json'),
    'utf8',
  );
  const dataset = parseEvaluationDataset(JSON.parse(datasetText));
  const selected = dataset.cases.filter((row) => selectedSplit === 'all' || row.split === selectedSplit);
  if (!selected.length) throw new Error('No cases in the selected split');
  const sourceFiles = new Map<string, string>();
  const read = async <T>(name: string): Promise<T> => {
    let source = sourceFiles.get(name);
    if (source === undefined) {
      source = await readFile(path.join(repoRoot, 'public/data', name), 'utf8');
      sourceFiles.set(name, source);
    }
    return JSON.parse(source) as T;
  };
  const [items, heroes, abilities, config] = await Promise.all([
    read<Item[]>('items.json'),
    read<Hero[]>('heroes.json'),
    read<Ability[]>('abilities.json'),
    read<BrawlConfig>('brawl-config.json'),
  ]);
  await read<unknown>('manifest.json');
  // Include both splits' hero files so --split reports compare against an all-cases baseline unchanged.
  const analytics = new Map<number, BrawlAnalytics>();
  for (const row of dataset.cases) {
    const hero = heroes.find((candidate) => candidate.name === row.hero);
    if (!hero) throw new Error(`Unknown evaluation hero ${row.hero}`);
    if (!analytics.has(hero.id)) analytics.set(hero.id, await read<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`));
  }
  const enginePath = path.resolve(repoRoot, options.get('--engine-module') ?? 'src/brawl/engine.ts');
  const engine = (await import(pathToFileURL(enginePath).href)) as { adviseDraft?: Advisor };
  if (typeof engine.adviseDraft !== 'function') throw new Error('Engine module must export adviseDraft');
  const item = (name: string) => {
    const found = items.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Unknown evaluation item ${name}`);
    return found;
  };
  const results = selected.map((row) => {
    const hero = heroes.find((candidate) => candidate.name === row.hero)!;
    const input: BrawlInput = {
      hero,
      items: row.catalogRestriction ? row.catalogRestriction.map(item) : items,
      abilities,
      config,
      analytics: analytics.get(hero.id)!,
    };
    const state: DraftState = {
      round: row.round,
      choice: row.choice,
      rerollsRemaining: row.rerollsRemaining,
      owned: row.owned.map((name) => item(name).id),
      enemies: row.enemies.map((name) => {
        const enemy = heroes.find((candidate) => candidate.name === name);
        if (!enemy) throw new Error(`Unknown evaluation enemy ${name}`);
        return enemy.id;
      }),
      sets: row.sets.map((set) =>
        set.map((card) => ({ itemId: item(card.item).id, enhanced: card.enhanced, rare: card.rare })),
      ),
    };
    return evaluateCase(row, input, state, engine.adviseDraft!);
  });
  const report: EvaluationReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    datasetHash: sha256(datasetText),
    snapshotHash: sha256(
      [...sourceFiles]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, text]) => `${name}\0${text}`)
        .join('\0'),
    ),
    engineLabel: options.get('--engine-label') ?? path.relative(repoRoot, enginePath),
    cases: results,
    summaries: {
      training: summarize(results.filter((row) => row.split === 'training')),
      holdout: summarize(results.filter((row) => row.split === 'holdout')),
    },
    limitations: [
      'Structural audit checks are not human expert labels and do not measure game wins.',
      'Unreviewed cases are excluded from expert agreement; absent expert labels produce null, never zero or fabricated accuracy.',
      'Holdout audit cases were specified as a fixed regression group; they are not an independent player study and must not be used for weight fitting.',
      'Empirical drop probabilities and causal item effects are not established by this evaluation.',
      'Synthetic regression cases have no match IDs or observation times; temporal generalization is not measured. Real observed cases require strictly earlier analytics time and match cutoffs.',
    ],
    leakage: {
      splitSeparation: 'passed',
      cases: selected.map((row) => {
        const hero = heroes.find((candidate) => candidate.name === row.hero)!;
        return checkObservationLeakage(row, analytics.get(hero.id)!);
      }),
    },
    evidenceWindows: [...analytics].map(([heroId, data]) => ({
      heroId,
      patchId: data.stats_window?.patch_id ?? null,
      minUnixTimestamp: data.stats_window?.min_unix_timestamp ?? null,
      maxUnixTimestamp: data.stats_window?.max_unix_timestamp ?? null,
      maxMatchId: data.stats_window?.max_match_id ?? null,
    })),
  };
  const baselinePath = options.get('--baseline-report');
  if (baselinePath)
    report.comparison = compareReports(
      report,
      JSON.parse(await readFile(path.resolve(repoRoot, baselinePath), 'utf8')) as EvaluationReport,
    );
  const output = path.resolve(repoRoot, options.get('--output') ?? 'logs/evaluation-current.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const structuralFailures = results.flatMap((row) => row.checks).filter((check) => check.status === 'failed').length;
  const unreviewed = results.filter((row) => row.expertReviewStatus !== 'reviewed').length;
  const leakageFailures = report.leakage!.cases.filter(
    (row) => row.status === 'failed' || (requireNoLeakage && row.status === 'unverified'),
  ).length;
  return {
    report,
    output,
    exitCode: structuralFailures || leakageFailures || (requireExpert && unreviewed) ? 1 : 0,
    requireExpert,
    unreviewed,
    leakageFailures,
    requireNoLeakage,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runEvaluation(process.argv.slice(2));
    console.log(
      JSON.stringify(
        {
          output: result.output,
          summaries: result.report.summaries,
          comparison: result.report.comparison,
          expertReviewRequired: result.requireExpert,
          missingExpertReviews: result.unreviewed,
          leakageFailures: result.leakageFailures,
          independentObservationRequired: result.requireNoLeakage,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
