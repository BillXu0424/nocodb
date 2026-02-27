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

1. 复制 `.env.example` 为 `.env`，按实际路径设置：
   ```bash
   cp .env.example .env
   # 编辑 .env：
   #   DATUS_SOURCE_PATH - 指向 datus-agent 目录
   #   DATUS_HOME - 若用 sudo 启动，需设置为当前用户的 home（如 /home/xzh495328），否则挂载的是 /root/.datus
   ```

2. 启动服务：
   ```bash
   cd docker-compose/4_nocodb_datus
   docker compose up -d --build
   ```

### 二开版本：本地构建 → 导出 → 开发机加载

compose 使用 `nocodb-local:latest`（你的二开代码构建的镜像）。

**步骤 1：在本地（有外网）**，确保代码已提交二开修改后：

```bash
cd /path/to/nocodb   # 仓库根目录

# 若本机无法访问 Docker Hub，先从有网络机器获取 node 镜像：
#   docker pull --platform linux/amd64 node:22-slim
#   docker save -o node-22-slim.tar node:22-slim
# 传到本机后，构建时指定：DOCKER_NODE_IMAGE_TAR=./node-22-slim.tar DOCKER_BUILD_PULL=false

# Mac ARM 部署到 amd64 服务器：加 DOCKER_PLATFORM=linux/amd64
./build-local-docker-image.sh   # 或 DOCKER_PLATFORM=linux/amd64 ./build-local-docker-image.sh
docker save -o nocodb-local.tar nocodb-local:latest
# 将 nocodb-local.tar 传到开发机
```

**步骤 2：在开发机上**：

```bash
sudo docker load -i nocodb-local.tar
cd docker-compose/4_nocodb_datus
sudo docker compose up -d
```

> Mac ARM 部署到 amd64 开发机时，需执行 `DOCKER_PLATFORM=linux/amd64 ./build-local-docker-image.sh`

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
- **容器内看不到 agent.yml**：若用 `sudo docker compose up`，`$HOME` 会变成 `/root`，宿主机挂载的是 `/root/.datus/conf` 而非你用户的目录。在 `.env` 中设置 `DATUS_HOME=/home/你的用户名` 即可
