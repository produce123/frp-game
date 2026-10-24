# Coturn TLS 证书目录

将 TLS 证书文件放到此目录下：

- `fullchain.pem` — 完整证书链（证书 + 中间 CA）
- `privkey.pem`  — 私钥

## 获取证书

### 使用 Let's Encrypt (certbot)
```bash
certbot certonly --standalone -d turn.fatpaper.site
cp /etc/letsencrypt/live/turn.fatpaper.site/fullchain.pem .
cp /etc/letsencrypt/live/turn.fatpaper.site/privkey.pem .
chmod 644 *.pem
```

### 使用阿里云/腾讯云免费证书
下载 Nginx 格式证书，将 `.crt` 重命名为 `fullchain.pem`，`.key` 重命名为 `privkey.pem`。

## 验证
重启 coturn 后检查日志：
```bash
docker logs monopoly-coturn | grep -i "certificate\|tls"
```
