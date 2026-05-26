# tabulator

A tiny **spreadsheet for your [Solid](https://solidproject.org) pod** — in the
spirit of [TimBL's Tabulator](https://www.w3.org/2005/ajar/tab): simple sums and
arithmetic, plus the trick that makes it Solid-native — **a cell can dereference
a URI to pull a live value from the data web.**

```
=SUM(B2:B9)      =AVG(A1:A5)      =A1*1.2 + B1      =MIN(..) =MAX(..) =COUNT(..)
=GET("https://alice.example/profile/card#me", "vcard:fn")
=GET("https://my.pod/private/budget/log.jsonld#this", "schema:name")
```

`=GET(subjectURI, predicate)` fetches the resource, finds the subject by its
fragment, and returns the object of that predicate. The predicate is tolerant:
`schema:price`, a full URI, or a bare local name all work. A bare `https://…`
typed into a cell renders as a clickable link — follow your nose across the data
web, Tabulator-style. So a sheet becomes a **live dashboard over your pod**: total
your `budget` rows, pull a `health` metric, read a contact's details — and it
recomputes when the source changes.

## Formula engine

A small recursive-descent evaluator (no `eval`), cycle-guarded (`#CYCLE`):

- arithmetic `+ - * / ( )`, unary minus
- cell refs `A1`, ranges `A1:A5`
- functions `SUM AVG MIN MAX COUNT` (ranges/args; non-numbers ignored)
- `GET("uri","predicate")` — resolved asynchronously and cached; cells show `…`
  until the value arrives, then recompute. Errors surface as `#REF` `#VAL`
  `#NAME` `#CYCLE` `#404` `#PRED`.

## Data model — every cell is an addressable URI

One JSON-LD doc per sheet, registered in your TypeIndex as
`urn:solid:Spreadsheet` so `hub`/`pilot` can discover it. **Each non-empty cell
is its own fragment subject** (`#A1`, `#B5`, …) — closer to TimBL's Tabulator,
where things and values are dereferenceable. A cell carries:

- `rdf:value` — the **materialised value** other sheets/apps dereference;
- `tab:src` — the **raw input** (literal or formula) the app reloads for editing.

```
/public/sheet/<slug>.jsonld
{ "@context": {"schema":"https://schema.org/","urn":"urn:solid:",
               "rdf":"http://www.w3.org/1999/02/22-rdf-syntax-ns#","tab":"urn:solid:tabulator#"},
  "@graph": [
    { "@id":"#this", "@type":"urn:Spreadsheet", "schema:name":"…", "cols":26, "rows":100 },
    { "@id":"#A1", "rdf:value":"Item",          "tab:src":"Item" },
    { "@id":"#B5", "rdf:value":420,             "tab:src":"=SUM(B2:B4)" }
  ] }
```

### Reference one sheet from another
Because each cell is a URI, a cell in *this* sheet can pull a cell from *another*:

```
=GET("https://my.pod/public/sheet/budget.jsonld#B5")          ← defaults to that cell's rdf:value
=GET("https://my.pod/public/sheet/budget.jsonld#B5","rdf:value")
```

So sheets compose into a web of live figures (and any app can read a cell, or
write `rdf:value` for tabulator to display). **Freshness caveat (v1):** the
referenced `rdf:value` is the *last-saved* materialisation of that cell — it
refreshes when the source sheet is re-opened/saved, not instantly across sheets.
Live cross-sheet recalculation is a follow-up.

## Use

Click a cell to select; edit in the formula bar (Enter commits + moves down,
Esc cancels). Arrow keys move; start typing to edit; Delete clears. Sheets save
to your pod automatically.

## Notes / follow-ups

- Sign-in required (sheets live on your pod).
- `=GET` works for your pod and CORS-friendly Solid data; arbitrary web resources
  may be CORS-blocked — a proxy fallback (like `news`) is a planned follow-up.
- Fixed 26×100 grid for v1; `&` text-concat, more functions, and CSV import/export
  are natural next steps.

## Run

Static — open `index.html`, or install via the **store** to
`/public/apps/tabulator/`.

AGPL-3.0-only.
