# fast-csv

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/yansenlim724-hub/fast-csv/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/yansenlim724-hub/fast-csv/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in for csv-reader 1.0.0. It reads broken CSV files and answers
exactly as csv-reader does — `{columns, rows, errors}` for every
`{text, header}` input — in about a third of the CPU time.

## Run it

```sh
MAKEFUN_INPUT_DIR=path/to/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## What it does

`solve.js` exports `run(input)`, which reads the text once, left to right,
with commas and double quotes:

- a U+FEFF at the very start is dropped;
- a record ends at LF or CRLF, and a line left with no characters is no record;
- outside a quoted field a CR not followed by LF is dropped (`stray_cr`);
- a field that opens with a quote runs to the next quote that is not doubled
  (`""` inside it is one quote, each CRLF or lone CR inside it reads as LF);
  what follows its closing quote, up to the next comma or line break, is
  appended as it stands (`quote_junk`); a quote that never closes is a
  literal character and the text after it is read again as unquoted
  (`unterminated_quote`);
- a quote inside an unquoted field is a literal character; fields stay
  strings, never trimmed or converted;
- `columns` is the first record when `header` is true, else null; `rows`
  holds the records after it, each padded with `""` (`short_row`) or cut
  (`long_row`) to the first record's width;
- each error is `{code, line, row}` in the order met.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`. Node 22, standard library only, no dependencies.

## How it is fast

The reference reader walks the text one character at a time and builds
every field one character at a time. This reader never does that on the
common case:

- **Whole-record fast path.** Most records hold no quote and no stray CR,
  so a whole record is cut out with `indexOf` and split on commas in one
  go — no per-field loop at all.
- **Jumping field scan.** A record that does hold a quote or a stray CR is
  read field by field, but each field still jumps from one delimiter to the
  next with `indexOf` and `slice` instead of walking characters. Only the
  rare broken field itself — a stray CR, a doubled quote, a line break
  inside quotes — is walked character by character.
- **Bounded checks.** Every search for a CR or a line break runs on the
  field's (or the line's) own slice, never on the rest of the text, so a
  file with almost no CRs costs nothing extra. The next LF is cached per
  record and stays valid across comma-ended fields.
- **Almost no garbage.** Field readers report through shared locals
  instead of a fresh object per field, so the scan allocates almost
  nothing beyond the answer itself.

## Check it

```sh
# practice set, from the kit's directory
MAKEFUN_INPUT_DIR=path/to/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

On the kit's practice set (6 cases, 10.2 MB of CSV), measured locally
with Node 24 under `--no-incremental-marking`, median of 12 interleaved
runs of `run()` alone:

| reader | CPU per set |
| --- | --- |
| csv-reader 1.0.0 | ~700 ms |
| fast-csv (`solve.js`) | ~210 ms |

The official scorer passes all 6 practice cases (`passed: 1,
cases_passed: 6/6`), and the output is byte-identical to the reference's.
Correctness was also checked against the reference on ~90,000 generated
inputs — random broken-CSV soup plus cases drawn with the kit's own
generator — with zero differences.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wz6mbrsd&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · Read broken CSV files faster, 21 November 2026</sub>
