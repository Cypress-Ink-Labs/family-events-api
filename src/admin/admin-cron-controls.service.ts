import { ForbiddenException, Injectable } from "@nestjs/common"
import { JobsService } from "../jobs/jobs.service.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { scheduledOperations } from "../pipeline/scheduled-operations.js"
import { isDatabaseAdminDenial } from "./admin-database.js"
import { AdminCronControlsRepository, type CronOwner } from "./admin-cron-controls.repository.js"

@Injectable()
export class AdminCronControlsService {
  constructor(
    private readonly repository: AdminCronControlsRepository,
    private readonly jobs: JobsService
  ) {}
  private async safe<T>(work: () => Promise<T>) {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      throw error
    }
  }
  setOwner(actor: string, label: string, owner: CronOwner) {
    const operation = scheduledOperations().find((candidate) => candidate.label === label)!
    return this.safe(() =>
      this.repository.setOwner(
        actor,
        operation,
        owner,
        isFamilyEnabled(operation.family, process.env)
      )
    )
  }
  run(actor: string, label: string) {
    const operation = scheduledOperations().find((candidate) => candidate.label === label)!
    return this.safe(() =>
      this.repository.dispatch(
        actor,
        operation,
        isFamilyEnabled(operation.family, process.env),
        (client) =>
          this.jobs.send(operation.queue, operation.payload, {
            singletonKey: operation.key,
            singletonSeconds: 60,
            db: { executeSql: (sql, values) => client.query(sql, values) },
          })
      )
    )
  }
}
