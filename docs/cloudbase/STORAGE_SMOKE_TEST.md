# CloudBase Storage Smoke Test

## 1. Purpose

本文记录 Terra 测试数据写入 CloudBase 云存储的最小验证闭环，作为后续
1k 和 globe terrain 数据部署的操作基线。验证目标包括：

- 使用 CloudBase CLI 将本地文件上传到私有云存储；
- 查询对象大小、类型和 ETag；
- 下载对象并比较 SHA-256；
- 明确对象在 CloudBase Run 容器中的预期挂载路径。

最初 smoke 只验证“上传、查询、下载、字节一致性”；后续部署验证已补充
CloudBase Run 只读挂载、1k patch 与北京 globe patch 的实际读取。上传成功仍
不能单独等同于运行时挂载成功。

## 2. Verified Environment

验证日期：2026-07-28。

| Item | Value |
| --- | --- |
| CloudBase CLI | `3.5.10` |
| Environment ID | `shunlu-api-test-d9fvhxfy3199a35a` |
| Environment type | PostgreSQL |
| Region | `ap-shanghai` |
| Physical COS bucket | `7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477` |
| PG Storage bucket | `terra-testdata` |
| Bucket visibility | private |
| Per-file limit | `2147483648` bytes, 2 GiB |

通过 `tcb api tcb DescribeEnvs` 可以查询当前环境的物理 COS bucket。部署脚本
不应根据环境 ID 推导 bucket 名称，必须读取 API 或部署配置中的真实值。

## 3. PG Storage Command Model

当前环境是 PostgreSQL 模式。旧命令：

```powershell
tcb storage upload <LOCAL_PATH> <CLOUD_PATH>
```

会返回 `FLAT_CMD_NOT_AVAILABLE_IN_PG`。正确方式是先创建 PG Storage bucket，
再通过 `storage objects` 命令操作对象。

创建私有 bucket：

```powershell
tcb -e <ENV_ID> db execute --sql `
  "INSERT INTO storage.buckets
   (id, name, public, created_at, updated_at)
   VALUES ('terra-testdata', 'terra-testdata', false, now(), now())"
```

`file_size_limit` 必须显式设置。当前环境中省略该字段会得到 `0`，所有非空文件
都会被拒绝：

```powershell
tcb -e <ENV_ID> db execute --sql `
  "UPDATE storage.buckets
   SET file_size_limit = 2147483648, updated_at = now()
   WHERE id = 'terra-testdata'"
```

## 4. Executed Smoke Test

上传的本地文件：

```text
testdata/miniprogram/desktop_oracle_manifest.txt
```

上传命令：

```powershell
tcb -e shunlu-api-test-d9fvhxfy3199a35a `
  storage objects upload `
  "\\wsl.localhost\Ubuntu-22.04\home\holo\terra-sdk-anti\terra-sdk-miniprogram\testdata\miniprogram\desktop_oracle_manifest.txt" `
  "smoke/v1/desktop_oracle_manifest.txt" `
  -b terra-testdata `
  --content-type text/plain `
  --json
```

CloudBase 返回的物理 object key：

```text
terra-testdata/smoke/v1/desktop_oracle_manifest.txt
```

查询对象：

```powershell
tcb -e shunlu-api-test-d9fvhxfy3199a35a `
  storage objects stat `
  "smoke/v1/desktop_oracle_manifest.txt" `
  -b terra-testdata `
  --json
```

下载对象：

```powershell
tcb -e shunlu-api-test-d9fvhxfy3199a35a `
  storage objects download `
  "smoke/v1/desktop_oracle_manifest.txt" `
  "C:\tmp\cloudbase-storage-smoke-downloaded.txt" `
  -b terra-testdata `
  --overwrite
```

## 5. Evidence

| Check | Result |
| --- | --- |
| Upload | passed |
| Object size | `691` bytes |
| Content-Type | `text/plain` |
| ETag | `"fef13dd4a8136814e42dc3904d081c81"` |
| Download | passed |
| Source SHA-256 | `BDB60EFD124027C29656B506B72EA403D7C5AB4EF53824ED123CFB55BFE60321` |
| Download SHA-256 | `BDB60EFD124027C29656B506B72EA403D7C5AB4EF53824ED123CFB55BFE60321` |

源文件和下载文件逐字节一致。

## 6. CloudBase Run Mount Contract

Terrain 服务使用只读对象存储挂载：

| Setting | Value |
| --- | --- |
| Storage type | COS |
| Bucket | `7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477` |
| Source path | `/terra-testdata` |
| Container path | `/mnt/terra-data` |
| Read-only | `true` |

挂载后，smoke 文件预期位于：

```text
/mnt/terra-data/smoke/v1/desktop_oracle_manifest.txt
```

独立 storage probe 的目标响应格式如下；当前正式验证由 terrain 服务
`/readyz` 与实际 patch 请求共同覆盖挂载可用性：

```json
{
  "path": "/mnt/terra-data/smoke/v1/desktop_oracle_manifest.txt",
  "size": 691,
  "sha256": "bdb60efd124027c29656b506b72ea403d7c5ab4ef53824ed123cfb55bfe60321",
  "status": "ok"
}
```

文件缺失、不可读、大小或 SHA 不匹配时 readiness 必须失败。

## 7. RLS Warning

CloudBase 网页显示“该存储桶未配置任何 RLS 策略，所有通过 API 的访问都将被
拒绝”是当前部署的预期安全状态。RLS 控制 PG Storage API 的客户端角色；
CloudBase Run 使用专用 CAM 资源连接挂载物理 COS，不依赖该 RLS。

小程序不直接读取 `terra-testdata`，因此不要添加公开 RLS。线上数据链路应
通过 Run 服务的 `/readyz`、manifest 与实际 patch 请求验证。

### 7.1 Physical COS And PG Storage Visibility

CloudBase PG Storage 的对象列表来自逻辑 bucket 的 metadata 表。Globe
`.data` 使用短期 STS 和 COS multipart 直接写入物理 bucket，不会同时创建 PG
Storage metadata 行。因此，逻辑 bucket 页面可能只显示小文件，而不显示已经
存在于物理 COS 的 `global_srtm_tol2.data`。

这不表示 `.data` 缺失。权威核验是：

1. 对精确物理 COS key 执行 `HeadObject`，比较对象和本地文件字节数；
2. 检查 CloudBase Run `/readyz`；
3. 请求实际 1k patch 和北京 `116,40` globe patch。

2026-07-29 的幂等检查结果：

| Dataset | Physical COS key | Exact size |
| --- | --- | ---: |
| PS 1k | `terra-testdata/datasets/ps-1k/v1/terrain/terrain.data` | `1769472` |
| Globe | `terra-testdata/datasets/globe/v1/terrain/global_srtm_tol2.data` | `859361280` |

两个对象均返回 `object already exists`，大小与本地源一致。不要为了让大文件
出现在 PG Storage 页面而重复上传、手工写 metadata 或开放 RLS。

## 8. Production Data Rules

- 使用不可变版本路径，例如 `ps-1k/v1/` 和 `globe/srtm-v2/`。
- 每个版本包含 `manifest.json`，记录文件名、字节数和 SHA-256。
- 不覆盖已发布版本；数据变化创建新版本目录。
- 1k 数据可使用当前 CLI 上传。
- Globe data 约 820 MiB，由 `upload_cloudbase_data.ps1` 自动选择官方 COS
  multipart 上传器；不得退回 PG 单次 PUT。上传器通过
  `sts.GetFederationToken` 获取只允许目标对象、有效期 15 分钟的临时凭据。
- Terrain 服务只读挂载；构建和运行过程中不得修改 repository 文件。
- Bucket 保持私有，不生成长期公开 URL。

## 9. References

- [CloudBase CLI cloud storage](https://docs.cloudbase.net/cli-v1/storage)
- [PG cloud storage](https://docs.cloudbase.net/storage/pg/introduce)
- [CloudBase Run COS mount](https://docs.cloudbase.net/run/deploy/configuring/storage/cos)
- [CloudBase Run VolumeConf](https://cloud.tencent.com/document/api/1243/75713)

## 10. CloudBase Resource Connection

CloudBase Run COS mounts require a resource-connection `KeyID`; the bucket
name alone is insufficient. Create a `cloud-api` connection with a dedicated
CAM sub-user. Limit the policy to the physical bucket and these prefixes:

- `terra-testdata/*`: read-only for both terrain services.
- `terra-tianditu-cache/*`: read/write for the imagery proxy.

Pass only the non-secret ID through
`TERRA_COS_CONNECTION_KEY_ID` or `-StorageKeyId`. SecretId and SecretKey
must remain in CloudBase connection storage and must not appear in Git,
deployment evidence, logs, or Mini Program configuration.
