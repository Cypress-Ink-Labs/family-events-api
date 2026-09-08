import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { JobsService } from "../jobs/jobs.service.js"
import { AdminAccessDeniedError } from "./admin-database.js"
import type { AdminCreateSourceInput } from "./admin-source.input.js"
import type { AdminSourceRepository } from "./admin-source.repository.js"
import { InactiveAdminSourceError } from "./admin-source.repository.js"
import { AdminSourceService } from "./admin-source.service.js"

const createInput = {
  name: "Calendar",
  url: "https://example.com",
  sourceType: "website",
  extractionMode: "deterministic",
  processingMode: "manual_review",
  cityId: null,
  isActive: true,
  scrapeIntervalHours: 24,
  notes: null,
  dateWindowDays: null,
} satisfies AdminCreateSourceInput

function setup() {
  const source = { id: "source" }
  const jobs = { send: vi.fn().mockResolvedValue("job") }
  const repository = {
    list: vi.fn().mockResolvedValue([source]),
    create: vi.fn().mockResolvedValue(source),
    update: vi.fn().mockResolvedValue(source),
    setProcessingMode: vi.fn().mockResolvedValue(source),
    bulkSetProcessingMode: vi.fn().mockResolvedValue(undefined),
    scrape: vi.fn().mockResolvedValue({ queueId: "1", deduped: false }),
  }
  return {
    jobs,
    source,
    repository,
    service: new AdminSourceService(
      repository as unknown as AdminSourceRepository,
      jobs as unknown as JobsService
    ),
  }
}

describe("AdminSourceService", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("forwards trusted actor and parsed source values", async () => {
    const { jobs, repository, service, source } = setup()
    await expect(service.list("actor")).resolves.toEqual([source])
    await expect(service.create("actor", createInput)).resolves.toBe(source)
    await expect(service.update("actor", "source", { notes: null })).resolves.toBe(source)
    await expect(service.setProcessingMode("actor", "source", "llm_review")).resolves.toBe(source)
    await expect(service.bulkSetProcessingMode("actor", "auto_approve")).resolves.toBeUndefined()
    await expect(service.scrape("actor", "source")).resolves.toEqual({
      queueId: "1",
      deduped: false,
    })
    expect(jobs.send).toHaveBeenCalledWith(
      "scrape",
      { task: "drain-source-queue" },
      { singletonKey: "drain-source-queue" }
    )
    expect(repository.create).toHaveBeenCalledWith("actor", createInput)
    expect(repository.update).toHaveBeenCalledWith("actor", "source", { notes: null })
  })

  it.each([
    new AdminAccessDeniedError(),
    { code: "42501", message: "forbidden" },
    { code: "P0001", message: "ADMIN_SOURCE_ADMIN_REQUIRED" },
  ])("maps database authorization denial to the stable 403", async (failure) => {
    const { repository, service } = setup()
    repository.create.mockRejectedValueOnce(failure)
    await expect(service.create("actor", createInput)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("conceals missing sources across mutation paths", async () => {
    const { repository, service } = setup()
    repository.update.mockRejectedValueOnce({ code: "P0001", message: "ADMIN_SOURCE_NOT_FOUND" })
    await expect(service.update("actor", "source", { notes: null })).rejects.toBeInstanceOf(
      NotFoundException
    )
    repository.setProcessingMode.mockRejectedValueOnce({
      code: "P0002",
      message: "source not found: source",
    })
    await expect(
      service.setProcessingMode("actor", "source", "manual_review")
    ).rejects.toBeInstanceOf(NotFoundException)
    repository.scrape.mockResolvedValueOnce(null)
    await expect(service.scrape("actor", "source")).rejects.toBeInstanceOf(NotFoundException)
  })

  it("maps an inactive scrape and legacy validation failures to typed 400 responses", async () => {
    const { repository, service } = setup()
    repository.scrape.mockRejectedValueOnce(new InactiveAdminSourceError())
    await expect(service.scrape("actor", "source")).rejects.toBeInstanceOf(BadRequestException)
    repository.create.mockRejectedValueOnce({
      code: "P0001",
      message: "ADMIN_SOURCE_NAME_REQUIRED",
    })
    try {
      await service.create("actor", createInput)
      throw new Error("expected service failure")
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        message: "invalid request body",
        issues: [{ path: "name", message: "name is required" }],
      })
    }
  })

  it("preserves unrelated database failures", async () => {
    const { repository, service } = setup()
    const failure = Object.assign(new Error("connection failed"), { code: "08006" })
    repository.list.mockRejectedValueOnce(failure)
    await expect(service.list("actor")).rejects.toBe(failure)
  })

  it("keeps durable enqueue successful when an enabled drain kick fails", async () => {
    const { jobs, service } = setup()
    jobs.send.mockRejectedValueOnce(new Error("pg-boss unavailable"))
    await expect(service.scrape("actor", "source")).resolves.toEqual({
      queueId: "1",
      deduped: false,
    })
  })

  it("does not send a drain job while scrape ownership is disabled", async () => {
    vi.stubEnv("CUTOVER_SCRAPE", "false")
    const { jobs, service } = setup()
    await expect(service.scrape("actor", "source")).resolves.toBeDefined()
    expect(jobs.send).not.toHaveBeenCalled()
  })
})
