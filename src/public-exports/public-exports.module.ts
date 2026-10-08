import { Module } from "@nestjs/common"
import { PublicExportsController } from "./public-exports.controller.js"
import { PublicExportsRepository } from "./public-exports.repository.js"

@Module({ controllers: [PublicExportsController], providers: [PublicExportsRepository] })
export class PublicExportsModule {}
