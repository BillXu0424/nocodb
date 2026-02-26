import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { GlobalGuard } from '~/guards/global/global.guard';
import { MetaApiLimiterGuard } from '~/guards/meta-api-limiter.guard';
import { Acl } from '~/middlewares/extract-ids/extract-ids.middleware';
import { TenantContext } from '~/decorators/tenant-context.decorator';
import type { NcContext, NcRequest } from '~/interface/config';
import { DatusAgentService } from '~/services/datus-agent.service';

@Controller()
@UseGuards(MetaApiLimiterGuard, GlobalGuard)
export class DatusAgentController {
  private readonly logger = new Logger(DatusAgentController.name);

  constructor(private readonly datusAgentService: DatusAgentService) {}

  @Post('/api/v2/meta/bases/:baseId/ai/chat/stream')
  @Acl('baseGet')
  async chatStream(
    @TenantContext() context: NcContext,
    @Param('baseId') baseId: string,
    @Body()
    body: {
      message: string;
      session_id?: string;
      source_id?: string;
      namespace?: string;
    },
    @Res() res: Response,
    @Req() req: NcRequest,
  ) {
    try {
      // 确定 namespace（必须与 createNamespaceForSource 创建的格式一致：nocodb_{baseId}_{sourceId}）
      let namespace: string | undefined;

      if (body.namespace) {
        namespace = body.namespace;
      } else if (body.source_id) {
        namespace = `nocodb_${baseId}_${body.source_id}`;
      }

      if (!namespace) {
        res.status(400).json({
          error: 'Missing namespace',
          message: '请指定 namespace 或 source_id',
        });
        return;
      }

      // 调用 datus-agent 的流式 API
      const stream = await this.datusAgentService.chatStream(baseId, {
        message: body.message,
        session_id: body.session_id,
        namespace,
      });

      // 设置响应头并立即发送（建立 SSE 连接）
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // 使用 pipe 转发流（比手动 data/end 更可靠）
      const cleanup = () => {
        stream.destroy();
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);

      stream.on('error', (err: Error) => {
        this.logger.error('Datus stream error', err);
        if (!res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
          );
          res.end();
        }
      });

      stream.pipe(res);
    } catch (error: any) {
      this.logger.error(`chatStream error: ${error?.message}`, error?.stack);
      const status = error.response?.status ?? 500;
      const detail =
        error.response?.data?.detail ??
        error.message ??
        'Failed to start chat stream';
      res.status(status).json({
        error: 'Chat stream failed',
        message: typeof detail === 'string' ? detail : JSON.stringify(detail),
      });
    }
  }

  /**
   * 获取会话列表（按 namespace 过滤，datus-agent 新 API）
   */
  @Get('/api/v2/meta/bases/:baseId/ai/chat/sessions')
  @Acl('baseGet')
  async listSessions(
    @TenantContext() context: NcContext,
    @Param('baseId') baseId: string,
    @Query('source_id') sourceId: string,
  ) {
    if (!sourceId) {
      return { sessions: [] };
    }
    const namespace = `nocodb_${baseId}_${sourceId}`;
    return this.datusAgentService.listSessions(namespace);
  }

  /**
   * 按 session 加载历史消息（需 namespace 校验，datus-agent 新 API）
   */
  @Get('/api/v2/meta/bases/:baseId/ai/chat/sessions/:sessionId/messages')
  @Acl('baseGet')
  async getSessionMessages(
    @TenantContext() context: NcContext,
    @Param('baseId') baseId: string,
    @Param('sessionId') sessionId: string,
    @Query('source_id') sourceId: string,
  ) {
    if (!sourceId) {
      return { session_id: sessionId, messages: [] };
    }
    const namespace = `nocodb_${baseId}_${sourceId}`;
    return this.datusAgentService.getSessionMessages(sessionId, namespace);
  }

  /**
   * 删除会话
   */
  @Delete('/api/v2/meta/bases/:baseId/ai/chat/sessions/:sessionId')
  @Acl('baseGet')
  async deleteSession(
    @TenantContext() context: NcContext,
    @Param('baseId') baseId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.datusAgentService.deleteSession(sessionId);
  }

  @Get('/api/v2/meta/bases/:baseId/ai/health')
  @Acl('baseGet')
  async healthCheck(
    @TenantContext() context: NcContext,
    @Param('baseId') baseId: string,
  ) {
    const health = await this.datusAgentService.healthCheck();
    return health;
  }
}
