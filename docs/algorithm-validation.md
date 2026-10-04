# Draft scoring assumptions and offline validation

The draft score is a heuristic comparison of free items. It is not a win probability, a causal estimate of buying an item, or proof of the best possible game decision. The original `BRAWL_WEIGHTS` and stat unit values have not been fitted or retuned during this audit.

## Evidence used by the score

- The hero baseline is `hero_stats.wins / hero_stats.matches`, an exact hero-game denominator. A match can contain many items, so item rows are never summed to manufacture hero games. Older snapshots without this denominator use an explicitly disclosed neutral 50% prior.
- Current item evidence is smoothed with `K = max(200, 0.05 × most-used item matches in its tier)`. Popularity remains usage relative to the most-used item in the same tier, not the fraction of drafts containing the item or its drop probability. The statistical term is `10 × relative usage × (smoothed rate − baseline)`; its explanation calls this a weighted score rather than presenting it as a percentage-point improvement.
- Historical item evidence is optional. It requires an earlier, nonoverlapping historical window. Its strength is at most 50 pseudo-observations and at most half the current row's observations, so current evidence always has greater weight. Missing current evidence cannot be replaced by an apparent large historical sample. Historical item IDs do not verify historical item properties; only the bounded outcome prior is used.
- With validated flow provenance, the selected purchase round's rows replace the item row in the outcome term. These rows count purchases and attach the outcome of the entire match. They are not round victories, a survival probability, or a causal item effect. If an item has no all-round row, relative usage can fall back to the maximum available purchase count for that tier and round. If round data is absent, the existing item evidence remains available. All-match historical rows are not applied as priors to purchase-round rows because their populations differ.
- `RankedOffer.winRate` reports the raw rate of the selected evidence row, including the purchase-round row when used. It is descriptive; the score also uses shrinkage and relative usage. Missing and invalid counts produce no statistical evidence, rather than fabricated zero losses or zero wins.
- Enemy-conditioned rows are descriptive associations. There is no exact enemy-conditioned hero-game denominator in this contract, so they are compared around the same hero baseline without summing overlapping item rows. Enemy selection and opposing builds remain confounders.

Pair interaction is the residual above the two individual smoothed associations, not the pair's raw win rate above the hero baseline. The expected pair rate is clipped to `[0, 1]` from `rate(A) + rate(B) − baseline`. The observed pair is smoothed toward that expected rate; the residual approaches zero when its sample is small. The smoothing strength uses the existing 200-observation floor and 5% fraction of the largest current item sample. Missing either individual row or the pair row means unknown interaction. It does not establish neutral or negative synergy. Aggregate pair rows still cannot identify a causal interaction.

## Property semantics and build context

`src/local/itemSemantics.ts` owns the unchanged stat unit table and the explicit property semantics. Ordinary bonuses retain their signs: Trophy Collector's `NonPlayerBonusWeaponPower = -15` is a penalty. The signed enemy deltas `BulletArmorReduction`, `MagicResistReduction`, and `TechPowerReduction` invert their sign when valuing benefits to the player; the current catalog represents these reductions as negative numbers. Unsupported properties are unpriced, rather than automatically treated as beneficial via an absolute value.

Tooltip sections identify innate and conditional properties. Positive conditional values with unknown activation or proc uptime are excluded from permanent stat value and identified in explanations. Penalties retain their sign. This conservative rule does not model proc damage, activation accuracy, target count, or uptime. An item with no priced properties receives neutral tier-median kit value; a priced net penalty remains negative.

The hero kit profile continues to describe damage and ability needs. Owned percentage resistance, cooldown, lifesteal, and status resistance benefits reduce the marginal value of another such benefit by `1 / (1 + held amount / offered amount)`. Linear health and damage keep the existing kit scaling. This is a diminishing-returns heuristic, not a verified game stacking formula. Shared healing reduction, silence, disarm, slow, and resistance/power reduction properties also reduce repeated counter value by `1 / (1 + matching held effects)`. Missing effect metadata supplies no counter tag. These adjustments and the existing exact-item duplicate penalty are separate score terms and are disclosed in explanations.

The API does not provide verified enhanced properties. The inherited fallback assumes a stat multiplier of 1.25 and score bonus of 0.6, and explanations explicitly identify that assumption. `BrawlInput.enhancedScoring` can override the global multiplier/bonus or an item's values. An item override can supply its full enhanced property map; this skips the generic multiplier and prices those properties directly. An override is not marked verified merely because it is supplied. Conditional enhanced effects still have unknown uptime. No enhanced numbers were invented during the audit.

## Reroll model limits

`src/local/rerollModel.ts` uses the same full offer scorer for the visible choice and prospective draws, including owned, enemy, enhanced, and duplicate terms. The finite token horizon includes the value of remaining choices; a confirmed zero or unread live counter cannot authorize a reroll. Whole-card permutations keep their modifiers. The final choice has no value reserved for later choices. The finite-horizon result is exact for its supplied score distribution and fixed context, not an optimal game policy.

The default distribution is explicitly uncalibrated uniform sampling within eligible tier pools. It does not infer actual drop chances from purchases. Current slot flags persist in the model; unseen future choices use zero rare/enhanced probability in the default fallback. These zeros define an unverified scenario, not measured frequencies or a claim that future bonuses cannot occur. An injected distribution can replace those assumptions. Future scoring holds the current owned/enemy context fixed; it does not jointly update the inventory after every hypothetical future pick or model changing opponents. Distribution status and assumptions are part of the advice contract.

## Screen state limits

Confirmed choice/round advances and counter decrements authorize fresh offer reads. The previous advice is hidden while the complete three-card tuple and independently sampled icon cores settle across fresh frames. Cached reads retain the immutable fingerprints of their recognition source; comparing only adjacent pictures would let gradual animation drift retain unrelated item IDs. Initial reads also settle before publication. New offers require qualifying cream-colored ink in each current item-name band, so an empty slot cannot be accepted solely because its background resembles an icon. This is an absence filter, not proof of a correctly read name; it does not invalidate a settled offer under a tooltip. These timing checks are conservative heuristics; elapsed time alone cannot turn missing cards into a valid offer.

A sustained contradiction from three strong direct icon matches can correct a provisional lock without recording a reroll or clearing the confirmed counter. For weak enhanced icons, exact independent OCR agreement with all three raw item IDs can corroborate the correction. This agreement must belong to the same candidate and copied name crops; it does not replace IDs before comparison. Partial tooltip reads cannot trigger that exception. Initial and authorized transitions preserve the upstream recognizer's `present` contract, including valid low-score matches; ordinary missing-card OCR remains separate from this strict confirmation. Late corrections require stronger evidence and are not guaranteed for every obscured or low-score card.

Recognition corrections do not add new drop observations. A provisional observation already flushed to the bounded local journal is not rewritten retrospectively. Experimental empirical distributions therefore still need reviewed measurements; the default scorer does not consume that journal.

## Reproducible evaluation

`evaluation/scenarios.json` contains eight fixed audit regression scenarios: four development cases and four held-aside structural cases. Their `observation` metadata explicitly says `synthetic-regression`, with null match IDs and observation timestamps. They are not independently observed matches and have no human expert labels. The split is useful for regression discipline; it does not establish temporal generalization or independent expert agreement. No weights were fitted to these cases.

The CLI records dataset and data snapshot SHA-256 hashes, including both splits' hero analytics files even for a selected-split run. Baseline comparisons require matching hashes. Cross-split copies of the same state, including reordered cards, and observations sharing a match ID are rejected. For real `match-observation` cases, both timestamp and match ID are required. The evaluator checks that each is strictly after the recorded analytics cutoffs. Missing analytics bounds make leakage unverified, not passed. This excludes outcome overlap under the supplied bounds but cannot prove that analysts never inspected a held-aside label. Snapshot window metadata is recorded separately; absent patch IDs and match cutoffs remain null.

```powershell
npx tsx scripts/brawl-evaluate.ts --output logs/evaluation-current.json
npx tsx scripts/brawl-evaluate.ts --split holdout --output logs/evaluation-holdout.json
npx tsx scripts/brawl-evaluate.ts --baseline-report logs/evaluation-baseline.json
npx tsx scripts/brawl-evaluate.ts --require-expert-reviewed
npx tsx scripts/brawl-evaluate.ts --require-no-leakage
```

An independently supplied expert review needs status `reviewed`, a named author, an explanation, and accepted IDs from the actual current offer. Unreviewed rows are excluded from agreement, which remains null when none are reviewed. `--require-expert-reviewed` intentionally fails the current eight unreviewed cases. `--require-no-leakage` rejects unverified real observations; synthetic scenarios remain explicitly not applicable and do not become validated match predictions.

For the audited snapshot, baseline and current reports use dataset hash `d66afd429e2b0e8c3161ef4ef52e6a52754af31ce184f6e401b3630d55ae261e` and snapshot hash `c59a679ab068455c21687b75690f7738770a710f83bca6fbed369aef73c45b9c`.

| Structural checks                            |  Baseline |   Current |
| -------------------------------------------- | --------: | --------: |
| Development passed / failed / not applicable | 3 / 5 / 0 | 8 / 0 / 0 |
| Held-aside passed / failed / not applicable  | 4 / 2 / 4 | 7 / 0 / 3 |
| Expert-reviewed cases                        |         0 |         0 |
| Expert agreement                             |      null |      null |

These results show that the tested token, permutation, singleton-pool, and score-consistency defects were corrected. They do not establish better game win rate or expert ranking quality. One previously not-applicable score-consistency check became applicable. Tests separately exercise exact hero baselines, historical caps and overlap, purchase-round outcome semantics, pair shrinkage and missing evidence, signed properties, conditional effects, diminishing benefits, enhanced overrides, split duplication, and temporal/match leakage guards. The complete suite passed 219 tests in 39 files at the time of this report.

User-facing wiki material can use this document as its reviewable source. No remote wiki was changed in this local contribution.
