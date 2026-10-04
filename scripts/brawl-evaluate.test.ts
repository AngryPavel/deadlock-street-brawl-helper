import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  checkObservationLeakage,
  compareReports,
  evaluateCase,
  hasExpertReview,
  parseEvaluationDataset,
  runEvaluation,
  validateSplitSeparation,
} from './brawl-evaluate';
import type { EvaluationCase, EvaluationDataset } from './brawl-evaluate';
import { heroByName, inputFor, itemByName } from '../src/brawl/__tests__/testData';
import { adviseDraft } from '../src/brawl/engine';

const dataset = (): EvaluationDataset =>
  parseEvaluationDataset(JSON.parse(readFileSync('evaluation/scenarios.json', 'utf8')));
const observed = (): EvaluationCase => ({
  ...dataset().cases[0],
  observation: { source: 'match-observation', unixTimestamp: 300, matchId: 30, patchId: null },
});
const evidence = () => ({
  ...inputFor(heroByName('Infernus').id).analytics,
  stats_window: {
    schema_version: 2 as const,
    role: 'primary' as const,
    patch_id: null,
    min_unix_timestamp: 100,
    max_unix_timestamp: 200,
    max_match_id: 20,
    fetched_at: '2026-01-01',
    catalog_fetched_at: '2026-01-01',
    catalog_compatibility: 'current' as const,
  },
});

describe('offline evaluation provenance and separation', () => {
  it('keeps fixed audit cases explicitly synthetic and unreviewed', () => {
    for (const row of dataset().cases) {
      expect(row.observation).toMatchObject({ source: 'synthetic-regression', unixTimestamp: null, matchId: null });
      expect(hasExpertReview(row)).toBe(false);
      expect(checkObservationLeakage(row, evidence()).status).toBe('not-applicable');
    }
  });

  it('rejects the same state in both splits even if cards are reordered or false flags become absent', () => {
    const fixture = dataset();
    const source = fixture.cases[0];
    fixture.cases.push({
      ...source,
      id: 'duplicate-holdout',
      split: 'holdout',
      sets: source.sets.map((set) => [...set].reverse()),
    });
    expect(() => validateSplitSeparation(fixture)).toThrow('Training/holdout leakage');
  });

  it('rejects two states from one observed match crossing the split', () => {
    const fixture = dataset();
    fixture.cases[0] = observed();
    fixture.cases[4].observation = { ...observed().observation! };
    expect(() => parseEvaluationDataset(fixture)).toThrow('Training/holdout leakage');
  });

  it('rejects fabricated or incomplete synthetic/match observation metadata', () => {
    const fixture = dataset();
    fixture.cases[0].observation!.matchId = 1;
    expect(() => parseEvaluationDataset(fixture)).toThrow('Invalid observation metadata');
    fixture.cases[0] = observed();
    fixture.cases[0].observation!.unixTimestamp = null;
    expect(() => parseEvaluationDataset(fixture)).toThrow('Invalid observation metadata');
  });

  it('requires both observation time and match ID beyond the scoring cutoffs', () => {
    const row = observed();
    const analytics = evidence();
    expect(checkObservationLeakage(row, analytics).status).toBe('passed');
    row.observation!.unixTimestamp = 200;
    expect(checkObservationLeakage(row, analytics).status).toBe('failed');
    row.observation!.unixTimestamp = 300;
    row.observation!.matchId = 20;
    expect(checkObservationLeakage(row, analytics).status).toBe('failed');
    row.observation!.matchId = 30;
    delete (analytics.stats_window as { max_match_id?: number }).max_match_id;
    expect(checkObservationLeakage(row, analytics).status).toBe('unverified');
    delete (analytics as { stats_window?: unknown }).stats_window;
    expect(checkObservationLeakage(row, analytics).status).toBe('unverified');
  });

  it('accepts only external reviewed labels present in the current offer', () => {
    const fixture = inputFor(heroByName('Infernus').id);
    const row = observed();
    row.expertReview = {
      reviewStatus: 'reviewed',
      author: 'Independent reviewer',
      explanation: 'Supplied human review',
      expertAcceptedIds: [itemByName('Extra Health').id],
    };
    const state = {
      round: row.round,
      choice: row.choice,
      rerollsRemaining: row.rerollsRemaining,
      owned: [],
      enemies: [],
      sets: row.sets.map((set) => set.map((card) => ({ itemId: itemByName(card.item).id, enhanced: card.enhanced }))),
    };
    expect(() => evaluateCase(row, fixture, state, adviseDraft)).toThrow('absent from the current offer');
  });

  it('reports null expert agreement, stable snapshot hashes, and fails the expert requirement', async () => {
    const reportPath = 'node_modules/.tmp/scoring-vitest/evaluation-test-report.json';
    const current = await runEvaluation(['--output', reportPath, '--require-expert-reviewed']);
    expect(current.exitCode).toBe(1);
    expect(current.unreviewed).toBe(8);
    expect(current.report.summaries.holdout.expertAgreement).toBeNull();
    const training = await runEvaluation(['--output', reportPath, '--split', 'training']);
    expect(training.report.snapshotHash).toBe(current.report.snapshotHash);
    expect(training.report.datasetHash).toBe(current.report.datasetHash);
    expect(compareReports(training.report, current.report).changedCaseIds).toEqual([]);
    expect(() => compareReports({ ...current.report, snapshotHash: 'wrong' }, current.report)).toThrow(
      'same dataset and data snapshot',
    );
  });
});
