-- IPinfo observe-only evidence. Cloudflare edge values remain independent.
-- Existing generic network columns are retained for backward compatibility.

ALTER TABLE network_evidence ADD COLUMN cf_asn INTEGER;
ALTER TABLE network_evidence ADD COLUMN cf_country TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_lookup_status TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_cache_status TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_vpn INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_proxy INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_tor INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_hosting INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_relay INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_residential_proxy INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_privacy INTEGER;
ALTER TABLE network_evidence ADD COLUMN ipinfo_service TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_asn TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_as_name TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_as_type TEXT;
ALTER TABLE network_evidence ADD COLUMN ipinfo_country TEXT;

UPDATE network_evidence
   SET cf_asn = asn,
       cf_country = country
 WHERE cf_asn IS NULL
   AND cf_country IS NULL;

CREATE INDEX IF NOT EXISTS idx_network_evidence_ipinfo_asn_observed
  ON network_evidence(ipinfo_asn, observed_at);
