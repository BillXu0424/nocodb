import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { Readable } from 'stream';
import type Source from '~/models/Source';
import type { Base } from '~/models';

interface ChatRequest {
  message: string;
  session_id?: string;
  namespace: string;
  subagent?: string;
}

interface AuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

@Injectable()
export class DatusAgentService {
  private readonly logger = new Logger(DatusAgentService.name);
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: number | null = null;

  constructor() {
    const baseURL =
      process.env.DATUS_AGENT_API_URL || 'http://localhost:8002';
    this.client = axios.create({
      baseURL,
      timeout: 60000, // 60秒超时，因为流式响应可能需要较长时间
    });
  }

  /**
   * 获取认证 token（OAuth2 Client Credentials）
   */
  private async authenticate(): Promise<void> {
    try {
      const clientId =
        process.env.DATUS_CLIENT_ID || 'datus_client';
      const clientSecret =
        process.env.DATUS_CLIENT_SECRET || 'datus_secret_key';

      const response = await axios.post<AuthTokenResponse>(
        `${this.client.defaults.baseURL}/auth/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.accessToken = response.data.access_token;
      // 设置 token 过期时间（默认 3600 秒，提前 5 分钟刷新）
      const expiresIn = response.data.expires_in || 3600;
      this.tokenExpiry = Date.now() + (expiresIn - 300) * 1000;

      this.logger.debug('Successfully authenticated with datus-agent API');
    } catch (error) {
      this.logger.error(
        `Failed to authenticate with datus-agent: ${error.message}`,
      );
      throw new Error(
        `Datus-agent authentication failed: ${error.message}`,
      );
    }
  }

  /**
   * 确保 token 有效，如果过期则重新获取
   */
  private async ensureAuthenticated(): Promise<void> {
    if (
      !this.accessToken ||
      (this.tokenExpiry && Date.now() >= this.tokenExpiry)
    ) {
      await this.authenticate();
    }
  }

  /**
   * 调用 /api/chat/stream 接口进行流式聊天
   * @param baseId NocoDB base ID
   * @param request 聊天请求参数
   * @returns SSE 流
   */
  async chatStream(
    baseId: string,
    request: ChatRequest,
  ): Promise<Readable> {
    await this.ensureAuthenticated();

    // 如果没有指定 namespace，使用 baseId 作为 namespace
    const namespace = request.namespace || `nocodb_${baseId}`;

    try {
      const response: AxiosResponse<Readable> = await this.client.post(
        '/chat/stream',
        {
          message: request.message,
          session_id: request.session_id,
          namespace: namespace,
          subagent: request.subagent || null,
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          responseType: 'stream',
        },
      );

      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to call datus-agent chat stream: ${error.message}`,
      );
      if (error.response) {
        this.logger.error(
          `Response status: ${error.response.status}, data: ${error.response.data}`,
        );
      }
      throw new Error(
        `Datus-agent chat stream failed: ${error.message}`,
      );
    }
  }

  /**
   * 创建 namespace
   * @param namespaceName namespace 名称
   * @param dbConfig 数据库配置信息
   */
  async createNamespace(
    namespaceName: string,
    dbConfig: {
      db_type: 'sqlite' | 'mysql';
      uri?: string; // SQLite 使用
      host?: string; // MySQL 使用
      port?: number; // MySQL 使用
      username?: string; // MySQL 使用
      password?: string; // MySQL 使用
      database?: string; // MySQL 使用
    },
  ): Promise<{
    status: string;
    namespace_name: string;
    message: string;
    kb_init?: any;
  }> {
    await this.ensureAuthenticated();

    try {
      const response = await this.client.post(
        '/chat/namespaces',
        {
          namespace_name: namespaceName,
          ...dbConfig,
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log(
        `Successfully created namespace '${namespaceName}' in datus-agent`,
      );
      return response.data;
    } catch (error) {
      // 如果 namespace 已存在，不抛出错误（幂等性）
      if (
        error.response?.status === 400 &&
        error.response?.data?.detail?.includes('已存在')
      ) {
        this.logger.warn(
          `Namespace '${namespaceName}' already exists in datus-agent`,
        );
        return {
          status: 'success',
          namespace_name: namespaceName,
          message: `命名空间 '${namespaceName}' 已存在`,
        };
      }

      this.logger.error(
        `Failed to create namespace '${namespaceName}' in datus-agent: ${error.message}`,
      );
      throw new Error(
        `Failed to create namespace in datus-agent: ${error.message}`,
      );
    }
  }

  /**
   * 删除 namespace
   * @param namespaceName namespace 名称
   */
  async deleteNamespace(namespaceName: string): Promise<void> {
    await this.ensureAuthenticated();

    try {
      await this.client.delete(`/chat/namespaces/${namespaceName}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      this.logger.log(
        `Successfully deleted namespace '${namespaceName}' from datus-agent`,
      );
    } catch (error) {
      // 如果 namespace 不存在，不抛出错误（幂等性）
      if (error.response?.status === 404) {
        this.logger.warn(
          `Namespace '${namespaceName}' does not exist in datus-agent`,
        );
        return;
      }

      this.logger.error(
        `Failed to delete namespace '${namespaceName}' from datus-agent: ${error.message}`,
      );
      // 不抛出错误，避免影响 base 删除流程
    }
  }

  /**
   * 健康检查 - 测试 datus-agent 服务是否可用
   */
  async healthCheck(): Promise<{
    status: string;
    version?: string;
    database_status?: Record<string, string>;
    llm_status?: string;
  }> {
    try {
      const response = await axios.get(
        `${this.client.defaults.baseURL}/health`,
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `Datus-agent health check failed: ${error.message}`,
      );
      return {
        status: 'unhealthy',
      };
    }
  }

  /**
   * 为 NocoDB Source 创建 datus-agent namespace
   * 提取公共逻辑，供 SourcesService 和 BasesService 使用
   * @param source NocoDB Source 实例
   * @param base NocoDB Base 实例
   * @returns 是否成功创建
   */
  async createNamespaceForSource(
    source: Source,
    base: Base,
  ): Promise<boolean> {
    const namespaceName = `nocodb_${base.id}_${source.id}`;
    let config = source.getConfig();

    // 如果 getConfig() 返回 null，尝试使用 getConnectionConfig()（异步方法）
    // 这通常发生在 source 对象刚创建但 config 属性还未正确设置时
    if (!config) {
      try {
        config = await source.getConnectionConfig();
      } catch (error) {
        this.logger.warn(
          `Source ${source.id} has no config and getConnectionConfig() failed: ${error.message}, skipping namespace creation`,
        );
        return false;
      }
    }

    if (!config) {
      this.logger.warn(
        `Source ${source.id} has no config, skipping namespace creation`,
      );
      return false;
    }

    // 映射 NocoDB 数据库类型到 datus-agent 支持的数据库类型
    // 暂时不考虑 PostgreSQL
    const dbTypeMap: Record<string, 'sqlite' | 'mysql'> = {
      sqlite3: 'sqlite',
      mysql: 'mysql',
      mysql2: 'mysql',
    };

    const dbType = dbTypeMap[config.client || source.type];
    if (!dbType) {
      this.logger.warn(
        `Unsupported database type '${config.client || source.type}' for datus-agent namespace creation (PG not supported yet)`,
      );
      return false;
    }

    const dbConfig: any = {
      db_type: dbType,
    };

    if (dbType === 'sqlite') {
      // SQLite 配置
      const connection = config.connection || {};
      // 处理嵌套的 connection 结构（NC_MINIMAL_DBS 的情况）
      const filename =
        connection.filename ||
        connection.connection?.filename ||
        connection.database;
      if (filename) {
        // 转换为绝对路径 URI
        const path = require('path');
        const absolutePath = path.isAbsolute(filename)
          ? filename
          : path.resolve(filename);
        dbConfig.uri = `sqlite:///${absolutePath}`;
      } else {
        this.logger.warn(
          `SQLite source ${source.id} has no filename, skipping namespace creation`,
        );
        return false;
      }
    } else if (dbType === 'mysql') {
      // MySQL 配置
      const connection = config.connection || {};
      if (
        !connection.host ||
        !connection.port ||
        !connection.user ||
        !connection.password ||
        !connection.database
      ) {
        this.logger.warn(
          `MySQL source ${source.id} missing required connection parameters, skipping namespace creation`,
        );
        return false;
      }

      dbConfig.host = connection.host;
      dbConfig.port = parseInt(connection.port, 10);
      dbConfig.username = connection.user || connection.username;
      dbConfig.password = connection.password;
      dbConfig.database = connection.database;
    }

    // 创建 namespace
    await this.createNamespace(namespaceName, dbConfig);
    this.logger.log(
      `Successfully created datus-agent namespace '${namespaceName}' for source ${source.id}`,
    );
    return true;
  }
}
