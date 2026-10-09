import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import type { PoolClient } from "pg"
import { DbService } from "../db/db.service.js"
import { isDatabaseAdminDenial, requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { AdminCityDto } from "./admin-city.dto.js"
import type { AdminCreateCityInput } from "./admin-city.input.js"

const COLUMNS = "id,name,state,country,slug,timezone,latitude,longitude,is_active,created_at"
@Injectable()
export class AdminCityRepository {
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
  list(actor: string): Promise<AdminCityDto[]> {
    return this.asAdmin(
      actor,
      async (client) =>
        (await client.query<AdminCityDto>(`SELECT ${COLUMNS} FROM public.cities ORDER BY name,id`))
          .rows
    )
  }
  create(actor: string, input: AdminCreateCityInput): Promise<AdminCityDto> {
    return this.asAdmin(actor, async (client) => {
      const [city] = (
        await client.query<AdminCityDto>(
          `INSERT INTO public.cities(name,state,country,slug,timezone,latitude,longitude,is_active) VALUES($1,$2,$3,$4,$5,NULL,NULL,true) RETURNING ${COLUMNS}`,
          [input.name, input.state, input.country, input.slug, input.timezone]
        )
      ).rows
      if (!city) throw new Error("City insert did not return a row")
      await this.audit(client, actor, "create_city", city.id, { after: city })
      return city
    })
  }
  setActive(actor: string, id: string, isActive: boolean): Promise<AdminCityDto> {
    return this.asAdmin(actor, async (client) => {
      const [before] = (
        await client.query<AdminCityDto>(
          `SELECT ${COLUMNS} FROM public.cities WHERE id=$1::uuid FOR UPDATE`,
          [id]
        )
      ).rows
      if (!before) throw new NotFoundException("city not found")
      if (before.is_active === isActive) return before
      const [after] = (
        await client.query<AdminCityDto>(
          `UPDATE public.cities SET is_active=$2 WHERE id=$1::uuid RETURNING ${COLUMNS}`,
          [id, isActive]
        )
      ).rows
      if (!after) throw new NotFoundException("city not found")
      await this.audit(client, actor, "set_city_active", id, { before, after })
      return after
    })
  }
  private async audit(
    client: PoolClient,
    actor: string,
    action: string,
    id: string,
    metadata: unknown
  ): Promise<void> {
    await client.query(
      "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES($1::uuid,$2,'city',$3::uuid,$4::jsonb)",
      [actor, action, id, JSON.stringify(metadata)]
    )
  }
}
