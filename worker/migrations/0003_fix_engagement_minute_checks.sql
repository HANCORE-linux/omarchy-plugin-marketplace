ALTER TABLE plugin_engagement_daily DROP COLUMN views_minute;
ALTER TABLE plugin_engagement_daily DROP COLUMN views_minute_count;
ALTER TABLE plugin_engagement_daily DROP COLUMN copies_minute;
ALTER TABLE plugin_engagement_daily DROP COLUMN copies_minute_count;
ALTER TABLE plugin_engagement_daily DROP COLUMN hearts_minute;
ALTER TABLE plugin_engagement_daily DROP COLUMN hearts_minute_count;

ALTER TABLE plugin_engagement_daily
  ADD COLUMN views_minute TEXT CHECK (
    views_minute IS NULL OR (
      length(views_minute) = 16
      AND substr(views_minute, 5, 1) = '-'
      AND substr(views_minute, 8, 1) = '-'
      AND substr(views_minute, 11, 1) = 'T'
      AND substr(views_minute, 14, 1) = ':'
      AND substr(views_minute, 1, 4) NOT GLOB '*[^0-9]*'
      AND substr(views_minute, 6, 2) NOT GLOB '*[^0-9]*'
      AND substr(views_minute, 9, 2) NOT GLOB '*[^0-9]*'
      AND substr(views_minute, 12, 2) NOT GLOB '*[^0-9]*'
      AND substr(views_minute, 15, 2) NOT GLOB '*[^0-9]*'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN views_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (views_minute_count >= 0);

ALTER TABLE plugin_engagement_daily
  ADD COLUMN copies_minute TEXT CHECK (
    copies_minute IS NULL OR (
      length(copies_minute) = 16
      AND substr(copies_minute, 5, 1) = '-'
      AND substr(copies_minute, 8, 1) = '-'
      AND substr(copies_minute, 11, 1) = 'T'
      AND substr(copies_minute, 14, 1) = ':'
      AND substr(copies_minute, 1, 4) NOT GLOB '*[^0-9]*'
      AND substr(copies_minute, 6, 2) NOT GLOB '*[^0-9]*'
      AND substr(copies_minute, 9, 2) NOT GLOB '*[^0-9]*'
      AND substr(copies_minute, 12, 2) NOT GLOB '*[^0-9]*'
      AND substr(copies_minute, 15, 2) NOT GLOB '*[^0-9]*'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN copies_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (copies_minute_count >= 0);

ALTER TABLE plugin_engagement_daily
  ADD COLUMN hearts_minute TEXT CHECK (
    hearts_minute IS NULL OR (
      length(hearts_minute) = 16
      AND substr(hearts_minute, 5, 1) = '-'
      AND substr(hearts_minute, 8, 1) = '-'
      AND substr(hearts_minute, 11, 1) = 'T'
      AND substr(hearts_minute, 14, 1) = ':'
      AND substr(hearts_minute, 1, 4) NOT GLOB '*[^0-9]*'
      AND substr(hearts_minute, 6, 2) NOT GLOB '*[^0-9]*'
      AND substr(hearts_minute, 9, 2) NOT GLOB '*[^0-9]*'
      AND substr(hearts_minute, 12, 2) NOT GLOB '*[^0-9]*'
      AND substr(hearts_minute, 15, 2) NOT GLOB '*[^0-9]*'
    )
  );

ALTER TABLE plugin_engagement_daily
  ADD COLUMN hearts_minute_count INTEGER NOT NULL DEFAULT 0 CHECK (hearts_minute_count >= 0);
