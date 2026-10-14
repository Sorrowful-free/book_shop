// /covers (spec 08 §5): cover upload presign + public read proxy.
//
// POST /covers/upload is staff-only (AuthGuard + RolesGuard EMPLOYER|ADMIN,
// same matrix as book writes — catalog re-checks on the wire call) and
// returns the presigned POST {uploadUrl, fields, coverUrl}; the browser
// then uploads straight to MinIO.
//
// GET /covers/:key is intentionally guard-free — <img> tags load covers
// without credentials. Keys are uuid.ext and content is immutable once
// uploaded, so responses carry a year-long immutable Cache-Control.

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { COVER_KEY_PATTERN, UserRole } from "@book-shop/contracts";
import type { CatalogClient } from "../clients";
import { CATALOG_CLIENT } from "../tokens";
import { outgoingMetadata, type AuthedRequest } from "../request-context";
import { AuthGuard, Roles, RolesGuard } from "../guards";
import { CreateCoverUploadDto } from "../dto";

const COVER_CACHE_CONTROL = "public, max-age=31536000, immutable";

@ApiTags("covers")
@Controller("covers")
export class CoversController {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClient
  ) {}

  @Post("upload")
  // spec §10: the presign is not a resource creation — 200, not Nest's
  // default 201 for POST.
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.Employer, UserRole.Admin)
  async upload(@Body() dto: CreateCoverUploadDto, @Req() req: AuthedRequest) {
    const res = await this.catalog.createCoverUpload(
      dto,
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return {
      uploadUrl: res.uploadUrl,
      fields: res.fields,
      coverUrl: res.coverUrl
    };
  }

  @Get(":key")
  async get(@Param("key") key: string, @Res() res: Response) {
    // The route param only excludes path separators — enforce the full
    // `<uuid>.<ext>` shape before the key is forwarded to the store.
    if (!COVER_KEY_PATTERN.test(key)) {
      throw new BadRequestException("invalid cover key");
    }
    const cover = await this.catalog.getBookCover({ key });
    const data = Buffer.from(cover.data);
    res
      .set("Content-Type", cover.contentType)
      .set("Content-Length", String(data.length))
      .set("Cache-Control", COVER_CACHE_CONTROL)
      .send(data);
  }
}
