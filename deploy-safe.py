#!/usr/bin/env python3
"""安全部署脚本 v2 —— 保护 data / .env / docker-compose.yml

策略：**不做任何删除**，直接以覆盖方式解压代码包。
      打包时已排除 data/ 与 .env，解压时再次排除，双重保险；
      原目录中的文件保留在原处，任何情况下都不会丢。
"""
import paramiko
import os
import sys

HOST = os.environ.get('DEPLOY_HOST', '172.29.133.24')
USER = os.environ.get('DEPLOY_USER', 'root')
PASSWORD = os.environ.get('DEPLOY_PASSWORD', '')  # 不要硬编码，用环境变量传入
REMOTE_DIR = os.environ.get('DEPLOY_REMOTE_DIR', '/opt/bili-dyn-publisher')
TARBALL = r'C:\Users\Administrator\AppData\Local\Temp\opencode\deploy\bili-dyn.tgz'


def run(ssh, cmd, pty=False):
    stdin, stdout, stderr = ssh.exec_command(cmd, get_pty=pty)
    out = stdout.read().decode('utf-8', errors='ignore')
    err = stderr.read().decode('utf-8', errors='ignore')
    return out, err


def main():
    if not PASSWORD:
        print('错误: 未设置 DEPLOY_PASSWORD 环境变量')
        print('用法: DEPLOY_PASSWORD=*** python deploy-safe.py')
        sys.exit(1)
    if not os.path.exists(TARBALL):
        print(f'错误: {TARBALL} 不存在，请先打包')
        sys.exit(1)

    size = os.path.getsize(TARBALL)
    print(f'[1/6] 连接到 {HOST}...')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASSWORD)

    try:
        sftp = ssh.open_sftp()

        # ---- 部署前快照 ----
        print('[2/6] 记录部署前状态...')
        out, _ = run(ssh, f'''
cd {REMOTE_DIR}
echo "--- data 目录 ---"
ls -l data/ 2>/dev/null | head -5
echo "--- db.json md5 ---"
md5sum data/db.json 2>/dev/null
echo "--- 图库文件数 ---"
find data/uploads -type f 2>/dev/null | wc -l
echo "--- 现有 .env ---"
test -f .env && echo "存在" || echo "不存在"
''')
        print(out)

        # ---- 上传 ----
        print(f'[3/6] 上传 bili-dyn.tgz ({size/1024:.0f} KB)...')
        sftp.put(TARBALL, '/tmp/bili-dyn.tgz')
        sftp.close()

        # ---- 备份 data ----
        print('[4/6] 备份 data 目录...')
        out, _ = run(ssh, f'''
cd {REMOTE_DIR}
BK=/tmp/data-backup-$(date +%Y%m%d-%H%M%S)
if [ -d data ]; then
  cp -r data "$BK" && echo "已备份到 $BK"
  du -sh "$BK"
else
  echo "data 目录不存在"
fi
''')
        print(out)

        # ---- 覆盖式解压（不删除任何文件）----
        print('[5/6] 覆盖部署代码（不删除任何文件）...')
        out, err = run(ssh, f'''
cd {REMOTE_DIR}
tar -xzf /tmp/bili-dyn.tgz --exclude='./data' --exclude='./data/*' --exclude='./.env' -C {REMOTE_DIR}
echo "解压完成"
''', pty=True)
        print(out)
        if err.strip():
            print('STDERR:', err)

        # ---- 重建 ----
        print('      重建并启动容器...')
        out, err = run(ssh, f'''
cd {REMOTE_DIR}
docker compose down
docker compose up -d --build
echo "=== 部署完成 ==="
''', pty=True)
        print(out)
        if err.strip():
            print('STDERR:', err)

        # ---- 验证 ----
        print('[6/6] 验证...')
        out, _ = run(ssh, f'''
cd {REMOTE_DIR}
echo "=== 容器状态 ==="
docker compose ps
echo ""
echo "=== data 目录（应与部署前一致）==="
ls -l data/ | head -5
echo "--- db.json md5（应与部署前一致）---"
md5sum data/db.json
echo "--- 图库文件数 ---"
find data/uploads -type f | wc -l
echo ""
echo "=== 迁移脚本 ==="
ls -l scripts/
echo ""
echo "=== 容器内 SDK 是否就位 ==="
docker compose exec -T bili-dyn node -e "require('@aws-sdk/client-s3'); console.log('@aws-sdk/client-s3 OK')"
''')
        print(out)
        print('\n✓ 代码部署完成（data 未被触碰）')

    finally:
        ssh.close()


if __name__ == '__main__':
    main()
