-- ZEDGE indexer (README.md). Public chain data only: the endpoint's events of this application as they stand on Horizen,
-- and Chainlink BTC/USD as verified on Solana. Nothing here was decrypted; the indexer holds no key. Hashes, addresses and
-- event data are bytea; block numbers are bigint. Applied at every start by the writer; every statement is idempotent.

CREATE TABLE IF NOT EXISTS cursors (
  name  text PRIMARY KEY,         -- 'horizen' | 'solana'
  block bigint NOT NULL,          -- horizen: the last block indexed, inclusive (solana: 0)
  hash  bytea,                    -- horizen: that block's hash, compared with the chain before the next range (reorg check)
  time  bigint,                   -- horizen: that block's timestamp; solana: the block time of `sig`
  sig   text                      -- solana: the newest program transaction read
);

-- RequestSubmitted: users, the house, keeper reports and trigger ticks.
CREATE TABLE IF NOT EXISTS requests (
  request_id bytea  PRIMARY KEY,
  sender     bytea  NOT NULL,
  block      bigint NOT NULL,
  log_index  int    NOT NULL,
  tx         bytea  NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_sender ON requests (sender, block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS requests_block ON requests (block);

-- RequestCompleted (status, and the public error string of a refused request).
CREATE TABLE IF NOT EXISTS completions (
  request_id    bytea    PRIMARY KEY,
  block         bigint   NOT NULL,
  log_index     int      NOT NULL,
  tx            bytea    NOT NULL,
  status        smallint NOT NULL,
  error_code    smallint NOT NULL,
  error_message text     NOT NULL
);
CREATE INDEX IF NOT EXISTS completions_block ON completions (block);

-- UserEvent: the encrypted receipt exactly as on chain, kept forever (owner decision 2026-10-07).
CREATE TABLE IF NOT EXISTS receipts (
  block      bigint NOT NULL,
  log_index  int    NOT NULL,
  request_id bytea  NOT NULL,
  tx         bytea  NOT NULL,
  data       bytea  NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS receipts_request ON receipts (request_id);

-- AppEvent: the guest's public records (tick clock archive settle credit payout confirm; another subtype keeps its hex).
-- round_id: the registry round id of settle and confirm records. Decoded when read, from the stored record bytes.
CREATE TABLE IF NOT EXISTS records (
  block      bigint NOT NULL,
  log_index  int    NOT NULL,
  tx         bytea  NOT NULL,
  request_id bytea  NOT NULL,
  kind       text   NOT NULL,
  round_id   bytea,
  data       bytea  NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS records_round ON records (round_id) WHERE round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS records_kind ON records (kind, block DESC, log_index DESC);

-- Chainlink BTC/USD (Data Streams) as verified on Solana: one row per observed minute, the earliest observation read.
CREATE TABLE IF NOT EXISTS btc_minutes (
  minute      bigint        PRIMARY KEY, -- unix s, a multiple of 60
  price       numeric(78,0) NOT NULL,    -- int192, 18 decimals
  observed_at bigint        NOT NULL,    -- observationsTimestamp
  signature   text          NOT NULL     -- the Solana transaction it was read from
);
