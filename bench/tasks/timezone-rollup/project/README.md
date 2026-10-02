# daily-rollup

Buckets timestamped events into daily totals for reporting. Every event carries an ISO-8601 instant (`at`, always with an explicit offset or `Z`) and an `amount`; `rollup(events, fromKey, toKey)` returns one bucket per calendar day in the inclusive range, in order, each with a `count` and a `total`, including zero rows for days with no events. Days are **UTC calendar days** everywhere in this module, keyed as `YYYY-MM-DD`, regardless of the timezone the process happens to run in. `src/keys.js` maps instants to day keys and `src/range.js` enumerates the days between two keys.
