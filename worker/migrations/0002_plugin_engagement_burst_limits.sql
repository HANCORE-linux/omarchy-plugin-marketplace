ALTER TABLE plugin_engagement_daily
  ADD COLUMN views_minute TEXT CHECK (
    views_minute IS NULL OR (
      length(views_minute) = 16
      AND views_minute GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN views_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (views_minute_count >= 0);

ALTER TABLE plugin_engagement_daily
  ADD COLUMN copies_minute TEXT CHECK (
    copies_minute IS NULL OR (
      length(copies_minute) = 16
      AND copies_minute GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN copies_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (copies_minute_count >= 0);

ALTER TABLE plugin_engagement_daily
  ADD COLUMN hearts_minute TEXT CHECK (
    hearts_minute IS NULL OR (
      length(hearts_minute) = 16
      AND hearts_minute GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN hearts_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (hearts_minute_count >= 0);
