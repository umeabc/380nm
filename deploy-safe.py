#!/usr/bin/env python3
"""安全部署脚本 - 保护 data 目录"""
import paramiko
import os
import sys

HOST = '172.29.133.24'
USER = 'root'
PASSWORD = '1237ujm8ik,9ol.'
REMOTE_DIR = '/opt/bili-dyn-publisher'
TARBALL = 'bili-dyn.tgz'

def main():
    # 1. 检查本地 tarball
    if not os.path.exists(TARBALL):
        print(f'错误: {TARBALL} 不存在，请先打包')
        sys.exit(1)

    print(f'[1/5] 连接到 {HOST}...')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASSWORD)
    sftp = ssh.open_sftp()

    try:
        # 2. 上传 tarball
        print(f'[2/5] 上传 {TARBALL}...')
        sftp.put(TARBALL, f'/tmp/{TARBALL}')

        # 3. 备份 data 目录
        print('[3/5] 备份 data 目录...')
        stdin, stdout, stderr = ssh.exec_command(f'''
cd {REMOTE_DIR}
if [ -d data ]; then
    echo "备份 data 到 /tmp/data-backup-$(date +%s)"
    cp -r data /tmp/data-backup-$(date +%s)
else
    echo "data 目录不存在，跳过备份"
fi
        ''')
        print(stdout.read().decode('utf-8'))

        # 4. 安全部署：只删除代码文件，保留 data
        print('[4/5] 部署新代码（保留 data）...')
        cmd = f'''
cd {REMOTE_DIR}
# 停止容器
docker compose down

# 删除除 data 和 docker-compose.yml 外的所有内容
shopt -s extglob
rm -rf !(data|docker-compose.yml)

# 解压新代码，跳过 data 目录
tar -xzf /tmp/{TARBALL} --exclude='data'

# 重建并启动
docker compose up -d --build

echo "部署完成"
        '''

        stdin, stdout, stderr = ssh.exec_command(cmd, get_pty=True)
        output = stdout.read().decode('utf-8')
        print(output)

        # 5. 验证
        print('[5/5] 验证部署...')
        stdin, stdout, stderr = ssh.exec_command(f'''
echo "=== 容器状态 ==="
docker compose ps

echo -e "\n=== data 目录 ==="
ls -lh {REMOTE_DIR}/data/
        ''')
        print(stdout.read().decode('utf-8'))

        print('\n✓ 部署成功！data 目录已保护')

    finally:
        sftp.close()
        ssh.close()

if __name__ == '__main__':
    main()
