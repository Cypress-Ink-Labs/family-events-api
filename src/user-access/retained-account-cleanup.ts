import type { PoolClient } from "pg"

function quoteSqlIdentifier(identifier: string) {
  return '"' + identifier.replaceAll('"', '""') + '"'
}

export async function cleanRetainedAccount(client: PoolClient, userId: string): Promise<void> {
  const owned = await client.query<{
    schema: string
    table_name: string
    column_name: string
  }>(
    `SELECT DISTINCT ns.nspname AS schema,child.relname AS table_name,column_name.attname AS column_name
   FROM pg_constraint fk
   JOIN pg_class child ON child.oid=fk.conrelid
   JOIN pg_namespace ns ON ns.oid=child.relnamespace
   JOIN pg_attribute column_name ON column_name.attrelid=fk.conrelid AND column_name.attnum=fk.conkey[1]
   JOIN pg_attribute parent_column ON parent_column.attrelid=fk.confrelid AND parent_column.attnum=fk.confkey[1]
   WHERE fk.contype='f' AND fk.confdeltype='c' AND cardinality(fk.conkey)=1
     AND fk.confrelid IN ('auth.users'::regclass,'public.user_profiles'::regclass)
     AND parent_column.attname='id' AND ns.nspname IN ('public','private')
     AND fk.conrelid NOT IN ('public.user_profiles'::regclass,'public.user_access'::regclass)
   ORDER BY ns.nspname,child.relname,column_name.attname`
  )
  for (const table of owned.rows) {
    await client.query(
      `DELETE FROM ${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.table_name)} WHERE ${quoteSqlIdentifier(table.column_name)}=$1`,
      [userId]
    )
  }
  await client.query(
    "UPDATE public.user_profiles SET email=NULL,display_name=NULL,avatar_url=NULL,city_preference_id=NULL,child_name=NULL,child_age=NULL,updated_at=now() WHERE id=$1",
    [userId]
  )
  await client.query(
    "UPDATE auth.users SET email=NULL,email_confirmed_at=NULL,raw_app_meta_data='{}'::jsonb,raw_user_meta_data='{}'::jsonb,updated_at=now() WHERE id=$1",
    [userId]
  )
}
