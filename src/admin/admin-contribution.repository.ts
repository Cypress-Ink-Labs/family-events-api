import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import type { PoolClient } from "pg"
import { DbService } from "../db/db.service.js"
import { isDatabaseAdminDenial, requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { AdminCommentDto, AdminRatingDto } from "./admin-contribution.dto.js"
import type { CommentUpdate } from "./admin-contribution.input.js"

@Injectable()
export class AdminContributionRepository {
  constructor(private readonly db: DbService) {}
  private async asAdmin<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withAdminActor(this.db, actor, async (client) => {
        await requireDatabaseAdmin(client)
        return work(client)
      })
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      throw error
    }
  }
  comments(actor: string, page: number, filter: string) {
    const predicate =
      filter === "flagged"
        ? "c.is_flagged=true"
        : filter === "pending"
          ? "c.is_approved=false AND c.is_flagged=false"
          : filter === "approved"
            ? "c.is_approved=true AND c.is_flagged=false"
            : "true"
    return this.asAdmin(actor, async (client) => {
      const count = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.comments c WHERE ${predicate}`
      )
      const rows = await client.query<AdminCommentDto>(
        `SELECT c.id,c.user_id,c.event_id,c.body,c.is_approved,c.is_flagged,c.created_at,c.updated_at,p.display_name,e.title AS event_title FROM public.comments c LEFT JOIN public.user_profiles p ON p.id=c.user_id JOIN public.events e ON e.id=c.event_id WHERE ${predicate} ORDER BY c.created_at DESC,c.id DESC LIMIT 50 OFFSET $1`,
        [page * 50]
      )
      return { rows: rows.rows, totalCount: count.rows[0]!.total }
    })
  }
  ratings(actor: string, page: number) {
    return this.asAdmin(actor, async (client) => {
      const count = await client.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM public.ratings"
      )
      const rows = await client.query<AdminRatingDto>(
        "SELECT r.id,r.user_id,r.event_id,r.score,r.created_at,p.display_name,e.title AS event_title FROM public.ratings r LEFT JOIN public.user_profiles p ON p.id=r.user_id JOIN public.events e ON e.id=r.event_id ORDER BY r.created_at DESC,r.id DESC LIMIT 50 OFFSET $1",
        [page * 50]
      )
      return { rows: rows.rows, totalCount: count.rows[0]!.total }
    })
  }
  update(actor: string, id: string, input: CommentUpdate) {
    return this.asAdmin(actor, async (client) => {
      const before = (
        await client.query("SELECT * FROM public.comments WHERE id=$1::uuid FOR UPDATE", [id])
      ).rows[0]
      if (!before) throw new NotFoundException("comment not found")
      const after = (
        await client.query(
          "UPDATE public.comments SET body=COALESCE($2,body),is_approved=COALESCE($3,is_approved),is_flagged=COALESCE($4,is_flagged),updated_at=now() WHERE id=$1::uuid RETURNING *",
          [id, input.body ?? null, input.is_approved ?? null, input.is_flagged ?? null]
        )
      ).rows[0]
      await this.audit(client, actor, "update_comment", "comment", id, { before, after })
      return { updated: true }
    })
  }
  remove(actor: string, kind: "comment" | "rating", id: string) {
    const table = kind === "comment" ? "comments" : "ratings"
    return this.asAdmin(actor, async (client) => {
      const before = (
        await client.query(`DELETE FROM public.${table} WHERE id=$1::uuid RETURNING *`, [id])
      ).rows[0]
      if (!before) throw new NotFoundException(`${kind} not found`)
      await this.audit(client, actor, `delete_${kind}`, kind, id, { before })
      return { removed: true }
    })
  }
  private async audit(
    client: PoolClient,
    actor: string,
    action: string,
    kind: string,
    id: string,
    metadata: unknown
  ) {
    await client.query(
      "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES($1::uuid,$2,$3,$4::uuid,$5::jsonb)",
      [actor, action, kind, id, JSON.stringify(metadata)]
    )
  }
}
