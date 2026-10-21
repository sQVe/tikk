import type { Database } from 'bun:sqlite';

// One second, in days. Fact times may differ from what JavaScript parses by rounding, so every
// comparison leans toward "maybe".
const daySeconds = 86_400;
const slackDays = 1 / daySeconds;
const archiveDelayDays = 14;

// A finished root has its finish time, or NULL when no fact dates its status. A done task finishes
// at its newest accept fact, and any other root at its newest status fact for its current status.
const finishedRootsSql = `finished(id, final, finish) AS (
  SELECT t.id, t.status IN ('canceled', 'closed'),
    CASE WHEN t.status IN ('canceled', 'closed')
      THEN (SELECT max(julianday(f.at)) FROM facts f
        WHERE f.ticket = t.id AND f.kind = 'status' AND json_valid(f.json)
          AND json_extract(f.json, '$.status') = t.status)
      ELSE (SELECT max(julianday(f.at)) FROM facts f WHERE f.ticket = t.id AND f.kind = 'accept')
    END
  FROM tickets t
  WHERE t.title IS NOT NULL AND t.error IS NULL
    AND (t.kind = 'plan' OR t.parent IS NULL)
    AND (t.status IN ('canceled', 'closed') OR (t.kind = 'task' AND t.status = 'open'))
)`;

// Every ticket under a due root, with the root's finish. UNION ends a parent cycle.
const dueTreesSql = `tree(id, finish) AS (
  SELECT id, finish FROM finished WHERE finish <= julianday(?1) - ${archiveDelayDays} + ${slackDays}
  UNION
  SELECT child.id, tree.finish FROM tickets child JOIN tree ON child.parent = tree.id
  WHERE child.title IS NOT NULL AND child.error IS NULL
)`;

const archiveWorkSql = `WITH ${finishedRootsSql}, ${dueTreesSql}
  SELECT 1 FROM finished WHERE final AND finish IS NULL
  UNION ALL
  SELECT 1 FROM tree JOIN tickets t ON t.id = tree.id AND t.title IS NOT NULL AND t.error IS NULL
  WHERE t.archived IS NULL AND NOT EXISTS (
    SELECT 1 FROM facts f WHERE f.ticket = tree.id AND f.kind = 'unarchive'
      AND julianday(f.at) > tree.finish + ${slackDays})
  LIMIT 1`;

// False only when no root is due and every finished root has a fact that dates its finish. True
// means the sweep must load the tickets and facts to decide.
export const mayHaveArchiveWork = (database: Database, now: Date): boolean =>
  database.query(archiveWorkSql).get(now.toISOString()) !== null;
