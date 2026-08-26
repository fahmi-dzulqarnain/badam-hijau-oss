/**
 * The Postgres text-search configuration, named in exactly one place.
 *
 * It has to be the same on both sides or search silently returns nothing useful. The trigger
 * calls `to_tsvector(<this>, …)` to build the lexemes; Task 3's query will call
 * `websearch_to_tsquery(<this>, …)` to build the ones it looks for. Mismatch them and the index
 * is full of stems while the query asks for whole words — `deployments` indexed as `deploy` by
 * `english`, searched for as `deployments` by `simple`, and the page reads as not existing.
 *
 * `english` rather than `simple`, and the trade is real in both directions. Stemming is what
 * makes "publishing" find a page that says "publish", and dropping stopwords is what stops "the"
 * from matching every page in the corpus. The cost is that an identifier is stemmed like a word,
 * so `statuses` and `status` collapse — acceptable, because the alternative loses every
 * inflection in ordinary prose to buy exactness on a minority of tokens.
 *
 * **This constant cannot be interpolated into the migration**, which is SQL and ran before this
 * file was read. So the agreement is asserted instead of assumed: an integration test reads
 * `pg_get_functiondef` for the deployed trigger function and fails if the configuration it names
 * is not this string. That is the only thing standing between a one-word edit here and an index
 * that no query can match.
 */
export const SEARCH_CONFIG = "english";
