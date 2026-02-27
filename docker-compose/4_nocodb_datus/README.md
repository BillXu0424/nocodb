# NocoDB + Datus Agent 联合部署

将 NocoDB（SQLite + NC_MINIMAL_DBS）与 Datus Agent 部署在同一 compose 中，并**共享 SQLite 数据目录**，使 Datus 能正确创建 namespace 并访问 NocoDB 导入的数据库文件。

## 核心设计

| 项目 | 说明 |
|------|------|
| **共享卷** | `nc_data` 挂载到 NocoDB 和 Datus 的 `/usr/app/data` |
| **路径一致** | NocoDB 创建的 SQLite 路径如 `/usr/app/data/nc_minimal_dbs/BaseTitle_xxx.db`，Datus 通过相同挂载可见 |
| **namespace 创建** | NocoDB 调用 Datus API 时传递该路径，Datus 能直接打开文件做连接测试和 KB 初始化 |

## 前置条件

- `datus-agent` 源码与 `nocodb` 同级或可访问，例如：
  ```
  Desktop/
  ├── nocodb/
  └── datus-agent-ob/
      └── datus-agent/
  ```

## 启动步骤

1. 复制 `.env.example` 为 `.env`，按实际路径设置 `DATUS_SOURCE_PATH`：
   ```bash
   cp .env.example .env
   # 编辑 .env，确认 DATUS_SOURCE_PATH 指向 datus-agent 目录
   ```

2. 启动服务：
   ```bash
   cd docker-compose/5_nocodb_datus
   docker compose up -d --build
   ```

3. 访问：
   - NocoDB: http://localhost:8080
   - Datus API（供 NocoDB 调用）: http://localhost:8002

## 数据流说明

1. **NocoDB 创建 Base**：在 `nc_minimal_dbs/` 下生成 `BaseTitle_<id>.db`
2. **NocoDB 调用 Datus**：为新 Base 创建 namespace，传入 `uri=/usr/app/data/nc_minimal_dbs/BaseTitle_xxx.db`
3. **Datus 挂载 nc_data**：可读到该路径，连接测试通过后写入 `~/.datus/conf` 的 agent.yml
4. **从外部导入数据**：导入后 SQLite 文件同样在 `nc_minimal_dbs/` 下，Datus 通过共享卷可见

## 故障排查

- **Datus 连接测试失败**：确认 `nc_data` 在两容器内都挂载到 `/usr/app/data`
- **路径错误**：NocoDB 使用 `NC_TOOL_DIR` 的绝对路径，需与 Datus 挂载路径一致
- **DATUS_SOURCE_PATH 无效**：使用绝对路径，如 `/Users/xxx/Desktop/datus-agent-ob/datus-agent`
