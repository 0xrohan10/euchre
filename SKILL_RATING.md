# Player skill rating

The skill rating starts at 1,000 and updates after a completed match. The app keeps separate ratings for competitive games with four human-controlled seats and games involving bots. Ratings are provisional for the first 10 matches.

## Formula

Each completed hand records the caller, caller's partner, defenders, tricks, points, and expected tricks. Expected tricks come from a transparent card-strength table that accounts for trump, both bowers, and off-suit card rank.

For match rating, each team's average rating supplies the normal Elo expectation. Deal advantage is the average difference between the teams' best available trump strength, independent of the suit that was actually called. It shifts the Elo gap by up to 200 rating points:

```text
expected win = 1 / (1 + 10 ^ (-(team rating gap + 200 * deal advantage) / 400))
```

This makes the adjustment asymmetric in the intended direction:

- Winning with weaker deals gains more rating.
- Losing with weaker deals loses less rating.
- Winning with stronger deals gains less rating.
- Losing with stronger deals loses more rating.

The final update also includes hand performance. It compares actual team tricks with expected team tricks. Individual trick ownership remains an audit statistic but does not affect rating, because taking a trick from your partner is not evidence of better cooperative play. A player sitting out during a loner receives no hand-performance credit.

```text
rating change = round(K * (result - expected win) + 16 * average trick residual)
K = 40 for the first 10 matches, then 24
```

## Audit statistics

Each rating record also retains:

- wins and losses
- hands played
- calls and successful calls
- partner calls and successful partner calls
- defended hands and successful euchres
- actual and expected individual tricks

These counters let the rating be explained and allow role-specific comparisons without making any one noisy statistic the rating itself.

Only humans present before a bot has acted for their seat are enrolled in a match rating. If a bot later replaces an enrolled player, that player's team forfeits the rated result and hand-performance evidence is discarded. Competitive matches therefore stay in the competitive pool instead of allowing a late disconnect to redirect a likely loss.

Rating application has its own durable, one-per-history claim. This permits a newer application version to rate a match whose history was written by an older version without applying any match twice.

## Known limits

The current formula estimates card strength rather than replaying each decision. A future model can use the same hand evidence to improve these areas:

- pass and trump-selection quality compared with available alternatives
- dealer discard quality
- loner decision quality, not just loner outcomes
- play value based on the information available when each card was played
- separate calibration for rule variants and bot difficulty
- explicit participation tracking when a bot temporarily takes over a human seat

Those improvements should be calibrated against a large set of completed hands before changing public ratings.
