CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  message TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_form_submissions_ip_created
  ON form_submissions (ip_hash, created_at);

CREATE INDEX idx_form_submissions_created
  ON form_submissions (created_at);

CREATE TABLE mail_log (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  template TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES form_submissions (id)
);

CREATE INDEX idx_mail_log_submission
  ON mail_log (submission_id);
