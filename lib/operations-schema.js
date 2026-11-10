'use strict';
const statements = [
  `CREATE TABLE IF NOT EXISTS score_judges (reg_id text NOT NULL REFERENCES registrations(id) ON DELETE CASCADE, workout_id text NOT NULL, judge_id text NOT NULL DEFAULT '', judge_name text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(reg_id,workout_id))`,
  `CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), actor_id text, actor_email text NOT NULL, actor_name text NOT NULL DEFAULT '', action text NOT NULL, entity text NOT NULL, entity_id text, details jsonb NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at DESC,id DESC)`,
  `CREATE OR REPLACE FUNCTION record_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE before_row jsonb; after_row jsonb; before_safe jsonb; after_safe jsonb;
  BEGIN
    IF current_setting('app.restoring',true)='true' THEN RETURN COALESCE(NEW,OLD); END IF;
    IF TG_OP<>'INSERT' THEN before_row=to_jsonb(OLD); END IF;
    IF TG_OP<>'DELETE' THEN after_row=to_jsonb(NEW); END IF;
    IF before_row IS NOT DISTINCT FROM after_row THEN RETURN COALESCE(NEW,OLD); END IF;
    before_safe=before_row-'avatar'; after_safe=after_row-'avatar';
    IF TG_TABLE_NAME='content' THEN
      before_safe=jsonb_build_object('events',(SELECT jsonb_agg(jsonb_build_object('id',e->'id','name',e->'name','status',e->'status')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(before_row->'data'->'EVENTS')='array' THEN before_row->'data'->'EVENTS' ELSE '[]'::jsonb END) e));
      after_safe=jsonb_build_object('events',(SELECT jsonb_agg(jsonb_build_object('id',e->'id','name',e->'name','status',e->'status')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(after_row->'data'->'EVENTS')='array' THEN after_row->'data'->'EVENTS' ELSE '[]'::jsonb END) e),'changed_sections',(SELECT jsonb_agg(key) FROM jsonb_object_keys(coalesce(after_row->'data','{}')||coalesce(before_row->'data','{}')) key WHERE before_row->'data'->key IS DISTINCT FROM after_row->'data'->key));
    END IF;
    INSERT INTO audit_log(actor_id,actor_email,actor_name,action,entity,entity_id,details)
      VALUES(nullif(current_setting('app.actor_id',true),''),coalesce(nullif(current_setting('app.actor_email',true),''),'Система / база данных'),coalesce(current_setting('app.actor_name',true),''),TG_OP,TG_TABLE_NAME,coalesce(after_row->>'id',before_row->>'id',after_row->>'reg_id',before_row->>'reg_id',after_row->>'email',before_row->>'email'),jsonb_build_object('before',before_safe,'after',after_safe,'route',current_setting('app.action',true)));
    RETURN COALESCE(NEW,OLD);
  END $$`,
];
for (const table of ['content','users','staff','kids','kid_guardians','registrations','scores','score_judges','crew','crew_rates','teams','leads']) {
  statements.push(`DROP TRIGGER IF EXISTS audit_changes ON ${table}`);
  statements.push(`CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION record_audit_change()`);
}
module.exports = { statements };
