import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import type { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import { useAgent } from 'request-filtering-agent';
import type { Base, Source } from '~/models';

const DEFAULT_BASE_URL = 'http://localhost:8000';
const DEFAULT_CLIENT_ID = 'datus_client';
const DEFAULT_CLIENT_SECRET = 'datus_secret_key';

interface TokenInfo {
  access_token: string;
  expires_at: number;
}

@Injectable()
export class DatusAgentService {
  private readonly logger = new Logger(DatusAgentService.name);

  private tokenCache: TokenInfo | null = null;
  private tokenPromise: Promise<TokenInfo> | null = null;

  private get baseURL(): string {
    return (
      process.env.NC_DATUS_AGENT_URL ||
      process.env.DATUS_AGENT_URL ||
      process.env.DATUS_AGENT_API_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  }

  private get client(): AxiosInstance {
    const baseURL = this.baseURL;
    return axios.create({
      baseURL,
      timeout: 60000,
      httpAgent: useAgent(baseURL, { allowPrivateIPAddress: true }),
      httpsAgent: useAgent(baseURL, { allowPrivateIPAddress: true }),
    });
  }

  private get clientId(): string {
    return process.env.NC_DATUS_CLIENT_ID || process.env.DATUS_CLIENT_ID || DEFAULT_CLIENT_ID;
  }

  private get clientSecret(): string {
    return (
      process.env.NC_DATUS_CLIENT_SECRET || process.env.DATUS_CLIENT_SECRET || DEFAULT_CLIENT_SECRET
    );
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expires_at > now + 60_000) {
      return this.tokenCache.access_token;
    }
    if (this.tokenPromise) {
      const t = await this.tokenPromise;
      return t.access_token;
    }
    this.tokenPromise = (async (): Promise<TokenInfo> => {
      try {
        const res = await this.client.post(
          '/auth/token',
          new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials',
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        );
        const data = res.data as { access_token: string; expires_in: number };
        const tokenInfo: TokenInfo = {
          access_token: data.access_token,
          expires_at: now + (data.expires_in || 7200) * 1000,
        };
        this.tokenCache = tokenInfo;
        return tokenInfo;
      } finally {
        this.tokenPromise = null;
      }
    })();
    return (await this.tokenPromise).access_token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  async chatStream(
    _baseId: string,
    request: { message: string; session_id?: string; namespace: string },
  ): Promise<Readable> {
    const headers = await this.authHeaders();
    // 流式请求不宜设置 timeout，LLM 多次工具调用可能超过 60 秒
    const response: AxiosResponse<Readable> = await this.client.post(
      '/chat/stream',
      {
        message: request.message,
        session_id: request.session_id,
        namespace: request.namespace,
      },
      { responseType: 'stream', headers, timeout: 0 },
    );
    return response.data;
  }

  /**
   * 获取会话列表。datus-agent 新 API：按 namespace、subagent 过滤。
   * namespace 为 nocodb_{baseId}_{sourceId}，subagent 不传则默认 global
   */
  async listSessions(
    namespace: string,
  ): Promise<{ sessions: Array<{ session_id: string; latest_user_message?: string }> }> {
    try {
      const headers = { ...(await this.authHeaders()), Accept: 'application/json' };
      const response = await this.client.get('/chat/sessions', {
        headers,
        params: { namespace },
      });
      return {
        sessions: response.data?.sessions ?? [],
      };
    } catch (error: any) {
      this.logger.warn(`listSessions failed: ${error?.message}`);
      return { sessions: [] };
    }
  }

  /**
   * 加载会话历史。datus-agent 新 API：需传 namespace 校验会话归属
   */
  async getSessionMessages(
    sessionId: string,
    namespace: string,
  ): Promise<{
    session_id: string;
    messages: Array<{ role: string; content: string; timestamp?: string | number }>;
  }> {
    try {
      const headers = { ...(await this.authHeaders()), Accept: 'application/json' };
      const response = await this.client.get(
        `/chat/session/${sessionId}/messages`,
        { headers, params: { namespace } },
      );
      return {
        session_id: sessionId,
        messages: response.data?.messages ?? [],
      };
    } catch (error: any) {
      this.logger.warn(`getSessionMessages failed: ${error?.message}`);
      return { session_id: sessionId, messages: [] };
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const headers = await this.authHeaders();
    await this.client.delete(`/chat/session/${sessionId}`, { headers });
  }

  async createNamespaceForSource(source: Source, _base: Base): Promise<void> {
    const namespace = `nocodb_${source.base_id}_${source.id}`;
    const config = typeof source.getConfig === 'function' ? source.getConfig() : source.config;
    if (!config) {
      this.logger.warn(`Source ${source.id} has no config, skipping namespace creation`);
      return;
    }
    const body = this.buildNamespaceCreateRequest(namespace, config);
    if (!body) {
      this.logger.warn(
        `Source ${source.id} db type '${config.client}' not supported for datus-agent namespace`,
      );
      return;
    }
    try {
      const headers = await this.authHeaders();
      await this.client.post('/chat/namespaces', body, { headers });
      this.logger.log(`Created datus-agent namespace '${namespace}' for source ${source.id}`);
    } catch (error: any) {
      this.logger.warn(`createNamespaceForSource failed: ${error?.message}`);
      throw error;
    }
  }

  /** 将 NocoDB source 配置转换为 datus-agent NamespaceCreateRequest 格式 */
  private buildNamespaceCreateRequest(
    namespaceName: string,
    config: { client?: string; connection?: any },
  ): Record<string, unknown> | null {
    const client = (config.client || '').toLowerCase();
    const conn = config.connection || config;

    if (client === 'sqlite3' || client === 'sqlite') {
      const uri = conn.filename || conn.uri || conn.connection?.filename;
      if (!uri) return null;
      return { namespace_name: namespaceName, db_type: 'sqlite', uri };
    }
    if (client === 'mysql2' || client === 'mysql') {
      const host = conn.host || conn.hostname;
      const port = conn.port ?? 3306;
      const username = conn.user || conn.username;
      const password = conn.password;
      const database = conn.database || conn.db;
      if (!host || !username || !password || !database) return null;
      return {
        namespace_name: namespaceName,
        db_type: 'mysql',
        host,
        port: Number(port),
        username,
        password,
        database,
      };
    }
    return null;
  }

  async deleteNamespace(namespaceName: string): Promise<void> {
    try {
      const headers = await this.authHeaders();
      await this.client.delete(`/chat/namespaces/${encodeURIComponent(namespaceName)}`, { headers });
    } catch (error: any) {
      this.logger.warn(`deleteNamespace '${namespaceName}' failed: ${error?.message}`);
      throw error;
    }
  }

  async healthCheck(): Promise<{ status?: string }> {
    try {
      const response = await this.client.get('/health');
      return response.data ?? { status: 'unknown' };
    } catch (error: any) {
      this.logger.warn(`healthCheck failed: ${error?.message}`);
      return { status: 'unhealthy' };
    }
  }
}
