# Docker 私有部署

一台装了 Docker（含 Compose v2.24+）的服务器，三个容器：

| 容器 | 作用 |
|---|---|
| `mysql` | 业务数据库（MySQL 8.4），数据在 `mysql-data` 卷 |
| `app` | 后端 + 前端 + 业务包；账号、导入记录、设置在 `app-data` 卷 |
| `caddy` | HTTPS 入口，自动申请证书，转发到 app |

## 第一次部署

```bash
git clone <仓库地址> bi && cd bi
cp deploy/docker/.env.example .env      # 填域名、两个数据库密码、AI 模型 key
docker compose up -d --build
docker compose logs app | grep 管理员     # 第一个管理员的初始密码
```

打开 `https://<你的域名>`，用 admin 和初始密码登录，**先在右上角改密码**，再到「用户管理」给同事建账号。

启动时 app 会自动运行 `python -m app.cli setup`（每次启动都跑，已完成的步骤会跳过）：

1. 生成会话密钥（存在 `app-data` 卷的 `secrets.env`）；
2. 按业务包 `schema/` 建表；以后业务包新增的迁移文件也在这时执行；
3. 账号表为空时创建管理员，随机密码打印在日志里，也写在卷里的 `initial_admin_password`；
4. 创建 AI 写 SQL 用的只读数据库账号（看不到业务包 `hidden_columns` 里的列）；
5. 汇总表为空而明细有数据时补算汇总。

## 日常

```bash
git pull && docker compose up -d --build                         # 升级
docker compose exec app python -m app.cli set-password admin     # 管理员忘了密码
docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" bi_data' > backup.sql   # 备份业务库
```

## 用客户已有的 MySQL

不启动自带的 mysql 容器，`.env` 里把 `DB_HOST / DB_PORT / DB_USER / DB_PASSWORD` 指向那个库，然后：

```bash
docker compose -f compose.yaml -f deploy/docker/compose.external-db.yaml up -d --build
```

`DB_USER` 需要在业务库里建表的权限。要让 AI 问数能写 SQL，再给一个能 `CREATE USER` / `GRANT` 的账号
（`DB_ADMIN_USER / DB_ADMIN_PASSWORD`），setup 用它建只读账号；不给的话 AI 问数仍能查报表。

## 服务器上已有 nginx

80/443 已被宝塔等 nginx 占用时，不启动自带的 caddy，app 只监听本机 `127.0.0.1:8100`（`.env` 里 `APP_PORT` 可改）：

```bash
docker compose -f compose.yaml -f deploy/docker/compose.behind-proxy.yaml up -d --build
```

`.env` 里仍要填 `DOMAIN`。在已有 nginx 里给这个域名建站点、配好证书，再把 `deploy/docker/nginx-behind-proxy.conf` 的内容放进站点配置。

## 换成客户自己的业务包

业务包格式见 `packages/README.md`。不想重新构建镜像时，把业务包目录挂进去：

```yaml
# compose.override.yaml
services:
  app:
    volumes:
      - ./my-package:/app/packages/custom:ro
    environment:
      BI_PACKAGE_DIR: /app/packages/custom
```

## 没有域名时（内网 / 测试）

`.env` 里 `DOMAIN=:80`、`COOKIE_SECURE=0`，用 `http://服务器IP` 访问（不加密，只适合内网）。
