CREATE TABLE plugin_engagement_daily (
  plugin_id TEXT NOT NULL CHECK (
    length(plugin_id) BETWEEN 1 AND 128
    AND plugin_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  day TEXT NOT NULL CHECK (
    length(day) = 10
    AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  copies INTEGER NOT NULL DEFAULT 0 CHECK (copies >= 0),
  hearts INTEGER NOT NULL DEFAULT 0 CHECK (hearts >= 0),
  PRIMARY KEY (plugin_id, day)
) WITHOUT ROWID;
