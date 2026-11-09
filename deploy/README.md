# 部署示例（bi.example.com → 一台云服务器）

这是一个**参考部署**：演示怎么把 BI 挂在一台已有 nginx（示例用宝塔面板）的服务器上，
换成你自己的域名和服务器地址即可。

架构：宝塔 nginx（HTTPS）→ `127.0.0.1:8100` app 容器 → 同一个 Compose 项目里的 mysql 容器（不对外开端口）。
用的是 Docker 私有部署（`compose.yaml`，说明见 `deploy/docker/README.md`），挂在宝塔 nginx 后面（同一文档「服务器上已有 nginx」）。

- 代码在 `/opt/bi`（没有 git，部署时上传源码），配置 `/opt/bi/.env`。
- 业务库在 `bi_mysql-data` 卷，账号库 `app.db`、密钥、上传文件在 `bi_app-data` 卷。
- 宝塔站点和证书在面板里建；反向代理在 `/www/server/panel/vhost/nginx/extension/bi.example.com/bi_proxy.conf`
  （内容同 `deploy/docker/nginx-behind-proxy.conf`），改完 `nginx -t` 再 `/www/server/nginx/sbin/nginx -s reload`。

以下服务器上的命令都在 `/opt/bi` 下执行，`dc` 指
`docker compose -f compose.yaml -f deploy/docker/compose.behind-proxy.yaml`。

## 日常更新

`deploy/deploy.sh`：上传当前工作区的源码（不含 `.env` 和数据文件）→ 在服务器上重新构建镜像 → 重建容器
（启动时自动跑 `app.cli setup`：建表、迁移、只读账号授权）。服务器上的 `.env` 和数据卷不会被动。

改了 `/opt/bi/.env` 后要 `dc up -d app`，`restart` 不会读新配置。

## 账号和权限

账号存在 `app.db`（不在业务数据库里），三种角色：

| 角色 | 能做什么 |
|---|---|
| 只读 | 看报表、用 AI 问数（只查报表）、改自己的密码 |
| 分析员 | 另外可以浏览数据表、导入数据、用 SQL 查询，AI 问数可以执行 SQL |
| 管理员 | 另外可以在「用户管理」页添加用户、分配角色、停用、重置密码 |

平时在页面上管理。服务器上的应急命令（例如唯一的管理员忘了密码）：

```bash
dc exec app python -m app.cli set-password admin      # 重置密码（并重新启用该账号）
dc exec app python -m app.cli add-user zhangsan analyst  # 新建用户：viewer / analyst / admin
```

## AI 问数（页面右下角「问数」）

后端 `/api/chat` 调 OpenAI 兼容接口（默认 Command Code + `deepseek/deepseek-v4.1-flash`），key 在 `.env` 的
`COMMANDCODE_API_KEY`（或 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 换成别的服务）。这些只是初始配置：管理员可以在「AI 设置」页
管理 provider（接口地址、key、模型）、选择模型、改提示词，存在 data/app.db，优先于 `.env`，页面上可「恢复 .env 配置」。AI 用两个工具查数：看板报表，
和以只读账号 `bi_ai_ro` 执行的 SQL。业务口径在 `packages/retail/knowledge.md`。
每轮的 token 用量、每次查询和模型调用失败记在 `dc logs app | grep bi.chat`。

## 汇总表

`bi_store_daily` 由导入明细时自动重算。需要整体补算时：`dc exec app python -m app.cli rebuild-summaries`。

## 备份

```bash
dc exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" bi_data' | gzip > bi_data-$(date +%F).sql.gz
```
