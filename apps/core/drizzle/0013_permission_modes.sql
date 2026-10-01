-- Thread permissions become the agent's own mode names instead of Valet's auto/ask.
UPDATE "threads" SET "permissions" = CASE
  WHEN "agent" = 'codex' AND "permissions" = 'auto' THEN 'never'
  WHEN "agent" = 'codex' AND "permissions" = 'ask' THEN 'on-request'
  WHEN "permissions" = 'auto' THEN 'bypassPermissions'
  WHEN "permissions" = 'ask' THEN 'acceptEdits'
  ELSE "permissions"
END
WHERE "permissions" IN ('auto', 'ask');
--> statement-breakpoint
-- The settings default becomes one mode per agent.
UPDATE "settings" SET "data" = "data" || jsonb_build_object(
  'defaultPermissions',
  CASE WHEN "data"->>'defaultPermissions' = 'ask'
    THEN '{"claude":"acceptEdits","codex":"on-request"}'::jsonb
    ELSE '{"claude":"bypassPermissions","codex":"never"}'::jsonb
  END
)
WHERE jsonb_typeof("data"->'defaultPermissions') = 'string';
