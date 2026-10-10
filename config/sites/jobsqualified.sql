-- Public site key, not a credential. Origin validation remains mandatory.
-- A conflicting registration fails instead of overwriting another site's data.
INSERT INTO sites (site_key, hostname, enabled, mode)
VALUES ('jobsqualified.com', 'jobsqualified.com', 1, 'shadow');
