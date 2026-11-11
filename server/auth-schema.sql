CREATE TABLE IF NOT EXISTS auth_login_challenges (
  challenge_id TEXT PRIMARY KEY REFERENCES challenges(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  browser_nonce_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_expiry_idx ON auth_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES wallet_links(identity_id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_session_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry_idx ON auth_rate_limits(expires_at);
